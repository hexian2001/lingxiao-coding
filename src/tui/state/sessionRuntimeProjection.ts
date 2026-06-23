import { deriveRuntimeWaitGate, deriveRuntimeWorkerFacts, normalizeRunStatus, runtimeImpliesBusy } from '../../core/StateSemantics.js';
import type { CommandSessionStatusData } from '../../commands/types.js';
import type { EternalRuntimeSnapshot } from '../../core/EternalLoop.js';
import type { ModeRuntimeProjection } from '../../core/ModeRuntimeProjection.js';

type RuntimeRecord = Record<string, unknown>;

export interface TuiRuntimeWorker {
  agentId: string;
  name: string;
  roleType: string;
  taskId?: string;
  status: string;
}

export interface TuiSessionRuntimeProjectionInput {
  event: unknown;
  currentSessionStatus?: CommandSessionStatusData | null;
  workspace: string;
  processingStatus: string;
  awaitingInputStatus: string;
  idleStatus?: string;
}

export interface TuiSessionRuntimeProjection {
  runtimeState: RuntimeRecord;
  runtimeSessionId: string;
  runtimeActive: boolean;
  derivedLeaderActive: boolean;
  sessionStatus: string;
  permissionSummary?: string;
  executionMode?: 'direct' | 'hybrid' | 'delegate';
  executionReason: string;
  queueLength: number;
  displayLeaderQueueLength: number;
  runningWorkers: TuiRuntimeWorker[];
  hasRunningWorkers: boolean;
  eternalRuntime?: EternalRuntimeSnapshot;
  nextSessionStatus: CommandSessionStatusData;
  nextLeaderStatus: string;
  /** Session-local leader model from runtime state (undefined if not available). */
  leaderModel?: string;
  /** Session-local agent/worker model from runtime state (undefined if not available). */
  agentModel?: string;
}

function asRuntimeRecord(value: unknown): RuntimeRecord | null {
  return value && typeof value === 'object' ? value as RuntimeRecord : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return null;
}

function deriveLeaderRuntimeActive(leader: RuntimeRecord): boolean {
  return Boolean(
    leader.busy === true ||
    (leader.running === true && leader.waitingForUser !== true),
  );
}

function normalizeRuntimeWorker(worker: RuntimeRecord, index: number): TuiRuntimeWorker {
  const agentId = asString(worker.agentId) || `worker-${index + 1}`;
  return {
    agentId,
    name: asString(worker.name) || asString(worker.agentName) || agentId,
    roleType: asString(worker.roleType) || 'worker',
    taskId: asString(worker.taskId),
    status: asString(worker.status) || 'running',
  };
}

export function buildTuiSessionRuntimeProjection(
  input: TuiSessionRuntimeProjectionInput,
): TuiSessionRuntimeProjection | null {
  const event = asRuntimeRecord(input.event);
  const runtimeState = asRuntimeRecord(event?.runtimeState);
  if (!runtimeState) return null;
  const runtimeSessionId = asString(runtimeState?.sessionId);
  if (!runtimeSessionId || runtimeSessionId !== input.currentSessionStatus?.sessionId) return null;

  const sessionStatus = asString(runtimeState?.sessionStatus) || input.currentSessionStatus?.status || 'active';
  const leader = runtimeState?.leader && typeof runtimeState.leader === 'object'
    ? runtimeState.leader as RuntimeRecord
    : {};
  const derivedLeaderActive = deriveLeaderRuntimeActive(leader);
  const displayLeaderQueueLength = asNonNegativeInteger(leader.queueLength) ?? 0;
  const runtimeActive = runtimeImpliesBusy({ runtimeState });
  const permissionSummary = typeof leader.permissionSummary === 'string'
    ? leader.permissionSummary
    : undefined;
  const executionMode =
    leader.executionMode === 'direct' || leader.executionMode === 'hybrid' || leader.executionMode === 'delegate'
      ? leader.executionMode
      : undefined;
  const executionReason = typeof leader.executionReason === 'string' ? leader.executionReason : '';
  const queueLength = displayLeaderQueueLength;
  const rawWorkerFacts = deriveRuntimeWorkerFacts<RuntimeRecord>(runtimeState);
  const runningWorkers = rawWorkerFacts.runningWorkers.map(normalizeRuntimeWorker);
  const eternalRuntime = runtimeState?.eternal && typeof runtimeState.eternal === 'object'
    ? runtimeState.eternal as EternalRuntimeSnapshot
    : undefined;
  const modes = runtimeState?.modes && typeof runtimeState.modes === 'object'
    ? runtimeState.modes as ModeRuntimeProjection
    : undefined;

  const nextSessionStatus = {
    ...(input.currentSessionStatus || {}),
    sessionId: runtimeSessionId,
    workspace: asString(runtimeState?.workspace) || input.currentSessionStatus?.workspace || input.workspace,
    status: String(sessionStatus),
    permissionMode: modes?.permission.mode || input.currentSessionStatus?.permissionMode,
    permissionSummary: modes?.permission.summary || permissionSummary || input.currentSessionStatus?.permissionSummary,
    controlMode: modes?.controlMode || input.currentSessionStatus?.controlMode,
    ...(modes ? { modes } : {}),
    ...(eternalRuntime ? { eternal: eternalRuntime } : {}),
  };

  const normalizedSessionStatus = normalizeRunStatus(sessionStatus);
  const completed = normalizedSessionStatus === 'completed';
  const failed = normalizedSessionStatus === 'failed';
  const interrupted = normalizedSessionStatus === 'cancelled';
  const waitGate = deriveRuntimeWaitGate(runtimeState);
  const nextLeaderStatus = (completed || failed)
    ? (input.idleStatus ?? input.awaitingInputStatus)
    : interrupted
      ? (input.idleStatus ?? input.awaitingInputStatus)
      : runtimeActive
        ? input.processingStatus
        : waitGate
          ? input.awaitingInputStatus
          : input.idleStatus ?? input.awaitingInputStatus;

  const leaderModel = asString(leader.leaderModel);
  const agentModel = asString(leader.agentModel);

  return {
    runtimeState,
    runtimeSessionId,
    runtimeActive,
    derivedLeaderActive,
    sessionStatus,
    permissionSummary,
    executionMode,
    executionReason,
    queueLength,
    displayLeaderQueueLength,
    runningWorkers,
    hasRunningWorkers: rawWorkerFacts.hasRunningWorkers,
    eternalRuntime,
    nextSessionStatus,
    nextLeaderStatus,
    leaderModel,
    agentModel,
  };
}
