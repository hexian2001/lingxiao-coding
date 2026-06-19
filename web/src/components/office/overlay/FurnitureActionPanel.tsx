import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useOfficeStore } from '../stores/officeStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { approvePlan, getErrorMessage, rejectPlan, runSlashCommand, sendAgentPrompt, sendSessionPrompt } from '../officeActions';
import { Activity, AlertTriangle, CheckCircle2, Coffee, GitBranch, Send, Server, Sofa, Terminal, Wrench, X, XCircle, Zap } from 'lucide-react';

export default function FurnitureActionPanel() {
  const { t } = useTranslation();
  const { furnitureAction, closeFurnitureAction, setActionStatus, selectArea, setAreaInfoOpen } = useOfficeStore();
  const sessionId = useSessionStore((s) => s.sessionId);
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const [input, setInput] = useState('');
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const failedAgents = useMemo(() => agents.filter((a) => (agentConversations[a.agentId]?.status || a.status) === 'failed'), [agents, agentConversations]);
  const runningAgents = useMemo(() => agents.filter((a) => (agentConversations[a.agentId]?.status || a.status) === 'running'), [agents, agentConversations]);

  if (!furnitureAction) return null;

  const run = async (kind: string, action: () => Promise<void>, success: string) => {
    if (!sessionId || busy) return;
    setBusy(kind);
    try {
      await action();
      setActionStatus({ kind: 'success', message: success });
      if (kind !== 'reject') closeFurnitureAction();
    } catch (error) {
      setActionStatus({ kind: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const openArea = (areaId: string) => {
    selectArea(areaId);
    setAreaInfoOpen(true);
    closeFurnitureAction();
  };

  const compact = () => {
    if (!window.confirm(t('office.confirm.compactSlash'))) return;
    void run('compact', () => runSlashCommand('/compact'), t('office.toast.compact'));
  };

  const askDiagnostics = (agentName: string) => run('diag', () => sendAgentPrompt(sessionId!, agentName, 'summarize your current diagnostics, recent errors, and recovery state'), t('office.toast.diagnose', { name: agentName }));
  const askRecovery = (agentName: string) => run('recover', () => sendAgentPrompt(sessionId!, agentName, 'propose concrete recovery steps for your failure'), t('office.toast.recover', { name: agentName }));

  const title = getTitle(furnitureAction.type, t);

  return (
    <div className="absolute left-1/2 top-16 z-40 w-[28rem] -translate-x-1/2 rounded-lg border border-accent-yellow/50 bg-bg-primary/95 shadow-2xl backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-border-default px-3 py-2">
        {getIcon(furnitureAction.type)}
        <div className="flex-1">
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className="font-mono text-[9px] text-text-tertiary">tile {furnitureAction.x}, {furnitureAction.y} · real backend-linked actions</div>
        </div>
        <button onClick={closeFurnitureAction} className="rounded p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"><X size={14} /></button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-3 text-xs text-text-secondary">
        {renderContent()}
      </div>
    </div>
  );

  function renderContent() {
    switch (furnitureAction!.type) {
      case 'terminal':
        return <ActionBox label={t('office.title.terminal')} note={t('office.note.terminal')}><PromptInput value={input} onChange={setInput} placeholder={t('office.placeholder.terminal')} onSend={() => run('terminal', () => sendSessionPrompt(sessionId!, input.trim()), t('office.toast.terminalIntent'))} busy={busy !== null} /></ActionBox>;
      case 'server':
        return <AgentDiagnostics agents={runningAgents.length ? runningAgents : agents} ask={askDiagnostics} busy={busy !== null} />;
      case 'coffee':
        return <ActionBox label={t('office.title.coffee')} note={t('office.note.coffee')}><button onClick={compact} disabled={busy !== null} className="rounded border border-accent-yellow/40 bg-accent-yellow/10 px-3 py-1.5 text-accent-yellow hover:bg-accent-yellow/20 disabled:opacity-40"><Coffee size={12} className="mr-1 inline" />{t('office.action.compactContext')}</button></ActionBox>;
      case 'elevator':
        return <ActionBox label={t('office.title.elevator')} note={t('office.note.elevator')}><PromptInput value={input} onChange={setInput} placeholder={t('office.placeholder.dispatch')} onSend={() => run('dispatch', () => sendSessionPrompt(sessionId!, input.trim()), t('office.toast.newTask'))} busy={busy !== null} /></ActionBox>;
      case 'conference_table':
        return <div className="space-y-3"><ActionBox label={t('office.title.conferenceTable')} note={t('office.note.plan')}><div className="flex gap-2"><button onClick={() => { if (window.confirm(t('office.confirm.approve'))) void run('approve', approvePlan, t('office.toast.approved')); }} disabled={busy !== null} className="rounded bg-accent-green/15 px-3 py-1.5 text-accent-green hover:bg-accent-green/25 disabled:opacity-40"><CheckCircle2 size={12} className="mr-1 inline" />{t('office.action.approve')}</button></div><textarea value={rejectFeedback} onChange={(e) => setRejectFeedback(e.target.value)} placeholder={t('office.placeholder.rejectReason')} className="mt-2 h-16 w-full resize-none rounded border border-border-default bg-bg-secondary px-2 py-1 text-xs outline-none" /><button onClick={() => { if (rejectFeedback.trim() && window.confirm(t('office.confirm.reject'))) void run('reject', () => rejectPlan(rejectFeedback.trim()), t('office.toast.rejected')); }} disabled={!rejectFeedback.trim() || busy !== null} className="mt-1 rounded bg-accent-red/15 px-3 py-1.5 text-accent-red hover:bg-accent-red/25 disabled:opacity-40"><XCircle size={12} className="mr-1 inline" />{t('office.action.reject')}</button></ActionBox></div>;
      case 'whiteboard':
      case 'bookshelf':
        return <ActionBox label={t('office.title.whiteboard')} note={t('office.note.board')}><div className="flex flex-wrap gap-2"><button onClick={() => openArea('planning')} className="rounded bg-bg-secondary px-3 py-1.5 text-text-primary hover:bg-bg-tertiary">{t('office.action.openPlanningArea')}</button><button onClick={() => run('plan-summary', () => sendSessionPrompt(sessionId!, 'summarize the current plan and orchestration state briefly'), t('office.toast.planSummary'))} disabled={busy !== null} className="rounded bg-accent-purple/15 px-3 py-1.5 text-accent-purple hover:bg-accent-purple/25 disabled:opacity-40"><GitBranch size={12} className="mr-1 inline" />{t('office.action.summarizePlan')}</button></div></ActionBox>;
      case 'toolbench':
        return <ActionBox label={t('office.title.toolbench')} note={t('office.note.toolLab')}><button onClick={() => run('tool-summary', () => sendSessionPrompt(sessionId!, 'summarize recent tool usage, failures, and recommended tool actions'), t('office.toast.toolSummary'))} disabled={busy !== null} className="rounded bg-accent-orange/15 px-3 py-1.5 text-accent-orange hover:bg-accent-orange/25 disabled:opacity-40"><Wrench size={12} className="mr-1 inline" />{t('office.action.askToolSummary')}</button></ActionBox>;
      case 'sofa':
        return <AgentDiagnostics agents={failedAgents} ask={askRecovery} busy={busy !== null} empty={t('office.empty.noFailedAgents')} />;
      default:
        return <ActionBox label={t('office.title.default')} note={t('office.note.officeLink')}><button onClick={() => openArea('observability')} className="rounded bg-bg-secondary px-3 py-1.5 text-text-primary hover:bg-bg-tertiary">{t('office.action.openObservability')}</button></ActionBox>;
    }
  }
}

function ActionBox({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return <div className="rounded border border-border-default bg-bg-secondary/40 p-3"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-accent-yellow">{label}</div><div className="mb-3 text-[10px] text-text-tertiary">{note}</div>{children}</div>;
}

function PromptInput({ value, onChange, onSend, placeholder, busy }: { value: string; onChange: (v: string) => void; onSend: () => void; placeholder: string; busy: boolean }) {
  const { t } = useTranslation();
  return <div className="space-y-2"><textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-20 w-full resize-none rounded border border-border-default bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary" /><button onClick={onSend} disabled={!value.trim() || busy} className="rounded bg-accent-brand/15 px-3 py-1.5 text-accent-brand hover:bg-accent-brand/25 disabled:opacity-40"><Send size={12} className="mr-1 inline" />{t('office.action.send')}</button></div>;
}

function AgentDiagnostics({ agents, ask, busy, empty = '' }: { agents: ReturnType<typeof useSessionStore.getState>['agents']; ask: (agentName: string) => void; busy: boolean; empty?: string }) {
  const { t } = useTranslation();
  const agentConversations = useSessionStore((s) => s.agentConversations);
  if (agents.length === 0) return <div className="rounded border border-border-default bg-bg-secondary/40 p-3 text-center text-text-tertiary">{empty || t('office.empty.noAgentsAvailable')}</div>;
  return <div className="space-y-2">{agents.slice(0, 8).map((agent) => { const conv = agentConversations[agent.agentId]; const diag = conv?.diagnostics; const err = conv?.lastError; return <div key={agent.agentId} className="rounded border border-border-default bg-bg-secondary/40 p-2"><div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${(conv?.status || agent.status) === 'running' ? 'bg-accent-brand animate-pulse' : (conv?.status || agent.status) === 'failed' ? 'bg-accent-red' : 'bg-text-tertiary'}`} /><span className="flex-1 truncate text-xs font-medium text-text-primary">{agent.agentName}</span><button onClick={() => ask(agent.agentName)} disabled={busy} className="rounded bg-accent-brand/10 px-2 py-1 text-[10px] text-accent-brand hover:bg-accent-brand/20 disabled:opacity-40">{t('office.action.ask')}</button></div>{err && <div className="mt-1 truncate text-[10px] text-accent-red">{err}</div>}{diag?.stderrTail?.length ? <div className="mt-1 truncate font-mono text-[9px] text-text-tertiary">{t('office.panel.stderr')}: {diag.stderrTail.join('').slice(0, 100)}</div> : null}{conv?.recovery?.recoverable && <div className="mt-1 text-[9px] text-accent-yellow">{t('office.panel.recoverable')}: {conv.recovery.recoveryAction || 'yes'}</div>}</div>; })}</div>;
}

function getTitle(type: string, t: (key: string) => string): string {
  const titles: Record<string, string> = { terminal: t('office.title.terminal'), server: t('office.title.server'), coffee: t('office.title.coffee'), elevator: t('office.title.elevator'), conference_table: t('office.title.conferenceTable'), whiteboard: t('office.title.whiteboard'), bookshelf: t('office.title.bookshelf'), toolbench: t('office.title.toolbench'), sofa: t('office.title.sofa') };
  return titles[type] || t('office.title.default');
}

function getIcon(type: string) {
  if (type === 'terminal') return <Terminal size={15} className="text-accent-green" />;
  if (type === 'server') return <Server size={15} className="text-accent-cyan" />;
  if (type === 'coffee') return <Coffee size={15} className="text-accent-yellow" />;
  if (type === 'sofa') return <Sofa size={15} className="text-accent-purple" />;
  if (type === 'toolbench') return <Wrench size={15} className="text-accent-orange" />;
  if (type === 'conference_table' || type === 'whiteboard' || type === 'bookshelf') return <GitBranch size={15} className="text-accent-purple" />;
  return <Zap size={15} className="text-accent-yellow" />;
}
