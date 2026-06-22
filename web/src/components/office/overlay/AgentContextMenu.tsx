import { useState, type ReactNode } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore } from '../stores/officeStore';
import { cancelSession, getErrorMessage, sendAgentPrompt, sendNudge } from '../officeActions';
import { Activity, Crosshair, MessageSquare, Send, Square, X, Zap } from 'lucide-react';

export default function AgentContextMenu() {
  const { contextMenu, closeAgentContextMenu, selectAgent, setFocusAgentId, setActionStatus } = useOfficeStore();
  const agents = useSessionStore((s) => s.agents);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const sessionId = useSessionStore((s) => s.sessionId);
  const [nudge, setNudge] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Single early return to avoid Hook race conditions
  if (!contextMenu) return null;
  
  const agent = agents.find((a) => a.agentId === contextMenu.agentId);
  const conv = agentConversations[contextMenu.agentId];
  const name = conv?.agentName || agent?.agentName;
  
  // Guard against incomplete data but avoid second return null after Hooks
  if (!agent || !name) {
    // Render placeholder instead of null to keep Hook call chain stable
    return (
      <div className="fixed z-50 w-64 rounded-lg border border-border-muted bg-bg-primary/95 shadow-lg backdrop-blur-sm" style={{ left: contextMenu.x, top: contextMenu.y }}>
        <div className="flex items-center justify-center p-4 text-xs text-text-tertiary">
          Loading agent data...
        </div>
      </div>
    );
  }

  const run = async (kind: string, action: () => Promise<void>, success: string) => {
    if (!sessionId || busy) return;
    setBusy(kind);
    try {
      await action();
      setActionStatus({ kind: 'success', message: success });
      closeAgentContextMenu();
    } catch (error) {
      setActionStatus({ kind: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const askStatus = () => run('status', () => sendAgentPrompt(sessionId!, name, 'report current status briefly'), `已请求 ${name} 汇报状态`);
  const sendNudgeToAgent = () => {
    const text = nudge.trim();
    if (!text) return;
    return run('nudge', () => sendNudge(sessionId!, `@${name} ${text}`), `已向 ${name} 注入指导`);
  };
  const interrupt = () => {
    if (!window.confirm('这会中断当前会话/运行，不是单独中断某个 Agent。继续吗？')) return;
    void run('cancel', () => cancelSession(sessionId!), '已发送中断当前会话请求');
  };

  return (
    <div className="fixed z-50 w-64 rounded-lg border border-accent-yellow/50 bg-bg-primary/95 shadow-2xl backdrop-blur-sm" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="flex items-center gap-2 border-b border-border-default px-3 py-2">
        <Activity size={13} className="text-accent-yellow" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-text-primary">{name}</div>
          <div className="truncate font-mono text-[9px] text-text-tertiary">{agent.role} · {conv?.status || agent.status || 'idle'}</div>
        </div>
        <button onClick={closeAgentContextMenu} className="rounded p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"><X size={12} /></button>
      </div>

      <div className="p-1.5 space-y-1">
        <MenuButton icon={<MessageSquare size={12} />} label="Open Details / Message" onClick={() => { selectAgent(agent.agentId); closeAgentContextMenu(); }} />
        <MenuButton icon={<Crosshair size={12} />} label="Focus Camera" onClick={() => { setFocusAgentId(agent.agentId); closeAgentContextMenu(); }} />
        <MenuButton icon={<Send size={12} />} label="Ask for Status" disabled={busy !== null} onClick={askStatus} />
        <MenuButton icon={<Square size={12} />} label="Interrupt Current Session" danger disabled={busy !== null} onClick={interrupt} />
      </div>

      <div className="border-t border-border-default p-2">
        <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-text-tertiary"><Zap size={10} /> Nudge Agent</div>
        <textarea value={nudge} onChange={(e) => setNudge(e.target.value)} placeholder="给这个 Agent 注入非打断式指导..." className="h-16 w-full resize-none rounded border border-border-default bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none placeholder:text-text-tertiary" />
        <button onClick={sendNudgeToAgent} disabled={!nudge.trim() || busy !== null} className="mt-1 w-full rounded bg-accent-brand/15 px-2 py-1 text-[11px] text-accent-brand hover:bg-accent-brand/25 disabled:opacity-40">{busy === 'nudge' ? 'Sending...' : 'Send Nudge'}</button>
      </div>
    </div>
  );
}

function MenuButton({ icon, label, onClick, danger, disabled }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs disabled:opacity-40 ${danger ? 'text-accent-red hover:bg-accent-red/10' : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary'}`}>{icon}<span>{label}</span></button>;
}
