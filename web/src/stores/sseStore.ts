// ─── SSE connection lifecycle + event dispatch ───
// Registered once at module load; dispatches events into useSessionStore.

import { acpClient, type ConnectionStateEvent } from '../api/AcpClient';
import { getServerToken } from '../api/headers';
import i18n from '../i18n';
import { appendMessage, updateMessage } from '../utils/historyDB';
import type { ProjectBlueprint } from '../types/blueprint';
import {
  createEventProcessorState,
  extractCanonicalEventEnvelope,
  processEvent,
  SESSION_UPDATE_METHOD,
  type EventType,
  type EventProcessorState,
} from '@contracts/adapters/EventAdapter';
import { useBlackboardStore, type GraphEdge, type GraphNode } from './blackboardStore';
import {
  extractText,
  isAgentActiveStatus,
  isOpenToolCall,
  isRunActiveStatus,
  isToolCallTerminalStatus,
  mergeAgentHistoryIntoState,
  mergeAgentStatus,
  normalizeAgentSnapshotMap,
  normalizeAgentStatus,
  normalizeLeaderStatusKind,
  normalizeRunStatus,
  runtimeImpliesBusy,
  syntheticToolCallId,
  toolNamesCompatible,
  STREAMING_TIMEOUT_MS,
  STREAMING_WATCHDOG_INTERVAL_MS,
  trimMessageWindow,
  pruneAgentConversations,
} from './sessionStoreHelpers.ts';
import type {
  AgentActivity,
  AgentConversation,
  AgentMessage,
  Message,
  SessionRuntimeSnapshot,
  SessionState,
  TeamMessageItem,
  ToolCall,
} from './sessionStoreTypes.ts';
import { usePermissionStore } from './permissionStore';
import {
  applyConnectionStateForResync,
  applyRuntimeSnapshotPatch,
  clearAssistantRetrying,
  coerceSessionRuntimeSnapshot,
  completeAgentUiState,
  completeSessionUiState,
  computeGlobalTokenUsage,
  createLeaderSyntheticToolSettleResult,
  createFinalAssistantMessage,
  extractEventSessionId,
  hasOpenSessionWork,
  mergeAssistantSnapshot,
  phaseForBusySignal,
  settleOpenLeaderToolCalls,
  shouldMergeAssistantSnapshot,
} from './streamMergeUtils';
// Late import to break circular dependency: sessionStore imports sseStore (side-effect),
// sseStore reads useSessionStore at runtime (not at module parse time).
import type { useSessionStore as UseSessionStoreType } from './sessionStore';
let _useSessionStore: typeof UseSessionStoreType;
export function _injectSessionStore(store: typeof UseSessionStoreType) {
  _useSessionStore = store;
}
function getStore() { return _useSessionStore; }

type UnknownRecord = Record<string, unknown>;
type EventToolCallFunction = { name?: unknown; arguments?: unknown };
type EventToolCall = {
  id?: unknown;
  callId?: unknown;
  function?: EventToolCallFunction;
  name?: unknown;
  tool?: unknown;
  input?: unknown;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
};
type EventGoalUpdate = { description?: unknown; paused?: unknown; createdAt?: unknown; updatedAt?: unknown };
type AskUserQuestionItem = {
  question: string;
  options?: Array<{ value: string; label?: string }>;
  multiSelect?: boolean;
} & UnknownRecord;
type StreamingMessageSubtype = 'tool_output' | 'terminal_output';
type AgentMessageWithSubtype = AgentMessage & { subtype: StreamingMessageSubtype };
type SessionEventPayloadFields = {
  action?: string;
  activeNodeIds?: string[];
  agentId: string;
  agentName?: string;
  answer?: string;
  attempt?: number | string;
  backend?: AgentConversation['backend'];
  blockedNodes?: number;
  bottleneck?: string;
  busy?: boolean;
  callId: string;
  changedEdges?: GraphEdge[];
  changedNodes?: GraphNode[];
  chunk: string;
  chunkIndex?: number;
  chunkTotal?: number;
  completedNodes?: number;
  consecutiveStagnantRounds?: number;
  contextMax?: number;
  contextRatio?: number;
  contextTokens?: number;
  currentNodeId?: string;
  dag?: SessionState['dagSnapshot'];
  elapsedMs?: number;
  enabled?: boolean;
  content: string;
  error?: string;
  errorKind?: string;
  eventCount?: number;
  eventType?: string;
  explanation?: SessionState['runExplanation'];
  externalSessionId?: string;
  failedNodes?: number;
  generation?: number;
  goal?: EventGoalUpdate;
  id?: string | number;
  index?: number;
  input?: unknown;
  intervention?: string;
  isBroadcast?: boolean;
  isBusy?: boolean;
  isError?: boolean;
  label?: string;
  llmErrorKind?: string;
  logPath?: string;
  memberName?: string;
  message: string;
  messageCount?: number;
  messageId?: string;
  messageIds?: unknown[];
  metadata?: TaskOrchestrationMetadata;
  mode?: string;
  multiSelect?: boolean;
  name?: string;
  newTokens?: number;
  nodeKind?: string;
  note?: string;
  notification?: UnknownRecord;
  oldTokens?: number;
  options?: Array<{ value: string; label?: string }>;
  owner?: string;
  partialJson?: string;
  percent?: number;
  phase?: string;
  pid?: number;
  plan?: unknown;
  question?: string;
  questions?: unknown;
  queueLength?: number;
  reader?: string;
  reason?: string;
  reasoningContent?: string;
  recoverable?: boolean;
  recoveryAction?: string;
  requestedHosts?: unknown[];
  requestedMode?: string;
  requestId?: string;
  result?: unknown;
  role?: string;
  runId?: string;
  source?: string;
  stage?: string;
  state?: unknown;
  status?: string;
  statusKind?: string;
  stderrTail?: string[];
  stdoutTail?: string[];
  streamingToolName?: string;
  summary?: string;
  task?: ({ id?: string } & UnknownRecord) | TaskUpdatePayload;
  taskId?: string;
  terminalId: string;
  threshold?: number;
  timestamp?: number;
  toTeam?: string;
  tokenUsage?: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number };
  tokens?: unknown;
  tool: string;
  toolCalls?: EventToolCall[];
  toolName?: string;
  totalNodes?: number;
  trigger?: string;
  ts?: number;
  usage?: { prompt?: number; completion?: number; total?: number; cache_read?: number; cache_creation?: number };
  verdict?: string;
  workerName?: string;
  workingDirectory?: string;
  writeScope?: string[];
};

export type SessionUpdateEventData = {
  sessionId?: unknown;
  session_id?: unknown;
  params?: {
    update?: unknown;
    sessionId?: unknown;
    session_id?: unknown;
  } & UnknownRecord;
} & UnknownRecord;

export type SessionEventPayload = SessionEventPayloadFields & UnknownRecord;
export type NormalizedSessionUpdateEventData = {
  eventData: SessionUpdateEventData;
  envelope: ReturnType<typeof extractCanonicalEventEnvelope>;
  eventType?: EventType;
  kind?: SessionUpdateKind;
  update: SessionEventPayload | null;
  sessionId?: string;
};

export const SessionUpdateKind = {
  LeaderTextDelta: 'leaderTextDelta',
  LeaderThinkingDelta: 'leaderThinkingDelta',
  LeaderTextFinal: 'leaderTextFinal',
  LeaderLlmRetry: 'leaderLlmRetry',
  UserMessage: 'userMessage',
  ConversationMessage: 'conversationMessage',
  LeaderToolCall: 'leaderToolCall',
  LeaderToolCallDelta: 'leaderToolCallDelta',
  LeaderToolResult: 'leaderToolResult',
  LeaderToolOutput: 'leaderToolOutput',
  AgentSpawned: 'agentSpawned',
  AgentStarted: 'agentStarted',
  AgentTextDelta: 'agentTextDelta',
  AgentTextFinal: 'agentTextFinal',
  AgentThinkingDelta: 'agentThinkingDelta',
  AgentLlmRetry: 'agentLlmRetry',
  AgentToolCall: 'agentToolCall',
  AgentToolCallDelta: 'agentToolCallDelta',
  AgentToolResult: 'agentToolResult',
  AgentCompleted: 'agentCompleted',
  AgentTerminated: 'agentTerminated',
  AgentFailed: 'agentFailed',
  AgentStatus: 'agentStatus',
  AgentProgress: 'agentProgress',
  LeaderPhaseChange: 'leaderPhaseChange',
  SessionFailed: 'sessionFailed',
  OrchestrationRunState: 'orchestrationRunState',
  OrchestrationDagUpdate: 'orchestrationDagUpdate',
  RunExplanationUpdate: 'runExplanationUpdate',
  OrchestrationNodeUpdate: 'orchestrationNodeUpdate',
  OrchestrationEventApplied: 'orchestrationEventApplied',
  OrchestrationEventRejected: 'orchestrationEventRejected',
  OrchestrationRepairRequested: 'orchestrationRepairRequested',
  OrchestrationResetRequested: 'orchestrationResetRequested',
  BlackboardDelta: 'blackboardDelta',
  BlackboardInitialized: 'blackboardInitialized',
  TeamMessageSent: 'teamMessageSent',
  TeamMessageRead: 'teamMessageRead',
  WorkNoteWritten: 'workNoteWritten',
  AgentHeartbeat: 'agentHeartbeat',
  AgentInteractiveState: 'agentInteractiveState',
  AgentCrashed: 'agentCrashed',
  Notification: 'notification',
  LeaderMessageQueued: 'leaderMessageQueued',
  LeaderMessageDequeued: 'leaderMessageDequeued',
  AgentError: 'agentError',
  LeaderBusy: 'leader:busy',
  SessionCompleted: 'sessionCompleted',
  SessionRenamed: 'sessionRenamed',
  StatusChange: 'statusChange',
  InterruptionRequest: 'interruptionRequest',
  PlanSubmitted: 'planSubmitted',
  PlanUpdated: 'planUpdated',
  PlanFinalized: 'planFinalized',
  PlanApproved: 'planApproved',
  PlanRejected: 'planRejected',
  ControlModeChanged: 'controlModeChanged',
  BlueprintUpdated: 'blueprintUpdated',
  EternalGoalChanged: 'eternalGoalChanged',
  PermissionModeChanged: 'permissionModeChanged',
  AskUserQuestion: 'askUserQuestion',
  AskUserAnswered: 'askUserAnswered',
  Error: 'error',
  AgentTokenUsage: 'agentTokenUsage',
  ToolOutput: 'toolOutput',
  ShellState: 'shellState',
  ToolProgress: 'toolProgress',
  AgentToolProgress: 'agentToolProgress',
  TerminalOutput: 'terminalOutput',
  TerminalState: 'terminalState',
  InterruptionResolved: 'interruptionResolved',
  AgentContextUpdated: 'agentContextUpdated',
  ContextCompressed: 'contextCompressed',
  ContextCompacting: 'contextCompacting',
  ContextRuntimeUpdated: 'contextRuntimeUpdated',
  SessionRuntimeState: 'sessionRuntimeState',
  TaskUpdate: 'taskUpdate',
  WatchdogAlert: 'watchdogAlert',
  ProgressStagnant: 'progressStagnant',
  LeaderRoundComplete: 'leaderRoundComplete',
  ContextOverflow: 'contextOverflow',
  PluginToggled: 'pluginToggled',
  SessionResyncFailed: 'sessionResyncFailed',
} as const;
export type SessionUpdateKind = (typeof SessionUpdateKind)[keyof typeof SessionUpdateKind];

const CANONICAL_EVENT_KIND: Partial<Record<EventType, SessionUpdateKind>> = {
  'leader:text_chunk': SessionUpdateKind.LeaderTextDelta,
  'leader:thinking_chunk': SessionUpdateKind.LeaderThinkingDelta,
  'leader:text': SessionUpdateKind.LeaderTextFinal,
  'leader:llm_retry': SessionUpdateKind.LeaderLlmRetry,
  'chat:user_message': SessionUpdateKind.UserMessage,
  'conversation:message_saved': SessionUpdateKind.ConversationMessage,
  'leader:tool_call': SessionUpdateKind.LeaderToolCall,
  'leader:tool_call_delta': SessionUpdateKind.LeaderToolCallDelta,
  'leader:tool_result': SessionUpdateKind.LeaderToolResult,
  'leader:tool_output': SessionUpdateKind.LeaderToolOutput,
  'agent:spawned': SessionUpdateKind.AgentSpawned,
  'agent:started': SessionUpdateKind.AgentStarted,
  'agent:text_chunk': SessionUpdateKind.AgentTextDelta,
  'agent:text': SessionUpdateKind.AgentTextFinal,
  'agent:thinking_chunk': SessionUpdateKind.AgentThinkingDelta,
  'agent:llm_retry': SessionUpdateKind.AgentLlmRetry,
  'agent:tool_call': SessionUpdateKind.AgentToolCall,
  'agent:tool_call_delta': SessionUpdateKind.AgentToolCallDelta,
  'agent:tool_result': SessionUpdateKind.AgentToolResult,
  'agent:completed': SessionUpdateKind.AgentCompleted,
  'agent:terminated': SessionUpdateKind.AgentTerminated,
  'agent:failed': SessionUpdateKind.AgentFailed,
  'agent:status': SessionUpdateKind.AgentStatus,
  'agent:progress': SessionUpdateKind.AgentProgress,
  'leader:phase_change': SessionUpdateKind.LeaderPhaseChange,
  'session:failed': SessionUpdateKind.SessionFailed,
  'orchestration:run_state': SessionUpdateKind.OrchestrationRunState,
  'orchestration:dag_updated': SessionUpdateKind.OrchestrationDagUpdate,
  'run:explanation_updated': SessionUpdateKind.RunExplanationUpdate,
  'orchestration:node_update': SessionUpdateKind.OrchestrationNodeUpdate,
  'orchestration:event_applied': SessionUpdateKind.OrchestrationEventApplied,
  'orchestration:event_rejected': SessionUpdateKind.OrchestrationEventRejected,
  'blackboard:delta': SessionUpdateKind.BlackboardDelta,
  'blackboard:initialized': SessionUpdateKind.BlackboardInitialized,
  'team:message_sent': SessionUpdateKind.TeamMessageSent,
  'team:message_read': SessionUpdateKind.TeamMessageRead,
  'work_note:written': SessionUpdateKind.WorkNoteWritten,
  'agent:heartbeat': SessionUpdateKind.AgentHeartbeat,
  'agent:interactive_state': SessionUpdateKind.AgentInteractiveState,
  'agent:crashed': SessionUpdateKind.AgentCrashed,
  'notification:new': SessionUpdateKind.Notification,
  'leader:message_queued': SessionUpdateKind.LeaderMessageQueued,
  'leader:message_dequeued': SessionUpdateKind.LeaderMessageDequeued,
  'agent:error': SessionUpdateKind.AgentError,
  'leader:busy': SessionUpdateKind.LeaderBusy,
  'session:completed': SessionUpdateKind.SessionCompleted,
  'session:renamed': SessionUpdateKind.SessionRenamed,
  'leader:status': SessionUpdateKind.StatusChange,
  'session:interrupted': SessionUpdateKind.StatusChange,
  'permission:request': SessionUpdateKind.InterruptionRequest,
  'plan:submitted': SessionUpdateKind.PlanSubmitted,
  'plan:updated': SessionUpdateKind.PlanUpdated,
  'plan:finalized': SessionUpdateKind.PlanFinalized,
  'leader:plan_approved': SessionUpdateKind.PlanApproved,
  'leader:plan_rejected': SessionUpdateKind.PlanRejected,
  'leader:control_mode_changed': SessionUpdateKind.ControlModeChanged,
  'leader:blueprint_updated': SessionUpdateKind.BlueprintUpdated,
  'eternal:goal_changed': SessionUpdateKind.EternalGoalChanged,
  'permission:mode_changed': SessionUpdateKind.PermissionModeChanged,
  'user:input_needed': SessionUpdateKind.AskUserQuestion,
  'user:question_answered': SessionUpdateKind.AskUserAnswered,
  'leader:error': SessionUpdateKind.Error,
  'token:usage': SessionUpdateKind.AgentTokenUsage,
  'agent:tool_output': SessionUpdateKind.ToolOutput,
  'agent:shell_state': SessionUpdateKind.ShellState,
  'leader:tool_progress': SessionUpdateKind.ToolProgress,
  'agent:tool_progress': SessionUpdateKind.AgentToolProgress,
  'terminal:output': SessionUpdateKind.TerminalOutput,
  'terminal:state': SessionUpdateKind.TerminalState,
  'permission:resolved': SessionUpdateKind.InterruptionResolved,
  'agent:context_updated': SessionUpdateKind.AgentContextUpdated,
  'context:compressed': SessionUpdateKind.ContextCompressed,
  'context:compacting': SessionUpdateKind.ContextCompacting,
  'context:runtime_updated': SessionUpdateKind.ContextRuntimeUpdated,
  'session:runtime_state': SessionUpdateKind.SessionRuntimeState,
  'task:created': SessionUpdateKind.TaskUpdate,
  'task:updated': SessionUpdateKind.TaskUpdate,
  'task:assigned': SessionUpdateKind.TaskUpdate,
  'task:completed': SessionUpdateKind.TaskUpdate,
  'task:failed': SessionUpdateKind.TaskUpdate,
  'task:cancelled': SessionUpdateKind.TaskUpdate,
  'task:deleted': SessionUpdateKind.TaskUpdate,
  'leader:watchdog_alert': SessionUpdateKind.WatchdogAlert,
  'leader:progress_stagnant': SessionUpdateKind.ProgressStagnant,
  'leader:round_complete': SessionUpdateKind.LeaderRoundComplete,
  'context:overflow': SessionUpdateKind.ContextOverflow,
  'plugin:toggled': SessionUpdateKind.PluginToggled,
  'session:resync_failed': SessionUpdateKind.SessionResyncFailed,
};

export function getSessionUpdateKind(eventType?: EventType | string | null): SessionUpdateKind | undefined {
  return eventType ? CANONICAL_EVENT_KIND[eventType as EventType] : undefined;
}
type TaskDisplayState =
  | 'pending'
  | 'dispatchable'
  | 'blocked'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
type TaskExitReason = 'completed' | 'failed' | 'cancelled' | 'timeout';
type TaskOrchestrationMetadata = {
  orchestrationRunId?: string;
  nodeKind?: string;
  generation?: number;
  stage?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN' | string;
  contract?: unknown;
  evaluationPolicy?: unknown;
  acceptance?: {
    status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
    summary?: string;
    criteria?: string[];
    evidenceTaskIds?: string[];
    artifactRefs?: Array<{ path: string; label?: string; kind?: string }>;
    evaluatedAt?: number;
  };
  blockedReason?: string;
  nextAction?: string;
  explainReason?: string;
  mainPathRank?: number;
  repairCount?: number;
};
type TaskUpdatePayload = {
  id: string;
  session_id: string;
  sessionId?: string;
  subject: string;
  description: string | object;
  status: string;
  displayState?: TaskDisplayState;
  exitReason?: TaskExitReason;
  agent_type: string;
  blocked_by: string[];
  blocks: string[];
  assigned_agent: string;
  working_directory?: string;
  write_scope?: string[];
  result?: string | object;
  orchestration?: TaskOrchestrationMetadata;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
};

function asSessionUpdateEventData(data: unknown): SessionUpdateEventData {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as SessionUpdateEventData
    : {};
}

function asUnknownRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function recordStatus(value: unknown): unknown {
  return asUnknownRecord(value).status;
}

function isAskUserQuestionItem(value: unknown): value is AskUserQuestionItem {
  const record = asUnknownRecord(value);
  return typeof record.question === 'string' && record.question.trim().length > 0;
}

function normalizeQuestionList(value: unknown): AskUserQuestionItem[] | undefined {
  return Array.isArray(value) ? value.filter(isAskUserQuestionItem) : undefined;
}

function hasStreamingSubtype(
  message: AgentMessage | undefined,
  subtype: StreamingMessageSubtype,
): message is AgentMessageWithSubtype {
  return !!message && asUnknownRecord(message).subtype === subtype;
}

function withStreamingSubtype(message: AgentMessage, subtype: StreamingMessageSubtype): AgentMessageWithSubtype {
  return { ...message, subtype };
}

function asConnectionStatePayload(data: unknown): ConnectionStateEvent {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as ConnectionStateEvent
    : { state: 'disconnected', sessionId: null, isConnected: false, attempts: 0, reconnectCycle: 0 };
}

function toSessionEventPayload(envelope: ReturnType<typeof extractCanonicalEventEnvelope>): SessionEventPayload | null {
  if (!envelope) return null;
  const payload = asUnknownRecord(envelope.payload);
  const chunk = payload.chunk;
  const content = payload.content ?? chunk;
  return {
    ...payload,
    ...(content !== undefined ? { content } : {}),
    sessionId: envelope.sessionId,
    timestamp: envelope.timestamp,
    eventType: envelope.type,
  } as unknown as SessionEventPayload;
}

export function normalizeSessionUpdateEventData(data: unknown): NormalizedSessionUpdateEventData {
  const eventData = asSessionUpdateEventData(data);
  const envelope = extractCanonicalEventEnvelope(eventData);
  const eventType = envelope?.type;
  const update = toSessionEventPayload(envelope);
  const kind = getSessionUpdateKind(eventType);
  const sessionId = (update ? extractEventSessionId(eventData, update) : undefined)
    ?? envelope?.sessionId;
  return { eventData, envelope, eventType, kind, update, sessionId };
}

type SessionUpdateEventSource = {
  on(method: string, handler: (data: unknown) => void): () => void;
};

export function subscribeSessionUpdateEvents(
  client: SessionUpdateEventSource,
  handler: (event: NormalizedSessionUpdateEventData) => void,
): () => void {
  return client.on(SESSION_UPDATE_METHOD, (data: unknown) => handler(normalizeSessionUpdateEventData(data)));
}

function debugUpdateContent(update: SessionEventPayload): string {
  return typeof update.content === 'string' ? update.content.slice(0, 30) : '';
}

function toTaskUpdatePayload(task: unknown): TaskUpdatePayload | null {
  return task && typeof task === 'object' && !Array.isArray(task) && typeof (task as { id?: unknown }).id === 'string'
    ? task as TaskUpdatePayload
    : null;
}

function addPermissionRequestFromUpdate(update: SessionEventPayload, data: SessionUpdateEventData): void {
  const requestId = typeof update.requestId === 'string' ? update.requestId : '';
  if (!requestId) return;
  usePermissionStore.getState().addRequest({
    requestId,
    sessionId: String(data.sessionId || data.params?.sessionId || ''),
    source: update.source === 'worker' ? 'worker' : 'leader',
    toolName: String(update.toolName || ''),
    reason: String(update.reason || ''),
    requestedMode: typeof update.requestedMode === 'string' ? update.requestedMode : undefined,
    requestedHosts: Array.isArray(update.requestedHosts) ? update.requestedHosts.map(String) : undefined,
    workerName: typeof update.workerName === 'string' ? update.workerName : undefined,
    timestamp: Date.now(),
  });
}

// ─── Streaming watchdog ───

export function markStreamingActivity() {
  getStore().setState({ streamingLastActivityAt: Date.now() });
}

function ensureStreamingWatchdog() {
  if (getStore().getState().streamingWatchdogInterval) return;
  const interval = setInterval(() => {
    const { phase, streamingLastActivityAt } = getStore().getState();
    if (phase !== 'streaming' && phase !== 'tool_executing' && phase !== 'thinking') return;
    if (Date.now() - streamingLastActivityAt > STREAMING_TIMEOUT_MS) {
      getStore().getState().setPhase('idle');
    }
  }, STREAMING_WATCHDOG_INTERVAL_MS);
  getStore().setState({ streamingWatchdogInterval: interval });
  unrefTimer(interval);
}

function unrefTimer(timer: unknown): void {
  if (timer && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

// ─── Stream buffer (rAF batching) ───

// A single long-running bash/shell tool can stream megabytes of stdout into one
// toolCall.streamingOutput (or an agent tool/terminal message's content). Bound
// each live buffer to the last N chars so memory stays flat no matter how much a
// tool emits; the tail is what matters for display and the full output is kept
// server-side. 50K chars (~50KB) per active stream is a generous display window.
const MAX_STREAMING_OUTPUT_CHARS = 50_000;
function appendStreamingOutput(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > MAX_STREAMING_OUTPUT_CHARS ? next.slice(-MAX_STREAMING_OUTPUT_CHARS) : next;
}

export type PendingStreamEntry =
  | { type: 'leader_text'; chunk: string }
  | { type: 'leader_thinking'; chunk: string }
  | { type: 'agent_text'; agentId: string; chunk: string }
  | { type: 'agent_thinking'; agentId: string; chunk: string };

const pendingStream: { entries: PendingStreamEntry[] } = { entries: [] };
let streamFlushHandle: ReturnType<typeof requestAnimationFrame> | ReturnType<typeof setTimeout> | null = null;
const hasRAF = typeof requestAnimationFrame === 'function';
const scheduleRaf = (fn: () => void) => hasRAF ? requestAnimationFrame(fn) : setTimeout(fn, 16);
const cancelRaf = (h: ReturnType<typeof requestAnimationFrame> | ReturnType<typeof setTimeout>) =>
  hasRAF ? cancelAnimationFrame(h as number) : clearTimeout(h as ReturnType<typeof setTimeout>);

const leaderThinkStreamState = { inThinking: false, pendingTag: '' };
const agentThinkStreamState = new Map<string, { inThinking: boolean; pendingTag: string }>();

export function pendingStreamIsEmpty(): boolean {
  return pendingStream.entries.length === 0;
}

export function resetThinkStreamState(agentId?: string): void {
  if (agentId) { agentThinkStreamState.delete(agentId); return; }
  leaderThinkStreamState.inThinking = false;
  leaderThinkStreamState.pendingTag = '';
  agentThinkStreamState.clear();
}

export function clearPendingStreamBuffers(): void {
  if (streamFlushHandle !== null) { cancelRaf(streamFlushHandle); streamFlushHandle = null; }
  pendingStream.entries = [];
  resetThinkStreamState();
  // Tear down the streaming-watchdog interval too: every session-lifecycle reset
  // (switch / connect / disconnect / reset) routes through this function, and the
  // 30s interval was previously created once and never cleared. setPhase re-enables
  // it when streaming resumes (sessionStore setPhase -> ensureStreamingWatchdog).
  const watchdog = getStore().getState().streamingWatchdogInterval;
  if (watchdog) {
    clearInterval(watchdog);
    getStore().setState({ streamingWatchdogInterval: null });
  }
  // Reset the reconnect-resync accumulator: a fresh connect (page load or session
  // switch) is the "initial" connect for that lifecycle, so the first 'connected'
  // must NOT trigger a redundant /agents refetch (connectToSession already hydrates).
  agentResyncAcc = { hasConnectedOnce: false };
}

function enqueuePendingStream(entry: PendingStreamEntry): void {
  if (!entry.chunk) return;
  const last = pendingStream.entries[pendingStream.entries.length - 1];
  if (last && last.type === entry.type && ('agentId' in last ? last.agentId : undefined) === ('agentId' in entry ? entry.agentId : undefined)) {
    last.chunk += entry.chunk;
    return;
  }
  pendingStream.entries.push(entry);
}

function scheduleStreamFlush() {
  if (streamFlushHandle !== null) return;
  streamFlushHandle = scheduleRaf(() => { streamFlushHandle = null; flushStreamBuffers(); });
}

export function flushStreamBuffers() {
  if (streamFlushHandle !== null) { cancelRaf(streamFlushHandle); streamFlushHandle = null; }
  if (pendingStreamIsEmpty()) return;
  const entries = pendingStream.entries;
  pendingStream.entries = [];
  const store = getStore().getState();
  for (const entry of entries) {
    if (entry.type === 'leader_text') store.appendToLastMessage(entry.chunk);
    else if (entry.type === 'leader_thinking') store.appendToLastThinking(entry.chunk);
    else if (entry.type === 'agent_text') store.appendToLastAgentMessage(entry.agentId, entry.chunk);
    else store.appendToLastAgentThinking(entry.agentId, entry.chunk);
  }
}

function settleLeaderFinalOutputPhase(): void {
  const state = getStore().getState();
  if (shouldAcceptIdleTransition(state)) {
    state.setLeaderStatusText?.('');
    state.setPhase('idle');
    return;
  }
  if (state.phase === 'preparing') {
    state.setPhase('streaming');
  }
}

// Re-export leaderThinkStreamState/agentThinkStreamState for sessionStore actions
export function getLeaderThinkStreamState() { return leaderThinkStreamState; }
export function getAgentThinkStreamState(agentId: string) {
  let state = agentThinkStreamState.get(agentId);
  if (!state) { state = { inThinking: false, pendingTag: '' }; agentThinkStreamState.set(agentId, state); }
  return state;
}

// Export ensureStreamingWatchdog for sessionStore setPhase action
export { ensureStreamingWatchdog };

// ─── shouldAcceptIdleTransition (uses pendingStreamIsEmpty from this module) ───

export function shouldAcceptIdleTransition(state?: SessionState): boolean {
  const s = state ?? getStore().getState();
  return !hasOpenSessionWork(s, pendingStreamIsEmpty());
}

// ─── Task update pub/sub ───

type TaskUpdateListener = (task: TaskUpdatePayload, action: string) => void;
const taskUpdateListeners = new Set<TaskUpdateListener>();
export function subscribeTaskUpdates(fn: TaskUpdateListener): () => void {
  taskUpdateListeners.add(fn);
  return () => taskUpdateListeners.delete(fn);
}

// ─── applyRuntimeSnapshotFromRpcResult (used by ControlModeToggle) ───

export function applyRuntimeSnapshotFromRpcResult(result: unknown, expectedSessionId?: string): boolean {
  const raw = result && typeof result === 'object' && 'runtime' in (result as Record<string, unknown>)
    ? (result as { runtime?: unknown }).runtime
    : result;
  const snapshot = coerceSessionRuntimeSnapshot(raw);
  if (!snapshot) return false;
  if (expectedSessionId && snapshot.sessionId !== expectedSessionId) return false;
  if (getStore().getState().sessionId !== snapshot.sessionId) return false;
  getStore().setState((s) => applyRuntimeSnapshotPatch(s, snapshot, pendingStreamIsEmpty()));
  return true;
}

// ─── SSE resync helpers ───

let activeFetchController: AbortController | null = null;
let agentsSnapshotController: AbortController | null = null;
let lastSseState: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | null = null;
// Agent-history resync accumulator for the connection/state listener. Replaces the
// fragile `previousState === 'reconnecting'` gate that the intermediate 'connecting'
// state defeated on every reconnect. See applyConnectionStateForResync for the why.
let agentResyncAcc = { hasConnectedOnce: false };

async function resyncAgentsSnapshot(sessionId: string): Promise<void> {
  if (agentsSnapshotController) agentsSnapshotController.abort();
  const controller = new AbortController();
  agentsSnapshotController = controller;
  try {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/agents`, {
      headers: { 'x-lingxiao-token': getServerToken() },
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (!res.ok) {
      console.warn('[resyncAgentsSnapshot] failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    const json = await res.json();
    if (controller.signal.aborted) return;
    if (!json?.data || typeof json.data !== 'object') return;
    const agentConvs = normalizeAgentSnapshotMap(json.data);
    if (Object.keys(agentConvs).length > 0) {
      if (getStore().getState().sessionId !== sessionId) return;
      getStore().setState((s) => mergeAgentHistoryIntoState(s, agentConvs));
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name !== 'AbortError') { console.warn('[resyncAgentsSnapshot] failed:', e.message); }
  } finally {
    if (agentsSnapshotController === controller) agentsSnapshotController = null;
  }
}

export async function syncRuntimeSnapshotFromAcp(sessionId: string): Promise<void> {
  const result = await acpClient.sendJsonRpc('session/runtime_state', { sessionId });
  const snapshot = coerceSessionRuntimeSnapshot(result);
  if (!snapshot) return;
  if (getStore().getState().sessionId !== sessionId) return;
  getStore().setState((s) => applyRuntimeSnapshotPatch(s, snapshot, pendingStreamIsEmpty()));
}

// ─── SSE Listener ───

let sseListenerRegistered = false;
let sseEventProcessorState: EventProcessorState = createEventProcessorState();

export function ensureSseListener() {
  if (sseListenerRegistered) return;
  sseListenerRegistered = true;

  acpClient.on('connection/state', (data: unknown) => {
    const nextState = asConnectionStatePayload(data).state;
    const previousState = lastSseState;
    if (nextState === previousState) return;
    lastSseState = nextState ?? null;

    if (nextState === 'connected') {
      getStore().setState({ isConnected: true });
      const currentSessionId = getStore().getState().sessionId;
      if (currentSessionId) {
        if (activeFetchController) activeFetchController.abort();
        activeFetchController = new AbortController();
        const controller = activeFetchController;
        fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, {
          headers: { 'x-lingxiao-token': getServerToken() },
          signal: controller.signal,
        }).then(res => { if (!res.ok) return; return res.json(); }).then(detail => {
          if (controller.signal.aborted) return;
          if (getStore().getState().sessionId !== currentSessionId) return;
          if (!detail) return;
          const snapshot = coerceSessionRuntimeSnapshot(detail?.runtime);
          if (snapshot && runtimeImpliesBusy({ runtimeState: snapshot })) {
            getStore().setState((s) => ({ phase: phaseForBusySignal(s.phase) }));
          } else {
            const currentState = getStore().getState();
            if (shouldAcceptIdleTransition(currentState)) {
              getStore().setState({ phase: 'idle', leaderStatusText: '' });
            }
          }
        }).catch((err) => { if (err.name === 'AbortError') return; }).finally(() => {
          if (activeFetchController === controller) activeFetchController = null;
        });
        // Re-hydrate agent history on RECONNECT (not the initial connect). The server
        // SSE sends only {method:'connected'} with no agent snapshot, so without this
        // the agent panel freezes on stale state after any silent mid-session reconnect
        // (proxy/NAT idle timeout, backgrounded tab) — manifesting as "agent 面板跑久了
        // 不更新，要刷新". The old `previousState === 'reconnecting'` gate was defeated by
        // the intermediate 'connecting' state; the accumulator tracks "connected once".
        const resyncDecision = applyConnectionStateForResync(agentResyncAcc, 'connected');
        agentResyncAcc = resyncDecision.acc;
        if (resyncDecision.resync) {
          resyncAgentsSnapshot(currentSessionId).catch(() => {});
        }
        syncRuntimeSnapshotFromAcp(currentSessionId).catch(() => {});
      }
      return;
    }
    if (nextState === 'connecting' || nextState === 'reconnecting' || nextState === 'disconnected') {
      getStore().setState({ isConnected: false });
    }
  });

  subscribeSessionUpdateEvents(acpClient, ({ eventData, envelope, eventType, kind, update, sessionId: eventSessionId }) => {
    const store = getStore().getState();
    if (import.meta.env.DEV && update) console.log('[SSE recv]', eventType ?? kind ?? 'unknown', debugUpdateContent(update));
    const activeConnectionSessionId = acpClient.getSessionId?.() ?? acpClient.sessionId;
    if (activeConnectionSessionId && store.sessionId && activeConnectionSessionId !== store.sessionId) {
      if (import.meta.env.DEV) console.warn('[SSE drop stale] conn=', activeConnectionSessionId?.slice(0,8), 'store=', store.sessionId?.slice(0,8));
      return;
    }
    if (!update) return;
    if (eventSessionId && store.sessionId && eventSessionId !== store.sessionId) {
      if (import.meta.env.DEV) console.warn('[SSE drop session mismatch] event=', eventSessionId.slice(0,8), 'store=', store.sessionId.slice(0,8));
      return;
    }

    if (envelope && kind) {
      const currentProcessorState = store.eventProcessorState ?? sseEventProcessorState;
      const processorState = envelope.sessionId && currentProcessorState.sessionId && envelope.sessionId !== currentProcessorState.sessionId
        ? createEventProcessorState({ sessionId: envelope.sessionId })
        : currentProcessorState;
      sseEventProcessorState = processEvent(envelope, processorState);
      getStore().setState({ eventProcessorState: sseEventProcessorState });
    }

    handleSessionUpdate(store, update, eventData, kind);
  });
}

function handleSessionUpdate(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    // ─── Leader events → main chat ───
    case SessionUpdateKind.LeaderTextDelta:
      markStreamingActivity();
      enqueuePendingStream({ type: 'leader_text', chunk: update.content || '' });
      scheduleStreamFlush();
      break;
    case SessionUpdateKind.LeaderThinkingDelta:
      markStreamingActivity();
      enqueuePendingStream({ type: 'leader_thinking', chunk: update.content || '' });
      scheduleStreamFlush();
      break;
    case SessionUpdateKind.LeaderTextFinal:
      markStreamingActivity();
      flushStreamBuffers();
      getStore().setState((s) => ({ messages: clearAssistantRetrying(s.messages) }));
      if (update.content || update.reasoningContent) {
        store.updateLastMessage(update.content || '', update.reasoningContent);
        resetThinkStreamState();
      }
      settleLeaderFinalOutputPhase();
      break;
    case SessionUpdateKind.LeaderLlmRetry:
      flushStreamBuffers();
      resetThinkStreamState();
      getStore().setState((s) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant' && last.isStreaming) {
          msgs[msgs.length - 1] = { ...last, content: '', thinkingContent: undefined, contentBlocks: undefined, retrying: true, isStreaming: true };
          return { messages: msgs, phase: 'streaming' };
        }
        return { messages: trimMessageWindow([...msgs, { id: `retry-${Date.now()}`, role: 'assistant' as const, content: '', timestamp: Date.now(), isStreaming: true, retrying: true }]), phase: 'streaming' };
      });
      break;
    case SessionUpdateKind.UserMessage: {
      const umContent = extractText(update.content);
      const umTimestamp = typeof update.timestamp === 'number' ? update.timestamp : Date.now();
      const umId = `remote-user-${umTimestamp}`;
      getStore().setState((s: SessionState) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'user' && last.content === umContent && Math.abs(last.timestamp - umTimestamp) < 5000) return s;
        return { messages: trimMessageWindow([...msgs, { id: umId, role: 'user' as const, content: umContent, timestamp: umTimestamp, isStreaming: false, retrying: false }]) };
      });
      break;
    }
    case SessionUpdateKind.ConversationMessage: {
      const role: Extract<Message['role'], 'user' | 'assistant' | 'system'> = update.role === 'user'
        ? 'user'
        : update.role === 'system'
          ? 'system'
          : 'assistant';
      if (role === 'user') break;
      if (role === 'system' || update.role === 'tool') break;
      const content = extractText(update.content);
      const timestamp = typeof update.timestamp === 'number' ? update.timestamp * 1000 : Date.now();
      const id = update.id != null ? `srv-${update.id}` : `srv-${role}-${timestamp}`;
      getStore().setState((s) => {
        if (s.messages.some(m => m.id === id)) return s;
        const toolCalls: ToolCall[] | undefined = Array.isArray(update.toolCalls)
          ? update.toolCalls.map((tc, index) => ({
              id: String(tc.id || tc.callId || `tc-${id}-${index}`),
              tool: String(tc.function?.name || tc.name || tc.tool || 'unknown'),
              input: tc.function?.arguments ?? tc.arguments ?? tc.input,
              result: tc.result,
              status: tc.result || tc.error ? (tc.error ? 'failed' as const : 'completed' as const) : 'running' as const,
            }))
          : undefined;
        const message: Message = {
          id, role, content: '', timestamp, isStreaming: false, retrying: false,
          toolCalls,
        };
        const finalizedMessage = role === 'assistant'
          ? createFinalAssistantMessage(id, content, update.reasoningContent, message.toolCalls, timestamp)
          : { ...message, content };
        const msgs = [...s.messages];
        const lastAssistantIndex = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant') return i; if (msgs[i].role === 'user') break; } return -1; })();
        if (role === 'assistant' && lastAssistantIndex >= 0) {
          const existing = msgs[lastAssistantIndex];
          if (shouldMergeAssistantSnapshot(existing, finalizedMessage)) {
            msgs[lastAssistantIndex] = mergeAssistantSnapshot(existing, finalizedMessage);
            if (s.sessionId) updateMessage(s.sessionId, msgs[lastAssistantIndex]).catch(() => {});
            return { messages: msgs };
          }
        }
        if (s.sessionId) appendMessage(s.sessionId, finalizedMessage).catch(() => {});
        return { messages: trimMessageWindow([...msgs, finalizedMessage]) };
      });
      if (role === 'assistant') {
        resetThinkStreamState();
        settleLeaderFinalOutputPhase();
      }
      break;
    }

    case SessionUpdateKind.LeaderToolCall: {
      flushStreamBuffers();
      getStore().setState((s) => ({ messages: clearAssistantRetrying(s.messages) }));
      store.setPhase('tool_executing');
      const tcMsgs = store.messages;
      const tcLastMsg = tcMsgs[tcMsgs.length - 1];
      if (tcLastMsg && tcLastMsg.role === 'assistant') {
        const callId = update.callId || syntheticToolCallId(update.tool, update.input);
        const existing = (tcLastMsg.toolCalls || []).find(tc => tc.id === callId);
        store.addToolCall(tcLastMsg.id, {
          id: callId, tool: update.tool || existing?.tool || 'unknown', input: update.input ?? existing?.input,
          status: 'running', startedAt: Date.now(), firstDeltaAt: existing?.firstDeltaAt, inputCharCount: existing?.inputCharCount,
        });
      }
      break;
    }
    case SessionUpdateKind.LeaderToolCallDelta: {
      markStreamingActivity();
      flushStreamBuffers();
      getStore().setState((s) => ({ messages: clearAssistantRetrying(s.messages) }));
      if (store.phase !== 'streaming') store.setPhase('streaming');
      const tcdMsgs = store.messages;
      let tcdLastMsg = tcdMsgs[tcdMsgs.length - 1];
      if (!tcdLastMsg || tcdLastMsg.role !== 'assistant') {
        const newAssistant = { id: `msg-${Date.now()}`, role: 'assistant' as const, content: '', timestamp: Date.now(), isStreaming: true, streamStartedAt: Date.now() };
        getStore().setState((s) => ({ messages: trimMessageWindow([...s.messages, newAssistant]) }));
        tcdLastMsg = newAssistant;
      }
      const tcdCallId = update.callId || `tc-stream-${update.index ?? 0}`;
      const tcdExisting = (tcdLastMsg.toolCalls || []).find(tc => tc.id === tcdCallId);
      const tcdPrevInput = typeof tcdExisting?.input === 'string' ? tcdExisting.input : '';
      const tcdPartial = String(update.partialJson || '');
      const tcdNextInput = tcdPrevInput + tcdPartial;
      const tcdNow = Date.now();
      store.addToolCall(tcdLastMsg.id, {
        id: tcdCallId, tool: update.tool || tcdExisting?.tool || 'unknown', input: tcdNextInput,
        status: 'streaming_input', inputCharCount: tcdNextInput.length, firstDeltaAt: tcdExisting?.firstDeltaAt ?? tcdNow,
      });
      break;
    }
    case SessionUpdateKind.LeaderToolResult: {
      flushStreamBuffers();
      getStore().setState((s) => ({ messages: clearAssistantRetrying(s.messages) }));
      store.updateToolCall(
        update.callId || syntheticToolCallId(update.tool, update.input),
        update.result, update.error ? 'failed' : 'completed', update.tool
      );
      const trUpdatedState = getStore().getState();
      const trAssistantMsgs = [...trUpdatedState.messages].reverse().filter(m => m.role === 'assistant' && m.toolCalls?.length);
      const trHasOpenTools = trAssistantMsgs.some(m => m.toolCalls!.some(t => isOpenToolCall(t.status)));
      if (!trHasOpenTools && shouldAcceptIdleTransition(trUpdatedState) === false) {
        store.setPhase(phaseForBusySignal(getStore().getState().phase));
      }
      break;
    }
    case SessionUpdateKind.LeaderToolOutput: {
      if (!update.callId || !update.chunk) break;
      markStreamingActivity();
      getStore().setState((s) => {
        const messages = s.messages.map(m => {
          if (m.role !== 'assistant' || !m.toolCalls?.some(tc => tc.id === update.callId)) return m;
          return { ...m, toolCalls: m.toolCalls!.map(tc => tc.id === update.callId ? { ...tc, streamingOutput: appendStreamingOutput(tc.streamingOutput || '', update.chunk) } : tc) };
        });
        return { messages };
      });
      break;
    }
    default:
      handleSessionUpdatePart2(store, update, data, kind);
      break;
  }
}

function handleSessionUpdatePart2(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    // ─── Agent events → agentConversations ───
    case SessionUpdateKind.AgentSpawned:
    case SessionUpdateKind.AgentStarted:
      if (update.agentId) {
        store.setPhase('streaming');
        store.addAgent({
          agentId: update.agentId, agentName: update.agentName || 'Agent', role: update.role || 'worker', status: 'running',
          taskId: update.taskId as string | undefined, workingDirectory: update.workingDirectory as string | undefined,
          writeScope: Array.isArray(update.writeScope) ? update.writeScope as string[] : undefined,
          backend: update.backend, externalSessionId: update.externalSessionId, pid: update.pid,
        });
        getStore().setState((s) => {
          const pendingTokens = s._pendingTokens?.[update.agentId];
          const existing = s.agentConversations[update.agentId];
          const existingMessages = existing?.messages ?? [];
          const existingHasReal = existingMessages.some((m) => m.type !== 'status');
          const startedContent = i18n.t('session.agent.started');
          const startedMsg: AgentMessage = { id: `as-${Date.now()}`, type: 'status' as const, content: startedContent, timestamp: Date.now() };
          const lastMsg = existingMessages[existingMessages.length - 1];
          const lastIsStartDivider = lastMsg?.type === 'status' && lastMsg.content === startedContent;
          const nextMessages: AgentMessage[] = existingHasReal ? (lastIsStartDivider ? existingMessages : [...existingMessages, startedMsg]) : [startedMsg];
          const newConv: AgentConversation = {
            ...existing, agentId: update.agentId, agentName: update.agentName || existing?.agentName || 'Agent',
            role: update.role || existing?.role || 'worker', status: 'running',
            taskId: (update.taskId as string | undefined) ?? existing?.taskId,
            workingDirectory: (update.workingDirectory as string | undefined) ?? existing?.workingDirectory,
            writeScope: (Array.isArray(update.writeScope) ? update.writeScope as string[] : undefined) ?? existing?.writeScope,
            backend: update.backend ?? existing?.backend, externalSessionId: update.externalSessionId ?? existing?.externalSessionId,
            pid: update.pid ?? existing?.pid, logPath: update.logPath ?? existing?.logPath,
            messages: nextMessages,
            ...(pendingTokens ? { tokenUsage: pendingTokens } : (existing?.tokenUsage ? { tokenUsage: existing.tokenUsage } : {})),
          };
          const nextConversations = { ...s.agentConversations, [update.agentId]: newConv };
          const nextPending = { ...s._pendingTokens };
          delete nextPending[update.agentId];
          const newGlobal = computeGlobalTokenUsage(nextConversations, nextPending);
          return { agentConversations: nextConversations, tokenUsage: newGlobal, _pendingTokens: nextPending };
        });
        getStore().setState((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') {
            const activity: AgentActivity = { agentId: update.agentId, agentName: update.agentName || 'Agent', status: 'running', taskId: update.taskId as string | undefined, workingDirectory: update.workingDirectory as string | undefined, backend: update.backend };
            const prevActivity = last.agentActivity || [];
            const existingIdx = prevActivity.findIndex(a => a.agentId === update.agentId);
            const nextActivity = existingIdx >= 0
              ? prevActivity.map((a, i) => (i === existingIdx ? { ...a, ...activity } : a))
              : [...prevActivity, activity];
            msgs[msgs.length - 1] = { ...last, agentActivity: nextActivity };
          }
          return { messages: msgs };
        });
      }
      break;
    case SessionUpdateKind.AgentTextDelta:
      if (update.agentId) {
        markStreamingActivity();
        enqueuePendingStream({ type: 'agent_text', agentId: update.agentId, chunk: update.content || '' });
        scheduleStreamFlush();
      }
      break;
    case SessionUpdateKind.AgentTextFinal:
      if (update.agentId) {
        markStreamingActivity();
        flushStreamBuffers();
        store.finalizeLastAgentMessage(update.agentId, update.content, update.reasoningContent);
        resetThinkStreamState(update.agentId);
      }
      break;
    case SessionUpdateKind.AgentThinkingDelta:
      if (update.agentId) {
        markStreamingActivity();
        enqueuePendingStream({ type: 'agent_thinking', agentId: update.agentId, chunk: update.content || '' });
        scheduleStreamFlush();
      }
      break;

    // PLACEHOLDER_SSE7
    default:
      handleSessionUpdatePart3(store, update, data, kind);
      break;
  }
}

function handleSessionUpdatePart3(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.AgentLlmRetry:
      if (update.agentId) {
        flushStreamBuffers();
        resetThinkStreamState(update.agentId);
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const msgs = conv.messages.map(m => m.isStreaming ? { ...m, content: '', isStreaming: false } : m).filter(m => !((m.type === 'text' || m.type === 'thinking') && !m.content));
          msgs.push({ id: `ar-${Date.now()}`, type: 'status' as const, content: `LLM retry #${update.attempt}: ${update.message || update.errorKind || 'stream interrupted'}`, timestamp: Date.now() });
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
      }
      break;
    case SessionUpdateKind.AgentToolCall:
      if (update.agentId) {
        flushStreamBuffers();
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const callId = update.callId;
          const idx = conv.messages.findIndex((m) => m.type === 'tool_call' && m.isStreaming && callId && m.id === `atc-${callId}`);
          if (idx >= 0) {
            const inputStr = typeof update.input === 'string' ? update.input : JSON.stringify(update.input);
            const msgs = [...conv.messages];
            msgs[idx] = { ...msgs[idx], content: inputStr, isStreaming: false, toolStatus: 'running', startedAt: Date.now() };
            return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
          }
          return s;
        });
        const conv = getStore().getState().agentConversations[update.agentId];
        const callId = update.callId;
        const hasFinalized = !!callId && conv?.messages?.some((m) => m.type === 'tool_call' && m.id === `atc-${callId}` && !m.isStreaming);
        if (!hasFinalized) {
          store.appendAgentMessage(update.agentId, {
            id: `atc-${callId || Date.now()}`, type: 'tool_call',
            content: typeof update.input === 'string' ? update.input : JSON.stringify(update.input),
            tool: update.tool, timestamp: Date.now(), toolStatus: 'running', startedAt: Date.now(),
          });
        }
      }
      break;
    case SessionUpdateKind.AgentToolCallDelta: {
      if (!update.agentId) break;
      flushStreamBuffers();
      getStore().setState((s) => {
        const conv = s.agentConversations[update.agentId];
        if (!conv) return s;
        const callId = update.callId;
        const msgs = [...conv.messages];
        const partial = String(update.partialJson || '');
        const idx = callId ? msgs.findIndex((m) => m.id === `atc-${callId}`) : msgs.findIndex((m) => m.type === 'tool_call' && m.isStreaming === true);
        if (idx >= 0) {
          const prev = msgs[idx];
          const prevContent = typeof prev.content === 'string' ? prev.content : '';
          const nextContent = prevContent + partial;
          msgs[idx] = { ...prev, content: nextContent, tool: prev.tool || update.tool, isStreaming: true, toolStatus: 'streaming_input', inputCharCount: nextContent.length, firstDeltaAt: prev.firstDeltaAt ?? Date.now() };
        } else {
          const now = Date.now();
          msgs.push({ id: `atc-${callId || `stream-${update.index ?? 0}-${now}`}`, type: 'tool_call', content: partial, tool: update.tool, timestamp: now, isStreaming: true, toolStatus: 'streaming_input', inputCharCount: partial.length, firstDeltaAt: now });
        }
        return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
      });
      break;
    }
    case SessionUpdateKind.AgentToolResult:
      if (update.agentId) {
        flushStreamBuffers();
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv || !update.callId) return s;
          const idx = conv.messages.findIndex((m) => m.type === 'tool_call' && m.id === `atc-${update.callId}`);
          if (idx < 0) return s;
          const msgs = [...conv.messages];
          msgs[idx] = { ...msgs[idx], isStreaming: false, toolStatus: update.error || update.isError ? 'failed' : 'completed', endedAt: Date.now() };
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
        store.appendAgentMessage(update.agentId, {
          id: `atr-${update.callId || Date.now()}`, type: 'tool_result',
          content: typeof update.result === 'string' ? update.result : JSON.stringify(update.result),
          tool: update.tool, timestamp: Date.now(),
        });
        if (String(update.tool || '').toLowerCase() === 'attempt_completion') {
          resetThinkStreamState(update.agentId);
          getStore().setState((s) => completeAgentUiState(s, update.agentId));
          store.finalizeLastAgentMessage(update.agentId);
        }
      }
      break;

    // PLACEHOLDER_SSE8
    default:
      handleSessionUpdatePart4(store, update, data, kind);
      break;
  }
}

function handleSessionUpdatePart4(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.AgentCompleted:
      if (update.agentId) {
        flushStreamBuffers();
        resetThinkStreamState(update.agentId);
        store.updateAgentStatus(update.agentId, 'completed');
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          const newConvs = { ...s.agentConversations, [update.agentId]: conv ? { ...conv, status: 'completed', ...(update.tokenUsage ? { tokenUsage: update.tokenUsage as { prompt: number; completion: number; total: number } } : {}), messages: [...conv.messages, { id: `ac-${Date.now()}`, type: 'status' as const, content: `${i18n.t('session.agent.completed')}${update.result ? ': ' + String(update.result).slice(0, 100) : ''}`, timestamp: Date.now() }] } : conv };
          const msgs = s.messages.map((m) => { if (m.role !== 'assistant' || !m.agentActivity?.length) return m; return { ...m, agentActivity: m.agentActivity.map(a => a.agentId === update.agentId ? { ...a, status: 'completed' as const } : a) }; });
          return { agentConversations: pruneAgentConversations(newConvs), messages: msgs };
        });
        store.finalizeLastAgentMessage(update.agentId);
      }
      break;
    case SessionUpdateKind.AgentTerminated:
      if (update.agentId) {
        flushStreamBuffers();
        resetThinkStreamState(update.agentId);
        store.updateAgentStatus(update.agentId, 'interrupted');
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          const newConvs = { ...s.agentConversations, [update.agentId]: conv ? { ...conv, status: 'interrupted', messages: [...conv.messages, { id: `at-${Date.now()}`, type: 'status' as const, content: `${i18n.t('session.agent.terminated')}${update.reason ? ': ' + String(update.reason).slice(0, 100) : ''}`, timestamp: Date.now() }] } : conv };
          const msgs = s.messages.map((m) => { if (m.role !== 'assistant' || !m.agentActivity?.length) return m; return { ...m, agentActivity: m.agentActivity.map(a => a.agentId === update.agentId ? { ...a, status: 'interrupted' as const } : a) }; });
          return { agentConversations: pruneAgentConversations(newConvs), messages: msgs };
        });
      }
      break;
    case SessionUpdateKind.AgentFailed:
      if (update.agentId) {
        flushStreamBuffers();
        resetThinkStreamState(update.agentId);
        store.updateAgentStatus(update.agentId, 'failed');
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          const newConvs = { ...s.agentConversations, [update.agentId]: conv ? { ...conv, status: 'failed', backend: update.backend || conv.backend, externalSessionId: update.externalSessionId || conv.externalSessionId, pid: update.pid || conv.pid, logPath: update.logPath || conv.logPath, diagnostics: { stderrTail: update.stderrTail || conv.diagnostics?.stderrTail, stdoutTail: update.stdoutTail || conv.diagnostics?.stdoutTail }, recovery: { recoverable: update.recoverable ?? conv.recovery?.recoverable, recoveryAction: update.recoveryAction || conv.recovery?.recoveryAction }, messages: [...conv.messages, { id: `af-${Date.now()}`, type: 'status' as const, content: `${i18n.t('session.agent.failed')}: ${update.error || 'Unknown error'}`, timestamp: Date.now() }] } : conv };
          const msgs = s.messages.map((m) => { if (m.role !== 'assistant' || !m.agentActivity?.length) return m; return { ...m, agentActivity: m.agentActivity.map(a => a.agentId === update.agentId ? { ...a, status: 'failed' as const } : a) }; });
          return { agentConversations: pruneAgentConversations(newConvs), messages: msgs };
        });
        store.finalizeLastAgentMessage(update.agentId);
      }
      break;
    case SessionUpdateKind.AgentStatus:
      if (update.agentId) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          const currentAgent = s.agents.find(a => a.agentId === update.agentId);
          const status = mergeAgentStatus(conv?.status || currentAgent?.status, update.status);
          const nextAgents = s.agents.map(a => a.agentId === update.agentId ? { ...a, status } : a);
          if (!conv) return { agents: nextAgents };
          return { agents: nextAgents, agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, status: status as AgentConversation['status'], backend: update.backend || conv.backend, externalSessionId: update.externalSessionId || conv.externalSessionId, pid: update.pid || conv.pid, logPath: update.logPath || conv.logPath, recovery: { recoverable: update.recoverable ?? conv.recovery?.recoverable, recoveryAction: update.recoveryAction || conv.recovery?.recoveryAction } } } };
        });
      }
      break;
    case SessionUpdateKind.AgentProgress:
      break;

    default:
      handleSessionUpdatePart5(store, update, data, kind);
      break;
  }
}

function handleSessionUpdatePart5(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.LeaderPhaseChange: {
      const newPhase = update.phase as import('./sessionStoreTypes.ts').SessionPhase;
      store.setPhase(newPhase);
      if (update.streamingToolName) { getStore().setState({ streamingToolName: update.streamingToolName as string }); }
      else if (newPhase !== 'streaming') { getStore().setState({ streamingToolName: undefined }); }
      markStreamingActivity();
      break;
    }
    case SessionUpdateKind.SessionFailed:
      store.setPhase('error');
      getStore().setState((s) => ({ messages: [...clearAssistantRetrying(s.messages), { id: `session-failed-${Date.now()}`, role: 'assistant' as const, content: `[Session Failed] ${update.error || 'unknown error'}`, timestamp: Date.now(), isStreaming: false, retrying: false, error: true }] }));
      break;
    case SessionUpdateKind.OrchestrationRunState:
      getStore().setState((s) => {
        const summary = String(update.summary || '');
        const state = normalizeRunStatus(update.status);
        const busy = typeof update.busy === 'boolean' ? update.busy : isRunActiveStatus(state);
        return { orchestrationStatus: { ...(s.orchestrationStatus || { active: false, state: 'idle', summary: '', updatedAt: Date.now() }), active: isRunActiveStatus(state), busy, state, summary, updatedAt: Date.now(), runId: update.runId, generation: update.generation, totalNodes: update.totalNodes, completedNodes: update.completedNodes, failedNodes: update.failedNodes, blockedNodes: update.blockedNodes, activeNodeIds: update.activeNodeIds, currentNodeId: update.currentNodeId, bottleneck: update.bottleneck, eventCount: update.eventCount }, leaderStatusText: summary ? `Orchestration: ${summary}` : s.leaderStatusText, phase: isRunActiveStatus(state) ? 'streaming' : s.phase };
      });
      break;
    case SessionUpdateKind.OrchestrationDagUpdate:
      getStore().setState({ dagSnapshot: update.dag || null });
      break;
    case SessionUpdateKind.RunExplanationUpdate:
      getStore().setState({ runExplanation: update.explanation || null, leaderStatusText: update.explanation?.reason ? String(update.explanation.reason) : getStore().getState().leaderStatusText });
      break;
    case SessionUpdateKind.OrchestrationNodeUpdate:
      {
        const task = toTaskUpdatePayload(update.task);
        if (task) taskUpdateListeners.forEach(fn => fn(task, 'orchestration_node_update'));
      }
      getStore().setState((s) => {
        const eventHistory = [...(s.orchestrationStatus?.eventHistory || []), { kind: 'node' as const, eventType: String(update.eventType || 'NodeUpdated'), taskId: update.task?.id, nodeKind: update.metadata?.nodeKind, verdict: update.metadata?.verdict, generation: update.metadata?.generation, agentName: update.task?.assigned_agent != null ? String(update.task.assigned_agent) : undefined, repairCount: typeof update.metadata?.repairCount === 'number' ? update.metadata.repairCount : undefined, ts: Date.now() }];
        return { orchestrationStatus: { ...(s.orchestrationStatus || { active: true, state: 'running', summary: '', updatedAt: Date.now() }), active: true, updatedAt: Date.now(), runId: update.runId, eventHistory: eventHistory.slice(-50) } };
      });
      break;
    case SessionUpdateKind.OrchestrationEventApplied:
    case SessionUpdateKind.OrchestrationEventRejected:
    case SessionUpdateKind.OrchestrationRepairRequested:
    case SessionUpdateKind.OrchestrationResetRequested:
      getStore().setState((s) => {
        const historyKind: 'applied' | 'rejected' | 'repair' | 'reset' = kind === SessionUpdateKind.OrchestrationEventRejected
          ? 'rejected'
          : kind === SessionUpdateKind.OrchestrationRepairRequested
            ? 'repair'
            : kind === SessionUpdateKind.OrchestrationResetRequested
              ? 'reset'
              : 'applied';
        const eventHistory = [...(s.orchestrationStatus?.eventHistory || []), { kind: historyKind, eventType: String(update.eventType || kind || 'orchestrationEvent'), taskId: update.taskId, nodeKind: update.nodeKind, verdict: update.verdict, reason: update.reason, generation: update.generation, repairCount: typeof update.repairCount === 'number' ? update.repairCount : undefined, ts: Date.now() }];
        return { orchestrationStatus: { ...(s.orchestrationStatus || { active: true, state: 'running', summary: '', updatedAt: Date.now() }), active: true, state: historyKind === 'rejected' ? 'blocked' : (s.orchestrationStatus?.state || 'running'), summary: historyKind === 'rejected' ? `rejected: ${update.eventType || update.taskId || ''}` : (s.orchestrationStatus?.summary || ''), reason: update.reason, runId: update.runId, generation: update.generation, eventHistory: eventHistory.slice(-50), eventCount: (s.orchestrationStatus?.eventCount || 0) + 1, updatedAt: Date.now() } };
      });
      break;
    case SessionUpdateKind.BlackboardDelta:
      try { useBlackboardStore.getState().applyDelta({ changedNodes: update.changedNodes || [], changedEdges: update.changedEdges || [] }); } catch (err) { if (import.meta.env.DEV) console.warn('[blackboard_delta] applyDelta failed', err); }
      break;
    case SessionUpdateKind.BlackboardInitialized:
      try { useBlackboardStore.setState({ enabled: !!update.enabled, error: update.enabled ? null : (update.reason || 'blackboard disabled') }); } catch (err) { if (import.meta.env.DEV) console.warn('[blackboard_initialized] setState failed', err); }
      break;
    case SessionUpdateKind.SessionResyncFailed:
      // P4: SSE resync failure — set user-visible alert
      getStore().setState((s) => ({
        resyncAlert: {
          active: true,
          reason: String(update.reason || 'SSE resync failed'),
          timestamp: Date.now(),
        },
      }));
      break;

    default:
      handleSessionUpdatePart6(store, update, data, kind);
      break;
  }
}

function handleSessionUpdatePart6(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.TeamMessageSent: {
      const raw = asUnknownRecord(update.message);
      const metadata = raw.metadata && typeof raw.metadata === 'object'
        ? asUnknownRecord(raw.metadata)
        : undefined;
      const item: TeamMessageItem = { id: String(raw.id || `team-${Date.now()}`), fromTeam: String(raw.fromTeam || ''), fromMember: raw.fromMember ? String(raw.fromMember) : undefined, toTeam: String(update.toTeam || raw.toTeam || ''), toMember: raw.toMember ? String(raw.toMember) : undefined, content: String(raw.content || ''), urgency: raw.urgency === 'urgent' ? 'urgent' : 'normal', timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(), isBroadcast: !!update.isBroadcast, kind: raw.kind ? String(raw.kind) : undefined, requestId: raw.requestId ? String(raw.requestId) : undefined, metadata, readBy: Array.isArray(raw.readBy) ? raw.readBy.map(String) : undefined };
      getStore().setState((s) => ({ teamMessages: [...(s.teamMessages || []), item].slice(-100) }));
      break;
    }
    case SessionUpdateKind.TeamMessageRead: {
      const messageIds = Array.isArray(update.messageIds) ? update.messageIds.map(String) : [String(update.messageId || update.id || '')].filter(Boolean);
      const reader = update.memberName ? String(update.memberName) : update.reader ? String(update.reader) : undefined;
      if (messageIds.length === 0 || !reader) break;
      const idSet = new Set(messageIds);
      getStore().setState((s) => ({ teamMessages: (s.teamMessages || []).map((msg) => { if (!idSet.has(msg.id)) return msg; const readBy = new Set(msg.readBy || []); readBy.add(reader); return { ...msg, readBy: [...readBy] }; }) }));
      break;
    }
    case SessionUpdateKind.WorkNoteWritten:
      getStore().setState((s) => ({ notifications: [...(s.notifications || []), { kind: 'work_note_written', agentId: update.agentId, note: update.note, receivedAt: Date.now() }].slice(-50) }));
      break;
    case SessionUpdateKind.AgentHeartbeat:
    case SessionUpdateKind.AgentInteractiveState:
    case SessionUpdateKind.AgentCrashed: {
      if (!update.agentId) break;
      const runtimeState = (update.state && typeof update.state === 'object') ? update.state : update;
      const explicitStatus = update.status || recordStatus(runtimeState);
      const recoverable = update.recoverable === true || Boolean(update.recoveryAction);
      const status = kind === SessionUpdateKind.AgentCrashed
        ? (recoverable ? 'recovering' : 'failed')
        : explicitStatus ? normalizeAgentStatus(explicitStatus) : undefined;
      getStore().setState((s) => {
        const conv = s.agentConversations[update.agentId];
        if (!conv) return s;
        const nextStatus = status ? mergeAgentStatus(conv.status, status) as AgentConversation['status'] : conv.status;
        return {
          agentConversations: {
            ...s.agentConversations,
            [update.agentId]: {
              ...conv,
              status: nextStatus,
              backend: update.backend || conv.backend,
              externalSessionId: update.externalSessionId || conv.externalSessionId,
              pid: update.pid || conv.pid,
              logPath: update.logPath || conv.logPath,
              lastError: update.error ? String(update.error) : conv.lastError,
              summary: update.message ? String(update.message) : conv.summary,
              diagnostics: {
                stderrTail: update.stderrTail || conv.diagnostics?.stderrTail,
                stdoutTail: update.stdoutTail || conv.diagnostics?.stdoutTail,
              },
              recovery: recoverable
                ? {
                    recoverable: true,
                    recoveryAction: update.recoveryAction ? String(update.recoveryAction) : conv.recovery?.recoveryAction,
                  }
                : conv.recovery,
            },
          },
          agents: status ? s.agents.map((agent) => agent.agentId === update.agentId ? { ...agent, status: mergeAgentStatus(agent.status, status) } : agent) : s.agents,
        };
      });
      break;
    }
    case SessionUpdateKind.Notification:
      getStore().setState((s) => ({ notifications: [...(s.notifications || []), { ...(update.notification || {}), receivedAt: Date.now() }].slice(-50) }));
      break;
    case SessionUpdateKind.LeaderMessageQueued:
      getStore().setState({ leaderQueueLength: (update.queueLength as number) || 0 });
      break;
    case SessionUpdateKind.LeaderMessageDequeued:
      getStore().setState({ leaderQueueLength: (update.queueLength as number) || 0 });
      break;
    case SessionUpdateKind.AgentError:
      if (update.agentId) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, lastError: String(update.error || '') } } };
        });
      }
      break;
    case SessionUpdateKind.LeaderBusy: {
      const isBusy = update.isBusy === true || update.busy === true;
      const queueLength = typeof update.queueLength === 'number' ? update.queueLength : 0;
      getStore().setState({ leaderQueueLength: queueLength });
      if (isBusy) {
        const reason = typeof update.reason === 'string' ? update.reason : '';
        if (reason) store.setLeaderStatusText?.(reason);
        store.setPhase(phaseForBusySignal(getStore().getState().phase));
      } else {
        flushStreamBuffers();
        store.setLeaderStatusText?.('');
        if (shouldAcceptIdleTransition()) store.setPhase('idle');
      }
      break;
    }
    case SessionUpdateKind.SessionCompleted:
      getStore().setState((s) => completeSessionUiState(s));
      break;
    case SessionUpdateKind.SessionRenamed: {
      const newName = String(update.name || '').trim();
      const renamedId = String(data.params?.sessionId || data.sessionId || store.sessionId || '');
      if (newName && renamedId) {
        getStore().setState((s) => ({ sessions: s.sessions.map((sess) => sess.id === renamedId ? { ...sess, name: newName } : sess) }));
      }
      break;
    }

    default:
      handleSessionUpdatePart7(store, update, data, kind);
      break;
  }
}

function handleSessionUpdatePart7(store: SessionState, update: SessionEventPayload, data: SessionUpdateEventData, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.StatusChange: {
      if (getStore().getState().phase === 'error') break;
      if (normalizeRunStatus(update.status) === 'completed') { getStore().setState((s) => completeSessionUiState(s)); break; }
      getStore().setState((s) => ({ messages: clearAssistantRetrying(s.messages) }));
      const statusKind = update.statusKind as 'active' | 'idle' | 'waiting' | 'interrupted' | 'completed' | undefined;
      if (statusKind === 'completed') { flushStreamBuffers(); getStore().setState((s) => completeSessionUiState(s)); break; }
      if (statusKind === 'interrupted') { flushStreamBuffers(); getStore().setState((s) => settleOpenLeaderToolCalls(s, 'cancelled', createLeaderSyntheticToolSettleResult('interrupted', update.status || 'interrupted'))); store.setLeaderStatusText?.(''); store.setPhase('interrupted'); break; }
      if (statusKind === 'idle' || statusKind === 'waiting') { flushStreamBuffers(); store.setLeaderStatusText?.(''); if (shouldAcceptIdleTransition()) { store.setPhase('idle'); } break; }
      const normalizedStatusKind = normalizeLeaderStatusKind(update.status);
      if (normalizedStatusKind === 'interrupted') { flushStreamBuffers(); getStore().setState((s) => settleOpenLeaderToolCalls(s, 'cancelled', createLeaderSyntheticToolSettleResult('interrupted', update.status || 'interrupted'))); store.setLeaderStatusText?.(''); store.setPhase('interrupted'); break; }
      if (normalizedStatusKind === 'idle' || normalizedStatusKind === 'waiting' || normalizedStatusKind === 'completed') { flushStreamBuffers(); store.setLeaderStatusText?.(''); if (shouldAcceptIdleTransition()) { store.setPhase('idle'); } break; }
      if (statusKind === 'active' || normalizedStatusKind === 'active') { store.setLeaderStatusText?.(update.status || ''); store.setPhase(phaseForBusySignal(getStore().getState().phase)); }
      break;
    }
    case SessionUpdateKind.InterruptionRequest:
      addPermissionRequestFromUpdate(update, data);
      break;
    case SessionUpdateKind.PlanSubmitted: {
      const rawPlan = update.plan;
      const planStr = typeof rawPlan === 'string' ? rawPlan : (rawPlan != null ? JSON.stringify(rawPlan, null, 2) : '');
      if (getStore().getState().controlMode === 'eternal') break;
      getStore().setState({ pendingPlan: planStr || '' });
      break;
    }
    case SessionUpdateKind.PlanUpdated:
      getStore().setState({ activePlan: update.plan ?? null });
      break;
    case SessionUpdateKind.PlanFinalized:
      getStore().setState((state) => ({
        activePlan: state.activePlan && typeof state.activePlan === 'object'
          ? { ...(state.activePlan as Record<string, unknown>), finalStatus: update.finalStatus, summary: update.summary }
          : null,
      }));
      break;
    case SessionUpdateKind.PlanApproved:
      getStore().setState({ pendingPlan: null });
      break;
    case SessionUpdateKind.PlanRejected:
      getStore().setState({ pendingPlan: null });
      break;
    case SessionUpdateKind.ControlModeChanged: {
      const mode = update.mode;
      if (mode === 'manual' || mode === 'eternal') {
        getStore().setState({ controlMode: mode });
        if (mode === 'eternal') { getStore().setState({ pendingPlan: null }); }
      }
      break;
    }
    case SessionUpdateKind.BlueprintUpdated: {
      const blueprint = (update.blueprint ?? null) as ProjectBlueprint | null;
      getStore().setState((s) => {
        const snap = s.runtimeSnapshot;
        return {
          blueprint,
          ...(snap ? { runtimeSnapshot: { ...snap, modes: { ...snap.modes, blueprint } } } : {}),
        };
      });
      break;
    }
    case SessionUpdateKind.EternalGoalChanged: {
      const goal = update.goal && typeof update.goal === 'object' && typeof update.goal.description === 'string'
        ? { description: update.goal.description, paused: Boolean(update.goal.paused), createdAt: Number(update.goal.createdAt || 0), updatedAt: Number(update.goal.updatedAt || Date.now()) }
        : null;
      getStore().setState((s) => {
        const current = s.runtimeSnapshot;
        if (!current) return {};
        return { runtimeSnapshot: { ...current, eternal: { ...current.eternal, goal, status: goal?.paused && current.eternal.enabled ? 'paused' : current.eternal.status } } };
      });
      break;
    }
    case SessionUpdateKind.PermissionModeChanged: {
      const mode = update.mode;
      if (typeof mode === 'string' && mode) { getStore().setState({ permissionMode: mode }); }
      break;
    }
    case SessionUpdateKind.AskUserQuestion: {
      const qMsg = { id: `ask-${Date.now()}`, role: 'assistant' as const, content: '', timestamp: Date.now(), askUserQuestion: { question: update.question || '', options: update.options, multiSelect: update.multiSelect === true, answered: false, questions: normalizeQuestionList(update.questions) } };
      getStore().getState().addMessage(qMsg);
      break;
    }
    case SessionUpdateKind.AskUserAnswered: {
      const answer = typeof update.answer === 'string' ? update.answer : undefined;
      getStore().getState().resolvePendingQuestions(answer);
      break;
    }

    default:
      handleSessionUpdatePart8(store, update, kind);
      break;
  }
}

function handleSessionUpdatePart8(store: SessionState, update: SessionEventPayload, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.Error:
      flushStreamBuffers();
      store.setPhase('error');
      getStore().setState((s) => {
        const content = `[Error] ${update.error || 'Unknown error'}`;
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant' && (last.isStreaming || last.retrying || !last.content)) {
          msgs[msgs.length - 1] = { ...last, content, isStreaming: false, retrying: false, error: true, errorKind: update.errorKind || update.llmErrorKind };
          return { messages: msgs };
        }
        return { messages: trimMessageWindow([...msgs, { id: `error-${Date.now()}`, role: 'assistant' as const, content, timestamp: Date.now(), isStreaming: false, retrying: false, error: true, errorKind: update.errorKind || update.llmErrorKind }]) };
      });
      break;
    case SessionUpdateKind.AgentTokenUsage:
      if (update.agentId) {
        markStreamingActivity();
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          const incomingTs = (update.ts as number | undefined) ?? Date.now();
          const u = update.usage as { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number };
          let nextConversations = s.agentConversations;
          if (conv) {
            if (conv._lastTokenTs != null && incomingTs < conv._lastTokenTs) return s;
            const prev = conv.tokenUsage ?? { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0 };
            nextConversations = { ...s.agentConversations, [update.agentId]: { ...conv, _lastTokenTs: incomingTs, tokenUsage: { prompt: prev.prompt + (u.prompt || 0), completion: prev.completion + (u.completion || 0), total: prev.total + (u.total || 0), cache_read: (prev.cache_read ?? 0) + (u.cache_read ?? 0), cache_creation: (prev.cache_creation ?? 0) + (u.cache_creation ?? 0) }, contextRatio: update.contextRatio as number | undefined } };
          } else {
            const pending = s._pendingTokens?.[update.agentId] ?? { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0 };
            const nextPending = { ...s._pendingTokens, [update.agentId]: { prompt: pending.prompt + (u.prompt || 0), completion: pending.completion + (u.completion || 0), total: pending.total + (u.total || 0), cache_read: (pending.cache_read ?? 0) + (u.cache_read ?? 0), cache_creation: (pending.cache_creation ?? 0) + (u.cache_creation ?? 0) } };
            return { _pendingTokens: nextPending, tokenUsage: computeGlobalTokenUsage(nextConversations, nextPending) };
          }
          return { agentConversations: nextConversations, tokenUsage: computeGlobalTokenUsage(nextConversations, s._pendingTokens) };
        });
      }
      break;
    case SessionUpdateKind.ToolOutput:
      // agent 工具卡片的真实流式输出（Shell/Python 等）：chunk 累积进 atc-${callId}.streamingOutput，
      // 对齐 leader LeaderToolOutput（sseStore.ts:1012）。不再 push 独立 to- 消息（原独立消息会错误占用
      // groupAgentMessages 的 pending 配对槽，导致真 atr- tool_result 变孤立）。
      if (update.agentId && update.callId && update.chunk) {
        markStreamingActivity();
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const idx = conv.messages.findIndex((m) => m.type === 'tool_call' && m.id === `atc-${update.callId}`);
          if (idx < 0) return s; // atc 尚未落地则丢弃（同 leader）
          const prev = conv.messages[idx];
          if (isToolCallTerminalStatus(prev.toolStatus)) return s;
          const msgs = [...conv.messages];
          msgs[idx] = { ...prev, streamingOutput: appendStreamingOutput(prev.streamingOutput || '', update.chunk) };
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
      }
      break;
    case SessionUpdateKind.ShellState:
      if (update.agentId) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const msgs = conv.messages.map(m => hasStreamingSubtype(m, 'tool_output') && m.isStreaming ? { ...m, isStreaming: false } : m);
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
      }
      break;
    case SessionUpdateKind.ToolProgress: {
      markStreamingActivity();
      if (update.callId) {
        getStore().setState((s) => {
          const messages = s.messages.map(m => { if (m.role !== 'assistant' || !m.toolCalls?.some(tc => tc.id === update.callId)) return m; return { ...m, toolCalls: m.toolCalls!.map(tc => tc.id === update.callId ? { ...tc, progressMessage: update.message } : tc) }; });
          return { messages };
        });
      }
      break;
    }
    case SessionUpdateKind.AgentToolProgress: {
      markStreamingActivity();
      if (update.agentId && update.callId) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const idx = conv.messages.findIndex((m) => m.type === 'tool_call' && m.id === `atc-${update.callId}`);
          if (idx < 0) return s;
          const prev = conv.messages[idx];
          if (isToolCallTerminalStatus(prev.toolStatus)) return s;
          const msgs = [...conv.messages];
          msgs[idx] = { ...prev, startedAt: prev.startedAt ?? Date.now() - (typeof update.elapsedMs === 'number' ? update.elapsedMs : 0), progressMessage: typeof update.message === 'string' ? update.message : prev.progressMessage };
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
      }
      break;
    }

    default:
      handleSessionUpdatePart9(store, update, kind);
      break;
  }
}

function handleSessionUpdatePart9(store: SessionState, update: SessionEventPayload, kind?: SessionUpdateKind) {
  switch (kind) {
    case SessionUpdateKind.TerminalOutput:
      if (update.agentId && update.chunk) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (hasStreamingSubtype(last, 'terminal_output') && last.isStreaming && last.tool === update.terminalId) { msgs[msgs.length - 1] = { ...last, content: appendStreamingOutput(last.content, update.chunk) }; }
          else { msgs.push(withStreamingSubtype({ id: `tmo-${update.terminalId || Date.now()}`, type: 'tool_result' as const, content: update.chunk, tool: update.terminalId, timestamp: Date.now(), isStreaming: true }, 'terminal_output')); }
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
      }
      break;
    case SessionUpdateKind.TerminalState:
      if (update.agentId) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const msgs = conv.messages.map(m => hasStreamingSubtype(m, 'terminal_output') && m.isStreaming ? { ...m, isStreaming: false } : m);
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, messages: msgs } } };
        });
      }
      break;
    case SessionUpdateKind.InterruptionResolved:
      if (update.requestId) { usePermissionStore.setState((s) => ({ pendingRequests: s.pendingRequests.filter(r => r.requestId !== update.requestId) })); }
      break;
    case SessionUpdateKind.AgentContextUpdated:
      if (update.agentId) {
        getStore().setState((s) => {
          const conv = s.agentConversations[update.agentId];
          if (!conv) return s;
          const ctxTokens = update.contextTokens as number;
          const ctxMax = update.contextMax as number;
          return { agentConversations: { ...s.agentConversations, [update.agentId]: { ...conv, contextRatio: ctxMax > 0 ? ctxTokens / ctxMax : undefined } } };
        });
      }
      break;
    case SessionUpdateKind.ContextCompressed:
      markStreamingActivity();
      getStore().setState({ lastCompressedAt: Date.now() });
      store.fetchTokenUsage();
      break;
    case SessionUpdateKind.ContextCompacting:
      markStreamingActivity();
      if (update.phase === 'end') {
        getStore().setState((s) => ({ compactingProgress: null, phase: s.phase === 'compacting' ? 'idle' : s.phase }));
      } else {
        store.setPhase('compacting');
        getStore().setState((s) => ({
          compactingProgress: {
            stage: (update.stage as string) || s.compactingProgress?.stage || 'llm_summary',
            chunkIndex: update.chunkIndex as number | undefined,
            chunkTotal: update.chunkTotal as number | undefined,
            percent: update.percent as number | undefined,
            oldTokens: (update.oldTokens as number | undefined) ?? s.compactingProgress?.oldTokens,
            newTokens: (update.newTokens as number | undefined) ?? s.compactingProgress?.newTokens,
            threshold: (update.threshold as number | undefined) ?? s.compactingProgress?.threshold,
            messageCount: (update.messageCount as number | undefined) ?? s.compactingProgress?.messageCount,
            label: (update.label as string | undefined) ?? s.compactingProgress?.label,
            at: s.compactingProgress?.at ?? Date.now(),
          },
        }));
      }
      break;
    case SessionUpdateKind.ContextRuntimeUpdated:
      markStreamingActivity();
      if (update.owner === 'leader' && update.state) {
        const st = update.state as { currentTokens: number; maxTokens: number; threshold: number; warningLevel: 'ok' | 'warning' | 'critical' };
        getStore().setState({ contextRuntimeState: { currentTokens: st.currentTokens ?? 0, maxTokens: st.maxTokens ?? 0, threshold: st.threshold ?? 0, warningLevel: st.warningLevel ?? 'ok' } });
      }
      break;
    case SessionUpdateKind.SessionRuntimeState: {
      const snapshot = coerceSessionRuntimeSnapshot(update);
      if (!snapshot) break;
      if (!runtimeImpliesBusy({ runtimeState: snapshot })) { flushStreamBuffers(); resetThinkStreamState(); }
      markStreamingActivity();
      getStore().setState((s) => applyRuntimeSnapshotPatch(s, snapshot, pendingStreamIsEmpty()));
      break;
    }
    case SessionUpdateKind.TaskUpdate:
      {
        const task = toTaskUpdatePayload(update.task);
        if (task) taskUpdateListeners.forEach(fn => fn(task, typeof update.action === 'string' ? update.action : 'updated'));
      }
      break;
    case SessionUpdateKind.WatchdogAlert:
      getStore().setState({ watchdogAlert: { elapsedMs: update.elapsedMs as number, intervention: update.intervention as string, at: Date.now() } });
      break;
    case SessionUpdateKind.ProgressStagnant:
      getStore().setState({ progressStagnant: { consecutiveRounds: update.consecutiveStagnantRounds as number, at: Date.now() } });
      break;
    case SessionUpdateKind.LeaderRoundComplete:
      markStreamingActivity();
      break;
    case SessionUpdateKind.ContextOverflow:
      markStreamingActivity();
      getStore().setState((s) => ({ notifications: [...(s.notifications || []), { kind: 'context_overflow', tokens: update.tokens, threshold: update.threshold, owner: update.owner, agentId: update.agentId, agentName: update.agentName, receivedAt: Date.now() }].slice(-50) }));
      break;
  }
}

// Auto-register on import
ensureSseListener();
