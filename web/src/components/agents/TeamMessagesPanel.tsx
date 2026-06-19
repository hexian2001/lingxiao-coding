/**
 * TeamMessagesPanel — 实时渲染 sessionStore.teamMessages
 *
 * Tier 2.5：Team 通讯流（Leader / Worker / Broadcast 三色）。
 * 数据来源：SSE `team_message_sent` → sessionStore.teamMessages（最多 100 条）。
 *
 * 设计取舍：
 * - 不另设 fetch；纯响应式渲染 store。
 * - urgency=urgent 高亮 + 红色侧条；broadcast 用青色侧条；P2P 用 brand。
 * - 按时间倒序，最近 50 条；超长 content 截断 + 展开。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/sessionStore';
import type { TeamMessageItem } from '../../stores/sessionStoreTypes.ts';
import { MessageSquare, AlertOctagon, Megaphone, ArrowRight, GitBranch, CheckCircle2, Handshake, ClipboardCheck, FileText, Search, Filter, X } from 'lucide-react';

const MAX_RENDER = 50;
type MessageFilter = 'all' | 'urgent' | 'broadcast' | 'intent';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function CollaborationTimeline({ messages }: { messages: TeamMessageItem[] }) {
  const events = useMemo(() => messages
    .filter((msg) => {
      const intent = typeof msg.metadata?.intent === 'string' ? msg.metadata.intent : undefined;
      return intent && intent !== 'message';
    })
    .slice(-12)
    .reverse(), [messages]);

  const iconFor = (intent?: string) => {
    if (intent === 'conflict_notice' || intent === 'coordination_result') return Handshake;
    if (intent === 'review_request' || intent === 'review_result') return ClipboardCheck;
    if (intent === 'transfer_request' || intent === 'transfer_accept') return GitBranch;
    if (intent === 'decision_record') return FileText;
    return MessageSquare;
  };

  if (events.length === 0) return null;

  return (
    <div className="px-3 pb-2">
      <div className="rounded border border-border-default bg-bg-secondary/70 p-2">
        <div className="flex items-center gap-2 mb-2 text-[10px] text-text-tertiary uppercase tracking-wider">
          <GitBranch size={11} className="text-accent-purple" />
          <span>Collaboration Timeline</span>
        </div>
        <div className="space-y-1.5 max-h-40 overflow-y-auto">
          {events.map((msg) => {
            const intent = typeof msg.metadata?.intent === 'string' ? msg.metadata.intent : 'message';
            const taskId = typeof msg.metadata?.taskId === 'string' ? msg.metadata.taskId : undefined;
            const verdict = typeof msg.metadata?.verdict === 'string' ? msg.metadata.verdict : undefined;
            const Icon = iconFor(intent);
            return (
              <div key={`tl-${msg.id}`} className="flex items-start gap-2 text-[11px]">
                <div className="mt-0.5 w-5 h-5 rounded-full bg-bg-tertiary flex items-center justify-center shrink-0">
                  <Icon size={10} className="text-accent-brand" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-text-secondary">
                    <span className="font-mono text-text-primary truncate max-w-[80px]">{msg.fromMember || msg.fromTeam}</span>
                    <span className="text-text-tertiary">→</span>
                    <span className="font-mono text-text-primary truncate max-w-[80px]">{msg.toMember || msg.toTeam}</span>
                    <span className="px-1 py-0.5 rounded text-[9px] bg-accent-brand/10 text-accent-brand uppercase">{intent}</span>
                    {taskId && <span className="px-1 py-0.5 rounded text-[9px] bg-bg-tertiary text-text-tertiary font-mono">{taskId}</span>}
                    {verdict && <span className="px-1 py-0.5 rounded text-[9px] bg-accent-yellow/10 text-accent-yellow font-mono">{verdict}</span>}
                    <span className="ml-auto text-[9px] font-mono text-text-tertiary">{formatTime(msg.timestamp)}</span>
                  </div>
                  <div className="text-[10px] text-text-tertiary truncate mt-0.5">{msg.content}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ msg }: { msg: TeamMessageItem }) {
  const [expanded, setExpanded] = useState(false);
  const isUrgent = msg.urgency === 'urgent';
  const isBroadcast = msg.isBroadcast;

  const sideClass = isUrgent
    ? 'border-l-2 border-accent-red bg-accent-red/5'
    : isBroadcast
      ? 'border-l-2 border-accent-cyan bg-accent-cyan/5'
      : 'border-l-2 border-accent-brand/40 bg-bg-secondary';

  const Icon = isUrgent ? AlertOctagon : isBroadcast ? Megaphone : msg.kind === 'ack' ? CheckCircle2 : MessageSquare;
  const iconCls = isUrgent
    ? 'text-accent-red'
    : isBroadcast
      ? 'text-accent-cyan'
      : 'text-accent-brand';

  const intent = typeof msg.metadata?.intent === 'string' ? msg.metadata.intent : undefined;
  const taskId = typeof msg.metadata?.taskId === 'string' ? msg.metadata.taskId : undefined;
  const verdict = typeof msg.metadata?.verdict === 'string' ? msg.metadata.verdict : undefined;
  const truncated = msg.content.length > 240 && !expanded;
  const display = truncated ? msg.content.slice(0, 240) + '…' : msg.content;

  return (
    <div className={`rounded px-3 py-2 ${sideClass}`}>
      <div className="flex items-center gap-2 text-[11px] text-text-tertiary mb-1">
        <Icon size={11} className={iconCls} />
        <span className="font-mono text-text-primary">{msg.fromMember || msg.fromTeam}</span>
        <ArrowRight size={10} className="opacity-50" />
        <span className="font-mono text-text-primary">
          {isBroadcast ? `${msg.toTeam} (broadcast)` : (msg.toMember || msg.toTeam)}
        </span>
        {isUrgent && (
          <span className="ml-1 px-1 py-0.5 rounded text-[9px] font-medium bg-accent-red/15 text-accent-red uppercase">
            urgent
          </span>
        )}
        {intent && intent !== 'message' && <span className="px-1 py-0.5 rounded text-[9px] bg-accent-brand/10 text-accent-brand uppercase">{intent}</span>}
        {taskId && <span className="px-1 py-0.5 rounded text-[9px] bg-bg-tertiary text-text-tertiary font-mono">{taskId}</span>}
        {verdict && <span className="px-1 py-0.5 rounded text-[9px] bg-accent-yellow/10 text-accent-yellow font-mono">{verdict}</span>}
        <span className="ml-auto font-mono opacity-60">{formatTime(msg.timestamp)}</span>
      </div>
      <div className="text-xs text-text-primary whitespace-pre-wrap break-words leading-relaxed">
        {display}
      </div>
      {msg.content.length > 240 && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-1 text-[10px] text-accent-brand hover:underline font-mono"
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      )}
    </div>
  );
}

export default function TeamMessagesPanel() {
  const { t } = useTranslation();
  const teamMessages = useSessionStore((s) => s.teamMessages);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MessageFilter>('all');

  const stats = useMemo(() => {
    const messages = teamMessages || [];
    return {
      total: messages.length,
      urgent: messages.filter((msg) => msg.urgency === 'urgent').length,
      broadcast: messages.filter((msg) => msg.isBroadcast).length,
      intent: messages.filter((msg) => {
        const intent = typeof msg.metadata?.intent === 'string' ? msg.metadata.intent : undefined;
        return Boolean(intent && intent !== 'message');
      }).length,
    };
  }, [teamMessages]);

  const ordered = useMemo(() => {
    if (!teamMessages || teamMessages.length === 0) return [];
    const q = search.trim().toLowerCase();
    return [...teamMessages]
      .filter((msg) => {
        const intent = typeof msg.metadata?.intent === 'string' ? msg.metadata.intent : '';
        if (filter === 'urgent' && msg.urgency !== 'urgent') return false;
        if (filter === 'broadcast' && !msg.isBroadcast) return false;
        if (filter === 'intent' && (!intent || intent === 'message')) return false;
        if (!q) return true;
        const haystack = [
          msg.fromTeam,
          msg.fromMember,
          msg.toTeam,
          msg.toMember,
          msg.content,
          msg.kind,
          intent,
          msg.metadata?.taskId,
          msg.metadata?.verdict,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      })
      .slice(-MAX_RENDER)
      .reverse();
  }, [filter, search, teamMessages]);

  const hasFilters = search || filter !== 'all';

  return (
    <div className="border-b border-border-default bg-bg-primary">
      <div className="px-4 py-2 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <MessageSquare size={12} className="text-accent-brand" />
          <span className="font-medium">{t('teamMessages.title', 'Team Messages')}</span>
          <span className="font-mono text-[10px] text-text-tertiary">
            {ordered.length}/{teamMessages?.length || 0}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(12rem,1fr)_auto]">
          <div className="relative min-w-0">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('teamMessages.search', 'Search team messages...')}
              className="min-h-8 w-full rounded border border-border-input bg-bg-input py-1.5 pl-7 pr-2 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
            />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
            <Filter className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            <MessageFilterButton label={t('teamMessages.filter.all', 'All')} count={stats.total} active={filter === 'all'} onClick={() => setFilter('all')} />
            <MessageFilterButton label={t('teamMessages.filter.urgent', 'Urgent')} count={stats.urgent} active={filter === 'urgent'} onClick={() => setFilter('urgent')} />
            <MessageFilterButton label={t('teamMessages.filter.broadcast', 'Broadcast')} count={stats.broadcast} active={filter === 'broadcast'} onClick={() => setFilter('broadcast')} />
            <MessageFilterButton label={t('teamMessages.filter.intent', 'Intent')} count={stats.intent} active={filter === 'intent'} onClick={() => setFilter('intent')} />
            {hasFilters && (
              <button
                type="button"
                onClick={() => { setSearch(''); setFilter('all'); }}
                className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded border border-border-default px-2 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <X className="h-3 w-3" />
                {t('teamMessages.clear', 'Clear')}
              </button>
            )}
          </div>
        </div>
      </div>
      <CollaborationTimeline messages={teamMessages || []} />
      {ordered.length === 0 ? (
        <div className="px-4 py-4 text-center text-[11px] text-text-tertiary opacity-70">
          {teamMessages?.length ? t('teamMessages.noMatch', 'No matching team messages') : t('teamMessages.empty', 'No team messages yet')}
        </div>
      ) : (
        <div className="px-3 pb-3 space-y-1.5 max-h-64 overflow-y-auto">
          {ordered.map((msg) => (
            <MessageRow key={msg.id} msg={msg} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageFilterButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-7 shrink-0 items-center gap-1 rounded border px-2 text-[11px] transition-colors ${
        active
          ? 'border-accent-brand/30 bg-accent-brand/10 text-accent-brand'
          : 'border-border-default text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {label}
      <span className="font-mono opacity-70">{count}</span>
    </button>
  );
}
