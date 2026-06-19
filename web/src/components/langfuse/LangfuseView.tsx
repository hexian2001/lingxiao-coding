/**
 * LangfuseView — Langfuse 可观测性实时 Dashboard
 *
 * 特性：
 * - 本地实时数据优先（SSE 推送 + ring buffer），远程 Langfuse 作为补充
 * - 延迟分布直方图、Token 趋势 sparkline、Actor 分布图
 * - 实时时间线：新 trace 淡入动画，可展开查看详情
 * - Local/Remote 数据源切换
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity, ExternalLink, RefreshCw, CheckCircle2, XCircle,
  Clock, AlertTriangle, TrendingUp, Loader2, Wifi, Settings,
  ChevronRight, ChevronDown, Cpu, User, Zap, Hash, Brain,
  Layers, Database, ArrowDown, ArrowUp, Radio,
} from 'lucide-react';
import { settingsApiFetch } from '../../components/settings/settingsApi';
import { getServerToken } from '../../api/headers';
import { useLangfuseStore, type LocalTrace, type DataSource } from '../../stores/langfuseStore';

// ─── Types ────────────────────────────────────────────────

interface LangfuseStatus {
  enabled: boolean;
  baseUrl: string;
  secretKeyConfigured: boolean;
  publicKeyConfigured: boolean;
  traceLlmCalls: boolean;
  traceToolCalls: boolean;
  traceAgentLifecycle: boolean;
  sampleRate: number;
  maskSensitive: boolean;
}

interface RemoteTrace {
  id: string;
  name: string;
  timestamp: string;
  userId?: string;
  sessionId?: string;
  session_id?: string;
  tags?: string[];
  latencyMs?: number;
  totalCost?: number;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  status?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  observations?: RemoteObservation[];
}

interface RemoteObservation {
  id: string;
  name: string;
  type: string;
  startTime: string;
  endTime?: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  usage?: { input?: number; output?: number; total?: number; };
  level?: string;
  statusMessage?: string;
  metadata?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────

function latencyColor(ms: number): string {
  if (ms === 0) return 'text-text-tertiary';
  if (ms < 5000) return 'text-accent-green';
  if (ms < 10000) return 'text-accent-yellow';
  if (ms < 20000) return 'text-accent-orange';
  return 'text-accent-red';
}

function latencyBg(ms: number): string {
  if (ms === 0) return 'bg-text-quaternary';
  if (ms < 5000) return 'bg-accent-green';
  if (ms < 10000) return 'bg-accent-yellow';
  if (ms < 20000) return 'bg-accent-orange';
  return 'bg-accent-red';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const ts = new Date(timestamp).getTime();
  const diff = now - ts;
  if (diff < 10_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function shortId(id: string): string {
  if (!id) return '—';
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function truncateText(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

function safeJsonStringify(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

const ACTOR_COLORS: Record<string, string> = {
  Leader: '#5FE0C7',
  unknown: '#6b7280',
};

function actorColor(actor: string): string {
  return ACTOR_COLORS[actor] ?? '#C9A86A';
}

// ─── Component ────────────────────────────────────────────

export default function LangfuseView() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LangfuseStatus | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('local');
  const [remoteTraces, setRemoteTraces] = useState<RemoteTrace[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [filterActor, setFilterActor] = useState<string>('all');
  const [filterModel, setFilterModel] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'timeline' | 'session'>('timeline');
  const [showErrorsOnly, setShowErrorsOnly] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const { traces: localTraces, sseConnected, latestTraceId, loading: localLoading, fetchLocalTraces, fetchLocalStats } = useLangfuseStore();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await settingsApiFetch<{ data: LangfuseStatus }>('/langfuse/status');
      setStatus(res.data);
    } catch { /* ignore */ }
  }, []);

  const fetchRemoteTraces = useCallback(async () => {
    if (!status?.enabled) return;
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const res = await fetch('/api/v1/langfuse/traces?limit=50&includeObservations=true', {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (res.ok) {
        const data = await res.json();
        setRemoteTraces(Array.isArray(data?.data) ? data.data : []);
        if (data?.error) setRemoteError(data.error);
      } else {
        setRemoteTraces([]);
        setRemoteError(`HTTP ${res.status}`);
      }
    } catch (e) {
      setRemoteTraces([]);
      setRemoteError(e instanceof Error ? e.message : 'Network error');
    }
    setRemoteLoading(false);
  }, [status?.enabled]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/v1/langfuse/test', {
        method: 'POST',
        headers: { 'x-lingxiao-token': getServerToken(), 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      setTestResult(data.success
        ? { success: true, message: data.message || '连接成功' }
        : { success: false, message: data.error || '连接失败' });
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : 'Network error' });
    }
    setTesting(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Local data — only re-fetch when switching to local source (store methods are stable)
  useEffect(() => {
    if (dataSource === 'local') {
      fetchLocalTraces(200);
      fetchLocalStats();
    }
  }, [dataSource, fetchLocalTraces, fetchLocalStats]);

  // Remote data — use ref so fetchRemoteTraces identity changes don't re-trigger local fetch
  const fetchRemoteRef = useRef(fetchRemoteTraces);
  fetchRemoteRef.current = fetchRemoteTraces;

  useEffect(() => {
    if (dataSource !== 'remote' || !status?.enabled) return;
    fetchRemoteRef.current();
    const interval = setInterval(() => fetchRemoteRef.current(), 15000);
    return () => clearInterval(interval);
  }, [dataSource, status?.enabled]);

  const toggleTrace = (id: string) => {
    setExpandedTraces(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ─── Unified trace list ───
  interface UnifiedTrace {
    id: string; timestamp: string; actor: string; model: string;
    status: 'ok' | 'error'; latencyMs: number;
    inputTokens: number; outputTokens: number; totalTokens: number;
    errorKind?: string; sessionId?: string; agentId?: string; taskId?: string;
    metadata?: Record<string, unknown>;
    observations?: RemoteObservation[];
  }
  const unifiedTraces = useMemo<UnifiedTrace[]>(() => {
    if (dataSource === 'local') {
      return localTraces.map(t => ({
        id: t.id, timestamp: t.timestamp, actor: t.actor, model: t.model,
        status: t.status, latencyMs: t.latencyMs,
        inputTokens: t.inputTokens, outputTokens: t.outputTokens, totalTokens: t.totalTokens,
        errorKind: t.errorKind, sessionId: t.sessionId, agentId: t.agentId, taskId: t.taskId,
        metadata: undefined, observations: undefined,
      }));
    }
    return remoteTraces.map(t => {
      // Langfuse trace 顶层没有 model/usage 字段——这些在 observation 上
      // （type=GENERATION）。trace list API 的 observations 字段只是 id 数组，
      // 完整 observation 由后端 /observations 端点补全后挂在 t.observations 上。
      const meta = (t.metadata ?? {}) as Record<string, unknown>;
      const metaLatency = meta.latencyMs as number;
      const genObs = t.observations?.find(o => o.type?.toUpperCase() === 'GENERATION' && o.model)
        ?? t.observations?.find(o => o.model)
        ?? t.observations?.[0];
      const obsMeta = (genObs?.metadata ?? {}) as Record<string, unknown>;
      const usage = genObs?.usage ?? t.usage;
      // actor 优先级：trace metadata.actor（LLM 调用）→ observation metadata.actor
      // → metadata.agentName（tool/lifecycle 调用）→ trace name 解析
      const actor = (meta.actor as string)
        || (obsMeta.actor as string)
        || (obsMeta.agentName as string)
        || (meta.agentName as string)
        || t.name?.match(/llm-(.+)/)?.[1]
        || t.name?.match(/tool-(.+)/)?.[1]
        || 'unknown';
      return {
        id: t.id, timestamp: t.timestamp,
        actor,
        model: genObs?.model || t.model || '—',
        status: (t.status === 'error' || t.observations?.some(o => o.level?.toUpperCase() === 'ERROR')) ? 'error' as const : 'ok' as const,
        latencyMs: t.latencyMs ?? metaLatency ?? 0,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        totalTokens: usage?.total ?? 0,
        errorKind: undefined, sessionId: t.sessionId ?? t.session_id,
        agentId: t.userId, taskId: undefined,
        metadata: t.metadata, observations: t.observations,
      };
    });
  }, [dataSource, localTraces, remoteTraces]);

  const actors = useMemo(() => {
    const map = new Map<string, { count: number; tokens: number; errors: number }>();
    for (const t of unifiedTraces) {
      const e = map.get(t.actor) ?? { count: 0, tokens: 0, errors: 0 };
      e.count++; e.tokens += t.totalTokens;
      if (t.status === 'error') e.errors++;
      map.set(t.actor, e);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count);
  }, [unifiedTraces]);

  const models = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of unifiedTraces) {
      // 排除 'tool'（工具调用占位）和 '—'，只统计真实 LLM 模型
      if (t.model && t.model !== '—' && t.model !== 'tool') map.set(t.model, (map.get(t.model) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [unifiedTraces]);

  const sessionGroups = useMemo(() => {
    const map = new Map<string, typeof unifiedTraces>();
    for (const t of unifiedTraces) {
      const sid = t.sessionId || 'no-session';
      if (!map.has(sid)) map.set(sid, []);
      map.get(sid)!.push(t);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [unifiedTraces]);

  const filteredTraces = useMemo(() => {
    return unifiedTraces.filter(t =>
      (filterActor === 'all' || t.actor === filterActor) &&
      (filterModel === 'all' || t.model === filterModel) &&
      (!showErrorsOnly || t.status === 'error')
    );
  }, [unifiedTraces, filterActor, filterModel, showErrorsOnly]);

  // ─── Stats ───
  const stats = useMemo(() => {
    const total = unifiedTraces.length;
    const inputTokens = unifiedTraces.reduce((s, t) => s + t.inputTokens, 0);
    const outputTokens = unifiedTraces.reduce((s, t) => s + t.outputTokens, 0);
    const totalTokens = inputTokens + outputTokens;
    const latencies = unifiedTraces.map(t => t.latencyMs).filter(l => l > 0).sort((a, b) => a - b);
    const avgLatency = latencies.length > 0 ? latencies.reduce((s, l) => s + l, 0) / latencies.length : 0;
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p90 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.9)] : 0;
    const maxLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
    const errorCount = unifiedTraces.filter(t => t.status === 'error').length;
    const errorRate = total > 0 ? (errorCount / total) * 100 : 0;
    const sessionCount = sessionGroups.filter(([sid]) => sid !== 'no-session').length;
    return { total, inputTokens, outputTokens, totalTokens, avgLatency, p50, p90, maxLatency, errorCount, errorRate, sessionCount };
  }, [unifiedTraces, sessionGroups]);

  // ─── Latency histogram ───
  const latencyHistogram = useMemo(() => {
    const buckets = [
      { label: '<2s', min: 0, max: 2000, count: 0 },
      { label: '2-5s', min: 2000, max: 5000, count: 0 },
      { label: '5-10s', min: 5000, max: 10000, count: 0 },
      { label: '10-20s', min: 10000, max: 20000, count: 0 },
      { label: '>20s', min: 20000, max: Infinity, count: 0 },
    ];
    for (const t of unifiedTraces) {
      if (t.latencyMs <= 0) continue;
      for (const b of buckets) {
        if (t.latencyMs >= b.min && t.latencyMs < b.max) { b.count++; break; }
      }
    }
    const maxCount = Math.max(...buckets.map(b => b.count), 1);
    return { buckets, maxCount };
  }, [unifiedTraces]);

  // ─── Token trend ───
  const tokenTrend = useMemo(() => {
    const recent = unifiedTraces.slice(0, 30).reverse();
    const maxTokens = Math.max(...recent.map(t => t.totalTokens), 1);
    return { recent, maxTokens };
  }, [unifiedTraces]);

  // ─── Render ───
  if (!status) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
      </div>
    );
  }

  if (!status.enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-text-tertiary gap-3">
        <Activity className="w-10 h-10 opacity-40" />
        <p className="text-sm font-medium">{t('langfuse.notEnabled', 'Langfuse 可观测性未启用')}</p>
        <p className="text-xs">{t('langfuse.notEnabledHint', '请在设置 → Langfuse 中配置并启用')}</p>
        <a href="#/settings" className="mt-2 inline-flex items-center gap-1.5 rounded border border-border-input bg-bg-input px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-accent-brand hover:text-text-primary transition-colors">
          {t('langfuse.goToSettings', '前往设置')}
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Activity className="w-4 h-4 text-accent-purple" />
            <div className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-bg-secondary ${dataSource === 'local' ? 'bg-accent-green' : 'bg-accent-blue'}`} />
          </div>
          <span className="text-sm font-semibold text-text-primary">{t('langfuse.title', 'Langfuse 可观测性')}</span>
        </div>

        <div className="flex items-center gap-0.5 rounded-md border border-border-default bg-bg-tertiary/30 p-0.5 ml-2">
          <button className={`px-2.5 py-0.5 text-[10px] font-medium rounded transition-colors flex items-center gap-1 ${dataSource === 'local' ? 'bg-bg-primary text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`} onClick={() => setDataSource('local')}>
            <Radio className="w-2.5 h-2.5" />
            Local {sseConnected && dataSource === 'local' && <span className="w-1 h-1 rounded-full bg-accent-green animate-pulse" />}
          </button>
          <button className={`px-2.5 py-0.5 text-[10px] font-medium rounded transition-colors ${dataSource === 'remote' ? 'bg-bg-primary text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`} onClick={() => setDataSource('remote')}>
            Remote
          </button>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-0.5 rounded-md border border-border-default bg-bg-tertiary/30 p-0.5">
          <button className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${viewMode === 'timeline' ? 'bg-bg-primary text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`} onClick={() => setViewMode('timeline')}>
            <Clock className="w-2.5 h-2.5 inline mr-0.5" />时间线
          </button>
          <button className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${viewMode === 'session' ? 'bg-bg-primary text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`} onClick={() => setViewMode('session')}>
            <Layers className="w-2.5 h-2.5 inline mr-0.5" />会话
          </button>
        </div>

        <a href={status.baseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border-input bg-bg-input px-2.5 py-1 text-xs font-medium text-text-secondary hover:border-accent-brand hover:text-text-primary transition-colors">
          <ExternalLink className="h-3.5 w-3.5" /> Dashboard
        </a>
        <button className="p-1.5 rounded-md hover:bg-bg-hover transition-colors" onClick={() => dataSource === 'local' ? fetchLocalTraces(200) : fetchRemoteTraces()} title="刷新">
          <RefreshCw size={14} className={`text-text-tertiary ${(localLoading || remoteLoading) ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ─── Stats Grid ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-1.5 px-3 py-2 border-b border-border-default bg-bg-secondary/30 shrink-0">
        <StatCard icon={<TrendingUp className="w-3.5 h-3.5 text-accent-blue" />} label="Traces" value={stats.total.toString()} sub={`${actors.length} actors`} />
        <StatCard icon={<Layers className="w-3.5 h-3.5 text-accent-brand" />} label="Sessions" value={stats.sessionCount.toString()} sub={dataSource === 'local' ? 'local buffer' : 'remote'} />
        <StatCard icon={<ArrowDown className="w-3.5 h-3.5 text-accent-purple" />} label="Input" value={formatTokens(stats.inputTokens)} sub="prompt tokens" />
        <StatCard icon={<ArrowUp className="w-3.5 h-3.5 text-accent-green" />} label="Output" value={formatTokens(stats.outputTokens)} sub="completion" />
        <StatCard icon={<Clock className="w-3.5 h-3.5 text-accent-yellow" />} label="P50 / P90" value={stats.p50 > 0 ? `${formatLatency(stats.p50)} / ${formatLatency(stats.p90)}` : '--'} sub={stats.maxLatency > 0 ? `max ${formatLatency(stats.maxLatency)}` : ''} />
        <StatCard icon={<AlertTriangle className="w-3.5 h-3.5 text-accent-red" />} label="Errors" value={`${stats.errorRate.toFixed(1)}%`} sub={`${stats.errorCount} errors`} valueClass={stats.errorRate > 0 ? 'text-accent-red' : ''} />
        <StatCard icon={<Cpu className="w-3.5 h-3.5 text-accent-orange" />} label="Models" value={models.length.toString()} sub={models[0]?.[0]?.slice(0, 15) ?? ''} />
      </div>

      {/* ─── Analytics Row ─── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-1.5 px-3 py-2 border-b border-border-default bg-bg-secondary/20 shrink-0">
        {/* Latency histogram */}
        <div className="rounded-lg border border-border-default bg-bg-tertiary/20 p-2.5">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock className="w-3 h-3 text-accent-yellow" />
            <span className="text-[10px] text-text-tertiary uppercase tracking-wide">延迟分布</span>
            <span className="text-[9px] text-text-quaternary ml-auto">avg {stats.avgLatency > 0 ? formatLatency(stats.avgLatency) : '--'}</span>
          </div>
          <div className="flex items-end gap-1.5 h-16">
            {latencyHistogram.buckets.map((b, i) => {
              const h = b.count > 0 ? Math.max((b.count / latencyHistogram.maxCount) * 100, 8) : 0;
              const colors = ['bg-accent-green', 'bg-accent-green', 'bg-accent-yellow', 'bg-accent-orange', 'bg-accent-red'];
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <span className="text-[8px] font-mono text-text-quaternary">{b.count || ''}</span>
                  <div className="w-full flex-1 flex items-end">
                    <div className={`w-full rounded-t transition-all duration-300 ${h > 0 ? colors[i] : 'bg-bg-tertiary'}`} style={{ height: `${h}%`, minHeight: h > 0 ? '4px' : '0' }} />
                  </div>
                  <span className="text-[8px] text-text-quaternary">{b.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actor distribution */}
        <div className="rounded-lg border border-border-default bg-bg-tertiary/20 p-2.5">
          <div className="flex items-center gap-1.5 mb-2">
            <User className="w-3 h-3 text-accent-brand" />
            <span className="text-[10px] text-text-tertiary uppercase tracking-wide">Actor 分布</span>
          </div>
          <div className="space-y-1.5">
            {actors.length === 0 && <div className="text-[10px] text-text-quaternary py-4 text-center">暂无数据</div>}
            {actors.map(([actor, info]) => {
              const pct = stats.total > 0 ? (info.count / stats.total) * 100 : 0;
              const errPct = info.count > 0 ? (info.errors / info.count) * 100 : 0;
              return (
                <div key={actor} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: actorColor(actor) }} />
                  <span className="text-[10px] text-text-secondary w-16 truncate">{actor}</span>
                  <div className="flex-1 h-3 rounded-full bg-bg-tertiary overflow-hidden flex">
                    <div className="h-full rounded-l" style={{ width: `${pct * (1 - errPct / 100)}%`, backgroundColor: actorColor(actor) }} />
                    {errPct > 0 && <div className="h-full bg-accent-red" style={{ width: `${pct * (errPct / 100)}%` }} />}
                  </div>
                  <span className="text-[9px] font-mono text-text-tertiary w-8 text-right">{info.count}</span>
                  <span className="text-[9px] font-mono text-accent-purple w-12 text-right">{formatTokens(info.tokens)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Token trend sparkline */}
        <div className="rounded-lg border border-border-default bg-bg-tertiary/20 p-2.5">
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="w-3 h-3 text-accent-yellow" />
            <span className="text-[10px] text-text-tertiary uppercase tracking-wide">Token 趋势</span>
            <span className="text-[9px] text-text-quaternary ml-auto">最近 {tokenTrend.recent.length} 次</span>
          </div>
          <div className="flex items-end gap-px h-16">
            {tokenTrend.recent.length === 0 && <div className="text-[10px] text-text-quaternary py-4 text-center w-full">暂无数据</div>}
            {tokenTrend.recent.map((t, i) => {
              const h = t.totalTokens > 0 ? Math.max((t.totalTokens / tokenTrend.maxTokens) * 100, 4) : 0;
              const inputRatio = t.totalTokens > 0 ? t.inputTokens / t.totalTokens : 0;
              return (
                <div key={i} className="flex-1 flex flex-col-reverse" style={{ height: '100%' }} title={`${t.actor}: ${formatTokens(t.totalTokens)} tokens`}>
                  <div className="w-full transition-all duration-200 rounded-b-sm" style={{ height: `${h}%`, minHeight: h > 0 ? '2px' : '0' }}>
                    <div className="w-full h-full flex flex-col">
                      <div className="bg-accent-green" style={{ height: `${(1 - inputRatio) * 100}%` }} />
                      <div className="bg-accent-purple" style={{ height: `${inputRatio * 100}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 bg-accent-purple rounded-sm" /><span className="text-[8px] text-text-quaternary">Input</span></div>
            <div className="flex items-center gap-1"><div className="w-1.5 h-1.5 bg-accent-green rounded-sm" /><span className="text-[8px] text-text-quaternary">Output</span></div>
          </div>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border-default bg-bg-secondary/20 shrink-0 overflow-x-auto">
        <button className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${showErrorsOnly ? 'bg-accent-red/15 border-accent-red text-accent-red' : 'border-border-default text-text-secondary hover:border-text-quaternary'}`} onClick={() => setShowErrorsOnly(!showErrorsOnly)}>
          <AlertTriangle className="w-2.5 h-2.5" />
          {showErrorsOnly ? '仅错误 ✓' : '仅错误'}
        </button>
        {actors.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[9px] text-text-quaternary uppercase">Actor</span>
            <FilterChip active={filterActor === 'all'} onClick={() => setFilterActor('all')} label="All" count={unifiedTraces.length} />
            {actors.map(([a, info]) => (
              <FilterChip key={a} active={filterActor === a} onClick={() => setFilterActor(a)} label={a} count={info.count} color="blue" />
            ))}
          </div>
        )}
        {models.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[9px] text-text-quaternary uppercase">Model</span>
            <FilterChip active={filterModel === 'all'} onClick={() => setFilterModel('all')} label="All" />
            {models.slice(0, 5).map(([m, c]) => (
              <FilterChip key={m} active={filterModel === m} onClick={() => setFilterModel(m)} label={m.length > 18 ? m.slice(0, 16) + '…' : m} count={c} color="purple" />
            ))}
          </div>
        )}
      </div>

      {/* ─── Connection bar ─── */}
      <div className="flex items-center gap-3 px-4 py-1 border-b border-border-default bg-bg-secondary/30 shrink-0 text-[10px] text-text-tertiary">
        {dataSource === 'local' ? (
          <span className="flex items-center gap-1">
            <Radio className="w-3 h-3 text-accent-green" />
            {sseConnected ? 'SSE 实时连接' : 'SSE 断开 — 使用轮询'}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Database className="w-3 h-3 text-accent-blue" />
            Remote API {remoteError ? `— ${remoteError}` : '已连接'}
          </span>
        )}
        <span className="text-text-quaternary">·</span>
        <span>{truncateText(status.baseUrl, 40)}</span>
        <span className="text-text-quaternary">·</span>
        <span>采样 {(status.sampleRate * 100).toFixed(0)}%</span>
        {testResult && <span className={testResult.success ? 'text-accent-green' : 'text-accent-red'}>{testResult.message}</span>}
        <div className="flex-1" />
        <button onClick={testConnection} disabled={testing} className="text-text-tertiary hover:text-text-primary disabled:opacity-50">
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>

      {/* ─── Trace Timeline / Session View ─── */}
      <div className="flex-1 overflow-y-auto">
        {(localLoading || remoteLoading) && filteredTraces.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-tertiary">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : filteredTraces.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
            <Activity className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">{dataSource === 'local' ? '等待实时 trace… (SSE live)' : '暂无 Trace 数据'}</p>
            <p className="text-xs mt-1">{dataSource === 'local' ? '发起 LLM 调用后将在此实时显示' : '请检查远程 Langfuse 连接'}</p>
          </div>
        ) : viewMode === 'session' ? (
          <div className="divide-y divide-border-default">
            {sessionGroups.map(([sid, groupTraces]) => {
              const filtered = groupTraces.filter(t =>
                (filterActor === 'all' || t.actor === filterActor) &&
                (filterModel === 'all' || t.model === filterModel) &&
                (!showErrorsOnly || t.status === 'error')
              );
              if (filtered.length === 0) return null;
              return <SessionGroup key={sid} sessionId={sid} traces={filtered} expandedTraces={expandedTraces} onToggleTrace={toggleTrace} baseUrl={status.baseUrl} />;
            })}
          </div>
        ) : (
          <div className="divide-y divide-border-default/50">
            {filteredTraces.map((trace) => (
              <TraceRow key={trace.id} trace={trace} isExpanded={expandedTraces.has(trace.id)} isNew={trace.id === latestTraceId && dataSource === 'local'} onToggle={() => toggleTrace(trace.id)} baseUrl={status.baseUrl} showSession={true} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub Components ───────────────────────────────────────

function StatCard({ icon, label, value, sub, valueClass }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-secondary px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 mb-0.5">
        {icon}<span className="text-[10px] text-text-tertiary uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-sm font-mono font-semibold text-text-primary ${valueClass ?? ''}`}>{value}</div>
      {sub && <div className="text-[9px] text-text-quaternary mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function FilterChip({ active, onClick, label, count, color = 'default' }: {
  active: boolean; onClick: () => void; label: string; count?: number; color?: 'default' | 'blue' | 'purple';
}) {
  const colorMap = {
    default: active ? 'bg-accent-brand/15 border-accent-brand text-accent-brand' : 'border-border-default text-text-secondary hover:border-text-quaternary',
    blue: active ? 'bg-accent-blue/15 border-accent-blue text-accent-blue' : 'border-border-default text-text-secondary hover:border-text-quaternary',
    purple: active ? 'bg-accent-purple/15 border-accent-purple text-accent-purple' : 'border-border-default text-text-secondary hover:border-text-quaternary',
  };
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors whitespace-nowrap ${colorMap[color]}`}>
      {label}{count != null && <span className="opacity-60">{count}</span>}
    </button>
  );
}

function SessionGroup({ sessionId, traces, expandedTraces, onToggleTrace, baseUrl, loadingObs }: {
  sessionId: string; traces: any[]; expandedTraces: Set<string>; onToggleTrace: (id: string) => void; baseUrl: string; loadingObs?: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const totalTokens = traces.reduce((s, t) => s + t.totalTokens, 0);
  const errorCount = traces.filter(t => t.status === 'error').length;
  const avgLatency = traces.length > 0 ? traces.reduce((s, t) => s + t.latencyMs, 0) / traces.length : 0;
  const actorsSet = new Set(traces.map(t => t.actor));
  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-bg-hover/30 transition-colors bg-bg-secondary/20" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-text-tertiary shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary shrink-0" />}
        <Database className="w-3.5 h-3.5 text-accent-brand shrink-0" />
        <span className="text-xs font-mono font-medium text-text-primary">{shortId(sessionId)}</span>
        <span className="text-[10px] text-text-tertiary">{traces.length} traces</span>
        {Array.from(actorsSet).map(a => (
          <span key={a} className="px-1 py-0.5 rounded text-[9px] font-medium" style={{ backgroundColor: actorColor(a) + '20', color: actorColor(a) }}>{a}</span>
        ))}
        <div className="flex-1" />
        {totalTokens > 0 && <span className="text-[10px] font-mono text-accent-purple">{formatTokens(totalTokens)} tokens</span>}
        <span className={`text-[10px] font-mono ${latencyColor(avgLatency)}`}>avg {formatLatency(avgLatency)}</span>
        {errorCount > 0 && <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-accent-red/15 text-accent-red">{errorCount} err</span>}
      </div>
      {!collapsed && (
        <div className="border-t border-border-default/30">
          {traces.map(trace => (
            <TraceRow key={trace.id} trace={trace} isExpanded={expandedTraces.has(trace.id)} isNew={false} onToggle={() => onToggleTrace(trace.id)} baseUrl={baseUrl} showSession={false} loadingObs={loadingObs} />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceRow({ trace, isExpanded, isNew, onToggle, baseUrl, showSession = true, loadingObs }: {
  trace: any; isExpanded: boolean; isNew: boolean; onToggle: () => void; baseUrl: string; showSession?: boolean; loadingObs?: Set<string>;
}) {
  return (
    <div className={`hover:bg-bg-hover/30 transition-colors ${isNew ? 'animate-in fade-in duration-300 bg-accent-brand/5' : ''}`}>
      <div className="flex items-center gap-2 px-4 py-1.5 cursor-pointer" onClick={onToggle}>
        {isExpanded ? <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" /> : <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />}
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${trace.status === 'error' ? 'bg-accent-red' : 'bg-accent-green'}`} />
        <span className="text-xs font-medium text-text-primary truncate max-w-[200px]">{trace.actor}</span>
        {showSession && trace.sessionId && (
          <span className="text-[9px] font-mono text-text-quaternary bg-bg-tertiary/50 px-1 py-0.5 rounded">{shortId(trace.sessionId)}</span>
        )}
        <div className="flex-1" />
        {trace.model && trace.model !== '—' && (
          <span className="text-[10px] text-text-tertiary font-mono bg-bg-tertiary/50 px-1.5 py-0.5 rounded shrink-0 hidden md:inline">{truncateText(trace.model, 18)}</span>
        )}
        {trace.totalTokens > 0 && (
          <div className="flex items-center gap-1 shrink-0 hidden lg:flex">
            <span className="text-[10px] font-mono text-accent-purple">{formatTokens(trace.inputTokens)}</span>
            <span className="text-[9px] text-text-quaternary">→</span>
            <span className="text-[10px] font-mono text-accent-green">{formatTokens(trace.outputTokens)}</span>
          </div>
        )}
        <span className={`text-[10px] font-mono shrink-0 ${latencyColor(trace.latencyMs)}`}>{trace.latencyMs > 0 ? formatLatency(trace.latencyMs) : '--'}</span>
        <span className="text-[10px] font-mono text-text-quaternary shrink-0 w-16 text-right">{formatRelativeTime(trace.timestamp)}</span>
      </div>
      {isExpanded && (
        <div className="px-8 pb-3 pt-1 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <DetailItem label="Trace ID" value={shortId(trace.id)} />
            <DetailItem label="Actor" value={trace.actor} />
            <DetailItem label="Model" value={trace.model || '—'} />
            <DetailItem label="Latency" value={trace.latencyMs > 0 ? formatLatency(trace.latencyMs) : '—'} />
            <DetailItem label="Input Tokens" value={formatTokens(trace.inputTokens)} />
            <DetailItem label="Output Tokens" value={formatTokens(trace.outputTokens)} />
            <DetailItem label="Total Tokens" value={formatTokens(trace.totalTokens)} />
            <DetailItem label="Status" value={trace.status} valueClass={trace.status === 'error' ? 'text-accent-red' : 'text-accent-green'} />
          </div>
          {trace.latencyMs > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-text-quaternary uppercase">Latency</span>
              <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                <div className={`h-full rounded-full ${latencyBg(trace.latencyMs)}`} style={{ width: `${Math.min((trace.latencyMs / 30000) * 100, 100)}%` }} />
              </div>
              <span className={`text-[10px] font-mono ${latencyColor(trace.latencyMs)}`}>{formatLatency(trace.latencyMs)}</span>
            </div>
          )}
          {trace.totalTokens > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-text-quaternary uppercase">Tokens</span>
              <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden flex">
                <div className="bg-accent-purple" style={{ width: `${(trace.inputTokens / trace.totalTokens) * 100}%` }} />
                <div className="bg-accent-green" style={{ width: `${(trace.outputTokens / trace.totalTokens) * 100}%` }} />
              </div>
              <span className="text-[10px] font-mono text-accent-purple">{formatTokens(trace.inputTokens)}</span>
              <span className="text-[9px] text-text-quaternary">→</span>
              <span className="text-[10px] font-mono text-accent-green">{formatTokens(trace.outputTokens)}</span>
            </div>
          )}
          {trace.errorKind && (
            <div className="rounded-md border border-accent-red/30 bg-accent-red/5 p-2">
              <span className="text-[10px] text-accent-red font-medium">Error: {trace.errorKind}</span>
            </div>
          )}
          {trace.metadata && Object.keys(trace.metadata).length > 0 && (
            <div className="rounded-md border border-border-default bg-bg-tertiary/30 p-2">
              <div className="text-[9px] text-text-quaternary uppercase tracking-wide mb-1">Metadata</div>
              <pre className="text-[10px] text-text-secondary font-mono overflow-x-auto max-h-40">{truncateText(safeJsonStringify(trace.metadata), 3000)}</pre>
            </div>
          )}
          {loadingObs?.has(trace.id) && (
            <div className="flex items-center gap-2 text-[10px] text-text-tertiary">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>加载 observation 详情…</span>
            </div>
          )}
          {!loadingObs?.has(trace.id) && trace.observations && trace.observations.length > 0 && (
            <div className="space-y-1.5">
              {trace.observations.map((obs: RemoteObservation, idx: number) => (
                <ObservationDetail key={obs.id ?? idx} obs={obs} baseUrl={baseUrl} traceId={trace.id} />
              ))}
            </div>
          )}
          {!loadingObs?.has(trace.id) && (!trace.observations || trace.observations.length === 0) && (
            <div className="text-[10px] text-text-quaternary italic">无 observation 数据</div>
          )}
          <a href={`${baseUrl.replace(/\/+$/, '')}/traces/${trace.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] text-accent-brand hover:underline">
            <ExternalLink className="h-3 w-3" /> 在 Langfuse 中查看完整详情
          </a>
        </div>
      )}
    </div>
  );
}

function DetailItem({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded border border-border-default/50 bg-bg-tertiary/20 px-2 py-1">
      <div className="text-[8px] text-text-quaternary uppercase tracking-wide">{label}</div>
      <div className={`text-[10px] font-mono text-text-secondary ${valueClass ?? ''}`}>{value}</div>
    </div>
  );
}

function ObservationDetail({ obs, baseUrl, traceId }: { obs: RemoteObservation; baseUrl: string; traceId: string }) {
  const [showInput, setShowInput] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const isError = obs.level?.toUpperCase() === 'ERROR';
  const obsLatency = obs.startTime && obs.endTime ? new Date(obs.endTime).getTime() - new Date(obs.startTime).getTime() : null;
  return (
    <div className={`rounded-md border bg-bg-tertiary/20 overflow-hidden ${isError ? 'border-accent-red/30' : 'border-border-default'}`}>
      <div className="flex items-center gap-2 px-2.5 py-1 border-b border-border-default/50">
        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: obs.type === 'generation' ? '#5FE0C7' : '#C9A86A' }} />
        <span className="text-xs font-medium text-text-primary">{obs.name}</span>
        <span className="text-[9px] text-text-quaternary uppercase">{obs.type}</span>
        {obs.model && <span className="text-[9px] text-text-tertiary font-mono bg-bg-tertiary/50 px-1 py-0.5 rounded">{truncateText(obs.model, 25)}</span>}
        {isError && <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-accent-red/15 text-accent-red">ERROR</span>}
        <div className="flex-1" />
        {obsLatency != null && <span className={`text-[10px] font-mono ${latencyColor(obsLatency)}`}>{formatLatency(obsLatency)}</span>}
      </div>
      {obs.usage && ((obs.usage.input ?? 0) > 0 || (obs.usage.output ?? 0) > 0) && (
        <div className="flex items-center gap-2 px-2.5 py-1 border-b border-border-default/30 bg-bg-secondary/20">
          <Zap className="w-2.5 h-2.5 text-accent-yellow" />
          <span className="text-[9px] text-text-tertiary uppercase">Tokens</span>
          {(obs.usage.input ?? 0) > 0 && <span className="text-[9px] text-accent-purple font-mono">{formatTokens(obs.usage.input!)}</span>}
          {(obs.usage.input ?? 0) > 0 && (obs.usage.output ?? 0) > 0 && <span className="text-[8px] text-text-quaternary">→</span>}
          {(obs.usage.output ?? 0) > 0 && <span className="text-[9px] text-accent-green font-mono">{formatTokens(obs.usage.output!)}</span>}
        </div>
      )}
      <div className="flex items-center gap-2 px-2.5 py-1">
        <button onClick={() => setShowInput(!showInput)} className="flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary transition-colors">
          {showInput ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
          <span className="text-accent-purple font-medium">Input</span>
        </button>
        {showInput && obs.input != null && (
          <pre className="mt-1 p-1.5 rounded bg-bg-tertiary/50 text-[9px] text-text-secondary font-mono overflow-x-auto max-h-40 whitespace-pre-wrap break-all">{truncateText(safeJsonStringify(obs.input), 2000)}</pre>
        )}
        <button onClick={() => setShowOutput(!showOutput)} className="flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary transition-colors">
          {showOutput ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
          <span className="text-accent-green font-medium">Output</span>
        </button>
        {showOutput && obs.output != null && (
          <pre className="mt-1 p-1.5 rounded bg-bg-tertiary/50 text-[9px] text-text-secondary font-mono overflow-x-auto max-h-40 whitespace-pre-wrap break-all">{truncateText(safeJsonStringify(obs.output), 2000)}</pre>
        )}
      </div>
    </div>
  );
}
