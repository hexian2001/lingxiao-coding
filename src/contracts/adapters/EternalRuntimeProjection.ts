export type EternalRuntimeProjectionStatus =
  | 'disabled'
  | 'paused'
  | 'ready'
  | 'waiting'
  | 'patrolling'
  | 'silenced'
  | 'budget_exhausted'
  | 'circuit_open';

export type EternalRuntimeProjectionTone = 'active' | 'ok' | 'warn' | 'danger' | 'neutral';

export interface EternalRuntimeProjectionSnapshot {
  enabled: boolean;
  status: EternalRuntimeProjectionStatus;
  goal?: {
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

export interface EternalRuntimeProjection {
  tone: EternalRuntimeProjectionTone;
  statusLabel: string;
  compactDetailLabel: string | null;
  detailLabel: string | null;
  title: string;
  spinning: boolean;
}

export function formatEternalRuntimeStatus(status: EternalRuntimeProjectionStatus): string {
  if (status === 'paused') return 'paused';
  if (status === 'budget_exhausted') return 'budget';
  if (status === 'circuit_open') return 'circuit';
  return status.replace(/_/g, ' ');
}

export function formatEternalRuntimeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
}

function toneForStatus(status: EternalRuntimeProjectionStatus): EternalRuntimeProjectionTone {
  if (status === 'patrolling') return 'active';
  if (status === 'ready') return 'ok';
  if (status === 'paused') return 'warn';
  if (status === 'waiting') return 'neutral';
  if (status === 'silenced') return 'warn';
  if (status === 'budget_exhausted' || status === 'circuit_open') return 'danger';
  return 'neutral';
}

function detailForSnapshot(
  snapshot: EternalRuntimeProjectionSnapshot,
  now: number,
): Pick<EternalRuntimeProjection, 'compactDetailLabel' | 'detailLabel'> {
  if (snapshot.status === 'patrolling') {
    const value = snapshot.patrolInFlight ? 'in flight' : null;
    return { compactDetailLabel: value, detailLabel: value };
  }
  if (snapshot.status === 'paused') {
    return { compactDetailLabel: 'goal paused', detailLabel: 'goal paused' };
  }
  if (snapshot.status === 'waiting' && snapshot.nextPatrolDueAtMs > 0) {
    const value = `next ${formatEternalRuntimeDuration(snapshot.nextPatrolDueAtMs - now)}`;
    return { compactDetailLabel: value, detailLabel: value };
  }
  if (snapshot.status === 'ready') {
    return { compactDetailLabel: 'due now', detailLabel: 'due now' };
  }
  if (snapshot.status === 'silenced') {
    const value = snapshot.silenceLockEngaged ? 'lock' : null;
    return { compactDetailLabel: value, detailLabel: value };
  }
  if (snapshot.status === 'budget_exhausted') {
    const compact = snapshot.tokenBudgetPerHour > 0
      ? `${snapshot.currentWindowTokens}/${snapshot.tokenBudgetPerHour}`
      : 'budget';
    return {
      compactDetailLabel: compact,
      detailLabel: compact === 'budget' ? compact : `budget ${compact}`,
    };
  }
  if (snapshot.status === 'circuit_open') {
    const retry = snapshot.circuitOpenUntilMs > 0
      ? `retry ${formatEternalRuntimeDuration(snapshot.circuitOpenUntilMs - now)}`
      : null;
    const failures = snapshot.consecutiveApiFailures > 0
      ? `fail ${snapshot.consecutiveApiFailures}`
      : null;
    const detail = [retry, failures].filter(Boolean).join(' ') || null;
    return {
      compactDetailLabel: retry,
      detailLabel: detail,
    };
  }
  return { compactDetailLabel: null, detailLabel: null };
}

function titleForSnapshot(
  snapshot: EternalRuntimeProjectionSnapshot,
  statusLabel: string,
  detailLabel: string | null,
): string {
  const parts = [
    `Eternal ${statusLabel}`,
    detailLabel,
    `patrols ${snapshot.totalPatrols}`,
    `idle ${snapshot.consecutiveIdlePatrols}`,
    `outcome ${snapshot.lastPatrolOutcome}`,
    snapshot.tokenBudgetPerHour > 0
      ? `tokens ${snapshot.currentWindowTokens}/${snapshot.tokenBudgetPerHour}`
      : null,
    snapshot.consecutiveApiFailures > 0
      ? `api failures ${snapshot.consecutiveApiFailures}`
      : null,
    snapshot.goal?.description
      ? `goal ${snapshot.goal.description.slice(0, 80)}`
      : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

export function buildEternalRuntimeProjection(
  snapshot: EternalRuntimeProjectionSnapshot | null | undefined,
  now = Date.now(),
): EternalRuntimeProjection | null {
  if (!snapshot?.enabled) return null;
  const statusLabel = formatEternalRuntimeStatus(snapshot.status);
  const detail = detailForSnapshot(snapshot, now);
  return {
    tone: toneForStatus(snapshot.status),
    statusLabel,
    compactDetailLabel: detail.compactDetailLabel,
    detailLabel: detail.detailLabel,
    title: titleForSnapshot(snapshot, statusLabel, detail.detailLabel),
    spinning: snapshot.status === 'patrolling' && snapshot.patrolInFlight,
  };
}
