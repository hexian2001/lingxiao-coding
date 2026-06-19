import { z } from 'zod';
import { Tool, emitToolOutput, type ToolContext, type ToolResult } from '../Tool.js';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { prepareExecutionSandbox, type SandboxNetworkMode } from './ExecutionSandbox.js';
import { getToolPermissionContextFromToolContext } from '../../core/PermissionSystem.js';
import { getTerminalSessionManager, type TerminalSession } from './TerminalSessionManager.js';
import { getPty, type PtyImplementation } from '../../utils/getPty.js';
import { getShellCommand, hiddenSpawnOpts, killProcess } from '../../utils/platform.js';
import { TERMINAL, TRUNCATION } from '../../config/defaults.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { rmSync } from 'fs';
import { registerCleanup } from '../../core/CleanupRegistry.js';
import { isLikelyBinaryBuffer } from './utils.js';
import { shouldRequireStrongExecutionSandbox } from '../../core/HardeningPolicy.js';
import { smartTruncate } from '../../utils/SmartTruncator.js';

const execFileAsync = promisify(execFile);

type ExecFailure = Error & {
  killed?: boolean;
  signal?: string;
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

function sigkillDiagnostic(params: { command: string; errorMsg: string; signal?: string }): string {
  // 注：广播式杀进程（pkill -f / killall / fuser -k）现由 validateCommandForProcessKill
  // 在执行前统一拦截，不会到达此处；故此处只保留通用 SIGKILL 诊断。
  return [
    '[diagnostic] shell 进程收到 SIGKILL，且没有捕获到 stdout/stderr。',
    '这通常表示命令被外部 kill、超时强杀，或收到了 OOM/系统级强制终止信号。',
    `原始错误: ${params.errorMsg}`,
    '建议：先用 lsof/ps 查 PID，再 kill 精确 PID；广播式杀进程已在执行前拦截。',
  ].join('\n');
}

// ─── 输出截断 ────────────────────────────────────────────────────────────────

const TRUNCATE_CHAR_THRESHOLD = TRUNCATION.SHELL_STDOUT_MAX;
const TRUNCATE_LINE_THRESHOLD = TRUNCATION.SHELL_LINE_MAX;

/**
 * Error-aware truncation: uses smartTruncate to detect error patterns in the
 * tail and apply 70/30 head+tail split when errors are present.
 * Falls back to head-only truncation for non-error output.
 * Saves full output to a temp file when truncation occurs.
 */
export async function truncateOutput(content: string): Promise<string> {
  const result = smartTruncate(content, TRUNCATE_CHAR_THRESHOLD, TRUNCATE_LINE_THRESHOLD);

  if (!result.truncated) {
    return content;
  }

  // 保存完整输出到临时文件
  const { randomUUID } = await import('crypto');
  const tmpFile = join(tmpdir(), `lingxiao_shell_${randomUUID()}.output`);
  try {
    await writeFile(tmpFile, content, 'utf-8');
    trackShellTempFile(tmpFile); // C8: 追踪临时文件,封顶 + 进程退出时清理
    return `输出过大已截断。完整输出已保存到: ${tmpFile}\n使用 file_read 工具读取完整内容。\n\n截断预览:\n${result.text}`;
  } catch {/* expected: fallback to default */
    return result.text + '\n[注意: 无法保存完整输出到临时文件]';
  }
}

// ─── Shell 临时输出文件追踪 (C8) ─────────────────────────────────────────────
// truncateOutput 把超大输出落盘到 tmpdir,但这些文件从不回收 → 跨长会话无限堆积。
// 追踪 + FIFO 封顶 + 进程退出 registerCleanup 清理。Map 保留插入序,头部即最旧。
const shellTempFiles = new Map<string, number>();
const MAX_SHELL_TEMP_FILES = 50;

function trackShellTempFile(path: string): void {
  shellTempFiles.set(path, Date.now());
  while (shellTempFiles.size > MAX_SHELL_TEMP_FILES) {
    const oldest = shellTempFiles.keys().next().value;
    if (oldest === undefined) break;
    try { rmSync(oldest, { force: true }); } catch { /* tolerate */ }
    shellTempFiles.delete(oldest);
  }
}

// 进程退出时清理所有残留的 shell 临时输出文件。
registerCleanup(() => {
  for (const p of shellTempFiles.keys()) {
    try { rmSync(p, { force: true }); } catch { /* tolerate */ }
  }
  shellTempFiles.clear();
}, 18);

// ─── 二进制检测 ───────────────────────────────────────────────────────────────

export function isBinaryBuffer(buf: Buffer): boolean {
  return isLikelyBinaryBuffer(buf);
}

// ─── 编码检测 ────────────────────────────────────────────────────────────────

/**
 * 尝试将 Buffer 解码为可读文本。
 * 优先 UTF-8，若含无效序列则尝试 Latin-1 回退，输出乱码提示。
 */
export function detectAndDecode(buf: Buffer): string {
  // 先验证 UTF-8 合法性
  const utf8 = buf.toString('utf-8');
  // UTF-8 替换字符 U+FFFD 表示解码失败
  if (!utf8.includes('\uFFFD')) {
    return utf8;
  }
  // 回退：Latin-1（逐字节，不会丢失数据）
  // 对于 GBK/GB2312 内容，这里会显示乱码，但不会崩溃
  // 注：Node.js 原生不支持 GBK，需要 iconv-lite 才能完美处理
  // 这里给出提示，引导用户安装 iconv-lite 或使用 LC_ALL=zh_CN.UTF-8 环境变量
  const latin1 = buf.toString('latin1');
  return `[编码警告: 输出含非UTF-8字节，已用Latin-1解码，中文可能显示为乱码。如需正确显示，请在命令前设置 LANG=zh_CN.UTF-8 或 PYTHONIOENCODING=utf-8 等]\n${latin1}`;
}

// ─── 后台进程清理 ──────────────────────────────────────────────────────────────

/**
 * 后台进程跟踪表 — 用于父进程退出时清理孤儿进程
 * key: PID, value: ChildProcess 引用
 */
const backgroundProcesses = new Map<number, ChildProcess>();

/** 注册后台进程到跟踪表 */
function trackBackgroundProcess(child: ChildProcess): void {
  if (child.pid) {
    const pid = child.pid;
    backgroundProcesses.set(pid, child);
    child.on('exit', () => {
      // 防御性检查：确保删除的是同一个进程实例
      if (backgroundProcesses.get(pid) === child) {
        backgroundProcesses.delete(pid);
      }
    });
  }
}

/**
 * 三阶段进程终止：SIGTERM → 等待 2s → SIGKILL
 */
function killProcessGracefully(pid: number): void {
  void killProcess(pid, 'SIGTERM', { tree: true });
  setTimeout(() => {
    void killProcess(pid, 'SIGKILL', { tree: true });
  }, 2000);
}

/** 清理所有后台进程（父进程退出时调用） */
export function cleanupBackgroundProcesses(): void {
  for (const [pid, proc] of backgroundProcesses) {
    if (!proc.killed) {
      killProcessGracefully(pid);
    }
  }
  backgroundProcesses.clear();
}

// 注册进程退出时清理（只注册一次）
let _exitHandlerRegistered = false;
if (!_exitHandlerRegistered) {
  _exitHandlerRegistered = true;
  process.once('exit', () => {
    cleanupBackgroundProcesses();
  });
}

const ShellSchema = z.object({
  command: z.string().describe('shell 命令'),
  timeout: z.number().optional().describe('超时秒数 (默认 30)'),
  cwd: z.string().optional().describe('工作目录 (可选，默认当前目录)'),
  network: z.enum(['inherit', 'disabled', 'allowlisted']).optional().describe('网络模式，默认 inherit（继承主机网络）'),
  allowed_hosts: z.array(z.string()).optional().describe('allowlisted 网络模式下允许的主机名'),
  sandbox_backend: z.enum(['app-guard', 'bubblewrap']).optional().describe('sandbox backend，默认 app-guard'),
  is_background: z.boolean().optional().describe('是否后台运行，默认 false。长任务/服务/持续监听命令应显式设为 true；后台结果会返回 terminal_id 和 next_tool'),
  _abortSignal: z.custom<AbortSignal>().optional(),
});

const SHELL_REGISTRY_OUTPUT_DRAIN_GRACE_MS = 5 * 60_000;
const SHELL_BACKGROUND_START_TIMEOUT_MS = 60_000;

export class ShellTool extends Tool {
  readonly name = 'shell';
  readonly description = '在工作区执行 shell 命令。支持前台/后台、sandbox、网络隔离模式';
  readonly parameters = ShellSchema;

  override getSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'shell 命令' },
        timeout: { type: 'number', description: '超时秒数 (默认 30)' },
        cwd: { type: 'string', description: '工作目录 (可选，默认当前目录)' },
        network: { type: 'string', enum: ['inherit', 'disabled', 'allowlisted'], description: '网络模式，默认 inherit（继承主机网络）' },
        allowed_hosts: { type: 'array', items: { type: 'string' }, description: 'allowlisted 网络模式下允许的主机名' },
        sandbox_backend: { type: 'string', enum: ['app-guard', 'bubblewrap'], description: 'sandbox backend，默认 app-guard' },
        is_background: { type: 'boolean', description: '是否后台运行，默认 false。长任务/服务/持续监听命令应显式设为 true；后台结果会返回 terminal_id 和 next_tool' },
      },
      required: ['command'],
      additionalProperties: false,
    };
  }

  private formatSandboxLabel(sandbox: ReturnType<typeof prepareExecutionSandbox>): string {
    return `sandbox mode=${sandbox.metadata?.mode} network=${sandbox.metadata?.networkMode} enforced=${sandbox.metadata?.networkEnforced ? 'true' : 'false'}`;
  }

  private emitShellState(
    context: ToolContext | undefined,
    payload: {
      pid?: number;
      status: 'started' | 'completed' | 'failed' | 'killed';
    },
  ): void {
    context?.emitter?.emit('agent:shell_state', {
      agentId: String(context?.agentId || ''),
      agentName: typeof context?.agentName === 'string' ? context.agentName : undefined,
      sessionId: typeof context?.sessionId === 'string' ? context.sessionId : undefined,
      taskId: typeof context?.taskId === 'string' ? context.taskId : undefined,
      callId: typeof context?.toolCallId === 'string' ? context.toolCallId : undefined,
      tool: this.name,
      pid: payload.pid,
      status: payload.status,
    });
  }

  getExecutionTimeoutMs(args: unknown): number {
    const params = args as Partial<z.infer<typeof ShellSchema>>;
    if (params?.is_background === true) {
      return SHELL_BACKGROUND_START_TIMEOUT_MS;
    }
    const timeoutSeconds = typeof params?.timeout === 'number' && Number.isFinite(params.timeout) && params.timeout > 0
      ? params.timeout
      : 30;
    return Math.ceil(timeoutSeconds * 1000) + SHELL_REGISTRY_OUTPUT_DRAIN_GRACE_MS;
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ShellSchema>;
    const workspace = context?.workspace || process.cwd();
    const taskWriteScope = Array.isArray(context?.taskWriteScope) ? context.taskWriteScope : undefined;
    const taskWorkingDirectory = typeof context?.taskWorkingDirectory === 'string'
      ? context.taskWorkingDirectory
      : undefined;
    const permissionContext = getToolPermissionContextFromToolContext(context);
    const networkMode = (params.network || (permissionContext.mode === 'yolo' ? 'inherit' : permissionContext.mode === 'networked' ? 'allowlisted' : 'disabled')) as SandboxNetworkMode;
    // 注：广播式/运行时解析的进程杀灭（pkill/killall/kill $(...)/xargs kill）由
    // prepareExecutionSandbox → validateCommandForProcessKill 统一拦截，无需在此重复检查。
    if (params.is_background === true && shouldRequireStrongExecutionSandbox()) {
      return {
        success: false,
        data: null,
        error: 'ERROR: 企业加固模式要求后台命令具备强隔离与生命周期约束；当前后台 shell 不能安全承载 bubblewrap 会话。请改用前台命令，或关闭企业加固模式后再启动长期后台进程。',
      };
    }

    // 后台模式下强制使用 app-guard (bubblewrap 的 --die-with-parent 会杀死后台进程)
    const effectiveBackend = params.is_background && params.sandbox_backend === 'bubblewrap'
      ? 'app-guard'
      : params.sandbox_backend || permissionContext.sandboxBackend;

    const sandbox = prepareExecutionSandbox({
      workspace,
      sessionId: typeof context?.sessionId === 'string' ? context.sessionId : undefined,
      cwd: params.cwd || taskWorkingDirectory,
      command: params.command,
      networkMode,
      allowedHosts: params.allowed_hosts || permissionContext.allowedHosts,
      backend: effectiveBackend,
      taskId: typeof context?.taskId === 'string' ? context.taskId : undefined,
      taskWorkingDirectory,
      taskWriteScope,
    });
    if (!sandbox.ok || !sandbox.cwd || !sandbox.env) {
      return {
        success: false,
        data: null,
        error: sandbox.error || 'ERROR: sandbox policy 拒绝执行该命令',
      };
    }
    const workDir = sandbox.cwd;

    // 检查工作目录是否存在
    const fs = await import('fs/promises');
    try {
      await fs.access(workDir);
    } catch {/* expected: fallback to default */
      return {
        success: false,
        data: null,
        error: `ERROR: 工作目录不存在：${params.cwd}`,
      };
    }

    const timeout = params.timeout !== undefined ? params.timeout : 30;
    const isBackground = params.is_background === true; // 默认前台，长任务显式后台

    // 后台模式执行路径
    if (isBackground) {
      return this.executeBackground(params, sandbox, workDir, timeout, context);
    }

    // 前台模式执行路径
    const abortSignal = params._abortSignal instanceof AbortSignal
      ? (context?.abortSignal ? AbortSignal.any([params._abortSignal, context.abortSignal]) : params._abortSignal)
      : context?.abortSignal;
    return this.executeForeground(params, sandbox, workDir, timeout, context, abortSignal);
  }

  /**
   * 前台执行 — 兼容原有逻辑，超时时自动转后台
   */
  private async executeForeground(
    params: z.infer<typeof ShellSchema>,
    sandbox: ReturnType<typeof prepareExecutionSandbox>,
    workDir: string,
    timeout: number,
    context?: ToolContext,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      let stdoutBufs: Buffer[] = [];
      let stderrBufs: Buffer[] = [];
      let stdoutText = '';
      let stderrText = '';
      let binaryDetected = false;
      let binaryTotalBytes = 0;

      if (sandbox.plan?.mode === 'execFile' && sandbox.plan.args) {
        const result = await execFileAsync(sandbox.plan.command, sandbox.plan.args, {
          cwd: workDir,
          encoding: 'buffer',
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          killSignal: 'SIGKILL',
          env: sandbox.env,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        const outBuf = result.stdout as unknown as Buffer;
        const errBuf = result.stderr as unknown as Buffer;
        let stderrBinaryBytes = 0;
        if (isBinaryBuffer(outBuf)) {
          binaryDetected = true;
          binaryTotalBytes = outBuf.length;
        } else {
          stdoutText = detectAndDecode(outBuf);
        }
        if (isBinaryBuffer(errBuf)) {
          stderrBinaryBytes = errBuf.length;
        } else {
          stderrText = detectAndDecode(errBuf);
        }
        // 如果 stderr 是二进制但 stdout 不是，仅跳过 stderr 内容
        if (stderrBinaryBytes > 0 && !binaryDetected) {
          stderrText = `[二进制输出，已跳过 ${stderrBinaryBytes} bytes]`;
        }
      } else {
        const command = sandbox.plan?.command || params.command;
        const sh = getShellCommand(command);
        const child = spawn(sh.executable, sh.args, {
          cwd: workDir,
          env: sandbox.env,
          ...hiddenSpawnOpts(),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        const pid = typeof child.pid === 'number' ? child.pid : undefined;
        this.emitShellState(context, { pid, status: 'started' });

        // 超时后立即返回后台结果（不阻塞等待进程关闭）
        let backgroundResult: ToolResult | undefined;
        const timeoutHandle = setTimeout(() => {
          if (TERMINAL.TIMEOUT_AUTO_BACKGROUND) {
            // 将已收集的 buffer 合并为文本再转后台
            const partialOut = binaryDetected
              ? `[二进制输出，已跳过 ${binaryTotalBytes} bytes]`
              : stdoutBufs.length > 0 ? detectAndDecode(Buffer.concat(stdoutBufs)) : stdoutText;
            const partialErr = stderrBufs.length > 0 ? detectAndDecode(Buffer.concat(stderrBufs)) : stderrText;
            backgroundResult = this.convertToBackground(child, params, sandbox, workDir, partialOut, partialErr, context);
            resolvePromise?.();
            return;
          }
          if (pid) {
            void killProcess(pid, 'SIGKILL', { tree: true });
          } else {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
          this.emitShellState(context, { pid, status: 'killed' });
        }, timeout * 1000);

        let resolvePromise: (() => void) | undefined;
        await new Promise<void>((resolve, reject) => {
          resolvePromise = resolve;
          child.stdout?.on('data', (data: Buffer) => {
            // 仅在首个 chunk 时检测二进制
            if (!binaryDetected && stdoutBufs.length === 0) {
              if (isBinaryBuffer(data)) {
                binaryDetected = true;
                binaryTotalBytes += data.length;
                return; // 不累积二进制数据
              }
            }
            if (binaryDetected) {
              binaryTotalBytes += data.length;
              return;
            }
            stdoutBufs.push(data);
            const chunk = detectAndDecode(data);
            stdoutText += chunk;
            emitToolOutput(context, this.name, { chunk, stream: 'stdout', pid });
          });
          child.stderr?.on('data', (data: Buffer) => {
            stderrBufs.push(data);
            const chunk = detectAndDecode(data);
            stderrText += chunk;
            emitToolOutput(context, this.name, { chunk, stream: 'stderr', pid });
          });
          child.on('error', (error) => {
            clearTimeout(timeoutHandle);
            this.emitShellState(context, { pid, status: 'failed' });
            reject(error);
          });
          child.on('close', (code, signal) => {
            clearTimeout(timeoutHandle);
            // backgroundResult 已设置说明已转后台，Promise 已被 resolve，忽略 close
            if (backgroundResult) return;

            if (code === 0) {
              this.emitShellState(context, { pid, status: 'completed' });
              resolve();
              return;
            }

            const commandError = new Error(`Command failed with exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`) as ExecFailure;
            commandError.code = code ?? undefined;
            commandError.signal = signal ?? undefined;
            commandError.stdout = stdoutText;
            commandError.stderr = stderrText;
            this.emitShellState(context, { pid, status: 'failed' });
            reject(commandError);
          });
        });

        // 超时转后台：立即返回后台会话信息，不再走下面的输出截断逻辑
        if (backgroundResult) {
          return backgroundResult;
        }
      }

      // 二进制输出：跳过内容，直接提示
      if (binaryDetected) {
        return {
          success: true,
          data: [
            `[${this.formatSandboxLabel(sandbox)}]`,
            `[二进制输出，已跳过 ${binaryTotalBytes} bytes。如需查看，使用 file_read 或重定向到文件后用 xxd 分析]`,
          ].join('\n'),
        };
      }

      // 智能输出截断（head/tail + 临时文件）
      const rawStdout = stdoutText || '(无输出)';
      const truncatedStdout = await truncateOutput(rawStdout);

      let truncatedStderr = '';
      if (stderrText) {
        truncatedStderr = await truncateOutput(stderrText);
      }

      const resultParts = [truncatedStdout];
      if (truncatedStderr) {
        resultParts.push(`[stderr]\n${truncatedStderr}`);
      }

      return {
        success: true,
        data: [
          `[${this.formatSandboxLabel(sandbox)}]`,
          resultParts.join('\n'),
        ].join('\n'),
      };
    } catch (error: unknown) {
      // 处理 AbortSignal 中断
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          data: JSON.stringify({
            output: '[UserInterrupt] 命令被用户中断',
            exitCode: -1,
            interrupted: true,
          }),
        };
      }

      const execError = error as ExecFailure;

      // 处理超时（转后台的情况由 convertToBackground 处理，这里只处理非自动转后台的情况）
      if (execError.killed && execError.signal === 'SIGKILL') {
        return {
          success: false,
          data: null,
          error: `ERROR: 命令执行超时 (${timeout}秒)！🚨 警告：如果是因为命令需要前台交互 (如输入 y/n)、或者进入了像 vim/nano 这样的全屏界面，Agent 将被永久阻塞！请立刻修改你的命令（例如添加 -y 或 --non-interactive 参数，或者使用重定向过滤掉长输出）再次执行！`,
        };
      }

      const stdoutText = execError.stdout ? String(execError.stdout) : '';
      const stderrText = execError.stderr ? String(execError.stderr) : '';
      const errorMsg = execError.message || String(error);

      const errorDetails = [
        `错误消息: ${errorMsg}`,
        execError.code ? `退出码: ${execError.code}` : null,
        execError.signal ? `信号: ${execError.signal}` : null,
      ].filter(Boolean).join('\n');

      // 错误输出也用智能截断
      const truncatedOut = stdoutText ? await truncateOutput(stdoutText) : '';
      const truncatedErr = stderrText ? await truncateOutput(stderrText) : '';

      let output = '';
      if (truncatedOut) output += truncatedOut + '\n';
      if (truncatedErr) output += `[stderr]\n${truncatedErr}\n`;
      if (!output && execError.signal === 'SIGKILL') {
        output = sigkillDiagnostic({
          command: params.command,
          errorMsg,
          signal: execError.signal,
        });
      }

      return {
        success: false,
        data: output || null,
        error: `Shell 执行失败\n${errorDetails}`,
      };
    }
  }

  /**
   * 后台执行 — 注册到 TerminalSessionManager 并立即返回
   */
  private async executeBackground(
    params: z.infer<typeof ShellSchema>,
    sandbox: ReturnType<typeof prepareExecutionSandbox>,
    workDir: string,
    _timeout: number,
    context?: ToolContext,
  ): Promise<ToolResult> {
    const manager = getTerminalSessionManager();
    if (context?.emitter) {
      manager.setEmitter(context.emitter);
    }

    // 创建会话
    const session = manager.createSession({
      command: params.command,
      cwd: workDir,
      isBackground: true,
      agentId: context?.agentId ? String(context.agentId) : undefined,
      agentName: context?.agentName,
      taskId: context?.taskId,
      callId: context?.toolCallId,
      sessionId: context?.sessionId,
      sandboxMode: sandbox.metadata?.mode,
      networkMode: sandbox.metadata?.networkMode,
      networkEnforced: sandbox.metadata?.networkEnforced,
      networkIsolation: sandbox.metadata?.networkIsolation,
    });

    // 尝试 PTY 模式
    const ptyInfo = await getPty();
    if (ptyInfo && sandbox.plan?.mode !== 'execFile') {
      try {
        return this.executeBackgroundWithPty(session, params, sandbox, workDir, ptyInfo, context);
      } catch {
        // PTY 失败，回退到 child_process
        manager.removeSession(session.terminalId);
        const fallbackSession = manager.createSession({
          command: params.command,
          cwd: workDir,
          isBackground: true,
          agentId: context?.agentId ? String(context.agentId) : undefined,
          agentName: context?.agentName,
          taskId: context?.taskId,
          callId: context?.toolCallId,
          sessionId: context?.sessionId,
          sandboxMode: sandbox.metadata?.mode,
          networkMode: sandbox.metadata?.networkMode,
          networkEnforced: sandbox.metadata?.networkEnforced,
          networkIsolation: sandbox.metadata?.networkIsolation,
        });
        return this.executeBackgroundWithChildProcess(fallbackSession, params, sandbox, workDir, context);
      }
    }

    // child_process 回退
    return this.executeBackgroundWithChildProcess(session, params, sandbox, workDir, context);
  }

  /**
   * PTY 模式后台执行
   */
  private async executeBackgroundWithPty(
    session: TerminalSession,
    params: z.infer<typeof ShellSchema>,
    sandbox: ReturnType<typeof prepareExecutionSandbox>,
    workDir: string,
    ptyInfo: PtyImplementation,
    context?: ToolContext,
  ): Promise<ToolResult> {
    const rawCommand = sandbox.plan?.command || params.command;
    // PTY spawn 直接 execvp，不支持 shell 语法（环境变量前缀、管道等）
    // 必须通过 shell 包装，与 child_process 模式保持一致
    const sh = getShellCommand(rawCommand);
    const ptyCommand = sh.executable;
    const ptyArgs = sh.args;

    let headlessTerminal: { write: (data: string) => void; buffer?: { active?: { getLine?: (y: number) => { translateToString: (trim?: boolean) => string } | undefined }; cursorY?: number; baseY?: number; length?: number } } | undefined;
    try {
      const { Terminal } = await import('@xterm/headless') as unknown as { Terminal: new (opts: { cols: number; rows: number; scrollback: number }) => typeof headlessTerminal };
      headlessTerminal = new Terminal({
        cols: TERMINAL.DEFAULT_COLS,
        rows: TERMINAL.DEFAULT_ROWS,
        scrollback: 1000,
      });
    } catch {/* swallowed: unhandled error */
      headlessTerminal = undefined;
    }

    if (!ptyInfo) {
      return {
        success: false,
        data: null,
        error: 'PTY 模块加载失败',
      };
    }

    const ptyProcess = ptyInfo.module.spawn(ptyCommand, ptyArgs, {
      name: 'xterm-256color',
      cols: TERMINAL.DEFAULT_COLS,
      rows: TERMINAL.DEFAULT_ROWS,
      cwd: workDir,
      env: sandbox.env || process.env as Record<string, string>,
    });

    getTerminalSessionManager().registerPtyProcess(session.terminalId, ptyProcess, headlessTerminal);

    return {
      success: true,
      data: {
        message: `[后台终端已启动] [${this.formatSandboxLabel(sandbox)}]`,
        terminal_id: session.terminalId,
        pid: ptyProcess.pid,
        status: 'running',
        next_tool: { name: 'get_terminal_output', args: { terminal_id: session.terminalId } },
        control_tool: { name: 'terminal_control', args: { terminal_id: session.terminalId, action: 'kill' } },
        text: [
          `[后台终端已启动] [${this.formatSandboxLabel(sandbox)}]`,
          `terminal_id: ${session.terminalId}`,
          `PID: ${ptyProcess.pid}`,
          `状态: running`,
          ``,
          `使用 get_terminal_output 查看输出`,
          `使用 terminal_control 管理 (kill/suspend/resume/write)`,
        ].join('\n'),
      },
    };
  }

  /**
   * child_process 模式后台执行
   */
  private executeBackgroundWithChildProcess(
    session: TerminalSession,
    params: z.infer<typeof ShellSchema>,
    sandbox: ReturnType<typeof prepareExecutionSandbox>,
    workDir: string,
    context?: ToolContext,
  ): ToolResult {
    const manager = getTerminalSessionManager();
    const command = sandbox.plan?.command || params.command;
    const sh = getShellCommand(command);
    // 后台执行：stdin 设为 pipe (允许后续写入)，detached 进程组
    const child = spawn(sh.executable, sh.args, {
      cwd: workDir,
      env: sandbox.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...hiddenSpawnOpts(),
    });

    // 取消引用，让子进程独立运行
    child.unref();

    // 跟踪进程，父进程退出时清理（三阶段 SIGTERM→SIGKILL）
    trackBackgroundProcess(child);

    manager.registerProcess(session.terminalId, child);

    // 也发射 agent:shell_state 用于 TUI 兼容
    this.emitShellState(context, { pid: child.pid ?? undefined, status: 'started' });

    return {
      success: true,
      data: {
        message: `[后台终端已启动] [${this.formatSandboxLabel(sandbox)}]`,
        terminal_id: session.terminalId,
        pid: child.pid,
        status: 'running',
        next_tool: { name: 'get_terminal_output', args: { terminal_id: session.terminalId } },
        control_tool: { name: 'terminal_control', args: { terminal_id: session.terminalId, action: 'kill' } },
        text: [
          `[后台终端已启动] [${this.formatSandboxLabel(sandbox)}]`,
          `terminal_id: ${session.terminalId}`,
          `PID: ${child.pid}`,
          `状态: running`,
          ``,
          `使用 get_terminal_output 查看输出`,
          `使用 terminal_control 管理 (kill/suspend/resume/write)`,
        ].join('\n'),
      },
    };
  }

  /**
   * 前台超时自动转后台
   */
  private convertToBackground(
    child: ChildProcess,
    params: z.infer<typeof ShellSchema>,
    sandbox: ReturnType<typeof prepareExecutionSandbox>,
    workDir: string,
    existingStdout: string,
    existingStderr: string,
    context?: ToolContext,
  ): ToolResult {
    const manager = getTerminalSessionManager();
    if (context?.emitter) {
      manager.setEmitter(context.emitter);
    }

    // 创建后台会话
    const session = manager.createSession({
      command: params.command,
      cwd: workDir,
      isBackground: false, // 原本是前台，超时后转后台
      agentId: context?.agentId ? String(context.agentId) : undefined,
      agentName: context?.agentName,
      taskId: context?.taskId,
      callId: context?.toolCallId,
      sessionId: context?.sessionId,
      sandboxMode: sandbox.metadata?.mode,
      networkMode: sandbox.metadata?.networkMode,
      networkEnforced: sandbox.metadata?.networkEnforced,
      networkIsolation: sandbox.metadata?.networkIsolation,
    });

    // 将已有的输出放入会话
    session.stdout = existingStdout;
    session.stderr = existingStderr;
    session.outputUpdatedAt = Date.now();

    // 注册子进程到会话
    manager.registerProcess(session.terminalId, child);

    // 跟踪进程，父进程退出时三阶段清理
    trackBackgroundProcess(child);

    // 不 kill 进程，让它继续运行
    // child.unref() 不需要，因为原进程已经是 referenced

    const partialOutput = [existingStdout, existingStderr].filter(Boolean).join('\n');
    return {
      success: true,
      data: [
        `[前台超时，已转后台] [${this.formatSandboxLabel(sandbox)}]`,
        `terminal_id: ${session.terminalId}`,
        `PID: ${child.pid ?? 'unknown'}`,
        `状态: running（命令仍在运行）`,
        partialOutput ? `已收到输出:\n${partialOutput.substring(0, 2000)}` : '',
        ``,
        `命令超时 (${params.timeout ?? 30}s) 但进程仍在运行，已转为后台终端。`,
        `使用 get_terminal_output terminal_id=${session.terminalId} 查看最新输出`,
        `使用 terminal_control 发送输入或管理进程`,
        `如果命令需要交互输入（如 y/N），使用 terminal_control write 发送`,
      ].filter(s => s !== '').join('\n'),
    };
  }
}

export default ShellTool;
