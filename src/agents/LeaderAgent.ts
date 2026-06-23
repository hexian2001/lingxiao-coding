/**
 * LeaderAgent - 领导者 Agent
 * 负责任务分解、协调和监督多个子 Agent
 * 
 * 参考 Python 版本的 LeaderAgent 实现
 */

import { createHash } from 'node:crypto';
import {
  contentToPlainText,
  isEmptyContent,
  type ChatMessage,
  type ChatResponse,
  type MessageContent,
  type ThinkingBlock,
  type ToolCall,
  type ToolDefinition,
} from '../llm/types.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { RecoveredTaskInfo } from '../contracts/types/Agent.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { MessageBus, type BusMessage } from '../core/MessageBus.js';
import type { EventEmitter, EventMap } from '../core/EventEmitter.js';
import { DatabaseManager, type ConversationMessage } from '../core/Database.js';
import { healInterruptedToolCalls, resequenceTimestampsForPersistence } from '../llm/message_sanitizer.js';
import { TaskBoard, type Task } from '../core/TaskBoard.js';
import { collectScratchpadFollowUps } from '../core/ScratchpadReview.js';
import type { AgentPool, AgentHandle } from './AgentPoolRuntime.js';
import type { TokenTracker } from './BaseAgentRuntime.js';
import { WorkNoteManager } from '../core/WorkNoteManager.js';
import { AgentRoleRegistry, type AgentRole } from './RoleRegistry.js';
import { AgentDefinitionService } from './AgentDefinitionService.js';
import { ContextManager } from '../core/ContextManager.js';
import { upsertSystemSlot, collapseSystemSlots, type SystemSlotMatcher } from '../core/SystemMessageSlot.js';
import { ContextMemoryIndex } from '../core/ContextMemoryIndex.js';
import {
  LEADER_MAX_TOOL_ROUNDS,
  LEADER_IDLE_WARNING_SECONDS,
  LEADER_PROBE_BACKOFF_MULTIPLIER,
  LEADER_PROBE_MAX_INTERVAL_SECONDS,
  LEADER_PROBE_SILENCE_SECONDS,
  MAX_CONVERSATION_BYTES,
  MAX_CONVERSATION_MESSAGES,
} from '../config.js';
import { join } from 'path';
import { AssetUsageStore } from '../memory/AssetUsageStore.js';
import { mkdirSync, writeFileSync } from 'fs';
import { Workspace } from '../core/Workspace.js';
import { buildImplementationContent } from './leader/artifactContent.js';
import { t } from '../i18n.js';
import { getExternalAgentAvailability } from './external/availability.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../core/TeamMailbox.js';
import { createLlmGuard } from './LlmGuard.js';
import { getTeamRequestTracker } from '../core/TeamRequestTracker.js';
import { assertCoreAgentTransition, isAgentRuntimeActiveStatus, isRunTerminalStatus } from '../contracts/adapters/StatusAdapter.js';

/**
 * 主循环控制指令 —— 段3-6 抽出为独立段方法后,内部 continue/break 不能再直接控制
 * _runImpl 的 while 循环,改为返回该枚举,由 _runImpl 顶层循环统一解释:
 *   - 'continue' → 跳过本轮剩余段,进入下一轮 while
 *   - 'break'    → 跳出 while(!this.finished) 主循环
 *   - 'next'     → 本段未触发循环跳转,继续执行下一个段
 * 纯确定性映射,无任何启发式。
 */
type LeaderLoopControl = 'continue' | 'break' | 'next';

/**
 * 单轮循环段间共享的可变状态(每轮重建一次)。段3 产出 allMsgs/agentMsgs,
 * 段5 产出 consumedCompletionKeys/pendingReportsToInject,段6 读取这些字段。
 * 抽出段方法后用于替代原局部变量在段间的隐式共享。
 */
interface LeaderLoopFrame {
  allMsgs: BusMessage[];
  agentMsgs: BusMessage[];
  consumedCompletionKeys: Set<string>;
  pendingReportsToInject: CompletionSignal[];
}

import { LeaderToolsExecutor } from './LeaderTools.js';
import { LeaderDirectToolsExecutor } from './LeaderDirectTools.js';
import { registerLeaderMetaTools } from './leader/LeaderMetaToolRegistry.js';
import { buildInitialUserContent } from './leader/userContent.js';
import { buildLeaderSystemPrompt } from './leader/systemPrompt.js';
import { buildDynamicContext } from './leader/dynamicContext.js';
import { LeaderContextBuilder, type LeaderContextBuilderDeps, isModeHintContent } from './leader/LeaderContextBuilder.js';
import {
  ensureMessageTimestamp,
  trimConversationBuffer,
} from './leader/conversationBuffer.js';
import { resolveModelContextLimit } from './leader/contextLimit.js';
import { collectBuiltinRoles } from './leader/builtinRoles.js';
import { buildMemoryItemsFingerprint } from './leader/contextMemory.js';
import {
  LeaderP0Handler,
  type CompletionSignal,
} from './leader/p0Message.js';
import { collectAvailableSkills, resolveExplicitSkillMentions, resolveDisabledSkillNames } from '../core/SkillCatalog.js';
import { resolveDynamicRoleCapability, applyRoleToolsConfigMap, type ResolvedRoleCapability } from './RoleCapabilityModel.js';

import { TeamSynchronizer } from './TeamSynchronizer.js';
import {
  isPermissionMode,
  summarizePermissionContextForDisplay,
  type PermissionMode,
  type PermissionRequestPayload,
  type PermissionUpdate,
  type ToolPermissionContext,
} from '../core/PermissionSystem.js';
import type { PermissionUpdateDestination } from '../core/PermissionStore.js';
import type { LeaderInteractionSnapshot } from '../core/SessionRuntimeState.js';
import type { EternalRuntimeSnapshot } from '../core/EternalLoop.js';
import type { ContextRuntimeState } from '../core/ContextRuntimeState.js';
import { getRecoveryRecord } from '../core/RecoveryRecords.js';
import {
  isTaskTerminalControlMessage,
  isActionableAgentBusMessage,
  readAgentControlMessage,
  type WorkerArtifactTrace,
  type WorkerContractComplianceProof,
  type WorkerRecoveryPayload,
  type WorkerVerificationItem,
} from '../core/AgentProtocol.js';
import { renderContextManifest } from '../core/ContextManifest.js';
import { formatWorkerCompletion } from './leader/workerCompletionFormatter.js';
import { classifyLLMError, formatLLMErrorLabel } from '../llm/errors.js';
import { _resetAllCircuitBreakers } from '../llm/CircuitBreaker.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { createEventStreamClient, type LlmRoundHooks } from './runtime/LlmRoundExecutor.js';
import { ToolScheduler } from './runtime/ToolScheduler.js';
import type { ToolResultContent } from './runtime/ToolResponseProcessor.js';
import { startToolProgressHeartbeat } from './runtime/ToolProgressHeartbeat.js';
import type { CapabilityIntentProfile } from '../contracts/types/Autonomy.js';
import {
  LEADER_PARALLEL_SAFE_TOOLS,
  canBatchExecuteToolCalls as canBatchExecuteToolCallsFn,
  runToolCallsBatch,
} from './runtime/parallelToolBatch.js';
import {
  createLeaderSupervisionState,
  normalizeLeaderSupervisionConfig,
  type LeaderSupervisionAgentSnapshot,
  type LeaderSupervisionConfig,
  type LeaderSupervisionEvaluation,
  type LeaderSupervisionState,
} from './LeaderSupervisionPolicy.js';
import {
  AgentHealthMonitor,
} from '../core/AgentHealthMonitor.js';
import {
  HEALTH_POLL_INTERVAL_SECONDS,
  HEALTH_STALL_THRESHOLD_SECONDS,
  HEALTH_STUCK_THRESHOLD_SECONDS,
  HEALTH_RUNAWAY_THRESHOLD_SECONDS,
  HEALTH_NUDGE_COOLDOWN_SECONDS,
  HEALTH_MAX_NUDGE_BEFORE_ESCALATION,
  config as globalConfig,
  refreshRuntimeConfig,
  onConfigReload,
} from '../config.js';
import { leaderLogger } from '../core/Log.js';
import { LeaderPermissionManager } from './LeaderPermissionManager.js';
import { LeaderProgressInvariant } from './LeaderProgressInvariant.js';
import { LeaderWorkOrchestrator } from './LeaderWorkOrchestrator.js';
import { LeaderSupervisionCoordinator } from './LeaderSupervisionCoordinator.js';
import { LeaderExecutionController, type LeaderExecutionMode, type RouteDecision } from './LeaderExecutionController.js';
import { LeaderThinkingEngine } from './leader/LeaderThinkingLoop.js';
import type { WorkflowManager } from '../core/workflow/WorkflowManager.js';
import type { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';

// 黑板架构集成（feature flag: LINGXIAO_BLACKBOARD）
import type { GraphAnalysis } from '../core/blackboard/types.js';
import type { BlackboardEvent } from '../core/blackboard/types.js';
import { LeaderBlackboard } from './LeaderBlackboard.js';
import { UnifiedScheduler, type DispatchOptions as SchedDispatchOptions } from './UnifiedScheduler.js';
import { DispatchDecisionCoordinator } from './DispatchDecisionCoordinator.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { WorktreeService } from '../core/WorktreeService.js';
import { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';

// 导入预设角色的系统提示
import { getLeaderSystemPrompt } from './prompts/leader/system_prompt.js';
import { getPromptLocale, getPromptCatalog } from './prompts/i18n/catalog.js';
import { buildSessionScopeSection } from './prompts/shared/fragments.js';
import { RESEARCH_SYSTEM_PROMPT_BY_LOCALE, EXPLORE_SYSTEM_PROMPT_BY_LOCALE, CODING_SYSTEM_PROMPT_BY_LOCALE, VERIFY_SYSTEM_PROMPT_BY_LOCALE, REVIEW_SYSTEM_PROMPT_BY_LOCALE } from './prompts/worker/system_prompts.js';
import { FRONTEND_SYSTEM_PROMPT_BY_LOCALE } from './prompts/frontend_system.js';
import { BACKEND_SYSTEM_PROMPT_BY_LOCALE } from './prompts/backend_system.js';
import { FULLSTACK_SYSTEM_PROMPT_BY_LOCALE } from './prompts/fullstack_system.js';
import { QA_SYSTEM_PROMPT_BY_LOCALE } from './prompts/qa_system.js';
import { UX_DESIGNER_SYSTEM_PROMPT_BY_LOCALE } from './prompts/ux_designer_system.js';
import { PLANNER_SYSTEM_PROMPT_BY_LOCALE } from './prompts/planner_system.js';
import { EVALUATOR_SYSTEM_PROMPT_BY_LOCALE } from './prompts/evaluator_system.js';
import { ARCHITECT_SYSTEM_PROMPT_BY_LOCALE } from './prompts/architect_system.js';
import { buildOfficeModeProtocol } from './office/OfficeModeProtocol.js';
import { LLM } from '../config/defaults.js';
import { getModelManager } from '../config/ModelManager.js';
import { OrchestrationRuntime } from './OrchestrationRuntime.js';
import { captureBughuntEvidence } from '../core/BughuntEvidenceCapture.js';
import { readBughuntLedger, updateBughuntDagNode } from '../core/BughuntLedger.js';
import { getModelDevInfo } from '../llm/ModelsDevRegistry.js';
import { getContextWindowSizeFromProvider } from '../llm/model_capabilities.js';
import { renderContractPackManifestSection, renderContractPackSystemMessage } from '../core/ContractPack.js';


function transitionLeaderAgentHandleToStopped(handle: AgentHandle): void {
  if (handle.status === 'stopped') {
    return;
  }
  assertCoreAgentTransition(handle.status, 'stopped', `Agent "${handle.name}"`);
  handle.status = 'stopped';
}

function stripSessionPrefix(sessionId: string, agentName: string): string {
  const prefix = `${sessionId}:`;
  return agentName.startsWith(prefix) ? agentName.slice(prefix.length) : agentName;
}

export function formatWorkerRecoveryPayload(payload: WorkerRecoveryPayload): string {
  const agent = payload.agentName.replace(/^[^:]+:/, '') || 'unknown';
  const lines = [
    `--- Worker Recovery Required @${agent} ---`,
    `task: ${payload.taskId}${typeof payload.taskRunGeneration === 'number' ? ` generation=${payload.taskRunGeneration}` : ''}`,
    `status: ${payload.status}`,
    `category: ${payload.category}`,
    `fault_class: ${payload.faultClass}`,
    `recovery_action: ${payload.recoveryAction}`,
    `auto_retry_scheduled: ${payload.autoRetryScheduled === true}`,
    ...(payload.llmErrorKind ? [`llm_error_kind: ${payload.llmErrorKind}`] : []),
    `attempt: ${payload.attempt}`,
    `reason: ${payload.reason}`,
  ];
  if (payload.roleType) {
    lines.push(`role: ${payload.roleType}`);
  }
  if (typeof payload.lastActivityAt === 'number') {
    lines.push(`last_activity_at: ${payload.lastActivityAt}`);
  }
  if (payload.diagnostics) {
    const diag = payload.diagnostics;
    const diagParts = [
      typeof diag.pid === 'number' ? `pid=${diag.pid}` : '',
      diag.exitCode !== undefined && diag.exitCode !== null ? `exit=${diag.exitCode}` : '',
      diag.exitSignal ? `signal=${diag.exitSignal}` : '',
      diag.timeoutReason ? `timeout=${diag.timeoutReason}` : '',
      diag.error ? `error=${diag.error}` : '',
    ].filter(Boolean);
    if (diagParts.length > 0) {
      lines.push(`diagnostics: ${diagParts.join(' ')}`);
    }
    if (diag.stderrTail?.length) {
      lines.push(`stderr_tail: ${diag.stderrTail.slice(-3).join(' | ')}`);
    } else if (diag.stdoutTail?.length) {
      lines.push(`stdout_tail: ${diag.stdoutTail.slice(-3).join(' | ')}`);
    }
  }
  const autoScheduled = payload.autoRetryScheduled === true;
  const redispatchAction = payload.recoveryAction === 'worker_restart' || payload.recoveryAction === 'worker_redispatch';
  lines.push(
    autoScheduled
      ? `runtime: system has ALREADY auto-scheduled a worker respawn/redispatch for this recovery (attempt ${payload.attempt}). Verify the new worker is running and wait/verify its output; only explicitly redispatch if the auto retry failed — do NOT re-dispatch the same task.`
      : redispatchAction
        ? 'runtime: system has scheduled an autonomous worker respawn/redispatch when possible; verify the restarted worker or dispatch a replacement if auto retry failed.'
        : 'runtime: Leader must take over, block, escalate, or explicitly redispatch; this is not task completion.',
  );
  return lines.join('\n');
}


/**
 * LeaderAgent 配置
 */
export interface LeaderConfig {
  sessionId: string;
  llm: ContentGenerator;
  toolRegistry: ToolRegistry;
  board: TaskBoard;
  bus: MessageBus;
  pool: AgentPool;
  tracker: TokenTracker;
  workspace: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  model: string;
  customPrompt?: string;
  defaultSkillsContent?: string;
  workflowManager?: WorkflowManager;
  workflowEngine?: WorkflowEngine;
  scheduledTaskManager?: ScheduledTaskManager;
}

export type { RecoveredTaskInfo } from '../contracts/types/Agent.js';

/**
 * LeaderAgent - 领导者 Agent
 * 负责任务分解与协调，管理多个子 Agent 的执行
 */
export class LeaderAgent {
  // ==================== Policy Threshold Constants ====================
  /** Max automatic recovery attempts for stuck open work */
  static readonly OPEN_WORK_RECOVERY_MAX_ATTEMPTS = 3;
  /** Tool calls count threshold for diagnostic logging */
  static readonly TOOL_CALLS_DIAGNOSTIC_THRESHOLD = 5;

  sessionId: string;
  llm: ContentGenerator;
  board: TaskBoard;
  bus: MessageBus;
  pool: AgentPool;
  tracker: TokenTracker;
  workspace: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  model: string;
  name = 'leader';
  /** 带 sessionId 前缀的 bus 收件人名 */
  get busName(): string { return `${this.sessionId}:${this.name}`; }
  /** 本会话 leader 的 bus 收件人名（等同 busName） */
  get leaderBusName(): string { return `${this.sessionId}:leader`; }
  /** 给任意 agent name 加上本会话前缀 */
  /** 用户中断控制器，abort 时会 kill 正在执行的 shell 命令 */
  private userInterruptController = new AbortController();
  sessionPrefix(name: string): string { return `${this.sessionId}:${name}`; }
  protected customPrompt?: string;
  protected defaultSkillsContent: string;
  protected running = false;
  /**
   * 当前 run() 的 in-flight Promise（P0 #2 单飞锁）。
   * - stop() 后 finished=true，run() 仍在 await LLM/工具调用，外部紧接着 sendUserInput 可能重启 run()。
   *   此字段保证同一时刻只有一个 run() 在跑：第二次进入直接返回当前 Promise，等旧 run() finally 设回 null 后再启动。
   * - 用 protected 是因为运行时扩展共享主循环。
   */
  protected currentRunPromise: Promise<string> | null = null;
  /** Restart requested while a stopped run is still unwinding. */
  protected pendingRunRestartPromise: Promise<string> | null = null;
  protected rawXmlRetryCount = 0;
  protected emptyResponseRetryCount = 0;

  protected conversation: ChatMessage[] = [];
  protected pendingUserInput: MessageContent = null;
  protected waitingForUser = false;
  protected controlMode: 'manual' | 'eternal' = 'manual';
  protected currentLlmAbortController: AbortController | null = null;
  protected finished = false;
  private userInterruptPending = false;
  /** 用户消息队列：Leader 忙碌时到来的用户消息按序存放，空闲后依次处理 */
  protected userMessageQueue: Array<BusMessage> = [];
  /** Leader 是否正在执行 leaderThinkAndAct（即正在忙碌） */
  protected isBusy = false;
  /** Public getter for isBusy — allows SessionManager to check Leader state */
  get busy(): boolean { return this.isBusy; }
  protected pendingReview = false;

  /**
   * 原始用户任务文本(防漂移锚点)。新会话首条 user prompt 时捕获,
   * 供每轮 getDynamicContext() 置顶「当前使命」锚点段(见 LeaderContextBuilder)。
   */
  protected originalGoal: string | null = null;
  /** 防漂移:对外暴露原始用户任务文本,供 create_task 注入每个子任务的 context。 */
  public getOriginalGoal(): string | null {
    return this.originalGoal;
  }

  /**
   * Leader 上下文构建子模块(L1/B4 抽出)。fingerprint 状态已迁入 builder。
   */
  private _contextBuilder: LeaderContextBuilder | null = null;
  protected get contextBuilder(): LeaderContextBuilder {
    if (!this._contextBuilder) {
      this._contextBuilder = new LeaderContextBuilder(this.buildContextBuilderDeps());
    }
    return this._contextBuilder;
  }

  protected emitRoundComplete(trigger: string): void {
    this.emitter.emit('leader:round_complete', { sessionId: this.sessionId, trigger });
  }

  protected planApproved = false;
  /** 非打断式用户指导消息，在下轮 LLM 调用时作为 system 消息注入 */
  protected nudgeMessage: string | null = null;
  protected lastScratchpadReviewDigest: string | null = null;
  protected lastRuntimeContextFingerprint: string | null = null;
  protected lastContextMemoryFingerprint: string | null = null;
  protected lastProgressReportDigest: string | null = null;
  protected turnCount = 0;
  protected lastOpenWorkRecoveryFingerprint: string | null = null;
  protected openWorkRecoveryAttempts = 0;
  /** Active team name for this session (set when Leader calls team_manage(action="create")). */
  protected activeTeamName: string | null = null;
  /** Agent 完成报告队列：P0 到达时立即保存报告正文，直到注入 Leader conversation 后才清除 */
  protected pendingAgentCompletionSignals: CompletionSignal[] = [];
  /** P0 消息处理下沉载体 — handleLeaderP0Message 改为薄委托 */
  private _leaderP0Handler: LeaderP0Handler | null = null;
  protected workerResultQueue: Promise<void> = Promise.resolve();
  protected lastOpenWorkRecoveryAtMs = 0;

  /** LLM 连续错误重试计数 */
  protected llmErrorRetryCount = 0;
  protected readonly LLM_MAX_ERROR_RETRIES = globalConfig.llm.max_retries;
  /**
   * 进度哈希检测 + Watchdog — 委托给 LeaderProgressInvariant
   */
  protected progressInvariant: LeaderProgressInvariant;
  protected workOrchestrator: LeaderWorkOrchestrator;
  protected workNoteManager: WorkNoteManager;
  getWorkNoteManager(): WorkNoteManager { return this.workNoteManager; }
  protected toolsExecutor: LeaderToolsExecutor;
  protected directToolsExecutor: LeaderDirectToolsExecutor;
  protected roleRegistry: AgentRoleRegistry;
  protected contextManager: ContextManager;
  protected orchestrationRuntime: OrchestrationRuntime;

  protected toolRegistry: ToolRegistry;
  protected executionMode: LeaderExecutionMode = 'direct';
  protected executionReason = '默认优先由 Leader 直接处理当前请求';
  protected permManager: LeaderPermissionManager;
  protected teamSynchronizer: TeamSynchronizer | null = null;
  protected healthMonitor: AgentHealthMonitor;
  protected supervCoordinator!: LeaderSupervisionCoordinator;
  protected executionController!: LeaderExecutionController;
  protected fileChangesApi: InstanceType<typeof import('../web-server/FileChangesApi.js').FileChangesApi> | null = null;
  protected thinkingEngine!: LeaderThinkingEngine;
  protected workflowManager?: WorkflowManager;
  protected workflowEngine?: WorkflowEngine;
  protected scheduledTaskManager?: ScheduledTaskManager;
  protected readonly supervisionConfig: LeaderSupervisionConfig = normalizeLeaderSupervisionConfig({
    initialProbeSilenceSeconds: LEADER_PROBE_SILENCE_SECONDS,
    maxProbeIntervalSeconds: LEADER_PROBE_MAX_INTERVAL_SECONDS,
    probeBackoffMultiplier: LEADER_PROBE_BACKOFF_MULTIPLIER,
    idleWarningSeconds: LEADER_IDLE_WARNING_SECONDS,
  });
  protected supervisionState: LeaderSupervisionState = createLeaderSupervisionState();

  // ─── 黑板架构（feature flag: LINGXIAO_BLACKBOARD） ───
  /** 黑板集成模块 — 持有 blackboardGraph / graphBridge / dispatcherEngine */
  protected leaderBlackboard: LeaderBlackboard | null = null;
  /** 统一调度器 — 全局唯一 worker dispatch 入口 */
  protected scheduler: UnifiedScheduler | null = null;
  public getScheduler(): UnifiedScheduler | null { return this.scheduler; }
  protected dispatchDecisionCoordinator: DispatchDecisionCoordinator | null = null;
  /** requestLeaderDispatchDecision 去重：避免事件驱动 + 主循环兜底重复注入同一批提示 */
  private lastLeaderDecisionSig: { sig: string; at: number } | null = null;
  /**
   * 构造器级（实例级）事件退订函数集合：attachTaskLifecycleToTeamMailbox 注册的
   * task:failed / task:cancelled 监听器存放于此。这些监听器在构造器注册一次、
   * 不随 run() 重入而重注册，因此必须在 dispose()（实例终结）时退订，
   * 而非 run() 的 finally（否则同实例重跑 run() 后团队通知会永久失效）。
   */
  private _taskTeamUnsubscribers: Array<() => void> = [];
  /** onConfigReload 退订函数：在 dispose() 时调用以防止监听器泄漏 */
  private _configReloadUnsubscribe: (() => void) | null = null;

  /**
   * Leader 已"看过并决定等待"的 dispatchable 任务集合指纹。
   * 非 eternal 模式下，Leader 思考完一轮仍未派发某 dispatchable 任务（如等待上游、
   * 或有意先观察）会 latch waitingForUser。若主循环每轮都因"还有 dispatchable"把它
   * 重新唤醒 think，就成了用户看到的"没开 eternal 却无限请求 LLM"。
   * 用指纹记住"这批 dispatchable 我已经决定等了"，集合不变就不再重复唤醒；
   * 集合变化（新任务解锁 / 派发后减少）才重新驱动一次。
   */
  private waitedDispatchableSig: string | null = null;
  /** 公开访问器 — SessionRoutes 等外部消费者用来读取黑板分析 */
  public getLeaderBlackboard(): LeaderBlackboard | null { return this.leaderBlackboard; }

  /**
   * 获取黑板图分析结果（供 LeaderThinkingEngine 注入上下文）
   * 黑板模式未启用时返回 null
   */
  getBlackboardAnalysis(): GraphAnalysis | null {
    return this.leaderBlackboard?.getBlackboardAnalysis() ?? null;
  }

  /** 黑板模式是否启用 */
  isBlackboardEnabled(): boolean {
    return this.leaderBlackboard?.isEnabled() ?? false;
  }

  protected resolveTaskContractReadiness(task: Task): { ready: boolean; reasons?: string[] } {
    const binding = task.orchestration?.contractBinding;
    if (!binding || (!binding.requireContract && !binding.requireAck)) {
      return { ready: true };
    }

    const reasons: string[] = [];
    const tag = binding.tag || `contract:${binding.surface}`;

    if (binding.requireContract) {
      const graph = this.leaderBlackboard?.blackboardGraph;
      const contractEvidence = graph?.getContractEvidence(this.sessionId, binding.surface)
        ?? graph?.getActiveContract(this.sessionId, binding.surface);
      if (!contractEvidence) {
        reasons.push(`等待黑板契约就绪: ${tag}`);
      }
    }

    if (binding.requireAck) {
      const requestId = binding.requestId || `${binding.surface}@v${binding.version ?? 1}`;
      const state = getTeamRequestTracker(this.sessionId).getRequestState(requestId);
      if (state.status === 'unknown') {
        reasons.push(`等待契约 ack request 登记: ${requestId}`);
      } else if (state.status === 'pending') {
        const missing = state.missingAckBy && state.missingAckBy.length > 0
          ? ` 缺 ${state.missingAckBy.join(', ')}`
          : '';
        reasons.push(`等待契约 ack 闭环: ${requestId}${missing}`);
      }
    }

    return reasons.length > 0 ? { ready: false, reasons } : { ready: true };
  }

  private refreshContractBoundTasks(event: BlackboardEvent): void {
    if (event.sessionId !== this.sessionId) return;
    if (event.type !== 'node_added' && event.type !== 'node_superseded') return;
    this.board.refreshReadiness();
    void this.dispatchDecisionCoordinator?.notifyLeaderOfDispatchable();
  }

  protected buildInitialUserContent(content: MessageContent): MessageContent {
    return buildInitialUserContent(content, this.workspace);
  }

  /**
   * 订阅 task:failed/cancelled，向 active team 中所有 *running* worker 直推系统通知。
   *
   * 设计取舍（2026-05-27 重构）：
   *   - 直接走 MessageBus，不再写 TeamMailbox。系统通知是"实时事件"，
   *     塞进 mailbox 会污染 inbox_check 的"补漏"语义，让任何 worker 重启
   *     后都看到一堆别的任务的失败 fanout，毫无相关性。
   *   - completed 路径完全静默：worker 自己的 task_complete + work note 已经覆盖。
   *   - failed/cancelled 必通知：用 user_intervention 类型，让 worker 立刻注入到上下文。
   *   - 没有 active team / 没有 running worker → 默默跳过。
   */
  private attachTaskLifecycleToTeamMailbox(): void {
    const e = this.emitter;

    const notifyTeam = (taskId: string, status: 'failed' | 'cancelled', detail?: string): void => {
      const activeTeam = this.activeTeamName;
      if (!activeTeam) return;

      const task = this.board.getTask(taskId);
      const agent = task?.assigned_agent || '';
      const subject = task?.subject || taskId;
      const trimmedDetail = detail ? detail.replace(/\s+/g, ' ').slice(0, 160) : '';
      const content = [
        `[任务${status === 'failed' ? '失败' : '已取消'} — 系统通知]`,
        `${taskId}：${subject}`,
        agent ? `执行者：@${agent}` : '',
        trimmedDetail ? `详情：${trimmedDetail}` : '',
      ].filter(Boolean).join('\n');

      try {
        const running = this.pool.getRunning();
        for (const handle of running) {
          // 不通知触发任务的 worker 自己（它已经在终态路径里了）
          if (handle.name === agent) continue;
          this.bus.send(
            this.sessionPrefix('system'),
            this.sessionPrefix(handle.name),
            'user_intervention',
            { _system_notice: true, kind: `task:${status}`, taskId, content },
          );
        }
      } catch {
        // 非致命：bus 投递失败不应影响 leader 主循环
      }
    };

    const onFailed = (payload: { taskId: string; error?: string }) => {
      notifyTeam(payload.taskId, 'failed', payload.error);
    };
    const onCancelled = (payload: { taskId: string; reason?: string }) => {
      notifyTeam(payload.taskId, 'cancelled', payload.reason);
    };

    e.on('task:failed', onFailed);
    e.on('task:cancelled', onCancelled);

    const unsub = () => {
      e.off('task:failed', onFailed);
      e.off('task:cancelled', onCancelled);
    };
    this._taskTeamUnsubscribers.push(unsub);
  }

  /**
   * 任务终态时自动回收 task 级 worktree。
   *
   * - completed: 尝试 ff-only merge 到 base branch，成功则 remove worktree + 删分支；
   *   merge 失败（非 ff 或 dirty）只记日志，保留 worktree 供 Leader 手动处理。
   * - failed / cancelled: force remove worktree + 删分支（放弃工作）。
   *
   * 所有操作 try-catch 包裹，失败只记日志，不阻塞任务生命周期。
   */
  private attachWorktreeCleanup(): void {
    const e = this.emitter;

    const cleanupWorktree = async (taskId: string, kind: 'completed' | 'failed' | 'cancelled'): Promise<void> => {
      try {
        const repos = new DatabaseRepositoryAdapter(this.db);
        const service = new WorktreeService(repos.worktrees);
        const records = await service.list({ sessionId: this.sessionId, taskId });
        if (records.length === 0) return;

        for (const wt of records) {
          if (kind === 'completed') {
            try {
              await service.merge(wt.id, { ffOnly: true, deleteAfterMerge: true });
              leaderLogger.info(`[WorktreeCleanup] task ${taskId} completed: merged & removed worktree ${wt.branch}`);
            } catch (mergeErr) {
              // merge 失败（非 ff / dirty / base 不匹配）→ 保留 worktree，供 Leader 手动处理
              leaderLogger.warn(`[WorktreeCleanup] task ${taskId} worktree ${wt.branch} merge failed, keeping for manual review: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
            }
          } else {
            // failed / cancelled → force remove + 删分支
            try {
              await service.remove(wt.id, { keepBranch: false });
              leaderLogger.info(`[WorktreeCleanup] task ${taskId} ${kind}: removed worktree ${wt.branch}`);
            } catch (removeErr) {
              leaderLogger.warn(`[WorktreeCleanup] task ${taskId} worktree ${wt.branch} remove failed: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`);
            }
          }
        }
      } catch (err) {
        leaderLogger.warn(`[WorktreeCleanup] task ${taskId} cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const onCompleted = (payload: { taskId: string }): void => {
      void cleanupWorktree(payload.taskId, 'completed');
    };
    const onFailed = (payload: { taskId: string }): void => {
      void cleanupWorktree(payload.taskId, 'failed');
    };
    const onCancelled = (payload: { taskId: string }): void => {
      void cleanupWorktree(payload.taskId, 'cancelled');
    };

    e.on('task:completed', onCompleted);
    e.on('task:failed', onFailed);
    e.on('task:cancelled', onCancelled);

    const unsub = () => {
      e.off('task:completed', onCompleted);
      e.off('task:failed', onFailed);
      e.off('task:cancelled', onCancelled);
    };
    this._taskTeamUnsubscribers.push(unsub);
  }

  constructor(config: LeaderConfig) {
    this.sessionId = config.sessionId;
    this.llm = config.llm;
    this.toolRegistry = config.toolRegistry;
    this.board = config.board;
    this.board.setContractReadinessResolver((task) => this.resolveTaskContractReadiness(task));
    this.bus = config.bus;
    this.pool = config.pool;
    this.tracker = config.tracker;
    this.workspace = config.workspace;
    this.db = config.db;
    this.emitter = config.emitter;
    this.model = config.model;
    const persistedControlMode = this.db.getSessionState(this.sessionId, SESSION_KEYS.CONTROL_MODE);
    this.controlMode = persistedControlMode === 'eternal' ? 'eternal' : 'manual';
    // 恢复 active team：只信任显式持久化值，不从 mailbox 猜测唯一 team。
    try {
      const persistedActiveTeam = this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM);
      const candidate = typeof persistedActiveTeam === 'string' ? persistedActiveTeam.trim() : '';
      if (candidate) {
        try {
          const mailbox = getTeamMailbox();
          if (mailbox.teamExists(candidate, this.sessionId)) {
            this.activeTeamName = candidate;
          } else {
            this.activeTeamName = null;
            void this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM, '');
          }
        } catch {
          // mailbox 暂未就绪 — 信任持久化值，待首次 dispatch 时再校验
          this.activeTeamName = candidate;
        }
      }
    } catch { /* tolerate */ }
    this.customPrompt = config.customPrompt;
    this.defaultSkillsContent = config.defaultSkillsContent || '';
    this.workflowManager = config.workflowManager;
    this.workflowEngine = config.workflowEngine;
    this.scheduledTaskManager = config.scheduledTaskManager;

    // Populate skills catalog for Leader awareness (if not provided externally)
    if (!this.defaultSkillsContent) {
      try {
        const disabledNames = resolveDisabledSkillNames();
        const skills = collectAvailableSkills(this.workspace, { disabledNames });
        if (skills.length > 0) {
          const lines = skills.map(s =>
            `- **${s.name}** [${s.source}]: ${s.summary || '(no description)'}`,
          );
          this.defaultSkillsContent = lines.join('\n');
        }
      } catch {
        // Non-fatal: Leader will operate without skill catalog
      }
    }

    this.permManager = new LeaderPermissionManager({
      sessionId: this.sessionId,
      db: this.db,
      emitter: this.emitter,
      bus: this.bus,
      workspace: this.workspace,
      setWaitingForUser: (waiting) => { this.waitingForUser = waiting; },
      addAndPersistMessage: (msg) => {
        this.addMessage(msg);
        this.db.saveConversationMessage(this.sessionId, this.conversation[this.conversation.length - 1]);
      },
    });

    // progressInvariant needs leaderThinkAndAct which is defined on this — bind lazily
    this.progressInvariant = new LeaderProgressInvariant({
      sessionId: this.sessionId,
      db: this.db,
      emitter: this.emitter,
      board: this.board,
      pool: this.pool,
      isFinished: () => this.finished,
      isWaitingForUser: () => this.waitingForUser,
      isPendingReview: () => this.pendingReview,
      isEternalMode: () => this.isEternalMode(),
      isLeaderRunning: () => this.running && !this.finished,
      getConversation: () => this.conversation,
      getConversationLength: () => this.conversation.length,
      addAndPersistMessage: async (msg) => {
        this.addMessage(msg);
        await this.db.saveConversationMessage(this.sessionId, this.conversation[this.conversation.length - 1]);
      },
      leaderThinkAndAct: () => this.leaderThinkAndAct(),
      setWaitingForUser: async (waiting) => {
        this.waitingForUser = waiting;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, waiting ? 'true' : 'false');
      },
      recordTokenUsage: (_usage) => {
        // Token tracking delegated to EternalLoop
      },
      buildHealthInput: () => null,
      executeRecoveryAction: async (_action) => {
        // Recovery actions delegated to orchestration runtime
      },
      escalateBlocked: async (_decision) => {
        // Blocked escalation delegated to AlertManager via EternalLoop
      },
      dispatchReadyTasks: async () => {
        // 所有派发决策必须经过 Leader LLM，不再自动 tick scheduler
        return 0;
      },
      getReadyTaskCount: () => this.board.getReadyTasks().filter(t => t.status === 'dispatchable').length,
      // ─── EternalLoop silence-gate 接线 ───
      getBlackboardCounts: () => {
        const graph = this.leaderBlackboard?.blackboardGraph;
        if (!graph) return null;
        try {
          const snapshot = graph.getSnapshot(this.sessionId);
          return { nodes: snapshot.nodes.length, edges: snapshot.edges.length };
        } catch { /* expected: blackboard not initialized yet */
          return null;
        }
      },
      getScratchpadDigest: () => this.lastScratchpadReviewDigest,
      getRecentConversationDigest: () => {
        // 复用 NextSpeakerPolicy 同款 summarizer 思路；这里直接拼后 6 条非 system 消息
        const recent = this.conversation
          .filter((m) => m.role !== 'system')
          .slice(-6)
          .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 200) : '(structured)'}`)
          .join('\n');
        return recent || '(none)';
      },
      getEternalJudgeLlm: () => {
        try {
          return this.llm;
        } catch { /* expected: llm getter may throw before init */
          return null;
        }
      },
      getEternalJudgeModel: () => this.model || null,
      yieldEternalToUser: async (reason) => {
        leaderLogger.info(`[EternalLoop] yielding to user: ${reason}`);
        if (!this.waitingForUser) {
          this.waitingForUser = true;
          await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
        }
        this.emitter.emit('leader:status', {
          sessionId: this.sessionId,
          status: '等待用户输入...',
        });
      },
    });

    this.workOrchestrator = new LeaderWorkOrchestrator({
      sessionId: this.sessionId,
      db: this.db,
      board: this.board,
      pool: this.pool,
      emitter: this.emitter,
      bus: this.bus,
      getExecutionMode: () => this.executionMode,
      isEternalMode: () => this.isEternalMode(),
      isFinished: () => this.finished,
      isWaitingForUser: () => this.waitingForUser,
      setWaitingForUser: async (waiting) => {
        this.waitingForUser = waiting;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, waiting ? 'true' : 'false');
      },
      isPendingReview: () => this.pendingReview,
      getPendingPermissionRequest: () => this.permManager.pendingPermissionRequest,
      getPendingUserInput: () => this.pendingUserInput,
      getConversation: () => this.conversation,
      addAndPersistMessage: async (msg) => {
        this.addMessage(msg);
        await this.db.saveConversationMessage(this.sessionId, this.conversation[this.conversation.length - 1]);
      },
      leaderThinkAndAct: () => this.leaderThinkAndAct(),
      getLastOpenWorkRecoveryFingerprint: () => this.lastOpenWorkRecoveryFingerprint,
      setLastOpenWorkRecoveryFingerprint: (v) => { this.lastOpenWorkRecoveryFingerprint = v; },
      getOpenWorkRecoveryAttempts: () => this.openWorkRecoveryAttempts,
      setOpenWorkRecoveryAttempts: (v) => { this.openWorkRecoveryAttempts = v; },
      getLastOpenWorkRecoveryAtMs: () => this.lastOpenWorkRecoveryAtMs,
      setLastOpenWorkRecoveryAtMs: (v) => { this.lastOpenWorkRecoveryAtMs = v; },
      openWorkRecoveryMaxAttempts: LeaderAgent.OPEN_WORK_RECOVERY_MAX_ATTEMPTS,
      getOrchestrationRuntime: () => this.orchestrationRuntime,
      getLeaderBlackboard: () => this.leaderBlackboard,
      getDispatchDecisionCoordinator: () => this.dispatchDecisionCoordinator,
      persistImplementationArtifact: (input) => this.persistImplementationArtifact(input),
      addMessage: (msg) => this.addMessage(msg),
      captureBughuntWorkerEvidence: (input) => this.captureBughuntWorkerEvidence(input),
      recordAgentOutcome: (agentName, taskId, outcome) => this.recordAgentOutcome(agentName, taskId, outcome),
      getPendingAgentCompletionSignals: () => this.pendingAgentCompletionSignals,
      setPendingAgentCompletionSignals: (signals) => { this.pendingAgentCompletionSignals = signals; },
      getLeaderBusName: () => this.leaderBusName,
      clearSoftWaitingForUser: (reason) => this.clearSoftWaitingForUser(reason),
      setDelegateMode: (reason) => this.setDelegateMode(reason),
      acceptWorkerTaskResult: (input) => this.acceptWorkerTaskResult(input),
    });

    this.bus.register(this.leaderBusName);
    this.toolsExecutor = new LeaderToolsExecutor(this);
    registerLeaderMetaTools(this.toolRegistry);
    this.workNoteManager = new WorkNoteManager(join(this.workspace, '.lingxiao'));
    // TeamSynchronizer 需要黑板图来检测 verdict/contradicts 冲突；
    // leaderBlackboard 的 graph 在 enableBlackboardGraph() 内部才创建，
    // 此处先用 null 构造，等 graph 就绪后再 setGraph 注入。
    this.teamSynchronizer = new TeamSynchronizer(this.workNoteManager, this.sessionId);
    this.roleRegistry = new AgentRoleRegistry();

    // 任务终态自动通知 team mailbox
    this.attachTaskLifecycleToTeamMailbox();
    // 任务终态自动回收 task 级 worktree（防止分支堆积）
    this.attachWorktreeCleanup();

    const leaderInitContextLimit = resolveModelContextLimit({
      providerCtx: getContextWindowSizeFromProvider(this.model),
      modelInfoCtx: getModelDevInfo(this.model)?.contextLimit,
      configuredCtx: globalConfig.llm.context_max_tokens,
      fallback: LLM.CONTEXT_MAX_TOKENS,
    })!;
    this.contextManager = new ContextManager(
      leaderInitContextLimit,
      this.model,
      this.sessionId,
      this.db,
      this.createLeaderEventStreamClient('Leader-ContextManager'),
      this.emitter,
      {
        kind: 'leader',
        workspace: this.workspace,
      },
      createLlmGuard,
    );
    this.orchestrationRuntime = new OrchestrationRuntime({
      sessionId: this.sessionId,
      emitter: this.emitter,
      getTasks: () => this.board.getAllTasks(),
      // 把 verdict 真写回 task.orchestration.verdict + DB —— 让 reject/repair 路径生效
      setOrchestrationVerdict: (taskId, verdict) => this.board.setOrchestrationVerdict(taskId, verdict),
      createFollowupTask: (input) => {
        const taskId = this.board.nextTaskId();
        // 防御性 guard：如果 nextTaskId 意外返回了与 blockedBy 中相同的 ID（自依赖），
        // 强制跳过该 ID 再取一个。正常情况下 nextTaskId 的 while 循环已处理此问题，
        // 但在极端时序下（如 DB 恢复后 taskCounter 未同步）仍可能发生。
        const blockedBy = input.blockedBy ?? [];
        let safeTaskId = taskId;
        if (blockedBy.includes(safeTaskId)) {
          // nextTaskId 已有 while(this.tasks.has) 保护，但自依赖检查不在其中。
          // 强制递增直到不再与任何 blockedBy 冲突。
          do {
            safeTaskId = this.board.nextTaskId();
          } while (blockedBy.includes(safeTaskId));
        }
        const task = this.board.createTask(
          safeTaskId,
          input.subject,
          input.description,
          input.agentType,
          blockedBy,
          [],
          undefined,
          input.context,
          { orchestration: input.orchestration },
        );
        return task.id;
      },
    });
    this.directToolsExecutor = new LeaderDirectToolsExecutor({
      toolRegistry: this.toolRegistry,
      db: this.db,
      sessionId: this.sessionId,
      workspace: this.workspace,
      emitter: this.emitter,
      bus: this.bus,
      contextManager: this.contextManager,
      llm: this.createLeaderEventStreamClient('Leader-DirectTools'),
      model: this.model,
      getModel: () => this.model,
      workflowManager: this.workflowManager,
      workflowEngine: this.workflowEngine,
      scheduledTaskManager: this.scheduledTaskManager,
      // 黑板在本构造函数后段才 init（line ~778），用 getter 惰性解析，
      // 让 Leader 调用 blackboard(action="...") 统一入口时能拿到 graph。
      getBlackboardGraph: () => this.leaderBlackboard?.blackboardGraph ?? null,
    });
    this.healthMonitor = new AgentHealthMonitor(
      this.emitter,
      // supervCoordinator 在此之后才初始化，使用延迟引用确保安全
      (report) => { if (this.supervCoordinator) this.supervCoordinator.handleHealthReport(report); },
      {
        pollIntervalMs: HEALTH_POLL_INTERVAL_SECONDS * 1000,
        stallThresholdMs: HEALTH_STALL_THRESHOLD_SECONDS * 1000,
        stuckThresholdMs: HEALTH_STUCK_THRESHOLD_SECONDS * 1000,
        runawayThresholdMs: HEALTH_RUNAWAY_THRESHOLD_SECONDS * 1000,
        // heartbeatLivenessMs 不暴露为 config：固定 90s（3× worker 30s 心跳）走 DEFAULT，
        // 仅在 runaway 级别作「进程死活」二分门（见 assessAgentHealth）。
        nudgeCooldownMs: HEALTH_NUDGE_COOLDOWN_SECONDS * 1000,
        maxNudgeBeforeEscalation: HEALTH_MAX_NUDGE_BEFORE_ESCALATION,
      },
    );
    this.supervCoordinator = new LeaderSupervisionCoordinator({
      sessionId: this.sessionId,
      pool: this.pool,
      emitter: this.emitter,
      bus: this.bus,
      healthMonitor: this.healthMonitor,
      workNoteManager: this.workNoteManager,
      teamSynchronizer: this.teamSynchronizer,
      supervisionConfig: this.supervisionConfig,
      getSupervisionState: () => this.supervisionState,
      setSupervisionState: (s) => { this.supervisionState = s; },
      getConversation: () => this.conversation,
      setConversation: (msgs) => { this.conversation = msgs; },
      getContextManager: () => this.contextManager,
      getDb: () => this.db,
      getPendingAgentCompletionSignals: () => this.pendingAgentCompletionSignals,
      addPendingAgentCompletionSignal: (signal) => { this.pendingAgentCompletionSignals.push(signal); },
      interruptCurrentRound: (reason) => this.interruptCurrentRound(reason),
      onProgressUpdate: (progressAtMs) => { this.progressInvariant.lastProgressAtMs = progressAtMs; },
      saveConversationMessage: (msg) => { this.db.saveConversationMessage(this.sessionId, msg); },
    });
    // 消息处理在 run() 主循环中通过 poll() 完成，无需额外 subscribe
    this.supervCoordinator.subscribeAgentActivityEvents();
    this.supervCoordinator.subscribeContextOverflow();
    this.executionController = new LeaderExecutionController({
      sessionId: this.sessionId,
      db: this.db,
      emitter: this.emitter,
      directToolsExecutor: this.directToolsExecutor,
      hasRunningAgents: () => this.hasRunningAgents(),
      getBoard: () => this.board,
      getTracker: () => this.tracker,
      getExecutionMode: () => this.executionMode,
      setExecutionMode: (mode) => { this.executionMode = mode; },
      getExecutionReason: () => this.executionReason,
      setExecutionReason: (reason) => { this.executionReason = reason; },
      // 黑板 init 在本构造函数后段才发生，用 getter 惰性解析就绪状态，
      // 关闭时从 Leader 工具集剔除黑板写入工具，避免调用必然失败的工具。
      getBlackboardEnabled: () => this.leaderBlackboard?.isEnabled() ?? false,
    });
    this.reloadBuiltinRoles();
    this.thinkingEngine = new LeaderThinkingEngine({
      sessionId: this.sessionId,
      llm: this.llm,
      model: this.model,
      db: this.db,
      emitter: this.emitter,
      tracker: this.tracker,
      contextManager: this.contextManager,
      streamBufferFlushThreshold: globalConfig.leader.stream_buffer_flush_threshold,
      getConversation: () => this.conversation,
      setConversation: (msgs) => { this.conversation = msgs; },
      addMessage: (msg) => this.addMessage(msg),
      syncSystemPrompt: () => this.syncSystemPromptForCurrentMode(),
      getModel: () => this.model,
      setModel: (model) => {
        this.model = model;
        const ctxLimit = resolveModelContextLimit({
          providerCtx: getContextWindowSizeFromProvider(model),
          modelInfoCtx: getModelDevInfo(model)?.contextLimit,
          configuredCtx: globalConfig.llm.context_max_tokens,
        });
        this.contextManager.updateModel(model, ctxLimit);
      },
      getActiveToolDefinitions: () => this.getActiveToolDefinitions(),
      getCurrentLlmAbortController: () => this.currentLlmAbortController,
      setCurrentLlmAbortController: (ctrl) => { this.currentLlmAbortController = ctrl; },
      isFinished: () => this.finished,
      isWaitingForUser: () => this.waitingForUser,
      setWaitingForUser: (v) => { this.waitingForUser = v; },
      isUserInterruptPending: () => this.userInterruptPending,
      isPendingReview: () => this.pendingReview,
      setIsBusy: (v) => { this.isBusy = v; },
      getLastProgressAtMs: () => this.progressInvariant.lastProgressAtMs,
      setLastProgressAtMs: (v) => { this.progressInvariant.lastProgressAtMs = v; },
      getRawXmlRetryCount: () => this.rawXmlRetryCount,
      setRawXmlRetryCount: (v) => { this.rawXmlRetryCount = v; },
      getEmptyResponseRetryCount: () => this.emptyResponseRetryCount,
      setEmptyResponseRetryCount: (v) => { this.emptyResponseRetryCount = v; },
      getLlmErrorRetryCount: () => this.llmErrorRetryCount,
      setLlmErrorRetryCount: (v) => { this.llmErrorRetryCount = v; },
      getLlmMaxErrorRetries: () => this.LLM_MAX_ERROR_RETRIES,
      getTurnCount: () => this.turnCount,
      getNudgeMessage: () => this.nudgeMessage,
      clearNudgeMessage: () => { this.nudgeMessage = null; },
      drainPendingUserMessages: () => this.drainPendingUserMessagesIntoConversation(),
      hasPendingTasks: () => this.hasPendingTasks(),
      hasDispatchableWork: () => this.board.getDispatchable().length > 0,
      isEternalMode: () => this.isEternalMode(),
      getCollaborationMode: () => resolveModeRuntimeProjection({
        sessionId: this.sessionId,
        db: this.db,
        blackboardAvailable: this.isBlackboardEnabled(),
        permissionSummary: this.getInteractionSnapshot().permissionSummary,
      }).collaboration.mode,
      hasExplicitUserGate: () => this.hasExplicitUserGate(),
      getPendingAgentCompletionSignals: () => this.pendingAgentCompletionSignals,
      isAgentCompletionPending: () => this.pendingAgentCompletionSignals.length > 0,
      getBoardTaskCount: () => this.board.getAllTasks().length,
      getTaskById: (taskId: string) => this.board.getTask(taskId),
      peekNextTaskIds: (count: number) => this.board.peekNextTaskIds(count),
      getActiveTeam: () => this.activeTeamName,
      getRunningAgentsCount: () => typeof this.pool.getRunning === 'function' ? this.pool.getRunning().length : 0,
      getAllTasks: () => this.board.getAllTasks(),
      getActiveTaskId: () => {
        const running = typeof this.pool.getRunning === 'function' ? this.pool.getRunning() : [];
        return running.length > 0 ? running[0].taskId : undefined;
      },
      executeToolCallsBatch: (toolCalls) => this.executeToolCallsBatch(toolCalls),
      maybeContinueFromStopHook: (final) => this.maybeContinueFromStopHook(final),
      appendRuntimeContextManifestIfChanged: () => this.appendRuntimeContextManifestIfChanged(),
      appendContextMemoryIfChanged: () => this.appendContextMemoryIfChanged(),
      createFileSnapshot: async (turnCount, label) => {
        try {
          if (!this.fileChangesApi) {
            const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
            const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
            this.fileChangesApi = new FileChangesApi(new DatabaseRepositoryAdapter(this.db));
          }
          await this.fileChangesApi.createSnapshot(this.sessionId, `[turn:${turnCount}] ${label}`);
        } catch { /* non-critical */ }
      },
      getBlackboardAnalysis: () => this.getBlackboardAnalysis(),
      upsertSystemSlot: (matcher, content) => this.upsertRuntimeSystemSlot(matcher, content),
      compactContext: () => this.compactContext(),
    });

    // ─── 黑板架构初始化（feature flag + mode policy） ───
    this.ensureFullBlackboardInitialized();

    // ─── 统一调度器 — 唯一 worker dispatch 入口 ───
    this.scheduler = new UnifiedScheduler({
      sessionId: this.sessionId,
      board: this.board,
      pool: this.pool,
      emitter: this.emitter,
      dispatchTask: (task, opts) => this.runScheduledDispatch(task, opts),
      config: {
        maxWorkers: globalConfig.agents.max_concurrent,
        maxProjectWorkers: globalConfig.agents.max_concurrent,
      },
    });

    // ─── 派发决策协调器 — 依赖解锁/队友完成后提醒 Leader 显式处置 ───
    this.dispatchDecisionCoordinator = new DispatchDecisionCoordinator({
      sessionId: this.sessionId,
      board: this.board,
      emitter: this.emitter,
      requestLeaderDecision: (tasks) => this.requestLeaderDispatchDecision(tasks),
      getDispatchFingerprintContext: () => {
        const modes = resolveModeRuntimeProjection({
          sessionId: this.sessionId,
          db: this.db,
          blackboardAvailable: Boolean(this.leaderBlackboard),
          permissionSummary: this.getInteractionSnapshot().permissionSummary,
        });
        return {
          collaborationMode: modes.collaboration.mode,
          routePreference: modes.route.preference,
          activeTeamName: modes.collaboration.activeTeamName ?? this.activeTeamName,
        };
      },
    });

    // ─── 配置热加载：health/probe 参数变更时尝试更新运行时状态 ───
    // AgentHealthMonitor 和 LeaderSupervisionCoordinator 的内部 config 在构造时固定，
    // 无法从外部原地更新。此处注册 onConfigReload 记录日志，提示部分配置
    // 需要新 session 才能完全生效；同时 syncDerivedConstants 已在 config.ts
    // 的 refreshRuntimeConfig 中调用，LEADER_MAX_TOOL_ROUNDS / MAX_CONVERSATION_MESSAGES
    // 等 let 变量会自动更新，leaderThinkAndAct 和 trimConversationBuffer 在下次
    // 调用时自动读取新值。
    this._configReloadUnsubscribe = onConfigReload((cfg) => {
      try {
        // 检测 health/probe 配置是否发生变化
        const healthChanged =
          cfg.health.poll_interval_seconds !== HEALTH_POLL_INTERVAL_SECONDS ||
          cfg.health.stall_threshold_seconds !== HEALTH_STALL_THRESHOLD_SECONDS ||
          cfg.health.stuck_threshold_seconds !== HEALTH_STUCK_THRESHOLD_SECONDS ||
          cfg.health.runaway_threshold_seconds !== HEALTH_RUNAWAY_THRESHOLD_SECONDS ||
          cfg.health.nudge_cooldown_seconds !== HEALTH_NUDGE_COOLDOWN_SECONDS ||
          cfg.health.max_nudge_before_escalation !== HEALTH_MAX_NUDGE_BEFORE_ESCALATION;
        const probeChanged =
          cfg.leader.probe_silence_seconds !== LEADER_PROBE_SILENCE_SECONDS ||
          cfg.leader.probe_max_interval_seconds !== LEADER_PROBE_MAX_INTERVAL_SECONDS ||
          cfg.leader.probe_backoff_multiplier !== LEADER_PROBE_BACKOFF_MULTIPLIER ||
          cfg.leader.idle_warning_seconds !== LEADER_IDLE_WARNING_SECONDS;
        if (healthChanged || probeChanged) {
          leaderLogger.warn(
            `[LeaderAgent] health/probe 配置已热加载，但 AgentHealthMonitor 和 SupervisionCoordinator 的内部 config 在构造时固定。` +
            `部分参数（poll interval、stall/stuck/runaway 阈值、probe 间隔等）需要新 session 才能完全生效。` +
            `LEADER_MAX_TOOL_ROUNDS / MAX_CONVERSATION_MESSAGES 等 let 变量已通过 syncDerivedConstants 自动更新。`
          );
        }
      } catch (e) {
        leaderLogger.warn(`[LeaderAgent] onConfigReload 回调异常: ${e}`);
      }
    });
  }

  private ensureFullBlackboardInitialized(): void {
    if (this.leaderBlackboard) return;
    // 黑板初始化下沉到 LeaderBlackboard.initializeIfApplicable — 事件订阅/契约落盘/图桥接
    // 全部在子模块内完成，原 LA 只负责注入依赖（active team provider / workflowEngine /
    // teamSynchronizer / refreshContractBoundTasks）并把退订函数并入 _taskTeamUnsubscribers。
    this.leaderBlackboard = LeaderBlackboard.initializeIfApplicable({
      db: this.db,
      emitter: this.emitter,
      sessionId: this.sessionId,
      pool: this.pool,
      workspace: this.workspace,
      activeTeamProvider: () => this.activeTeamName,
      permissionSummary: this.getInteractionSnapshot().permissionSummary,
      workflowEngine: this.workflowEngine,
      teamSynchronizer: this.teamSynchronizer,
      refreshContractBoundTasks: (event) => this.refreshContractBoundTasks(event),
      unsubscribersSink: this._taskTeamUnsubscribers,
    });
  }

  /**
   * 把需要显式派发决策的任务交回 Leader：注入 system 提示并触发下一轮思考。
   * 这是重构前 LeaderAgent 主循环「已解锁可调度」提示路径的复用入口。
   */
  protected requestLeaderDispatchDecision(tasks: Task[]): void {
    if (tasks.length === 0) return;
    try {
      // 去重：5s 内同一批任务 id 不重复注入（事件驱动 + 主循环兜底可能撞车）
      const sig = tasks.map(t => t.id).sort().join(',');
      const now = Date.now();
      if (this.lastLeaderDecisionSig
        && this.lastLeaderDecisionSig.sig === sig
        && now - this.lastLeaderDecisionSig.at < 5000) {
        return;
      }
      this.lastLeaderDecisionSig = { sig, at: now };

      const dispatchMsg = '以下任务已解锁可调度:\n'
        + tasks.map(t => `- [${t.id}] ${t.subject} (类型=${t.agent_type}${t.preferred_agent_name ? `, 预绑定=@${t.preferred_agent_name}` : ''})\n`).join('')
        + '强制要求：对每个就绪任务，要么立刻派发（建/复用 worker 调度），要么逐条给出可核验的暂不派理由（依赖未真正满足 / 并发预算已满 / 需用户决策等）。'
        + '就绪任务的处理口径：已解锁任务需要派发动作或具体暂缓依据；监控纪律只约束运行中的 agent。';
      this.addMessage({ role: 'system', content: dispatchMsg });
      void this.db.saveConversationMessage(this.sessionId, { role: 'system', content: dispatchMsg });
    } catch (err) {
      leaderLogger.warn(`[DispatchDecision] requestLeaderDispatchDecision 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 调度器派发 hook — 把 TaskBoard task 物化为运行中的 worker。
   *
   * 调用约定：
   * - scheduler 已经在 budget / 单调度入口语义上做完检查；这里只负责把 task 转成 worker。
   * - 失败返回 false，scheduler 会回滚 budget；不抛错以避免 tick 循环失败。
   */
  protected async runScheduledDispatch(
    task: Task,
    opts?: SchedDispatchOptions,
  ): Promise<boolean> {
    if (!this.dispatchDecisionCoordinator) return false;
    return this.dispatchDecisionCoordinator.dispatchScheduledTask(task, opts, {
      sessionId: this.sessionId,
      db: this.db,
      roleRegistry: this.roleRegistry,
      pool: this.pool,
      board: this.board,
      bus: this.bus,
      permissionSummary: () => this.getInteractionSnapshot().permissionSummary,
      isBlackboardEnabled: () => this.isBlackboardEnabled(),
      getActiveTeam: () => this.getActiveTeam(),
      sessionPrefix: (name) => this.sessionPrefix(name),
      registerAgentHealth: (agentId, name, roleType) => this.registerAgentHealth(agentId, name, roleType),
      transitionHandleToStopped: transitionLeaderAgentHandleToStopped,
    });
  }

  protected toLeaderSupervisionAgents(handles: AgentHandle[]): LeaderSupervisionAgentSnapshot[] {
    return this.supervCoordinator.toLeaderSupervisionAgents(handles);
  }

  protected getLeaderSupervisionEvaluation(running: AgentHandle[]): LeaderSupervisionEvaluation {
    return this.supervCoordinator.getLeaderSupervisionEvaluation(running);
  }

  protected getLeaderSupervisionWaitTimeoutMs(running: AgentHandle[]): number {
    return this.supervCoordinator.getLeaderSupervisionWaitTimeoutMs(running);
  }

  protected _unsubscribeAgentActivityEvents(): void {
    this.supervCoordinator.unsubscribeAgentActivityEvents();
  }

  protected markLeaderSupervisionProgress(progressAtMs = Date.now()): void {
    this.supervCoordinator.markLeaderSupervisionProgress(progressAtMs);
  }

  protected surfaceIdleWarnings(
    idleAgents: LeaderSupervisionAgentSnapshot[],
    nowMs = Date.now(),
  ): void {
    this.supervCoordinator.surfaceIdleWarnings(idleAgents, nowMs);
  }

  getPermissionContext(): ToolPermissionContext {
    return this.permManager.getPermissionContext();
  }

  protected loadPermissionContextFromState(): void {
    this.permManager.loadPermissionContextFromState();
  }

  applyPermissionUpdates(
    updates: PermissionUpdate[],
    destination: PermissionUpdateDestination = 'session'
  ): ToolPermissionContext {
    return this.permManager.applyPermissionUpdates(updates, destination);
  }

  protected requestPermissionUpdate(payload: PermissionRequestPayload): string {
    return this.permManager.requestPermissionUpdate(payload, this.isEternalMode());
  }

  getControlMode(): 'manual' | 'eternal' {
    return this.controlMode;
  }

  isEternalMode(): boolean {
    return this.controlMode === 'eternal';
  }

  async setControlMode(mode: 'manual' | 'eternal'): Promise<{ ok: boolean; message: string }> {
    if (mode !== 'manual' && mode !== 'eternal') {
      return { ok: false, message: `invalid control mode: ${String(mode)}` };
    }

    const previousMode = this.controlMode;
    if (previousMode === mode) {
      return { ok: true, message: `control mode already ${mode}` };
    }

    this.controlMode = mode;
    await this.db.setSessionState(this.sessionId, SESSION_KEYS.CONTROL_MODE, mode);

    // 切回 manual：解绑 EternalLoop 的 7 个事件监听 + 上锁，避免 listener 残留 / 旧 silence state 在下次切回 eternal 时复活
    // 切到 eternal：让 progressInvariant 主动重新绑定（兼容运行时第一次开启）+ 把卡住的非 bypass 权限请求批准回放
    if (mode === 'manual') {
      this.progressInvariant.disposeEternalListeners();
      // 切回 manual 时若当前还有 in-flight patrol LLM round，立即 abort，
      // 否则用户切回手动后还会经历"最后一轮自驱"才停下，违反"立即生效"预期。
      // 注意：仅在原先是 eternal 时 abort——如果原本就是 manual（重复切换），
      // 当前 LLM 必然是用户触发的，不应打断。
      if (previousMode === 'eternal' && this.currentLlmAbortController) {
        try {
          this.currentLlmAbortController.abort('control mode switched to manual');
          leaderLogger.info('[ControlMode] 切回 manual 时 abort 当前 patrol LLM round');
        } catch {
          /* abort 异常可吞 */
        }
      }
    } else {
      this.progressInvariant.rebindEternalListenersIfActive();
      const replayed = this.permManager.replayPendingOnEternalEnable();
      if (replayed > 0) {
        leaderLogger.info(`[ControlMode] 切到 eternal 时回放并自动批准 ${replayed} 条卡住的权限请求`);
      }
    }

    this.emitter.emit('leader:control_mode_changed', {
      sessionId: this.sessionId,
      mode,
      previousMode,
    });
    return { ok: true, message: `control mode changed to ${mode}` };
  }

  protected resolvePendingPermissionFromUserInput(content: string): 'resolved' | 'pending' | 'none' {
    return this.permManager.resolvePendingPermissionFromUserInput(content);
  }

  /**
   * 从 Web UI 直接解决权限请求（绕过文本输入解析）
   * 由 AcpHandler 调用，当用户在 Web UI 点击批准/拒绝时触发
   */
  public resolvePermissionFromWebUI(requestId: string, decision: 'approved' | 'rejected' | 'allowAll'): void {
    this.permManager.resolvePermissionFromWebUI(requestId, decision);
  }

  protected getActiveToolDefinitions(): ToolDefinition[] {
    return this.executionController.getActiveToolDefinitions();
  }

  protected setExecutionRoute(decision: RouteDecision): void {
    this.executionController.setExecutionRoute(decision);
  }

  protected chooseExecutionRoute(intentProfile?: CapabilityIntentProfile | null): RouteDecision {
    return this.executionController.chooseExecutionRoute(intentProfile);
  }

  private beginUserTurn(): number {
    this.turnCount++;
    this.db.setSessionState(this.sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, this.turnCount);
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.CAPABILITY_INTENT_PROFILE);
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID);
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.AUTONOMY_DECISION_TRACE);
    return this.turnCount;
  }

  setDelegateMode(reason: string): void {
    this.executionController.setDelegateMode(reason);
  }

  /** Active team for this session (null when no team has been created yet). */
  getActiveTeam(): string | null {
    return this.activeTeamName;
  }

  /**
   * Set / clear the active team name for this session and persist to session_state.
   * dispatch_agent uses this with the explicit TeamMemberRegistry roster.
   */
  setActiveTeam(teamName: string | null): void {
    this.activeTeamName = teamName;
    try {
      if (teamName) {
        void this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM, teamName);
        void this.db.setSessionState(this.sessionId, SESSION_KEYS.COLLABORATION_MODE, 'team');
      } else {
        void this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM, '');
        void this.db.setSessionState(this.sessionId, SESSION_KEYS.COLLABORATION_MODE, 'solo');
      }
    } catch { /* tolerate */ }
    if (teamName) {
      this.ensureFullBlackboardInitialized();
    }
  }

  protected async acceptWorkerTaskResult(input: {
    taskId: string;
    taskRunGeneration?: number;
    status: 'terminal';
    exitReason: 'completed' | 'failed';
    result: string;
    agentName?: string;
    summary?: string;
    verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
    artifacts?: WorkerArtifactTrace;
    verification?: WorkerVerificationItem[];
    next_steps?: string[];
    blocked_by_discovery?: string[];
    needs_leader_coordination?: boolean;
    evidence_refs?: string[];
    contract_compliance?: WorkerContractComplianceProof;
    toolTrace?: WorkerArtifactTrace;
  }): Promise<void> {
    const queued = this.workerResultQueue.then(() => this.processWorkerTaskResult(input));
    this.workerResultQueue = queued.catch((error) => {
      leaderLogger.error('[Leader] worker 回执处理失败:', error);
    });
    return queued;
  }

  protected async processWorkerTaskResult(input: {
    taskId: string;
    taskRunGeneration?: number;
    status: 'terminal';
    exitReason: 'completed' | 'failed';
    result: string;
    agentName?: string;
    summary?: string;
    verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
    artifacts?: WorkerArtifactTrace;
    verification?: WorkerVerificationItem[];
    next_steps?: string[];
    blocked_by_discovery?: string[];
    needs_leader_coordination?: boolean;
    evidence_refs?: string[];
    contract_compliance?: WorkerContractComplianceProof;
    toolTrace?: WorkerArtifactTrace;
  }): Promise<void> {
    return this.workOrchestrator.processWorkerTaskResult(input);
  }

  /**
   * Attribute a task's terminal outcome to the agent that ran it (N5-A task_outcome).
   * Recorded at the true terminal points (completeTask / failTask), not at receipt entry,
   * so an orchestration-rejected 'completed' that gets redispatched does NOT inflate the
   * success count. Best-effort: never blocks receipt handling. The ref matches the
   * agent_spawned埋点 (agents/<name>) so usage + outcome correlate per agent.
   */
  private recordAgentOutcome(agentName: string | undefined, taskId: string, outcome: 'success' | 'failure'): void {
    try {
      const clean = (agentName || '').replace(/^[^:]+:/, '');
      if (!clean) return;
      new AssetUsageStore(join(this.workspace, '.lingxiao')).recordUsage({
        assetRef: `agents/${clean}`,
        outcome,
        taskId,
        sessionId: this.sessionId,
        timestamp: Date.now(),
      });
    } catch { /* usage tracking is best-effort, never blocks receipt handling */ }
  }


  protected captureBughuntWorkerEvidence(input: {
    taskId: string;
    status: 'terminal';
    exitReason: 'completed' | 'failed';
    result: string;
    agentName?: string;
  }): void {
    try {
      captureBughuntEvidence(this.db, {
        taskId: input.taskId,
        status: input.exitReason,
        result: input.result,
        agentName: input.agentName,
        sessionId: this.sessionId,
        workspace: this.workspace,
      });
    } catch (error) {
      leaderLogger.debug('[Bughunt] evidence extraction skipped:', error);
    }
    // P5: worker terminal → 回写对应 DAG node 为 completed，解锁后继节点的 blocked_by。
    // 单一真相源：ledger.dag 是调度核心，TaskBoard task 是执行投影（node.task_id ↔ task.id）。
    try {
      const ledger = readBughuntLedger(this.db, this.sessionId);
      if (ledger) {
        const dagNode = ledger.dag.find((n) => n.task_id === input.taskId);
        if (dagNode) {
          updateBughuntDagNode(this.db, this.sessionId, dagNode.id, { status: 'completed' });
        }
      }
    } catch (error) {
      leaderLogger.debug('[Bughunt] DAG node writeback skipped:', error);
    }
  }




  protected async consumePendingAgentCompletionsIntoConversation(): Promise<boolean> {
    return this.workOrchestrator.consumePendingAgentCompletionsIntoConversation();
  }

  /**
   * 任务完成时落盘 Implementation 报告，便于 Leader / 下游 agent 通过
   * session_artifacts 工具读取真实交付内容（结果摘要 + scratchpad 尾巴）。
   */
  protected persistImplementationArtifact(input: {
    taskId: string;
    agentName?: string;
    result: string;
  }): void {
    try {
      const task = this.board.getTask(input.taskId);
      const paths = Workspace.getSessionArtifactPaths(this.sessionId, this.workspace);
      // 去掉 session 前缀（bus sender 是 sessionId:agentName）
      const localAgent = (input.agentName ?? task?.assigned_agent ?? 'unknown').replace(/^[^:]+:/, '');
      const md = buildImplementationContent({
        taskId: input.taskId,
        agentName: localAgent,
        result: typeof input.result === 'string' ? input.result : JSON.stringify(input.result),
        workspace: this.workspace,
        sessionId: this.sessionId,
        task,
      });
      mkdirSync(paths.implementationsDir, { recursive: true });
      const safeId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
      writeFileSync(join(paths.implementationsDir, `${safeId}.md`), md, 'utf-8');
    } catch (error) {
      leaderLogger.warn(`[Leader] persist implementation artifact failed (task=${input.taskId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * LeaderContextBuilder 依赖句柄:经 getter 闭包捕获运行期才初始化的实例字段,
   * 避免在构造期(字段尚未赋值)即解析。fingerprint 状态与上下文装配逻辑均下沉至 builder。
   */
  protected buildContextBuilderDeps(): LeaderContextBuilderDeps {
    return {
      sessionId: this.sessionId,
      model: this.model,
      workspace: this.workspace,
      getPendingAgentCompletionSignals: () => this.pendingAgentCompletionSignals,
      getPool: () => this.pool,
      getBoard: () => this.board,
      getWorkOrchestrator: () => this.workOrchestrator,
      getContextManager: () => this.contextManager,
      getLeaderBlackboard: () => this.leaderBlackboard,
      getWorkNoteManager: () => this.workNoteManager,
      getOriginalGoal: () => this.originalGoal,
      getActiveTeamName: () => this.activeTeamName,
      isBlackboardEnabled: () => this.isBlackboardEnabled(),
      getPermissionSummary: () => this.getInteractionSnapshot().permissionSummary,
      getDb: () => this.db,
      addMessage: (msg) => this.addMessage(msg),
      upsertSystemSlot: (matcher, content) => this.upsertRuntimeSystemSlot(matcher, content),
    };
  }

  protected buildRuntimeStateSection(): string {
    return this.contextBuilder.buildRuntimeStateSection();
  }

  protected buildLeaderLiveRuntimeAwareness(): string {
    return this.contextBuilder.buildLeaderLiveRuntimeAwareness();
  }

  protected appendRuntimeContextManifestIfChanged(): boolean {
    return this.contextBuilder.appendRuntimeContextManifestIfChanged();
  }

  protected async appendContextMemoryIfChanged(): Promise<boolean> {
    return this.contextBuilder.appendContextMemoryIfChanged();
  }


  protected hasNonTerminalTasks(): boolean {
    return this.workOrchestrator.hasNonTerminalTasks();
  }

  protected hasExplicitUserGate(): boolean {
    return this.workOrchestrator.hasExplicitUserGate();
  }

  protected async maybeDriveOpenWork(): Promise<boolean> {
    return this.workOrchestrator.maybeDriveOpenWork();
  }

  protected reconcileRecoveringTasks(): boolean {
    return this.workOrchestrator.reconcileRecoveringTasks();
  }

  protected getRecoveryStatusSummary(): {
    total: number;
    blocked: number;
    statusText?: string;
  } {
    return this.workOrchestrator.getRecoveryStatusSummary();
  }

  protected async maybeFinalizeCompletedSession(): Promise<boolean> {
    return this.workOrchestrator.maybeFinalizeCompletedSession();
  }

  protected async maybeContinueFromStopHook(final: string): Promise<{
    shouldContinue: boolean;
    feedback?: string;
    signal?: { source: string; detail?: string };
  }> {
    return this.workOrchestrator.maybeContinueFromStopHook(final);
  }

  resolveRoleCapability(input: {
    roleName: string;
    baseRoleName?: string;
    roleDescription: string;
    systemPrompt: string;
    tools: string[];
    requestedSkillNames?: string[];
  }): ResolvedRoleCapability {
    const disabledNames = resolveDisabledSkillNames();
    const availableSkills = collectAvailableSkills(this.workspace, { disabledNames });
    const userRequestedSkillNames = Array.from(new Set([
      ...resolveExplicitSkillMentions(input.roleDescription, availableSkills),
      ...resolveExplicitSkillMentions(input.systemPrompt, availableSkills),
    ]));
    return resolveDynamicRoleCapability({
      roleName: input.roleName,
      baseRoleName: input.baseRoleName,
      roleDescription: input.roleDescription,
      systemPrompt: input.systemPrompt,
      requestedTools: input.tools,
      availableSkills,
      requestedSkillNames: input.requestedSkillNames,
      userRequestedSkillNames,
    });
  }

  selectSkillsForRole(input: {
    roleName: string;
    baseRoleName?: string;
    roleDescription: string;
    systemPrompt: string;
    tools: string[];
    requestedSkillNames?: string[];
  }): string[] {
    return this.resolveRoleCapability(input).skillNames;
  }

  /**
   * 注册系统预置角色
   */
  protected registerBuiltinRoles(): void {
    const roles = collectBuiltinRoles({
      prompts: {
        research: RESEARCH_SYSTEM_PROMPT_BY_LOCALE,
        explore: EXPLORE_SYSTEM_PROMPT_BY_LOCALE,
        coding: CODING_SYSTEM_PROMPT_BY_LOCALE,
        verify: VERIFY_SYSTEM_PROMPT_BY_LOCALE,
        review: REVIEW_SYSTEM_PROMPT_BY_LOCALE,
        frontend: FRONTEND_SYSTEM_PROMPT_BY_LOCALE,
        backend: BACKEND_SYSTEM_PROMPT_BY_LOCALE,
        fullstack: FULLSTACK_SYSTEM_PROMPT_BY_LOCALE,
        qa: QA_SYSTEM_PROMPT_BY_LOCALE,
        ux_designer: UX_DESIGNER_SYSTEM_PROMPT_BY_LOCALE,
        planner: PLANNER_SYSTEM_PROMPT_BY_LOCALE,
        evaluator: EVALUATOR_SYSTEM_PROMPT_BY_LOCALE,
        architect: ARCHITECT_SYSTEM_PROMPT_BY_LOCALE,
      },
      externalCodingPrompt: CODING_SYSTEM_PROMPT_BY_LOCALE,
      availability: getExternalAgentAvailability(),
      descriptions: {
        claudeCoding: t('external_agent.role.claude_coding.description'),
        codexCoding: t('external_agent.role.codex_coding.description'),
      },
    });
    // 应用全局 settings.json 里的 roles 配置（基础工具开关 + 每角色 tools_added/removed）。
    const rolesCfg = (globalConfig as { roles?: { basic_tools_enabled?: boolean; overrides?: Record<string, { tools_added?: string[]; tools_removed?: string[] }> } }).roles;
    const adjusted = applyRoleToolsConfigMap(roles, {
      basicToolsEnabled: rolesCfg?.basic_tools_enabled !== false,
      overrides: rolesCfg?.overrides,
    });
    for (const role of adjusted) {
      this.roleRegistry.register(role);
    }
  }

  /**
   * 热加载：重新计算 settings.json 中 `roles.basic_tools_enabled` / `roles.overrides`
   * 对内置角色 tools 的影响，覆写 RoleRegistry 里 createdBy='system' 的条目。
   *
   * 不动自定义角色（createdBy='llm'/'user'）。已派出的 worker 仍持有旧 tools 快照，
   * 新 dispatch 的 worker 通过 RoleRegistry.get(name).tools 自动取到新值。
   */
  public reloadBuiltinRoles(): void {
    this.registerBuiltinRoles();
    this.registerCustomAgentRoles();
  }

  protected registerCustomAgentRoles(): void {
    const disabledNames = resolveDisabledSkillNames();
    const availableSkills = collectAvailableSkills(this.workspace, { disabledNames });
    const service = new AgentDefinitionService({ workspace: this.workspace });
    const rolesCfg = (globalConfig as { roles?: { basic_tools_enabled?: boolean; overrides?: Record<string, { tools_added?: string[]; tools_removed?: string[] }> } }).roles;
    const adjusted = applyRoleToolsConfigMap(service.listAgentRoles(availableSkills), {
      basicToolsEnabled: rolesCfg?.basic_tools_enabled !== false,
      overrides: rolesCfg?.overrides,
    });
    for (const role of adjusted) {
      this.roleRegistry.register(role);
    }
  }

  /**
   * 添加消息到对话历史，带 Ring Buffer 保护
   */
  public addMessage(msg: ChatMessage): void {
    ensureMessageTimestamp(msg);
    this.conversation.push(msg);
    this.conversation = trimConversationBuffer(this.conversation, MAX_CONVERSATION_MESSAGES, MAX_CONVERSATION_BYTES);
  }

  /**
   * 获取系统提示（稳定核心 — 可被 Anthropic cache 缓存）
   */
  protected getSystemPrompt(): string {
    const locale = getPromptLocale();
    const modes = resolveModeRuntimeProjection({
      sessionId: this.sessionId,
      db: this.db,
      blackboardAvailable: this.isBlackboardEnabled(),
      permissionSummary: this.getInteractionSnapshot().permissionSummary,
    });
    const promptProfile = modes.workflow.enabled
      ? 'workflow'
      : modes.collaboration.mode === 'team'
        ? 'team'
        : 'solo';
    return buildLeaderSystemPrompt({
      template: this.customPrompt || getLeaderSystemPrompt(locale, promptProfile),
      availableRoles: this.roleRegistry.toLLMContext(),
      sessionId: this.sessionId,
      workspace: this.workspace,
      sessionScopeSection: buildSessionScopeSection({
        workspace: this.workspace,
        sessionId: this.sessionId,
      }),
      skillsContent: this.defaultSkillsContent,
      locale,
    });
  }

  /**
   * Keep the primary Leader system prompt aligned with runtime mode changes.
   *
   * Existing sessions may switch Solo/Team/Workflow after the first system
   * message has already been persisted. The runtime LLM input should reflect
   * the current mode immediately, while the historical conversation table
   * remains append-only.
   */
  private hashContextContent(content: unknown): string {
    return createHash('sha1').update(contentToPlainText(content)).digest('hex').slice(0, 16);
  }

  protected syncSystemPromptForCurrentMode(): void {
    const prompt = this.getSystemPrompt();
    const firstSystemIndex = this.conversation.findIndex((message) => message.role === 'system');
    if (firstSystemIndex >= 0) {
      if (this.conversation[firstSystemIndex]?.content !== prompt) {
        const previous = this.conversation[firstSystemIndex]?.content;
        this.conversation[firstSystemIndex] = {
          ...this.conversation[firstSystemIndex],
          content: prompt,
        };
        this.emitter.emit('context:mutation', {
          sessionId: this.sessionId,
          source: 'leader_system_prompt_sync',
          operation: 'replace',
          slot: 'leader_primary_system',
          oldHash: this.hashContextContent(previous),
          newHash: this.hashContextContent(prompt),
          oldLength: contentToPlainText(previous).length,
          newLength: prompt.length,
          changed: true,
          reason: 'primary_system_prompt_changed',
        });
      }
      return;
    }
    this.conversation.unshift({
      role: 'system',
      content: prompt,
      timestamp: Date.now() / 1000,
    });
    this.emitter.emit('context:mutation', {
      sessionId: this.sessionId,
      source: 'leader_system_prompt_sync',
      operation: 'append',
      slot: 'leader_primary_system',
      oldHash: null,
      newHash: this.hashContextContent(prompt),
      oldLength: 0,
      newLength: prompt.length,
      changed: true,
      reason: 'primary_system_prompt_inserted',
    });
    this.conversation = trimConversationBuffer(this.conversation, MAX_CONVERSATION_MESSAGES, MAX_CONVERSATION_BYTES);
  }

  /**
   * Leader 侧状态镜像类 system 槽位（每轮刷新、最新值即权威）。
   * upsertRuntimeSystemSlot / collapseLeaderSystemSlots 据此做单槽 in-place 更新，
   * 治本「每轮 append manifest/黑板分析堆积占满上下文」。与 mode hint 同契约：只改内存
   * 运行时视图，DB 保持 append-only（manifest 是可重算状态镜像，崩溃/审计无损）。
   */
  private static readonly LEADER_SYSTEM_SLOTS: readonly SystemSlotMatcher[] = [
    { kind: 'manifestSlot', slot: 'leader_runtime' },
    { kind: 'manifestSlot', slot: 'leader_memory' },
    { kind: 'manifestSlot', slot: 'leader_init' },
    { kind: 'prefix', prefix: '## 黑板图分析（自动注入' },
  ];

  /**
   * 单槽 in-place system 注入（状态镜像类）。命中同槽覆盖内容 + collapse 残留，无匹配 append。
   * 只改 this.conversation 内存视图，不落库（同 pruneStaleModeHints / syncSystemPromptForCurrentMode 契约）。
   */
  private upsertRuntimeSystemSlot(matcher: SystemSlotMatcher, content: string): boolean {
    const slot = matcher.kind === 'manifestSlot' ? matcher.slot : matcher.prefix;
    const before = this.conversation.find((message) => message.role === 'system' && (
      matcher.kind === 'manifestSlot'
        ? contentToPlainText(message.content).includes(`slot=${matcher.slot}`)
        : contentToPlainText(message.content).trimStart().startsWith(matcher.prefix)
    ));
    const result = upsertSystemSlot(this.conversation, matcher, content);
    if (result.messages !== this.conversation) {
      this.conversation = trimConversationBuffer(result.messages, MAX_CONVERSATION_MESSAGES, MAX_CONVERSATION_BYTES);
    }
    if (result.changed) {
      this.emitter.emit('context:mutation', {
        sessionId: this.sessionId,
        source: 'leader_runtime_system_slot',
        operation: before ? 'replace' : 'append',
        slot,
        oldHash: before ? this.hashContextContent(before.content) : null,
        newHash: this.hashContextContent(content),
        oldLength: before ? contentToPlainText(before.content).length : 0,
        newLength: content.length,
        changed: true,
        reason: 'system_slot_upsert',
      });
    }
    return result.changed;
  }

  /**
   * 收敛 conversation 中 append-only 累积的所有状态镜像槽位（每个槽只留最后一条）。
   * resume 从 DB 重建带回的历史残留在此一次性收敛（治本 R1）。
   */
  private collapseLeaderSystemSlots(): void {
    const collapsed = collapseSystemSlots(this.conversation, LeaderAgent.LEADER_SYSTEM_SLOTS);
    if (collapsed !== this.conversation) {
      this.conversation = collapsed;
    }
  }

  /**
   * 模式切换（solo↔team / execution route）后立即对齐运行时 Leader 上下文。
   *
   * 由 SessionManagerRuntime.setCollaborationMode / setExecutionRoutePreference 在写 DB 后调用，
   * 覆盖 Web/CLI/TUI 全部切换入口——切换不再「等下一条用户消息触发 think 才生效」。
   *
   * 纯同步、不触发 think（避免空转 ping LLM，见 leader-keeps-pinging-llm 教训）：
   *  - syncSystemPromptForCurrentMode: 重写 conversation[0] 主 system prompt 为当前 mode profile；
   *  - pruneStaleModeHints: 移除切换前 append-only 残留的旧 mode hint，刷新保留的最新 hint
   *    （含新 route 偏好 section），消除「旧 [Solo 模式] 与新 [Team 模式] 并存」的注入冲突。
   *
   * Node 单线程下它只能在 think 的 await 让出点（LLM in-flight）插入；已发请求用旧快照不受影响，
   * 下一轮 think 读新数组。session 未加载时调用方已跳过（DB 是真理，下次加载/resume 首轮 think 对齐）。
   */
  public applyRuntimeModeChange(): void {
    this.syncSystemPromptForCurrentMode();
    this.pruneStaleModeHints();
  }

  /**
   * 修剪 conversation 中 append-only 累积的 mode hint system 消息：只保留最后一条并刷新为当前
   * getTeamModeHint()（反映最新 collaboration mode + route 偏好），移除切换前残留的旧 hint。
   * 仅修剪内存运行时视图；DB 历史（leader_conversation 表）保持 append-only 不动。
   * 识别用内容指纹（isModeHintContent）而非 metadata——表无 metadata 列，resume 重建后仍可识别。
   */
  private pruneStaleModeHints(): void {
    const hintIndices: number[] = [];
    for (let i = 0; i < this.conversation.length; i++) {
      const message = this.conversation[i];
      if (message.role === 'system' && isModeHintContent(message.content)) {
        hintIndices.push(i);
      }
    }
    if (hintIndices.length === 0) {
      // 无 hint：不动（下次 think 入口或用户消息时会追加当前 mode 的新 hint）。
      return;
    }

    // 多条 hint 时，移除除最后一条外的所有旧 hint（切换前残留）。
    if (hintIndices.length > 1) {
      const keepOriginalIndex = hintIndices[hintIndices.length - 1];
      this.conversation = this.conversation.filter(
        (message, i) =>
          message.role !== 'system' || !isModeHintContent(message.content) || i === keepOriginalIndex,
      );
    }

    // 刷新保留的 hint 为当前最新内容（mode/route 变化都要反映）。
    const latest = this.getTeamModeHint();
    if (latest) {
      const keepIndex = this.conversation.findIndex(
        (message) => message.role === 'system' && isModeHintContent(message.content),
      );
      if (keepIndex >= 0 && this.conversation[keepIndex].content !== latest) {
        this.conversation[keepIndex] = {
          ...this.conversation[keepIndex],
          content: latest,
        };
      }
    }
  }

  /**
   * 获取动态上下文（Context Manifest dynamic context）— 作为独立 system 消息注入
   * 避免动态内容变化导致 Anthropic prompt cache 失效。
   *
   * 实现已下沉至 LeaderContextBuilder.getDynamicContext()(含「当前使命」锚点置顶 +
   * A2 token 预算门:超 context window 60% 时按优先级丢弃低优 fragment,mission 必留)。
   */
  protected getDynamicContext(): string | null {
    return this.contextBuilder.getDynamicContext();
  }

  /**
   * Build the per-turn team-mode hint shown to the Leader before each user
   * message. 实现已下沉至 LeaderContextBuilder.getTeamModeHint()。
   */
  protected getTeamModeHint(): string | null {
    return this.contextBuilder.getTeamModeHint();
  }

  get isRunning(): boolean {
    return this.running && !this.finished;
  }

  markWaitingForUser(waiting: boolean): void {
    this.waitingForUser = waiting;
  }

  /**
   * 标记当前正在等待的用户输入（硬用户门）。
   * ask_user 必须调用它把内存 pendingUserInput 与 DB 写入对齐，
   * 否则 hasExplicitUserGate() 读到内存为 null，主循环 un-latch 守卫
   * 会把"等用户回答"误判成"软空闲等待"并继续偷跑派活。
   */
  markPendingUserInput(input: MessageContent): void {
    this.pendingUserInput = input;
  }

  markPendingReview(pending: boolean): void {
    this.pendingReview = pending;
  }

  async approvePlanInternally(): Promise<void> {
    this.pendingReview = false;
    this.planApproved = true;
    await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_PENDING_REVIEW, 'false');
    await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_PLAN_APPROVED, 'true');
    this.emitter.emit('leader:plan_approved', { sessionId: this.sessionId });
  }

  markFinished(): void {
    this.finished = true;
  }

  /**
   * 切换当前会话使用的模型（立即生效，下一轮 LLM 调用使用新模型）
   */
  setModel(modelId: string, options?: { persistSessionState?: boolean }): { ok: boolean; message: string } {
    if (!modelId) {
      return { ok: false, message: 'modelId 不能为空' };
    }
    const normalizedModelId = modelId.trim();
    try {
      getModelManager().getModelByIdStrict(normalizedModelId);
    } catch (error) {
      const available = getModelManager().getAllModels().map(model => model.id).join(', ') || '无';
      return {
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)} 可用模型: ${available}`,
      };
    }
    const prev = this.model;
    this.model = normalizedModelId;
    if (options?.persistSessionState !== false) {
      void this.db.setSessionState(this.sessionId, SESSION_KEYS.CURRENT_MODEL, normalizedModelId);
    }

    // 同步更新 contextManager 的 context window 大小
    // 优先级：ModelManager 用户配置 > ModelsDevRegistry > 保持现有值
    const contextLimit = resolveModelContextLimit({
      providerCtx: getContextWindowSizeFromProvider(normalizedModelId),
      modelInfoCtx: getModelDevInfo(normalizedModelId)?.contextLimit,
      configuredCtx: globalConfig.llm.context_max_tokens,
    });
    this.contextManager.updateModel(normalizedModelId, contextLimit);
    leaderLogger.info(`模型已切换: ${prev} → ${normalizedModelId}${contextLimit ? ` (ctx ${Math.round(contextLimit / 1000)}K)` : ''}`);

    this.emitter.emit('leader:status', {
      sessionId: this.sessionId,
      status: `模型已切换为 ${normalizedModelId}${contextLimit ? ` · 上下文窗口 ${Math.round(contextLimit / 1000)}K` : ''}`,
    });

    return { ok: true, message: `模型已切换为 ${normalizedModelId}` };
  }

  /**
   * 切换权限模式（strict / dev / networked / yolo）
   */
  setPermissionMode(mode: string): { ok: boolean; message: string } {
    if (!isPermissionMode(mode)) {
      return { ok: false, message: `无效的权限模式: ${mode}，有效值: strict, dev, networked, yolo` };
    }
    const permissionMode: PermissionMode = mode;
    this.applyPermissionUpdates([{ type: 'setMode', mode: permissionMode }], 'session');
    leaderLogger.info(`权限模式已切换: ${mode}`);
    return { ok: true, message: `权限模式已切换为 ${mode}` };
  }

  /**
   * 处理用户输入
   */
  async handleUserInput(content: MessageContent): Promise<void> {
    if (this.waitingForUser) {
      this.waitingForUser = false;
      this.pendingUserInput = content;
      this.addMessage({
        role: 'user',
        content: content,
      });
      // 用户重新发消息时重置所有 Circuit Breaker：
      // CB OPEN 后系统停下等待用户，用户回来时 provider 可能已恢复，
      // 不应让上一代失败计数继续阻塞新请求。
      _resetAllCircuitBreakers();
      this.llmErrorRetryCount = 0;
      leaderLogger.info('[LeaderAgent] 用户重新发消息，已重置 Circuit Breaker 和 LLM 重试计数');
    }
  }

  /**
   * 执行工具调用
   */
  protected async executeToolCall(toolCall: ToolCall): Promise<ToolResultContent> {
    const { name, arguments: argsStr } = toolCall.function;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr);
    } catch (error) {
      return `ERROR: 工具参数 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}\n原始参数: ${argsStr.slice(0, 500)}`;
    }

    // 为 shell 工具注入用户中断信号
    if (name === 'shell') {
      args._abortSignal = this.userInterruptController.signal;
    }

    const heartbeat = startToolProgressHeartbeat({
      emitter: this.emitter,
      toolCall,
      sessionId: this.sessionId,
      scope: 'leader',
    });

    try {
      const registeredTool = this.toolRegistry.get(name);
      if (registeredTool?.scope === 'leader') {
        const result = await this.toolRegistry.execute(name, args, {
          db: this.db,
          sessionId: this.sessionId,
          agentId: 'leader',
          agentName: 'leader',
          workspace: this.workspace,
          emitter: this.emitter,
          bus: this.bus,
          permissionContext: this.permManager.permissionContext,
          llm: this.createLeaderEventStreamClient('Leader-MetaTools'),
          model: this.model,
          leaderToolsExecutor: this.toolsExecutor,
          toolRegistry: this.toolRegistry,
          blackboardGraph: this.leaderBlackboard?.blackboardGraph ?? undefined,
          toolCallId: toolCall.id,
        });
        if (!result.success) return `ERROR: ${result.error || 'unknown error'}`;
        return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      }

      const directExec = await this.directToolsExecutor.executeStructured(name, args, this.permManager.permissionContext, toolCall.id);

      // team_manage(create/delete) 走 ToolRegistry 后，需要在 Leader 侧同步 active team 状态
      // 使用结构化 ok 判定，避免对字符串前缀做关键词正则
      const teamManageAction = name === 'team_manage' ? String((args as { action?: unknown }).action || '').trim() : '';
      if (name === 'team_manage' && teamManageAction === 'create') {
        const teamName = String((args as { team_name?: unknown }).team_name || '').trim();
        if (teamName && directExec.ok) this.setActiveTeam(teamName);
      } else if (name === 'team_manage' && teamManageAction === 'delete') {
        const teamName = String((args as { team_name?: unknown }).team_name || '').trim();
        if (teamName && directExec.ok && this.getActiveTeam() === teamName) this.setActiveTeam(null);
      }

      return directExec.ok ? directExec.content : `ERROR: ${directExec.content}`;
    } finally {
      heartbeat.stop();
    }
  }

  protected canBatchExecuteToolCalls(toolCalls: ToolCall[]): boolean {
    return canBatchExecuteToolCallsFn(toolCalls, LEADER_PARALLEL_SAFE_TOOLS);
  }

  protected async executeToolCallsBatch(
    toolCalls: ToolCall[],
  ): Promise<Array<{ toolCall: ToolCall; result: ToolResultContent }>> {
    return runToolCallsBatch(
      toolCalls,
      (toolCall: ToolCall) => this.executeToolCall(toolCall),
      LEADER_PARALLEL_SAFE_TOOLS,
    );
  }

  protected createToolScheduler(input?: {
    finishReason?: ChatResponse['finish_reason'];
    thinking?: ThinkingBlock[];
    wasOutputTruncated?: boolean;
    nextSpeakerLlm?: ContentGenerator;
  }): ToolScheduler<{ done: boolean; result?: string }> {
    return this.thinkingEngine.createToolScheduler(input);
  }

  protected createLeaderEventStreamClient(
    actorLabel: string,
    hooks?: LlmRoundHooks,
  ): ContentGenerator {
    // NOTE: called during constructor before thinkingEngine is initialized,
    // so we call createEventStreamClient directly instead of delegating.
    return createEventStreamClient({
      actorLabel,
      llm: this.llm,
      classifyError: classifyLLMError,
      hooks,
      gatewayContext: {
        actorType: 'leader',
        actorLabel,
        purpose: 'leader',
        sessionId: this.sessionId,
      },
    });
  }

  protected async monitorUserInterventionDuringInFlight(input: {
    stopSignal: AbortSignal;
    onIntervention: () => void;
  }): Promise<void> {
    return this.thinkingEngine.monitorUserInterventionDuringInFlight(input);
  }

  /**
   * 处理 LLM 响应
   */
  protected async processResponse(response: ChatResponse): Promise<{ done: boolean; result?: string }> {
    return this.thinkingEngine.processResponse(response);
  }

  private isUserInterventionMessage(message: BusMessage): boolean {
    const sender = String(message.from ?? '');
    return message.type === 'user_intervention' && (sender === 'user' || sender.endsWith(':user'));
  }

  private async clearConsumedUserInputState(): Promise<void> {
    this.pendingUserInput = null;
    this.db.deleteSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_INPUT);
    const gate = this.db.getSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_GATE);
    if (gate && typeof gate === 'object' && !Array.isArray(gate) && (gate as { kind?: unknown }).kind === 'ask_user') {
      this.db.deleteSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_GATE);
    }
  }

  private async clearSoftWaitingForUser(reason: string): Promise<boolean> {
    if (!this.waitingForUser) return false;
    if (this.hasExplicitUserGate()) {
      leaderLogger.debug(`[Leader] keep waiting_for_user during ${reason}: explicit user gate is active`);
      return false;
    }
    this.waitingForUser = false;
    await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
    return true;
  }

  private handleLeaderP0Message(data: EventMap['message:bus:priority']): void {
    this.getLeaderP0Handler().handle(data);
  }

  /** 懒构造 P0 处理器 — 事件订阅/优先级/时序全部下沉到子模块，行为不变 */
  private getLeaderP0Handler(): LeaderP0Handler {
    if (!this._leaderP0Handler) {
      this._leaderP0Handler = new LeaderP0Handler({
        sessionId: this.sessionId,
        leaderBusName: this.leaderBusName,
        emitter: this.emitter,
        permManager: this.permManager,
        // 主循环会用 .filter(...) 重新赋值该数组，必须走 getter 取活引用
        pendingAgentCompletionSignals: () => this.pendingAgentCompletionSignals,
        isEternalMode: () => this.isEternalMode(),
        isBusy: () => this.isBusy,
        waitingForUser: () => this.waitingForUser,
        setDelegateMode: (reason) => this.setDelegateMode(reason),
        clearSoftWaitingForUser: (reason) => this.clearSoftWaitingForUser(reason),
        interruptCurrentRound: (reason) => this.interruptCurrentRound(reason),
        setUserInterruptPending: (value) => { this.userInterruptPending = value; },
        stripSessionPrefix,
      });
    }
    return this._leaderP0Handler;
  }

  /**
   * Leader 主循环 - 完整复刻 Python 版本
   *
   * 单飞锁（P0 #2）：stop() 只置 finished=true 不会 await run() 退出，紧跟的 sendUserInput
   * 在 isRunning=false 后会再次 launchLeaderDetached，导致并发两份 run() 共享 conversation /
   * userMessageQueue / abortController，会出现：监听器双倍订阅、消息错位、conversation 交错。
   * 这里入口检测：若旧 run() 仍未 settle，直接复用其 Promise，外部仍能 await 同一结果。
   */
  private startRun(initialPrompt?: MessageContent, resume = false, recoveredTasks?: RecoveredTaskInfo[]): Promise<string> {
    const promise = this._runImpl(initialPrompt, resume, recoveredTasks);
    this.currentRunPromise = promise;
    // 无论 settle 成功/失败都要清理，否则下一次 run() 永远复用旧 Promise
    promise.finally(() => {
      if (this.currentRunPromise === promise) {
        this.currentRunPromise = null;
      }
    }).catch(() => { /* 防止 unhandled rejection；调用方仍会拿到原 promise 的 reject */ });
    return promise;
  }

  async run(initialPrompt?: MessageContent, resume = false, recoveredTasks?: RecoveredTaskInfo[]): Promise<string> {
    if (this.currentRunPromise) {
      if (this.finished) {
        if (!this.pendingRunRestartPromise) {
          const previousRun = this.currentRunPromise;
          leaderLogger.warn('[run] 上一次 run() 已被中断但仍在收尾，等待清理后重启 Leader');
          let queuedRestart: Promise<string>;
          queuedRestart = previousRun
            .catch((error) => {
              leaderLogger.warn(`[run] 被中断的上一轮在重启前结束为异常: ${error instanceof Error ? error.message : String(error)}`);
            })
            .then(() => {
              if (this.currentRunPromise === previousRun) {
                this.currentRunPromise = null;
              }
              return this.startRun(initialPrompt, resume, recoveredTasks);
            })
            .finally(() => {
              if (this.pendingRunRestartPromise === queuedRestart) {
                this.pendingRunRestartPromise = null;
              }
            });
          this.pendingRunRestartPromise = queuedRestart;
        } else {
          leaderLogger.warn('[run] Leader 重启已排队，复用排队重启 Promise');
        }
        return this.pendingRunRestartPromise;
      }
      leaderLogger.warn('[run] 上一次 run() 仍未结束，复用现有 Promise（避免并发主循环）');
      return this.currentRunPromise;
    }
    return this.startRun(initialPrompt, resume, recoveredTasks);
  }

  private async _runImpl(initialPrompt?: MessageContent, resume = false, recoveredTasks?: RecoveredTaskInfo[]): Promise<string> {
    this.finished = false;
    this.running = true;
    // 重置 abort controller，确保重启后的 LLM call 不会因旧的已 abort controller 立刻失败
    this.currentLlmAbortController = null;
    this.healthMonitor.start();

    // 段1: 事件订阅(bus/blackboard/orchestration/plugin/tools/roles)统一收口到 setupRunListeners,
    // 返回 unsubscribe 句柄数组,由 run 的 finally 块逐个退订。行为与原内联订阅完全一致。
    const runListenerUnsubs = this._runImpl_setupRunListeners();

    try {
      await this._runImpl_initializeSession(initialPrompt, resume, recoveredTasks);
  
      // 主循环
      let loopCount = 0;
      let pollCount = 0;

      // 启动 Watchdog 看门狗
      this.startWatchdog();
  
      while (!this.finished) {
        loopCount++;

      // 每轮重建段间共享的可变状态(段3 产出消息,段5 产出 completion 跟踪,段6 读取)。
      const frame: LeaderLoopFrame = {
        allMsgs: [],
        agentMsgs: [],
        consumedCompletionKeys: new Set<string>(),
        pendingReportsToInject: [],
      };

      const loopPollControl = await this._runImpl_loopPollAndStatus(frame, pollCount);
      if (loopPollControl !== 'next') {
        if (loopPollControl === 'break') break;
        continue;
      }

  
      this.clearUserInterruptPending();
  
      const userMsgControl = await this._runImpl_consumeUserMessages(frame);
      if (userMsgControl !== 'next') {
        if (userMsgControl === 'break') break;
        continue;
      }
  
      const agentReportControl = await this._runImpl_consumeAgentReports(frame);
      if (agentReportControl !== 'next') {
        if (agentReportControl === 'break') break;
        continue;
      }

  
      const dispatchControl = await this._runImpl_dispatchAndFinalize(frame, loopCount);
      if (dispatchControl !== 'next') {
        if (dispatchControl === 'break') break;
        continue;
      }
      }

      return 'Leader finished';
    } catch (err) {
      // A4: 主循环未预期异常(逃出每轮迭代 try/catch 的)——原 try/finally 无 catch,
      // 异常静默上抛且 leader 卡在 running=false/finished=false 的 limbo(不可重启、不可观测)。
      // 这里:置终态(finished=true 让 run() 重启路径可用)+ emit leader:error(SseBridge 已订阅,广播到 Web UI)+ 记日志,再上抛保调用方 reject 契约。
      const msg = err instanceof Error ? err.message : String(err);
      leaderLogger.error(`[Leader] 主循环未预期异常(session=${this.sessionId}): ${msg}`);
      this.finished = true;
      try {
        this.emitter.emit('leader:error', {
          sessionId: this.sessionId,
          error: { message: `Leader 主循环未预期异常: ${msg}`, name: 'LeaderRunError', errorKind: 'fatal' },
        });
      } catch { /* tolerate emit failure */ }
      throw err;
    } finally {
      // 段1 返回的 unsubscribe 句柄,逐个退订,顺序与原内联 finally 一致。
      for (const unsub of runListenerUnsubs) {
        try {
          unsub();
        } catch (err) {
          leaderLogger.warn(`[Leader] run listener unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.stopWatchdog();
      this._unsubscribeAgentActivityEvents();
      this.healthMonitor.stop();
      this.running = false;
    }
  }

  /**
   * 段1: _runImpl 启动时注册的事件订阅(bus/blackboard/orchestration/plugin/tools/roles)。
   *
   * 返回 unsubscribe 句柄数组,_runImpl 的 finally 块逐个退订。行为与原内联订阅完全一致 ——
   * 仅是物理搬运,无任何逻辑变更。顺序即退订顺序(bugHunt→crash→plugin→tools→roles→
   * orchestration run_state→orchestration event_rejected),与原 finally 一一对应。
   */
  private _runImpl_setupRunListeners(): Array<() => void> {
    // 监听 agent 紧急消息（P0 user_intervention），中断当前 LLM round
    // 参考介入机制：agent 通过 send_message 发送 help/error/flag 时，立即唤醒 Leader
    const busP0Unsub = this.emitter.subscribe('message:bus:priority', (data) => {
      this.handleLeaderP0Message(data);
    });

    // 监听 agent 崩溃事件
    //   不在这里 abort 当前 LLM：abort 会丢弃模型已生成的 partial 输出。
    //   实际 crash 路径会通过 AgentPool.markAgentFailed → bus 投递 task_failed
    //   → handleLeaderP0Message → mergeAgentCompletionSignal 进入 pending 队列，
    //   LeaderThinkingEngine 在每轮 LLM 结束后 break 即可。
    const crashUnsub = this.emitter.subscribe('agent:crashed', (data) => {
      if (this.isBusy) {
        leaderLogger.debug(`[Recovery] Agent @${data.name} ${data.status}，等待当前 LLM round 自然结束`);
      }
    });

    // 监听插件开关事件（BugHunt / Office / Workflow 模式切换）
    const pluginToggleUnsub = this.emitter.subscribe('plugin:toggled', (data) => {
      if (data.sessionId && data.sessionId !== this.sessionId) return;
      if (data.pluginId === 'bughunt') {
        this.executionController.setBugHuntMode(data.enabled);
        leaderLogger.info(`BugHunt mode ${data.enabled ? 'enabled' : 'disabled'}`);
      }
      if (data.pluginId === 'office') {
        this.executionController.setOfficeMode(data.enabled);
        leaderLogger.info(`Office mode ${data.enabled ? 'enabled' : 'disabled'}`);
      }
      if (data.pluginId === 'workflow') {
        this.executionController.setWorkflowMode(data.enabled);
        leaderLogger.info(`Workflow mode ${data.enabled ? 'enabled' : 'disabled'}`);
      }
    });

    // 监听用户工具变更事件（CRUD via /api/v1/tools）
    // Registry 已在 ToolsRoutes 内同步更新，这里仅做日志 + 失效缓存提示。
    // Leader 每轮都通过 toolRegistry.getDefinitions(toolNames) 取最新工具表，
    // 因此主进程 leader 的下一次 LLM round 自动看到新工具/失去被禁工具。
    const toolsChangedUnsub = this.emitter.subscribe('tools:changed', (data) => {
      const action = data?.action ?? 'unknown';
      const name = data?.name ?? 'unknown';
      leaderLogger.info(`[Tools] registry change: ${action} ${name}`);
    });

    // 监听 roles 配置变更（PATCH /api/v1/roles 触发）
    // 重新读 runtimeConfig.roles 并把内置角色的 tools 重新计算后写回 RoleRegistry。
    // 自定义角色（createdBy !== 'system'）保持不动；overrides 不影响它们。
    // 已经派出的 worker 仍持有旧 role tools 快照，新派 worker 立刻取到新值。
    const rolesChangedUnsub = this.emitter.subscribe('roles:changed', (data) => {
      try {
        refreshRuntimeConfig();
        this.reloadBuiltinRoles();
        leaderLogger.info(`[Roles] reloaded after action=${data.action}${data.name ? ` name=${data.name}` : ''}`);
      } catch (error) {
        leaderLogger.error(`[Roles] reload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    const orchestrationRunStateUnsub = this.emitter.subscribe('orchestration:run_state', (data) => {
      if (data.sessionId && data.sessionId !== this.sessionId) return;
      const isTerminal = isRunTerminalStatus(data.status);
      if (!data.bottleneck && !isTerminal) return;
      const parts = [`[Orchestration] status=${data.status} gen=${data.generation}`];
      parts.push(`nodes=${data.completedNodes}/${data.totalNodes}`);
      if (data.failedNodes) parts.push(`failed=${data.failedNodes}`);
      if (data.blockedNodes) parts.push(`blocked=${data.blockedNodes}`);
      if (data.bottleneck) parts.push(`bottleneck=${data.bottleneck}`);
      if (data.summary) parts.push(`summary=${data.summary}`);
      this.addMessage({ role: 'system', content: parts.join(' ') });
    });

    const orchestrationRejectUnsub = this.emitter.subscribe('orchestration:event_rejected', (data) => {
      if (data.sessionId && data.sessionId !== this.sessionId) return;
      this.addMessage({
        role: 'system',
        content: `[Orchestration] event_rejected eventType=${data.eventType} eventId=${data.eventId} reason=${data.reason ?? 'unknown'}`,
      });
    });

    return [
      busP0Unsub,
      crashUnsub,
      pluginToggleUnsub,
      toolsChangedUnsub,
      rolesChangedUnsub,
      orchestrationRunStateUnsub,
      orchestrationRejectUnsub,
    ];
  }

  /**
   * 段2: 会话恢复 + 消息回放 + 首轮系统提示。
   *
   * resume 分支:从 db 回放 conversation,恢复 leader 运行态(waitingForUser/pendingReview/
   * planApproved/executionMode/customRoles/pendingPermission 等),重置 recoveredTasks 为可
   * 重新派发。新会话分支:注入 system prompt + dynamic context,把 initialPrompt 锚定为
   * originalGoal(防漂移),首轮 leaderThinkAndAct。
   *
   * 纯物理搬运自原 _runImpl 的 try 块开头,行为零变更。
   */
  private async _runImpl_initializeSession(
    initialPrompt: MessageContent | undefined,
    resume: boolean,
    recoveredTasks: RecoveredTaskInfo[] | undefined,
  ): Promise<void> {
      if (resume) {
      this.conversation = this.db.getConversationMessages(this.sessionId) as ChatMessage[];

      // 治标层：自愈历史里的「中断孤儿」——assistant 发起 tool_call 但 tool result 因进程
      // 在工具执行中途崩溃/被杀而永久缺失（assistant 已落库、result 未落库）。补明确语义
      // 占位并事务重写，从此该段历史自洽，provider 边界 sanitizer 不再每次反复合成
      // [tool result missing]。与治本层（LeaderToolDispatch 原子批写）互补：
      // 治本杜绝新裂缝、治标一次性自愈既有脏历史。
      const { healed, addedCount } = healInterruptedToolCalls(this.conversation);
      if (addedCount > 0) {
        leaderLogger.warn(`[ResumeHeal] 检测到 ${addedCount} 个中断孤儿 tool_call（缺配对 tool result），补占位并重写 leader_conversation`);
        this.conversation = resequenceTimestampsForPersistence(healed);
        this.db.replaceConversation(this.sessionId, this.conversation as ConversationMessage[]);
      }

      // 治本 R1：resume 从 append-only DB 重建会带回历史多条 manifest/黑板分析残留，
      // 一次性收敛成每槽一条（manifest 是状态镜像，最新值即权威，旧条无信息价值）。
      this.collapseLeaderSystemSlots();

      if (initialPrompt) {
        const newMsg: ChatMessage = {
          role: 'user',
          content: initialPrompt,
        };
        this.addMessage(newMsg);
        this.db.saveConversationMessage(this.sessionId, newMsg);
      }

      if (this.conversation.length === 0) {
        this.conversation = [{
          role: 'system',
          content: this.getSystemPrompt(),
        }];
        // 统一 Context Manifest 动态上下文作为独立 system 消息
        const dynCtx = this.getDynamicContext();
        if (dynCtx) {
          // leader_init 槽 in-place 注入（带 slot 标记），单槽不堆积。
          this.upsertRuntimeSystemSlot({ kind: 'manifestSlot', slot: 'leader_init' }, dynCtx);
        }
        if (initialPrompt) {
          this.addMessage({
            role: 'user',
            content: initialPrompt,
          });
        }
        for (const message of this.conversation) {
          this.db.saveConversationMessage(this.sessionId, message);
        }
      }

      const state = await this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER);
      this.waitingForUser = state === 'true';
      this.loadPermissionContextFromState();

      const pendingReview = await this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_PENDING_REVIEW);
      this.pendingReview = pendingReview === 'true';

      const planApproved = await this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_PLAN_APPROVED);
      this.planApproved = planApproved === 'true';
      const scratchpadDigest = await this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_LAST_SCRATCHPAD_REVIEW_DIGEST);
      this.lastScratchpadReviewDigest = typeof scratchpadDigest === 'string' ? scratchpadDigest : null;
      const executionMode = await this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_EXECUTION_MODE);
      const executionReason = await this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_EXECUTION_REASON);
      if (typeof executionMode === 'string' && (executionMode === 'direct' || executionMode === 'hybrid' || executionMode === 'delegate')) {
        this.executionMode = executionMode;
      }
      if (typeof executionReason === 'string' && executionReason.trim()) {
        this.executionReason = executionReason;
      }
      const pendingPermission = await this.db.getSessionState(this.sessionId, SESSION_KEYS.PENDING_PERMISSION_REQUEST);
      if (pendingPermission && typeof pendingPermission === 'object') {
        this.permManager.pendingPermissionRequest = pendingPermission as PermissionRequestPayload;
      }
      if (this.waitingForUser) {
        const pendingInput = await this.db.getSessionState(this.sessionId, SESSION_KEYS.PENDING_USER_INPUT);
        if (pendingInput) {
          this.pendingUserInput = pendingInput as MessageContent;
        }
      }

      const customRoles = this.db.getSessionState(this.sessionId, SESSION_KEYS.CUSTOM_ROLES);
      if (customRoles && typeof customRoles === 'object') {
        this.roleRegistry.loadFromDict(customRoles as Record<string, AgentRole>);
      } else if (typeof customRoles === 'string') {
        try {
          this.roleRegistry.loadFromDict(JSON.parse(customRoles) as Record<string, AgentRole>);
        } catch (error) {
          leaderLogger.error(`恢复自定义角色失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (this.pendingReview) {
        const pendingPlan = this.db.getSessionState(this.sessionId, SESSION_KEYS.PENDING_PLAN);
        if (pendingPlan) {
          this.emitter.emit('plan:submitted', {
            sessionId: this.sessionId,
            plan: pendingPlan,
          });
        }
      }

      if (recoveredTasks && recoveredTasks.length > 0) {
        // 重置被中断任务为 pending，准备重新 dispatch
        for (const recoveredTask of recoveredTasks) {
          const task = this.board.getTask(recoveredTask.id);
          if (!task) continue;
          this.board.prepareTaskForRedispatch(task.id, '会话中断后恢复');
        }

        // 仅作为本次运行的上下文注入，不写入会话历史，避免污染真实对话记录
        const taskList = recoveredTasks.map(t => `- [${t.id}] ${t.subject}`).join('\n');
        const resumeMsg: ChatMessage = {
          role: 'system',
          content: [
            `[系统] 检测到 ${recoveredTasks.length} 个在中断前未完成的任务，已重置为可重新派发状态：`,
            taskList,
            '',
            '请结合用户当前消息与 task board 状态决定下一步；面向用户时直接给出当前可执行结论。',
          ].join('\n'),
        };
        this.addMessage(resumeMsg);
      }

      await this.tracker.loadHistory(this.sessionId);

      if (resume && this.board.allTerminal() && this.pool.getRunning().length === 0) {
        leaderLogger.info('恢复已完成会话，等待用户输入新指令');
        this.waitingForUser = true;
        this.emitter.emit('leader:status', {
          sessionId: this.sessionId,
          status: 'Idle (已完成，等待新指令)',
        });
        this.emitter.emit('leader:busy', {
          sessionId: this.sessionId,
          isBusy: false,
          queueLength: 0,
        });
      }
      } else {
      this.conversation = [];
      this.loadPermissionContextFromState();
      this.setExecutionRoute({
        mode: 'direct',
        reason: '新会话默认先由 Leader 直接理解并处理用户请求。',
      });
      this.addMessage({
        role: 'system',
        content: this.getSystemPrompt(),
      });
      // 统一 Context Manifest 动态上下文作为独立 system 消息
      const dynamicCtx = this.getDynamicContext();
      if (dynamicCtx) {
        // leader_init 槽 in-place 注入（带 slot 标记），单槽不堆积。
        this.upsertRuntimeSystemSlot({ kind: 'manifestSlot', slot: 'leader_init' }, dynamicCtx);
      }

      if (initialPrompt) {
        // 防漂移:捕获原始用户任务文本,供每轮「当前使命」锚点置顶(见 getDynamicContext)。
        const goalText = typeof initialPrompt === 'string'
          ? initialPrompt
          : contentToPlainText(initialPrompt);
        this.originalGoal = goalText?.trim() ? goalText.trim().slice(0, 500) : null;
        this.beginUserTurn();
        // Orchestration 不再在用户消息进来时自动启动；Leader 在 leaderThinkAndAct 中
        // 通过任务图与节点元数据自行决定是否进入统一编排内核。
        this.setExecutionRoute(this.chooseExecutionRoute(null));
        const teamHint = this.getTeamModeHint();
        if (teamHint) {
          this.addMessage({ role: 'system', content: teamHint });
        }
        this.addMessage({
          role: 'user',
          content: this.buildInitialUserContent(initialPrompt),
        });
      }

      for (const message of this.conversation) {
        this.db.saveConversationMessage(this.sessionId, message);
      }

      if (initialPrompt) {
        this.emitter.emit('leader:status', {
          sessionId: this.sessionId,
          status: 'Thinking...',
        });
        try {
          if (!this.fileChangesApi) {
            const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
            const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
            this.fileChangesApi = new FileChangesApi(new DatabaseRepositoryAdapter(this.db));
          }
          const preview = typeof initialPrompt === 'string' ? initialPrompt.slice(0, 60) : '[task]';
          await this.fileChangesApi.createSnapshot(this.sessionId, `[turn:${this.turnCount}] Turn ${this.turnCount}: ${preview}`);
        } catch { /* non-critical */ }
        try {
          await this.leaderThinkAndAct();
        } catch (err) {
          leaderLogger.error('leaderThinkAndAct failed:', err);
          this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
        } finally {
          this.emitRoundComplete('initial_prompt');
        }
      }
    }
  }


  /**
   * 段3: 主循环顶部 —— 运行中 agent 状态显示 + 消息轮询 + 用户消息入队 + 超时唤醒/抢占。
   *
   * 行为与原 _runImpl 内联段完全一致。写入 frame.allMsgs / frame.agentMsgs 供后续段读取。
   * 原段内 maybeDriveOpenWork 后的 continue 改为 return 'continue',由 _runImpl 解释。
   */
  private async _runImpl_loopPollAndStatus(frame: LeaderLoopFrame, pollCount: number): Promise<LeaderLoopControl> {
    // 混合唤醒：事件驱动 (即时) + 超时巡检 (30s)
    const runningAgents = this.pool.getRunning();
  
    if (this.pendingReview) {
      // 等待用户审批方案，不发送状态更新
    } else if (runningAgents.length > 0) {
      // 有 Agent 正在运行，显示运行中的 Agent 信息
      const agentNames = runningAgents.map(a => a.name);
      let statusMsg: string;
      if (agentNames.length === 1) {
        statusMsg = `⏳ ${agentNames[0]} 工作中...`;
      } else {
        statusMsg = `⏳ ${agentNames.length} 个 Agent 工作中：${agentNames.slice(0, 3).join(', ')}${agentNames.length > 3 ? '...' : ''}`;
      }
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: statusMsg,
        pollCount,
        runningAgents: agentNames,
      });
    }
  
    let waitTimeoutMs = 30000;
    if (this.waitingForUser) {
      waitTimeoutMs = 60000;
    } else if (runningAgents.length > 0) {
      waitTimeoutMs = this.getLeaderSupervisionWaitTimeoutMs(runningAgents);
    }

    // allMsgs 由 frame.allMsgs 承载(段间共享)

    // 统一消息轮询：让 P0 agent 消息（task_complete/task_failed）与 user 消息同轮处理。
    //
    // 历史实现里，userMessageQueue 非空时连 poll 都跳过，导致 worker 在该轮发出的
    // task_complete 要等下一轮才被捕获，造成 "leader 被叫醒只 check 不反馈" 的滞后假象。
    //
    // 现行：
    // - userQueue 已有积压且不在评审：跳过 race-wait（避免给已排队的用户消息多加 30s 延迟），
    //   但仍 poll 一次，确保已到达 bus 的 agent 消息被同轮拉走。
    // - 其余情况：race-wait（关键消息即时唤醒 / 常规消息阻塞等待）后再 poll。
    const skipWait = this.userMessageQueue.length > 0 && !this.pendingReview;
    if (!skipWait) {
      const criticalPromise = this.bus.waitForCriticalMessage(this.leaderBusName, waitTimeoutMs);
      const regularPromise = this.bus.waitForMessage(this.leaderBusName, waitTimeoutMs);
      await Promise.race([criticalPromise, regularPromise]);
    }
    frame.allMsgs = await this.bus.poll(this.leaderBusName);

    const userMsgs = frame.allMsgs.filter(m => this.isUserInterventionMessage(m));
    frame.agentMsgs = frame.allMsgs.filter(m => !this.isUserInterventionMessage(m));

    // 新到的用户消息全部入队，延迟判断是否立即处理还是排队
    if (userMsgs.length > 0) {
      for (const um of userMsgs) {
        this.userMessageQueue.push(um);
      }
      // 如果队列中有超过一条消息（意味着某些消息必须排队等待），通知 TUI
      if (this.userMessageQueue.length > 1) {
        this.emitter.emit('leader:message_queued', {
          sessionId: this.sessionId,
          queueLength: this.userMessageQueue.length,
        });
        leaderLogger.debug(`用户消息入队，队列长度: ${this.userMessageQueue.length}`);
      }
    }

    // 只有当确实有消息需要处理时才显示 Processing 状态
    // 超时唤醒（无消息）时应保持/恢复等待状态
    if (frame.allMsgs.length > 0) {
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: '处理新事件...',
      });
    } else if (!this.pendingReview && this.pool.getRunning().length === 0) {
      const preemptiveUserMsgs = this.bus
        .pollByType(this.leaderBusName, ['user_intervention'])
        .filter(m => this.isUserInterventionMessage(m));
      if (preemptiveUserMsgs.length > 0) {
        this.userMessageQueue.push(...preemptiveUserMsgs);
        this.emitter.emit('leader:status', {
          sessionId: this.sessionId,
          status: t('leader.status.processing_user_input'),
        });
      } else {
        const recoverySummary = this.getRecoveryStatusSummary();
        if (await this.maybeDriveOpenWork()) {
          if (!this.waitingForUser) {
            return 'continue';
          }
        }
        // 自动唤醒条件收紧：仅当真有 running agent 或 dispatchable/running 任务时才主动 LLM。
        // 老逻辑用 !this.board.allTerminal() — 把"还有终态以外的任务"都算作要推进，
        // 导致空闲会话在每次 30s 巡检都 ping 一次 LLM。
        //
        // 控制模式守卫：inline 自驱与 maybeDriveOpenWork 同属"自治找活"，只在 eternal
        // 下允许。manual / 默认模式即便有未完成任务，也只回到等待状态，由 worker 汇报
        // 或用户消息驱动 —— 关掉 eternal 后绝不残留无限自驱。
        const hasOpenWork = this.hasPendingTasks() || this.hasRunningAgents();
        if (this.isEternalMode() && !this.waitingForUser && hasOpenWork) {
          leaderLogger.info('[Leader] maybeDriveOpenWork 已耗尽，主动触发 leaderThinkAndAct');
          await this.leaderThinkAndAct();
        } else if (this.isEternalMode() && !this.waitingForUser) {
          // Eternal 模式有 goal 但 hasOpenWork=false 时，走 patrol 让 LLM 规划下一步
          const patrolled = await this.progressInvariant.maybeEternalIdlePatrol();
          if (!patrolled) {
            this.emitter.emit('leader:status', {
              sessionId: this.sessionId,
              status: getPromptCatalog().leader.eternalGoal.statusStandby,
            });
          }
        } else {
          // 超时唤醒且无消息、无运行中 Agent → 回到等待状态
          this.emitter.emit('leader:status', {
            sessionId: this.sessionId,
            status: '等待用户输入...',
          });
          this.emitter.emit('leader:busy', {
            sessionId: this.sessionId,
            isBusy: false,
            queueLength: 0,
          });
        }
      }
    }
    return 'next';
  }

  /**
   * 段4: 用户消息消费 + permission 解决 + COMPACT + 评审批准/拒绝 + waitingForUser 门控。
   * 行为与原内联段一致。原段内 continue 改为 return 'continue';评审内层 for-break 保持不变。
   */
  private async _runImpl_consumeUserMessages(frame: LeaderLoopFrame): Promise<LeaderLoopControl> {
    // 1. 优先处理用户介入 / 回复（从队列取消息，FIFO）
    // 条件收紧：仅 pendingAgentCompletionSignals（task_complete/task_failed）优先级极高，
    // 必须抢在用户消息之前处理以维持任务状态一致性。frame.agentMsgs（report/finding 等一般消息）
    // 不再阻塞用户消息，避免"有 worker 持续汇报时用户输入无限排队"。
    if (this.userMessageQueue.length > 0 && !this.pendingReview && this.pendingAgentCompletionSignals.length === 0) {
      // Eternal silence lock 必须在处理用户消息前主动解锁，
      // 否则刚收到的用户输入会被 fingerprint 锁挡掉一轮 patrol。
      this.progressInvariant.invalidateEternalSilenceLock?.('user_message');
      const msg = this.userMessageQueue.shift()!;
      // 通知 TUI 队列长度更新
      if (this.userMessageQueue.length > 0) {
        this.emitter.emit('leader:message_dequeued', {
          sessionId: this.sessionId,
          queueLength: this.userMessageQueue.length,
        });
      }
      const content = contentToPlainText(msg.payload as MessageContent);

      if (this.waitingForUser) {
        leaderLogger.info(`收到用户介入消息，立即处理: ${content.substring(0, 50)}...`);
        this.waitingForUser = false;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
        await this.clearConsumedUserInputState();
        const msgContentInner = (msg.payload as MessageContent) ?? '';
        this.beginUserTurn();
        // Orchestration 触发改由 Leader 在编排内核里通过任务图节点决定
        this.setExecutionRoute(this.chooseExecutionRoute(null));
        const teamHintInner = this.getTeamModeHint();
        if (teamHintInner) {
          this.addMessage({ role: 'system', content: teamHintInner });
        }
        this.addMessage({ role: 'user', content: msgContentInner });
        await this.db.saveConversationMessage(this.sessionId, {
          role: 'user',
          content: msgContentInner,
        });
        try {
          if (!this.fileChangesApi) {
            const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
            const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
            this.fileChangesApi = new FileChangesApi(new DatabaseRepositoryAdapter(this.db));
          }
          const preview = typeof msgContentInner === 'string' ? msgContentInner.slice(0, 60) : '[message]';
          await this.fileChangesApi.createSnapshot(this.sessionId, `[turn:${this.turnCount}] Turn ${this.turnCount}: ${preview}`);
        } catch { /* non-critical */ }
        try {
          await this.leaderThinkAndAct();
        } catch (err) {
          leaderLogger.error('leaderThinkAndAct failed:', err);
          this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
        } finally {
          this.emitRoundComplete('user_intervention');
        }
        if (this.waitingForUser) {
          return 'continue';
        }
        return 'continue';
      }

      const permissionResolution = this.resolvePendingPermissionFromUserInput(content);
      if (permissionResolution === 'resolved') {
        this.waitingForUser = false;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
        return 'continue';
      }
      if (permissionResolution === 'pending') {
        return 'continue';
      }
  
      // 检查是否是 COMPACT 指令
      if (content.toUpperCase() === 'COMPACT') {
        leaderLogger.info('收到 COMPACT 指令，执行手动压缩');
        await this.compactContext();
        return 'continue';
      }
  
      leaderLogger.debug(`收到用户消息 (介入/回复): ${content.substring(0, 50)}...`);
      this.waitingForUser = false;
      await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
      await this.clearConsumedUserInputState();
      const msgContent = (msg.payload as MessageContent) ?? '';
      this.beginUserTurn();
      // Orchestration 触发改由 Leader 在编排内核里通过任务图节点决定
      this.setExecutionRoute(this.chooseExecutionRoute(null));
      const teamHint = this.getTeamModeHint();
      if (teamHint) {
        this.addMessage({ role: 'system', content: teamHint });
      }
      this.addMessage({ role: 'user', content: msgContent });
      await this.db.saveConversationMessage(this.sessionId, { role: 'user', content: msgContent });
      try {
        if (!this.fileChangesApi) {
          const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
          const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
          this.fileChangesApi = new FileChangesApi(new DatabaseRepositoryAdapter(this.db));
        }
        const preview = typeof msgContent === 'string' ? msgContent.slice(0, 60) : '[message]';
        await this.fileChangesApi.createSnapshot(this.sessionId, `[turn:${this.turnCount}] Turn ${this.turnCount}: ${preview}`);
      } catch { /* non-critical */ }
      try {
        await this.leaderThinkAndAct();
      } catch (err) {
        leaderLogger.error('leaderThinkAndAct failed:', err);
        this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
      } finally {
        this.emitRoundComplete('user_message');
      }
      if (this.waitingForUser) {
        return 'continue';
      }
      return 'continue';
    }
  
    const hasCompletionToProcess =
      this.pendingAgentCompletionSignals.length > 0 ||
      frame.agentMsgs.some((msg) => {
        const controlMessage = readAgentControlMessage(msg);
        return controlMessage?.kind === 'task_complete' || controlMessage?.kind === 'task_failed';
      });

    // 2. 检查评审状态
    if (this.pendingReview && !hasCompletionToProcess) {
      // 从队列取一条评审消息
      const reviewMsg = this.userMessageQueue.shift();
      if (!reviewMsg) {
        return 'continue';
      }
      // 通知 TUI 队列长度更新
      if (this.userMessageQueue.length > 0) {
        this.emitter.emit('leader:message_dequeued', {
          sessionId: this.sessionId,
          queueLength: this.userMessageQueue.length,
        });
      }
      const reviewMsgsForLoop = [reviewMsg];
      for (const msg of reviewMsgsForLoop) {
        const content = contentToPlainText(msg.payload as MessageContent);
        const normalized = content.trim().toLowerCase();
        if (
          normalized === '/approve'
        ) {
          leaderLogger.info('用户批准方案，继续执行');
          this.pendingReview = false;
          await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_PENDING_REVIEW, 'false');
          this.planApproved = true;
          await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_PLAN_APPROVED, 'true');
          this.emitter.emit('leader:plan_approved', { sessionId: this.sessionId });
          // 发送通知
          this.emitter.emit('notification:new', {
            sessionId: this.sessionId,
            id: `plan_approved_${this.sessionId}_${Date.now()}`,
            type: 'plan_approved',
            priority: 'important',
            title: '方案已批准',
            message: '用户已批准执行方案，团队开始执行任务',
            timestamp: Date.now(),
            read: false,
          });
          await this.db.setSessionState(this.sessionId, 'running', 'approved');
  
          this.addMessage({
            role: 'user',
            content: '用户已批准方案，请开始执行。',
          });
          await this.db.saveConversationMessage(this.sessionId, {
            role: 'user',
            content: '用户已批准方案，请开始执行。',
          });
          try {
            await this.leaderThinkAndAct();
          } catch (err) {
            leaderLogger.error('leaderThinkAndAct failed:', err);
            this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
          } finally {
            this.emitRoundComplete('plan_approved');
          }
        } else {
          leaderLogger.info(`收到用户评审意见：${content}`);
          this.pendingReview = false;
          await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_PENDING_REVIEW, 'false');
          this.emitter.emit('leader:plan_rejected', { sessionId: this.sessionId, feedback: content });
  
          this.addMessage({
            role: 'user',
            content: `[评审意见]: ${content}\n请根据意见调整方案。`,
          });
          await this.db.saveConversationMessage(this.sessionId, {
            role: 'user',
            content: `[评审意见]: ${content}`,
          });
          try {
            await this.leaderThinkAndAct();
          } catch (err) {
            leaderLogger.error('leaderThinkAndAct failed:', err);
            this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
          } finally {
            this.emitRoundComplete('plan_rejected');
          }
        }
        break; // 每次只处理一条评审消息
      }
  
      if (this.pendingReview) {
        return 'continue';
      }
    }

    // 清除 waitingForUser 只应在有实质性工作要推进时
    // LLM 刚回复完设置的 waitingForUser 不应被清除，应等待用户输入
    // 先调和恢复中的任务（将 recovering task 重置为 pending），再检查是否有可派发工作
    this.reconcileRecoveringTasks();
    if (this.waitingForUser && !this.hasExplicitUserGate() && !this.board.allTerminal()) {
      // 只有当有待派发任务且之前是因为 agent 事件被打断等待状态时，才恢复推进。
      // 但：若这批 dispatchable 任务 Leader 上一轮已经"看过并决定等待"（指纹未变），
      // 就不要把它从 waitingForUser 里拽回来 —— 否则非 eternal 模式下只要存在一个
      // Leader 有意不派发的 dispatchable 任务，主循环就会每轮 un-latch → think →
      // 重新 latch → 再 un-latch，表现为无限请求 LLM。集合变化才重新驱动一次。
      const dispatchable = this.board.getDispatchable();
      const dispatchableSig = dispatchable.map(t => t.id).sort().join(',');
      const hasRecoverableWork = dispatchable.length > 0;

      if (hasRecoverableWork && dispatchableSig !== this.waitedDispatchableSig) {
        this.waitingForUser = false;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
      }
    }

    if (this.waitingForUser && frame.agentMsgs.length === 0 && this.pendingAgentCompletionSignals.length === 0) {
      return 'continue';
    }
    return 'next';
  }

  /**
   * 段5: agent 消息消费 + worker completion signal 注入 + dispatch directive。
   * 行为与原内联段一致。产出 frame.consumedCompletionKeys / frame.pendingReportsToInject 供段6 读取。
   * 段内 while-level continue/break 改为返回控制指令;for-内层 continue 保持。
   */
  private async _runImpl_consumeAgentReports(frame: LeaderLoopFrame): Promise<LeaderLoopControl> {
    // 3. 批量处理各 Agent 的报告 / 消息
    let combinedAgentReport = '';
    // 是否含 actionable 事件（任务终态 / 权限请求 / 健康严重 / worker 求助 help|error|flag）。
    // 仅 actionable 才起一轮 leaderThinkAndAct；纯进展（report/finding）只并入上下文，
    // 不为每条 worker 汇报单独 ping LLM —— 否则 Leader"只是监控等待"也会被刷起 think。
    // 分类规则集中在 isActionableAgentBusMessage（AgentProtocol），此处只做聚合。
    let hasActionableAgentReport = frame.agentMsgs.some(m => isActionableAgentBusMessage(m));
    frame.consumedCompletionKeys = new Set<string>();
    const completionKey = (signal: {
      agentName?: string;
      taskId: string;
      taskRunGeneration?: number;
      exitReason: 'completed' | 'failed';
    }) => `${signal.agentName ?? ''}\u0000${signal.taskId}\u0000${signal.taskRunGeneration ?? 'legacy'}\u0000${signal.exitReason}`;
    // 本轮刚落终态的任务（completed/failed）。用于在 reportMsg 里把它们锚定为
    // terminal —— 防止 Leader 把刚完成的任务幻觉成"还在跑 / 刚起步"。
    const justTerminatedTasks: Array<{ taskId: string; exitReason: 'completed' | 'failed' }> = [];
    let combinedRecoveryReport = '';
    for (const msg of frame.agentMsgs) {
      const content = contentToPlainText(msg.payload as MessageContent);
      const controlMessage = readAgentControlMessage(msg);

      if (msg.type === 'eternal_goal_set') {
        const payload = msg.payload as { goal?: unknown };
        const goal = typeof payload.goal === 'string' ? payload.goal.trim() : contentToPlainText(msg.payload).trim();
        combinedAgentReport += [
          '',
          '--- Eternal Goal 已设置/更新（系统事件）---',
          `goal: ${goal || '(empty)'}`,
          '这是 Goal Mode 的启动/变更事件，不是普通进展汇报。',
          '请立即围绕该 goal 判断下一步：需要规划就 plan/create_task，需要实现就直接改或派发，需要验证就运行测试；不要只回复“已保存”。',
          '后续所有自主行动都必须优先服务这个 goal，直到 complete_eternal_goal、pause 或 clear。',
        ].join('\n') + '\n';
        continue;
      }

      if (controlMessage?.kind === 'permission_request') {
        const payload = controlMessage;
        // 注册到 PermManager 的 pendingWorkerRequests，确保后续 permission_response
        // 能精确回到对应 worker（即便 LLM 后续介入修改也能反查）。
        const enriched = {
          ...payload,
          workerName: payload.workerName || stripSessionPrefix(this.sessionId, msg.from),
        };

        // 直接由 PermManager 触发用户审批弹窗（或 eternal 自动放行），
        // 不再依赖 Leader LLM 主动调 request_permission_update——
        // 后者在 LLM 走神 / 上下文阻塞时会让 worker 卡死等不到响应。
        // Leader LLM 仍然会从 combinedAgentReport 看到这次审批事件，可在响应里向用户解释。
        const directOutcome = this.permManager.receiveWorkerPermissionRequest(enriched, this.isEternalMode());
        this.setDelegateMode(`收到来自 @${msg.from} 的权限请求，已直送用户审批。`);
        combinedAgentReport += `\n--- 来自 Agent @${msg.from} 的权限请求（已直送用户）---\n` +
          `tool: ${payload.toolName}\n` +
          `reason: ${payload.reason}\n` +
          `worker_name: ${enriched.workerName}\n` +
          `request_id: ${payload.requestId}\n` +
          `outcome: ${directOutcome.split('\n')[0]}\n` +
          '系统已自动向用户发起审批，无需再调 request_permission_update。\n' +
          '可向用户简要说明 worker 为何需要该权限，或继续调度其他可推进的任务。\n';
        continue;
      }

      if (controlMessage?.kind === 'agent_health_critical') {
        const stall = typeof controlMessage.stallSeconds === 'number'
          ? `, stall=${controlMessage.stallSeconds}s`
          : '';
        combinedAgentReport += [
          '',
          `--- Agent @${controlMessage.agentName} 健康严重事件 ---`,
          `task: ${controlMessage.taskId}`,
          `status: ${controlMessage.status}`,
          `action: ${controlMessage.action}${stall}`,
          `reason: ${controlMessage.reason}`,
          '请立即根据 recovery record / task board 决定重派、接管、取消或向用户升级。',
        ].join('\n') + '\n';
        continue;
      }

      if (controlMessage?.kind === 'worker_recovery') {
        combinedRecoveryReport += `\n${formatWorkerRecoveryPayload(controlMessage)}\n`;
        continue;
      }

      if (controlMessage?.kind === 'task_complete' || controlMessage?.kind === 'task_failed') {
        const exitReason = controlMessage.kind === 'task_complete' ? 'completed' : 'failed';
        const taskId = controlMessage.taskId;
        const result = controlMessage.kind === 'task_complete'
          ? controlMessage.result
          : controlMessage.error;

        try {
          await this.acceptWorkerTaskResult({
            taskId,
            taskRunGeneration: controlMessage.taskRunGeneration,
            status: 'terminal',
            exitReason,
            result,
            agentName: msg.from,
            summary: controlMessage.kind === 'task_complete' ? controlMessage.summary : undefined,
            verdict: controlMessage.kind === 'task_complete' ? controlMessage.verdict : undefined,
            artifacts: controlMessage.kind === 'task_complete' ? controlMessage.artifacts : undefined,
            verification: controlMessage.kind === 'task_complete' ? controlMessage.verification : undefined,
            evidence_refs: controlMessage.kind === 'task_complete' ? controlMessage.evidence_refs : undefined,
            contract_compliance: controlMessage.kind === 'task_complete' ? controlMessage.contract_compliance : undefined,
            next_steps: controlMessage.kind === 'task_complete' ? controlMessage.next_steps : undefined,
            blocked_by_discovery: controlMessage.kind === 'task_complete' ? controlMessage.blocked_by_discovery : undefined,
            needs_leader_coordination: controlMessage.kind === 'task_complete' ? controlMessage.needs_leader_coordination : undefined,
            toolTrace: controlMessage.kind === 'task_complete' ? controlMessage.toolTrace : undefined,
          });
        } catch (err) {
          leaderLogger.error(`[Leader] acceptWorkerTaskResult 异常 (task=${taskId}): ${err instanceof Error ? err.message : String(err)}`);
        }
        // Drain the matching signal from the completion queue
        this.pendingAgentCompletionSignals = this.pendingAgentCompletionSignals.filter(
          s => completionKey(s) !== completionKey({
            agentName: msg.from,
            taskId,
            taskRunGeneration: controlMessage.taskRunGeneration,
            exitReason,
          })
        );
        frame.consumedCompletionKeys.add(completionKey({
          agentName: msg.from,
          taskId,
          taskRunGeneration: controlMessage.taskRunGeneration,
          exitReason,
        }));
        justTerminatedTasks.push({ taskId, exitReason });
        leaderLogger.info(`Agent @${msg.from} 报告任务 ${taskId} ${exitReason}`);
        // 强注入统一 Cross-Agent Artifact Awareness，合并 attempt_completion 与框架 toolTrace。
        const digest = formatWorkerCompletion(
          {
            result,
            summary: controlMessage.kind === 'task_complete' ? controlMessage.summary : undefined,
            artifacts: controlMessage.kind === 'task_complete' ? controlMessage.artifacts : undefined,
            verification: controlMessage.kind === 'task_complete' ? controlMessage.verification : undefined,
            evidence_refs: controlMessage.kind === 'task_complete' ? controlMessage.evidence_refs : undefined,
            contract_compliance: controlMessage.kind === 'task_complete' ? controlMessage.contract_compliance : undefined,
            next_steps: controlMessage.kind === 'task_complete' ? controlMessage.next_steps : undefined,
            blocked_by_discovery: controlMessage.kind === 'task_complete' ? controlMessage.blocked_by_discovery : undefined,
            needs_leader_coordination: controlMessage.kind === 'task_complete' ? controlMessage.needs_leader_coordination : undefined,
            toolTrace: controlMessage.kind === 'task_complete' ? controlMessage.toolTrace : undefined,
          },
          { agentName: msg.from ?? 'unknown', taskId, exitReason },
        );
        combinedAgentReport += `\n${digest.block}\n`;
      } else {
        // 区分 actionable 求助 vs 纯进展汇报（分类见 isActionableAgentBusMessage）：
        // - worker 的 help/error/flag 走 bus type='user_intervention'（sender 是 worker 不是 user，
        //   故没被 isUserInterventionMessage 归为用户介入）→ 需要 Leader 处理，actionable。
        // - report/finding 走 bus type='message' → 纯进展，只并入上下文，不单独起一轮 think。
        const isWorkerEscalation = msg.type === 'user_intervention';
        leaderLogger.debug(`收到 Agent @${msg.from} 的${isWorkerEscalation ? '求助' : '普通'}消息`);
        combinedAgentReport += `\n--- 来自 Agent @${msg.from} 的消息 ---\n${content}\n`;
      }
    }

    frame.pendingReportsToInject = this.pendingAgentCompletionSignals.filter((signal) => {
      if (!signal.result) return false;
      return !frame.consumedCompletionKeys.has(completionKey(signal));
    });
    for (const signal of frame.pendingReportsToInject) {
      try {
        await this.acceptWorkerTaskResult({
          taskId: signal.taskId,
          taskRunGeneration: signal.taskRunGeneration,
          status: 'terminal',
          exitReason: signal.exitReason,
          result: signal.result || '',
          agentName: signal.agentName,
          summary: signal.summary,
          verdict: signal.verdict,
          artifacts: signal.artifacts,
          verification: signal.verification,
          evidence_refs: signal.evidence_refs,
          contract_compliance: signal.contract_compliance,
          next_steps: signal.next_steps,
          blocked_by_discovery: signal.blocked_by_discovery,
          needs_leader_coordination: signal.needs_leader_coordination,
          toolTrace: signal.toolTrace,
        });
      } catch (err) {
        leaderLogger.error(`[Leader] acceptWorkerTaskResult 异常 (pending task=${signal.taskId}): ${err instanceof Error ? err.message : String(err)}`);
      }
      leaderLogger.info(`Agent @${signal.agentName} pending report injected for task ${signal.taskId} ${signal.exitReason}`);
      hasActionableAgentReport = true;
      justTerminatedTasks.push({ taskId: signal.taskId, exitReason: signal.exitReason });
      // pending 信号来自 P0 合并队列，没有结构化字段，至少用统一渲染保持一致格式。
      const pendingDigest = formatWorkerCompletion(
        {
          result: signal.result || '',
          summary: signal.summary,
          verdict: signal.verdict,
          artifacts: signal.artifacts,
        verification: signal.verification,
        evidence_refs: signal.evidence_refs,
        contract_compliance: signal.contract_compliance,
        next_steps: signal.next_steps,
        blocked_by_discovery: signal.blocked_by_discovery,
        needs_leader_coordination: signal.needs_leader_coordination,
        toolTrace: signal.toolTrace,
        },
        { agentName: signal.agentName, taskId: signal.taskId, exitReason: signal.exitReason },
      );
      combinedAgentReport += `\n${pendingDigest.block}\n`;
    }
    if (frame.pendingReportsToInject.length > 0) {
      const injectedKeys = new Set(frame.pendingReportsToInject.map(s => completionKey(s)));
      this.pendingAgentCompletionSignals = this.pendingAgentCompletionSignals.filter(
        s => !injectedKeys.has(completionKey(s))
      );
    }

    if (frame.agentMsgs.length > 0) {
      this.markLeaderSupervisionProgress();
    }
  
    const actionableContextReport = [combinedAgentReport, combinedRecoveryReport].filter(Boolean).join('\n');

    if (actionableContextReport && hasActionableAgentReport) {
      this.setDelegateMode('当前正在处理 worker 汇报，Leader 进入委派验收模式。');
      const clearedWaitingForAgentReport = await this.clearSoftWaitingForUser('agent_report');
      if (clearedWaitingForAgentReport) {
        leaderLogger.debug('Agent 事件打断了等待用户状态');
      }

      // 立即发送状态
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: '处理 Worker 汇报...',
      });

      // 完成回执已被 acceptWorkerTaskResult 落为 terminal，被依赖任务在此刻解锁。
      // 主动把「刚解锁的就绪任务」摆到 Leader 面前并强制正面处置——否则 Leader 会
      // drift 进"agent 刚起步、按监控纪律不打扰"，把本可立即推进的 ready 任务晾着。
      // 监控纪律只约束「运行中的 agent」，不适用于完成回执后新解锁的 dispatchable 任务。
      let dispatchDirective = '';
      try {
        // 先锚定本轮刚落终态的任务，杜绝 Leader 把刚完成的任务幻觉成"还在跑/刚起步"。
        // （现实 bug：Diego 的 T-20 已 completed，Leader 仍说"T-20 在跑，刚起步不久，按纪律不轮询"。）
        if (justTerminatedTasks.length > 0) {
          const terminatedList = justTerminatedTasks
            .map(t => `[${t.taskId}] ${t.exitReason === 'completed' ? '已完成' : '失败'}`)
            .join('、')
          ;
          dispatchDirective += `\n\n✓ 本轮已落终态：${terminatedList}。它们已是 terminal，请据此验收、解锁后续任务或收口。`;
        }

        let readyAfterCompletion = this.board.getDispatchable();
        if (readyAfterCompletion.length > 0 && this.dispatchDecisionCoordinator) {
          await this.dispatchDecisionCoordinator.notifyLeaderOfDispatchable();
          readyAfterCompletion = this.board.getDispatchable();
        }
        if (readyAfterCompletion.length > 0) {
          const list = readyAfterCompletion
            .map(t => `- [${t.id}] ${t.subject} (类型=${t.agent_type}${t.preferred_agent_name ? `, 预绑定=@${t.preferred_agent_name}` : ''})`)
            .join('\n');
          dispatchDirective += `\n\n⚠ 本次完成回执仍有 ${readyAfterCompletion.length} 个就绪任务需要 Leader 决策：\n${list}\n`
            + '强制要求：对上述每个就绪任务，要么立刻派发（建/复用 worker 调度），要么在本轮回复中逐条说明为何暂不派（依赖未真正满足 / 并发预算已满 / 需用户决策等具体可核验理由）。'
            + '就绪任务的处理口径：已解锁任务需要派发动作或具体暂缓依据；监控纪律只约束运行中的 agent。';
        } else if (this.board.allTerminal() && this.pool.getRunning().length === 0) {
          // 无就绪任务且全部终态、无运行中 agent：这是真正的收尾点。明确告诉 Leader
          // 做收口动作（验收 / 清理 team / 总结），而不是继续"等待完成信号"。
          dispatchDirective += '\n\nℹ 任务板已全部终态、无运行中 agent、无新解锁就绪任务——这是收尾点：请做最终验收 / 清理 team / 给用户完整收口总结。';
        }
      } catch (err) {
        leaderLogger.debug(`[Leader] 计算完成后就绪任务失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      const reportMsg = renderContextManifest({
        scope: 'leader',
        sessionId: this.sessionId,
        sections: [
          ...(combinedAgentReport ? [{ title: 'Worker Completion Artifacts', content: combinedAgentReport }] : []),
          ...(combinedRecoveryReport ? [{ title: 'Worker Recovery Required', content: combinedRecoveryReport }] : []),
          {
            title: 'Leader Verification Directive',
            content: `评估恢复事件并决定下一步。【硬性前提】对涉及 worker_recovery 的任务，先用 list_runtime_agents 或当前 Leader Runtime State 确认目标 agent 是否仍存在、是否 active，以及 recoveryLineage / consecutiveRespawnFailures；只有目标 agent 在当前 runtime agents 中存在且仍 active 时，才调用 check_agent_progress 做深查。若恢复报告里的 agent 名已不在当前 runtime agents 中，禁止拿旧名反复调用 check_agent_progress；应改用 list_runtime_agents 返回的真实 agent 名、任务板状态和 auto_retry_scheduled 结果判断等待/接管/重派。worker_recovery 表示任务未完成，不得当作 completed；若 auto_retry_scheduled=true 且新 worker 仍在运行，等待并验收，不要重复 dispatch；若 llm_error_kind 为 request_timeout/network_error 等瞬时类，属 provider 抖动，倾向等待而非重派；仅当当前 active agent 的 check_agent_progress 显示确无进展/卡死，或 list_runtime_agents 显示自动重派失败/无 active worker，才显式重派、接管、阻塞或升级给用户。如本次任务产出了重要的架构决策、技术选型、用户偏好或关键发现，请调用 learn_soul 写入对应的项目级/用户级长期记忆。${dispatchDirective}`,
          },
        ],
      });
      this.addMessage({ role: 'system', content: reportMsg });
      await this.db.saveConversationMessage(this.sessionId, { role: 'system', content: reportMsg });
      if (this.hasExplicitUserGate()) {
        this.emitter.emit('leader:status', {
          sessionId: this.sessionId,
          status: '等待用户输入...',
        });
        return 'continue';
      }
      try {
        await this.leaderThinkAndAct();
      } catch (err) {
        leaderLogger.error('leaderThinkAndAct failed:', err);
        this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
      } finally {
        this.emitRoundComplete('agent_report');
      }
    } else if (combinedAgentReport) {
      // 纯进展汇报（report/finding）：不为每条 worker 汇报单独起一轮 LLM。
      // 仅把进展并入对话上下文，留待下一次"真正需要思考"的轮次（任务终态 / 用户输入 /
      // 求助）一并消费——这样 Leader 说了"持续监控、不介入"就真的不再 ping LLM。
      // 不清 waitingForUser：派发后等待 worker 完成是正常 idle 态。
      const noteMsg = `[Worker 进展汇报，仅供参考，无需立即行动]\n${combinedAgentReport}`;
      this.addMessage({ role: 'system', content: noteMsg });
      await this.db.saveConversationMessage(this.sessionId, { role: 'system', content: noteMsg });
      leaderLogger.debug('收到纯进展汇报，已并入上下文，不触发 leaderThinkAndAct');
    }

    if (this.finished) {
      return 'break';
    }
    return 'next';
  }

  /**
   * 段6: 健康巡检 + 派发触发(dispatchable) + 终局判定 + 永驻巡逻 + 监督 idle + 进度停滞检测。
   * 行为与原内联段一致。无内层循环,原 while-level continue/break 全部转为返回控制指令。
   */
  private async _runImpl_dispatchAndFinalize(frame: LeaderLoopFrame, loopCount: number): Promise<LeaderLoopControl> {
    // P3.5: Agent 健康巡检 + 主动轮询进度
    const running = this.pool.getRunning();
    const receivedCompletionMsg = frame.allMsgs.some(
      m => !this.isUserInterventionMessage(m) && isTaskTerminalControlMessage(m)
    ) || frame.consumedCompletionKeys.size > 0 || frame.pendingReportsToInject.length > 0
      || this.pendingAgentCompletionSignals.length > 0;
  
    if (running.length > 0 && !receivedCompletionMsg) {
      const supervision = this.getLeaderSupervisionEvaluation(running);

      if (supervision.decision.type === 'warn_idle') {
        this.surfaceIdleWarnings(supervision.decision.idleAgents);
        return 'continue';
      }

      if (this.finished) {
        return 'break';
      }

      if (!this.waitingForUser) {
        return 'continue';
      }
    }
  
    // 收到完成消息 或 没有 Agent 运行中 → 继续往下检查任务状态
    this.reconcileRecoveringTasks();
  
    // 检查是否有可调度任务
    const dispatchable = this.board.getDispatchable();
    if (dispatchable.length > 0) {
      leaderLogger.debug(`有 ${dispatchable.length} 个任务可调度`);
      // 所有就绪任务都必须由 Leader 显式 dispatch 或说明暂缓理由。
      // 协调器只负责注入决策提示，不会启动 worker。
      if (this.dispatchDecisionCoordinator) {
        try {
          await this.dispatchDecisionCoordinator.notifyLeaderOfDispatchable();
        } catch (err) {
          leaderLogger.warn(`[DispatchDecision] 主循环 notifyLeaderOfDispatchable 异常: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        this.requestLeaderDispatchDecision(dispatchable);
      }

      {
        const dispatchableSigBefore = dispatchable.map(t => t.id).sort().join(',');
        try {
          await this.leaderThinkAndAct();
        } catch (err) {
          leaderLogger.error('leaderThinkAndAct failed:', err);
          this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
        } finally {
          this.emitRoundComplete('dispatchable_tasks');
        }

        if (this.finished) {
          return 'break';
        }
        if (!this.waitingForUser) {
          // Leader 仍活跃（在派发 / 继续推进）：清掉"已等待集合"标记，
          // 让后续真实变化能正常驱动。
          this.waitedDispatchableSig = null;
          return 'continue';
        }
        // Leader 思考后选择等待（未派发这批 dispatchable）：记住这批集合的指纹，
        // 主循环顶部的 un-latch 守卫据此不再为同一不变集合反复唤醒 think。
        // 非 eternal 模式下这是杜绝"无限请求 LLM"的关键。
        this.waitedDispatchableSig = dispatchableSigBefore;
      }
    }
  
    // 所有任务完成且没有 Agent 运行时，进入等待用户输入状态
    // 但如果还有待处理的 agent completion 信号（P0 handler 已入队但主循环尚未消费），
    // 跳过此分支让下一轮循环正常处理这些信号——否则会过早进入 idle/finalize。
    if (this.board.allTerminal() && this.pool.getRunning().length === 0
      && this.pendingAgentCompletionSignals.length === 0) {
      if (this.finished) {
        return 'break';
      }

      const reviewedScratchpad = await this.maybeReviewScratchpadTailWork();
      if (reviewedScratchpad) {
        if (this.finished) {
          return 'break';
        }
        return 'continue';
      }

      if (await this.maybeFinalizeCompletedSession()) {
        return 'break';
      }

      // Eternal 模式有 goal 时不进 idle，走 patrol 让 LLM 持续推进目标
      if (this.isEternalMode()) {
        const patrolled = await this.progressInvariant.maybeEternalIdlePatrol();
        if (patrolled) {
          return 'continue';
        }
      }

      if (!this.waitingForUser) {
        leaderLogger.info('所有任务已完成，进入空闲等待状态');
        this.waitingForUser = true;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
        this.emitter.emit('leader:status', {
          sessionId: this.sessionId,
          status: 'Idle',
        });
        this.emitter.emit('leader:busy', {
          sessionId: this.sessionId,
          isBusy: false,
          queueLength: 0,
        });
      }
    }
  
      // 进度哈希检测：每轮末尾计算，连续停滞则注入破局
      this.checkProgressStagnation();

      if (loopCount % 10 === 0) {
        leaderLogger.debug(`主循环运行中... (第${loopCount}轮)`);
      }
    return 'next';
  }
  /**
   * 停止 Leader
   */
  stop(): void {
    this.finished = true;
    this.isBusy = false;
    this.currentLlmAbortController?.abort();
    // 不清除 controller：保持 abort 状态，防止 stop() 后的下次 LLM call 继续执行
    // 释放派发决策协调器的事件订阅，避免 stop 后残留 listener
    try { this.dispatchDecisionCoordinator?.dispose(); } catch { /* tolerate */ }
  }

  /**
   * 实例终结清理：退订所有构造器级（不随 run() 重注册）的事件监听器，断开对共享 emitter 的引用。
   *
   * H1 修复：LeaderAgent 在构造器中创建并订阅共享 emitter 的子系统——
   *   - attachTaskLifecycleToTeamMailbox 注册的 task:failed / task:cancelled（_taskTeamUnsubscribers）
   *   - orchestrationRuntime（task:created/updated/assigned/completed/failed/cancelled）
   *   - leaderBlackboard（task:created/updated/completed/failed）
   *   - scheduler / dispatchDecisionCoordinator（task:failed 等调度触发器）
   * 这些监听器均在构造器注册一次、不随 run() 重入而重注册。历史上 dispose 仅退订
   * dispatchDecisionCoordinator，其余从不退订——同进程会话重建（resumeSession 造新 LeaderAgent）会在
   * 同一共享 emitter 上持续累积监听器，泄漏监听器及对 leader/board/bus 的引用。
   *
   * dispose() 隐含 stop()：先停止主循环（含 dispatchDecisionCoordinator.dispose），再退订其余实例级监听器。
   * 可安全重复调用（幂等）。
   */
  dispose(): void {
    this.stop();
    this.board.setContractReadinessResolver(undefined);
    // 退订 attachTaskLifecycleToTeamMailbox 注册的团队通知监听器
    for (const off of this._taskTeamUnsubscribers) {
      try { off(); } catch { /* tolerate：单个退订失败不应阻断其余退订 */ }
    }
    this._taskTeamUnsubscribers = [];
    // 退订配置热加载回调，防止监听器泄漏
    if (this._configReloadUnsubscribe) {
      try { this._configReloadUnsubscribe(); } catch { /* tolerate */ }
      this._configReloadUnsubscribe = null;
    }
    // 退订 eternal 模式绑定的共享 emitter 监听器（task:completed 等），防止 dispose 后泄漏
    try { this.progressInvariant?.disposeEternalListeners(); } catch { /* tolerate */ }
    // 退订 supervCoordinator 注册的 agent:completed/failed 等活动事件监听器
    try { this.supervCoordinator?.unsubscribeAgentActivityEvents(); } catch { /* tolerate */ }
    // 退订 LeaderAgent 拥有的、订阅共享 emitter 的子系统（与现有 run-scoped 退订并列，
    // 但这些是 constructor-scoped，必须在实例终结时统一释放）。
    try { this.orchestrationRuntime?.dispose(); } catch { /* tolerate */ }
    try { this.leaderBlackboard?.dispose(); } catch { /* tolerate */ }
    try { this.scheduler?.dispose(); } catch { /* tolerate */ }
    // dispatchDecisionCoordinator 已在 stop() 中 dispose；此处兜底重复调用幂等无副作用
    try { this.dispatchDecisionCoordinator?.dispose(); } catch { /* tolerate */ }
  }

  /**
   * 用户新输入到达时，只中断当前 LLM round，不结束 Leader 主循环。
   * 主循环随后会从 MessageBus 读取 user_intervention，并按最高优先级处理。
   */
  /**
   * 泛化中断方法：中断当前 LLM round，不结束 Leader 主循环。
   * @param reason 中断原因：'user_input' | 'agent_completion'
   */
  interruptCurrentRound(reason: 'user_input' | 'agent_completion' = 'user_input'): void {
    this.userInterruptPending = reason === 'user_input';
    this.currentLlmAbortController?.abort();
    this.userInterruptController.abort();
    leaderLogger.debug(`[Interrupt] 原因: ${reason}`);
  }

  /**
   * 非打断式用户指导：注入消息到下一轮 LLM 调用，不中断当前思考。
   * 用户可以通过这种方式给 Leader 补充信息、调整方向，而不需要打断正在进行的工作。
   */
  nudgeLeader(message: string): void {
    if (this.nudgeMessage) {
      // 已有未消费的 nudge，追加而非覆盖
      this.nudgeMessage += '\n' + message;
    } else {
      this.nudgeMessage = message;
    }
    leaderLogger.info(`[Nudge] 收到非打断式指导（将在下轮 LLM 调用时注入）`);
    this.emitter.emit('leader:status', {
      sessionId: this.sessionId,
      status: `💬 收到用户指导，将在下轮处理...`,
    });
  }

  /** 是否有待处理的 Agent 完成信号 */
  isAgentCompletionPending(): boolean {
    return this.pendingAgentCompletionSignals.length > 0;
  }

  /**
   * 在 LLM 调用前排空 bus 上已到达但尚未消费的 user_intervention 消息，
   * 直接注入为 user role 对话，让下一轮 LLM 立即看到用户输入并回复。
   *
   * 触发场景：用户在 Leader busy 期间用 interrupt:false 投递的"非打断式"消息。
   * 历史上这条路径只设置 nudgeMessage（注入为 system role），并且依赖外层
   * 主循环把 userMessageQueue 单独喂回 leaderThinkAndAct；当 leaderThinkAndAct
   * 已经在 AgentCore 多轮里运行时，bus 上的用户消息要等当前完整 think-and-act
   * 全部退出才被处理，体感就是"用户发了消息但 Leader 不答"。
   *
   * 现在：每轮 runRound 开始前，主动 poll bus，把用户消息原封不动以
   * role=user 注入对话；下一次 LLM 调用会立刻看到并回复。
   *
   * 返回 true 表示注入了至少一条用户消息。
   */
  async drainPendingUserMessagesIntoConversation(): Promise<boolean> {
    if (!this.bus) return false;
    const pendingUser = this.bus
      .pollByType(this.leaderBusName, ['user_intervention'])
      .filter(m => this.isUserInterventionMessage(m));
    if (pendingUser.length === 0) return false;

    let injected = 0;
    for (const msg of pendingUser) {
      const content = (msg.payload as MessageContent) ?? '';
      if (isEmptyContent(content)) continue;
      this.addMessage({ role: 'user', content });
      try {
        await this.db.saveConversationMessage(this.sessionId, { role: 'user', content });
      } catch { /* persist 失败不阻塞推进 */ }
      injected += 1;
    }

    if (injected > 0) {
      // 用户消息进来后必须重置 waiting/pending review 等用户门，否则 LLM
      // 这一轮会被 Planning Gate / askUser 等闸门挡住而不回复。
      if (this.waitingForUser) {
        this.waitingForUser = false;
        await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
      }
      await this.clearConsumedUserInputState();
      leaderLogger.info(`[NonInterrupt] LLM 调用前注入 ${injected} 条用户消息（非打断式）`);
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: '已收到用户消息，下一轮立即回复...',
      });
    }
    return injected > 0;
  }

  isUserInterruptPending(): boolean {
    return this.userInterruptPending;
  }

  clearUserInterruptPending(): void {
    this.userInterruptPending = false;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Progress Invariant + Watchdog + Eternal Patrol — delegated to progressInvariant
  // ─────────────────────────────────────────────────────────────────────

  private checkProgressStagnation(): void {
    this.progressInvariant.checkProgressStagnation();
  }

  /**
   * 标记进度更新时间（在每次成功推进时调用）
   */
  markLeaderProgress(): void {
    this.progressInvariant.markProgress();
  }

  private startWatchdog(): void {
    this.progressInvariant.startWatchdog();
  }

  private stopWatchdog(): void {
    this.progressInvariant.stopWatchdog();
  }

  protected async maybeReviewScratchpadTailWork(): Promise<boolean> {
    const summary = await collectScratchpadFollowUps({
      workspace: this.workspace,
      sessionId: this.sessionId,
      llm: this.llm,
      model: this.model,
      llmGuardFactory: createLlmGuard,
    });
    if (!summary) {
      return false;
    }

    if (summary.digest === this.lastScratchpadReviewDigest) {
      return false;
    }

    this.lastScratchpadReviewDigest = summary.digest;
    await this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_LAST_SCRATCHPAD_REVIEW_DIGEST, summary.digest);

    const reviewPrompt = [
      summary.report,
      '',
      '请判断这些收尾项是否需要转化为补充任务、补充验证，或明确声明无需继续处理。',
      '在给出“全部完成”的最终结论前，必须先处理这些尾巴。',
    ].join('\n');

    this.addMessage({
      role: 'system',
      content: reviewPrompt,
    });
    await this.db.saveConversationMessage(this.sessionId, {
      role: 'system',
      content: reviewPrompt,
    });
    try {
      await this.leaderThinkAndAct();
    } catch (err) {
      leaderLogger.error('leaderThinkAndAct failed:', err);
      this.emitter.emit('leader:error', { sessionId: this.sessionId, error: err as Error });
    } finally {
      this.emitRoundComplete('plan_review');
    }
    return true;
  }

  /**
   * Leader 思考和行动循环
   */
  public async leaderThinkAndAct(maxToolRounds = LEADER_MAX_TOOL_ROUNDS): Promise<void> {
    this.clearUserInterruptPending();
    // 每轮思考前重置用户中断控制器，确保新一轮的 shell 命令可以被正确中断
    this.userInterruptController = new AbortController();
    await this.consumePendingAgentCompletionsIntoConversation();

    // 派发由 Leader 通过 dispatch_agent 显式触发，
    // think 入口不再隐式 scheduler.tick —— 避免 Leader 还没说话就被
    // 自动派出去的任务抢跑。
    return this.thinkingEngine.leaderThinkAndAct(maxToolRounds);
  }


  /**
   * 获取当前消息数
   */
  getMessageCount(): number {
    return this.conversation.length;
  }

  /**
   * 获取角色注册表
   */
  getRoleRegistry(): AgentRoleRegistry {
    return this.roleRegistry;
  }

  /**
   * 获取工具注册表（公开访问）
   */
  getToolRegistry() {
    return this.toolRegistry;
  }

  getContextManager() {
    return this.contextManager;
  }

  setConversation(messages: ChatMessage[]) {
    this.conversation = messages;
  }

  /**
   * 主动压缩 Leader 上下文：先把当前 conversation 同步到 ContextManager，
   * 触发强制压缩，再把压缩后的消息回写到 conversation。
   *
   * 三处入口（TUI dispatcher、Web AcpHandler、HTTP SessionRoutes、COMPACT 字符串）
   * 都必须走这一个方法，禁止直接调 contextManager.forceCompact() 而不回写。
   */
  async compactContext(): Promise<{
    oldTokens: number;
    newTokens: number;
    compacted: boolean;
    compactType?: string;
    overflow?: boolean;
    archivePath?: string;
    inProgress?: boolean;
    threshold?: number;
  }> {
    const oldLength = this.conversation.length;
    const oldHash = this.hashContextContent(this.conversation.map((message) => contentToPlainText(message.content)).join('\n'));
    this.contextManager.setMessages(this.conversation);
    const result = await this.contextManager.forceCompact();
    this.conversation = this.contextManager.getMessages();
    const newHash = this.hashContextContent(this.conversation.map((message) => contentToPlainText(message.content)).join('\n'));
    this.emitter.emit('context:mutation', {
      sessionId: this.sessionId,
      source: 'leader_compact_context',
      operation: 'compact',
      oldHash,
      newHash,
      oldLength,
      newLength: this.conversation.length,
      changed: oldHash !== newHash || oldLength !== this.conversation.length,
      reason: result.compacted ? 'context_compacted' : 'compact_noop',
    });
    return result;
  }

  getContextRuntimeState(): ContextRuntimeState {
    return this.contextManager.getRuntimeState();
  }

  getEternalRuntimeSnapshot(): EternalRuntimeSnapshot {
    return this.progressInvariant.getEternalRuntimeSnapshot();
  }

  invalidateEternalSilenceLock(reason?: string): void {
    this.progressInvariant.invalidateEternalSilenceLock(reason);
  }

  publishAssistantOutput(content: string, reasoningContent?: string): void {
    const text = String(content || '').trim();
    if (!text) {
      return;
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: text,
    };
    this.addMessage(assistantMessage);
    this.db.saveConversationMessage(this.sessionId, assistantMessage);
    this.emitter.emit('leader:text', {
      sessionId: this.sessionId,
      content: text,
      reasoningContent,
    });
  }

  /**
   * 获取当前交互运行时快照
   */
  getInteractionSnapshot(): LeaderInteractionSnapshot {
    return {
      running: this.running,
      busy: this.isBusy,
      finished: this.finished,
      waitingForUser: this.waitingForUser,
      pendingReview: this.pendingReview,
      planApproved: this.planApproved,
      executionMode: this.executionMode,
      executionReason: this.executionReason,
      permissionSummary: summarizePermissionContextForDisplay(this.permManager.permissionContext),
      pendingPermissionRequest: this.permManager.pendingPermissionRequest,
    };
  }

  /**
   * 检查是否有未完成的任务
   */
  hasPendingTasks(): boolean {
    const tasks = this.board.getAllTasks();
    return tasks.some((t) => t.status === 'dispatchable' || t.status === 'running');
  }

  /**
   * 检查是否有运行的 Agent
   */
  hasRunningAgents(): boolean {
    return typeof this.pool?.getRunning === 'function'
      ? this.pool.getRunning().length > 0
      : false;
  }

  /**
   * 将 Agent 注册到健康巡检系统（供 LeaderTools 等外部调用）
   */
  registerAgentHealth(agentId: string, name: string, roleType?: string): void {
    this.healthMonitor.registerAgent(agentId, name, roleType);
  }
}

export default LeaderAgent;
