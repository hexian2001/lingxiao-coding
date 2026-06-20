/**
 * LeaderThinkingEngine
 * Handles LLM execution: streaming client creation, response processing,
 * tool scheduling, and the main leaderThinkAndAct loop.
 * Extracted from LeaderAgent.
 */

import {
  contentToPlainText,
  thinkingBlocksToText,
  type ChatMessage,
  type ChatResponse,
  type ThinkingBlock,
  type ToolCall,
  type ToolDefinition,
} from '../../llm/types.js';
import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import { estimateTokens } from '../../llm/token_counter.js';
import type { EventEmitter } from '../../core/EventEmitter.js';
import type { DatabaseManager } from '../../core/Database.js';
import type { ContextManager } from '../../core/ContextManager.js';
import type { TokenTracker } from '../BaseAgentRuntime.js';
import {
  ENABLE_STREAMING,
  LEADER_MAX_RUNTIME_MINUTES,
  LEADER_MAX_TOOL_ROUNDS,
  config as runtimeConfig,
} from '../../config.js';
import { t } from '../../i18n.js';
import { hasRawToolSyntax, parseRawToolCalls } from '../raw_tool_calls.js';
import { ToolScheduler } from '../runtime/ToolScheduler.js';
import type { ToolResultContent } from '../runtime/ToolResponseProcessor.js';
import { ToolLoopDetector } from '../runtime/ToolLoopDetector.js';
import { isStopFinishReason } from '../runtime/CompletionTerminationPolicy.js';
import { AgentCore } from '../runtime/AgentCore.js';
import { evaluateNextSpeakerCandidate } from '../runtime/NextSpeakerPolicy.js';
import { classifyLLMError, formatLLMErrorLabel } from '../../llm/errors.js';
import { CircuitOpenError } from '../../llm/CircuitBreaker.js';
import { createLlmGuard } from '../LlmGuard.js';
import { getReasoningGenerateOptions } from '../../llm/reasoningSampling.js';
import { SESSION_KEYS } from '../../core/SessionStateKeys.js';
import { leaderLogger } from '../../core/Log.js';
import { isTaskTerminalStatus, normalizeTaskStatus } from '../../contracts/adapters/StatusAdapter.js';
import type { CompletionSignal } from './p0Message.js';
import { buildLlmInputManifest, summarizeLlmInputManifest } from '../../core/LlmInputManifest.js';
import { createLeaderLlmSessionClient, type LeaderLlmRoundHooks } from './LeaderLlmSession.js';
import { createLeaderStreamBufferSession } from './LeaderStreamBuffer.js';
import { createLeaderToolScheduler } from './LeaderToolDispatch.js';
import { type SystemSlotMatcher } from '../../core/SystemMessageSlot.js';

/**
 * A5 短路窗口解析（确定性配置，非启发式阈值打分）。
 * 默认 4000ms（取任务建议的 3-5s 中位附近）。可经环境变量
 * LEADER_CONTINUATION_SHORTCIRCUIT_MS 覆盖（毫秒）。解析失败/越界回退默认。
 */
const DEFAULT_SHORTCIRCUIT_WINDOW_MS = 4000;
function parseShortCircuitWindowMs(): number {
  const raw = process.env.LEADER_CONTINUATION_SHORTCIRCUIT_MS;
  if (raw === undefined) return DEFAULT_SHORTCIRCUIT_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SHORTCIRCUIT_WINDOW_MS;
  return Math.floor(parsed);
}

export interface LeaderThinkingEngineOptions {
  sessionId: string;
  llm: ContentGenerator;
  model: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  tracker: TokenTracker;
  contextManager: ContextManager;

  // State accessors
  getConversation: () => ChatMessage[];
  setConversation: (msgs: ChatMessage[]) => void;
  addMessage: (msg: ChatMessage) => void;
  /** 单槽 in-place system 注入（状态镜像类：黑板分析）。命中同槽覆盖+collapse，无匹配 append。 */
  upsertSystemSlot?: (matcher: SystemSlotMatcher, content: string) => boolean;
  syncSystemPrompt?: () => void;
  getModel: () => string;
  setModel: (model: string) => void;
  getActiveToolDefinitions: () => ToolDefinition[];
  getCurrentLlmAbortController: () => AbortController | null;
  setCurrentLlmAbortController: (ctrl: AbortController | null) => void;

  // Flags
  isFinished: () => boolean;
  isWaitingForUser: () => boolean;
  isUserInterruptPending: () => boolean;
  /** 是否有待处理的 Agent 完成信号 */
  isAgentCompletionPending?: () => boolean;
  setWaitingForUser: (v: boolean) => void;
  isPendingReview: () => boolean;
  setIsBusy: (v: boolean) => void;
  getLastProgressAtMs: () => number;
  setLastProgressAtMs: (v: number) => void;
  getRawXmlRetryCount: () => number;
  setRawXmlRetryCount: (v: number) => void;
  getEmptyResponseRetryCount: () => number;
  setEmptyResponseRetryCount: (v: number) => void;
  getLlmErrorRetryCount: () => number;
  setLlmErrorRetryCount: (v: number) => void;
  getLlmMaxErrorRetries: () => number;
  getTurnCount: () => number;
  /** 获取非打断式用户指导消息（nudge） */
  getNudgeMessage?: () => string | null;
  /** 清除非打断式用户指导消息 */
  clearNudgeMessage?: () => void;
  /**
   * 排空 bus 上已到达但尚未处理的 user_intervention 消息，注入为 user role 对话。
   * 让 LLM 在下一轮调用前就能看到用户的非打断式输入。
   * 返回 true 表示有消息被注入。
   */
  drainPendingUserMessages?: () => Promise<boolean>;

  // Board/pool state
  hasPendingTasks: () => boolean;
  hasExplicitUserGate: () => boolean;
  /**
   * 是否存在「Leader 仍需亲自行动」的开放工作 = dispatchable 任务（尚未派发的就绪任务）。
   * 注意：running 任务 / running worker 不算 —— 那是已委派、在途的工作，Leader 应等待而非
   * 继续自说自话。next-speaker 决策用这个，而非 hasPendingTasks(含 running)||运行中 worker，
   * 否则只要有 worker 在跑 Leader 的回合永远结束不了、每轮 stop 后又被判 model 续跑。
   */
  hasDispatchableWork: () => boolean;
  /**
   * 是否处于 eternal（自治长跑）模式。manual 下系统绝不因"还有没派的活"强制续跑，
   * 是否继续完全交给 Leader 自己（实际调工具 / 真截断）。
   */
  isEternalMode?: () => boolean;
  getPendingAgentCompletionSignals: () => CompletionSignal[];
  getBoardTaskCount: () => number;
  getRunningAgentsCount: () => number;
  /** 根据 task_id 获取任务（Planning Gate 用） */
  getTaskById?: (taskId: string) => { id: string; status: string } | undefined;
  /** 只读预测接下来 create_task 会分配的任务 ID（Planning Gate 用，不推进计数器） */
  peekNextTaskIds?: (count: number) => string[];
  /** 获取当前 active team 名称（Team Gate 用） */
  getActiveTeam?: () => string | null;
  /** 获取当前 collaboration mode（Solo 允许 ephemeral dispatch；Team 才要求 roster） */
  getCollaborationMode?: () => 'solo' | 'team';
  /** 获取所有任务（用于停止前自检） */
  getAllTasks?: () => Array<{ id: string; status: string; exitReason?: string; result?: string | object }>;
  /** 获取当前活跃任务 ID（用于 Langfuse trace 关联）。返回第一个 running agent 的 taskId，无 running 时返回 undefined。 */
  getActiveTaskId?: () => string | undefined;

  // Operations
  executeToolCallsBatch: (toolCalls: ToolCall[]) => Promise<Array<{ toolCall: ToolCall; result: ToolResultContent }>>;
  maybeContinueFromStopHook: (final: string) => Promise<{
    shouldContinue: boolean;
    feedback?: string;
    signal?: { source: string; detail?: string };
  }>;
  appendRuntimeContextManifestIfChanged: () => boolean;
  createFileSnapshot?: (turnCount: number, label: string) => Promise<void>;
  streamBufferFlushThreshold: number;

  /**
   * 可选：连续 unknown_error 达到重试上限时触发上下文压缩。
   * LeaderAgent 传入 this.compactContext()。
   */
  compactContext?: () => Promise<{
    oldTokens: number;
    newTokens: number;
    compacted?: boolean;
    compactType?: string;
    overflow?: boolean;
    archivePath?: string;
    inProgress?: boolean;
    threshold?: number;
  }>;

  // 黑板架构（feature flag: LINGXIAO_BLACKBOARD）
  /** 获取黑板图分析结果，用于注入 LLM 上下文 */
  getBlackboardAnalysis?: () => import('../../core/blackboard/types.js').GraphAnalysis | null;
  /** 注入统一上下文记忆召回结果 */
  appendContextMemoryIfChanged?: () => Promise<boolean>;
}

/**
 * 决策可审查 trace 条目（确定性、结构化、可被测试断言）。
 * 记录每次 next-speaker 判定的：触发来源 / 输入信号快照 / 判定结果 / 是否本地短路。
 * 不含 confidence / 关键词匹配 —— 全部字段来自真实信号源（openWork count / 时间差 / finishReason）。
 */
export interface LeaderDecisionTraceEntry {
  /** 单调递增序号，便于断言 trace 顺序与条数 */
  seq: number;
  /** 毫秒级时间戳（Date.now()），可重放时序 */
  timestampMs: number;
  /** 决策触发来源：evaluateContinuationAfterStop / routeDecision 等 */
  source: string;
  /** 判定结果：model=Leader 续跑 / user=交回用户 */
  nextSpeaker: 'model' | 'user';
  /** 判定理由（来自 NextSpeakerVerdict.reason 或本地短路 reason） */
  reason: string;
  /** 是否本地短路（跳过 LLM judge，基于确定性信号直接判定） */
  shortCircuited: boolean;
  /** 输入信号快照（确定性结构化字段，断言用） */
  input: {
    finishReason?: string;
    openWorkCount: number;
    hasRunningAgents: boolean;
    isEternalMode: boolean;
    /** 是否含本轮新工具调用（短路条件之一） */
    hadNewToolCalls?: boolean;
    /** 距上次 stop 的毫秒数（短路条件之一；首次 stop 为 undefined） */
    msSinceLastStop?: number;
    /** 短路窗口阈值（仅 shortCircuited=true 时有意义，便于断言用了哪个配置值） */
    shortCircuitWindowMs?: number;
  };
}

export class LeaderThinkingEngine {
  private opts: LeaderThinkingEngineOptions;
  /** Planning gate: 在任务板为空时，防止 LLM 跳过 create_task 直接 dispatch_agent。最多触发 2 次。 */
  private planningGateBlockCount = 0;
  /** 同 toolName+args 连续调用探针；超阈值注入告警并跳过本轮工具执行 */
  private toolLoopDetector = new ToolLoopDetector({ threshold: 5 });
  /**
   * 连续续跑次数（LLM continuation judge / nextSpeaker=model 触发）。任意真实工具调用清零。
   * 超过 MAX_CONTINUATION_RETRIES 即强制 latch waitingForUser，打破
   * 「续跑→短 stop→续跑」空转死循环（无新工作时 Leader 反复刷续跑提示）。
   */
  private continuationRetryCount = 0;
  private readonly MAX_CONTINUATION_RETRIES = 5;
  private openWorkDecisionRetryCount = 0;
  private readonly MAX_OPEN_WORK_DECISION_RETRIES = 2;

  /**
   * 可回放的 Leader 决策 trace（A4）。每次 next-speaker 判定追加一条结构化条目。
   * capped at MAX_DECISION_TRACE 防止无界增长；测试通过 getDecisionTrace() 断言。
   */
  private readonly decisionTrace: LeaderDecisionTraceEntry[] = [];
  private readonly MAX_DECISION_TRACE = 100;
  private decisionTraceSeq = 0;
  /**
   * 上一次 stop（next-speaker 判定为 user 或 evaluateContinuationAfterStop 被调用）的毫秒时间戳。
   * A5 本地短路用它算"距上次 stop 的秒数"，确定性、无 confidence。
   */
  private lastStopTimestampMs: number | null = null;
  /**
   * A5 短路窗口：当无 open work + 无本轮新工具调用 + 距上次 stop 小于该窗口时，
   * 跳过 LLM judge 直接判定无需续跑。可经环境变量覆盖（确定性配置，非启发式阈值打分）。
   */
  private readonly shortCircuitWindowMs = parseShortCircuitWindowMs();
  /**
   * 本轮 processResponse 是否产生过新工具调用（native / raw_xml 均算）。
   * A5 短路条件之一：无新工具调用 = Leader 这一轮没做任何实质推进。
   * 每次 leaderThinkAndAct 入口清零（一个 think 周期 = 一轮判定）。
   */
  private hadToolCallsThisCycle = false;

  constructor(opts: LeaderThinkingEngineOptions) {
    this.opts = opts;
  }

  /**
   * 返回决策 trace 的只读快照（可回放 / 可断言）。每条条目都是结构化对象，
   * 不含 confidence / 关键词 —— 字段全部来自真实信号源。
   */
  getDecisionTrace(): readonly LeaderDecisionTraceEntry[] {
    return this.decisionTrace.slice();
  }

  /** 清空 trace（测试辅助） */
  resetDecisionTrace(): void {
    this.decisionTrace.length = 0;
    this.decisionTraceSeq = 0;
    this.lastStopTimestampMs = null;
  }

  private appendDecisionTrace(entry: Omit<LeaderDecisionTraceEntry, 'seq' | 'timestampMs'>): void {
    this.decisionTraceSeq += 1;
    this.decisionTrace.push({
      seq: this.decisionTraceSeq,
      timestampMs: Date.now(),
      ...entry,
    });
    if (this.decisionTrace.length > this.MAX_DECISION_TRACE) {
      this.decisionTrace.splice(0, this.decisionTrace.length - this.MAX_DECISION_TRACE);
    }
  }

  /** Expose the underlying ContentGenerator for callers that need it directly */
  getLlm(): ContentGenerator {
    return this.opts.llm;
  }

  createLeaderEventStreamClient(
    actorLabel: string,
    hooks?: LeaderLlmRoundHooks,
  ): ContentGenerator {
    return createLeaderLlmSessionClient({
      actorLabel,
      sessionId: this.opts.sessionId,
      llm: this.opts.llm,
      hooks,
    });
  }

  private async evaluateContinuationAfterStop(input: {
    finishReason?: ChatResponse['finish_reason'];
    content: string;
    continuationRole: 'user' | 'system';
  }): Promise<{ done: boolean; result?: string } | null> {
    const { sessionId, db } = this.opts;
    // open work = Leader 仍需亲自派发的就绪任务。running 任务 / 在途 worker 不算——
    // 那是已委派的活，Leader 应等 worker 汇报而非每轮 stop 后被判 model 续跑。
    const hasOpenWork = this.opts.hasDispatchableWork();
    const hasExplicitUserGate = this.opts.isWaitingForUser() || this.opts.isPendingReview() || this.opts.hasExplicitUserGate();
    const hasRunningAgents = this.opts.getRunningAgentsCount() > 0;
    const isEternalMode = this.opts.isEternalMode?.() ?? false;
    // 本轮 processResponse 是否产生过新工具调用（真实推进信号，确定性布尔）。
    const hadNewToolCalls = this.hadToolCallsThisCycle;
    const nowMs = Date.now();
    const msSinceLastStop = this.lastStopTimestampMs === null
      ? undefined
      : nowMs - this.lastStopTimestampMs;

    // ── A5 本地短路（确定性，基于真实信号，无 confidence 打分） ──
    // 当 ALL of：
    //   (1) 无 open work（hasDispatchableWork=false）
    //   (2) 本轮无新工具调用（hadNewToolCalls=false）
    //   (3) 存在前一次 stop（lastStopTimestampMs != null）
    //   (4) 距上次 stop 小于 shortCircuitWindowMs（默认 4s）
    // 则跳过 LLM judge，直接判定 nextSpeaker=user（无需续跑）。
    // 语义：Leader 刚停过且什么都没做（没派活、没调工具），短时间内又触发 stop judge
    //      → 必然空转，直接收尾。保留现有 continuationRetryCount latch 作兜底（短路只是更早跳过）。
    const shortCircuitEligible =
      !hasOpenWork
      && !hadNewToolCalls
      && msSinceLastStop !== undefined
      && msSinceLastStop < this.shortCircuitWindowMs;

    if (shortCircuitEligible) {
      // 记录短路判定到 trace（A4），确定性结构化条目
      this.appendDecisionTrace({
        source: 'evaluateContinuationAfterStop',
        nextSpeaker: 'user',
        reason: 'local_short_circuit_no_work_no_tools_recent_stop',
        shortCircuited: true,
        input: {
          finishReason: input.finishReason,
          openWorkCount: 0,
          hasRunningAgents,
          isEternalMode,
          hadNewToolCalls,
          msSinceLastStop,
          shortCircuitWindowMs: this.shortCircuitWindowMs,
        },
      });
      // 更新 lastStopTimestampMs：本次也判 user（收尾），视为新的"上次 stop"时刻。
      this.lastStopTimestampMs = nowMs;
      leaderLogger.debug(
        `[A5-shortcircuit] 跳过 LLM judge：无 open work + 无新工具调用 + 距上次 stop ${msSinceLastStop}ms < ${this.shortCircuitWindowMs}ms`,
      );
      return null;
    }

    const verdict = await evaluateNextSpeakerCandidate({
      finishReason: input.finishReason,
      content: input.content,
      hasOpenWork,
      hasExplicitUserGate,
      hasRunningAgents,
      isEternalMode,
      llm: this.createLeaderEventStreamClient('Leader-NextSpeakerJudge'),
      model: this.opts.getModel(),
      messages: this.opts.getConversation(),
      sessionId,
      actorLabel: 'Leader-NextSpeakerJudge',
    });

    // 记录非短路判定到 trace（A4），确定性结构化条目
    this.appendDecisionTrace({
      source: 'evaluateContinuationAfterStop',
      nextSpeaker: verdict.nextSpeaker,
      reason: verdict.reason,
      shortCircuited: false,
      input: {
        finishReason: input.finishReason,
        openWorkCount: 0, // hasOpenWork 是布尔；用 0/1 表达更结构化便于断言
        hasRunningAgents,
        isEternalMode,
        hadNewToolCalls,
        msSinceLastStop,
      },
    });
    // 无论 LLM 判 model 还是 user，本次 stop judge 已完成，更新"上次 stop"时刻。
    this.lastStopTimestampMs = nowMs;

    if (verdict.nextSpeaker === 'model') {
      const retry = ++this.continuationRetryCount;
      if (retry > this.MAX_CONTINUATION_RETRIES) {
        // 连续续跑耗尽且无工具推进：模型反复返回"截断"短 stop 或 open_work 恒为真
        // 却不实际派发。强制 latch waitingForUser，打破空转死循环。
        leaderLogger.warn(`Leader 连续续跑已达 ${retry} 次仍无工具推进 (reason=${verdict.reason})，强制进入等待`);
        this.continuationRetryCount = 0;
        this.opts.setWaitingForUser(true);
        return null;
      }
      this.opts.addMessage({ role: input.continuationRole, content: verdict.continuationPrompt || '请基于当前上下文接续未完成部分，已输出内容用承接方式处理。' });
      const c = this.opts.getConversation();
      await db.saveConversationMessage(sessionId, c[c.length - 1]);
      return { done: false };
    }

    // user 判定下，再问本地 stop hook 是否仍要继续。hook 是非 LLM 的本地信号源。
    const hook = await this.opts.maybeContinueFromStopHook(input.content);
    if (!hook.shouldContinue) {
      return null;
    }

    this.opts.addMessage({ role: input.continuationRole, content: hook.feedback || 'Stop Hook 要求继续推进当前会话。' });
    const c = this.opts.getConversation();
    await db.saveConversationMessage(sessionId, c[c.length - 1]);
    return { done: false };
  }

  async monitorUserInterventionDuringInFlight(input: {
    stopSignal: AbortSignal;
    onIntervention: () => void;
  }): Promise<void> {
    const { stopSignal } = input;
    await new Promise<void>((resolve) => {
      if (stopSignal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => resolve();
      stopSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  createToolScheduler(input?: {
    finishReason?: ChatResponse['finish_reason'];
    thinking?: ThinkingBlock[];
    wasOutputTruncated?: boolean;
  }): ToolScheduler<{ done: boolean; result?: string }> {
    return createLeaderToolScheduler({
      sessionId: this.opts.sessionId,
      emitter: this.opts.emitter,
      db: this.opts.db,
      finishReason: input?.finishReason,
      wasOutputTruncated: input?.wasOutputTruncated,
      planningGateBlockCount: this.planningGateBlockCount,
      setPlanningGateBlockCount: (value) => { this.planningGateBlockCount = value; },
      addMessage: (message) => this.opts.addMessage(message),
      getConversation: () => this.opts.getConversation(),
      setRawXmlRetryCount: (value) => this.opts.setRawXmlRetryCount(value),
      setEmptyResponseRetryCount: (value) => this.opts.setEmptyResponseRetryCount(value),
      isUserInterruptPending: () => this.opts.isUserInterruptPending(),
      getActiveTeam: this.opts.getActiveTeam,
      getCollaborationMode: this.opts.getCollaborationMode,
      peekNextTaskIds: this.opts.peekNextTaskIds,
      getTaskById: this.opts.getTaskById,
      executeToolCallsBatch: (toolCalls) => this.opts.executeToolCallsBatch(toolCalls),
      createFileSnapshot: this.opts.createFileSnapshot,
      getTurnCount: () => this.opts.getTurnCount(),
      isWaitingForUser: () => this.opts.isWaitingForUser(),
      isPendingReview: () => this.opts.isPendingReview(),
      isFinished: () => this.opts.isFinished(),
      isAgentCompletionPending: this.opts.isAgentCompletionPending,
      evaluateContinuationAfterStop: (continuationInput) => this.evaluateContinuationAfterStop(continuationInput),
    });
  }

  async processResponse(response: ChatResponse): Promise<{ done: boolean; result?: string }> {
    const { sessionId, emitter, db, tracker } = this.opts;

    const hasRealUsage = response.usage && response.usage.total_tokens > 0;
    if (hasRealUsage) {
      tracker.addUsage('leader', {
        prompt: response.usage!.prompt_tokens,
        completion: response.usage!.completion_tokens,
        total: response.usage!.total_tokens,
        cache_read: response.usage!.cache_read_input_tokens,
        cache_creation: response.usage!.cache_creation_input_tokens,
      }, this.opts.getModel());
    } else {
      // 回退估算：当 provider 不返回 usage 或 usage 为 0 时，本地估算
      // 只估算 completion tokens 作为增量（TUI 按增量累加，用完整对话历史会重复计算）
      let completionTokens = estimateTokens(response.content ?? '') + estimateTokens(thinkingBlocksToText(response.thinking));
      if (response.tool_calls) {
        for (const tc of response.tool_calls) {
          completionTokens += estimateTokens(tc.function?.arguments ?? '');
        }
      }
      if (completionTokens > 0) {
        leaderLogger.debug(`[token-fallback] usage=${JSON.stringify(response.usage)}, estimated completion=${completionTokens}`);
        tracker.addUsage('leader', {
          prompt: 0,
          completion: completionTokens,
          total: completionTokens,
        }, this.opts.getModel());
      }
    }

    if (response.tool_calls && response.tool_calls.length > 0) {
      // 真实工具调用代表有实质推进，清零续跑计数（防误熔断正常工作）
      this.continuationRetryCount = 0;
      // A5 短路信号：本轮有新工具调用，不满足"无新工具调用"条件
      this.hadToolCallsThisCycle = true;
      // ── 死循环探针：仅匹配 name+args 完全相同 ──
      this.toolLoopDetector.observe(response.tool_calls);
      if (this.toolLoopDetector.isLooping) {
        const sig = this.toolLoopDetector.currentSignature ?? '<unknown>';
        const streak = this.toolLoopDetector.consecutiveCount;
        leaderLogger.warn(
          `Leader 检测到工具死循环：${sig} 连续 ${streak} 次，注入提示并跳过本轮`,
        );
        this.opts.addMessage({
          role: 'system',
          content:
            `⚠️ [死循环保护] 你已用完全相同的参数连续调用同一个工具 ${streak} 次。` +
            `请改变参数（不同 file_path / pattern / query）或切换工具，或基于已有信息直接给出结论。`,
        });
        const c = this.opts.getConversation();
        await db.saveConversationMessage(sessionId, c[c.length - 1]);
        this.toolLoopDetector.reset();
        return { done: false };
      }

      const toolScheduler = this.createToolScheduler({
        finishReason: response.finish_reason,
        thinking: response.thinking,
        wasOutputTruncated: response.was_output_truncated,
      });
      const toolResult = await toolScheduler.run({
        assistantContent: response.content,
        toolCalls: response.tool_calls,
        thinking: response.thinking,
        wasOutputTruncated: response.was_output_truncated,
        toolCallContext: { source: 'native' },
      });
      return toolResult;
    }

    const final = contentToPlainText(response.content);
    const parsedToolCalls = parseRawToolCalls(final);

    if (parsedToolCalls) {
      // A5 短路信号：本轮有 raw_xml 工具调用，算实质推进
      this.hadToolCallsThisCycle = true;
      this.toolLoopDetector.observe(parsedToolCalls);
      if (this.toolLoopDetector.isLooping) {
        const sig = this.toolLoopDetector.currentSignature ?? '<unknown>';
        const streak = this.toolLoopDetector.consecutiveCount;
        leaderLogger.warn(
          `Leader 检测到工具死循环（raw_xml）：${sig} 连续 ${streak} 次`,
        );
        this.opts.addMessage({
          role: 'system',
          content:
            `⚠️ [死循环保护] 你已用完全相同的参数连续调用同一个工具 ${streak} 次，请改变参数或切换工具。`,
        });
        const c = this.opts.getConversation();
        await db.saveConversationMessage(sessionId, c[c.length - 1]);
        this.toolLoopDetector.reset();
        return { done: false };
      }

      const toolScheduler = this.createToolScheduler({
        finishReason: response.finish_reason,
        thinking: response.thinking,
        wasOutputTruncated: response.was_output_truncated,
      });
      const toolResult = await toolScheduler.run({
        assistantContent: final,
        toolCalls: parsedToolCalls,
        thinking: response.thinking,
        wasOutputTruncated: response.was_output_truncated,
        toolCallContext: { source: 'raw_xml' },
      });
      return toolResult.done ? toolResult : { done: false };
    }

    if (hasRawToolSyntax(final)) {
      this.opts.setRawXmlRetryCount(this.opts.getRawXmlRetryCount() + 1);
      if (this.opts.getRawXmlRetryCount() > 10) {
        leaderLogger.error('输出无效工具调用格式超过 10 次，结束本轮');
        return { done: true, result: '[错误] Leader 输出无效工具调用格式，已终止。' };
      }

      const warningMsg = '🚨 **系统拦截警报**\n系统检测到你的输出包含无效的工具调用格式。工具调用统一通过标准原生 Function Calling 协议发起；文本回复只写解释、结论或用户可见内容。';
      emitter.emit('leader:status', { sessionId, status: '⚠️ 格式纠正中...' });

      this.opts.addMessage({ role: 'assistant', content: final });
      const c1 = this.opts.getConversation();
      db.saveConversationMessage(sessionId, c1[c1.length - 1]);
      this.opts.addMessage({ role: 'system', content: warningMsg });
      const c2 = this.opts.getConversation();
      db.saveConversationMessage(sessionId, c2[c2.length - 1]);
      return { done: false };
    }

    const reasoning = thinkingBlocksToText(response.thinking).trim();
    if (!final.trim()) {
      if (reasoning) {
        emitter.emit('leader:text', { sessionId, content: '', reasoningContent: reasoning });
      }

      this.opts.setEmptyResponseRetryCount(this.opts.getEmptyResponseRetryCount() + 1);
      if (this.opts.getEmptyResponseRetryCount() > 10) {
        const errorMessage = '[错误] Leader 连续输出空响应超过 10 次，结束本轮。';
        this.opts.addMessage({ role: 'assistant', content: errorMessage });
        const c1 = this.opts.getConversation();
        db.saveConversationMessage(sessionId, c1[c1.length - 1]);
        emitter.emit('leader:text', { sessionId, content: errorMessage, reasoningContent: reasoning || undefined });
        return { done: true, result: errorMessage };
      }

      const retryPrompt = '你上一轮没有产出任何可见文本，请继续思考并采取下一步。';
      emitter.emit('leader:status', { sessionId, status: '⚠️ 空响应重试中...' });
      this.opts.addMessage({ role: 'system', content: retryPrompt });
      const c2 = this.opts.getConversation();
      db.saveConversationMessage(sessionId, c2[c2.length - 1]);
      return { done: false };
    }

    this.opts.setEmptyResponseRetryCount(0);
    if (final) {
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: final,
        thinking: response.thinking,
      };
      this.opts.addMessage(assistantMessage);
      db.saveConversationMessage(sessionId, assistantMessage);
    }

    const isStop = isStopFinishReason(response.finish_reason);
    if (!isStop) {
      this.opts.addMessage({ role: 'system', content: '请延续当前上下文继续输出，接续前文未完成部分。' });
      const c = this.opts.getConversation();
      db.saveConversationMessage(sessionId, c[c.length - 1]);
      return { done: false };
    }

    // Stop 响应的续跑判定统一收敛到 evaluateContinuationAfterStop：
    // 硬 finish_reason / open_work 约束 + LLM continuation judge，并接入 continuationRetryCount 熔断。
    const continuation = await this.evaluateContinuationAfterStop({
      finishReason: response.finish_reason,
      content: final,
      continuationRole: 'user',
    });
    if (continuation) return continuation;

    return { done: true, result: final };
  }

  async leaderThinkAndAct(maxToolRounds = LEADER_MAX_TOOL_ROUNDS): Promise<void> {
    const { sessionId, emitter, db } = this.opts;
    this.opts.setIsBusy(true);
    // A5 短路信号：每个 think 周期开始时清零，processResponse 内有工具调用则置 true
    this.hadToolCallsThisCycle = false;
    this.opts.setLastProgressAtMs(Date.now());
    emitter.emit('leader:busy', { sessionId, isBusy: true, queueLength: 0 });

    // Hot-reload model config
    const latestModel = runtimeConfig.llm.leader_model;
    if (latestModel && latestModel !== this.opts.getModel()) {
      this.opts.setModel(latestModel);
    }

    try {
      this.opts.syncSystemPrompt?.();
      this.opts.appendRuntimeContextManifestIfChanged();
      await this.opts.appendContextMemoryIfChanged?.();

      // 黑板架构：注入图分析上下文（作为 system 消息，不影响 LLM 决策）
      if (this.opts.getBlackboardAnalysis) {
        const analysis = this.opts.getBlackboardAnalysis();
        if (analysis) {
          const parts: string[] = ['## 黑板图分析（自动注入，供你参考已有知识）'];
          // 始终显示已知事实及其内容摘要（避免 LLM 误判黑板为空）
          if (analysis.recentFacts.length > 0) {
            parts.push(`已知事实 (${analysis.recentFacts.length}):`);
            for (const f of analysis.recentFacts.slice(0, 5)) {
              const contentPreview = f.content ? f.content.slice(0, 300) : '';
              parts.push(`  - [${f.id}] ${f.title}`);
              if (contentPreview) parts.push(`    摘要: ${contentPreview}`);
            }
          }
          if (analysis.openIntents.length > 0) {
            parts.push(`开放 Intent (${analysis.openIntents.length}):`);
            for (const i of analysis.openIntents.slice(0, 5)) {
              parts.push(`  - [${i.id}] ${i.title}${i.content ? `: ${i.content.slice(0, 100)}` : ''}`);
            }
          }
          if (analysis.unresolvedContradictions.length > 0) {
            parts.push(`矛盾 (${analysis.unresolvedContradictions.length}):`);
            for (const c of analysis.unresolvedContradictions.slice(0, 3)) {
              parts.push(`  - ${c.nodeA.title} ↔ ${c.nodeB.title}`);
            }
          }
          if (analysis.knowledgeGaps.length > 0) {
            parts.push(`知识缺口: ${analysis.knowledgeGaps.slice(0, 3).join(', ')}`);
          }
          if (analysis.completionSignals.length > 0) {
            parts.push(`完成信号: ${analysis.completionSignals.join(', ')}`);
          }
          if (analysis.recentFacts.length === 0 && analysis.openIntents.length === 0) {
            parts.push('黑板当前无数据。');
          }
          // 黑板图分析是状态镜像（每轮刷新、最新值即权威）→ 单槽 in-place，避免每轮 append 堆积。
          const blackboardContent = parts.join('\n');
          if (this.opts.upsertSystemSlot) {
            this.opts.upsertSystemSlot({ kind: 'prefix', prefix: '## 黑板图分析（自动注入' }, blackboardContent);
          } else {
            this.opts.addMessage({ role: 'system', content: blackboardContent });
          }
        }
      }

      const taskCountBefore = this.opts.getBoardTaskCount();
      const runningAgentsBefore = this.opts.getRunningAgentsCount();

      const core = new AgentCore<void>();
      await core.run({
        maxRounds: maxToolRounds,
        maxRuntimeMinutes: LEADER_MAX_RUNTIME_MINUTES,
        shouldStop: () => this.opts.isFinished(),
        onStopped: async () => undefined,
        onBoundReached: async (reason) => {
          const continuationMsg = reason === 'max_runtime'
            ? `Leader 达到最大运行时长窗口 (${LEADER_MAX_RUNTIME_MINUTES} 分钟)，继续推进`
            : `Leader 达到最大轮次窗口 (${maxToolRounds})，继续推进`;
          emitter.emit('leader:status', { sessionId, status: `♻️ ${continuationMsg}` });
          this.opts.addMessage({
            role: 'system',
            content: `运行时续跑：当前仍有会话工作需要推进。内部${reason === 'max_runtime' ? '时长' : '轮次'}窗口已到，请将该窗口视为预算刷新点并继续推进。`,
          });
          const c = this.opts.getConversation();
          await db.saveConversationMessage(sessionId, c[c.length - 1]);
          return { type: 'reset_budget' };
        },
        runRound: async (toolRound) => {
          const statusText = `Thinking (round ${toolRound})...`;
          emitter.emit('leader:status', { sessionId, status: statusText });
          leaderLogger.info(statusText);

          const streamSession = createLeaderStreamBufferSession({
            emitter,
            sessionId,
            flushThreshold: this.opts.streamBufferFlushThreshold,
            logToolCall: (name) => leaderLogger.debug(`\n工具调用：${name}`),
          });
          const { buffers } = streamSession;

          try {
            emitter.emit('leader:status', { sessionId, status: 'Context Managing...' });

            this.opts.contextManager.setMessages(this.opts.getConversation());
            const managed = await this.opts.contextManager.manage();
            this.opts.setConversation(managed);

            // 排空 bus 上的非打断式用户消息（interrupt:false 投递的 user_intervention），
            // 直接以 user role 注入对话；下一轮 LLM 调用立即看到并回复，避免被排队到
            // 下一次 leaderThinkAndAct 才处理。
            await this.opts.drainPendingUserMessages?.();

            // 注入非打断式用户指导消息（如有）
            const nudge = this.opts.getNudgeMessage?.();
            if (nudge) {
              this.opts.addMessage({
                role: 'system',
                content: `[用户指导（非打断式注入）] ${nudge}`,
              });
              this.opts.clearNudgeMessage?.();
              const c = this.opts.getConversation();
              await db.saveConversationMessage(sessionId, c[c.length - 1]);
            }

            emitter.emit('leader:status', { sessionId, status: 'Calling LLM...' });

            const useStreaming = ENABLE_STREAMING;
            // stop() 在发起 LLM call 前已被调用则立即中止本轮
            if (this.opts.isFinished()) {
              return { type: 'break' };
            }

            const interventionStopController = new AbortController();
            const interventionTask = this.monitorUserInterventionDuringInFlight({
              stopSignal: interventionStopController.signal,
              onIntervention: () => {},
            }).catch(() => undefined);

            const compactFn = this.opts.compactContext;
            const llmGuard = createLlmGuard({
              actorLabel: 'Leader',
              classifyError: classifyLLMError,
              maxRetries: this.opts.getLlmMaxErrorRetries(),
              backoffBaseMs: runtimeConfig.llm.backoff_base_ms,
              cbScope: 'leader',
              langfuseSessionId: sessionId,
              langfuseAgentId: 'Leader',
              langfuseTaskId: this.opts.getActiveTaskId?.(),
              onError: (error) => {
                leaderLogger.error(`LLM 流式错误: ${error instanceof Error ? error.message : String(error)}`);
              },
              onCompactNeeded: compactFn
                ? async () => { await compactFn(); }
                : undefined,
            });

            const llmAbort = new AbortController();
            this.opts.setCurrentLlmAbortController(llmAbort);

            // 对齐 CodeBuddy: LLM 请求发出前 emit model_requesting phase
            emitter.emit('leader:phase_change', { sessionId, phase: 'model_requesting' });

            let response: ChatResponse;
            try {
              const activeTools = this.opts.getActiveToolDefinitions();
              const inputManifest = buildLlmInputManifest({
                actor: 'leader',
                actorLabel: 'Leader',
                sessionId,
                model: this.opts.getModel(),
                messages: this.opts.getConversation(),
                tools: activeTools,
              });
              leaderLogger.debug(`[llm-input] ${summarizeLlmInputManifest(inputManifest)}`);
              emitter.emit('llm:input_manifest', {
                sessionId,
                actor: 'leader',
                actorLabel: 'Leader',
                manifest: inputManifest,
              });
              response = await llmGuard.call(
                this.opts.llm,
                this.opts.getConversation(),
                this.opts.getModel(),
                activeTools,
                useStreaming,
                llmAbort.signal,
                streamSession.hooks,
                {
                  actorType: 'leader',
                  actorLabel: 'Leader',
                  purpose: 'leader',
                  sessionId,
                },
                // 防漂移：Leader 主推理走确定性温度(默认 0)，避免任务分解/工具选择随机抖动
                getReasoningGenerateOptions(),
              );
            } catch (error) {
              // 用户中断（ESC / interrupt）不应重试，直接退出思考循环
              const errorMsg = error instanceof Error ? error.message : String(error);
              if (errorMsg.includes('aborted by caller') || llmAbort.signal.aborted) {
                leaderLogger.info('LLM 调用被用户中断，退出思考循环');
                return { type: 'break' };
              }

              // CircuitBreaker OPEN：provider 整体不可用，主动 sleep 到探针窗口
              // 而不是 200ms 高频 retry 形成死循环。sleep 期间 emit 等待状态。
              if (error instanceof CircuitOpenError) {
                const waitMs = error.retryAfterMs;
                const waitSec = Math.ceil(waitMs / 1000);
                leaderLogger.warn(
                  `Leader CB OPEN provider="${error.providerKey}"，sleep ${waitSec}s 等待 HALF_OPEN 探针窗口`,
                );
                emitter.emit('leader:status', {
                  sessionId,
                  status: `🛑 Provider 暂不可用，${waitSec}s 后自动重试...`,
                });
                emitter.emit('leader:error', { sessionId, error: classifyLLMError(error) });
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                // 不再 setLlmErrorRetryCount(0) — 那会清零外层计数器导致无限 sleep 循环。
                // 用外层 retry 计数器追踪连续 CB OPEN sleep，到达上限后停下等待用户介入。
                const cbRetry = this.opts.getLlmErrorRetryCount() + 1;
                this.opts.setLlmErrorRetryCount(cbRetry);
                const outerMax = this.opts.getLlmMaxErrorRetries();
                if (cbRetry >= outerMax) {
                  leaderLogger.error(
                    `Leader CB OPEN 已连续 ${cbRetry}/${outerMax} 次仍未恢复，停下等待用户介入`,
                  );
                  emitter.emit('leader:status', {
                    sessionId,
                    status: `🛑 Provider 持续不可用：等待人工介入`,
                  });
                  const stopMsg = `🛑 [系统终止] Provider 持续不可用（Circuit Breaker 已连续触发 ${cbRetry}/${outerMax} 次）。请检查 provider 状态或更换模型后再继续。`;
                  this.opts.addMessage({ role: 'system', content: stopMsg });
                  const c2 = this.opts.getConversation();
                  await db.saveConversationMessage(sessionId, c2[c2.length - 1]);
                  this.opts.setLlmErrorRetryCount(0);
                  this.opts.setWaitingForUser(true);
                  return { type: 'break' };
                }
                return { type: 'continue' };
              }

              const classified = classifyLLMError(error);
              const errorLabel = formatLLMErrorLabel(classified);
              const retryCount = llmGuard.getRetryCount();

              // 打印完整错误详情（含堆栈）
              const rawDetail = error instanceof Error
                ? `${error.message}\n${error.stack ?? ''}`
                : String(error);
              leaderLogger.error(`LLM ${errorLabel} 第 ${retryCount} 次，继续重试... 完整错误: ${rawDetail}`);
              emitter.emit('leader:error', { sessionId, error: classified });

              // === 上下文溢出兜底：HTTP 413 / context_length_exceeded ===
              // 重试同样的输入只会反复 413，必须主动触发硬重置压缩；
              // 也不应该往对话里追加错误 system 消息（会让上下文更大）。
              if (classified.llmErrorKind === 'context_overflow') {
                const ctxMgr = this.opts.contextManager;
                const tokens = await ctxMgr.getTokenCount().catch(() => 0);
                const threshold = ctxMgr.getThreshold();
                leaderLogger.warn(
                  `Leader 收到 ${classified.statusCode ?? '?'} ${errorLabel}，先同步压缩再重试`,
                );
                let shouldRetry = false;
                try {
                  const compacted = await this.opts.compactContext?.();
                  shouldRetry = Boolean(
                    compacted
                      && compacted.compacted
                      && !compacted.overflow
                      && !compacted.inProgress
                      && compacted.newTokens < compacted.oldTokens,
                  );
                  if (shouldRetry && compacted) {
                    leaderLogger.warn(`context_overflow 后压缩完成: ${compacted.oldTokens} -> ${compacted.newTokens}`);
                  } else {
                    leaderLogger.warn(
                      `context_overflow 后未获得有效压缩结果，停止盲重试: ${compacted
                        ? `${compacted.oldTokens} -> ${compacted.newTokens}, compacted=${String(compacted.compacted)}, overflow=${String(compacted.overflow)}, inProgress=${String(compacted.inProgress)}`
                        : 'no compact result'}`,
                    );
                    emitter.emit('context:overflow', { sessionId, tokens, threshold, owner: 'leader' });
                  }
                } catch (compactErr) {
                  leaderLogger.warn(`context_overflow 同步压缩失败，退回硬重置: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`);
                  emitter.emit('context:overflow', { sessionId, tokens, threshold, owner: 'leader' });
                }
                this.toolLoopDetector.reset();
                this.opts.setLlmErrorRetryCount(0);
                return { type: shouldRetry ? 'continue' : 'break' };
              }

              // === 鉴权 / 配额耗尽：retry 没用，必须打断进程并等待用户 ===
              // 注入一条明显的 system 消息让 Leader 停下，并 break 思考循环。
              if (
                classified.llmErrorKind === 'auth_error' ||
                classified.llmErrorKind === 'quota_exhausted'
              ) {
                const isAuth = classified.llmErrorKind === 'auth_error';
                leaderLogger.error(
                  `Leader 收到 ${classified.statusCode ?? '?'} ${errorLabel}，已停止思考循环等待人工处理`,
                );
                emitter.emit('leader:status', {
                  sessionId,
                  status: isAuth
                    ? `🛑 ${errorLabel}：请检查 API Key`
                    : `🛑 ${errorLabel}：请充值或更换模型`,
                });
                const stopMsg = isAuth
                  ? `🛑 [系统终止] LLM 鉴权失败（${classified.statusCode ?? ''} ${classified.message}）。请前往设置检查或更换 API Key 后再继续。`
                  : `🛑 [系统终止] LLM 额度耗尽（${classified.statusCode ?? ''} ${classified.message}）。请充值、切换 provider 或更换可用模型后再继续。`;
                this.opts.addMessage({ role: 'system', content: stopMsg });
                const c2 = this.opts.getConversation();
                await db.saveConversationMessage(sessionId, c2[c2.length - 1]);
                this.opts.setLlmErrorRetryCount(0);
                this.opts.setWaitingForUser(true);
                return { type: 'break' };
              }

              // === 外层 retry 计数：LlmGuard 内部已穷尽自身 5 次预算后才会抛到这里。
              // 历史 bug：每个 catch 分支都 setLlmErrorRetryCount(0) 立即清零，
              // 外层 retry 永远 0 → 立即 continue 重新建 LlmGuard 又跑 5 次 → 死循环。
              // 修复：每次进 catch 累加，到 LLM_MAX_ERROR_RETRIES 即停下等待用户。
              const outerRetry = this.opts.getLlmErrorRetryCount() + 1;
              this.opts.setLlmErrorRetryCount(outerRetry);
              const outerMax = this.opts.getLlmMaxErrorRetries();
              if (outerRetry >= outerMax) {
                leaderLogger.error(
                  `Leader 外层 LLM 重试已达 ${outerRetry}/${outerMax} 次仍失败 (${errorLabel})，停下等待用户介入`,
                );
                emitter.emit('leader:status', {
                  sessionId,
                  status: `🛑 LLM 反复失败 (${errorLabel})：等待人工介入`,
                });
                const stopMsg = `🛑 [系统终止] LLM 调用反复失败（${errorLabel}: ${classified.message}），外层已自动重试 ${outerRetry}/${outerMax} 次仍未恢复。请检查网络 / provider 状态后再继续。\n完整错误: ${rawDetail}`;
                this.opts.addMessage({ role: 'system', content: stopMsg });
                const c2 = this.opts.getConversation();
                await db.saveConversationMessage(sessionId, c2[c2.length - 1]);
                this.opts.setLlmErrorRetryCount(0);
                this.opts.setWaitingForUser(true);
                return { type: 'break' };
              }

              // 注入错误通知，然后继续重试。
              // 400 provider_error 时不追加 system 消息——消息格式问题追加 system 只会让序列更不合法，
              // 且 LlmGuard 的 compact 已尝试清理历史。用 user 角色注入避免中间 system 消息触发 400。
              const isBadRequest = classified.llmErrorKind === 'provider_error' && classified.statusCode === 400;
              if (!isBadRequest) {
                const errorReportMsg = [
                  `⚠️ [系统通知] LLM 调用失败（${errorLabel}: ${classified.message}），外层已自动重试 ${outerRetry}/${outerMax} 次。`,
                  `完整错误: ${rawDetail}`,
                  '系统将继续自动重试。请等待恢复后继续工作。',
                ].join('\n');
                this.opts.addMessage({ role: 'system', content: errorReportMsg });
                const c = this.opts.getConversation();
                await db.saveConversationMessage(sessionId, c[c.length - 1]);
              } else {
                // 400: 只记日志，不注入消息——避免雪上加霜
                leaderLogger.warn(
                  `Leader 400 provider_error 外层重试 ${outerRetry}/${outerMax}：不注入 system 消息，依赖 compact+sanitizer 恢复`,
                );
              }

              // 外层退避：LlmGuard 内部已穷尽，立即 continue 等于 0ms 高频重试。
              // 用 outerRetry 做线性退避（1s / 2s / 3s ... 封顶 30s），给上游网络喘息时间。
              const outerBackoffMs = Math.min(outerRetry * 1000, 30_000);
              await new Promise((resolve) => setTimeout(resolve, outerBackoffMs));
              return { type: 'continue' }; // 继续思考循环，不中断
            } finally {
              buffers.flushAll();
              buffers.dispose();
              interventionStopController.abort();
              await interventionTask;
            }

            this.opts.setLlmErrorRetryCount(0);
            const responseText = contentToPlainText(response.content);

            // LLM 响应完成，清除计时状态
            if (response.tool_calls?.length) {
              emitter.emit('leader:status', { sessionId, status: '执行工具...' });
            } else {
              emitter.emit('leader:status', { sessionId, status: '✓ 响应完成' });
            }

            if (responseText) {
              emitter.emit('leader:text', { sessionId, content: responseText, reasoningContent: thinkingBlocksToText(response.thinking) });
            }

            const result = await this.processResponse(response);

            // hasNewWork = 本轮 Leader 是否真正"改变了工作状态"——新建任务 或 派发了新 agent。
            //
            // 关键：不能用 hadToolCalls（只要调了任何工具就 true）。check_agent_progress /
            // file_read / team_manage(action="task_board") 等只读监控也是工具调用，但它们不产生新工作。
            // 若用 hadToolCalls，则 Leader 每次"看一眼进度就停"都被判 hasNewWork → 走
            // `done && hasNewWork` 分支、永不 latch waitingForUser → 主循环里只要还有
            // dispatchable 任务就反复 think，表现为"我没开 eternal 却无限请求 LLM"。
            // 也不能算"有 worker 在跑"——那是已委派、在途的活，Leader 应等待而非续跑。
            // 用户语义确认：派发后安静等 agent；只读监控算空闲应进入等待。
            const dispatchedNewAgent = this.opts.getRunningAgentsCount() > runningAgentsBefore;
            const createdNewTask = this.opts.getBoardTaskCount() > taskCountBefore;
            const hasNewWork = createdNewTask || dispatchedNewAgent;
            const hasDispatchableWorkAfter = this.opts.hasDispatchableWork();
            const hasRunningAgentsAfter = this.opts.getRunningAgentsCount() > 0;

            const pendingSignals = this.opts.getPendingAgentCompletionSignals();
            if (pendingSignals.length > 0) {
              leaderLogger.info(`Agent completion signals pending — breaking for immediate verification`);
              return { type: 'break' };
            }

            if (this.opts.isFinished() || this.opts.isWaitingForUser() || this.opts.isPendingReview()) {
              return { type: 'break' };
            }

            if (result.done && !hasNewWork) {
              const hasExplicitUserGate = this.opts.hasExplicitUserGate();
              const allowOpenWorkGuard = this.opts.isEternalMode?.() === true;
              if (allowOpenWorkGuard && hasDispatchableWorkAfter && !hasRunningAgentsAfter && !hasExplicitUserGate) {
                this.openWorkDecisionRetryCount += 1;
                if (this.openWorkDecisionRetryCount <= this.MAX_OPEN_WORK_DECISION_RETRIES) {
                  leaderLogger.info('[OpenWorkGuard] 仍有可派发任务，继续一轮要求 Leader 明确派发或解释暂缓原因');
                  this.opts.addMessage({
                    role: 'system',
                    content: [
                      '[Open Work Guard] 当前仍有 ready/dispatchable 任务，且没有运行中的 worker、没有用户审批/权限/ask_user 门。',
                      '本轮不能直接进入等待。请对每个 ready 任务执行以下之一：',
                      '1. 立即 dispatch_agent 派发或复用 worker；',
                      '2. 如果确实暂不派发，必须向用户说明具体、可核验的暂缓原因。',
                    ].join('\n'),
                  });
                  const c = this.opts.getConversation();
                  await db.saveConversationMessage(sessionId, c[c.length - 1]);
                  return { type: 'continue' };
                }
              } else {
                this.openWorkDecisionRetryCount = 0;
              }

              // 停止前自检：验证所有任务是否有工作笔记
              const tasks = this.opts.getAllTasks?.() || [];
              const terminalTasks = tasks.filter(t => isTaskTerminalStatus(t));
              const hasUnreportedTasks = terminalTasks.some(t => {
                // 检查已完成任务是否有结果但没有被 Leader 验收
                return normalizeTaskStatus(t) === 'completed' && !t.result;
              });

              if (hasUnreportedTasks && terminalTasks.length > 0) {
                // 有未报告的任务，不进入等待，让 Leader 继续思考
                leaderLogger.info('[自检] 发现已完成但无结果的任务，继续思考而非停止');
                this.opts.addMessage({
                  role: 'system',
                  content: '[系统自检] 检测到有已完成的任务缺少结果记录。请检查所有任务状态，确保每个已完成的任务都有完整的结果摘要，然后再决定是否等待用户。',
                });
                return { type: 'continue' };
              }

              leaderLogger.debug('LLM 本轮结束，无新工作产出，进入等待');
              emitter.emit('leader:status', { sessionId, status: '等待用户输入...' });
              emitter.emit('leader:busy', { sessionId, isBusy: false, queueLength: 0 });
              this.opts.setWaitingForUser(true);
              db.setSessionState(sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
              return { type: 'break' };
            }

            if (result.done && hasNewWork) {
              leaderLogger.debug('LLM 本轮结束，但有新工作，继续执行');
              emitter.emit('leader:phase_change', { sessionId, phase: 'observing' });
              return { type: 'break' };
            }
            return { type: 'continue' };
          } catch (err) {
            // LlmGuard 已内化处理所有重试逻辑，此处不应到达（LlmGuard 超限后直接 throw）
            // 但保留 catch 以捕获 contextManager.manage() 等非 LLM 错误
            const error = err instanceof Error ? err : new Error(String(err));
            leaderLogger.error(`LLM 循环内未预期错误: ${error.message}`);
            emitter.emit('leader:error', { sessionId, error });

            // 工具执行等非致命错误：注入系统消息让 LLM 知道发生了什么，继续循环
            // 只有 LLM 调用本身的致命错误才应该由 LlmGuard 抛出并终止
            const errorMsg = error.message;
            const isFatal = errorMsg.includes('context window') || errorMsg.includes('token limit') || errorMsg.includes('rate limit');
            if (isFatal) {
              return { type: 'break' };
            }

            // 非致命错误：告知 LLM，让它决定下一步
            this.opts.addMessage({
              role: 'system',
              content: `[系统通知] 上一步操作出错: ${errorMsg}。请评估错误影响并决定下一步操作。`,
            });
            const c = this.opts.getConversation();
            await db.saveConversationMessage(sessionId, c[c.length - 1]);
            return { type: 'continue' };
          }
        },
      });

      if (this.opts.isWaitingForUser()) {
        emitter.emit('leader:status', { sessionId, status: '等待用户输入...' });
        emitter.emit('leader:busy', { sessionId, isBusy: false, queueLength: 0 });
      } else if (this.opts.isFinished()) {
        emitter.emit('leader:status', { sessionId, status: 'Leader 已终止' });
        emitter.emit('leader:busy', { sessionId, isBusy: false, queueLength: 0 });
      }
    } finally {
      this.opts.setIsBusy(false);
      emitter.emit('leader:busy', { sessionId, isBusy: false, queueLength: 0, reason: 'leader_finally' });
    }
  }
}
