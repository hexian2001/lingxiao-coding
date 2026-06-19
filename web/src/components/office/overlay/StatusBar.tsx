/**
 * StatusBar — 底部状态栏
 */
import { useMemo } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore } from '../stores/officeStore';
import { Users, Zap, CheckCircle2, Loader2, XCircle, PauseCircle, BarChart3 } from 'lucide-react';

export default function StatusBar() {
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const { setStatusFilter, toggleStatsPanel } = useOfficeStore();

  const stats = useMemo(() => {
    let running = 0, completed = 0, failed = 0, paused = 0, tokens = 0;
    for (const a of agents) {
      const s = (agentConversations[a.agentId]?.status || a.status) as string;
      if (s === 'running') running++;
      else if (s === 'completed') completed++;
      else if (s === 'failed' || s === 'crashed' || s === 'timeout' || s === 'terminated') failed++;
      else if (s === 'interrupted' || s === 'paused' || s === 'stalled') paused++;
      tokens += agentConversations[a.agentId]?.tokenUsage?.total || 0;
    }
    return { total: agents.length, running, completed, failed, paused, tokens };
  }, [agents, agentConversations]);

  if (stats.total === 0) return null;

  return (
    <div className="absolute bottom-2 left-2 right-2 z-10 flex items-center gap-3 bg-bg-primary/80 backdrop-blur-sm rounded-lg border border-border-default px-3 py-1.5">
      <button onClick={()=>setStatusFilter('all')} className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary"><Users size={12} className="text-accent-purple"/><span className="font-mono">{stats.total}</span></button>
      {stats.running>0&&<button onClick={()=>setStatusFilter('running')} className="flex items-center gap-1 text-[11px] text-accent-brand"><Loader2 size={11} className="animate-spin"/><span className="font-mono">{stats.running}</span></button>}
      {stats.completed>0&&<button onClick={()=>setStatusFilter('completed')} className="flex items-center gap-1 text-[11px] text-accent-green"><CheckCircle2 size={11}/><span className="font-mono">{stats.completed}</span></button>}
      {stats.failed>0&&<button onClick={()=>setStatusFilter('failed')} className="flex items-center gap-1 text-[11px] text-accent-red"><XCircle size={11}/><span className="font-mono">{stats.failed}</span></button>}
      {stats.paused>0&&<button onClick={()=>setStatusFilter('idle')} className="flex items-center gap-1 text-[11px] text-accent-yellow"><PauseCircle size={11}/><span className="font-mono">{stats.paused}</span></button>}
      <div className="ml-auto flex items-center gap-2">
        <button onClick={()=>toggleStatsPanel()} className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-bg-secondary"><BarChart3 size={11}/></button>
        <div className="flex items-center gap-1 text-[11px] text-text-tertiary"><Zap size={10} className="text-accent-yellow"/><span className="font-mono">{stats.tokens>=1000?`${(stats.tokens/1000).toFixed(1)}K`:stats.tokens}</span></div>
      </div>
    </div>
  );
}
