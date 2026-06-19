/**
 * OrchestrationProgress — Command Center unified orchestration projection.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/sessionStore';
import { CheckCircle2, XCircle, Loader2, Zap, ChevronRight, Circle, GitBranch, RotateCcw, Wrench, Check, X, CircleSlash } from 'lucide-react';

const STATE_CONFIG = {
  idle:      { color: 'text-text-tertiary', bg: 'bg-text-tertiary/10', border: 'border-text-tertiary/20', icon: Circle,        labelKey: 'orchestration.state.idle' },
  planning:  { color: 'text-accent-purple', bg: 'bg-accent-purple/10', border: 'border-accent-purple/20', icon: GitBranch,     labelKey: 'orchestration.state.planning' },
  running:   { color: 'text-accent-brand',  bg: 'bg-accent-brand/10',  border: 'border-accent-brand/20',  icon: Loader2,      labelKey: 'orchestration.state.running' },
  blocked:   { color: 'text-accent-yellow', bg: 'bg-accent-yellow/10', border: 'border-accent-yellow/20', icon: Circle,        labelKey: 'orchestration.state.blocked' },
  completed: { color: 'text-accent-green',  bg: 'bg-accent-green/10',  border: 'border-accent-green/20',  icon: CheckCircle2, labelKey: 'orchestration.state.completed' },
  failed:    { color: 'text-accent-red',    bg: 'bg-accent-red/10',    border: 'border-accent-red/20',    icon: XCircle,      labelKey: 'orchestration.state.failed' },
  cancelled: { color: 'text-text-tertiary', bg: 'bg-text-tertiary/10', border: 'border-text-tertiary/20', icon: XCircle,      labelKey: 'orchestration.state.cancelled' },
} as const;

const EVENT_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  applied: Zap,
  rejected: XCircle,
  repair: Wrench,
  reset: RotateCcw,
  node: GitBranch,
};

export default function OrchestrationProgress() {
  const { t } = useTranslation();
  const orchestrationStatus = useSessionStore((s) => s.orchestrationStatus);
  const leaderStatusText = useSessionStore((s) => s.leaderStatusText);

  const rawStateKey = orchestrationStatus?.state ?? 'idle';
  const stateKey = rawStateKey in STATE_CONFIG ? rawStateKey as keyof typeof STATE_CONFIG : 'idle';
  const cfg = STATE_CONFIG[stateKey];
  const Icon = cfg.icon;

  const nodeFraction = useMemo(() => {
    const status = orchestrationStatus;
    if (!status || !status.totalNodes) return null;
    const completed = status.completedNodes ?? 0;
    const total = status.totalNodes;
    const failed = status.failedNodes ?? 0;
    const blocked = status.blockedNodes ?? 0;
    return { completed, total, failed, blocked, pct: total > 0 ? (completed / total) * 100 : 0 };
  }, [orchestrationStatus]);

  const recentEvents = useMemo(() => {
    const history = orchestrationStatus?.eventHistory ?? [];
    return [...history].reverse().slice(0, 8);
  }, [orchestrationStatus]);

  if (!orchestrationStatus) {
    return (
      <div className="px-4 py-2 border-b border-border-default text-[11px] text-text-tertiary flex items-center gap-2">
        <Circle size={10} className="opacity-40" />
        <span>{t('orchestration.notActive')}</span>
      </div>
    );
  }

  return (
    <div className="border-b border-border-default">
      <div className="px-4 py-2 flex items-center gap-3 bg-bg-secondary">
        <Icon
          size={12}
          className={`${cfg.color} ${stateKey === 'running' ? 'animate-spin' : ''}`}
        />
        <span className={`text-[11px] font-medium ${cfg.color}`}>
          {t('orchestration.title')}
        </span>

        {nodeFraction && (
          <>
            <div className="flex items-center gap-1.5 ml-2">
              <span className="text-[10px] text-accent-green font-mono flex items-center gap-0.5"><Check size={10} />{nodeFraction.completed}</span>
              {nodeFraction.failed > 0 && <span className="text-[10px] text-accent-red font-mono flex items-center gap-0.5"><X size={10} />{nodeFraction.failed}</span>}
              {nodeFraction.blocked > 0 && <span className="text-[10px] text-accent-yellow font-mono flex items-center gap-0.5"><CircleSlash size={10} />{nodeFraction.blocked}</span>}
            </div>
            <span className="text-[10px] text-text-tertiary font-mono">
              {nodeFraction.completed}/{nodeFraction.total}
            </span>
          </>
        )}

        {orchestrationStatus.eventCount != null && (
          <span className="text-[10px] text-text-tertiary font-mono flex items-center gap-0.5">
            <Zap size={9} className="text-accent-yellow" />
            {orchestrationStatus.eventCount}
          </span>
        )}

        {orchestrationStatus.generation != null && (
          <span className="text-[10px] text-text-tertiary font-mono ml-auto">
            gen={orchestrationStatus.generation}
          </span>
        )}

        <div className={`ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${cfg.bg} ${cfg.color}`}>
          <Icon size={8} className={stateKey === 'running' ? 'animate-spin' : ''} />
          {t(cfg.labelKey)}
        </div>
      </div>

      {nodeFraction && (
        <div className="px-4 py-1.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 bg-border-default rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-brand transition-all duration-500 rounded-full"
                style={{ width: `${nodeFraction.pct}%` }}
              />
            </div>
            <span className="text-[10px] text-text-tertiary font-mono shrink-0">
              {nodeFraction.completed}/{nodeFraction.total}
            </span>
          </div>
        </div>
      )}

      {recentEvents.length > 0 && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none text-[9px] font-mono">
            {recentEvents.map((event, i) => {
              const EventIcon = EVENT_ICONS[event.kind] ?? Zap;
              const colorClass =
                event.kind === 'applied' || event.kind === 'node'
                  ? 'text-accent-green'
                  : event.kind === 'rejected'
                    ? 'text-accent-red'
                    : 'text-accent-brand';
              // P0-6 (audit-2026-05-15)：先显示 eventType（NodeCreated/NodeDispatched/...），
              // 再把 nodeKind 当作小 chip（仅当不是 generic 才显示），verdict 仅当不是 UNKNOWN 才显示。
              const showNodeKind = event.nodeKind && event.nodeKind !== 'generic';
              const showVerdict = event.verdict && event.verdict !== 'UNKNOWN';
              return (
                <span key={i} className={`shrink-0 flex items-center gap-0.5 ${colorClass}`}>
                  <EventIcon size={8} />
                  <span>{event.eventType || event.nodeKind || event.kind}</span>
                  {showNodeKind && (
                    <span className="ml-0.5 px-1 rounded bg-bg-tertiary/60 text-text-tertiary">
                      {event.nodeKind}
                    </span>
                  )}
                  {showVerdict && <span className="text-text-tertiary/60">:{event.verdict}</span>}
                  {event.reason && (
                    <span className="text-accent-red/70 truncate max-w-[60px]" title={event.reason}>
                      :{event.reason.split(' ')[0]}
                    </span>
                  )}
                  {i < recentEvents.length - 1 && <ChevronRight size={7} className="text-text-tertiary/30 mx-0.5" />}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {(orchestrationStatus.summary || orchestrationStatus.bottleneck || leaderStatusText) && (
        <div className="px-4 pb-1.5 text-[10px] text-text-tertiary truncate">
          {orchestrationStatus.summary || orchestrationStatus.bottleneck || leaderStatusText}
        </div>
      )}
    </div>
  );
}
