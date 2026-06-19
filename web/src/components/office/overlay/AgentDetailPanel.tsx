/**
 * AgentDetailPanel — 点击角色弹出的详情面板（Activity / Tools / Stats 三 tab）
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore } from '../stores/officeStore';
import { cancelSession, getErrorMessage, runSlashCommand, sendAgentPrompt, sendNudge } from '../officeActions';
import { X, Zap, MessageSquare, Wrench, CheckCircle2, XCircle, Loader2, Activity, BarChart3, AlertTriangle } from 'lucide-react';

type Tab = 'activity' | 'tools' | 'stats';

export default function AgentDetailPanel() {
  const { t } = useTranslation();
  const { selectedAgentId, detailPanelOpen, selectAgent, setActionStatus } = useOfficeStore();
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const agents = useSessionStore((s) => s.agents);
  const sessionId = useSessionStore((s) => s.sessionId);
  const [tab, setTab] = useState<Tab>('activity');
  const [nudgeText, setNudgeText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const conv = selectedAgentId ? agentConversations[selectedAgentId] : null;
  const agent = selectedAgentId ? agents.find((a) => a.agentId === selectedAgentId) : null;
  const displayName = conv?.agentName || agent?.agentName || '';
  const role = conv?.role || agent?.role || 'worker';
  const status = conv?.status || agent?.status || 'idle';
  const messages = conv?.messages || [];

  if (!detailPanelOpen || !selectedAgentId || !displayName) return null;

  const sc = status === 'running' ? 'text-accent-brand' : status === 'completed' ? 'text-accent-green' : status === 'failed' ? 'text-accent-red' : 'text-text-tertiary';
  const tcs = messages.filter((m) => m.type === 'tool_call');
  const trs = messages.filter((m) => m.type === 'tool_result');
  const tabs: Tab[] = ['activity', 'tools', 'stats'];

  const runAction = async (kind: string, action: () => Promise<void>, success: string) => {
    if (!sessionId || busy) return;
    setBusy(kind);
    try {
      await action();
      setActionStatus({ kind: 'success', message: success });
      if (kind === 'nudge') setNudgeText('');
    } catch (error) {
      setActionStatus({ kind: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const interrupt = () => {
    if (!window.confirm(t('office.confirm.interrupt'))) return;
    void runAction('cancel', () => cancelSession(sessionId!), t('office.toast.interrupt'));
  };

  const compact = () => {
    if (!window.confirm(t('office.confirm.compact'))) return;
    void runAction('compact', () => runSlashCommand('/compact'), t('office.toast.compact'));
  };

  return (
    <div className="absolute top-2 right-2 bottom-2 w-80 z-20 bg-bg-primary/95 backdrop-blur-sm rounded-lg border border-border-default flex flex-col overflow-hidden shadow-lg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${sc} ${status==='running'?'animate-pulse':''}`} style={{boxShadow:status==='running'?'0 0 8px var(--color-accent-brand)':'none'}} />
        <span className="text-sm font-medium text-text-primary truncate flex-1">{displayName}</span>
        <span className="text-[10px] font-mono text-text-tertiary px-1.5 py-0.5 rounded bg-bg-secondary">{role}</span>
        {agent?.backend && <span className="text-[9px] font-mono text-accent-brand bg-accent-brand/10 px-1 py-0.5 rounded">{agent.backend}</span>}
        <button onClick={() => selectAgent(null)} className="p-1 rounded hover:bg-bg-secondary text-text-tertiary hover:text-text-primary"><X size={14} /></button>
      </div>
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border-default text-[10px] text-text-tertiary shrink-0">
        <span className="flex items-center gap-1"><Zap size={9} className="text-accent-yellow" />{conv?.tokenUsage ? `${(conv.tokenUsage.total / 1000).toFixed(1)}K` : '0'}</span>
        <span className="flex items-center gap-1"><MessageSquare size={9} />{messages.filter(m=>m.type==='text').length}</span>
        <span className="flex items-center gap-1"><Wrench size={9} />{tcs.length}</span>
        {conv?.taskId && <span className="ml-auto text-[8px] font-mono truncate max-w-[60px]">#{conv.taskId.slice(-8)}</span>}
      </div>
      <div className="border-b border-border-default px-3 py-2 shrink-0">
        <div className="mb-2 flex flex-wrap gap-1.5">
          <button onClick={() => void runAction('status', () => sendAgentPrompt(sessionId!, displayName, 'report current status briefly'), t('office.toast.status', { name: displayName }))} disabled={busy !== null} className="rounded bg-accent-brand/10 px-2 py-1 text-[10px] text-accent-brand hover:bg-accent-brand/20 disabled:opacity-40">{t('office.action.askStatus')}</button>
          <button onClick={interrupt} disabled={busy !== null} className="rounded bg-accent-red/10 px-2 py-1 text-[10px] text-accent-red hover:bg-accent-red/20 disabled:opacity-40">{t('office.action.interrupt')}</button>
          <button onClick={compact} disabled={busy !== null} className="rounded bg-accent-yellow/10 px-2 py-1 text-[10px] text-accent-yellow hover:bg-accent-yellow/20 disabled:opacity-40">{t('office.action.compact')}</button>
        </div>
        <div className="flex gap-1.5">
          <input value={nudgeText} onChange={(e) => setNudgeText(e.target.value)} placeholder={t('office.placeholder.nudge')} className="min-w-0 flex-1 rounded border border-border-default bg-bg-secondary px-2 py-1 text-[10px] text-text-primary outline-none placeholder:text-text-tertiary" />
          <button onClick={() => nudgeText.trim() && void runAction('nudge', () => sendNudge(sessionId!, `@${displayName} ${nudgeText.trim()}`), t('office.toast.nudge', { name: displayName }))} disabled={!nudgeText.trim() || busy !== null} className="rounded bg-accent-purple/10 px-2 py-1 text-[10px] text-accent-purple hover:bg-accent-purple/20 disabled:opacity-40">{t('office.action.nudge')}</button>
        </div>
      </div>
      <div className="flex border-b border-border-default shrink-0">
        {tabs.map((tabKey) => (
          <button key={tabKey} onClick={() => setTab(tabKey)} className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-medium ${tab===tabKey ? 'text-accent-brand border-b-2 border-accent-brand bg-accent-brand/5' : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'}`}>
            {tabKey==='activity'?<Activity size={10}/>:tabKey==='tools'?<Wrench size={10}/>:<BarChart3 size={10}/>}
            <span className="uppercase tracking-wider">{tabKey}</span>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {tab === 'activity' && (messages.length === 0 ? <div className="text-center text-text-tertiary text-xs py-8">{conv ? t('office.empty.noActivity') : t('office.empty.waitingActivity')}</div> : messages.slice(-40).map((msg) => (
          <div key={msg.id} className="text-[11px]">
            {msg.type==='text'&&<div className="text-text-secondary leading-relaxed whitespace-pre-wrap break-words">{msg.content.slice(0,300)}</div>}
            {msg.type==='thinking'&&<div className="text-accent-yellow/60 italic">{msg.content.slice(0,200)}</div>}
            {msg.type==='tool_call'&&<div className="flex items-center gap-1 text-accent-purple/80 font-mono"><Wrench size={9}/>{msg.tool||'tool'}</div>}
            {msg.type==='tool_result'&&<div className="text-text-tertiary font-mono pl-3 border-l border-border-default">{msg.content.slice(0,150)}</div>}
            {msg.type==='status'&&<div className="text-text-tertiary text-[10px] uppercase tracking-wider">{msg.content}</div>}
          </div>
        )))}
        {tab === 'tools' && (tcs.length === 0 ? <div className="text-center text-text-tertiary text-xs py-8">{t('office.empty.noToolCalls')}</div> : tcs.slice(-20).reverse().map((tc) => {
          const result = trs.find(r => r.tool === tc.tool);
          return <div key={tc.id} className="bg-bg-secondary/50 rounded p-2"><div className="flex items-center gap-1.5 mb-0.5"><Wrench size={9} className="text-accent-purple"/><span className="font-mono text-accent-purple text-[10px] font-medium">{tc.tool}</span>{result&&<CheckCircle2 size={9} className="text-accent-green ml-auto"/>}</div><div className="text-[9px] font-mono text-text-tertiary truncate">{typeof tc.content==='string'?tc.content.slice(0,100):JSON.stringify(tc.content).slice(0,100)}</div></div>;
        }))}
        {tab === 'stats' && (<div className="space-y-2">
            <div><div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1 font-medium">{t('office.panel.tokens')}</div>
              <div className="grid grid-cols-2 gap-1">{(['prompt','completion','total']as const).map((k)=>{const v=conv?.tokenUsage?.[k]??0;return <div key={k} className="bg-bg-secondary rounded px-2 py-1"><div className="text-[8px] text-text-tertiary uppercase">{k==='prompt'?t('office.panel.prompt'):k==='completion'?t('office.panel.completion'):t('office.panel.total')}</div><div className="text-[11px] font-mono text-text-primary">{v>=1000?`${(v/1000).toFixed(1)}K`:v}</div></div>;})}</div></div>
            <div><div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1 font-medium">{t('office.panel.metadata')}</div>
              <div className="space-y-0.5 text-[10px]">{(['Status','Backend','Task','PID','Context']as const).map((l)=>{const v=l==='Status'?status:l==='Backend'?conv?.backend||agent?.backend||'-':l==='Task'?conv?.taskId||agent?.taskId||'-':l==='PID'?conv?.pid:l==='Context'?conv?.contextRatio?`${Math.round(conv.contextRatio*100)}%`:'-':'';if(!v||v==='-')return null;return <div key={l} className="flex justify-between px-2 py-1 bg-bg-secondary rounded"><span className="text-text-tertiary">{l}</span><span className="font-mono text-text-primary truncate max-w-[140px]">{String(v)}</span></div>;})}</div></div>
            {conv?.lastError && <div className="bg-accent-red/10 rounded p-2 border border-accent-red/20 text-[10px]"><div className="flex items-center gap-1 text-accent-red"><AlertTriangle size={9}/>{t('office.panel.stderror')}</div><div className="text-[9px] text-text-secondary mt-0.5">{conv.lastError}</div></div>}
        </div>)}
      </div>
    </div>
  );
}
