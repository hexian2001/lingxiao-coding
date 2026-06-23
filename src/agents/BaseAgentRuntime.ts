/**
 * BaseAgent - Agent 基类
 * 完整复刻 Python 版本的所有功能
 * 
 * 包含:
 * - ContextManager 集成
 * - 多模态上下文注入
 * - 数据库持久化
 * - 完整的事件日志
 * - 消息总线干预检查
 * - 超时重试机制
 * - 原始 XML 工具调用容错解析
 * - 工具结果智能截断
 * - Agent 级上下文管理
 * - 技能注入
 * - Scratchpad 工作笔记
 * - 幻觉检测和处理
 */

import {
  contentToPlainText,
  thinkingBlocksToText,
  type ChatMessage,
  type ChatResponse,
  type MessageContentPart,
  type ToolCall,
  type ToolDefinition,
} from '../llm/types.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { TokenUsageView } from '../types/canonical.js';
import type { ToolRegistry } from '../tools/Registry.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import type { AgentHandle } from './AgentPoolRuntime.js';
import { createFailureResult, createSuccessResult } from './AgentExecutionResult.js';
import type { ContractAllowedScope } from '../core/ContractAllowedScope.js';
import type { AgentExecutionResult } from './AgentExecutionResult.js';
import type { AttemptCompletionStructuredResult } from '../tools/implementations/AttemptCompletionTool.js';
import { BUGHUNT_MODE_TOOL_NAMES, OFFICE_TOOL_NAMES } from '../contracts/constants/leaderToolDefinitions.js';
import { ContextManager } from '../core/ContextManager.js';
import {
  renderContextManifest,
  type ContextManifestAgentArtifact,
  type ContextManifestMcpSurface,
  type ContextManifestModeSurface,
  type ContextManifestPluginSurface,
  type ContextManifestToolSurface,
} from '../core/ContextManifest.js';
import { buildLlmInputManifest, summarizeLlmInputManifest } from '../core/LlmInputManifest.js';
import {
  getLeaderDefaultPermissionContext,
  isNetworkTool,
  normalizeToolPermissionContext,
  type PermissionRequestPayload,
} from '../core/PermissionSystem.js';
import {
  createPermissionRequestPayload,
  readAgentControlMessage,
} from '../core/AgentProtocol.js';
import { parseProtocolPayload } from '../core/TeamProtocol.js';
import { langfuseIntegration } from '../core/LangfuseIntegration.js';
import {
  buildSkillInjection,
  collectAvailableSkills,
  parseExplicitSkillMentions,
  resolveExplicitSkillMentions,
  resolveDisabledSkillNames,
} from '../core/SkillCatalog.js';
import { setWorkerFlushFn } from './WorkerFlushRegistry.js';
import { AssetUsageStore } from '../memory/AssetUsageStore.js';
import {
  AGENT_MAX_ITERATIONS,
  AGENT_MAX_RUNTIME_MINUTES,
  ENABLE_STREAMING,
  ENABLE_THINKING_INSTRUCTION,
  MAX_AGENT_MESSAGES,
  onConfigReload,
} from '../config.js';
import { THINKING_INSTRUCTION as DEFAULT_THINKING_INSTRUCTION } from './prompts/task-runtime/thinking_instruction.js';
import { buildWorkerTaskPrompt } from './prompts/task-runtime/worker_task_prompt.js';
import { hasRawToolSyntax, parseRawToolCalls } from './raw_tool_calls.js';
import { clearAgentResumeCheckpoint, saveAgentResumeCheckpoint } from '../core/ResumeManager.js';
import { classifyLLMError, formatLLMErrorLabel, type LLMErrorKind } from '../llm/errors.js';
import { CircuitOpenError } from '../llm/CircuitBreaker.js';
import { getModelDevInfo } from '../llm/ModelsDevRegistry.js';
import { getContextWindowSizeFromProvider } from '../llm/model_capabilities.js';
import { getReasoningGenerateOptions } from '../llm/reasoningSampling.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { getTeamMemberRegistry } from '../core/TeamMailbox.js';
import { t } from '../i18n.js';
import { LlmGuard, createLlmGuard } from './LlmGuard.js';
import {
  createEventStreamClient,
} from './runtime/LlmRoundExecutor.js';
import { AgentCore } from './runtime/AgentCore.js';
import { ToolScheduler } from './runtime/ToolScheduler.js';
import { healInterruptedToolCalls } from '../llm/message_sanitizer.js';
import type { ToolResultContent } from './runtime/ToolResponseProcessor.js';
import { executeToolCallsWithTruncationGuard, rejectEmptyArgsFileTools } from './runtime/ToolCallSafety.js';
import { ToolLoopDetector } from './runtime/ToolLoopDetector.js';
import { getToolFailureLoopGuard, type LoopGuardDecision } from './runtime/ToolFailureLoopGuard.js';
import { createToolFailureLoopEscalationPayload } from '../core/AgentProtocol.js';
import { createStreamHookBuffers, wrapLlmHooksForEmitter } from './runtime/LlmStreamHooks.js';
import {
  formatIncomingContent,
  isStopMessage as inboxIsStopMessage,
  isPauseMessage as inboxIsPauseMessage,
  parseInterveneMessage as inboxParseInterveneMessage,
  parseInterventionControl as inboxParseInterventionControl,
  isResumeMessage as inboxIsResumeMessage,
  isInterventionConfirmMessage as inboxIsInterventionConfirmMessage,
  resolveSenderLabel as inboxResolveSenderLabel,
  type InboxRawMessage,
  type ParsedIntervention,
} from './runtime/AgentInboxParsers.js';
import { startToolProgressHeartbeat, startLlmInFlightHeartbeat, type LlmInFlightHeartbeatHandle } from './runtime/ToolProgressHeartbeat.js';
import {
  evaluateRawToolRetryOutcome,
} from './runtime/CompletionTerminationPolicy.js';
import { evaluateNextSpeakerCandidate } from './runtime/NextSpeakerPolicy.js';
import { AgentRuntimeState } from './runtime/AgentRuntimeState.js';
import { AgentContextController } from './AgentContextController.js';
import { AgentInterventionHandler } from './AgentInterventionHandler.js';
import { AgentRoundExecutor } from './AgentRoundExecutor.js';
import {
  inferAgentGatewayPurpose,
  recordAgentTokenUsage,
  renderAgentPromptTemplate,
  summarizeAgentProgress,
  truncateAgentToolResult,
} from './AgentRuntimeUtilities.js';
import { autoWriteAgentCompletionNote } from './AgentCompletionNoteWriter.js';
import type { BlackboardGraph } from '../core/blackboard/BlackboardGraph.js';
import type { WorkflowManager } from '../core/workflow/WorkflowManager.js';
import type { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';
import { evaluateWorkerCompletionCandidate } from './runtime/WorkerCompletionPolicy.js';
import { runCompletionVerification } from './runtime/MandatoryVerification.js';
import { decideAgentP0Action } from './agentP0Message.js';
import type { RecoveryFaultClass } from '../core/RecoveryRecords.js';
import { join } from 'path';
import { homedir } from 'os';
import { agentLogger } from '../core/Log.js';
import { executeStop } from '../core/hooks/index.js';
import { LLM, AGENT, LEADER, BUDGET } from '../config/defaults.js';
import { config as runtimeConfig, getConfigValue } from '../config.js';
import { normalizeImageRetainRounds } from '../llm/image_blob_store.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { OFFICE_SUITE_SKILL_NAME } from './office/OfficeModeProtocol.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { TimeoutError } from './errors/TimeoutError.js';
import { getPromptTemplate, type TaskType, type PromptMode } from './prompts/PromptTemplates.js';
import { TaskClassifier } from './TaskClassifier.js';
import { AssumptionTracker, type VerificationBatch } from '../core/AssumptionTracker.js';
import {
  REQUIRED_AGENT_CONTRACT_TOOLS,
  REQUIRED_TEAM_CONTRACT_TOOLS,
  pruneTools,
  type ExecutionMode as ToolPrunerMode,
} from '../core/ToolPruner.js';
import { discoverPlugins } from '../core/plugins/PluginStore.js';
import { BASE_PARALLEL_SAFE_TOOLS, FILE_MODIFYING_TOOLS, runToolCallsBatch } from './runtime/parallelToolBatch.js';
import { CONTRACT_PACK_MARKER } from '../core/ContractPack.js';
import { upsertSystemSlot, collapseSystemSlots, matchesSystemSlot, type SystemSlotMatcher } from '../core/SystemMessageSlot.js';
import type { AgentTask } from '../types/canonical.js';

// Task — re-exported from canonical (agent-facing lightweight subset)
export type Task = AgentTask;

/**
 * 把 ToolFailureLoopGuard 的熔断决策转成给 LLM 看的 ERROR 文案。
 * 放在模块顶层（不依赖 class state）以便未来跨模块复用 + 纯函数可单测。
 */
export function formatToolFailureLoopError(
  toolName: string,
  decision: LoopGuardDecision,
): string {
  const lines = [
    `TOOL_FAILURE_LOOP_TRIPPED: 工具 "${toolName}" 连续 ${decision.count} 次以相同 args + 错误类型（${decision.errorKind}）失败，已自动熔断。`,
  ];
  if (decision.requiresEscalation) {
    lines.push('本错误属于状态类（permission / mode / write_scope / sandbox / network / schema），继续重试不会改变结果。');
    lines.push('下一步：请通过 escalate_to_leader 或 request_permission_update 申请 Leader 介入；不要再次发起相同调用。');
  } else {
    lines.push('本错误非状态类，但已超过熔断阈值，避免 LLM 在已熔断的 key 上继续消耗 round。');
    lines.push('下一步：可主动调整 args 后再试，或通过 escalate_to_leader 上报。');
  }
  lines.push(`\nLLM_RECOVERY=${JSON.stringify({
    code: 'TOOL_FAILURE_LOOP_TRIPPED',
    message: lines.join(' '),
    retryable: false,
    fix: 'Do not retry the same toolName+args+errorKind combination. Escalate to leader or change strategy.',
    failure_loop: {
      toolName: decision.signature.toolName,
      argsHash: decision.signature.argsHash,
      errorKind: decision.signature.errorKind,
      errorCode: decision.signature.errorCode,
      count: decision.count,
      requiresEscalation: decision.requiresEscalation,
    },
  })}`);
  return lines.join('\n');
}

export interface TokenTracker {
  addUsage(agentId: string, usage: TokenUsageView, modelName?: string): void;
  getTotal(): number;
  loadHistory(sessionId: string): void;
  getSessionTotal(): number;
  usageMap?: Map<string, TokenUsageView>;
}

/**
 * Agent 配置
 */
export interface AgentConfig {
  agentId: string;
  name: string;
  role: string;
  systemPrompt: string;
  toolNames: string[];
  skillNames?: string[];
  llmClient: ContentGenerator;
  toolRegistry: ToolRegistry;
  messageBus: MessageBus;
  tokenTracker: TokenTracker;
  workspace: string;
  sessionId: string;
  model: string;
  eventEmitter: EventEmitter;
  db?: DatabaseManager;
  handle?: AgentHandle;
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  blackboardGraph?: BlackboardGraph;
  workflowManager?: WorkflowManager;
  workflowEngine?: WorkflowEngine;
  scheduledTaskManager?: ScheduledTaskManager;
  /** Per-role git author identity for commit attribution. */
  gitIdentity?: { name: string; email: string };
}

/**
 * BaseAgent - Agent 基类
 * 完整复刻 Python 版本
 */
/**
 * Worker 侧状态镜像类 system 槽位（contract pack + worker_runtime manifest）。
 * upsertSystemContextMessage / initializeMessagesFromInherited 据此做单槽 in-place 更新，
 * 治本「每轮 append 堆积占满上下文」。
 */
const WORKER_SYSTEM_SLOTS: readonly SystemSlotMatcher[] = [
  { kind: 'prefix', prefix: CONTRACT_PACK_MARKER },
  { kind: 'manifestSlot', slot: 'worker_runtime' },
];

/**
 * 将 MCP SDK ContentBlock[] 转换为前端可渲染的 MessageContentPart[]。
 * 检测 block._meta.lingxiao_app 标记，生成 mcp_app part。
 * 无 lingxiao_app 标记的 block 按标准类型映射（text/image_url/image_blob_ref）。
 */
function extractMcpContentParts(content: Array<Record<string, unknown>>): MessageContentPart[] {
  const parts: MessageContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    // 检测 lingxiao_app 标记
    const meta = block._meta as Record<string, unknown> | undefined;
    const appMeta = meta?.lingxiao_app as Record<string, unknown> | undefined;
    if (appMeta && typeof appMeta === 'object'
        && typeof appMeta.html === 'string' && appMeta.html.length > 0) {
      parts.push({
        type: 'mcp_app',
        html: appMeta.html,
        title: typeof appMeta.title === 'string' ? appMeta.title : undefined,
        height: typeof appMeta.height === 'number'
          ? Math.min(Math.max(appMeta.height, 100), 800)
          : 'auto',
        actions: Array.isArray(appMeta.actions)
          ? appMeta.actions.filter((a: unknown): a is { label: string; event: string; data?: unknown } =>
              typeof (a as Record<string, unknown>)?.label === 'string'
              && typeof (a as Record<string, unknown>)?.event === 'string')
          : undefined,
      });
      continue;
    }

    // 标准类型映射
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    }
    // image / audio / resource 等类型按现有 image_url / image_blob_ref 映射
    // （MCP SDK image block → 前端 image_url，data:mimeType;base64 格式）
  }
  return parts;
}

export class BaseAgent {
  agentId: string;
  name: string;
  role: string;
  systemPrompt: string;
  toolNames: string[];
  skillNames: string[];
  llm: ContentGenerator;
  tools: ToolRegistry;
  bus: MessageBus;
  tracker: TokenTracker;
  workspace: string;
  sessionId: string;
  model: string;
  emitter: EventEmitter;
  db?: DatabaseManager;
  protected handle?: AgentHandle;
  protected blackboardGraph?: BlackboardGraph;
  protected workflowManager?: WorkflowManager;
  protected workflowEngine?: WorkflowEngine;
  protected scheduledTaskManager?: ScheduledTaskManager;
  /** Per-role git author identity for commit attribution. */
  protected gitIdentity?: { name: string; email: string };

  /** 带 sessionId 前缀的 bus 收件人名（避免跨会话消息串台） */
  get busName(): string { return `${this.sessionId}:${this.name}`; }
  /** 本会话 leader 的 bus 收件人名 */
  get leaderBusName(): string { return `${this.sessionId}:leader`; }

  protected messages: ChatMessage[] = [];
  protected stopped = false;
  protected paused = false;
  protected stalled = false;
  protected interventionMessage: string | null = null;
  protected currentLlmAbortController: AbortController | null = null;
  /** Leader 注入的 nudge 干预消息，在下轮 LLM 调用时作为 system 注入 */
  protected nudgeMessage: string | null = null;
  private pendingInboxInterventionResult: { type: 'repeat' | 'continue' } | null = null;
  private terminalRuntimeOutcome: {
    kind: 'failed' | 'recovering' | 'terminated';
    reason: string;
    faultClass?: RecoveryFaultClass;
    recoverable: boolean;
    phase?: 'execute' | 'conclude';
    llmErrorKind?: LLMErrorKind;
  } | null = null;
  /**
   * 复用同名 worker 时继承的历史对话（来自上一轮运行、已落在 DB 的 agent_conversation）。
   *
   * Why：worker 子进程永远以 isResume=false 启动，run() 会走 initializeMessages → this.messages=[]，
   * 把任何预置消息清空。所以"继承上下文"不能靠 WorkerProcessEntry 预先 addMessage（会被清掉），
   * 必须由 run() 在初始化时显式识别这份历史并 weave 进消息序列。非空即代表"这是个被复用/复活的 worker"。
   *
   * 这些消息已存在于 DB（上一轮用同一 agentId 保存），run() 继承时不重复回写历史，
   * 避免下次复用时 agent_conversation 翻倍。
   */
  protected inheritedHistory: ChatMessage[] | null = null;
  /**
   * 继承历史的语义：
   *   - 'resume'：复活同一个任务（追问 / team 复活），把历史当作基底直接续，不再注入任务指令
   *     （续推由随后投递的 leaderMessage / inbox 驱动）。
   *   - 'new_task'：复用同名 worker 跑一个新任务，历史作为背景上下文，再追加新任务指令与分隔说明。
   */
  protected inheritedHistoryMode: 'resume' | 'new_task' = 'new_task';
  private auditedDefaultBypassFallback = false;
  protected runtimeState = new AgentRuntimeState();
  protected readonly MAX_TIMEOUT_RETRIES = runtimeConfig.llm.max_retries;
  /** 外层 LLM 错误重试计数（与 LlmGuard 内部 5 次预算解耦，跨 catch 累加） */
  protected llmErrorRetryCount = 0;
  protected readonly LLM_MAX_ERROR_RETRIES = runtimeConfig.llm.max_retries;
  protected maxIterations: number;
  protected maxRuntimeMinutes: number;
  /** onConfigReload 退订函数：在 agent 终止时调用以防止监听器泄漏 */
  private _configReloadUnsubscribe: (() => void) | null = null;
  protected readonly MAX_COMPLETION_GUARD_RETRIES = 3;
  /**
   * 连续续跑上限。超过即强制接受当前输出收尾，打破「续跑→短 stop→续跑」空转。
   * 任意真实工具调用会把计数清零，所以正常多轮工作不受影响。
   */
  protected readonly MAX_CONTINUATION_RETRIES = 5;
  protected contextManager: ContextManager;
  protected contextController: AgentContextController;
  protected interventionHandler: AgentInterventionHandler;
  protected roundExecutor: AgentRoundExecutor;
  protected lastRuntimeContextFingerprint: string | null = null;
  /** 同 toolName+args 连续调用探针；超阈值打断当前 task */
  protected toolLoopDetector = new ToolLoopDetector({ threshold: 5 });
  /** context:overflow 事件取消订阅函数 */
  protected _contextOverflowUnsub: (() => void) | null = null;
  /** P0 紧急消息介入监听取消订阅函数 */
  protected _p0InterventionUnsub: (() => void) | null = null;
  /**
   * 框架自动采集的工具产物轨迹 —— 不依赖 worker 主动在 attempt_completion 里
   * 填 artifacts，也能让 Leader 看到 worker 真实改过哪些文件、跑过哪些命令。
   *   - file_create → files_created
   *   - structured_patch → files_modified
   *   - shell → commands_run（command 原文）
   *   - python_exec → commands_run（python: 首行）
   * 与 attempt_completion 声明的 artifacts 在 Leader 端按文件路径去重合并。
   */
  protected readonly toolTrace = {
    filesCreated: new Set<string>(),
    filesModified: new Set<string>(),
    commandsRun: [] as string[],
  };
  private assumptionTracker?: AssumptionTracker;
  private assumptionTrackerProjectRoot?: string;
  /**
   * DAG-based context state — 追踪消息间依赖关系,支持结构性无损压缩。
   * 由 addMessage 自动维护; performContextReset 时用 structuralTrim 替代粗暴的"只留最近 15 条"。
   * 导入: import { ContextDAG } from '../core/compress/ContextDAG.js';
   */
  protected contextDAG: import('../core/compress/ContextDAG.js').ContextDAG | null = null;

  /**
   * worker 调用 attempt_completion 时捕获的结构化收尾结果。
   * run() 结束后透传给 WorkerProcessEntry → task_complete payload → Leader。
   */
  protected attemptCompletion?: AttemptCompletionStructuredResult;
  /** 权限超时计数：连续超时 2 次则终止 agent */
  protected permissionTimeoutCount = 0;
  /** 标记 agent 应终止（权限超时等场景） */
  protected shouldTerminate = false;

  protected get toolCallCount(): number {
    return this.runtimeState.toolCallCount;
  }

  protected set toolCallCount(value: number) {
    this.runtimeState.toolCallCount = value;
  }

  protected get currentTaskId(): string | null {
    return this.runtimeState.currentTaskId;
  }

  protected set currentTaskId(value: string | null) {
    this.runtimeState.currentTaskId = value;
  }

  protected get currentTaskWorkingDirectory(): string | null {
    return this.runtimeState.currentTaskWorkingDirectory;
  }

  protected set currentTaskWorkingDirectory(value: string | null) {
    this.runtimeState.currentTaskWorkingDirectory = value;
  }

  protected get currentTaskWriteScope(): string[] {
    return this.runtimeState.currentTaskWriteScope;
  }

  protected set currentTaskWriteScope(value: string[]) {
    this.runtimeState.currentTaskWriteScope = value;
  }

  protected get currentContractAllowedScope(): ContractAllowedScope | undefined {
    return this.runtimeState.currentContractAllowedScope;
  }

  /** WorkerProcessEntry 在 run 前从 payload 透传契约允许面(多契约已 intersect)。 */
  setContractAllowedScope(scope?: ContractAllowedScope): void {
    this.runtimeState.currentContractAllowedScope = scope;
  }

  protected get iteration(): number {
    return this.runtimeState.iteration;
  }

  protected set iteration(value: number) {
    this.runtimeState.iteration = value;
  }

  protected get rawXmlRetryCount(): number {
    return this.runtimeState.rawXmlRetryCount;
  }

  protected set rawXmlRetryCount(value: number) {
    this.runtimeState.rawXmlRetryCount = value;
  }

  protected get completionGuardRetryCount(): number {
    return this.runtimeState.completionGuardRetryCount;
  }

  protected set completionGuardRetryCount(value: number) {
    this.runtimeState.completionGuardRetryCount = value;
  }

  private auditDefaultPermissionContext(source: string, reason: string): void {
    if (this.auditedDefaultBypassFallback || !this.db) return;
    this.auditedDefaultBypassFallback = true;
    const record = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      actor: this.name === 'leader' ? 'leader' : 'worker',
      source,
      mode: getLeaderDefaultPermissionContext().mode,
      workerName: this.name === 'leader' ? undefined : this.name,
      reason,
    };
    try {
      this.db.updateSessionState<unknown[]>(
        this.sessionId,
        SESSION_KEYS.PERMISSION_AUDIT_LOG,
        (current) => {
          const list = Array.isArray(current) ? current : [];
          return [...list.slice(-199), record];
        },
      );
    } catch { /* tolerate */ }
    try {
      this.emitter.emit('permission:audit', record);
    } catch { /* tolerate */ }
  }

  protected getPermissionContext() {
    if (!this.db) {
      return getLeaderDefaultPermissionContext();
    }
    const stored = this.db.getSessionState(this.sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT);
    // 与 LeaderPermissionManager.loadPermissionContextFromState 对齐：
    // session_state 为 null 时，worker 与 leader 统一读取中心化默认权限模式。
    if (stored == null) {
      this.auditDefaultPermissionContext('worker_default_permission_context', 'session 未设置权限上下文，worker 使用中心化默认权限模式。');
      return getLeaderDefaultPermissionContext();
    }
    return normalizeToolPermissionContext(stored);
  }

  protected async requestPermissionFromLeader(toolName: string, reason: string): Promise<boolean> {
    if (!this.bus || this.name === 'leader') {
      return false;
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: PermissionRequestPayload = {
      requestId,
      source: 'worker',
      toolName,
      requestedMode: isNetworkTool(toolName) ? 'networked' : 'dev',
      reason,
      workerName: this.name,
    };

    this.bus.send(this.busName, this.leaderBusName, 'permission_request', createPermissionRequestPayload(payload));
    const permissionTimeoutMs = runtimeConfig.agents.permission_timeout_ms;
    const response = await this.bus.waitForMessageType(this.busName, 'permission_response', permissionTimeoutMs);
    if (!response) {
      await this.logEvent('permission_request_timeout', {
        requestId,
        toolName,
        reason,
        timeoutMs: permissionTimeoutMs,
      });
      this.emitter.emit('agent:status', {
        agentId: this.agentId,
        agentName: this.name,
        sessionId: this.sessionId,
        status: `⚠️ 权限审批超时: ${toolName}`,
      });
      // 权限超时：标记终止，让 LLM 循环不再重试该工具
      this.permissionTimeoutCount = (this.permissionTimeoutCount || 0) + 1;
      if (this.permissionTimeoutCount >= 2) {
        // 连续 2 次权限超时，终止 agent
        this.shouldTerminate = true;
      }
      return false;
    }
    const parsed = readAgentControlMessage(response);
    return parsed?.kind === 'permission_response' &&
      parsed.requestId === requestId &&
      parsed.decision === 'approved';
  }

  protected persistResumeCheckpoint(task: Task): void {
    if (!this.db) {
      return;
    }
    try {
      saveAgentResumeCheckpoint(this.db, this.sessionId, {
        agentId: this.agentId,
        agentName: this.name,
        agentRole: this.role,
        taskId: task.id,
        iteration: this.iteration,
        toolCallCount: this.toolCallCount,
        timestamp: Date.now() / 1000,
      });
    } catch (err) {
      // DB 写入失败（SQLITE_BUSY / 连接关闭）不应杀死 worker 进程
      agentLogger.warn(`[${this.name}] persistResumeCheckpoint failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  protected clearResumeCheckpoint(): void {
    if (!this.db) {
      return;
    }
    clearAgentResumeCheckpoint(this.db, this.sessionId, this.agentId);
  }

  // 思考指令
  static readonly THINKING_INSTRUCTION = DEFAULT_THINKING_INSTRUCTION;

  constructor(config: AgentConfig) {
    this.agentId = config.agentId;
    this.name = config.name;
    this.role = config.role;
    this.systemPrompt = config.systemPrompt;
    this.toolNames = config.toolNames;
    this.skillNames = config.skillNames || [];
    this.llm = config.llmClient;
    this.tools = config.toolRegistry;
    this.bus = config.messageBus;
    this.tracker = config.tokenTracker;
    this.workspace = config.workspace;
    this.sessionId = config.sessionId;
    this.model = config.model;
    this.emitter = config.eventEmitter;
    this.db = config.db;
    this.handle = config.handle;
    this.blackboardGraph = config.blackboardGraph;
    this.workflowManager = config.workflowManager;
    this.workflowEngine = config.workflowEngine;
    this.scheduledTaskManager = config.scheduledTaskManager;
    this.gitIdentity = config.gitIdentity;
    this.maxIterations = config.maxIterations ?? AGENT_MAX_ITERATIONS;
    this.maxRuntimeMinutes = config.maxRuntimeMinutes ?? AGENT_MAX_RUNTIME_MINUTES;

    // 注册配置热加载回调：agents.max_iterations / agents.max_runtime_minutes 变化时
    // 更新当前 agent 的迭代/运行时长上限，让 Settings 面板的修改对活跃 agent 立即生效。
    // 仅当 agent 未显式指定 maxIterations/maxRuntimeMinutes 时才跟随全局配置（与构造逻辑一致）。
    this._configReloadUnsubscribe = onConfigReload((cfg) => {
      try {
        if (config.maxIterations == null) {
          this.maxIterations = cfg.agents.max_iterations;
        }
        if (config.maxRuntimeMinutes == null) {
          this.maxRuntimeMinutes = cfg.agents.max_runtime_minutes;
        }
      } catch (e) {
        // 参考 ModelManager.ts:279-288 的 try-catch 模式，不阻断其他 reload handler
      }
    });

    const agentInitContextLimit = this.resolveContextLimit(this.model);
    this.contextManager = new ContextManager(
      agentInitContextLimit,
      this.model,
      this.sessionId,
      this.db,
      this.llm,
      this.emitter,
      {
        kind: 'agent',
        workspace: this.workspace,
        agentId: this.agentId,
        agentName: this.name,
      },
      createLlmGuard,
    );
    this.contextController = new AgentContextController({
      maxMessages: MAX_AGENT_MESSAGES,
    });
    this.interventionHandler = new AgentInterventionHandler({
      bus: this.bus,
      agentId: this.agentId,
      busName: this.busName,
      logger: agentLogger,
    });
    this.roundExecutor = new AgentRoundExecutor({
      llm: this.llm,
      toolRegistry: this.tools,
      contextController: this.contextController,
      interventionHandler: this.interventionHandler,
      logger: agentLogger,
      maxRounds: this.maxIterations,
      model: this.model,
    });

    this._contextOverflowUnsub = this.emitter.subscribe('context:overflow', (data) => {
      if (data.owner !== 'agent' || data.agentId !== this.agentId) return;
      agentLogger.warn(`Agent ${this.name} 上下文溢出，执行硬重置`);
      this.performContextReset();
    });

    // 延迟初始化 ContextDAG (避免阻塞构造,只在首次需要时创建)
    this.initContextDAG();

    // 监听 P0 紧急消息（Leader 通过 send_message_to_agent 发送）。
    //
    // 仅当 P0 类型属于真正的"行动指令"（user_intervention / force_terminate）
    // 时才 abort 当前 LLM。其他 P0（task_complete / task_failed / agent_health_critical
    // 等）只是状态广播，不应破坏 worker 正在生成的长 tool_input。
    this._p0InterventionUnsub = this.emitter.subscribe('message:bus:priority', (data) => {
      const action = decideAgentP0Action(data, this.busName);
      if (
        action.kind === 'abort' &&
        this.currentLlmAbortController &&
        this.interventionHandler.shouldAbort(data)
      ) {
        agentLogger.info(
          `[Intervention] 收到来自 @${action.sender} 的紧急指令(${action.type})，中断当前 LLM 调用`,
        );
        this.currentLlmAbortController.abort(`P0 ${action.type} from @${action.sender}`);
      }
    });
  }

  protected resolveContextLimit(model: string): number {
    const providerCtx = getContextWindowSizeFromProvider(model);
    if (providerCtx && providerCtx > 0) return providerCtx;
    const info = getModelDevInfo(model);
    if (info?.contextLimit && info.contextLimit > 0) return info.contextLimit;
    const configuredLimit = Number(runtimeConfig.llm?.context_max_tokens);
    return Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : LLM.CONTEXT_MAX_TOKENS;
  }

  /**
   * 执行上下文压缩：优先用 ContextDAG 结构性压缩（每次从当前消息无状态重建图）；
   * fallback 到保留 system + 最近 15 条。
   */
  private performContextReset(): void {
    try {
      // ContextDAG 已初始化时，用结构性三趟压缩（依赖安全、配对安全、确定性）。
      // 关键：每次从 this.messages 重建图（fromMessages），否则 DAG 为空、什么也压不掉。
      if (this.contextDAG) {
        this.contextDAG.fromMessages(this.messages);
        const estimate = this.contextDAG.getActiveTokenEstimate();
        if (estimate > 0) {
          const target = Math.floor(estimate * 0.4); // 释放约 40% 空间
          const result = this.contextDAG.structuralTrim(target);
          if (result.tokensFreed > 0 || result.compressedCount > 0 || result.archivedCount > 0) {
            // 用 toMessages 重建配对安全的消息序列（保留 role/tool_calls/tool_call_id，
            // 仅旧内容替换为 breadcrumb；出口过 sanitizer 兜底）。
            this.messages = this.contextDAG.toMessages();
            agentLogger.info(
              `Agent ${this.name} DAG 结构性压缩完成: 释放 ~${result.tokensFreed} tokens, 压缩 ${result.compressedCount} 节点, 归档 ${result.archivedCount} 节点, 剩余 ${result.remainingCount} 条`,
            );
            return;
          }
        }
      }

      // Fallback: 传统硬重置
      const systemMsg = this.messages[0];
      const runtimeContractPack = this.messages.find(msg => this.isRuntimeContractPackMessage(msg));
      this.messages = this.contextManager.hardReset({
        messages: this.messages,
        preservedMessages: [systemMsg, runtimeContractPack].filter(Boolean) as ChatMessage[],
        recentCount: 15,
        reason: 'agent_context_overflow',
      });
      agentLogger.info(`Agent ${this.name} 上下文压缩完成，保留 ${this.messages.length} 条消息`);
    } catch (error) {
      agentLogger.error(`Agent ${this.name} 上下文压缩失败:`, error);
    }
  }

  /** 延迟初始化 ContextDAG */
  private async initContextDAG(): Promise<void> {
    try {
      const { ContextDAG } = await import('../core/compress/ContextDAG.js');
      this.contextDAG = new ContextDAG();
    } catch {
      // 模块不可用时静默降级
      this.contextDAG = null;
    }
  }

  /**
   * 添加消息到对话历史，带 Ring Buffer 保护
   */
  addMessage(msg: ChatMessage): void {
    const before = this.messages.length;
    this.messages = this.contextController.addMessage(msg, this.messages);
    if (before >= MAX_AGENT_MESSAGES || this.messages.length < before + 1) {
      agentLogger.debug(`Ring Buffer 触发，当前消息数: ${this.messages.length}`);
    }
  }

  private isRuntimeContractPackMessage(msg: ChatMessage): boolean {
    return this.contextController.isRuntimeContractPackMessage(msg);
  }

  private collapseRuntimeContractPackMessages(messages: ChatMessage[]): ChatMessage[] {
    return this.contextController.collapseContractPacks(messages);
  }

  private upsertSystemContextMessage(content: string): ChatMessage {
    // 定位 content 属于哪个 worker 状态镜像槽（确定性精确匹配，非启发式）。
    let matched: SystemSlotMatcher | null = null;
    for (const matcher of WORKER_SYSTEM_SLOTS) {
      if (matchesSystemSlot(content, matcher)) { matched = matcher; break; }
    }
    if (matched) {
      const result = upsertSystemSlot(this.messages, matched, content);
      this.messages = result.messages;
      return result.message;
    }
    // 非槽内容（事件/指令）：append。
    const message: ChatMessage = { role: 'system', content, timestamp: Date.now() / 1000 };
    this.addMessage(message);
    return message;
  }

  /**
   * 预置继承历史，供 run() 在初始化阶段 weave 进消息序列。
   *
   * Why 不直接 addMessage：worker 子进程以 isResume=false 启动，run() 会走
   * initializeMessages → this.messages=[] 清空。所以历史必须存到 inheritedHistory 字段，
   * 由 run() 优先识别后通过 initializeMessagesFromInherited 注入。
   */
  seedInheritedHistory(history: ChatMessage[], mode: 'resume' | 'new_task' = 'new_task'): void {
    this.inheritedHistory = this.collapseRuntimeContractPackMessages(history);
    this.inheritedHistoryMode = mode;
  }

  protected trimMessageBuffer(
    messages: ChatMessage[],
    protectedCount: number,
    maxMessages: number,
  ): ChatMessage[] {
    return this.contextController.trimMessageBuffer(messages, protectedCount, maxMessages);
  }

  /**
   * 获取增强的系统提示
   * 返回稳定核心（可被 Anthropic cache 缓存）+ 动态附加（不缓存）
   */
  protected getEnhancedSystemPrompt(): string {
    let prompt = this.systemPrompt;
    if (ENABLE_THINKING_INSTRUCTION) {
      prompt = BaseAgent.THINKING_INSTRUCTION + '\n\n' + prompt;
    }

    // 自动注入会话空间信息（替代已移除的 session_info 工具）
    prompt += '\n\n--- 会话空间 ---\n';
    prompt += `会话 ID: ${this.sessionId}\n`;
    prompt += `工作区根目录: ${this.workspace}\n`;
    const sessionDir = `${this.workspace}/.lingxiao/sessions/${this.sessionId}`;
    prompt += `Session 目录: ${sessionDir}\n`;
    prompt += `Scratchpad 目录: ${sessionDir}/scratchpad\n`;
    prompt += `Context 目录: ${sessionDir}/context\n`;
    prompt += '\n使用约定：\n';
    prompt += '- shell 命令可直接使用环境变量：$LINGXIAO_SESSION_ID / $LINGXIAO_SESSION_DIR / $LINGXIAO_SCRATCHPAD_DIR\n';
    prompt += '- 当前任务 scratchpad 命名规则：T-<任务号>_<角色>.md\n';
    prompt += '- 路径以上述返回值为准，scratchpad/ 相对路径使用注入的真实目录计算\n';
    prompt += '- 查找当前任务报告时，可优先读取当前 Scratchpad\n';

    // 工作笔记能力说明（稳定内容，可以缓存）
    prompt += '\n\n--- 工作笔记 ---\n'
      + '你可以通过 `write_work_note` 工具记录当前进展摘要，任务指令中包含详细字段说明和必填要求。\n'
      + '如需了解前序任务的成果，任务指令中的 Context Manifest 包含前序笔记摘要；\n'
      + '需要完整细节时，调用 `read_work_notes` 读取完整笔记。\n'
      + '收到 Leader 的 `request_work_note` 消息时，请主动更新你的工作笔记。';

    prompt += '\n\n--- 可验证假设 ---\n'
      + '在基于未确认的 API 行为、类型结构、文件内容或测试结果继续实现前，先调用 `declare_assumption`。\n'
      + '每个假设必须包含 verification_type、target、expected；expected 是精确证据文本，不是置信度或主观判断。\n'
      + '相关文件被写入后系统会自动验证；若假设被证伪，你会收到 system 反馈，必须停止当前错误方向并修正理解。';

    return prompt;
  }

  /**
   * 获取动态上下文（长期记忆索引等）— 作为统一 Context Manifest 注入，
   * 不混入主 system prompt，避免动态内容变化导致 Anthropic prompt cache 失效
   */
  protected getDynamicContext(): string | null {
    try {
      if (getConfigValue('memory.enabled') === false) return null;
      const memoryManager = new MemoryManager(this.workspace);
      const memoryContent = memoryManager.getAllIndexContent({ tokenBudget: 1_200, maxEntriesPerScope: 12 });
      if (memoryContent) {
        return renderContextManifest({
          scope: 'worker',
          slot: 'worker_runtime',
          sessionId: this.sessionId,
          persistentMemoryIndex: memoryContent,
        });
      }
    } catch { /* memory not available */ }
    return null;
  }

  protected buildRuntimeContextFingerprint(): string | null {
    const state = this.contextManager.getRuntimeState();
    if (
      state.recentFiles.length === 0 &&
      state.warningLevel === 'ok' &&
      state.consecutiveFailures === 0 &&
      !state.lastArchivePath &&
      state.compactHistory.length === 0
    ) {
      return null;
    }
    return JSON.stringify({
      warningLevel: state.warningLevel,
      consecutiveFailures: state.consecutiveFailures,
      lastArchivePath: state.lastArchivePath || null,
      lastCompact: state.lastCompact
        ? {
            timestamp: state.lastCompact.timestamp,
            oldTokens: state.lastCompact.oldTokens,
            newTokens: state.lastCompact.newTokens,
            archivePath: state.lastCompact.archivePath || null,
          }
        : null,
      recentFiles: state.recentFiles.map((file) => ({
        path: file.path,
        timestamp: file.timestamp,
        charCount: file.charCount,
        tokenEstimate: file.tokenEstimate,
      })),
    });
  }

  protected buildAgentArtifactManifest(): ContextManifestAgentArtifact[] {
    const toolTrace = this.buildToolTraceSnapshot();
    const artifacts = this.attemptCompletion?.artifacts;
    const verification = this.attemptCompletion?.verification;
    if (
      toolTrace.files_created.length === 0 &&
      toolTrace.files_modified.length === 0 &&
      toolTrace.commands_run.length === 0 &&
      !this.attemptCompletion?.summary &&
      !artifacts &&
      !verification?.length &&
      !this.attemptCompletion?.evidence_refs?.length &&
      !this.attemptCompletion?.contract_compliance
    ) {
      return [];
    }
    return [{
      source: 'worker_runtime',
      taskId: this.currentTaskId || undefined,
      agentId: this.agentId,
      summary: this.attemptCompletion?.summary,
      filesCreated: [...(artifacts?.files_created ?? []), ...toolTrace.files_created],
      filesModified: [...(artifacts?.files_modified ?? []), ...toolTrace.files_modified],
      commandsRun: [...(artifacts?.commands_run ?? []), ...toolTrace.commands_run],
      evidenceRefs: this.attemptCompletion?.evidence_refs,
      contractCompliance: this.attemptCompletion?.contract_compliance,
      toolTrace: {
        filesCreated: toolTrace.files_created,
        filesModified: toolTrace.files_modified,
        commandsRun: toolTrace.commands_run,
      },
      verification,
      nextSteps: this.attemptCompletion?.next_steps,
    }];
  }

  protected async appendRuntimeContextManifestIfChanged(): Promise<boolean> {
    const fingerprint = this.buildRuntimeContextFingerprint();
    const artifactManifest = this.buildAgentArtifactManifest();
    const combinedFingerprint = JSON.stringify({
      runtime: fingerprint,
      artifacts: artifactManifest,
    });
    if ((!fingerprint && artifactManifest.length === 0) || combinedFingerprint === this.lastRuntimeContextFingerprint) {
      return false;
    }

    this.lastRuntimeContextFingerprint = combinedFingerprint;
    // worker_runtime 槽 in-place 注入（带 slot 标记），单槽不堆积；不每轮落库
    // （manifest 是可重算状态镜像，worker 子进程内存即真理，崩溃重算无损）。
    this.upsertSystemContextMessage(renderContextManifest({
      scope: 'worker',
      slot: 'worker_runtime',
      sessionId: this.sessionId,
      runtime: this.contextManager.getRuntimeState(),
      agentArtifacts: artifactManifest,
    }));
    return true;
  }

  /**
   * 获取工具定义。尊重角色工具白名单，避免所有 agent 都携带全量工具 schema。
   * 接入 ToolPruner：硬模式过滤 + 确定性 token 预算裁剪。
   */
  protected async getToolDefinitions(task?: Task): Promise<ToolDefinition[] | undefined> {
    const allowedTools = this.toolNames.length > 0 ? this.toolNames : undefined;
    const modes = this.db
      ? resolveModeRuntimeProjection({
          sessionId: this.sessionId,
          db: this.db,
          permissionContext: this.getPermissionContext(),
          blackboardAvailable: Boolean(this.blackboardGraph),
        })
      : undefined;
    let callerInTeamRoster = false;
    let callerIsTeamLeader = false;
    if (modes?.collaboration.teamEnabled && this.db) {
      try {
        const member = getTeamMemberRegistry().getByName(this.name, this.sessionId);
        callerInTeamRoster = Boolean(member);
        callerIsTeamLeader = member?.role === 'leader';
      } catch {
        callerInTeamRoster = false;
        callerIsTeamLeader = false;
      }
    }
    let definitions = this.tools.getDefinitions(allowedTools, {
      scope: 'worker',
      ...(modes
        ? {
            modePolicy: {
              modes,
              actor: callerInTeamRoster ? 'team_member' : 'worker',
              agentName: this.name,
              callerInTeamRoster,
              callerIsTeamLeader,
            },
          }
        : {}),
    });
    if (!definitions || definitions.length === 0) return definitions;

    const officeMode = this.db?.getSessionState(this.sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
    if (!officeMode) {
      const officeNames: ReadonlySet<string> = new Set(OFFICE_TOOL_NAMES);
      definitions = definitions.filter((tool) => !officeNames.has(tool.function.name));
    }

    // 推断执行模式
    const mode: ToolPrunerMode = this.inferToolPrunerMode();
    const tokenBudget = BUDGET.TOOLS_DEFAULT_BUDGET;

    const result = await pruneTools(definitions, {
      mode,
      tokenBudget,
      // Keep the worker hot path deterministic: semantic tool selection is an
      // extra LLM request before the real worker round and can dominate latency.
      context: {
        sessionId: this.sessionId,
        agentId: this.agentId,
        agentName: this.name,
        role: this.role,
        task,
        recentMessages: this.messages,
      },
    });
    if (result.removedTools.length > 0) {
      agentLogger.debug(`[ToolPruner] ${this.name}: removed ${result.removedTools.length} tools (${result.originalTokens}→${result.finalTokens} tokens, status=${result.selectionStatus})`);
    }
    return result.tools;
  }

  /**
   * 推断 ToolPruner 执行模式：根据 agent 的 toolNames 判断。
   */
  private inferToolPrunerMode(): ToolPrunerMode {
    const hasBughunt = this.toolNames.some((t) => (BUGHUNT_MODE_TOOL_NAMES as readonly string[]).includes(t));
    if (hasBughunt) return 'bughunt';

    const officeMode = this.db?.getSessionState(this.sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
    if (officeMode) return 'office';

    const hasBlackboard = Boolean(this.blackboardGraph) && this.toolNames.some(t => t === 'blackboard');
    if (hasBlackboard) return 'blackboard';

    return 'normal';
  }

  /**
   * 记录 Agent 事件到数据库
   */
  protected async logEvent(eventType: string, content: Record<string, unknown>): Promise<void> {
    if (this.db) {
      try {
        this.db.insertAgentLog({
          session_id: this.sessionId,
          agent_id: this.agentId,
          agent_name: this.name,
          agent_role: this.role,
          task_id: this.currentTaskId || '',
          event_type: eventType,
        content: JSON.stringify(content),
        timestamp: Date.now() / 1000,
      });
      } catch (err) {
        agentLogger.debug(`[${this.name}] logEvent(${eventType}) DB write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private getAssumptionTracker(): AssumptionTracker | undefined {
    if (!this.db) return undefined;
    const projectRoot = this.currentTaskWorkingDirectory || this.workspace;
    if (!this.assumptionTracker || this.assumptionTrackerProjectRoot !== projectRoot) {
      this.assumptionTracker = new AssumptionTracker({
        db: this.db,
        emitter: this.emitter,
        logger: agentLogger,
        sessionId: this.sessionId,
        projectRoot,
      });
      this.assumptionTrackerProjectRoot = projectRoot;
    }
    return this.assumptionTracker;
  }

  private async handleAssumptionFeedback(batch: VerificationBatch): Promise<void> {
    if (batch.falsified.length === 0) return;
    const content = [
      '[假设证伪] 以下假设已被运行时证据证伪，请停止当前错误方向，修正理解后继续。',
      ...batch.falsified.map((item) => `- ${item.id}: ${item.evidence}${item.dependents.length > 0 ? `; dependents=${item.dependents.join(',')}` : ''}`),
    ].join('\n');
    const message: ChatMessage = { role: 'system', content };
    this.addMessage(message);
    try {
      await this.db?.saveAgentMessage?.(this.sessionId, this.agentId, this.name, message);
    } catch (error) {
      agentLogger.warn(`[${this.name}] 保存假设证伪反馈失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.emitter.emit('agent:message', {
      agentId: this.agentId,
      message: content,
    });
  }

  /**
   * 构建任务提示词，包含技能注入
   */
  protected buildTaskPrompt(task: Task): string {
    const globalSkills = join(homedir(), '.lingxiao', 'skills');
    const projectSkills = join(this.workspace, '.lingxiao', 'skills');
    const disabledNames = resolveDisabledSkillNames();
    const availableSkills = collectAvailableSkills(this.workspace, { disabledNames });

    const taskDescription = task.description;
    const explicitSkills = resolveExplicitSkillMentions(`${taskDescription}\n${this.systemPrompt}`, availableSkills);
    const officeMode = this.db?.getSessionState(this.sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
    const officeSkill = officeMode && availableSkills.some((skill) => skill.name === OFFICE_SUITE_SKILL_NAME)
      ? [OFFICE_SUITE_SKILL_NAME]
      : [];
    const mergedSkillNames = Array.from(new Set([...this.skillNames, ...explicitSkills, ...officeSkill]));
    const injectedSkills = buildSkillInjection(mergedSkillNames, availableSkills, {
      maxTotalChars: 18_000,
      maxPerSkillChars: 7_500,
    });
    if (injectedSkills.names.length > 0) {
      agentLogger.info(`注入技能: ${injectedSkills.names.join(', ')}`);
      // Record real usage so distill's C gate can later refine proven skills (N5-A).
      try {
        const usageStore = new AssetUsageStore(join(this.workspace, '.lingxiao'));
        for (const name of injectedSkills.names) {
          usageStore.recordUsage({
            assetRef: `skills/${name}`,
            kind: 'skill_injected',
            sessionId: this.sessionId,
            taskId: task.id,
            timestamp: Date.now(),
          });
        }
      } catch { /* usage tracking is best-effort, never breaks injection */ }
    }
    const configuredToolNames = new Set(this.toolNames);
    const toolSurface: ContextManifestToolSurface = {
      tools: this.toolNames.length > 0 ? this.toolNames : this.tools.getAll().map((tool) => tool.name),
      required: [
        ...REQUIRED_AGENT_CONTRACT_TOOLS,
        ...REQUIRED_TEAM_CONTRACT_TOOLS.filter((name) => configuredToolNames.has(name)),
      ],
      mode: this.inferToolPrunerMode(),
    };
    const enabledPlugins = discoverPlugins(this.workspace).filter((plugin) => plugin.enabled);
    const pluginSurface: ContextManifestPluginSurface = {
      sources: enabledPlugins.map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        path: plugin.path,
        manifestPath: plugin.manifestPath,
        scope: plugin.scope,
        enabled: plugin.enabled,
      })),
      runtime: enabledPlugins.flatMap((plugin) => [
        ...(plugin.contributions.skills.length > 0 ? [`${plugin.id}:skills`] : []),
        ...(plugin.contributions.mcp.length > 0 ? [`${plugin.id}:mcp`] : []),
      ]),
      nonRuntime: enabledPlugins.flatMap((plugin) => [
        ...(plugin.contributions.apps.length > 0 ? [`${plugin.id}:apps`] : []),
        ...(plugin.contributions.assets.length > 0 ? [`${plugin.id}:assets`] : []),
        ...(plugin.contributions.tools.length > 0 ? [`${plugin.id}:tools(non-runtime)`] : []),
        ...(plugin.contributions.hooks.length > 0 ? [`${plugin.id}:hooks(non-runtime)`] : []),
        ...(plugin.contributions.scripts.length > 0 ? [`${plugin.id}:scripts(non-runtime)`] : []),
      ]),
    };
    const mcpSurface: ContextManifestMcpSurface = {
      servers: enabledPlugins.flatMap((plugin) => plugin.contributions.mcp.map((mcp) => ({
        id: mcp.server.id,
        name: mcp.server.name,
        version: mcp.server.registry?.version || mcp.pluginVersion,
        schemaVersion: mcp.server.registry?.source_id,
      }))),
    };
    const runtimeModes = this.db
      ? resolveModeRuntimeProjection({
          sessionId: this.sessionId,
          db: this.db,
          permissionContext: this.getPermissionContext(),
          blackboardAvailable: Boolean(this.blackboardGraph),
        })
      : undefined;
    let teamCommunicationEnabled = false;
    if (runtimeModes?.collaboration.teamEnabled && this.db) {
      try {
        teamCommunicationEnabled = Boolean(getTeamMemberRegistry().getByName(this.name, this.sessionId));
      } catch {
        teamCommunicationEnabled = false;
      }
    }
    const activeModes = [
      this.inferToolPrunerMode(),
      ...(teamCommunicationEnabled ? ['team'] : []),
      ...(officeMode ? ['office'] : []),
      ...(this.blackboardGraph ? ['blackboard'] : []),
    ];
    const modes: ContextManifestModeSurface = {
      active: Array.from(new Set(activeModes.filter((mode) => mode && mode !== 'normal'))),
      notes: [
        'mode injection is an additive surface; core contracts remain Context Manifest, ToolRegistry, MCP, and blackboard.',
      ],
    };

    return buildWorkerTaskPrompt({
      task: {
        id: task.id,
        subject: task.subject,
        description: taskDescription,
        context: task.context,
        working_directory: task.working_directory,
        write_scope: task.write_scope,
      },
      workspace: this.workspace,
      sessionId: this.sessionId,
      role: this.role,
      globalSkillsDir: globalSkills,
      projectSkillsDir: projectSkills,
      injectedSkills,
      toolSurface,
      pluginSurface,
      mcpSurface,
      modes,
      agentArtifacts: this.buildAgentArtifactManifest(),
      blackboardEnabled: this.toolNames.some(t => t === 'blackboard'),
    });
  }

  /**
   * 初始化消息列表
   */
  protected async initializeMessages(task: Task): Promise<void> {
    this.messages = [];

    // 多模态上下文注入
    const initialMessages: ChatMessage[] = [];
    const MAX_INITIAL_IMAGES = normalizeImageRetainRounds(getConfigValue('advanced.image_history_retain_rounds'));

    if (this.db) {
      // 获取最近的多模态消息
      try {
        const recentHistory = await this.db.getRecentMultimodalMessages?.(this.sessionId, MAX_INITIAL_IMAGES);
        if (recentHistory) {
          for (const msg of recentHistory) {
            if (typeof msg.content === 'object' && Array.isArray(msg.content)) {
              initialMessages.push(msg as ChatMessage);
            }
          }
        }
      } catch (e) {
        agentLogger.warn(`获取多模态上下文失败:`, e);
      }

      if (initialMessages.length > 0) {
        agentLogger.info(`注入了 ${initialMessages.length} 条多模态上下文`);
        initialMessages.push({
          role: 'assistant',
          content: '我已经查看了会话中提供的视觉信息。现在我准备好处理你分配的任务了。',
        });
      }
    }

    const taskPrompt = this.buildTaskPrompt(task);

    this.addMessage({
      role: 'system',
      content: this.getEnhancedSystemPrompt(),
    });

    // 动态上下文（记忆索引等）作为独立 system 消息注入
    // 这样动态内容变化不会导致 Anthropic prompt cache 失效
    const dynamicContext = this.getDynamicContext();
    if (dynamicContext) {
      // worker_runtime 槽 in-place（与每轮 appendRuntimeContextManifestIfChanged 同槽），单槽不堆积。
      this.upsertSystemContextMessage(dynamicContext);
    }

    for (const msg of initialMessages) {
      this.addMessage(msg);
    }

    this.addMessage({
      role: 'user',
      content: `${'='.repeat(40)}\n任务指令:\n${'='.repeat(40)}\n${taskPrompt}`,
    });

    // 保存初始对话
    if (this.db) {
      for (const msg of this.messages) {
        await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, msg);
      }
      await this.db.saveAgentState?.({
        session_id: this.sessionId,
        agent_id: this.agentId,
        agent_name: this.name,
        agent_role: this.role,
        task_id: task.id,
        status: 'running',
        stopped: 0,
        iteration: 0,
        timestamp: Date.now() / 1000,
      });
    }
    this.persistResumeCheckpoint(task);
  }

  /**
   * 继承历史对话的初始化：worker 子进程总以 isResume=false 启动，run() 默认会
   * initializeMessages → this.messages=[]，把 WorkerProcessEntry 预注入的历史清空。
   * 所以"继承上下文"统一收敛到这里，由 run() 在 inheritedHistory 非空时优先走本方法。
   *
   * 两种语义（inheritedHistoryMode）：
   *   - 'resume'（追问 / team 复活同一个任务）：历史即完整对话基底，不再注入任务指令，
   *     后续推进由随后投递的 leaderMessage / inbox 干预驱动；恢复 toolCallCount 进度。
   *   - 'new_task'（复用同名 worker 跑新任务）：历史作为背景上下文，追加一条 user 分隔说明
   *     + 新任务指令 user 消息；进度按新任务从 0 起（initializeTaskScope 已在 run 开头重置）。
   *
   * 持久化：历史早已在 DB（上一轮同 agentId 保存），只回写本次新追加的消息，
   * 避免下次复用时 agent_conversation 翻倍。
   */
  protected async initializeMessagesFromInherited(
    task: Task,
    recoveredIteration = 0,
    recoveredToolCallCount = 0,
  ): Promise<void> {
    const inherited = this.inheritedHistory ?? [];
    // 收敛继承历史中 append-only 累积的状态镜像槽位（contract pack + worker manifest），
    // 每槽只留最后一条，治本历史残留堆积（inheritedHistory 可能含旧 worker 多条 manifest）。
    this.messages = collapseSystemSlots([...inherited], WORKER_SYSTEM_SLOTS);

    if (this.inheritedHistoryMode === 'resume') {
      // 自愈中断孤儿：worker 被 kill 后恢复时，assistant 发起的 tool_call 可能
      // 缺配对 tool_result（assistant 已落库、result 未落库）。
      // 补语义占位，避免 provider 反复合成 [tool result missing]。
      const { healed, addedCount } = healInterruptedToolCalls(this.messages);
      if (addedCount > 0) {
        agentLogger.warn(`[WorkerResumeHeal] 检测到 ${addedCount} 个中断孤儿 tool_call，补占位`);
        this.messages = healed;
      }
      this.runtimeState.restoreProgress(
        recoveredIteration,
        recoveredToolCallCount || inherited.filter(m => m.role === 'tool').length,
      );
      agentLogger.info(`♻️ 复活 worker 恢复对话历史 (共 ${inherited.length} 条消息)`);
      this.persistResumeCheckpoint(task);
      return;
    }

    const taskPrompt = this.buildTaskPrompt(task);
    const newMessages: ChatMessage[] = [
      {
        role: 'user',
        content:
          '以上是你在本会话中之前任务积累的上下文（保留以便你复用对代码库、环境与既有产出的了解）。' +
          '现在你接到一个新任务，请基于已有了解继续，并以当前任务指令作为完成状态的唯一依据。',
      },
      {
        role: 'user',
        content: `${'='.repeat(40)}\n任务指令:\n${'='.repeat(40)}\n${taskPrompt}`,
      },
    ];
    for (const msg of newMessages) {
      this.addMessage(msg);
    }

    if (this.db) {
      for (const msg of newMessages) {
        await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, msg);
      }
      await this.db.saveAgentState?.({
        session_id: this.sessionId,
        agent_id: this.agentId,
        agent_name: this.name,
        agent_role: this.role,
        task_id: task.id,
        status: 'running',
        stopped: 0,
        iteration: 0,
        timestamp: Date.now() / 1000,
      });
    }
    agentLogger.info(`🔗 复用同名 worker 继承上下文 (继承 ${inherited.length} 条历史 + 新任务指令)`);
    this.persistResumeCheckpoint(task);
  }

  /**
   * 执行工具调用
   */
  protected async executeToolCall(toolCall: ToolCall): Promise<ToolResultContent> {
    const { name, arguments: argsStr } = toolCall.function;
    let args: unknown;
    try {
      args = JSON.parse(argsStr);
    } catch (error) {
      return `ERROR: 工具参数 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}\n原始参数: ${argsStr.slice(0, 500)}`;
    }

    const heartbeat = startToolProgressHeartbeat({
      emitter: this.emitter,
      toolCall,
      sessionId: this.sessionId,
      agentId: this.agentId,
      agentName: this.name,
      taskId: this.currentTaskId || undefined,
      scope: 'agent',
    });

    const __toolCallStart = Date.now();
    try {
      const assumptionTracker = this.getAssumptionTracker();
      const assumptionFeedback = (batch: VerificationBatch) => this.handleAssumptionFeedback(batch);
      let result = await this.tools.execute(name, args, {
        db: this.db,
        sessionId: this.sessionId,
        agentId: this.agentId,
        agentName: this.name,
        workspace: this.workspace,
        emitter: this.emitter,
        bus: this.bus,
        permissionContext: this.getPermissionContext(),
        llm: this.llm,
        model: this.model,
        toolCallId: toolCall.id,
        taskId: this.currentTaskId || undefined,
        taskWorkingDirectory: this.currentTaskWorkingDirectory || undefined,
        taskWriteScope: this.currentTaskWriteScope,
        contractAllowedScope: this.currentContractAllowedScope,
        blackboardGraph: this.blackboardGraph,
        assumptionTracker,
        assumptionFeedback,
        workflowManager: this.workflowManager,
        workflowEngine: this.workflowEngine,
        scheduledTaskManager: this.scheduledTaskManager,
        toolRegistry: this.tools,
        gitIdentity: this.gitIdentity,
      });

      // ── ToolFailureLoopGuard：失败先记账，再决定是否重试 ──
      // 任何工具失败（无论 success=false 还是 PERMISSION_REQUIRED 路径）都先进入 guard
      // 计数；同 toolName+argsHash+errorKind 累计达阈值时 guard.tripped=true，
      // 此时不再走本地 PERMISSION_REQUIRED 重试（避免 LLM 自循环），转而构造熔断
      // 错误返回给上层，Leader/Health 侧通过 agent:tool_failure_loop 事件响应。
      if (!result.success) {
        const failureDecision = this.recordToolFailure(name, args, result.error);
        if (failureDecision.tripped) {
          // 状态类错误必须升级；其他类型也立即返回熔断结果（防止 LLM 继续调同一 key）
          const trippedError = formatToolFailureLoopError(name, failureDecision);
          this.logEvent('tool_failure_loop_tripped', {
            toolName: name,
            argsHash: failureDecision.signature.argsHash,
            errorKind: failureDecision.errorKind,
            errorCode: failureDecision.signature.errorCode,
            count: failureDecision.count,
            threshold: failureDecision.count + 1,
            requiresEscalation: failureDecision.requiresEscalation,
          }).catch(() => {});
          this.emitter.emit('agent:status', {
            agentId: this.agentId,
            agentName: this.name,
            sessionId: this.sessionId,
            status: failureDecision.requiresEscalation
              ? `🛑 工具 "${name}" 连续 ${failureDecision.count} 次失败（${failureDecision.errorKind}），已停止自循环，需 Leader 介入`
              : `⚠️ 工具 "${name}" 连续 ${failureDecision.count} 次失败（${failureDecision.errorKind}），已停止自循环`,
          });
          // 升级到 Leader：bus 发 tool_failure_loop_escalation 消息，LeaderPermissionManager
          // 据 errorKind 自动选众合理动作（自动放行 / 拒绝 / 交互审批）。仅 worker 侧发送；
          // leader 自身不需自升级（这里 name === 'leader' 的场景在 BaseAgentRuntime 中不执行）。
          if (this.bus && this.name !== 'leader') {
            const escalationRequestId = `tfl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            try {
              this.bus.send(
                this.busName,
                this.leaderBusName,
                'tool_failure_loop_escalation',
                createToolFailureLoopEscalationPayload({
                  requestId: escalationRequestId,
                  workerName: this.name,
                  toolName: name,
                  argsHash: failureDecision.signature.argsHash,
                  errorKind: failureDecision.errorKind,
                  errorCode: failureDecision.signature.errorCode,
                  count: failureDecision.count,
                  requiresEscalation: failureDecision.requiresEscalation,
                  lastErrorMessage: String(result.error || '').split('\n\nLLM_RECOVERY=')[0] || '',
                }),
              );
            } catch {
              // bus 发送失败不应阻断熔断主路径
            }
          }
          // 失败路径：跳过 PERMISSION_REQUIRED 本地重试（避免 LLM 在已熔断的调用上耗 round）
          return `ERROR: ${trippedError}`;
        }
      }

      if (!result.success && String(result.error || '').startsWith('PERMISSION_REQUIRED:')) {
        const approved = await this.requestPermissionFromLeader(name, String(result.error || ''));
        if (approved) {
          result = await this.tools.execute(name, args, {
            db: this.db,
            sessionId: this.sessionId,
            agentId: this.agentId,
            agentName: this.name,
            workspace: this.workspace,
            emitter: this.emitter,
            bus: this.bus,
            permissionContext: this.getPermissionContext(),
            llm: this.llm,
            model: this.model,
            toolCallId: toolCall.id,
            taskId: this.currentTaskId || undefined,
            taskWorkingDirectory: this.currentTaskWorkingDirectory || undefined,
            taskWriteScope: this.currentTaskWriteScope,
        contractAllowedScope: this.currentContractAllowedScope,
            blackboardGraph: this.blackboardGraph,
            assumptionTracker,
            assumptionFeedback,
            workflowManager: this.workflowManager,
            workflowEngine: this.workflowEngine,
            scheduledTaskManager: this.scheduledTaskManager,
            toolRegistry: this.tools,
            gitIdentity: this.gitIdentity,
          });
        }
      }

      // Langfuse tool call tracing (non-fatal, fire-and-forget)
      langfuseIntegration.recordToolCall({
        toolName: name,
        args,
        status: result.success ? 'ok' : 'error',
        latencyMs: Date.now() - __toolCallStart,
        agentId: this.agentId,
        agentName: this.name,
        taskId: this.currentTaskId || undefined,
        sessionId: this.sessionId,
        errorMessage: result.success ? undefined : String(result.error || ''),
      }).catch(() => {});

      if (!result.success) return `ERROR: ${result.error}`;
      // 成功路径：采集工具产物轨迹 + 捕获 attempt_completion 结构化收尾
      this.recordToolTrace(name, args, result.data);
      this.recordContextRead(name, args, result.data);
      const d = result.data;
      if (d === null || d === undefined) return '';

      // ── MCP CallToolResult 提取 ──
      // McpTool.callTool 返回 { success: true, data: CallToolResult }
      // CallToolResult = { content: ContentBlock[], _meta?, isError? }
      // 提取 content 数组为 MessageContentPart[]，并检测 _meta.lingxiao_app 标记
      if (typeof d === 'object' && !Array.isArray(d)
          && Array.isArray((d as Record<string, unknown>).content)
          && name === 'mcp') {
        const callResult = d as { content: Array<Record<string, unknown>>; isError?: boolean };
        if (callResult.isError) {
          const textParts = callResult.content
            .filter(b => b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text as string).join('\n');
          return `ERROR: ${textParts || 'MCP tool returned isError'}`;
        }
        const parts = extractMcpContentParts(callResult.content);
        if (parts.length > 0) return parts;
        // content 为空时回退到 JSON
        return JSON.stringify(d, null, 2);
      }

      if (Array.isArray(d) && d.length > 0 && typeof d[0] === 'object' && 'type' in d[0]) {
        return d as MessageContentPart[];
      }
      if (typeof d === 'string') return d;
      return JSON.stringify(d, null, 2);
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * 采集单次工具调用的产物轨迹 / 捕获 attempt_completion 结构化收尾。
   * 仅在工具执行 success 后调用。失败的工具调用不计入产物。
   */
  protected recordToolTrace(toolName: string, args: unknown, data: unknown): void {
    const a = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {};
    const pathArg = typeof a.path === 'string' ? a.path : undefined;

    switch (toolName) {
      case 'file_create':
        if (pathArg) this.toolTrace.filesCreated.add(pathArg);
        break;
      case 'structured_patch':
        if (pathArg) this.toolTrace.filesModified.add(pathArg);
        break;
      case 'shell': {
        const cmd = typeof a.command === 'string' ? a.command.trim() : '';
        if (cmd) this.toolTrace.commandsRun.push(cmd);
        break;
      }
      case 'python_exec': {
        const code = typeof a.code === 'string' ? a.code.trim() : '';
        if (code) {
          const firstLine = code.split('\n')[0]?.slice(0, 120) ?? '';
          this.toolTrace.commandsRun.push(`python: ${firstLine}`);
        }
        break;
      }
      case 'attempt_completion':
        // AttemptCompletionTool.execute 返回 data = AttemptCompletionStructuredResult
        if (data && typeof data === 'object' && 'summary' in (data as Record<string, unknown>)) {
          this.attemptCompletion = data as AttemptCompletionStructuredResult;
        }
        break;
      default:
        break;
    }
  }

  /**
   * 从 ToolResult.error 文本中提取 LLM_RECOVERY.code（与 createToolError 对齐：error 末尾
   * 形如 `\n\nLLM_RECOVERY={"code":"...","message":"...",...}`）。若不存在则回退到错误前缀匹配。
   */
  protected extractToolErrorCode(errorText: string | undefined): string {
    const text = String(errorText || '');
    if (!text) return '';
    const marker = 'LLM_RECOVERY=';
    const idx = text.lastIndexOf(marker);
    if (idx < 0) {
      // 退化：取首行第一段作为 code（形如 "TOOL_NOT_FOUND: ..."）
      const firstLine = text.split('\n')[0] || '';
      const colonIdx = firstLine.indexOf(':');
      return colonIdx > 0 ? firstLine.slice(0, colonIdx).trim() : firstLine.trim();
    }
    const jsonText = text.slice(idx + marker.length).trim();
    try {
      const parsed = JSON.parse(jsonText) as { code?: unknown };
      return typeof parsed?.code === 'string' ? parsed.code : '';
    } catch {
      return '';
    }
  }

  /**
   * 将一次工具失败计入 ToolFailureLoopGuard。
   * 成功路径不需调用（registry 内部有独立 success 跟踪）。
   */
  protected recordToolFailure(
    toolName: string,
    args: unknown,
    errorText: string | undefined,
  ): LoopGuardDecision {
    const errorCode = this.extractToolErrorCode(errorText);
    const errorMessage = String(errorText || '').split('\n\nLLM_RECOVERY=')[0] || '';
    const guard = getToolFailureLoopGuard(this.emitter);
    return guard.record({
      sessionId: this.sessionId,
      agentId: this.agentId,
      agentName: this.name,
      taskId: this.currentTaskId || undefined,
      toolName,
      args,
      errorCode,
      errorMessage,
    });
  }

  protected recordContextRead(toolName: string, args: unknown, data: unknown): void {
    if (typeof data !== 'string' || data.length === 0) return;
    const a = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {};
    if (toolName === 'file_read' || toolName === 'parse_file') {
      const pathArg = typeof a.path === 'string' ? a.path : '';
      if (pathArg) this.contextManager.trackFileRead(pathArg, data);
      return;
    }
    if (toolName === 'session_artifacts') {
      const action = typeof a.action === 'string' ? a.action : '';
      const artifact = typeof a.artifact === 'string' ? a.artifact : '';
      if (action === 'read' && artifact) {
        this.contextManager.trackFileRead(artifact, data);
      }
    }
  }

  /**
   * 把框架采集的 toolTrace 转成可序列化的产物快照（用于 task_complete payload）。
   * 数组去重，commands 保序去重。
   */
  protected buildToolTraceSnapshot(): {
    files_created: string[];
    files_modified: string[];
    commands_run: string[];
  } {
    const created = Array.from(this.toolTrace.filesCreated);
    const createdSet = new Set(created);
    // 同一文件若先 create 再 edit，归入 created，不重复进 modified
    const modified = Array.from(this.toolTrace.filesModified).filter((p) => !createdSet.has(p));
    const seenCmd = new Set<string>();
    const commands: string[] = [];
    for (const c of this.toolTrace.commandsRun) {
      if (!seenCmd.has(c)) {
        seenCmd.add(c);
        commands.push(c);
      }
    }
    return { files_created: created, files_modified: modified, commands_run: commands };
  }

  protected canBatchExecuteToolCalls(toolCalls: ToolCall[]): boolean {
    return toolCalls.length > 1 && toolCalls.every((toolCall) =>
      BASE_PARALLEL_SAFE_TOOLS.has(toolCall.function.name)
    );
  }

  protected async executeToolCallsBatch(
    toolCalls: ToolCall[],
  ): Promise<Array<{ toolCall: ToolCall; result: ToolResultContent }>> {
    return runToolCallsBatch(
      toolCalls,
      (toolCall: ToolCall) => this.executeToolCall(toolCall),
      BASE_PARALLEL_SAFE_TOOLS,
    );
  }

  protected createToolScheduler(
    options?: { logToolCall?: boolean; wasOutputTruncated?: boolean },
  ): ToolScheduler<{ done: boolean; result?: string }> {
    const logToolCall = options?.logToolCall ?? false;
    const wasTruncated = options?.wasOutputTruncated ?? false;

    // pipeline-flush 契约：注册 Worker 侧 flush 回调。
    // Worker 的 persistToolMessage 是 async（await this.db.saveAgentMessage），
    // 在信号到达时可能尚未 settle。setWorkerFlushFn 注册一个 no-op 回调，
    // 实际保护由 WorkerProcessEntry.flushPendingToolResults 的 3s 超时窗口提供，
    // 确保 clearRuntime()→db.close() 前给 pending async writes 留出 settle 时间。
    setWorkerFlushFn(() => {
      // Worker 即时写 DB，无 pending batch 需要 flush。
      // 此回调存在的意义是让 flushPendingToolResults 不短路（pendingFlushFn !== null），
      // 从而在 clearRuntime() 前留出 3s settle 窗口给在飞的 saveAgentMessage await。
    });
    return new ToolScheduler({
      checkHighPriorityIntervention: async () => {
        // 权限超时终止检查：shouldTerminate 由 requestPermissionFromLeader 设置
        if (this.shouldTerminate) {
          return { done: true, result: '权限审批连续超时，agent 终止' };
        }

        const counts = this.bus.getPendingPriorityCounts(this.busName);
        if (counts.p0 + counts.p1 === 0) {
          return null;
        }

        const shouldStop = await this.checkInbox();
        if (shouldStop) {
          const lastMessage = this.messages[this.messages.length - 1];
          const lastText = lastMessage ? contentToPlainText(lastMessage.content ?? '') : '未知原因';
          return { done: true, result: `被Leader停止: ${lastText || '未知原因'}` };
        }

        return { done: false };
      },
      beforeToolCalls: (toolCalls, context) => {
        if (context?.source === 'raw_xml') {
          agentLogger.warn(`[${this.name}] 检测到原始 XML 工具标签，容错解析出 ${toolCalls.length} 个工具调用`);
          this.emitter.emit('agent:status', {
            agentId: this.agentId,
            agentName: this.name,
            sessionId: this.sessionId,
            status: `⚠️ 格式容错：解析到 ${toolCalls.length} 个工具调用，执行中...`,
          });
        }

        this.runtimeState.recordToolCalls(toolCalls.length);
        this.rawXmlRetryCount = 0;
        return null;
      },
      persistAssistantMessage: async (message) => {
        this.addMessage(message);
        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, message);
        }
      },
      executeToolCallsBatch: (toolCalls) => {
        if (wasTruncated) {
          return executeToolCallsWithTruncationGuard(toolCalls, calls => this.executeToolCallsBatch(calls));
        }
        // 即使 wasOutputTruncated=false，也对文件编辑类工具做空参数保护。
        // 某些 provider 截断时 finish_reason 仍报 'stop' 而非 'length'，
        // 导致 wasOutputTruncated 误判为 false，但 args 实际为空。
        return rejectEmptyArgsFileTools(toolCalls, calls => this.executeToolCallsBatch(calls));
      },
      emitToolCall: (toolCall) => {
        if (logToolCall) {
          agentLogger.debug(`调用工具: ${toolCall.function.name}`);
        }
        this.emitter.emit('agent:tool_call', {
          agentId: this.agentId,
          agentName: this.name,
          sessionId: this.sessionId,
          taskId: this.currentTaskId || undefined,
          callId: toolCall.id,
          tool: toolCall.function.name,
          input: toolCall.function.arguments,
        });
      },
      transformToolResult: (toolCall, rawResult) => truncateAgentToolResult(toolCall.function.name, rawResult, runtimeConfig.agents.tool_result_max_chars),
      persistToolMessage: async (message) => {
        this.addMessage(message);
        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, message);
        }
      },
      emitToolResult: (toolCall, renderedResult) => {
        this.emitter.emit('agent:tool_result', {
          agentId: this.agentId,
          agentName: this.name,
          sessionId: this.sessionId,
          taskId: this.currentTaskId || undefined,
          callId: toolCall.id,
          tool: toolCall.function.name,
          result: renderedResult,
        });
      },
      afterToolResult: async (toolCall) => {
        const toolName = toolCall.function.name;
        if (FILE_MODIFYING_TOOLS.has(toolName)) {
          await this.createAgentFileSnapshot(toolName);
        }
      },
      shouldStopAfterToolResult: () => {
        if (this.attemptCompletion) {
          return { done: true, result: this.attemptCompletion.summary };
        }
        return null;
      },
      afterToolCalls: ({ toolCallContext }) => {
        if (toolCallContext?.source === 'raw_xml') {
          return null;
        }
        return null;
      },
      onEarlyStop: () => {
        // Worker 即时写 DB（无延迟批写），onEarlyStop 无需 flush。
        // 此 hook 作为防御性日志 + 未来批写扩展预留。
        // 真正的自愈由 resume 路径的 healInterruptedToolCalls 兜底。
        agentLogger.info(`[${this.name}] onEarlyStop 触发（worker 即时写 DB，无需 flush）`);
      },
    });
  }

  protected createAgentEventStreamClient(actorLabel: string): ContentGenerator {
    return createEventStreamClient({
      actorLabel,
      llm: this.llm,
      classifyError: classifyLLMError,
      gatewayContext: {
        actorType: 'agent',
        actorLabel,
        purpose: 'agent',
        sessionId: this.sessionId,
        agentId: this.agentId,
        agentName: this.name,
        taskId: this.currentTaskId || undefined,
        role: this.role,
      },
    });
  }

  /**
   * Agent 文件变更 snapshot — 记录 Agent 级别的文件修改操作到 Changes timeline
   */
  protected async createAgentFileSnapshot(toolName: string): Promise<void> {
    try {
      const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
      const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
      const api = new FileChangesApi(new DatabaseRepositoryAdapter(this.db!));
      const iteration = this.runtimeState.toolCallCount;
      const label = `[agent:${this.name}] [task:${this.currentTaskId || 'unknown'}] [tool] Auto: ${toolName}`;
      await api.createSnapshot(this.sessionId, label, {
        agentId: this.agentId,
        agentName: this.name,
        agentRole: this.role,
        taskId: this.currentTaskId || undefined,
      });
    } catch {
      // non-critical: snapshot failure should not break agent execution
    }
  }

  /**
   * 处理 LLM 响应（协调者）
   */
  protected async processResponse(response: ChatResponse, task: Task): Promise<{ done: boolean; result?: string }> {
    recordAgentTokenUsage(response, this.tracker, this.agentId, this.model);

    // 处理原生工具调用
    if (response.tool_calls && response.tool_calls.length > 0) {
      return this.handleNativeToolCalls(response);
    }

    // 没有工具调用，但有文本回复 — 检查是否包含内嵌工具调用
    const final = contentToPlainText(response.content);
    const parsedToolCallResult = this.handleParsedToolCalls(final, response);
    if (parsedToolCallResult) {
      return parsedToolCallResult;
    }

    // 检查是否有无法解析的原始工具语法（格式错乱）
    const rawSyntaxResult = await this.handleRawToolSyntaxRetry(final, response);
    if (rawSyntaxResult) {
      return rawSyntaxResult;
    }

    const hasExplicitFinishReason = Boolean(response.finish_reason);
    if (hasExplicitFinishReason) {
      // 明确的 API 终止/未终止信号先于最终完成守卫处理：
      // - 非 stop: 继续接续
      // - stop: 先尊重 nextSpeaker/stopHook，再要求最终契约证明
      const continuationResult = await this.evaluateContinuation(final, response, task);
      if (continuationResult) {
        return continuationResult;
      }
    }

    // 评估完成状态
    const completionResult = await this.evaluateCompletionAndRetry(final, response, task);
    if (completionResult) {
      return completionResult;
    }

    // 正常完成
    return this.finalizeCompletion(final, task);
  }

  // ─── processResponse 子方法 ───────────────────────────────────────────────

  /**
   * 处理原生 tool_calls（含死循环检测）
   */
  private handleNativeToolCalls(response: ChatResponse): Promise<{ done: boolean; result?: string }> {
    // ── 死循环探针：只对「同 name + 同 args」连续命中累计 ──
    this.toolLoopDetector.observe(response.tool_calls!);
    if (this.toolLoopDetector.isLooping) {
      const sig = this.toolLoopDetector.currentSignature ?? '<unknown>';
      const streak = this.toolLoopDetector.consecutiveCount;
      agentLogger.warn(
        `[${this.name}] 检测到工具死循环：${sig} 连续 ${streak} 次，注入系统提示并跳过本轮执行`,
      );
      this.messages.push({
        role: 'system',
        content:
          `⚠️ [死循环保护] 你已用完全相同的参数连续调用同一个工具 ${streak} 次，这通常意味着策略卡住了。\n` +
          `请：1) 改变参数（不同 file_path / pattern / query），或 2) 切换到另一种工具，或 3) 直接给出当前已知信息的结论。\n` +
          `下一次工具调用请使用新的参数、替代工具或转为结论输出：${sig.split('::')[0]}。`,
      });
      this.toolLoopDetector.reset();
      return Promise.resolve({ done: false });
    }

    const toolScheduler = this.createToolScheduler({ logToolCall: true, wasOutputTruncated: response.was_output_truncated });
    return toolScheduler.run({
      assistantContent: response.content,
      toolCalls: response.tool_calls!,
      thinking: response.thinking,
      wasOutputTruncated: response.was_output_truncated,
      toolCallContext: { source: 'native' },
    });
  }

  /**
   * 尝试从纯文本解析内嵌工具调用并执行（含死循环检测）
   * 返回 null 表示没有可解析的工具调用
   */
  private handleParsedToolCalls(final: string, response: ChatResponse): Promise<{ done: boolean; result?: string }> | null {
    const parsedToolCalls = parseRawToolCalls(final);
    if (!parsedToolCalls) {
      return null;
    }

    this.toolLoopDetector.observe(parsedToolCalls);
    if (this.toolLoopDetector.isLooping) {
      const sig = this.toolLoopDetector.currentSignature ?? '<unknown>';
      const streak = this.toolLoopDetector.consecutiveCount;
      agentLogger.warn(
        `[${this.name}] 检测到工具死循环（raw_xml）：${sig} 连续 ${streak} 次`,
      );
      this.messages.push({
        role: 'system',
        content:
          `⚠️ [死循环保护] 你已用完全相同的参数连续调用同一个工具 ${streak} 次，请改变参数或切换工具。`,
      });
      this.toolLoopDetector.reset();
      return Promise.resolve({ done: false });
    }
    const toolScheduler = this.createToolScheduler({ wasOutputTruncated: response.was_output_truncated });
    return toolScheduler.run({
      assistantContent: final,
      toolCalls: parsedToolCalls,
      thinking: response.thinking,
      wasOutputTruncated: response.was_output_truncated,
      toolCallContext: { source: 'raw_xml' },
    });
  }

  /**
   * 处理包含无法解析的原始工具语法（格式错乱）的情况
   * 返回 null 表示不包含原始工具语法
   */
  private async handleRawToolSyntaxRetry(final: string, response: ChatResponse): Promise<{ done: boolean; result?: string } | null> {
    if (!hasRawToolSyntax(final)) {
      return null;
    }

    const rawToolRetry = evaluateRawToolRetryOutcome({
      currentRetryCount: this.rawXmlRetryCount,
      maxRetryCount: 3,
      finalMessage: (_nextRetryCount) => `[错误] Agent 反复输出无效工具调用格式，已在第 ${this.iteration} 轮强制终止。最后输出片段: ${final.slice(0, 500)}`,
    });
    this.runtimeState.setRawXmlRetryCount(rawToolRetry.nextRetryCount);
    if (rawToolRetry.type === 'terminate') {
      agentLogger.error(`[${this.name}] 连续 ${this.rawXmlRetryCount} 次输出原始 XML 标签且无法解析，停止重试`);
      return { done: true, result: rawToolRetry.finalMessage };
    }

    const warningMsg = `🚨 **系统拦截警报**
系统检测到您的输出包含试图调用工具的原始标签或 JSON 代码块，但它们没有被上层的 Native Function Calling 引擎正确捕获。

受此影响，您的调用并未实际执行。请立刻重新思考；工具调用统一通过标准原生 Function Calling 协议发起，文本回复只写解释、结论或用户可见内容。`;

    agentLogger.warn(`[${this.name}] 触发底层格式错乱阻断防线，强制打回重做 (第 ${this.rawXmlRetryCount} 次)`);
    this.emitter.emit('agent:status', {
      agentId: this.agentId,
      agentName: this.name,
      sessionId: this.sessionId,
      status: `⚠️ 格式纠正中 (第 ${this.rawXmlRetryCount}/3 次)...`,
    });

    this.addMessage({ role: 'assistant', content: final, thinking: response.thinking });
    if (this.db) {
      await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
    }
    this.addMessage({ role: 'system', content: warningMsg });

    if (this.db) {
      await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
    }

    return { done: false };
  }

  /**
   * 评估完成状态，如果 completion guard 拒绝则返回重试指令
   * 返回 null 表示完成校验通过（继续后续流程）
   */
  private async evaluateCompletionAndRetry(final: string, response: ChatResponse, task: Task): Promise<{ done: boolean; result?: string } | null> {
    // 注：Worker stop 后不做本地截断猜测。
    // Worker 的真正完成判定交给下方的 completion guard（默认确定性硬校验）；
    // 是否继续完全信任远程 API 的 finish_reason（已在上方非 stop 分支处理）。
    // 这样杜绝"短 stop 被误判截断 → 反复续跑"的空转。

    const completionDecision = await this.evaluateCompletionCandidate(final, task);
    if (!completionDecision.accepted) {
      const nextRetryCount = this.runtimeState.incrementCompletionGuardRetry();
      const nonBypassableCompletionReasons = new Set([
        'missing_contract_compliance_proof',
      ]);
      const reason = completionDecision.reason || 'unknown';
      const isNonBypassable = nonBypassableCompletionReasons.has(reason);
      if (nextRetryCount > this.MAX_COMPLETION_GUARD_RETRIES && isNonBypassable) {
        const message = `completion guard rejected after ${this.MAX_COMPLETION_GUARD_RETRIES} retries: ${reason}`;
        agentLogger.error(`[${this.name}] ${message}`);
        this.emitter.emit('agent:status', {
          agentId: this.agentId,
          agentName: this.name,
          sessionId: this.sessionId,
          status: `🛑 完成校验失败：${reason}`,
        });
        throw new Error(message);
      }
      if (nextRetryCount > this.MAX_COMPLETION_GUARD_RETRIES) {
        // B2: 守护耗尽 — 不抛错(避免死循环),强制接受但记 envelope 可审计(放行不再静默)。
        this.runtimeState.completionBypassed = { reason, retries: nextRetryCount };
        agentLogger.warn(`[${this.name}] completion guard 已尝试 ${nextRetryCount} 次，强制接受（标记 UNVERIFIED）: ${reason}`);
        this.emitter.emit('agent:status', {
          agentId: this.agentId,
          agentName: this.name,
          sessionId: this.sessionId,
          status: `⚠️ 完成校验重试耗尽（${nextRetryCount}次），接受当前输出 [UNVERIFIED: ${reason}]`,
        });
        // 继续走正常完成流程，不再 retry — 返回 null
      } else {
        agentLogger.warn(`[${this.name}] completion guard 拒绝收尾: ${completionDecision.reason || 'unknown'} (${nextRetryCount}/${this.MAX_COMPLETION_GUARD_RETRIES})`);
        this.emitter.emit('agent:status', {
          agentId: this.agentId,
          agentName: this.name,
          sessionId: this.sessionId,
          status: `⚠️ 完成校验未通过 (${nextRetryCount}/${this.MAX_COMPLETION_GUARD_RETRIES})，继续执行中...`,
        });

        this.addMessage({ role: 'assistant', content: final, thinking: response.thinking });
        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
        }

        this.addMessage({ role: 'user', content: completionDecision.feedback });
        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
        }

        return { done: false };
      }
    }

    this.runtimeState.resetCompletionGuardRetry();
    agentLogger.debug(`completion guard 通过，任务结束`);
    return null;
  }

  /**
   * 评估 nextSpeaker 和 stopHook，决定是否需要继续
   * 返回 null 表示无需继续（应走正常完成流程）
   */
  private async evaluateContinuation(final: string, response: ChatResponse, task: Task): Promise<{ done: boolean; result?: string } | null> {
    const nextSpeakerVerdict = await evaluateNextSpeakerCandidate({
      finishReason: response.finish_reason,
      content: final,
      hasOpenWork: false,
      hasExplicitUserGate: false,
      llm: this.createAgentEventStreamClient(`Agent-${this.name}-NextSpeakerJudge`),
      model: this.model,
      messages: this.messages,
      sessionId: this.sessionId,
      actorLabel: `Agent-${this.name}-NextSpeakerJudge`,
    });
    if (nextSpeakerVerdict.nextSpeaker === 'model') {
      const continuationRetry = this.runtimeState.incrementContinuationRetry();
      if (continuationRetry > this.MAX_CONTINUATION_RETRIES) {
        agentLogger.warn(`[${this.name}] nextSpeaker 连续判 model 已达 ${continuationRetry} 次仍无工具推进，强制收尾`);
        this.runtimeState.resetContinuationRetry();
        // 落到下方 stop hook / 正常完成流程
      } else {
        // 续写前必须先把本轮已生成的部分输出（assistant content + thinking）入栈。
        // 否则 messages 末尾只剩"请接续"的 user 消息，模型看不到自己刚才输出的几千字，
        // 下一轮只会从头重新生成——MAX_CONTINUATION_RETRIES 次预算全部浪费在重写前文上，
        // 最终强制收尾时输出仍是半截（"无法真正续写"的根因）。
        // 入栈模式与 evaluateCompletionAndRetry / handleRawToolSyntaxRetry 完全一致：
        // 先 assistant 半截内容，再追加续写指令。
        this.addMessage({ role: 'assistant', content: final, thinking: response.thinking });
        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
        }

        this.addMessage({
          role: 'user',
          content: nextSpeakerVerdict.continuationPrompt || '请基于当前上下文接续未完成部分，已输出内容用承接方式处理。',
        });

        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
        }

        return { done: false };
      }
    }

    const stopHook = await this.maybeContinueFromStopHook(final);
    if (stopHook.shouldContinue) {
      this.addMessage({ role: 'user', content: stopHook.feedback || 'Stop Hook 要求继续推进当前任务。' });
      if (this.db) {
        await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
      }
      return { done: false };
    }

    return null;
  }

  /**
   * 执行最终完成流程：日志、工作笔记、事件发射、状态持久化
   */
  private async finalizeCompletion(final: string, task: Task): Promise<{ done: boolean; result?: string }> {
    await this.logEvent('agent_completed', {
      task_id: task.id,
      result_length: final.length,
      iterations: this.iteration,
      tool_calls: this.toolCallCount,
      result_summary: final,
    });

    // 结构化守卫：完成前自动写工作笔记（不依赖 LLM 主动调用）
    await autoWriteAgentCompletionNote({
      workspace: this.workspace,
      sessionId: this.sessionId,
      agentId: this.agentId,
      agentName: this.name,
      role: this.role,
      task,
      result: final,
      messages: this.messages,
      logger: agentLogger,
    });

    // 本 agent 自己的累计用量。usageMap 没有该 agentId 时（极少：无任何
    // 真实/估算 usage 落账），报 0 而非用 getSessionTotal() 冒充——后者是
    // 全会话总量，会让单个 agent 的 total 虚高且与 prompt/completion 不自洽。
    const agentTokenUsage = this.tracker.usageMap?.get(this.agentId);
    this.emitter.emit('agent:completed', {
      agentId: this.agentId,
      agentName: this.name,
      sessionId: this.sessionId,
      taskId: task.id,
      result: final,
      stats: {
        iterations: this.iteration,
        toolCalls: this.toolCallCount,
      },
      tokenUsage: {
        total: agentTokenUsage?.total ?? 0,
        prompt: agentTokenUsage?.prompt ?? 0,
        completion: agentTokenUsage?.completion ?? 0,
      },
    });

    if (this.db) {
      await this.db.saveAgentState?.({
        session_id: this.sessionId,
        agent_id: this.agentId,
        agent_name: this.name,
        agent_role: this.role,
        task_id: task.id,
        status: 'completed',
        stopped: 0,
        iteration: this.iteration,
        timestamp: Date.now() / 1000,
      });
    }

    return { done: true, result: final };
  }

  /**
   * 检查收件箱：处理停止消息和 Leader 干预指令。
   * @param prePolledMessages 可选的已 poll 消息列表，避免重复 poll
   * @returns true=需要停止Agent, false=继续运行
   */
  protected async checkInbox(prePolledMessages?: Array<{ id?: string; type: string; payload: unknown; content?: unknown; from: string }>): Promise<boolean> {
    let messages = prePolledMessages;
    if (!messages) {
      messages = this.bus ? this.bus.poll(this.busName) : [];
    }

    if (messages.length === 0) {
      return false;
    }

    agentLogger.debug(`📬 收到 ${messages.length} 条消息`);

    for (const msg of messages) {
      const senderLabel = inboxResolveSenderLabel(msg as InboxRawMessage);
      // 用于日志预览 / agent_stopped|paused 事件的 reason：team 协议消息优先取
      // 协议体 content（人类可读），普通消息取 canonical payload。
      const protocolMessage = parseProtocolPayload(msg.payload);
      const content = contentToPlainText(protocolMessage?.content ?? msg.payload);
      agentLogger.debug(`📨 来自 ${senderLabel}: ${content.slice(0, 80)}${content.length > 80 ? '…' : ''}`);

      // system_context 是运行时系统注入，必须作为 system role 进入模型上下文。
      if (msg.type === 'system_context') {
        const systemMessage = this.upsertSystemContextMessage(content);
        if (this.db) {
          await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, systemMessage);
        }
        if (this.bus && 'acknowledge' in this.bus && msg.id) {
          this.bus.acknowledge(this.busName, msg.id);
        }
        await this.logEvent('agent_system_context', { from: msg.from, content });
        const status = content.trim().startsWith(CONTRACT_PACK_MARKER)
          ? '收到 Contract Pack 系统契约更新'
          : `收到来自${senderLabel}的系统上下文更新`;
        agentLogger.debug(`🧭 已将系统上下文加入对话: ${status}`);
        this.emitter.emit('agent:status', {
          agentId: this.agentId,
          agentName: this.name,
          sessionId: this.sessionId,
          status,
        });
        if (this.currentTaskId) {
          this.emitter.emit('agent:progress', {
            agentId: this.agentId,
            name: this.name,
            sessionId: this.sessionId,
            taskId: this.currentTaskId,
            message: `● ${status}`,
          });
        }
        continue;
      }

      // 检查结构化控制命令（暂停/干预/终止）；普通文本仅接受整句 stop/停止，避免"请停止分析"类误触发
      if (inboxIsStopMessage(msg as InboxRawMessage)) {
        agentLogger.info(`🛑 收到停止命令`);
        this.stopped = true;
        this.markTerminalRuntimeOutcome({
          kind: 'terminated',
          reason: content || 'Agent stopped by explicit stop command',
          recoverable: false,
          phase: 'execute',
        });
        if (this.bus && 'acknowledge' in this.bus && msg.id) {
          this.bus.acknowledge(this.busName, msg.id);
        }
        await this.logEvent('agent_stopped', { reason: content, iteration: this.iteration });
        return true;
      }

      // 检查暂停命令
      if (inboxIsPauseMessage(msg as InboxRawMessage)) {
        agentLogger.info(`⏸ 收到暂停命令`);
        this.pause();
        if (this.bus && 'acknowledge' in this.bus && msg.id) {
          this.bus.acknowledge(this.busName, msg.id);
        }
        await this.logEvent('agent_paused', { reason: content, iteration: this.iteration });
        continue;
      }

      // 检查干预命令
      const interveneContent = inboxParseInterveneMessage(msg as InboxRawMessage);
      if (interveneContent) {
        agentLogger.info(`🎯 收到干预命令`);
        this.intervene(interveneContent);
        if (this.bus && 'acknowledge' in this.bus && msg.id) {
          this.bus.acknowledge(this.busName, msg.id);
        }
        await this.logEvent('agent_intervened', { instruction: interveneContent, iteration: this.iteration });
        continue;
      }

      const runtimeIntervention = await this.handleRuntimeInterventionMessage(msg as InboxRawMessage);
      if (runtimeIntervention) {
        if (!this.pendingInboxInterventionResult || runtimeIntervention.type === 'repeat') {
          this.pendingInboxInterventionResult = runtimeIntervention;
        }
        if (this.bus && 'acknowledge' in this.bus && msg.id) {
          this.bus.acknowledge(this.busName, msg.id);
        }
        continue;
      }

      const interventionContent = formatIncomingContent(msg as InboxRawMessage);

      this.addMessage({ role: 'user', content: interventionContent });

      if (this.db) {
        await this.db.saveAgentMessage?.(this.sessionId, this.agentId, this.name, this.messages[this.messages.length - 1]);
      }

      // 发送 ACK 确认消息已收到
      if (this.bus && 'acknowledge' in this.bus && msg.id) {
        this.bus.acknowledge(this.busName, msg.id);
      }

      await this.logEvent('agent_intervention', { from: msg.from, content: msg.payload });

      const interventionStatus = `收到来自${senderLabel}的消息，下一轮调整中`;
      agentLogger.debug(`📝 已将消息加入对话: ${interventionStatus}`);
      this.emitter.emit('agent:status', {
        agentId: this.agentId,
        agentName: this.name,
        sessionId: this.sessionId,
        status: interventionStatus,
      });
      if (this.currentTaskId) {
        this.emitter.emit('agent:progress', {
          agentId: this.agentId,
          name: this.name,
          sessionId: this.sessionId,
          taskId: this.currentTaskId,
          message: `● ${interventionStatus}`,
        });
      }
    }

    return false;
  }

  private async applyRuntimeIntervention(
    intervention: ParsedIntervention,
    msg: InboxRawMessage,
  ): Promise<{ type: 'repeat' | 'continue' } | null> {
    switch (intervention.type) {
      case 'retry_llm': {
        agentLogger.info(`[INTERVENTION] retry_llm: 中止当前 LLM 调用并触发重试`);
        if (this.currentLlmAbortController) {
          this.currentLlmAbortController.abort('Leader intervention: retry_llm');
        }
        return { type: 'repeat' };
      }

      case 'swap_model': {
        const newModel = intervention.param;
        if (!newModel) {
          agentLogger.warn(`[INTERVENTION] swap_model 缺少模型参数`);
          return null;
        }
        try {
          const { getModelManager } = await import('../config/ModelManager.js');
          getModelManager().getModelByIdStrict(newModel);
        } catch (error) {
          agentLogger.warn(`[INTERVENTION] swap_model 拒绝未知模型 ${newModel}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
        agentLogger.info(`[INTERVENTION] swap_model: ${this.model} -> ${newModel}`);
        this.model = newModel;
        this.contextManager.updateModel(newModel, this.resolveContextLimit(newModel));
        return { type: 'repeat' };
      }

      case 'nudge': {
        const content = contentToPlainText(msg.payload).trim();
        const nudgeText = (intervention.param || content.replace(/^\[INTERVENTION:nudge\]\s*/i, '')).trim();
        if (nudgeText) {
          this.nudgeMessage = nudgeText;
          agentLogger.info(`[INTERVENTION] nudge: ${nudgeText.substring(0, 80)}${nudgeText.length > 80 ? '...' : ''}`);
        }
        return { type: 'continue' };
      }

      case 'compact_context': {
        agentLogger.info(`[INTERVENTION] compact_context: 压缩 Agent 上下文`);
        try {
          this.contextManager.setMessages(this.messages);
          const result = await this.contextManager.forceCompact();
          this.messages = this.contextManager.getMessages();
          agentLogger.info(`[INTERVENTION] compact_context 完成: ${result.oldTokens} → ${result.newTokens} tokens`);
        } catch (err) {
          agentLogger.warn(`[INTERVENTION] compact_context 失败: ${String(err)}`);
        }
        return { type: 'repeat' };
      }
    }
    return null;
  }

  private async handleRuntimeInterventionMessage(
    msg: InboxRawMessage,
  ): Promise<{ type: 'repeat' | 'continue' } | null> {
    const intervention = inboxParseInterventionControl(msg);
    if (!intervention) return null;
    return this.applyRuntimeIntervention(intervention, msg);
  }

  /**
   * 检查并处理 Leader 的运行时干预指令。
   * 在每次 LLM 调用前调用，识别 [INTERVENTION:*] 前缀消息。
   * @returns { type: 'repeat' } 触发循环重试, { type: 'continue' } 继续, null 无干预
   */
  protected async checkInboxForIntervention(): Promise<{ type: 'repeat' | 'continue' } | null> {
    if (this.pendingInboxInterventionResult) {
      const result = this.pendingInboxInterventionResult;
      this.pendingInboxInterventionResult = null;
      return result;
    }
    if (!this.bus) return null;

    try {
      const messages = this.bus.poll(this.busName);
      if (messages.length === 0) return null;
      const shouldStop = await this.checkInbox(messages);
      if (shouldStop) return { type: 'repeat' };
      if (this.pendingInboxInterventionResult) {
        const result = this.pendingInboxInterventionResult;
        this.pendingInboxInterventionResult = null;
        return result;
      }
    } catch (err) {
      agentLogger.warn(`checkInboxForIntervention 出错: ${String(err)}`);
    }

    return null;
  }

  /**
   * 检查收件箱是否有恢复暂停的消息
   */
  protected async checkInboxForResume(): Promise<boolean> {
    if (!this.bus) return false;

    try {
      const messages = this.bus.poll(this.busName);
      const remaining: typeof messages = [];
      let resumed = false;
      for (const msg of messages) {
        if (inboxIsResumeMessage(msg as InboxRawMessage)) {
          agentLogger.info(`收到恢复消息，Agent ${this.name} 将继续执行`);
          resumed = true;
          if (this.bus && 'acknowledge' in this.bus && msg.id) {
            this.bus.acknowledge(this.busName, msg.id);
          }
          continue;
        }
        remaining.push(msg);
      }
      if (remaining.length > 0) {
        await this.checkInbox(remaining);
      }
      return resumed;
    } catch (err) {
      agentLogger.warn(`checkInboxForResume 出错: ${String(err)}`);
    }

    return false;
  }

  /**
   * 检查收件箱是否有干预确认消息
   */
  protected async checkInboxForInterventionConfirm(): Promise<boolean> {
    if (!this.bus) return false;

    try {
      const messages = this.bus.poll(this.busName);
      const remaining: typeof messages = [];
      let confirmed = false;
      for (const msg of messages) {
        if (inboxIsInterventionConfirmMessage(msg as InboxRawMessage)) {
          agentLogger.info(`收到干预确认消息，Agent ${this.name} 将继续执行`);
          confirmed = true;
          if (this.bus && 'acknowledge' in this.bus && msg.id) {
            this.bus.acknowledge(this.busName, msg.id);
          }
          continue;
        }
        // 如果收到新的干预指令，替换当前的
        const interventionResult = await this.handleRuntimeInterventionMessage(msg as InboxRawMessage);
        if (interventionResult) {
          this.pendingInboxInterventionResult = interventionResult;
          agentLogger.info(`收到新的干预指令: ${interventionResult.type}`);
          confirmed = true;
          if (this.bus && 'acknowledge' in this.bus && msg.id) {
            this.bus.acknowledge(this.busName, msg.id);
          }
          continue;
        }
        remaining.push(msg);
      }
      if (remaining.length > 0) {
        await this.checkInbox(remaining);
      }
      return confirmed;
    } catch (err) {
      agentLogger.warn(`checkInboxForInterventionConfirm 出错: ${String(err)}`);
    }

    return false;
  }

  protected async maybeContinueFromStopHook(final: string): Promise<{
    shouldContinue: boolean;
    feedback?: string;
    signal?: { source: string; detail?: string };
  }> {
    const hookResult = await executeStop(this.sessionId, final);
    if (!hookResult.blocked && hookResult.system_messages.length === 0) {
      return { shouldContinue: false };
    }

    const feedback = hookResult.block_reason || hookResult.system_messages.join('\n').trim() || 'Stop Hook 要求继续推进当前任务。';
    return {
      shouldContinue: true,
      feedback,
      signal: { source: 'stop_hook', detail: feedback },
    };
  }

  private markTerminalRuntimeOutcome(outcome: {
    kind: 'failed' | 'recovering' | 'terminated';
    reason: string;
    faultClass?: RecoveryFaultClass;
    recoverable?: boolean;
    phase?: 'execute' | 'conclude';
    llmErrorKind?: LLMErrorKind;
  }): string {
    const normalized = this.normalizeTerminalRuntimeOutcome(outcome);
    if (this.terminalRuntimeOutcome?.kind === 'terminated' && outcome.kind !== 'terminated') {
      return this.terminalRuntimeOutcome.reason;
    }
    this.terminalRuntimeOutcome = {
      kind: normalized.kind,
      reason: normalized.reason,
      faultClass: normalized.faultClass,
      recoverable: normalized.recoverable ?? normalized.kind === 'recovering',
      phase: normalized.phase,
      llmErrorKind: normalized.llmErrorKind,
    };
    return normalized.reason;
  }

  private isStoppedRuntimeReason(reason: string | undefined): boolean {
    const normalized = String(reason || '').trim();
    return /^Agent stopped(?:\b|$)/i.test(normalized)
      || normalized.startsWith('被Leader停止')
      || /^Agent stopped before LLM call$/i.test(normalized);
  }

  private normalizeTerminalRuntimeOutcome(outcome: {
    kind: 'failed' | 'recovering' | 'terminated';
    reason: string;
    faultClass?: RecoveryFaultClass;
    recoverable?: boolean;
    phase?: 'execute' | 'conclude';
    llmErrorKind?: LLMErrorKind;
  }): {
    kind: 'failed' | 'recovering' | 'terminated';
    reason: string;
    faultClass?: RecoveryFaultClass;
    recoverable?: boolean;
    phase?: 'execute' | 'conclude';
    llmErrorKind?: LLMErrorKind;
  } {
    if (outcome.kind !== 'terminated' && this.isStoppedRuntimeReason(outcome.reason)) {
      return {
        ...outcome,
        kind: 'recovering',
        faultClass: 'worker_stopped',
        recoverable: true,
      };
    }
    return outcome;
  }

  private buildTerminalFailureResult(
    summary: string,
    defaults: {
      kind: 'failed' | 'recovering' | 'terminated';
      faultClass?: RecoveryFaultClass;
      recoverable?: boolean;
      phase: 'execute' | 'conclude';
    },
  ): AgentExecutionResult {
    const outcome = this.normalizeTerminalRuntimeOutcome(this.terminalRuntimeOutcome ?? {
      kind: defaults.kind,
      reason: summary,
      faultClass: defaults.faultClass,
      recoverable: defaults.recoverable ?? defaults.kind === 'recovering',
      phase: defaults.phase,
    });

    return createFailureResult({
      summary: outcome.reason || summary,
      error: outcome.reason || summary,
      duration: Date.now() - this.runtimeState.startTime,
      metadata: {
        iterations: this.iteration,
        toolCalls: this.toolCallCount,
        recoverable: outcome.recoverable,
        faultClass: outcome.faultClass,
        llmErrorKind: outcome.llmErrorKind,
        terminalKind: outcome.kind,
        statusReason: outcome.reason || summary,
        runtimePhase: outcome.phase ?? defaults.phase,
      },
    });
  }

  private isRuntimeFailureLoopResult(result: string | undefined): boolean {
    if (!result) return true;
    const normalized = result.trim();
    return (
      /^Agent stopped(?:\b|$)/i.test(normalized) ||
      /^Agent stopped before LLM call$/i.test(normalized) ||
      normalized.startsWith('被Leader停止') ||
      normalized.startsWith('[LLM') ||
      normalized.startsWith('Conclude phase failed')
    );
  }

  /**
   * Agent 主循环
   */
  /**
   * 双阶段执行入口
   * Execute 阶段：正常执行任务
   * Conclude 阶段：超时后快速收尾
   */
  async runWithConclude(
    task: Task,
    isResume = false,
    recoveredState?: { iteration?: number; toolCallCount?: number },
  ): Promise<string | import('./AgentExecutionResult.js').AgentExecutionResult> {
    try {
      // Execute 阶段：正常执行
      return await this.executePhase(task, isResume, recoveredState);
    } catch (error) {
      // 如果是 TimeoutError，进入 Conclude 阶段
      if (error instanceof TimeoutError) {
        agentLogger.info(`[${this.name}] 执行超时，进入 Conclude 阶段`);
        return await this.concludePhase(task, error);
      }
      // 其他错误直接抛出
      throw error;
    }
  }

  /**
   * Execute 阶段：正常执行任务
   */
  private async executePhase(
    task: Task,
    isResume = false,
    recoveredState?: { iteration?: number; toolCallCount?: number },
  ): Promise<string | import('./AgentExecutionResult.js').AgentExecutionResult> {
    return await this.run(task, isResume, recoveredState);
  }

  /**
   * Conclude 阶段：超时后快速收尾
   * 限时 2 分钟，最多 3 轮对话
   */
  private async concludePhase(task: Task, timeoutError: TimeoutError): Promise<import('./AgentExecutionResult.js').AgentExecutionResult> {
    agentLogger.info(`[${this.name}] 开始 Conclude 阶段收尾`);
    
    // 注入 Conclude Prompt
    const taskType = await this.inferTaskType(task);
    const concludePrompt = getPromptTemplate(taskType, 'conclude');
    
    if (concludePrompt) {
      const progress = summarizeAgentProgress(this.iteration, this.toolCallCount, this.messages);
      
      // 如果有黑板图，获取当前状态
      let factCount = '0';
      let hintCount = '0';
      if (this.blackboardGraph) {
        const snapshot = this.blackboardGraph.getSnapshot(this.sessionId);
        factCount = String(snapshot.nodes.filter(n => n.kind === 'fact').length);
        hintCount = String(snapshot.nodes.filter(n => n.kind === 'hint').length);
      }
      
      const promptContent = renderAgentPromptTemplate(concludePrompt.template, {
        goal: task.description,
        intent: task.context || '',
        description: task.description,
        progress,
        factCount,
        hintCount,
      });
      
      this.messages.push({
        role: 'system',
        content: promptContent,
      });
    }

    // 限时 2 分钟，最多 3 轮
    const concludeMaxIterations = 3;
    const concludeMaxMinutes = 2;
    
    try {
      const core = new AgentCore<string>();
      const loopResult = await core.run({
        maxRounds: concludeMaxIterations,
        maxRuntimeMinutes: concludeMaxMinutes,
        shouldStop: () => this.stopped,
        onStopped: async () => this.markTerminalRuntimeOutcome({
          kind: 'recovering',
          reason: 'Agent stopped during conclude phase',
          faultClass: 'worker_stopped',
          recoverable: true,
          phase: 'conclude',
        }),
        onBoundReached: async (reason) => {
          agentLogger.info(`[${this.name}] Conclude 阶段达到限制: ${reason}`);
          return { type: 'break', result: 'Conclude phase completed' };
        },
        runRound: async (roundNumber) => this.roundExecutor.executeRuntimeRound({
          round: roundNumber,
          run: async () => {
          if (this.stopped) {
            return { type: 'break', result: this.markTerminalRuntimeOutcome({
              kind: 'recovering',
              reason: 'Agent stopped during conclude phase',
              faultClass: 'worker_stopped',
              recoverable: true,
              phase: 'conclude',
            }) };
          }

          this.runtimeState.beginRound();

          // 调用 LLM
          const tools = await this.getToolDefinitions(task);
          const guard = createLlmGuard({
            actorLabel: this.name,
            maxRetries: 2, // Conclude 阶段减少重试次数
            backoffBaseMs: runtimeConfig.llm.backoff_base_ms,
            classifyError: classifyLLMError,
            cbScope: `conclude::${this.name}`,
            langfuseSessionId: this.sessionId,
            langfuseAgentId: this.agentId,
            langfuseTaskId: task.id,
          });

	          this.currentLlmAbortController = new AbortController();

	          let response: ChatResponse;
	          try {
	            const inputManifest = buildLlmInputManifest({
	              actor: 'worker',
	              actorLabel: this.name,
	              sessionId: this.sessionId,
	              agentId: this.agentId,
	              taskId: task.id,
	              model: this.model,
	              messages: this.messages,
	              tools,
	            });
	            agentLogger.debug(`[llm-input] ${summarizeLlmInputManifest(inputManifest)}`);
	            this.emitter.emit('llm:input_manifest', {
	              sessionId: this.sessionId,
	              actor: 'worker',
	              actorLabel: this.name,
	              manifest: inputManifest,
	            });
	            response = await guard.call(
	              this.llm,
	              this.messages,
              this.model,
              tools,
              ENABLE_STREAMING,
              this.currentLlmAbortController.signal,
              {
                onText: (text) => {
                  this.emitter.emit('agent:text_chunk', {
                    agentId: this.agentId,
                    agentName: this.name,
                    sessionId: this.sessionId,
                    chunk: text,
                  });
                },
              },
              {
                actorType: 'agent',
                actorLabel: this.name,
                purpose: 'summary',
                sessionId: this.sessionId,
                agentId: this.agentId,
                agentName: this.name,
                taskId: task.id,
                role: this.role,
              },
              // 防漂移：Worker Conclude 摘要走确定性温度
              getReasoningGenerateOptions(),
            );
          } catch (error) {
            // CircuitBreaker OPEN：sleep 到探针窗口再 continue
            if (error instanceof CircuitOpenError) {
              const waitMs = error.retryAfterMs;
              agentLogger.warn(
                `[${this.name}] Conclude CB OPEN provider="${error.providerKey}"，sleep ${Math.ceil(waitMs / 1000)}s`,
              );
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              return { type: 'continue' };
            }
            // 超时错误：不重试，直接 continue 重新请求
            const concludeClassified = classifyLLMError(error);
            if (
              concludeClassified.llmErrorKind === 'request_timeout' ||
              concludeClassified.llmErrorKind === 'connect_timeout' ||
              concludeClassified.llmErrorKind === 'stream_timeout'
            ) {
              agentLogger.warn(`[${this.name}] Conclude 阶段 LLM 超时 (${concludeClassified.llmErrorKind})，重新请求中...`);
              return { type: 'continue' };
            }
            agentLogger.error(`[${this.name}] Conclude 阶段 LLM 调用失败:`, error);
            return { type: 'break', result: this.markTerminalRuntimeOutcome({
              kind: 'recovering',
              reason: `Conclude phase failed: ${error instanceof Error ? error.message : String(error)}`,
              faultClass: 'worker_runtime',
              recoverable: true,
              phase: 'conclude',
            }) };
          }

          // 处理响应
          const { done, result } = await this.processResponse(response, task);
          if (done) {
            return { type: 'break', result: result || 'Conclude phase completed' };
          }

          return { type: 'continue' };
          },
        }),
      });

      if (this.terminalRuntimeOutcome || this.isRuntimeFailureLoopResult(loopResult)) {
        return this.buildTerminalFailureResult(loopResult || 'Conclude phase failed', {
          kind: 'recovering',
          faultClass: 'worker_runtime',
          recoverable: true,
          phase: 'conclude',
        });
      }

      return createSuccessResult({
        summary: loopResult || 'Conclude phase completed',
        filesChanged: [],
        duration: Date.now() - this.runtimeState.startTime,
      });
    } catch (error) {
      agentLogger.error(`[${this.name}] Conclude 阶段执行错误:`, error);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return createFailureResult({
        summary: normalizedError.message,
        error: normalizedError.stack || normalizedError.message,
        duration: Date.now() - this.runtimeState.startTime,
      });
    }
  }

  /**
   * 推断任务类型
   */
  private async inferTaskType(task: Task): Promise<TaskType> {
    const classification = await TaskClassifier.classify({
      ...task,
      session_id: task.session_id || this.sessionId,
    }, {
      blackboardGraph: this.blackboardGraph,
      llm: this.createAgentEventStreamClient(`Agent-${this.name}-TaskClassifier`),
      model: this.model,
    });
    agentLogger.info(`[${this.name}] Task classified as ${classification.type}: ${classification.reason}`);
    return classification.type;
  }

  async run(
    task: Task,
    isResume = false,
    recoveredState?: { iteration?: number; toolCallCount?: number },
  ): Promise<string | import('./AgentExecutionResult.js').AgentExecutionResult> {
    this.runtimeState.initializeTaskScope(task, this.workspace);
    // 复用同名 worker 跑新任务时，清空上个任务的产物轨迹与收尾，防止旧产物泄漏到新任务。
    this.toolTrace.filesCreated.clear();
    this.toolTrace.filesModified.clear();
    this.toolTrace.commandsRun.length = 0;
    this.attemptCompletion = undefined;
    this.terminalRuntimeOutcome = null;
    const recoveredIteration = recoveredState?.iteration || 0;
    const recoveredToolCallCount = recoveredState?.toolCallCount || 0;

    if (this.inheritedHistory && this.inheritedHistory.length > 0) {
      // 继承历史（复用同名 worker 跑新任务 / 复活同一任务），统一走 inherited 初始化。
      // 必须优先于 initializeMessages（后者 this.messages=[] 会清空继承内容）。
      await this.initializeMessagesFromInherited(task, recoveredIteration, recoveredToolCallCount);
    } else if (isResume && this.db) {
      const history = await this.db.getAgentConversation?.(this.sessionId, this.agentId);
      if (history && history.length > 0) {
        // 自愈中断孤儿：worker 被 kill 后从 DB 恢复时，assistant 发起的 tool_call
        // 可能缺配对 tool_result。补语义占位，避免 provider 反复合成 [tool result missing]。
        const { healed, addedCount } = healInterruptedToolCalls(history);
        if (addedCount > 0) {
          agentLogger.warn(`[WorkerResumeHeal] 从 DB 恢复时检测到 ${addedCount} 个中断孤儿 tool_call，补占位`);
          this.messages = healed;
        } else {
          this.messages = history;
        }
        this.runtimeState.restoreProgress(
          recoveredIteration,
          recoveredToolCallCount || history.filter(m => m.role === 'tool').length,
        );
        agentLogger.info(`♻️ 从数据库恢复对话历史 (共 ${history.length} 条消息)`);
      } else {
        await this.initializeMessages(task);
      }
    } else {
      await this.initializeMessages(task);
    }

    this.runtimeState.restoreProgress(recoveredIteration, this.toolCallCount);

    // 发射 Agent 启动事件
    await this.logEvent('agent_spawned', {
      agent_id: this.agentId,
      name: this.name,
      role: this.role,
      task_id: task.id,
      task_subject: task.subject,
    });

    this.emitter.emit('agent:spawned', {
      sessionId: this.sessionId,
      agentId: this.agentId,
      name: this.name,
      role: this.role,
      taskId: task.id,
      baselineRole: this.handle?.capabilityDetails?.baselineRole,
      skillNames: this.handle?.capabilityDetails?.skillNames,
      droppedTools: this.handle?.capabilityDetails?.droppedTools,
      tools: this.handle?.capabilityDetails?.tools,
    });

    try {
      // 不可重试错误的恢复尝试标记（仅允许一次恢复，避免死循环）
      let nonRetryableRecoveryAttempted = false;

      const core = new AgentCore<string>();
      const loopResult = await core.run({
        maxRounds: this.maxIterations,
        maxRuntimeMinutes: this.maxRuntimeMinutes,
        shouldStop: () => this.stopped,
        onStopped: async () => this.markTerminalRuntimeOutcome({
          kind: 'recovering',
          reason: 'Agent stopped',
          faultClass: 'worker_stopped',
          recoverable: true,
          phase: 'execute',
        }),
        onBoundReached: async (reason) => {
          // 如果是时长超时，抛出 TimeoutError 触发 Conclude 阶段
          if (reason === 'max_runtime') {
            const elapsedMinutes = (Date.now() - this.runtimeState.startTime) / (1000 * 60);
            throw new TimeoutError(
              `Agent ${this.name} 执行超时 (${elapsedMinutes.toFixed(1)} 分钟)`,
              this.agentId,
              this.iteration,
              elapsedMinutes,
            );
          }
          
          // 如果是轮次超时，继续执行（原有逻辑）
          const continuationMsg = reason === 'max_rounds'
            ? `达到最大迭代窗口 (${this.maxIterations})，继续推进任务`
            : `达到最大运行时长窗口 (${this.maxRuntimeMinutes} 分钟)，继续推进任务`;
          this.emitter.emit('agent:status', {
            agentId: this.agentId,
            agentName: this.name,
            sessionId: this.sessionId,
            status: `♻️ ${continuationMsg}`,
          });
          await this.logEvent('continuation_window_reached', {
            reason,
            iteration: this.iteration,
            maxIterations: this.maxIterations,
            maxRuntimeMinutes: this.maxRuntimeMinutes,
          });
          this.addMessage({
            role: 'system',
            content: `运行时续跑：已达到内部${reason === 'max_rounds' ? '轮次' : '时长'}窗口，但任务尚未完成。请将该窗口视为预算刷新点并继续推进。`,
          });
          return { type: 'reset_budget' };
        },
        runRound: async (roundNumber) => this.roundExecutor.executeRuntimeRound({
          round: roundNumber,
          run: async () => {
          if (this.stopped) {
            return { type: 'break', result: this.markTerminalRuntimeOutcome({
              kind: 'recovering',
              reason: 'Agent stopped',
              faultClass: 'worker_stopped',
              recoverable: true,
              phase: 'execute',
            }) };
          }

          // 检查是否被暂停
          if (this.paused) {
            // 等待恢复，定期检查 inbox 是否有 resume 消息
            const resumeMsg = await this.checkInboxForResume();
            if (!resumeMsg) {
              // 没有恢复消息，继续等待
              await new Promise(resolve => setTimeout(resolve, 1000));
              return { type: 'repeat' };
            }
            // 收到恢复消息，继续执行
            this.paused = false;
          }

          // 检查是否处于干预等待状态
          if (this.stalled) {
            const confirmMsg = await this.checkInboxForInterventionConfirm();
            if (!confirmMsg) {
              // 等待用户确认，定期检查 inbox
              await new Promise(resolve => setTimeout(resolve, 1000));
              return { type: 'repeat' };
            }
            // 用户确认继续，恢复执行
            this.resumeWithIntervention();
          }

          this.runtimeState.beginRound();

          // 上报健康指标给 AgentHandle
          if (this.handle) {
            this.handle.lastProgress = Date.now();
            this.handle.iteration = this.iteration;
            this.handle.toolCalls = this.toolCallCount;
          }
          this.persistResumeCheckpoint(task);

          // 检查收件箱
          const shouldStop = await this.checkInbox();
          if (shouldStop) {
            return { type: 'break', result: this.terminalRuntimeOutcome?.reason || `被Leader停止: ${this.messages[this.messages.length - 1]?.content || '未知原因'}` };
          }

          // 检查并处理 Leader 运行时干预指令
          const interventionResult = await this.checkInboxForIntervention();
          if (interventionResult) {
            if (interventionResult.type === 'repeat') {
              this.runtimeState.repeatRound();
              return { type: 'repeat' };
            }
            // nudge: continue, message injected below
          }

          // 发射思考中事件
          this.emitter.emit('agent:thinking', {
            agentId: this.agentId,
            agentName: this.name,
            sessionId: this.sessionId,
            iteration: this.iteration,
          });

          const contextStartedAt = Date.now();
          this.contextManager.setMessages(this.messages);
          this.messages = await this.contextManager.manage();
          const managedAt = Date.now();
          await this.appendRuntimeContextManifestIfChanged();
          this.contextManager.setMessages(this.messages);
          const ctxTokens = await this.contextManager.getTokenCount(this.messages);
          const tokenCountedAt = Date.now();
          agentLogger.debug(`[llm-phase] ${this.name} context_manage=${managedAt - contextStartedAt}ms token_count=${tokenCountedAt - managedAt}ms`);
          const ctxState = this.contextManager.getRuntimeState();
          this.emitter.emit('agent:context_updated', {
            sessionId: this.sessionId,
            agentId: this.agentId,
            agentName: this.name,
            tokens: ctxTokens,
            maxTokens: ctxState.maxTokens,
          });
          // 注入 Leader nudge 干预消息（如有）
          if (this.nudgeMessage) {
            this.messages.push({
              role: 'system',
              content: `[Leader 指导] ${this.nudgeMessage}`,
            });
            this.nudgeMessage = null; // 消费后清除，避免重复注入
          }

          // 调用 LLM
          const toolsStartedAt = Date.now();
          const tools = await this.getToolDefinitions(task);
          agentLogger.debug(`[llm-phase] ${this.name} tool_definitions=${Date.now() - toolsStartedAt}ms tool_count=${tools?.length ?? 0}`);
          const inputManifest = buildLlmInputManifest({
            actor: 'worker',
            actorLabel: this.name,
            sessionId: this.sessionId,
            agentId: this.agentId,
            taskId: task.id,
            model: this.model,
            messages: this.messages,
            tools,
          });
          agentLogger.debug(`[llm-input] ${summarizeLlmInputManifest(inputManifest)}`);
          this.emitter.emit('llm:input_manifest', {
            sessionId: this.sessionId,
            actor: 'worker',
            actorLabel: this.name,
            manifest: inputManifest,
          });
          let response: ChatResponse;

          // ─── LLM 调用（LlmGuard 封装重试逻辑）───
          // cbScope 按 agent 名字拆分：每个 worker 拥有独立 CircuitBreaker，
          // 避免单个 worker 连续失败把所有 worker 全员熔断（共享串扰）。
          const guard = createLlmGuard({
            actorLabel: this.name,
            maxRetries: this.MAX_TIMEOUT_RETRIES,
            backoffBaseMs: runtimeConfig.llm.backoff_base_ms,
            classifyError: classifyLLMError,
            cbScope: `agent::${this.name}`,
            langfuseSessionId: this.sessionId,
            langfuseAgentId: this.agentId,
            langfuseTaskId: task.id,
          });

          if (this.stopped) {
            return { type: 'break', result: this.markTerminalRuntimeOutcome({
              kind: 'recovering',
              reason: 'Agent stopped before LLM call',
              faultClass: 'worker_stopped',
              recoverable: true,
              phase: 'execute',
            }) };
          }
          this.currentLlmAbortController = new AbortController();

          const buffers = createStreamHookBuffers({
            scope: 'agent',
            emitter: this.emitter,
            sessionId: this.sessionId,
            agentId: this.agentId,
            agentName: this.name,
            flushThreshold: runtimeConfig.leader.stream_buffer_flush_threshold,
          });

          // in-flight LLM 心跳：request_timeout 全程（首 token 前）worker 除 30s setInterval 外零 IPC，
          // 父进程心跳阈值会把 LlmGuard 正在重试的活 worker 误判 heartbeat_timeout 杀掉。期间持续 emit
          // agent:progress（在 WorkerProcessEntry.bridgedEvents → 桥接到父进程 reset lastHeartbeat）。
          // 声明在 try 外，确保 finally 任何出口（成功/异常/abort）都能 stop。
          let llmHeartbeat: LlmInFlightHeartbeatHandle | null = null;
          try {
            llmHeartbeat = startLlmInFlightHeartbeat({
              emitter: this.emitter,
              sessionId: this.sessionId,
              agentId: this.agentId,
              agentName: this.name,
              taskId: task.id,
              scope: 'agent',
            });
            response = await guard.call(
              this.llm,
              this.messages,
              this.model,
              tools,
              ENABLE_STREAMING,
              this.currentLlmAbortController.signal,
              wrapLlmHooksForEmitter(
                {
                  scope: 'agent',
                  emitter: this.emitter,
                  sessionId: this.sessionId,
                  agentId: this.agentId,
                  agentName: this.name,
                  logToolCall: (name) => agentLogger.debug(`\n工具调用: ${name}`),
                  // Wiki 等下游订阅者依赖原始 chunk（按 LLM 输出节奏），不能受缓冲影响
                  onRawTextChunk: (text) => {
                    const self = this as unknown as { onStreamChunk?: (sectionId: string, sectionTitle: string, text: string) => void; currentSectionId?: string; currentSectionTitle?: string };
                    if (typeof self.onStreamChunk === 'function') {
                      self.onStreamChunk(self.currentSectionId ?? '', self.currentSectionTitle ?? '', text);
                    }
                  },
                },
                buffers,
              ),
              {
                actorType: 'agent',
                actorLabel: this.name,
                purpose: inferAgentGatewayPurpose(task, this.role),
                sessionId: this.sessionId,
                agentId: this.agentId,
                agentName: this.name,
                taskId: task.id,
                role: this.role,
              },
              // 防漂移：Worker 主推理走确定性温度(默认 0)，避免工具选择随机抖动
              getReasoningGenerateOptions(),
            );

            // ─── 成功路径 ───
            const responseText = typeof response.content === 'string' ? response.content : '';

            if (responseText) {
              this.emitter.emit('agent:text', {
                agentId: this.agentId,
                agentName: this.name,
                sessionId: this.sessionId,
                content: responseText,
                reasoningContent: thinkingBlocksToText(response.thinking),
              });
            }
          } catch (error) {
            const abortedSignal = this.currentLlmAbortController?.signal.aborted ?? false;
            this.currentLlmAbortController = null;

            // 用户/Leader 主动 abort（ESC、retry_llm、P0 干预）：不应进入错误重试路径，
            // 直接 repeat 让外层主循环按干预后的状态重新跑一次（注入消息、新指令）。
            // 否则 "LLM call aborted by caller" 会被 classifyLLMError 当成 unknown_error，
            // 触发 break 或外层 retry 累加，把"中断后重试"变成"中断后退出/反复重试"。
            const errMsg = error instanceof Error ? error.message : String(error);
            if (abortedSignal || errMsg.includes('aborted by caller')) {
              agentLogger.info(`[${this.name}] LLM 调用被 abort（用户/Leader 干预），repeat 主循环`);
              return { type: 'repeat' };
            }

            // CircuitBreaker OPEN：sleep 到探针窗口再 repeat 重试，
            // 避免 200ms 高频 retry 死循环
            if (error instanceof CircuitOpenError) {
              const waitMs = error.retryAfterMs;
              const waitSec = Math.ceil(waitMs / 1000);
              agentLogger.warn(
                `[${this.name}] CB OPEN provider="${error.providerKey}"，sleep ${waitSec}s 等待 HALF_OPEN`,
              );
              this.emitter.emit('agent:status', {
                agentId: this.agentId,
                agentName: this.name,
                sessionId: this.sessionId,
                status: `🛑 Provider 暂不可用，${waitSec}s 后重试`,
              });
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              return { type: 'repeat' };
            }

            const classified = classifyLLMError(error);
            const errorMsg = classified.message;
            const errorLabel = formatLLMErrorLabel(classified);
            const rawErrorDetail = classified.rawMessage || (error instanceof Error ? error.message : String(error));
            const stackTrace = error instanceof Error ? `\n${error.stack ?? ''}` : '';

            // === 超时错误：LlmGuard 已不重试直接抛出。走 ESC 中断语义：不注入错误消息、
            // 不累加外层重试计数，直接 repeat 让主循环重新发起 LLM 请求。
            // CircuitBreaker 已在 LlmGuard 内累积失败计数，持续超时最终熔断走 CircuitOpenError 停下。
            if (
              classified.llmErrorKind === 'request_timeout' ||
              classified.llmErrorKind === 'connect_timeout' ||
              classified.llmErrorKind === 'stream_timeout'
            ) {
              agentLogger.warn(`[${this.name}] LLM 超时 (${errorLabel})，重新请求中...`);
              this.emitter.emit('agent:status', {
                agentId: this.agentId,
                agentName: this.name,
                sessionId: this.sessionId,
                status: `⏱️ LLM 超时，重新请求中...`,
              });
              // 抢救 partial content
              const partialTimeout = (error as unknown as Record<string, unknown>).partialContent;
              if (typeof partialTimeout === 'string' && partialTimeout.trim()) {
                this.messages.push({ role: 'assistant', content: partialTimeout });
                agentLogger.info(`[${this.name}] 超时重请求：已抢救 partial content (${partialTimeout.length} chars)`);
              }
              return { type: 'repeat' };
            }

            agentLogger.error(`[${this.name}] LLM ${errorLabel}，自动重试中... 完整错误: ${rawErrorDetail}${stackTrace}`);
            await this.logEvent('llm_error', {
              iteration: this.iteration,
              kind: classified.llmErrorKind,
              error: errorMsg,
              fullDetail: rawErrorDetail + stackTrace,
            });

            // === 上下文溢出兜底：HTTP 413 / context_length_exceeded ===
            // 重试同样的输入只会反复 413，必须主动触发硬重置压缩；
            // 同时不再注入错误 system 消息，避免上下文继续膨胀。
            if (classified.llmErrorKind === 'context_overflow') {
              const ctxMgr = this.contextManager;
              const tokens = ctxMgr ? await ctxMgr.getTokenCount().catch(() => 0) : 0;
              const threshold = ctxMgr?.getThreshold() ?? 0;
              agentLogger.warn(
                `[${this.name}] 收到 ${classified.statusCode ?? '?'} ${errorLabel}，主动触发硬重置`,
              );
              this.emitter.emit('context:overflow', {
                sessionId: this.sessionId,
                tokens,
                threshold,
                owner: 'agent',
                agentId: this.agentId,
                agentName: this.name,
              });
              this.toolLoopDetector.reset();
              return { type: 'repeat' };
            }

            // === 连续 unknown_error：LlmGuard 内部已重试 5 次仍失败 ===
            // Worker 无 compact 能力，直接 break 让 Leader 处理（Leader 会触发 compact）。
            // 不再走外层 retry（已耗尽，追加 error 消息只增上下文恶化问题）。
            if (classified.llmErrorKind === 'unknown_error') {
              agentLogger.warn(
                `[${this.name}] 连续 unknown_error，LlmGuard 内部已重试耗尽，Worker 退出等待 Leader 处理`,
              );
              // 抢救 partial content：LlmGuard 内部重试时可能已累积部分输出，注入对话历史避免白输
              const partialUnknown = (error as unknown as Record<string, unknown>).partialContent;
              if (typeof partialUnknown === 'string' && partialUnknown.trim()) {
                this.messages.push({ role: 'assistant', content: partialUnknown });
                agentLogger.info(`[${this.name}] unknown_error 终态：已抢救 partial content (${partialUnknown.length} chars)`);
              }
              this.llmErrorRetryCount = 0;
              return { type: 'break', result: this.markTerminalRuntimeOutcome({
                kind: 'recovering',
                reason: `[${errorLabel}] ${classified.message}`,
                faultClass: 'worker_runtime',
                llmErrorKind: classified.llmErrorKind,
                recoverable: true,
                phase: 'execute',
              }) };
            }

            // === 鉴权 / 配额耗尽 / Provider 参数错误：retry 没用，必须 break 让 Leader 接管 ===
            // 但如果 error 自身标记了 retryable=true (如 "content is empty" 瞬态错误)，
            // 则不应 break——应该走下面的重试逻辑。
            if (
              (classified.llmErrorKind === 'auth_error' ||
              classified.llmErrorKind === 'quota_exhausted' ||
              (classified.llmErrorKind === 'provider_error' && !classified.retryable))
            ) {
              const isAuth = classified.llmErrorKind === 'auth_error';
              agentLogger.error(
                `[${this.name}] 收到 ${classified.statusCode ?? '?'} ${errorLabel}，Worker 直接退出等待 Leader 处理`,
              );
              this.emitter.emit('agent:status', {
                agentId: this.agentId,
                agentName: this.name,
                sessionId: this.sessionId,
                status: isAuth
                  ? `🛑 ${errorLabel}：等待 API Key 修复`
                  : `🛑 ${errorLabel}：等待充值 / 切换模型`,
              });
              return { type: 'break', result: this.markTerminalRuntimeOutcome({
                kind: 'failed',
                reason: `[${errorLabel}] ${classified.message}`,
                faultClass: 'worker_runtime',
                recoverable: false,
                phase: 'execute',
              }) };
            }

            // 注入系统消息告知 Agent 当前错误状态，然后继续重试
            // 外层重试计数：LlmGuard 内部已穷尽自身预算后才会抛到这里。
            // 历史 bug：之前每个分支都直接 return repeat → 外层 retry 永远不累加 →
            // 网络持续抖动时形成 0ms 死循环。
            const outerRetry = ++this.llmErrorRetryCount;
            const outerMax = this.LLM_MAX_ERROR_RETRIES;
            if (outerRetry >= outerMax) {
              agentLogger.error(
                `[${this.name}] 外层 LLM 重试已达 ${outerRetry}/${outerMax} 次仍失败 (${errorLabel})，退出等待 Leader 处理`,
              );
              // 抢救 partial content：LlmGuard 内部重试时可能已累积部分输出
              const partialExhausted = (error as unknown as Record<string, unknown>).partialContent;
              if (typeof partialExhausted === 'string' && partialExhausted.trim()) {
                this.messages.push({ role: 'assistant', content: partialExhausted });
                agentLogger.info(`[${this.name}] 外层重试耗尽终态：已抢救 partial content (${partialExhausted.length} chars)`);
              }
              this.emitter.emit('agent:status', {
                agentId: this.agentId,
                agentName: this.name,
                sessionId: this.sessionId,
                status: `🛑 LLM 反复失败 (${errorLabel})：等待人工介入`,
              });
              this.llmErrorRetryCount = 0;
              return { type: 'break', result: this.markTerminalRuntimeOutcome({
                kind: 'recovering',
                reason: `[${errorLabel}] ${classified.message} (外层重试 ${outerRetry}/${outerMax} 次仍失败)`,
                faultClass: 'worker_runtime',
                llmErrorKind: classified.llmErrorKind,
                recoverable: true,
                phase: 'execute',
              }) };
            }
            // 注入错误通知，然后继续重试。
            // 400 provider_error 时不追加 system 消息——消息格式问题追加 system 只会让序列更不合法，
            // 且 LlmGuard 的 compact 已尝试清理历史。
            const isBadRequest = classified.llmErrorKind === 'provider_error' && classified.statusCode === 400;
            if (!isBadRequest) {
              this.messages.push({
                role: 'system',
                content: `⚠️ [系统通知] LLM 调用失败（${errorLabel}: ${rawErrorDetail}），外层已自动重试 ${outerRetry}/${outerMax} 次。系统将继续自动重试。`,
              });
            } else {
              agentLogger.warn(
                `[${this.name}] 400 provider_error 外层重试 ${outerRetry}/${outerMax}：不注入 system 消息，依赖 compact+sanitizer 恢复`,
              );
            }
            // 外层重试也要给 UI 可见反馈 + 刷新健康监控活动时间。
            // 否则 worker 在"每轮耗尽 5 次内层重试 → 外层再重试"的超时循环里，
            // 用户只看到 agent 长时间无输出却无任何告警（本次 bug 现象）。
            this.emitter.emit('agent:status', {
              agentId: this.agentId,
              agentName: this.name,
              sessionId: this.sessionId,
              status: `⏳ LLM ${errorLabel}：外层第 ${outerRetry}/${outerMax} 次重试中`,
            });
            // 外层退避：1s / 2s / 3s ... 封顶 30s，防止网络抖动时高频空转
            const outerBackoffMs = Math.min(outerRetry * 1000, 30_000);
            await new Promise((resolve) => setTimeout(resolve, outerBackoffMs));
            return { type: 'repeat' }; // 继续主循环，不中断
          } finally {
            llmHeartbeat?.stop();
            // 缓冲在调用结束时强制 flush，保证最后一段（短链 thinking / 残留文本）
            // 一定会通过 chunk 事件交付给 UI。
            buffers.flushAll();
            buffers.dispose();
          }

          // ─── 成功路径走到这里：清零外层 LLM 错误计数 ───
          this.llmErrorRetryCount = 0;

          // 处理响应
          const { done, result } = await this.processResponse(response, task);
          if (done) {
            this.clearResumeCheckpoint();
            this.emitter.emit('agent:stop', {
              agentId: this.agentId,
              name: this.name,
              sessionId: this.sessionId,
            });
            return { type: 'break', result: result || 'Task completed' };
          }

          // ─── 关键：工具执行后、下一轮 LLM 前，再次检查收件箱 ───
          // 防止在工具执行期间积压的 Leader 消息被延迟处理
          const postToolShouldStop = await this.checkInbox();
          if (postToolShouldStop) {
            return { type: 'break', result: this.terminalRuntimeOutcome?.reason || `被Leader停止: ${this.messages[this.messages.length - 1]?.content || '未知原因'}` };
          }
          // 工具执行后也检查干预指令
          const postToolIntervention = await this.checkInboxForIntervention();
          if (postToolIntervention && postToolIntervention.type === 'repeat') {
            this.runtimeState.repeatRound();
            return { type: 'repeat' };
          }
          agentLogger.debug(`第 ${this.iteration} 轮完成，继续下一轮...`);
          return { type: 'continue' };
          },
        }),
      });

      if (this.terminalRuntimeOutcome || this.isRuntimeFailureLoopResult(loopResult)) {
        return this.buildTerminalFailureResult(loopResult || 'Agent stopped', {
          kind: 'recovering',
          faultClass: 'worker_runtime',
          recoverable: true,
          phase: 'execute',
        });
      }

      // 生成结构化返回结果
      const duration = Date.now() - this.runtimeState.startTime;
      const structuredResult = createSuccessResult({
        summary: loopResult || 'Agent stopped',
        // 真实追踪：tool 层执行期间已采集的 create/modify 文件路径（见 this.toolTrace），
        // 去重后输出 —— 与 worker 路径 collectCompletionFiles 同源数据，保持一致。
        filesChanged: Array.from(
          new Set([...this.toolTrace.filesCreated, ...this.toolTrace.filesModified]),
        ),
        duration,
        metadata: {
          iterations: this.iteration,
          toolCalls: this.toolCallCount,
        },
      });

      return structuredResult;
    } catch (error) {
      agentLogger.error(`[${this.name}] Agent 执行错误:`, error);
      this.emitter.emit('agent:error', {
        agentId: this.agentId,
        sessionId: this.sessionId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.clearResumeCheckpoint();
      throw error;
    }
  }

  /**
   * 停止 Agent（完全终止，不可恢复）
   */
  stop(): void {
    this.stopped = true;
    this.currentLlmAbortController?.abort();
    // 不清除 controller：保持 abort 状态，防止 stop() 后又启动新的 LLM call
    // 下次 LLM call 开始前会在 stopped 检查处拦截
    // 清理事件监听器
    if (this._contextOverflowUnsub) {
      this._contextOverflowUnsub();
      this._contextOverflowUnsub = null;
    }
    if (this._p0InterventionUnsub) {
      this._p0InterventionUnsub();
      this._p0InterventionUnsub = null;
    }
  }

  /**
   * 暂停 Agent（保留进度，可随时恢复）
   * 不杀进程，只 abort 当前 LLM 调用，保存 checkpoint
   */
  pause(): void {
    this.paused = true;
    this.currentLlmAbortController?.abort();
    // 保存 checkpoint 到 DB
    this.savePauseCheckpoint();
    agentLogger.info(`Agent ${this.name} 已暂停`);
  }

  /**
   * 干预 Agent（停下来等用户指令）
   * 暂停当前操作，存储干预指令，等待用户确认后继续
   */
  intervene(instruction: string): void {
    this.stalled = true;
    this.currentLlmAbortController?.abort();
    this.interventionMessage = instruction;
    // 保存 checkpoint 到 DB
    this.savePauseCheckpoint();
    agentLogger.info(`Agent ${this.name} 已收到干预指令，等待确认`);
  }

  /**
   * 带着干预指令恢复执行
   * 将 interventionMessage 注入到对话中
   */
  resumeWithIntervention(): void {
    this.stalled = false;
    this.stopped = false;
    this.paused = false;
    if (this.interventionMessage) {
      // 将干预指令作为 system 消息注入
      this.messages.push({
        role: 'system',
        content: `[用户干预指令] 请按照以下指示调整你的执行方向：\n${this.interventionMessage}`,
      });
      agentLogger.info(`已将干预指令注入对话: ${this.interventionMessage.substring(0, 80)}...`);
    }
    this.interventionMessage = null;
    // 不在此创建 AbortController — 主循环在每次 LLM 调用前自行创建
  }

  /**
   * 保存暂停时的 checkpoint 到 DB
   */
  private savePauseCheckpoint(): void {
    if (this.db && this.currentTaskId) {
      const checkpoint = {
        agentId: this.agentId,
        agentName: this.name,
        agentRole: this.role,
        taskId: this.currentTaskId,
        iteration: this.iteration,
        toolCallCount: this.toolCallCount,
        timestamp: Date.now() / 1000,
        paused: this.paused,
        stalled: this.stalled,
        interventionMessage: this.interventionMessage,
      };
      try {
        saveAgentResumeCheckpoint(this.db, this.sessionId, checkpoint);
      } catch (err) {
        agentLogger.warn(`保存暂停 checkpoint 失败: ${err}`);
      }
    }
  }

  /**
   * 获取工具调用次数
   */
  getToolCallCount(): number {
    return this.toolCallCount;
  }

  /**
   * 获取当前迭代次数
   */
  getIterationCount(): number {
    return this.iteration;
  }

  /**
   * 框架自动采集的工具产物轨迹（已去重、created/modified 互斥）。
   * WorkerProcessEntry 在 complete payload 里透传给 Leader。
   */
  getToolTrace(): { files_created: string[]; files_modified: string[]; commands_run: string[] } {
    return this.buildToolTraceSnapshot();
  }

  /**
   * worker 通过 attempt_completion 声明的结构化收尾结果；未调用则为 undefined。
   */
  getAttemptCompletion(): AttemptCompletionStructuredResult | undefined {
    return this.attemptCompletion;
  }

  protected async evaluateCompletionCandidate(final: string, task: Task): Promise<{
    accepted: boolean;
    reason?: string;
    feedback: string;
  }> {
    const toolTrace = this.buildToolTraceSnapshot();
    const verification = await runCompletionVerification({
      workingDir: this.workspace,
      artifacts: this.attemptCompletion?.artifacts,
      toolTrace,
    });

    // 自动合成契约遵守证明：当 worker 有真实工作产物（toolTrace 有文件/命令）
    // 但未调用 attempt_completion 或未填 contract_compliance 时，
    // 框架用 toolTrace 证据自动合成基本证明，避免 worker 因格式认知不足反复失败。
    const hasRealArtifacts =
      toolTrace.files_created.length > 0 ||
      toolTrace.files_modified.length > 0 ||
      toolTrace.commands_run.length > 0;
    let contractCompliance = this.attemptCompletion?.contract_compliance;
    if (!contractCompliance && hasRealArtifacts) {
      const binding = (task as Task & { orchestration?: { contractBinding?: { surface?: unknown } } }).orchestration?.contractBinding;
      const surface = typeof binding?.surface === 'string' && binding.surface.trim() ? binding.surface.trim() : `task:${task.id}`;
      const evidence: string[] = [];
      if (toolTrace.files_created.length > 0) {
        evidence.push(`files_created: ${toolTrace.files_created.join(', ')}`);
      }
      if (toolTrace.files_modified.length > 0) {
        evidence.push(`files_modified: ${toolTrace.files_modified.join(', ')}`);
      }
      if (toolTrace.commands_run.length > 0) {
        evidence.push(`commands_run: ${toolTrace.commands_run.slice(0, 5).join('; ')}`);
      }
      contractCompliance = {
        surface,
        status: 'complied',
        evidence: evidence.length > 0 ? evidence : ['task completed with tool activity'],
        deviations: ['无（框架自动合成，worker 未显式声明契约遵守证明）'],
      };
      agentLogger.info(
        `[${this.name}] worker 未提供 contract_compliance，框架用 toolTrace 自动合成 (surface=${surface}, evidence=${evidence.length} items)`,
      );
    }

    return evaluateWorkerCompletionCandidate({
      final,
      task,
      role: this.role,
      messages: this.messages,
      contractCompliance,
      verification,
      hasContractAllowedScope: Boolean(this.currentContractAllowedScope),
      llm: this.llm,
      model: this.model,
    });
  }

}

export default BaseAgent;
