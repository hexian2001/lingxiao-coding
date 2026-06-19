/**
 * MetricsView — 实时系统指标监控高级可视化
 *
 * 功能：
 *  - CPU/内存/磁盘 mini sparkline（保留最近 60 采样点）
 *  - CPU 使用率大号环形进度仪表
 *  - 多指标卡片
 *  - 进程实例表格
 *  - 5s 自动刷新，可暂停
 *  - 中国风强调色：青锋 #5FE0C7 / 朱砂 #E5484D / 金箔 #C9A86A
 */

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cpu, MemoryStick, HardDrive, RefreshCw, Loader2,
  AlertTriangle, Pause, Play, Clock, Server, Gauge,
  Activity,
} from 'lucide-react';
import { getServerToken } from '../../api/headers';

// ─── Types ──────────────────────────────────────────────

type MetricInstanceDto = Record<string, unknown>;

interface Metrics {
  ts?: number;
  cpuCount: number;
  cpuUsedPct: number;
  memTotalMib: number;
  memUsedMib: number;
  diskUsed: number;
  diskTotal: number;
  instances?: MetricInstanceDto[];
  runtime?: Record<string, number>;
}

interface HistoryPoint {
  cpu: number;
  mem: number;
  disk: number;
  ts: number;
}

// ─── Constants ──────────────────────────────────────────

const MAX_HISTORY = 60;
const POLL_INTERVAL = 5000;

// 中国风强调色
const COLOR_CINNABAR = '#E5484D'; // 朱砂 — CPU
const COLOR_JADE = '#5FE0C7'; // 青锋 — 内存
const COLOR_GOLD = '#C9A86A'; // 金箔 — 磁盘

// ─── API ────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: { 'x-lingxiao-token': getServerToken() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Utility ────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function formatBytes(mib: number): string {
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`;
  return `${mib.toFixed(0)} MiB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Sparkline (mini 折线图) ────────────────────────────

interface SparklineProps {
  data: number[];
  color: string;
  height?: number;
  width?: number;
  gradientId: string;
}

function Sparkline({ data, color, height = 40, width = 120, gradientId }: SparklineProps) {
  if (data.length === 0) {
    return (
      <svg width={width} height={height} className="opacity-30">
        <line
          x1={0} y1={height / 2} x2={width} y2={height / 2}
          stroke={color} strokeWidth={1} strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const max = 100; // 百分比固定 0-100
  const stepX = data.length > 1 ? width / (MAX_HISTORY - 1) : 0;
  const pad = 2;
  const usableH = height - pad * 2;

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + usableH - (clamp(v, 0, max) / max) * usableH;
    return [x, y] as const;
  });

  // 路径
  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fillPath = points.length > 0
    ? `${linePath} L ${points[points.length - 1][0].toFixed(1)} ${height} L ${points[0][0].toFixed(1)} ${height} Z`
    : '';

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {fillPath && <path d={fillPath} fill={`url(#${gradientId})`} />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.length > 0 && (
        <circle
          cx={points[points.length - 1][0]}
          cy={points[points.length - 1][1]}
          r={2.5}
          fill={color}
        />
      )}
    </svg>
  );
}

// ─── CircularGauge (环形进度) ───────────────────────────

interface CircularGaugeProps {
  value: number; // 0-100
  size?: number;
  thickness?: number;
  gradientId: string;
  colorStart: string;
  colorEnd: string;
  label?: string;
  sublabel?: string;
}

function CircularGauge({
  value, size = 160, thickness = 12, gradientId,
  colorStart, colorEnd, label, sublabel,
}: CircularGaugeProps) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = clamp(value, 0, 100);
  const offset = circumference - (pct / 100) * circumference;
  const center = size / 2;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colorStart} />
            <stop offset="100%" stopColor={colorEnd} />
          </linearGradient>
        </defs>
        {/* 背景环 */}
        <circle
          cx={center} cy={center} r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={thickness}
          className="text-border-default opacity-30"
        />
        {/* 进度环 */}
        <circle
          cx={center} cy={center} r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {label && (
          <span className="text-3xl font-mono font-semibold text-text-primary tabular-nums">
            {label}
          </span>
        )}
        {sublabel && (
          <span className="text-xs text-text-tertiary uppercase tracking-wide mt-0.5">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── MetricCard (指标卡片容器) ──────────────────────────

interface MetricCardProps {
  icon: ReactNode;
  title: string;
  accentColor: string;
  children: ReactNode;
  className?: string;
}

function MetricCard({ icon, title, accentColor, children, className = '' }: MetricCardProps) {
  return (
    <div
      className={`bg-bg-secondary border border-border-default rounded-xl p-4 flex flex-col gap-3 ${className}`}
      style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: accentColor }}>{icon}</span>
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

// ─── StatItem (小号指标条) ──────────────────────────────

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className="text-sm font-mono text-text-primary tabular-nums">{value}</span>
    </div>
  );
}

// ─── ProgressBar (水平渐变进度条) ───────────────────────

function GradientBar({ pct, colorStart, colorEnd }: { pct: number; colorStart: string; colorEnd: string }) {
  return (
    <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${clamp(pct, 0, 100)}%`,
          background: `linear-gradient(90deg, ${colorStart}, ${colorEnd})`,
        }}
      />
    </div>
  );
}

// ─── InstanceTable (进程实例表格) ───────────────────────

function InstanceTable({ instances }: { instances: MetricInstanceDto[] }) {
  if (!instances || instances.length === 0) return null;

  // 从第一个实例提取列名
  const columns = Object.keys(instances[0]).slice(0, 6);

  return (
    <div className="bg-bg-secondary border border-border-default rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border-default flex items-center gap-2">
        <Server className="w-4 h-4 text-text-secondary" />
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Instances
        </span>
        <span className="ml-auto text-xs font-mono text-text-tertiary">{instances.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-muted">
              {columns.map(col => (
                <th key={col} className="px-3 py-2 text-left font-medium text-text-tertiary uppercase tracking-wide whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {instances.map((inst, i) => (
              <tr key={i} className="border-b border-border-muted last:border-0 hover:bg-bg-hover transition-colors">
                {columns.map(col => (
                  <td key={col} className="px-3 py-2 font-mono text-text-secondary whitespace-nowrap">
                    {String(inst[col] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────

export default function MetricsView() {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const historyRef = useRef<HistoryPoint[]>([]);
  const [, forceRender] = useState(0);

  const fetchMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      const resp = await apiFetch<{ data: Metrics }>('/metrics');
      const m = resp.data || null;
      setMetrics(m);
      setError(null);
      setLastUpdate(Date.now());

      // push history point
      if (m) {
        const memPct = m.memTotalMib > 0 ? (m.memUsedMib / m.memTotalMib) * 100 : 0;
        const diskPct = m.diskTotal > 0 ? (m.diskUsed / m.diskTotal) * 100 : 0;
        const point: HistoryPoint = {
          cpu: clamp(m.cpuUsedPct, 0, 100),
          mem: clamp(memPct, 0, 100),
          disk: clamp(diskPct, 0, 100),
          ts: m.ts ?? Math.floor(Date.now() / 1000),
        };
        const hist = [...historyRef.current, point];
        if (hist.length > MAX_HISTORY) hist.shift();
        historyRef.current = hist;
        forceRender(n => n + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metrics');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchMetrics, POLL_INTERVAL);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchMetrics, autoRefresh]);

  // ─── Derived values ──────────────────────────────────
  const history = historyRef.current;
  const cpuHistory = history.map(h => h.cpu);
  const memHistory = history.map(h => h.mem);
  const diskHistory = history.map(h => h.disk);

  const memPct = metrics && metrics.memTotalMib > 0
    ? (metrics.memUsedMib / metrics.memTotalMib) * 100 : 0;
  const diskPct = metrics && metrics.diskTotal > 0
    ? (metrics.diskUsed / metrics.diskTotal) * 100 : 0;
  const uptime = metrics?.runtime?.lingxiao_uptime_seconds ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* ─── Header ─── */}
      <div className="px-4 py-3 border-b border-border-default bg-bg-secondary flex items-center justify-between shrink-0">
        <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
          <Gauge className="w-4 h-4" style={{ color: COLOR_CINNABAR }} />
          {t('metrics.title')}
        </h2>
        <div className="flex items-center gap-2">
          {lastUpdate > 0 && (
            <span className="text-xs text-text-tertiary font-mono hidden sm:inline">
              {new Date(lastUpdate).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => setAutoRefresh(prev => !prev)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:bg-bg-hover transition-colors border border-border-muted"
          >
            {autoRefresh ? (
              <><Pause className="w-3 h-3" /> {t('metrics.current')}</>
            ) : (
              <><Play className="w-3 h-3" /> Auto</>
            )}
          </button>
          <button
            onClick={fetchMetrics}
            disabled={isLoading}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:bg-bg-hover transition-colors border border-border-muted disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            {t('metrics.refresh')}
          </button>
        </div>
      </div>

      {/* ─── Error ─── */}
      {error && (
        <div className="px-4 py-2 bg-error-bg border-b border-border-default flex items-center gap-2 text-sm text-accent-red">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="font-mono text-xs">{error}</span>
        </div>
      )}

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {metrics ? (
          <>
            {/* ── Row 1: CPU 环形仪表 + 核心信息 ── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* CPU 环形仪表 */}
              <MetricCard
                icon={<Cpu className="w-4 h-4" />}
                title={t('metrics.cpu')}
                accentColor={COLOR_CINNABAR}
                className="lg:col-span-1"
              >
                <div className="flex items-center justify-center py-2">
                  <CircularGauge
                    value={metrics.cpuUsedPct}
                    size={150}
                    thickness={10}
                    gradientId="gauge-cpu"
                    colorStart={COLOR_CINNABAR}
                    colorEnd={COLOR_GOLD}
                    label={`${metrics.cpuUsedPct.toFixed(1)}%`}
                    sublabel="Usage"
                  />
                </div>
                <div className="space-y-1.5">
                  <StatItem label={t('metrics.cores')} value={String(metrics.cpuCount)} />
                  <StatItem label={t('metrics.current')} value={`${metrics.cpuUsedPct.toFixed(1)}%`} />
                </div>
              </MetricCard>

              {/* CPU Sparkline + 系统信息 */}
              <MetricCard
                icon={<Activity className="w-4 h-4" />}
                title="CPU Trend"
                accentColor={COLOR_CINNABAR}
                className="lg:col-span-2"
              >
                <div className="flex items-center justify-between">
                  <Sparkline
                    data={cpuHistory}
                    color={COLOR_CINNABAR}
                    width={280}
                    height={50}
                    gradientId="spark-cpu"
                  />
                  <div className="text-right space-y-1">
                    <div className="text-2xl font-mono font-semibold text-text-primary tabular-nums">
                      {metrics.cpuUsedPct.toFixed(1)}<span className="text-sm text-text-tertiary">%</span>
                    </div>
                    <div className="text-xs text-text-tertiary uppercase tracking-wide">
                      {metrics.cpuCount} {t('metrics.cores')}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1 border-t border-border-muted">
                  <StatItem label={t('metrics.uptime')} value={formatUptime(uptime)} />
                  <StatItem label="Samples" value={`${cpuHistory.length}/${MAX_HISTORY}`} />
                </div>
              </MetricCard>
            </div>

            {/* ── Row 2: Memory + Disk 卡片 ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Memory */}
              <MetricCard
                icon={<MemoryStick className="w-4 h-4" />}
                title={t('metrics.memory')}
                accentColor={COLOR_JADE}
              >
                <div className="flex items-center justify-between">
                  <Sparkline
                    data={memHistory}
                    color={COLOR_JADE}
                    width={200}
                    height={40}
                    gradientId="spark-mem"
                  />
                  <div className="text-right">
                    <div className="text-2xl font-mono font-semibold text-text-primary tabular-nums">
                      {memPct.toFixed(1)}<span className="text-sm text-text-tertiary">%</span>
                    </div>
                  </div>
                </div>
                <GradientBar pct={memPct} colorStart={COLOR_JADE} colorEnd={COLOR_GOLD} />
                <div className="space-y-1.5">
                  <StatItem label="Used" value={formatBytes(metrics.memUsedMib)} />
                  <StatItem label="Total" value={formatBytes(metrics.memTotalMib)} />
                </div>
              </MetricCard>

              {/* Disk */}
              <MetricCard
                icon={<HardDrive className="w-4 h-4" />}
                title={t('metrics.disk')}
                accentColor={COLOR_GOLD}
              >
                <div className="flex items-center justify-between">
                  <Sparkline
                    data={diskHistory}
                    color={COLOR_GOLD}
                    width={200}
                    height={40}
                    gradientId="spark-disk"
                  />
                  <div className="text-right">
                    <div className="text-2xl font-mono font-semibold text-text-primary tabular-nums">
                      {diskPct.toFixed(1)}<span className="text-sm text-text-tertiary">%</span>
                    </div>
                  </div>
                </div>
                <GradientBar pct={diskPct} colorStart={COLOR_GOLD} colorEnd={COLOR_CINNABAR} />
                <div className="space-y-1.5">
                  <StatItem label="Used" value={formatBytes(metrics.diskUsed)} />
                  <StatItem label="Total" value={formatBytes(metrics.diskTotal)} />
                </div>
              </MetricCard>
            </div>

            {/* ── Row 3: 系统信息概览 ── */}
            <div className="bg-bg-secondary border border-border-default rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-text-secondary" />
                <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                  System Info
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatItem label={t('metrics.uptime')} value={formatUptime(uptime)} />
                <StatItem label={t('metrics.cores')} value={String(metrics.cpuCount)} />
                <StatItem label="Memory" value={formatBytes(metrics.memTotalMib)} />
                <StatItem label="Disk" value={formatBytes(metrics.diskTotal)} />
              </div>
            </div>

            {/* ── Row 4: 进程实例 ── */}
            {metrics.instances && metrics.instances.length > 0 && (
              <InstanceTable instances={metrics.instances} />
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-text-tertiary" />
            <span className="text-sm text-text-tertiary">{t('metrics.loading')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
