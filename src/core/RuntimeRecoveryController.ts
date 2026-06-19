import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import type { Task, TaskBoard } from './TaskBoard.js';
import {
  clearRecoveryRecord,
  gcRecoveryRecords,
  listRecoveryRecords,
  type RuntimeRecoveryRecord,
} from './RecoveryRecords.js';
import { isTaskTerminalStatus } from './StateSemantics.js';

export interface RecoveryReconcileResult {
  changed: boolean;
  redispatched: string[];
  blocked: string[];
  resolved: string[];
  orphaned: string[];
}

export interface RecoverySnapshot {
  sessionId: string;
  total: number;
  recovering: number;
  blocked: number;
  resolved: number;
  redispatchable: number;
  leaderTakeover: number;
  waitingExternal: number;
  orphaned: number;
  records: Array<{
    taskId: string;
    agentName: string;
    status: RuntimeRecoveryRecord['status'];
    category: RuntimeRecoveryRecord['category'];
    faultClass: RuntimeRecoveryRecord['faultClass'];
    recoveryAction: RuntimeRecoveryRecord['recoveryAction'];
    attempt: number;
    reason: string;
    taskStatus?: Task['status'];
    assignedAgent?: string;
  }>;
}

export function buildRecoverySnapshot(
  sessionId: string,
  records: RuntimeRecoveryRecord[],
  getTask?: (taskId: string) => Task | undefined,
): RecoverySnapshot {
  const active = records.filter((record) => record.status !== 'resolved');
  const getMaybeTask = (taskId: string) => getTask?.(taskId);
  const orphaned = getTask
    ? active.filter((record) => !getMaybeTask(record.taskId))
    : [];
  const blocked = active.filter((record) => record.status === 'blocked' || record.recoveryAction === 'waiting_external');

  return {
    sessionId,
    total: active.length,
    recovering: active.filter((record) => record.status === 'recovering').length,
    blocked: blocked.length,
    resolved: records.filter((record) => record.status === 'resolved').length,
    redispatchable: active.filter((record) => record.recoveryAction === 'worker_restart' || record.recoveryAction === 'worker_redispatch').length,
    leaderTakeover: active.filter((record) => record.recoveryAction === 'leader_takeover').length,
    waitingExternal: active.filter((record) => record.recoveryAction === 'waiting_external').length,
    orphaned: orphaned.length,
    records: active.map((record) => {
      const task = getMaybeTask(record.taskId);
      return {
        taskId: record.taskId,
        agentName: record.agentName,
        status: record.status,
        category: record.category,
        faultClass: record.faultClass,
        recoveryAction: record.recoveryAction,
        attempt: record.attempt,
        reason: record.reason,
        taskStatus: task?.status,
        assignedAgent: task?.assigned_agent,
      };
    }),
  };
}

export class RuntimeRecoveryController {
  constructor(
    private readonly db: DatabaseManager,
    private readonly board: TaskBoard,
    private readonly sessionId: string,
    private readonly emitter?: EventEmitter,
  ) {}

  listActiveRecords(): RuntimeRecoveryRecord[] {
    return listRecoveryRecords(this.db, this.sessionId).filter((record) => record.status !== 'resolved');
  }

  reconcile(): RecoveryReconcileResult {
    const records = this.listActiveRecords();
    const result: RecoveryReconcileResult = {
      changed: false,
      redispatched: [],
      blocked: [],
      resolved: [],
      orphaned: [],
    };

    for (const record of records) {
      const task = this.board.getTask(record.taskId);
      if (!task) {
        result.orphaned.push(record.taskId);
        clearRecoveryRecord(this.db, this.sessionId, record.taskId);
        this.emitter?.emit('runtime_recovery:changed', {
          sessionId: this.sessionId,
          action: 'cleared',
          taskId: record.taskId,
        });
        result.changed = true;
        continue;
      }

      if (isTaskTerminalStatus(task)) {
        clearRecoveryRecord(this.db, this.sessionId, record.taskId);
        this.emitter?.emit('runtime_recovery:changed', {
          sessionId: this.sessionId,
          action: 'cleared',
          taskId: record.taskId,
        });
        result.resolved.push(record.taskId);
        result.changed = true;
        continue;
      }

      // waiting_external: the task is stalled on an external condition (e.g. approval).
      // The assigned worker is precisely what's stuck, so release it and mark the task
      // blocked — do NOT clear the record just because a worker is assigned.
      if (record.recoveryAction === 'waiting_external') {
        if (task.assigned_agent || task.status !== 'dispatchable') {
          this.board.blockTask(record.taskId, '[blocked] ' + record.reason);
          result.changed = true;
        }
        result.blocked.push(record.taskId);
        continue;
      }

      if (record.status === 'blocked') {
        // A previously-blocked task: if a worker is actively running again the block is
        // stale → clear; otherwise re-block to keep it tracked.
        if (task.assigned_agent && task.status !== 'dispatchable') {
          clearRecoveryRecord(this.db, this.sessionId, record.taskId);
          this.emitter?.emit('runtime_recovery:changed', {
            sessionId: this.sessionId,
            action: 'cleared',
            taskId: record.taskId,
          });
          result.changed = true;
          continue;
        }
        if (task.status === 'dispatchable' && !task.assigned_agent) {
          this.board.blockTask(record.taskId, '[blocked] ' + record.reason);
          result.changed = true;
        }
        result.blocked.push(record.taskId);
        continue;
      }

      if (record.recoveryAction === 'worker_restart' || record.recoveryAction === 'worker_redispatch') {
        if (task.assigned_agent || task.status !== 'dispatchable') {
          this.board.prepareTaskForRedispatch(record.taskId, `[recovering] ${record.reason}`);
          result.changed = true;
        }
        result.redispatched.push(record.taskId);
        continue;
      }
    }

    return result;
  }

  snapshot(): RecoverySnapshot {
    return buildRecoverySnapshot(
      this.sessionId,
      listRecoveryRecords(this.db, this.sessionId),
      (taskId) => this.board.getTask(taskId),
    );
  }

  summary(): { total: number; blocked: number; statusText?: string } {
    const snapshot = this.snapshot();
    if (snapshot.blocked > 0) {
      const first = snapshot.records.find((record) =>
        record.status === 'blocked' || record.recoveryAction === 'waiting_external'
      );
      return {
        total: snapshot.total,
        blocked: snapshot.blocked,
        statusText: `外部阻塞中... (${snapshot.blocked} 个任务等待外部条件: ${(first?.reason || '').slice(0, 48)})`,
      };
    }
    if (snapshot.total > 0) {
      return {
        total: snapshot.total,
        blocked: 0,
        statusText: `自治恢复中... (${snapshot.total} 个任务等待接管, redispatchable=${snapshot.redispatchable}, takeover=${snapshot.leaderTakeover})`,
      };
    }
    return {
      total: 0,
      blocked: 0,
      statusText: undefined,
    };
  }

  gc(maxAgeMs?: number): number {
    return gcRecoveryRecords(this.db, this.sessionId, maxAgeMs);
  }
}
