import type { DatabaseManager } from '../../core/Database.js';
import type { EventEmitter, EventName } from '../../core/EventEmitter.js';
import { agentLogger } from '../../core/Log.js';

export interface WorkerLifecycleOptions {
  maxRespawnsPerMinute?: number;
  now?: () => number;
}

export interface WorkerHealth {
  workerId: string;
  healthy: boolean;
  lastHeartbeat: number;
  crashCount: number;
}

/**
 * 宿主上下文：Worker 终止路径所需的最小依赖面。
 *
 * AgentPool 把自身这些字段/方法以结构化对象交给子模块，避免子模块反向持有整个
 * 巨类的引用。所有成员都是确定性的方法/只读引用 —— 不做关键词匹配、阈值猜测、
 * confidence 打分。
 */
export interface AgentHandleLike {
  agentId: string;
  name: string;
  roleType: string;
  taskId: string;
  status: 'starting' | 'running' | 'stopped';
  interactiveRuntime?: {
    setStatus(status: string): void;
    clearQueuedMessages(): void;
    clearAllToolOutputs(): void;
    getSnapshot(): unknown;
  };
  iteration?: number;
}

export interface TerminationHostContext {
  readonly sessionId: string;
  readonly db: DatabaseManager;
  readonly emitter: EventEmitter;
  forceStopAgent(
    handle: AgentHandleLike,
    exitReason: 'completed' | 'failed' | 'timeout' | 'crashed' | 'terminated',
    reason?: string,
  ): void;
  cleanupWorkerInboxBridge(handle: AgentHandleLike): void;
  emitInteractiveRuntimeState(handle: AgentHandleLike | undefined): void;
  releaseHeavyResources(handle: AgentHandleLike): void;
  emitAgentEvent<T extends EventName>(
    handle: AgentHandleLike,
    kind: T,
    extra: Record<string, unknown>,
  ): void;
}

export class WorkerLifecycle {
  private readonly now: () => number;
  private readonly maxRespawnsPerMinute: number;
  private readonly health = new Map<string, WorkerHealth>();
  private readonly crashTimes = new Map<string, number[]>();
  private host: TerminationHostContext | null = null;

  constructor(options: WorkerLifecycleOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRespawnsPerMinute = Math.max(1, options.maxRespawnsPerMinute ?? 3);
  }

  /** AgentPool 注入宿主上下文（构造期完成，运行期不变）。 */
  bindHost(context: TerminationHostContext): void {
    this.host = context;
  }

  markHeartbeat(workerId: string): WorkerHealth {
    const current = this.health.get(workerId) ?? {
      workerId,
      healthy: true,
      lastHeartbeat: 0,
      crashCount: 0,
    };
    current.healthy = true;
    current.lastHeartbeat = this.now();
    this.health.set(workerId, current);
    return current;
  }

  recordCrash(workerId: string): WorkerHealth {
    const current = this.health.get(workerId) ?? {
      workerId,
      healthy: true,
      lastHeartbeat: 0,
      crashCount: 0,
    };
    current.healthy = false;
    current.crashCount += 1;
    this.health.set(workerId, current);
    const cutoff = this.now() - 60_000;
    const crashes = (this.crashTimes.get(workerId) ?? []).filter((timestamp) => timestamp >= cutoff);
    crashes.push(this.now());
    this.crashTimes.set(workerId, crashes);
    return current;
  }

  canRespawn(workerId: string): boolean {
    const cutoff = this.now() - 60_000;
    const crashes = (this.crashTimes.get(workerId) ?? []).filter((timestamp) => timestamp >= cutoff);
    this.crashTimes.set(workerId, crashes);
    return crashes.length < this.maxRespawnsPerMinute;
  }

  getHealth(workerId: string): WorkerHealth | undefined {
    return this.health.get(workerId);
  }

  /**
   * 执行 worker 终止语义：强制 stop → 清交互运行时队列 → 清 inbox bridge →
   * emit 状态 → 释放重型资源 → 持久化 agent_state(interrupted) → emit agent:terminated。
   *
   * 终止顺序敏感（并发路径核心保护）：原 AgentPool.markAgentTerminated 的调用顺序
   * 原样下沉，host 方法逐字对应原实现，仅把 `this.xxx(...)` 改成 `host.xxx(...)`。
   */
  markTerminated(handle: AgentHandleLike, reason: string): void {
    const host = this.requireHost();
    host.forceStopAgent(handle, 'terminated', reason);
    handle.interactiveRuntime?.setStatus('terminated');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    host.cleanupWorkerInboxBridge(handle);
    host.emitInteractiveRuntimeState(handle);
    // 最终 emit 后立即释放重型资源
    host.releaseHeavyResources(handle);

    try {
      host.db.saveAgentState?.({
        session_id: host.sessionId,
        agent_id: handle.agentId,
        agent_name: handle.name,
        agent_role: handle.roleType,
        task_id: handle.taskId,
        status: 'interrupted',
        stopped: 1,
        iteration: handle.iteration || 0,
        timestamp: Date.now() / 1000,
      });
    } catch (err) {
      agentLogger.warn(`[AgentPool] saveAgentState(terminated) 失败 (${handle.name}): ${err instanceof Error ? err.message : String(err)}`);
    }

    host.emitAgentEvent(handle, 'agent:terminated', {
      status: 'stopped',
      reason,
    });
  }

  private requireHost(): TerminationHostContext {
    if (!this.host) {
      throw new Error('WorkerLifecycle host not bound');
    }
    return this.host;
  }
}

export default WorkerLifecycle;
