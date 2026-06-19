/**
 * Blackboard Graph — 核心类型定义
 *
 * 节点类型：
 *   Fact   — 已确认事实，不可变
 *   Intent — 待探索方向，可被认领/放弃
 *   Hint   — 人类注入的经验提示
 *   Origin — 起点（特殊 Fact，会话开始时设一次）
 *   Goal   — 终点（特殊 Fact，由用户或 Dispatcher 设定）
 *   Contract — 跨 Agent 接口/数据/验收契约
 *   DesignDoc — 跨 Agent 设计文档/方案约定
 */

// ═══════════════════════════════════════════════════════════════
// 节点
// ═══════════════════════════════════════════════════════════════

import type { ContractAllowedScope } from '../ContractAllowedScope.js';

export type NodeKind = 'fact' | 'intent' | 'hint' | 'origin' | 'goal' | 'contract' | 'design_doc' | 'review' | 'verdict' | 'decision_log';

/**
 * 跨 tag 全局广播的节点类型集合。
 *
 * 默认 broadcastBlackboardDelta 会按 agent.tags 过滤增量推送，避免噪音；
 * 但 contract / design_doc / goal / task_result 这种"跨栈协作必看"的节点必须无视 tag 过滤
 * 直接广播给所有在跑的 worker。
 *
 * AgentPool.broadcastBlackboardDelta 与 contract_node.test.ts 共享此集合，
 * 用 export 而非 AgentPool 内部常量，避免测试反向依赖 AgentPool。
 */
export const GLOBAL_BROADCAST_NODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'contract',
  'design_doc',
  'goal',
]);

export function isGlobalBroadcastNode(node: Pick<GraphNode, 'kind' | 'tags'>): boolean {
  return GLOBAL_BROADCAST_NODE_KINDS.has(node.kind) || node.tags?.includes('task_result');
}

export type Confidence = 'confirmed' | 'likely' | 'tentative';

export type IntentStatus = 'open' | 'claimed' | 'resolved';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  sessionId: string;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  supersededBy?: string;
  confidence?: Confidence;
  intentStatus?: IntentStatus;
  priority?: number;
  evidence?: EvidenceItem[];

  /** 契约结构化允许面(仅 kind==='contract' 节点使用)。undefined=未声明→维持现状。 */
  contractAllowedScope?: ContractAllowedScope;

  // 超边支持：Intent 可以有多个前置 Fact
  intentFrom?: string[];  // 多个前置条件（超边）
  intentTo?: string;      // 探索完成后填充的结果 Fact
}

export interface EvidenceItem {
  type: 'file' | 'test_result' | 'log_output' | 'url' | 'observation' | 'artifact' | 'tool_result' | 'task_result' | 'blackboard_node';
  ref: string;
  location?: string;
  snippet?: string;
}

// ═══════════════════════════════════════════════════════════════
// 边
// ═══════════════════════════════════════════════════════════════

export type EdgeType =
  | 'depends_on'
  | 'supports'
  | 'contradicts'
  | 'refines'
  | 'supersedes'
  | 'produces'
  | 'consumes';

export interface GraphEdge {
  id: string;
  sessionId: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: EdgeType;
  createdAt: number;
  createdBy: string;
  metadata?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════
// 快照 & 输出
// ═══════════════════════════════════════════════════════════════

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusNodeId?: string;
  originNode?: GraphNode;
  goalNode?: GraphNode;
}

export interface WorkerGraphOutput {
  newFacts: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>[];
  newIntents: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>[];
  newContracts?: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>[];
  newDesignDocs?: Omit<GraphNode, 'id' | 'kind' | 'createdAt'>[];
  newEdges: Omit<GraphEdge, 'id' | 'createdAt'>[];
  supersededNodeIds: string[];
  completionSummary: string;
}

// ═══════════════════════════════════════════════════════════════
// 调度
// ═══════════════════════════════════════════════════════════════

export type TaskInstruction = 'bootstrap' | 'reason' | 'explore';

export interface DispatchDecision {
  intentNodeId: string;
  instruction: TaskInstruction;
  graphSnapshot: GraphSnapshot;
  suggestedTools?: string[];
  priority: number;
}

export interface GraphAnalysis {
  openIntents: GraphNode[];
  unresolvedContradictions: Array<{ nodeA: GraphNode; nodeB: GraphNode }>;
  knowledgeGaps: string[];
  blockedIntents: GraphNode[];
  recentFacts: GraphNode[];
  completionSignals: string[];
}

// ═══════════════════════════════════════════════════════════════
// 事件
// ═══════════════════════════════════════════════════════════════

export interface BlackboardEvent {
  type:
    | 'node_added'
    | 'node_superseded'
    | 'edge_added'
    | 'intent_resolved'
    | 'contradiction_detected';
  sessionId: string;
  nodeId?: string;
  edgeId?: string;
  taskId?: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════
// 结构化增量（用于 Agent 实时联动）
// ═══════════════════════════════════════════════════════════════

export interface BlackboardDelta {
  eventType: BlackboardEvent['type'];
  changedNodes: GraphNode[];
  changedEdges: GraphEdge[];
  humanSummary: string;
  relatedTags: string[];
}
