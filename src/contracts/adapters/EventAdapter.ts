export {
  EVENT_ENVELOPE_SCHEMA_VERSION,
  createEventId,
  nextEventSequence,
  parseEventEnvelope,
  isEventType,
  isToolCallEvent,
  isToolResultEvent,
  type EventEnvelope,
  type EventPayload,
  type EventPayloadMap,
  type EventType,
} from '../types/Event.js';

import {
  EVENT_ENVELOPE_SCHEMA_VERSION,
  createEventId,
  nextEventSequence,
  parseEventEnvelope,
  type EventEnvelope,
  type EventPayload,
  type EventPayloadBase,
  type EventType,
} from '../types/Event.js';
import {
  mergeAgentStatus,
  normalizeAgentStatus,
  normalizeLeaderStatusKind,
  normalizeRunStatus,
  runtimeImpliesBusy,
  type NormalizedAgentStatus,
  type NormalizedLeaderStatusKind,
  type NormalizedRunStatus,
} from './StatusAdapter.js';

export interface EventEnvelopeOptions {
  eventId?: string;
  sequence?: number;
  source?: string;
  method?: string;
  timestamp?: number;
}

export interface SessionUpdateMessage<T extends EventType = EventType> {
  method: 'session/update';
  params: {
    sessionId: string;
    update: EventEnvelope<T>;
  };
}

export interface WrappedSessionUpdate<T extends EventType = EventType> {
  envelope: EventEnvelope<T>;
  message: SessionUpdateMessage<T>;
}

export const SESSION_UPDATE_METHOD = 'session/update';

export interface ProcessedToolCall {
  id: string;
  tool?: string;
  input?: unknown;
  result?: unknown;
  status: 'streaming_input' | 'running' | 'completed' | 'failed' | 'cancelled';
  updatedAt: number;
}

export interface ProcessedAgentState {
  agentId: string;
  agentName: string;
  role?: string;
  taskId?: string;
  status: NormalizedAgentStatus;
  progress?: unknown;
  summary?: string;
  backend?: unknown;
  externalSessionId?: unknown;
  pid?: unknown;
  logPath?: unknown;
  error?: string;
  text: string;
  thinking: string;
  toolCalls: Record<string, ProcessedToolCall>;
  updatedAt: number;
}

export interface ProcessedTaskState {
  taskId: string;
  status?: string;
  action?: string;
  task?: unknown;
  assignedAgent?: string;
  updatedAt: number;
}

export interface EventProcessorState {
  sessionId?: string;
  sessionStatus?: 'active' | 'completed' | 'failed' | 'interrupted';
  leader: {
    statusKind: NormalizedLeaderStatusKind;
    statusText: string;
    busy: boolean;
    phase?: string;
    route?: string;
    controlMode?: 'manual' | 'eternal';
    queueLength: number;
    text: string;
    thinking: string;
    toolCalls: Record<string, ProcessedToolCall>;
    updatedAt?: number;
  };
  agents: Record<string, ProcessedAgentState>;
  tasks: Record<string, ProcessedTaskState>;
  runtime?: unknown;
  notifications: unknown[];
  lastEvent?: {
    type: EventType;
    timestamp: number;
  };
}

export function createEventProcessorState(seed: Partial<EventProcessorState> = {}): EventProcessorState {
  return {
    sessionId: seed.sessionId,
    sessionStatus: seed.sessionStatus,
    leader: {
      statusKind: seed.leader?.statusKind ?? 'idle',
      statusText: seed.leader?.statusText ?? '',
      busy: seed.leader?.busy ?? false,
      phase: seed.leader?.phase,
      route: seed.leader?.route,
      controlMode: seed.leader?.controlMode,
      queueLength: seed.leader?.queueLength ?? 0,
      text: seed.leader?.text ?? '',
      thinking: seed.leader?.thinking ?? '',
      toolCalls: seed.leader?.toolCalls ?? {},
      updatedAt: seed.leader?.updatedAt,
    },
    agents: seed.agents ?? {},
    tasks: seed.tasks ?? {},
    runtime: seed.runtime,
    notifications: seed.notifications ?? [],
    lastEvent: seed.lastEvent,
  };
}

const AGENT_EVENT_TYPES: ReadonlySet<EventType> = new Set([
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
  'agent:crashed',
  'agent:intervention',
]);

const PERMISSION_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'permission:request',
  'permission:resolved',
]);

export function taskActionForEvent(type: EventType): string | undefined {
  switch (type) {
    case 'task:created': return 'created';
    case 'task:updated': return 'updated';
    case 'task:assigned': return 'assigned';
    case 'task:completed': return 'completed';
    case 'task:failed': return 'failed';
    case 'task:cancelled': return 'cancelled';
    case 'task:deleted': return 'deleted';
    default: return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function payloadForEnvelope(envelope: EventEnvelope): Record<string, unknown> {
  return canonicalizeEventPayloadRecord(envelope.type, asRecord(envelope.payload));
}

export function canonicalizeEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return canonicalizeEventPayloadRecord(type, asRecord(payload)) as EventPayload<T>;
}

function canonicalizeEventPayloadRecord(type: EventType, payload: Record<string, unknown>): Record<string, unknown> {
  if (type === 'leader:status') {
    return {
      ...payload,
      statusKind: payload.statusKind ?? normalizeLeaderStatusKind(payload.status),
    };
  }
  if (type === 'orchestration:run_state') {
    const status = normalizeRunStatus(payload.status);
    return {
      ...payload,
      status,
      busy: payload.busy ?? (status === 'planning' || status === 'running' || status === 'blocked'),
    };
  }
  if (type === 'session:completed') {
    return { ...payload, status: payload.status ?? 'completed' };
  }
  if (type === 'session:failed') {
    return { ...payload, status: payload.status ?? 'failed' };
  }
  if (type === 'session:interrupted') {
    return {
      ...payload,
      status: payload.status ?? 'interrupted',
      statusKind: payload.statusKind ?? 'interrupted',
    };
  }
  if (type.startsWith('task:')) {
    return {
      ...payload,
      action: payload.action ?? taskActionForEvent(type),
      task: payload.task ?? payload,
    };
  }
  if (!AGENT_EVENT_TYPES.has(type)) return payload;
  return payload;
}

function taskIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const task = asRecord(payload.task);
  return stringValue(task.id) ?? stringValue(payload.taskId) ?? stringValue(payload.id);
}

function agentIdFromPayload(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.agentId) ?? stringValue(payload.id);
}

function callIdFromPayload(payload: Record<string, unknown>): string {
  return stringValue(payload.callId)
    ?? stringValue(payload.id)
    ?? `${stringValue(payload.tool) ?? 'tool'}:${numberValue(payload.index) ?? 0}`;
}

function updateToolCall(
  calls: Record<string, ProcessedToolCall>,
  payload: Record<string, unknown>,
  status: ProcessedToolCall['status'],
  timestamp: number,
): Record<string, ProcessedToolCall> {
  const id = callIdFromPayload(payload);
  const previous = calls[id];
  const partial = typeof payload.partialJson === 'string' ? payload.partialJson : '';
  const previousInput = typeof previous?.input === 'string' ? previous.input : '';
  return {
    ...calls,
    [id]: {
      id,
      tool: stringValue(payload.tool) ?? previous?.tool,
      input: status === 'streaming_input' ? `${previousInput}${partial}` : payload.input ?? previous?.input,
      result: payload.result ?? previous?.result,
      status,
      updatedAt: timestamp,
    },
  };
}

function upsertAgent(
  state: EventProcessorState,
  payload: Record<string, unknown>,
  status: NormalizedAgentStatus,
  timestamp: number,
): EventProcessorState {
  const agentId = agentIdFromPayload(payload);
  if (!agentId) return state;
  const previous = state.agents[agentId];
  const agentName = stringValue(payload.agentName) ?? previous?.agentName ?? 'Agent';
  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: {
        agentId,
        agentName,
        role: stringValue(payload.role) ?? previous?.role,
        taskId: stringValue(payload.taskId) ?? previous?.taskId,
        status: previous ? mergeAgentStatus(previous.status, status) : status,
        progress: payload.progress ?? previous?.progress,
        summary: stringValue(payload.message) ?? stringValue(payload.summary) ?? previous?.summary,
        backend: payload.backend ?? previous?.backend,
        externalSessionId: payload.externalSessionId ?? previous?.externalSessionId,
        pid: payload.pid ?? previous?.pid,
        logPath: payload.logPath ?? previous?.logPath,
        error: stringValue(payload.error) ?? stringValue(payload.reason) ?? previous?.error,
        text: previous?.text ?? '',
        thinking: previous?.thinking ?? '',
        toolCalls: previous?.toolCalls ?? {},
        updatedAt: timestamp,
      },
    },
  };
}

function updateAgentStream(
  state: EventProcessorState,
  payload: Record<string, unknown>,
  field: 'text' | 'thinking',
  timestamp: number,
): EventProcessorState {
  const agentId = agentIdFromPayload(payload);
  if (!agentId) return state;
  const previous = state.agents[agentId] ?? {
    agentId,
    agentName: stringValue(payload.agentName) ?? 'Agent',
    status: 'running' as NormalizedAgentStatus,
    text: '',
    thinking: '',
    toolCalls: {},
    updatedAt: timestamp,
  };
  const chunk = String(payload.chunk ?? '');
  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: {
        ...previous,
        [field]: `${previous[field]}${chunk}`,
        updatedAt: timestamp,
      },
    },
  };
}

export function eventPayloadToEnvelope<T extends EventType>(
  type: T,
  payload: unknown,
  sessionIdHint = '',
  options: EventEnvelopeOptions = {},
): EventEnvelope<T> {
  const record = canonicalizeEventPayloadRecord(type, asRecord(payload));
  const sessionId = stringValue(record.sessionId)
    ?? stringValue(asRecord(record.task).session_id)
    ?? sessionIdHint;
  const timestamp = options.timestamp ?? numberValue(record.timestamp) ?? numberValue(record.createdAt) ?? Date.now();
  const sequence = options.sequence ?? nextEventSequence();
  const envelope: EventEnvelope<T> = {
    schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION,
    type,
    eventId: options.eventId ?? createEventId(type, sequence, timestamp),
    sequence,
    source: options.source ?? 'event-emitter',
    method: options.method,
    sessionId,
    timestamp,
    payload: record as EventPayloadBase as EventEnvelope<T>['payload'],
  };
  return envelope;
}

export function processEvent(envelope: EventEnvelope, state: EventProcessorState = createEventProcessorState()): EventProcessorState {
  const payload = payloadForEnvelope(envelope);
  const timestamp = envelope.timestamp || Date.now();
  let next: EventProcessorState = {
    ...state,
    sessionId: envelope.sessionId || state.sessionId,
    lastEvent: { type: envelope.type, timestamp },
  };

  switch (envelope.type) {
    case 'leader:text':
    case 'leader:text_chunk':
      next = {
        ...next,
        leader: {
          ...next.leader,
          statusKind: 'active',
          busy: true,
          text: `${next.leader.text}${String(payload.chunk ?? '')}`,
          updatedAt: timestamp,
        },
      };
      break;
    case 'leader:thinking_chunk':
      next = {
        ...next,
        leader: {
          ...next.leader,
          statusKind: 'active',
          busy: true,
          thinking: `${next.leader.thinking}${String(payload.chunk ?? '')}`,
          updatedAt: timestamp,
        },
      };
      break;
    case 'leader:tool_call':
      next = {
        ...next,
        leader: {
          ...next.leader,
          statusKind: 'active',
          busy: true,
          toolCalls: updateToolCall(next.leader.toolCalls, payload, 'running', timestamp),
          updatedAt: timestamp,
        },
      };
      break;
    case 'leader:tool_call_delta':
      next = {
        ...next,
        leader: {
          ...next.leader,
          statusKind: 'active',
          busy: true,
          toolCalls: updateToolCall(next.leader.toolCalls, payload, 'streaming_input', timestamp),
          updatedAt: timestamp,
        },
      };
      break;
    case 'leader:tool_result':
      next = {
        ...next,
        leader: {
          ...next.leader,
          toolCalls: updateToolCall(next.leader.toolCalls, payload, payload.error ? 'failed' : 'completed', timestamp),
          updatedAt: timestamp,
        },
      };
      break;
    case 'leader:status': {
      const status = stringValue(payload.status) ?? '';
      next = {
        ...next,
        leader: {
          ...next.leader,
          statusText: status,
          statusKind: normalizeLeaderStatusKind(status),
          busy: normalizeLeaderStatusKind(status) === 'active',
          updatedAt: timestamp,
        },
      };
      break;
    }
    case 'leader:busy': {
      const busy = payload.isBusy === true || payload.busy === true;
      next = {
        ...next,
        leader: {
          ...next.leader,
          busy,
          statusKind: busy ? 'active' : next.leader.statusKind,
          queueLength: numberValue(payload.queueLength) ?? next.leader.queueLength,
          updatedAt: timestamp,
        },
      };
      break;
    }
    case 'leader:phase_change':
      next = { ...next, leader: { ...next.leader, phase: stringValue(payload.phase), updatedAt: timestamp } };
      break;
    case 'leader:route':
      next = { ...next, leader: { ...next.leader, route: stringValue(payload.mode) ?? stringValue(payload.reason), updatedAt: timestamp } };
      break;
    case 'leader:control_mode_changed': {
      const mode = payload.mode === 'manual' || payload.mode === 'eternal' ? payload.mode : undefined;
      next = { ...next, leader: { ...next.leader, controlMode: mode, updatedAt: timestamp } };
      break;
    }
    case 'leader:message_queued':
    case 'leader:message_dequeued':
      next = {
        ...next,
        leader: {
          ...next.leader,
          queueLength: Math.max(0, numberValue(payload.queueLength) ?? next.leader.queueLength),
          updatedAt: timestamp,
        },
      };
      break;
    case 'agent:spawned':
    case 'agent:started':
      next = upsertAgent(next, payload, 'running', timestamp);
      break;
    case 'agent:completed':
      next = upsertAgent(next, payload, 'completed', timestamp);
      break;
    case 'agent:terminated':
      next = upsertAgent(next, payload, 'interrupted', timestamp);
      break;
    case 'agent:failed':
    case 'agent:crashed':
      next = upsertAgent(next, payload, 'failed', timestamp);
      break;
    case 'agent:status': {
      const status = normalizeAgentStatus(payload.status);
      next = upsertAgent(next, payload, status, timestamp);
      break;
    }
    case 'agent:heartbeat':
    case 'agent:interactive_state': {
      const status = payload.status ? normalizeAgentStatus(payload.status) : runtimeImpliesBusy(payload) ? 'running' : 'idle';
      next = upsertAgent(next, payload, status, timestamp);
      break;
    }
    case 'agent:progress':
      next = upsertAgent(next, payload, 'running', timestamp);
      break;
    case 'agent:text':
    case 'agent:text_chunk':
      next = updateAgentStream(next, payload, 'text', timestamp);
      break;
    case 'agent:thinking_chunk':
      next = updateAgentStream(next, payload, 'thinking', timestamp);
      break;
    case 'agent:tool_call':
    case 'agent:tool_call_delta':
    case 'agent:tool_result': {
      const agentId = agentIdFromPayload(payload);
      if (!agentId) break;
      const previous = next.agents[agentId] ?? {
        agentId,
        agentName: stringValue(payload.agentName) ?? 'Agent',
        status: 'running' as NormalizedAgentStatus,
        text: '',
        thinking: '',
        toolCalls: {},
        updatedAt: timestamp,
      };
      const status = envelope.type === 'agent:tool_result'
        ? (payload.error || payload.isError ? 'failed' : 'completed')
        : envelope.type === 'agent:tool_call_delta'
          ? 'streaming_input'
          : 'running';
      next = {
        ...next,
        agents: {
          ...next.agents,
          [agentId]: {
            ...previous,
            status: mergeAgentStatus(previous.status, 'running'),
            toolCalls: updateToolCall(previous.toolCalls, payload, status, timestamp),
            updatedAt: timestamp,
          },
        },
      };
      break;
    }
    case 'task:created':
    case 'task:updated':
    case 'task:assigned':
    case 'task:completed':
    case 'task:failed':
    case 'task:cancelled':
    case 'task:deleted': {
      const taskId = taskIdFromPayload(payload);
      if (!taskId) break;
      const task = asRecord(payload.task);
      next = {
        ...next,
        tasks: {
          ...next.tasks,
          [taskId]: {
            taskId,
            task: payload.task,
            status: stringValue(task.status) ?? stringValue(payload.status),
            action: taskActionForEvent(envelope.type),
            assignedAgent: stringValue(payload.agentId) ?? stringValue(task.assigned_agent),
            updatedAt: timestamp,
          },
        },
      };
      break;
    }
    case 'session:completed':
      next = { ...next, sessionStatus: 'completed', leader: { ...next.leader, busy: false, statusKind: 'completed', updatedAt: timestamp } };
      break;
    case 'session:failed':
      next = { ...next, sessionStatus: 'failed', leader: { ...next.leader, busy: false, statusKind: 'interrupted', updatedAt: timestamp } };
      break;
    case 'session:interrupted':
      next = { ...next, sessionStatus: 'interrupted', leader: { ...next.leader, busy: false, statusKind: 'interrupted', updatedAt: timestamp } };
      break;
    case 'session:runtime_state':
      next = {
        ...next,
        runtime: payload,
        leader: {
          ...next.leader,
          busy: runtimeImpliesBusy(payload),
          statusKind: runtimeImpliesBusy(payload) ? 'active' : next.leader.statusKind,
          updatedAt: timestamp,
        },
      };
      break;
    case 'orchestration:run_state': {
      const status: NormalizedRunStatus = normalizeRunStatus(payload.status);
      next = {
        ...next,
        leader: {
          ...next.leader,
          busy: status === 'running' || status === 'planning' || status === 'blocked',
          statusText: stringValue(payload.summary) ?? next.leader.statusText,
          updatedAt: timestamp,
        },
      };
      break;
    }
    case 'notification:new':
      next = { ...next, notifications: [...next.notifications, payload] };
      break;
    default:
      break;
  }

  return next;
}

export function eventPayloadToSessionUpdateMessage<T extends EventType>(
  type: T,
  payload: unknown,
  sessionIdHint = '',
  options: EventEnvelopeOptions = {},
): WrappedSessionUpdate<T> | null {
  const envelope = eventPayloadToEnvelope(type, payload, sessionIdHint, {
    ...options,
    method: options.method ?? SESSION_UPDATE_METHOD,
  });
  if (!envelope.sessionId) return null;
  return {
    envelope,
    message: {
      method: SESSION_UPDATE_METHOD,
      params: {
        sessionId: envelope.sessionId,
        update: envelope,
      },
    },
  };
}

export function extractCanonicalEventEnvelope(data: unknown): EventEnvelope | null {
  const input = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const params = input.params && typeof input.params === 'object'
    ? input.params as Record<string, unknown>
    : {};
  const envelope = parseEventEnvelope(params.update)
    ?? parseEventEnvelope(data);
  if (!envelope) return null;
  const method = typeof envelope.method === 'string'
    ? envelope.method
    : typeof input.method === 'string'
      ? input.method
      : undefined;
  const canonicalPayload = canonicalizeEventPayloadRecord(envelope.type, asRecord(envelope.payload));
  const canonicalEnvelope = {
    ...envelope,
    payload: canonicalPayload as EventEnvelope['payload'],
  };
  const withMethod = method ? { ...canonicalEnvelope, method } : canonicalEnvelope;
  if (withMethod.sessionId) return withMethod;
  const payload = asRecord(withMethod.payload);
  const sessionIdHint = stringValue(input.sessionId)
    ?? stringValue(params.sessionId)
    ?? stringValue(payload.sessionId)
    ?? stringValue(asRecord(payload.task).session_id);
  return sessionIdHint ? { ...withMethod, sessionId: sessionIdHint } : withMethod;
}
