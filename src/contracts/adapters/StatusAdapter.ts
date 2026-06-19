export {
  isActiveSessionPhase,
  isTerminalAgentStatus,
  isTerminalTaskStatus,
  isTerminalToolCallStatus,
  type AgentRunStatus,
  type SessionPhase,
  type TaskStatus,
  type ToolCallStatus,
  type WorkflowState,
} from '../types/Status.js';

/**
 * 凌霄统一状态语义合同。
 *
 * 这里是后端内核、Web UI、TUI、daemon/QQ 共同使用的唯一状态解释层：
 * - Core* 类型描述内核真实状态机，不面向 UI 文案。
 * - Normalized* 类型描述跨端展示 / SSE / 统计 / 诊断使用的归一状态。
 * - 内核模块可以保存自己的 canonical 状态，但不能再私藏 transition 表或终态解释集合。
 */
export type NormalizedAgentStatus = 'idle' | 'running' | 'recovering' | 'completed' | 'failed' | 'interrupted';
export type NormalizedTaskStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed' | 'cancelled';
export type NormalizedTaskDisplayState = NormalizedTaskStatus | 'dispatchable';
export type NormalizedRunStatus = 'idle' | 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type NormalizedLeaderStatusKind = 'active' | 'idle' | 'waiting' | 'interrupted' | 'completed';
export type NormalizedToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type NormalizedWorkflowNodeStatus = 'idle' | 'waiting' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused' | 'cancelled';
export type NormalizedWorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
export type NormalizedTerminalSessionStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'killed';
export type NormalizedDaemonStatus = 'running' | 'stopped';
export type NormalizedSupervisorStatus = 'watching' | 'restarting' | 'given_up' | 'stopped';
export type NormalizedWorktreeStatus = 'active' | 'dirty' | 'merged' | 'removed' | 'failed';
export type NormalizedQQBotStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type NormalizedBlackboardIntentStatus = 'open' | 'claimed' | 'resolved';
export type NormalizedTeamDeliveryStatus = 'queued' | 'delivered' | 'read' | 'skipped' | 'failed';
export type NormalizedProjectRuntimeMode =
  | 'draft'
  | 'planning'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'recovering'
  | 'completed'
  | 'archived';
export type NormalizedProjectBacklogStatus = 'planned' | 'ready' | 'running' | 'blocked' | 'completed' | 'cancelled';
export type NormalizedProjectMilestoneStatus = 'pending' | 'at_risk' | 'completed' | 'missed';
export type NormalizedProjectRiskStatus = 'open' | 'mitigated' | 'accepted' | 'closed';
export type NormalizedProjectDependencyStatus = 'requested' | 'awaiting_input' | 'fulfilled' | 'failed';
export type NormalizedWikiGenerationPhase = 'scanning' | 'analyzing' | 'generating' | 'finalizing' | 'idle';

const NORMALIZED_TASK_STATUS_VALUES = new Set<string>([
  'pending',
  'blocked',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

function isNormalizedTaskStatusValue(value: string): value is NormalizedTaskStatus {
  return NORMALIZED_TASK_STATUS_VALUES.has(value);
}

/**
 * AgentPool 内核三态。
 * stopped 只是进程池层面的终态容器，真实结果必须结合 exitReason 再归一化。
 */
export type CoreAgentStatus = 'starting' | 'running' | 'stopped';

/**
 * 外部 agent CLI 进程状态域。
 * terminated 是主动停止，不等同 failed；跨端展示由 normalizeAgentStatus 映射为 interrupted。
 */
export type CoreExternalAgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'crashed' | 'terminated';

/**
 * Worker 子进程状态域。
 * Worker 比 AgentPool 更靠近 OS 进程，所以保留 crashed / timeout 等进程级失败原因。
 */
export type CoreWorkerStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timeout' | 'crashed' | 'terminated';

/**
 * 后台终端会话状态域。
 * resumed/started 是事件名，不是持久状态；进入统一语义层时归一为 running。
 */
export type CoreTerminalSessionStatus =
  | 'started'
  | 'running'
  | 'suspended'
  | 'resumed'
  | 'completed'
  | 'failed'
  | 'killed';

/**
 * 工作流状态域独立于任务板。
 * skipped 是节点级终态；执行超时折叠为 failed 并通过 reason/timeoutMs 表达。
 */
export type CoreWorkflowNodeStatus = NormalizedWorkflowNodeStatus;
export type CoreWorkflowExecutionStatus = NormalizedWorkflowExecutionStatus;

/**
 * Web 工具调用卡片状态域。
 * streaming_input 和 pending 都是未执行完成的打开态，跨端展示时统一归到 pending。
 */
export type CoreToolCallStatus = 'streaming_input' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Daemon / Worktree 是运维资源状态，不参与 Agent/Task/Run transition。
 */
export type CoreDaemonStatus = 'running' | 'stopped';
export type CoreSupervisorStatus = 'watching' | 'restarting' | 'given_up' | 'stopped';
export type CoreWorktreeStatus = 'active' | 'dirty' | 'merged' | 'removed' | 'failed';
export type CoreQQBotStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type CoreBlackboardIntentStatus = 'open' | 'claimed' | 'resolved';
export type CoreTeamDeliveryStatus = 'queued' | 'delivered' | 'read' | 'skipped' | 'failed';

/**
 * TaskBoard 内核状态域。
 * dispatchable 同时覆盖“可派发”和“因依赖未满足暂不可派发”的原始状态；
 * blocked / pending 只在 displayState 或 normalizeTaskStatus 中作为跨端投影出现。
 */
export type CoreTaskStatus = 'dispatchable' | 'running' | 'terminal';
export type CoreTaskExitReason = 'completed' | 'failed' | 'cancelled' | 'timeout';
export interface CoreTaskStatusTarget {
  status: CoreTaskStatus;
  exitReason?: CoreTaskExitReason;
}

/**
 * AgentPool 唯一合法 transition 表。
 * stopped -> starting 仅用于 respawn；stopped 不能直接跳 running，必须重新经历 starting。
 */
export const CORE_AGENT_TRANSITIONS: Readonly<Record<CoreAgentStatus, readonly CoreAgentStatus[]>> = {
  starting: ['running', 'stopped'],
  running: ['stopped'],
  stopped: ['starting'],
};

/**
 * TaskBoard 唯一合法 transition 表。
 * terminal 是死状态；重开任务必须走 TaskBoard.reopenTask 的显式重置逻辑。
 */
export const CORE_TASK_TRANSITIONS: Readonly<Record<CoreTaskStatus, readonly CoreTaskStatus[]>> = {
  dispatchable: ['running', 'terminal'],
  running: ['terminal', 'dispatchable'],
  terminal: [],
};


export function validateCoreAgentTransition(from: CoreAgentStatus, to: CoreAgentStatus): boolean {
  return from === to || CORE_AGENT_TRANSITIONS[from].includes(to);
}

export function assertCoreAgentTransition(from: CoreAgentStatus, to: CoreAgentStatus, label = 'Agent'): void {
  if (validateCoreAgentTransition(from, to)) return;
  throw new Error(`[AgentPool] 非法状态转换：${label} 不能从 ${from} 转为 ${to}`);
}

/**
 * 判断 Worker 是否已经不可再产生运行态事件。
 * endTime 这类进程事实由调用方额外判断，这里只负责状态语义。
 */
export function isCoreWorkerTerminalStatus(status: unknown): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'timeout'
    || status === 'crashed'
    || status === 'terminated';
}

/**
 * Worker 的 active 口径包含 starting，避免进程刚创建时被上层误判为空闲。
 */
export function isCoreWorkerActiveStatus(status: unknown): boolean {
  return status === 'starting' || status === 'running';
}

export function normalizeToolCallStatus(status: unknown): NormalizedToolCallStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'streaming_input' || text === 'pending' || text === 'queued') return 'pending';
  if (text === 'running' || text === 'executing') return 'running';
  if (text === 'completed' || text === 'complete' || text === 'done' || text === 'success') return 'completed';
  if (text === 'cancelled' || text === 'canceled' || text === 'interrupted') return 'cancelled';
  if (text === 'failed' || text === 'error' || text === 'timeout') return 'failed';
  return 'pending';
}

export function isToolCallOpenStatus(status: unknown): boolean {
  const normalized = normalizeToolCallStatus(status);
  return normalized === 'pending' || normalized === 'running';
}

export function isToolCallTerminalStatus(status: unknown): boolean {
  const normalized = normalizeToolCallStatus(status);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled';
}

export function normalizeWorkflowNodeStatus(status: unknown): NormalizedWorkflowNodeStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'waiting' || text === 'blocked') return 'waiting';
  if (text === 'running' || text === 'executing') return 'running';
  if (text === 'completed' || text === 'complete' || text === 'done' || text === 'success') return 'completed';
  if (text === 'skipped' || text === 'skip') return 'skipped';
  if (text === 'paused') return 'paused';
  if (text === 'cancelled' || text === 'canceled') return 'cancelled';
  if (text === 'failed' || text === 'error' || text === 'timeout') return 'failed';
  return 'idle';
}

export function isWorkflowNodeActiveStatus(status: unknown): boolean {
  const normalized = normalizeWorkflowNodeStatus(status);
  return normalized === 'waiting' || normalized === 'running' || normalized === 'paused';
}

export function isWorkflowNodeTerminalStatus(status: unknown): boolean {
  const normalized = normalizeWorkflowNodeStatus(status);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'skipped' || normalized === 'cancelled';
}

export function normalizeWorkflowExecutionStatus(status: unknown): NormalizedWorkflowExecutionStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'paused') return 'paused';
  if (text === 'completed' || text === 'complete' || text === 'done' || text === 'success') return 'completed';
  if (text === 'cancelled' || text === 'canceled' || text === 'interrupted') return 'cancelled';
  if (text === 'timeout' || text === 'timed_out') return 'failed';
  if (text === 'failed' || text === 'error') return 'failed';
  return 'running';
}

export function isWorkflowExecutionActiveStatus(status: unknown): boolean {
  const normalized = normalizeWorkflowExecutionStatus(status);
  return normalized === 'running' || normalized === 'paused';
}

export function isWorkflowExecutionTerminalStatus(status: unknown): boolean {
  return !isWorkflowExecutionActiveStatus(status);
}

export function normalizeTerminalSessionStatus(status: unknown): NormalizedTerminalSessionStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'started' || text === 'resumed' || text === 'running') return 'running';
  if (text === 'suspended' || text === 'paused') return 'suspended';
  if (text === 'completed' || text === 'complete' || text === 'done' || text === 'success') return 'completed';
  if (text === 'killed' || text === 'terminated' || text === 'cancelled' || text === 'canceled') return 'killed';
  if (text === 'failed' || text === 'error' || text === 'timeout' || text === 'orphaned') return 'failed';
  return 'failed';
}

export function isTerminalSessionActiveStatus(status: unknown): boolean {
  const normalized = normalizeTerminalSessionStatus(status);
  return normalized === 'running' || normalized === 'suspended';
}

export function isTerminalSessionTerminalStatus(status: unknown): boolean {
  return !isTerminalSessionActiveStatus(status);
}

export function normalizeDaemonStatus(status: unknown): NormalizedDaemonStatus {
  return String(status || '').trim().toLowerCase() === 'running' ? 'running' : 'stopped';
}

export function isDaemonActiveStatus(status: unknown): boolean {
  return normalizeDaemonStatus(status) === 'running';
}

/**
 * Supervisor 负责守护 daemon，本身有独立生命周期。
 * watching/restarting 是活跃态；given_up 是失败终态；stopped 是正常停止态。
 */
export function normalizeSupervisorStatus(status: unknown): NormalizedSupervisorStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'watching' || text === 'running' || text === 'active') return 'watching';
  if (text === 'restarting' || text === 'recovering') return 'restarting';
  if (text === 'given_up' || text === 'gave_up' || text === 'failed') return 'given_up';
  return 'stopped';
}

export function isSupervisorActiveStatus(status: unknown): boolean {
  const normalized = normalizeSupervisorStatus(status);
  return normalized === 'watching' || normalized === 'restarting';
}

export function isSupervisorTerminalStatus(status: unknown): boolean {
  return !isSupervisorActiveStatus(status);
}

export function isSupervisorGivenUpStatus(status: unknown): boolean {
  return normalizeSupervisorStatus(status) === 'given_up';
}

export function isSupervisorStoppedStatus(status: unknown): boolean {
  return normalizeSupervisorStatus(status) === 'stopped';
}

export function normalizeWorktreeStatus(status: unknown): NormalizedWorktreeStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'dirty') return 'dirty';
  if (text === 'merged') return 'merged';
  if (text === 'removed' || text === 'deleted') return 'removed';
  if (text === 'failed' || text === 'error' || text === 'missing') return 'failed';
  return 'active';
}

export function isWorktreeTerminalStatus(status: unknown): boolean {
  const normalized = normalizeWorktreeStatus(status);
  return normalized === 'merged' || normalized === 'removed' || normalized === 'failed';
}

/**
 * QQBot 是远程入口状态，和 daemon 进程状态分开解释。
 * connecting/connected 都算活跃，error/disconnected 都不再接受消息。
 */
export function normalizeQQBotStatus(status: unknown): NormalizedQQBotStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'connected' || text === 'online') return 'connected';
  if (text === 'connecting' || text === 'reconnecting' || text === 'starting') return 'connecting';
  if (text === 'error' || text === 'failed' || text === 'failure') return 'error';
  return 'disconnected';
}

export function isQQBotActiveStatus(status: unknown): boolean {
  const normalized = normalizeQQBotStatus(status);
  return normalized === 'connecting' || normalized === 'connected';
}

export function isQQBotTerminalStatus(status: unknown): boolean {
  return !isQQBotActiveStatus(status);
}

/**
 * Blackboard intent 是知识图谱的探索状态，不等价于任务状态。
 * open/claimed 表示仍可能继续调度，resolved 表示知识层终态。
 */
export function normalizeBlackboardIntentStatus(status: unknown): NormalizedBlackboardIntentStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'claimed' || text === 'assigned' || text === 'in_progress' || text === 'running') return 'claimed';
  if (text === 'resolved' || text === 'completed' || text === 'done') return 'resolved';
  return 'open';
}

export function isBlackboardIntentActiveStatus(status: unknown): boolean {
  const normalized = normalizeBlackboardIntentStatus(status);
  return normalized === 'open' || normalized === 'claimed';
}

export function isBlackboardIntentTerminalStatus(status: unknown): boolean {
  return normalizeBlackboardIntentStatus(status) === 'resolved';
}

/**
 * 团队投递状态只描述消息是否送达/已读，不能混入 agent 或 task 状态。
 */
export function normalizeTeamDeliveryStatus(status: unknown): NormalizedTeamDeliveryStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'delivered' || text === 'sent') return 'delivered';
  if (text === 'read' || text === 'seen') return 'read';
  if (text === 'skipped' || text === 'ignored') return 'skipped';
  if (text === 'failed' || text === 'error') return 'failed';
  return 'queued';
}

export function isTeamDeliveryTerminalStatus(status: unknown): boolean {
  const normalized = normalizeTeamDeliveryStatus(status);
  return normalized === 'read' || normalized === 'skipped' || normalized === 'failed';
}

export function isTeamDeliveryActiveStatus(status: unknown): boolean {
  return !isTeamDeliveryTerminalStatus(status);
}

/**
 * 项目运行 mode 是长周期项目态，统一折叠成 Web/TUI 容易消费的生命周期。
 */
export function normalizeProjectRuntimeMode(mode: unknown): NormalizedProjectRuntimeMode {
  const text = String(mode || '').trim().toLowerCase();
  if (text === 'planning' || text === 'replanning') return 'planning';
  if (text === 'sprint_in_flight' || text === 'evaluating' || text === 'repairing') return 'running';
  if (text === 'waiting_for_dependency') return 'waiting';
  if (text === 'blocked_external') return 'blocked';
  if (text === 'recovering') return 'recovering';
  if (text === 'completed') return 'completed';
  if (text === 'archived') return 'archived';
  return 'draft';
}

export function isProjectRuntimeActiveMode(mode: unknown): boolean {
  const normalized = normalizeProjectRuntimeMode(mode);
  return normalized === 'planning'
    || normalized === 'running'
    || normalized === 'waiting'
    || normalized === 'blocked'
    || normalized === 'recovering';
}

export function isProjectRuntimeTerminalMode(mode: unknown): boolean {
  const normalized = normalizeProjectRuntimeMode(mode);
  return normalized === 'completed' || normalized === 'archived';
}

export function normalizeProjectBacklogStatus(status: unknown): NormalizedProjectBacklogStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'ready') return 'ready';
  if (text === 'in_progress' || text === 'running') return 'running';
  if (text === 'blocked') return 'blocked';
  if (text === 'completed' || text === 'done') return 'completed';
  if (text === 'cancelled' || text === 'canceled') return 'cancelled';
  return 'planned';
}

export function isProjectBacklogTerminalStatus(status: unknown): boolean {
  const normalized = normalizeProjectBacklogStatus(status);
  return normalized === 'completed' || normalized === 'cancelled';
}

export function normalizeProjectMilestoneStatus(status: unknown): NormalizedProjectMilestoneStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'at_risk' || text === 'risk') return 'at_risk';
  if (text === 'completed' || text === 'done') return 'completed';
  if (text === 'missed' || text === 'failed') return 'missed';
  return 'pending';
}

export function isProjectMilestoneTerminalStatus(status: unknown): boolean {
  const normalized = normalizeProjectMilestoneStatus(status);
  return normalized === 'completed' || normalized === 'missed';
}

export function normalizeProjectRiskStatus(status: unknown): NormalizedProjectRiskStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'mitigated') return 'mitigated';
  if (text === 'accepted') return 'accepted';
  if (text === 'closed' || text === 'resolved') return 'closed';
  return 'open';
}

export function isProjectRiskTerminalStatus(status: unknown): boolean {
  const normalized = normalizeProjectRiskStatus(status);
  return normalized === 'mitigated' || normalized === 'accepted' || normalized === 'closed';
}

export function normalizeProjectDependencyStatus(status: unknown): NormalizedProjectDependencyStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'awaiting_input' || text === 'waiting' || text === 'pending_user') return 'awaiting_input';
  if (text === 'fulfilled' || text === 'completed' || text === 'done') return 'fulfilled';
  if (text === 'failed' || text === 'error') return 'failed';
  return 'requested';
}

export function isProjectDependencyTerminalStatus(status: unknown): boolean {
  const normalized = normalizeProjectDependencyStatus(status);
  return normalized === 'fulfilled' || normalized === 'failed';
}

/**
 * Wiki 生成进度是 UI/后台流式进度的阶段语义；idle 只作为无活动兜底。
 */
export function normalizeWikiGenerationPhase(phase: unknown): NormalizedWikiGenerationPhase {
  const text = String(phase || '').trim().toLowerCase();
  if (text === 'scan' || text === 'scanning') return 'scanning';
  if (text === 'analyze' || text === 'analyzing' || text === 'planning') return 'analyzing';
  if (text === 'generate' || text === 'generating' || text === 'writing') return 'generating';
  if (text === 'finalize' || text === 'finalizing' || text === 'done') return 'finalizing';
  return 'idle';
}

export function isWikiGenerationActivePhase(phase: unknown): boolean {
  return normalizeWikiGenerationPhase(phase) !== 'idle';
}

export function isCoreExternalAgentTerminalStatus(status: unknown): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'timeout'
    || status === 'crashed'
    || status === 'terminated';
}

export function isCoreExternalAgentActiveStatus(status: unknown): boolean {
  return status === 'starting' || status === 'running';
}

export function isCoreTaskTerminalStatus(status: unknown): boolean {
  return status === 'terminal';
}

export function validateCoreTaskTransition(from: CoreTaskStatus, to: CoreTaskStatus): boolean {
  return from === to || CORE_TASK_TRANSITIONS[from].includes(to);
}

export function assertCoreTaskTransition(from: CoreTaskStatus, to: CoreTaskStatus, label = '任务'): void {
  if (validateCoreTaskTransition(from, to)) return;
  const allowed = CORE_TASK_TRANSITIONS[from];
  throw new Error(`非法状态转换：${label} 不能从 ${from} 转为 ${to}（允许: ${allowed.join(', ') || '无'}）`);
}

export function assertCoreTaskExitReason(status: CoreTaskStatus, exitReason?: CoreTaskExitReason, label = '任务'): void {
  if (status === 'terminal' && !exitReason) {
    throw new Error(`${label} 转为 terminal 状态时必须指定 exitReason`);
  }
  if (status !== 'terminal' && exitReason) {
    throw new Error(`${label} 只能在 terminal 状态时设置 exitReason`);
  }
}

/**
 * Leader 工具层允许 LLM 写入的任务目标状态。
 * completed 只能由 worker 完成事件产生，Leader 手动工具目前只允许 failed/cancelled。
 */
export function normalizeTaskStatusUpdateTarget(status: unknown): CoreTaskStatusTarget | null {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'cancelled' || text === 'canceled') return { status: 'terminal', exitReason: 'cancelled' };
  if (text === 'failed') return { status: 'terminal', exitReason: 'failed' };
  return null;
}

/**
 * 外部事件、数据库快照、前端旧缓存可能带不同拼写；统一收敛到跨端 Agent 五态。
 * 注意：单独的 stopped 被视为 completed 只是展示兜底，AgentPool 内核统计应使用
 * normalizeAgentRuntimeStatus(handle)，因为那里能读到 exitReason。
 */
const AGENT_RUNNING_STATUSES = new Set([
  'running',
  'starting',
  'started',
  'working',
  'thinking',
  'calling',
  'observing',
  'streaming',
  'busy',
  'active',
  'in_progress',
]);
const AGENT_RECOVERING_STATUSES = new Set(['recovering', 'recovery', 'restarting', 'redispatching']);
const AGENT_COMPLETED_STATUSES = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'stopped']);
const AGENT_FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored', 'crashed', 'timeout']);
const AGENT_INTERRUPTED_STATUSES = new Set(['interrupted', 'paused', 'stalled', 'cancelled', 'canceled', 'terminated', 'killed']);

export function normalizeAgentStatus(status: unknown): NormalizedAgentStatus {
  const text = String(status || '').trim().toLowerCase();
  if (!text || text === 'idle' || text === 'unknown') return 'idle';
  if (AGENT_RECOVERING_STATUSES.has(text)) return 'recovering';
  if (AGENT_COMPLETED_STATUSES.has(text)) return 'completed';
  if (AGENT_FAILED_STATUSES.has(text)) return 'failed';
  if (AGENT_INTERRUPTED_STATUSES.has(text)) return 'interrupted';
  // 无法归类的非空状态字符串默认视为 running —— 实际场景中大多为进度描述
  // (如 "bootstrapping"、"⏳ LLM retry..."、"Calling tool…" 等），agent 实质仍在运行。
  return 'running';
}

/**
 * AgentPool 运行时状态归一化。
 * stopped 必须结合 exitReason 才能知道是 completed / failed / interrupted，避免
 * “被终止的 stopped”在统计或 UI 中被误显示为 completed。
 */
export function normalizeAgentRuntimeStatus(agent: unknown): NormalizedAgentStatus {
  const obj = agent && typeof agent === 'object' ? agent as Record<string, unknown> : {};
  const status = obj.status ?? agent;
  const exitReason = String(obj.exitReason || obj.exit_reason || '').trim().toLowerCase();
  if (String(status || '').trim().toLowerCase() === 'stopped' && exitReason) {
    if (exitReason === 'completed') return 'completed';
    if (exitReason === 'terminated' || exitReason === 'cancelled' || exitReason === 'canceled') return 'interrupted';
    return 'failed';
  }
  return normalizeAgentStatus(status);
}

export function isAgentTerminalStatus(status: unknown): boolean {
  const normalized = normalizeAgentStatus(status);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'interrupted';
}

export function isAgentActiveStatus(status: unknown): boolean {
  const normalized = normalizeAgentStatus(status);
  return normalized === 'running' || normalized === 'recovering';
}

export function isAgentRuntimeTerminalStatus(agent: unknown): boolean {
  const normalized = normalizeAgentRuntimeStatus(agent);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'interrupted';
}

export function isAgentRuntimeActiveStatus(agent: unknown): boolean {
  const normalized = normalizeAgentRuntimeStatus(agent);
  return normalized === 'running' || normalized === 'recovering';
}

export function mergeAgentStatus(currentStatus: unknown, incomingStatus: unknown): NormalizedAgentStatus {
  const current = normalizeAgentStatus(currentStatus);
  const incoming = incomingStatus == null ? current : normalizeAgentStatus(incomingStatus);
  // 终态不允许回退到 running（防止 snapshot 覆盖已终结的状态）
  if (isAgentTerminalStatus(current) && (incoming === 'running' || incoming === 'recovering')) return current;
  // running 不允许降级到 idle：空状态快照会归一为 idle，但 agent 实际仍在运行；
  // 允许降级会导致 UI 闪烁。
  // 真正的空闲状态由 agent_completed / agent_failed 等终态事件驱动。
  if (current === 'running' && incoming === 'idle') return current;
  return incoming;
}

export interface RuntimeWorkerFacts<TWorker = Record<string, unknown>> {
  runningWorkers: TWorker[];
  runningWorkerCount: number;
  hasRunningWorkers: boolean;
}

export type RuntimeWaitGateKind = 'permission' | 'review' | 'waiting';

export interface RuntimeWaitGate {
  kind: RuntimeWaitGateKind;
  source: 'user' | 'leader' | 'worker' | 'unknown';
}

function coerceRuntimeWorkerCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return null;
}

/**
 * Worker liveness has three fields in the runtime snapshot. Count/boolean are
 * the explicit backend facts; runningWorkers is the detail list used only when
 * explicit facts are absent.
 */
export function deriveRuntimeWorkerFacts<TWorker = Record<string, unknown>>(runtimeState: unknown): RuntimeWorkerFacts<TWorker> {
  const state = runtimeState && typeof runtimeState === 'object'
    ? runtimeState as Record<string, unknown>
    : {};
  const rawRunningWorkers = Array.isArray(state.runningWorkers)
    ? state.runningWorkers as TWorker[]
    : [];
  const explicitCount = coerceRuntimeWorkerCount(state.runningWorkerCount);
  const explicitHas = typeof state.hasRunningWorkers === 'boolean'
    ? state.hasRunningWorkers
    : null;
  const hasRunningWorkers = explicitCount !== null
    ? explicitCount > 0
    : explicitHas !== null
      ? explicitHas
      : rawRunningWorkers.length > 0;
  return {
    runningWorkers: hasRunningWorkers ? rawRunningWorkers : [],
    runningWorkerCount: explicitCount ?? (hasRunningWorkers ? rawRunningWorkers.length : 0),
    hasRunningWorkers,
  };
}

/**
 * Runtime wait gates are explicit backend snapshot facts. UI surfaces use this
 * instead of re-deriving permission/review/user-wait state from local phase.
 */
export function deriveRuntimeWaitGate(runtimeState: unknown): RuntimeWaitGate | null {
  const state = runtimeState && typeof runtimeState === 'object'
    ? runtimeState as Record<string, unknown>
    : {};
  const leader = state.leader && typeof state.leader === 'object'
    ? state.leader as Record<string, unknown>
    : {};
  const pendingUserInput = state.pendingUserInput && typeof state.pendingUserInput === 'object'
    ? state.pendingUserInput as Record<string, unknown>
    : {};
  const pendingKind = String(pendingUserInput.kind || '').trim().toLowerCase();
  const pendingPermissionRequest = leader.pendingPermissionRequest && typeof leader.pendingPermissionRequest === 'object'
    ? leader.pendingPermissionRequest as Record<string, unknown>
    : null;

  if (pendingPermissionRequest || pendingKind === 'permission_request') {
    const source = pendingPermissionRequest?.source === 'worker'
      ? 'worker'
      : pendingPermissionRequest?.source === 'leader'
        ? 'leader'
        : 'unknown';
    return { kind: 'permission', source };
  }

  if (leader.pendingReview || pendingKind === 'plan_review') {
    return { kind: 'review', source: 'user' };
  }

  if (leader.waitingForUser) {
    return { kind: 'waiting', source: 'user' };
  }

  return null;
}

/**
 * 运行时 busy 推断只读取结构化字段，不根据任意 status 文本猜。
 * 这样 Web/TUI/daemon 看到的 busy 口径来自同一份 runtime snapshot。
 */
export function runtimeImpliesBusy(runtime: unknown): boolean {
  if (!runtime || typeof runtime !== 'object') return false;
  const r = runtime as Record<string, unknown>;
  const runtimeState = r.runtimeState && typeof r.runtimeState === 'object'
    ? r.runtimeState as Record<string, unknown>
    : undefined;
  const state = runtimeState ?? r;
  const leader = state.leader && typeof state.leader === 'object'
    ? state.leader as Record<string, unknown>
    : undefined;
  const pendingUserInput = state.pendingUserInput && typeof state.pendingUserInput === 'object'
    ? state.pendingUserInput as Record<string, unknown>
    : undefined;
  const workerFacts = deriveRuntimeWorkerFacts(state);
  const summaryBusy = runtimeState ? false : Boolean(
    workerFacts.hasRunningWorkers
  );
  return Boolean(
    summaryBusy ||
    leader?.busy ||
    (leader?.running && !leader?.waitingForUser) ||
    pendingUserInput?.kind === 'message' ||
    pendingUserInput?.kind === 'unknown' ||
    workerFacts.hasRunningWorkers ||
    state.hasRecoveringTasks ||
    state.hasDispatchableTasks
  );
}

/**
 * 任务跨端语义归一化。
 * 优先读取 displayState，因为它已经包含“dispatchable 但被依赖阻塞”的投影结果；
 * 没有 displayState 时再从 TaskBoard 内核状态 + exitReason 推导。
 */
export function normalizeTaskStatus(task: unknown): NormalizedTaskStatus {
  const obj = task && typeof task === 'object' ? task as Record<string, unknown> : {};
  const displayState = String(obj.displayState || obj.display_state || '').trim().toLowerCase();
  if (displayState) {
    if (displayState === 'dispatchable') return 'pending';
    if (displayState === 'in_progress') return 'running';
    if (displayState === 'cancelled' || displayState === 'canceled') return 'cancelled';
    if (isNormalizedTaskStatusValue(displayState)) {
      return displayState;
    }
  }

  const status = String(obj.status || task || '').trim().toLowerCase();
  const exitReason = String(obj.exitReason || obj.exit_reason || '').trim().toLowerCase();
  if (status === 'terminal') {
    if (exitReason === 'completed') return 'completed';
    if (exitReason === 'cancelled' || exitReason === 'canceled') return 'cancelled';
    return 'failed';
  }
  if (status === 'dispatchable') return 'pending';
  if (status === 'in_progress') return 'running';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (isNormalizedTaskStatusValue(status)) {
    return status;
  }
  return 'pending';
}

/**
 * 任务展示态归一化。
 * dispatchable 只在“已经分配 agent、等待真正开始执行”的展示场景保留；
 * 未分配的 dispatchable 对用户展示为 pending。
 */
export function normalizeTaskDisplayState(task: unknown): NormalizedTaskDisplayState {
  const obj = task && typeof task === 'object' ? task as Record<string, unknown> : {};
  const displayState = String(obj.displayState || obj.display_state || '').trim().toLowerCase();
  if (displayState === 'dispatchable') return 'dispatchable';
  const normalized = normalizeTaskStatus(task);
  if (normalized !== 'pending') return normalized;
  const status = String(obj.status || '').trim().toLowerCase();
  const assigned = Boolean(obj.assigned_agent || obj.assignedAgent);
  return status === 'dispatchable' && assigned ? 'dispatchable' : 'pending';
}

export function isTaskTerminalStatus(task: unknown): boolean {
  const normalized = normalizeTaskStatus(task);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled';
}

export function normalizeRunStatus(status: unknown): NormalizedRunStatus {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'planning') return 'planning';
  if (text === 'running' || text === 'active' || text === 'busy') return 'running';
  if (text === 'blocked' || text === 'waiting') return 'blocked';
  if (text === 'completed' || text === 'done' || text === 'success') return 'completed';
  if (text === 'failed' || text === 'error' || text === 'crashed') return 'failed';
  if (text === 'cancelled' || text === 'canceled' || text === 'interrupted') return 'cancelled';
  return 'idle';
}

export function isRunActiveStatus(status: unknown): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized === 'planning' || normalized === 'running' || normalized === 'blocked';
}

export function isRunTerminalStatus(status: unknown): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled';
}

export function normalizeLeaderStatusKind(status: unknown): NormalizedLeaderStatusKind {
  const text = String(status || '').trim();
  const lower = text.toLowerCase();
  const runStatus = normalizeRunStatus(lower);
  if (runStatus === 'completed' || runStatus === 'failed') return 'completed';
  if (runStatus === 'cancelled') return 'interrupted';
  if (lower === 'idle' || lower.startsWith('idle ')) return 'idle';
  if (lower.includes('waiting') || text.includes('等待用户输入') || text.includes('等待输入')) return 'waiting';
  if (runStatus === 'planning' || runStatus === 'running' || runStatus === 'blocked') return 'active';
  if (!text) return 'idle';
  return leaderStatusTextImpliesActive(text) ? 'active' : 'idle';
}

/**
 * Leader 仍有少量自然语言状态文本来自流式事件。
 * 这些文本只在这里兜底解释，SSE/Web/TUI 不再各自写 includes 规则。
 */
export function leaderStatusTextImpliesActive(status: unknown): boolean {
  const text = String(status || '');
  if (!text) return false;
  return (
    text.includes('Calling LLM') ||
    text.includes('Thinking') ||
    text.includes('Context Managing') ||
    text.includes('LLM') ||
    text.includes('请求模型') ||
    text.includes('等待模型响应') ||
    text.includes('模型响应') ||
    text.includes('处理新事件') ||
    text.includes('处理用户输入') ||
    text.includes('自治编排') ||
    text.includes('执行工具') ||
    text.includes('格式纠正') ||
    text.includes('空响应重试')
  );
}
