/**
 * statsReport — 把 DB 中的 token/模型/工具/Agent 统计组装成终端可读文本报告。
 *
 * 与 Web 的 StatsView 同源（都读 db.getModelStats / getToolStats / getTokenSummary），
 * 但在 TUI 中以紧凑文本呈现，作为 /stats 回调命令的结果。
 */

import type { AgentLog, DatabaseManager } from '../core/Database.js';
import { renderTable, type TableColumn } from '../utils/textTable.js';

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 当前会话的 token/费用/工具统计报告 */
export function buildSessionStatsReport(db: DatabaseManager, sessionId: string | null | undefined): string {
  if (!sessionId) return '当前没有活动会话';

  const lines: string[] = [];
  const summary = db.getTokenSummary(sessionId);

  // ── Token 用量（按 agent） ──
  lines.push('▸ Token 用量（本会话）');
  if (summary.length === 0) {
    lines.push('  暂无 token 记录');
  } else {
    const cols: TableColumn[] = [
      { header: 'Agent', width: 18 },
      { header: '输入', width: 8, align: 'right' },
      { header: '输出', width: 8, align: 'right' },
      { header: '缓存读', width: 8, align: 'right' },
      { header: '缓存写', width: 8, align: 'right' },
    ];
    let totalPrompt = 0, totalCompletion = 0, totalCacheRead = 0, totalCacheCreation = 0;
    const rows: string[][] = [];
    for (const s of summary) {
      totalPrompt += s.prompt;
      totalCompletion += s.completion;
      totalCacheRead += s.cache_read;
      totalCacheCreation += s.cache_creation;
      rows.push([s.agent_name || s.agent_id, fmt(s.prompt), fmt(s.completion), fmt(s.cache_read), fmt(s.cache_creation)]);
    }
    rows.push(['合计', fmt(totalPrompt), fmt(totalCompletion), fmt(totalCacheRead), fmt(totalCacheCreation)]);
    lines.push(...renderTable(cols, rows));
  }

  // ── 工具调用 Top ──
  try {
    const toolStats = db.getToolStats();
    if (toolStats.length > 0) {
      lines.push('');
      lines.push('▸ 工具调用 Top 10');
      const top = [...toolStats].sort((a, b) => b.callCount - a.callCount).slice(0, 10);
      const cols: TableColumn[] = [
        { header: '工具', width: 24 },
        { header: '次数', width: 8, align: 'right' },
      ];
      lines.push(...renderTable(cols, top.map((t) => [t.name, `${t.callCount}`])));
    }
  } catch { /* noop */ }

  return lines.join('\n');
}

/** 全局模型统计（跨会话） */
export function buildModelStatsReport(db: DatabaseManager): string {
  const lines: string[] = ['▸ 模型统计（聚合）'];
  try {
    const models = db.getModelStatsAggregated();
    if (!models || models.length === 0) return '暂无模型统计';
    const cols: TableColumn[] = [
      { header: '模型', width: 26 },
      { header: '调用', width: 8, align: 'right' },
      { header: '输入', width: 9, align: 'right' },
      { header: '输出', width: 9, align: 'right' },
      { header: '总计', width: 9, align: 'right' },
    ];
    const rows = models.map((m) => [m.name, fmt(m.callCount), fmt(m.totalPrompt), fmt(m.totalCompletion), fmt(m.totalTokens)]);
    lines.push(...renderTable(cols, rows));
  } catch (error) {
    return `模型统计读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  return lines.join('\n');
}

/** 最近 agent_logs（本会话），用于 /logs */
export function buildLogsReport(db: DatabaseManager, sessionId: string | null | undefined, limit = 40): string {
  if (!sessionId) return '当前没有活动会话';
  let logs: AgentLog[];
  try {
    logs = db.getAgentLogs(sessionId);
  } catch (error) {
    return `日志读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!logs || logs.length === 0) return '本会话暂无日志';

  const recent = logs.slice(-limit);
  const lines: string[] = [`▸ 最近 ${recent.length} 条日志（本会话）`];
  const cols: TableColumn[] = [
    { header: '时间', width: 11 },
    { header: 'Agent', width: 14 },
    { header: '事件', width: 16 },
    { header: '内容', width: 50 },
  ];
  const rows = recent.map((log) => {
    const time = new Date((log.timestamp || 0) * 1000).toLocaleTimeString();
    const who = log.agent_id || 'system';
    const evt = log.event_type || '';
    const content = String(log.content || '').replace(/\s+/g, ' ');
    return [time, who, evt, content];
  });
  lines.push(...renderTable(cols, rows));
  return lines.join('\n');
}

/** 按 agent 分组的执行时间线（trace 风格），用于 /traces */
export function buildTracesReport(db: DatabaseManager, sessionId: string | null | undefined): string {
  if (!sessionId) return '当前没有活动会话';
  let logs: AgentLog[];
  try {
    logs = db.getAgentLogs(sessionId);
  } catch (error) {
    return `Trace 读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!logs || logs.length === 0) return '本会话暂无 trace';

  // 按 agent_id 聚合：首末时间、事件数、最后事件、按事件类型计数
  interface Span {
    agentId: string;
    agentName: string;
    role: string;
    firstTs: number;
    lastTs: number;
    count: number;
    lastEvent: string;
    eventCounts: Map<string, number>;
  }
  const spans = new Map<string, Span>();
  for (const log of logs) {
    const id = log.agent_id || 'leader';
    const ts = log.timestamp || 0;
    let span = spans.get(id);
    if (!span) {
      span = {
        agentId: id,
        agentName: log.agent_name || id,
        role: log.agent_role || '',
        firstTs: ts,
        lastTs: ts,
        count: 0,
        lastEvent: '',
        eventCounts: new Map(),
      };
      spans.set(id, span);
    }
    span.firstTs = Math.min(span.firstTs, ts);
    span.lastTs = Math.max(span.lastTs, ts);
    span.count += 1;
    const evt = log.event_type || '';
    span.lastEvent = evt;
    span.eventCounts.set(evt, (span.eventCounts.get(evt) || 0) + 1);
  }

  const ordered = [...spans.values()].sort((a, b) => a.firstTs - b.firstTs);
  const lines: string[] = [`▸ 执行时间线（${ordered.length} 个 agent · ${logs.length} 事件）`];
  for (const span of ordered) {
    const durationS = Math.max(0, Math.round((span.lastTs - span.firstTs)));
    const dur = durationS >= 60 ? `${Math.floor(durationS / 60)}m${durationS % 60}s` : `${durationS}s`;
    const start = new Date(span.firstTs * 1000).toLocaleTimeString();
    lines.push('');
    lines.push(`▸ ${span.agentName}${span.role ? ` (${span.role})` : ''} · ${span.count} 事件 · ${dur} · 始于 ${start}`);
    // top 事件类型
    const topEvents = [...span.eventCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const evtSummary = topEvents.map(([evt, n]) => `${evt}×${n}`).join(' · ');
    if (evtSummary) lines.push(`    ${evtSummary}`);
    lines.push(`    最后: ${span.lastEvent}`);
  }
  return lines.join('\n');
}
