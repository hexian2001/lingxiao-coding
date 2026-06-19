import type { RecoveredTaskInfo } from '../contracts/types/Agent.js';
import type { AgentState, DatabaseManager } from './Database.js';
import type { TaskBoard } from './TaskBoard.js';
import { normalizeAgentStatus, normalizeTaskStatus } from './StateSemantics.js';

export interface AgentResumeCheckpoint {
  agentId: string;
  agentName: string;
  agentRole: string;
  taskId: string;
  iteration: number;
  toolCallCount: number;
  timestamp: number;
}

const AGENT_CHECKPOINT_PREFIX = 'agent_checkpoint:';

export function getAgentCheckpointKey(agentId: string): string {
  return `${AGENT_CHECKPOINT_PREFIX}${agentId}`;
}

export function saveAgentResumeCheckpoint(
  db: Pick<DatabaseManager, 'setSessionState'>,
  sessionId: string,
  checkpoint: AgentResumeCheckpoint,
): void {
  db.setSessionState(sessionId, getAgentCheckpointKey(checkpoint.agentId), checkpoint);
}

export function clearAgentResumeCheckpoint(
  db: Pick<DatabaseManager, 'deleteSessionState'>,
  sessionId: string,
  agentId: string,
): void {
  db.deleteSessionState(sessionId, getAgentCheckpointKey(agentId));
}

export function loadAgentResumeCheckpoints(
  db: Pick<DatabaseManager, 'listSessionStateByPrefix'>,
  sessionId: string,
): Map<string, AgentResumeCheckpoint> {
  const checkpoints = new Map<string, AgentResumeCheckpoint>();
  const rows = db.listSessionStateByPrefix(sessionId, AGENT_CHECKPOINT_PREFIX);
  for (const row of rows) {
    const value = row.value;
    if (!value || typeof value !== 'object') {
      continue;
    }
    const candidate = value as Partial<AgentResumeCheckpoint>;
    if (
      typeof candidate.agentId === 'string' &&
      typeof candidate.agentName === 'string' &&
      typeof candidate.agentRole === 'string' &&
      typeof candidate.taskId === 'string'
    ) {
      checkpoints.set(candidate.agentId, {
        agentId: candidate.agentId,
        agentName: candidate.agentName,
        agentRole: candidate.agentRole,
        taskId: candidate.taskId,
        iteration: typeof candidate.iteration === 'number' ? candidate.iteration : 0,
        toolCallCount: typeof candidate.toolCallCount === 'number' ? candidate.toolCallCount : 0,
        timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : 0,
      });
    }
  }
  return checkpoints;
}

export function buildRecoveredTasks(
  board: TaskBoard,
  agentStates: AgentState[],
  checkpoints: Map<string, AgentResumeCheckpoint> = new Map(),
): RecoveredTaskInfo[] {
  const recoveredTasks: RecoveredTaskInfo[] = [];
  const tasks = board.getAllTasks();
  const agentStateByTask = new Map<string, AgentState>();
  const interruptedStateByTask = new Map<string, AgentState>();
  const checkpointByTask = new Map<string, AgentResumeCheckpoint>();

  for (const state of agentStates) {
    if (!state?.task_id) continue;
    const prev = agentStateByTask.get(state.task_id);
    if (!prev || (state.timestamp ?? 0) >= (prev.timestamp ?? 0)) {
      agentStateByTask.set(state.task_id, state);
    }
    if (normalizeAgentStatus(state.status) === 'interrupted') {
      const interruptedPrev = interruptedStateByTask.get(state.task_id);
      if (!interruptedPrev || (state.timestamp ?? 0) >= (interruptedPrev.timestamp ?? 0)) {
        interruptedStateByTask.set(state.task_id, state);
      }
    }
  }

  for (const checkpoint of checkpoints.values()) {
    if (!checkpoint?.taskId) continue;
    const prev = checkpointByTask.get(checkpoint.taskId);
    if (!prev || (checkpoint.timestamp ?? 0) >= (prev.timestamp ?? 0)) {
      checkpointByTask.set(checkpoint.taskId, checkpoint);
    }
  }

  for (const task of tasks) {
    const matchedState = agentStateByTask.get(task.id);
    const interruptedState = interruptedStateByTask.get(task.id);
    const checkpoint = checkpointByTask.get(task.id);
    const taskUpdatedAt = typeof task.updated_at === 'number' ? task.updated_at : 0;
    const interruptedTimestamp = interruptedState?.timestamp ?? 0;
    const stateTimestamp = matchedState?.timestamp ?? 0;
    const checkpointTimestamp = checkpoint?.timestamp ?? 0;
    const latestSignalTimestamp = Math.max(stateTimestamp, interruptedTimestamp, checkpointTimestamp);
    const hasFreshInterruptedSignal = interruptedTimestamp > 0 && interruptedTimestamp >= (taskUpdatedAt - 1);
    const shouldRecover = normalizeTaskStatus(task) === 'running'
      || (task.status === 'dispatchable' && hasFreshInterruptedSignal);

    const hasIdentity = Boolean(
      task.assigned_agent || matchedState?.agent_name || checkpoint?.agentName,
    );

    if (!shouldRecover || !hasIdentity) {
      continue;
    }

    const preferTaskIdentity = Boolean(task.assigned_agent)
      && taskUpdatedAt > latestSignalTimestamp;
    const checkpointFromAgent = matchedState?.agent_id
      ? checkpoints.get(matchedState.agent_id)
      : undefined;
    const selectedCheckpoint = checkpointFromAgent || checkpoint;
    const selectedCheckpointTimestamp = selectedCheckpoint?.timestamp ?? 0;
    const shouldUseCheckpointIdentity = !preferTaskIdentity
      && selectedCheckpointTimestamp >= stateTimestamp
      && !!selectedCheckpoint;

    const iterationFromState = typeof matchedState?.iteration === 'number' ? matchedState.iteration : 0;
    const iterationFromCheckpoint = typeof selectedCheckpoint?.iteration === 'number' ? selectedCheckpoint.iteration : 0;
    const iteration = Math.max(iterationFromCheckpoint, iterationFromState);
    const role = (shouldUseCheckpointIdentity ? selectedCheckpoint?.agentRole : matchedState?.agent_role)
      || task.agent_type
      || 'coding';
    const agent = preferTaskIdentity
      ? task.assigned_agent
      : (shouldUseCheckpointIdentity ? selectedCheckpoint?.agentName : matchedState?.agent_name)
        || task.assigned_agent
        || 'unknown';
    const toolCallCount = selectedCheckpoint?.toolCallCount ?? 0;
    const detailParts: string[] = [];
    if (iteration > 0) {
      detailParts.push(`${iteration}次迭代后中断`);
    } else if (interruptedTimestamp > 0) {
      detailParts.push('会话中断');
    }
    if (toolCallCount > 0) {
      detailParts.push(`${toolCallCount}次工具调用`);
    }

    let agentId: string | undefined;
    if (!preferTaskIdentity) {
      agentId = (shouldUseCheckpointIdentity ? selectedCheckpoint?.agentId : matchedState?.agent_id)
        || selectedCheckpoint?.agentId
        || matchedState?.agent_id;
    } else if (agent === selectedCheckpoint?.agentName) {
      agentId = selectedCheckpoint?.agentId;
    } else if (agent === matchedState?.agent_name) {
      agentId = matchedState?.agent_id;
    }

    recoveredTasks.push({
      id: task.id,
      subject: task.subject,
      agent,
      agentId,
      detail: detailParts.length > 0 ? `，${detailParts.join('，')}` : '',
      role,
      iteration,
      toolCallCount,
    });
  }

  return recoveredTasks;
}
