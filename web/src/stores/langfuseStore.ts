/**
 * langfuseStore — 本地实时 Langfuse trace 状态管理
 *
 * 通过 SSE (acpClient) 接收 `langfuse:trace` 事件，实时推送 trace 到本地列表。
 * 同时提供 REST API 拉取历史 trace 和统计摘要。
 *
 * 镜像 maintenanceStore/wikiStore 的订阅/去重/HMR 模式。
 */

import { create } from 'zustand';
import { acpClient } from '../api/AcpClient';
import { getServerToken } from '../api/headers';
import { extractCanonicalEventEnvelope, SESSION_UPDATE_METHOD } from '@contracts/adapters/EventAdapter';

// ─── Types ────────────────────────────────────────────────

export interface LocalTrace {
  id: string;
  timestamp: string;
  actor: string;
  model: string;
  status: 'ok' | 'error';
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorKind?: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
}

export interface LocalStats {
  total: number;
  errorCount: number;
  avgLatencyMs: number;
  totalTokens: number;
}

export type DataSource = 'local' | 'remote';
export type ViewMode = 'flat' | 'session';

interface LangfuseStoreState {
  /** 本地实时 trace 列表（最近 500 条，按时间倒序） */
  traces: LocalTrace[];
  /** 本地统计摘要 */
  stats: LocalStats | null;
  /** SSE 连接是否活跃 */
  sseConnected: boolean;
  /** 最近一条 trace 的 ID（用于触发新 trace 动画） */
  latestTraceId: string | null;
  /** 加载状态 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;

  /** 从 REST API 拉取本地历史 trace */
  fetchLocalTraces: (limit?: number, sessionId?: string) => Promise<void>;
  /** 从 REST API 拉取本地统计 */
  fetchLocalStats: () => Promise<void>;
  /** 清空 trace 列表 */
  clearTraces: () => void;
  /** 设置 SSE 连接状态 */
  setSseConnected: (connected: boolean) => void;
}

// ─── Constants ────────────────────────────────────────────

const MAX_TRACES = 500;
const LANGFUSE_TRACE_TYPE = 'langfuse:trace';
const DEDUPE_TTL_MS = 2000;
const seenEventIds = new Map<string, number>();

// ─── Helpers ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pruneSeen(now: number): void {
  for (const [eventId, at] of seenEventIds.entries()) {
    if (now - at > DEDUPE_TTL_MS) seenEventIds.delete(eventId);
  }
}

function normalizeTrace(raw: unknown): LocalTrace | null {
  if (!isRecord(raw)) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    actor: typeof raw.actor === 'string' ? raw.actor : 'unknown',
    model: typeof raw.model === 'string' ? raw.model : '—',
    status: raw.status === 'error' ? 'error' : 'ok',
    latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
    inputTokens: typeof raw.inputTokens === 'number' ? raw.inputTokens : 0,
    outputTokens: typeof raw.outputTokens === 'number' ? raw.outputTokens : 0,
    totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : 0,
    errorKind: typeof raw.errorKind === 'string' && raw.errorKind ? raw.errorKind : undefined,
    agentId: typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : undefined,
    taskId: typeof raw.taskId === 'string' && raw.taskId ? raw.taskId : undefined,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined,
  };
}

// ─── Store ────────────────────────────────────────────────

export const useLangfuseStore = create<LangfuseStoreState>((set) => ({
  traces: [],
  stats: null,
  sseConnected: false,
  latestTraceId: null,
  loading: false,
  error: null,

  fetchLocalTraces: async (limit = 100, sessionId?: string) => {
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (sessionId) params.set('sessionId', sessionId);
      const res = await fetch(`/api/v1/langfuse/local/traces?${params}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const traces: LocalTrace[] = Array.isArray(data?.data)
        ? data.data.map(normalizeTrace).filter((t: LocalTrace | null): t is LocalTrace => t !== null)
        : [];
      set((state) => {
        // Merge REST results with existing SSE traces — dedup by id
        // REST data is more complete, so it takes priority for same id
        const existing = new Map(state.traces.map(t => [t.id, t]));
        for (const t of traces) existing.set(t.id, t);
        const merged = Array.from(existing.values())
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, MAX_TRACES);
        return { traces: merged, loading: false };
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Network error', loading: false });
    }
  },

  fetchLocalStats: async () => {
    try {
      const res = await fetch('/api/v1/langfuse/local/stats', {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ stats: data?.data ?? null });
    } catch {
      // non-fatal — stats are supplementary
    }
  },

  clearTraces: () => set({ traces: [], stats: null, latestTraceId: null }),

  setSseConnected: (connected) => set({ sseConnected: connected }),
}));

// ─── SSE Event Subscription ───────────────────────────────

let langfuseSseUnsubscribe: (() => void) | null = null;

export function ensureLangfuseSseSubscription(): void {
  if (langfuseSseUnsubscribe) return;

  langfuseSseUnsubscribe = acpClient.on(SESSION_UPDATE_METHOD, (data: unknown) => {
    const envelope = extractCanonicalEventEnvelope(data);
    if (!envelope || envelope.type !== LANGFUSE_TRACE_TYPE) return;

    // Dedupe by eventId
    const now = Date.now();
    pruneSeen(now);
    if (envelope.eventId) {
      if (seenEventIds.has(envelope.eventId)) return;
      seenEventIds.set(envelope.eventId, now);
    }

    const payloadRaw = envelope.payload as unknown;
    const payload = isRecord(payloadRaw) ? payloadRaw : {};
    const traceRaw = payload.trace;
    const trace = normalizeTrace(traceRaw);
    if (!trace) return;

    // Set sessionId from envelope if trace doesn't have it
    if (!trace.sessionId && typeof envelope.sessionId === 'string') {
      trace.sessionId = envelope.sessionId;
    }

    const store = useLangfuseStore.getState();
    store.setSseConnected(true);
    useLangfuseStore.setState((state: LangfuseStoreState) => {
      // Prepend new trace, keep max MAX_TRACES
      const next = [trace, ...state.traces].slice(0, MAX_TRACES);
      return { traces: next, latestTraceId: trace.id };
    });
  });

  // Also listen for connection state changes
  acpClient.on('connection/state', (data: unknown) => {
    const connState = isRecord(data) ? data : {};
    const isConnected = connState.state === 'connected';
    useLangfuseStore.getState().setSseConnected(isConnected);
  });
}

export function disposeLangfuseSseSubscription(): void {
  langfuseSseUnsubscribe?.();
  langfuseSseUnsubscribe = null;
}

// Auto-subscribe on module load
ensureLangfuseSseSubscription();

// HMR support
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLangfuseSseSubscription();
  });
}
