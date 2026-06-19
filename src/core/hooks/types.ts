/**
 * Hook 类型定义
 *
 * 实际运行时只消费 3 个生命周期事件（STOP / PRE_COMPACT / POST_COMPACT），
 * 此处不再保留预想中的 17 个 hook 类型——按需新增即可。
 */

/**
 * Hook 事件类型
 */
export enum HookEvent {
  /** Compact 压缩前 */
  PRE_COMPACT = 'pre_compact',
  /** Compact 压缩后 */
  POST_COMPACT = 'post_compact',
  /** Leader/Worker 主循环 stop */
  STOP = 'stop',
  /** 工具执行前 — 可修改参数或阻止执行 */
  TOOL_EXECUTE_BEFORE = 'tool.execute.before',
  /** 工具执行后 — 可修改输出 */
  TOOL_EXECUTE_AFTER = 'tool.execute.after',
  /** 消息发送到 LLM 前 — 可过滤/修改/添加消息 */
  CHAT_MESSAGES_TRANSFORM = 'chat.messages.transform',
}

/**
 * 所有有效的事件类型
 */
export const HOOK_EVENTS: string[] = Object.values(HookEvent);

/**
 * Hook 输入
 */
export interface HookInput {
  event: HookEvent;
  session_id: string;
  timestamp?: number;

  // 通用字段
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;

  // 结果字段
  tool_result?: unknown;

  // 错误字段
  error?: string;

  // Agent 字段
  agent_id?: string;
  agent_name?: string;

  // Task 字段
  task_id?: string;
  task_subject?: string;

  // Permission 字段
  permission_suggestions?: unknown[];
  decision?: string;

  // Compact 字段
  compact_type?: string;
  tokens_saved?: number;
  summary?: string;

  // 环境变化字段
  old_value?: unknown;
  new_value?: unknown;

  // 用户消息
  user_message?: string;
}

/**
 * Hook 输出
 */
export interface HookOutput {
  // 是否阻止后续操作
  block?: boolean;

  // 阻止原因
  block_reason?: string;

  // 修改后的输入
  modified_input?: Record<string, unknown>;

  // 系统消息
  system_message?: string;

  // 权限更新
  permission_updates?: unknown[];
}

/**
 * Hook 回调类型
 */
export type HookCallback = (
  input: HookInput
) => HookOutput | Promise<HookOutput> | boolean | Promise<boolean> | void | Promise<void>;

/**
 * Hook 匹配器
 */
export interface HookMatcher {
  event: HookEvent;
  matcher: string;
  conditions?: Record<string, unknown>;
}

/**
 * Shell 命令 Hook
 */
export interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
  env: Record<string, string>;
}

/**
 * 函数 Hook
 */
export interface FunctionHook {
  type: 'function';
  id?: string;
  callback?: HookCallback;
  timeout: number;
  error_message: string;
}

/**
 * Hook 定义
 */
export type HookDefinition = HookCommand | FunctionHook;

/**
 * 已注册的 Hook
 */
export interface RegisteredHook {
  matcher: HookMatcher;
  hook: HookDefinition;
  priority: number;
  enabled: boolean;
  source: string;
}

/**
 * Hook 执行结果
 */
export interface HookResult {
  hook_id: string;
  success: boolean;
  output?: HookOutput;
  error?: string;
  duration_ms: number;
}

/**
 * 聚合 Hook 结果
 */
export interface AggregatedHookResult {
  results: HookResult[];
  blocked: boolean;
  block_reason?: string;
  modified_input?: Record<string, unknown>;
  system_messages: string[];
}

/**
 * 创建默认的 HookInput
 */
export function createHookInput(
  event: HookEvent,
  session_id: string,
  partial?: Partial<HookInput>
): HookInput {
  return {
    event,
    session_id,
    timestamp: Date.now(),
    ...partial,
  };
}

/**
 * 创建默认的 HookOutput
 */
export function createHookOutput(partial?: Partial<HookOutput>): HookOutput {
  return {
    block: false,
    ...partial,
  };
}