import type { WorkerBackend } from './Agent.js';
import type { AgentRunStatus } from './Status.js';

export type EventType =
  | 'leader:text'
  | 'leader:text_chunk'
  | 'leader:thinking_chunk'
  | 'leader:tool_call'
  | 'leader:tool_result'
  | 'leader:tool_call_delta'
  | 'leader:status'
  | 'leader:error'
  | 'leader:route'
  | 'leader:control_mode_changed'
  | 'leader:blueprint_updated'
  | 'leader:phase_change'
  | 'leader:busy'
  | 'leader:round_complete'
  | 'leader:watchdog_alert'
  | 'leader:progress_stagnant'
  | 'leader:tool_output'
  | 'leader:tool_progress'
  | 'leader:plan_approved'
  | 'leader:plan_rejected'
  | 'leader:llm_retry'
  | 'agent:spawned'
  | 'agent:started'
  | 'agent:completed'
  | 'agent:terminated'
  | 'agent:failed'
  | 'agent:status'
  | 'agent:progress'
  | 'agent:heartbeat'
  | 'agent:interactive_state'
  | 'agent:tool_call'
  | 'agent:tool_result'
  | 'agent:tool_call_delta'
  | 'agent:tool_output'
  | 'agent:shell_state'
  | 'agent:tool_progress'
  | 'agent:text_chunk'
  | 'agent:thinking_chunk'
  | 'agent:text'
  | 'agent:error'
  | 'agent:context_updated'
  | 'agent:llm_retry'
  | 'task:created'
  | 'task:updated'
  | 'task:assigned'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  | 'task:deleted'
  | 'session:created'
  | 'session:failed'
  | 'session:deleted'
  | 'session:renamed'
  | 'session:focus'
  | 'session:completed'
  | 'session:interrupted'
  | 'session:runtime_state'
  | 'settings:changed'
  | 'chat:user_message'
  | 'conversation:message_saved'
  | 'permission:mode_changed'
  | 'permission:request'
  | 'permission:resolved'
  | 'context:runtime_updated'
  | 'context:compressed'
  | 'context:compacting'
  | 'context:overflow'
  | 'eternal:goal_changed'
  | 'blackboard:delta'
  | 'blackboard:initialized'
  | 'work_note:written'
  | 'team:message_sent'
  | 'team:message_read'
  | 'leader:message_queued'
  | 'leader:message_dequeued'
  | 'agent:crashed'
  | 'agent:intervention'
  | 'wiki:generation_started'
  | 'wiki:generation_progress'
  | 'wiki:generation_stream'
  | 'wiki:generation_completed'
  | 'wiki:generation_failed'
  | 'memory:maintenance_started'
  | 'memory:maintenance_progress'
  | 'memory:maintenance_completed'
  | 'memory:maintenance_failed'
  | 'workflow:created'
  | 'workflow:updated'
  | 'workflow:deleted'
  | 'workflow:node_added'
  | 'workflow:node_updated'
  | 'workflow:node_deleted'
  | 'workflow:edge_added'
  | 'workflow:edge_updated'
  | 'workflow:edge_deleted'
  | 'workflow:execution_started'
  | 'workflow:node_started'
  | 'workflow:node_completed'
  | 'workflow:node_failed'
  | 'workflow:node_retrying'
  | 'workflow:node_skipped'
  | 'workflow:execution_completed'
  | 'workflow:execution_failed'
  | 'workflow:execution_cancelled'
  | 'workflow:execution_paused'
  | 'workflow:execution_resumed'
  | 'workflow:execution_progress'
  | 'orchestration:status'
  | 'orchestration:run_state'
  | 'orchestration:node_update'
  | 'orchestration:dag_updated'
  | 'orchestration:event_applied'
  | 'orchestration:event_rejected'
  | 'run:explanation_updated'
  | 'token:usage'
  | 'plan:submitted'
  | 'plan:updated'
  | 'plan:finalized'
  | 'skills:loaded'
  | 'skill:invoked'
  | 'session:soul_extracted'
  | 'plugin:toggled'
  | 'terminal:output'
  | 'terminal:state'
  | 'notification:new'
  | 'notification:mark_read'
  | 'user:input_needed'
  | 'user:question_answered'
  | 'langfuse:trace'
  | 'session:resync_failed';

export type EventPayloadBase = object & {
  sessionId?: string;
  timestamp?: number;
};

export const EVENT_ENVELOPE_SCHEMA_VERSION = 1;

let eventSequenceCounter = 0;

export function nextEventSequence(): number {
  eventSequenceCounter = eventSequenceCounter >= Number.MAX_SAFE_INTEGER ? 1 : eventSequenceCounter + 1;
  return eventSequenceCounter;
}

export function createEventId(type: EventType, sequence: number, timestamp: number): string {
  return `evt_${timestamp}_${sequence}_${type.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

type TaskEventPayload = EventPayloadBase & {
  task: unknown;
};

type TaskTerminalPayload = Partial<TaskEventPayload> & EventPayloadBase & {
  taskId?: string;
  result?: unknown;
  reason?: string;
};

type AgentInterventionPayload = AgentEventPayload & {
  agentName: string;
  message_type: string;
  content: string;
};

type WikiGenerationPayload = EventPayloadBase & {
  projectPath: string;
  lang: string;
};

type WikiGenerationProgressPayload = WikiGenerationPayload & {
  phase: string;
  progress: number;
  detail: string;
};

type WikiGenerationStreamPayload = WikiGenerationPayload & {
  sectionId: string;
  sectionTitle: string;
  chunk: string;
};

/**
 * Memory maintenance (dream/distill) lifecycle. Mirrors wiki:generation_* so
 * both the TUI status line and the web overlay can animate background memory
 * consolidation. `kind` distinguishes the two pipelines; `phase`/`progress`
 * drive the deterministic step indicator (no heuristics — progress is a fixed
 * fraction per pipeline stage). sessionId is optional: daemon-triggered runs
 * carry the daemon session, manual /dream|/distill runs carry the active one.
 */
type MemoryMaintenancePayload = EventPayloadBase & {
  kind: 'dream' | 'distill';
};

type MemoryMaintenanceProgressPayload = MemoryMaintenancePayload & {
  phase: string;
  progress: number;
  detail: string;
};

type SessionCreatedPayload = EventPayloadBase & {
  sessionId: string;
  workspace?: string;
  createdAt?: number;
};

type SessionFocusPayload = EventPayloadBase & {
  sessionId: string;
  status?: 'active' | 'completed' | 'failed' | 'interrupted';
  workspace?: string;
};

type SkillSummaryPayload = {
  name: string;
  source?: string;
  summary?: string;
};

type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

type ConversationMessagePayload = EventPayloadBase & {
  id?: number | string;
  role: MessageRole;
  content?: unknown;
  toolCalls?: unknown[];
  thinking?: Array<{ type: string; text?: string }>;
  source?: string;
};

type SettingsChangedPayload = EventPayloadBase & {
  key: string;
  value: unknown;
};

type ChatUserMessagePayload = EventPayloadBase & {
  content?: unknown;
  attachments?: unknown[];
};

type DagSnapshotPayload = EventPayloadBase & {
  dag?: unknown;
  snapshot?: unknown;
};

type OrchestrationNodePayload = TaskEventPayload & {
  runId?: string;
  eventType?: string;
  metadata?: unknown;
  displayState?: string;
};

type OrchestrationRunPayload = EventPayloadBase & {
  runId: string;
  status: string;
  busy?: boolean;
  generation?: number;
  totalNodes?: number;
  completedNodes?: number;
  failedNodes?: number;
  blockedNodes?: number;
  activeNodeIds?: string[];
  currentNodeId?: string | null;
  bottleneck?: string;
  summary?: string;
  eventCount?: number;
};

type OrchestrationVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';

type OrchestrationAppliedPayload = EventPayloadBase & {
  sessionId: string;
  runId: string;
  eventId: string;
  eventType: string;
  taskId?: string;
  nodeKind?: string;
  generation?: number;
  verdict?: OrchestrationVerdict;
};

type OrchestrationRejectedPayload = EventPayloadBase & {
  runId?: string;
  eventId?: string;
  eventType?: string;
  reason?: string;
  taskId?: string;
};

type PermissionDecision = 'approved' | 'rejected' | 'allowAll';

type PermissionRequestPayload = EventPayloadBase & {
  requestId: string;
  source: 'leader' | 'worker';
  toolName: string;
  reason: string;
  requestedMode?: 'strict' | 'dev' | 'networked' | 'yolo';
  requestedHosts?: string[];
  workerName?: string;
};

type PermissionResolvedPayload = EventPayloadBase & {
  requestId: string;
  decision: PermissionDecision;
  workerName?: string;
  toolName: string;
};

type AgentEventPayload = EventPayloadBase & {
  agentId: string;
  agentName: string;
  role?: string;
  taskId?: string;
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
  logPath?: string;
};

type AgentSpawnedPayload = AgentEventPayload & {
  role: string;
  taskId: string;
  workingDirectory?: string;
  writeScope?: string[];
  baselineRole?: string;
  skillNames?: string[];
  droppedTools?: string[];
  tools?: string[];
};

type AgentStatusPayload = AgentEventPayload & {
  agentName: string;
  status: AgentRunStatus | string;
  statusText?: string;
  message?: string;
  recoverable?: boolean;
  recoveryAction?: string;
};

type AgentProgressPayload = AgentEventPayload & {
  name: string;
  taskId: string;
  message: string;
};

type AgentCompletionPayload = AgentEventPayload & {
  agentName: string;
  taskId?: string;
  summary?: string;
  result?: unknown;
  stats?: {
    iterations?: number;
    toolCalls?: number;
  };
  pid?: number;
  backend?: 'worker_process' | 'claude' | 'codex' | 'remote';
  exitCode?: number | null;
  exitSignal?: string | null;
  recoverable?: boolean;
  recoveryAction?: string;
  timeoutReason?: string;
  stderrTail?: string[];
  stdoutTail?: string[];
};

export type EventPayloadMap = Record<EventType, EventPayloadBase> & {
  'agent:spawned': AgentSpawnedPayload;
  'agent:started': AgentEventPayload;
  'agent:completed': AgentCompletionPayload;
  'agent:terminated': AgentCompletionPayload;
  'agent:failed': AgentCompletionPayload & { error?: string; reason?: string };
  'agent:crashed': AgentCompletionPayload & { error?: string; reason?: string };
  'agent:intervention': AgentInterventionPayload;
  'agent:status': AgentStatusPayload;
  'agent:progress': AgentProgressPayload;
  'agent:heartbeat': AgentEventPayload & { agentName: string; taskId: string; phase?: string };
  'agent:interactive_state': AgentEventPayload & { agentName: string; taskId?: string; status?: string };
  'task:created': TaskEventPayload;
  'task:updated': TaskEventPayload;
  'task:assigned': TaskEventPayload & { agentId?: string };
  'task:completed': TaskTerminalPayload;
  'task:failed': TaskTerminalPayload;
  'task:cancelled': TaskTerminalPayload;
  'task:deleted': Partial<TaskEventPayload> & EventPayloadBase & { taskId: string };
  'session:created': SessionCreatedPayload;
  'session:completed': EventPayloadBase & { status?: 'completed'; summary?: string; result?: unknown };
  'session:failed': EventPayloadBase & { status?: 'failed'; error?: string; summary?: string };
  'session:interrupted': EventPayloadBase & { status?: 'interrupted'; statusKind?: 'interrupted'; reason?: string };
  'session:deleted': EventPayloadBase & { sessionId: string };
  'session:focus': SessionFocusPayload;
  'leader:status': EventPayloadBase & { status: string; statusKind?: string; pollCount?: number; runningAgents?: string[] };
  'leader:message_queued': EventPayloadBase & { count?: number; queueLength?: number };
  'leader:message_dequeued': EventPayloadBase & { count?: number; queueLength?: number };
  'chat:user_message': ChatUserMessagePayload;
  'conversation:message_saved': ConversationMessagePayload;
  'orchestration:dag_updated': DagSnapshotPayload;
  'settings:changed': SettingsChangedPayload;
  'permission:request': PermissionRequestPayload;
  'permission:resolved': PermissionResolvedPayload;
  'skills:loaded': EventPayloadBase & { sessionId: string; skills: SkillSummaryPayload[] };
  'skill:invoked': EventPayloadBase & { skills: SkillSummaryPayload[] };
  'notification:mark_read': EventPayloadBase & { notificationId?: string; markAllRead?: boolean };
  'wiki:generation_started': WikiGenerationPayload;
  'wiki:generation_progress': WikiGenerationProgressPayload;
  'wiki:generation_stream': WikiGenerationStreamPayload;
  'wiki:generation_completed': WikiGenerationPayload & { result: unknown };
  'wiki:generation_failed': WikiGenerationPayload & { error: string };
  'memory:maintenance_started': MemoryMaintenancePayload;
  'memory:maintenance_progress': MemoryMaintenanceProgressPayload;
  'memory:maintenance_completed': MemoryMaintenancePayload & { summary: string };
  'memory:maintenance_failed': MemoryMaintenancePayload & { error: string };
  'workflow:created': EventPayloadBase & { workflowId: string; workflow?: unknown };
  'workflow:updated': EventPayloadBase & { workflowId: string; workflow?: unknown; updates?: unknown };
  'workflow:deleted': EventPayloadBase & { workflowId: string };
  'workflow:node_added': EventPayloadBase & { workflowId: string; node: unknown };
  'workflow:node_updated': EventPayloadBase & { workflowId: string; nodeId: string; node?: unknown; updates?: unknown };
  'workflow:node_deleted': EventPayloadBase & { workflowId: string; nodeId: string; deletedEdges?: string[] };
  'workflow:edge_added': EventPayloadBase & { workflowId: string; edge: unknown };
  'workflow:edge_updated': EventPayloadBase & { workflowId: string; edgeId: string; edge?: unknown; updates?: unknown };
  'workflow:edge_deleted': EventPayloadBase & { workflowId: string; edgeId: string };
  'workflow:execution_started': EventPayloadBase & { workflowId: string; executionId: string; [key: string]: unknown };
  'workflow:node_started': EventPayloadBase & { executionId: string; nodeId: string; workflowId?: string; [key: string]: unknown };
  'workflow:node_completed': EventPayloadBase & { executionId: string; nodeId: string; workflowId?: string; result?: unknown; [key: string]: unknown };
  'workflow:node_failed': EventPayloadBase & { executionId: string; nodeId: string; workflowId?: string; error?: string; [key: string]: unknown };
  'workflow:node_retrying': EventPayloadBase & { executionId: string; nodeId: string; workflowId?: string; attempt?: number; [key: string]: unknown };
  'workflow:node_skipped': EventPayloadBase & { executionId: string; nodeId: string; workflowId?: string; reason?: string; [key: string]: unknown };
  'workflow:execution_completed': EventPayloadBase & { executionId: string; workflowId?: string; output?: unknown; duration?: number; [key: string]: unknown };
  'workflow:execution_failed': EventPayloadBase & { executionId: string; workflowId?: string; timeoutMs?: number; error?: string; reason?: string; [key: string]: unknown };
  'workflow:execution_cancelled': EventPayloadBase & { executionId: string; workflowId?: string; [key: string]: unknown };
  'workflow:execution_paused': EventPayloadBase & { executionId: string; workflowId?: string; [key: string]: unknown };
  'workflow:execution_resumed': EventPayloadBase & { executionId: string; workflowId?: string; [key: string]: unknown };
  'workflow:execution_progress': EventPayloadBase & { executionId: string; workflowId?: string; [key: string]: unknown };
  'orchestration:run_state': OrchestrationRunPayload;
  'orchestration:node_update': OrchestrationNodePayload;
  'orchestration:event_applied': OrchestrationAppliedPayload;
  'orchestration:event_rejected': OrchestrationRejectedPayload;
  'leader:blueprint_updated': EventPayloadBase & { blueprint: unknown; coverage?: unknown };
};

export interface EventEnvelope<T extends EventType = EventType> {
  schemaVersion: number;
  type: T;
  eventId: string;
  sequence: number;
  source: string;
  method?: string;
  sessionId: string;
  timestamp: number;
  payload: EventPayloadMap[T];
}

export type EventPayload<T extends EventType> = EventPayloadMap[T];

export const EVENT_TYPES: readonly EventType[] = [
  'leader:text',
  'leader:text_chunk',
  'leader:thinking_chunk',
  'leader:tool_call',
  'leader:tool_result',
  'leader:tool_call_delta',
  'leader:status',
  'leader:error',
  'leader:route',
  'leader:control_mode_changed',
  'leader:blueprint_updated',
  'leader:phase_change',
  'leader:busy',
  'leader:round_complete',
  'leader:watchdog_alert',
  'leader:progress_stagnant',
  'leader:tool_output',
  'leader:tool_progress',
  'leader:plan_approved',
  'leader:plan_rejected',
  'leader:llm_retry',
  'agent:spawned',
  'agent:started',
  'agent:completed',
  'agent:terminated',
  'agent:failed',
  'agent:status',
  'agent:progress',
  'agent:heartbeat',
  'agent:interactive_state',
  'agent:tool_call',
  'agent:tool_result',
  'agent:tool_call_delta',
  'agent:tool_output',
  'agent:shell_state',
  'agent:tool_progress',
  'agent:text_chunk',
  'agent:thinking_chunk',
  'agent:text',
  'agent:error',
  'agent:context_updated',
  'agent:llm_retry',
  'task:created',
  'task:updated',
  'task:assigned',
  'task:completed',
  'task:failed',
  'task:cancelled',
  'task:deleted',
  'session:created',
  'session:failed',
  'session:deleted',
  'session:renamed',
  'session:focus',
  'session:completed',
  'session:interrupted',
  'session:runtime_state',
  'settings:changed',
  'chat:user_message',
  'conversation:message_saved',
  'permission:mode_changed',
  'permission:request',
  'permission:resolved',
  'context:runtime_updated',
  'context:compressed',
  'context:compacting',
  'context:overflow',
  'eternal:goal_changed',
  'blackboard:delta',
  'blackboard:initialized',
  'work_note:written',
  'team:message_sent',
  'team:message_read',
  'leader:message_queued',
  'leader:message_dequeued',
  'agent:crashed',
  'agent:intervention',
  'wiki:generation_started',
  'wiki:generation_progress',
  'wiki:generation_stream',
  'wiki:generation_completed',
  'wiki:generation_failed',
  'workflow:created',
  'workflow:updated',
  'workflow:deleted',
  'workflow:node_added',
  'workflow:node_updated',
  'workflow:node_deleted',
  'workflow:edge_added',
  'workflow:edge_updated',
  'workflow:edge_deleted',
  'workflow:execution_started',
  'workflow:node_started',
  'workflow:node_completed',
  'workflow:node_failed',
  'workflow:node_retrying',
  'workflow:node_skipped',
  'workflow:execution_completed',
  'workflow:execution_failed',
  'workflow:execution_cancelled',
  'workflow:execution_paused',
  'workflow:execution_resumed',
  'workflow:execution_progress',
  'orchestration:status',
  'orchestration:run_state',
  'orchestration:node_update',
  'orchestration:dag_updated',
  'orchestration:event_applied',
  'orchestration:event_rejected',
  'run:explanation_updated',
  'token:usage',
  'plan:submitted',
  'plan:updated',
  'plan:finalized',
  'skills:loaded',
  'skill:invoked',
  'session:soul_extracted',
  'plugin:toggled',
  'terminal:output',
  'terminal:state',
  'notification:new',
  'notification:mark_read',
  'user:input_needed',
  'user:question_answered',
  'langfuse:trace',
] as const;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

export function isToolCallEvent(type: string): type is 'leader:tool_call' | 'agent:tool_call' {
  return type === 'leader:tool_call' || type === 'agent:tool_call';
}

export function isToolResultEvent(type: string): type is 'leader:tool_result' | 'agent:tool_result' {
  return type === 'leader:tool_result' || type === 'agent:tool_result';
}

export function parseEventEnvelope(input: unknown): EventEnvelope | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const type = typeof raw.type === 'string'
    ? raw.type
    : typeof raw.eventType === 'string'
      ? raw.eventType
      : undefined;
  if (!type || !isEventType(type)) {
    return null;
  }
  const payload = raw.payload && typeof raw.payload === 'object'
    ? raw.payload as EventPayloadBase
    : raw as EventPayloadBase;
  const sessionId = typeof raw.sessionId === 'string'
    ? raw.sessionId
    : typeof payload.sessionId === 'string'
      ? payload.sessionId
      : '';
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now();
  const sequence = typeof raw.sequence === 'number' && Number.isFinite(raw.sequence)
    ? raw.sequence
    : nextEventSequence();
  const hasCanonicalFields = Boolean(raw.payload)
    || typeof raw.schemaVersion === 'number'
    || typeof raw.sequence === 'number';
  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : EVENT_ENVELOPE_SCHEMA_VERSION,
    type,
    eventId: hasCanonicalFields && typeof raw.eventId === 'string'
      ? raw.eventId
      : createEventId(type, sequence, timestamp),
    sequence,
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
    method: typeof raw.method === 'string' ? raw.method : undefined,
    sessionId,
    timestamp,
    payload,
  };
}
