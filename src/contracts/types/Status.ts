export type ToolCallStatus =
  | 'streaming_input'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunStatus =
  | 'spawning'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped'
  | 'crashed'
  | 'recovering'
  | 'idle'
  | 'unknown';

export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'spawning',
  'starting',
  'running',
  'completed',
  'failed',
  'interrupted',
  'stopped',
  'crashed',
  'recovering',
  'idle',
  'unknown',
] as const;

const AGENT_RUN_STATUS_SET: ReadonlySet<string> = new Set(AGENT_RUN_STATUSES);

export function isAgentRunStatus(status: string): status is AgentRunStatus {
  return AGENT_RUN_STATUS_SET.has(status);
}

export type SessionPhase =
  | 'idle'
  | 'preparing'
  | 'model_requesting'
  | 'streaming'
  | 'thinking'
  | 'tool_executing'
  | 'observing'
  | 'waiting_for_permission'
  | 'waiting_for_user'
  | 'retrying'
  | 'compacting'
  | 'cancelling'
  | 'done'
  | 'error'
  | 'interrupted';

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'dispatchable'
  | 'in_progress'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'terminal';

export type WorkflowState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'repairing'
  | 'evaluating'
  | 'waiting_for_dependency'
  | 'waiting_for_user'
  | 'working';

export function isTerminalToolCallStatus(status: ToolCallStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isTerminalAgentStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted' || status === 'stopped' || status === 'crashed';
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'terminal';
}

export function isActiveSessionPhase(status: SessionPhase): boolean {
  return status !== 'idle' && status !== 'done' && status !== 'error' && status !== 'interrupted';
}
