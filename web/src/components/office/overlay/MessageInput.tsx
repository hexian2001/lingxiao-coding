/**
 * MessageInput — 给角色发送消息
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../../stores/sessionStore';
import { useOfficeStore } from '../stores/officeStore';
import { Send } from 'lucide-react';

export default function MessageInput() {
  const { t } = useTranslation();
  const { selectedAgentId } = useOfficeStore();
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const agents = useSessionStore((s) => s.agents);
  const sessionId = useSessionStore((s) => s.sessionId);
  const [message, setMessage] = useState(''); const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedAgent = useMemo(() => agents.find((a) => a.agentId === selectedAgentId), [agents, selectedAgentId]);
  const conv = selectedAgentId ? agentConversations[selectedAgentId] : null;
  const targetName = conv?.agentName || selectedAgent?.agentName;

  useEffect(() => { if (targetName && inputRef.current) inputRef.current.focus(); }, [targetName]);
  if (!selectedAgentId || !targetName) return null;

  const handleSend = async () => {
    if (!message.trim() || !sessionId || sending) return;
    setSending(true);
    try { const { acpClient } = await import('../../../api/AcpClient'); await acpClient.sendJsonRpc('session/prompt', { sessionId, content: `@${targetName} ${message.trim()}` }); setMessage(''); } catch (err) { console.error(err); }
    finally { setSending(false); }
  };

  return (
    <div className="absolute bottom-28 right-2 w-80 z-20">
      <div className="bg-bg-primary/95 backdrop-blur-sm rounded-lg border border-border-default px-3 py-2 flex items-center gap-2 shadow-lg">
        <span className="text-[10px] text-text-tertiary shrink-0">@{targetName}</span>
        <input ref={inputRef} type="text" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend(); } }} placeholder={t('office.sendMessage','Send message...')} className="flex-1 rounded-md border border-border-input bg-bg-input px-2 py-1 text-sm text-text-primary placeholder:text-text-tertiary outline-none" disabled={sending} />
        <button onClick={handleSend} disabled={!message.trim() || sending} className="p-1 rounded hover:bg-bg-secondary text-accent-brand disabled:opacity-30"><Send size={14} /></button>
      </div>
    </div>
  );
}
