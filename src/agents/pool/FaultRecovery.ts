import type { DatabaseManager } from '../../core/Database.js';
import type { TaskBoard, Task as BoardTask } from '../../core/TaskBoard.js';
import type { EventEmitter } from '../../core/EventEmitter.js';
import type { AgentRoleRegistry } from '../RoleRegistry.js';
import type { AgentRole } from '../RoleRegistry.js';
import {
  getRecoveryRecord,
  saveRecoveryRecord,
  type RecoveryFaultClass,
  type RuntimeRecoveryRecord,
} from '../../core/RecoveryRecords.js';
import { applyRecoveryAttemptBudget, classifyAutonomousFault } from '../../core/AutonomousFaultPolicy.js';
import type { LLMErrorKind } from '../../llm/errors.js';
import {
  createWorkerRecoveryPayload,
  type WorkerRecoveryPayload,
} from '../../core/AgentProtocol.js';
import type { TaskCompletePayload, TaskFailedPayload } from '../../core/AgentProtocol.js';
import { agentLogger } from '../../core/Log.js';

export type FaultClass = 'timeout' | 'crash' | 'protocol' | 'network' | 'unknown';
export type RecoveryAction = 'retry' | 'respawn' | 'requeue' | 'fail';

// A8: 恢复重试指数退避基址与封顶。系统性崩溃的 worker 若立即重试 → spawn+LLM 风暴
// (maxRecoveryAttempts 次无间隔连发)。按 attempt 退避:1s/2s/4s/8s...封顶 30s。
const RECOVERY_BACKOFF_BASE_MS = 1_000;
const RECOVERY_BACKOFF_MAX_MS = 30_000;

export interface RecoveryDecision {
  fault: FaultClass;
  action: RecoveryAction;
  reason: string;
}

/**
 * 恢复执行路径所需的 handle 最小面（结构化，对应 AgentHandle 的子集）。
 */
export interface RecoveryHandleLike {
  agentId: string;
  name: string;
  roleType: string;
  taskId: string;
  status: 'starting' | 'running' | 'stopped';
  iteration?: number;
  startTime: number;
  lastProgress?: number;
  taskRunGeneration?: number;
  recoveryLineage?: number;
  asyncTask?: Promise<string>;
  runtimeRole?: AgentRole;
  interactiveRuntime?: {
    setStatus(status: string): void;
    clearQueuedMessages(): void;
    clearAllToolOutputs(): void;
    getSnapshot(): unknown;
  };
  respawnTimestampsMs?: number[];
  consecutiveRespawnFailures?: number;
}

/** 诊断载荷 —— 直接复用 WorkerRecoveryPayload 的契约类型（结构化，不重定义避免漂移）。 */
export type RecoveryDiagnostics = NonNullable<WorkerRecoveryPayload['diagnostics']>;

export interface AgentRespawnOptionsLike {
  failureMode?: 'task_failed' | 'recovery';
}

/**
 * 宿主上下文：恢复执行体所需的最小依赖面（确定性结构，无启发式）。
 * AgentPool 把自身这些字段/方法交给子模块。
 */
export interface RecoveryHostContext {
  readonly sessionId: string;
  readonly db: DatabaseManager;
  readonly taskBoard: TaskBoard;
  readonly roleRegistry: AgentRoleRegistry;
  readonly emitter: EventEmitter;
  readonly autoRetryRecoveries: boolean;
  readonly maxRecoveryAttempts: number;
  /** 给 agent name 加会话前缀（MessageBus 寻址）。 */
  sp(name: string): string;
  getTaskRunGeneration(handle: RecoveryHandleLike): number;
  forceStopAgent(
    handle: RecoveryHandleLike,
    exitReason: 'completed' | 'failed' | 'timeout' | 'crashed' | 'terminated',
    reason?: string,
  ): void;
  cleanupWorkerInboxBridge(handle: RecoveryHandleLike): void;
  emitInteractiveRuntimeState(handle: RecoveryHandleLike | undefined): void;
  releaseHeavyResources(handle: RecoveryHandleLike): void;
  /**
   * 释放仍 claim 指定 task 的 active handle（转终态 + 回收资源）。
   * 用于恢复失败路径解绑任务时同步清理 pool 侧，避免 board「无主」与 pool「active 占用」desync。
   */
  releaseHandleForTask(taskId: string, reason?: string): boolean;
  sendCriticalBusMessageToLeader(
    from: string,
    type: 'task_complete' | 'task_failed' | 'worker_recovery',
    payload: TaskCompletePayload | TaskFailedPayload | WorkerRecoveryPayload,
  ): void;
  respawnAgent(
    handle: RecoveryHandleLike,
    task: BoardTask,
    leaderMessage?: string,
    options?: AgentRespawnOptionsLike,
  ): Promise<string>;
}

export class FaultRecovery {
  private host: RecoveryHostContext | null = null;

  /** AgentPool 注入宿主上下文（构造期完成，运行期不变）。 */
  bindHost(context: RecoveryHostContext): void {
    this.host = context;
  }

  classify(error: unknown): FaultClass {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout';
    if (/ECONNRESET|EPIPE|network|socket/i.test(message)) return 'network';
    if (/protocol|contract|invalid payload/i.test(message)) return 'protocol';
    if (/crash|exit|SIGKILL|SIGTERM/i.test(message)) return 'crash';
    return 'unknown';
  }

  decide(error: unknown, attempts: number): RecoveryDecision {
    const fault = this.classify(error);
    if (fault === 'protocol') {
      return { fault, action: 'fail', reason: 'protocol errors need corrected worker output' };
    }
    if (attempts <= 0) {
      return { fault, action: 'fail', reason: 'retry budget exhausted' };
    }
    if (fault === 'network' || fault === 'timeout') {
      return { fault, action: 'retry', reason: 'transient worker failure' };
    }
    if (fault === 'crash') {
      return { fault, action: 'respawn', reason: 'worker process crashed' };
    }
    return { fault, action: 'requeue', reason: 'unknown failure should move task to another worker' };
  }

  /**
   * 标记 agent 进入恢复态：强制 stop → 清交互运行时 → 清 inbox bridge →
   * emit 状态 → 计算 attempt/lineId → 应用预算决策 → 持久化 recoveryRecord →
   * 构造 payload → critical bus 通知 leader → emit recovery:changed →
   * 尝试自动重试（否则释放重型资源）。
   *
   * 调用顺序与原 AgentPool.markAgentRecovering 原样下沉，逐字对应。
   */
  markRecovering<H extends RecoveryHandleLike>(
    handle: H,
    faultClass: RecoveryFaultClass,
    reason: string,
    diagnostics?: RecoveryDiagnostics,
    llmErrorKind?: LLMErrorKind,
  ): WorkerRecoveryPayload {
    const host = this.requireHost();
    const exitReason: 'timeout' | 'crashed' =
      faultClass === 'worker_heartbeat_timeout' ||
      faultClass === 'worker_max_runtime' ||
      faultClass === 'external_agent_timeout'
        ? 'timeout'
        : 'crashed';
    host.forceStopAgent(handle, exitReason, reason);
    handle.interactiveRuntime?.setStatus('failed');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    host.cleanupWorkerInboxBridge(handle);
    // 同 worker:complete —— 不在失败/崩溃时 detachFromTeam，保留 team 成员注册记录。
    host.emitInteractiveRuntimeState(handle);
    const taskRunGeneration = host.getTaskRunGeneration(handle);
    const previous = getRecoveryRecord(host.db, host.sessionId, handle.taskId);
    const attempt = (previous?.attempt || 0) + 1;
    const lineId = previous?.lineId || `${handle.agentId}:${handle.taskId}`;
    const decision = applyRecoveryAttemptBudget(
      classifyAutonomousFault({ reason, faultClass, llmErrorKind }),
      attempt,
      host.maxRecoveryAttempts,
    );
    handle.recoveryLineage = attempt;
    const recoveryRecord: RuntimeRecoveryRecord = {
      sessionId: host.sessionId,
      taskId: handle.taskId,
      agentId: handle.agentId,
      agentName: handle.name,
      roleType: handle.roleType,
      category: decision.category,
      faultClass,
      status: decision.status,
      reason: decision.reason,
      recoveryAction: decision.recoveryAction,
      attempt,
      lineId,
      lastActivityAt: handle.lastProgress ?? handle.startTime,
      timestamp: Date.now() / 1000,
    };
    try {
      saveRecoveryRecord(host.db, recoveryRecord);
    } catch (err) {
      agentLogger.error(`[AgentPool] saveRecoveryRecord failed (${handle.name}/${handle.taskId}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const recoveryPayload = createWorkerRecoveryPayload({
      kind: 'worker_recovery',
      taskId: handle.taskId,
      taskRunGeneration,
      agentId: handle.agentId,
      agentName: handle.name,
      roleType: handle.roleType,
      category: decision.category,
      faultClass,
      ...(llmErrorKind ? { llmErrorKind } : {}),
      status: decision.status,
      recoveryAction: decision.recoveryAction,
      reason: decision.reason,
      attempt,
      lineId,
      lastActivityAt: recoveryRecord.lastActivityAt,
      ...(diagnostics ? { diagnostics } : {}),
    });

    // 先决定是否自主重派，再把结果写进 payload 发给 Leader —— Leader 的 directive 才能
    // 准确反映「系统已自动重派，验证勿重复 dispatch」。原顺序是先发再重派，Leader 拿不到
    // 这个布尔，会对已被自主恢复接管的事件重复判读 / 冗余 redispatch（"干扰 leader" 根因）。
    // maybeAutoRetryRecoveringWorker 的门控只读 recovery.status/recoveryAction/attempt 等，
    // 已由上方 decision/attempt 算好，不依赖是否已发送，故提前调用安全。
    const autoRetryStarted = this.maybeAutoRetryRecoveringWorker(handle, recoveryPayload);
    recoveryPayload.autoRetryScheduled = autoRetryStarted;

    // 系统已自主重派（autoRetryStarted=true）时【不】向 Leader 投递 P0 worker_recovery。
    // 这是「agent 一出事就乱激活 leader」噪声的根因：每条 worker_recovery 都是 P0_CRITICAL，
    // 会硬唤醒 Leader 跑一整轮 think（一次 LLM 调用），即便系统已自愈、Leader 跑完只能得出
    // 「无需我动」。自主恢复由系统接管，Leader 通过持久化 recoveryRecord 懒感知，并在 respawn
    // worker 最终 task_complete（P0）或恢复预算耗尽（attempt 达 max → leader_takeover →
    // autoRetryStarted=false → 此处照常唤醒）时被适时唤醒。仅 leader_takeover / blocked /
    // 不可恢复 / 无自主重派路径才 P0 唤醒。runtime_recovery:changed emit（UI）仍无条件触发。
    if (!autoRetryStarted) {
      host.sendCriticalBusMessageToLeader(
        host.sp(handle.name),
        'worker_recovery',
        recoveryPayload,
      );
    }

    host.emitter.emit('runtime_recovery:changed', {
      sessionId: host.sessionId,
      action: 'saved',
      record: recoveryPayload,
    });

    if (!autoRetryStarted) {
      host.releaseHeavyResources(handle);
    }
    return recoveryPayload;
  }

  /**
   * 自动重试恢复中的 worker：满足前置条件 → prepareTaskForRedispatch →
   * assignTask → respawnAgent → emit auto_retry_started → 失败回退 markRecoveryAutoRetryFailed。
   *
   * 调用顺序与原 AgentPool.maybeAutoRetryRecoveringWorker 原样下沉。
   */
  maybeAutoRetryRecoveringWorker<H extends RecoveryHandleLike>(
    handle: H,
    recovery: WorkerRecoveryPayload,
  ): boolean {
    const host = this.requireHost();
    if (!host.autoRetryRecoveries) {
      return false;
    }
    if (
      recovery.status !== 'recovering' ||
      (recovery.recoveryAction !== 'worker_restart' && recovery.recoveryAction !== 'worker_redispatch')
    ) {
      return false;
    }
    if (recovery.attempt >= host.maxRecoveryAttempts) {
      return false;
    }
    if (recovery.faultClass.startsWith('external_agent_')) {
      return false;
    }
    const role = handle.runtimeRole || host.roleRegistry.get(handle.roleType);
    if (role?.worker_backend && role.worker_backend !== 'worker_process') {
      return false;
    }

    const task = host.taskBoard.getTask(recovery.taskId);
    if (!task || task.status === 'terminal') {
      return false;
    }

    try {
      host.taskBoard.prepareTaskForRedispatch(recovery.taskId, `[recovering] ${recovery.reason}`);
      const dispatchableTask = host.taskBoard.getTask(recovery.taskId) || task;
      if (dispatchableTask.status === 'dispatchable') {
        const assignedTask = host.taskBoard.assignTask(recovery.taskId, handle.name);
        if (assignedTask) {
          handle.taskRunGeneration = assignedTask.runGeneration;
        }
      }

      const retryTask = host.taskBoard.getTask(recovery.taskId) || dispatchableTask;
      if (retryTask.status !== 'running' || retryTask.assigned_agent !== handle.name) {
        throw new Error(`recovery auto retry could not assign task ${recovery.taskId} to @${handle.name}`);
      }
      // A8: 按 attempt 指数退避(1s/2s/4s...封顶 30s),防止系统性崩溃的 worker 被立即连发重试
      // 形成 spawn+LLM 风暴。delay 期间 handle.asyncTask 占位,handle 视为 busy。
      const backoffMs = Math.min(
        RECOVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, recovery.attempt - 1),
        RECOVERY_BACKOFF_MAX_MS,
      );
      const respawnPromise: ReturnType<typeof host.respawnAgent> = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          host.respawnAgent(
            handle,
            retryTask,
            `[RECOVERY:${recovery.faultClass}] ${recovery.reason}`,
            { failureMode: 'recovery' },
          ).then(resolve, reject);
        }, backoffMs);
        timer.unref?.();
      });
      handle.asyncTask = respawnPromise;
      agentLogger.info(`[AgentPool] recovery auto retry scheduled @${handle.name} attempt=${recovery.attempt} backoff=${backoffMs}ms`);
      host.emitter.emit('runtime_recovery:changed', {
        sessionId: host.sessionId,
        action: 'auto_retry_started',
        taskId: recovery.taskId,
        record: recovery,
      });
      void respawnPromise.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        agentLogger.warn(`[AgentPool] recovery auto retry failed (@${handle.name}/${recovery.taskId}): ${message}`);
        this.markAutoRetryFailed(recovery, message);
        host.releaseHeavyResources(handle);
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentLogger.warn(`[AgentPool] recovery auto retry scheduling failed (@${handle.name}/${recovery.taskId}): ${message}`);
      this.markAutoRetryFailed(recovery, message);
      host.releaseHeavyResources(handle);
      return false;
    }
  }

  /**
   * 自动重试失败：读 current → 写 leader_takeover recoveryRecord → 必要时
   * prepareTaskForRedispatch → 构造 payload → emit auto_retry_failed。
   *
   * 调用顺序与原 AgentPool.markRecoveryAutoRetryFailed 原样下沉。
   */
  markAutoRetryFailed(recovery: WorkerRecoveryPayload, reason: string): void {
    const host = this.requireHost();
    const current = getRecoveryRecord(host.db, host.sessionId, recovery.taskId);
    const record: RuntimeRecoveryRecord = {
      sessionId: host.sessionId,
      taskId: recovery.taskId,
      agentId: current?.agentId ?? recovery.agentId,
      agentName: current?.agentName ?? recovery.agentName,
      roleType: current?.roleType ?? recovery.roleType,
      category: current?.category ?? recovery.category,
      faultClass: current?.faultClass ?? recovery.faultClass,
      status: 'recovering',
      reason: `auto retry failed: ${reason}; original recovery: ${current?.reason ?? recovery.reason}`,
      recoveryAction: 'leader_takeover',
      attempt: current?.attempt ?? recovery.attempt,
      lineId: current?.lineId ?? recovery.lineId,
      lastActivityAt: current?.lastActivityAt ?? recovery.lastActivityAt,
      timestamp: Date.now() / 1000,
    };
    try {
      saveRecoveryRecord(host.db, record);
    } catch (err) {
      agentLogger.error(`[AgentPool] saveRecoveryRecord(auto_retry_failed) failed (${recovery.taskId}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const task = host.taskBoard.getTask(recovery.taskId);
    if (task && task.status !== 'terminal' && (task.status !== 'dispatchable' || task.assigned_agent)) {
      host.taskBoard.prepareTaskForRedispatch(recovery.taskId, `[recovery_auto_retry_failed] ${reason}`);
    }
    // 恢复已确认失败（无成功 respawn 在途）：释放仍 claim 该 task 的 active handle，
    // 否则 board 解绑后 pool 侧残留 active handle 会与 board「无主」desync，任务进死区
    // （dispatch 判占用、force_complete 判未分配，谁都动不了）。
    host.releaseHandleForTask(recovery.taskId, `[recovery_auto_retry_failed] ${reason}`);
    const payload = createWorkerRecoveryPayload({
      kind: 'worker_recovery',
      taskId: record.taskId,
      agentId: record.agentId,
      agentName: record.agentName,
      roleType: record.roleType,
      category: record.category,
      faultClass: record.faultClass,
      status: record.status,
      recoveryAction: record.recoveryAction,
      reason: record.reason,
      attempt: record.attempt,
      lineId: record.lineId,
      lastActivityAt: record.lastActivityAt,
    });
    // auto-retry 已确认失败 → 明确告知 Leader 需接管（autoRetryScheduled=false）
    payload.autoRetryScheduled = false;
    host.emitter.emit('runtime_recovery:changed', {
      sessionId: host.sessionId,
      action: 'auto_retry_failed',
      taskId: recovery.taskId,
      record: payload,
      reason,
    });
    // leader_takeover 必须 P0 唤醒 Leader：auto-retry 已失败、系统无能为力，任务被
    // prepareTaskForRedispatch 设回 dispatchable，若不唤醒 Leader 则既不被自动重派、也不被
    // Leader 接手 → 永远卡 dispatchable → runtimeImpliesBusy 永真 → 前端永远 processing。
    // 与 markRecovering 的 !autoRetryStarted 分支对称：凡需 Leader 介入的恢复结果都 P0 唤醒。
    host.sendCriticalBusMessageToLeader(
      host.sp(record.agentName ?? recovery.agentName),
      'worker_recovery',
      payload,
    );
  }

  private requireHost(): RecoveryHostContext {
    if (!this.host) {
      throw new Error('FaultRecovery host not bound');
    }
    return this.host;
  }
}

export default FaultRecovery;
