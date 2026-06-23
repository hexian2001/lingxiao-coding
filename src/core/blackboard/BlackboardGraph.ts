/**
 * BlackboardGraph — 黑板图的高层 API
 *
 * 职责：
 *   - 节点 CRUD（自动 ID 生成、事件发射）
 *   - 图查询（BFS 子图、可调度 Intent、矛盾检测）
 *   - Worker 输出批量写入（事务原子性）
 *   - Intent 认领/释放生命周期
 *   - 图裁剪（max_nodes/max_edges 执行）
 *
 * 设计原则：
 *   - 所有持久化委托给 GraphStore
 *   - 所有变更通过 EventEmitter 广播
 *   - Fact 节点不可变（只能 supersede，不能 edit）
 */

import { randomUUID } from 'node:crypto';
import { GraphStore } from './GraphStore.js';
import { coreLogger } from '../Log.js';
import type { EventEmitter } from '../EventEmitter.js';
import {
  isBlackboardIntentTerminalStatus,
  normalizeBlackboardIntentStatus,
} from '../StateSemantics.js';
import type {
  GraphNode,
  GraphEdge,
  NodeKind,
  EdgeType,
  IntentStatus,
  GraphSnapshot,
  WorkerGraphOutput,
  GraphAnalysis,
  BlackboardEvent,
} from './types.js';
import { isNodeReady, type DagNodeLike, type DagSchedulerDeps } from '../DagScheduler.js';
import { shouldPreferContractNode, shouldSupersedeExistingContract } from '../ContractProvenance.js';
import { config as runtimeConfig } from '../../config.js';

/** 黑板 intent 依赖视图节点(适配通用 DagScheduler):聚合并非节点字段的 depends_on 图边。
 *  graphNode 缺省表示依赖源节点不存在(黑板语义:视为已解决)。 */
interface BbViewNode extends DagNodeLike {
  readonly graphNode?: GraphNode;
  readonly isOpenIntent: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

const ID_PREFIX: Record<NodeKind, string> = {
  fact: 'F',
  intent: 'I',
  hint: 'H',
  origin: 'O',
  goal: 'G',
  contract: 'C',
  design_doc: 'D',
  review: 'R',
  verdict: 'V',
  decision_log: 'L',
};

const DEFAULT_SUBGRAPH_DEPTH = 2;

/** 黑板图谱单 session 节点/边硬上限。超出即按 superseded→resolved→最旧 策略剪枝，
 *  防止长会话图谱无界增长（snapshot token 成本随规模线性膨胀 + DB 行堆积）。
 *  worker 批量路径走 applyWorkerOutputAndPrune；其余 addX 入口走 persistNodeAndBound 自动限流。 */
function getBlackboardLimits(): { maxNodes: number; maxEdges: number; maxNodeContentChars: number } {
  return {
    maxNodes: runtimeConfig.blackboard.max_nodes,
    maxEdges: runtimeConfig.blackboard.max_edges,
    maxNodeContentChars: runtimeConfig.blackboard.max_node_content_chars,
  };
}

function truncateNodeContent(content: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || content.length <= maxChars) return content;
  const marker = `\n\n[blackboard content truncated: original_chars=${content.length}, kept_chars=${maxChars}]`;
  return content.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

function normalizeContractSurface(surface: string): string {
  return surface.startsWith('contract:') ? surface.slice('contract:'.length) : surface;
}

function contractTagForSurface(surface: string): string {
  return `contract:${normalizeContractSurface(surface)}`;
}

function isContractEvidenceKind(kind: NodeKind): boolean {
  return kind === 'design_doc' || kind === 'fact';
}

function containsContractSemanticEvidence(node: GraphNode, surface: string): boolean {
  const normalizedSurface = normalizeContractSurface(surface).toLowerCase();
  const haystack = `${node.title}\n${node.content}`.toLowerCase();
  return haystack.includes(normalizedSurface) && /contract|契约/.test(haystack);
}

// ═══════════════════════════════════════════════════════════════
// BlackboardGraph
// ═══════════════════════════════════════════════════════════════

export class BlackboardGraph {
  private store: GraphStore;
  private emitter?: EventEmitter;
  /** sessionId → kind → 下一个序号 */
  private counters = new Map<string, Map<NodeKind, number>>();
  /**
   * 非空时，emit() 把事件收集到这里而不立即发射。
   * 用于在 DB 事务期间缓冲事件，待事务成功提交后再统一发射——
   * 避免对最终被回滚的写入误发事件，也避免监听器异常回滚事务。
   */
  private pendingEvents: BlackboardEvent[] | null = null;

  constructor(store: GraphStore, emitter?: EventEmitter) {
    this.store = store;
    this.emitter = emitter;
  }

  // ─────────────────────────────────────────────────────────────
  // ID 生成
  // ─────────────────────────────────────────────────────────────

  private nextId(sessionId: string, kind: NodeKind): string {
    return `${ID_PREFIX[kind]}-${randomUUID()}`;
  }

  private nextEdgeId(sessionId: string): string {
    return `E-${randomUUID()}`;
  }

  // ─────────────────────────────────────────────────────────────
  // 事件发射
  // ─────────────────────────────────────────────────────────────

  private emit(event: BlackboardEvent): void {
    // 事务期间：只缓冲，待提交后由 flushPendingEvents 统一发射
    if (this.pendingEvents) {
      this.pendingEvents.push(event);
      return;
    }
    if (!this.emitter) return;
    try {
      // 使用 'blackboard:event' 作为通用事件通道
      (this.emitter as unknown as { emit: (event: string, data: unknown) => boolean })
        .emit('blackboard:event', event);
    } catch (err) {
      coreLogger.warn(`[BlackboardGraph] 事件发射失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 在 DB 事务中缓冲事件，事务成功返回后再统一发射。
   * - 事务回调内只做 DB 写 + emit（被缓冲），不触达监听器，监听器异常无法回滚事务；
   * - 仅当事务成功（store.transaction 正常返回）时才发射缓冲事件；
   * - 单个监听器抛错被 emit() 的 try/catch 兜住，不影响其余事件与已提交的数据。
   */
  private withBufferedEvents(fn: () => void): void {
    // 支持嵌套：外层已在缓冲时，内层复用同一缓冲区，由最外层统一 flush
    if (this.pendingEvents) {
      fn();
      return;
    }
    const buffer: BlackboardEvent[] = [];
    this.pendingEvents = buffer;
    try {
      this.store.transaction(fn);
    } finally {
      // 无论事务成功或抛出，都先解除缓冲态
      this.pendingEvents = null;
    }
    // 只有 transaction 未抛错（已提交）才会执行到这里，安全发射缓冲事件
    for (const event of buffer) {
      this.flushOneEvent(event);
    }
  }

  private flushOneEvent(event: BlackboardEvent): void {
    if (!this.emitter) return;
    try {
      (this.emitter as unknown as { emit: (event: string, data: unknown) => boolean })
        .emit('blackboard:event', event);
    } catch (err) {
      coreLogger.warn(`[BlackboardGraph] 事件发射失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 节点操作
  // ─────────────────────────────────────────────────────────────

  addFact(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      id: this.nextId(input.sessionId, 'fact'),
      kind: 'fact',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  addIntent(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      id: this.nextId(input.sessionId, 'intent'),
      kind: 'intent',
      intentStatus: input.intentStatus ?? 'open',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  addHint(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      id: this.nextId(input.sessionId, 'hint'),
      kind: 'hint',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  addContract(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const surfaceTag = input.tags.find(tag => tag.startsWith('contract:'));
    const liveContracts = surfaceTag
      ? this.store.getNodesByTag(input.sessionId, surfaceTag)
          .filter(node => node.kind === 'contract' && !node.supersededBy)
      : [];
    const node: GraphNode = {
      ...input,
      tags: Array.from(new Set(['contract', ...input.tags])),
      id: this.nextId(input.sessionId, 'contract'),
      kind: 'contract',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });

    // ARCH FIX: provenance 分级 supersede 守卫。
    // 薄模板不 supersede 非模板节点,避免任务模板凭时间戳覆盖真实契约。
    for (const old of liveContracts) {
      if (!shouldSupersedeExistingContract(node, old)) {
        continue;
      }
      this.store.updateNode(old.id, input.sessionId, { supersededBy: node.id });
      this.emit({ type: 'node_superseded', sessionId: input.sessionId, nodeId: old.id, timestamp: Date.now() });
    }
    return node;
  }

  addDesignDoc(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      tags: Array.from(new Set(['design_doc', ...input.tags])),
      id: this.nextId(input.sessionId, 'design_doc'),
      kind: 'design_doc',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  addReview(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      tags: Array.from(new Set(['review', ...input.tags])),
      id: this.nextId(input.sessionId, 'review'),
      kind: 'review',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  addVerdict(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      tags: Array.from(new Set(['verdict', ...input.tags])),
      id: this.nextId(input.sessionId, 'verdict'),
      kind: 'verdict',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  addDecisionLog(input: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>): GraphNode {
    const node: GraphNode = {
      ...input,
      tags: Array.from(new Set(['decision_log', ...input.tags])),
      id: this.nextId(input.sessionId, 'decision_log'),
      kind: 'decision_log',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId: node.sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  getActiveContract(sessionId: string, surface: string): GraphNode | null {
    const tag = contractTagForSurface(surface);
    const live = this.store.getNodesByTag(sessionId, tag)
      .filter(node => node.kind === 'contract' && !node.supersededBy);
    return live.reduce<GraphNode | null>((best, node) => {
      if (!best || shouldPreferContractNode(node, best)) return node;
      return best;
    }, null);
  }

  /**
   * 返回可解除 contract gate 的黑板证据。
   *
   * 正式 contract 节点优先；同时兼容 Leader/Worker 通过 blackboard(write_fact)
   * 记录的契约事实，避免只有 kind='contract' 才能解锁实现任务。
   */
  getContractEvidence(sessionId: string, surface: string): GraphNode | null {
    const activeContract = this.getActiveContract(sessionId, surface);
    if (activeContract) return activeContract;

    const tag = contractTagForSurface(surface);
    const taggedEvidence = this.store.getNodesByTag(sessionId, tag)
      .filter(node => isContractEvidenceKind(node.kind) && !node.supersededBy)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (taggedEvidence[0]) return taggedEvidence[0];

    const semanticEvidence = this.store.getNodesBySession(sessionId)
      .filter(node => isContractEvidenceKind(node.kind) && !node.supersededBy)
      .filter(node => containsContractSemanticEvidence(node, surface))
      .sort((a, b) => b.createdAt - a.createdAt);
    return semanticEvidence[0] ?? null;
  }

  setOrigin(sessionId: string, content: string, title = 'Origin'): GraphNode {
    const existing = this.store.getNodesByKind(sessionId, 'origin');
    if (existing.length > 0) {
      // Origin 只能设一次，已有则直接返回
      return existing[0];
    }
    const node: GraphNode = {
      id: this.nextId(sessionId, 'origin'),
      kind: 'origin',
      sessionId,
      title,
      content,
      tags: [],
      createdBy: 'dispatcher',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  setGoal(sessionId: string, content: string, title = 'Goal'): GraphNode {
    const existing = this.store.getNodesByKind(sessionId, 'goal');
    if (existing.length > 0) {
      return existing[0];
    }
    const node: GraphNode = {
      id: this.nextId(sessionId, 'goal'),
      kind: 'goal',
      sessionId,
      title,
      content,
      tags: [],
      createdBy: 'dispatcher',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId, nodeId: node.id, timestamp: node.createdAt });
    return node;
  }

  updateIntentStatus(nodeId: string, sessionId: string, status: IntentStatus): void {
    const normalized = normalizeBlackboardIntentStatus(status);
    this.store.updateNode(nodeId, sessionId, { intentStatus: normalized });
    if (isBlackboardIntentTerminalStatus(normalized)) {
      this.emit({ type: 'intent_resolved', sessionId, nodeId, timestamp: Date.now() });
    }
  }

  /**
   * 直接 patch 节点字段（仅 GraphBridge.onTaskUpdated 等结构化调用方使用）。
   * 用于把 TaskBoard task:updated 投影到对应 Intent 节点的 title/content/tags/status，
   * 解决 Leader update_task 修改 description 后 Intent 节点停留在 createTask 快照的问题。
   */
  updateNode(nodeId: string, sessionId: string, updates: Partial<Pick<GraphNode,
    'title' | 'content' | 'tags' | 'intentStatus' | 'priority' | 'evidence'
  >>): void {
    this.store.updateNode(nodeId, sessionId, updates);
  }

  supersedeNode(nodeId: string, sessionId: string, supersededByNodeId: string): void {
    this.store.updateNode(nodeId, sessionId, { supersededBy: supersededByNodeId });
    this.emit({ type: 'node_superseded', sessionId, nodeId, timestamp: Date.now() });
  }

  // ─────────────────────────────────────────────────────────────
  // Group / Team projection
  //
  // Team 不另起 NodeKind — 用一个 hint 节点 + group:<name> tag 投影群组事实，
  // Worker payload / DispatcherEngine / Reviewer 可以按 tag 过滤获取组上下文。
  // ─────────────────────────────────────────────────────────────

  /**
   * 写入或更新一个 group 投影节点。
   * - 若已存在带 `group:<name>` tag 的 hint 节点，则 supersede 旧节点，写入新节点；
   * - payload.members / payload.leader / payload.workspace 等都序列化进 content。
   * @returns 新节点
   */
  addGroupTag(
    sessionId: string,
    name: string,
    payload: { leader: string; members: string[]; workspace?: string; description?: string },
  ): GraphNode {
    const tag = `group:${name}`;
    const existing = this.store
      .getNodesBySession(sessionId)
      .filter(n => n.kind === 'hint' && n.tags.includes(tag) && !n.supersededBy);
    const content = JSON.stringify({
      leader: payload.leader,
      members: payload.members,
      workspace: payload.workspace,
      description: payload.description,
    });
    const node: GraphNode = {
      id: this.nextId(sessionId, 'hint'),
      kind: 'hint',
      sessionId,
      title: `[group] ${name}`,
      content,
      tags: ['group', tag],
      createdBy: 'team',
      createdAt: Date.now(),
    };
    this.persistNodeAndBound(node);
    this.emit({ type: 'node_added', sessionId, nodeId: node.id, timestamp: node.createdAt });
    for (const old of existing) {
      this.store.updateNode(old.id, sessionId, { supersededBy: node.id });
      this.emit({ type: 'node_superseded', sessionId, nodeId: old.id, timestamp: Date.now() });
    }
    return node;
  }

  /**
   * 释放 group 投影 — 把现存活的 group 节点全部 supersede 到一个 release fact。
   * Reviewer / DispatcherEngine 看到 `group:<name>` 但 supersededBy 非空就视为已解散。
   */
  releaseGroupTag(sessionId: string, name: string, reason?: string): GraphNode | null {
    const tag = `group:${name}`;
    const live = this.store
      .getNodesBySession(sessionId)
      .filter(n => n.kind === 'hint' && n.tags.includes(tag) && !n.supersededBy);
    if (live.length === 0) return null;
    const release: GraphNode = {
      id: this.nextId(sessionId, 'fact'),
      kind: 'fact',
      sessionId,
      title: `[group:released] ${name}`,
      content: reason || 'team_manage(action="delete")',
      tags: ['group', tag, 'group:released'],
      createdBy: 'team',
      createdAt: Date.now(),
    };
    this.store.insertNode(release);
    this.emit({ type: 'node_added', sessionId, nodeId: release.id, timestamp: release.createdAt });
    for (const old of live) {
      this.store.updateNode(old.id, sessionId, { supersededBy: release.id });
      this.emit({ type: 'node_superseded', sessionId, nodeId: old.id, timestamp: Date.now() });
    }
    return release;
  }

  /**
   * 读取当前活跃的 group 投影节点（不含已解散的）。
   */
  getActiveGroup(sessionId: string, name: string): GraphNode | null {
    const tag = `group:${name}`;
    const live = this.store
      .getNodesBySession(sessionId)
      .filter(n => n.kind === 'hint' && n.tags.includes(tag) && !n.supersededBy);
    return live[0] ?? null;
  }

  // ─────────────────────────────────────────────────────────────
  // Intent 认领/释放
  // ─────────────────────────────────────────────────────────────

  claimIntent(intentId: string, sessionId: string, workerId: string): boolean {
    const ok = this.store.claimIntent(intentId, sessionId, workerId);
    if (ok) {
      this.emit({ type: 'node_added', sessionId, nodeId: intentId, timestamp: Date.now() });
    }
    return ok;
  }

  releaseIntent(intentId: string, sessionId: string, workerId: string): void {
    this.store.releaseIntent(intentId, sessionId);
  }

  // ─────────────────────────────────────────────────────────────
  // 图裁剪
  // ─────────────────────────────────────────────────────────────

  /**
   * 写入节点并在超过上限时剪枝（所有 addX 入口的单点限流）。
   * 覆盖 worker 批量写之外的所有路径：Leader 直接工具（write_fact/declare_intent）、
   * GraphBridge、collaboration 事件（review/verdict/decision）。未超上限时仅一次 COUNT 查询即返回；
   * 剪枝失败不阻断写入（addX 仍返回刚插入的节点）。
   */
  private normalizeNodeForStorage(node: GraphNode): GraphNode {
    const { maxNodeContentChars } = getBlackboardLimits();
    const content = truncateNodeContent(node.content, maxNodeContentChars);
    if (content === node.content) return node;
    return {
      ...node,
      content,
      tags: Array.from(new Set([...node.tags, 'content_truncated'])),
    };
  }

  private persistNodeAndBound(node: GraphNode): void {
    const boundedNode = this.normalizeNodeForStorage(node);
    this.store.insertNode(boundedNode);
    const sid = boundedNode.sessionId;
    const { maxNodes, maxEdges } = getBlackboardLimits();
    if (this.store.getNodeCount(sid) <= maxNodes && this.store.getEdgeCount(sid) <= maxEdges) return;
    try {
      this.prune(sid, maxNodes, maxEdges);
    } catch (err) {
      coreLogger.warn(`[BlackboardGraph] auto-prune failed (node=${boundedNode.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  prune(sessionId: string, maxNodes: number, maxEdges: number): void {
    const nodeCount = this.store.getNodeCount(sessionId);
    const edgeCount = this.store.getEdgeCount(sessionId);

    if (nodeCount <= maxNodes && edgeCount <= maxEdges) return;

    this.store.transaction(() => {
      // 优先删除已被 supersede 的节点（保留 origin/goal）
      if (nodeCount > maxNodes) {
        const superseded = this.store.getSupersededNodes(sessionId);
        const deletable = superseded.filter(n => n.kind !== 'origin' && n.kind !== 'goal');
        let toDelete = nodeCount - maxNodes;
        for (const node of deletable) {
          if (toDelete <= 0) break;
          this.store.deleteNodeUnchecked(node.id, sessionId);
          toDelete--;
        }
      }

      // 再删除最旧的已 resolved intent
      if (this.store.getNodeCount(sessionId) > maxNodes) {
        const resolved = this.store.getResolvedIntents(sessionId);
        let toDelete = this.store.getNodeCount(sessionId) - maxNodes;
        for (const node of resolved) {
          if (toDelete <= 0) break;
          this.store.deleteNodeUnchecked(node.id, sessionId);
          toDelete--;
        }
      }

      // 兜底:supersede + resolved-intent 仍超限时(facts/reviews/verdicts/decision_logs/hints 永远不合格),
      // 按 created_at 升序淘汰最旧的非必要节点(origin/goal 与 open/claimed intent 除外),让 MAX_GRAPH_NODES
      // 成为硬上限——否则图过 cap 后每次 addX 跑无用全表 prune,且图无限增长(#9/#25)。
      if (this.store.getNodeCount(sessionId) > maxNodes) {
        const evictable = this.store.getOldestEvictableNodes(sessionId);
        let toDelete = this.store.getNodeCount(sessionId) - maxNodes;
        for (const node of evictable) {
          if (toDelete <= 0) break;
          this.store.deleteNodeUnchecked(node.id, sessionId);
          toDelete--;
        }
      }

      // 边裁剪：删除最旧的边
      if (this.store.getEdgeCount(sessionId) > maxEdges) {
        const allEdges = this.store.getAllEdges(sessionId);
        let toDelete = this.store.getEdgeCount(sessionId) - maxEdges;
        for (const edge of allEdges) {
          if (toDelete <= 0) break;
          this.store.deleteEdge(edge.id, sessionId);
          toDelete--;
        }
      }
    });
  }

  getNode(id: string, sessionId: string): GraphNode | null {
    return this.store.getNode(id, sessionId);
  }

  getNodesByKind(sessionId: string, kind: NodeKind): GraphNode[] {
    return this.store.getNodesByKind(sessionId, kind);
  }

  getNodesByTag(sessionId: string, tag: string): GraphNode[] {
    return this.store.getNodesByTag(sessionId, tag);
  }

  // ─────────────────────────────────────────────────────────────
  // 边操作
  // ─────────────────────────────────────────────────────────────

  addEdge(input: Omit<GraphEdge, 'id' | 'createdAt'>): GraphEdge {
    // 验证两端节点存在，防止悬空边
    const fromNode = this.store.getNode(input.fromNodeId, input.sessionId);
    const toNode = this.store.getNode(input.toNodeId, input.sessionId);
    if (!fromNode || !toNode) {
      coreLogger.warn(`[BlackboardGraph] addEdge 跳过：节点不存在 from=${input.fromNodeId}(${!!fromNode}) to=${input.toNodeId}(${!!toNode})`);
      // 返回一个标记为无效的 edge（不写入数据库）
      return {
        ...input,
        id: `invalid-${Date.now()}`,
        createdAt: Date.now(),
      };
    }

    const edge: GraphEdge = {
      ...input,
      id: this.nextEdgeId(input.sessionId),
      createdAt: Date.now(),
    };
    this.store.insertEdge(edge);
    this.emit({ type: 'edge_added', sessionId: edge.sessionId, edgeId: edge.id, timestamp: edge.createdAt });

    // 检测矛盾边
    if (edge.edgeType === 'contradicts') {
      this.emit({
        type: 'contradiction_detected',
        sessionId: edge.sessionId,
        nodeId: edge.fromNodeId,
        timestamp: Date.now(),
      });
    }

    return edge;
  }

  getEdgesFrom(sessionId: string, nodeId: string): GraphEdge[] {
    return this.store.getEdgesFrom(sessionId, nodeId);
  }

  getEdgesTo(sessionId: string, nodeId: string): GraphEdge[] {
    return this.store.getEdgesTo(sessionId, nodeId);
  }

  // ─────────────────────────────────────────────────────────────
  // 图查询
  // ─────────────────────────────────────────────────────────────

  /**
   * BFS 提取以 centerNodeId 为中心的子图
   */
  getSubgraph(sessionId: string, centerNodeId: string, maxDepth = DEFAULT_SUBGRAPH_DEPTH): GraphSnapshot {
    const visited = new Set<string>();
    const resultNodes: GraphNode[] = [];
    const resultEdges: GraphEdge[] = [];
    let frontier = [centerNodeId];

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = this.store.getNode(nodeId, sessionId);
        if (!node) continue;
        resultNodes.push(node);

        // 沿出边和入边扩展
        const outEdges = this.store.getEdgesFrom(sessionId, nodeId);
        const inEdges = this.store.getEdgesTo(sessionId, nodeId);
        for (const edge of [...outEdges, ...inEdges]) {
          resultEdges.push(edge);
          if (!visited.has(edge.fromNodeId)) nextFrontier.push(edge.fromNodeId);
          if (!visited.has(edge.toNodeId)) nextFrontier.push(edge.toNodeId);
        }
      }
      frontier = nextFrontier;
    }

    const originNode = resultNodes.find(n => n.kind === 'origin');
    const goalNode = resultNodes.find(n => n.kind === 'goal');

    return {
      nodes: resultNodes,
      edges: resultEdges,
      focusNodeId: centerNodeId,
      originNode,
      goalNode,
    };
  }

  /**
   * 获取可调度的 Intent(status=open 且无未解决的 depends_on 依赖)。
   * 委托通用 DagScheduler:把 depends_on 图边聚合成节点视图,保留黑板特殊语义
   * (依赖源不存在→已解决;非 intent 依赖→已满足)。语义等价于原内联实现。
   */
  getDispatchableIntents(sessionId: string): GraphNode[] {
    const openIntents = this.store.getNodesByKind(sessionId, 'intent')
      // 调度入口只接收 open;active helper 覆盖 claimed,但 claimed 不能再次派发。
      .filter(n => normalizeBlackboardIntentStatus(n.intentStatus) === 'open');
    if (openIntents.length === 0) return [];

    const byId = new Map<string, BbViewNode>();
    const views: BbViewNode[] = [];
    for (const intent of openIntents) {
      const fromIds = this.store
        .getEdgesTo(sessionId, intent.id)
        .filter(e => e.edgeType === 'depends_on')
        .map(e => e.fromNodeId);
      const view: BbViewNode = { id: intent.id, blocked_by: fromIds, graphNode: intent, isOpenIntent: true };
      byId.set(intent.id, view);
      views.push(view);
      // 依赖源节点入图(供 isDependencySatisfied 查询 kind/intentStatus)
      for (const fid of fromIds) {
        if (!byId.has(fid)) {
          byId.set(fid, { id: fid, blocked_by: [], graphNode: this.store.getNode(fid, sessionId) ?? undefined, isOpenIntent: false });
        }
      }
    }
    const deps: DagSchedulerDeps<BbViewNode> = {
      isDependencySatisfied: (dep) => {
        if (!dep?.graphNode) return true;                  // 依赖源不存在 → 已解决(黑板语义)
        if (dep.graphNode.kind !== 'intent') return true;   // 非 intent 依赖 → 已满足
        return isBlackboardIntentTerminalStatus(dep.graphNode.intentStatus);
      },
      isCandidate: (n) => n.isOpenIntent,                   // 只有 open intents 是候选(已预过滤)
    };
    return views.filter(v => isNodeReady(v, byId, deps).ready).map(v => v.graphNode!);
  }

  /**
   * 检测图中的矛盾（contradicts 边）
   */
  getContradictions(sessionId: string): Array<{ nodeA: GraphNode; nodeB: GraphNode; edge: GraphEdge }> {
    const contradictionEdges = this.store.getEdgesByType(sessionId, 'contradicts');
    const results: Array<{ nodeA: GraphNode; nodeB: GraphNode; edge: GraphEdge }> = [];

    for (const edge of contradictionEdges) {
      const nodeA = this.store.getNode(edge.fromNodeId, sessionId);
      const nodeB = this.store.getNode(edge.toNodeId, sessionId);
      if (nodeA && nodeB) {
        results.push({ nodeA, nodeB, edge });
      }
    }
    return results;
  }

  /**
   * 分析图状态，供 Dispatcher 使用
   */
  analyze(sessionId: string): GraphAnalysis {
    const allNodes = this.store.getNodesBySession(sessionId);
    const openIntents = allNodes.filter(n => n.kind === 'intent' && normalizeBlackboardIntentStatus(n.intentStatus) === 'open');
    const recentFacts = allNodes
      .filter(n => n.kind === 'fact')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    const contradictions = this.getContradictions(sessionId);
    const unresolvedContradictions = contradictions.map(c => ({ nodeA: c.nodeA, nodeB: c.nodeB }));

    // 被阻塞的 Intent
    const dispatchable = this.getDispatchableIntents(sessionId);
    const dispatchableIds = new Set(dispatchable.map(n => n.id));
    const blockedIntents = openIntents.filter(i => !dispatchableIds.has(i.id));
    const knowledgeGaps = blockedIntents.map(i => `Intent ${i.id} (${i.title}) is blocked by unresolved dependencies`);

    const completionSignals = openIntents.length === 0 && recentFacts.length > 0
      ? ['No open intents remaining']
      : [];

    return {
      openIntents,
      unresolvedContradictions,
      knowledgeGaps,
      blockedIntents,
      recentFacts,
      completionSignals,
    };
  }

  /**
   * 获取完整快照
   */
  /** 轻量计数(COUNT 查询),供 EternalLoop silence-gate 等高频轮询用,避免 getSnapshot 全量物化(#52)。 */
  getCounts(sessionId: string): { nodes: number; edges: number } {
    return { nodes: this.store.getNodeCount(sessionId), edges: this.store.getEdgeCount(sessionId) };
  }

  getSnapshot(sessionId: string): GraphSnapshot {
    const nodes = this.store.getNodesBySession(sessionId);
    const edges = this.store.getAllEdges(sessionId);
    const originNode = nodes.find(n => n.kind === 'origin');
    const goalNode = nodes.find(n => n.kind === 'goal');
    return { nodes, edges, originNode, goalNode };
  }

  /**
   * 原子批量写入 Worker 输出
   */
  applyWorkerOutput(sessionId: string, taskId: string, output: WorkerGraphOutput): void {
    this.withBufferedEvents(() => {
      // 1. 写入 Fact 节点
      for (const factInput of output.newFacts) {
        const node: GraphNode = {
          ...factInput,
          id: this.nextId(sessionId, 'fact'),
          kind: 'fact',
          createdAt: Date.now(),
        };
        this.store.insertNode(node);
        this.emit({ type: 'node_added', sessionId, nodeId: node.id, timestamp: node.createdAt });
      }

      // 2. 写入 Intent 节点
      for (const intentInput of output.newIntents) {
        const node: GraphNode = {
          ...intentInput,
          id: this.nextId(sessionId, 'intent'),
          kind: 'intent',
          intentStatus: intentInput.intentStatus ?? 'open',
          createdAt: Date.now(),
        };
        this.store.insertNode(node);
        this.emit({ type: 'node_added', sessionId, nodeId: node.id, timestamp: node.createdAt });
      }

      // 3. 写入 Contract 节点
      for (const contractInput of output.newContracts ?? []) {
        this.addContract(contractInput);
      }

      // 4. 写入 DesignDoc 节点
      for (const designInput of output.newDesignDocs ?? []) {
        this.addDesignDoc(designInput);
      }

      // 5. 写入边（验证节点存在）
      for (const edgeInput of output.newEdges) {
        const fromExists = this.store.getNode(edgeInput.fromNodeId, sessionId);
        const toExists = this.store.getNode(edgeInput.toNodeId, sessionId);
        if (!fromExists || !toExists) {
          coreLogger.warn(`[BlackboardGraph] 跳过边 ${edgeInput.fromNodeId}→${edgeInput.toNodeId}: 节点不存在`);
          continue;
        }
        const edge: GraphEdge = {
          ...edgeInput,
          id: this.nextEdgeId(sessionId),
          createdAt: Date.now(),
        };
        this.store.insertEdge(edge);
        this.emit({ type: 'edge_added', sessionId, edgeId: edge.id, timestamp: edge.createdAt });
      }

      // 4. Supersede 节点
      for (const nodeId of output.supersededNodeIds) {
        this.store.updateNode(nodeId, sessionId, { supersededBy: `task:${taskId}` });
        this.emit({ type: 'node_superseded', sessionId, nodeId, timestamp: Date.now() });
      }
    });
  }

  /**
   * 原子批量写入 + 自动裁剪
   */
  applyWorkerOutputAndPrune(
    sessionId: string,
    taskId: string,
    output: WorkerGraphOutput,
    maxNodes: number = getBlackboardLimits().maxNodes,
    maxEdges: number = getBlackboardLimits().maxEdges,
  ): void {
    this.applyWorkerOutput(sessionId, taskId, output);
    this.prune(sessionId, maxNodes, maxEdges);
  }
}
