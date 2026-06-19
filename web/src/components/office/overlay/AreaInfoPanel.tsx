/**
 * AreaInfoPanel — 每个分区展示不同真实系统数据
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore } from '../stores/officeStore';
import { OFFICE_LAYOUT } from '../assets/officeLayout';
import { roleMatchesAnyAffinity } from '../assets/roleAffinity';
import { approvePlan, getErrorMessage, rejectPlan, runSlashCommand, sendAgentPrompt, sendSessionPrompt } from '../officeActions';
import { X, Users, Loader2, CheckCircle2, XCircle, MapPin, Zap, Wrench, GitBranch, Activity, AlertTriangle, BarChart3 } from 'lucide-react';

export default function AreaInfoPanel() {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const sessionId = useSessionStore((s) => s.sessionId);
  const messages = useSessionStore((s) => s.messages);
  const phase = useSessionStore((s) => s.phase);
  const tokenUsage = useSessionStore((s) => s.tokenUsage);
  const orchestrationStatus = useSessionStore((s) => s.orchestrationStatus);
  const leaderStatusText = useSessionStore((s) => s.leaderStatusText);
  const contextRuntimeState = useSessionStore((s) => s.contextRuntimeState);
  const watchdogAlert = useSessionStore((s) => s.watchdogAlert);
  const progressStagnant = useSessionStore((s) => s.progressStagnant);
  const leaderQueueLength = useSessionStore((s) => s.leaderQueueLength);
  const isConnected = useSessionStore((s) => s.isConnected);
  const { selectedAreaId, areaInfoOpen, setAreaInfoOpen, setFocusAgentId, setActionStatus } = useOfficeStore();
  const [areaPrompt, setAreaPrompt] = useState('');
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const area = selectedAreaId ? OFFICE_LAYOUT.areas.find((a) => a.id === selectedAreaId) : null;
  const agentsInArea = useMemo(() => {
    if (!area) return [];
    if (!area.roleAffinity?.length) return agents;
    return agents.filter((a) => roleMatchesAnyAffinity(a.role, area.roleAffinity));
  }, [agents, area]);

  const areaStats = useMemo(() => {
    let r = 0, c = 0, f = 0, tk = 0;
    for (const a of agentsInArea) {
      const conv = agentConversations[a.agentId]; const s = (conv?.status || a.status) as string;
      if (s === 'running') r++; else if (s === 'completed') c++; else if (s === 'failed' || s === 'crashed' || s === 'timeout') f++;
      tk += conv?.tokenUsage?.total || 0;
    }
    return { total: agentsInArea.length, r, c, f, tk };
  }, [agentsInArea, agentConversations]);

  if (!areaInfoOpen || !area) return null;

  const runAction = async (kind: string, action: () => Promise<void>, success: string) => {
    if (!sessionId || busy) return;
    setBusy(kind);
    try {
      await action();
      setActionStatus({ kind: 'success', message: success });
      if (kind === 'dispatch') setAreaPrompt('');
      if (kind === 'reject') setRejectFeedback('');
    } catch (error) {
      setActionStatus({ kind: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const askAgent = (agentName: string, prompt: string) => runAction('agent', () => sendAgentPrompt(sessionId!, agentName, prompt), t('office.toast.requested', { name: agentName }));

  const renderZoneContent = () => {
    const k = area.kind;

    // LOBBY
    switch (k) {
      case 'lobby': {
        const idleAgents = agentsInArea.filter((a) => { const s = (agentConversations[a.agentId]?.status || a.status) as string; return !s || s === '' || s === 'idle'; });
        return (<>
          <div className="px-3 py-2 border-b border-border-default">
            <div className="flex items-center gap-1.5 mb-2"><MapPin size={13} className="text-accent-green"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.dispatchQueue')}</span></div>
            <div className="flex items-center gap-3">
              <div className="bg-bg-secondary rounded px-3 py-2 text-center min-w-[60px]"><div className="text-lg font-mono font-bold text-accent-brand">{leaderQueueLength??0}</div><div className="text-[9px] text-text-tertiary">{t('office.panel.queued')}</div></div>
              <div className="grid grid-cols-2 gap-1.5 flex-1">
                <div className="bg-bg-secondary rounded px-2 py-1 text-center"><div className="text-sm font-mono font-bold text-text-primary">{phase}</div><div className="text-[8px] text-text-tertiary uppercase">{t('office.panel.phase')}</div></div>
                <div className="bg-bg-secondary rounded px-2 py-1 text-center"><div className={`text-sm font-mono font-bold ${isConnected?'text-accent-green':'text-accent-red'}`}>{isConnected?'CONNECTED':'DISCONNECTED'}</div><div className="text-[8px] text-text-tertiary uppercase">{t('office.panel.net')}</div></div>
                <div className="bg-bg-secondary rounded px-2 py-1 text-center col-span-2"><div className="text-sm font-mono font-bold text-accent-yellow">{idleAgents.length}</div><div className="text-[8px] text-text-tertiary uppercase">{t('office.panel.idleAgents')}</div></div>
              </div>
            </div>
          </div>
          <div className="px-3 py-2 border-b border-border-default">
            <div className="flex gap-1.5">
              <input value={areaPrompt} onChange={(e) => setAreaPrompt(e.target.value)} placeholder={t('office.placeholder.dispatchTask')} className="min-w-0 flex-1 rounded border border-border-default bg-bg-secondary px-2 py-1 text-[10px] text-text-primary outline-none placeholder:text-text-tertiary" />
              <button onClick={() => areaPrompt.trim() && void runAction('dispatch', () => sendSessionPrompt(sessionId!, areaPrompt.trim()), t('office.toast.dispatched'))} disabled={!areaPrompt.trim() || busy !== null} className="rounded bg-accent-green/10 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/20 disabled:opacity-40">{t('office.action.dispatch')}</button>
            </div>
          </div>
          <div className="px-3 py-2"><div className="flex items-center gap-1.5 mb-1.5"><Users size={13} className="text-accent-green"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.agentsInLobby')}</span></div>
            <div className="space-y-1 max-h-[120px] overflow-y-auto">{agentsInArea.length===0?<div className="text-[10px] text-text-tertiary text-center py-2">{t('office.empty.noAgents')}</div>:agentsInArea.map((a)=>{const s=agentConversations[a.agentId]?.status||a.status;return <button key={a.agentId} onClick={()=>{setFocusAgentId(a.agentId);setAreaInfoOpen(false);}} className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-secondary"><span className={`w-1.5 h-1.5 rounded-full ${s==='running'?'bg-accent-brand animate-pulse':s==='completed'?'bg-accent-green':s==='failed'?'bg-accent-red':'bg-text-tertiary'}`}/><span className="text-xs text-text-primary truncate flex-1">{a.agentName}</span><span className="text-[9px] text-text-tertiary font-mono">{a.backend||'worker_process'}</span></button>;})}</div></div>
        </>);
      }

      // CODING
      if (k === 'coding') return (<>
        <div className="px-3 py-2 border-b border-border-default">
          <div className="flex items-center gap-1.5 mb-2"><Activity size={13} className="text-accent-blue"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.agentBackends')}</span></div>
          <div className="grid grid-cols-3 gap-1.5">{(['worker_process','claude','codex']as const).map((bk)=>{const cnt=agents.filter((a)=>a.backend===bk||(!a.backend&&bk==='worker_process')).length;return <div key={bk} className="bg-bg-secondary rounded px-2 py-1.5 text-center"><div className="text-sm font-mono font-bold text-text-primary">{cnt}</div><div className="text-[9px] text-text-tertiary uppercase">{bk}</div></div>;})}</div></div>
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1.5"><Activity size={13} className="text-accent-green"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.activeAgents')}</span>{areaStats.r>0&&<Loader2 size={10} className="animate-spin text-accent-brand"/>}</div>
          <div className="space-y-1.5 max-h-[200px] overflow-y-auto">{agentsInArea.filter((a)=>(agentConversations[a.agentId]?.status||a.status)==='running').map((agent)=>{const conv=agentConversations[agent.agentId];const lastText=conv?.messages?.slice().reverse().find((m)=>m.type==='text');const lastTool=conv?.messages?.slice().reverse().find((m)=>m.type==='tool_call');return <button key={agent.agentId} onClick={()=>{setFocusAgentId(agent.agentId);setAreaInfoOpen(false);}} className="w-full px-2 py-1.5 rounded bg-bg-secondary/30 hover:bg-bg-secondary"><div className="flex items-center gap-1.5"><Loader2 size={10} className="animate-spin text-accent-brand"/><span className="text-xs text-text-primary font-medium truncate flex-1">{agent.agentName}</span><span className="text-[9px] text-text-tertiary font-mono">{agent.backend||'worker_process'}</span></div>{lastTool&&<div className="flex items-center gap-1 text-[10px] text-accent-purple mt-0.5"><Wrench size={9}/><span className="truncate">{lastTool.tool}</span></div>}{lastText&&<div className="text-[10px] text-text-secondary truncate mt-0.5">{lastText.content.slice(0,80)}</div>}<div className="mt-1 flex gap-1"><span onClick={(e)=>{e.stopPropagation(); void askAgent(agent.agentName, 'report current coding status, blockers, and next step briefly');}} className="rounded bg-accent-brand/10 px-1.5 py-0.5 text-[9px] text-accent-brand hover:bg-accent-brand/20">{t('office.action.askStatus')}</span><span onClick={(e)=>{e.stopPropagation(); setFocusAgentId(agent.agentId); setAreaInfoOpen(false);}} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-secondary hover:text-text-primary">{t('office.action.focus')}</span></div></button>;})}</div></div>
      </>);

      // PLANNING
      if (k === 'planning') return (<>
        <div className="px-3 py-2 border-b border-border-default">
          <div className="flex items-center gap-1.5 mb-2"><GitBranch size={13} className="text-accent-purple"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.orchestration')}</span></div>
          {(() => {
            if (!orchestrationStatus) return <div className="text-[10px] text-text-tertiary text-center py-2">{t('office.empty.noOrchestration')}</div>;
            return (<>
            <div className="flex items-center justify-between mb-2"><span className={`inline-block w-2 h-2 rounded-full ${orchestrationStatus!.state==='running'||orchestrationStatus!.state==='planning'?'bg-accent-brand animate-pulse':orchestrationStatus!.state==='completed'?'bg-accent-green':orchestrationStatus!.state==='blocked'?'bg-accent-yellow':orchestrationStatus!.state==='failed'?'bg-accent-red':'bg-text-tertiary'}`}/><span className="text-xs font-mono font-bold text-text-primary uppercase">{orchestrationStatus!.state}</span><span className="text-[9px] text-text-tertiary">Run #{orchestrationStatus!.generation||'-'}</span></div>
            {(orchestrationStatus!.totalNodes??0)>0&&<div className="mb-2"><div className="flex justify-between text-[9px] text-text-tertiary mb-0.5"><span>{orchestrationStatus!.completedNodes||0}/{orchestrationStatus!.totalNodes} nodes</span>{orchestrationStatus!.currentNodeId&&<span className="truncate max-w-[120px]">{orchestrationStatus!.currentNodeId}</span>}</div><div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden"><div className="h-full bg-accent-brand rounded-full transition-all duration-500" style={{width:`${((orchestrationStatus!.completedNodes||0)/(orchestrationStatus!.totalNodes??1))*100}%`}}/></div></div>}
            {orchestrationStatus!.bottleneck&&<div className="flex items-center gap-1 text-[10px] text-accent-yellow"><AlertTriangle size={9}/><span className="truncate">{orchestrationStatus!.bottleneck}</span></div>}
            {leaderStatusText&&<div className="text-[10px] text-text-tertiary truncate">{leaderStatusText}</div>}
            <div className="mt-2 flex flex-wrap gap-1.5"><button onClick={() => void runAction('plan-summary', () => sendSessionPrompt(sessionId!, 'summarize the current plan and orchestration state briefly'), t('office.toast.planSummary'))} disabled={busy !== null} className="rounded bg-accent-purple/10 px-2 py-1 text-[10px] text-accent-purple hover:bg-accent-purple/20 disabled:opacity-40">{t('office.action.summarize')}</button><button onClick={() => { if (window.confirm(t('office.confirm.approve'))) void runAction('approve', approvePlan, t('office.toast.approved')); }} disabled={busy !== null} className="rounded bg-accent-green/10 px-2 py-1 text-[10px] text-accent-green hover:bg-accent-green/20 disabled:opacity-40">{t('office.action.approve')}</button></div>
            <div className="mt-2 flex gap-1.5"><input value={rejectFeedback} onChange={(e)=>setRejectFeedback(e.target.value)} placeholder={t('office.placeholder.rejectFeedback')} className="min-w-0 flex-1 rounded border border-border-default bg-bg-secondary px-2 py-1 text-[10px] outline-none"/><button onClick={() => rejectFeedback.trim() && window.confirm(t('office.confirm.reject')) && void runAction('reject', () => rejectPlan(rejectFeedback.trim()), t('office.toast.rejected'))} disabled={!rejectFeedback.trim() || busy !== null} className="rounded bg-accent-red/10 px-2 py-1 text-[10px] text-accent-red hover:bg-accent-red/20 disabled:opacity-40">{t('office.action.reject')}</button></div>
          </>);
          })()}</div>
        <div className="px-3 py-2"><div className="flex items-center gap-1.5 mb-1.5"><Activity size={13} className="text-accent-cyan"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.eventHistory')}</span></div>
          <div className="space-y-1 max-h-[160px] overflow-y-auto">{(orchestrationStatus?.eventHistory?.length??0)===0?<div className="text-[10px] text-text-tertiary text-center py-2">{t('office.empty.noEvents')}</div>:orchestrationStatus!.eventHistory!.slice(-12).reverse().map((ev,i)=><div key={i} className="flex items-center gap-2 px-2 py-1 rounded bg-bg-secondary/40 text-[10px]"><span className={`w-1.5 h-1.5 rounded-full ${ev.kind==='applied'||ev.kind==='node'?'bg-accent-green':ev.kind==='rejected'?'bg-accent-red':ev.kind==='repair'?'bg-accent-yellow':'bg-text-tertiary'}`}/><span className="font-mono text-text-secondary w-16 truncate">{ev.eventType}</span>{ev.nodeKind&&<span className="text-text-tertiary">{ev.nodeKind}</span>}{ev.verdict&&<span className={`ml-auto font-mono ${ev.verdict==='PASS'?'text-accent-green':ev.verdict==='FAIL'?'text-accent-red':'text-text-tertiary'}`}>{ev.verdict}</span>}</div>)}</div></div>
      </>);

      // TOOLING
      if (k === 'tooling') { let tc=0,co=0;const tm=new Map<string,number>();for(const conv of Object.values(agentConversations)){for(const msg of conv.messages){if(msg.type==='tool_call'){tc++;const t=msg.tool||'unknown';tm.set(t,(tm.get(t)||0)+1);}if(msg.type==='tool_result')co++;}};const tt=Array.from(tm.entries()).sort((a,b)=>b[1]-a[1]).slice(5);return(<>
        <div className="px-3 py-2 border-b border-border-default"><div className="flex items-center gap-1.5 mb-2"><Wrench size={13} className="text-accent-orange"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.toolStatistics')}</span></div>
          <div className="grid grid-cols-2 gap-1.5 mb-2"><div className="bg-bg-secondary rounded px-2 py-1.5 text-center"><div className="text-sm font-mono font-bold text-text-primary">{tc}</div><div className="text-[9px] text-text-tertiary">{t('office.panel.calls')}</div></div><div className="bg-bg-secondary rounded px-2 py-1.5 text-center"><div className="text-sm font-mono font-bold text-accent-green">{tc>0?Math.round((co/tc)*100):0}%</div><div className="text-[9px] text-text-tertiary">{t('office.panel.success')}</div></div></div>
          {tt.length>0&&<div className="space-y-0.5">{tt.map(([tool,cnt])=><div key={tool} className="flex items-center justify-between px-1.5 py-0.5 text-[10px]"><span className="font-mono text-text-secondary truncate flex-1">{tool}</span><span className="font-mono text-text-primary ml-2">{cnt}</span></div>)}</div>}<button onClick={() => void runAction('tool-summary', () => sendSessionPrompt(sessionId!, 'summarize recent tool usage, failures, and recommended tool actions'), t('office.toast.toolSummary'))} disabled={busy !== null} className="mt-2 rounded bg-accent-orange/10 px-2 py-1 text-[10px] text-accent-orange hover:bg-accent-orange/20 disabled:opacity-40">{t('office.action.askToolSummary')}</button></div>
        <div className="px-3 py-2"><div className="flex items-center gap-1.5 mb-1.5"><Activity size={13} className="text-accent-cyan"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.externalAgents')}</span></div>
          <div className="space-y-1 max-h-[140px] overflow-y-auto">{agents.filter((a)=>a.backend==='claude'||a.backend==='codex').map((agent)=>{const conv=agentConversations[agent.agentId];const s=conv?.status||agent.status;return <button key={agent.agentId} onClick={()=>{setFocusAgentId(agent.agentId);setAreaInfoOpen(false);}} className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-secondary"><span className={`w-1.5 h-1.5 rounded-full ${s==='running'?'bg-accent-brand animate-pulse':s==='completed'?'bg-accent-green':'bg-text-tertiary'}`}/><span className="text-xs text-text-primary truncate flex-1">{agent.agentName}</span><span className="text-[9px] text-text-tertiary font-mono">{agent.backend}</span></button>;})}</div></div>
      </>);}

      // REVIEW
      if (k === 'review') { const evV = orchestrationStatus?.eventHistory?.filter((ev)=>ev.nodeKind==='evaluate'||ev.verdict)||[];const p=evV.filter((e)=>e.verdict==='PASS').length;const fl=evV.filter((e)=>e.verdict==='FAIL').length;return(<>
        <div className="px-3 py-2 border-b border-border-default"><div className="flex items-center gap-1.5 mb-2"><CheckCircle2 size={13} className="text-accent-yellow"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.evaluationVerdicts')}</span></div>
          <div className="grid grid-cols-3 gap-1.5 mb-2"><div className="bg-bg-secondary rounded px-2 py-1.5 text-center"><div className="text-sm font-mono font-bold text-text-primary">{evV.length}</div><div className="text-[9px] text-text-tertiary">{t('office.panel.total')}</div></div><div className="bg-bg-secondary rounded px-2 py-1.5 text-center"><div className="text-sm font-mono font-bold text-accent-green">{p}</div><div className="text-[9px] text-text-tertiary">{t('office.panel.passed')}</div></div><div className="bg-bg-secondary rounded px-2 py-1.5 text-center"><div className="text-sm font-mono font-bold text-accent-red">{fl}</div><div className="text-[9px] text-text-tertiary">{t('office.panel.failed')}</div></div></div></div>
        <div className="px-3 py-2"><div className="flex items-center gap-1.5 mb-1.5"><XCircle size={13} className="text-accent-red"/><span className="text-[11px] font-medium text-text-primary">{t('office.panel.failedAgents')}</span></div>
          <div className="space-y-1.5 max-h-[180px] overflow-y-auto">{agentsInArea.filter((a)=>(agentConversations[a.agentId]?.status||a.status)==='failed').map((agent)=>{const conv=agentConversations[agent.agentId];const err=conv?.lastError;const diag=conv?.diagnostics;const rec=conv?.recovery;return <button key={agent.agentId} onClick={()=>{setFocusAgentId(agent.agentId);setAreaInfoOpen(false);}} className="w-full px-2 py-1.5 rounded bg-accent-red/5 hover:bg-accent-red/10 border border-accent-red/10"><div className="flex items-center gap-1.5"><XCircle size={10} className="text-accent-red"/><span className="text-xs text-text-primary font-medium truncate flex-1">{agent.agentName}</span>{rec?.recoverable&&<span className="text-[9px] text-accent-yellow font-mono">RECOVERABLE</span>}</div>{err&&<div className="text-[10px] text-accent-red/80 truncate mt-0.5">{err}</div>}{diag?.stderrTail?.length?<div className="text-[9px] text-text-tertiary font-mono truncate mt-0.5">{t('office.panel.stderr')}: {diag.stderrTail.join('').slice(0,60)}</div>:null}<div className="mt-1 flex gap-1"><span onClick={(e)=>{e.stopPropagation(); void askAgent(agent.agentName, 'propose concrete recovery steps for your failure');}} className="rounded bg-accent-red/10 px-1.5 py-0.5 text-[9px] text-accent-red hover:bg-accent-red/20">{t('office.action.askRecovery')}</span></div></button>;})}</div></div>
      </>);}

      // OBSERVABILITY
      if (k === 'observability') {
        const ctx = contextRuntimeState;
        if (!ctx) return null;
        const cp = Math.min(100, (ctx!.currentTokens / ctx!.maxTokens) * 100);
        const wc = ctx!.warningLevel === 'critical' ? 'bg-accent-red' : ctx!.warningLevel === 'warning' ? 'bg-accent-yellow' : 'bg-accent-green';
        return (<>
          <div className="px-3 py-2 border-b border-border-default">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="bg-bg-secondary rounded px-2 py-1.5">
                <div className="text-[9px] text-text-tertiary uppercase mb-0.5">{t('office.panel.phase')}</div>
                <div className="text-sm font-mono font-bold text-accent-brand">{phase}</div>
              </div>
              <div className="bg-bg-secondary rounded px-2 py-1.5">
                <div className="text-[9px] text-text-tertiary uppercase mb-0.5">{t('office.panel.connection')}</div>
                <div className="text-sm font-mono font-bold text-accent-green">{isConnected ? 'CONNECTED' : 'DISCONNECTED'}</div>
              </div>
            </div>
          </div>
          <div className="px-3 py-2 border-b border-border-default">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap size={13} className="text-accent-yellow" />
              <span className="text-[11px] font-medium text-text-primary">{t('office.panel.tokenUsage')}</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]"><span className="text-text-tertiary">{t('office.panel.total')}</span><span className="font-mono text-text-primary">{(tokenUsage.total/1000).toFixed(0)}K</span></div>
              <div className="flex justify-between text-[10px]"><span className="text-text-tertiary">{t('office.panel.prompt')}</span><span className="font-mono text-text-primary">{(tokenUsage.prompt/1000).toFixed(0)}K</span></div>
              <div className="flex justify-between text-[10px]"><span className="text-text-tertiary">{t('office.panel.completion')}</span><span className="font-mono text-text-primary">{(tokenUsage.completion/1000).toFixed(0)}K</span></div>
            </div>
          </div>
          {(() => {
            if (!ctx) return null;
            return (
            <div className="px-3 py-2 border-b border-border-default">
              <div className="flex items-center gap-1.5 mb-1.5">
                <BarChart3 size={13} />
                <span className="text-[11px] font-medium text-text-primary">{t('office.panel.contextWindow')}</span>
                <span className="text-[9px] font-mono px-1 rounded bg-bg-secondary">{ctx!.warningLevel}</span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[10px]"><span className="text-text-tertiary">{t('office.panel.current')}</span><span className="font-mono text-text-primary">{(ctx!.currentTokens/1000).toFixed(1)}K</span></div>
                <div className="flex justify-between text-[10px]"><span className="text-text-tertiary">{t('office.panel.max')}</span><span className="font-mono text-text-primary">{(ctx!.maxTokens/1000).toFixed(0)}K</span></div>
                <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${wc}`} style={{ width: `${cp}%` }} />
                </div>
              </div>
            </div>
          );
          })()}
          <div className="px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertTriangle size={13} className="text-accent-red" />
              <span className="text-[11px] font-medium text-text-primary">{t('office.panel.health')}</span>
            </div>
            <div className="space-y-1">
              <button onClick={() => { if (window.confirm(t('office.confirm.compact'))) void runAction('compact', () => runSlashCommand('/compact'), t('office.toast.compact')); }} disabled={busy !== null} className="w-full rounded bg-accent-yellow/10 px-2 py-1 text-[10px] text-accent-yellow hover:bg-accent-yellow/20 disabled:opacity-40">{t('office.action.compactContext')}</button>
              <button onClick={() => void runAction('health', () => sendSessionPrompt(sessionId!, 'summarize current health, context usage, token usage, and risks briefly'), t('office.toast.healthSummary'))} disabled={busy !== null} className="w-full rounded bg-accent-brand/10 px-2 py-1 text-[10px] text-accent-brand hover:bg-accent-brand/20 disabled:opacity-40">{t('office.action.askHealthSummary')}</button>
              {(() => {
                if (!watchdogAlert) return null;
                return (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-accent-red/10 border border-accent-red/20">
                  <AlertTriangle size={11} className="text-accent-red" />
                  <div className="text-[10px] text-text-secondary flex-1">
                    <span className="font-medium">{watchdogAlert!.intervention}</span>
                    <span className="text-text-tertiary ml-1">({Math.round(watchdogAlert!.elapsedMs/1000)}s ago)</span>
                  </div>
                </div>
              );
              })()}
              {(() => {
                if (!progressStagnant) return null;
                return (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-accent-yellow/10 border border-accent-yellow/20">
                  <Activity size={11} className="text-accent-yellow" />
                  <div className="text-[10px] text-text-secondary">Progress stagnated ({progressStagnant!.consecutiveRounds} rounds)</div>
                </div>
              );
              })()}
              {!watchdogAlert && !progressStagnant && (
                <div className="text-[10px] text-accent-green text-center py-2">
                  <CheckCircle2 size={10} className="inline-block mr-1" />{t('office.action.allHealthy')}
                </div>
              )}
            </div>
          </div>
        </>);
      }
    }
    return null;
  };

  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-sm w-full">
      <div className="bg-bg-primary/95 backdrop-blur-sm rounded-lg border border-border-default shadow-xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default"><MapPin size={14} className="text-accent-brand"/><span className="text-sm font-semibold text-text-primary flex-1">{area.name}</span><span className="text-[10px] font-mono text-text-tertiary uppercase bg-bg-secondary px-1.5 py-0.5 rounded">{area.kind}</span><button onClick={()=>setAreaInfoOpen(false)} className="p-1 rounded hover:bg-bg-secondary text-text-tertiary hover:text-text-primary"><X size={14}/></button></div>
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border-default text-[11px] text-text-tertiary">
          <span className="flex items-center gap-1"><Users size={11}/><span className="font-mono">{areaStats.total}</span></span>
          {areaStats.r>0&&<span className="flex items-center gap-1 text-accent-brand"><Loader2 size={10} className="animate-spin"/><span className="font-mono">{areaStats.r}</span></span>}
          {areaStats.c>0&&<span className="flex items-center gap-1 text-accent-green"><CheckCircle2 size={10}/><span className="font-mono">{areaStats.c}</span></span>}
          {areaStats.f>0&&<span className="flex items-center gap-1 text-accent-red"><XCircle size={10}/><span className="font-mono">{areaStats.f}</span></span>}
          {areaStats.tk>0&&<span className="ml-auto flex items-center gap-1"><Zap size={10} className="text-accent-yellow"/><span className="font-mono">{(areaStats.tk/1000).toFixed(1)}K</span></span>}
        </div>
        {renderZoneContent()}
      </div>
    </div>
  );
}
