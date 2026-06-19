import { create } from 'zustand';
import { getServerToken } from '../api/headers';

// ─── Types ───

export interface GraphNode {
  id: string;
  kind: 'fact' | 'intent' | 'hint' | 'origin' | 'goal';
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  supersededBy?: string;
  confidence?: 'confirmed' | 'likely' | 'tentative';
  intentStatus?: 'open' | 'exploring' | 'resolved' | 'abandoned';
  priority?: number;
  evidence?: Array<{ type: string; ref: string; location?: string; snippet?: string }>;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  createdAt: number;
  createdBy: string;
}

export interface GraphAnalysis {
  openIntents: GraphNode[];
  unresolvedContradictions: Array<{ nodeA: GraphNode; nodeB: GraphNode }>;
  knowledgeGaps: string[];
  blockedIntents: GraphNode[];
  recentFacts: GraphNode[];
  completionSignals: string[];
}

interface GraphResponse {
  enabled: boolean;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

interface AnalysisResponse {
  enabled: boolean;
  analysis?: GraphAnalysis;
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return fallback;
}

// ─── API ───

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: { 'x-lingxiao-token': getServerToken() },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errorMessageFromBody(body, `HTTP ${res.status}`));
  }
  return res.json() as T;
}

// ─── Store ───

interface BlackboardState {
  enabled: boolean;
  /** GraphView 是否挂载并订阅实时 delta;未订阅时 applyDelta 不累积,避免单例 store 跨整会话无限增长(#4) */
  subscribed: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  analysis: GraphAnalysis | null;
  loading: boolean;
  error: string | null;
  selectedNodeId: string | null;

  fetchGraph: (sessionId: string) => Promise<void>;
  fetchAnalysis: (sessionId: string) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  addNode: (node: GraphNode) => void;
  addEdge: (edge: GraphEdge) => void;
  /**
   * 应用 LeaderBlackboard 聚合 emit 的 BlackboardDelta — 增量合并节点和边。
   * - 已存在的节点 id 会用新版本覆盖（处理 supersededBy 等更新）
   * - 不存在的节点直接追加
   * - 边按 id 去重
   */
  applyDelta: (delta: { changedNodes: GraphNode[]; changedEdges: GraphEdge[] }) => void;
  /** GraphView 挂载/卸载时切换订阅态;未订阅时 delta 不累积 */
  setSubscribed: (subscribed: boolean) => void;
  reset: () => void;
}

const initialState = {
  enabled: false,
  subscribed: false,
  nodes: [] as GraphNode[],
  edges: [] as GraphEdge[],
  analysis: null as GraphAnalysis | null,
  loading: false,
  error: null as string | null,
  selectedNodeId: null as string | null,
};

let latestGraphSessionId: string | null = null;
let latestAnalysisSessionId: string | null = null;

// 图节点/边确定性上限,与后端 BlackboardGraph.MAX_GRAPH_NODES(500)/MAX_GRAPH_EDGES(1000)对齐。
// 超限时按 createdAt 降序保留最新(自然淘汰被取代的旧版本),防止单例 store 跨整会话无限增长。
const MAX_NODES = 500;
const MAX_EDGES = 1000;

export const useBlackboardStore = create<BlackboardState>((set, get) => ({
  ...initialState,

  fetchGraph: async (sessionId) => {
    latestGraphSessionId = sessionId;
    set({ loading: true, error: null, selectedNodeId: null });
    try {
      const data = await apiFetch<GraphResponse>(`/sessions/${sessionId}/graph`);
      if (latestGraphSessionId !== sessionId) return;
      if (!data.enabled) {
        set({ enabled: false, nodes: [], edges: [], loading: false });
        return;
      }
      set({
        enabled: true,
        nodes: data.nodes ?? [],
        edges: data.edges ?? [],
        loading: false,
      });
    } catch (err) {
      if (latestGraphSessionId !== sessionId) return;
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  fetchAnalysis: async (sessionId) => {
    latestAnalysisSessionId = sessionId;
    try {
      const data = await apiFetch<AnalysisResponse>(`/sessions/${sessionId}/graph/analysis`);
      if (latestAnalysisSessionId !== sessionId) return;
      if (data.enabled && data.analysis) {
        set({ analysis: data.analysis });
      } else if (data.enabled === false) {
        set({ analysis: null });
      }
    } catch {
      // analysis is optional — don't set error
    }
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  addNode: (node) => set((s) => {
    const exists = s.nodes.some((n) => n.id === node.id);
    if (exists) return s;
    return { nodes: [...s.nodes, node] };
  }),

  addEdge: (edge) => set((s) => {
    const exists = s.edges.some((e) => e.id === edge.id);
    if (exists) return s;
    return { edges: [...s.edges, edge] };
  }),

  applyDelta: ({ changedNodes, changedEdges }) => set((s) => {
    // GraphView 未挂载(未订阅)时不累积:delta 只在订阅时合并,GraphView 挂载会 fetchGraph 全量重载,
    // 故未订阅期间丢弃增量即可——这是 #4 的主修复(黑板图原本在单例 store 里跨整会话无限增长)。
    if (!s.subscribed) return s;
    if ((!changedNodes || changedNodes.length === 0) && (!changedEdges || changedEdges.length === 0)) {
      // 仍然标记为 enabled — delta 到达本身就证明黑板可用
      return s.enabled ? s : { enabled: true };
    }
    let nodes = s.nodes;
    if (changedNodes && changedNodes.length > 0) {
      const map = new Map(nodes.map((n) => [n.id, n]));
      for (const node of changedNodes) {
        if (!node || !node.id) continue;
        // 直接覆盖现有节点（含 supersededBy 等字段更新）
        map.set(node.id, node as GraphNode);
      }
      nodes = [...map.values()];
    }
    let edges = s.edges;
    if (changedEdges && changedEdges.length > 0) {
      const map = new Map(edges.map((e) => [e.id, e]));
      for (const edge of changedEdges) {
        if (!edge || !edge.id) continue;
        map.set(edge.id, edge as GraphEdge);
      }
      edges = [...map.values()];
    }
    // 确定性上限:超限时按 createdAt 降序保留最新(自然淘汰被取代的旧版本节点),防御性地兜底无限增长。
    if (nodes.length > MAX_NODES) {
      nodes = [...nodes].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NODES);
    }
    if (edges.length > MAX_EDGES) {
      edges = [...edges].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_EDGES);
    }
    return { enabled: true, nodes, edges, error: null };
  }),

  setSubscribed: (subscribed) => set({ subscribed }),

  reset: () => {
    latestGraphSessionId = null;
    latestAnalysisSessionId = null;
    // 清空图数据但保留 subscribed 视图生命周期标志(由 GraphView 挂载/卸载管理,不随会话切换复位)
    set((s) => ({ ...initialState, subscribed: s.subscribed }));
  },
}));
