/**
 * VerdictRepairChain — P3: Repair chain causal tracking view.
 *
 * Renders the orchestration eventHistory as a structured repair chain,
 * showing generation/agent/repairCount for each event.
 */
import { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { Wrench, CheckCircle, XCircle, RotateCcw, GitBranch, AlertTriangle } from 'lucide-react';

interface ChainEntry {
  kind: string;
  eventType: string;
  taskId?: string;
  nodeKind?: string;
  verdict?: string;
  reason?: string;
  ts: number;
  generation?: number;
  agentName?: string;
  repairCount?: number;
}

const KIND_ICON: Record<string, typeof CheckCircle> = {
  applied: CheckCircle,
  rejected: XCircle,
  repair: Wrench,
  reset: RotateCcw,
  node: GitBranch,
};

const KIND_COLOR: Record<string, string> = {
  applied: 'text-green-500',
  rejected: 'text-red-500',
  repair: 'text-orange-500',
  reset: 'text-blue-500',
  node: 'text-gray-400',
};

export default function VerdictRepairChain() {
  const eventHistory = useSessionStore((s) => s.orchestrationStatus?.eventHistory ?? []);

  const chain = useMemo(() => {
    // Group events by taskId to form repair chains
    const byTask = new Map<string, ChainEntry[]>();
    for (const entry of eventHistory as ChainEntry[]) {
      if (!entry.taskId) continue;
      const list = byTask.get(entry.taskId) ?? [];
      list.push(entry);
      byTask.set(entry.taskId, list);
    }
    return Array.from(byTask.entries())
      .map(([taskId, entries]) => ({
        taskId,
        entries: entries.sort((a, b) => a.ts - b.ts),
        maxGeneration: Math.max(...entries.map((e) => e.generation ?? 0)),
        hasRepair: entries.some((e) => e.kind === 'repair' || e.repairCount),
        repairLimitReached: entries.some((e) => e.eventType === 'RepairLimitReached'),
      }))
      .sort((a, b) => b.entries[b.entries.length - 1].ts - a.entries[a.entries.length - 1].ts);
  }, [eventHistory]);

  if (chain.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
        <GitBranch className="w-3.5 h-3.5" />
        <span>Repair Chain</span>
      </div>
      {chain.map(({ taskId, entries, maxGeneration, hasRepair, repairLimitReached }) => (
        <div key={taskId} className="rounded-md border border-gray-200 dark:border-gray-700 p-2 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-gray-600 dark:text-gray-300">{taskId}</span>
            <div className="flex items-center gap-2">
              {maxGeneration > 0 && (
                <span className="text-orange-500 flex items-center gap-0.5">
                  <RotateCcw className="w-3 h-3" />
                  Gen {maxGeneration}
                </span>
              )}
              {hasRepair && (
                <span className="text-orange-500 flex items-center gap-0.5">
                  <Wrench className="w-3 h-3" />
                  Repair
                </span>
              )}
              {repairLimitReached && (
                <span className="text-red-500 flex items-center gap-0.5">
                  <AlertTriangle className="w-3 h-3" />
                  Limit
                </span>
              )}
            </div>
          </div>
          <div className="space-y-0.5">
            {entries.map((entry, i) => {
              const Icon = KIND_ICON[entry.kind] ?? GitBranch;
              const color = KIND_COLOR[entry.kind] ?? 'text-gray-400';
              return (
                <div key={i} className="flex items-start gap-1.5 text-xs">
                  <Icon className={`w-3 h-3 mt-0.5 shrink-0 ${color}`} />
                  <div className="flex-1 min-w-0">
                    <span className={`font-medium ${color}`}>{entry.eventType}</span>
                    {entry.verdict && entry.verdict !== 'UNKNOWN' && (
                      <span className={`ml-1 ${entry.verdict === 'PASS' ? 'text-green-500' : 'text-red-500'}`}>
                        {entry.verdict}
                      </span>
                    )}
                    {entry.agentName && (
                      <span className="ml-1 text-gray-400">@{entry.agentName}</span>
                    )}
                    {entry.repairCount !== undefined && entry.repairCount > 0 && (
                      <span className="ml-1 text-orange-400">×{entry.repairCount}</span>
                    )}
                    {entry.reason && (
                      <span className="ml-1 text-gray-400 truncate">{entry.reason}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
