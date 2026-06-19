/**
 * Hook 执行器
 *
 * 当前仅 executeStop / executePreCompact / executePostCompact 有外部消费者。
 * 其余 hook 类型保留类型定义（types.ts），但不预建 execute* 包装——
 * 需要时按实际需求添加。
 */

import { spawn } from 'child_process';
import {
  AggregatedHookResult,
  FunctionHook,
  HookCommand,
  HookEvent,
  HookInput,
  HookOutput,
  HookResult,
  RegisteredHook,
} from './types.js';
import { getHookRegistry } from './registry.js';

/**
 * command hook 执行失败（非零退出或被信号杀死）时抛出。
 * - block=true 表示这是 hook 主动 deny（正常非零退出），应阻止后续操作；
 * - signal 非空表示进程被信号杀死（如超时 SIGTERM），属基础设施失败而非主动 deny。
 */
class HookCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly block: boolean,
    readonly blockReason?: string,
  ) {
    super(message);
    this.name = 'HookCommandError';
  }
}

/**
 * Hook 执行器
 */
export class HookExecutor {
  private registry = getHookRegistry();

  /**
   * 执行所有匹配的 Hook
   */
  async execute(
    event: HookEvent,
    input: HookInput,
    toolName?: string
  ): Promise<AggregatedHookResult> {
    const hooks = this.registry.getHooksForEvent(event, toolName);

    if (!hooks.length) {
      return {
        results: [],
        blocked: false,
        system_messages: [],
      };
    }

    const results: HookResult[] = [];
    let blocked = false;
    let blockReason: string | undefined;
    let modifiedInput: Record<string, unknown> | undefined;
    const systemMessages: string[] = [];

    for (const hook of hooks) {
      if (blocked) break;

      const result = await this.executeSingle(hook, input);
      results.push(result);

      // 命令 hook 非零退出会返回 success:false + output.block（deny 语义），
      // 因此 block 判定不能要求 success，否则 hook 的 block/deny 失效。
      if (result.output) {
        const output = result.output;

        if (output.block) {
          blocked = true;
          blockReason = output.block_reason;
        }

        if (result.success) {
          if (output.modified_input) {
            modifiedInput = output.modified_input;
            input.tool_input = modifiedInput;
          }

          if (output.system_message) {
            systemMessages.push(output.system_message);
          }
        }
      }
    }

    return {
      results,
      blocked,
      block_reason: blockReason,
      modified_input: modifiedInput,
      system_messages: systemMessages,
    };
  }

  /**
   * 执行单个 Hook
   */
  private async executeSingle(
    hook: RegisteredHook,
    input: HookInput
  ): Promise<HookResult> {
    const hookId = `${hook.matcher.event}:${hook.hook.type}`;
    const startTime = Date.now();

    try {
      let output: HookOutput | undefined;

      if (hook.hook.type === 'function') {
        output = await this.executeFunction(hook.hook, input);
      } else if (hook.hook.type === 'command') {
        output = await this.executeCommand(hook.hook, input);
      } else {
        const unknownHook = hook.hook as { type?: string };
        return {
          hook_id: hookId,
          success: false,
          error: `Unknown hook type: ${unknownHook.type}`,
          duration_ms: Date.now() - startTime,
        };
      }

      return {
        hook_id: hookId,
        success: true,
        output,
        duration_ms: Date.now() - startTime,
      };
    } catch (e) {
      if (e instanceof HookCommandError) {
        // 命令 hook 非零退出 → deny：附带 block 输出让聚合层阻止后续操作；
        // 被信号杀死（超时）→ 基础设施失败，不阻止，仅记错误。
        return {
          hook_id: hookId,
          success: false,
          error: e.stderr ? `${e.message}: ${e.stderr}` : e.message,
          output: e.block
            ? { block: true, block_reason: e.blockReason ?? e.message }
            : undefined,
          duration_ms: Date.now() - startTime,
        };
      }
      return {
        hook_id: hookId,
        success: false,
        error: String(e),
        duration_ms: Date.now() - startTime,
      };
    }
  }

  /**
   * 执行函数 Hook
   */
  private async executeFunction(
    hook: FunctionHook,
    input: HookInput
  ): Promise<HookOutput | undefined> {
    if (!hook.callback) return undefined;

    // 执行回调（带超时）
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), hook.timeout);
    });

    try {
      const result = await Promise.race([
        Promise.resolve(hook.callback(input)),
        timeoutPromise,
      ]);

      // 转换结果
      if (result === undefined || result === null) {
        return undefined;
      } else if (typeof result === 'boolean') {
        return { block: !result };
      } else if (typeof result === 'object' && 'block' in result) {
        return result as HookOutput;
      }
      return undefined;
    } catch (e) {
      throw new Error(`${hook.error_message}: ${e}`);
    }
  }

  /**
   * 执行命令 Hook
   */
  private async executeCommand(
    hook: HookCommand,
    input: HookInput
  ): Promise<HookOutput | undefined> {
    const env = { ...hook.env };
    env.HOOK_EVENT = input.event;
    env.HOOK_SESSION_ID = input.session_id;
    if (input.tool_name) {
      env.HOOK_TOOL_NAME = input.tool_name;
    }

    const stdinData = JSON.stringify(this.inputToDict(input));

    return new Promise((resolve, reject) => {
      const proc = spawn(hook.command, [], {
        shell: true,
        env: { ...process.env, ...env },
        timeout: hook.timeout,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', data => {
        stdout += data.toString();
      });

      proc.stderr.on('data', data => {
        stderr += data.toString();
      });

      proc.on('error', err => {
        reject(new Error(`Command execution failed: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        // 被信号杀死（含 timeout 触发的 SIGTERM）：基础设施失败，不是 hook 主动 deny
        if (signal) {
          reject(
            new HookCommandError(
              `Command hook killed by signal ${signal}` +
                (signal === 'SIGTERM' ? ` (likely timeout after ${hook.timeout}ms)` : ''),
              stderr.trim(),
              code,
              signal,
              false,
            ),
          );
          return;
        }

        // 非零退出码：hook 主动 deny/block，必须让 block 语义生效而非被当成成功
        if (code !== 0 && code !== null) {
          // 退出码非零时优先解析 stdout 里的结构化 block 输出，缺省则按 deny 处理
          let blockReason = stderr.trim() || `Command hook exited with code ${code}`;
          if (stdout) {
            try {
              const parsed = JSON.parse(stdout) as HookOutput;
              if (parsed.block_reason) blockReason = parsed.block_reason;
            } catch {/* swallowed: unhandled error */
              if (stdout.trim()) blockReason = stdout.trim();
            }
          }
          reject(
            new HookCommandError(
              `Command hook exited with non-zero code ${code}`,
              stderr.trim(),
              code,
              null,
              true,
              blockReason,
            ),
          );
          return;
        }

        if (stdout) {
          try {
            const output = JSON.parse(stdout);
            resolve(output as HookOutput);
          } catch {/* swallowed: unhandled error */
            resolve({ system_message: stdout.trim() });
          }
        } else {
          resolve(undefined);
        }
      });

      // 发送 stdin。子进程可能在写入前就退出（如 `exit 0`），stdin 已关闭会抛 EPIPE，
      // 这里吞掉写错误：退出码/输出由 close 事件负责，stdin 写失败不应让整个 hook 崩溃。
      proc.stdin?.on('error', () => {
        /* 子进程提前退出导致的 EPIPE/ECONNRESET，忽略 */
      });
      try {
        proc.stdin?.write(stdinData);
        proc.stdin?.end();
      } catch {
        /* 同步写抛错同样忽略 */
      }
    });
  }

  /**
   * 将 HookInput 转换为字典
   */
  private inputToDict(input: HookInput): Record<string, unknown> {
    return {
      event: input.event,
      session_id: input.session_id,
      timestamp: input.timestamp,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_use_id: input.tool_use_id,
      tool_result: input.tool_result,
      error: input.error,
      agent_id: input.agent_id,
      agent_name: input.agent_name,
      task_id: input.task_id,
      task_subject: input.task_subject,
      permission_suggestions: input.permission_suggestions,
      decision: input.decision,
      compact_type: input.compact_type,
      tokens_saved: input.tokens_saved,
      summary: input.summary,
      old_value: input.old_value,
      new_value: input.new_value,
      user_message: input.user_message,
    };
  }
}

// ─── 便捷函数（仅保留有外部消费者的） ────────────────────────────────────────

/**
 * 通用 Hook 执行入口
 */
export async function executeHooks(
  event: HookEvent,
  sessionId: string,
  toolName?: string,
  partial?: Partial<HookInput>
): Promise<AggregatedHookResult> {
  const input: HookInput = {
    event,
    session_id: sessionId,
    timestamp: Date.now(),
    ...partial,
  };

  const executor = new HookExecutor();
  return executor.execute(event, input, toolName);
}

/**
 * 执行 Stop Hook
 */
export async function executeStop(
  sessionId: string,
  reason?: string
): Promise<AggregatedHookResult> {
  return executeHooks(HookEvent.STOP, sessionId, undefined, {
    user_message: reason,
  });
}

/**
 * 执行 PreCompact Hook
 */
export async function executePreCompact(
  sessionId: string,
  compactType = 'auto'
): Promise<AggregatedHookResult> {
  return executeHooks(HookEvent.PRE_COMPACT, sessionId, undefined, {
    compact_type: compactType,
  });
}

/**
 * 执行 PostCompact Hook
 */
export async function executePostCompact(
  sessionId: string,
  compactType = 'auto',
  tokensSaved?: number,
  summary?: string
): Promise<AggregatedHookResult> {
  return executeHooks(HookEvent.POST_COMPACT, sessionId, undefined, {
    compact_type: compactType,
    tokens_saved: tokensSaved,
    summary: summary,
  });
}
