/**
 * CompressionPipeline — 上下文压缩统一编排器
 *
 * 本 Pipeline 仅处理"会话上下文"压缩。
 *
 * 不在此处理：
 *   - SoulCompressor：人格/历史记忆压缩，由 SessionManager 调用；
 *   - BlackboardCompressor：黑板快照压缩，由 LeaderBlackboard / ContextMemoryIndex 调用。
 *
 * 这是有意的边界，不要"再统一一次"。
 *
 * 流程：
 *   1. 阈值判定（forceRun 跳过）
 *   2. PRE_COMPACT Hook
 *   3. 默认 LLM 分块/递归摘要
 *   4. 文件快照注入 + 二次截断
 *   5. POST_COMPACT Hook
 *
 * 设计原则：
 * - 不持有消息状态，所有数据通过参数传递
 * - 所有 token 计算统一通过 ContextTokenCalculator
 * - 内部状态仅 _compressing 守卫（防 await 期间重入）
 */

import { mkdirSync, readdirSync, unlinkSync, promises as fsp } from 'fs';
import { join } from 'path';
import {
  contentToPlainText,
  type ChatMessage,
} from '../../llm/types.js';
import { sanitizeOpenAIToolMessageSequence } from '../../llm/message_sanitizer.js';
import { getReasoningGenerateOptions } from '../../llm/reasoningSampling.js';
import { coreLogger } from '../Log.js';
import { SESSION_KEYS } from '../SessionStateKeys.js';
import { executePreCompact, executePostCompact } from '../hooks/executor.js';
import {
  calculateTokens,
  batchCalculateTokenCounts,
  calculateRequestBytes,
  calculateByteThreshold,
} from './ContextTokenCalculator.js';
import { countTokens } from '../../llm/token_counter.js';
import {
  truncateOversizedMessages,
  createOversizedArchiveWriter,
} from './MessageByteTruncator.js';
import type {
  CompressionPipelineOptions,
  CompressionRecord,
  CompressionResult,
  CompressionRunContext,
  ContextOwner,
  FileRecord,
} from './CompressionTypes.js';

const POST_COMPACT_MAX_FILES = 10;
const POST_COMPACT_TOKEN_BUDGET = 60_000;
const POST_COMPACT_MAX_TOKENS_PER_FILE = 6_000;
const RECENT_WINDOW_TOKEN_BUDGET = 50_000;
const MAX_RECENT_MESSAGE_COUNT = 24;
const MAX_SUMMARY_DEPTH = 3;
const MAX_EVIDENCE_ITEMS = 12;
const DETERMINISTIC_SUMMARY_CHAR_BUDGET = 40_000;
const DETERMINISTIC_HEAD_RECORDS = 12;
const DETERMINISTIC_TAIL_RECORDS = 48;

// 历史上用三个中文 marker 文本(text.includes)判定 pinned 摘要,违反禁止启发式。
// 改为结构化字段:压缩器注入摘要消息时打 metadata.kind='context_summary',这里按字段判定。
// 结构化消息种类见 src/llm/types.ts ChatMessageKind。

/**
 * 从文本行中确定性挑选保留行：head + tail 窗口（不再用关键词/扩展名正则挑行）。
 * 旧实现用关键词+文件扩展名正则筛选，会漏掉无关键词的关键行（纯数字错误、配置 diff）
 * 并误留含 'next'/'session' 等词的噪声行，违反"禁止启发式"原则。head/tail 窗口对日志、
 * 堆栈、工具输出都是可预测、无损的覆盖。导出供测试与算法层复用。
 */
function pickImportantLines(lines: string[], maxItems: number): string[] {
  if (lines.length <= maxItems) return uniqueLines(lines);
  const headCount = Math.max(1, Math.floor(maxItems / 2));
  const head = lines.slice(0, headCount);
  const tail = lines.slice(-(maxItems - headCount));
  return uniqueLines([...head, ...tail]);
}

/** 去重保持顺序。 */
function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

export class CompressionPipeline {
  private readonly options: CompressionPipelineOptions;
  /** 防止 await 期间被并发重入触发第二次压缩 */
  private _compressing = false;

  constructor(options: CompressionPipelineOptions) {
    this.options = options;
  }

  /** 同步刷新阈值 / 模型 / 上下文窗口（模型切换时调用） */
  updateOptions(patch: Partial<CompressionPipelineOptions>): void {
    Object.assign(this.options, patch);
  }

  get owner(): ContextOwner {
    return this.options.owner;
  }

  /**
   * 请求体字节触发阈值。未配置 maxRequestBytes 时返回 Infinity（关闭字节维度）。
   */
  private byteThreshold(): number {
    return this.options.maxRequestBytes
      ? calculateByteThreshold(this.options.maxRequestBytes)
      : Infinity;
  }

  /**
   * 标准压缩流程：只做阈值判定；触发后默认进入 LLM 压缩。
   */
  async run(
    messages: ChatMessage[],
    ctx: CompressionRunContext = {},
  ): Promise<CompressionResult> {
    if (this._compressing) {
      coreLogger.warn(`${this.options.sessionId} CompressionPipeline.run() 已在进行中，跳过重入`);
      const tokens = await this.calc(messages);
      return {
        messages,
        oldTokens: tokens,
        newTokens: tokens,
        compacted: false,
        inProgress: true,
      };
    }

    this._compressing = true;
    try {
      const oldTokens = await this.calc(messages);
      const oldBytes = calculateRequestBytes(messages);
      const byteThreshold = this.byteThreshold();

      // 触发重压缩的条件：token 超阈值 **或** 请求体字节超阈值。
      // 后者专治 HTTP 413（网关 body 字节上限）：token 远未达阈值、但序列化字节
      // 已超网关限制的场景（大量中文/JSON/base64），单看 token 永远不会压缩。
      if (oldTokens <= this.options.threshold && oldBytes <= byteThreshold) {
        return {
          messages,
          oldTokens,
          newTokens: oldTokens,
          oldBytes,
          newBytes: oldBytes,
          compacted: false,
        };
      }

      coreLogger.info(
        `${this.options.sessionId} 上下文过长 (tokens=${oldTokens.toLocaleString()}/${this.options.threshold.toLocaleString()}, bytes=${oldBytes.toLocaleString()}/${Number.isFinite(byteThreshold) ? byteThreshold.toLocaleString() : '∞'})，执行 LLM 压缩...`,
      );

      // PRE_COMPACT Hook
      await this.executePreCompactHook(ctx.compactType ?? 'auto');

      const result = await this.compress(messages, oldTokens, oldBytes, ctx);

      // POST_COMPACT Hook
      const tokensSaved = Math.max(0, result.oldTokens - result.newTokens);
      await this.executePostCompactHook(
        ctx.compactType ?? 'auto',
        tokensSaved,
        result.summary ?? '',
      );

      return result;
    } finally {
      this._compressing = false;
    }
  }

  /**
   * 强制压缩：跳过阈值检查，直接执行默认 LLM 压缩流程。
   * 用于 /compact 命令、context_overflow 硬重置等场景。
   */
  async forceRun(
    messages: ChatMessage[],
    ctx: CompressionRunContext = {},
  ): Promise<CompressionResult> {
    if (this._compressing) {
      coreLogger.warn(`${this.options.sessionId} CompressionPipeline.forceRun() 已在进行中，跳过重入`);
      const tokens = await this.calc(messages);
      return {
        messages,
        oldTokens: tokens,
        newTokens: tokens,
        compacted: false,
        inProgress: true,
      };
    }

    this._compressing = true;
    try {
      const oldTokens = await this.calc(messages);
      const oldBytes = calculateRequestBytes(messages);
      await this.executePreCompactHook(ctx.compactType ?? 'manual');
      const result = await this.compress(messages, oldTokens, oldBytes, ctx);
      await this.executePostCompactHook(
        ctx.compactType ?? 'manual',
        Math.max(0, result.oldTokens - result.newTokens),
        result.summary ?? '',
      );
      return result;
    } finally {
      this._compressing = false;
    }
  }

  // ─── Hook 集成 ──────────────────────────────────────────────────────────

  private async executePreCompactHook(compactType: string): Promise<void> {
    if (!this.options.sessionId) return;
    try {
      await executePreCompact(this.options.sessionId, compactType);
    } catch (error) {
      coreLogger.warn(
        `[CompressionPipeline] PRE_COMPACT hook failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async executePostCompactHook(
    compactType: string,
    tokensSaved: number,
    summary: string,
  ): Promise<void> {
    if (!this.options.sessionId) return;
    try {
      await executePostCompact(this.options.sessionId, compactType, tokensSaved, summary);
    } catch (error) {
      coreLogger.warn(
        `[CompressionPipeline] POST_COMPACT hook failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ─── 核心压缩流程 ─────────────────────────────────────────────────────────

  private async compress(
    messages: ChatMessage[],
    oldTokens: number,
    oldBytes: number,
    ctx: CompressionRunContext,
  ): Promise<CompressionResult> {
    this.emitCompacting('start', 'llm_summary', {
      percent: 2,
      oldTokens,
      threshold: this.options.threshold,
      messageCount: messages.length,
      label: 'Preparing LLM compression',
    });

    // Step 0：单条巨型消息「中段截断 + 全文归档」。
    // 必须在 pinned/recent 划分之前、且不受 messages.length < 12 早返回影响 ——
    // 单条几十万字节的消息（粘贴长文 / 巨大工具结果）无论落在 pinned 还是 recent，
    // 现有按整条 pop 的逻辑都缩不掉它，是 413 死循环的核心。这里先把它就地裁短。
    let oversizedTruncated = false;
    if (this.options.maxSingleMessageBytes && this.options.maxSingleMessageBytes > 0) {
      const archiveWriter = createOversizedArchiveWriter({
        owner: this.options.owner,
        sessionId: this.options.sessionId,
      });
      const truncResult = truncateOversizedMessages(messages, {
        maxSingleMessageBytes: this.options.maxSingleMessageBytes,
        archiveWriter,
      });
      if (truncResult.truncatedCount > 0) {
        messages = truncResult.messages;
        oversizedTruncated = true;
        coreLogger.info(
          `${this.options.sessionId} 单条巨型消息截断：${truncResult.truncatedCount} 条，节省约 ${(truncResult.bytesSaved / 1024).toFixed(0)}KB`,
        );
      }
    }

    // 消息太少无法做分层摘要；但若已做过单条截断，仍要返回截断后的结果（算压缩成功）。
    if (messages.length < 12) {
      return this.finishWithoutSummary(messages, oldTokens, oldBytes, oversizedTruncated);
    }

    const preservedIndexes = this.getPinnedIndexes(messages);
    const recentIndexes = await this.getRecentIndexes(messages, preservedIndexes);
    const middleMessages = messages.filter(
      (_message, index) => !preservedIndexes.has(index) && !recentIndexes.has(index),
    );

    if (middleMessages.length === 0) {
      return this.finishWithoutSummary(messages, oldTokens, oldBytes, oversizedTruncated);
    }

    const records = this.buildCompressionRecords(middleMessages);
    if (records.length === 0) {
      return this.finishWithoutSummary(messages, oldTokens, oldBytes, oversizedTruncated);
    }

    this.emitCompacting('progress', 'llm_summary', {
      percent: 8,
      oldTokens,
      threshold: this.options.threshold,
      messageCount: messages.length,
      label: 'Building compression archive',
    });

    const deterministicSummary = this.buildDeterministicSummary(records, 'LLM 压缩归档索引');
    const archivePath = await this.writeCompressionArchive(middleMessages, records, deterministicSummary);

    // 归档写盘失败时，绝不能继续做有损替换：中段消息一旦从候选集中剔除且无归档兜底，
    // 原始对话将永久丢失。此时放弃本次有损压缩，保留原始消息，
    // 等待下次压缩或人工介入，宁可不压缩也不丢数据。
    if (!archivePath) {
      coreLogger.warn(
        `${this.options.sessionId} 压缩归档写盘失败，放弃本次有损压缩以避免中段对话永久丢失，保留原始消息`,
      );
      // 即便分层摘要放弃，单条巨型消息截断已生效，仍算压缩成功。
      const result = await this.finishWithoutSummary(messages, oldTokens, oldBytes, oversizedTruncated);
      return { ...result, llmFailed: false };
    }

    const preservedMessages = messages.filter((_message, index) => preservedIndexes.has(index));
    const recentMessages = messages.filter((_message, index) => recentIndexes.has(index));

    // 只用 LLM 压缩，不回退本地算法。
    // LLM 不可用或失败时直接抛错，让调用方感知，不静默降级。
    let llmFailed = false;
    let summaryContent: string;
    if (!this.options.llmClient) {
      throw new Error('LLM 压缩失败：未配置 LLM 客户端（本地算法已禁用）');
    }
    this.emitCompacting('progress', 'llm_summary', {
      percent: 14,
      oldTokens,
      threshold: this.options.threshold,
      messageCount: messages.length,
      label: 'Summarizing conversation',
    });
    try {
      summaryContent = await this.buildHierarchicalSummary(records, archivePath);
    } catch (error) {
      llmFailed = true;
      coreLogger.warn(
        `[CompressionPipeline] ${this.options.sessionId} LLM 压缩失败，不回退本地算法: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }

    let candidateMessages: ChatMessage[] = [
      ...preservedMessages,
      {
        role: 'assistant',
        content: `[上下文压缩摘要]\n${summaryContent}`,
        // 结构化标记:下游(本类 getPinnedIndexes/truncateToThreshold)按此字段判定,不嗅探文本。
        metadata: { kind: 'context_summary' },
      },
      ...recentMessages,
    ];

    const fileAttachments = this.buildFileAttachments(ctx.recentFiles);
    if (fileAttachments) {
      const insertion = Math.min(candidateMessages.length, preservedMessages.length + 1);
      candidateMessages = [
        ...candidateMessages.slice(0, insertion),
        {
          role: 'assistant',
          content: `[上下文文件快照]\n## 最近访问文件快照\n${fileAttachments}`,
          // 结构化标记:truncateToThreshold 按字段识别并剔除文件快照,不嗅探文本前缀。
          metadata: { kind: 'context_file_snapshot' },
        },
        ...candidateMessages.slice(insertion),
      ];
    }

    this.emitCompacting('progress', 'finalizing', {
      percent: 94,
      oldTokens,
      threshold: this.options.threshold,
      messageCount: candidateMessages.length,
      label: 'Finalizing compressed context',
    });

    candidateMessages = sanitizeOpenAIToolMessageSequence(candidateMessages);
    let newTokens = await this.calc(candidateMessages);
    let newBytes = calculateRequestBytes(candidateMessages);
    const byteThreshold = this.byteThreshold();
    let truncated = false;
    let overflow = false;

    // 二次截断触发条件：token 超阈值 **或** 字节超阈值。
    if (newTokens > this.options.threshold || newBytes > byteThreshold) {
      coreLogger.warn(
        `${this.options.sessionId} 压缩后仍超限 (tokens=${newTokens.toLocaleString()}/${this.options.threshold.toLocaleString()}, bytes=${newBytes.toLocaleString()}/${Number.isFinite(byteThreshold) ? byteThreshold.toLocaleString() : '∞'})，尝试截断recent消息`,
      );
      candidateMessages = this.truncateToThreshold(candidateMessages, preservedMessages.length);
      candidateMessages = sanitizeOpenAIToolMessageSequence(candidateMessages);
      truncated = true;
      newTokens = await this.calc(candidateMessages);
      newBytes = calculateRequestBytes(candidateMessages);

      if (newTokens > this.options.threshold || newBytes > byteThreshold) {
        overflow = true;
        coreLogger.warn(
          `${this.options.sessionId} 二次截断后仍超限 (tokens=${newTokens.toLocaleString()}, bytes=${newBytes.toLocaleString()})`,
        );
      }
    }

    // 持久化 leader summary 给 worker 继承
    if (
      !overflow &&
      this.options.owner.kind === 'leader' &&
      this.options.db &&
      this.options.sessionId
    ) {
      const summaryTruncated = summaryContent.length > 8000
        ? summaryContent.slice(0, 8000) + '\n...(截断)'
        : summaryContent;
      this.options.db.setSessionState(
        this.options.sessionId,
        SESSION_KEYS.LEADER_CONTEXT_SUMMARY,
        summaryTruncated,
      );
    }

    coreLogger.info(
      `${this.options.sessionId} 压缩完成：tokens ${oldTokens.toLocaleString()} → ${newTokens.toLocaleString()}, bytes ${oldBytes.toLocaleString()} → ${newBytes.toLocaleString()}`,
    );

    this.emitCompacting('end', 'finalizing', {
      percent: 100,
      oldTokens,
      newTokens,
      threshold: this.options.threshold,
      messageCount: candidateMessages.length,
      label: 'Compression complete',
    });

    const finalCompactType = this.joinCompactTypes(
      oversizedTruncated ? 'oversized_message' : '',
      ctx.compactType === 'manual' ? 'manual' : '',
      this.options.llmClient && !llmFailed ? 'llm_summary' : 'llm_fallback',
    ) || 'llm_summary';

    if (!overflow) {
      this.emitCompressed(oldTokens, newTokens, candidateMessages.length, finalCompactType, archivePath);
    }

    return {
      messages: candidateMessages,
      oldTokens,
      newTokens,
      oldBytes,
      newBytes,
      compacted: true,
      compactType: finalCompactType,
      archivePath,
      summary: summaryContent,
      llmFailed,
      truncated,
      overflow,
    };
  }

  /** 发出「压缩进行中」事件，供 Web/TUI 显示进度（区别于终态 context:compressed）。 */
  private emitCompacting(
    phase: 'start' | 'progress' | 'end',
    stage: 'preparing' | 'llm_summary' | 'finalizing' | 'algorithmic',
    progress?: {
      index?: number;
      total?: number;
      percent?: number;
      oldTokens?: number;
      newTokens?: number;
      threshold?: number;
      messageCount?: number;
      label?: string;
    },
  ): void {
    if (!this.options.emitter || !this.options.sessionId) return;
    this.options.emitter.emit('context:compacting', {
      sessionId: this.options.sessionId,
      owner: this.options.owner.kind,
      ownerName: this.options.owner.agentName,
      stage,
      phase,
      chunkIndex: progress?.index,
      chunkTotal: progress?.total,
      percent: progress?.percent,
      oldTokens: progress?.oldTokens,
      newTokens: progress?.newTokens,
      threshold: progress?.threshold,
      messageCount: progress?.messageCount,
      label: progress?.label,
    });
  }

  private emitCompressed(
    oldTokens: number,
    newTokens: number,
    messageCount: number,
    compactType: string,
    archivePath?: string,
  ): void {
    if (!this.options.emitter || !this.options.sessionId) return;
    this.options.emitter.emit('context:compressed', {
      sessionId: this.options.sessionId,
      oldTokens,
      newTokens,
      messageCount,
      compactType,
      archivePath,
      owner: this.options.owner.kind,
      ownerName: this.options.owner.agentName,
    });
  }

  private async finishWithoutSummary(
    messages: ChatMessage[],
    oldTokens: number,
    oldBytes: number,
    oversizedTruncated: boolean,
  ): Promise<CompressionResult> {
    const compactType = this.joinCompactTypes(
      oversizedTruncated ? 'oversized_message' : '',
    );
    const compacted = !!compactType;
    const outputMessages = compacted ? sanitizeOpenAIToolMessageSequence(messages) : messages;
    const newTokens = await this.calc(outputMessages);
    const newBytes = calculateRequestBytes(outputMessages);
    const overflow = newTokens > this.options.threshold || newBytes > this.byteThreshold();

    this.emitCompacting('end', 'finalizing', {
      percent: 100,
      oldTokens,
      newTokens,
      threshold: this.options.threshold,
      messageCount: outputMessages.length,
      label: compacted ? 'Safety compaction complete' : 'No compressible context',
    });
    if (compacted && !overflow) {
      this.emitCompressed(oldTokens, newTokens, outputMessages.length, compactType);
    }

    return {
      messages: outputMessages,
      oldTokens,
      newTokens,
      oldBytes,
      newBytes,
      compacted,
      compactType,
      overflow,
    };
  }

  private joinCompactTypes(...parts: Array<string | undefined>): string | undefined {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const part of parts) {
      if (!part) continue;
      for (const piece of part.split('+')) {
        const trimmed = piece.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
    return result.length > 0 ? result.join('+') : undefined;
  }

  // ─── Token 计算（统一委托给 ContextTokenCalculator）──────────────────────

  private calc(messages: ChatMessage[]): Promise<number> {
    return calculateTokens(messages, this.options.model);
  }

  // ─── Pinned/recent 选择 ─────────────────────────────────────────────────

  private getPinnedIndexes(messages: ChatMessage[]): Set<number> {
    const pinned = new Set<number>();

    if (messages.length > 0) {
      pinned.add(0);
    }

    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        pinned.add(i);
        break;
      }
    }

    // 只 pin 最近一条压缩摘要(而非全部):更早的摘要不再 pin → 进入 middleMessages 被下一次
    // 分层摘要吸收。否则每次压缩都新增一条永久 pinned 摘要,context floor 单调膨胀,最终窗口被
    // 累积摘要填满、压缩退化为反复 no-op 却每次都打 LLM(#3)。(归档原文已 writeCompressionArchive 写盘留存。)
    // 判定走结构化字段 metadata.kind==='context_summary'(产出方注入),不再嗅探文本 marker(禁止启发式)。
    let latestSummaryIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].metadata?.kind === 'context_summary') {
        latestSummaryIndex = i;
      }
    }
    if (latestSummaryIndex >= 0) {
      pinned.add(latestSummaryIndex);
    }

    return pinned;
  }

  private async getRecentIndexes(messages: ChatMessage[], pinned: Set<number>): Promise<Set<number>> {
    const recent = new Set<number>();
    let tokenBudget = 0;
    let count = 0;

    const allTokenCounts = await batchCalculateTokenCounts(messages, this.options.model);

    for (let i = messages.length - 1; i >= 0; i--) {
      if (pinned.has(i)) continue;

      recent.add(i);
      tokenBudget += allTokenCounts[i];
      count += 1;

      if (count >= MAX_RECENT_MESSAGE_COUNT || tokenBudget >= RECENT_WINDOW_TOKEN_BUDGET) {
        break;
      }
    }

    // P1 修复：边界做 tool_use ↔ tool_result 配对校正，避免压缩后留下孤立 tool 消息。
    // 1) recent 内任何 role==='tool'，必须把它配对的 assistant.tool_calls 也拉进 recent。
    // 2) 反向：recent 内 assistant.tool_calls 的所有配对 role==='tool' 也要尽量拉进来
    //    （它们一般紧随其后，正常情况已被 token 累加吃进；防御一下被边界切断的情况）。
    // 3) 如果某个 role==='tool' 的配对 assistant 不在 recent 也不在 pinned 范围内，
    //    且无法整段拉入（例如已被 pinned 占位、或会形成跨度黑洞），则把这个孤立 tool 从 recent 剔除。
    const toolCallIdToAssistantIdx = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      const calls = messages[i].tool_calls;
      if (!calls?.length) continue;
      for (const c of calls) {
        if (c.id) toolCallIdToAssistantIdx.set(c.id, i);
      }
    }

    // 第 1 步：拉对应 assistant
    let changed = true;
    while (changed) {
      changed = false;
      for (const idx of Array.from(recent)) {
        const m = messages[idx];
        if (m.role === 'tool' && m.tool_call_id) {
          const owner = toolCallIdToAssistantIdx.get(m.tool_call_id);
          if (owner !== undefined && !recent.has(owner) && !pinned.has(owner)) {
            recent.add(owner);
            changed = true;
          }
        }
      }
    }

    // 第 2 步：拉 assistant 的全部 tool_result
    changed = true;
    while (changed) {
      changed = false;
      for (const idx of Array.from(recent)) {
        const m = messages[idx];
        if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
        const ids = new Set(m.tool_calls.map((c) => c.id).filter(Boolean));
        for (let j = idx + 1; j < messages.length; j++) {
          const cand = messages[j];
          if (cand.role !== 'tool') break;
          if (cand.tool_call_id && ids.has(cand.tool_call_id) && !recent.has(j) && !pinned.has(j)) {
            recent.add(j);
            changed = true;
          }
        }
      }
    }

    // 第 3 步：剔除真正孤立的 role==='tool'（owner 在 pinned 中或不存在）
    for (const idx of Array.from(recent)) {
      const m = messages[idx];
      if (m.role !== 'tool') continue;
      const owner = m.tool_call_id ? toolCallIdToAssistantIdx.get(m.tool_call_id) : undefined;
      if (owner === undefined || (!recent.has(owner) && !pinned.has(owner))) {
        // owner 不可达：删掉，避免 LLM 报 orphan tool
        recent.delete(idx);
      }
    }

    return recent;
  }

  // ─── 算法层：CompressionRecord 抽取 ─────────────────────────────────────

  private buildCompressionRecords(messages: ChatMessage[]): CompressionRecord[] {
    const records: CompressionRecord[] = [];
    const seenNoiseFingerprints = new Set<string>();

    messages.forEach((message, index) => {
      const rawText = this.stringifyMessage(message).trim();
      if (!rawText) return;

      const condensed = this.condenseMessage(message, rawText);
      if (!condensed?.text) return;

      const fingerprint = `${condensed.category}:${condensed.text}`;
      if (condensed.dedup && seenNoiseFingerprints.has(fingerprint)) return;
      if (condensed.dedup) seenNoiseFingerprints.add(fingerprint);

      records.push({
        id: `R-${String(index + 1).padStart(3, '0')}`,
        role: message.role,
        category: condensed.category,
        text: condensed.text,
        tokenEstimate: countTokens(condensed.text),
      });
    });

    return records;
  }

  private stringifyMessage(message: ChatMessage): string {
    const parts: string[] = [];
    const text = contentToPlainText(message.content).trim();
    if (text) parts.push(text);
    if (message.tool_calls?.length) {
      const toolNames = message.tool_calls.map((call) => call.function.name).join(', ');
      parts.push(`工具调用: ${toolNames}`);
    }
    return parts.join('\n');
  }

  private condenseMessage(
    message: ChatMessage,
    text: string,
  ): { category: CompressionRecord['category']; text: string; dedup: boolean } | null {
    if (!text) return null;

    if (message.tool_calls?.length) {
      const toolNames = message.tool_calls.map((call) => call.function.name).join(', ');
      return {
        category: 'tool_call',
        text: `工具调用: ${toolNames}${text ? `\n${this.compactPlainText(text, 240)}` : ''}`,
        dedup: false,
      };
    }

    // 结构化分类:产出方注入 metadata.kind,这里按字段判定消息用途并路由到对应压缩器。
    // 不再用 text.startsWith('任务统计：') / text.startsWith('收到 Agent 最新进展：') 嗅探内容(禁止启发式)。
    const kind = message.metadata?.kind;
    if (kind === 'task_board_snapshot') {
      return {
        category: 'task_board',
        text: this.compactTaskBoardSnapshot(text),
        dedup: true,
      };
    }

    if (kind === 'agent_report') {
      return {
        category: 'agent_report',
        text: this.compactAgentReport(text),
        dedup: false,
      };
    }

    if (message.role === 'tool') {
      return {
        category: 'tool',
        text: this.compactToolOutput(text),
        dedup: false,
      };
    }

    return {
      category: 'message',
      text: this.compactPlainText(text, 640),
      dedup: false,
    };
  }

  private compactTaskBoardSnapshot(text: string): string {
    // 确定性 head/tail 窗口:任务看板快照的结构(统计行 + 已完成 + 失败任务列表)天然头尾最重要
    // ——头部是汇总统计、尾部是最近失败任务。不再用 9 个硬编码中文行首前缀挑行(禁止启发式)。
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return this.limitText(text, 480);
    const selected = this.pickImportantLines(lines, 18);
    return this.limitText(selected.join('\n'), 480);
  }

  private compactAgentReport(text: string): string {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const preferred = this.pickImportantLines(lines, 16);
    const merged = preferred.length > 0 ? preferred : lines.slice(0, 12);
    return this.limitText(merged.join('\n'), 900);
  }

  private compactToolOutput(text: string): string {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const important = this.pickImportantLines(lines, 18);
    const head = lines.slice(0, 4);
    const tail = lines.slice(-3);
    const merged = this.uniqueLines([...head, ...important, ...tail]);
    return this.limitText(merged.join('\n'), this.recordCharBudget());
  }

  private recordCharBudget(): number {
    return Math.max(1, Math.floor(this.options.maxTokens / Math.max(1, MAX_RECENT_MESSAGE_COUNT)));
  }

  private compactPlainText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const important = this.pickImportantLines(lines, 12);
    const head = lines.slice(0, 4);
    const tail = lines.slice(-2);
    const merged = this.uniqueLines([...head, ...important, ...tail]).join('\n');
    return this.limitText(merged || text, maxChars);
  }

  private pickImportantLines(lines: string[], maxItems: number): string[] {
    return pickImportantLines(lines, maxItems);
  }

  private uniqueLines(lines: string[]): string[] {
    return uniqueLines(lines);
  }

  private limitText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... [截断 ${text.length - maxChars} 字符]`;
  }

  // ─── 摘要构建 ───────────────────────────────────────────────────────────

  private buildDeterministicSummary(records: CompressionRecord[], title = 'LLM 压缩回退摘要'): string {
    const routeHistory = this.readRouteHistory();
    const skillHistory = this.readSelectedSkillHistory();
    const byCategory = records.reduce<Record<string, number>>((acc, record) => {
      acc[record.category] = (acc[record.category] || 0) + 1;
      return acc;
    }, {});

    const highlights = this.buildDeterministicHighlights(records);

    return [
      '## 对话分层记忆',
      '',
      `- 模式: ${title}`,
      `- 作用域: ${this.options.owner.kind}${this.options.owner.agentName ? `/${this.options.owner.agentName}` : ''}`,
      this.options.sessionId ? `- 会话: ${this.options.sessionId}` : '',
      `- 记录数: ${records.length}`,
      `- 类别统计: ${Object.entries(byCategory).map(([key, value]) => `${key}=${value}`).join(', ')}`,
      routeHistory ? `- Leader route history: ${routeHistory}` : '',
      skillHistory ? `- Leader selected skills: ${skillHistory}` : '',
      '',
      '### 关键记录',
      highlights || '- 无',
    ].filter(Boolean).join('\n');
  }

  private buildDeterministicHighlights(records: CompressionRecord[]): string {
    const selected = new Map<string, CompressionRecord>();
    const add = (record: CompressionRecord) => selected.set(record.id, record);

    records.slice(0, DETERMINISTIC_HEAD_RECORDS).forEach(add);
    records.forEach((record) => {
      // 结构化保留：user 消息 + 非 message 类别（tool/tool_call/task_board/agent_report）。
      // 泛 message 中段仅靠 head/tail 窗口覆盖，不再用关键词/文件扩展名正则挑行（禁止启发式）。
      if (record.role === 'user' || record.category !== 'message') {
        add(record);
      }
    });
    records.slice(-DETERMINISTIC_TAIL_RECORDS).forEach(add);

    const ordered = Array.from(selected.values()).sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    const lines: string[] = [];
    let usedChars = 0;
    let omitted = 0;

    for (const record of ordered) {
      const line = `- [${record.id}][${record.role}/${record.category}] ${record.text}`;
      if (usedChars + line.length > DETERMINISTIC_SUMMARY_CHAR_BUDGET) {
        omitted++;
        continue;
      }
      lines.push(line);
      usedChars += line.length;
    }

    if (omitted > 0) {
      lines.push(`- [...][system] 因摘要预算限制省略 ${omitted} 条低优先级记录；完整原文已写入压缩归档。`);
    }

    return lines.join('\n');
  }

  private async buildHierarchicalSummary(
    records: CompressionRecord[],
    archivePath?: string,
  ): Promise<string> {
    if (!this.options.llmClient) {
      return this.buildDeterministicSummary(records, 'LLM 不可用回退');
    }

    const singlePassSource = this.recordsToSummaryText(records);
    const singlePassPrompt = this.buildSummaryPrompt(singlePassSource, 1, 1, 1, true);
    if (this.canUseSinglePassSummary(singlePassPrompt)) {
      this.emitCompacting('progress', 'llm_summary', {
        index: 1,
        total: 1,
        percent: 40,
        label: 'Summarizing conversation in one pass',
      });
      // 单次 LLM 压缩失败不回退分块递归，直接抛错让上层感知
      const finalSummarySource = await this.callSummaryLlm(singlePassPrompt, singlePassSource, 1, 'SinglePass');
      return this.wrapSummaryResult(records, finalSummarySource, archivePath, '单次 LLM 摘要');
    }

    return this.buildChunkedHierarchicalSummary(records, archivePath);
  }

  private async buildChunkedHierarchicalSummary(
    records: CompressionRecord[],
    archivePath?: string,
  ): Promise<string> {
    let layer = this.chunkRecordTexts(records).map((chunk) => chunk.join('\n\n'));
    let depth = 1;

    while (layer.length > 1 && depth <= MAX_SUMMARY_DEPTH) {
      const next: string[] = [];
      for (let i = 0; i < layer.length; i++) {
        const layerSpan = 70 / MAX_SUMMARY_DEPTH;
        const percent = Math.min(
          88,
          Math.round(16 + (depth - 1) * layerSpan + ((i + 1) / layer.length) * layerSpan),
        );
        this.emitCompacting('progress', 'llm_summary', {
          index: i + 1,
          total: layer.length,
          percent,
          label: `Summarizing chunk ${i + 1}/${layer.length}`,
        });
        next.push(await this.summarizeChunk(layer[i], depth, i + 1, layer.length));
      }
      layer = this.groupChunkTexts(next);
      depth += 1;
    }

    const finalSummarySource = layer.length === 1
      ? await (async () => {
          this.emitCompacting('progress', 'llm_summary', {
            index: 1,
            total: 1,
            percent: 90,
            label: 'Merging final summary',
          });
          return this.summarizeChunk(layer[0], depth, 1, 1, true);
        })()
      : (() => {
          throw new Error('LLM 压缩失败：分块层级超过最大深度，无法合并最终摘要（本地算法已禁用）');
        })();

    return this.wrapSummaryResult(records, finalSummarySource, archivePath, '默认 LLM 分块/递归摘要');
  }

  private recordsToSummaryText(records: CompressionRecord[]): string {
    return records.map((record) => `[${record.id}][${record.role}/${record.category}] ${record.text}`).join('\n\n');
  }

  private canUseSinglePassSummary(prompt: string): boolean {
    if (countTokens(prompt) > this.options.maxTokens) return false;
    const byteThreshold = this.byteThreshold();
    return !Number.isFinite(byteThreshold) || Buffer.byteLength(prompt, 'utf8') <= byteThreshold;
  }

  private wrapSummaryResult(
    records: CompressionRecord[],
    finalSummarySource: string,
    archivePath: string | undefined,
    mode: string,
  ): string {
    const evidence = records
      .filter((record) => record.category !== 'message')
      .slice(-MAX_EVIDENCE_ITEMS)
      .map((record) => `- [${record.id}][${record.category}] ${this.limitText(record.text, 220)}`)
      .join('\n') || '- 无额外证据';

    return [
      '## 对话分层摘要 (已压缩)',
      '',
      `- 压缩模式: ${mode}`,
      `- 作用域: ${this.options.owner.kind}${this.options.owner.agentName ? `/${this.options.owner.agentName}` : ''}`,
      this.options.sessionId ? `- 会话: ${this.options.sessionId}` : '',
      archivePath ? `- 压缩归档: ${archivePath}` : '',
      '',
      finalSummarySource.trim(),
      '',
      '### 关键证据片段',
      evidence,
    ].filter(Boolean).join('\n');
  }

  private summaryChunkTokenBudget(): number {
    return Math.max(1, this.options.maxTokens);
  }

  private chunkRecordTexts(records: CompressionRecord[]): string[][] {
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;
    const chunkTokenBudget = this.summaryChunkTokenBudget();

    for (const record of records) {
      const line = `[${record.id}][${record.role}/${record.category}] ${record.text}`;
      const lineTokens = countTokens(line);

      if (currentChunk.length > 0 && currentTokens + lineTokens > chunkTokenBudget) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokens = 0;
      }
      currentChunk.push(line);
      currentTokens += lineTokens;
    }

    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
  }

  private groupChunkTexts(texts: string[]): string[] {
    const groups: string[] = [];
    let current = '';
    let currentTokens = 0;
    const chunkTokenBudget = this.summaryChunkTokenBudget();

    for (const text of texts) {
      const nextText = `${current ? `${current}\n\n` : ''}${text}`;
      const nextTokens = countTokens(text);
      if (current && currentTokens + nextTokens > chunkTokenBudget) {
        groups.push(current);
        current = text;
        currentTokens = nextTokens;
      } else {
        current = nextText;
        currentTokens += nextTokens;
      }
    }

    if (current) groups.push(current);
    return groups;
  }

  private buildSummaryPrompt(
    chunkText: string,
    depth: number,
    index: number,
    total: number,
    finalPass = false,
  ): string {
    return [
      '你正在为一个 Agent Orchestration 压缩历史上下文。',
      '请只根据给定记录生成 grounded summary，事实范围限定为记录中已出现的信息。',
      '必须保留：用户目标、任务 ID、文件路径、命令/工具、错误、未完成事项、会话边界信息。',
      '如果信息缺失，直接写"未知"。',
      finalPass
        ? '这一步是最终汇总，请合并重复项并突出后续继续工作真正需要的事实。'
        : `当前正在处理第 ${index}/${total} 个摘要分块，层级 ${depth}。`,
      '',
      '输出格式：',
      '## 用户目标',
      '## 已完成工作',
      '## 关键文件/命令/错误',
      '## 未解决事项',
      '',
      '记录如下：',
      chunkText,
    ].join('\n');
  }

  private async callSummaryLlm(prompt: string, fallbackText: string, depth: number, actorLabelSuffix?: string): Promise<string> {
    const owner = this.options.owner;
    const actorLabelBase = owner.kind === 'agent'
      ? `Agent-${owner.agentName || owner.agentId || 'unknown'}-ContextSummary`
      : 'Leader-ContextSummary';
    const actorLabel = actorLabelSuffix ? `${actorLabelBase}-${actorLabelSuffix}` : actorLabelBase;
    const guardFactory = this.options.llmGuardFactory;
    if (!this.options.llmClient || !guardFactory) {
      throw new Error('LLM 压缩失败：LLM 客户端或 Guard Factory 未配置（本地算法已禁用）');
    }
    const guard = guardFactory({
      actorLabel,
      maxRetries: 2,
      cbScope: `context_summary::${owner.kind}::${owner.agentId || 'leader'}`,
    });
    const response = await guard.call(
      this.options.llmClient,
      [{ role: 'user', content: prompt }],
      this.options.model,
      undefined,
      false,
      undefined,
      undefined,
      {
        actorType: owner.kind === 'agent' ? 'agent' : 'leader',
        actorLabel,
        purpose: 'summary',
        sessionId: this.options.sessionId,
        agentId: owner.agentId,
        agentName: owner.agentName,
        requestedModel: this.options.model,
      },
      // 防漂移：压缩摘要走确定性温度，减少上下文压缩本身引入的漂移源
      getReasoningGenerateOptions(),
    );
    const content = contentToPlainText(response.content);
    if (!content) {
      throw new Error('LLM 压缩失败：返回空内容（本地算法已禁用）');
    }
    return content;
  }

  private async summarizeChunk(
    chunkText: string,
    depth: number,
    index: number,
    total: number,
    finalPass = false,
  ): Promise<string> {
    if (!this.options.llmClient) {
      throw new Error('LLM 压缩失败：LLM 客户端未配置（本地算法已禁用）');
    }

    const prompt = this.buildSummaryPrompt(chunkText, depth, index, total, finalPass);

    // SDK 600s 总超时是唯一权威；不再叠加本地短 timeout（本地短超时只会在 LLM 真正成功前先触发降级）。
    try {
      return await this.callSummaryLlm(prompt, chunkText, depth);
    } catch (error) {
      coreLogger.warn(
        `${this.options.sessionId} LLM 语义压缩失败 (depth=${depth})，不回退本地算法: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  // ─── 归档 ───────────────────────────────────────────────────────────────

  protected async writeCompressionArchive(
    middleMessages: ChatMessage[],
    records: CompressionRecord[],
    summary: string,
  ): Promise<string | undefined> {
    const owner = this.options.owner;
    if (!owner.workspace || !this.options.sessionId) return undefined;

    try {
      const scopeDir = owner.kind === 'agent'
        ? join(
            owner.workspace,
            '.lingxiao',
            'sessions',
            this.options.sessionId,
            'context',
            'agents',
            owner.agentId || 'unknown',
          )
        : join(owner.workspace, '.lingxiao', 'sessions', this.options.sessionId, 'context', 'leader');
      mkdirSync(scopeDir, { recursive: true });

      const safeOwner = (owner.agentName || owner.agentId || owner.kind)
        .replace(/[^a-zA-Z0-9_-]+/g, '_');
      const filePath = join(scopeDir, `compact-${Date.now()}-${safeOwner}.md`);
      const originalMessages = middleMessages
        .map((message, index) => `### M-${index + 1} [${message.role}]\n${this.stringifyMessage(message) || '(empty)'}`)
        .join('\n\n');
      const recordText = records
        .map((record) => `- [${record.id}][${record.role}/${record.category}] ${record.text}`)
        .join('\n');

      const content = [
        '# Context Compression Archive',
        '',
        '<!-- lingxiao-context-archive',
        JSON.stringify({
          sessionId: this.options.sessionId,
          owner: owner.kind,
          agentId: owner.agentId,
          agentName: owner.agentName,
          createdAt: new Date().toISOString(),
          recordCount: records.length,
          categories: records.reduce<Record<string, number>>((acc, record) => {
            acc[record.category] = (acc[record.category] || 0) + 1;
            return acc;
          }, {}),
        }),
        '-->',
        '',
        `- session_id: ${this.options.sessionId}`,
        `- owner: ${owner.kind}${owner.agentName ? `/${owner.agentName}` : ''}`,
        `- created_at: ${new Date().toISOString()}`,
        owner.kind === 'leader' ? `- leader_route_history: ${this.readRouteHistory() || 'none'}` : '',
        owner.kind === 'leader' ? `- leader_selected_skills_history: ${this.readSelectedSkillHistory() || 'none'}` : '',
        '',
        '## Compression Records',
        recordText || '(empty)',
        '',
        '## Summary',
        summary,
        '',
        '## Original Messages',
        originalMessages || '(empty)',
        '',
      ].join('\n');

      await fsp.writeFile(filePath, content, 'utf-8');
      this.purgeOldArchives(scopeDir);
      return filePath;
    } catch (error) {
      coreLogger.warn(`写入压缩归档失败: ${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  }

  private purgeOldArchives(dir: string): void {
    try {
      const files = readdirSync(dir).filter((f) => (f.startsWith('compact-') || f.startsWith('oversized-')) && f.endsWith('.md'));
      if (files.length <= POST_COMPACT_MAX_FILES) return;
      files.sort();
      const toDelete = files.slice(0, files.length - POST_COMPACT_MAX_FILES);
      for (const file of toDelete) {
        try {
          unlinkSync(join(dir, file));
        } catch (e) {
          coreLogger.warn(`[CompressionPipeline] 删除旧归档失败 ${file}: ${e}`);
        }
      }
    } catch (e) {
      coreLogger.warn(`[CompressionPipeline] 清理归档失败: ${e}`);
    }
  }

  // ─── DB 元数据读取 ─────────────────────────────────────────────────────

  private readRouteHistory(): string {
    if (!this.options.db || !this.options.sessionId || this.options.owner.kind !== 'leader') return '';
    const history = this.options.db.getSessionState(this.options.sessionId, SESSION_KEYS.LEADER_ROUTE_HISTORY);
    if (!Array.isArray(history) || history.length === 0) return '';
    return history
      .slice(-5)
      .map((item: { mode?: unknown; reason?: unknown }) => {
        const mode = typeof item?.mode === 'string' ? item.mode : 'unknown';
        const reason = typeof item?.reason === 'string' ? item.reason : '';
        return `${mode}: ${reason}`;
      })
      .join(' | ');
  }

  private readSelectedSkillHistory(): string {
    if (!this.options.db || !this.options.sessionId || this.options.owner.kind !== 'leader') return '';
    const history = this.options.db.getSessionState(
      this.options.sessionId,
      SESSION_KEYS.LEADER_SELECTED_SKILLS_HISTORY,
    );
    if (!Array.isArray(history) || history.length === 0) return '';
    return history
      .slice(-5)
      .map((item: { role_name?: unknown; skills?: unknown }) => {
        const roleName = typeof item?.role_name === 'string' ? item.role_name : 'unknown-role';
        const skills = Array.isArray(item?.skills) ? item.skills.join(', ') : '';
        return `${roleName}: ${skills || '(none)'}`;
      })
      .join(' | ');
  }

  // ─── 文件快照注入 ─────────────────────────────────────────────────────

  private buildFileAttachments(recentFiles?: Map<string, FileRecord>): string {
    if (!recentFiles || recentFiles.size === 0) return '';

    const sortedFiles = Array.from(recentFiles.entries())
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .slice(0, POST_COMPACT_MAX_FILES);

    const result: string[] = [];
    let totalBudget = 0;

    for (const [path, data] of sortedFiles) {
      let content = data.content;
      if (content.length > POST_COMPACT_MAX_TOKENS_PER_FILE * 4) {
        content = content.slice(0, POST_COMPACT_MAX_TOKENS_PER_FILE * 4) + '\n... (truncated)';
      }

      totalBudget += countTokens(content);
      if (totalBudget > POST_COMPACT_TOKEN_BUDGET) break;

      result.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
    }

    return result.join('\n\n');
  }

  // ─── 二次截断 ───────────────────────────────────────────────────────────

  private truncateToThreshold(messages: ChatMessage[], pinnedCount: number): ChatMessage[] {
    const withoutFileSnapshots = messages.filter((msg) => msg.metadata?.kind !== 'context_file_snapshot');

    const minKeep = pinnedCount + 2;
    let result = withoutFileSnapshots;

    while (result.length > minKeep) {
      const summaryIdx = result.findIndex((msg) => msg.metadata?.kind === 'context_summary');

      const earliestRecentIdx = summaryIdx >= 0 ? summaryIdx + 1 : pinnedCount;
      if (earliestRecentIdx >= result.length) break;
      if (result[earliestRecentIdx].role === 'user') break;

      // P1 修复：保 tool_use ↔ tool_result 配对原子性。
      // 若被 pop 的 assistant 带 tool_calls，必须连同其所有 role==='tool' 配对一起移除；
      // 若被 pop 的本身就是孤立 role==='tool'（无前置 tool_calls），直接 pop 即可。
      const head = result[earliestRecentIdx];
      const removeIdx = new Set<number>([earliestRecentIdx]);

      if (head.role === 'assistant' && head.tool_calls?.length) {
        const toolCallIds = new Set(head.tool_calls.map((c) => c.id));
        for (let j = earliestRecentIdx + 1; j < result.length; j++) {
          const m = result[j];
          if (m.role !== 'tool') break; // 工具结果一般紧随其后；遇到非 tool 即停
          if (m.tool_call_id && toolCallIds.has(m.tool_call_id)) {
            removeIdx.add(j);
          }
        }
      }

      const next = result.filter((_m, i) => !removeIdx.has(i));
      // 防御：极端场景下没移除任何消息，跳出避免死循环
      if (next.length === result.length) break;
      result = next;
    }

    return result;
  }
}
