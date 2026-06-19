/**
 * GraphStore — 黑板图的 SQLite 持久化层
 *
 * 职责：节点/边的 CRUD 操作，所有 SQL 均使用 prepared statements。
 * 不做业务逻辑，不做事件发射 — 那是 BlackboardGraph 的职责。
 */

import type { DatabaseSync as DatabaseType, SQLInputValue } from 'node:sqlite';
import type {
  GraphNode,
  GraphEdge,
  NodeKind,
  EdgeType,
  Confidence,
  IntentStatus,
  EvidenceItem,
} from './types.js';
import { runTransaction } from '../Database.js';
import type { ContractAllowedScope } from '../ContractAllowedScope.js';

// ═══════════════════════════════════════════════════════════════
// 内部行类型（SQLite 列均为 TEXT/REAL/INTEGER）
// ═══════════════════════════════════════════════════════════════

interface NodeRow {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  content: string;
  tags: string;
  created_by: string;
  created_at: number;
  superseded_by: string | null;
  confidence: string | null;
  intent_status: string | null;
  priority: number | null;
  evidence: string | null;
  intent_from: string | null;
  intent_to: string | null;
  contract_allowed_scope: string | null;
}

interface EdgeRow {
  id: string;
  session_id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  created_at: number;
  created_by: string;
  metadata: string | null;
}

// ═══════════════════════════════════════════════════════════════
// 行 ↔ 类型转换
// ═══════════════════════════════════════════════════════════════

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    sessionId: row.session_id,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    supersededBy: row.superseded_by ?? undefined,
    confidence: (row.confidence as Confidence) ?? undefined,
    intentStatus: (row.intent_status as IntentStatus) ?? undefined,
    priority: row.priority ?? undefined,
    evidence: row.evidence ? (JSON.parse(row.evidence) as EvidenceItem[]) : undefined,
    intentFrom: row.intent_from ? (JSON.parse(row.intent_from) as string[]) : undefined,
    intentTo: row.intent_to ?? undefined,
    contractAllowedScope: row.contract_allowed_scope
      ? (JSON.parse(row.contract_allowed_scope) as ContractAllowedScope)
      : undefined,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    sessionId: row.session_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    edgeType: row.edge_type as EdgeType,
    createdAt: row.created_at,
    createdBy: row.created_by,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, string>) : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════
// GraphStore
// ═══════════════════════════════════════════════════════════════

export class GraphStore {
  private db: DatabaseType;

  constructor(db: DatabaseType) {
    this.db = db;
  }

  // ─────────────────────────────────────────────────────────────
  // 节点操作
  // ─────────────────────────────────────────────────────────────

  insertNode(node: GraphNode): void {
    this.db.prepare(`
      INSERT INTO graph_nodes
        (id, session_id, kind, title, content, tags, created_by, created_at,
         superseded_by, confidence, intent_status, priority, evidence, intent_from, intent_to,
         contract_allowed_scope)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id,
      node.sessionId,
      node.kind,
      node.title,
      node.content,
      JSON.stringify(node.tags),
      node.createdBy,
      node.createdAt,
      node.supersededBy ?? null,
      node.confidence ?? null,
      node.intentStatus ?? null,
      node.priority ?? null,
      node.evidence ? JSON.stringify(node.evidence) : null,
      node.intentFrom ? JSON.stringify(node.intentFrom) : null,
      node.intentTo ?? null,
      node.contractAllowedScope ? JSON.stringify(node.contractAllowedScope) : null,
    );
  }

  getNode(id: string, sessionId: string): GraphNode | null {
    const row = this.db.prepare(
      'SELECT * FROM graph_nodes WHERE id = ? AND session_id = ?'
    ).get(id, sessionId) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  updateNode(id: string, sessionId: string, updates: Partial<Pick<GraphNode,
    'title' | 'content' | 'tags' | 'supersededBy' | 'confidence' | 'intentStatus' | 'priority' | 'evidence' | 'intentFrom' | 'intentTo' | 'contractAllowedScope'
  >>): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
    if (updates.supersededBy !== undefined) { sets.push('superseded_by = ?'); values.push(updates.supersededBy); }
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.intentStatus !== undefined) { sets.push('intent_status = ?'); values.push(updates.intentStatus); }
    if (updates.priority !== undefined) { sets.push('priority = ?'); values.push(updates.priority); }
    if (updates.evidence !== undefined) { sets.push('evidence = ?'); values.push(JSON.stringify(updates.evidence)); }
    if (updates.intentFrom !== undefined) { sets.push('intent_from = ?'); values.push(JSON.stringify(updates.intentFrom)); }
    if (updates.intentTo !== undefined) { sets.push('intent_to = ?'); values.push(updates.intentTo); }
    if (updates.contractAllowedScope !== undefined) { sets.push('contract_allowed_scope = ?'); values.push(updates.contractAllowedScope ? JSON.stringify(updates.contractAllowedScope) : null); }

    if (sets.length === 0) return;

    values.push(id, sessionId);
    this.db.prepare(`UPDATE graph_nodes SET ${sets.join(', ')} WHERE id = ? AND session_id = ?`).run(...values);
  }

  getNodesBySession(sessionId: string): GraphNode[] {
    const rows = this.db.prepare(
      'SELECT * FROM graph_nodes WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  getNodesByKind(sessionId: string, kind: NodeKind): GraphNode[] {
    const rows = this.db.prepare(
      'SELECT * FROM graph_nodes WHERE session_id = ? AND kind = ? ORDER BY created_at ASC'
    ).all(sessionId, kind) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  getNodesByTag(sessionId: string, tag: string): GraphNode[] {
    // SQLite JSON: tags 列是 JSON 数组，用 LIKE 做简单匹配
    const rows = this.db.prepare(
      "SELECT * FROM graph_nodes WHERE session_id = ? AND tags LIKE ? ORDER BY created_at ASC"
    ).all(sessionId, `%"${tag}"%`) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  // ─────────────────────────────────────────────────────────────
  // 边操作
  // ─────────────────────────────────────────────────────────────

  insertEdge(edge: GraphEdge): void {
    this.db.prepare(`
      INSERT INTO graph_edges
        (id, session_id, from_node_id, to_node_id, edge_type, created_at, created_by, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.id,
      edge.sessionId,
      edge.fromNodeId,
      edge.toNodeId,
      edge.edgeType,
      edge.createdAt,
      edge.createdBy,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    );
  }

  getEdgesFrom(sessionId: string, nodeId: string): GraphEdge[] {
    const rows = this.db.prepare(
      'SELECT * FROM graph_edges WHERE session_id = ? AND from_node_id = ?'
    ).all(sessionId, nodeId) as unknown as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getEdgesTo(sessionId: string, nodeId: string): GraphEdge[] {
    const rows = this.db.prepare(
      'SELECT * FROM graph_edges WHERE session_id = ? AND to_node_id = ?'
    ).all(sessionId, nodeId) as unknown as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getEdgesByType(sessionId: string, edgeType: EdgeType): GraphEdge[] {
    const rows = this.db.prepare(
      'SELECT * FROM graph_edges WHERE session_id = ? AND edge_type = ?'
    ).all(sessionId, edgeType) as unknown as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getAllEdges(sessionId: string): GraphEdge[] {
    const rows = this.db.prepare(
      'SELECT * FROM graph_edges WHERE session_id = ?'
    ).all(sessionId) as unknown as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ─────────────────────────────────────────────────────────────
  // Intent 认领/释放
  // ─────────────────────────────────────────────────────────────

  claimIntent(intentId: string, sessionId: string, workerId: string): boolean {
    const result = this.db.prepare(
      `UPDATE graph_nodes
       SET intent_status = 'claimed', created_by = ?
       WHERE id = ? AND session_id = ? AND intent_status = 'open'`
    ).run(workerId, intentId, sessionId);
    return Number(result.changes) > 0;
  }

  releaseIntent(intentId: string, sessionId: string): void {
    this.db.prepare(
      `UPDATE graph_nodes
       SET intent_status = 'open'
       WHERE id = ? AND session_id = ? AND intent_status = 'claimed'`
    ).run(intentId, sessionId);
  }

  // ─────────────────────────────────────────────────────────────
  // 计数 & 删除
  // ─────────────────────────────────────────────────────────────

  getNodeCount(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM graph_nodes WHERE session_id = ?'
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  getEdgeCount(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM graph_edges WHERE session_id = ?'
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  deleteNode(id: string, sessionId: string): void {
    // 两条 DELETE 必须同事务（immediate 抢写锁 + BUSY 重试），否则中途崩溃/争用
    // 会留下孤立边或孤立节点。
    runTransaction(this.db, () => {
      this.db.prepare(
        'DELETE FROM graph_edges WHERE session_id = ? AND (from_node_id = ? OR to_node_id = ?)'
      ).run(sessionId, id, id);
      this.db.prepare(
        'DELETE FROM graph_nodes WHERE id = ? AND session_id = ?'
      ).run(id, sessionId);
    }, { immediate: true });
  }

  /**
   * 删除节点及其关联边(无独立事务)——供已在事务内的调用方(prune)使用。
   * deleteNode 自带 runTransaction,在 prune 的外层事务内调用会触发"嵌套事务"错误(SQLite 不支持);
   * prune 用此 raw 版本,原子性由外层 prune 事务保证(顺带修 latent bug:历史上 prune 的 superseded/
   * resolved 兜底其实从未真正执行过,persistNodeAndBound 的 try/catch 把嵌套事务错误吞成了 warn,#9/#25)。
   */
  deleteNodeUnchecked(id: string, sessionId: string): void {
    this.db.prepare(
      'DELETE FROM graph_edges WHERE session_id = ? AND (from_node_id = ? OR to_node_id = ?)'
    ).run(sessionId, id, id);
    this.db.prepare(
      'DELETE FROM graph_nodes WHERE id = ? AND session_id = ?'
    ).run(id, sessionId);
  }

  deleteEdge(id: string, sessionId: string): void {
    this.db.prepare(
      'DELETE FROM graph_edges WHERE id = ? AND session_id = ?'
    ).run(id, sessionId);
  }

  getSupersededNodes(sessionId: string): GraphNode[] {
    const rows = this.db.prepare(
      "SELECT * FROM graph_nodes WHERE session_id = ? AND superseded_by IS NOT NULL ORDER BY created_at ASC"
    ).all(sessionId) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  getResolvedIntents(sessionId: string): GraphNode[] {
    const rows = this.db.prepare(
      "SELECT * FROM graph_nodes WHERE session_id = ? AND kind = 'intent' AND intent_status = 'resolved' ORDER BY created_at ASC"
    ).all(sessionId) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 返回最旧的非必要节点(origin/goal 与 open/claimed intent 除外),供 prune 兜底层按 created_at 升序淘汰(#9/#25)。
   * facts/reviews/verdicts/decision_logs/hints 及 resolved intent 都在此列——否则这些种类永远不合格,
   * 图过 MAX_GRAPH_NODES 后每次 addX 跑无用全表 prune。
   */
  getOldestEvictableNodes(sessionId: string): GraphNode[] {
    const rows = this.db.prepare(
      `SELECT * FROM graph_nodes
       WHERE session_id = ?
         AND kind NOT IN ('origin','goal')
         AND NOT (kind = 'intent' AND intent_status IN ('open','claimed'))
       ORDER BY created_at ASC`
    ).all(sessionId) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  // ─────────────────────────────────────────────────────────────
  // 事务辅助
  // ─────────────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    // immediate + BUSY 重试：黑板批量写（prune / worker 图谱输出）在多进程共享 DB 下
    // 必须串行化，避免裸 BEGIN 在 SQLITE_BUSY_SNAPSHOT 下直接抛、丢失整批写。
    return runTransaction(this.db, fn, { immediate: true });
  }
}
