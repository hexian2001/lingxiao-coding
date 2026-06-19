/**
 * OfficeStatsPanel — 全局统计面板
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore } from '../stores/officeStore';
import { OFFICE_LAYOUT } from '../assets/officeLayout';
import { roleMatchesAnyAffinity } from '../assets/roleAffinity';
import { X, Zap, Loader2, CheckCircle2, XCircle, BarChart3 } from 'lucide-react';

export default function OfficeStatsPanel() {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const { statsPanelOpen, setStatsPanelOpen, selectArea, setAreaInfoOpen } = useOfficeStore();

  const stats = useMemo(() => {
    let r = 0, c = 0, f = 0, i = 0, tk = 0;
    for (const a of agents) {
      const s = (agentConversations[a.agentId]?.status || a.status) as string;
      if (s === 'running') r++; else if (s === 'completed') c++; else if (s === 'failed' || s === 'crashed' || s === 'timeout') f++; else i++;
      tk += agentConversations[a.agentId]?.tokenUsage?.total || 0;
    }
    return { total: agents.length, r, c, f, i, tk };
  }, [agents, agentConversations]);

  const areaStats = useMemo(() => OFFICE_LAYOUT.areas.map((area) => {
    const inArea = agents.filter((a) => roleMatchesAnyAffinity(a.role, area.roleAffinity));
    const active = inArea.filter((a) => (agentConversations[a.agentId]?.status || a.status) === 'running').length;
    return { ...area, count: inArea.length, active };
  }), [agents, agentConversations]);

  if (!statsPanelOpen) return null;

  return (
    <div className="absolute right-2 top-16 bottom-2 w-64 z-30 bg-bg-primary/95 backdrop-blur-sm rounded-lg border border-border-default flex flex-col overflow-hidden shadow-xl">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0">
        <BarChart3 size={14} className="text-accent-brand" />
        <span className="text-sm font-semibold text-text-primary flex-1">{t('office.stats','Tower Stats')}</span>
        <button onClick={() => setStatsPanelOpen(false)} className="p-1 rounded hover:bg-bg-secondary text-text-tertiary hover:text-text-primary"><X size={14} /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        <div>
          <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1.5 font-medium">Agent Overview</div>
          <div className="grid grid-cols-2 gap-1.5">
            {[{label:'Total',v:stats.total,c:'text-text-primary'},{label:'Active',v:stats.r,c:'text-accent-brand'},{label:'Done',v:stats.c,c:'text-accent-green'},{label:'Failed',v:stats.f,c:'text-accent-red'}].map((item)=><div key={item.label} className="bg-bg-secondary rounded p-2 text-center"><div className={`text-sm font-mono font-bold ${item.c}`}>{item.v}</div><div className="text-[9px] text-text-tertiary mt-0.5">{item.label}</div></div>)}
          </div>
        </div>
        <div><div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1 font-medium">Resources</div>
          <div className="flex items-center gap-2 bg-bg-secondary rounded px-2.5 py-2"><Zap size={12} className="text-accent-yellow"/><span className="text-xs text-text-primary font-mono">{stats.tk>=1000000?`${(stats.tk/1000000).toFixed(1)}M`:`${(stats.tk/1000).toFixed(1)}K`}</span><span className="text-[10px] text-text-tertiary">tokens used</span></div></div>
        <div><div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1.5 font-medium">By Zone</div>
          <div className="space-y-1">{areaStats.map((area)=><button key={area.id} onClick={()=>{selectArea(area.id);setAreaInfoOpen(true);}} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-secondary text-left"><div className="w-2 h-2 rounded-sm shrink-0" style={{backgroundColor:area.kind==='lobby'?'#3a5a3a':area.kind==='coding'?'#3a3a5c':area.kind==='planning'?'#5a3a5c':area.kind==='tooling'?'#3a5a5c':area.kind==='review'?'#5a5a3a':'#3a5a6a'}}/><div className="flex-1 min-w-0"><div className="text-[11px] text-text-primary truncate">{area.name}</div></div><div className="flex items-center gap-1.5 text-[10px]"><span className="text-text-tertiary font-mono">{area.count}</span>{area.active>0&&<Loader2 size={8} className="text-accent-brand animate-spin"/>}</div></button>)}</div></div>
      </div>
    </div>
  );
}
