/**
 * IPCDrainQueue — per-worker IPC 消息异步消费队列
 *
 * 解决"一个 worker 的事件风暴拖慢所有 worker 的 IPC 消费"问题：
 *
 *   旧路径：child.on('message', msg => handleWorkerMessage(...))
 *           ↑ Node.js 同步调用所有 listener；handler 内任何同步慢操作（DB 写、复杂 emit）
 *           都会阻塞当前 child 的 IPC 消费 → 进而反压 worker 端 process.send → 心跳延迟。
 *
 *   新路径：child.on('message', msg => queue.push(msg))   // O(1)，立即返回
 *           queue.scheduleDrain()                          // setImmediate 异步消费
 *           drain() 内部按批处理，每批让出 event loop 一次。
 *
 * 设计要点：
 *   - 每个 workerId 一个独立队列：A worker 队列堆积不会影响 B worker
 *   - 有界队列 + 优先级丢弃：背压时丢 heartbeat / progress / event 等 P3，
 *     但 complete / failed / error 永不丢
 *   - 批量消费：每次 drain 处理 batchSize 条，让出 event loop，避免长任务
 *   - O(1) push：仅追加 + 必要时 schedule，不在 hot path 做任何昂贵操作
 */

import type { WorkerMessage } from '../WorkerProcessRunner.js';
import { coreLogger } from '../Log.js';

export interface IPCDrainQueueOptions {
  /** 每次 drain 处理的最大消息数，默认 50 */
  batchSize?: number;
  /** 单 worker 队列上限（含所有优先级），默认 5000；超过后开始丢 P3 → P2 → P1 */
  maxQueueSize?: number;
  /** 消费回调 */
  consume: (workerId: string, msg: WorkerMessage) => void;
}

interface WorkerQueue {
  /** P0 - 永不丢 + 生命周期关键：started/complete/failed/error
   *  started 与 complete/failed 同级：started 必须先于终态消息被处理（FIFO within P0），
   *  否则终态消息先把 status 改终态、started 被忽略 → worker:started 不 emit →
   *  spawnWorker.waitForWorkerStart 超时杀活进程。且 started 被丢同样会导致 spawn 超时。 */
  p0: WorkerMessage[];
  /** P1 - 重要：usage/bus_message */
  p1: WorkerMessage[];
  /** P2 - 一般：progress */
  p2: WorkerMessage[];
  /** P3 - 可丢：heartbeat/event 流式 chunk */
  p3: WorkerMessage[];
  /** drain 是否已 schedule（避免重复 setImmediate） */
  scheduled: boolean;
  /** 累计丢弃数（用于诊断） */
  droppedCount: number;
}

const P0_TYPES = new Set<WorkerMessage['type']>(['started', 'complete', 'failed', 'error']);
const P1_TYPES = new Set<WorkerMessage['type']>(['usage', 'bus_message']);
const P2_TYPES = new Set<WorkerMessage['type']>(['progress']);
// 'heartbeat' / 'event' 默认 P3（最可丢）

function classifyPriority(type: WorkerMessage['type']): 'p0' | 'p1' | 'p2' | 'p3' {
  if (P0_TYPES.has(type)) return 'p0';
  if (P1_TYPES.has(type)) return 'p1';
  if (P2_TYPES.has(type)) return 'p2';
  return 'p3';
}

export class IPCDrainQueue {
  private queues = new Map<string, WorkerQueue>();
  private readonly batchSize: number;
  private readonly maxQueueSize: number;
  private readonly consume: (workerId: string, msg: WorkerMessage) => void;
  private destroyed = false;

  constructor(options: IPCDrainQueueOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.maxQueueSize = options.maxQueueSize ?? 5000;
    this.consume = options.consume;
  }

  /** O(1) push — 仅追加到 per-worker bucket，必要时 schedule drain */
  push(workerId: string, msg: WorkerMessage): void {
    if (this.destroyed) return;
    let queue = this.queues.get(workerId);
    if (!queue) {
      queue = { p0: [], p1: [], p2: [], p3: [], scheduled: false, droppedCount: 0 };
      this.queues.set(workerId, queue);
    }

    const priority = classifyPriority(msg.type);
    queue[priority].push(msg);

    // 背压：超过队列上限时按 p3 → p2 → p1 顺序丢弃
    const total = queue.p0.length + queue.p1.length + queue.p2.length + queue.p3.length;
    if (total > this.maxQueueSize) {
      let overflow = total - this.maxQueueSize;
      for (const tier of ['p3', 'p2', 'p1'] as const) {
        if (overflow <= 0) break;
        const dropped = queue[tier].splice(0, Math.min(queue[tier].length, overflow));
        overflow -= dropped.length;
        queue.droppedCount += dropped.length;
      }
      if (queue.droppedCount % 100 === 0 || overflow > 0) {
        coreLogger.warn(`[IPCDrainQueue] worker=${workerId} dropped=${queue.droppedCount} (back-pressure)`);
      }
    }

    if (!queue.scheduled) {
      queue.scheduled = true;
      setImmediate(() => this.drain(workerId));
    }
  }

  /** 异步分批消费，让出 event loop */
  private drain(workerId: string): void {
    const queue = this.queues.get(workerId);
    if (!queue) return;

    let processed = 0;
    while (processed < this.batchSize) {
      const msg = this.shift(queue);
      if (!msg) break;
      try {
        this.consume(workerId, msg);
      } catch (err) {
        coreLogger.error(`[IPCDrainQueue] consume threw for worker=${workerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      processed++;
    }

    const remaining = queue.p0.length + queue.p1.length + queue.p2.length + queue.p3.length;
    if (remaining > 0) {
      // 还有积压，下一个 tick 继续 drain — 让出 event loop 给其它 worker 和定时器
      setImmediate(() => this.drain(workerId));
    } else {
      queue.scheduled = false;
    }
  }

  /** 从 p0 → p3 顺序取出第一个非空消息 */
  private shift(queue: WorkerQueue): WorkerMessage | undefined {
    if (queue.p0.length) return queue.p0.shift();
    if (queue.p1.length) return queue.p1.shift();
    if (queue.p2.length) return queue.p2.shift();
    if (queue.p3.length) return queue.p3.shift();
    return undefined;
  }

  /** 移除某个 worker 的整个队列（worker 退出后调用） */
  remove(workerId: string): void {
    // A6: 防御性 drain-before-clear——即使调用方漏调 drainAllSync,remove 也不丢弃 pending
    // complete 消息(否则 worker:exit 把丢掉的 complete 当崩溃重复恢复重派,Bug5)。
    // drainAllSync 在队列已空时为 no-op,故已先 drain 的调用方不会双重消费。
    this.drainAllSync(workerId);
    this.queues.delete(workerId);
  }

  /**
   * 同步排干某 worker 的全部剩余消息（worker 退出时调用）。
   *
   * 必要性：进程 'exit' 可能在最后一条 'complete' 被 setImmediate drain 之前触发。
   * 若此时 remove() 直接清队列，pending 的 complete 被丢弃 → worker:exit 把它当崩溃
   * 重复恢复重派（Bug5 / complete 丢失）。退出前先同步排干，保证 complete 被处理
   * （置位 completionReceived），再由调用方 remove 清空队列。
   */
  drainAllSync(workerId: string): void {
    const queue = this.queues.get(workerId);
    if (!queue) return;
    queue.scheduled = false;
    let msg: WorkerMessage | undefined;
    while ((msg = this.shift(queue))) {
      try {
        this.consume(workerId, msg);
      } catch (err) {
        coreLogger.error(`[IPCDrainQueue] drainAllSync consume threw for worker=${workerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** 诊断：暴露每个 worker 的队列状态 */
  private getMetrics(): Array<{ workerId: string; backlog: number; dropped: number; perTier: { p0: number; p1: number; p2: number; p3: number } }> {
    const out: Array<{ workerId: string; backlog: number; dropped: number; perTier: { p0: number; p1: number; p2: number; p3: number } }> = [];
    for (const [workerId, queue] of this.queues) {
      const backlog = queue.p0.length + queue.p1.length + queue.p2.length + queue.p3.length;
      out.push({
        workerId,
        backlog,
        dropped: queue.droppedCount,
        perTier: { p0: queue.p0.length, p1: queue.p1.length, p2: queue.p2.length, p3: queue.p3.length },
      });
    }
    return out;
  }

  destroy(): void {
    this.destroyed = true;
    this.queues.clear();
  }
}
