/**
 * WorkerEventHandlerBinder
 *
 * 从 AgentPoolRuntime 抽出的事件路由层。负责把 worker 进程事件
 * (setupWorkerEventHandlers) 和交互运行时事件 (setupInteractiveRuntimeEventHandlers)
 * 绑定到对应的处理回调。
 *
 * 设计原则：纯路由——事件集合与原实现完全一致（不丢不增），所有副作用都通过 host
 * 绑定委托回 AgentPoolRuntime，本模块不持有自有状态、不做启发式判断。
 *
 * 依赖以「host 绑定对象」形式注入（参照 AgentPoolBroadcast 的既定模式），
 * 避免循环依赖、避免改 AgentPoolRuntime 成员可见性。
 */

import type { EventEmitter, EventName, EventMap } from '../../core/EventEmitter.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { DatabaseManager } from '../../core/Database.js';
import type { TaskBoard } from '../../core/TaskBoard.js';
import type { TokenTracker } from '../BaseAgentRuntime.js';
import { langfuseIntegration } from '../../core/LangfuseIntegration.js';
import type {
  WorkerProcessRunner,
  WorkerBusEnvelope,
  WorkerEventEnvelope,
  WorkerUsageEnvelope,
  WorkerProcessDiagnostics,
} from '../../core/WorkerProcessRunner.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';
import type { StructuredCompletionPayload } from './AgentPoolCompletionPayload.js';
import type { WorkNote } from '../../core/WorkNoteManager.js';
import type {
  WorkerContractComplianceProof,
  WorkerRecoveryPayload,
} from '../../core/AgentProtocol.js';
import type { RecoveryFaultClass } from '../../core/RecoveryRecords.js';
import type { LLMErrorKind } from '../../llm/errors.js';
import type { SpeculativeWinnerEvidence } from '../../core/SpeculativeExecutionController.js';

import { isBusMessageType } from '../../core/BusMessageTypes.js';
import {
  createTaskCompletePayload,
} from '../../core/AgentProtocol.js';
import {
  emitAgentSpawned as emitAgentSpawnedEvent,
} from './AgentPoolEvents.js';
import { agentLogger } from '../../core/Log.js';
import {
  isAgentRuntimeActiveStatus,
  isCoreWorkerTerminalStatus,
  normalizeTerminalSessionStatus,
} from '../../contracts/adapters/StatusAdapter.js';

/**
 * AgentPoolRuntime 通过该对象把 binder 所需的全部能力注入进来。
 * 每个字段对应原方法体里的一处 `this.X` 引用，逐字面搬运、不改语义。
 */
export interface WorkerEventHandlerHost {
  sessionId: string;
  agents: Map<string, AgentHandle>;
  workerRunner: WorkerProcessRunner;
  emitter: EventEmitter;
  bus: MessageBus;
  db: DatabaseManager;
  tracker: TokenTracker;
  taskBoard: TaskBoard;
  interactiveStateUnsubscribers: Array<() => void>;

  /** 给任意 agent name 加上本会话前缀（原 this.sp）。 */
  sp(name: string): string;

  /** WorkerLifecycle 协作（原 this.workerLifecycle）。 */
  workerLifecycle: {
    markHeartbeat(workerId: string): unknown;
    recordCrash(workerId: string): unknown;
  };

  /** FaultRecovery 协作（原 this.faultRecovery.decide）。 */
  faultRecovery: {
    decide(error: Error, maxAttempts: number): unknown;
  };

  /** 原 AgentPool.transitionAgentStatus —— 静态状态迁移，纯函数。 */
  transitionAgentStatus(handle: AgentHandle, newStatus: 'starting' | 'running' | 'stopped'): void;

  /** 原 AgentPool.MAX_RECOVERY_ATTEMPTS。 */
  maxRecoveryAttempts: number;

  /** 原 AgentPoolRuntime 模块级 parseWorkerFailurePayload（worker:failed 逃逸口解析）。 */
  parseWorkerFailurePayload(error: unknown): {
    error: Error;
    recoverable: boolean;
    terminalKind?: string;
    faultClass?: RecoveryFaultClass;
    llmErrorKind?: LLMErrorKind;
    reason: string;
  };

  // —— 下列方法签名逐字搬自 AgentPoolRuntime，签名保持不变 ——
  getById(agentId: string): AgentHandle | undefined;
  getByName(name: string): AgentHandle | undefined;
  getTaskRunGeneration(handle: AgentHandle): number;
  parseWorkerCompletionPayload(payload: unknown): {
    result: string;
    stats: { iterations: number; toolCalls: number };
    tokenUsage?: { total?: number; prompt?: number; completion?: number };
    summary?: string;
    artifacts?: { files_created?: string[]; files_modified?: string[]; commands_run?: string[] };
    verification?: Array<{ kind: string; detail: string; passed?: boolean }>;
    next_steps?: string[];
    blocked_by_discovery?: string[];
    needs_leader_coordination?: boolean;
    evidence_refs?: string[];
    contract_compliance?: WorkerContractComplianceProof;
    toolTrace?: { files_created?: string[]; files_modified?: string[]; commands_run?: string[] };
    speculativeWinner?: SpeculativeWinnerEvidence;
  };
  buildWorkerFailureDiagnostics(
    handle: AgentHandle,
    runnerDiagnostics?: WorkerProcessDiagnostics,
  ): WorkerRecoveryPayload['diagnostics'];
  clearRecoveryRecordAndNotify(taskId: string): void;
  applyWorkerOutputToBlackboard(taskId: string, output: unknown): void;
  broadcastWorkNoteAwareness(note: WorkNote, sourceAgentId: string): number;
  cleanupWorkerInboxBridge(handle: AgentHandle): void;
  emitInteractiveRuntimeState(handle: AgentHandle | undefined): void;
  emitAgentEvent<T extends EventName>(handle: AgentHandle, kind: T, extra: Partial<EventMap[T]>): void;
  markAgentRecovering(
    handle: AgentHandle,
    faultClass: RecoveryFaultClass,
    reason: string,
    diagnostics?: WorkerRecoveryPayload['diagnostics'],
    llmErrorKind?: LLMErrorKind,
  ): WorkerRecoveryPayload;
  markAgentFailed(handle: AgentHandle, error: Error, source?: string): void;
  markAgentTerminated(handle: AgentHandle, reason: string): void;
  forceStopAgent(
    handle: AgentHandle,
    exitReason: NonNullable<AgentHandle['exitReason']>,
    reason?: string,
  ): void;
  recordTaskResultPendingAcceptance(
    handle: AgentHandle,
    result: string,
    completion?: StructuredCompletionPayload,
  ): void;
  releaseHeavyResources(handle: AgentHandle): void;
  sendCriticalBusMessageToLeader(
    from: string,
    type: 'task_complete' | 'task_failed' | 'worker_recovery',
    payload: unknown,
  ): void;
}

/**
 * 事件绑定器。构造后调用两个 setup* 方法完成全部事件订阅。
 */
export class WorkerEventHandlerBinder {
  constructor(private readonly host: WorkerEventHandlerHost) {}

  /**
   * 1.3: 设置 Worker 事件处理器，将 Worker 事件转发到 Leader
   */
  setupWorkerEventHandlers(): void {
    const h = this.host;
    const markHandleProgress = (handle: AgentHandle | undefined): void => {
      if (!handle) return;
      handle.lastProgress = Date.now();
    };
    const markHandleHeartbeat = (handle: AgentHandle | undefined): void => {
      if (!handle) return;
      handle.lastHeartbeat = Date.now();
      h.workerLifecycle.markHeartbeat(handle.name);
    };

    h.workerRunner.on('worker:started', (workerId: string) => {
      const handle = h.agents.get(workerId);
      if (handle) {
        h.transitionAgentStatus(handle, 'running');
        handle.interactiveRuntime?.setStatus('running');
        markHandleProgress(handle);
        markHandleHeartbeat(handle);
        h.emitInteractiveRuntimeState(handle);
        emitAgentSpawnedEvent({ emitter: h.emitter, sessionId: h.sessionId, taskBoard: h.taskBoard, handle });
        h.emitAgentEvent(handle, 'agent:started', {
          name: workerId,
        });
        // Langfuse agent lifecycle tracing (non-fatal, fire-and-forget)
        langfuseIntegration.recordAgentLifecycle({
          event: 'started',
          agentId: handle.agentId,
          agentName: handle.name,
          taskId: handle.taskId,
          sessionId: h.sessionId,
        }).catch(() => {});
        // Langfuse task dispatch tracing (non-fatal, fire-and-forget)
        langfuseIntegration.recordAgentLifecycle({
          event: 'task_dispatched',
          agentId: handle.agentId,
          agentName: handle.name,
          taskId: handle.taskId,
          sessionId: h.sessionId,
          metadata: {
            strategy: handle.visibility === 'ephemeral' ? 'ephemeral' : 'persistent',
            roleType: handle.roleType,
            team: handle.teamMember ?? null,
          },
        }).catch(() => {});
      }
    });

    h.workerRunner.on('worker:progress', (workerId: string, payload: unknown) => {
      const handle = h.agents.get(workerId);
      if (handle) {
        markHandleProgress(handle);
        h.emitAgentEvent(handle, 'agent:progress', { name: workerId, message: String(payload) });
      }
    });

    h.workerRunner.on('worker:heartbeat', (workerId: string, payload: unknown) => {
      const handle = h.agents.get(workerId);
      if (!handle) return;
      markHandleHeartbeat(handle);
      h.emitAgentEvent(handle, 'agent:heartbeat', {
        phase: typeof payload === 'object' && payload && 'phase' in (payload as Record<string, unknown>)
          ? String((payload as Record<string, unknown>).phase || '')
          : undefined,
        timestamp: Date.now(),
      });
    });

    h.workerRunner.on('worker:complete', (workerId: string, result: unknown) => {
      const handle = h.agents.get(workerId);
      if (!handle) return;
      markHandleProgress(handle);
      if (handle.status !== 'running' && handle.status !== 'starting') {
        return;
      }

      // 乱序保护（Bug5）：最先置位完成回执屏障。即便随后 payload 解析失败走
      // markAgentFailed，也已表明「worker 已投递完成回执」——后续 worker:exit
      // 的 crashed/timeout 不应再把它当崩溃重复恢复重派。必须早于解析与状态迁移置位。
      handle.completionReceived = true;

      let completion: {
        result: string;
        stats: { iterations: number; toolCalls: number };
        tokenUsage?: { total?: number; prompt?: number; completion?: number };
        summary?: string;
        verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
        artifacts?: { files_created?: string[]; files_modified?: string[]; commands_run?: string[] };
        verification?: Array<{ kind: string; detail: string; passed?: boolean }>;
        evidence_refs?: string[];
        contract_compliance?: WorkerContractComplianceProof;
        next_steps?: string[];
        blocked_by_discovery?: string[];
        needs_leader_coordination?: boolean;
        toolTrace?: { files_created?: string[]; files_modified?: string[]; commands_run?: string[] };
        speculativeWinner?: SpeculativeWinnerEvidence;
      };
      try {
        completion = h.parseWorkerCompletionPayload(result);
      } catch (error) {
        const protocolError = error instanceof Error ? error : new Error(String(error));
        h.markAgentFailed(handle, protocolError, 'protocol');
        h.emitAgentEvent(handle, 'agent:error', {
          error: protocolError,
        });
        return;
      }
      h.transitionAgentStatus(handle, 'stopped');
      handle.exitReason = 'completed';
      handle.endTime = Date.now();
      handle.recoveryLineage = undefined;
      handle.interactiveRuntime?.setStatus('completed');
      handle.interactiveRuntime?.clearQueuedMessages();
      handle.interactiveRuntime?.clearAllToolOutputs();
      h.cleanupWorkerInboxBridge(handle);
      // 不再在 worker 完成时 detachFromTeam —— 已注册的团队成员应保留到 team 生命周期结束。
      // 原逻辑会导致其他 still-running worker 调 team_message 时找不到已完成的成员
      // （registry.getByName 返回 undefined → "找不到成员（同session内未注册）"）。
      h.emitInteractiveRuntimeState(handle);

      // 先落任务/agent 状态，再唤醒 Leader。Leader 收到 task_complete 时必须已经能看到 terminal 任务态。
      const completionPayload: StructuredCompletionPayload = {
        summary: completion.summary,
        verdict: completion.verdict,
        artifacts: completion.artifacts,
        verification: completion.verification,
        evidence_refs: completion.evidence_refs,
        contract_compliance: completion.contract_compliance,
        next_steps: completion.next_steps,
        blocked_by_discovery: completion.blocked_by_discovery,
        needs_leader_coordination: completion.needs_leader_coordination,
        toolTrace: completion.toolTrace,
        speculativeWinner: completion.speculativeWinner,
        taskRunGeneration: h.getTaskRunGeneration(handle),
      };
      try {
        h.recordTaskResultPendingAcceptance(handle, completion.result, completionPayload);
        h.clearRecoveryRecordAndNotify(handle.taskId);
        h.applyWorkerOutputToBlackboard(handle.taskId, completion.result);
      } catch (err) {
        agentLogger.error(`[AgentPool] worker:complete 状态落地异常 (${workerId}): ${err instanceof Error ? err.message : String(err)}`);
      }

      // 持久化 agent_state 为 completed，带重试避免 SQLITE_BUSY 导致 DB/memory 状态不一致
      {
        const payload = {
          session_id: h.sessionId,
          agent_id: handle.agentId,
          agent_name: handle.name,
          agent_role: handle.roleType,
          task_id: handle.taskId,
          status: 'completed' as const,
          stopped: 0,
          iteration: handle.iteration || 0,
          timestamp: Date.now() / 1000,
        };
        let persisted = false;
        for (let retry = 0; retry < 3; retry++) {
          try {
            h.db.saveAgentState?.(payload);
            persisted = true;
            break;
          } catch (err) {
            if (retry < 2) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (retry + 1));
            } else {
              agentLogger.warn(`[AgentPool] saveAgentState(completed) 最终失败 (${workerId}): ${err instanceof Error ? err.message : String(err)}`);
              (handle as unknown as Record<string, unknown>).stateDirty = true;
            }
          }
        }
        void persisted;
      }

      h.sendCriticalBusMessageToLeader(h.sp(workerId), 'task_complete', createTaskCompletePayload(handle.taskId, completion.result, completionPayload));

      h.emitAgentEvent(handle, 'agent:completed', {
        result: completion.result,
        stats: completion.stats,
        tokenUsage: completion.tokenUsage,
      });
      // Langfuse agent lifecycle tracing (non-fatal, fire-and-forget)
      langfuseIntegration.recordAgentLifecycle({
        event: 'completed',
        agentId: handle.agentId,
        agentName: handle.name,
        taskId: handle.taskId,
        sessionId: h.sessionId,
        metadata: { tokenUsage: completion.tokenUsage },
      }).catch(() => {});
      // Langfuse task score (non-fatal, fire-and-forget)
      const __verdict = completion.verdict || (completion.verification?.every(v => v.passed !== false) ? 'PASS' : 'FAIL');
      langfuseIntegration.recordScore({
        taskId: handle.taskId,
        verdict: __verdict as 'PASS' | 'FAIL' | 'BLOCKED',
        score: __verdict === 'PASS' ? 1.0 : __verdict === 'BLOCKED' ? 0.5 : 0.0,
        sessionId: h.sessionId,
        agentId: handle.agentId,
        agentName: handle.name,
        metadata: { taskSubject: handle.taskId, tokenUsage: completion.tokenUsage },
      }).catch(() => {});
      // Langfuse contract verification tracing (non-fatal, fire-and-forget)
      if (completion.contract_compliance) {
        const cc = completion.contract_compliance;
        langfuseIntegration.recordAgentLifecycle({
          event: 'contract_verified',
          agentId: handle.agentId,
          agentName: handle.name,
          taskId: handle.taskId,
          sessionId: h.sessionId,
          metadata: {
            surface: cc.surface,
            status: cc.status,
            passed: cc.status === 'complied' || cc.status === 'upgraded',
            evidenceCount: cc.evidence?.length ?? 0,
            deviations: cc.deviations ?? [],
          },
        }).catch(() => {});
      }
      // 立即释放重型资源，不等 scheduleHandleCleanup 的延迟清理
      h.releaseHeavyResources(handle);
    });

    h.workerRunner.on('worker:failed', (workerId: string, error: unknown) => {
      const handle = h.agents.get(workerId);
      if (!handle) return;
      markHandleProgress(handle);
      if (handle.status !== 'running' && handle.status !== 'starting') {
        return;
      }
      try {
        const failure = h.parseWorkerFailurePayload(error);
        if (failure.terminalKind === 'terminated') {
          // Worker 报告 terminated 但 handle 仍处于 running/starting（上方 guard 已过滤 stopped）
          // → 外部 SIGTERM（daemon 重启 / OOM / 系统 kill），而非 pool 主动关停
          // （pool 主动 stop 会先 forceStopAgent 置 stopped → 上方 guard early-return）。
          // 走恢复管线而非 markAgentTerminated 死路，避免任务孤儿化（不重派 / 不通知 Leader）。
          const termDiagnostics = h.buildWorkerFailureDiagnostics(handle);
          const termRecovery = h.markAgentRecovering(handle, 'worker_crashed', failure.reason, termDiagnostics);
          h.emitAgentEvent(handle, 'agent:crashed', {
            name: workerId,
            status: 'crashed',
            recoverable: termRecovery.status === 'recovering',
            recoveryAction: termRecovery.recoveryAction,
            backend: 'worker_process',
            error: termDiagnostics?.error,
          });
          langfuseIntegration.recordAgentLifecycle({
            event: 'crashed',
            agentId: handle.agentId,
            agentName: handle.name,
            taskId: handle.taskId,
            sessionId: h.sessionId,
            metadata: { reason: failure.reason, error: termDiagnostics?.error },
          }).catch(() => {});
          return;
        }
        if (failure.recoverable) {
          const faultClass = failure.faultClass ?? 'worker_runtime';
          const diagnostics = h.buildWorkerFailureDiagnostics(handle);
          const recovery = h.markAgentRecovering(handle, faultClass, failure.reason, diagnostics, failure.llmErrorKind);
          h.emitAgentEvent(handle, 'agent:crashed', {
            name: workerId,
            status: faultClass === 'worker_stopped' ? 'stopped' : 'failed',
            recoverable: true,
            recoveryAction: recovery.recoveryAction,
            backend: 'worker_process',
            pid: diagnostics?.pid,
            exitCode: typeof diagnostics?.exitCode === 'number' ? diagnostics.exitCode : undefined,
            signal: diagnostics?.exitSignal ?? undefined,
            error: diagnostics?.error,
            timeoutReason: diagnostics?.timeoutReason,
            stderrTail: diagnostics?.stderrTail,
            stdoutTail: diagnostics?.stdoutTail,
          });
          langfuseIntegration.recordAgentLifecycle({
            event: 'failed',
            agentId: handle.agentId,
            agentName: handle.name,
            taskId: handle.taskId,
            sessionId: h.sessionId,
            metadata: { faultClass, reason: failure.reason, llmErrorKind: failure.llmErrorKind },
          }).catch(() => {});
          return;
        }
        h.faultRecovery.decide(failure.error, h.maxRecoveryAttempts);
        h.markAgentFailed(handle, failure.error, 'runtime');
      } catch (err) {
        agentLogger.error(`[AgentPool] worker:failed handler error (${workerId}): ${err instanceof Error ? err.message : String(err)}`);
        if (isAgentRuntimeActiveStatus(handle)) {
          h.forceStopAgent(handle, 'failed', `recovery infrastructure error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    h.workerRunner.on('worker:exit', (workerId: string, code: number | null, signal: string | null, status: string) => {
      const handle = h.agents.get(workerId);
      if (!handle) return;
      markHandleProgress(handle);

      // P1 修复：worker:complete 已经把 handle 标 completed 但子进程随后又因
      // 心跳/最大运行时长 watchdog 被 kill，会再走到这里发 RECOVERY_REQUIRED 与
      // recovery_record，导致 Leader 重派同任务（重复执行 + DB 状态翻转）。
      // 已收到合法 task_complete 的 worker，不再视为崩溃。
      //
      // Bug5 乱序修复：改为以 completionReceived 屏障为准，而非仅依赖 exitReason==='completed'。
      // worker:complete 回调在解析 payload 之前就已置位 completionReceived；即便随后
      // 解析失败走 markAgentFailed（exitReason 变为 'failed' 而非 'completed'），也表明
      // 该 worker 已投递完成回执，worker:exit 不应再当崩溃重复恢复重派。
      if (handle.completionReceived || handle.exitReason === 'completed') {
        return;
      }

      // 事实源收敛：只要底层 worker 已进入终态，AgentPool 里的 active handle
      // 必须同步落到 stopped。否则 @agent / sendAgentInput 会误以为 worker 仍可接收
      // bus 消息，转而等待一个不存在的下一轮信号。
      if (!isAgentRuntimeActiveStatus(handle) || !isCoreWorkerTerminalStatus(status)) {
        return;
      }

      const runnerHandle = h.workerRunner.getWorker(workerId);
      // P2 修复：worker:exit 回调在 Node.js EventEmitter 上触发——若此处同步抛异常
      // 会变成 uncaughtException → RuntimeGuards 调 process.exit(1) 导致整个 CLI 死亡。
      // 恢复流程中的 DB 写入（saveRecoveryRecord / persistTask / saveAgentState）均可能
      // 因 SQLITE_BUSY、DB 已关闭或序列化异常而 throw。用 try-catch 兜底，确保 worker
      // 崩溃不连带杀死 Leader 主进程。
      try {
      if (status === 'crashed' || status === 'timeout') {
        h.workerLifecycle.recordCrash(workerId);
        const diagnostics = h.buildWorkerFailureDiagnostics(handle, runnerHandle ? h.workerRunner.getWorkerDiagnostics(workerId) : undefined);
        const faultClass: RecoveryFaultClass = status === 'timeout'
          ? (runnerHandle?.timeoutReason === 'max_runtime' ? 'worker_max_runtime' : 'worker_heartbeat_timeout')
          : 'worker_crashed';
        const reason = status === 'timeout'
          ? `worker timeout (${signal || code || 'unknown'})`
          : `worker crashed (${signal || code || 'unknown'})`;
        const recovery = h.markAgentRecovering(handle, faultClass, reason, diagnostics);

        h.emitAgentEvent(handle, 'agent:crashed', {
          name: workerId,
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
          status,
          recoverable: recovery.status === 'recovering',
          recoveryAction: recovery.recoveryAction,
          backend: 'worker_process',
          pid: diagnostics?.pid,
          error: diagnostics?.error,
          timeoutReason: diagnostics?.timeoutReason,
          stderrTail: diagnostics?.stderrTail,
          stdoutTail: diagnostics?.stdoutTail,
        });
        return;
      }

      if (status === 'terminated') {
        // 与 worker:failed(terminalKind='terminated') 同理：handle 仍 active + worker 退出为 terminated
        // → 外部 kill（非 pool 主动关停）。走恢复管线避免任务孤儿。
        const termRunnerHandle = h.workerRunner.getWorker(workerId);
        const termDiagnostics = h.buildWorkerFailureDiagnostics(handle, termRunnerHandle ? h.workerRunner.getWorkerDiagnostics(workerId) : undefined);
        const termRecovery = h.markAgentRecovering(handle, 'worker_crashed', `worker terminated (${signal || code || 'unknown'})`, termDiagnostics);
        h.emitAgentEvent(handle, 'agent:crashed', {
          name: workerId,
          status: 'crashed',
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
          recoverable: termRecovery.status === 'recovering',
          recoveryAction: termRecovery.recoveryAction,
          backend: 'worker_process',
          pid: termDiagnostics?.pid,
          error: termDiagnostics?.error,
        });
        return;
      }

      if (status === 'failed') {
        const error = runnerHandle?.error
          ?? new Error(`worker failed (${signal || code || 'unknown'})`);
        h.markAgentFailed(handle, error, 'worker_exit');
        return;
      }

      if (status === 'completed') {
        // Race condition: worker exited (code 0) but worker:complete IPC message hasn't been
        // processed yet (Node.js exit event can precede message event). Don't mark as failed —
        // the complete message is still in the IPC buffer and will arrive shortly.
        // If completionReceived were already true, we would have early-returned at the barrier above.
        // Just log and return; worker:complete handler will transition to completed.
        // If worker:complete truly never arrives (e.g. IPC message lost), heartbeat watchdog will catch it.
        agentLogger.warn(`[AgentPool] worker:exit(status=completed) received before worker:complete for ${workerId}, deferring to complete handler`);
        return;
      }
      } catch (err) {
        // 恢复失败不应杀进程——降级为 forceStop + 日志，让 Leader 仍可运行
        agentLogger.error(`[AgentPool] worker:exit recovery failed (${workerId}/${status}): ${err instanceof Error ? err.message : String(err)}`);
        if (isAgentRuntimeActiveStatus(handle)) {
          h.forceStopAgent(handle, 'crashed', `recovery infrastructure error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    h.workerRunner.on('worker:timeout', (workerId: string, error: Error) => {
      const handle = h.agents.get(workerId);
      if (!handle || handle.completionReceived || handle.exitReason === 'completed') return;
      try {
      const runnerHandle = h.workerRunner.getWorker(workerId);
      const faultClass: RecoveryFaultClass = runnerHandle?.timeoutReason === 'max_runtime'
        ? 'worker_max_runtime'
        : 'worker_heartbeat_timeout';
      h.workerLifecycle.recordCrash(workerId);
      handle.error = error;
      const diagnostics = h.buildWorkerFailureDiagnostics(handle, runnerHandle ? h.workerRunner.getWorkerDiagnostics(workerId) : undefined);
      const recovery = h.markAgentRecovering(handle, faultClass, error.message, diagnostics);
      h.emitAgentEvent(handle, 'agent:crashed', {
        name: workerId,
        status: 'timeout',
        recoverable: recovery.status === 'recovering',
        recoveryAction: recovery.recoveryAction,
        backend: 'worker_process',
        pid: diagnostics?.pid,
        exitCode: typeof diagnostics?.exitCode === 'number' ? diagnostics.exitCode : undefined,
        signal: diagnostics?.exitSignal ?? undefined,
        error: diagnostics?.error,
        timeoutReason: diagnostics?.timeoutReason,
        stderrTail: diagnostics?.stderrTail,
        stdoutTail: diagnostics?.stdoutTail,
      });
      } catch (err) {
        agentLogger.error(`[AgentPool] worker:timeout recovery failed (${workerId}): ${err instanceof Error ? err.message : String(err)}`);
        if (isAgentRuntimeActiveStatus(handle)) {
          h.forceStopAgent(handle, 'timeout', `recovery infrastructure error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    h.workerRunner.on('worker:bus_message', (workerId: string, payload: unknown) => {
      const message = payload as WorkerBusEnvelope | undefined;
      markHandleProgress(h.agents.get(workerId));
      if (!message?.from || !message.to || !isBusMessageType(message.type)) {
        return; // IPC 逃逸口:type 非法直接丢弃,不投递脏消息
      }
      // Worker 端 (SendMessage/BaseAgent) 已经添加了 sessionId 前缀，直接转发即可
      // payload 形状运行时不可知(来自子进程),接收侧各 handler 自行 narrow;此处受控 cast。
      h.bus.send(message.from, message.to, message.type, message.payload as never);
    });

    h.workerRunner.on('worker:event', (_workerId: string, payload: unknown) => {
      const event = payload as WorkerEventEnvelope | undefined;
      if (!event?.eventName) {
        return;
      }
      if (event.eventName !== 'agent:heartbeat') {
        markHandleProgress(h.agents.get(_workerId));
      }
      h.emitter.emit(event.eventName as EventName, event.data as EventMap[EventName]);
    });

    h.workerRunner.on('worker:usage', (workerId: string, payload: unknown) => {
      const usage = payload as WorkerUsageEnvelope | undefined;
      markHandleProgress(h.agents.get(workerId));
      if (!usage?.usage) {
        return;
      }
      const handle = h.agents.get(workerId);
      const agentId = usage.agentId || handle?.agentId || workerId;
      h.tracker.addUsage(agentId, usage.usage, usage.modelName);
    });
  }

  setupInteractiveRuntimeEventHandlers(): void {
    const h = this.host;
    const subscribe = <T extends EventName>(eventName: T, handler: (payload: EventMap[T]) => void) => {
      h.interactiveStateUnsubscribers.push(h.emitter.subscribe(eventName, handler));
    };

    subscribe('agent:progress', (payload) => {
      const handle = h.getById(payload.agentId) || h.getByName(payload.name);
      if (!handle?.interactiveRuntime) return;
      handle.interactiveRuntime.noteProgress(String(payload.message || ''));
      handle.lastProgress = Date.now();
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('agent:tool_output', (payload) => {
      const handle = h.getById(payload.agentId) || (payload.agentName ? h.getByName(payload.agentName) : undefined);
      if (!handle?.interactiveRuntime) return;
      // Track current tool for smart watchdog
      handle.currentToolName = payload.tool;
      handle.lastToolCallAt = handle.lastToolCallAt || Date.now();
      handle.interactiveRuntime.updateToolOutput({
        key: payload.callId || payload.tool,
        toolName: payload.tool,
        chunk: payload.chunk,
        stream: payload.stream,
        pid: payload.pid,
      });
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('agent:shell_state', (payload) => {
      const handle = h.getById(payload.agentId) || (payload.agentName ? h.getByName(payload.agentName) : undefined);
      if (!handle?.interactiveRuntime) return;
      const key = payload.callId || payload.tool;
      if (typeof payload.pid === 'number') {
        handle.interactiveRuntime.setShellPid(key, payload.pid);
      }
      if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'killed') {
        handle.interactiveRuntime.clearToolOutput(key);
      }
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('agent:tool_result', (payload) => {
      const handle = h.getById(payload.agentId) || (payload.agentName ? h.getByName(payload.agentName) : undefined);
      if (!handle) return;
      // Track tool result timestamp for smart watchdog
      handle.lastToolResultAt = Date.now();
      handle.currentToolName = null;
      if (!handle.interactiveRuntime) return;
      handle.interactiveRuntime.clearToolOutput(payload.callId || payload.tool);
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('terminal:state', (payload) => {
      const handle = h.getById(payload.agentId) || (payload.agentName ? h.getByName(payload.agentName) : undefined);
      if (!handle?.interactiveRuntime) return;
      if (payload.status === 'started') {
        handle.interactiveRuntime.addTerminalSession({
          terminalId: payload.terminalId,
          pid: payload.pid,
          status: 'running',
          command: '',
        });
      } else if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'killed') {
        handle.interactiveRuntime.updateTerminalSession(payload.terminalId, {
          status: normalizeTerminalSessionStatus(payload.status),
          lastOutputAt: Date.now(),
        });
      } else if (payload.status === 'suspended') {
        handle.interactiveRuntime.updateTerminalSession(payload.terminalId, { status: normalizeTerminalSessionStatus(payload.status) });
      } else if (payload.status === 'resumed') {
        handle.interactiveRuntime.updateTerminalSession(payload.terminalId, { status: normalizeTerminalSessionStatus(payload.status) });
      }
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('terminal:output', (payload) => {
      const handle = h.getById(payload.agentId) || (payload.agentName ? h.getByName(payload.agentName) : undefined);
      if (!handle?.interactiveRuntime) return;
      handle.interactiveRuntime.updateTerminalSession(payload.terminalId, {
        lastOutputAt: Date.now(),
      });
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('permission:request', (payload) => {
      if (payload.source !== 'worker' || !payload.workerName) return;
      const handle = h.getByName(payload.workerName);
      if (!handle?.interactiveRuntime) return;
      handle.pendingPermission = true;
      handle.interactiveRuntime.addPendingApproval({
        requestId: payload.requestId,
        toolName: payload.toolName,
        reason: payload.reason,
        source: payload.source,
        workerName: payload.workerName,
        requestedMode: payload.requestedMode,
      });
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('permission:resolved', (payload) => {
      if (!payload.workerName) return;
      const handle = h.getByName(payload.workerName);
      if (!handle?.interactiveRuntime) return;
      handle.pendingPermission = false;
      handle.interactiveRuntime.resolvePendingApproval(payload.requestId);
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('work_note:written', (payload) => {
      if (payload.sessionId !== h.sessionId) return;
      const delivered = h.broadcastWorkNoteAwareness(payload.note, payload.agentId);
      if (delivered > 0) {
        agentLogger.info(`[AgentPool] work note ${payload.note.id} synced to ${delivered} running workers`);
      }
    });

    subscribe('agent:completed', (payload) => {
      const handle = h.getById(payload.agentId) || h.getByName(payload.agentName);
      if (!handle?.interactiveRuntime) return;
      handle.interactiveRuntime.setStatus('completed');
      handle.interactiveRuntime.clearQueuedMessages();
      handle.interactiveRuntime.clearAllToolOutputs();
      h.emitInteractiveRuntimeState(handle);
    });

    subscribe('agent:failed', (payload) => {
      const handle = h.getById(payload.agentId) || h.getByName(payload.agentName);
      if (!handle?.interactiveRuntime) return;
      handle.interactiveRuntime.setStatus('failed');
      handle.interactiveRuntime.clearQueuedMessages();
      handle.interactiveRuntime.clearAllToolOutputs();
      h.emitInteractiveRuntimeState(handle);
    });

    // token:usage 追踪 lastTokenAt（智能 watchdog 信号）
    h.interactiveStateUnsubscribers.push(
      h.emitter.subscribe('token:usage', (payload) => {
        const handle = h.getById(payload.agentId);
        if (!handle || handle.status !== 'running') return;
        handle.lastTokenAt = Date.now();
        handle.lastProgress = Date.now();
      }),
    );
  }
}

export default WorkerEventHandlerBinder;
