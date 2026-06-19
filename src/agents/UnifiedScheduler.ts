/**
 * UnifiedScheduler — 凌霄 Agent OS 的 worker dispatch 槽位预算管理
 *
 * 设计要点：
 * - LLM 显式调 dispatch_agent → LeaderTools.dispatchAgent → scheduler.requestDispatch；
 *   走统一 budget + dispatchTask hook，确保所有派发都受全局/单 session 并发上限约束。
 * - tick() / 自动 selectNext 已废弃 — 所有派发决策必须经过 Leader LLM，
 *   不再由 scheduler 自驱挑选 ready task（避免与 Leader thinking 形成竞争）。
 * - 通过订阅 task:assigned / task:completed / task:failed / task:cancelled 维护并发槽位。
 */

import type { TaskBoard, Task } from '../core/TaskBoard.js';
import type { AgentPool } from './AgentPoolRuntime.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import { config as runtimeConfig } from '../config.js';
import { coreLogger } from '../core/Log.js';
import { isCoreTaskTerminalStatus } from '../core/StateSemantics.js';

export interface SchedulerConfig {
  /** 全局最大并发 Worker 数 */
  maxWorkers: number;
  /** 单个项目（session）最大并发 Worker 数 */
  maxProjectWorkers: number;
}

export interface SchedulerStats {
  totalDispatched: number;
  totalCompleted: number;
  totalFailed: number;
  currentRunning: number;
}

export interface UnifiedSchedulerDeps {
  sessionId: string;
  board: TaskBoard;
  pool: AgentPool;
  emitter: EventEmitter;
  /**
   * Hook：把可调度任务转换为已派发 Agent；返回是否成功启动 worker。
   *
   * `opts.agentName` 由 caller（例如 LeaderTools.dispatchAgent）显式指定时使用，
   * 用于保留 LLM 选定的 agent 名称；否则由 hook 内部生成默认名 `worker-<taskId>`。
   */
  dispatchTask: (task: Task, opts?: DispatchOptions) => Promise<boolean>;
  config?: Partial<SchedulerConfig>;
}

export interface DispatchOptions {
  agentName?: string;
  displayRole?: string;
  capabilityDetails?: unknown;
  collaborationMode?: 'solo' | 'team';
  runtimeIdentity?: {
    visibility: 'team' | 'ephemeral';
    owner: 'leader' | 'team';
    interactive: boolean;
    persistAcrossTurns: boolean;
    teamMember: string | null;
  };
}

/**
 * 统一调度器槽位预算管理。
 *
 * 不持有 setInterval，不自驱选 task。所有派发都由 LLM 显式触发 requestDispatch。
 */
export class UnifiedScheduler {
  private readonly config: SchedulerConfig;
  private readonly deps: UnifiedSchedulerDeps;
  /** sessionId -> Set<taskId>，反映"已派发尚未释放槽位"的 worker */
  private readonly runningWorkers = new Map<string, Set<string>>();
  private readonly stats: SchedulerStats = {
    totalDispatched: 0,
    totalCompleted: 0,
    totalFailed: 0,
    currentRunning: 0,
  };
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(deps: UnifiedSchedulerDeps) {
    this.deps = deps;
    const defaultMaxWorkers = runtimeConfig.agents.max_concurrent;
    this.config = {
      maxWorkers: deps.config?.maxWorkers ?? defaultMaxWorkers,
      maxProjectWorkers: deps.config?.maxProjectWorkers ?? defaultMaxWorkers,
    };
    this.subscribeToTaskBoardEvents();
  }

  /** 订阅 TaskBoard 生命周期事件，自动维护槽位计数 */
  private subscribeToTaskBoardEvents(): void {
    const onCompleted = (payload: { taskId: string }): void => {
      this.releaseSlot(payload.taskId, 'completed');
    };
    const onFailed = (payload: { taskId: string }): void => {
      this.releaseSlot(payload.taskId, 'failed');
    };
    const onCancelled = (payload: { taskId: string }): void => {
      this.releaseSlot(payload.taskId, 'cancelled');
    };

    const e = this.deps.emitter;
    e.on('task:completed', onCompleted);
    e.on('task:failed', onFailed);
    e.on('task:cancelled', onCancelled);

    this.unsubscribers.push(
      () => e.off('task:completed', onCompleted),
      () => e.off('task:failed', onFailed),
      () => e.off('task:cancelled', onCancelled),
    );
  }

  /**
   * 释放并发槽位。terminal 路径在 worker 完成时也会被 caller 通过事件触发。
   */
  private releaseSlot(taskId: string, kind: 'completed' | 'failed' | 'cancelled'): void {
    const sid = this.deps.sessionId;
    const bucket = this.runningWorkers.get(sid);
    if (!bucket || !bucket.has(taskId)) return;
    bucket.delete(taskId);
    if (bucket.size === 0) this.runningWorkers.delete(sid);
    this.stats.currentRunning = Math.max(0, this.stats.currentRunning - 1);
    if (kind === 'completed') this.stats.totalCompleted++;
    else if (kind === 'failed') this.stats.totalFailed++;
  }

  /** 当前是否还能再派发（全局 + 本 session 桶）。 */
  private canDispatchMore(): boolean {
    if (this.stats.currentRunning >= this.config.maxWorkers) return false;
    const bucket = this.runningWorkers.get(this.deps.sessionId);
    if (bucket && bucket.size >= this.config.maxProjectWorkers) return false;
    return true;
  }

  /**
   * 把 task 标记为"已认领"，避免同一调用里被重复派发。
   * 真正释放走 task lifecycle 事件。
   */
  private claimSlot(taskId: string): void {
    const sid = this.deps.sessionId;
    let bucket = this.runningWorkers.get(sid);
    if (!bucket) {
      bucket = new Set();
      this.runningWorkers.set(sid, bucket);
    }
    bucket.add(taskId);
    this.stats.currentRunning++;
    this.stats.totalDispatched++;
  }

  /**
   * LLM/Leader 显式请求派发某个任务（保留 LLM 选定的 agent 名称）。
   *
   * @returns 是否成功启动 worker。budget 不足、任务非 dispatchable、hook 拒绝都会返回 false。
   */
  async requestDispatch(task: Task, opts: DispatchOptions = {}): Promise<boolean> {
    if (this.disposed) return false;
    // A7: 派发前先对账,回收因漏事件泄漏的槽位(否则 currentRunning 虚高挤占可用并发)。
    this.reconcile();
    if (task.status !== 'dispatchable') return false;
    if (!this.deps.board.isTaskReady(task.id)) return false;
    const bucket = this.runningWorkers.get(this.deps.sessionId);
    if (bucket?.has(task.id)) return false;
    if (!this.canDispatchMore()) return false;

    this.claimSlot(task.id);
    let ok = false;
    try {
      ok = await this.deps.dispatchTask(task, opts);
    } catch (err) {
      coreLogger.error(`[UnifiedScheduler] requestDispatch threw for ${task.id}:`, err);
    }
    if (!ok) {
      const b = this.runningWorkers.get(this.deps.sessionId);
      // 以 bucket.delete 结果为准（H/M：双重递减）。await dispatchTask 期间若
      // task:failed/completed/cancelled 事件先行触发 releaseSlot，该 task 已被
      // 从 bucket 移除并递减过 currentRunning。此处 delete 返回 false 表示已被
      // 事件路径处理，必须跳过递减，避免与 releaseSlot 双重递减 currentRunning
      // （会把并发上限低估，长期挤占可用槽位）。
      const removed = b?.delete(task.id) ?? false;
      if (b && b.size === 0) this.runningWorkers.delete(this.deps.sessionId);
      if (removed) {
        this.stats.currentRunning = Math.max(0, this.stats.currentRunning - 1);
        this.stats.totalDispatched = Math.max(0, this.stats.totalDispatched - 1);
      }
      return false;
    }
    return true;
  }

  /** Caller 在 worker 终态时主动通知；事件路径已经覆盖大部分场景，此处幂等。 */
  onTaskCompleted(taskId: string): void {
    this.releaseSlot(taskId, 'completed');
  }
  onTaskFailed(taskId: string): void {
    this.releaseSlot(taskId, 'failed');
  }
  onTaskCancelled(taskId: string): void {
    this.releaseSlot(taskId, 'cancelled');
  }

  /**
   * A7: 与 TaskBoard 权威源对账——释放桶中已转终态(或已不存在)的 task 槽位。
   * 事件路径(task:completed/failed/cancelled)覆盖大部分场景,但 emitter 订阅在
   * dispose/重连竞态下漏事件、或 worker 异常退出未发事件时槽位泄漏(currentRunning
   * 虚高 → canDispatchMore 永久低估可用槽位)。以 TaskBoard 为单一事实源确定性回收。
   */
  reconcile(): void {
    const sid = this.deps.sessionId;
    const bucket = this.runningWorkers.get(sid);
    if (!bucket || bucket.size === 0) return;
    let reclaimed = 0;
    for (const taskId of bucket) {
      const task = this.deps.board.getTask(taskId);
      if (!task || isCoreTaskTerminalStatus(task.status)) {
        bucket.delete(taskId);
        reclaimed++;
      }
    }
    if (reclaimed > 0) {
      this.stats.currentRunning = Math.max(0, this.stats.currentRunning - reclaimed);
      coreLogger.warn(`[UnifiedScheduler] reconcile 回收 ${reclaimed} 个泄漏槽位(session=${sid})`);
    }
    if (bucket.size === 0) this.runningWorkers.delete(sid);
  }

  getStats(): SchedulerStats {
    return { ...this.stats };
  }

  getRunningTaskIds(): string[] {
    return Array.from(this.runningWorkers.get(this.deps.sessionId) ?? []);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* tolerate */ }
    }
    this.unsubscribers.length = 0;
    this.runningWorkers.clear();
    coreLogger.info('[UnifiedScheduler] disposed');
  }
}
