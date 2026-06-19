import type { EventEmitter } from '../../core/EventEmitter.js';
import type { MessageBus } from '../../core/MessageBus.js';
import type { TaskBoard, Task as BoardTask } from '../../core/TaskBoard.js';
import type { WorkerProcessRunner, WorkerHandle } from '../../core/WorkerProcessRunner.js';
import type { RemoteWorkerRegistry, RemoteWorkerDescriptor } from '../../core/transport/RemoteWorkerRegistry.js';
import type { AgentRoleRegistry, AgentRole } from '../RoleRegistry.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';
import type { RemoteCompletion } from './RemoteDispatchCoordinator.js';
import type { WorkerTaskPayload } from '../../core/WorkerProcessRunner.js';
import type { LLMErrorKind } from '../../llm/errors.js';
import { runAgentOnRemoteWorker, selectRemoteWorker } from './RemoteDispatchCoordinator.js';
import { globalTracer } from '../../core/Tracing.js';
import { taskDispatchTotal } from '../../core/Metrics.js';
import { refreshRuntimeConfig } from '../../config.js';
import { withToolProxyEnv } from '../../core/ProxyConfig.js';
import { buildLocalLlmGatewayEnv } from '../../core/LocalLlmGateway.js';
import { t } from '../../i18n.js';

export interface SlotSchedulerSnapshot {
  maxConcurrency: number;
  running: string[];
  queued: string[];
}

/**
 * 派发执行体依赖的最小结构化上下文：把 AgentPool 在 runAgentWrapperDispatched 中
 * 用到的成员显式收口在这里，避免自由函数直接持有整个 pool 句柄。pool 自身已满足该结构。
 */
export interface AgentDispatchContext {
  readonly sessionId: string;
  readonly workspace: string;
  readonly bus: MessageBus;
  readonly emitter: EventEmitter;
  readonly taskBoard: TaskBoard;
  readonly roleRegistry: AgentRoleRegistry;
  readonly workerRunner: WorkerProcessRunner;
  readonly remoteWorkers: RemoteWorkerRegistry;
  readonly autoRetryRecoveries: boolean;

  sp(name: string): string;
  transitionAgentStatusInstance(handle: AgentHandle, newStatus: AgentHandle['status']): void;
  parseWorkerFailurePayloadInstance(error: unknown): {
    error: Error;
    recoverable: boolean;
    terminalKind?: string;
    llmErrorKind?: LLMErrorKind;
    reason: string;
  };
  bindTaskRunGeneration(handle: AgentHandle, task?: BoardTask): number;
  getTaskRunGeneration(handle: AgentHandle): number;
  emitAgentEvent<T extends string>(handle: AgentHandle, event: T, payload: Record<string, unknown>): void;
  emitInteractiveRuntimeState(handle: AgentHandle): void;
  clearRecoveryRecordAndNotify(taskId: string): void;
  installWorkerInboxBridge(handle: AgentHandle): void;
  scheduleHandleCleanup(name: string): void;
  loadInheritedWorkerHistory(handle: AgentHandle): Promise<WorkerTaskPayload['conversationHistory'] | undefined>;
  buildWorkerPayload(
    handle: AgentHandle,
    task: BoardTask,
    role: AgentRole,
    options?: {
      conversationHistory?: WorkerTaskPayload['conversationHistory'];
      inheritHistoryMode?: 'resume' | 'new_task';
      logPrefix?: string;
    },
  ): Promise<WorkerTaskPayload>;
  parseWorkerCompletionPayload(result: unknown): RemoteCompletion;
  markAgentFailed(handle: AgentHandle, error: Error, source: string): unknown;
  recordTaskResultPendingAcceptance(
    handle: AgentHandle,
    result: string,
    completionPayload: Record<string, unknown>,
  ): void;
  applyWorkerOutputToBlackboard(taskId: string, result: string): void;
  releaseHeavyResources(handle: AgentHandle): void;
  sendCriticalBusMessageToLeader(
    to: string,
    type: 'task_complete' | 'task_failed' | 'worker_recovery',
    payload: unknown,
  ): void;
  /** 外部 backend agent 执行体（已下沉至 ExternalAgentRunner）的薄委托入口。 */
  runExternalAgent(handle: AgentHandle, role: AgentRole, task: BoardTask): Promise<string>;
}

export class SlotScheduler {
  private readonly running = new Set<string>();
  private readonly queue: string[] = [];
  private readonly waiters = new Map<string, () => void>();
  private maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  acquire(taskId: string): boolean {
    if (this.running.has(taskId)) {
      return true;
    }
    if (this.running.size >= this.maxConcurrency) {
      return false;
    }
    this.running.add(taskId);
    return true;
  }

  enqueue(taskId: string): void {
    if (this.running.has(taskId) || this.queue.includes(taskId)) {
      return;
    }
    this.queue.push(taskId);
  }

  async acquireOrWait(taskId: string): Promise<void> {
    if (this.acquire(taskId)) {
      return;
    }
    this.enqueue(taskId);
    await new Promise<void>((resolve) => {
      this.waiters.set(taskId, resolve);
    });
  }

  release(taskId: string): string | null {
    this.running.delete(taskId);
    this.waiters.delete(taskId);
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (this.acquire(next)) {
        const waiter = this.waiters.get(next);
        if (waiter) {
          this.waiters.delete(next);
          waiter();
        }
        return next;
      }
    }
    return null;
  }

  resize(maxConcurrency: number): void {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  snapshot(): SlotSchedulerSnapshot {
    return {
      maxConcurrency: this.maxConcurrency,
      running: [...this.running],
      queued: [...this.queue],
    };
  }
}

export default SlotScheduler;

import {
  createTaskCompletePayload,
  type WorkerArtifactTrace,
  type WorkerContractComplianceProof,
} from '../../core/AgentProtocol.js';
import { emitAgentSpawned as emitAgentSpawnedEvent } from './AgentPoolEvents.js';

/**
 * 从 AgentPool.runAgentWrapperDispatched 下沉的派发执行体：
 * 1) external backend → ctx.runExternalAgent 委托
 * 2) remote worker → runAgentOnRemoteWorker
 * 3) 本地 worker_process → spawn + 监听 worker:complete/failed 与 agent:crashed/failed/terminated settle
 * public 接口签名不变，原类方法改为薄委托。
 */
export async function dispatchAgent(
  ctx: AgentDispatchContext,
  handle: AgentHandle,
  task: BoardTask,
  slotWaitMs = 0,
): Promise<string> {
  // register() 已将 handle 设为 'starting'，跳过重复转换
  if (handle.status !== 'starting') {
    ctx.transitionAgentStatusInstance(handle, 'starting');
  }
  ctx.bindTaskRunGeneration(handle, task);
  const dispatchSpan = globalTracer.startSpan('agent_pool.dispatch', globalTracer.currentSpan()?.context, {
    session_id: ctx.sessionId,
    agent_id: handle.agentId,
    task_id: task.id,
    role: handle.roleType,
  });
  dispatchSpan.addAttribute('slot_wait_ms', slotWaitMs);
  taskDispatchTotal.inc({ role: handle.roleType, backend: handle.workerBackend ?? 'worker_process' });

  const role = handle.runtimeRole || ctx.roleRegistry.get(handle.roleType);
  if (!role) {
    dispatchSpan.end('error');
    throw new Error(t('error.role_not_found', handle.roleType));
  }

  if (role.worker_backend && role.worker_backend !== 'worker_process') {
    dispatchSpan.addAttribute('backend', role.worker_backend);
    dispatchSpan.end('ok');
    return ctx.runExternalAgent(handle, role, task);
  }

  const remoteWorker: RemoteWorkerDescriptor | null = selectRemoteWorker(
    ctx.remoteWorkers,
    role.tools,
    refreshRuntimeConfig().scaling.remoteWorkers.enabled,
  );
  if (remoteWorker) {
    const inheritedHistory = await ctx.loadInheritedWorkerHistory(handle);
    const payload = await ctx.buildWorkerPayload(
      handle,
      task,
      role,
      inheritedHistory ? { conversationHistory: inheritedHistory, inheritHistoryMode: 'new_task' } : {},
    );
    dispatchSpan.addAttribute('backend', 'remote');
    dispatchSpan.addAttribute('remote_worker_id', remoteWorker.id);
    dispatchSpan.end('ok');
    return runAgentOnRemoteWorker({
      sessionId: ctx.sessionId,
      handle,
      task,
      worker: remoteWorker,
      payload,
      bus: ctx.bus,
      emitter: ctx.emitter,
      registry: ctx.remoteWorkers,
      callbacks: {
        getTaskRunGeneration: (agentHandle) => ctx.getTaskRunGeneration(agentHandle),
        markRemoteRunning: (agentHandle) => {
          ctx.transitionAgentStatusInstance(agentHandle, 'running');
          agentHandle.workerBackend = 'remote';
          agentHandle.interactiveRuntime?.setStatus('running');
          ctx.emitInteractiveRuntimeState(agentHandle);
          ctx.clearRecoveryRecordAndNotify(agentHandle.taskId);
          emitAgentSpawnedEvent({ emitter: ctx.emitter, sessionId: ctx.sessionId, taskBoard: ctx.taskBoard, handle: agentHandle });
        },
        markAgentFailed: (error, source) => ctx.markAgentFailed(handle, error, source),
        parseCompletion: (completionPayload): RemoteCompletion => ctx.parseWorkerCompletionPayload(completionPayload),
        buildCompletionPayload: (completion) => ({
          summary: completion.summary,
          verdict: completion.verdict,
          artifacts: completion.artifacts,
          verification: completion.verification,
          evidence_refs: completion.evidence_refs,
          contract_compliance: completion.contract_compliance as WorkerContractComplianceProof | undefined,
          next_steps: completion.next_steps,
          blocked_by_discovery: completion.blocked_by_discovery,
          needs_leader_coordination: completion.needs_leader_coordination,
          toolTrace: completion.toolTrace,
          speculativeWinner: completion.speculativeWinner,
          taskRunGeneration: ctx.getTaskRunGeneration(handle),
        }),
        acceptCompletion: (completion, completionPayload) => {
          ctx.transitionAgentStatusInstance(handle, 'stopped');
          handle.completionReceived = true;
          handle.exitReason = 'completed';
          handle.endTime = Date.now();
          handle.interactiveRuntime?.setStatus('completed');
          handle.interactiveRuntime?.clearQueuedMessages();
          handle.interactiveRuntime?.clearAllToolOutputs();
          ctx.emitInteractiveRuntimeState(handle);
          ctx.recordTaskResultPendingAcceptance(handle, completion.result, completionPayload);
          ctx.clearRecoveryRecordAndNotify(handle.taskId);
          ctx.applyWorkerOutputToBlackboard(handle.taskId, completion.result);
          ctx.sendCriticalBusMessageToLeader(ctx.sp(handle.name), 'task_complete', createTaskCompletePayload(handle.taskId, completion.result, completionPayload));
          ctx.emitAgentEvent(handle, 'agent:completed', {
            result: completion.result,
            stats: completion.stats,
            tokenUsage: completion.tokenUsage,
            backend: 'remote',
          });
          ctx.releaseHeavyResources(handle);
        },
      },
    });
  }

  // 构建 Worker Payload。
  // 复用同名 worker 继承上下文：dispatch 路径若复用了历史 agentId（resolvePriorAgentId 命中），
  // 则 DB 里已有该 agentId 上一轮任务的完整对话。这里加载它，以 'new_task' 语义注入——
  // 历史作背景上下文，worker 端再追加新任务指令。全新 worker（无历史）→ 空，照常初始化。
  const inheritedHistory = await ctx.loadInheritedWorkerHistory(handle);
  const payload = await ctx.buildWorkerPayload(
    handle,
    task,
    role,
    inheritedHistory ? { conversationHistory: inheritedHistory, inheritHistoryMode: 'new_task' } : {},
  );

  // 启动 Worker 子进程
  let workerHandle: WorkerHandle;
  try {
    const workerEnv = {
      LINGXIAO_SESSION_ID: ctx.sessionId,
      LINGXIAO_AGENT_NAME: handle.name,
      LINGXIAO_WORKSPACE: ctx.workspace,
    };
    workerHandle = await ctx.workerRunner.spawnWorker(payload, withToolProxyEnv({
      ...workerEnv,
      ...buildLocalLlmGatewayEnv({ ...process.env, ...workerEnv }),
    }));
  } catch (error) {
    const startupError = error instanceof Error ? error : new Error(String(error));
    ctx.markAgentFailed(handle, startupError, 'startup');
    dispatchSpan.end('error');
    throw startupError;
  }

  handle.workerHandle = workerHandle;
  ctx.transitionAgentStatusInstance(handle, 'running');
  ctx.installWorkerInboxBridge(handle);
  handle.interactiveRuntime?.setStatus('running');
  ctx.emitInteractiveRuntimeState(handle);
  ctx.clearRecoveryRecordAndNotify(handle.taskId);
  dispatchSpan.addAttribute('backend', 'worker_process');
  dispatchSpan.end('ok');

  // 等待 Worker 完成 — 由三个事件之一 settle：
  //   worker:complete → resolve
  //   worker:failed   → markAgentFailed 已发 task_failed + emit agent:failed，这里 reject
  //   agent:crashed   → markAgentRecovering 已发 agent_error + emit agent:crashed，这里 reject
  // 注意：不再设置包装器层的硬超时。真正的超时兜底由 WorkerProcessRun 的
  // heartbeatTimeoutMs / maxRuntimeMs 触发，会走 worker:exit(status='timeout') →
  // markAgentRecovering，仍然走 agent:crashed 路径，从而保证状态机/总线/UI 三方一致。
  const workerRunner = ctx.workerRunner;
  const emitter = ctx.emitter;
  return new Promise((resolve, reject) => {
    let settled = false;

    const onComplete = (completedId: string, result: unknown) => {
      if (settled || completedId !== handle.name) return;
      settled = true;
      cleanup();
      ctx.scheduleHandleCleanup(handle.name);
      try {
        resolve(ctx.parseWorkerCompletionPayload(result).result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onFailed = (failedId: string, error: unknown) => {
      if (settled || failedId !== handle.name) return;
      const failure = ctx.parseWorkerFailurePayloadInstance(error);
      if (failure.terminalKind === 'terminated' || failure.recoverable) {
        return;
      }
      settled = true;
      cleanup();
      ctx.scheduleHandleCleanup(handle.name);
      reject(failure.error);
    };

    const onCrashed = (event: unknown) => {
      if (settled) return;
      const e = event as { name?: string; status?: string; exitCode?: number | null; recoverable?: boolean; recoveryAction?: string };
      if (e && typeof e === 'object' && e.name === handle.name) {
        if (
          ctx.autoRetryRecoveries &&
          e.recoverable === true &&
          (e.recoveryAction === 'worker_restart' || e.recoveryAction === 'worker_redispatch')
        ) {
          return;
        }
        settled = true;
        cleanup();
        ctx.scheduleHandleCleanup(handle.name);
        const reason = e.status === 'timeout'
          ? `worker timeout (exit=${e.exitCode ?? 'unknown'})`
          : `worker crashed (exit=${e.exitCode ?? 'unknown'})`;
        reject(new Error(`Worker ${handle.name} ${reason}`));
      }
    };

    const onAgentFailed = (event: unknown) => {
      if (settled) return;
      const e = event as { agentName?: string; name?: string; error?: string };
      if (e && typeof e === 'object' && (e.agentName === handle.name || e.name === handle.name)) {
        settled = true;
        cleanup();
        ctx.scheduleHandleCleanup(handle.name);
        reject(new Error(e.error || `Worker ${handle.name} failed`));
      }
    };

    const onAgentTerminated = (event: unknown) => {
      if (settled) return;
      const e = event as { agentName?: string; name?: string; reason?: string };
      if (e && typeof e === 'object' && (e.agentName === handle.name || e.name === handle.name)) {
        settled = true;
        cleanup();
        ctx.scheduleHandleCleanup(handle.name);
        reject(new Error(e.reason || `Worker ${handle.name} terminated`));
      }
    };

    const cleanup = () => {
      workerRunner.off('worker:complete', onComplete);
      workerRunner.off('worker:failed', onFailed);
      emitter.off('agent:crashed', onCrashed);
      emitter.off('agent:failed', onAgentFailed);
      emitter.off('agent:terminated', onAgentTerminated);
    };

    workerRunner.on('worker:complete', onComplete);
    workerRunner.on('worker:failed', onFailed);
    emitter.on('agent:crashed', onCrashed);
    emitter.on('agent:failed', onAgentFailed);
    emitter.on('agent:terminated', onAgentTerminated);
  });
}
