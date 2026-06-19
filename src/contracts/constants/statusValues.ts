import type { SessionPhase, TaskStatus, ToolCallStatus, WorkflowState } from '../types/Status.js';
export { AGENT_RUN_STATUSES } from '../types/Status.js';

export const TOOL_CALL_STATUSES: readonly ToolCallStatus[] = ['streaming_input', 'pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export const SESSION_PHASES: readonly SessionPhase[] = ['idle', 'preparing', 'model_requesting', 'streaming', 'thinking', 'tool_executing', 'observing', 'waiting_for_permission', 'waiting_for_user', 'retrying', 'compacting', 'cancelling', 'done', 'error', 'interrupted'] as const;
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'queued', 'dispatchable', 'in_progress', 'running', 'completed', 'failed', 'blocked', 'cancelled', 'terminal'] as const;
export const WORKFLOW_STATES: readonly WorkflowState[] = ['idle', 'planning', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'repairing', 'evaluating', 'waiting_for_dependency', 'waiting_for_user', 'working'] as const;
