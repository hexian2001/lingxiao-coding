/**
 * StatsView — 会话使用统计 (V3 · 中国风可视化增强)
 *
 * 增强点：
 *   - SVG 手绘图表：环形图、饼图、sparkline、堆叠条形图、横向条形图、热力图
 *   - 中国风配色：青锋 #5FE0C7 / 朱砂 #E5484D / 金箔 #C9A86A
 *   - 渐变色填充、紧凑布局、font-mono 数字
 *
 * Tab 页：
 *   overview — 摘要 + 时间分布环形图 + token sparkline + 代码变更对比
 *   models   — 双色堆叠条形图 + 调用排行横向条形图
 *   agents   — token 甜甜圈图 + 活跃度热力图
 *   tools    — 调用排行条形图 + 红绿灯成功率
 *   cost     — 成本分布饼图 + 缓存命中率大环形图
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getServerToken } from '../../api/headers';
import {
  BarChart3, Brain, Wrench, Bot, RefreshCw,
  Loader2, AlertTriangle, Zap, Clock, CheckCircle2, XCircle,
  Activity, Timer, Hash, ArrowUpRight, ArrowDownRight, Database,
  Cpu, DollarSign,
} from 'lucide-react';
import { calculateCost, formatCost } from '../../utils/costCalculator';

// ── Types ─────────────────────────────────────────────────────────────

interface SessionOverview {
  totalSessions: number;
  totalMessages: number;
  wallTimeMs?: number;
  apiTimeMs?: number;
  toolTimeMs?: number;
  agentActiveMs?: number;
  totalToolCalls?: number;
  toolSuccessCount?: number;
  toolFailCount?: number;
  linesAdded?: number;
  linesDeleted?: number;
  promptCount?: number;
}

interface ModelStat {
  sessionId: string;
  name: string;
  callCount: number;
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
  cacheHitRate?: number;
  avgLatencyMs?: number;
  errorCount?: number;
}

interface ModelSummary {
  name: string;
  callCount: number;
  sessionCount: number;
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
}

interface AgentStat {
  agentId: string;
  agentName: string;
  modelName: string;
  callCount: number;
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
}

interface ToolStat {
  name: string;
  callCount: number;
  successCount: number;
  failCount: number;
  avgDurationMs: number;
  lastUsed: number;
}

interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  netInputTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheCreationCost: number;
  totalCost: number;
}

interface CostSummary {
  models: CostBreakdown[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCost: number;
  cacheHitRate: number;
  cacheSavings: number;
}

// ── 中国风配色常量 ────────────────────────────────────────────────────

const CN_COLORS = {
  jade: '#5FE0C7',       // 青锋
  jadeDeep: '#3BB5A0',
  vermilion: '#E5484D',  // 朱砂
  vermilionDeep: '#C93B3F',
  gold: '#C9A86A',       // 金箔
  goldDeep: '#B8923D',
  purple: '#9B7EC9',     // 紫 (prompt tokens)
  purpleDeep: '#7B5EAB',
  green: '#5FCE8A',      // 绿 (completion tokens)
  greenDeep: '#3BA86B',
  blue: '#5B9BD5',
  neutral: '#6B7B7E',
};

/** 渐变色定义 — 用于 SVG 填充 */
function gradientId(name: string): string {
  return `grad-${name}`;
}

// ── API & Format Utils ────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: { 'x-lingxiao-token': getServerToken() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── SVG 图表组件 ──────────────────────────────────────────────────────

/** SVG 渐变定义集合 — 放在图表父容器内 */
function ChartGradients() {
  const defs: { id: string; from: string; to: string }[] = [
    { id: 'jade', from: CN_COLORS.jade, to: CN_COLORS.jadeDeep },
    { id: 'vermilion', from: CN_COLORS.vermilion, to: CN_COLORS.vermilionDeep },
    { id: 'gold', from: CN_COLORS.gold, to: CN_COLORS.goldDeep },
    { id: 'purple', from: CN_COLORS.purple, to: CN_COLORS.purpleDeep },
    { id: 'green', from: CN_COLORS.green, to: CN_COLORS.greenDeep },
    { id: 'blue', from: CN_COLORS.blue, to: '#3A7AB5' },
  ];
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        {defs.map((d) => (
          <linearGradient key={d.id} id={gradientId(d.id)} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={d.from} />
            <stop offset="100%" stopColor={d.to} />
          </linearGradient>
        ))}
        {/* 用于 sparkline 的面积渐变 */}
        <linearGradient id="grad-spark-area" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={CN_COLORS.jade} stopOpacity="0.35" />
          <stop offset="100%" stopColor={CN_COLORS.jade} stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** 环形图 / 甜甜圈图 */
function DonutChart({
  segments,
  size = 160,
  thickness = 24,
  centerLabel,
  centerValue,
}: {
  segments: { label: string; value: number; gradId: string; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;

  let dashOffset = 0;
  const arcs = segments.map((seg) => {
    const fraction = total > 0 ? seg.value / total : 0;
    const dashLength = fraction * circumference;
    const arc = {
      ...seg,
      dashLength,
      dashOffset,
      fraction,
    };
    dashOffset -= dashLength;
    return arc;
  });

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="shrink-0">
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {/* 背景环 */}
          <circle cx={cx} cy={cy} r={radius} fill="none"
            stroke="currentColor" strokeWidth={thickness}
            className="text-bg-tertiary opacity-30" />
          {arcs.map((arc, i) => (
            <circle key={i} cx={cx} cy={cy} r={radius} fill="none"
              stroke={`url(#${gradientId(arc.gradId)})`}
              strokeWidth={thickness}
              strokeDasharray={`${arc.dashLength} ${circumference - arc.dashLength}`}
              strokeDashoffset={arc.dashOffset}
              strokeLinecap="butt" />
          ))}
        </g>
        {centerValue && (
          <text x={cx} y={cy - 2} textAnchor="middle" dominantBaseline="central"
            className="fill-text-primary font-mono" fontSize="18" fontWeight="700">
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x={cx} y={cy + 16} textAnchor="middle" dominantBaseline="central"
            className="fill-text-tertiary" fontSize="10">
            {centerLabel}
          </text>
        )}
      </svg>
      <div className="space-y-1.5">
        {segments.map((seg, i) => {
          const pct = total > 0 ? (seg.value / total * 100) : 0;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: seg.color }} />
              <span className="text-text-secondary truncate flex-1">{seg.label}</span>
              <span className="text-text-tertiary font-mono">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 饼图 — 实心扇形 */
function PieChart({
  segments,
  size = 180,
}: {
  segments: { label: string; value: number; gradId: string; color: string }[];
  size?: number;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;

  let startAngle = -Math.PI / 2;
  const slices = segments.map((seg) => {
    const fraction = total > 0 ? seg.value / total : 0;
    const angle = fraction * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    startAngle = endAngle;
    return { ...seg, path, fraction };
  });

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="shrink-0">
        {slices.map((slice, i) => (
          <path key={i} d={slice.path} fill={`url(#${gradientId(slice.gradId)})`}
            stroke="var(--color-bg-secondary)" strokeWidth="1.5" />
        ))}
        {/* 中心白色圆 */}
        <circle cx={cx} cy={cy} r={r * 0.38} fill="var(--color-bg-secondary)" />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          className="fill-text-primary font-mono" fontSize="14" fontWeight="700">
          {total > 0 ? formatTokens(total) : '0'}
        </text>
      </svg>
      <div className="space-y-1.5">
        {segments.map((seg, i) => {
          const pct = total > 0 ? (seg.value / total * 100) : 0;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: seg.color }} />
              <span className="text-text-secondary truncate flex-1 max-w-[100px]">{seg.label}</span>
              <span className="text-text-tertiary font-mono">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Sparkline — 趋势折线图 + 面积填充 */
function Sparkline({
  data,
  width = 240,
  height = 50,
  color = CN_COLORS.jade,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pad = 3;
  const innerH = height - pad * 2;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * step;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} className="w-full">
      <defs>
        <linearGradient id="spark-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#spark-grad)" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* 末点高亮 */}
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y}
        r="2.5" fill={color} />
    </svg>
  );
}

/** 堆叠条形图 — 双色 prompt + completion */
function StackedTokenBar({
  items,
  maxTotal,
}: {
  items: { name: string; prompt: number; completion: number }[];
  maxTotal: number;
}) {
  const max = maxTotal || 1;
  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const total = item.prompt + item.completion;
        const promptPct = (item.prompt / max) * 100;
        const compPct = (item.completion / max) * 100;
        return (
          <div key={item.name} className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-text-primary font-mono truncate flex-1">{item.name}</span>
              <span className="text-text-tertiary font-mono text-[10px]">
                <span style={{ color: CN_COLORS.purple }}>{formatTokens(item.prompt)}</span>
                <span className="mx-0.5">+</span>
                <span style={{ color: CN_COLORS.green }}>{formatTokens(item.completion)}</span>
                <span className="ml-1 text-text-secondary">= {formatTokens(total)}</span>
              </span>
            </div>
            <div className="flex h-3.5 rounded-sm overflow-hidden bg-bg-tertiary/40">
              <div className="h-full transition-all" style={{ width: `${promptPct}%`, background: `linear-gradient(90deg, ${CN_COLORS.purple}, ${CN_COLORS.purpleDeep})` }} />
              <div className="h-full transition-all" style={{ width: `${compPct}%`, background: `linear-gradient(90deg, ${CN_COLORS.green}, ${CN_COLORS.greenDeep})` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 横向条形图 — 排行 */
function HBarChart({
  items,
  maxVal,
  barColor = CN_COLORS.jade,
  barColorDeep = CN_COLORS.jadeDeep,
  unit = '',
}: {
  items: { label: string; value: number; sub?: string }[];
  maxVal: number;
  barColor?: string;
  barColorDeep?: string;
  unit?: string;
}) {
  const max = maxVal || 1;
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const pct = (item.value / max) * 100;
        return (
          <div key={i} className="flex items-center gap-2 group">
            <span className="text-text-secondary font-mono text-xs truncate w-28 shrink-0 text-right">{item.label}</span>
            <div className="flex-1 relative h-5 rounded-sm bg-bg-tertiary/30 overflow-hidden">
              <div className="h-full rounded-sm transition-all flex items-center justify-end pr-1.5"
                style={{ width: `${Math.max(pct, 2)}%`, background: `linear-gradient(90deg, ${barColor}, ${barColorDeep})` }}>
                {pct > 15 && (
                  <span className="text-[10px] font-mono text-white/90">{item.value.toLocaleString()}{unit}</span>
                )}
              </div>
              {pct <= 15 && (
                <span className="absolute right-1.5 top-0 bottom-0 flex items-center text-[10px] font-mono text-text-secondary">
                  {item.value.toLocaleString()}{unit}
                </span>
              )}
            </div>
            {item.sub && <span className="text-text-tertiary text-[10px] w-16 shrink-0">{item.sub}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** 热力图网格 — agent × model 活跃度 */
function HeatmapGrid({
  rows,
  cols,
  data,
}: {
  rows: string[];
  cols: string[];
  data: Record<string, Record<string, number>>;
}) {
  const maxVal = Math.max(1, ...rows.flatMap((r) => cols.map((c) => data[r]?.[c] ?? 0)));

  function heatColor(val: number): string {
    if (val === 0) return 'rgba(107,123,126,0.08)';
    const ratio = val / maxVal;
    if (ratio > 0.75) return CN_COLORS.vermilion;
    if (ratio > 0.5) return CN_COLORS.gold;
    if (ratio > 0.25) return CN_COLORS.jade;
    return `${CN_COLORS.jadeDeep}55`;
  }

  const cellSize = 36;
  const labelW = 80;
  const labelH = 20;

  return (
    <div className="overflow-x-auto">
      <svg width={labelW + cols.length * cellSize + 4} height={labelH + rows.length * cellSize + 4}>
        {/* 列标签 */}
        {cols.map((col, ci) => (
          <text key={ci} x={labelW + ci * cellSize + cellSize / 2} y={labelH - 4}
            textAnchor="middle" className="fill-text-tertiary" fontSize="9">
            {col.length > 8 ? col.slice(0, 7) + '…' : col}
          </text>
        ))}
        {/* 行标签 + 单元格 */}
        {rows.map((row, ri) => (
          <g key={ri}>
            <text x={labelW - 4} y={labelH + ri * cellSize + cellSize / 2 + 3}
              textAnchor="end" className="fill-text-secondary" fontSize="9">
              {row.length > 12 ? row.slice(0, 11) + '…' : row}
            </text>
            {cols.map((col, ci) => {
              const val = data[row]?.[col] ?? 0;
              return (
                <g key={ci}>
                  <rect x={labelW + ci * cellSize + 1} y={labelH + ri * cellSize + 1}
                    width={cellSize - 2} height={cellSize - 2}
                    rx="3" fill={heatColor(val)} />
                  {val > 0 && (
                    <text x={labelW + ci * cellSize + cellSize / 2}
                      y={labelH + ri * cellSize + cellSize / 2 + 3}
                      textAnchor="middle" className="fill-text-primary font-mono" fontSize="9" fontWeight="600">
                      {val}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** 红绿灯指示器 — 成功率 */
function TrafficLight({ rate }: { rate: number }) {
  const color = rate >= 80 ? CN_COLORS.green : rate >= 50 ? CN_COLORS.gold : CN_COLORS.vermilion;
  return (
    <div className="flex items-center gap-1">
      <svg width="36" height="12">
        <circle cx="6" cy="6" r="4" fill={rate >= 80 ? color : 'currentColor'} className={rate >= 80 ? '' : 'text-bg-tertiary opacity-30'} />
        <circle cx="18" cy="6" r="4" fill={rate >= 50 && rate < 80 ? color : 'currentColor'} className={rate >= 50 && rate < 80 ? '' : 'text-bg-tertiary opacity-30'} />
        <circle cx="30" cy="6" r="4" fill={rate < 50 ? color : 'currentColor'} className={rate < 50 ? '' : 'text-bg-tertiary opacity-30'} />
      </svg>
      <span style={{ color }} className="font-mono text-xs font-medium">{rate.toFixed(0)}%</span>
    </div>
  );
}

// ── UI 组件 ───────────────────────────────────────────────────────────

/** 统计卡片 — 中国风：圆角边框 + 小号大写标题 + font-mono 数字 */
function StatCard({
  icon, label, value, sub, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="bg-bg-secondary border border-border-default rounded-lg p-3.5 hover:border-border-hover transition-colors">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={accent || 'text-accent-brand'}>{icon}</span>
        <span className="text-[10px] text-text-tertiary uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="text-xl font-mono font-semibold text-text-primary tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-text-tertiary mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

/** 区块标题 — 中国风小号大写 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-text-tertiary uppercase tracking-widest mb-3 flex items-center gap-2">
      <span className="w-1 h-3 rounded-sm" style={{ background: `linear-gradient(180deg, ${CN_COLORS.jade}, ${CN_COLORS.jadeDeep})` }} />
      {children}
    </h3>
  );
}

type TabKey = 'overview' | 'models' | 'agents' | 'tools' | 'cost';

// ── Tab Props 类型 ────────────────────────────────────────────────────

interface OverviewTabProps {
  overview: SessionOverview | null;
  totalModelCalls: number;
  totalModelTokens: number;
  successRate: number;
  apiTimePercent: number;
  toolTimePercent: number;
  idleTimePercent: number;
  wallTimeMs: number;
  apiTimeMs: number;
  toolTimeMs: number;
  tokenTrend: number[];
  modelSummary: ModelSummary[];
  t: (key: string) => string;
}

interface ModelsTabProps {
  modelSummary: ModelSummary[];
  totalModelTokens: number;
  totalModelCalls: number;
  t: (key: string) => string;
}

interface AgentsTabProps {
  agentStats: AgentStat[];
  aggregatedAgents: { name: string; totalTokens: number; modelName: string; callCount: number; totalPrompt: number; totalCompletion: number }[];
  totalAgentTokens: number;
  heatmapAgents: string[];
  heatmapModels: string[];
  heatmapData: Record<string, Record<string, number>>;
  t: (key: string) => string;
}

interface ToolsTabProps {
  toolStats: ToolStat[];
  t: (key: string) => string;
}

interface CostTabProps {
  costSummary: CostSummary | null;
  t: (key: string) => string;
}

// ── 主组件 ────────────────────────────────────────────────────────────

export default function StatsView() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const [modelStats, setModelStats] = useState<ModelStat[]>([]);
  const [modelSummary, setModelSummary] = useState<ModelSummary[]>([]);
  const [agentStats, setAgentStats] = useState<AgentStat[]>([]);
  const [toolStats, setToolStats] = useState<ToolStat[]>([]);
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const [overviewData, modelsData, modelSummaryData, agentsData, toolsData, costData] = await Promise.all([
        apiFetch<{ data: SessionOverview }>('/stats'),
        apiFetch<{ data: ModelStat[] }>('/stats/models'),
        apiFetch<{ data: ModelSummary[] }>('/stats/models/summary'),
        apiFetch<{ data: AgentStat[] }>('/stats/agents'),
        apiFetch<{ data: ToolStat[] }>('/stats/tools'),
        apiFetch<{ data: CostSummary }>('/stats/cost').catch(() => ({ data: null as unknown as CostSummary })),
      ]);
      setOverview(overviewData.data || null);
      setModelStats(modelsData.data || []);
      setModelSummary(modelSummaryData.data || []);
      setAgentStats(agentsData.data || []);
      setToolStats(toolsData.data || []);
      setCostSummary(costData.data || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch stats');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const tabs: { key: TabKey; icon: React.ReactNode; label: string }[] = [
    { key: 'overview', icon: <BarChart3 className="w-4 h-4" />, label: t('stats.tab.overview') },
    { key: 'models', icon: <Brain className="w-4 h-4" />, label: t('stats.tab.models') },
    { key: 'agents', icon: <Bot className="w-4 h-4" />, label: t('stats.tab.agents') || 'Agents' },
    { key: 'tools', icon: <Wrench className="w-4 h-4" />, label: t('stats.tab.tools') },
    { key: 'cost', icon: <DollarSign className="w-4 h-4" />, label: t('stats.tab.cost') || 'Cost' },
  ];

  // ── Derived stats ───────────────────────────────────────────────────
  const totalToolCalls = overview?.totalToolCalls ?? 0;
  const toolSuccessCount = overview?.toolSuccessCount ?? 0;
  const wallTimeMs = overview?.wallTimeMs ?? 0;
  const apiTimeMs = overview?.apiTimeMs ?? 0;
  const toolTimeMs = overview?.toolTimeMs ?? 0;
  const successRate = totalToolCalls > 0 ? ((toolSuccessCount / totalToolCalls) * 100) : 0;
  const apiTimePercent = wallTimeMs > 0 ? ((apiTimeMs / wallTimeMs) * 100) : 0;
  const toolTimePercent = wallTimeMs > 0 ? ((toolTimeMs / wallTimeMs) * 100) : 0;
  const idleTimePercent = Math.max(0, 100 - apiTimePercent - toolTimePercent);
  const totalModelTokens = modelSummary.reduce((s, m) => s + m.totalTokens, 0);
  const totalModelCalls = modelSummary.reduce((s, m) => s + m.callCount, 0);
  const totalAgentTokens = agentStats.reduce((s, a) => s + a.totalTokens, 0);

  // Sparkline 数据：按 modelStats 的 sessionId 聚合 token 趋势
  const tokenTrend = useMemo(() => {
    const sessionMap = new Map<string, number>();
    for (const ms of modelStats) {
      sessionMap.set(ms.sessionId, (sessionMap.get(ms.sessionId) ?? 0) + ms.totalTokens);
    }
    return Array.from(sessionMap.values());
  }, [modelStats]);

  // Agent 聚合
  const aggregatedAgents = useMemo(() => {
    const m = new Map<string, { totalTokens: number; modelName: string; callCount: number; totalPrompt: number; totalCompletion: number }>();
    for (const a of agentStats) {
      const key = a.agentName || a.agentId;
      const ex = m.get(key);
      if (ex) {
        ex.totalTokens += a.totalTokens;
        ex.callCount += a.callCount;
        ex.totalPrompt += a.totalPrompt;
        ex.totalCompletion += a.totalCompletion;
      } else {
        m.set(key, { totalTokens: a.totalTokens, modelName: a.modelName, callCount: a.callCount, totalPrompt: a.totalPrompt, totalCompletion: a.totalCompletion });
      }
    }
    return Array.from(m.entries()).map(([name, s]) => ({ name, ...s })).sort((a, b) => b.totalTokens - a.totalTokens);
  }, [agentStats]);

  // 热力图数据：agent × model
  const heatmapData = useMemo(() => {
    const d: Record<string, Record<string, number>> = {};
    for (const a of agentStats) {
      const agent = a.agentName || a.agentId;
      if (!d[agent]) d[agent] = {};
      d[agent][a.modelName] = (d[agent][a.modelName] ?? 0) + a.callCount;
    }
    return d;
  }, [agentStats]);

  const heatmapAgents = aggregatedAgents.slice(0, 8).map(a => a.name);
  const heatmapModels = useMemo(() => Array.from(new Set(agentStats.map(a => a.modelName))).slice(0, 8), [agentStats]);

  return (
    <div className="flex flex-col h-full">
      <ChartGradients />
      {/* Tab bar */}
      <div className="flex border-b border-border-default bg-bg-secondary shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-accent-brand text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={fetchStats} className="px-3 text-text-tertiary hover:text-text-secondary transition-colors">
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && !overview ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : activeTab === 'overview' ? (
          <OverviewTab
            overview={overview}
            totalModelCalls={totalModelCalls}
            totalModelTokens={totalModelTokens}
            successRate={successRate}
            apiTimePercent={apiTimePercent}
            toolTimePercent={toolTimePercent}
            idleTimePercent={idleTimePercent}
            wallTimeMs={wallTimeMs}
            apiTimeMs={apiTimeMs}
            toolTimeMs={toolTimeMs}
            tokenTrend={tokenTrend}
            modelSummary={modelSummary}
            t={t}
          />
        ) : activeTab === 'models' ? (
          <ModelsTab
            modelSummary={modelSummary}
            totalModelTokens={totalModelTokens}
            totalModelCalls={totalModelCalls}
            t={t}
          />
        ) : activeTab === 'agents' ? (
          <AgentsTab
            agentStats={agentStats}
            aggregatedAgents={aggregatedAgents}
            totalAgentTokens={totalAgentTokens}
            heatmapAgents={heatmapAgents}
            heatmapModels={heatmapModels}
            heatmapData={heatmapData}
            t={t}
          />
        ) : activeTab === 'tools' ? (
          <ToolsTab toolStats={toolStats} t={t} />
        ) : (
          <CostTab costSummary={costSummary} t={t} />
        )}
      </div>
    </div>
  );
}

// ── Overview Tab ─────────────────────────────────────────────────────

function OverviewTab({
  overview, totalModelCalls, totalModelTokens, successRate,
  apiTimePercent, toolTimePercent, idleTimePercent,
  wallTimeMs, apiTimeMs, toolTimeMs, tokenTrend, modelSummary, t,
}: OverviewTabProps) {
  // 时间分布环形图数据
  const timeSegments = [
    { label: 'API', value: apiTimeMs, gradId: 'jade', color: CN_COLORS.jade },
    { label: 'Tools', value: toolTimeMs, gradId: 'gold', color: CN_COLORS.gold },
    { label: 'Idle', value: Math.max(0, wallTimeMs - apiTimeMs - toolTimeMs), gradId: 'neutral' as const, color: CN_COLORS.neutral },
  ].filter(s => s.value > 0);

  // 代码变更对比数据
  const linesAdded = overview?.linesAdded ?? 0;
  const linesDeleted = overview?.linesDeleted ?? 0;
  const totalChanges = linesAdded + linesDeleted;
  const addedPct = totalChanges > 0 ? (linesAdded / totalChanges * 100) : 0;
  const deletedPct = totalChanges > 0 ? (linesDeleted / totalChanges * 100) : 0;

  return (
    <div className="p-4 space-y-5">
      {/* Section: Interaction Summary */}
      <div>
        <SectionTitle>{t('stats.interactionSummary')}</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard icon={<Hash className="w-4 h-4" />} label={t('stats.totalSessions')} value={overview?.totalSessions || 0} sub={`${overview?.totalMessages || 0} ${t('stats.messages')}`} />
          <StatCard icon={<Activity className="w-4 h-4" />} label={t('stats.promptCount')} value={overview?.promptCount || 0} sub={`${totalModelCalls} API calls`} />
          <StatCard icon={<CheckCircle2 className="w-4 h-4" />} label={t('stats.toolSuccessRate')} value={`${successRate.toFixed(1)}%`} sub={`${overview?.toolSuccessCount || 0} / ${overview?.toolFailCount || 0}`} accent={successRate >= 80 ? 'text-accent-green' : successRate >= 50 ? 'text-accent-yellow' : 'text-accent-red'} />
          <StatCard icon={<Database className="w-4 h-4" />} label={t('stats.totalTokens')} value={formatTokens(totalModelTokens)} />
        </div>
      </div>

      {/* Section: Token Trend Sparkline + Time Distribution Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {tokenTrend.length >= 2 && (
          <div>
            <SectionTitle>Token 消耗趋势</SectionTitle>
            <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
              <Sparkline data={tokenTrend} width={300} height={60} color={CN_COLORS.jade} />
              <div className="flex justify-between mt-2 text-[10px] text-text-tertiary font-mono">
                <span>min: {formatTokens(Math.min(...tokenTrend))}</span>
                <span>max: {formatTokens(Math.max(...tokenTrend))}</span>
                <span>avg: {formatTokens(tokenTrend.reduce((a, b) => a + b, 0) / tokenTrend.length)}</span>
              </div>
            </div>
          </div>
        )}

        {wallTimeMs > 0 && timeSegments.length > 0 && (
          <div>
            <SectionTitle>时间分布</SectionTitle>
            <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
              <DonutChart
                segments={timeSegments}
                size={140}
                thickness={20}
                centerLabel="总耗时"
                centerValue={formatDuration(wallTimeMs)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Section: Performance */}
      <div>
        <SectionTitle>{t('stats.performance')}</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard icon={<Clock className="w-4 h-4" />} label={t('stats.session.wallTime')} value={formatDuration(wallTimeMs)} />
          <StatCard icon={<Zap className="w-4 h-4" />} label={t('stats.session.apiDuration')} value={formatDuration(apiTimeMs)} sub={`${apiTimePercent.toFixed(1)}%`} accent="text-accent-brand" />
          <StatCard icon={<Wrench className="w-4 h-4" />} label={t('stats.toolTime')} value={formatDuration(toolTimeMs)} sub={`${toolTimePercent.toFixed(1)}%`} accent="text-accent-yellow" />
          <StatCard icon={<Timer className="w-4 h-4" />} label={t('stats.agentActive')} value={formatDuration(overview?.agentActiveMs || 0)} />
        </div>
      </div>

      {/* Section: Code Changes — +/- 对比图 */}
      <div>
        <SectionTitle>{t('stats.codeChanges')}</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
          <div className="grid grid-cols-2 gap-4 mb-3">
            <StatCard icon={<ArrowUpRight className="w-4 h-4" />} label={t('stats.session.linesAdded')} value={`+${linesAdded.toLocaleString()}`} accent="text-accent-green" />
            <StatCard icon={<ArrowDownRight className="w-4 h-4" />} label={t('stats.session.linesDeleted')} value={`-${linesDeleted.toLocaleString()}`} accent="text-accent-red" />
          </div>
          {totalChanges > 0 && (
            <div className="space-y-1.5">
              <div className="flex h-4 rounded-sm overflow-hidden">
                <div className="h-full transition-all flex items-center justify-center" style={{ width: `${addedPct}%`, background: `linear-gradient(90deg, ${CN_COLORS.green}, ${CN_COLORS.greenDeep})` }}>
                  {addedPct > 10 && <span className="text-[10px] font-mono text-white/90">+{formatNumber(linesAdded)}</span>}
                </div>
                <div className="h-full transition-all flex items-center justify-center" style={{ width: `${deletedPct}%`, background: `linear-gradient(90deg, ${CN_COLORS.vermilion}, ${CN_COLORS.vermilionDeep})` }}>
                  {deletedPct > 10 && <span className="text-[10px] font-mono text-white/90">-{formatNumber(linesDeleted)}</span>}
                </div>
              </div>
              <div className="flex justify-between text-[10px] text-text-tertiary font-mono">
                <span style={{ color: CN_COLORS.green }}>新增 {addedPct.toFixed(1)}%</span>
                <span style={{ color: CN_COLORS.vermilion }}>删除 {deletedPct.toFixed(1)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section: Model Consumption Summary */}
      {modelSummary.length > 0 && (
        <div>
          <SectionTitle>{t('stats.modelTokenConsumption')}</SectionTitle>
          <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
            <StackedTokenBar
              items={modelSummary.slice(0, 8).map(m => ({ name: m.name, prompt: m.totalPrompt, completion: m.totalCompletion }))}
              maxTotal={Math.max(...modelSummary.map(m => m.totalTokens), 1)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Models Tab ────────────────────────────────────────────────────────

function ModelsTab({ modelSummary, totalModelTokens, totalModelCalls, t }: ModelsTabProps) {
  if (modelSummary.length === 0) {
    return (
      <div className="text-center text-text-tertiary py-12">
        <Brain className="w-10 h-10 text-text-tertiary/30 mx-auto mb-3" />
        <p className="text-sm">{t('stats.noModelData')}</p>
      </div>
    );
  }

  const maxTokens = Math.max(...modelSummary.map(m => m.totalTokens), 1);
  const maxCalls = Math.max(...modelSummary.map(m => m.callCount), 1);

  return (
    <div className="p-4 space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon={<Brain className="w-4 h-4" />} label={t('stats.tab.models')} value={modelSummary.length} />
        <StatCard icon={<Activity className="w-4 h-4" />} label={t('stats.totalCalls')} value={totalModelCalls} />
        <StatCard icon={<Database className="w-4 h-4" />} label={t('stats.totalTokens')} value={formatTokens(totalModelTokens)} />
        <StatCard icon={<DollarSign className="w-4 h-4" />} label={t('stats.totalCost')} value={formatCost(modelSummary.reduce((s, m) => s + calculateCost(m.name, { prompt: m.totalPrompt, completion: m.totalCompletion }), 0))} />
      </div>

      {/* Token 分布 — 双色堆叠条形图 */}
      <div>
        <SectionTitle>{t('stats.tokenDistribution')} — Prompt / Completion</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
          <StackedTokenBar
            items={modelSummary.slice(0, 10).map(m => ({ name: m.name, prompt: m.totalPrompt, completion: m.totalCompletion }))}
            maxTotal={maxTokens}
          />
          <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border-default/50 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg, ${CN_COLORS.purple}, ${CN_COLORS.purpleDeep})` }} />
              <span className="text-text-tertiary">Prompt</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2.5 rounded-sm" style={{ background: `linear-gradient(90deg, ${CN_COLORS.green}, ${CN_COLORS.greenDeep})` }} />
              <span className="text-text-tertiary">Completion</span>
            </span>
          </div>
        </div>
      </div>

      {/* 调用次数排行 — 横向条形图 */}
      <div>
        <SectionTitle>调用次数排行</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
          <HBarChart
            items={modelSummary.map(m => ({ label: m.name, value: m.callCount, sub: `${m.sessionCount} sessions` }))}
            maxVal={maxCalls}
            barColor={CN_COLORS.gold}
            barColorDeep={CN_COLORS.goldDeep}
          />
        </div>
      </div>

      {/* Aggregated model table */}
      <div>
        <SectionTitle>模型明细</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr>
                <th className="px-4 py-2.5 text-left text-text-tertiary font-mono text-xs">Model</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Calls</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Sessions</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Input</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Output</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Total</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Cost</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">%</th>
              </tr>
            </thead>
            <tbody>
              {modelSummary.map((m) => {
                const pct = totalModelTokens > 0 ? (m.totalTokens / totalModelTokens * 100) : 0;
                return (
                  <tr key={m.name} className="border-t border-border-default hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 text-text-primary font-mono text-xs font-medium">{m.name}</td>
                    <td className="px-4 py-2.5 text-right text-text-secondary font-mono text-xs">{m.callCount.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">{m.sessionCount}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs" style={{ color: CN_COLORS.purple }}>{formatTokens(m.totalPrompt)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs" style={{ color: CN_COLORS.green }}>{formatTokens(m.totalCompletion)}</td>
                    <td className="px-4 py-2.5 text-right text-accent-brand font-mono text-xs font-medium">{formatTokens(m.totalTokens)}</td>
                    <td className="px-4 py-2.5 text-right text-accent-green font-mono text-xs">{formatCost(calculateCost(m.name, { prompt: m.totalPrompt, completion: m.totalCompletion }))}</td>
                    <td className="px-4 py-2.5 text-right text-text-secondary font-mono text-xs">{pct.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Agents Tab ────────────────────────────────────────────────────────

function AgentsTab({ agentStats, aggregatedAgents, totalAgentTokens, heatmapAgents, heatmapModels, heatmapData, t }: AgentsTabProps) {
  if (agentStats.length === 0) {
    return (
      <div className="text-center text-text-tertiary py-12">
        <Bot className="w-10 h-10 text-text-tertiary/30 mx-auto mb-3" />
        <p className="text-sm">{t('stats.noAgentData')}</p>
      </div>
    );
  }

  // Agent token 甜甜圈图数据
  const agentSegments = aggregatedAgents.slice(0, 6).map((a, i) => {
    const gradIds = ['jade', 'vermilion', 'gold', 'purple', 'green', 'blue'];
    const colors = [CN_COLORS.jade, CN_COLORS.vermilion, CN_COLORS.gold, CN_COLORS.purple, CN_COLORS.green, CN_COLORS.blue];
    return { label: a.name, value: a.totalTokens, gradId: gradIds[i % 6], color: colors[i % 6] };
  });

  return (
    <div className="p-4 space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon={<Bot className="w-4 h-4" />} label={t('stats.tab.agents')} value={aggregatedAgents.length} />
        <StatCard icon={<Cpu className="w-4 h-4" />} label={t('stats.modelsUsed')} value={new Set(agentStats.map(a => a.modelName)).size} />
        <StatCard icon={<Database className="w-4 h-4" />} label={t('stats.totalTokens')} value={formatTokens(totalAgentTokens)} />
        <StatCard icon={<DollarSign className="w-4 h-4" />} label={t('stats.totalCost')} value={formatCost(agentStats.reduce((s, a) => s + calculateCost(a.modelName, { prompt: a.totalPrompt, completion: a.totalCompletion }), 0))} />
      </div>

      {/* Agent token 甜甜圈图 */}
      <div>
        <SectionTitle>Agent Token 消耗分布</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
          <DonutChart
            segments={agentSegments}
            size={170}
            thickness={28}
            centerLabel="总 Token"
            centerValue={formatTokens(totalAgentTokens)}
          />
        </div>
      </div>

      {/* Agent 活跃度热力图 */}
      {heatmapAgents.length > 0 && heatmapModels.length > 0 && (
        <div>
          <SectionTitle>Agent × Model 活跃度热力图</SectionTitle>
          <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
            <HeatmapGrid rows={heatmapAgents} cols={heatmapModels} data={heatmapData} />
            <div className="flex items-center gap-3 mt-3 text-[10px] text-text-tertiary">
              <span>低</span>
              <div className="flex gap-0.5">
                <span className="w-4 h-3 rounded-sm" style={{ background: 'rgba(107,123,126,0.08)' }} />
                <span className="w-4 h-3 rounded-sm" style={{ background: `${CN_COLORS.jadeDeep}55` }} />
                <span className="w-4 h-3 rounded-sm" style={{ background: CN_COLORS.jade }} />
                <span className="w-4 h-3 rounded-sm" style={{ background: CN_COLORS.gold }} />
                <span className="w-4 h-3 rounded-sm" style={{ background: CN_COLORS.vermilion }} />
              </div>
              <span>高</span>
            </div>
          </div>
        </div>
      )}

      {/* Agent table */}
      <div>
        <SectionTitle>Agent 明细</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr>
                <th className="px-4 py-2.5 text-left text-text-tertiary font-mono text-xs">Agent</th>
                <th className="px-4 py-2.5 text-left text-text-tertiary font-mono text-xs">Model</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Calls</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Input</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Output</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Total</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Cost</th>
              </tr>
            </thead>
            <tbody>
              {agentStats.map((a) => (
                <tr key={`${a.agentId}-${a.modelName}`} className="border-t border-border-default hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-2.5 text-text-primary font-mono text-xs">{a.agentName || a.agentId}</td>
                  <td className="px-4 py-2.5 text-text-secondary font-mono text-[11px]">{a.modelName}</td>
                  <td className="px-4 py-2.5 text-right text-text-secondary font-mono text-xs">{a.callCount.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs" style={{ color: CN_COLORS.purple }}>{formatTokens(a.totalPrompt)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs" style={{ color: CN_COLORS.green }}>{formatTokens(a.totalCompletion)}</td>
                  <td className="px-4 py-2.5 text-right text-accent-brand font-mono text-xs font-medium">{formatTokens(a.totalTokens)}</td>
                  <td className="px-4 py-2.5 text-right text-accent-green font-mono text-xs">{formatCost(calculateCost(a.modelName, { prompt: a.totalPrompt, completion: a.totalCompletion }))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tools Tab ─────────────────────────────────────────────────────────

function ToolsTab({ toolStats, t }: ToolsTabProps) {
  if (toolStats.length === 0) {
    return (
      <div className="text-center text-text-tertiary py-12">
        <Wrench className="w-10 h-10 text-text-tertiary/30 mx-auto mb-3" />
        <p className="text-sm">{t('stats.noData')}</p>
      </div>
    );
  }

  const totalCalls = toolStats.reduce((s, t) => s + t.callCount, 0);
  const totalSuccess = toolStats.reduce((s, t) => s + t.successCount, 0);
  const overallRate = totalCalls > 0 ? (totalSuccess / totalCalls * 100) : 0;
  const maxCalls = Math.max(...toolStats.map(t => t.callCount), 1);

  return (
    <div className="p-4 space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<Wrench className="w-4 h-4" />} label={t('stats.toolCount')} value={toolStats.length} />
        <StatCard icon={<CheckCircle2 className="w-4 h-4" />} label={t('stats.toolSuccessRate')} value={`${overallRate.toFixed(1)}%`} accent="text-accent-green" />
        <StatCard icon={<XCircle className="w-4 h-4" />} label={t('stats.toolFailCount')} value={toolStats.reduce((s, t) => s + t.failCount, 0)} accent="text-accent-red" />
      </div>

      {/* 工具调用次数排行条形图 */}
      <div>
        <SectionTitle>调用次数排行</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
          <HBarChart
            items={toolStats.slice(0, 15).map(ts => ({ label: ts.name, value: ts.callCount, sub: formatDuration(ts.avgDurationMs) }))}
            maxVal={maxCalls}
            barColor={CN_COLORS.jade}
            barColorDeep={CN_COLORS.jadeDeep}
          />
        </div>
      </div>

      {/* 工具表格 — 带红绿灯指示器 */}
      <div>
        <SectionTitle>工具明细</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr>
                <th className="px-4 py-2.5 text-left text-text-tertiary font-mono text-xs">{t('stats.toolName')}</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">{t('stats.calls')}</th>
                <th className="px-4 py-2.5 text-center text-text-tertiary font-mono text-xs">{t('stats.successRate')}</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">{t('stats.avgDuration')}</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">{t('stats.lastUsed')}</th>
              </tr>
            </thead>
            <tbody>
              {toolStats.map((ts) => {
                const rate = ts.callCount > 0 ? (ts.successCount / ts.callCount * 100) : 0;
                return (
                  <tr key={ts.name} className="border-t border-border-default hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 text-text-primary font-mono text-xs">{ts.name}</td>
                    <td className="px-4 py-2.5 text-right text-accent-brand font-mono text-xs font-medium">{ts.callCount.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-center">
                      <TrafficLight rate={rate} />
                    </td>
                    <td className="px-4 py-2.5 text-right text-text-secondary font-mono text-xs">
                      {ts.avgDurationMs > 0 ? formatDuration(ts.avgDurationMs) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-text-tertiary text-xs">
                      {ts.lastUsed ? new Date(ts.lastUsed).toLocaleString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Cost Tab ──────────────────────────────────────────────────────────

function CostTab({ costSummary, t }: CostTabProps) {
  if (!costSummary || costSummary.models.length === 0) {
    return (
      <div className="text-center text-text-tertiary py-12">
        <DollarSign className="w-10 h-10 text-text-tertiary/30 mx-auto mb-3" />
        <p className="text-sm">No cost data yet — run a session first.</p>
      </div>
    );
  }

  // 成本分布饼图数据
  const costSegments = costSummary.models.slice(0, 6).map((m, i) => {
    const gradIds = ['gold', 'jade', 'vermilion', 'purple', 'green', 'blue'];
    const colors = [CN_COLORS.gold, CN_COLORS.jade, CN_COLORS.vermilion, CN_COLORS.purple, CN_COLORS.green, CN_COLORS.blue];
    return { label: m.model, value: m.totalCost, gradId: gradIds[i % 6], color: colors[i % 6] };
  });

  // 缓存命中率环形图数据
  const cacheSegments = [
    { label: 'Cache Hit', value: costSummary.cacheHitRate, gradId: 'jade', color: CN_COLORS.jade },
    { label: 'Cache Miss', value: 100 - costSummary.cacheHitRate, gradId: 'gold', color: CN_COLORS.gold },
  ];

  return (
    <div className="p-4 space-y-5">
      {/* Top-level cost cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<DollarSign className="w-4 h-4" />} label="Total cost" value={formatCost(costSummary.totalCost)} sub={`${costSummary.models.length} models`} accent="text-accent-green" />
        <StatCard icon={<Database className="w-4 h-4" />} label="Cache hit rate" value={`${costSummary.cacheHitRate.toFixed(1)}%`} sub={`${formatTokens(costSummary.totalCacheReadTokens)} cache reads`} accent={costSummary.cacheHitRate >= 30 ? 'text-accent-green' : costSummary.cacheHitRate >= 10 ? 'text-accent-yellow' : 'text-text-tertiary'} />
        <StatCard icon={<ArrowDownRight className="w-4 h-4" />} label="Cache savings" value={formatCost(costSummary.cacheSavings)} sub={costSummary.totalCost > 0 ? `${((costSummary.cacheSavings / (costSummary.totalCost + costSummary.cacheSavings)) * 100).toFixed(1)}% off` : undefined} accent="text-accent-green" />
        <StatCard icon={<Hash className="w-4 h-4" />} label="Tokens (in/out)" value={`${formatTokens(costSummary.totalInputTokens)} / ${formatTokens(costSummary.totalOutputTokens)}`} sub={`+${formatTokens(costSummary.totalCacheCreationTokens)} cache write`} />
      </div>

      {/* 成本分布饼图 + 缓存命中率大环形图 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <SectionTitle>成本分布（按模型）</SectionTitle>
          <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
            <PieChart segments={costSegments} size={180} />
          </div>
        </div>

        <div>
          <SectionTitle>缓存命中率</SectionTitle>
          <div className="bg-bg-secondary border border-border-default rounded-lg p-4 flex items-center justify-center">
            <DonutChart
              segments={cacheSegments}
              size={180}
              thickness={32}
              centerLabel="Hit Rate"
              centerValue={`${costSummary.cacheHitRate.toFixed(1)}%`}
            />
          </div>
        </div>
      </div>

      {/* Per-model cost table */}
      <div>
        <SectionTitle>模型成本明细</SectionTitle>
        <div className="bg-bg-secondary border border-border-default rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr>
                <th className="px-4 py-2.5 text-left text-text-tertiary font-mono text-xs">Model</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Input</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Output</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Cache R</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Cache W</th>
                <th className="px-4 py-2.5 text-right text-text-tertiary font-mono text-xs">Cost</th>
              </tr>
            </thead>
            <tbody>
              {costSummary.models.map((m) => {
                const hitRate = m.inputTokens > 0 ? (m.cacheReadTokens / m.inputTokens) * 100 : 0;
                return (
                  <tr key={m.model} className="border-t border-border-default hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5 text-text-primary font-mono text-xs">
                      {m.model}
                      {m.cacheReadTokens > 0 && (
                        <span className="ml-2 text-[10px] text-accent-green">{hitRate.toFixed(0)}% cached</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs" style={{ color: CN_COLORS.purple }}>
                      {formatTokens(m.netInputTokens)}
                      <div className="text-[10px] text-text-tertiary">{formatCost(m.inputCost)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs" style={{ color: CN_COLORS.green }}>
                      {formatTokens(m.outputTokens)}
                      <div className="text-[10px] text-text-tertiary">{formatCost(m.outputCost)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-text-secondary font-mono text-xs">
                      {formatTokens(m.cacheReadTokens)}
                      <div className="text-[10px] text-text-tertiary">{formatCost(m.cacheReadCost)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-text-secondary font-mono text-xs">
                      {formatTokens(m.cacheCreationTokens)}
                      <div className="text-[10px] text-text-tertiary">{formatCost(m.cacheCreationCost)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-accent-brand font-mono text-xs font-medium">{formatCost(m.totalCost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
