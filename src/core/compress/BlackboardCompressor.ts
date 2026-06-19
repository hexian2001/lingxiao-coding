/**
 * BlackboardCompressor — 黑板图快照压缩器
 *
 * 解决问题：黑板图快照原始注入无 token 预算，长期运行后图节点增长导致
 * 注入到 LLM 上下文的内容过大。
 *
 * 策略：分层快照 — 根据 token 预算选择详细程度：
 *   Level 0 (minimal):  只有 open intents + contradictions        ≤1K tokens
 *   Level 1 (standard): + recent facts + completion signals        ≤3K tokens
 *   Level 2 (detailed): + all facts + edges summary                ≤5K tokens
 *   Level 3 (full):     全量快照（仅大模型）                        ≤8K tokens
 *
 * 当图节点 > 20 时，额外提供事实聚类（按 tags 分组合并）。
 */

import type { EvidenceItem, GraphAnalysis, GraphNode, GraphSnapshot } from '../blackboard/types.js';
import { countTokens } from '../../llm/token_counter.js';
import { coreLogger } from '../Log.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const LEVEL_TOKEN_LIMITS = {
  minimal: 1_000,
  standard: 3_000,
  detailed: 5_000,
  full: 8_000,
} as const;

type SnapshotLevel = keyof typeof LEVEL_TOKEN_LIMITS;

/** 最大显示的节点数（per category） */
const MAX_OPEN_INTENTS_MINIMAL = 3;
const MAX_OPEN_INTENTS_STANDARD = 5;
const MAX_FACTS_STANDARD = 5;
const MAX_FACTS_DETAILED = 15;
const MAX_CONTRADICTIONS = 3;
const MAX_KNOWLEDGE_GAPS = 3;
const MAX_COMPLETION_SIGNALS = 5;

/** 事实聚类：当 fact 数量超过此阈值时启用聚类 */
const CLUSTER_THRESHOLD = 20;

function compactText(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function renderEvidenceItem(item: EvidenceItem): string {
  const location = item.location ? `:${item.location}` : '';
  const snippet = item.snippet ? ` (${compactText(item.snippet, 80)})` : '';
  return `${item.type}:${item.ref}${location}${snippet}`;
}

function renderNodeDetails(node: GraphNode, maxContentChars: number): string {
  const details: string[] = [];
  const content = compactText(node.content, maxContentChars);
  if (content) details.push(`content: ${content}`);
  if (node.tags.length > 0) details.push(`tags: ${node.tags.join(', ')}`);
  if (node.evidence && node.evidence.length > 0) {
    details.push(`evidence: ${compactText(node.evidence.map(renderEvidenceItem).join('; '), Math.max(120, Math.floor(maxContentChars / 2)))}`);
  }
  if (node.intentStatus) details.push(`status: ${node.intentStatus}`);
  if (node.priority !== undefined) details.push(`priority: ${node.priority}`);
  return details.length > 0 ? ` — ${details.join(' | ')}` : '';
}

// ─── Snapshot Builders ──────────────────────────────────────────────────────

/**
 * Level 0: 最小快照 — 只有开放意图和矛盾
 */
function buildMinimalSnapshot(
  snapshot: GraphSnapshot,
  analysis: GraphAnalysis,
): string {
  const parts: string[] = ['## 黑板图 (精简)'];

  if (analysis.openIntents.length > 0) {
    parts.push(`**开放方向** (${analysis.openIntents.length}):`);
    for (const intent of analysis.openIntents.slice(0, MAX_OPEN_INTENTS_MINIMAL)) {
      const priority = intent.priority ?? 5;
      parts.push(`  - [P${priority}] ${intent.id}: ${intent.title}`);
    }
    if (analysis.openIntents.length > MAX_OPEN_INTENTS_MINIMAL) {
      parts.push(`  ... 及其他 ${analysis.openIntents.length - MAX_OPEN_INTENTS_MINIMAL} 个`);
    }
  }

  if (analysis.unresolvedContradictions.length > 0) {
    parts.push(`**矛盾** (${analysis.unresolvedContradictions.length}):`);
    for (const c of analysis.unresolvedContradictions.slice(0, MAX_CONTRADICTIONS)) {
      parts.push(`  - ${c.nodeA.title} ↔ ${c.nodeB.title}`);
    }
  }

  return parts.join('\n');
}

/**
 * Level 1: 标准快照 — + 最近事实 + 完成信号
 */
function buildStandardSnapshot(
  snapshot: GraphSnapshot,
  analysis: GraphAnalysis,
): string {
  const parts: string[] = [buildMinimalSnapshot(snapshot, analysis)];

  if (analysis.recentFacts.length > 0) {
    parts.push(`\n**最近发现** (${analysis.recentFacts.length}):`);
    for (const fact of analysis.recentFacts.slice(0, MAX_FACTS_STANDARD)) {
      const conf = fact.confidence || '?';
      parts.push(`  - ${fact.id} [${conf}]: ${fact.title}`);
    }
  }

  if (analysis.knowledgeGaps.length > 0) {
    parts.push(`\n**知识缺口**: ${analysis.knowledgeGaps.slice(0, MAX_KNOWLEDGE_GAPS).join(', ')}`);
  }

  if (analysis.completionSignals.length > 0) {
    parts.push(`\n**完成信号**: ${analysis.completionSignals.slice(0, MAX_COMPLETION_SIGNALS).join(', ')}`);
  }

  if (snapshot.goalNode) {
    parts.push(`\n**目标**: ${snapshot.goalNode.title}`);
  }

  return parts.join('\n');
}

/**
 * Level 2: 详细快照 — + 所有事实 + 边摘要
 */
function buildDetailedSnapshot(
  snapshot: GraphSnapshot,
  analysis: GraphAnalysis,
): string {
  const parts: string[] = [buildStandardSnapshot(snapshot, analysis)];

  // 所有事实（非 recent 的）
  const allFacts = snapshot.nodes.filter((n) => n.kind === 'fact');
  const recentIds = new Set(analysis.recentFacts.map((f) => f.id));
  const olderFacts = allFacts.filter((f) => !recentIds.has(f.id));

  if (olderFacts.length > 0) {
    // 如果事实太多，使用聚类
    if (olderFacts.length > CLUSTER_THRESHOLD) {
      const clusters = clusterFacts(olderFacts);
      parts.push(`\n**历史事实聚类** (${olderFacts.length} 条 → ${clusters.length} 组):`);
      for (const cluster of clusters.slice(0, MAX_FACTS_DETAILED)) {
        parts.push(`  - [${cluster.tag}]: ${cluster.summary} (${cluster.count} 条)`);
      }
    } else {
      parts.push(`\n**历史事实** (${olderFacts.length}):`);
      for (const fact of olderFacts.slice(0, MAX_FACTS_DETAILED)) {
        const conf = fact.confidence || '?';
        parts.push(`  - ${fact.id} [${conf}]: ${fact.title}`);
      }
    }
  }

  // 边摘要
  if (snapshot.edges.length > 0) {
    const edgeTypeCounts = new Map<string, number>();
    for (const edge of snapshot.edges) {
      edgeTypeCounts.set(edge.edgeType, (edgeTypeCounts.get(edge.edgeType) || 0) + 1);
    }
    const edgeSummary = Array.from(edgeTypeCounts.entries())
      .map(([type, count]) => `${type}=${count}`)
      .join(', ');
    parts.push(`\n**关系**: ${snapshot.edges.length} 条边 (${edgeSummary})`);
  }

  // 被阻塞的意图
  if (analysis.blockedIntents.length > 0) {
    parts.push(`\n**被阻塞**: ${analysis.blockedIntents.map((i) => i.id).join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Level 3: 完整快照
 */
function buildFullSnapshot(
  snapshot: GraphSnapshot,
  analysis: GraphAnalysis,
): string {
  const parts: string[] = [buildDetailedSnapshot(snapshot, analysis)];

  // 补充所有意图（不只是 open 的）
  const allIntents = snapshot.nodes.filter((n) => n.kind === 'intent');
  const openIds = new Set(analysis.openIntents.map((i) => i.id));
  const otherIntents = allIntents.filter((i) => !openIds.has(i.id));

  if (otherIntents.length > 0) {
    parts.push(`\n**其他意图** (${otherIntents.length}):`);
    for (const intent of otherIntents.slice(0, 10)) {
      parts.push(`  - ${intent.id} [${intent.intentStatus || '?'}]: ${intent.title}`);
    }
  }

  // Hint 节点
  const hints = snapshot.nodes.filter((n) => n.kind === 'hint');
  if (hints.length > 0) {
    parts.push(`\n**提示** (${hints.length}):`);
    for (const hint of hints.slice(0, 5)) {
      parts.push(`  - ${hint.title}`);
    }
  }

  return parts.join('\n');
}

// ─── Fact Clustering ────────────────────────────────────────────────────────

interface FactCluster {
  tag: string;
  facts: GraphNode[];
  count: number;
  summary: string;
}

/**
 * 按 tags 将事实分组聚类。
 * 没有 tag 的事实归入 "其他" 组。
 */
function clusterFacts(facts: GraphNode[]): FactCluster[] {
  const tagGroups = new Map<string, GraphNode[]>();

  for (const fact of facts) {
    const tags = fact.tags.length > 0 ? fact.tags : ['其他'];
    for (const tag of tags) {
      const group = tagGroups.get(tag) || [];
      group.push(fact);
      tagGroups.set(tag, group);
    }
  }

  const clusters: FactCluster[] = [];
  for (const [tag, group] of tagGroups) {
    // 生成摘要：取前 3 个 fact 的 title
    const titles = group.slice(0, 3).map((f) => f.title);
    const summary = titles.join('; ') + (group.length > 3 ? ` ...+${group.length - 3}` : '');

    clusters.push({ tag, facts: group, count: group.length, summary });
  }

  // 按数量降序
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

// ─── Main Compressor ────────────────────────────────────────────────────────

export interface BlackboardCompressResult {
  /** 压缩后的快照文本 */
  content: string;
  /** 使用的快照级别 */
  level: SnapshotLevel;
  /** 估算 token 数 */
  tokens: number;
  /** 原始全量快照的 token 数（用于对比） */
  fullTokens: number;
}

/**
 * 根据 token 预算压缩黑板图快照。
 *
 * 从最详细的级别开始尝试，如果超预算就降级。
 *
 * @param snapshot - 图快照
 * @param analysis - 图分析结果
 * @param tokenBudget - token 预算
 * @returns 压缩后的快照文本
 */
export function compressBlackboardSnapshot(
  snapshot: GraphSnapshot,
  analysis: GraphAnalysis,
  tokenBudget: number,
): BlackboardCompressResult {
  // 如果图为空，返回空
  if (snapshot.nodes.length === 0) {
    return { content: '', level: 'minimal', tokens: 0, fullTokens: 0 };
  }

  // 生成全量快照作为参考
  const fullContent = buildFullSnapshot(snapshot, analysis);
  const fullTokens = countTokens(fullContent);

  // 如果全量在预算内，直接返回
  if (fullTokens <= tokenBudget) {
    return { content: fullContent, level: 'full', tokens: fullTokens, fullTokens };
  }

  // 从高到低尝试各级别
  const levels: Array<{ name: SnapshotLevel; builder: () => string }> = [
    { name: 'detailed', builder: () => buildDetailedSnapshot(snapshot, analysis) },
    { name: 'standard', builder: () => buildStandardSnapshot(snapshot, analysis) },
    { name: 'minimal', builder: () => buildMinimalSnapshot(snapshot, analysis) },
  ];

  for (const level of levels) {
    const content = level.builder();
    const tokens = countTokens(content);
    if (tokens <= tokenBudget) {
      return { content, level: level.name, tokens, fullTokens };
    }
  }

  // 最后兜底：minimal 仍超预算，强制截断
  const minimal = buildMinimalSnapshot(snapshot, analysis);
  const truncated = minimal.slice(0, tokenBudget * 3) + '\n...(截断)';
  const truncatedTokens = countTokens(truncated);

  coreLogger.warn(
    `[BlackboardCompressor] minimal 快照仍超预算 (${truncatedTokens} > ${tokenBudget})，强制截断`
  );

  return { content: truncated, level: 'minimal', tokens: truncatedTokens, fullTokens };
}

/**
 * 为 Worker 生成压缩后的图快照 markdown。
 * 这是 pool.setBlackboardCallbacks(getSnapshot) 的替代实现。
 */
export function buildCompressedWorkerSnapshot(
  snapshot: GraphSnapshot,
  tokenBudget: number,
): string {
  if (snapshot.nodes.length === 0) return '';

  const parts: string[] = [];

  if (snapshot.originNode) {
    parts.push(`**Origin:** ${snapshot.originNode.title}`);
  }
  if (snapshot.goalNode) {
    parts.push(`**Goal:** ${snapshot.goalNode.title}`);
  }

  const facts = snapshot.nodes.filter((n) => n.kind === 'fact' && !n.supersededBy);
  const intents = snapshot.nodes.filter((n) => n.kind === 'intent' && !n.supersededBy);
  const contracts = snapshot.nodes
    .filter((n) => n.kind === 'contract' && !n.supersededBy)
    .sort((a, b) => a.createdAt - b.createdAt);
  const designDocs = snapshot.nodes
    .filter((n) => n.kind === 'design_doc' && !n.supersededBy)
    .sort((a, b) => a.createdAt - b.createdAt);

  // 根据预算决定显示数量
  const maxContracts = tokenBudget > 3000 ? 8 : tokenBudget > 1500 ? 5 : 3;
  const maxDesignDocs = tokenBudget > 3000 ? 6 : tokenBudget > 1500 ? 4 : 2;
  const maxFacts = tokenBudget > 3000 ? 12 : tokenBudget > 1500 ? 7 : 4;
  const maxIntents = tokenBudget > 3000 ? 10 : tokenBudget > 1500 ? 5 : 3;
  const maxContentChars = tokenBudget > 3000 ? 420 : tokenBudget > 1500 ? 260 : 160;
  const maxContractContentChars = tokenBudget > 3000 ? 720 : tokenBudget > 1500 ? 480 : 320;

  if (contracts.length > 0) {
    parts.push('', `### 跨栈 Contracts (${contracts.length}) — 开工前必读`);
    const displayContracts = contracts.slice(-maxContracts);
    for (const c of displayContracts) {
      parts.push(`- **${c.id}** ${c.title}${renderNodeDetails(c, maxContractContentChars)}`);
    }
    if (contracts.length > maxContracts) {
      parts.push(`- ... 及其他 ${contracts.length - maxContracts} 个`);
    }
  }

  if (designDocs.length > 0) {
    parts.push('', `### Design Docs (${designDocs.length}) — 方案/接口约定`);
    const displayDocs = designDocs.slice(-maxDesignDocs);
    for (const d of displayDocs) {
      parts.push(`- **${d.id}** ${d.title}${renderNodeDetails(d, maxContractContentChars)}`);
    }
    if (designDocs.length > maxDesignDocs) {
      parts.push(`- ... 及其他 ${designDocs.length - maxDesignDocs} 个`);
    }
  }

  if (facts.length > 0) {
    parts.push('', `### 已知 Facts (${facts.length}) — 含具体发现内容`);
    const displayFacts = facts.slice(-maxFacts); // 最新的
    for (const f of displayFacts) {
      parts.push(`- **${f.id}** ${f.title} [${f.confidence || '?'}]${renderNodeDetails(f, maxContentChars)}`);
    }
    if (facts.length > maxFacts) {
      parts.push(`- ... 及其他 ${facts.length - maxFacts} 个`);
    }
  }

  if (intents.length > 0) {
    parts.push('', `### 待探索 Intents (${intents.length}) — 含目标/上下文`);
    const openIntents = intents.filter((i) => i.intentStatus === 'open' || !i.intentStatus);
    const displayIntents = openIntents.slice(0, maxIntents);
    for (const i of displayIntents) {
      parts.push(`- **${i.id}** ${i.title} [${i.intentStatus || 'open'}]${renderNodeDetails(i, maxContentChars)}`);
    }
    if (openIntents.length > maxIntents) {
      parts.push(`- ... 及其他 ${openIntents.length - maxIntents} 个`);
    }
  }

  if (snapshot.edges.length > 0) {
    parts.push('', `### 关键关系 (${snapshot.edges.length})`);
    for (const edge of snapshot.edges.slice(-8)) {
      parts.push(`- ${edge.fromNodeId} -[${edge.edgeType}]-> ${edge.toNodeId}`);
    }
    if (snapshot.edges.length > 8) {
      parts.push(`- ... 及其他 ${snapshot.edges.length - 8} 条关系`);
    }
  }

  const result = parts.join('\n');
  const resultTokens = countTokens(result);

  // 如果仍超预算，截断
  if (resultTokens > tokenBudget) {
    return result.slice(0, tokenBudget * 3) + '\n...(截断)';
  }

  return result;
}

/**
 * 快速检查：黑板分析是否值得注入（有内容才注入）。
 */
export function hasBlackboardContent(analysis: GraphAnalysis | null): boolean {
  if (!analysis) return false;
  return (
    analysis.openIntents.length > 0 ||
    analysis.unresolvedContradictions.length > 0 ||
    analysis.knowledgeGaps.length > 0 ||
    analysis.completionSignals.length > 0
  );
}
