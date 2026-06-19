/**
 * TracesView — 链路追踪高级可视化面板
 *
 * 基于真实的 agent_logs 数据展示：
 * - 会话选择器 + agent 筛选 + 事件类型筛选
 * - SSE 实时追加新事件
 * - Token 消耗趋势图 (sparkline, prompt/completion 双色堆叠)
 * - Agent 执行甘特图 (每 agent 一行, 活跃时段色块)
 * - 事件类型统计环形图
 * - 延迟分布直方图
 * - Agent 分组时间线 (保留现有功能)
 * - Agent 概览侧栏 (增强: 迷你 sparkline + 中国风状态色)
 *
 * 中国风配色:
 *   青锋(运行) → accent-green
 *   朱砂(失败) → accent-red
 *   金箔(完成) → lingxiao-sword / accent-yellow
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  Activity, Bot, Wrench, AlertTriangle, Clock, Cpu,
  RefreshCw, Filter, ChevronDown, ChevronRight, Zap,
  CheckCircle2, XCircle, Pause, Play, ArrowRight,
  TrendingUp, BarChart3, Gauge, Layers,
} from 'lucide-react';
import { acpClient } from '../../api/AcpClient';
import { useSessionStore } from '../../stores/sessionStore';
import { SessionUpdateKind, subscribeSessionUpdateEvents } from '../../stores/sseStore';
import { getServerToken } from '../../api/headers';
import { isAgentActiveStatus } from '../../stores/sessionStoreHelpers';

// ─── Types ───

interface TraceEvent {
  id: number;
  sessionId: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  taskId: string;
  eventType: string;
  content: unknown;
  tokenUsage?: { prompt: number; completion: number; total: number };
  agentStatus?: string;
  agentIteration?: number;
  timestamp: number;
}

interface AgentStateInfo {
  agent_id: string;
  agent_name: string;
  agent_role: string;
  status: string;
  iteration: number;
  stopped: number;
}

interface TokenSummary {
  prompt: number;
  completion: number;
  total: number;
}

type TraceResponseDto = {
  data?: unknown;
  states?: unknown;
  tokenSummary?: unknown;
};

// ─── Runtime guards ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ─── Normalizers ───

function normalizeTraceTokenUsage(value: unknown): TraceEvent['tokenUsage'] | undefined {
  if (!isRecord(value)) return undefined;
  return {
    prompt: numberField(value, 'prompt'),
    completion: numberField(value, 'completion'),
    total: numberField(value, 'total'),
  };
}

function normalizeTraceEvent(value: unknown, index: number): TraceEvent | null {
  if (!isRecord(value)) return null;
  const rawId = value.id;
  const numericId = typeof rawId === 'number' && Number.isFinite(rawId)
    ? rawId
    : typeof rawId === 'string' && rawId.trim() && Number.isFinite(Number(rawId))
      ? Number(rawId)
      : index;
  return {
    id: numericId,
    sessionId: stringField(value, 'sessionId', stringField(value, 'session_id')),
    agentId: stringField(value, 'agentId', stringField(value, 'agent_id', 'unknown')),
    agentName: stringField(value, 'agentName', stringField(value, 'agent_name')),
    agentRole: stringField(value, 'agentRole', stringField(value, 'agent_role')),
    taskId: stringField(value, 'taskId', stringField(value, 'task_id')),
    eventType: stringField(value, 'eventType', stringField(value, 'event_type', 'unknown')),
    content: value.content,
    tokenUsage: normalizeTraceTokenUsage(value.tokenUsage ?? value.token_usage),
    agentStatus: stringField(value, 'agentStatus', stringField(value, 'agent_status')),
    agentIteration: typeof value.agentIteration === 'number' && Number.isFinite(value.agentIteration)
      ? value.agentIteration
      : typeof value.agent_iteration === 'number' && Number.isFinite(value.agent_iteration)
        ? value.agent_iteration
        : undefined,
    timestamp: numberField(value, 'timestamp'),
  };
}

function normalizeAgentStateInfo(value: unknown): AgentStateInfo | null {
  if (!isRecord(value)) return null;
  return {
    agent_id: stringField(value, 'agent_id', stringField(value, 'agentId', 'unknown')),
    agent_name: stringField(value, 'agent_name', stringField(value, 'agentName')),
    agent_role: stringField(value, 'agent_role', stringField(value, 'agentRole')),
    status: stringField(value, 'status', 'idle'),
    iteration: numberField(value, 'iteration'),
    stopped: numberField(value, 'stopped'),
  };
}

function normalizeTokenSummary(value: unknown): TokenSummary {
  if (!isRecord(value)) return { prompt: 0, completion: 0, total: 0 };
  return {
    prompt: numberField(value, 'prompt'),
    completion: numberField(value, 'completion'),
    total: numberField(value, 'total'),
  };
}

// ─── Content helpers ───

function hasTraceDetailContent(value: unknown): value is object {
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

function valueText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function truncateStr(value: unknown, max: number): string {
  const s = valueText(value);
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ─── Event type config ───

const eventConfigBase: Record<string, { color: string; bg: string; icon: React.ReactNode; labelKey: string }> = {
  agent_spawned:              { color: 'text-accent-blue',   bg: 'bg-accent-blue/15',   icon: <Play size={12}/>,            labelKey: 'traces.event.spawned' },
  agent_completed:            { color: 'text-accent-green',  bg: 'bg-accent-green/15',  icon: <CheckCircle2 size={12}/>,    labelKey: 'traces.event.completed' },
  agent_stopped:              { color: 'text-accent-yellow', bg: 'bg-accent-yellow/15', icon: <Pause size={12}/>,           labelKey: 'traces.event.stopped' },
  agent_failed:               { color: 'text-accent-red',    bg: 'bg-accent-red/15',    icon: <XCircle size={12}/>,         labelKey: 'traces.event.failed' },
  agent_intervention:         { color: 'text-accent-purple', bg: 'bg-accent-purple/15', icon: <ArrowRight size={12}/>,     labelKey: 'traces.event.intervention' },
  llm_error:                  { color: 'text-accent-red',    bg: 'bg-accent-red/15',    icon: <AlertTriangle size={12}/>,  labelKey: 'traces.event.llmError' },
  permission_request_timeout: { color: 'text-accent-yellow', bg: 'bg-accent-yellow/15', icon: <AlertTriangle size={12}/>,  labelKey: 'traces.event.permissionTimeout' },
  continuation_window_reached:{ color: 'text-accent-yellow', bg: 'bg-accent-yellow/15', icon: <RefreshCw size={12}/>,      labelKey: 'traces.event.continuation' },
  tool_call:                  { color: 'text-accent-green',  bg: 'bg-accent-green/15',  icon: <Wrench size={12}/>,         labelKey: 'traces.event.toolCall' },
  tool_result:                { color: 'text-accent-green',  bg: 'bg-accent-green/15',  icon: <CheckCircle2 size={12}/>,   labelKey: 'traces.event.toolResult' },
};

const TRACE_REFRESH_SESSION_UPDATE_KINDS = new Set<SessionUpdateKind>([
  SessionUpdateKind.AgentToolCall,
  SessionUpdateKind.AgentToolResult,
  SessionUpdateKind.AgentSpawned,
  SessionUpdateKind.AgentCompleted,
  SessionUpdateKind.AgentFailed,
]);

function getEventConfig(type: string) {
  const base = eventConfigBase[type];
  if (!base) return { color: 'text-text-tertiary', bg: 'bg-bg-tertiary', icon: <Activity size={12}/>, label: type };
  return { ...base, label: i18n.t(base.labelKey) };
}

// ─── Agent status config (中国风配色) ───

const statusConfigBase: Record<string, { color: string; icon: React.ReactNode; labelKey: string }> = {
  running:   { color: 'text-accent-green',  icon: <div className="w-2 h-2 rounded-full bg-accent-green animate-pulse"/>,    labelKey: 'traces.status.running' },
  completed: { color: 'text-accent-yellow', icon: <CheckCircle2 size={14} className="text-accent-yellow"/>,                 labelKey: 'traces.status.completed' },
  failed:    { color: 'text-accent-red',    icon: <XCircle size={14} className="text-accent-red"/>,                         labelKey: 'traces.status.failed' },
  idle:      { color: 'text-text-tertiary', icon: <div className="w-2 h-2 rounded-full bg-text-tertiary"/>,                 labelKey: 'traces.status.idle' },
  stopped:   { color: 'text-accent-yellow', icon: <Pause size={14} className="text-accent-yellow"/>,                        labelKey: 'traces.status.stopped' },
};

function getStatusConfig(status?: string) {
  const base = statusConfigBase[status || 'idle'] || statusConfigBase.idle;
  return { ...base, label: i18n.t(base.labelKey) };
}

// ─── Utility ───

function formatTime(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ts1: number, ts2: number): string {
  const diff = Math.abs(ts2 - ts1);
  if (diff < 1) return '<1s';
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m${Math.round(diff % 60)}s`;
  return `${Math.floor(diff / 3600)}h${Math.floor((diff % 3600) / 60)}m`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ═══════════════════════════════════════════════════════════
// SVG 图表组件
// ═══════════════════════════════════════════════════════════

// ─── TokenTrendChart: 双色堆叠 sparkline ───

interface TokenDataPoint {
  timestamp: number;
  prompt: number;
  completion: number;
}

function TokenTrendChart({ data, total }: { data: TokenDataPoint[]; total: TokenSummary }) {
  const width = 280;
  const height = 60;
  const padding = 4;

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-[60px] text-[10px] text-text-muted">
        {data.length === 0 ? '暂无 Token 数据' : '数据不足'}
      </div>
    );
  }

  const timestamps = data.map((d) => d.timestamp);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  const maxPrompt = Math.max(...data.map((d) => d.prompt));
  const maxCompletion = Math.max(...data.map((d) => d.completion));
  const maxValue = Math.max(maxPrompt, maxCompletion, 1);

  const chartW = width - padding * 2;
  const chartH = height - padding * 2;

  const xFor = (ts: number) => padding + ((ts - minTs) / tsRange) * chartW;
  const yPromptFor = (v: number) => padding + chartH - (v / maxValue) * (chartH * 0.5);
  const yCompletionFor = (v: number) => padding + chartH * 0.5 - (v / maxValue) * (chartH * 0.5);

  const promptPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'} ${xFor(d.timestamp).toFixed(1)} ${yPromptFor(d.prompt).toFixed(1)}`,
  ).join(' ');
  const completionPath = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'} ${xFor(d.timestamp).toFixed(1)} ${yCompletionFor(d.completion).toFixed(1)}`,
  ).join(' ');

  const promptArea = `${promptPath} L ${xFor(maxTs).toFixed(1)} ${(padding + chartH).toFixed(1)} L ${xFor(minTs).toFixed(1)} ${(padding + chartH).toFixed(1)} Z`;
  const completionArea = `${completionPath} L ${xFor(maxTs).toFixed(1)} ${(padding + chartH * 0.5).toFixed(1)} L ${xFor(minTs).toFixed(1)} ${(padding + chartH * 0.5).toFixed(1)} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id="tokenPromptGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-blue)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-accent-blue)" stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id="tokenCompletionGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-green)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-accent-green)" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* 中线 */}
      <line x1={padding} y1={padding + chartH * 0.5} x2={width - padding} y2={padding + chartH * 0.5}
        stroke="var(--color-border-muted)" strokeDasharray="2 2" strokeWidth="0.5" />
      {/* Prompt 区域 */}
      <path d={promptArea} fill="url(#tokenPromptGrad)" />
      <path d={promptPath} fill="none" stroke="var(--color-accent-blue)" strokeWidth="1.2" />
      {/* Completion 区域 */}
      <path d={completionArea} fill="url(#tokenCompletionGrad)" />
      <path d={completionPath} fill="none" stroke="var(--color-accent-green)" strokeWidth="1.2" />
      {/* 图例 */}
      <circle cx={padding + 6} cy={padding + 4} r="2.5" fill="var(--color-accent-blue)" />
      <text x={padding + 12} y={padding + 7} fontSize="8" fill="var(--color-text-tertiary)">
        P {formatCompact(total.prompt)}
      </text>
      <circle cx={padding + 70} cy={padding + 4} r="2.5" fill="var(--color-accent-green)" />
      <text x={padding + 76} y={padding + 7} fontSize="8" fill="var(--color-text-tertiary)">
        C {formatCompact(total.completion)}
      </text>
    </svg>
  );
}

// ─── AgentGanttChart: 执行甘特图 ───

interface GanttRow {
  agentId: string;
  agentName: string;
  status: string;
  segments: { start: number; end: number; isLast: boolean }[];
}

function AgentGanttChart({ groups, agentStates }: { groups: GanttRow[]; agentStates: AgentStateInfo[] }) {
  const width = 280;
  const rowH = 18;
  const labelW = 70;
  const padding = 4;
  const chartW = width - labelW - padding * 2;
  const height = Math.max(groups.length * rowH + padding * 2, 30);

  if (groups.length === 0) {
    return <div className="flex items-center justify-center h-[40px] text-[10px] text-text-muted">暂无 Agent 数据</div>;
  }

  const allTimes = groups.flatMap((g) => g.segments).flatMap((s) => [s.start, s.end]);
  if (allTimes.length === 0) {
    return <div className="flex items-center justify-center h-[40px] text-[10px] text-text-muted">暂无时间数据</div>;
  }

  const minTs = Math.min(...allTimes);
  const maxTs = Math.max(...allTimes);
  const tsRange = maxTs - minTs || 1;

  const xFor = (ts: number) => labelW + padding + ((ts - minTs) / tsRange) * chartW;

  const getRowColor = (status: string): string => {
    if (status === 'running') return 'var(--color-accent-green)';
    if (status === 'failed') return 'var(--color-accent-red)';
    if (status === 'completed') return 'var(--lingxiao-sword)';
    if (status === 'stopped') return 'var(--color-accent-yellow)';
    return 'var(--color-text-tertiary)';
  };

  const getState = (agentId: string) => agentStates.find((s) => s.agent_id === agentId);

  return (
    <svg width={width} height={height} className="overflow-visible">
      {/* 网格线 */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={labelW + padding} y1={padding} x2={labelW + padding + chartW}
          y2={padding + groups.length * rowH}
          stroke="var(--color-border-muted)" strokeWidth="0.3" opacity="0.5"
          transform={`translate(${f * chartW}, 0)`} />
      ))}
      {groups.map((g, i) => {
        const state = getState(g.agentId);
        const color = getRowColor(state?.status || g.status);
        const y = padding + i * rowH + rowH * 0.25;
        const barH = rowH * 0.5;
        return (
          <g key={g.agentId}>
            <text x={padding} y={y + barH * 0.75} fontSize="8" fill="var(--color-text-secondary)" className="truncate">
              {truncateStr(g.agentName, 10)}
            </text>
            {g.segments.map((seg, si) => {
              const x1 = xFor(seg.start);
              const x2 = xFor(seg.end);
              const w = Math.max(x2 - x1, 2);
              const isLastSeg = seg.isLast && state && isAgentActiveStatus(state.status);
              return (
                <rect key={si} x={x1} y={y} width={w} height={barH}
                  fill={color} fillOpacity={isLastSeg ? 0.85 : 0.5}
                  rx="2" />
              );
            })}
            {/* 运行中 agent 的脉冲指示 */}
            {state && isAgentActiveStatus(state.status) && (
              <circle cx={xFor(maxTs) + 4} cy={y + barH / 2} r="2"
                fill={color} className="animate-pulse" />
            )}
          </g>
        );
      })}
      {/* 时间轴标签 */}
      <text x={labelW + padding} y={height - 1} fontSize="7" fill="var(--color-text-muted)">
        {formatTime(minTs)}
      </text>
      <text x={width - padding} y={height - 1} fontSize="7" fill="var(--color-text-muted)" textAnchor="end">
        {formatTime(maxTs)}
      </text>
    </svg>
  );
}

// ─── EventTypeDonut: 环形图统计 ───

const DONUT_COLORS = [
  'var(--color-accent-blue)',
  'var(--color-accent-green)',
  'var(--color-accent-yellow)',
  'var(--color-accent-red)',
  'var(--color-accent-purple)',
  'var(--color-accent-pink)',
  'var(--color-accent-brand)',
  'var(--color-text-tertiary)',
];

function EventTypeDonut({ counts }: { counts: Record<string, number> }) {
  const size = 100;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 42;
  const innerR = 26;

  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  if (total === 0) {
    return <div className="flex items-center justify-center w-full text-[10px] text-text-muted">暂无事件</div>;
  }

  let cumAngle = -Math.PI / 2;

  const arcs = entries.map(([type, count], i) => {
    const angle = (count / total) * Math.PI * 2;
    const startAngle = cumAngle;
    const endAngle = cumAngle + angle;
    cumAngle = endAngle;

    const x1 = cx + outerR * Math.cos(startAngle);
    const y1 = cy + outerR * Math.sin(startAngle);
    const x2 = cx + outerR * Math.cos(endAngle);
    const y2 = cy + outerR * Math.sin(endAngle);
    const x3 = cx + innerR * Math.cos(endAngle);
    const y3 = cy + innerR * Math.sin(endAngle);
    const x4 = cx + innerR * Math.cos(startAngle);
    const y4 = cy + innerR * Math.sin(startAngle);

    const largeArc = angle > Math.PI ? 1 : 0;
    const path = `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z`;

    return { path, color: DONUT_COLORS[i % DONUT_COLORS.length], type, count };
  });

  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} className="shrink-0">
        {arcs.map((arc, i) => (
          <path key={i} d={arc.path} fill={arc.color} fillOpacity="0.8" stroke="var(--color-bg-secondary)" strokeWidth="0.5" />
        ))}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="12" fontWeight="bold" fill="var(--color-text-primary)">
          {total}
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" fontSize="6" fill="var(--color-text-muted)">
          事件
        </text>
      </svg>
      <div className="flex flex-col gap-0.5 text-[9px] min-w-0 flex-1">
        {arcs.slice(0, 6).map((arc, i) => (
          <div key={i} className="flex items-center gap-1 truncate">
            <div className="w-2 h-2 rounded-sm shrink-0" style={{ background: arc.color }} />
            <span className="text-text-secondary truncate">{getEventConfig(arc.type).label}</span>
            <span className="text-text-muted shrink-0">{arc.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LatencyHistogram: 延迟分布直方图 ───

function LatencyHistogram({ events }: { events: TraceEvent[] }) {
  const width = 280;
  const height = 60;
  const padding = 4;
  const bins = 12;

  if (events.length < 2) {
    return <div className="flex items-center justify-center h-[60px] text-[10px] text-text-muted">数据不足</div>;
  }

  // 计算连续事件间隔 (秒)
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i].timestamp - sorted[i - 1].timestamp;
    if (diff > 0) intervals.push(diff);
  }

  if (intervals.length === 0) {
    return <div className="flex items-center justify-center h-[60px] text-[10px] text-text-muted">无间隔数据</div>;
  }

  const maxInterval = Math.max(...intervals);
  const binSize = maxInterval / bins || 1;
  const histogram = new Array(bins).fill(0);
  intervals.forEach((v) => {
    const idx = Math.min(Math.floor(v / binSize), bins - 1);
    histogram[idx]++;
  });

  const maxCount = Math.max(...histogram, 1);
  const chartW = width - padding * 2;
  const chartH = height - padding * 2 - 8;
  const barW = chartW / bins;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {histogram.map((count, i) => {
        const barH = (count / maxCount) * chartH;
        const x = padding + i * barW;
        const y = padding + chartH - barH;
        const isPeak = count === maxCount;
        return (
          <g key={i}>
            <rect x={x + 0.5} y={y} width={barW - 1} height={barH}
              fill={isPeak ? 'var(--lingxiao-sword)' : 'var(--color-accent-blue)'}
              fillOpacity={isPeak ? 0.9 : 0.55}
              rx="1" />
          </g>
        );
      })}
      <text x={padding} y={height - 1} fontSize="7" fill="var(--color-text-muted)">
        0s
      </text>
      <text x={width - padding} y={height - 1} fontSize="7" fill="var(--color-text-muted)" textAnchor="end">
        {maxInterval < 60 ? `${maxInterval.toFixed(0)}s` : `${(maxInterval / 60).toFixed(1)}m`}
      </text>
    </svg>
  );
}

// ─── MiniSparkline: 迷你活动密度图 ───

function MiniSparkline({ values, color }: { values: number[]; color: string }) {
  const width = 80;
  const height = 20;
  const padding = 2;

  if (values.length === 0) {
    return <div className="w-[80px] h-[20px]" />;
  }

  const maxVal = Math.max(...values, 1);
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;
  const step = chartW / Math.max(values.length - 1, 1);

  const points = values.map((v, i) => ({
    x: padding + i * step,
    y: padding + chartH - (v / maxVal) * chartH,
  }));

  const path = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`,
  ).join(' ');
  const areaPath = `${path} L ${points[points.length - 1].x.toFixed(1)} ${padding + chartH} L ${padding} ${padding + chartH} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`spark-${color.replace(/[^a-z0-9]/gi, '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#spark-${color.replace(/[^a-z0-9]/gi, '')})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// 统计卡片
// ═══════════════════════════════════════════════════════════

function StatCard({
  icon, title, children, className = '',
}: {
  icon: React.ReactNode; title: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`rounded-lg border border-border-default bg-bg-card/60 backdrop-blur-sm p-2.5 ${className}`}
      style={{ borderRadius: 'var(--radius-card)' }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-text-tertiary">{icon}</span>
        <span className="text-[10px] font-medium text-text-secondary">{title}</span>
      </div>
      {children}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// 主组件
// ═════════════════════════════════════════════════════════════

export default function TracesView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);

  const [selectedSessionId, setSelectedSessionId] = useState(sessionId);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [agentStates, setAgentStates] = useState<AgentStateInfo[]>([]);
  const [tokenSummary, setTokenSummary] = useState<TokenSummary>({ prompt: 0, completion: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const selectedSessionRef = useRef<string | null | undefined>(selectedSessionId);

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions();
  }, []);

  // Sync with current session
  useEffect(() => {
    setSelectedSessionId(sessionId);
    selectedSessionRef.current = sessionId;
    setEvents([]);
    setAgentStates([]);
    setTokenSummary({ prompt: 0, completion: 0, total: 0 });
    setSelectedAgent(null);
    setExpandedEvents(new Set());
    setExpandedAgents(new Set());
    setLoading(Boolean(sessionId));
  }, [sessionId]);

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
  }, [selectedSessionId]);

  // Fetch traces
  const fetchTraces = useCallback(async () => {
    const requestSessionId = selectedSessionId;
    if (!requestSessionId) return;
    if (selectedSessionRef.current !== requestSessionId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/traces?sessionId=${encodeURIComponent(requestSessionId)}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) {
        if (selectedSessionRef.current === requestSessionId) setLoading(false);
        return;
      }
      const data = await res.json().catch(() => null) as TraceResponseDto | null;
      if (selectedSessionRef.current !== requestSessionId) return;
      const rawEvents = Array.isArray(data?.data) ? data.data : [];
      const rawStates = Array.isArray(data?.states) ? data.states : [];
      setEvents(rawEvents
        .map((event, index) => normalizeTraceEvent(event, index))
        .filter((event): event is TraceEvent => event !== null)
        .sort((a, b) => a.timestamp - b.timestamp));
      setAgentStates(rawStates
        .map(normalizeAgentStateInfo)
        .filter((state): state is AgentStateInfo => state !== null));
      setTokenSummary(normalizeTokenSummary(data?.tokenSummary));
    } catch {
      // ignore
    }
    if (selectedSessionRef.current === requestSessionId) setLoading(false);
  }, [selectedSessionId]);

  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  // Auto refresh
  useEffect(() => {
    if (!autoRefresh || !selectedSessionId) return;
    const interval = setInterval(fetchTraces, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedSessionId, fetchTraces]);

  // SSE: append live events
  useEffect(() => {
    let isMounted = true;
    const unsub = subscribeSessionUpdateEvents(acpClient, ({ kind, update: u, sessionId: eventSessionId }) => {
      if (!isMounted) return;
      if (!u || !selectedSessionId) return;
      if (eventSessionId && eventSessionId !== selectedSessionId) return;
      if (kind && TRACE_REFRESH_SESSION_UPDATE_KINDS.has(kind)) {
        fetchTraces();
      }
    });
    return () => {
      isMounted = false;
      unsub();
    };
  }, [selectedSessionId, fetchTraces]);

  // Toggle event detail
  const toggleEvent = (id: number) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Toggle agent section
  const toggleAgent = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  };

  // Group events by agent
  const agentGroups = events.reduce((acc, ev) => {
    const key = ev.agentId;
    if (!acc[key]) acc[key] = { agentId: key, agentName: ev.agentName, agentRole: ev.agentRole, events: [] };
    acc[key].events.push(ev);
    return acc;
  }, {} as Record<string, { agentId: string; agentName: string; agentRole: string; events: TraceEvent[] }>);

  const getAgentState = (agentId: string) => agentStates.find((s) => s.agent_id === agentId);

  // Filter events (memoized)
  const filteredGroups = useMemo(() => Object.values(agentGroups)
    .filter((g) => !selectedAgent || g.agentId === selectedAgent)
    .map((g) => ({
      ...g,
      events: g.events.filter((e) => filterType === 'all' || e.eventType === filterType),
    }))
    .filter((g) => g.events.length > 0)
    .sort((a, b) => {
      const sa = getAgentState(a.agentId);
      const sb = getAgentState(b.agentId);
      if (isAgentActiveStatus(sa?.status) && !isAgentActiveStatus(sb?.status)) return -1;
      if (!isAgentActiveStatus(sa?.status) && isAgentActiveStatus(sb?.status)) return 1;
      return (a.events[0]?.timestamp || 0) - (b.events[0]?.timestamp || 0);
    }), [agentGroups, selectedAgent, filterType, agentStates]);

  const eventTypes = [...new Set(events.map((e) => e.eventType))].sort();

  // Auto-expand all agents by default
  useEffect(() => {
    if (Object.keys(agentGroups).length > 0 && expandedAgents.size === 0) {
      setExpandedAgents(new Set(Object.keys(agentGroups)));
    }
  }, [agentGroups, expandedAgents.size]);

  // ─── 可视化数据计算 ───

  // Token 趋势数据
  const tokenTrendData = useMemo((): TokenDataPoint[] => {
    const points: TokenDataPoint[] = [];
    let cumPrompt = 0;
    let cumCompletion = 0;
    events.forEach((ev) => {
      if (ev.tokenUsage && ev.tokenUsage.total > 0) {
        cumPrompt += ev.tokenUsage.prompt;
        cumCompletion += ev.tokenUsage.completion;
        points.push({ timestamp: ev.timestamp, prompt: ev.tokenUsage.prompt, completion: ev.tokenUsage.completion });
      }
    });
    return points;
  }, [events]);

  // 甘特图数据
  const ganttData = useMemo((): GanttRow[] => {
    return Object.values(agentGroups).map((g) => {
      const ts = g.events.map((e) => e.timestamp);
      const minTs = ts.length > 0 ? Math.min(...ts) : 0;
      const maxTs = ts.length > 0 ? Math.max(...ts) : 0;
      const state = getAgentState(g.agentId);
      const isActive = state && isAgentActiveStatus(state.status);
      return {
        agentId: g.agentId,
        agentName: g.agentName,
        status: state?.status || 'idle',
        segments: [{ start: minTs, end: maxTs, isLast: true }],
      };
    }).sort((a, b) => a.segments[0].start - b.segments[0].start);
  }, [agentGroups, agentStates]);

  // 事件类型统计
  const eventTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    events.forEach((e) => {
      counts[e.eventType] = (counts[e.eventType] || 0) + 1;
    });
    return counts;
  }, [events]);

  // Agent 活动密度 sparkline 数据
  const agentSparklineData = useMemo(() => {
    const map: Record<string, number[]> = {};
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const bins = 20;
    if (sorted.length === 0) return map;
    const minTs = sorted[0].timestamp;
    const maxTs = sorted[sorted.length - 1].timestamp;
    const range = maxTs - minTs || 1;
    const binSize = range / bins;

    Object.keys(agentGroups).forEach((agentId) => {
      map[agentId] = new Array(bins).fill(0);
    });

    sorted.forEach((e) => {
      const binIdx = Math.min(Math.floor((e.timestamp - minTs) / binSize), bins - 1);
      if (map[e.agentId]) {
        map[e.agentId][binIdx]++;
      }
    });

    return map;
  }, [events, agentGroups]);

  // ─── 渲染 ───

  return (
    <div className="flex h-full">
      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default bg-bg-secondary shrink-0">
          {/* Session selector */}
          <select
            value={selectedSessionId || ''}
            onChange={(e) => {
              setSelectedSessionId(e.target.value);
              setEvents([]);
              setAgentStates([]);
              setTokenSummary({ prompt: 0, completion: 0, total: 0 });
              setSelectedAgent(null);
              setExpandedEvents(new Set());
              setExpandedAgents(new Set());
            }}
            className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary max-w-[200px]"
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id.slice(0, 8)} ({new Date((s.created_at ?? 0) * 1000).toLocaleDateString()})
              </option>
            ))}
          </select>

          <div className="w-px h-4 bg-border-default" />

          {/* Event type filter */}
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary"
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            <option value="all">{t('traces.allInstances') || '所有类型'}</option>
            {eventTypes.map((et) => (
              <option key={et} value={et}>{getEventConfig(et).label}</option>
            ))}
          </select>

          {/* Agent filter */}
          <select
            value={selectedAgent || ''}
            onChange={(e) => setSelectedAgent(e.target.value || null)}
            className="px-2 py-1 text-xs bg-bg-input border border-border-input rounded text-text-primary"
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            <option value="">{t('traces.allAgents') || '所有 Agent'}</option>
            {Object.values(agentGroups).map((g) => (
              <option key={g.agentId} value={g.agentId}>{g.agentName}</option>
            ))}
          </select>

          <div className="w-px h-4 bg-border-default" />

          {/* Auto refresh toggle */}
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
              autoRefresh
                ? 'border-accent-green/30 text-accent-green bg-accent-green/10'
                : 'border-border-input text-text-tertiary bg-bg-input'
            }`}
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            {autoRefresh ? <Zap size={12} /> : <Pause size={12} />}
            {autoRefresh ? '实时' : '暂停'}
          </button>

          {/* Manual refresh */}
          <button
            onClick={fetchTraces}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border-input text-text-secondary bg-bg-input hover:bg-bg-hover transition-colors"
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>

          <div className="flex-1" />

          {/* Summary stats */}
          <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
            <span className="flex items-center gap-1">
              <Activity size={11} />
              {events.length} {t('traces.events') || '事件'}
            </span>
            <span className="flex items-center gap-1">
              <Bot size={11} />
              {Object.keys(agentGroups).length} Agent
            </span>
            {tokenSummary.total > 0 && (
              <span className="flex items-center gap-1">
                <Cpu size={11} />
                {formatCompact(tokenSummary.total)} Token
              </span>
            )}
          </div>
        </div>

        {/* 可视化仪表盘 */}
        {events.length > 0 && (
          <div className="px-3 py-2 border-b border-border-default/50 bg-bg-primary/30 shrink-0">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {/* Token 趋势图 */}
              <StatCard icon={<TrendingUp size={12} />} title="Token 消耗趋势">
                <TokenTrendChart data={tokenTrendData} total={tokenSummary} />
              </StatCard>

              {/* Agent 甘特图 */}
              <StatCard icon={<Clock size={12} />} title="Agent 执行甘特图">
                <AgentGanttChart groups={ganttData} agentStates={agentStates} />
              </StatCard>

              {/* 事件类型统计 */}
              <StatCard icon={<Layers size={12} />} title="事件类型统计">
                <EventTypeDonut counts={eventTypeCounts} />
              </StatCard>

              {/* 延迟分布 */}
              <StatCard icon={<BarChart3 size={12} />} title="延迟分布">
                <LatencyHistogram events={events} />
              </StatCard>
            </div>
          </div>
        )}

        {/* Loading / Empty state */}
        {loading && events.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
            <RefreshCw size={20} className="animate-spin mr-2" />
            {t('traces.loading') || '加载中...'}
          </div>
        ) : events.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
            <Filter size={20} className="mr-2 opacity-50" />
            {selectedSessionId ? (t('traces.noData') || '暂无追踪数据') : (t('traces.selectSession') || '请选择会话')}
          </div>
        ) : (
          /* Agent 分组时间线 */
          <div className="flex-1 overflow-y-auto">
            {filteredGroups.map((group) => {
              const state = getAgentState(group.agentId);
              const statusCfg = getStatusConfig(state?.status);
              const isExpanded = expandedAgents.has(group.agentId);
              const groupEvents = group.events;
              const firstTs = groupEvents[0]?.timestamp || 0;
              const lastTs = groupEvents[groupEvents.length - 1]?.timestamp || 0;
              const duration = firstTs && lastTs ? formatDuration(firstTs, lastTs) : '--';
              const sparkColor = state?.status === 'failed' ? 'var(--color-accent-red)' :
                state?.status === 'completed' ? 'var(--lingxiao-sword)' :
                state?.status === 'running' ? 'var(--color-accent-green)' :
                'var(--color-text-tertiary)';

              return (
                <div key={group.agentId} className="border-b border-border-default/30">
                  {/* Agent header */}
                  <div
                    className="flex items-center gap-2 px-4 py-2 bg-bg-secondary/50 hover:bg-bg-hover cursor-pointer"
                    onClick={() => toggleAgent(group.agentId)}
                  >
                    {isExpanded ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
                    {statusCfg.icon}
                    <span className="text-xs font-medium text-text-primary">{group.agentName}</span>
                    {group.agentRole && <span className="text-[10px] text-text-tertiary">({group.agentRole})</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusCfg.color} bg-bg-tertiary`}
                      style={{ borderRadius: 'var(--radius-tile)' }}
                    >
                      {statusCfg.label}
                    </span>
                    {state?.iteration ? <span className="text-[10px] text-text-tertiary font-mono">{t('traces.iteration')} {state.iteration}</span> : null}
                    {/* 迷你 sparkline */}
                    {agentSparklineData[group.agentId] && agentSparklineData[group.agentId].some((v) => v > 0) && (
                      <div className="ml-2 opacity-80">
                        <MiniSparkline values={agentSparklineData[group.agentId]} color={sparkColor} />
                      </div>
                    )}
                    <div className="flex-1" />
                    <span className="text-[10px] font-mono text-text-tertiary">{duration}</span>
                    <span className="text-[10px] font-mono text-text-tertiary">{group.events.length} {t('traces.events')}</span>
                  </div>

                  {/* Event list */}
                  {isExpanded && (
                    <div className="pl-8 pr-4 py-1">
                      {groupEvents.map((ev) => {
                        const cfg = getEventConfig(ev.eventType);
                        const isExpandedEvent = expandedEvents.has(ev.id);
                        const hasDetail = hasTraceDetailContent(ev.content);

                        return (
                          <div key={ev.id} className="group">
                            <div
                              className="flex items-start gap-2 py-1.5 cursor-pointer hover:bg-bg-hover/50 rounded px-2 -mx-2"
                              onClick={() => hasDetail && toggleEvent(ev.id)}
                            >
                              {/* Timeline dot */}
                              <div className="flex flex-col items-center mt-0.5">
                                <div className={`w-2 h-2 rounded-full ${cfg.bg} ${cfg.color}`} />
                                <div className="w-px h-full bg-border-default/30 min-h-[8px]" />
                              </div>

                              {/* Event icon */}
                              <span className={cfg.color}>{cfg.icon}</span>

                              {/* Event label */}
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${cfg.bg} ${cfg.color}`}
                                style={{ borderRadius: 'var(--radius-tile)' }}
                              >
                                {cfg.label}
                              </span>

                              {/* Event summary */}
                              <span className="text-xs text-text-secondary flex-1 truncate">
                                {getEventSummary(ev)}
                              </span>

                              {/* Timestamp */}
                              <span className="text-[10px] font-mono text-text-tertiary shrink-0">
                                {formatTime(ev.timestamp)}
                              </span>
                            </div>

                            {/* Expanded detail */}
                            {isExpandedEvent && hasDetail && (
                              <div className="ml-10 mb-2 p-2 bg-bg-primary rounded border border-border-default text-xs"
                                style={{ borderRadius: 'var(--radius-control)' }}
                              >
                                <pre className="text-text-secondary font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
                                  {JSON.stringify(ev.content, null, 2)}
                                </pre>
                                {ev.tokenUsage && ev.tokenUsage.total > 0 && (
                                  <div className="mt-2 pt-2 border-t border-border-default flex items-center gap-3 text-[10px] text-text-tertiary">
                                    <span>Token: {ev.tokenUsage.total.toLocaleString()}</span>
                                    <span>P {ev.tokenUsage.prompt.toLocaleString()}</span>
                                    <span>C {ev.tokenUsage.completion.toLocaleString()}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Agent summary sidebar */}
      {agentStates.length > 0 && (
        <div className="w-56 border-l border-border-default bg-bg-secondary overflow-y-auto shrink-0">
          <div className="px-3 py-2 border-b border-border-default">
            <h3 className="text-xs font-medium text-text-primary flex items-center gap-1.5">
              <Gauge size={13} className="text-text-tertiary" />
              {t('traces.llmCalls') || 'Agent 概览'}
            </h3>
          </div>
          {agentStates.map((state) => {
            const statusCfg = getStatusConfig(state.status);
            const agentEvents = events.filter((e) => e.agentId === state.agent_id);
            const agentTokens = agentEvents.reduce(
              (sum, ev) => {
                if (ev.tokenUsage) {
                  sum.prompt += ev.tokenUsage.prompt;
                  sum.completion += ev.tokenUsage.completion;
                  sum.total += ev.tokenUsage.total;
                }
                return sum;
              },
              { prompt: 0, completion: 0, total: 0 },
            );
            const sparkColor = state.status === 'failed' ? 'var(--color-accent-red)' :
              state.status === 'completed' ? 'var(--lingxiao-sword)' :
              state.status === 'running' ? 'var(--color-accent-green)' :
              'var(--color-text-tertiary)';

            return (
              <div key={state.agent_id} className="px-3 py-2 border-b border-border-default/30">
                <div className="flex items-center gap-1.5 mb-1">
                  {statusCfg.icon}
                  <span className="text-xs font-medium text-text-primary truncate flex-1">{state.agent_name}</span>
                </div>
                {/* 迷你 sparkline */}
                {agentSparklineData[state.agent_id] && agentSparklineData[state.agent_id].some((v) => v > 0) && (
                  <div className="mb-1.5">
                    <MiniSparkline values={agentSparklineData[state.agent_id]} color={sparkColor} />
                  </div>
                )}
                <div className="space-y-0.5 text-[10px] text-text-tertiary">
                  <div className="flex justify-between">
                    <span>{t('traces.spanDetail.type') || '状态'}</span>
                    <span className={statusCfg.color}>{statusCfg.label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('traces.duration') || '事件数'}</span>
                    <span className="text-text-secondary">{agentEvents.length}</span>
                  </div>
                  {state.iteration > 0 && (
                    <div className="flex justify-between">
                      <span>{t('traces.iteration')}</span>
                      <span className="text-text-secondary">{state.iteration}</span>
                    </div>
                  )}
                  {agentTokens.total > 0 && (
                    <div className="flex justify-between">
                      <span>{t('traces.spanDetail.tokens') || 'Token'}</span>
                      <span className="text-text-secondary">{agentTokens.total.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Event summary helper ───

function getEventSummary(ev: TraceEvent): string {
  const c = ev.content;
  if (!c || typeof c !== 'object') return typeof c === 'string' ? truncateStr(c, 60) : '';
  if (!isRecord(c)) return truncateStr(safeStringify(c).slice(0, 60), 60);

  switch (ev.eventType) {
    case 'agent_spawned':
      return c.task_subject ? truncateStr(c.task_subject, 60) : `${i18n.t('traces.summary.task')} ${truncateStr(c.task_id, 8)}`;
    case 'agent_completed':
      return c.result_summary ? truncateStr(c.result_summary, 60) : i18n.t('traces.summary.completed', { iterations: valueText(c.iterations), toolCalls: valueText(c.tool_calls) });
    case 'agent_stopped':
      return truncateStr(c.reason, 60);
    case 'agent_intervention':
      return `${i18n.t('traces.summary.from')} ${valueText(c.from) || '?'}: ${truncateStr(c.content, 40)}`;
    case 'llm_error':
      return truncateStr(c.error, 60);
    case 'permission_request_timeout':
      return `${valueText(c.toolName) || '?'} ${i18n.t('traces.summary.timeout')}`;
    case 'continuation_window_reached':
      return `${valueText(c.reason)} ${i18n.t('traces.iteration')}${valueText(c.iteration) || '?'}`;
    default:
      return truncateStr(safeStringify(c).slice(0, 60), 60);
  }
}
