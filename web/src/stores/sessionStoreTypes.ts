// ─── Shared types for sessionStore modules ───

import type { BaseMessage, ContentBlock as ContractContentBlock } from '@contracts/types/Message';
import type { EventProcessorState } from '@contracts/adapters/EventAdapter';
import type {
  AgentRunStatus,
  SessionPhase as ContractSessionPhase,
  ToolCallStatus,
  WorkflowState,
} from '@contracts/types/Status';
import type { TokenUsageView } from '@contracts/types/TokenUsage';
import type { WorkerBackend } from '@contracts/types/Agent';
import type { ProjectBlueprint } from '../types/blueprint';

export type AgentStatusValue = AgentRunStatus | string;

/** 内容块：保持文字和工具调用的交错顺序 */
export type ContentBlock =
  | Extract<ContractContentBlock, { type: 'text' | 'thinking' }>
  | { type: 'tool_call'; toolCallId: string };

export interface Message extends Omit<BaseMessage, 'content'> {
  content: string;
  isStreaming?: boolean;
  retrying?: boolean;
  error?: boolean;
  errorKind?: string;
  toolCalls?: ToolCall[];
  thinkingContent?: string;
  /** 流式开始时间戳，用于 ChatView 状态条计算 chars/s 速率 */
  streamStartedAt?: number;
  /** Inline agent activity indicators — compact badges showing which agents are running */
  agentActivity?: AgentActivity[];
  /**
   * 有序内容块列表：保持文字和工具调用的交错顺序。
   * 渲染时按此数组顺序依次渲染 text 段落和 tool_call 卡片。
   */
  contentBlocks?: ContentBlock[];
  /** Agent question requiring user input */
  askUserQuestion?: {
    question: string;
    options?: Array<{ value: string; label?: string }>;
    multiSelect?: boolean;
    answered?: boolean;
    answeredValue?: string;
    /** Multi-question wizard mode */
    questions?: Array<{
      question: string;
      options?: Array<{ value: string; label?: string }>;
      multiSelect?: boolean;
    }>;
  };
}

export interface ToolCall {
  id: string;
  tool: string;
  input: unknown;
  result?: unknown;
  /**
   * 工具状态：
   * - streaming_input: LLM 仍在流式生成 tool 参数 JSON
   * - pending: 已完成参数，等待执行调度
   * - running: 正在执行
   * - completed / failed / cancelled: 终态
   */
  status: ToolCallStatus;
  /** 流式入参累积字符数（用于 ChatView 状态条显示 ~N tokens · M chars） */
  inputCharCount?: number;
  /** 第一个入参 delta 到达的时间戳（用于计算 chars/s 速率） */
  firstDeltaAt?: number;
  /** running 状态对应的开始时间，用于卡片"已执行 Xs"耗时计数器 */
  startedAt?: number;
  /** 终态对应的结束时间，用于显示总耗时 */
  endedAt?: number;
  /** Leader/runtime 未返回工具结果时的结构化收尾原因，不等同工具执行结果。 */
  settleReason?: 'idle' | 'interrupted' | 'runtime_idle';
  settleDetail?: string;
  displayStatus?: string;
  /** Shell 等工具执行期间的流式输出（逐 chunk 追加） */
  streamingOutput?: string;
  /** 心跳进度消息（非 Shell 工具执行期间，如 "web_fetch 运行 8s..."） */
  progressMessage?: string;
}

export interface HistoryMessageRow {
  role: string;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: HistoryToolCall[];
  tool_call_id?: string;
  timestamp?: unknown;
}

export interface HistoryToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface SessionListRow {
  id: string;
  created_at: number;
  workspace: string;
  status: string;
  summary?: string;
  name?: string;
  isActive?: boolean;
  runtimeState?: unknown;
  turn?: unknown;
}

export interface AgentHistoryEntry {
  agentName: string;
  role: string;
  status: string;
  taskId?: string;
  tokenUsage?: TokenUsageView;
  messages: AgentHistoryMessageRow[];
}

export interface AgentHistoryMessageRow extends HistoryMessageRow {
  agentName?: string;
}

export type AgentHistoryResponse = Record<string, AgentHistoryEntry>;

export interface CreateSessionResponse {
  id: string;
}

export interface AgentActivity {
  agentId: string;
  agentName: string;
  status: AgentStatusValue;
  taskId?: string;
  workingDirectory?: string;
  backend?: WorkerBackend;
  visibility?: 'team' | 'ephemeral';
  owner?: 'leader' | 'team';
  interactive?: boolean;
  persistAcrossTurns?: boolean;
  teamMember?: string | null;
}

export interface AgentRuntime {
  agentId: string;
  agentName: string;
  role: string;
  status: AgentStatusValue;
  taskId?: string;
  workingDirectory?: string;
  writeScope?: string[];
  backend?: WorkerBackend;
  visibility?: 'team' | 'ephemeral';
  owner?: 'leader' | 'team';
  interactive?: boolean;
  persistAcrossTurns?: boolean;
  teamMember?: string | null;
  externalSessionId?: string;
  pid?: number;
  spawnedAt?: number;
}

export interface TeamMessageItem {
  id: string;
  fromTeam: string;
  fromMember?: string;
  toTeam: string;
  toMember?: string;
  content: string;
  urgency: 'normal' | 'urgent';
  timestamp: number;
  isBroadcast: boolean;
  kind?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  readBy?: string[];
}

/** A single message inside an agent's conversation panel */
export interface AgentMessage {
  id: string;
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'status';
  content: string;
  tool?: string;
  timestamp: number;
  isStreaming?: boolean;
  /**
   * 流式入参累积字符数（用于 ChatView 状态条显示 ~N tokens · M chars）。
   * 仅 type === 'tool_call' && isStreaming 期间有意义。
   */
  inputCharCount?: number;
  /** 第一个入参 delta 到达时间，用于计算 chars/s 速率 */
  firstDeltaAt?: number;
  /** 工具开始执行时间（已完成 streaming_input → running 切换） */
  startedAt?: number;
  /** 工具终态时间，用于显示总耗时 */
  endedAt?: number;
  /** 工具最终状态（仅 type === 'tool_call' 时有意义） */
  toolStatus?: Exclude<ToolCallStatus, 'pending'>;
  /** Shell/Python 等工具执行期间的流式输出（逐 chunk 追加）。对齐 leader ToolCall.streamingOutput。 */
  streamingOutput?: string;
  /** 心跳进度消息（非流式输出工具执行期间，如 "web_fetch 已运行 8s..."）。对齐 leader ToolCall.progressMessage。 */
  progressMessage?: string;
}

/** Map DB message role to AgentMessage type for history restoration */
export function mapDbRoleToAgentType(
  role: string,
  tool_calls?: unknown[],
  tool_call_id?: string,
): AgentMessage['type'] {
  if (role === 'tool') return 'tool_result';
  if (role === 'assistant' && tool_calls && tool_calls.length > 0) return 'tool_call';
  if (role === 'assistant') return 'text';
  if (role === 'status') return 'status';
  return 'text';
}

/** Per-agent conversation state */
export interface AgentConversation {
  agentId: string;
  agentName: string;
  role: string;
  status: AgentStatusValue;
  /** P0-5 修复（audit-2026-05-15）：与 worker 关联的 task ID，用于 Team↔Task 视图分组 */
  taskId?: string;
  workingDirectory?: string;
  writeScope?: string[];
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
  logPath?: string;
  diagnostics?: {
    stderrTail?: string[];
    stdoutTail?: string[];
  };
  recovery?: {
    recoverable?: boolean;
    recoveryAction?: string;
  };
  messages: AgentMessage[];
  /** Summary shown in the panel tab */
  summary?: string;
  /** Cumulative token usage for this agent (updated in real-time per LLM call) */
  tokenUsage?: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number };
  /** Context window usage ratio 0-1 (prompt tokens / model context limit) */
  contextRatio?: number;
  /** Timestamp of last token update — used to drop out-of-order SSE events */
  _lastTokenTs?: number;
  /** P0 死链修复：Agent 最近一次错误信息 */
  lastError?: string;
}

export interface SessionInfo {
  id: string;
  workspace: string;
  status: string;
  createdAt: number;
  summary?: string;
  isActive?: boolean;
  runtimeSnapshot?: SessionRuntimeSnapshot | null;
  name?: string;
  created_at?: number;
}

export type SessionPhase = ContractSessionPhase;

export type TokenUsage = TokenUsageView;

export interface DAGSnapshot {
  sessionId: string;
  runId?: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ from: string; to: string; type: string }>;
  ready: string[];
  blocked: string[];
  running: string[];
  terminal: string[];
  criticalPath?: string[];
  updatedAt: number;
}

export interface RunExplanation {
  mode: 'manual' | 'eternal';
  state: 'working' | 'waiting_for_dependency' | 'waiting_for_user' | 'evaluating' | 'repairing' | 'blocked' | 'idle';
  reason: string;
  nextAction?: string;
  activeTaskIds?: string[];
  activeAgentNames?: string[];
  blockedTaskIds?: string[];
  since: number;
  confidence?: 'observed' | 'reported' | 'inferred';
}

export interface OrchestrationStatus {
  active: boolean;
  busy?: boolean;
  summary: string;
  state: WorkflowState;
  reason?: string;
  updatedAt: number;
  runId?: string;
  generation?: number;
  totalNodes?: number;
  completedNodes?: number;
  failedNodes?: number;
  blockedNodes?: number;
  activeNodeIds?: string[];
  currentNodeId?: string | null;
  bottleneck?: string;
  eventCount?: number;
  eventHistory?: Array<{
    kind: 'applied' | 'rejected' | 'repair' | 'reset' | 'node';
    eventType: string;
    taskId?: string;
    nodeKind?: string;
    verdict?: string;
    reason?: string;
    ts: number;
    /** P3: repair chain generation (0=original, 1=first repair, ...) */
    generation?: number;
    /** P3: agent that executed this task */
    agentName?: string;
    /** P3: repair count for this task in the repair chain */
    repairCount?: number;
  }>;
}

export interface SessionRuntimeWorkerSummary {
  agentId: string;
  name: string;
  roleType: string;
  taskId: string;
  status: AgentStatusValue;
  visibility?: 'team' | 'ephemeral';
  owner?: 'leader' | 'team';
  interactive?: boolean;
  persistAcrossTurns?: boolean;
  teamMember?: string | null;
  iteration?: number;
  lastActivity?: number;
}

export interface SessionRuntimeRecoveringTask {
  taskId: string;
  agentName: string;
  category: string;
  faultClass: string;
  recoveryAction: string;
  lastActivityAt?: number;
}

export interface SessionModeRuntimeProjection {
  controlMode: 'manual' | 'eternal';
  route: {
    mode: 'direct' | 'hybrid' | 'delegate' | 'unknown';
    preference: 'auto' | 'direct' | 'hybrid' | 'delegate';
    reason?: string;
    source: 'leader' | 'session' | 'default';
  };
  collaboration: {
    mode: 'solo' | 'team';
    source: 'explicit' | 'legacy' | 'default';
    activeTeamName?: string | null;
    teamEnabled: boolean;
  };
  workflow: {
    enabled: boolean;
    activeExecutionCount: number;
  };
  blackboard: {
    mode: 'off' | 'summary' | 'full';
    source: 'default' | 'explicit' | 'team' | 'workflow' | 'contract_bound';
  };
  permission: {
    mode: 'strict' | 'dev' | 'networked' | 'yolo';
    summary?: string;
  };
  blueprint?: ProjectBlueprint | null;
}

export type SessionEternalRuntimeStatus =
  | 'disabled'
  | 'paused'
  | 'ready'
  | 'waiting'
  | 'patrolling'
  | 'silenced'
  | 'budget_exhausted'
  | 'circuit_open';

export interface SessionEternalRuntimeSnapshot {
  enabled: boolean;
  status: SessionEternalRuntimeStatus;
  goal: {
    description: string;
    paused: boolean;
    createdAt: number;
    updatedAt: number;
  } | null;
  currentPatrolIntervalMs: number;
  consecutiveIdlePatrols: number;
  lastPatrolAtMs: number;
  nextPatrolDueAtMs: number;
  currentWindowTokens: number;
  tokenBudgetPerHour: number;
  windowStartMs: number;
  consecutiveApiFailures: number;
  circuitOpenUntilMs: number;
  totalPatrols: number;
  silenceLockEngaged: boolean;
  lastPatrolOutcome: 'productive' | 'idle' | 'never';
  workerCompletionCount: number;
  patrolInFlight: boolean;
  lastFingerprintKnown: boolean;
}

export interface SessionRuntimeSnapshot {
  sessionId: string;
  workspace: string;
  sessionStatus: string;
  modes: SessionModeRuntimeProjection;
  leader: {
    running: boolean;
    busy?: boolean;
    finished: boolean;
    waitingForUser: boolean;
    pendingReview: boolean;
    planApproved: boolean;
    executionMode?: string;
    executionReason?: string;
    permissionSummary?: string;
  };
  pendingUserInput?: {
    raw?: unknown;
    kind?: 'empty' | 'message' | 'permission_request' | 'plan_review' | 'unknown';
    preview?: string;
  };
  runningWorkers: SessionRuntimeWorkerSummary[];
  runningWorkerCount: number;
  hasRunningWorkers: boolean;
  recoveringTasks: SessionRuntimeRecoveringTask[];
  recoveringTaskCount?: number;
  hasRecoveringTasks?: boolean;
  dispatchableTaskCount?: number;
  hasDispatchableTasks?: boolean;
  allTasksTerminal?: boolean;
  eternal: SessionEternalRuntimeSnapshot;
}

/** Full state interface for the session store */
export interface SessionState {
  sessionId: string | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  /** Main chat messages — ONLY user ↔ leader (assistant) */
  messages: Message[];
  phase: SessionPhase;
  agents: AgentRuntime[];
  /** Per-agent conversations — displayed in the right-side AgentPanel */
  agentConversations: Record<string, AgentConversation>;
  isConnected: boolean;
  isLoadingHistory: boolean;
  streamingLastActivityAt: number;
  streamingWatchdogInterval: ReturnType<typeof setInterval> | null;
  tokenUsage: TokenUsage;
  lastCompressedAt: number | null;
  /** 压缩进行中进度（null = 未在压缩）；用于显示「压缩上下文中… (chunk i/N)」 */
  compactingProgress: {
    stage: string;
    chunkIndex?: number;
    chunkTotal?: number;
    percent?: number;
    oldTokens?: number;
    newTokens?: number;
    threshold?: number;
    messageCount?: number;
    label?: string;
    at: number;
  } | null;
  /** Leader context window 实时状态 */
  contextRuntimeState: {
    currentTokens: number;
    maxTokens: number;
    threshold: number;
    warningLevel: 'ok' | 'warning' | 'critical';
  } | null;
  /** Pending plan content awaiting user approval */
  pendingPlan: string | null;
  /** Active Leader execution plan (separate from approval pendingPlan) */
  activePlan?: unknown | null;
  /** Server startup cwd — the directory where `lingxiao start` was run */
  serverCwd: string;
  /** Watchdog: last alert timestamp, null if no alert */
  watchdogAlert: { elapsedMs: number; intervention: string; at: number } | null;
  /** Progress stagnation: last detection info */
  progressStagnant: { consecutiveRounds: number; at: number } | null;
  /** Leader status text from SSE status_change events */
  leaderStatusText: string;
  /** Unified orchestration runtime status surfaced from SSE */
  orchestrationStatus: OrchestrationStatus | null;
  dagSnapshot: DAGSnapshot | null;
  runExplanation: RunExplanation | null;
  /** Backend-derived session/kernel runtime snapshot used to calibrate Web/TUI state. */
  runtimeSnapshot: SessionRuntimeSnapshot | null;
  /** Canonical shared event reducer state, updated before view projections run. */
  eventProcessorState: EventProcessorState;
  /** Whether fetchSessions has completed at least once */
  sessionsLoaded: boolean;
  /** Pending token usage for agents that haven't spawned yet */
  _pendingTokens?: Record<string, TokenUsage>;
  /** P0 死链修复：SSE 通知事件累积列表（最多保留 50 条） */
  notifications?: Array<Record<string, unknown> & { receivedAt: number }>;
  /** Team 通信消息流（最多保留 100 条） */
  teamMessages?: TeamMessageItem[];
  /** P0 死链修复：Leader 消息排队深度 */
  leaderQueueLength?: number;
  /** Eternal Mode 控制模式（manual = 用户主导；eternal = Leader 持续接管） */
  controlMode?: 'manual' | 'eternal';
  /** 项目蓝图(复杂项目结构化状态);供 BlueprintView 渲染子系统矩阵+覆盖仪表盘。 */
  blueprint?: ProjectBlueprint | null;
  /** 权限模式（strict / dev / networked / bypass） */
  permissionMode?: string;
  /** 流式阶段正在生成参数的工具名（由 phase_change / tool_call_delta 更新） */
  streamingToolName?: string;
  /** P4: SSE resync failure alert — shown via ResyncAlertBanner */
  resyncAlert?: {
    active: boolean;
    reason: string;
    timestamp: number;
  } | null;
  /** P4: dismiss the resync alert */
  dismissResyncAlert?: () => void;

  setSessionId: (id: string | null) => void;
  setSessions: (sessions: SessionInfo[]) => void;
  addMessage: (msg: Message) => void;
  updateLastMessage: (content: string, reasoningContent?: string) => void;
  appendToLastMessage: (chunk: string) => void;
  appendToLastThinking: (chunk: string) => void;
  setPhase: (phase: SessionPhase) => void;
  setLeaderStatusText: (text: string) => void;
  addAgent: (agent: Omit<AgentRuntime, 'spawnedAt'>) => void;
  updateAgentStatus: (agentId: string, status: string) => void;
  /** 停止单个 Agent（不影响 Leader 与其它 Agent）。乐观置 interrupted，DELETE /api/v1/workers/:id，SSE 兜底对账。 */
  stopAgent: (agentId: string) => Promise<void>;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (toolCallId: string, result: unknown, status: ToolCall['status'], toolName?: string) => void;
  setConnected: (connected: boolean) => void;
  setIsLoadingHistory: (loading: boolean) => void;
  loadMessagesFromHistory: (history: HistoryMessageRow[]) => void;
  fetchSessions: () => Promise<void>;
  connectToSession: (sessionId: string) => Promise<void>;
  createAndConnect: (options?: { workspace?: string }) => Promise<string | undefined>;
  deleteSession: (sessionId: string) => Promise<void>;
  fetchTokenUsage: () => Promise<void>;
  compressContext: () => Promise<{
    oldTokens?: number;
    newTokens?: number;
    compacted?: boolean;
    compactType?: string;
    overflow?: boolean;
    archivePath?: string;
    inProgress?: boolean;
    threshold?: number;
    skipped?: boolean;
    reason?: string;
    error?: string;
  } | null>;
  /** Mark an ask_user_question message as answered */
  markQuestionAnswered: (messageId: string, answeredValue: string) => void;
  /** Flip every still-open ask_user_question card to answered (driven by the
   *  'ask_user_answered' SSE update, e.g. when the answer came from the TUI). */
  resolvePendingQuestions: (answeredValue?: string) => void;
  /** Append a message to an agent's conversation */
  appendAgentMessage: (agentId: string, msg: AgentMessage) => void;
  /** Update last streaming agent message */
  appendToLastAgentMessage: (agentId: string, chunk: string) => void;
  /** Append thinking chunk — merges into last streaming thinking message */
  appendToLastAgentThinking: (agentId: string, chunk: string) => void;
  /** Finalize last agent streaming message */
  finalizeLastAgentMessage: (agentId: string, content?: string, reasoningContent?: string) => void;
  reset: () => void;
}
