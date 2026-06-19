/**
 * AgentSearchBar — 搜索过滤栏
 */
import { useMemo, useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore, type StatusFilter } from '../stores/officeStore';
import { Search, Loader2, CheckCircle2, XCircle, Clock, Users, Crosshair } from 'lucide-react';

type AgentStatusGroup = 'running' | 'completed' | 'failed' | 'idle';

const AGENT_STATUS_GROUPS: Record<string, AgentStatusGroup> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  crashed: 'failed',
  timeout: 'failed',
};

function classifyAgentStatus(status: unknown): AgentStatusGroup {
  return typeof status === 'string' ? AGENT_STATUS_GROUPS[status] ?? 'idle' : 'idle';
}

function agentStatusMatchesFilter(status: AgentStatusGroup, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return status === filter;
}

function agentStatusDotClass(status: AgentStatusGroup): string {
  switch (status) {
    case 'running':
      return 'bg-accent-brand animate-pulse';
    case 'completed':
      return 'bg-accent-green';
    case 'failed':
      return 'bg-accent-red';
    case 'idle':
      return 'bg-text-tertiary';
  }
}

export default function AgentSearchBar() {
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const {
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    setFocusAgentId, searchBarVisible, toggleSearchBar,
  } = useOfficeStore();

  // Ctrl+F toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.ctrlKey || e.metaKey) && agents.length > 0) {
        e.preventDefault();
        toggleSearchBar();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [agents.length, toggleSearchBar]);

  const stats = useMemo(() => {
    let r = 0, c = 0, f = 0, i = 0;
    for (const agent of agents) {
      const status = classifyAgentStatus(agentConversations[agent.agentId]?.status ?? agent.status);
      if (status === 'running') r++;
      else if (status === 'completed') c++;
      else if (status === 'failed') f++;
      else i++;
    }
    return { total: agents.length, r, c, f, i };
  }, [agents, agentConversations]);

  const filtered = useMemo(() => {
    let list = [...agents];
    if (statusFilter !== 'all') {
      list = list.filter((agent) => agentStatusMatchesFilter(
        classifyAgentStatus(agentConversations[agent.agentId]?.status ?? agent.status),
        statusFilter,
      ));
    }
    if (searchQuery.trim()) { const q = searchQuery.toLowerCase(); list = list.filter((a) => a.agentName.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)); }
    return list;
  }, [agents, agentConversations, statusFilter, searchQuery]);

  const chips: Array<{ key: StatusFilter; label: string; count: number; icon: React.ReactNode }> = [
    { key: 'all', label: 'All', count: stats.total, icon: <Users size={9} /> },
    { key: 'running', label: 'Active', count: stats.r, icon: <Loader2 size={9} className="animate-spin" /> },
    { key: 'completed', label: 'Done', count: stats.c, icon: <CheckCircle2 size={9} /> },
    { key: 'failed', label: 'Failed', count: stats.f, icon: <XCircle size={9} /> },
    { key: 'idle', label: 'Idle', count: stats.i, icon: <Clock size={9} /> },
  ];
  if (agents.length === 0 || !searchBarVisible) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-bg-primary/80 backdrop-blur-sm rounded-lg border border-border-default max-w-xl">
      <div className="relative flex-1 min-w-[160px] max-w-xs">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search agents..." className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-secondary border border-border-default rounded text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent-brand" />
      </div>
      <div className="flex items-center gap-1 flex-wrap">{chips.map((ch) => (
        <button key={ch.key} onClick={() => setStatusFilter(ch.key)} className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono transition-all ${statusFilter===ch.key?'bg-accent-brand/20 text-accent-brand border border-accent-brand/30':'bg-bg-secondary text-text-tertiary border border-border-default hover:text-text-primary'}`}>
          {ch.icon}<span>{ch.label}</span><span className="opacity-60">({ch.count})</span>
        </button>
      ))}</div>
      {searchQuery && filtered.length > 0 && (
        <div className="w-full mt-1 bg-bg-primary/95 backdrop-blur-sm rounded border border-border-default shadow-lg overflow-hidden max-h-[200px] overflow-y-auto">
          {filtered.slice(0, 20).map((agent) => {
            const status = classifyAgentStatus(agentConversations[agent.agentId]?.status ?? agent.status);
            return (
              <button key={agent.agentId} onClick={() => { setFocusAgentId(agent.agentId); setSearchQuery(''); }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-secondary text-left">
                <span className={`w-1.5 h-1.5 rounded-full ${agentStatusDotClass(status)}`} />
                <span className="text-xs text-text-primary font-medium flex-1 truncate">{agent.agentName}</span>
                <span className="text-[10px] text-text-tertiary">{agent.role}</span>
                <Crosshair size={10} className="text-text-tertiary" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
