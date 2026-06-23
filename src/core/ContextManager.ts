import { contentToPlainText, type ChatMessage, type MessageContent } from '../llm/types.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import { config as runtimeConfig } from '../config.js';
import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import {
  createInitialContextRuntimeState,
  getContextRuntimeStateKey,
  loadPersistedContextRuntimeState,
  type ContextCompactRecord,
  type ContextRuntimeState,
  recordContextCompaction,
  updateContextRuntimeObservation,
} from './ContextRuntimeState.js';
import { coreLogger } from './Log.js';
import {
  calculateTokens,
  calculateThreshold,
  calculateRequestBytes,
  calculateByteThreshold,
} from './compress/ContextTokenCalculator.js';
import { countTokens } from '../llm/token_counter.js';
import { CompressionPipeline } from './compress/CompressionPipeline.js';
import { ContextDAG } from './compress/ContextDAG.js';
import {
  truncateOversizedMessages,
  createOversizedArchiveWriter,
} from './compress/MessageByteTruncator.js';
import type { ContextOwner, FileRecord } from './compress/CompressionTypes.js';
import { renderContextManifest } from './ContextManifest.js';
import { compressionRuns } from './Metrics.js';
import { CONTRACT_PACK_MARKER } from './ContractPack.js';
import { HierarchicalContextManager } from './HierarchicalContextManager.js';
import type { JudgmentLlmGuardFactory } from './JudgmentService.js';
import { CheckpointService } from './checkpoint/CheckpointService.js';
import { ContextRebuilder } from './checkpoint/ContextRebuild.js';
import { microCompact } from './checkpoint/MicroCompact.js';

export type { ContextOwner } from './compress/CompressionTypes.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const RECENT_FILES_CAPACITY = 10;

function defaultLeaderModel(): string {
  return runtimeConfig.llm.leader_model;
}

/**
 * 解析「有效上下文上限」单一事实源——显示分母（runtimeState.maxTokens）与压缩触发阈值
 * 同源，保证状态栏百分比自动诚实。
 *
 * 优先级：context.token_limit（用户意图的「有效工作上限」）> 模型真实窗口 > llm.context_max_tokens > 200K。
 * token_limit 未设时自动跟随模型窗口；显式设置则优先于模型窗口，压缩在其 ~80% 触发。
 */
export function resolveEffectiveContextLimit(modelContextLimit: number): number {
  const tokenLimit = Number(runtimeConfig.context?.token_limit);
  if (Number.isFinite(tokenLimit) && tokenLimit > 0) return Math.max(1, tokenLimit);
  if (Number.isFinite(modelContextLimit) && modelContextLimit > 0) {
    return Math.max(1, modelContextLimit);
  }
  const configuredModelLimit = Number(runtimeConfig.llm?.context_max_tokens);
  return Number.isFinite(configuredModelLimit) && configuredModelLimit > 0
    ? configuredModelLimit
    : 200_000;
}

/**
 * ContextManager - 分层上下文管理器
 *
 * 负责消息状态、最近文件追踪、运行时状态广播。
 * 压缩逻辑统一委托给 CompressionPipeline。
 */
export class ContextManager {
  private maxTokens: number;
  private model: string;
  private sessionId?: string;
  private db?: DatabaseManager;
  private llmClient?: ContentGenerator;
  private emitter?: EventEmitter;
  private messages: ChatMessage[] = [];
  private threshold: number;
  private recentFiles: Map<string, FileRecord> = new Map();
  private consecutiveFailures = 0;
  private owner: ContextOwner;
  private runtimeState: ContextRuntimeState;
  private cachedTokenCount: number | null = null;
  private pipeline: CompressionPipeline;
  /**
   * single-flight 守卫：正在进行的压缩 Promise。
   * 并发 manage() 调用若都判定需要压缩，会各自基于「同一份旧 messages」跑压缩，
   * 后完成的把先完成的结果覆盖掉，可能丢消息/重复压缩。用此 Promise 把并发调用
   * 收敛到同一次压缩，后来者直接 await 同一结果。
   */
  private compacting: Promise<ChatMessage[]> | null = null;
  /** 请求体字节预算（HTTP 413 兜底），0/未配置则关闭字节维度 */
  private maxRequestBytes: number;
  /** 单条消息字节上限（超过即中段截断+归档） */
  private maxSingleMessageBytes: number;
  /** ContextManager 自身消息缓冲上限，避免绕过 Agent/Leader addMessage 时无限增长 */
  private maxMessages: number;
  /** P1-1h: proactive compression trigger at 70% of budget. 0 = disabled. */
  private proactiveCompactThreshold: number;
  private llmGuardFactory?: JudgmentLlmGuardFactory;
  private hierarchicalContext = new HierarchicalContextManager();
  private checkpointService: CheckpointService | null = null;

  constructor(
    maxTokens: number = Number(runtimeConfig.llm?.context_max_tokens) || 200_000,
    model: string = defaultLeaderModel(),
    sessionId?: string,
    db?: DatabaseManager,
    llmClient?: ContentGenerator,
    emitter?: EventEmitter,
    owner: ContextOwner = { kind: 'leader' },
    llmGuardFactory?: JudgmentLlmGuardFactory,
    /** P1-1g: per-role context budget override. Takes precedence over maxTokens. */
    contextBudget?: number,
  ) {
    // P1-1g: contextBudget overrides maxTokens when provided (>0)
    const effectiveMaxTokens = contextBudget && contextBudget > 0
      ? contextBudget
      : resolveEffectiveContextLimit(maxTokens);
    this.maxTokens = effectiveMaxTokens;
    this.model = model;
    this.sessionId = sessionId;
    this.db = db;
    this.llmClient = llmClient;
    this.emitter = emitter;
    this.owner = owner;
    this.llmGuardFactory = llmGuardFactory;
    this.threshold = calculateThreshold(this.maxTokens, this.model);
    this.maxRequestBytes = Number(runtimeConfig.context?.max_request_bytes) || 0;
    this.maxSingleMessageBytes = Number(runtimeConfig.context?.max_single_message_bytes) || 0;
    this.maxMessages = Math.max(0, Number(runtimeConfig.agents?.max_agent_messages) || 0);
    // P1-1h: proactive compression at 70% of maxTokens
    this.proactiveCompactThreshold = Math.floor(this.maxTokens * 0.7);
    this.runtimeState = createInitialContextRuntimeState(owner, this.threshold, this.sessionId, this.maxTokens);
    this.pipeline = new CompressionPipeline({
      maxTokens: this.maxTokens,
      threshold: this.threshold,
      model: this.model,
      sessionId: this.sessionId,
      db: this.db,
      llmClient: this.llmClient,
      llmGuardFactory: this.llmGuardFactory,
      emitter: this.emitter,
      owner: this.owner,
      maxRequestBytes: this.maxRequestBytes,
      maxSingleMessageBytes: this.maxSingleMessageBytes,
      maxRecentMessageCount: Number(runtimeConfig.context?.max_recent_message_count) || undefined,
      recentWindowTokenBudget: Number(runtimeConfig.context?.recent_window_token_budget) || undefined,
      postCompactTokenBudget: Number(runtimeConfig.context?.post_compact_token_budget) || undefined,
    });
    // Initialize checkpoint service if we have a session and workspace
    if (this.sessionId) {
      this.checkpointService = new CheckpointService({
        workspace: process.cwd(),
        sessionId: this.sessionId,
      });
    }
    this.loadPersistedRuntimeState();
  }

  /**
   * 切换模型时同步更新 context window 大小。
   */
  updateModel(modelId: string, contextLimit?: number): void {
    this.model = modelId;
    if (contextLimit && contextLimit > 0) {
      this.maxTokens = resolveEffectiveContextLimit(contextLimit);
      this.threshold = calculateThreshold(this.maxTokens, this.model);
      this.runtimeState = {
        ...this.runtimeState,
        maxTokens: this.maxTokens,
        threshold: this.threshold,
      };
      this.pipeline.updateOptions({
        maxTokens: this.maxTokens,
        threshold: this.threshold,
        model: this.model,
      });
      this.emitRuntimeState('observe');
    } else {
      this.pipeline.updateOptions({ model: this.model });
    }
  }

  setMessages(messages: ChatMessage[]): void {
    this.messages = this.collapseRuntimeContractPackMessages(messages);
    this.cachedTokenCount = null;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  getThreshold(): number {
    return this.threshold;
  }

  getRuntimeState(): ContextRuntimeState {
    return {
      ...this.runtimeState,
      compactHistory: [...this.runtimeState.compactHistory],
    };
  }

  addMessage(role: 'system' | 'user' | 'assistant' | 'tool', content: MessageContent): void {
    const message: ChatMessage = { role, content, timestamp: Date.now() / 1000 };
    if (this.isRuntimeContractPackMessage(message)) {
      const existingIndex = this.messages.findIndex((msg) => this.isRuntimeContractPackMessage(msg));
      if (existingIndex >= 0) {
        this.messages[existingIndex] = message;
        this.cachedTokenCount = null;
        return;
      }
    }
    this.messages.push(message);
    this.messages = this.trimMessageBuffer(this.messages, 3, this.maxMessages);
    this.cachedTokenCount = null;
  }

  /**
   * 主要入口：只在真正 overflow 时触发压缩（LLM 返回 413/context_length_exceeded）。
   * 平时不做任何主动裁剪，保持历史完整性。
   */
  async manage(): Promise<ChatMessage[]> {
    // autocompact 关闭时，不执行任何上下文管理
    if (runtimeConfig.context?.autocompact_enabled === false) {
      return this.messages;
    }

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      coreLogger.warn(
        `${this.sessionId} 熔断器开启，跳过压缩 (${this.consecutiveFailures} 连续失败)`,
      );
      return this.messages;
    }

    // 只计数用于 runtime state，不触发主动压缩
    const currentTokens = await this.getTokenCount();

    // Checkpoint 写入（不触发压缩）
    if (this.checkpointService && this.llmClient) {
      this.checkpointService.tryStartAsync(this.messages, this.llmClient, this.maxTokens);
    }

    // 不再主动压缩：等待 LLM 返回 overflow 错误后，由外层 LlmGuard/overflow handler 调用 forceCompact()
    this.updateRuntimeState({ currentTokens }, 'observe');
    return this.messages;
  }

  /** 实际执行一次压缩。仅由 manage() 在 single-flight 守卫下调用。 */
  private async runCompaction(): Promise<ChatMessage[]> {
    // Checkpoint 写入已上移到 manage()，每轮评估边界（见上）。此处不再触发，
    // 避免压缩点重复写入。压缩只负责内存预算，落盘由 checkpoint 独立完成。
    let result: Awaited<ReturnType<CompressionPipeline['run']>>;
    try {
      result = await this.pipeline.run(this.messages, {
        recentFiles: this.recentFiles,
        compactType: 'auto',
      });
    } catch (error) {
      return this.fallbackToHardResetAfterCompactionFailure(error);
    }

    this.messages = result.messages;
    this.cachedTokenCount = result.newTokens;
    this.updateRuntimeState({ currentTokens: result.newTokens }, 'observe');

    // 溢出确定性兜底：LLM/分层压缩后仍超阈值（result.overflow）时，不再把超限消息原样
    // 发给 provider（必然 context_length_exceeded）。改用 ContextDAG 做无 LLM、无关键词的
    // 结构压缩——把最旧 tool_result/assistant 替换为 breadcrumb 或整组原子丢弃，迭代到低于阈值。
    if (result.overflow) {
      const reduced = await this.reduceOverflowWithDag(this.messages);
      if (reduced) {
        const reducedTokens = await calculateTokens(reduced, this.model);
        this.messages = reduced;
        this.cachedTokenCount = reducedTokens;
        // 溢出已被 DAG 解决：标记为已压缩、不再 emit context:overflow。
        result = {
          ...result,
          messages: reduced,
          newTokens: reducedTokens,
          compacted: true,
          overflow: false,
          compactType: this.joinCompactType(result.compactType, 'dag_structural_trim'),
        };
        this.updateRuntimeState({ currentTokens: reducedTokens }, 'compact');
      }
    }

    if (result.compacted || result.overflow || result.llmFailed) {
      this.handleCompactionResult(result, 'auto');
    }

    return this.messages;
  }

  /** 拼接压缩类型标签（去重）。 */
  private joinCompactType(...parts: Array<string | undefined>): string | undefined {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of parts) {
      if (!part) continue;
      for (const piece of part.split('+')) {
        const trimmed = piece.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          out.push(trimmed);
        }
      }
    }
    return out.length > 0 ? out.join('+') : undefined;
  }

  /**
   * 溢出兜底：用 ContextDAG 做确定性结构压缩（无 LLM、无关键词启发式）。
   *
   * 性能策略：先用 DAG 内部 bytes/3 快估算迭代（不跑 tiktoken）判断能否降到目标；
   * 仅当估算表明能降到阈值以下时，才做**一次**真实 token 计数复核。这样在"明显降不动"
   * （如几乎全是 user/system 消息、无可压 tool_result）的常见溢出场景下零 tiktoken 开销，
   * 直接交回调用方 emit overflow / hardReset。
   *
   * @returns 压缩后的消息；若无法降到阈值以下则返回 null（调用方再走 hardReset）
   */
  private async reduceOverflowWithDag(messages: ChatMessage[]): Promise<ChatMessage[] | null> {
    if (messages.length < 4) return null;
    try {
      const desiredAfter = Math.floor(this.threshold * 0.75);
      const dag = new ContextDAG();
      dag.fromMessages(messages);

      // bytes/3 快估算迭代（不跑 tiktoken）。
      let estimate = dag.getActiveTokenEstimate();
      if (estimate <= desiredAfter) return null;
      for (let attempt = 0; attempt < 4 && estimate > desiredAfter; attempt++) {
        const target = Math.max(estimate - desiredAfter, Math.floor(desiredAfter * 0.2));
        dag.structuralTrim(target);
        const next = dag.getActiveTokenEstimate();
        if (next >= estimate) break; // 无进展
        estimate = next;
      }
      // 估算都降不到阈值 → 快速放弃（零 tiktoken），交回调用方 emit overflow / hardReset。
      if (estimate > this.threshold) return null;

      const reduced = dag.toMessages();
      if (reduced.length === 0) return null;
      // 单次真实计数复核：确实达标才采用。
      const finalTokens = await calculateTokens(reduced, this.model);
      if (finalTokens <= this.threshold) {
        coreLogger.info(
          `[ContextManager] ${this.sessionId || '(no-session)'} DAG 溢出兜底: 估算 ${estimate.toLocaleString()} → 真实 ${finalTokens.toLocaleString()} tokens`,
        );
        return reduced;
      }
      return null;
    } catch (error) {
      coreLogger.warn(
        `[ContextManager] DAG 溢出压缩失败: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private async fallbackToHardResetAfterCompactionFailure(error: unknown): Promise<ChatMessage[]> {
    const nextFailures = this.consecutiveFailures + 1;
    coreLogger.warn(
      `[ContextManager] ${this.sessionId || '(no-session)'} 压缩失败，fallback 到 hard reset: ${error instanceof Error ? error.message : String(error)}`,
    );

    // Try context rebuild if checkpoint service is available
    if (this.checkpointService && this.sessionId) {
      const originalCount = this.messages.length;
      const rebuilt = await this.tryContextRebuild();
      if (rebuilt) {
        // The rebuild recovers context, but it must still record WHY we reset — otherwise a
        // compression-failure fallback is indistinguishable from a normal rebuild downstream.
        // Prepend a Context Manifest reset summary carrying reset_reason=compression_failed_fallback.
        const resetManifest: ChatMessage = {
          role: 'assistant',
          content: renderContextManifest({
            scope: 'reset',
            sessionId: this.sessionId,
            runtime: this.getRuntimeState(),
            reset: {
              reason: 'compression_failed_fallback',
              originalMessages: originalCount,
              retainedMessages: rebuilt.length + 1,
              retainedRecentMessages: rebuilt.length,
            },
          }),
          timestamp: Date.now() / 1000,
        };
        this.messages = [resetManifest, ...rebuilt];
        this.cachedTokenCount = null;
        this.consecutiveFailures = nextFailures;
        this.updateRuntimeState({ consecutiveFailures: this.consecutiveFailures }, 'failure');
        this.persistCurrentMessages();
        return this.messages;
      }
    }

    const preservedMessages = this.messages.slice(0, 3);
    const resetMessages = this.hardReset({
      messages: this.messages,
      preservedMessages,
      recentCount: 15,
      reason: 'compression_failed_fallback',
    });
    this.consecutiveFailures = nextFailures;
    this.updateRuntimeState({ consecutiveFailures: this.consecutiveFailures }, 'failure');
    return resetMessages;
  }

  /**
   * Attempt to rebuild context from checkpoint and persisted sources.
   * Returns the rebuilt messages or null if rebuild is not possible.
   */
  private async tryContextRebuild(): Promise<ChatMessage[] | null> {
    try {
      const rebuilder = new ContextRebuilder({
        workspace: process.cwd(),
        sessionId: this.sessionId!,
        db: this.db,
      });

      const recoveryContext = rebuilder.buildRecoveryContext();

      // If recovery context is essentially empty (just framing), fall through to hard reset
      if (!recoveryContext.includes('<!-- REBUILD:')) {
        return null;
      }

      // Build recovery system message
      const recoveryMessage: ChatMessage = {
        role: 'system',
        content: recoveryContext,
        timestamp: Date.now() / 1000,
      };

      // Micro-compact the tail of recent messages
      const tailSize = 10;
      const tail = this.messages.slice(-tailSize);
      const compactedTail = microCompact(tail);

      this.messages = [recoveryMessage, ...compactedTail];
      // 预算校验：重建上下文（recovery system + tail）从未校验过 token 预算。大 checkpoint
      // + 大 memory + 非 compactable tail（think/todowrite/submit 结果 MicroCompact 原样保留）
      // 可能让重建后仍超阈值，紧接着又触发压缩 → ping-pong。这里递减最旧 tail 直到达标。
      await this.shrinkRebuildToBudget();
      this.cachedTokenCount = null;
      this.persistCurrentMessages();

      coreLogger.info(
        `[ContextManager] ${this.sessionId} context rebuilt from checkpoint with ${compactedTail.length} micro-compacted tail messages`,
      );

      return this.messages;
    } catch (err) {
      coreLogger.warn(
        `[ContextManager] Context rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 重建后预算收敛：保留首条 recovery system 消息，从第二条（最旧 tail）起逐条丢弃，
   * 直到当前 token 低于阈值。避免重建上下文超阈值后立即又触发压缩 ping-pong。
   * 至少保留 recovery + 1 条，防止退化到空对话。
   */
  private async shrinkRebuildToBudget(): Promise<void> {
    let tokens = await this.getTokenCount();
    let guard = 0;
    while (tokens > this.threshold && this.messages.length > 2 && guard++ < 64) {
      // messages[0] = recovery system；丢弃 messages[1]（最旧 tail）。
      this.messages = [this.messages[0], ...this.messages.slice(2)];
      this.cachedTokenCount = null;
      tokens = await this.getTokenCount();
    }
  }

  private truncateOversizedMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!this.maxSingleMessageBytes || this.maxSingleMessageBytes <= 0) {
      return messages;
    }
    const archiveWriter = createOversizedArchiveWriter({
      owner: this.owner,
      sessionId: this.sessionId,
    });
    const result = truncateOversizedMessages(messages, {
      maxSingleMessageBytes: this.maxSingleMessageBytes,
      archiveWriter,
    });
    if (result.truncatedCount > 0) {
      coreLogger.info(
        `${this.sessionId} 硬重置阶段截断 ${result.truncatedCount} 条巨型消息，节省约 ${(result.bytesSaved / 1024).toFixed(0)}KB`,
      );
    }
    return result.messages;
  }

  hardReset(input: {
    messages: ChatMessage[];
    preservedMessages?: ChatMessage[];
    recentCount: number;
    reason: string;
  }): ChatMessage[] {
    const originalMessages = input.messages;
    const seen = new Set<ChatMessage>();
    const preserved: ChatMessage[] = [];
    const recent: ChatMessage[] = [];
    const pushUnique = (target: ChatMessage[], message: ChatMessage | undefined | null) => {
      if (!message || seen.has(message)) return;
      seen.add(message);
      target.push(message);
    };

    for (const message of input.preservedMessages ?? []) {
      pushUnique(preserved, message);
    }
    for (const message of originalMessages.slice(-input.recentCount)) {
      pushUnique(recent, message);
    }

    const resetSummary: ChatMessage = {
      role: 'assistant',
      content: renderContextManifest({
        scope: 'reset',
        sessionId: this.sessionId || '(unknown)',
        runtime: this.getRuntimeState(),
        reset: {
          reason: input.reason,
          originalMessages: originalMessages.length,
          retainedMessages: preserved.length + 1 + recent.length,
          retainedRecentMessages: recent.length,
        },
      }),
      timestamp: Date.now() / 1000,
    };

    const rawMessages = [...preserved, resetSummary, ...recent];
    this.messages = this.truncateOversizedMessages(rawMessages);
    this.cachedTokenCount = null;
    this.consecutiveFailures = 0;
    this.updateRuntimeState({
      consecutiveFailures: this.consecutiveFailures,
    }, 'reset');
    this.persistCurrentMessages();
    return this.messages;
  }

  async getTokenCount(messages: ChatMessage[] = this.messages): Promise<number> {
    if (this.cachedTokenCount !== null && messages === this.messages) {
      return this.cachedTokenCount;
    }
    const totalTokens = await calculateTokens(messages, this.model);
    if (messages === this.messages) {
      this.cachedTokenCount = totalTokens;
      this.updateRuntimeState({ currentTokens: totalTokens }, 'observe');
    }
    return totalTokens;
  }

  async forceCompact(): Promise<{
    oldTokens: number;
    newTokens: number;
    compacted: boolean;
    compactType?: string;
    overflow?: boolean;
    archivePath?: string;
    inProgress?: boolean;
    threshold?: number;
  }> {
    // 与 manage() 共享 single-flight 槽 this.compacting：若自动压缩正在跑，先等它完成
    // （它会把 this.messages 更新到最新），再基于最新 messages 做手动 forceRun，
    // 避免两者并发对 this.messages / cachedTokenCount 写写竞态。
    if (this.compacting) {
      await this.compacting;
    }

    const beforeCount = this.messages.length;
    const oldTokens = await this.getTokenCount();

    coreLogger.warn(
      `[ContextManager.forceCompact] ${this.sessionId || '(no-session)'} 强制压缩触发 (通常因 LLM overflow): beforeMessages=${beforeCount} beforeTokens=${oldTokens}`,
    );

    const runPromise = this.pipeline.forceRun(this.messages, {
      recentFiles: this.recentFiles,
      compactType: 'manual',
    });
    // 占用 single-flight 槽（映射为 ChatMessage[] 兼容 manage() 的 return this.compacting；
    // 失败映射回当前 messages，确保槽不 reject、不连累 manage() 的调用方），
    // 阻止 manage() 在手动压缩期间并发启动自动压缩。
    this.compacting = runPromise.then((r) => r.messages, () => this.messages);
    try {
      const result = await runPromise;

      const afterCount = result.messages.length;
      const removedMessages = beforeCount - afterCount;
      const tokenDelta = oldTokens - result.newTokens;

      coreLogger.warn(
        `[ContextManager.forceCompact] ${this.sessionId || '(no-session)'} 压缩完成: afterMessages=${afterCount} afterTokens=${result.newTokens} removedMessages=${removedMessages} tokenDelta=${tokenDelta} compacted=${result.compacted} overflow=${result.overflow}`,
      );

      this.messages = result.messages;
      this.cachedTokenCount = result.newTokens;
      this.updateRuntimeState({ currentTokens: result.newTokens }, 'observe');

      if (result.compacted || result.overflow || result.llmFailed) {
        this.handleCompactionResult(result, 'manual');
      }

      return {
        oldTokens: result.oldTokens,
        newTokens: result.newTokens,
        compacted: result.compacted,
        compactType: result.compactType,
        overflow: result.overflow,
        archivePath: result.archivePath,
        inProgress: result.inProgress,
        threshold: this.threshold,
      };
    } finally {
      this.compacting = null;
    }
  }

  trackFileRead(filePath: string, content: string): void {
    const perFileChars = Math.max(100_000, Math.min(2_000_000, this.maxTokens * 4 / 100));
    const capped = content.length > perFileChars
      ? content.slice(0, perFileChars) + `\n...(truncated at ${Math.round(perFileChars / 1024)}KB, model ctx ${Math.round(this.maxTokens / 1000)}K tokens)`
      : content;
    this.recentFiles.set(filePath, {
      content: capped,
      timestamp: Date.now(),
    });

    if (this.recentFiles.size > RECENT_FILES_CAPACITY) {
      let oldest: [string, FileRecord] | null = null;
      for (const [path, record] of this.recentFiles.entries()) {
        if (!oldest || record.timestamp < oldest[1].timestamp) {
          oldest = [path, record];
        }
      }
      if (oldest) {
        this.recentFiles.delete(oldest[0]);
      }
    }

    this.updateRuntimeState({
      recentFileCount: this.recentFiles.size,
      recentFiles: Array.from(this.recentFiles.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp)
        .map(([path, record]) => ({
          path,
          timestamp: record.timestamp,
          charCount: record.content.length,
          tokenEstimate: countTokens(record.content),
        })),
    }, 'file_read');
  }

  clear(): void {
    this.messages = [];
    this.recentFiles.clear();
    this.consecutiveFailures = 0;
    this.cachedTokenCount = null;
    this.checkpointService?.resetWatermark();
    this.runtimeState = createInitialContextRuntimeState(this.owner, this.threshold, this.sessionId, this.maxTokens);
    this.persistRuntimeState();
    this.emitRuntimeState('clear');
  }

  // ─── 内部辅助 ─────────────────────────────────────────────────────────

  private isRuntimeContractPackMessage(msg: ChatMessage): boolean {
    return msg.role === 'system'
      && contentToPlainText(msg.content).trim().startsWith(CONTRACT_PACK_MARKER);
  }

  private collapseRuntimeContractPackMessages(messages: ChatMessage[]): ChatMessage[] {
    let lastContractPackIndex = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (this.isRuntimeContractPackMessage(messages[i])) {
        lastContractPackIndex = i;
      }
    }
    if (lastContractPackIndex < 0) {
      return messages;
    }
    return messages.filter((msg, index) => !this.isRuntimeContractPackMessage(msg) || index === lastContractPackIndex);
  }

  private trimMessageBuffer(
    messages: ChatMessage[],
    protectedCount: number,
    maxMessages: number,
  ): ChatMessage[] {
    if (!maxMessages || maxMessages <= 0 || messages.length <= maxMessages) {
      return messages;
    }

    return this.hierarchicalContext.buildContext(messages, {
      protectedCount,
      maxMessages,
      currentFiles: Array.from(this.recentFiles.keys()),
      activeErrors: this.extractActiveErrorSignals(messages),
      largeOutputBytes: this.maxSingleMessageBytes > 0 ? this.maxSingleMessageBytes : undefined,
    }).messages;
  }

  private applyHierarchicalContextBudget(): void {
    if (!this.maxMessages || this.maxMessages <= 0 || this.messages.length <= this.maxMessages) {
      return;
    }

    const beforeCount = this.messages.length;
    const result = this.hierarchicalContext.buildContext(this.messages, {
      protectedCount: 1,
      maxMessages: this.maxMessages,
      currentFiles: Array.from(this.recentFiles.keys()),
      activeErrors: this.extractActiveErrorSignals(this.messages),
      largeOutputBytes: this.maxSingleMessageBytes > 0 ? this.maxSingleMessageBytes : undefined,
    });

    if (result.messages.length !== this.messages.length) {
      const afterCount = result.messages.length;
      const removed = beforeCount - afterCount;
      coreLogger.warn(
        `[HierarchicalBudget] ${this.sessionId || '(no-session)'} trimmed messages: before=${beforeCount} after=${afterCount} removed=${removed} maxMessages=${this.maxMessages} hot=${result.hotCount} warm=${result.warmCount} cold=${result.coldCount} demoted=${result.demotedCount}`,
      );
      this.messages = result.messages;
      this.cachedTokenCount = null;
    }
  }

  private extractActiveErrorSignals(messages: ChatMessage[]): string[] {
    const signals: string[] = [];
    for (let i = messages.length - 1; i >= 0 && signals.length < 3; i -= 1) {
      const message = messages[i];
      if (message.role !== 'tool') continue;
      const text = contentToPlainText(message.content).trim();
      if (text.startsWith('ERROR:')) {
        signals.push(text.slice(0, 500));
      }
    }
    return signals;
  }

  /** 处理压缩结果：失败计数、压缩历史、持久化、overflow 通知 */
  private handleCompactionResult(
    result: Awaited<ReturnType<CompressionPipeline['run']>>,
    compactType: string,
  ): void {
    compressionRuns.inc({
      owner: this.owner.kind,
      mode: compactType,
      outcome: result.overflow ? 'overflow' : result.llmFailed ? 'llm_failed' : result.compacted ? 'compacted' : 'observed',
    });
    if (result.llmFailed) {
      this.consecutiveFailures += 1;
      this.updateRuntimeState({ consecutiveFailures: this.consecutiveFailures }, 'failure');
    }

    const resolvedCompactType = result.compactType
      || (compactType === 'manual' ? 'manual' : 'hierarchical');

    if (result.compacted) {
      const compactRecord: ContextCompactRecord = {
        timestamp: Date.now() / 1000,
        oldTokens: result.oldTokens,
        newTokens: result.newTokens,
        compactType: resolvedCompactType,
        archivePath: result.archivePath,
        messageCount: this.messages.length,
      };

      this.recordCompact(compactRecord);
      this.persistCurrentMessages();
    } else {
      this.updateRuntimeState({ currentTokens: result.newTokens }, 'observe');
    }

    if (result.overflow) {
      this.consecutiveFailures += 1;
      this.updateRuntimeState({ consecutiveFailures: this.consecutiveFailures }, 'failure');
      if (this.emitter && this.sessionId) {
        this.emitter.emit('context:overflow', {
          sessionId: this.sessionId,
          tokens: result.newTokens,
          threshold: this.threshold,
          owner: this.owner.kind,
          agentId: this.owner.agentId,
          agentName: this.owner.agentName,
        });
      }
      return;
    }

    if (!result.llmFailed) {
      this.consecutiveFailures = 0;
    }
    this.updateRuntimeState({ consecutiveFailures: this.consecutiveFailures }, 'compact');
  }

  private persistCurrentMessages(): void {
    if (!this.db || !this.sessionId) return;

    try {
      if (this.owner.kind === 'agent' && this.owner.agentId) {
        this.db.replaceAgentConversation(
          this.sessionId,
          this.owner.agentId,
          this.owner.agentName || this.owner.agentId,
          this.messages,
        );
      } else {
        this.db.replaceConversation(this.sessionId, this.messages);
      }
    } catch (error) {
      coreLogger.warn(`[ContextManager] 同步上下文消息到数据库失败: ${error}`);
    }
  }

  private loadPersistedRuntimeState(): void {
    if (!this.db || !this.sessionId || typeof this.db.getSessionState !== 'function') return;
    const persisted = loadPersistedContextRuntimeState(this.db, this.sessionId, this.owner);
    if (!persisted) return;
    this.runtimeState = {
      ...this.runtimeState,
      // maxTokens/threshold 是配置派生值（resolveEffectiveContextLimit / calculateThreshold 实时算），
      // 必须用实例当前值，绝不被旧会话的持久化值覆盖——否则切模型/改 token_limit 后显示仍停留在旧窗口。
      maxTokens: this.maxTokens,
      threshold: this.threshold,
      currentTokens: persisted.currentTokens,
      warningLevel: persisted.warningLevel,
      consecutiveFailures: persisted.consecutiveFailures,
      recentFileCount: persisted.recentFileCount,
      recentFiles: persisted.recentFiles,
      lastArchivePath: persisted.lastArchivePath,
      lastCompact: persisted.lastCompact,
      compactHistory: persisted.compactHistory,
    };
  }

  private updateRuntimeState(
    patch: Partial<ContextRuntimeState>,
    reason: 'observe' | 'compact' | 'failure' | 'file_read' | 'clear' | 'reset' = 'observe',
  ): void {
    const nextBase = updateContextRuntimeObservation(this.runtimeState, patch);
    this.runtimeState = {
      ...nextBase,
      recentFiles: patch.recentFiles ? [...patch.recentFiles] : this.runtimeState.recentFiles,
      compactHistory: patch.compactHistory ? [...patch.compactHistory] : this.runtimeState.compactHistory,
      lastCompact: patch.lastCompact ?? this.runtimeState.lastCompact,
    };
    this.persistRuntimeState();
    this.emitRuntimeState(reason);
  }

  private recordCompact(record: ContextCompactRecord): void {
    this.runtimeState = recordContextCompaction(this.runtimeState, record);
    this.updateRuntimeState({
      consecutiveFailures: this.consecutiveFailures,
      recentFileCount: this.recentFiles.size,
      lastArchivePath: record.archivePath,
      lastCompact: record,
      compactHistory: this.runtimeState.compactHistory,
    }, 'compact');
  }

  private persistRuntimeState(): void {
    if (!this.db || !this.sessionId || typeof this.db.setSessionState !== 'function') return;
    this.db.setSessionState(this.sessionId, getContextRuntimeStateKey(this.owner), this.runtimeState);
  }

  private emitRuntimeState(_reason: 'observe' | 'compact' | 'failure' | 'file_read' | 'clear' | 'reset'): void {
    if (!this.emitter || !this.sessionId) return;
    this.emitter.emit('context:runtime_updated', {
      sessionId: this.sessionId,
      owner: this.owner.kind,
      ownerName: this.owner.agentName,
      state: this.getRuntimeState(),
    });
  }
}

export default ContextManager;
