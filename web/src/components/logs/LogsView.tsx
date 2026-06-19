import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  AlignJustify,
  Clock,
  Filter,
  Gauge,
  Hash,
  Loader2,
  MessageSquare,
  PauseCircle,
  PieChart as PieChartIcon,
  Radio,
  RefreshCw,
  Rows3,
  ScrollText,
  Search,
  TrendingUp,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { getServerToken } from '../../api/headers';

// ─── Types ────────────────────────────────────────────────
interface LogEntry {
  id: number;
  session_id: string;
  agent_id: string;
  agent_name: string;
  agent_role: string;
  task_id: string;
  event_type: string;
  content: string;
  token_usage?: Record<string, unknown>;
  timestamp: number;
}

type Level = 'error' | 'warning' | 'info';

// ─── Constants ────────────────────────────────────────────
const ERROR_EVENT_TYPES = new Set<string>([
  'error', 'agent_error', 'llm_error', 'graph_error',
  'leader:error', 'worker:error', 'workflow:node_failed',
]);

const WARNING_EVENT_TYPES = new Set<string>([
  'warning', 'warn', 'deprecation', 'retry', 'timeout', 'rate_limit',
]);

/** 中国风配色 — 青锋/朱砂/金箔 */
const eventTone: Record<string, { text: string; bg: string; border: string; hex: string }> = {
  error:         { text: 'text-accent-red',    bg: 'bg-accent-red/10',    border: 'border-accent-red/25',    hex: '#b94a3a' },
  tool_call:     { text: 'text-accent-green',  bg: 'bg-accent-green/10',  border: 'border-accent-green/25',  hex: '#487f75' },
  tool_result:   { text: 'text-accent-green',  bg: 'bg-accent-green/10',  border: 'border-accent-green/25',  hex: '#5a9b8f' },
  thinking:      { text: 'text-accent-blue',   bg: 'bg-accent-blue/10',   border: 'border-accent-blue/25',   hex: '#4f7488' },
  response:      { text: 'text-accent-brand',  bg: 'bg-accent-brand/10',  border: 'border-accent-brand/25',  hex: '#8a651f' },
  prompt:        { text: 'text-accent-yellow', bg: 'bg-accent-yellow/10', border: 'border-accent-yellow/25', hex: '#a77720' },
  completion:    { text: 'text-accent-green',  bg: 'bg-accent-green/10',  border: 'border-accent-green/25',  hex: '#3d6b62' },
  start:         { text: 'text-accent-purple', bg: 'bg-accent-purple/10', border: 'border-accent-purple/25', hex: '#7471c9' },
  stop:          { text: 'text-text-tertiary', bg: 'bg-bg-tertiary',      border: 'border-border-default',   hex: '#5d6b66' },
};

const FALLBACK_HEXES = ['#8a651f', '#487f75', '#4f7488', '#7471c9', '#a77720', '#b94a3a', '#c04482', '#5a9b8f'];

/** 热力图渐变 — 从青锋(低密度)到朱砂(高密度) */
const HEATMAP_STOPS = [
  { ratio: 0,    color: [79, 116, 136] },   // 青锋
  { ratio: 0.33, color: [72, 127, 117] },   // 绿
  { ratio: 0.66, color: [167, 119, 32] },   // 金箔
  { ratio: 1,    color: [185, 74, 58] },    // 朱砂
];

// ─── Helpers ──────────────────────────────────────────────
function formatTime(timestamp: number): string {
  const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(millis).toLocaleTimeString();
}

function tokenTotal(tokenUsage?: Record<string, unknown>): number {
  if (!tokenUsage) return 0;
  const preferred = tokenUsage.total ?? tokenUsage.total_tokens;
  if (typeof preferred === 'number') return preferred;
  return Object.values(tokenUsage).reduce<number>((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function classifyLevel(eventType: string): Level {
  const lower = eventType.toLowerCase();
  if (ERROR_EVENT_TYPES.has(lower)) return 'error';
  if (WARNING_EVENT_TYPES.has(lower)) return 'warning';
  return 'info';
}

function getEventHex(type: string, index: number): string {
  return eventTone[type]?.hex ?? FALLBACK_HEXES[index % FALLBACK_HEXES.length];
}

function getEventTone(type: string) {
  return eventTone[type] ?? { text: 'text-text-secondary', bg: 'bg-bg-tertiary', border: 'border-border-default', hex: '#5d6b66' };
}

function interpolateHeat(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  for (let i = 0; i < HEATMAP_STOPS.length - 1; i++) {
    const a = HEATMAP_STOPS[i];
    const b = HEATMAP_STOPS[i + 1];
    if (clamped >= a.ratio && clamped <= b.ratio) {
      const t = (clamped - a.ratio) / (b.ratio - a.ratio);
      const r = Math.round(a.color[0] + (b.color[0] - a.color[0]) * t);
      const g = Math.round(a.color[1] + (b.color[1] - a.color[1]) * t);
      const bl = Math.round(a.color[2] + (b.color[2] - a.color[2]) * t);
      return `rgb(${r},${g},${bl})`;
    }
  }
  return `rgb(${HEATMAP_STOPS[HEATMAP_STOPS.length - 1].color.join(',')})`;
}

/** Build 1-minute buckets from logs */
function buildHeatmapBuckets(logs: LogEntry[]): { bucket: number; count: number; label: string }[] {
  if (logs.length === 0) return [];
  const min = Math.min(...logs.map((l) => l.timestamp));
  const max = Math.max(...logs.map((l) => l.timestamp));
  const span = max - min;
  if (span <= 0) return [{ bucket: 0, count: logs.length, label: 'now' }];

  const bucketMs = 60_000;
  const bucketCount = Math.min(Math.max(Math.ceil(span / bucketMs), 1), 60);
  const actualSpan = span > bucketCount * bucketMs ? span : bucketCount * bucketMs;
  const buckets = new Array(bucketCount).fill(0).map((_, i) => ({ bucket: i, count: 0, label: '' }));

  for (const log of logs) {
    const idx = Math.min(Math.floor(((log.timestamp - min) / actualSpan) * bucketCount), bucketCount - 1);
    buckets[idx].count++;
  }

  for (let i = 0; i < bucketCount; i++) {
    const t = min + (actualSpan / bucketCount) * (i + 0.5);
    const millis = t > 1_000_000_000_000 ? t : t * 1000;
    buckets[i].label = new Date(millis).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return buckets;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path.startsWith('/api/') ? path : `/api/v1${path}`, {
    headers: { 'x-lingxiao-token': getServerToken() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// ─── Donut Chart (事件分布环形图) ─────────────────────────
function DonutChart({ data }: { data: { type: string; count: number; hex: string }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const r = 52;
  const strokeW = 20;
  const circumference = 2 * Math.PI * r;

  if (total === 0) {
    return (
      <div className="flex h-[140px] items-center justify-center text-xs text-text-tertiary">
        No data
      </div>
    );
  }

  let offset = 0;
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-border-muted)" strokeWidth={strokeW} />
        {data.map((d) => {
          const fraction = d.count / total;
          const dashLen = fraction * circumference;
          const dashGap = circumference - dashLen;
          const dashArray = `${dashLen} ${dashGap}`;
          const dashOffset = -offset * circumference;
          const seg = (
            <circle
              key={d.type}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={d.hex}
              strokeWidth={strokeW}
              strokeDasharray={dashArray}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: 'stroke-dasharray 300ms ease, stroke-dashoffset 300ms ease' }}
            >
              <title>{`${d.type}: ${d.count} (${(fraction * 100).toFixed(1)}%)`}</title>
            </circle>
          );
          offset += fraction;
          return seg;
        })}
        <text x={cx} y={cy - 6} textAnchor="middle" className="fill-text-primary" style={{ fontSize: 22, fontWeight: 700 }}>
          {formatCompact(total)}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-text-tertiary" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          TOTAL
        </text>
      </svg>
      <div className="min-w-0 flex-1 space-y-1">
        {data.slice(0, 7).map((d) => {
          const pct = ((d.count / total) * 100).toFixed(1);
          return (
            <div key={d.type} className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: d.hex }} />
              <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">{d.type}</span>
              <span className="shrink-0 font-mono text-text-tertiary">{d.count}</span>
              <span className="shrink-0 w-10 text-right font-mono text-text-muted">{pct}%</span>
            </div>
          );
        })}
        {data.length > 7 && (
          <div className="text-[10px] text-text-muted">+{data.length - 7} more</div>
        )}
      </div>
    </div>
  );
}

// ─── Heatmap (时间线热力图) ────────────────────────────────
function Heatmap({ buckets }: { buckets: { bucket: number; count: number; label: string }[] }) {
  if (buckets.length === 0) return null;
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const barW = 8;
  const gap = 2;
  const chartH = 48;
  const totalW = buckets.length * (barW + gap) - gap;
  const showLabels = buckets.length <= 30;

  return (
    <div className="w-full overflow-x-auto">
      <svg width={Math.max(totalW, 100)} height={chartH + (showLabels ? 14 : 0)} className="block">
        {buckets.map((b, i) => {
          const ratio = b.count / maxCount;
          const h = Math.max(b.count > 0 ? 4 : 2, ratio * chartH);
          const x = i * (barW + gap);
          const y = chartH - h;
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={2}
                fill={b.count === 0 ? 'var(--color-border-muted)' : interpolateHeat(ratio)}
                opacity={b.count === 0 ? 0.4 : 0.6 + ratio * 0.4}
              >
                <title>{`${b.label} — ${b.count} events`}</title>
              </rect>
              {showLabels && i % Math.max(1, Math.ceil(buckets.length / 8)) === 0 && (
                <text x={x + barW / 2} y={chartH + 11} textAnchor="middle" className="fill-text-tertiary" style={{ fontSize: 8 }}>
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Agent Bar Chart (Agent 活跃度排行) ─────────────────────
function AgentBarChart({ data }: { data: { name: string; count: number; role: string }[] }) {
  if (data.length === 0) return null;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="space-y-1.5">
      {data.slice(0, 8).map((d, i) => {
        const pct = (d.count / maxCount) * 100;
        const barHex = FALLBACK_HEXES[i % FALLBACK_HEXES.length];
        return (
          <div key={d.name} className="group">
            <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate font-mono text-text-secondary" title={d.name}>{d.name}</span>
              <span className="shrink-0 font-mono text-text-tertiary">{d.count}</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-sm bg-bg-tertiary">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${pct}%`,
                  backgroundColor: barHex,
                  transition: 'width 300ms ease',
                }}
              />
            </div>
            {d.role && (
              <div className="mt-0.5 truncate text-[9px] uppercase tracking-wider text-text-muted">{d.role}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Level Stats (日志级别统计) ────────────────────────────
function LevelStats({ errorCount, warningCount, infoCount }: { errorCount: number; warningCount: number; infoCount: number }) {
  const items: { label: string; count: number; hex: string; bg: string; text: string }[] = [
    { label: 'ERROR', count: errorCount,   hex: '#b94a3a', bg: 'bg-accent-red/10',    text: 'text-accent-red' },
    { label: 'WARN',  count: warningCount, hex: '#a77720', bg: 'bg-accent-yellow/10', text: 'text-accent-yellow' },
    { label: 'INFO',  count: infoCount,    hex: '#4f7488', bg: 'bg-accent-blue/10',   text: 'text-accent-blue' },
  ];
  return (
    <div className="flex items-center gap-2">
      {items.map((item) => (
        <div key={item.label} className={`flex-1 rounded border border-border-muted ${item.bg} px-2 py-1.5 text-center`}>
          <div className={`font-mono text-base font-bold ${item.text}`}>{formatCompact(item.count)}</div>
          <div className="text-[9px] uppercase tracking-wider text-text-muted">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── StatTile ─────────────────────────────────────────────
function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'text-text-primary',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border-muted bg-bg-primary/55 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-tertiary">
        <Icon className="h-3 w-3" />
        <span className="truncate">{label}</span>
      </div>
      <div className={`truncate font-mono text-base font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

// ─── Chart Card wrapper ───────────────────────────────────
function ChartCard({
  icon: Icon,
  title,
  children,
  className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-border-muted bg-bg-secondary/60 p-3 ${className}`}>
      <div className="mb-2.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        <Icon className="h-3 w-3" />
        {title}
      </div>
      {children}
    </div>
  );
}

// ─── i18n fallback hook ───────────────────────────────────
function useT() {
  const { t } = useTranslation();
  return (key: string, fallback: string) => {
    const val = t(key);
    return val === key ? fallback : val;
  };
}
// ─── Main Component ───────────────────────────────────────
export default function LogsView() {
  const { t } = useTranslation();
  const tt = useT();
  const currentSessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(currentSessionId);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [agentFilter, setAgentFilter] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const [compactMode, setCompactMode] = useState(false);
  const selectedSessionRef = useRef<string | null>(selectedSessionId);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    setSelectedSessionId(currentSessionId || null);
    selectedSessionRef.current = currentSessionId || null;
    setLogs([]);
    setError(null);
    setSearch('');
    setAgentFilter('');
    setEventFilter('');
    setIsLoading(Boolean(currentSessionId));
  }, [currentSessionId]);

  const fetchLogs = useCallback(async () => {
    const requestSessionId = selectedSessionId;
    if (!requestSessionId) return;
    setIsLoading(true);
    try {
      let url = `/api/sessions/${encodeURIComponent(requestSessionId)}/logs`;
      const params: string[] = [];
      if (agentFilter) params.push(`agent_id=${encodeURIComponent(agentFilter)}`);
      if (params.length > 0) url += `?${params.join('&')}`;
      const data = await apiFetch<LogEntry[]>(url);
      if (selectedSessionRef.current !== requestSessionId) return;
      setLogs(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      if (selectedSessionRef.current !== requestSessionId) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      if (selectedSessionRef.current === requestSessionId) setIsLoading(false);
    }
  }, [selectedSessionId, agentFilter]);

  useEffect(() => {
    fetchLogs();
    if (autoRefresh && selectedSessionId) {
      const interval = setInterval(fetchLogs, 5000);
      return () => clearInterval(interval);
    }
  }, [fetchLogs, autoRefresh, selectedSessionId]);

  // ─── Derived data ────────────────────────────────────
  const agentOptions = useMemo(() => {
    const byId = new Map<string, { name: string; role: string }>();
    for (const log of logs) {
      if (log.agent_id) byId.set(log.agent_id, { name: log.agent_name || log.agent_id, role: log.agent_role || '' });
    }
    return [...byId.entries()].map(([id, v]) => ({ id, name: v.name, role: v.role }));
  }, [logs]);

  const eventTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of logs) {
      const type = log.event_type || 'info';
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [logs]);

  const donutData = useMemo(() =>
    eventTypes.map(([type, count], i) => ({ type, count, hex: getEventHex(type, i) })),
  [eventTypes]);

  const agentActivity = useMemo(() => {
    const counts = new Map<string, { name: string; count: number; role: string }>();
    for (const log of logs) {
      const key = log.agent_name || log.agent_id || 'unknown';
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { name: key, count: 1, role: log.agent_role || '' });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [logs]);

  const levelStats = useMemo(() => {
    let error = 0, warning = 0, info = 0;
    for (const log of logs) {
      const level = classifyLevel(log.event_type || 'info');
      if (level === 'error') error++;
      else if (level === 'warning') warning++;
      else info++;
    }
    return { error, warning, info };
  }, [logs]);

  const heatmapBuckets = useMemo(() => buildHeatmapBuckets(logs), [logs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((log) => {
      if (eventFilter && (log.event_type || 'info') !== eventFilter) return false;
      if (!q) return true;
      const haystack = [log.content, log.agent_name, log.agent_id, log.agent_role, log.task_id, log.event_type]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [eventFilter, logs, search]);

  const MAX_LOG_RENDER_ROWS = 1000;
  const windowedLogs = filtered.length > MAX_LOG_RENDER_ROWS ? filtered.slice(-MAX_LOG_RENDER_ROWS) : filtered;

  const stats = useMemo(() => {
    const tokenCount = logs.reduce((sum, log) => sum + tokenTotal(log.token_usage), 0);
    return {
      total: logs.length,
      errors: levelStats.error,
      warnings: levelStats.warning,
      agents: agentOptions.length,
      events: eventTypes.length,
      tokens: tokenCount,
    };
  }, [agentOptions.length, eventTypes.length, levelStats, logs]);

  const clearFilters = () => {
    setSearch('');
    setAgentFilter('');
    setEventFilter('');
  };

  if (!currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        <p>{t('app.connecting')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      {/* ─── Header ─── */}
      <div className="shrink-0 border-b border-border-default bg-bg-secondary/95 px-4 py-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <ScrollText className="h-4 w-4 text-accent-blue" />
            {t('logs.title')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded border px-2.5 text-xs transition-colors ${
                autoRefresh
                  ? 'border-accent-green/30 bg-accent-green/10 text-accent-green'
                  : 'border-border-default text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {autoRefresh ? <Radio className="h-3.5 w-3.5" /> : <PauseCircle className="h-3.5 w-3.5" />}
              {autoRefresh ? t('logs.live') : t('logs.pause')}
            </button>
            <button
              type="button"
              onClick={() => setCompactMode((v) => !v)}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded border px-2.5 text-xs transition-colors ${
                compactMode
                  ? 'border-accent-brand/30 bg-accent-brand/10 text-accent-brand'
                  : 'border-border-default text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
              }`}
              title={tt('logs.compact', '紧凑模式')}
            >
              {compactMode ? <AlignJustify className="h-3.5 w-3.5" /> : <Rows3 className="h-3.5 w-3.5" />}
              {tt('logs.compact', '紧凑')}
            </button>
            <button
              type="button"
              onClick={fetchLogs}
              disabled={isLoading}
              className="inline-flex min-h-8 items-center gap-1.5 rounded border border-border-default px-2.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              title={t('logs.refresh')}
            >
              {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t('logs.refresh')}
            </button>
          </div>
        </div>

        {/* ─── Stat tiles ─── */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <StatTile icon={Hash} label={t('logs.total')} value={stats.total} />
          <StatTile icon={AlertTriangle} label={t('logs.errors')} value={stats.errors} tone={stats.errors > 0 ? 'text-accent-red' : 'text-text-primary'} />
          <StatTile icon={Users} label={t('logs.agents')} value={stats.agents} />
          <StatTile icon={Activity} label={t('logs.events')} value={stats.events} />
          <StatTile icon={Clock} label={t('logs.tokens')} value={formatCompact(stats.tokens)} tone="text-accent-yellow" />
        </div>

        {/* ─── Visualization row ─── */}
        {logs.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-3">
            <ChartCard icon={PieChartIcon} title={tt('logs.distribution', '事件分布')}>
              <DonutChart data={donutData} />
            </ChartCard>
            <ChartCard icon={TrendingUp} title={tt('logs.agentActivity', 'Agent 活跃度')}>
              <AgentBarChart data={agentActivity} />
            </ChartCard>
            <div className="space-y-2">
              <ChartCard icon={Gauge} title={tt('logs.levelStats', '日志级别')}>
                <LevelStats errorCount={levelStats.error} warningCount={levelStats.warning} infoCount={levelStats.info} />
              </ChartCard>
              <ChartCard icon={Zap} title={tt('logs.heatmap', '时间线热力')}>
                <Heatmap buckets={heatmapBuckets} />
              </ChartCard>
            </div>
          </div>
        )}

        {/* ─── Filters ─── */}
        <div className="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-[minmax(12rem,22rem)_minmax(14rem,1fr)_12rem_auto]">
          <label className="flex min-w-0 items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            <select
              className="min-h-8 w-full min-w-0 rounded border border-border-input bg-bg-input px-2 py-1.5 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
              value={selectedSessionId || ''}
              onChange={(e) => {
                setSelectedSessionId(e.target.value);
                setLogs([]);
                setError(null);
                setAgentFilter('');
                setEventFilter('');
              }}
              aria-label={t('logs.session')}
            >
              {sessions.length === 0 && <option value="">{t('chat.noSessions')}</option>}
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name || session.id.slice(0, 8)}{session.isActive ? ` (${t('history.current')})` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="relative min-w-0">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('logs.search')}
              className="min-h-8 w-full rounded border border-border-input bg-bg-input py-1.5 pl-7 pr-2 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
            />
          </div>

          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="min-h-8 rounded border border-border-input bg-bg-input px-2 py-1.5 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
          >
            <option value="">{t('logs.allAgents')}</option>
            {agentOptions.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>

          {(search || agentFilter || eventFilter) && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex min-h-8 items-center justify-center gap-1 rounded border border-border-default px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
              {t('logs.clear')}
            </button>
          )}
        </div>

        {/* ─── Event type pills ─── */}
        <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <Filter className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          <button
            type="button"
            onClick={() => setEventFilter('')}
            className={`shrink-0 rounded border px-2 py-1 text-[11px] transition-colors ${
              !eventFilter
                ? 'border-accent-brand/30 bg-accent-brand/10 text-accent-brand'
                : 'border-border-default text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
            }`}
          >
            {t('logs.allEvents')}
          </button>
          {eventTypes.map(([type, count]) => {
            const tone = getEventTone(type);
            const selected = eventFilter === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => setEventFilter(selected ? '' : type)}
                className={`shrink-0 rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                  selected ? `${tone.border} ${tone.bg} ${tone.text}` : 'border-border-default text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
                }`}
              >
                {type} <span className="opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Error banner ─── */}
      {error && (
        <div className="flex items-center gap-2 bg-accent-red/10 px-4 py-2 text-sm text-accent-red">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ─── Log list ─── */}
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {isLoading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-accent-brand" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <ScrollText className="mb-2 h-8 w-8 opacity-50" />
            <p className="text-sm">{logs.length === 0 ? t('logs.empty') : t('logs.noMatch')}</p>
          </div>
        ) : (
          windowedLogs.map((log, index) => {
            const type = log.event_type || 'info';
            const tone = getEventTone(type);
            const tokens = tokenTotal(log.token_usage);
            const level = classifyLevel(type);
            const levelDot = level === 'error' ? 'bg-accent-red' : level === 'warning' ? 'bg-accent-yellow' : 'bg-accent-blue';
            return (
              <div
                key={log.id || `${log.timestamp}-${index}`}
                className={`grid items-start gap-2 border-b border-border-default/50 hover:bg-bg-hover ${
                  compactMode
                    ? 'grid-cols-[4.5rem_6rem_minmax(0,1fr)_auto] px-3 py-1 md:grid-cols-[5rem_7rem_8rem_minmax(0,1fr)_auto]'
                    : 'grid-cols-[5.5rem_7.5rem_minmax(0,1fr)_auto] px-4 py-2 md:grid-cols-[6rem_8.5rem_10rem_minmax(0,1fr)_auto]'
                }`}
              >
                <span className={`whitespace-nowrap text-text-tertiary/75 ${compactMode ? 'text-[10px]' : ''}`}>{formatTime(log.timestamp)}</span>
                <span className={`flex items-center gap-1`}> {/* eslint-disable-line */}
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${levelDot}`} title={level} />
                  <span className={`min-w-0 truncate rounded border px-1.5 py-0.5 text-[10px] uppercase ${tone.text} ${tone.bg} ${tone.border}`} title={type}>
                    {type}
                  </span>
                </span>
                <span className="hidden min-w-0 truncate text-accent-brand md:block" title={log.agent_id || log.agent_name}>
                  {log.agent_name || log.agent_id || '-'}
                </span>
                <span className={`min-w-0 whitespace-pre-wrap break-words leading-relaxed text-text-primary ${compactMode ? 'truncate' : ''}`}>
                  {log.content?.length > (compactMode ? 200 : 900) ? `${log.content.slice(0, compactMode ? 200 : 900)}...` : log.content}
                </span>
                {tokens > 0 && (
                  <span className="shrink-0 rounded bg-accent-yellow/10 px-1.5 py-0.5 text-[10px] text-accent-yellow" title={JSON.stringify(log.token_usage)}>
                    {formatCompact(tokens)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
