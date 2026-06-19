export type { WorkflowState } from './Status.js';

export type WorkflowNodeStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'paused'
  | 'cancelled';

export type WorkflowExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';

export type WorkflowUiLogType =
  | 'info'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'error'
  | 'thinking';

export interface WorkflowCanvasPosition {
  x: number;
  y: number;
}

export interface WorkflowCanvasNodeData {
  label?: string;
  type?: string;
  status?: WorkflowNodeStatus | string;
  description?: string;
  config?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startTime?: number;
  endTime?: number;
  [key: string]: unknown;
}

export interface WorkflowCanvasNode<TData extends WorkflowCanvasNodeData = WorkflowCanvasNodeData> {
  id: string;
  type?: string;
  position: WorkflowCanvasPosition;
  data: TData;
  selected?: boolean;
  dragging?: boolean;
  [key: string]: unknown;
}

export interface WorkflowCanvasEdge<TData extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: TData;
  style?: Record<string, unknown>;
  selected?: boolean;
  [key: string]: unknown;
}

export interface WorkflowDefinitionProjection<
  TNode extends WorkflowCanvasNode = WorkflowCanvasNode,
  TEdge extends WorkflowCanvasEdge = WorkflowCanvasEdge,
> {
  id: string;
  name?: string;
  description?: string | null;
  version?: string;
  nodes?: TNode[];
  edges?: TEdge[];
  config?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  tags?: string[] | null;
  [key: string]: unknown;
}

export interface WorkflowExecutionLog {
  timestamp: number;
  type: WorkflowUiLogType;
  content: string;
  tool?: string;
}

export interface WorkflowEngineLog {
  timestamp?: number;
  level?: 'info' | 'warn' | 'error' | 'debug' | string;
  uiType?: WorkflowUiLogType;
  tool?: string;
  content?: string;
  nodeId?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface WorkflowNodeExecutionProjection {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  status: Extract<WorkflowNodeStatus, 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'>;
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  logs: WorkflowExecutionLog[];
}

export interface WorkflowExecutionProjection {
  executionId: string;
  workflowId?: string;
  status: WorkflowExecutionStatus;
  startTime: number;
  endTime?: number;
  currentNodeId?: string;
  progress?: {
    completedNodes: number;
    totalNodes: number;
    percentage: number;
  };
  logs: WorkflowEngineLog[];
  output?: unknown;
  error?: string;
}

export interface WorkflowProjectionState<
  TNode extends WorkflowCanvasNode = WorkflowCanvasNode,
  TEdge extends WorkflowCanvasEdge = WorkflowCanvasEdge,
> {
  currentWorkflowId: string | null;
  nodes: TNode[];
  edges: TEdge[];
  currentExecutionId: string | null;
  isExecuting: boolean;
  showExecPanel: boolean;
  executions: WorkflowNodeExecutionProjection[];
  executionStates: Record<string, WorkflowExecutionProjection>;
}

export type WorkflowMutationEventName =
  | 'workflow:created'
  | 'workflow:updated'
  | 'workflow:deleted'
  | 'workflow:node_added'
  | 'workflow:node_updated'
  | 'workflow:node_deleted'
  | 'workflow:edge_added'
  | 'workflow:edge_updated'
  | 'workflow:edge_deleted';

export type WorkflowNodeEventName =
  | 'workflow:node_started'
  | 'workflow:node_completed'
  | 'workflow:node_failed'
  | 'workflow:node_retrying'
  | 'workflow:node_skipped';

export type WorkflowExecutionEventName =
  | 'workflow:execution_started'
  | 'workflow:execution_completed'
  | 'workflow:execution_failed'
  | 'workflow:execution_cancelled'
  | 'workflow:execution_paused'
  | 'workflow:execution_resumed'
  | 'workflow:execution_progress';

export type WorkflowRealtimeEventName =
  | WorkflowMutationEventName
  | WorkflowNodeEventName
  | WorkflowExecutionEventName;

export const WORKFLOW_REALTIME_EVENT_NAMES = [
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
  'workflow:execution_cancelled',
  'workflow:execution_paused',
  'workflow:execution_resumed',
  'workflow:execution_progress',
  'workflow:execution_completed',
  'workflow:execution_failed',
] as const satisfies readonly WorkflowRealtimeEventName[];

interface WorkflowEventBase<TType extends WorkflowRealtimeEventName> {
  type: TType;
  workflowId?: string;
  sessionId?: string;
  receivedAt?: number;
}

export interface WorkflowCreatedProjectionEvent extends WorkflowEventBase<'workflow:created'> {
  workflowId: string;
  workflow?: WorkflowDefinitionProjection;
}

export interface WorkflowUpdatedProjectionEvent extends WorkflowEventBase<'workflow:updated'> {
  workflowId: string;
  workflow?: WorkflowDefinitionProjection;
  updates?: Record<string, unknown>;
}

export interface WorkflowDeletedProjectionEvent extends WorkflowEventBase<'workflow:deleted'> {
  workflowId: string;
}

export interface WorkflowNodeAddedProjectionEvent extends WorkflowEventBase<'workflow:node_added'> {
  workflowId: string;
  node: WorkflowCanvasNode;
}

export interface WorkflowNodeUpdatedProjectionEvent extends WorkflowEventBase<'workflow:node_updated'> {
  workflowId: string;
  nodeId: string;
  node?: WorkflowCanvasNode;
  updates?: Partial<WorkflowCanvasNode>;
}

export interface WorkflowNodeDeletedProjectionEvent extends WorkflowEventBase<'workflow:node_deleted'> {
  workflowId: string;
  nodeId: string;
}

export interface WorkflowEdgeAddedProjectionEvent extends WorkflowEventBase<'workflow:edge_added'> {
  workflowId: string;
  edge: WorkflowCanvasEdge;
}

export interface WorkflowEdgeUpdatedProjectionEvent extends WorkflowEventBase<'workflow:edge_updated'> {
  workflowId: string;
  edgeId: string;
  edge?: WorkflowCanvasEdge;
  updates?: Partial<WorkflowCanvasEdge>;
}

export interface WorkflowEdgeDeletedProjectionEvent extends WorkflowEventBase<'workflow:edge_deleted'> {
  workflowId: string;
  edgeId: string;
}

export interface WorkflowExecutionStartedProjectionEvent extends WorkflowEventBase<'workflow:execution_started'> {
  executionId: string;
  workflowId?: string;
  startTime?: number;
  nodeCount?: number;
  summaryLabel?: string;
}

export interface WorkflowNodeStartedProjectionEvent extends WorkflowEventBase<'workflow:node_started'> {
  executionId: string;
  workflowId?: string;
  nodeId: string;
  startTime?: number;
}

export interface WorkflowNodeCompletedProjectionEvent extends WorkflowEventBase<'workflow:node_completed'> {
  executionId: string;
  workflowId?: string;
  nodeId: string;
  result?: unknown;
  duration?: number;
  startTime?: number;
  endTime?: number;
}

export interface WorkflowNodeFailedProjectionEvent extends WorkflowEventBase<'workflow:node_failed'> {
  executionId: string;
  workflowId?: string;
  nodeId: string;
  error?: string;
  startTime?: number;
  endTime?: number;
  duration?: number;
  reason?: string;
}

export interface WorkflowNodeRetryingProjectionEvent extends WorkflowEventBase<'workflow:node_retrying'> {
  executionId: string;
  workflowId?: string;
  nodeId: string;
  attempt?: number;
}

export interface WorkflowNodeSkippedProjectionEvent extends WorkflowEventBase<'workflow:node_skipped'> {
  executionId: string;
  workflowId?: string;
  nodeId: string;
  reason?: string;
  startTime?: number;
  endTime?: number;
}

export interface WorkflowExecutionCompletedProjectionEvent extends WorkflowEventBase<'workflow:execution_completed'> {
  executionId: string;
  workflowId?: string;
  output?: unknown;
  endTime?: number;
}

export interface WorkflowExecutionFailedProjectionEvent extends WorkflowEventBase<'workflow:execution_failed'> {
  executionId: string;
  workflowId?: string;
  error?: string;
  endTime?: number;
  reason?: string;
  timeoutMs?: number;
}

export interface WorkflowExecutionCancelledProjectionEvent extends WorkflowEventBase<'workflow:execution_cancelled'> {
  executionId: string;
  workflowId?: string;
  error?: string;
  endTime?: number;
  reason?: string;
}

export interface WorkflowExecutionPausedProjectionEvent extends WorkflowEventBase<'workflow:execution_paused'> {
  executionId: string;
  workflowId?: string;
}

export interface WorkflowExecutionResumedProjectionEvent extends WorkflowEventBase<'workflow:execution_resumed'> {
  executionId: string;
  workflowId?: string;
}

export interface WorkflowExecutionProgressProjectionEvent extends WorkflowEventBase<'workflow:execution_progress'> {
  executionId: string;
  workflowId?: string;
  nodeId?: string;
  log?: WorkflowEngineLog;
}

export type WorkflowProjectionEvent =
  | WorkflowCreatedProjectionEvent
  | WorkflowUpdatedProjectionEvent
  | WorkflowDeletedProjectionEvent
  | WorkflowNodeAddedProjectionEvent
  | WorkflowNodeUpdatedProjectionEvent
  | WorkflowNodeDeletedProjectionEvent
  | WorkflowEdgeAddedProjectionEvent
  | WorkflowEdgeUpdatedProjectionEvent
  | WorkflowEdgeDeletedProjectionEvent
  | WorkflowExecutionStartedProjectionEvent
  | WorkflowNodeStartedProjectionEvent
  | WorkflowNodeCompletedProjectionEvent
  | WorkflowNodeFailedProjectionEvent
  | WorkflowNodeRetryingProjectionEvent
  | WorkflowNodeSkippedProjectionEvent
  | WorkflowExecutionCompletedProjectionEvent
  | WorkflowExecutionFailedProjectionEvent
  | WorkflowExecutionCancelledProjectionEvent
  | WorkflowExecutionPausedProjectionEvent
  | WorkflowExecutionResumedProjectionEvent
  | WorkflowExecutionProgressProjectionEvent;

export interface WorkflowProjectionMessages {
  nodeStarted?: (label: string) => string;
  nodeCompleted?: (durationText?: string) => string;
  nodeFailed?: string;
  nodeSkipped?: string;
  workflowStarted?: (executionId: string) => string;
  workflowCompleted?: string;
  workflowFailed?: string;
  workflowCancelled?: string;
}

export interface WorkflowProjectionReduceOptions<
  TNode extends WorkflowCanvasNode = WorkflowCanvasNode,
  TEdge extends WorkflowCanvasEdge = WorkflowCanvasEdge,
> {
  now?: number;
  defaultNodes?: TNode[];
  defaultEdges?: TEdge[];
  preserveNodeId?: string | null;
  summaryLabel?: string;
  messages?: WorkflowProjectionMessages;
}

export interface WorkflowDirectorySummaryProjection {
  id: string;
  name: string;
  description: string | null;
  workspace: string | null;
  nodeCount?: number;
  edgeCount?: number;
  scheduleTriggerCount?: number;
  tags?: string[] | null;
  createdAt?: number;
  updatedAt: number;
}

export interface WorkflowDirectoryProjectionState {
  workflows: WorkflowDirectorySummaryProjection[];
  currentWorkflowId: string | null;
}

const EMPTY_NODES: WorkflowCanvasNode[] = [];
const EMPTY_EDGES: WorkflowCanvasEdge[] = [];

export function createWorkflowProjectionState<
  TNode extends WorkflowCanvasNode = WorkflowCanvasNode,
  TEdge extends WorkflowCanvasEdge = WorkflowCanvasEdge,
>(initial?: Partial<WorkflowProjectionState<TNode, TEdge>>): WorkflowProjectionState<TNode, TEdge> {
  return {
    currentWorkflowId: initial?.currentWorkflowId ?? null,
    nodes: initial?.nodes ?? [],
    edges: initial?.edges ?? [],
    currentExecutionId: initial?.currentExecutionId ?? null,
    isExecuting: initial?.isExecuting ?? false,
    showExecPanel: initial?.showExecPanel ?? false,
    executions: initial?.executions ?? [],
    executionStates: initial?.executionStates ?? {},
  };
}

export function normalizeWorkflowRealtimeEvent(
  type: WorkflowRealtimeEventName,
  payload: unknown,
): WorkflowProjectionEvent | null {
  const data = workflowRealtimePayload(payload);
  const workflowId = stringValue(data.workflowId);
  const executionId = stringValue(data.executionId);
  const receivedAt = Date.now();

  switch (type) {
    case 'workflow:created':
      if (!workflowId) return null;
      return { type, workflowId, workflow: workflowProjection(data.workflow), sessionId: stringValue(data.sessionId), receivedAt };
    case 'workflow:updated':
      if (!workflowId) return null;
      return { type, workflowId, workflow: workflowProjection(data.workflow), updates: recordValue(data.updates), sessionId: stringValue(data.sessionId), receivedAt };
    case 'workflow:deleted':
      if (!workflowId) return null;
      return { type, workflowId, sessionId: stringValue(data.sessionId), receivedAt };
    case 'workflow:node_added':
      if (!workflowId) return null;
      {
        const node = workflowNode(data.node);
        return node ? { type, workflowId, node, sessionId: stringValue(data.sessionId), receivedAt } : null;
      }
    case 'workflow:node_updated': {
      const nodeId = stringValue(data.nodeId);
      if (!workflowId || !nodeId) return null;
      const node = workflowNode(data.node);
      return { type, workflowId, nodeId, node, updates: recordValue(data.updates) as Partial<WorkflowCanvasNode> | undefined, sessionId: stringValue(data.sessionId), receivedAt };
    }
    case 'workflow:node_deleted': {
      const nodeId = stringValue(data.nodeId);
      return workflowId && nodeId ? { type, workflowId, nodeId, sessionId: stringValue(data.sessionId), receivedAt } : null;
    }
    case 'workflow:edge_added':
      if (!workflowId) return null;
      {
        const edge = workflowEdge(data.edge);
        return edge ? { type, workflowId, edge, sessionId: stringValue(data.sessionId), receivedAt } : null;
      }
    case 'workflow:edge_updated': {
      const edgeId = stringValue(data.edgeId);
      if (!workflowId || !edgeId) return null;
      const edge = workflowEdge(data.edge);
      return { type, workflowId, edgeId, edge, updates: recordValue(data.updates) as Partial<WorkflowCanvasEdge> | undefined, sessionId: stringValue(data.sessionId), receivedAt };
    }
    case 'workflow:edge_deleted': {
      const edgeId = stringValue(data.edgeId);
      return workflowId && edgeId ? { type, workflowId, edgeId, sessionId: stringValue(data.sessionId), receivedAt } : null;
    }
    case 'workflow:execution_started':
      return executionId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        startTime: numberValue(data.startTime),
        nodeCount: numberValue(data.nodeCount),
        summaryLabel: stringValue(data.summaryLabel),
        receivedAt,
      } : null;
    case 'workflow:node_started': {
      const nodeId = stringValue(data.nodeId);
      return executionId && nodeId ? { type, executionId, workflowId, sessionId: stringValue(data.sessionId), nodeId, startTime: numberValue(data.startTime), receivedAt } : null;
    }
    case 'workflow:node_completed': {
      const nodeId = stringValue(data.nodeId);
      return executionId && nodeId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        nodeId,
        result: data.result,
        duration: numberValue(data.duration),
        startTime: numberValue(data.startTime),
        endTime: numberValue(data.endTime),
        receivedAt,
      } : null;
    }
    case 'workflow:node_failed': {
      const nodeId = stringValue(data.nodeId);
      return executionId && nodeId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        nodeId,
        error: stringValue(data.error),
        startTime: numberValue(data.startTime),
        endTime: numberValue(data.endTime),
        duration: numberValue(data.duration),
        reason: stringValue(data.reason),
        receivedAt,
      } : null;
    }
    case 'workflow:node_retrying': {
      const nodeId = stringValue(data.nodeId);
      return executionId && nodeId ? { type, executionId, workflowId, sessionId: stringValue(data.sessionId), nodeId, attempt: numberValue(data.attempt), receivedAt } : null;
    }
    case 'workflow:node_skipped': {
      const nodeId = stringValue(data.nodeId);
      return executionId && nodeId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        nodeId,
        reason: stringValue(data.reason),
        startTime: numberValue(data.startTime),
        endTime: numberValue(data.endTime),
        receivedAt,
      } : null;
    }
    case 'workflow:execution_completed':
      return executionId ? { type, executionId, workflowId, sessionId: stringValue(data.sessionId), output: data.output, endTime: numberValue(data.endTime), receivedAt } : null;
    case 'workflow:execution_failed':
      return executionId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        timeoutMs: numberValue(data.timeoutMs),
        error: stringValue(data.error),
        endTime: numberValue(data.endTime),
        reason: stringValue(data.reason),
        receivedAt,
      } : null;
    case 'workflow:execution_cancelled':
      return executionId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        error: stringValue(data.error),
        endTime: numberValue(data.endTime),
        reason: stringValue(data.reason),
        receivedAt,
      } : null;
    case 'workflow:execution_paused':
      return executionId ? { type, executionId, workflowId, sessionId: stringValue(data.sessionId), receivedAt } : null;
    case 'workflow:execution_resumed':
      return executionId ? { type, executionId, workflowId, sessionId: stringValue(data.sessionId), receivedAt } : null;
    case 'workflow:execution_progress':
      return executionId ? {
        type,
        executionId,
        workflowId,
        sessionId: stringValue(data.sessionId),
        nodeId: stringValue(data.nodeId),
        log: engineLog(data.log),
        receivedAt,
      } : null;
  }
  return null;
}

export function reduceWorkflowProjection<
  TNode extends WorkflowCanvasNode = WorkflowCanvasNode,
  TEdge extends WorkflowCanvasEdge = WorkflowCanvasEdge,
>(
  state: WorkflowProjectionState<TNode, TEdge>,
  event: WorkflowProjectionEvent,
  options: WorkflowProjectionReduceOptions<TNode, TEdge> = {},
): WorkflowProjectionState<TNode, TEdge> {
  const now = options.now ?? event.receivedAt ?? Date.now();
  const defaultNodes = options.defaultNodes ?? ([] as TNode[]);
  const defaultEdges = options.defaultEdges ?? ([] as TEdge[]);
  const messages = options.messages ?? {};

  switch (event.type) {
    case 'workflow:created':
      return {
        ...state,
        currentWorkflowId: event.workflowId,
        nodes: workflowNodes(event.workflow, defaultNodes),
        edges: workflowEdges(event.workflow, defaultEdges),
      };
    case 'workflow:updated':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return {
        ...state,
        nodes: event.workflow?.nodes
          ? preserveNode(workflowNodes(event.workflow, state.nodes), state.nodes, options.preserveNodeId)
          : state.nodes,
        edges: event.workflow?.edges ? workflowEdges(event.workflow, state.edges) : state.edges,
      };
    case 'workflow:deleted':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return {
        ...state,
        currentWorkflowId: null,
        nodes: defaultNodes,
        edges: defaultEdges,
      };
    case 'workflow:node_added':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return state.nodes.some((node) => node.id === event.node.id)
        ? state
        : { ...state, nodes: [...state.nodes, event.node as TNode] };
    case 'workflow:node_updated':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return {
        ...state,
        nodes: state.nodes.map((node) => {
          if (node.id !== event.nodeId) return node;
          if (event.node) return event.node as TNode;
          return mergeNode(node, event.updates);
        }),
      };
    case 'workflow:node_deleted':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return {
        ...state,
        nodes: state.nodes.filter((node) => node.id !== event.nodeId),
        edges: state.edges.filter((edge) => edge.source !== event.nodeId && edge.target !== event.nodeId),
      };
    case 'workflow:edge_added':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return state.edges.some((edge) => edge.id === event.edge.id)
        ? state
        : { ...state, edges: [...state.edges, event.edge as TEdge] };
    case 'workflow:edge_updated':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return {
        ...state,
        edges: state.edges.map((edge) => {
          if (edge.id !== event.edgeId) return edge;
          if (event.edge) return event.edge as TEdge;
          return { ...edge, ...(event.updates ?? {}) } as TEdge;
        }),
      };
    case 'workflow:edge_deleted':
      if (!isCurrentWorkflow(state, event.workflowId)) return state;
      return {
        ...state,
        edges: state.edges.filter((edge) => edge.id !== event.edgeId),
      };
    case 'workflow:execution_started': {
      const summaryLabel = event.summaryLabel ?? options.summaryLabel ?? 'Workflow';
      const nextExecutionStates = upsertExecutionState(state.executionStates, event.executionId, {
        executionId: event.executionId,
        workflowId: event.workflowId ?? state.currentWorkflowId ?? undefined,
        status: 'running',
        startTime: event.startTime ?? now,
        logs: [],
      });
      return {
        ...state,
        currentExecutionId: event.executionId,
        isExecuting: true,
        showExecPanel: true,
        executionStates: nextExecutionStates,
        executions: upsertNodeExecution(state.executions, {
          nodeId: workflowSummaryNodeId(event.executionId),
          nodeLabel: summaryLabel,
          nodeType: 'workflow',
          status: 'running',
          startedAt: event.startTime ?? now,
          logs: [{ timestamp: now, type: 'info', content: messages.workflowStarted?.(event.executionId) ?? `Workflow started: ${event.executionId}` }],
        }),
      };
    }
    case 'workflow:node_started':
      if (!isCurrentExecution(state, event.executionId)) return state;
      return {
        ...state,
        showExecPanel: true,
        nodes: setNodeExecutionData(state.nodes, event.nodeId, { status: 'running', startTime: event.startTime ?? now }),
        executionStates: upsertExecutionState(state.executionStates, event.executionId, {
          executionId: event.executionId,
          workflowId: event.workflowId ?? state.currentWorkflowId ?? undefined,
          status: 'running',
          startTime: state.executionStates[event.executionId]?.startTime ?? now,
          currentNodeId: event.nodeId,
          logs: state.executionStates[event.executionId]?.logs ?? [],
        }),
        executions: upsertNodeExecution(state.executions, createRunningNodeExecution(state.nodes, event.nodeId, event.startTime ?? now, messages)),
      };
    case 'workflow:node_completed': {
      if (!isCurrentExecution(state, event.executionId)) return state;
      const existing = state.executions.find((execution) => execution.nodeId === event.nodeId);
      const durationText = typeof event.duration === 'number' ? `${(event.duration / 1000).toFixed(2)}s` : undefined;
      return {
        ...state,
        nodes: setNodeExecutionData(state.nodes, event.nodeId, { status: 'completed', result: event.result, endTime: event.endTime ?? now }),
        executions: upsertNodeExecution(state.executions, {
          ...createRunningNodeExecution(state.nodes, event.nodeId, event.startTime ?? existing?.startedAt ?? now, messages),
          ...(existing ?? {}),
          status: 'completed',
          completedAt: event.endTime ?? now,
          startedAt: event.startTime ?? existing?.startedAt ?? now,
          output: stringifyPayload(event.result),
          logs: [
            ...(existing?.logs ?? []),
            { timestamp: now, type: 'info', content: messages.nodeCompleted?.(durationText) ?? (durationText ? `Node completed (${durationText})` : 'Node completed') },
          ],
        }),
      };
    }
    case 'workflow:node_failed': {
      if (!isCurrentExecution(state, event.executionId)) return state;
      const existing = state.executions.find((execution) => execution.nodeId === event.nodeId);
      const error = event.error || messages.nodeFailed || 'Node failed';
      return {
        ...state,
        nodes: setNodeExecutionData(state.nodes, event.nodeId, { status: 'failed', error, endTime: event.endTime ?? now }),
        executions: upsertNodeExecution(state.executions, {
          ...createRunningNodeExecution(state.nodes, event.nodeId, event.startTime ?? existing?.startedAt ?? now, messages),
          ...(existing ?? {}),
          status: 'failed',
          completedAt: event.endTime ?? now,
          error,
          logs: [...(existing?.logs ?? []), { timestamp: now, type: 'error', content: error }],
        }),
      };
    }
    case 'workflow:node_retrying': {
      if (!isCurrentExecution(state, event.executionId)) return state;
      const existing = state.executions.find((execution) => execution.nodeId === event.nodeId);
      return {
        ...state,
        nodes: setNodeExecutionData(state.nodes, event.nodeId, { status: 'running' }),
        executions: upsertNodeExecution(state.executions, {
          ...createRunningNodeExecution(state.nodes, event.nodeId, existing?.startedAt ?? now, messages),
          ...(existing ?? {}),
          status: 'running',
          logs: [...(existing?.logs ?? []), { timestamp: now, type: 'info', content: `retry attempt ${event.attempt ?? '?'}` }],
        }),
      };
    }
    case 'workflow:node_skipped': {
      if (!isCurrentExecution(state, event.executionId)) return state;
      const existing = state.executions.find((execution) => execution.nodeId === event.nodeId);
      return {
        ...state,
        nodes: setNodeExecutionData(state.nodes, event.nodeId, { status: 'skipped', startTime: event.startTime, endTime: event.endTime ?? now }),
        executions: upsertNodeExecution(state.executions, {
          ...createRunningNodeExecution(state.nodes, event.nodeId, event.startTime ?? existing?.startedAt ?? now, messages),
          ...(existing ?? {}),
          status: 'skipped',
          completedAt: event.endTime ?? now,
          logs: [...(existing?.logs ?? []), { timestamp: now, type: 'info', content: event.reason || messages.nodeSkipped || 'skipped by condition branch' }],
        }),
      };
    }
    case 'workflow:execution_progress': {
      if (!isCurrentExecution(state, event.executionId)) return state;
      const executionStates = event.log
        ? upsertExecutionState(state.executionStates, event.executionId, {
          executionId: event.executionId,
          workflowId: event.workflowId ?? state.currentWorkflowId ?? undefined,
          status: state.executionStates[event.executionId]?.status ?? 'running',
          startTime: state.executionStates[event.executionId]?.startTime ?? now,
          logs: [...(state.executionStates[event.executionId]?.logs ?? []), event.log],
          currentNodeId: event.nodeId ?? state.executionStates[event.executionId]?.currentNodeId,
        })
        : state.executionStates;
      if (!event.log || !event.nodeId) return { ...state, executionStates };
      const existing = state.executions.find((execution) => execution.nodeId === event.nodeId);
      if (!existing) return { ...state, executionStates };
      return {
        ...state,
        executionStates,
        executions: upsertNodeExecution(state.executions, {
          ...existing,
          logs: [...existing.logs, engineLogToUiLog(event.log, now)],
        }),
      };
    }
    case 'workflow:execution_completed':
      if (!isCurrentExecution(state, event.executionId)) return state;
      return finishExecution(state, event.executionId, 'completed', {
        now: event.endTime ?? now,
        workflowId: event.workflowId,
        output: event.output,
        logType: 'info',
        logContent: messages.workflowCompleted ?? 'Workflow completed',
      });
    case 'workflow:execution_failed':
      if (!isCurrentExecution(state, event.executionId)) return state;
      return finishExecution(state, event.executionId, 'failed', {
        now: event.endTime ?? now,
        workflowId: event.workflowId,
        error: event.error ?? event.reason ?? messages.workflowFailed ?? 'Workflow failed',
        logType: 'error',
        logContent: event.error ?? event.reason ?? messages.workflowFailed ?? 'Workflow failed',
      });
    case 'workflow:execution_cancelled':
      if (!isCurrentExecution(state, event.executionId)) return state;
      return finishExecution(state, event.executionId, 'cancelled', {
        now: event.endTime ?? now,
        workflowId: event.workflowId,
        error: event.error ?? event.reason ?? messages.workflowCancelled ?? 'Cancelled by user',
        logType: 'error',
        logContent: event.reason ?? messages.workflowCancelled ?? 'Workflow cancelled by user',
      });
    case 'workflow:execution_paused':
      if (!isCurrentExecution(state, event.executionId)) return state;
      return {
        ...state,
        isExecuting: true,
        executionStates: upsertExecutionState(state.executionStates, event.executionId, {
          executionId: event.executionId,
          workflowId: event.workflowId ?? state.currentWorkflowId ?? undefined,
          status: 'paused',
          startTime: state.executionStates[event.executionId]?.startTime ?? now,
          logs: state.executionStates[event.executionId]?.logs ?? [],
        }),
      };
    case 'workflow:execution_resumed':
      if (!isCurrentExecution(state, event.executionId)) return state;
      return {
        ...state,
        isExecuting: true,
        executionStates: upsertExecutionState(state.executionStates, event.executionId, {
          executionId: event.executionId,
          workflowId: event.workflowId ?? state.currentWorkflowId ?? undefined,
          status: 'running',
          startTime: state.executionStates[event.executionId]?.startTime ?? now,
          logs: state.executionStates[event.executionId]?.logs ?? [],
        }),
      };
  }
  return state;
}

export function reduceWorkflowDirectoryProjection(
  state: WorkflowDirectoryProjectionState,
  event: WorkflowProjectionEvent,
): WorkflowDirectoryProjectionState {
  switch (event.type) {
    case 'workflow:created': {
      const summary = summaryFromWorkflow(event.workflow, event.workflowId);
      return {
        currentWorkflowId: event.workflowId,
        workflows: summary
          ? upsertWorkflowSummary(state.workflows, summary)
          : state.workflows,
      };
    }
    case 'workflow:updated': {
      const summary = summaryFromWorkflow(event.workflow, event.workflowId);
      return summary
        ? { ...state, workflows: upsertWorkflowSummary(state.workflows, summary) }
        : state;
    }
    case 'workflow:deleted':
      return {
        currentWorkflowId: state.currentWorkflowId === event.workflowId ? null : state.currentWorkflowId,
        workflows: state.workflows.filter((workflow) => workflow.id !== event.workflowId),
      };
    default:
      return state;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function workflowRealtimePayload(input: unknown): Record<string, unknown> {
  const raw = asRecord(input);
  const rawPayload = asRecord(raw.payload);
  if (typeof raw.type === 'string' && Object.keys(rawPayload).length > 0) {
    const sessionId = stringValue(raw.sessionId) ?? stringValue(rawPayload.sessionId);
    return sessionId ? { ...rawPayload, sessionId } : rawPayload;
  }

  const params = asRecord(raw.params);
  const update = asRecord(params.update);
  const updatePayload = asRecord(update.payload);
  if (typeof update.type === 'string' && Object.keys(updatePayload).length > 0) {
    const sessionId = stringValue(update.sessionId) ?? stringValue(updatePayload.sessionId);
    return sessionId ? { ...updatePayload, sessionId } : updatePayload;
  }

  return Object.keys(params).length > 0 ? params : raw;
}

function isWorkflowUiLogType(value: unknown): value is WorkflowUiLogType {
  return value === 'info'
    || value === 'tool_call'
    || value === 'tool_result'
    || value === 'text'
    || value === 'error'
    || value === 'thinking';
}

function workflowProjection(value: unknown): WorkflowDefinitionProjection | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const id = stringValue(record.id);
  if (!id) return undefined;
  return record as unknown as WorkflowDefinitionProjection;
}

function workflowNode(value: unknown): WorkflowCanvasNode | undefined {
  const record = recordValue(value);
  if (!record || !stringValue(record.id)) return undefined;
  const position = recordValue(record.position);
  return {
    ...record,
    id: stringValue(record.id)!,
    position: {
      x: numberValue(position?.x) ?? 0,
      y: numberValue(position?.y) ?? 0,
    },
    data: recordValue(record.data) as WorkflowCanvasNodeData | undefined ?? {},
  } as WorkflowCanvasNode;
}

function workflowEdge(value: unknown): WorkflowCanvasEdge | undefined {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const source = stringValue(record?.source);
  const target = stringValue(record?.target);
  if (!id || !source || !target) return undefined;
  return record as unknown as WorkflowCanvasEdge;
}

function engineLog(value: unknown): WorkflowEngineLog | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  return record as WorkflowEngineLog;
}

function isCurrentWorkflow(state: WorkflowProjectionState, workflowId?: string): boolean {
  return Boolean(workflowId && state.currentWorkflowId && workflowId === state.currentWorkflowId);
}

function isCurrentExecution(state: WorkflowProjectionState, executionId: string): boolean {
  return state.currentExecutionId === executionId;
}

function workflowNodes<TNode extends WorkflowCanvasNode>(
  workflow: WorkflowDefinitionProjection | undefined,
  fallback: TNode[],
): TNode[] {
  return Array.isArray(workflow?.nodes) ? workflow.nodes as TNode[] : fallback;
}

function workflowEdges<TEdge extends WorkflowCanvasEdge>(
  workflow: WorkflowDefinitionProjection | undefined,
  fallback: TEdge[],
): TEdge[] {
  return Array.isArray(workflow?.edges) ? workflow.edges as TEdge[] : fallback;
}

function preserveNode<TNode extends WorkflowCanvasNode>(
  incoming: TNode[],
  current: TNode[],
  nodeId?: string | null,
): TNode[] {
  if (!nodeId) return incoming;
  const preserved = current.find((node) => node.id === nodeId);
  if (!preserved) return incoming;
  return incoming.map((node) => node.id === nodeId ? preserved : node);
}

function mergeNode<TNode extends WorkflowCanvasNode>(node: TNode, updates?: Partial<WorkflowCanvasNode>): TNode {
  if (!updates) return node;
  const nextData = updates.data && typeof updates.data === 'object'
    ? { ...node.data, ...updates.data }
    : node.data;
  return { ...node, ...updates, data: nextData } as TNode;
}

function setNodeExecutionData<TNode extends WorkflowCanvasNode>(
  nodes: TNode[],
  nodeId: string,
  data: Partial<WorkflowCanvasNodeData>,
): TNode[] {
  return nodes.map((node) => node.id === nodeId
    ? { ...node, data: { ...node.data, ...data } } as TNode
    : node
  );
}

function nodeLabel(nodes: WorkflowCanvasNode[], nodeId: string): string {
  const data = nodes.find((node) => node.id === nodeId)?.data;
  return typeof data?.label === 'string' && data.label.length > 0 ? data.label : nodeId;
}

function nodeType(nodes: WorkflowCanvasNode[], nodeId: string): string {
  const data = nodes.find((node) => node.id === nodeId)?.data;
  return typeof data?.type === 'string' && data.type.length > 0 ? data.type : 'workflow';
}

function createRunningNodeExecution(
  nodes: WorkflowCanvasNode[],
  nodeId: string,
  startedAt: number,
  messages: WorkflowProjectionMessages,
): WorkflowNodeExecutionProjection {
  const label = nodeLabel(nodes, nodeId);
  return {
    nodeId,
    nodeLabel: label,
    nodeType: nodeType(nodes, nodeId),
    status: 'running',
    startedAt,
    logs: [{ timestamp: startedAt, type: 'info', content: messages.nodeStarted?.(label) ?? `Running ${label}` }],
  };
}

function upsertNodeExecution(
  executions: WorkflowNodeExecutionProjection[],
  next: WorkflowNodeExecutionProjection,
): WorkflowNodeExecutionProjection[] {
  const index = executions.findIndex((execution) => execution.nodeId === next.nodeId);
  if (index < 0) return [...executions, next];
  return executions.map((execution, itemIndex) => itemIndex === index ? { ...execution, ...next } : execution);
}

// D7: executionStates 按 executionId(每次 workflow 运行一个)累加,长会话/反复运行下无界增长。
// FIFO oldest-first 封顶:JS 对象键保留插入序,Object.keys 头部即最旧。投影 reducer 是单一增长点。
const MAX_EXECUTION_STATES = 200;

function upsertExecutionState(
  states: Record<string, WorkflowExecutionProjection>,
  executionId: string,
  next: WorkflowExecutionProjection,
): Record<string, WorkflowExecutionProjection> {
  const merged: Record<string, WorkflowExecutionProjection> = {
    ...states,
    [executionId]: {
      ...states[executionId],
      ...next,
      logs: next.logs ?? states[executionId]?.logs ?? [],
    },
  };
  const keys = Object.keys(merged);
  if (keys.length > MAX_EXECUTION_STATES) {
    // 删掉最旧的(插入序靠前),保留最近 MAX_EXECUTION_STATES 个 executionId。
    const toDrop = keys.length - MAX_EXECUTION_STATES;
    for (let i = 0; i < toDrop; i++) delete merged[keys[i]];
  }
  return merged;
}

function finishExecution<TNode extends WorkflowCanvasNode, TEdge extends WorkflowCanvasEdge>(
  state: WorkflowProjectionState<TNode, TEdge>,
  executionId: string,
  status: Extract<WorkflowExecutionStatus, 'completed' | 'failed' | 'cancelled'>,
  details: {
    now: number;
    workflowId?: string;
    output?: unknown;
    error?: string;
    logType: Extract<WorkflowUiLogType, 'info' | 'error'>;
    logContent: string;
  },
): WorkflowProjectionState<TNode, TEdge> {
  const summaryId = workflowSummaryNodeId(executionId);
  const summary = state.executions.find((execution) => execution.nodeId === summaryId);
  const executionState = state.executionStates[executionId];
  return {
    ...state,
    isExecuting: false,
    currentExecutionId: state.currentExecutionId === executionId ? executionId : state.currentExecutionId,
    executionStates: upsertExecutionState(state.executionStates, executionId, {
      executionId,
      workflowId: details.workflowId ?? executionState?.workflowId ?? state.currentWorkflowId ?? undefined,
      status,
      startTime: executionState?.startTime ?? details.now,
      endTime: details.now,
      logs: executionState?.logs ?? [],
      output: details.output,
      error: details.error,
    }),
    executions: summary
      ? upsertNodeExecution(state.executions, {
        ...summary,
        status,
        completedAt: details.now,
        output: details.output === undefined ? summary.output : stringifyPayload(details.output),
        error: details.error ?? summary.error,
        logs: [...summary.logs, { timestamp: details.now, type: details.logType, content: details.logContent }],
      })
      : state.executions,
  };
}

function workflowSummaryNodeId(executionId: string): string {
  return `workflow-${executionId}`;
}

function engineLogToUiLog(log: WorkflowEngineLog, fallbackTimestamp: number): WorkflowExecutionLog {
  const level = String(log.level || 'info').toLowerCase();
  const uiType = isWorkflowUiLogType(log.uiType)
    ? log.uiType
    : level === 'error'
      ? 'error'
      : 'info';
  const content = typeof log.content === 'string'
    ? log.content
    : typeof log.message === 'string'
      ? log.message
      : stringifyPayload(log);
  return {
    timestamp: log.timestamp ?? fallbackTimestamp,
    type: uiType,
    content,
    ...(typeof log.tool === 'string' ? { tool: log.tool } : {}),
  };
}

function stringifyPayload(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summaryFromWorkflow(
  workflow: WorkflowDefinitionProjection | undefined,
  fallbackId: string,
): WorkflowDirectorySummaryProjection | null {
  if (!workflow && !fallbackId) return null;
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : EMPTY_NODES;
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : EMPTY_EDGES;
  const config = recordValue(workflow?.config);
  return {
    id: workflow?.id ?? fallbackId,
    name: typeof workflow?.name === 'string' && workflow.name.length > 0 ? workflow.name : fallbackId,
    description: typeof workflow?.description === 'string' ? workflow.description : null,
    workspace: typeof config?.workspace === 'string' ? config.workspace : null,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    tags: Array.isArray(workflow?.tags) ? workflow.tags : null,
    createdAt: numberValue(workflow?.createdAt),
    updatedAt: numberValue(workflow?.updatedAt) ?? Date.now(),
  };
}

function upsertWorkflowSummary(
  workflows: WorkflowDirectorySummaryProjection[],
  next: WorkflowDirectorySummaryProjection,
): WorkflowDirectorySummaryProjection[] {
  const exists = workflows.some((workflow) => workflow.id === next.id);
  if (!exists) return [next, ...workflows];
  return workflows.map((workflow) => workflow.id === next.id ? { ...workflow, ...next } : workflow);
}
