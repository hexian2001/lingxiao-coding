/**
 * AgentPool - Agent 进程池管理
 * 负责管理 Agent 的创建、运行和生命周期
 *
 * 1.2 迁移: 使用 WorkerProcessRunner 启动独立 OS 子进程
 */

import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { LLMErrorKind } from '../llm/errors.js';
import type { BlackboardDelta } from '../core/blackboard/types.js';
import type { ToolRegistry } from '../tools/Registry.js';
import type { BusMessage, MessageBus } from '../core/MessageBus.js';
import type { EventEmitter, EventName, EventMap } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import type { Task as BoardTask, TaskBoard } from '../core/TaskBoard.js';
import type { TokenTracker } from './BaseAgentRuntime.js';
import { AgentRoleRegistry } from './RoleRegistry.js';
import type { AgentRole } from './RoleRegistry.js';
import { AGENT_MAX_ITERATIONS, AGENT_MAX_RUNTIME_MINUTES, refreshRuntimeConfig, onConfigReload } from '../config.js';
import { config as globalConfig } from '../config.js';
import {
  createTaskCompletePayload,
  createTaskFailedPayload,
  type TaskCompletePayload,
  type TaskFailedPayload,
  type WorkerArtifactTrace,
  type WorkerContractComplianceProof,
  type WorkerRecoveryPayload,
} from '../core/AgentProtocol.js';
import {
  buildArtifactAwarenessBlock,
} from '../core/ArtifactAwareness.js';
import { WorkerInteractiveRuntime } from './runtime/WorkerInteractiveRuntime.js';
import { withToolProxyEnv } from '../core/ProxyConfig.js';
import {
  WorkerProcessRunner,
  type WorkerHandle,
  type WorkerTaskPayload,
  type WorkerCompletionPayload,
  type WorkerBusEnvelope,
  type WorkerEventEnvelope,
  type WorkerUsageEnvelope,
  type WorkerProcessDiagnostics,
} from '../core/WorkerProcessRunner.js';
import type { AgentExecutionResult } from './AgentExecutionResult.js';
import {
  clearRecoveryRecord,
  gcRecoveryRecords,
  type RecoveryFaultClass,
} from '../core/RecoveryRecords.js';
import { agentLogger } from '../core/Log.js';
import { t } from '../i18n.js';
import { WorkNoteManager, type WorkNote } from '../core/WorkNoteManager.js';
import { buildLocalLlmGatewayEnv } from '../core/LocalLlmGateway.js';
import type { ContractPack } from '../core/ContractPack.js';
import type { WorkflowManager } from '../core/workflow/WorkflowManager.js';
import type { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';
import { ExternalAgentRunner } from './external/ExternalAgentRunner.js';
import { assertExternalAgentAvailable } from './external/availability.js';
import { buildExternalPrompt } from './external/promptBuilder.js';
import { parseExternalCompletionReport, type ExternalCompletionReport } from './external/completionReport.js';
import { resolveExternalModel } from './external/modelResolver.js';
import { ClaudeCodeDriver } from './external/drivers/ClaudeCodeDriver.js';
import { CodexDriver } from './external/drivers/CodexDriver.js';
import type { ExternalBackend, ExternalAgentProcessHandle } from './external/types.js';
import { killProcess } from '../utils/platform.js';
import {
  evaluateWorkerCompletionCandidate,
  evaluateWorkerCompletionHardGuards,
} from './runtime/WorkerCompletionPolicy.js';
import { runCompletionVerification } from './runtime/MandatoryVerification.js';
import {
  extractAdversarialBreakerPolicy,
  formatAdversarialBreakerFeedback,
  runAdversarialBreaker,
} from '../core/AdversarialVerifier.js';
import {
  assertCoreAgentTransition,
  isAgentRuntimeActiveStatus,
  isCoreWorkerTerminalStatus,
  normalizeTerminalSessionStatus,
  normalizeAgentRuntimeStatus,
  type CoreAgentStatus,
} from '../contracts/adapters/StatusAdapter.js';
import { join } from 'path';
import { RemoteWorkerRegistry, type RemoteWorkerDescriptor } from '../core/transport/RemoteWorkerRegistry.js';
import { globalTracer } from '../core/Tracing.js';
import { taskDispatchTotal } from '../core/Metrics.js';
import { WorkerLifecycle, type TerminationHostContext } from './pool/WorkerLifecycle.js';
import { FaultRecovery, type RecoveryHostContext } from './pool/FaultRecovery.js';
import { SlotScheduler } from './pool/SlotScheduler.js';
import {
  buildWorkerPayload,
  loadInheritedWorkerHistory,
} from './pool/WorkerPayloadBuilder.js';
import { dispatchAgent, type AgentDispatchContext } from './pool/SlotScheduler.js';
import { runExternalAgent as runExternalAgentExternal, type ExternalAgentRunContext, ExternalAgentProtocolError } from './external/ExternalAgentRunner.js';
import {
  broadcastBlackboardDelta as broadcastBlackboardDeltaToAgents,
  broadcastWorkNoteAwareness as broadcastWorkNoteAwarenessToAgents,
} from './pool/AgentPoolBroadcast.js';
import {
  runAgentOnRemoteWorker,
  selectRemoteWorker,
  type RemoteCompletion,
} from './pool/RemoteDispatchCoordinator.js';
import type { StructuredCompletionPayload } from './pool/AgentPoolCompletionPayload.js';
import {
  emitAgentSpawned as emitAgentSpawnedEvent,
  registerRemoteWorker as registerRemoteWorkerDescriptor,
} from './pool/AgentPoolEvents.js';
import { WorkerEventHandlerBinder } from './pool/WorkerEventHandlerBinder.js';
import { ExecutionTraceMemory } from '../core/ExecutionTraceMemory.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import {
  assertSpeculativeWinnerEvidenceVerified,
  type SpeculativeWinnerEvidence,
} from '../core/SpeculativeExecutionController.js';
import {
  AdaptiveHarness,
  renderAdaptiveStrategyPlan,
  type AdaptiveStrategyPlan,
  type EscalationTrigger,
} from '../core/AdaptiveHarness.js';

function getPositiveIntFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface WorkerFailurePayload {
  error: string;
  status?: AgentExecutionResult['status'];
  metadata?: Partial<AgentExecutionResult['metadata']>;
  outputs?: AgentExecutionResult['outputs'];
  stats?: { iterations?: number; toolCalls?: number };
  tokenUsage?: { total?: number; prompt?: number; completion?: number };
}

export function parseWorkerFailurePayload(error: unknown): {
  error: Error;
  recoverable: boolean;
  terminalKind?: AgentExecutionResult['metadata']['terminalKind'];
  faultClass?: RecoveryFaultClass;
  llmErrorKind?: LLMErrorKind;
  reason: string;
  payload?: WorkerFailurePayload;
} {
  if (error instanceof Error) {
    return { error, recoverable: false, reason: error.message };
  }

  if (error && typeof error === 'object') {
    const payload = error as WorkerFailurePayload;
    const message = typeof payload.error === 'string'
      ? payload.error
      : typeof (error as { message?: unknown }).message === 'string'
        ? String((error as { message: string }).message)
        : JSON.stringify(error);
    const metadata = payload.metadata;
    return {
      error: new Error(message),
      recoverable: metadata?.recoverable === true || metadata?.terminalKind === 'recovering',
      terminalKind: metadata?.terminalKind,
      faultClass: metadata?.faultClass,
      llmErrorKind: metadata?.llmErrorKind,
      reason: metadata?.statusReason || message,
      payload,
    };
  }

  const message = String(error);
  return { error: new Error(message), recoverable: false, reason: message };
}

type InjectedAgentEventField = 'sessionId' | 'agentId' | 'agentName' | 'taskId';
type AgentEventExtra<T extends EventName> =
  Omit<EventMap[T], InjectedAgentEventField> &
  Partial<Pick<EventMap[T], Extract<keyof EventMap[T], InjectedAgentEventField>>>;

export interface WorkerBridgeCursor {
  lastTimestamp: number;
  deliveredIdsAtTimestamp: string[];
}

export function createEmptyWorkerBridgeCursor(): WorkerBridgeCursor {
  return { lastTimestamp: 0, deliveredIdsAtTimestamp: [] };
}

export function shouldBridgeWorkerMessage(message: Pick<BusMessage, 'id' | 'timestamp'>, cursor: WorkerBridgeCursor): boolean {
  if (message.timestamp < cursor.lastTimestamp) return false;
  if (message.timestamp > cursor.lastTimestamp) return true;
  return !cursor.deliveredIdsAtTimestamp.includes(message.id);
}

export function advanceWorkerBridgeCursor(
  cursor: WorkerBridgeCursor,
  messages: Array<Pick<BusMessage, 'id' | 'timestamp'>>,
): WorkerBridgeCursor {
  if (messages.length === 0) return cursor;
  const maxTimestamp = Math.max(cursor.lastTimestamp, ...messages.map((message) => message.timestamp));
  const deliveredIdsAtTimestamp = new Set(
    maxTimestamp === cursor.lastTimestamp ? cursor.deliveredIdsAtTimestamp : [],
  );
  for (const message of messages) {
    if (message.timestamp === maxTimestamp) {
      deliveredIdsAtTimestamp.add(message.id);
    }
  }
  return { lastTimestamp: maxTimestamp, deliveredIdsAtTimestamp: [...deliveredIdsAtTimestamp] };
}

export function parseWorkerBridgeCursor(value: unknown): WorkerBridgeCursor {
  if (typeof value !== 'string' || !value.trim()) return createEmptyWorkerBridgeCursor();
  try {
    const parsed = JSON.parse(value) as Partial<WorkerBridgeCursor>;
    if (typeof parsed.lastTimestamp !== 'number' || !Number.isFinite(parsed.lastTimestamp)) {
      return createEmptyWorkerBridgeCursor();
    }
    return {
      lastTimestamp: Math.max(0, parsed.lastTimestamp),
      deliveredIdsAtTimestamp: Array.isArray(parsed.deliveredIdsAtTimestamp)
        ? parsed.deliveredIdsAtTimestamp.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return createEmptyWorkerBridgeCursor();
  }
}

export function serializeWorkerBridgeCursor(cursor: WorkerBridgeCursor): string {
  return JSON.stringify(cursor);
}

/**
 * AgentHandle - Agent 运行时的句柄
 */
export interface AgentHandle {
  agentId: string;
  name: string;
  roleType: string;
  displayRole?: string;
  taskId: string;
  status: 'starting' | 'running' | 'stopped';
  visibility?: 'team' | 'ephemeral';
  owner?: 'leader' | 'team';
  interactive?: boolean;
  persistAcrossTurns?: boolean;
  teamMember?: string | null;
  /** 退出原因，仅当 status === 'stopped' 时有效 */
  exitReason?: 'completed' | 'failed' | 'timeout' | 'crashed' | 'terminated';
  /** TaskBoard 当前执行代际；每次派发/重派绑定，用于 completion/failed 回执防旧代污染。 */
  taskRunGeneration?: number;
  asyncTask?: Promise<string>;
  startTime: number;
  endTime?: number;
  error?: Error;
  sessionId?: string;
  iteration?: number;
  role?: string;
  /** Last worker heartbeat / process liveness signal. Not proof of task progress. */
  lastHeartbeat?: number;
  /** Last meaningful task progress signal. Heartbeats must not refresh this. */
  lastProgress?: number;
  /** Last token streaming timestamp */
  lastTokenAt?: number;
  /** Last tool call start timestamp */
  lastToolCallAt?: number;
  /** Last tool result timestamp */
  lastToolResultAt?: number;
  /** Current tool being executed (null if not in tool) */
  currentToolName?: string | null;
  /** Whether agent is waiting for permission approval */
  pendingPermission?: boolean;
  toolCalls?: number;
  runtimeRole?: AgentRole;
  capabilityDetails?: {
    baselineRole?: string;
    skillNames: string[];
    droppedTools: string[];
    tools: string[];
  };
  interactiveRuntime?: WorkerInteractiveRuntime;
  /** Canonical worker-process handle. */
  workerHandle?: WorkerHandle;
  workerBackend?: 'worker_process' | 'claude' | 'codex' | 'remote';
  externalSessionId?: string;
  externalPid?: number;
  externalExitCode?: number | null;
  externalExitSignal?: string | null;
  externalDiagnostics?: {
    logPath?: string;
    stderrLogPath?: string;
    stderrTail?: string[];
    stdoutTail?: string[];
    lastEventAt?: number;
    recoverable?: boolean;
    recoveryAction?: string;
  };
  externalStop?: (reason: string) => boolean;
  workerInboxBridgeCleanup?: () => void;
  recoveryLineage?: number;
  /**
   * Respawn 限速 (2026-05-28)：
   * Leader 反复调用 send_message_to_agent / autoRespawn 会无限制 spawn 新 worker，
   * 把机器跑爆 / 把 provider 配额耗尽。这里记录最近一次 respawn 时间窗 + 失败次数，
   * AgentPool.respawnAgent 入口会基于此拒绝过频/连续失败的 respawn。
   */
  respawnTimestampsMs?: number[];
  consecutiveRespawnFailures?: number;
  /**
   * 完成回执屏障（乱序保护）：worker:complete 回调最先置位（解析 payload 之前）。
   * worker:exit 回调据此判断「该 worker 已收到合法完成回执」，而非仅依赖
   * handle.exitReason==='completed' 或事件到达顺序——避免 worker:exit 早于
   * worker:complete 到达（或 complete 解析中途）时被误判为崩溃而重复恢复重派。
   */
  completionReceived?: boolean;
}

/**
 * AgentPool 配置
 */
export interface AgentPoolConfig {
  sessionId: string;
  llm: ContentGenerator;
  toolRegistry: ToolRegistry;
  bus: MessageBus;
  emitter: EventEmitter;
  db: DatabaseManager;
  tracker: TokenTracker;
  workspace: string;
  model: string;
  roleRegistry: AgentRoleRegistry;
  /** TaskBoard 是任务生命周期唯一写入出口。 */
  taskBoard: TaskBoard;
  workflowManager?: WorkflowManager;
  workflowEngine?: WorkflowEngine;
  scheduledTaskManager?: ScheduledTaskManager;
  /** Production default is true; tests may disable it to inspect recovery state without spawning a child worker. */
  autoRetryRecoveries?: boolean;
  /**
   * Test seam：注入一个受控的 WorkerProcessRunner（通常是 fake，避免真起子进程）。
   * 缺省由 pool 自建真实 runner。binder 在构造期绑到本实例，故必须经 config 注入而非构造后替换。
   */
  workerRunner?: WorkerProcessRunner;
}

export interface AgentRespawnOptions {
  failureMode?: 'task_failed' | 'recovery';
}

/**
 * AgentPool - Agent 进程池
 */
export type AgentStatus = CoreAgentStatus;

export class AgentPool {
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;

  /**
   * 集中校验并执行 Agent 状态转换。非法转换会抛出 Error。
   *
   * AgentPool 不再保存自己的 transition 表；所有合法跳转来自 StateSemantics。
   * 这样 respawn、stopAll、worker complete/failed 等路径不会各自发展出不同规则。
   */
  static transitionAgentStatus(handle: AgentHandle, newStatus: AgentStatus): void {
    if (handle.status === newStatus) {
      return;
    }
    assertCoreAgentTransition(handle.status, newStatus, `Agent "${handle.name}"`);
    handle.status = newStatus;
  }

  protected forceStopAgent(
    handle: AgentHandle,
    exitReason: NonNullable<AgentHandle['exitReason']>,
    reason?: string,
  ): void {
    if (handle.status !== 'stopped') {
      AgentPool.transitionAgentStatus(handle, 'stopped');
    }
    handle.exitReason = exitReason;
    if (reason !== undefined) {
      handle.error = new Error(reason);
    }
    handle.endTime = handle.endTime ?? Date.now();
  }

  protected bindTaskRunGeneration(handle: AgentHandle, task?: BoardTask): number {
    const boardTask = this.taskBoard.getTask(handle.taskId);
    const raw = boardTask?.runGeneration ?? task?.runGeneration ?? handle.taskRunGeneration ?? 0;
    const generation = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    handle.taskRunGeneration = generation;
    return generation;
  }

  protected getTaskRunGeneration(handle: AgentHandle): number {
    if (handle.taskRunGeneration !== undefined) {
      const generation = Number(handle.taskRunGeneration);
      return Number.isFinite(generation) ? Math.max(0, Math.floor(generation)) : 0;
    }
    return this.bindTaskRunGeneration(handle);
  }
  protected sessionId: string;
  protected llm: ContentGenerator;
  protected toolRegistry: ToolRegistry;
  protected bus: MessageBus;
  protected emitter: EventEmitter;
  protected db: DatabaseManager;
  protected tracker: TokenTracker;
  protected workspace: string;
  protected model: string;
  protected roleRegistry: AgentRoleRegistry;
  protected workflowManager?: WorkflowManager;
  protected workflowEngine?: WorkflowEngine;
  protected scheduledTaskManager?: ScheduledTaskManager;

  protected agents: Map<string, AgentHandle> = new Map();
  protected agentCounter = 0;
  protected workerRunner: WorkerProcessRunner;
  protected interactiveStateUnsubscribers: Array<() => void> = [];
  /** onConfigReload 退订函数：在 destroy() 时调用以防止监听器泄漏 */
  private configReloadUnsubscribe: (() => void) | null = null;
  /** TaskBoard 引用，Worker 完成时直接更新任务状态 */
  protected taskBoard: TaskBoard;
  /** 兜底 GC 定时器：每 3 分钟扫描并删除超龄的 non-running handle */
  private staleHandleGcTimer: ReturnType<typeof setInterval> | null = null;
  /** non-running handle 被视为超龄的时间阈值：5 分钟 */
  private static readonly STALE_HANDLE_TTL_MS = 5 * 60 * 1000;
  /** 兜底 GC 扫描间隔：3 分钟 */
  private static readonly STALE_GC_INTERVAL_MS = 3 * 60 * 1000;
  /** agents Map 池大小上限：超过此值时强制清理最旧的已完成 handle */
  private static readonly MAX_POOL_SIZE = 200;
  /** 工作笔记管理器，用于 dispatch 时自动注入前序上下文 */
  private workNoteManager: WorkNoteManager;
  private readonly remoteWorkers = new RemoteWorkerRegistry();
  private readonly workerLifecycle = new WorkerLifecycle();
  private readonly faultRecovery = new FaultRecovery();
  private readonly slotScheduler: SlotScheduler;
  private readonly traceMemory?: ExecutionTraceMemory;
  private readonly adaptiveHarness = new AdaptiveHarness();
  private readonly adaptivePlans = new Map<string, AdaptiveStrategyPlan>();
  private readonly workerBridgeCursors = new Map<string, WorkerBridgeCursor>();
  private readonly autoRetryRecoveries: boolean;
  /** 事件路由层（worker 进程事件 + 交互运行时事件），抽取自原 setup*EventHandlers */
  protected readonly eventBinder: WorkerEventHandlerBinder;

  /** 给任意 agent name 加上本会话前缀，用于 MessageBus 寻址 */
  private sp(name: string): string { return `${this.sessionId}:${name}`; }
  /** 本会话 leader 的 bus 名 */
  private get leaderBusName(): string { return `${this.sessionId}:leader`; }

  protected sendCriticalBusMessageToLeader(from: string, type: 'task_complete' | 'task_failed' | 'worker_recovery', payload: unknown): void {
    void this.bus.sendReliable(from, this.leaderBusName, type, payload as TaskCompletePayload | TaskFailedPayload | WorkerRecoveryPayload, {
      sessionId: this.sessionId,
    }).then((result) => {
      if (!result.ok) {
        agentLogger.error(`[AgentPool] critical bus message dead-lettered (${type}) from ${from}: ${result.error}`);
      }
    }).catch((error) => {
      agentLogger.error(`[AgentPool] critical bus send unexpected failure (${type}) from ${from}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private buildWorkerFailureDiagnostics(
    handle: AgentHandle,
    runnerDiagnostics?: WorkerProcessDiagnostics,
  ): WorkerRecoveryPayload['diagnostics'] {
    const diagnostics = runnerDiagnostics ?? this.workerRunner.getWorkerDiagnostics(handle.name);
    if (!diagnostics && !handle.error) return undefined;
    return {
      ...(diagnostics?.pid ? { pid: diagnostics.pid } : {}),
      ...(diagnostics && 'exitCode' in diagnostics ? { exitCode: diagnostics.exitCode } : {}),
      ...(diagnostics?.exitSignal ? { exitSignal: diagnostics.exitSignal } : {}),
      ...(diagnostics?.timeoutReason ? { timeoutReason: diagnostics.timeoutReason } : {}),
      ...(diagnostics?.error || handle.error?.message ? { error: diagnostics?.error ?? handle.error?.message } : {}),
      ...(diagnostics?.stderrTail?.length ? { stderrTail: diagnostics.stderrTail } : {}),
      ...(diagnostics?.stdoutTail?.length ? { stdoutTail: diagnostics.stdoutTail } : {}),
    };
  }

  private clearRecoveryRecordAndNotify(taskId: string): void {
    clearRecoveryRecord(this.db, this.sessionId, taskId);
    this.emitter.emit('runtime_recovery:changed', {
      sessionId: this.sessionId,
      action: 'cleared',
      taskId,
    });
  }

  constructor(config: AgentPoolConfig) {
    this.sessionId = config.sessionId;
    this.llm = config.llm;
    this.toolRegistry = config.toolRegistry;
    this.bus = config.bus;
    this.emitter = config.emitter;
    this.db = config.db;
    this.tracker = config.tracker;
    this.workspace = config.workspace;
    this.model = config.model;
    this.roleRegistry = config.roleRegistry;
    this.taskBoard = config.taskBoard;
    this.workflowManager = config.workflowManager;
    this.workflowEngine = config.workflowEngine;
    this.scheduledTaskManager = config.scheduledTaskManager;
    this.autoRetryRecoveries = config.autoRetryRecoveries !== false;
    this.workNoteManager = new WorkNoteManager(config.workspace ? `${config.workspace}/.lingxiao` : undefined);
    this.traceMemory = typeof (config.db as { getDb?: unknown }).getDb === 'function'
      ? new ExecutionTraceMemory(config.db)
      : undefined;
    const liveConfig = refreshRuntimeConfig();
    this.slotScheduler = new SlotScheduler(liveConfig.agents.max_concurrent);

    this.workerRunner = config.workerRunner ?? new WorkerProcessRunner({
      heartbeatTimeoutMs: globalConfig.timeouts.worker_heartbeat_timeout_ms,
      spawnTimeoutMs: globalConfig.timeouts.worker_spawn_ms,
      maxRuntimeMs: globalConfig.timeouts.worker_max_runtime_ms,
      debug: process.env.LINGXIAO_DEBUG_WORKERS === 'true',
    });

    // 1.3: 监听 Worker 生命周期事件 —— 路由下沉到 WorkerEventHandlerBinder
    this.eventBinder = new WorkerEventHandlerBinder(this.buildEventHandlerHost());

    // 把终止/恢复路径所需的依赖面以结构化对象注入子模块（避免子模块反向持有巨类）。
    this.workerLifecycle.bindHost(this.buildLifecycleHostContext());
    this.faultRecovery.bindHost(this.buildRecoveryHostContext());
    this.setupWorkerEventHandlers();
    this.setupInteractiveRuntimeEventHandlers();

    // 兜底 GC：周期性清理异常路径未被 scheduleHandleCleanup 清理的 stale handle
    this.staleHandleGcTimer = setInterval(() => {
      this.collectStaleHandles();
    }, AgentPool.STALE_GC_INTERVAL_MS);
    if (this.staleHandleGcTimer.unref) this.staleHandleGcTimer.unref();

    // 注册配置热加载回调：agents.max_concurrent 变化时动态调整 SlotScheduler 容量，
    // 避免需要重启 session 才能让新并发上限生效。
    this.configReloadUnsubscribe = onConfigReload((cfg) => {
      try {
        const newMax = cfg.agents.max_concurrent;
        if (newMax > 0 && newMax !== this.slotScheduler.snapshot().maxConcurrency) {
          this.slotScheduler.resize(newMax);
        }
      } catch (e) {
        // 参考 ModelManager.ts:279-288 的 try-catch 模式，不阻断其他 reload handler
      }
    });
  }

  /**
   * 1.3: 设置 Worker 事件处理器，将 Worker 事件转发到 Leader
   *
   * 实现已下沉到 WorkerEventHandlerBinder（事件集合与原实现完全一致：不丢不增）。
   * 保留为薄委托，public 接口签名不变。
   */
  protected setupWorkerEventHandlers(): void {
    this.eventBinder.setupWorkerEventHandlers();
  }

  /**
   * 构造事件路由层所需的 host 绑定对象。逐字段映射到原方法体内的 `this.X` 引用，
   * 不改语义、不丢事件。WorkerLifecycle / FaultRecovery 以结构化子集暴露，
   * 避免改它们在 AgentPoolRuntime 上的可见性。
   */
  protected buildEventHandlerHost() {
    const pool = this;
    return {
      sessionId: this.sessionId,
      agents: this.agents,
      // getter 而非值捕获：TestAgentPool 等子类在构造后覆盖 workerRunner，
      // eventBinder 必须运行时读到最新实例，否则事件会绑到父类默认 runner。
      get workerRunner() { return pool.workerRunner; },
      emitter: this.emitter,
      bus: this.bus,
      db: this.db,
      tracker: this.tracker,
      taskBoard: this.taskBoard,
      interactiveStateUnsubscribers: this.interactiveStateUnsubscribers,
      sp: (name: string) => this.sp(name),
      workerLifecycle: this.workerLifecycle,
      faultRecovery: this.faultRecovery,
      transitionAgentStatus: (handle: AgentHandle, s: 'starting' | 'running' | 'stopped') =>
        AgentPool.transitionAgentStatus(handle, s),
      maxRecoveryAttempts: AgentPool.MAX_RECOVERY_ATTEMPTS,
      parseWorkerFailurePayload,
      getById: (id: string) => this.getById(id),
      getByName: (name: string) => this.getByName(name),
      getTaskRunGeneration: (handle: AgentHandle) => this.getTaskRunGeneration(handle),
      parseWorkerCompletionPayload: (p: unknown) => this.parseWorkerCompletionPayload(p),
      buildWorkerFailureDiagnostics: (handle: AgentHandle, d?: WorkerProcessDiagnostics) =>
        this.buildWorkerFailureDiagnostics(handle, d),
      clearRecoveryRecordAndNotify: (taskId: string) => this.clearRecoveryRecordAndNotify(taskId),
      applyWorkerOutputToBlackboard: (taskId: string, output: unknown) => this.applyWorkerOutputToBlackboard(taskId, output),
      broadcastWorkNoteAwareness: (note: WorkNote, src: string) => this.broadcastWorkNoteAwareness(note, src),
      cleanupWorkerInboxBridge: (handle: AgentHandle) => this.cleanupWorkerInboxBridge(handle),
      emitInteractiveRuntimeState: (handle: AgentHandle | undefined) => this.emitInteractiveRuntimeState(handle),
      emitAgentEvent: <T extends EventName>(handle: AgentHandle, kind: T, extra: Partial<EventMap[T]>) =>
        this.emitAgentEvent(handle, kind, extra as never),
      markAgentRecovering: (
        handle: AgentHandle,
        faultClass: RecoveryFaultClass,
        reason: string,
        diagnostics?: WorkerRecoveryPayload['diagnostics'],
        llmErrorKind?: LLMErrorKind,
      ) => this.markAgentRecovering(handle, faultClass, reason, diagnostics, llmErrorKind),
      markAgentFailed: (handle: AgentHandle, error: Error, source = 'runtime') =>
        this.markAgentFailed(handle, error, source),
      markAgentTerminated: (handle: AgentHandle, reason: string) => this.markAgentTerminated(handle, reason),
      forceStopAgent: (
        handle: AgentHandle,
        exitReason: NonNullable<AgentHandle['exitReason']>,
        reason?: string,
      ) => this.forceStopAgent(handle, exitReason, reason),
      recordTaskResultPendingAcceptance: (
        handle: AgentHandle,
        result: string,
        completion?: StructuredCompletionPayload,
      ) => this.recordTaskResultPendingAcceptance(handle, result, completion),
      releaseHeavyResources: (handle: AgentHandle) => this.releaseHeavyResources(handle),
      sendCriticalBusMessageToLeader: (from: string, type: 'task_complete' | 'task_failed' | 'worker_recovery', payload: unknown) =>
        this.sendCriticalBusMessageToLeader(from, type, payload),
    };
  }

  static normalizeAgentName(name: string): string {
    return name.trim().replace(/^@+/, '');
  }

  /** Set blackboard callbacks for worker graph access */
  setBlackboardCallbacks(
    getSnapshot: () => string,
    applyOutput: (agentId: string, output: unknown) => void,
    getGraph?: () => unknown,
    getActiveTeam?: () => string | null,
    getContractPack?: () => ContractPack | null,
  ): void {
    this._blackboardGetSnapshot = getSnapshot;
    this._blackboardApplyOutput = applyOutput;
    this._blackboardGetGraph = getGraph;
    this._getActiveTeam = getActiveTeam;
    this._blackboardGetContractPack = getContractPack;
  }
  private _blackboardGetSnapshot?: () => string;
  private _blackboardApplyOutput?: (agentId: string, output: unknown) => void;
  private _blackboardGetGraph?: () => unknown;
  private _getActiveTeam?: () => string | null;
  private _blackboardGetContractPack?: () => ContractPack | null;

  private applyWorkerOutputToBlackboard(taskId: string, output: unknown): void {
    if (!this.isFullBlackboardMode()) return;
    this._blackboardApplyOutput?.(taskId, output);
  }
  /**
   * 变更影响上下文提供者 —— 由 ChangeImpactResolver 接入。
   * 给定任务的 working_directory + write_scope → 返回影响摘要字符串（注入 worker 的 task context）。
   * 返回空字符串则跳过注入。
   */
  private _getChangeImpactContext?: (taskId: string, workingDir: string) => string;

  /** 设置变更影响分析回调 (由 LeaderAgent 在初始化 ChangeImpactResolver 后调用) */
  setChangeImpactProvider(provider: (taskId: string, workingDir: string) => string): void {
    this._getChangeImpactContext = provider;
  }

  private getAdaptiveStrategyPlan(task: BoardTask, refresh = false): AdaptiveStrategyPlan {
    const existing = this.adaptivePlans.get(task.id);
    if (existing && !refresh) return existing;
    let projectModel;
    if (this.traceMemory) {
      try {
        projectModel = this.traceMemory.getProjectModel(task.working_directory || this.workspace);
      } catch (error) {
        agentLogger.debug(`[AgentPool] AdaptiveHarness project model skipped (${task.id}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const plan = this.adaptiveHarness.buildPlan({ task, projectModel });
    this.adaptivePlans.set(task.id, plan);
    return plan;
  }

  private applyAdaptiveContext(context: string | undefined, plan: AdaptiveStrategyPlan): string | undefined {
    const section = renderAdaptiveStrategyPlan(plan);
    if (!section) return context;
    return context?.trim()
      ? `${context}\n\n${section}`
      : section;
  }

  private buildAdaptiveOutcomeMetadata(
    task: BoardTask | undefined,
    plan: AdaptiveStrategyPlan | undefined,
    status: 'success' | 'failed',
  ): Record<string, unknown> | undefined {
    if (!task || !plan) return undefined;
    const metadata: Record<string, unknown> = {
      strategy: plan.strategy,
      ruleId: plan.ruleId,
      signals: plan.signals,
      params: plan.params,
      outcome: status,
    };
    if (status === 'failed') {
      const repairCount = Math.max(
        task.orchestration?.nodeKind === 'repair' ? 1 : 0,
        task.runGeneration ?? 0,
        task.orchestration?.generation ?? 0,
      );
      const trigger: EscalationTrigger | undefined = repairCount > 0
        ? { type: 'repair_attempts_exceeded', count: repairCount }
        : undefined;
      const nextStrategy = trigger ? this.adaptiveHarness.escalate(plan.strategy, trigger) : null;
      if (trigger && nextStrategy) {
        metadata.escalation = {
          trigger,
          nextStrategy,
          nextParams: this.adaptiveHarness.getStrategyParams(nextStrategy),
        };
        this.adaptivePlans.set(task.id, {
          ...plan,
          strategy: nextStrategy,
          ruleId: `escalated:${trigger.type}`,
          params: this.adaptiveHarness.getStrategyParams(nextStrategy),
        });
      }
    }
    return metadata;
  }

  broadcastSystemContext(content: string, excludeAgentName?: string): number {
    const clean = content.trim();
    if (!clean) return 0;
    let delivered = 0;
    for (const handle of this.agents.values()) {
      if (excludeAgentName && handle.name === excludeAgentName) continue;
      if (handle.status !== 'running' && handle.status !== 'starting') continue;
      this.bus.send(`${this.sessionId}:system`, this.sp(handle.name), 'system_context', clean);
      delivered++;
    }
    return delivered;
  }

  registerRemoteWorker(
    endpoint: string,
    capabilities: string[],
    options: Partial<Pick<RemoteWorkerDescriptor, 'id' | 'maxConcurrency' | 'region'>> = {},
  ): RemoteWorkerDescriptor {
    return registerRemoteWorkerDescriptor({
      registry: this.remoteWorkers,
      bus: this.bus,
      sessionId: this.sessionId,
      endpoint,
      capabilities,
      options,
    });
  }

  getRemoteWorkerRegistry(): RemoteWorkerRegistry {
    return this.remoteWorkers;
  }

  private isFullBlackboardMode(): boolean {
    try {
      return resolveModeRuntimeProjection({
        sessionId: this.sessionId,
        db: this.db,
        blackboardAvailable: Boolean(this._blackboardGetSnapshot || this._blackboardGetGraph),
      }).blackboard.mode === 'full';
    } catch {
      return false;
    }
  }

  broadcastBlackboardDelta(delta: BlackboardDelta, excludeAgentName?: string): number {
    if (!this.isFullBlackboardMode()) return 0;
    return broadcastBlackboardDeltaToAgents({
      delta,
      excludeAgentName,
      agents: this.agents.values(),
      taskBoard: this.taskBoard,
      bus: this.bus,
      sessionId: this.sessionId,
      sp: (name) => this.sp(name),
    });
  }

  private broadcastWorkNoteAwareness(note: WorkNote, sourceAgentId: string): number {
    return broadcastWorkNoteAwarenessToAgents({
      note,
      sourceAgentId,
      agents: this.agents.values(),
      bus: this.bus,
      sessionId: this.sessionId,
      sp: (name) => this.sp(name),
    });
  }

  protected emitInteractiveRuntimeState(handle: AgentHandle | undefined): void {
    if (!handle?.interactiveRuntime) {
      return;
    }
    this.emitter.emit('agent:interactive_state', {
      sessionId: this.sessionId,
      agentId: handle.agentId,
      agentName: handle.name,
      taskId: handle.taskId,
      state: handle.interactiveRuntime.getSnapshot(),
    });
  }

  /**
   * 统一的 agent:* 事件出口。
   *
   * 从 handle 自动注入 sessionId / agentId / agentName / taskId，
   * 调用方只填差异字段，杜绝零散 emit 漏字段（导致 SseBridge 因 sessionId 缺失丢弃事件）。
   *
   * 仅服务于带 handle 的事件；agent:spawned / agent:interactive_state 等已有专用方法的不走此出口。
   */
  protected emitAgentEvent<T extends EventName>(
    handle: AgentHandle,
    kind: T,
    extra: AgentEventExtra<T>,
  ): void {
    const payload = {
      sessionId: this.sessionId,
      agentId: handle.agentId,
      agentName: handle.name,
      taskId: handle.taskId,
      ...extra,
    } as EventMap[T];
    this.emitter.emit(kind, payload);
  }

  protected markAgentRecovering(
    handle: AgentHandle,
    faultClass: RecoveryFaultClass,
    reason: string,
    diagnostics?: WorkerRecoveryPayload['diagnostics'],
    llmErrorKind?: LLMErrorKind,
  ): WorkerRecoveryPayload {
    return this.faultRecovery.markRecovering(handle, faultClass, reason, diagnostics, llmErrorKind);
  }

  private maybeAutoRetryRecoveringWorker(
    handle: AgentHandle,
    recovery: WorkerRecoveryPayload,
  ): boolean {
    return this.faultRecovery.maybeAutoRetryRecoveringWorker(handle, recovery);
  }

  private markRecoveryAutoRetryFailed(
    recovery: WorkerRecoveryPayload,
    reason: string,
  ): void {
    this.faultRecovery.markAutoRetryFailed(recovery, reason);
  }

  markAgentRecoveringFromSupervisor(
    handle: AgentHandle,
    faultClass: RecoveryFaultClass,
    reason: string,
  ): void {
    this.markAgentRecovering(handle, faultClass, reason);
  }

  /**
   * 构造 FaultRecovery 恢复执行路径的宿主上下文：把 AgentPool 自身的字段/方法
   * 以结构化对象交给子模块。子模块只依赖这个最小面，不反向 import 整个巨类。
   *
   * 恢复/终止顺序语义敏感（并发核心路径），这里只做直通委托，不改任何调用顺序。
   */
  private buildRecoveryHostContext(): RecoveryHostContext {
    return {
      sessionId: this.sessionId,
      db: this.db,
      taskBoard: this.taskBoard,
      roleRegistry: this.roleRegistry,
      emitter: this.emitter,
      autoRetryRecoveries: this.autoRetryRecoveries,
      maxRecoveryAttempts: AgentPool.MAX_RECOVERY_ATTEMPTS,
      sp: (name) => this.sp(name),
      getTaskRunGeneration: (handle) => this.getTaskRunGeneration(handle as AgentHandle),
      forceStopAgent: (handle, exitReason, reason) => {
        this.forceStopAgent(handle as AgentHandle, exitReason, reason);
      },
      cleanupWorkerInboxBridge: (handle) => {
        this.cleanupWorkerInboxBridge(handle as AgentHandle);
      },
      emitInteractiveRuntimeState: (handle) => {
        this.emitInteractiveRuntimeState(handle as AgentHandle | undefined);
      },
      releaseHeavyResources: (handle) => {
        this.releaseHeavyResources(handle as AgentHandle);
      },
      releaseHandleForTask: (taskId, reason) => this.releaseHandleForTask(taskId, reason),
      sendCriticalBusMessageToLeader: (from, type, payload) => {
        this.sendCriticalBusMessageToLeader(from, type, payload);
      },
      respawnAgent: (handle, task, leaderMessage, options) =>
        this.respawnAgent(handle as AgentHandle, task, leaderMessage, options),
    };
  }

  /**
   * 交互运行时事件处理器（agent:progress / tool_output / terminal:* / permission:* / ...）。
   *
   * 实现已下沉到 WorkerEventHandlerBinder（事件集合与原实现完全一致：不丢不增）。
   * 保留为薄委托，public 接口签名不变。
   */
  protected setupInteractiveRuntimeEventHandlers(): void {
    this.eventBinder.setupInteractiveRuntimeEventHandlers();
  }

  /**
   * 注册新 Agent
   *
   * P0 #3 修复：调度/唤醒/workflow 三路可能同名 register（normalizedName 撞车）。
   * 旧实现直接 `this.agents.set` 覆盖，前一个 handle 仍在 starting/running，
   * 但 Map 里已指向新 handle —— 第一份 worker 进程变成了无人持有的"僵尸"，
   * 后续 worker:complete/exit by workerId 会错改第二个 handle 的状态。
   *
   * 新策略：
   *   - 已存在且非 stopped：拒绝（抛错），由调用方决定是 reuse 还是先 stopAgent。
   *   - 已存在但 stopped：允许复用 normalizedName（valid transition 已支持 stopped→starting，
   *     但旧 handle 仍可能被外部代码持有；为安全这里覆盖前先 cleanup bus 注册）。
   */
  register(name: string, roleType: string, taskId: string, agentId?: string): AgentHandle {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const existing = this.agents.get(normalizedName);
    if (existing && existing.status !== 'stopped') {
      throw new Error(
        `[AgentPool] register 拒绝：同名 Agent "${normalizedName}" 仍处于 ${existing.status}（agentId=${existing.agentId}, taskId=${existing.taskId}）；调用方必须先 stopAgent 或选择不同的 name。`,
      );
    }
    const resolvedAgentId = agentId || `agent-${Date.now()}-${this.agentCounter++}`;
    const handle: AgentHandle = {
      agentId: resolvedAgentId,
      name: normalizedName,
      roleType,
      taskId,
      status: 'starting',
      startTime: Date.now(),
      interactiveRuntime: new WorkerInteractiveRuntime(resolvedAgentId, normalizedName),
    };

    this.agents.set(normalizedName, handle);
    this.bus.register(this.sp(normalizedName));
    handle.interactiveRuntime?.setStatus('starting');
    this.emitInteractiveRuntimeState(handle);
    // 注册后检查池大小，超限时清理最旧的已完成 handle
    this.enforcePoolSizeLimit();
    return handle;
  }

  /**
   * Prepare the canonical worker runtime for a task without constructing an
   * in-process agent instance.
   */
  prepareWorkerRuntime(handle: AgentHandle, _task: BoardTask): void {
    const role = handle.runtimeRole || this.roleRegistry.get(handle.roleType);
    if (!role) {
      throw new Error(t('error.role_not_found', handle.roleType));
    }
    handle.runtimeRole = role;
    handle.interactiveRuntime?.setStatus('running');
    this.emitInteractiveRuntimeState(handle);
  }

  private async loadInheritedWorkerHistory(handle: AgentHandle): Promise<WorkerTaskPayload['conversationHistory'] | undefined> {
    return loadInheritedWorkerHistory({
      db: this.db,
      sessionId: this.sessionId,
      agentId: handle.agentId,
      agentName: handle.name,
      logger: agentLogger,
    });
  }

  private async buildWorkerPayload(
    handle: AgentHandle,
    task: BoardTask,
    role: AgentRole,
    options: {
      conversationHistory?: WorkerTaskPayload['conversationHistory'];
      inheritHistoryMode?: 'resume' | 'new_task';
      logPrefix?: string;
    } = {},
  ): Promise<WorkerTaskPayload> {
    const payload = await buildWorkerPayload({
      sessionId: this.sessionId,
      workspace: this.workspace,
      db: this.db,
      workNoteManager: this.workNoteManager,
      handle,
      task,
      role,
      agentModel: globalConfig.llm.agent_model,
      maxIterations: AGENT_MAX_ITERATIONS,
      maxRuntimeMinutes: AGENT_MAX_RUNTIME_MINUTES,
      getBlackboardSnapshot: this._blackboardGetSnapshot,
      getContractPack: this._blackboardGetContractPack,
      getChangeImpactContext: this._getChangeImpactContext,
      logger: agentLogger,
      options,
    });
    if (payload.adaptiveStrategy) {
      this.adaptivePlans.set(task.id, payload.adaptiveStrategy);
    }
    return payload;
  }

  /**
   * 追问机制：重新 spawn 一个已完成/已清理的 Agent，加载完整对话历史
   *
   * 限速 (2026-05-28)：
   * - 60s 内 respawn 次数 ≥ MAX_RESPAWN_PER_WINDOW → 拒绝。
   * - 连续 spawn 失败次数 ≥ MAX_CONSECUTIVE_RESPAWN_FAILURES → 拒绝。
   * 防止 Leader 反复 send_message_to_agent / autoRespawn 把机器跑爆、provider 配额耗尽。
   */
  async respawnAgent(
    handle: AgentHandle,
    task: BoardTask,
    leaderMessage?: string,
    options: AgentRespawnOptions = {},
  ): Promise<string> {
    // ─── 取代保护（deterministic，治「中断后再 @ 启动有概率卡死在等待新进展」）───
    // respawn 仅对「当前 in-map 的 handle」合法。同名 handle 一旦被更新的 register 取代
    // （用户 @-重启 / Leader 追问复用同名 slot 都先 register 新 handle），旧 handle 上挂着的
    // 滞后 recovery auto-retry（markAgentRecovering 的 backoff 定时器）到点再调本方法时，
    // 必须直接放弃——否则两路 respawn 抢同一 worker slot：
    //   · 败者 spawnWorker 撞 "already exists" → catch 把【in-map 的 newer handle】标 failed；
    //   · 胜者 worker 跑在【已被取代的旧 handle】上（orphan，不在 agents map）；
    //   · binder 的事件按 name 路由到 in-map 的 failed handle，status guard 把活 worker 的
    //     progress/heartbeat 全部丢弃 → agent 卡死「等待新进展」。
    // 放弃时不 spawn、不标失败、不污染状态：resolve('') 让调用方 .catch 不触发，新 handle 接管。
    if (this.agents.get(handle.name) !== handle) {
      const current = this.agents.get(handle.name);
      agentLogger.info(
        `[AgentPool] respawn 放弃：@${handle.name} 已被更新的 register 取代` +
        `（旧 agentId=${handle.agentId} → 现 agentId=${current?.agentId ?? '<none>'}），由新 handle 接管 spawn`,
      );
      return '';
    }
    // ─── Spawn 限速门 ───
    const now = Date.now();
    const WINDOW_MS = 60_000;
    const MAX_RESPAWN_PER_WINDOW = 3;
    const MAX_CONSECUTIVE_RESPAWN_FAILURES = 3;
    const stamps = (handle.respawnTimestampsMs ??= []);
    while (stamps.length > 0 && now - stamps[0] > WINDOW_MS) {
      stamps.shift();
    }
    if (stamps.length >= MAX_RESPAWN_PER_WINDOW) {
      const oldest = stamps[0];
      const waitMs = WINDOW_MS - (now - oldest);
      const msg = `Agent ${handle.name} respawn 过频：${WINDOW_MS / 1000}s 内已 spawn ${stamps.length} 次（上限 ${MAX_RESPAWN_PER_WINDOW}），${Math.ceil(waitMs / 1000)}s 后再试`;
      agentLogger.warn(`[AgentPool] ${msg}`);
      throw new Error(msg);
    }
    if ((handle.consecutiveRespawnFailures ?? 0) >= MAX_CONSECUTIVE_RESPAWN_FAILURES) {
      const msg = `Agent ${handle.name} 连续 respawn 失败 ${handle.consecutiveRespawnFailures} 次，停止重试，等待人工介入`;
      agentLogger.error(`[AgentPool] ${msg}`);
      throw new Error(msg);
    }
    stamps.push(now);

    // 等待上一代同名 worker 进程真正退出再复活：forceStop/stopAll 已发 SIGTERM，
    // 但进程 'exit' 事件可能尚未触发；若此时立即 spawn 同名新进程会短暂并存
    // （workspace/端口/文件锁竞争 + runner 复用 slot 时序坑）。上限 3s，超时强制继续。
    await this.workerRunner.awaitWorkerExit(handle.name, 3000);

    const role = handle.runtimeRole || this.roleRegistry.get(handle.roleType);
    if (!role) {
      throw new Error(t('error.role_not_found', handle.roleType));
    }

    // 1. 从 DB 加载完整对话历史
    let conversationHistory: WorkerTaskPayload['conversationHistory'] = [];
    if (this.db) {
      try {
        const history = await this.db.getAgentConversation(this.sessionId, handle.agentId);
        conversationHistory = history.map((msg) => ({
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          thinking: msg.thinking,
          timestamp: msg.timestamp,
        }));
      } catch (err) {
        agentLogger.warn(`[AgentPool] 加载 Agent ${handle.name} 历史对话失败:`, err instanceof Error ? err.message : String(err));
      }
    }

    // 2. 重置 handle 状态（register() 已设为 starting 时跳过重复转换）
    if (handle.status !== 'starting') {
      AgentPool.transitionAgentStatus(handle, 'starting');
    }
    handle.startTime = Date.now();
    handle.endTime = undefined;
    handle.error = undefined;
    handle.exitReason = undefined;  // 复活：清掉上次的终止原因（terminated/failed/...），否则 starting 态残留 stale exitReason
    handle.completionReceived = false;  // 复位 Bug5 完成回执屏障：否则上一代 completed 的残留 true 会压制新进程的崩溃/超时恢复
    handle.asyncTask = undefined;
    handle.workerHandle = undefined;
    handle.interactiveRuntime ??= new WorkerInteractiveRuntime(handle.agentId, handle.name);
    this.bindTaskRunGeneration(handle, task);
    this.bus.register(this.sp(handle.name));
    handle.interactiveRuntime?.setStatus('starting');
    this.emitInteractiveRuntimeState(handle);

    // 3/4. 构建 payload 并启动 Worker 子进程。recovery 模式下，任一启动前失败都
    // 保留 runtime_recovery 记录给 Leader 接管，不把任务伪造成 task_failed。
    let workerHandle: WorkerHandle;
    try {
      const payload = await this.buildWorkerPayload(handle, task, role, {
        conversationHistory,
        inheritHistoryMode: 'resume',
        logPrefix: 'respawn',
      });
      const workerEnv = {
        LINGXIAO_SESSION_ID: this.sessionId,
        LINGXIAO_AGENT_NAME: handle.name,
        LINGXIAO_WORKSPACE: this.workspace,
      };
      workerHandle = await this.workerRunner.spawnWorker(payload, withToolProxyEnv({
        ...workerEnv,
        ...buildLocalLlmGatewayEnv({ ...process.env, ...workerEnv }),
      }));
    } catch (error) {
      handle.consecutiveRespawnFailures = (handle.consecutiveRespawnFailures ?? 0) + 1;
      const startupError = error instanceof Error ? error : new Error(String(error));
      if (options.failureMode === 'recovery') {
        this.forceStopAgent(handle, 'crashed', startupError.message);
        handle.interactiveRuntime?.setStatus('failed');
        handle.interactiveRuntime?.clearQueuedMessages();
        handle.interactiveRuntime?.clearAllToolOutputs();
        this.cleanupWorkerInboxBridge(handle);
        this.emitInteractiveRuntimeState(handle);
        this.releaseHeavyResources(handle);
      } else {
        this.markAgentFailed(handle, startupError, 'startup');
      }
      throw startupError;
    }
    // spawn 成功 → 立即清零失败计数（settle 时再不动它，避免后续 worker 退出时被误清零）
    handle.consecutiveRespawnFailures = 0;

    handle.workerHandle = workerHandle;
    AgentPool.transitionAgentStatus(handle, 'running');
    this.installWorkerInboxBridge(handle);
    handle.interactiveRuntime?.setStatus('running');
    this.emitInteractiveRuntimeState(handle);
    this.clearRecoveryRecordAndNotify(handle.taskId);

    // 5. 如果有 Leader 追问消息，立即投递
    if (leaderMessage) {
      setTimeout(() => {
        this.bus.send(this.leaderBusName, this.sp(handle.name), 'user_intervention', leaderMessage);
      }, 500); // 等待 worker 初始化完成
    }

    // 6. 等待完成 — 与 runAgentWrapper 对齐：仅由 worker:complete / worker:failed /
    //    agent:crashed 三个事件 settle，超时由 WorkerProcessRunner 兜底。
    return new Promise((resolve, reject) => {
      let settled = false;

      const onComplete = (completedId: string, result: unknown) => {
        if (settled || completedId !== handle.name) return;
        settled = true;
        cleanup();
        this.scheduleHandleCleanup(handle.name);
        try {
          resolve(this.parseWorkerCompletionPayload(result).result);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onFailed = (failedId: string, error: unknown) => {
        if (settled || failedId !== handle.name) return;
        const failure = parseWorkerFailurePayload(error);
        if (failure.terminalKind === 'terminated' || failure.recoverable) {
          return;
        }
        settled = true;
        cleanup();
        this.scheduleHandleCleanup(handle.name);
        reject(failure.error);
      };

      const onCrashed = (event: unknown) => {
        if (settled) return;
        const e = event as { name?: string; status?: string; exitCode?: number | null; recoverable?: boolean; recoveryAction?: string };
        if (e && typeof e === 'object' && e.name === handle.name) {
          if (
            this.autoRetryRecoveries &&
            e.recoverable === true &&
            (e.recoveryAction === 'worker_restart' || e.recoveryAction === 'worker_redispatch')
          ) {
            return;
          }
          settled = true;
          cleanup();
          this.scheduleHandleCleanup(handle.name);
          const reason = e.status === 'timeout'
            ? `worker timeout (exit=${e.exitCode ?? 'unknown'})`
            : `worker crashed (exit=${e.exitCode ?? 'unknown'})`;
          reject(new Error(`Agent ${handle.name} ${reason}`));
        }
      };

      const cleanup = () => {
        this.workerRunner.off('worker:complete', onComplete);
        this.workerRunner.off('worker:failed', onFailed);
        this.emitter.off('agent:crashed', onCrashed);
      };

      this.workerRunner.on('worker:complete', onComplete);
      this.workerRunner.on('worker:failed', onFailed);
      this.emitter.on('agent:crashed', onCrashed);
    });
  }

  /**
   * 1.2: 运行 Agent - 使用 WorkerProcessRunner 启动子进程
   */
  async runAgentWrapper(
    handle: AgentHandle,
    task: BoardTask,
    _isResume = false,
    _recoveredState?: { iteration?: number; toolCallCount?: number },
  ): Promise<string> {
    const generation = this.bindTaskRunGeneration(handle, task);
    const slotKey = `${task.id}:${generation}`;
    const queuedAt = Date.now();
    await this.slotScheduler.acquireOrWait(slotKey);
    const slotWaitMs = Date.now() - queuedAt;
    if (slotWaitMs > 0) {
      this.emitAgentEvent(handle, 'agent:status', {
        status: `dispatch slot acquired after ${slotWaitMs}ms`,
      });
    }
    try {
      return await this.runAgentWrapperDispatched(handle, task, _isResume, _recoveredState, slotWaitMs);
    } finally {
      this.slotScheduler.release(slotKey);
    }
  }

  private async runAgentWrapperDispatched(
    handle: AgentHandle,
    task: BoardTask,
    _isResume = false,
    _recoveredState?: { iteration?: number; toolCallCount?: number },
    slotWaitMs = 0,
  ): Promise<string> {
    return dispatchAgent(this.asDispatchContext(), handle, task, slotWaitMs);
  }

  /**
   * 构造 AgentDispatchContext：把 protected/private 成员收口为结构化上下文对象，
   * 供下沉到 SlotScheduler.dispatchAgent 的执行体使用，避免其直接依赖整个 pool 句柄。
   */
  private asDispatchContext(): AgentDispatchContext {
    return {
      sessionId: this.sessionId,
      workspace: this.workspace,
      bus: this.bus,
      emitter: this.emitter,
      taskBoard: this.taskBoard,
      roleRegistry: this.roleRegistry,
      workerRunner: this.workerRunner,
      remoteWorkers: this.remoteWorkers,
      autoRetryRecoveries: this.autoRetryRecoveries,
      sp: (name) => this.sp(name),
      transitionAgentStatusInstance: (h, s) => this.transitionAgentStatusInstance(h, s),
      parseWorkerFailurePayloadInstance: (e) => this.parseWorkerFailurePayloadInstance(e),
      bindTaskRunGeneration: (h, t) => this.bindTaskRunGeneration(h, t),
      getTaskRunGeneration: (h) => this.getTaskRunGeneration(h),
      emitAgentEvent: (h, e, p) => this.emitAgentEvent(h, e as EventName, p),
      emitInteractiveRuntimeState: (h) => this.emitInteractiveRuntimeState(h),
      clearRecoveryRecordAndNotify: (id) => this.clearRecoveryRecordAndNotify(id),
      installWorkerInboxBridge: (h) => this.installWorkerInboxBridge(h),
      scheduleHandleCleanup: (n) => this.scheduleHandleCleanup(n),
      loadInheritedWorkerHistory: (h) => this.loadInheritedWorkerHistory(h),
      buildWorkerPayload: (h, t, r, o) => this.buildWorkerPayload(h, t, r, o),
      parseWorkerCompletionPayload: (r) => this.parseWorkerCompletionPayload(r),
      markAgentFailed: (h, e, s) => this.markAgentFailed(h, e, s),
      recordTaskResultPendingAcceptance: (h, r, c) => this.recordTaskResultPendingAcceptance(h, r, c),
      applyWorkerOutputToBlackboard: (id, r) => this.applyWorkerOutputToBlackboard(id, r),
      releaseHeavyResources: (h) => this.releaseHeavyResources(h),
      sendCriticalBusMessageToLeader: (to, type, p) => this.sendCriticalBusMessageToLeader(to, type, p),
      runExternalAgent: (h, r, t) => this.runExternalAgent(h, r, t),
    };
  }

  protected async assertExternalCompletionAccepted(
    task: BoardTask,
    role: AgentRole,
    completionReport: ExternalCompletionReport,
    modelId: string,
  ): Promise<void> {
    assertSpeculativeWinnerEvidenceVerified(completionReport.speculativeWinner);
    const verification = await runCompletionVerification({
      workingDir: task.working_directory || this.workspace,
      artifacts: completionReport.artifacts,
    });
    const hardDecision = evaluateWorkerCompletionHardGuards({
      final: completionReport.result,
      task,
      role: role.name || task.agent_type || 'external',
      messages: [],
      contractCompliance: completionReport.contract_compliance,
      verification,
    });
    if (hardDecision && !hardDecision.accepted) {
      throw new ExternalAgentProtocolError(hardDecision.reason, hardDecision.feedback);
    }
    const adversarialPolicy = extractAdversarialBreakerPolicy(task.orchestration);
    const adversarial = await runAdversarialBreaker({
      workingDir: task.working_directory || this.workspace,
      policy: adversarialPolicy,
    });
    if (adversarial.verdict !== 'PASS') {
      throw new ExternalAgentProtocolError(
        `adversarial_${adversarial.verdict.toLowerCase()}`,
        formatAdversarialBreakerFeedback(adversarial),
      );
    }
    const decision = await evaluateWorkerCompletionCandidate({
      final: completionReport.result,
      task,
      role: role.name || task.agent_type || 'external',
      messages: [],
      contractCompliance: completionReport.contract_compliance,
      verification,
      llm: this.llm,
      model: modelId,
    });
    if (!decision.accepted) {
      throw new ExternalAgentProtocolError(decision.reason, decision.feedback);
    }
  }

  protected async runExternalAgent(
    handle: AgentHandle,
    role: AgentRole,
    task: BoardTask,
  ): Promise<string> {
    return runExternalAgentExternal(this.asExternalRunContext(), handle, role, task);
  }

  /**
   * 构造 ExternalAgentRunContext：把 protected/private 成员收口为结构化上下文对象，
   * 供下沉到 ExternalAgentRunner.runExternalAgent 的执行体使用。
   */
  private asExternalRunContext(): ExternalAgentRunContext {
    return {
      sessionId: this.sessionId,
      workspace: this.workspace,
      tracker: this.tracker,
      db: this.db,
      emitter: this.emitter,
      bus: this.bus,
      taskBoard: this.taskBoard,
      leaderBusName: this.leaderBusName,
      sp: (name) => this.sp(name),
      transitionAgentStatus: (h, s) => this.transitionAgentStatusInstance(h, s),
      getTaskRunGeneration: (h) => this.getTaskRunGeneration(h),
      emitAgentEvent: (h, e, p) => this.emitAgentEvent(h, e as EventName, p),
      emitInteractiveRuntimeState: (h) => this.emitInteractiveRuntimeState(h),
      clearRecoveryRecordAndNotify: (id) => this.clearRecoveryRecordAndNotify(id),
      scheduleHandleCleanup: (n) => this.scheduleHandleCleanup(n),
      buildWorkerPayload: (h, t, r) => this.buildWorkerPayload(h, t, r),
      assertExternalCompletionAccepted: (t, r, c, m) => this.assertExternalCompletionAccepted(t, r, c, m),
      recordTaskResultPendingAcceptance: (h, r, c) => this.recordTaskResultPendingAcceptance(h, r, c),
      applyWorkerOutputToBlackboard: (id, r) => this.applyWorkerOutputToBlackboard(id, r),
      sendCriticalBusMessageToLeader: (to, type, p) => this.sendCriticalBusMessageToLeader(to, type, p),
      markAgentRecovering: (h, f, r, d) => this.markAgentRecovering(h, f, r, d),
    };
  }

  private collectCompletionFiles(completion?: StructuredCompletionPayload): string[] {
    const files = new Set<string>();
    const addTrace = (trace?: WorkerArtifactTrace): void => {
      for (const file of trace?.files_created ?? []) files.add(file);
      for (const file of trace?.files_modified ?? []) files.add(file);
    };
    addTrace(completion?.artifacts);
    addTrace(completion?.toolTrace);
    return [...files];
  }

  private collectCompletionCommands(completion?: StructuredCompletionPayload): string[] {
    const commands = new Set<string>();
    for (const command of completion?.artifacts?.commands_run ?? []) commands.add(command);
    for (const command of completion?.toolTrace?.commands_run ?? []) commands.add(command);
    return [...commands];
  }

  private recordWorkerExecutionTrace(
    handle: AgentHandle,
    status: 'success' | 'failed',
    input: {
      completion?: StructuredCompletionPayload;
      error?: Error;
      source: string;
    },
  ): void {
    if (!this.traceMemory) return;
    try {
      const task = this.taskBoard.getTask(handle.taskId);
      const projectRoot = task?.working_directory || this.workspace;
      const adaptivePlan = task ? this.getAdaptiveStrategyPlan(task) : undefined;
      const adaptiveOutcome = this.buildAdaptiveOutcomeMetadata(task, adaptivePlan, status);
      this.traceMemory.recordTrace({
        projectRoot,
        sessionId: this.sessionId,
        taskId: handle.taskId,
        agentId: handle.agentId,
        agentName: handle.name,
        agentRole: handle.roleType,
        taskType: task?.taskType || (task as { task_type?: string } | undefined)?.task_type || task?.agent_type || handle.roleType,
        status,
        durationMs: Math.max(0, (handle.endTime ?? Date.now()) - handle.startTime),
        filesChanged: status === 'success' ? this.collectCompletionFiles(input.completion) : [],
        errorSignature: input.error?.message,
        verification: input.completion?.verification,
        metadata: {
          source: input.source,
          taskRunGeneration: this.getTaskRunGeneration(handle),
          workerBackend: handle.workerBackend ?? 'worker_process',
          commandsRun: this.collectCompletionCommands(input.completion),
          ...(adaptiveOutcome ? { adaptive: adaptiveOutcome } : {}),
        },
      });
      this.traceMemory.rebuildProjectModel(projectRoot);
    } catch (error) {
      agentLogger.warn(`[AgentPool] ExecutionTraceMemory 记录失败 (${handle.taskId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected recordTaskResultPendingAcceptance(
    handle: AgentHandle,
    result: string,
    completion?: StructuredCompletionPayload,
  ): void {
    const persistedResult = buildArtifactAwarenessBlock({
      source: 'worker_completion',
      taskId: handle.taskId,
      agentId: handle.name,
      result,
      summary: completion?.summary,
      artifacts: completion?.artifacts,
      toolTrace: completion?.toolTrace,
      evidenceRefs: completion?.evidence_refs,
      contractCompliance: completion?.contract_compliance,
      verification: completion?.verification,
      nextSteps: completion?.next_steps,
    });

    try {
      const task = this.taskBoard.getTask(handle.taskId);
      if (task && task.status !== 'terminal') {
        this.taskBoard.completeTask(handle.taskId, persistedResult);
      }
    } catch (err) {
      agentLogger.warn(`[AgentPool] TaskBoard.completeTask 失败 (${handle.taskId}): ${err instanceof Error ? err.message : String(err)}`);
    }
    this.recordWorkerExecutionTrace(handle, 'success', {
      completion,
      source: 'task_complete',
    });
  }

  protected markAgentFailed(handle: AgentHandle, error: Error, source = 'runtime'): void {
    this.forceStopAgent(handle, 'failed', error.message);
    handle.error = error;
    handle.interactiveRuntime?.setStatus('failed');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    this.cleanupWorkerInboxBridge(handle);
    // 同 worker:complete —— 不在失败时 detachFromTeam，保留 team 成员注册记录。
    this.emitInteractiveRuntimeState(handle);
    // 最终 emit 后立即释放重型资源
    this.releaseHeavyResources(handle);
    this.clearRecoveryRecordAndNotify(handle.taskId);

    try {
      const task = this.taskBoard.getTask(handle.taskId);
      if (task && task.status !== 'terminal') {
        this.taskBoard.failTask(handle.taskId, error.message);
      }
    } catch (err) {
      agentLogger.warn(`[AgentPool] TaskBoard.failTask 失败 (${handle.taskId}): ${err instanceof Error ? err.message : String(err)}`);
    }

    this.recordWorkerExecutionTrace(handle, 'failed', {
      error,
      source,
    });

    const diagnostics = this.buildWorkerFailureDiagnostics(handle);
    this.sendCriticalBusMessageToLeader(this.sp(handle.name), 'task_failed', createTaskFailedPayload(handle.taskId, error.message, {
      taskRunGeneration: this.getTaskRunGeneration(handle),
      diagnostics,
    }));
    this.emitAgentEvent(handle, 'agent:failed', {
      error: error.message,
      source,
      backend: 'worker_process',
      pid: diagnostics?.pid,
      recoverable: false,
      stderrTail: diagnostics?.stderrTail,
      stdoutTail: diagnostics?.stdoutTail,
      errorDetail: diagnostics?.error,
    });
  }

  protected markAgentTerminated(handle: AgentHandle, reason: string): void {
    this.workerLifecycle.markTerminated(handle, reason);
  }

  /**
   * 构造 WorkerLifecycle 终止路径的宿主上下文：把 AgentPool 自身的字段/方法
   * 以结构化对象交给子模块。子模块只依赖这个最小面，不反向 import 整个巨类。
   *
   * 终止顺序语义敏感（并发核心路径），这里只做直通委托，不改任何调用顺序。
   */
  private buildLifecycleHostContext(): TerminationHostContext {
    return {
      sessionId: this.sessionId,
      db: this.db,
      emitter: this.emitter,
      forceStopAgent: (handle, exitReason, reason) => {
        this.forceStopAgent(handle as AgentHandle, exitReason, reason);
      },
      cleanupWorkerInboxBridge: (handle) => {
        this.cleanupWorkerInboxBridge(handle as AgentHandle);
      },
      emitInteractiveRuntimeState: (handle) => {
        this.emitInteractiveRuntimeState(handle as AgentHandle | undefined);
      },
      releaseHeavyResources: (handle) => {
        this.releaseHeavyResources(handle as AgentHandle);
      },
      emitAgentEvent: (handle, kind, extra) => {
        this.emitAgentEvent(handle as AgentHandle, kind, extra as AgentEventExtra<typeof kind>);
      },
    };
  }

  /** 获取运行中的 Agent */
  getRunning(): AgentHandle[] {
    return Array.from(this.agents.values()).filter(h => isAgentRuntimeActiveStatus(h));
  }

  /** TeamCommunicationService 用：判断目标 agent 当前是否可接收 bus 推送。 */
  isAgentRunning(agentName: string): boolean {
    const handle = this.agents.get(AgentPool.normalizeAgentName(agentName));
    return !!handle && isAgentRuntimeActiveStatus(handle);
  }

  /**
   * TeamCommunicationService 用：目标 agent 已离线、但 team 消息已落 mailbox 时，
   * 尝试把它复活去读邮箱补漏（worker 启动会先 team_inbox）。
   *
   * - 仅对「曾被派发过」的 agent 生效：从内存 handle 或 DB agent_state 找回
   *   agentId / roleType / taskId；从未派发的成员（没有任何运行记录）直接放弃。
   * - 已在运行 / starting：无需复活。
   * - respawnAgent 自带 60s 内 3 次的限速门，防止 team 消息把同一 agent 反复拉起。
   * fire-and-forget：不阻塞 routeDirect；复活后的投递由 mailbox 兜底。
   */
  reviveAgentForTeamMessage(agentName: string): void {
    const normalized = AgentPool.normalizeAgentName(agentName);
    if (this.isAgentRunning(normalized)) return;

    const existing = this.agents.get(normalized);
    // 已存在但非终态（不该走到这里，防御性跳过：register 会拒绝非 stopped 复用）
    if (existing && existing.status !== 'stopped') return;

    let agentId = existing?.agentId;
    let roleType = existing?.roleType;
    let taskId = existing?.taskId;

    if (!agentId || !roleType || !taskId) {
      try {
        const latest = this.db.getAgentStates(this.sessionId)
          .filter((s) => AgentPool.normalizeAgentName(s.agent_name) === normalized)
          .sort((a, b) => b.timestamp - a.timestamp)[0];
        if (latest) {
          agentId = latest.agent_id;
          roleType = latest.agent_role;
          taskId = latest.task_id;
        }
      } catch { /* DB 不可用则放弃复活 */ }
    }

    // 从未派发 → 没有任何运行记录 → 无法复活（消息留在 mailbox，上线后补漏）
    if (!agentId || !roleType || !taskId) return;

    const task = this.taskBoard?.getTask(taskId);
    if (!task) return;

    try {
      const handle = this.register(normalized, roleType, taskId, agentId);
      const respawnPromise = this.respawnAgent(handle, task);
      handle.asyncTask = respawnPromise;
      void respawnPromise.catch((err) => {
        agentLogger.warn(`[AgentPool] team 消息触发 @${normalized} 复活失败: ${err instanceof Error ? err.message : String(err)}`);
      });
      agentLogger.info(`[AgentPool] team 消息触发 @${normalized} 复活（加载历史 + 读邮箱补漏）`);
    } catch (err) {
      agentLogger.warn(`[AgentPool] team 消息触发 @${normalized} 复活启动失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 按名字找回该 worker 上一次运行使用的 agentId。
   *
   * Why：对话历史表 agent_conversation 以 agentId 为主键存取，而"复用同名 worker
   * 跑下一个任务"时，register() 默认会铸造一个全新 agentId → 新 agentId 查不到任何历史，
   * 导致同名复用变成"白复用"（上下文没继承）。dispatch 路径调用本方法拿到旧 agentId 传给
   * register()，让新 worker 与历史对话接上。
   *
   * 查找顺序：
   *   1. 内存里同名且已 stopped 的 handle（5min 内未被 cleanup）→ 直接复用其 agentId。
   *   2. fallback：DB agent_state 里按名字过滤、取 timestamp 最新一条的 agent_id。
   * 找不到（从未派发过该名字）→ undefined，register() 会照常铸造新 agentId（全新 worker）。
   *
   * 注意：只在"可复用"（stopped / 不存在）时返回；同名仍在运行的情况由 register() 抛错拦截，
   * 这里返回 undefined 让调用链走正常的拒绝路径。
   */
  resolvePriorAgentId(name: string): string | undefined {
    const normalized = AgentPool.normalizeAgentName(name);
    const existing = this.agents.get(normalized);
    if (existing) {
      return existing.status === 'stopped' ? existing.agentId : undefined;
    }
    if (!this.db) return undefined;
    try {
      const latest = this.db.getAgentStates(this.sessionId)
        .filter((s) => AgentPool.normalizeAgentName(s.agent_name) === normalized)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      return latest?.agent_id || undefined;
    } catch {/* expected: resource not available */
      return undefined;
    }
  }

  /**
   * 获取所有 Agent
   */
  getAll(): AgentHandle[] {
    return Array.from(this.agents.values());
  }

  /**
   * 根据名称获取 Agent
   */
  getByName(name: string): AgentHandle | undefined {
    return this.agents.get(AgentPool.normalizeAgentName(name));
  }

  /**
   * 根据 ID 获取 Agent
   */
  getById(agentId: string): AgentHandle | undefined {
    for (const handle of this.agents.values()) {
      if (handle.agentId === agentId) {
        return handle;
      }
    }
    return undefined;
  }

  /**
   * 1.2/1.3: 停止指定 Agent（通过 WorkerProcessRunner 终止子进程）
   */
  stopAgent(name: string): void {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return;

    // 终止子进程
    if (handle.externalStop) {
      handle.externalStop('stopped by AgentPool');
    }
    if (handle.workerHandle) {
      this.workerRunner.killWorker(normalizedName, 'stopped by AgentPool');
    }
    this.cleanupWorkerInboxBridge(handle);
    // 不 detachFromTeam —— 团队成员注册由 team_manage(action="edit", edit_action="remove") / team_manage(action="delete") 显式管理，
    // 与 worker:complete 路径一致。否则只摘 registry 不动 mailbox.members，会造成
    // dispatch 网关（读 registry）说"不在 roster"、team_manage(edit/add)（读 mailbox）说"已在 team"的双源死锁。

    this.forceStopAgent(handle, 'terminated', 'stopped by AgentPool');
    handle.interactiveRuntime?.setStatus('interrupted');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    this.emitInteractiveRuntimeState(handle);
    // 发 agent:terminated 事件，使前端 AgentTerminated handler 触发并更新 agentConversations 状态
    this.emitAgentEvent(handle, 'agent:terminated', {
      status: 'interrupted',
      reason: 'stopped by AgentPool',
    });
    // 立即释放重型资源
    this.releaseHeavyResources(handle);
  }

  completeAgent(name: string, reason = 'completed by leader'): AgentHandle | undefined {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return undefined;

    if (handle.externalStop) {
      handle.externalStop(reason);
    }
    if (handle.workerHandle) {
      this.workerRunner.killWorker(normalizedName, reason);
    }
    this.cleanupWorkerInboxBridge(handle);
    // 不 detachFromTeam —— completeAgent 是"任务做完收工"，成员仍应留在 roster 供复用/再派。

    this.forceStopAgent(handle, 'completed', reason);
    handle.interactiveRuntime?.setStatus('completed');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    this.emitInteractiveRuntimeState(handle);
    this.scheduleHandleCleanup(handle.name);
    return handle;
  }

  /**
   * 暂停指定 Agent（保留进度，不杀进程）
   * 注意：新状态模型中不再有 paused 状态，暂停操作保持 running 状态
   */
  pauseAgent(name: string): void {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return;

    // 保持 running 状态，通过 interactiveRuntime 标记暂停。
    handle.interactiveRuntime?.setStatus('paused');
    this.emitInteractiveRuntimeState(handle);
  }

  /**
   * 恢复暂停的 Agent
   */
  resumeAgent(name: string): void {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return;

    // 发送恢复消息到 Agent 的收件箱
    this.bus?.send(this.leaderBusName, this.sp(normalizedName), 'message', {
      sessionId: this.sessionId,
      content: '[RESUME]',
    });

    // 确保状态为 running
    if (handle.status !== 'running') {
      AgentPool.transitionAgentStatus(handle, 'running');
    }
    handle.interactiveRuntime?.setStatus('running');
    this.emitInteractiveRuntimeState(handle);
  }

  /**
   * 干预指定 Agent（停下来，注入指令，等待用户确认）
   * 注意：新状态模型中不再有 stalled 状态，干预操作保持 running 状态
   */
  interveneAgent(name: string, instruction: string): void {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return;

    // 发送干预消息到 Agent 的收件箱
    this.bus?.send(this.leaderBusName, this.sp(normalizedName), 'intervene', {
      sessionId: this.sessionId,
      content: `[INTERVENE: ${instruction}]`,
      instruction,
    });

    // 保持 running 状态，通过 interactiveRuntime 标记 stalled
    handle.interactiveRuntime?.setStatus('stalled');
    this.emitInteractiveRuntimeState(handle);
  }

  /**
   * 确认干预，让 Agent 继续执行
   */
  confirmIntervention(name: string): void {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return;

    // 发送确认消息到 Agent 的收件箱
    this.bus?.send(this.leaderBusName, this.sp(normalizedName), 'message', {
      sessionId: this.sessionId,
      content: '[CONTINUE]',
    });

    // 确保状态为 running
    if (handle.status !== 'running') {
      AgentPool.transitionAgentStatus(handle, 'running');
    }
    handle.interactiveRuntime?.setStatus('running');
    this.emitInteractiveRuntimeState(handle);
  }

  /**
   * 完全终止指定 Agent（不可恢复，丢弃进度）
   */
  terminateAgent(name: string, reason?: string): void {
    const normalizedName = AgentPool.normalizeAgentName(name);
    const handle = this.agents.get(normalizedName);
    if (!handle) return;

    // 终止子进程
    if (handle.externalStop) {
      handle.externalStop('terminated by user');
    }
    if (handle.workerHandle) {
      this.workerRunner.killWorker(normalizedName, 'terminated by user');
    }
    this.cleanupWorkerInboxBridge(handle);
    // 不 detachFromTeam —— 终止只是结束这次运行，成员仍留在 team roster，
    // 便于 leader 重新 dispatch 同名 agent 跑别的任务。团队成员的增删交给
    // team_manage(edit/remove) / team_manage(delete) 显式管理，保持 registry 与 mailbox.members 单一真源一致。

    this.forceStopAgent(handle, 'terminated', reason ?? 'terminated by user');
    handle.interactiveRuntime?.setStatus('terminated');
    handle.interactiveRuntime?.clearQueuedMessages();
    handle.interactiveRuntime?.clearAllToolOutputs();
    this.emitInteractiveRuntimeState(handle);
    // 立即释放重型资源
    this.releaseHeavyResources(handle);

    this.emitAgentEvent(handle, 'agent:terminated', {
      status: 'stopped',
      reason,
    });
  }

  /**
   * 1.2/1.3: 停止所有 Agent
   */
  stopAll(): void {
    // 先标记所有活跃 handle 为终态，阻止后续 Worker 事件处理器修改状态
    for (const handle of this.agents.values()) {
      if (handle.status === 'running' || handle.status === 'starting') {
        this.forceStopAgent(handle, 'terminated', 'AgentPool.stopAll called');
        this.cleanupWorkerInboxBridge(handle);
        // 不 detachFromTeam —— stopAll 由 ESC 中断 / 删除会话触发。中断后 resume 仍需 roster，
        // 删除会话会整库清 team_members，两条路径都不该在这里摘成员。
        handle.interactiveRuntime?.setStatus('failed');
        handle.interactiveRuntime?.clearQueuedMessages();
        handle.interactiveRuntime?.clearAllToolOutputs();
        this.emitInteractiveRuntimeState(handle);
        // 立即释放重型资源
        this.releaseHeavyResources(handle);
      }
    }
    // 再 kill workers，此时 handle 已是终态，Worker 事件处理器不会修改状态
    for (const handle of this.agents.values()) {
      handle.externalStop?.('AgentPool.stopAll called');
    }
    this.workerRunner.killAllWorkers('AgentPool.stopAll called');
  }

  /**
   * 获取池状态
   *
   * stopped 只是 AgentPool 的内核终态容器，completed/failed/interrupted 必须结合 exitReason 归一化。
   * 这里使用 normalizeAgentRuntimeStatus，避免 terminated/timeout/crashed 被误算成 completed。
   */
  getStatus(): {
    total: number;
    starting: number;
    running: number;
    stopped: number;
    completed: number;
    failed: number;
    timeout: number;
    crashed: number;
    terminated: number;
  } {
    const all = this.getAll();
    const normalized = all.map((handle) => normalizeAgentRuntimeStatus(handle));
    return {
      total: all.length,
      starting: all.filter(h => h.status === 'starting').length,
      running: normalized.filter(status => status === 'running').length,
      stopped: all.filter(h => h.status === 'stopped').length,
      completed: normalized.filter(status => status === 'completed').length,
      failed: normalized.filter(status => status === 'failed').length,
      timeout: all.filter(h => h.status === 'stopped' && h.exitReason === 'timeout').length,
      crashed: all.filter(h => h.status === 'stopped' && h.exitReason === 'crashed').length,
      terminated: all.filter(h => h.status === 'stopped' && h.exitReason === 'terminated').length,
    };
  }

  destroy(): void {
    this.stopAll();
    for (const unsubscribe of this.interactiveStateUnsubscribers) {
      unsubscribe();
    }
    this.interactiveStateUnsubscribers = [];
    this.workerRunner.destroy();
    // 清理兜底 GC 定时器
    if (this.staleHandleGcTimer) {
      clearInterval(this.staleHandleGcTimer);
      this.staleHandleGcTimer = null;
    }
    // 退订配置热加载回调，防止监听器泄漏
    if (this.configReloadUnsubscribe) {
      try { this.configReloadUnsubscribe(); } catch { /* tolerate */ }
      this.configReloadUnsubscribe = null;
    }
  }

  /**
   * 立即释放已终止 handle 上的重型资源引用（interactiveRuntime, workerHandle 等），
   * 保留轻量元数据（agentId, name, taskId, status, exitReason, timestamps）供诊断查询。
   * 仅对非 running/starting 状态的 handle 生效，避免意外清理活跃 agent。
   */
  /**
   * 释放仍 claim 指定 task 的 active handle：把它强制转入终态（非 active）并回收重型资源。
   *
   * 用于崩溃恢复失败路径——当 TaskBoard 把任务解绑（prepareTaskForRedispatch 清空
   * assigned_agent）时，pool 侧可能还残留一个 active-looking handle 指着同一 task
   * （respawn 设回的 running/starting、recovering，或 stopped-no-exitReason 被
   * normalizeAgentRuntimeStatus 误判成 running）。不释放就会与 board 的「无主」状态
   * desync：dispatch_agent 读 pool 判「已在执行」、force_complete 读 board 判「未分配」，
   * 任务进死区无法逃脱。单独调 releaseHeavyResources 无效——它在 active handle 上早返回，
   * 这里先 forceStopAgent 转非 active 再回收。
   *
   * 不改 handle.taskId（其它路径读它做日志/恢复线归属），非 active 已足以让 dispatch 放行。
   */
  private releaseHandleForTask(taskId: string, reason?: string): boolean {
    let released = false;
    for (const handle of this.agents.values()) {
      if (handle.taskId !== taskId) continue;
      if (!isAgentRuntimeActiveStatus(handle)) continue;
      this.forceStopAgent(handle, 'failed', reason ?? `released by recovery for task ${taskId}`);
      this.cleanupWorkerInboxBridge(handle);
      this.releaseHeavyResources(handle);
      this.emitInteractiveRuntimeState(handle);
      this.scheduleHandleCleanup(handle.name);
      released = true;
    }
    return released;
  }

  private releaseHeavyResources(handle: AgentHandle): void {
    if (isAgentRuntimeActiveStatus(handle)) return;
    // 释放 ~50-100KB interactiveRuntime（含 liveOutputs, terminalSessions, queuedMessages）
    handle.interactiveRuntime = undefined;
    // 释放 worker 进程句柄引用
    handle.workerHandle = undefined;
    // 释放 external agent 相关闭包/诊断
    handle.externalStop = undefined;
    handle.externalDiagnostics = undefined;
    // 释放 inbox bridge 闭包（应已被 cleanupWorkerInboxBridge 清理，双重保险）
    handle.workerInboxBridgeCleanup = undefined;
  }

  /**
   * 当池大小超过 MAX_POOL_SIZE 时，强制清理最旧的已完成/失败 handle。
   * 只在 register() 成功后调用，确保新增 handle 不会触发无限增长。
   */
  private enforcePoolSizeLimit(): void {
    if (this.agents.size <= AgentPool.MAX_POOL_SIZE) return;

    // 收集所有 non-running handle，按 endTime/lastProgress 排序（最旧在前）
    const stoppedEntries: Array<[string, AgentHandle]> = [];
    for (const entry of this.agents.entries()) {
      if (!isAgentRuntimeActiveStatus(entry[1])) {
        stoppedEntries.push(entry);
      }
    }

    // 按结束时间排序（最旧优先清理）
    stoppedEntries.sort((a, b) => {
      const aTime = a[1].endTime ?? a[1].lastProgress ?? a[1].startTime;
      const bTime = b[1].endTime ?? b[1].lastProgress ?? b[1].startTime;
      return aTime - bTime;
    });

    // 清理到 MAX_POOL_SIZE 的 80% 水位线，避免频繁触发
    const target = Math.floor(AgentPool.MAX_POOL_SIZE * 0.8);
    const toRemove = this.agents.size - target;
    const removeCount = Math.min(toRemove, stoppedEntries.length);

    for (let i = 0; i < removeCount; i++) {
      const [name, handle] = stoppedEntries[i];
      this.releaseHeavyResources(handle);
      this.agents.delete(name);
    }

    if (removeCount > 0) {
      agentLogger.info(`[AgentPool] enforcePoolSizeLimit: 清理 ${removeCount} 个超龄 handle，当前池大小 ${this.agents.size}`);
    }
  }

  /**
   * 延迟清理已完成的 agent handle，防止长时间运行后 Map 无限增长。
   * 保留2分钟供诊断查询，之后移除。
   */
  private scheduleHandleCleanup(agentName: string): void {
    const handle = this.agents.get(agentName);
    const expectedAgentId = handle?.agentId;
    // 立即释放重型资源（不必等延迟清理）
    if (handle) {
      this.releaseHeavyResources(handle);
    }
    setTimeout(() => {
      const current = this.agents.get(agentName);
      // 只删除原始 handle，避免误删同名新注册的 handle
      if (current && current.status !== 'running' && (!expectedAgentId || current.agentId === expectedAgentId)) {
        this.agents.delete(agentName);
      }
    }, 2 * 60 * 1000).unref();
  }

  /**
   * 兜底 GC：扫描所有 non-running handle，删除超过 STALE_HANDLE_TTL_MS 未活动的。
   * 覆盖 scheduleHandleCleanup 未被调用的异常路径（forceComplete、进程崩溃等）。
   */
  private collectStaleHandles(): void {
    const now = Date.now();
    for (const [name, handle] of this.agents.entries()) {
      if (isAgentRuntimeActiveStatus(handle)) continue;
      const lastActivity = handle.lastProgress ?? handle.startTime ?? 0;
      if (now - lastActivity > AgentPool.STALE_HANDLE_TTL_MS) {
        this.releaseHeavyResources(handle);
        this.agents.delete(name);
      }
    }
    // GC 已解决的恢复记录，防止 DB 无限增长
    try {
      gcRecoveryRecords(this.db, this.sessionId);
    } catch {
      // GC 失败不应影响主流程
    }
  }

  private workerBridgeCursorKey(workerName: string): string {
    return `${this.sessionId}:${AgentPool.normalizeAgentName(workerName)}`;
  }

  private workerBridgeCursorStateKey(workerName: string): string {
    return `worker_bridge_cursor:${AgentPool.normalizeAgentName(workerName)}`;
  }

  private readWorkerBridgeCursor(workerName: string): WorkerBridgeCursor {
    const key = this.workerBridgeCursorKey(workerName);
    const cached = this.workerBridgeCursors.get(key);
    if (cached) return cached;
    const persisted = parseWorkerBridgeCursor(
      this.db.getSessionState?.(this.sessionId, this.workerBridgeCursorStateKey(workerName)),
    );
    this.workerBridgeCursors.set(key, persisted);
    return persisted;
  }

  private writeWorkerBridgeCursor(workerName: string, cursor: WorkerBridgeCursor): void {
    const key = this.workerBridgeCursorKey(workerName);
    this.workerBridgeCursors.set(key, cursor);
    try {
      this.db.setSessionState?.(this.sessionId, this.workerBridgeCursorStateKey(workerName), serializeWorkerBridgeCursor(cursor));
    } catch (error) {
      agentLogger.debug(`[AgentPool] worker inbox cursor persist skipped for @${workerName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  protected installWorkerInboxBridge(handle: AgentHandle): void {
    this.cleanupWorkerInboxBridge(handle);

    const flushInboxToWorker = () => {
      const workerInbox = this.sp(handle.name);
      const messages = this.bus.peek(workerInbox);
      const cursor = this.readWorkerBridgeCursor(handle.name);
      const deliverable = messages.filter((message) => shouldBridgeWorkerMessage(message, cursor));
      if (deliverable.length > 0) {
        for (const message of deliverable) {
          handle.interactiveRuntime?.enqueueMessage(typeof message.payload === 'string' ? message.payload : String(message.type));
        }
        this.emitInteractiveRuntimeState(handle);
      }
      const sentMessages: BusMessage[] = [];
      for (const message of deliverable) {
        const sent = this.workerRunner.sendToWorker(handle.name, {
          type: 'deliver_message',
          payload: message,
        });
        if (sent) {
          sentMessages.push(message);
        } else {
          agentLogger.warn(`[AgentPool] worker inbox bridge send failed for @${handle.name} message=${message.id}`);
        }
      }
      if (sentMessages.length > 0) {
        this.bus.removeMessages(workerInbox, sentMessages.map(message => message.id));
        this.writeWorkerBridgeCursor(handle.name, advanceWorkerBridgeCursor(cursor, sentMessages));
      }
      if (deliverable.length > 0) {
        handle.interactiveRuntime?.clearQueuedMessages();
        this.emitInteractiveRuntimeState(handle);
      }
    };

    const unsubscribe = this.bus.subscribe(this.sp(handle.name), () => {
      flushInboxToWorker();
    });

    handle.workerInboxBridgeCleanup = () => {
      unsubscribe();
      handle.workerInboxBridgeCleanup = undefined;
    };

    flushInboxToWorker();
  }

  protected cleanupWorkerInboxBridge(handle: AgentHandle): void {
    handle.workerInboxBridgeCleanup?.();
    handle.workerInboxBridgeCleanup = undefined;
  }

  /** 实例桥接：把静态 transitionAgentStatus 暴露为结构化上下文成员，供下沉执行体调用。 */
  protected transitionAgentStatusInstance(handle: AgentHandle, newStatus: AgentStatus): void {
    AgentPool.transitionAgentStatus(handle, newStatus);
  }

  /** 实例桥接：把模块私有 parseWorkerFailurePayload 暴露为结构化上下文成员。 */
  protected parseWorkerFailurePayloadInstance(error: unknown): {
    error: Error;
    recoverable: boolean;
    terminalKind?: AgentExecutionResult['metadata']['terminalKind'];
    faultClass?: RecoveryFaultClass;
    llmErrorKind?: LLMErrorKind;
    reason: string;
    payload?: WorkerFailurePayload;
  } {
    return parseWorkerFailurePayload(error);
  }

  protected parseWorkerCompletionPayload(payload: unknown): {
    result: string;
    verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
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
  } {
    if (
      payload &&
      typeof payload === 'object' &&
      'result' in payload &&
      'stats' in payload
    ) {
      const completion = payload as WorkerCompletionPayload;
      if (
        typeof completion.result !== 'string' ||
        !completion.stats ||
        typeof completion.stats.iterations !== 'number' ||
        typeof completion.stats.toolCalls !== 'number'
      ) {
        throw new Error('Worker completion payload is missing structured result/stats fields');
      }
      const speculativeWinner = assertSpeculativeWinnerEvidenceVerified(completion.speculativeWinner);
      return {
        result: completion.result,
        verdict: completion.verdict,
        stats: {
          iterations: completion.stats.iterations,
          toolCalls: completion.stats.toolCalls,
        },
        tokenUsage: completion.tokenUsage,
        summary: completion.summary,
        artifacts: completion.artifacts,
        verification: completion.verification,
        next_steps: completion.next_steps,
        blocked_by_discovery: completion.blocked_by_discovery,
        needs_leader_coordination: completion.needs_leader_coordination,
        evidence_refs: completion.evidence_refs,
        contract_compliance: completion.contract_compliance,
        toolTrace: completion.toolTrace,
        speculativeWinner,
      };
    }

    throw new Error('Worker completion payload must be structured');
  }

  // ─── Smart Agent Watchdog ───

  /**
   * 智能 watchdog 检查：基于 per-agent 进展信号判断是否停滞
   * 返回需要干预的 agent 列表及原因
   */
  getStagnantAgents(opts?: {
    idleThresholdMs?: number;
    toolStalledThresholdMs?: number;
  }): Array<{ handle: AgentHandle; reason: 'idle_no_progress' | 'tool_stalled' | 'heartbeat_lost'; elapsedMs: number }> {
    const idleThreshold = opts?.idleThresholdMs ?? 3 * 60 * 1000;     // 3 min no progress
    const toolStalled = opts?.toolStalledThresholdMs ?? 5 * 60 * 1000; // 5 min in same tool
    const now = Date.now();
    const results: Array<{ handle: AgentHandle; reason: 'idle_no_progress' | 'tool_stalled' | 'heartbeat_lost'; elapsedMs: number }> = [];

    for (const handle of this.getRunning()) {
      // Skip agents waiting for permission
      if (handle.pendingPermission) continue;

      // Tool stalled: agent started a tool but no result came back
      if (handle.currentToolName && handle.lastToolCallAt) {
        const toolElapsed = now - handle.lastToolCallAt;
        if (toolElapsed > toolStalled) {
          results.push({ handle, reason: 'tool_stalled', elapsedMs: toolElapsed });
          continue;
        }
      }

      // Idle: no progress signal for too long
      const lastSignal = Math.max(
        handle.lastProgress || 0,
        handle.lastToolResultAt || 0,
        handle.lastTokenAt || 0,
        handle.lastHeartbeat || 0,
      );
      if (lastSignal > 0) {
        const elapsed = now - lastSignal;
        if (elapsed > idleThreshold) {
          // Distinguish heartbeat lost vs idle
          const heartbeatElapsed = handle.lastHeartbeat ? now - handle.lastHeartbeat : Infinity;
          if (heartbeatElapsed > idleThreshold) {
            results.push({ handle, reason: 'heartbeat_lost', elapsedMs: heartbeatElapsed });
          } else {
            results.push({ handle, reason: 'idle_no_progress', elapsedMs: elapsed });
          }
        }
      }
    }

    return results;
  }
}

export default AgentPool;
