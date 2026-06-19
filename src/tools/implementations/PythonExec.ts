import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { refreshRuntimeConfig } from '../../config.js';
import { getPythonExecutable, getShellCommand } from '../../utils/platform.js';
import { getDefaultToolPermissionContext, type ToolPermissionContext } from '../../core/PermissionSystem.js';
import { prepareExecutionSandbox, type SandboxNetworkMode } from './ExecutionSandbox.js';
import { Workspace } from '../../core/Workspace.js';

/**
 * PythonExec - Python 代码执行工具
 *
 * 在子进程中执行 Python 代码片段
 * 参考 Python 版本的 python_exec 实现
 */

/** 流式输出回调：Python 子进程每收到一段 stdout/stderr 就推送（用于 agent/leader 卡片逐行流式）。 */
export type PythonOutputSink = (chunk: string, stream: 'stdout' | 'stderr') => void;

export interface PythonExecParams {
  code: string;
  timeout?: number;
  max_output?: number;
  permissionContext?: ToolPermissionContext;
  workspace?: string;
  sessionId?: string;
  cwd?: string;
  taskId?: string;
  taskWorkingDirectory?: string;
  taskWriteScope?: string[];
  /** 流式输出回调。undefined 时静默（向后兼容单测）。由调用方注入 emitToolOutput 闭包。 */
  onOutput?: PythonOutputSink;
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class PythonExec {
  /**
   * 执行 Python 代码
   *
   * @param params 执行参数
   * @returns 执行结果
   */
  static async execute(
    params: PythonExecParams
  ): Promise<{ success: boolean; data: string; error?: string }> {
    const { code, timeout = 30, max_output = 20000 } = params;
    refreshRuntimeConfig();
    const permissionContext = params.permissionContext || getDefaultToolPermissionContext();
    const workspace = params.workspace || process.cwd();
    const networkMode = (permissionContext.mode === 'yolo' ? 'inherit' : permissionContext.mode === 'networked' ? 'allowlisted' : 'disabled') as SandboxNetworkMode;

    // 限制代码大小
    if (code.length > 100000) {
      return {
        success: false,
        data: '',
        error: '代码大小超过 100KB 限制',
      };
    }

    let tmpPath: string | null = null;

    try {
      // 创建临时文件
      const { randomUUID } = await import('crypto');
      const tmpDir = params.sessionId
        ? join(Workspace.getSessionArtifactPaths(params.sessionId, workspace).sessionDir, 'sandbox-tmp')
        : tmpdir();
      const tmpFileName = `python_exec_${randomUUID()}.py`;
      tmpPath = join(tmpDir, tmpFileName);

      const command = `${shellQuote(getPythonExecutable())} ${shellQuote(tmpPath)}`;
      const sandbox = prepareExecutionSandbox({
        workspace,
        sessionId: params.sessionId,
        cwd: params.cwd || params.taskWorkingDirectory,
        command,
        networkMode,
        allowedHosts: permissionContext.allowedHosts,
        backend: permissionContext.sandboxBackend,
        taskId: params.taskId,
        taskWorkingDirectory: params.taskWorkingDirectory,
        taskWriteScope: params.taskWriteScope,
      });
      if (!sandbox.ok || !sandbox.cwd || !sandbox.env || !sandbox.plan) {
        return {
          success: false,
          data: '',
          error: sandbox.error || 'ERROR: sandbox policy 拒绝执行 Python 代码',
        };
      }

      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(tmpPath, code, 'utf-8');

      // 执行 Python 代码（spawn 逐 chunk 流式：等价 execFile 的超时/沙箱/截断语义，
      // 但能实时把 stdout/stderr 推到 agent/leader 工具卡片——治本流式输出）
      const plan: { command: string; args: string[] } = sandbox.plan.mode === 'execFile' && sandbox.plan.args
        ? { command: sandbox.plan.command, args: sandbox.plan.args }
        : (() => {
            const shell = getShellCommand(sandbox.plan.command);
            return { command: shell.executable, args: shell.args };
          })();

      const child = spawn(plan.command, plan.args, {
        cwd: sandbox.cwd,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 累积上限（用于最终结果）：stdout 2MB（等价 execFile maxBuffer，但超限改截断而非报错——见有意改善）、
      // stderr 2000（等价原逻辑）。onOutput 推流的是原始 chunk（前端自行滚动窗口）。
      const STDOUT_ACCUM_CAP = 2 * 1024 * 1024;
      const STDERR_ACCUM_CAP = 2000;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let stdoutTruncated = false;
      let timedOut = false;

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        if (stdoutLen < STDOUT_ACCUM_CAP) {
          const room = STDOUT_ACCUM_CAP - stdoutLen;
          stdoutChunks.push(text.slice(0, room));
          stdoutLen += Math.min(text.length, room);
          if (stdoutLen >= STDOUT_ACCUM_CAP) stdoutTruncated = true;
        }
        try { params.onOutput?.(text, 'stdout'); } catch { /* 推流故障不影响执行 */ }
      });
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        if (stderrLen < STDERR_ACCUM_CAP) {
          const room = STDERR_ACCUM_CAP - stderrLen;
          stderrChunks.push(text.slice(0, room));
          stderrLen += Math.min(text.length, room);
        }
        try { params.onOutput?.(text, 'stderr'); } catch { /* 推流故障不影响执行 */ }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // SIGTERM 后 200ms 仍未退出则 SIGKILL 兜底
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 200).unref?.();
      }, timeout * 1000);

      const exitCode: number = await new Promise<number>((resolve) => {
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(typeof code === 'number' ? code : -1));
      });
      clearTimeout(timer);

      if (timedOut) {
        return {
          success: false,
          data: '',
          error: `执行超时 (${timeout}秒)！警告：这可能是由于代码进入了死循环，或者是某些 IO 操作被永久挂起。请检查代码逻辑并修正后重试！`,
        };
      }

      const stdoutRaw = stdoutChunks.join('');
      const stderrRaw = stderrChunks.join('');

      // 处理输出（复用原 max_output 截断逻辑）
      const resultParts: string[] = [];

      if (stdoutRaw || stdoutTruncated) {
        let stdoutText = stdoutRaw;
        if (stdoutTruncated) stdoutText += '\n... (stdout 累计超过 2MB)';
        if (stdoutText.length > max_output) {
          stdoutText = stdoutText.slice(0, max_output) + '\n... (stdout 截断)';
        }
        resultParts.push(stdoutText);
      }

      if (stderrRaw) {
        let stderrText = stderrRaw;
        if (stderrText.length > 2000) {
          stderrText = stderrText.slice(0, 2000) + '\n... (stderr 截断)';
        }
        resultParts.push(`[stderr]\n${stderrText}`);
      }

      let output = resultParts.join('\n') || '(无输出)';

      // 最终输出限制
      if (output.length > max_output) {
        output = output.slice(0, max_output) + '\n... (截断)';
      }

      // 非零退出码：失败但保留输出（等价 execFile 非零退出语义，错误信息改用 stderr/退出码更精确——见有意改善）
      if (exitCode !== 0) {
        return {
          success: false,
          data: output,
          error: stderrRaw || `Python 进程退出码 ${exitCode}`,
        };
      }

      return {
        success: true,
        data: output,
      };
    } catch (error: unknown) {
      const execError = error as Error;
      const errorDetails = [
        `错误类型: ${execError.name || '未知'}`,
        `错误消息: ${execError.message || '无'}`,
        execError.stack ? `堆栈跟踪:\n${execError.stack}` : null,
      ].filter(Boolean).join('\n');
      return {
        success: false,
        data: '',
        error: `Python 执行失败\n${errorDetails}`,
      };
    } finally {
      // 清理临时文件
      if (tmpPath && existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch (cleanupError) {
          console.warn('[PythonExec] 清理临时文件失败:', cleanupError);
        }
      }
    }
  }
}

export default PythonExec;
