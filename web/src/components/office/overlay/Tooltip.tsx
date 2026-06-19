/**
 * Tooltip — 悬停提示
 */
import { useOfficeStore } from '../stores/officeStore';
import { useSessionStore } from '../../../stores/sessionStore';

interface TAgent { name: string; role: string; status: string; }
interface Props { agents: Map<string, TAgent>; }

export default function Tooltip({ agents }: Props) {
  const { hoveredAgentId, tooltipPosition } = useOfficeStore();
  const agentConversations = useSessionStore((s) => s.agentConversations);
  if (!hoveredAgentId) return null;
  const a = agents.get(hoveredAgentId); if (!a) return null;
  const conv = agentConversations[hoveredAgentId];
  const sc = a.status==='working'?'text-emerald-400':a.status==='thinking'?'text-yellow-400':a.status==='completed'?'text-green-400':a.status==='failed'?'text-red-400':'text-gray-400';
  return (
    <div className="pointer-events-none fixed z-50 rounded bg-gray-900/90 px-2.5 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm min-w-[140px]" style={{ left: tooltipPosition.x + 12, top: tooltipPosition.y - 8 }}>
      <div className="font-medium text-sm">{a.name}</div><div className="text-gray-400 text-[10px]">{a.role}</div>
      <div className={`mt-0.5 text-[11px] font-mono font-medium ${sc}`}>{a.status.toUpperCase()}</div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400"><span>{conv?.messages?.length||0} msgs</span>{(conv?.tokenUsage?.total??0)>0 && <span>{((conv?.tokenUsage?.total??0)/1000).toFixed(1)}K tokens</span>}</div>
    </div>
  );
}
