/**
 * Worker (BaseAgent) P0 message dispatching helper.
 *
 * 历史问题：BaseAgent 在收到任意 P0 消息时无脑 abort 当前 LLM，
 * 表现为：worker 正在生成长 tool_input 时，被无关的 P0 事件
 * （task_complete/task_failed 串扰、agent_health_critical 报告等）
 * 中断，整轮丢弃，重新思考。
 *
 * 真正需要 abort worker 当前 LLM 的 P0 类型只有两种：
 *   - user_intervention：Leader 通过 send_message_to_agent 注入新指令，
 *     语义上就是"打断现在做的事"。
 *   - force_terminate：SessionManager 取消任务，必须立即停。
 *
 * 其他 P0（task_complete / task_failed / agent_health_critical）对 worker 而言
 * 都不是行动指令（要么是其他 agent 的状态、要么是自己的健康报告回声），
 * 应忽略，不要破坏当前 LLM 的部分输出。
 */

export interface AgentP0MessageLite {
  priority?: number;
  to?: string;
  from?: unknown;
  type?: string;
}

export type AgentP0Action =
  | { kind: 'ignore' }
  | { kind: 'abort'; sender: string; type: string };

/**
 * Worker 真正需要 abort 当前 LLM 的 P0 类型集合。
 */
const WORKER_ABORT_TYPES = new Set<string>([
  'user_intervention',
  'force_terminate',
]);

/**
 * 决定 worker 收到 P0 消息时应做什么。
 *
 * - priority !== 0 / to 不匹配：'ignore'
 * - from === 'user' 直接来自用户：'ignore'（用户路径走其他通道，与本订阅无关）
 *   注：现实中 Leader 注入的 user_intervention from 是 leader 的 busName，
 *   并非字面 'user'，所以这条路径不影响 user_intervention 的中断。
 * - type ∈ {user_intervention, force_terminate}：'abort'
 * - 其他类型（task_complete/task_failed/agent_health_critical/未知）：'ignore'
 */
export function decideAgentP0Action(
  data: AgentP0MessageLite,
  busName: string,
): AgentP0Action {
  if (data.priority !== 0) return { kind: 'ignore' };
  if (data.to !== busName) return { kind: 'ignore' };
  const sender = String(data.from ?? '');
  if (sender === 'user') return { kind: 'ignore' };
  const type = String(data.type ?? '');
  if (!WORKER_ABORT_TYPES.has(type)) return { kind: 'ignore' };
  return { kind: 'abort', sender, type };
}
