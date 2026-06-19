/**
 * ContextDAG — 基于消息依赖分组的确定性、结构无损上下文压缩引擎
 *
 * 来源: DAG-Based State Management and Structurally Lossless Trimming (arxiv 2602.22402)
 *
 * 设计目标（与 CompressionPipeline 的 LLM 语义摘要互补）:
 * - **确定性**: 相同输入消息序列 → 相同压缩结果。createdAt 用消息下标（非 wall clock），
 *   不依赖 LLM 判断什么"重要"，不用关键词/正则启发式挑选内容。
 * - **结构无损**: 压缩只把旧内容替换为 breadcrumb（保留 role / tool_calls / tool_call_id），
 *   或整组原子丢弃；从不破坏 tool_use ↔ tool_result 配对。配对安全由两层保证：
 *     1) breadcrumb 阶段保留消息结构字段；
 *     2) archive（丢弃）阶段按"组"原子移除（assistant + 其全部 tool_result 一起丢）。
 *   出口处再过一道 sanitizeOpenAIToolMessageSequence 兜底。
 * - **可恢复**: 被压缩的原始内容应已落盘归档（由调用方在压缩前/后写盘），
 *   breadcrumb 只是上下文内的占位标记。
 *
 * 三趟压缩（按释放预算逐趟推进，达到目标即停）:
 * - Pass 1 (Structural Trim): 最旧的非钉扎 tool_result → breadcrumb（保留结构，省内容字节）。
 * - Pass 2 (Dependency-safe Compress): 最旧的非钉扎 assistant → breadcrumb。
 * - Pass 3 (Group Archive): 已全部压缩的"组"（assistant + 其 tool_result 都已 breadcrumb）
 *   整组原子丢弃，释放 breadcrumb 占位字节。组原子性保证不产生孤立 tool_use/tool_result。
 *
 * 调用方式（无状态、每次压缩重建）:
 *   const dag = new ContextDAG();
 *   dag.fromMessages(messages, { protectRecentN });
 *   const trim = dag.structuralTrim(tokensToFree);
 *   const out = dag.toMessages();   // 配对安全、可直接喂 LLM
 *
 * 钉扎（pinned）规则: system / user 永不压缩；最近 protectRecentN 条永不压缩。
 */

import { contentToPlainText, type ChatMessage } from '../../llm/types.js';
import { sanitizeOpenAIToolMessageSequence } from '../../llm/message_sanitizer.js';

/** 消息节点类型 */
export type DAGNodeKind = 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result';

/** DAG 中的消息节点 */
export interface DAGNode {
  /** 唯一 ID（单调递增，等于消息下标） */
  id: number;
  /** 节点类型 */
  kind: DAGNodeKind;
  /** 当前内容（压缩后为 breadcrumb） */
  content: string;
  /** 原始字节数（用于 token 估算） */
  originalBytes: number;
  /** 创建序号（消息下标，确定性，非 wall clock） */
  createdAt: number;
  /** 是否已被压缩为 breadcrumb */
  compressed: boolean;
  /** 是否已被整组归档（从活跃输出中移除） */
  archived: boolean;
  /** 是否为不可压缩节点（system/user/最近窗口） */
  pinned: boolean;
  /** 原子组 ID：assistant 与其全部 tool_result 共享同一 groupId */
  groupId: number;
  /** 原始消息引用（toMessages 重建时复用结构字段） */
  message?: ChatMessage;
}

/** DAG 中的依赖边: from 依赖 to（保留用于调试/统计；配对安全由 groupId 原子性保证） */
export interface DAGEdge {
  from: number;  // 依赖方 node id
  to: number;    // 被依赖方 node id
}

/** 三趟压缩的结果统计 */
export interface TrimResult {
  /** 本次 trim 释放的预估 token 数 */
  tokensFreed: number;
  /** 被压缩为 breadcrumb 的节点数 */
  compressedCount: number;
  /** 被归档（丢弃）的节点数 */
  archivedCount: number;
  /** trim 后剩余的活跃消息数 */
  remainingCount: number;
}

/** fromMessages / structuralTrim 共享选项 */
export interface DAGOptions {
  /** 保护最近 N 条消息不被压缩/归档。默认动态：clamp(8, 总数*0.25, 24)。 */
  protectRecentN?: number;
  /** token 估算器（默认 bytes/3）。结构压缩只需相对量纲，调用方事后用真实计数复核。 */
  estimateTokens?: (text: string) => number;
}

const DEFAULT_RECENT_FLOOR = 8;
const DEFAULT_RECENT_CEIL = 24;
const ASSISTANT_BREADCRUMB_PREVIEW = 120;
const BREADCRUMB_BYTES_BUDGET = 200;

function defaultEstimateTokens(bytes: number): number {
  // 1 token ≈ 3 bytes（中英文混合经验值）；仅用于"释放量"相对估算。
  return Math.ceil(bytes / 3);
}

function resolveProtectRecentN(total: number, opt?: number): number {
  if (typeof opt === 'number' && opt >= 0) return opt;
  return Math.max(DEFAULT_RECENT_FLOOR, Math.min(DEFAULT_RECENT_CEIL, Math.floor(total * 0.25)));
}

export class ContextDAG {
  private nodes: Map<number, DAGNode> = new Map();
  private edges: DAGEdge[] = [];
  private nextId = 0;
  private nextGroupId = 0;
  private estimate: (text: string) => number;

  constructor(options: { estimateTokens?: (text: string) => number } = {}) {
    this.estimate = options.estimateTokens
      ?? ((text: string) => defaultEstimateTokens(Buffer.byteLength(text, 'utf8')));
  }

  /**
   * 从 ChatMessage[] 构建依赖图。每次压缩前调用（无状态重建）。
   *
   * - 每条消息 → 一个节点，createdAt = 下标（确定性）。
   * - system/user 钉扎（pinned），永不压缩。
   * - 最近 protectRecentN 条钉扎。
   * - assistant 与紧随其后的 role='tool' 消息归入同一 groupId（原子组），
   *   保证 archive 阶段整组丢弃不产生孤立配对。
   * - 依赖边: tool_result 依赖其所属 assistant（tool_call_id 精确匹配）。
   */
  fromMessages(messages: ChatMessage[], options: DAGOptions = {}): void {
    this.nodes.clear();
    this.edges = [];
    this.nextId = 0;
    this.nextGroupId = 0;
    if (options.estimateTokens) this.estimate = options.estimateTokens;

    const protectRecentN = resolveProtectRecentN(messages.length, options.protectRecentN);
    const recentStart = Math.max(0, messages.length - protectRecentN);

    // 第一遍：建节点 + 分组。assistant 开新组，其后续 role='tool' 并入同组。
    let currentGroupId = -1;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const text = contentToPlainText(message.content);
      const kind = this.kindOf(message);

      // assistant（无论是否带 tool_calls）开新组；system/user 自成一组；
      // tool_result 并入当前组（即其所属 assistant 的组）。
      if (kind === 'assistant') {
        currentGroupId = this.nextGroupId++;
      } else if (kind === 'system' || kind === 'user') {
        currentGroupId = this.nextGroupId++;
      }
      // tool_result 沿用 currentGroupId（所属 assistant 组）
      const groupId = currentGroupId < 0 ? this.nextGroupId++ : currentGroupId;

      const node: DAGNode = {
        id: this.nextId++,
        kind,
        content: text,
        originalBytes: Buffer.byteLength(text, 'utf8'),
        createdAt: i,
        compressed: false,
        archived: false,
        pinned: kind === 'system' || kind === 'user' || i >= recentStart,
        groupId,
        message,
      };
      this.nodes.set(node.id, node);
    }

    // 第二遍：依赖边 —— tool_result 依赖其所属 assistant（tool_call_id 精确匹配，非子串）。
    const toolCallIdToAssistant = new Map<string, number>();
    for (const node of this.nodes.values()) {
      if (node.kind !== 'assistant' || !node.message?.tool_calls?.length) continue;
      for (const call of node.message.tool_calls) {
        if (call?.id) toolCallIdToAssistant.set(call.id, node.id);
      }
    }
    for (const node of this.nodes.values()) {
      if (node.kind !== 'tool_result') continue;
      const callId = node.message?.tool_call_id;
      if (!callId) continue;
      const assistantId = toolCallIdToAssistant.get(callId);
      if (assistantId === undefined) continue;
      this.edges.push({ from: node.id, to: assistantId });
    }
  }

  /** ChatMessage → DAGNodeKind。带 tool_calls 的 assistant 仍记为 assistant（tool_calls 保留在 message 上）。 */
  private kindOf(message: ChatMessage): DAGNodeKind {
    switch (message.role) {
      case 'system': return 'system';
      case 'user': return 'user';
      case 'tool': return 'tool_result';
      case 'assistant':
      default: return 'assistant';
    }
  }

  /**
   * 三趟结构性压缩。达到 targetTokensToFree 即停。确定性、配对安全。
   *
   * @param targetTokensToFree 目标释放的预估 token 数
   */
  structuralTrim(targetTokensToFree: number): TrimResult {
    let tokensFreed = 0;
    let compressedCount = 0;
    let archivedCount = 0;
    const target = Math.max(0, targetTokensToFree);

    if (tokensFreed < target) {
      const pass1 = this.pass1_trimLeafToolResults(target - tokensFreed);
      tokensFreed += pass1.freed;
      compressedCount += pass1.count;
    }
    if (tokensFreed < target) {
      const pass2 = this.pass2_compressOldAssistant(target - tokensFreed);
      tokensFreed += pass2.freed;
      compressedCount += pass2.count;
    }
    if (tokensFreed < target) {
      const pass3 = this.pass3_archiveCompressedGroups(target - tokensFreed);
      tokensFreed += pass3.freed;
      archivedCount += pass3.count;
    }

    const remainingCount = [...this.nodes.values()].filter(n => !n.archived).length;
    return { tokensFreed, compressedCount, archivedCount, remainingCount };
  }

  /** Pass 1: 最旧的非钉扎 tool_result → breadcrumb（保留结构，省内容）。配对安全：仅替换 content 文本。 */
  private pass1_trimLeafToolResults(budget: number): { freed: number; count: number } {
    let freed = 0;
    let count = 0;
    const candidates = this.oldestActiveNodes(n => n.kind === 'tool_result' && !n.compressed && !n.pinned);
    for (const node of candidates) {
      if (freed >= budget) break;
      const before = this.estimate(node.content);
      const breadcrumb = `[compacted tool_result, original ~${node.originalBytes}B]`;
      node.content = breadcrumb;
      node.compressed = true;
      freed += Math.max(0, before - this.estimate(breadcrumb));
      count++;
    }
    return { freed, count };
  }

  /** Pass 2: 最旧的非钉扎 assistant → breadcrumb。保留 tool_calls 结构，仅替换可见文本。 */
  private pass2_compressOldAssistant(budget: number): { freed: number; count: number } {
    let freed = 0;
    let count = 0;
    const candidates = this.oldestActiveNodes(n => n.kind === 'assistant' && !n.compressed && !n.pinned);
    for (const node of candidates) {
      if (freed >= budget) break;
      const before = this.estimate(node.content);
      const preview = node.content.slice(0, ASSISTANT_BREADCRUMB_PREVIEW).replace(/\s+/g, ' ').trim();
      const breadcrumb = `[compacted turn: "${preview}${node.content.length > ASSISTANT_BREADCRUMB_PREVIEW ? '…' : ''}" (~${node.originalBytes}B)]`;
      node.content = breadcrumb;
      node.compressed = true;
      freed += Math.max(0, before - this.estimate(breadcrumb));
      count++;
    }
    return { freed, count };
  }

  /**
   * Pass 3: 已"整组压缩"的组（assistant 已 compressed 且其全部 tool_result 已 compressed，
   * 且组内无钉扎节点）按最旧优先整组丢弃（archived）。组原子性保证：丢弃 assistant 的同时
   * 丢弃其全部 tool_result，不产生孤立 tool_use；丢弃 tool_result 的同时其 owner assistant 也丢弃。
   * 这修复了旧实现"archive 单节点 → 面包屑引用悬空"的缺陷。
   */
  private pass3_archiveCompressedGroups(budget: number): { freed: number; count: number } {
    let freed = 0;
    let count = 0;

    // 按组的最小 createdAt 排序（最旧的组先归档）。
    const groupMinCreatedAt = new Map<number, number>();
    for (const node of this.nodes.values()) {
      if (node.archived) continue;
      const cur = groupMinCreatedAt.get(node.groupId);
      if (cur === undefined || node.createdAt < cur) groupMinCreatedAt.set(node.groupId, node.createdAt);
    }
    const groupIds = [...groupMinCreatedAt.keys()].sort(
      (a, b) => (groupMinCreatedAt.get(a)! - groupMinCreatedAt.get(b)!),
    );

    for (const groupId of groupIds) {
      if (freed >= budget) break;
      const members = [...this.nodes.values()].filter(n => n.groupId === groupId && !n.archived);
      if (members.length === 0) continue;
      // 组内任一钉扎 → 跳过（不破坏最近窗口/契约）。
      if (members.some(n => n.pinned)) continue;
      // 组内任一未压缩 → 跳过（保证只丢弃"已压缩"的整组，避免丢未压缩的有用内容）。
      if (members.some(n => !n.compressed)) continue;

      let groupFreed = 0;
      for (const node of members) {
        groupFreed += this.estimate(node.content);
        node.archived = true;
        count++;
      }
      freed += groupFreed;
    }
    return { freed, count };
  }

  /** 按 createdAt 升序取满足谓词的活跃（非 archived）节点。确定性。 */
  private oldestActiveNodes(predicate: (n: DAGNode) => boolean): DAGNode[] {
    return [...this.nodes.values()]
      .filter(n => !n.archived && predicate(n))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 导出压缩后的 ChatMessage[]（配对安全，可直接喂 LLM）。
   * - 跳过 archived 节点。
   * - 复用原始消息的 role / tool_calls / tool_call_id / timestamp；仅 content 用当前（breadcrumb）文本。
   * - 出口过 sanitizeOpenAIToolMessageSequence 兜底，杜绝孤立 tool 消息。
   */
  toMessages(): ChatMessage[] {
    const ordered = [...this.nodes.values()]
      .filter(n => !n.archived)
      .sort((a, b) => a.id - b.id);
    const out: ChatMessage[] = [];
    for (const node of ordered) {
      if (!node.message) continue;
      out.push({
        ...node.message,
        content: node.content,
      });
    }
    return sanitizeOpenAIToolMessageSequence(out);
  }

  /** 导出当前活跃（非 archived）消息序列的简化视图（用于测试/调试）。 */
  getActiveMessages(): Array<{ id: number; kind: DAGNodeKind; content: string }> {
    return [...this.nodes.values()]
      .filter(n => !n.archived)
      .sort((a, b) => a.id - b.id)
      .map(n => ({ id: n.id, kind: n.kind, content: n.content }));
  }

  /** 当前活跃节点的总预估 token 数。 */
  getActiveTokenEstimate(): number {
    let total = 0;
    for (const node of this.nodes.values()) {
      if (!node.archived) total += this.estimate(node.content);
    }
    return total;
  }

  /** 图状态快照（用于测试/调试）。 */
  getStats(): { total: number; active: number; compressed: number; archived: number; edges: number } {
    let active = 0;
    let compressed = 0;
    let archived = 0;
    for (const node of this.nodes.values()) {
      if (node.archived) archived++;
      else if (node.compressed) compressed++;
      else active++;
    }
    return { total: this.nodes.size, active, compressed, archived, edges: this.edges.length };
  }

  // ─── 向后兼容：增量 addNode / tick（旧 API，新代码请用 fromMessages） ─────

  /** 推进迭代计数器（旧 API；fromMessages 用下标，无需手动 tick）。 */
  tick(): void { /* no-op: createdAt 由 fromMessages 的下标决定 */ }

  /** 增量添加节点（旧 API；新代码用 fromMessages 批量构建）。 */
  addNode(kind: DAGNodeKind, content: string, dependsOn: number[] = []): number {
    const id = this.nextId++;
    const node: DAGNode = {
      id,
      kind,
      content,
      originalBytes: Buffer.byteLength(content, 'utf8'),
      createdAt: id,
      compressed: false,
      archived: false,
      pinned: kind === 'system' || kind === 'user',
      groupId: this.nextGroupId++,
    };
    this.nodes.set(id, node);
    for (const depId of dependsOn) {
      this.edges.push({ from: id, to: depId });
    }
    return id;
  }
}
