/**
 * SessionRun — 会话编排运行相位（Orchestration Kernel v2）
 *
 * 与 TaskBoard/AgentPool 内核 FSM 正交：
 * - Task/Agent 描述「工作项/进程」
 * - SessionRun 描述「整场会话现在在哪个编排相位」
 *
 * 详见 docs/contracts/orchestration-kernel-v2.md
 */

export const SESSION_RUN_PHASES = [
  'idle',
  'thinking',
  'waiting_user',
  'waiting_workers',
  'dispatching',
  'recovering',
  'eternal_patrol',
] as const;

export type SessionRunPhase = (typeof SESSION_RUN_PHASES)[number];

/** 相位原因码：稳定字符串，便于日志/UI/不变量测试 */
export type SessionRunReason =
  | 'init'
  | 'busy_thinking'
  | 'explicit_user_gate'
  | 'pending_review'
  | 'leader_deferred_ready_tasks'
  | 'soft_wait_user'
  | 'workers_running'
  | 'dispatching'
  | 'recovering'
  | 'eternal_patrol'
  | 'all_work_terminal'
  | 'no_open_work'
  | 'ready_needs_decision'
  | 'unknown';

export interface SessionRunSignals {
  /** Leader 正在 leaderThinkAndAct / LLM 工具循环 */
  isBusyThinking: boolean;
  /** 遗留影子门：true 表示主循环 latched 等待 */
  waitingForUserFlag: boolean;
  /** ask_user / permission 等硬用户门 */
  explicitUserGate: boolean;
  /** 计划评审门 */
  pendingReview: boolean;
  /** 依赖与契约已满足、可派发的任务数 */
  readyTaskCount: number;
  /** 原始 dispatchable（含 blocked_reason）数，可选 */
  dispatchableRawCount?: number;
  /** 正在跑的 agent 数 */
  runningAgentCount: number;
  /** 恢复中任务/agent 数 */
  recoveringCount: number;
  /** 正在派发（spawn/assign 过渡），可选 */
  isDispatching?: boolean;
  controlMode: 'manual' | 'eternal';
  collaborationMode: 'solo' | 'team';
  /** team 模式下 roster 是否就绪；solo 为 null */
  teamReady: boolean | null;
  allTasksTerminal: boolean;
  /** eternal 空闲巡逻中 */
  isEternalPatrolIdle?: boolean;
}

export interface SessionRunSnapshot {
  phase: SessionRunPhase;
  reason: SessionRunReason;
  generation: number;
  updatedAt: number;
  readyTaskCount: number;
  runningAgentCount: number;
  recoveringCount: number;
  waitingForUser: boolean;
  explicitUserGate: boolean;
  pendingReview: boolean;
  controlMode: 'manual' | 'eternal';
  collaborationMode: 'solo' | 'team';
  teamReady: boolean | null;
  /** ready>0 且 0 running 且未强制推进时为 true（产品上「有活未派」） */
  hasDeferredReadyWork: boolean;
  /** manual 下若 phase 被标 idle 但 ready>0，属于不变量违规（诊断用） */
  silentIdleViolation: boolean;
}

export function isSessionRunPhase(value: unknown): value is SessionRunPhase {
  return typeof value === 'string' && (SESSION_RUN_PHASES as readonly string[]).includes(value);
}
