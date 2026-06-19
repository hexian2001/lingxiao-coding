/**
 * CommandCenterView — unified orchestration operations visualization
 *
 * Tier 1: OrchestrationProgress
 * Tier 2: TeamHierarchy + TeamMessagesPanel
 * Tier 3: searchable Agent runtime board
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/sessionStore';
import type { AgentConversation, AgentMessage } from '../../stores/sessionStore';
import { normalizeAgentStatus, type NormalizedAgentStatus } from '../../stores/sessionStoreHelpers.ts';
import type { WorkerBackend } from '@contracts/types/Agent';
import OrchestrationProgress from './OrchestrationProgress';
import TeamHierarchy from './TeamHierarchy';
import TeamMessagesPanel from './TeamMessagesPanel';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  Cpu,
  Filter,
  Folder,
  Hash,
  Loader2,
  MessageSquare,
  Pause,
  Search,
  Square,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react';

const statusConfig = {
  idle:        { color: 'text-text-tertiary', bg: 'bg-bg-secondary', border: 'border-border-default', icon: Activity, iconClass: '', labelKey: 'agentDashboard.status.idle' },
  running:     { color: 'text-accent-brand', bg: 'bg-accent-brand/10', border: 'border-accent-brand/20', icon: Loader2, iconClass: 'animate-spin', labelKey: 'agentDashboard.status.running' },
  recovering:  { color: 'text-accent-blue', bg: 'bg-accent-blue/10', border: 'border-accent-blue/20', icon: Loader2, iconClass: 'animate-spin', labelKey: 'agentDashboard.status.recovering' },
  completed:   { color: 'text-accent-green', bg: 'bg-accent-green/10', border: 'border-accent-green/20', icon: CheckCircle2, iconClass: '', labelKey: 'agentDashboard.status.completed' },
  failed:      { color: 'text-accent-red', bg: 'bg-accent-red/10', border: 'border-accent-red/20', icon: XCircle, iconClass: '', labelKey: 'agentDashboard.status.failed' },
  interrupted: { color: 'text-accent-yellow', bg: 'bg-accent-yellow/10', border: 'border-accent-yellow/20', icon: Pause, iconClass: '', labelKey: 'agentDashboard.status.interrupted' },
} as const;

type AgentStatus = NormalizedAgentStatus;
type StatusFilter = 'all' | 'active' | 'attention' | 'completed' | AgentStatus;
type SortKey = 'priority' | 'tokens' | 'messages' | 'recent' | 'name';

type AgentListItem = {
  agentId: string;
  agentName: string;
  role: string;
  status: string;
  taskId?: string;
  workingDirectory?: string;
  writeScope?: string[];
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
  spawnedAt?: number;
  conv: AgentConversation;
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ts?: number): string {
  if (!ts) return '-';
  const millis = ts > 1_000_000_000_000 ? ts : ts * 1000;
  return new Date(millis).toLocaleTimeString();
}

function basename(path?: string): string {
  if (!path) return '';
  const clean = path.replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

function contextColor(ratio: number | undefined): string {
  if (ratio == null) return 'text-text-tertiary';
  if (ratio > 0.85) return 'text-accent-red';
  if (ratio > 0.65) return 'text-accent-yellow';
  return 'text-accent-brand';
}

function contextBarColor(ratio: number | undefined): string {
  if (ratio == null) return 'bg-text-tertiary/20';
  if (ratio > 0.85) return 'bg-accent-red';
  if (ratio > 0.65) return 'bg-accent-yellow';
  return 'bg-accent-brand';
}

function latestMessage(conv: AgentConversation): AgentMessage | undefined {
  return [...conv.messages].reverse().find((msg) => msg.type !== 'status') || conv.messages.at(-1);
}

function previewMessage(msg?: AgentMessage): string {
  if (!msg?.content) return '';
  return msg.content.replace(/\s+/g, ' ').trim();
}

function statusPriority(status: AgentStatus): number {
  const order: Record<AgentStatus, number> = {
    running: 0,
    recovering: 1,
    failed: 2,
    interrupted: 3,
    idle: 4,
    completed: 5,
  };
  return order[status] ?? 5;
}

function AgentCard({ item, t }: { item: AgentListItem; t: ReturnType<typeof useTranslation>['t'] }) {
  const stopAgent = useSessionStore((s) => s.stopAgent);
  const [stopping, setStopping] = useState(false);
  const handleStop = useCallback(async () => {
    setStopping(true);
    try { await stopAgent(item.agentId); } finally { setStopping(false); }
  }, [item.agentId, stopAgent]);
  const conv = item.conv;
  const normalizedStatus = normalizeAgentStatus(conv.status);
  const cfg = statusConfig[normalizedStatus];
  const Icon = cfg.icon;
  const tokens = conv.tokenUsage;
  const taskId = conv.taskId || item.taskId;
  const cwd = conv.workingDirectory || item.workingDirectory;
  const backend = conv.backend || item.backend;
  const last = latestMessage(conv);
  const preview = previewMessage(last);
  const canStop = normalizedStatus === 'running' || normalizedStatus === 'recovering';

  return (
    <div className={`min-w-0 rounded border ${cfg.border} ${cfg.bg} p-3 transition-colors hover:bg-bg-hover`}>
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Icon size={14} className={`${cfg.color} ${cfg.iconClass} shrink-0`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={conv.agentName}>
          {conv.agentName}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${cfg.bg} ${cfg.color}`}>
          {t(cfg.labelKey, normalizedStatus)}
        </span>
        {canStop && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            title={t('agent.stop.title')}
            aria-label={t('agent.stop.title')}
            className="shrink-0 flex items-center gap-1 rounded border border-accent-red/30 px-1.5 py-0.5 text-[10px] font-medium text-accent-red hover:bg-accent-red/10 disabled:opacity-50 transition-colors"
          >
            {stopping
              ? <Loader2 size={11} className="animate-spin" />
              : <Square size={11} className="fill-current" />}
            <span>{stopping ? t('agent.stop.busy') : t('agent.stop')}</span>
          </button>
        )}
      </div>

      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-text-tertiary">
        {conv.role && <span className="max-w-full truncate rounded border border-border-default bg-bg-primary/50 px-1.5 py-0.5 font-mono" title={conv.role}>{conv.role}</span>}
        {taskId && (
          <span className="inline-flex max-w-full items-center gap-1 rounded border border-border-default bg-bg-primary/50 px-1.5 py-0.5 font-mono" title={taskId}>
            <Hash size={10} />
            <span className="truncate">{taskId}</span>
          </span>
        )}
        {backend && <span className="rounded border border-border-default bg-bg-primary/50 px-1.5 py-0.5 font-mono">{backend}</span>}
        {cwd && (
          <span className="inline-flex max-w-full items-center gap-1 rounded border border-border-default bg-bg-primary/50 px-1.5 py-0.5 font-mono" title={cwd}>
            <Folder size={10} />
            <span className="truncate">{basename(cwd)}</span>
          </span>
        )}
      </div>

      {tokens && tokens.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1 text-text-tertiary">
              <Zap size={10} className="text-accent-yellow" />
              <span className="font-mono">{formatTokens(tokens.total)} tokens</span>
            </div>
            <span className="font-mono text-[10px] text-text-tertiary/70">
              {formatTokens(tokens.prompt)} in / {formatTokens(tokens.completion)} out
            </span>
          </div>
          {conv.contextRatio != null && (
            <div>
              <div className="mb-0.5 flex items-center justify-between text-[10px]">
                <span className="text-text-tertiary">{t('agentDashboard.contextWindow', 'Context')}</span>
                <span className={`font-mono ${contextColor(conv.contextRatio)}`}>
                  {Math.round(conv.contextRatio * 100)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border-default">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${contextBarColor(conv.contextRatio)}`}
                  style={{ width: `${Math.min(conv.contextRatio * 100, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 text-[10px] text-text-tertiary">
        <span className="flex items-center gap-1">
          <MessageSquare size={10} />
          {conv.messages.length} {t('agentDashboard.messages', 'messages')}
        </span>
        <span className="font-mono">{formatTime(last?.timestamp)}</span>
      </div>

      {preview && (
        <div className="mt-2 line-clamp-2 rounded border border-border-default/70 bg-bg-primary/35 px-2 py-1.5 text-[11px] leading-4 text-text-secondary" title={preview}>
          {preview}
        </div>
      )}

      {conv.lastError && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-accent-red/25 bg-accent-red/10 px-2 py-1.5 text-[11px] text-accent-red">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{conv.lastError}</span>
        </div>
      )}
    </div>
  );
}

function StatusChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors ${
        active
          ? 'border-accent-brand/30 bg-accent-brand/10 text-accent-brand'
          : 'border-border-default text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <span>{label}</span>
      {count !== undefined && <span className="font-mono opacity-70">{count}</span>}
    </button>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'text-text-primary',
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded border border-border-default bg-bg-secondary p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase text-text-tertiary">
        <Icon size={12} />
        <span className="truncate">{label}</span>
      </div>
      <div className={`flex items-center gap-1 truncate font-mono text-xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}

export default function CommandCenterView() {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);
  const [agentSearch, setAgentSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('priority');

  const agentList = useMemo<AgentListItem[]>(
    () => agents
      .map((agent) => {
        const conv = agentConversations[agent.agentId];
        return conv ? { ...agent, conv } : null;
      })
      .filter((agent): agent is AgentListItem => Boolean(agent)),
    [agents, agentConversations],
  );

  const stats = useMemo(() => {
    const byStatus: Record<AgentStatus, number> = { idle: 0, running: 0, recovering: 0, completed: 0, failed: 0, interrupted: 0 };
    let totalTokens = 0;
    let totalMessages = 0;
    let attentionCount = 0;
    for (const item of agentList) {
      const ns = normalizeAgentStatus(item.conv.status);
      byStatus[ns] = (byStatus[ns] || 0) + 1;
      totalTokens += item.conv.tokenUsage?.total || 0;
      totalMessages += item.conv.messages.length;
      if (ns === 'failed' || ns === 'interrupted' || (item.conv.contextRatio ?? 0) > 0.85 || item.conv.lastError) {
        attentionCount += 1;
      }
    }
    return { byStatus, totalTokens, totalMessages, agentCount: agentList.length, attentionCount };
  }, [agentList]);

  const filteredAgents = useMemo(() => {
    const q = agentSearch.trim().toLowerCase();
    return agentList.filter((item) => {
      const ns = normalizeAgentStatus(item.conv.status);
      const needsAttention = ns === 'failed' || ns === 'interrupted' || (item.conv.contextRatio ?? 0) > 0.85 || Boolean(item.conv.lastError);
      if (statusFilter === 'active' && ns !== 'running') return false;
      if (statusFilter === 'attention' && !needsAttention) return false;
      if (statusFilter === 'completed' && ns !== 'completed') return false;
      if (statusFilter in statusConfig && ns !== statusFilter) return false;
      if (!q) return true;
      const last = previewMessage(latestMessage(item.conv));
      const haystack = [
        item.agentId,
        item.agentName,
        item.role,
        item.taskId,
        item.workingDirectory,
        item.backend,
        item.conv.agentName,
        item.conv.role,
        item.conv.taskId,
        item.conv.workingDirectory,
        item.conv.backend,
        item.conv.lastError,
        last,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [agentList, agentSearch, statusFilter]);

  const sortedAgents = useMemo(() => {
    return [...filteredAgents].sort((a, b) => {
      if (sortBy === 'name') return (a.conv.agentName || a.agentName).localeCompare(b.conv.agentName || b.agentName);
      if (sortBy === 'tokens') return (b.conv.tokenUsage?.total || 0) - (a.conv.tokenUsage?.total || 0);
      if (sortBy === 'messages') return b.conv.messages.length - a.conv.messages.length;
      if (sortBy === 'recent') return (latestMessage(b.conv)?.timestamp || b.spawnedAt || 0) - (latestMessage(a.conv)?.timestamp || a.spawnedAt || 0);

      const sa = statusPriority(normalizeAgentStatus(a.conv.status));
      const sb = statusPriority(normalizeAgentStatus(b.conv.status));
      if (sa !== sb) return sa - sb;
      const tokenDelta = (b.conv.tokenUsage?.total || 0) - (a.conv.tokenUsage?.total || 0);
      if (tokenDelta !== 0) return tokenDelta;
      return (a.spawnedAt ?? 0) - (b.spawnedAt ?? 0);
    });
  }, [filteredAgents, sortBy]);

  const clearFilters = () => {
    setAgentSearch('');
    setStatusFilter('all');
    setSortBy('priority');
  };

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <div className="flex shrink-0 items-center justify-between border-b border-border-default bg-bg-secondary px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Cpu className="h-4 w-4 text-accent-purple" />
          {t('agentDashboard.title', 'Command Center')}
        </h2>
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <Users size={12} className="opacity-60" />
          <span className="font-mono">{stats.agentCount} {t('agentDashboard.agents', 'agents')}</span>
        </div>
      </div>

      <div className="shrink-0 border-b border-border-default">
        <OrchestrationProgress />
        <TeamHierarchy />
        <TeamMessagesPanel />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-border-default px-4 py-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <StatCard icon={Users} label={t('agentDashboard.totalAgents', 'Total Agents')} value={stats.agentCount} />
            <StatCard icon={Activity} label={t('agentDashboard.runningAgents', 'Running')} value={stats.byStatus.running || 0} tone="text-accent-brand" />
            <StatCard icon={AlertTriangle} label={t('agentDashboard.attention', 'Needs Attention')} value={stats.attentionCount} tone={stats.attentionCount > 0 ? 'text-accent-red' : 'text-text-primary'} />
            <StatCard icon={Zap} label={t('agentDashboard.totalTokens', 'Agent Tokens')} value={formatTokens(stats.totalTokens)} tone="text-accent-yellow" />
            <StatCard icon={Cpu} label={t('agentDashboard.leaderTokens', 'Leader Tokens')} value={formatTokens(tokenUsage.total)} tone="text-accent-blue" />
          </div>
        </div>

        <div className="border-b border-border-default px-4 py-2">
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(14rem,1fr)_11rem_12rem_auto]">
            <div className="relative min-w-0">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
              <input
                value={agentSearch}
                onChange={(e) => setAgentSearch(e.target.value)}
                placeholder={t('agentDashboard.searchAgents', 'Search agents, roles, tasks...')}
                className="min-h-8 w-full rounded border border-border-input bg-bg-input py-1.5 pl-7 pr-2 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
              />
            </div>
            <label className="flex min-w-0 items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="min-h-8 w-full rounded border border-border-input bg-bg-input px-2 py-1.5 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
              >
                <option value="all">{t('agentDashboard.filter.all', 'All agents')}</option>
                <option value="active">{t('agentDashboard.filter.running', 'Running')}</option>
                <option value="attention">{t('agentDashboard.filter.attention', 'Needs attention')}</option>
                <option value="completed">{t('agentDashboard.filter.completed', 'Completed')}</option>
              </select>
            </label>
            <label className="flex min-w-0 items-center gap-1.5">
              <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                className="min-h-8 w-full rounded border border-border-input bg-bg-input px-2 py-1.5 text-xs text-text-primary focus:border-accent-brand focus:outline-none"
              >
                <option value="priority">{t('agentDashboard.sort.priority', 'Priority')}</option>
                <option value="recent">{t('agentDashboard.sort.recent', 'Recent')}</option>
                <option value="tokens">{t('agentDashboard.sort.tokens', 'Tokens')}</option>
                <option value="messages">{t('agentDashboard.sort.messages', 'Messages')}</option>
                <option value="name">{t('agentDashboard.sort.name', 'Name')}</option>
              </select>
            </label>
            {(agentSearch || statusFilter !== 'all' || sortBy !== 'priority') && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex min-h-8 items-center justify-center gap-1 rounded border border-border-default px-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" />
                {t('agentDashboard.clearFilters', 'Clear')}
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusChip label={t('agentDashboard.filter.all', 'All agents')} count={stats.agentCount} active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
            <StatusChip label={t('agentDashboard.filter.running', 'Running')} count={stats.byStatus.running || 0} active={statusFilter === 'active'} onClick={() => setStatusFilter('active')} />
            <StatusChip label={t('agentDashboard.filter.attention', 'Needs attention')} count={stats.attentionCount} active={statusFilter === 'attention'} onClick={() => setStatusFilter('attention')} />
            <StatusChip label={t('agentDashboard.filter.completed', 'Completed')} count={stats.byStatus.completed || 0} active={statusFilter === 'completed'} onClick={() => setStatusFilter('completed')} />
            <span className="ml-auto text-[11px] text-text-tertiary">
              {t('agentDashboard.showingAgents', '{{shown}}/{{total}} shown', { shown: sortedAgents.length, total: agentList.length })}
            </span>
          </div>
        </div>

        {agentList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
            <Cpu size={32} className="mb-3 opacity-30" />
            <p className="text-sm">{t('agentDashboard.noAgents', 'No agents active')}</p>
            <p className="mt-1 text-xs opacity-60">{t('agentDashboard.noAgentsHint', 'Agents will appear here when spawned by the leader')}</p>
          </div>
        ) : sortedAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
            <Search size={28} className="mb-3 opacity-40" />
            <p className="text-sm">{t('agentDashboard.noMatches', 'No agents match the current filters')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 px-4 py-3 xl:grid-cols-2">
            {sortedAgents.map((item) => (
              <AgentCard key={item.agentId} item={item} t={t} />
            ))}
          </div>
        )}

        {sortedAgents.length > 0 && stats.totalTokens > 0 && (
          <div className="border-t border-border-default px-4 py-3">
            <div className="mb-2 text-[10px] uppercase text-text-tertiary">
              {t('agentDashboard.tokenBreakdown', 'Token Distribution')}
            </div>
            <div className="flex h-3 overflow-hidden rounded-full bg-border-default">
              {sortedAgents.map((item, index) => {
                const pct = ((item.conv.tokenUsage?.total || 0) / stats.totalTokens) * 100;
                if (pct < 1) return null;
                const colors = ['bg-accent-brand', 'bg-accent-purple', 'bg-accent-blue', 'bg-accent-green', 'bg-accent-yellow'];
                return (
                  <div
                    key={item.agentId}
                    className={`${colors[index % colors.length]} transition-all duration-300`}
                    style={{ width: `${pct}%` }}
                    title={`${item.agentName}: ${formatTokens(item.conv.tokenUsage?.total || 0)} (${Math.round(pct)}%)`}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
