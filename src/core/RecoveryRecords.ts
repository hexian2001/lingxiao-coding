import type { DatabaseManager } from './Database.js';

export type RecoveryFaultClass =
  | 'worker_heartbeat_timeout'
  | 'worker_max_runtime'
  | 'worker_crashed'
  | 'worker_exit'
  | 'worker_protocol'
  | 'worker_runtime'
  | 'worker_stopped'
  | 'worker_health_runaway'
  | 'worker_startup'
  | 'external_agent_timeout'
  | 'external_agent_crashed'
  | 'external_agent_protocol'
  | 'external_agent_auth'
  | 'external_agent_config';

export interface RuntimeRecoveryRecord {
  sessionId: string;
  taskId: string;
  agentId: string;
  agentName: string;
  roleType?: string;
  category: 'internal_recoverable' | 'external_retryable' | 'external_blocking';
  faultClass: RecoveryFaultClass;
  status: 'recovering' | 'blocked' | 'resolved';
  reason: string;
  recoveryAction: 'leader_takeover' | 'worker_restart' | 'worker_redispatch' | 'waiting_external';
  attempt: number;
  lineId: string;
  lastActivityAt?: number;
  timestamp: number;
}

const RECOVERY_PREFIX = 'runtime_recovery:';
const RECOVERY_FAULT_CLASSES = new Set<RecoveryFaultClass>([
  'worker_heartbeat_timeout',
  'worker_max_runtime',
  'worker_crashed',
  'worker_exit',
  'worker_protocol',
  'worker_runtime',
  'worker_stopped',
  'worker_health_runaway',
  'worker_startup',
  'external_agent_timeout',
  'external_agent_crashed',
  'external_agent_protocol',
  'external_agent_auth',
  'external_agent_config',
]);
const RECOVERY_CATEGORIES = new Set<RuntimeRecoveryRecord['category']>([
  'internal_recoverable',
  'external_retryable',
  'external_blocking',
]);
const RECOVERY_STATUSES = new Set<RuntimeRecoveryRecord['status']>([
  'recovering',
  'blocked',
  'resolved',
]);
const RECOVERY_ACTIONS = new Set<RuntimeRecoveryRecord['recoveryAction']>([
  'leader_takeover',
  'worker_restart',
  'worker_redispatch',
  'waiting_external',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(row: Record<string, unknown>, field: keyof RuntimeRecoveryRecord): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Recovery record missing canonical field ${String(field)}`);
  }
  return value;
}

function requireNumber(row: Record<string, unknown>, field: keyof RuntimeRecoveryRecord): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Recovery record missing canonical field ${String(field)}`);
  }
  return value;
}

function parseRecoveryRecord(value: unknown): RuntimeRecoveryRecord {
  if (!isRecord(value)) {
    throw new Error('Recovery record must be a canonical object');
  }
  const record: RuntimeRecoveryRecord = {
    sessionId: requireString(value, 'sessionId'),
    taskId: requireString(value, 'taskId'),
    agentId: requireString(value, 'agentId'),
    agentName: requireString(value, 'agentName'),
    category: requireString(value, 'category') as RuntimeRecoveryRecord['category'],
    faultClass: requireString(value, 'faultClass') as RecoveryFaultClass,
    status: requireString(value, 'status') as RuntimeRecoveryRecord['status'],
    reason: requireString(value, 'reason'),
    recoveryAction: requireString(value, 'recoveryAction') as RuntimeRecoveryRecord['recoveryAction'],
    attempt: requireNumber(value, 'attempt'),
    lineId: requireString(value, 'lineId'),
    timestamp: requireNumber(value, 'timestamp'),
  };
  if (value.roleType !== undefined) record.roleType = requireString(value, 'roleType');
  if (value.lastActivityAt !== undefined) record.lastActivityAt = requireNumber(value, 'lastActivityAt');
  if (!RECOVERY_CATEGORIES.has(record.category)) throw new Error(`Recovery record has invalid category: ${record.category}`);
  if (!RECOVERY_FAULT_CLASSES.has(record.faultClass)) throw new Error(`Recovery record has invalid faultClass: ${record.faultClass}`);
  if (!RECOVERY_STATUSES.has(record.status)) throw new Error(`Recovery record has invalid status: ${record.status}`);
  if (!RECOVERY_ACTIONS.has(record.recoveryAction)) throw new Error(`Recovery record has invalid recoveryAction: ${record.recoveryAction}`);
  return record;
}

export function recoveryRecordKey(taskId: string): string {
  return `${RECOVERY_PREFIX}${taskId}`;
}

export function saveRecoveryRecord(db: DatabaseManager, record: RuntimeRecoveryRecord): void {
  db.setSessionState(record.sessionId, recoveryRecordKey(record.taskId), record);
}

export function getRecoveryRecord(
  db: Pick<DatabaseManager, 'getSessionState'>,
  sessionId: string,
  taskId: string,
): RuntimeRecoveryRecord | null {
  const value = db.getSessionState(sessionId, recoveryRecordKey(taskId));
  if (value === null || value === undefined) return null;
  return parseRecoveryRecord(value);
}

export function clearRecoveryRecord(db: DatabaseManager, sessionId: string, taskId: string): void {
  db.deleteSessionState(sessionId, recoveryRecordKey(taskId));
}

export function listRecoveryRecords(
  db: Pick<DatabaseManager, 'listSessionStateByPrefix'>,
  sessionId: string,
): RuntimeRecoveryRecord[] {
  return db.listSessionStateByPrefix(sessionId, RECOVERY_PREFIX)
    .map((entry) => parseRecoveryRecord(entry.value))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function recoveryTimestampMs(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

/**
 * 清理已解决且超过 maxAgeMs 的恢复记录，防止 DB 无限增长。
 * 返回清理的记录数。
 */
export function gcRecoveryRecords(
  db: DatabaseManager,
  sessionId: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000, // 24h
): number {
  const records = listRecoveryRecords(db, sessionId);
  const now = Date.now();
  let cleaned = 0;
  for (const record of records) {
    if (record.status === 'resolved' && now - recoveryTimestampMs(record.timestamp) > maxAgeMs) {
      clearRecoveryRecord(db, sessionId, record.taskId);
      cleaned++;
    }
  }
  return cleaned;
}
