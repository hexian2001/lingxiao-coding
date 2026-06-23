import { contentToPlainText, type MessageContent } from '../llm/types.js';
import type { AgentHandle } from '../contracts/types/Agent.js';
import type { LeaderExecutionMode } from '../contracts/types/Session.js';
import { SESSION_KEYS } from './SessionStateKeys.js';
import type { PermissionRequestPayload } from './PermissionSystem.js';
import { resolveModeRuntimeProjection, type ModeRuntimeProjection } from './ModeRuntimeProjection.js';
import {
  createInitialEternalRuntimeSnapshot,
  type EternalRuntimeSnapshot,
  type EternalRuntimeStatus,
} from './EternalLoop.js';
import { readPersistedEternalGoal } from './EternalGoal.js';

export type PendingUserInputKind =
  | 'empty'
  | 'message'
  | 'permission_request'
  | 'plan_review'
  | 'unknown';

export interface PendingUserInputState {
  raw: unknown | null;
  kind: PendingUserInputKind;
  preview: string;
}

export type PendingUserGateKind = 'none' | 'permission' | 'ask_user' | 'plan_review' | 'idle_wait';

export interface PendingUserGateState {
  raw: unknown | null;
  kind: PendingUserGateKind;
  preview: string;
  requestId?: string;
  source?: 'leader' | 'worker' | 'system' | 'user' | 'unknown';
  reason?: string;
}

export interface LeaderInteractionSnapshot {
  running: boolean;
  /** True while a leader turn/LLM round is actively in flight. */
  busy?: boolean;
  finished: boolean;
  waitingForUser: boolean;
  pendingReview: boolean;
  planApproved: boolean;
  executionMode: LeaderExecutionMode;
  executionReason: string;
  permissionSummary: string;
  pendingPermissionRequest: PermissionRequestPayload | null;
  /** Current session-local leader model ID (falls back to global config). */
  leaderModel?: string;
  /** Current session-local agent/worker model ID (falls back to global config). */
  agentModel?: string;
}

export interface RuntimeWorkerSummary {
  agentId: string;
  name: string;
  roleType: string;
  taskId: string;
  status: AgentHandle['status'];
  visibility?: 'team' | 'ephemeral';
  owner?: 'leader' | 'team';
  interactive?: boolean;
  persistAcrossTurns?: boolean;
  teamMember?: string | null;
  iteration?: number;
  lastActivity?: number;
}

export interface SessionRuntimeState {
  sessionId: string;
  workspace: string;
  sessionStatus: string;
  modes: ModeRuntimeProjection;
  leader: LeaderInteractionSnapshot;
  pendingUserInput: PendingUserInputState;
  pendingUserGate?: PendingUserGateState;
  runningWorkers: RuntimeWorkerSummary[];
  runningWorkerCount: number;
  hasRunningWorkers: boolean;
  recoveringTasks: Array<{
    taskId: string;
    agentName: string;
    category: string;
    faultClass: string;
    recoveryAction: string;
    lastActivityAt?: number;
  }>;
  recoveringTaskCount: number;
  hasRecoveringTasks: boolean;
  dispatchableTaskCount: number;
  hasDispatchableTasks: boolean;
  allTasksTerminal: boolean;
  eternal: EternalRuntimeSnapshot;
}

export interface DeriveSessionRuntimeStateInput {
  sessionId: string;
  workspace: string;
  sessionStatus: string;
  leader: LeaderInteractionSnapshot;
  runningWorkers: AgentHandle[];
  recoveringTasks?: Array<{
    taskId: string;
    agentName: string;
    category: string;
    faultClass: string;
    recoveryAction: string;
    lastActivityAt?: number;
  }>;
  dispatchableTaskCount: number;
  allTasksTerminal: boolean;
  pendingUserInput: unknown | null;
  pendingUserGate?: unknown | null;
  eternal?: EternalRuntimeSnapshot;
  modes?: ModeRuntimeProjection;
}

export interface SessionStateReader {
  getSessionState(sessionId: string, key: string): unknown | null;
}

export interface PersistedInteractionSnapshot {
  leader: LeaderInteractionSnapshot;
  pendingUserInput: unknown | null;
  pendingUserGate: unknown | null;
}

function readNumberState(db: SessionStateReader, sessionId: string, key: string): number | null {
  const value = db.getSessionState(sessionId, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBooleanState(db: SessionStateReader, sessionId: string, key: string): boolean | null {
  const value = db.getSessionState(sessionId, key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function readPatrolOutcomeState(
  db: SessionStateReader,
  sessionId: string,
  key: string,
): EternalRuntimeSnapshot['lastPatrolOutcome'] | null {
  const value = db.getSessionState(sessionId, key);
  return value === 'productive' || value === 'idle' || value === 'never'
    ? value
    : null;
}

function toPendingUserInputPreview(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').slice(0, 160);
  }
  try {
    return contentToPlainText(value as MessageContent).replace(/\s+/g, ' ').slice(0, 160);
  } catch {/* expected: fallback to default */
    return String(value).replace(/\s+/g, ' ').slice(0, 160);
  }
}

export function derivePendingUserInputState(value: unknown | null): PendingUserInputState {
  if (value == null || value === '') {
    return {
      raw: value,
      kind: 'empty',
      preview: '',
    };
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'permission_request') {
      return {
        raw: value,
        kind: 'permission_request',
        preview: 'permission_request',
      };
    }
    if (normalized === 'plan_review') {
      return {
        raw: value,
        kind: 'plan_review',
        preview: 'plan_review',
      };
    }
    return {
      raw: value,
      kind: 'message',
      preview: toPendingUserInputPreview(value),
    };
  }

  return {
    raw: value,
    kind: 'message',
    preview: toPendingUserInputPreview(value),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function derivePendingUserGateState(value: unknown | null): PendingUserGateState {
  if (value == null || value === '') {
    return { raw: value, kind: 'none', preview: '' };
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const kind = stringField(record, 'kind');
    const normalized = kind?.trim().toLowerCase();
    if (normalized === 'permission' || normalized === 'ask_user' || normalized === 'plan_review' || normalized === 'idle_wait') {
      const question = stringField(record, 'question');
      const reason = stringField(record, 'reason');
      const preview = question || reason || stringField(record, 'preview') || normalized;
      const source = stringField(record, 'source');
      return {
        raw: value,
        kind: normalized,
        preview: preview.replace(/\s+/g, ' ').slice(0, 160),
        requestId: stringField(record, 'requestId'),
        source: source === 'leader' || source === 'worker' || source === 'system' || source === 'user' ? source : 'unknown',
        reason,
      };
    }
  }

  const legacy = derivePendingUserInputState(value);
  if (legacy.kind === 'permission_request') {
    return { raw: value, kind: 'permission', preview: legacy.preview, source: 'unknown' };
  }
  if (legacy.kind === 'plan_review') {
    return { raw: value, kind: 'plan_review', preview: legacy.preview, source: 'user' };
  }
  return { raw: value, kind: 'none', preview: '' };
}

export function deriveSessionRuntimeState(input: DeriveSessionRuntimeStateInput): SessionRuntimeState {
  const pendingUserInput = derivePendingUserInputState(input.pendingUserInput);
  const pendingUserGate = derivePendingUserGateState(input.pendingUserGate ?? input.pendingUserInput);
  const runningWorkers = input.runningWorkers.map((worker) => ({
    agentId: worker.agentId,
    name: worker.name,
    roleType: worker.roleType,
    taskId: worker.taskId,
    status: worker.status,
    visibility: worker.visibility,
    owner: worker.owner,
    interactive: worker.interactive,
    persistAcrossTurns: worker.persistAcrossTurns,
    teamMember: worker.teamMember,
    iteration: worker.iteration,
    lastActivity: worker.lastProgress ?? worker.startTime,
  }));
  const recoveringTasks = [...(input.recoveringTasks || [])];
  const eternal = input.eternal ?? createInitialEternalRuntimeSnapshot(false);
  const modes = input.modes ?? resolveModeRuntimeProjection({
    sessionId: input.sessionId,
    db: {
      getSessionState: () => null,
    },
  });

  return {
    sessionId: input.sessionId,
    workspace: input.workspace,
    sessionStatus: input.sessionStatus,
    modes,
    leader: input.leader,
    pendingUserInput,
    pendingUserGate,
    runningWorkers,
    runningWorkerCount: runningWorkers.length,
    hasRunningWorkers: runningWorkers.length > 0,
    recoveringTasks,
    recoveringTaskCount: recoveringTasks.length,
    hasRecoveringTasks: recoveringTasks.length > 0,
    dispatchableTaskCount: input.dispatchableTaskCount,
    hasDispatchableTasks: input.dispatchableTaskCount > 0,
    allTasksTerminal: input.allTasksTerminal,
    eternal,
  };
}

export function loadPersistedEternalRuntimeSnapshot(
  db: SessionStateReader,
  sessionId: string,
  now = Date.now(),
): EternalRuntimeSnapshot {
  const enabled = db.getSessionState(sessionId, SESSION_KEYS.CONTROL_MODE) === 'eternal';
  const goal = readPersistedEternalGoal(db, sessionId);
  const base = createInitialEternalRuntimeSnapshot(enabled, {}, now, goal);
  const currentPatrolIntervalMs =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_PATROL_INTERVAL) ?? base.currentPatrolIntervalMs;
  const consecutiveIdlePatrols =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_IDLE_PATROL_COUNT) ?? base.consecutiveIdlePatrols;
  const lastPatrolAtMs =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_LAST_PATROL_AT) ?? base.lastPatrolAtMs;
  const currentWindowTokens =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_WINDOW_TOKENS) ?? base.currentWindowTokens;
  const tokenBudgetPerHour =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_TOKEN_BUDGET_PER_HOUR) ?? base.tokenBudgetPerHour;
  const windowStartMs =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_WINDOW_START_MS) ?? base.windowStartMs;
  const consecutiveApiFailures =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_API_FAILURE_COUNT) ?? base.consecutiveApiFailures;
  const circuitOpenUntilMs =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_CIRCUIT_OPEN_UNTIL) ?? base.circuitOpenUntilMs;
  const totalPatrols =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_TOTAL_PATROLS) ?? base.totalPatrols;
  const silenceLockEngaged =
    readBooleanState(db, sessionId, SESSION_KEYS.ETERNAL_SILENCE_LOCK_ENGAGED) ?? base.silenceLockEngaged;
  const lastPatrolOutcome =
    readPatrolOutcomeState(db, sessionId, SESSION_KEYS.ETERNAL_LAST_PATROL_OUTCOME) ?? base.lastPatrolOutcome;
  const workerCompletionCount =
    readNumberState(db, sessionId, SESSION_KEYS.ETERNAL_WORKER_COMPLETION_COUNT) ?? base.workerCompletionCount;
  const lastFingerprint = db.getSessionState(sessionId, SESSION_KEYS.ETERNAL_LAST_FINGERPRINT);
  const nextPatrolDueAtMs = lastPatrolAtMs > 0
    ? lastPatrolAtMs + currentPatrolIntervalMs
    : base.nextPatrolDueAtMs;
  const status: EternalRuntimeStatus = !enabled
    ? 'disabled'
    : goal?.paused
      ? 'paused'
      : circuitOpenUntilMs > now
      ? 'circuit_open'
      : tokenBudgetPerHour > 0 && currentWindowTokens >= tokenBudgetPerHour
        ? 'budget_exhausted'
        : silenceLockEngaged
          ? 'silenced'
          : now < nextPatrolDueAtMs
            ? 'waiting'
            : 'ready';

  return {
    ...base,
    status,
    goal,
    currentPatrolIntervalMs,
    consecutiveIdlePatrols,
    lastPatrolAtMs,
    nextPatrolDueAtMs,
    currentWindowTokens,
    tokenBudgetPerHour,
    windowStartMs,
    consecutiveApiFailures,
    circuitOpenUntilMs,
    totalPatrols,
    silenceLockEngaged,
    lastPatrolOutcome,
    workerCompletionCount,
    patrolInFlight: false,
    lastFingerprintKnown: typeof lastFingerprint === 'string' && lastFingerprint.length > 0,
  };
}

export function loadPersistedInteractionSnapshot(
  db: SessionStateReader,
  sessionId: string,
): PersistedInteractionSnapshot {
  const waitingForUser = db.getSessionState(sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER) === 'true';
  const pendingReview = db.getSessionState(sessionId, SESSION_KEYS.LEADER_PENDING_REVIEW) === 'true';
  const planApproved = db.getSessionState(sessionId, SESSION_KEYS.LEADER_PLAN_APPROVED) === 'true';
  const executionMode = db.getSessionState(sessionId, SESSION_KEYS.LEADER_EXECUTION_MODE);
  const executionReason = db.getSessionState(sessionId, SESSION_KEYS.LEADER_EXECUTION_REASON);
  const pendingPermissionRequest = db.getSessionState(sessionId, SESSION_KEYS.PENDING_PERMISSION_REQUEST);
  const pendingUserInput = db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_INPUT);
  const pendingUserGate = db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_GATE);

  return {
    leader: {
      running: false,
      busy: false,
      finished: false,
      waitingForUser,
      pendingReview,
      planApproved,
      executionMode:
        executionMode === 'direct' || executionMode === 'hybrid' || executionMode === 'delegate'
          ? executionMode
          : 'direct',
      executionReason: typeof executionReason === 'string' ? executionReason : '',
      permissionSummary: 'unknown',
      pendingPermissionRequest:
        pendingPermissionRequest && typeof pendingPermissionRequest === 'object'
          ? pendingPermissionRequest as PermissionRequestPayload
          : null,
    },
    pendingUserInput,
    pendingUserGate,
  };
}
