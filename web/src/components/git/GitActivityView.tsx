import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitCommitHorizontal, GitBranch, GitMerge, Upload, Download,
  CheckCircle2, XCircle, AlertTriangle, Clock, User, Trash2,
} from 'lucide-react';
import { useGitActivityStore, type GitActivityEvent } from '../../stores/gitActivityStore';
import { useSessionStore } from '../../stores/sessionStore';

const ACTION_ICONS: Record<GitActivityEvent['action'], React.ReactNode> = {
  commit: <GitCommitHorizontal size={14} />,
  push: <Upload size={14} />,
  pull: <Download size={14} />,
  branch_create: <GitBranch size={14} />,
  branch_switch: <GitBranch size={14} />,
  merge_mr: <GitMerge size={14} />,
  create_mr: <GitMerge size={14} />,
};

const ACTION_LABELS: Record<GitActivityEvent['action'], string> = {
  commit: 'Commit',
  push: 'Push',
  pull: 'Pull',
  branch_create: 'Branch+',
  branch_switch: 'Branch→',
  merge_mr: 'Merge MR',
  create_mr: 'Create MR',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border-muted bg-bg-card/60 px-4 py-3">
      <span className="text-[11px] text-text-tertiary uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-mono font-semibold ${accent || 'text-text-primary'}`}>{value}</span>
    </div>
  );
}

function AgentStats({ events }: { events: GitActivityEvent[] }) {
  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; commits: number; pushes: number; gatePasses: number; gateFails: number; lastActivity: number }>();
    for (const e of events) {
      const key = e.agentId;
      if (!map.has(key)) map.set(key, { name: e.agentName, commits: 0, pushes: 0, gatePasses: 0, gateFails: 0, lastActivity: 0 });
      const s = map.get(key)!;
      if (e.action === 'commit') {
        s.commits++;
        if (e.gateResult?.enabled) {
          if (e.gateResult.passed) s.gatePasses++;
          else s.gateFails++;
        }
      }
      if (e.action === 'push') s.pushes++;
      if (e.timestamp > s.lastActivity) s.lastActivity = e.timestamp;
    }
    return Array.from(map.values()).sort((a, b) => b.lastActivity - a.lastActivity);
  }, [events]);

  if (agentMap.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider px-1">Agent Activity</h3>
      <div className="flex flex-col gap-1.5">
        {agentMap.map((a) => (
          <div key={a.name} className="flex items-center gap-3 rounded-lg border border-border-muted bg-bg-card/40 px-3 py-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-brand/15 text-accent-brand shrink-0">
              <User size={13} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary truncate">{a.name}</span>
                <span className="text-[10px] text-text-tertiary">{formatRelative(a.lastActivity)}</span>
              </div>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-[10px] font-mono text-text-tertiary">
                  {a.commits} commits · {a.pushes} pushes
                </span>
                {a.gatePasses + a.gateFails > 0 && (
                  <span className={`text-[10px] font-mono ${a.gateFails > 0 ? 'text-accent-red' : 'text-green-400'}`}>
                    gate: {a.gatePasses}✓ {a.gateFails > 0 && `${a.gateFails}✗`}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityTimeline({ events }: { events: GitActivityEvent[] }) {
  const sorted = useMemo(() => [...events].sort((a, b) => b.timestamp - a.timestamp), [events]);

  if (sorted.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-tertiary py-16">
        <GitCommitHorizontal size={36} className="opacity-30" />
        <div className="text-sm">No git activity yet</div>
        <div className="text-xs text-text-tertiary">Git commits, pushes, and gate results from agents will appear here in real time.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-1">
      <div className="flex flex-col gap-1">
        {sorted.map((e) => {
          const isCommit = e.action === 'commit';
          const hasGateFail = e.gateResult && !e.gateResult.passed;
          return (
            <div
              key={e.id}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                e.success
                  ? hasGateFail
                    ? 'border-accent-yellow/30 bg-accent-yellow/5'
                    : 'border-border-muted bg-bg-card/40'
                  : 'border-accent-red/30 bg-accent-red/5'
              }`}
            >
              {/* Action icon */}
              <div className={`flex h-7 w-7 items-center justify-center rounded-full shrink-0 ${
                e.success
                  ? hasGateFail ? 'bg-accent-yellow/15 text-accent-yellow' : 'bg-accent-brand/15 text-accent-brand'
                  : 'bg-accent-red/15 text-accent-red'
              }`}>
                {ACTION_ICONS[e.action]}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-text-primary">{ACTION_LABELS[e.action]}</span>
                  {e.success ? (
                    <CheckCircle2 size={12} className="text-green-400" />
                  ) : (
                    <XCircle size={12} className="text-accent-red" />
                  )}
                  <span className="text-[10px] text-text-tertiary font-mono">{formatTime(e.timestamp)}</span>
                  {e.branch && (
                    <span className="text-[10px] font-mono text-accent-brand/70 flex items-center gap-0.5">
                      <GitBranch size={9} /> {e.branch}
                    </span>
                  )}
                </div>

                {/* Agent + commit info */}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-accent-brand font-medium">@{e.agentName}</span>
                  {e.commitHash && (
                    <span className="text-[10px] font-mono text-text-tertiary">
                      {e.commitHash.slice(0, 8)}
                    </span>
                  )}
                  {e.author && (
                    <span className="text-[10px] text-text-tertiary">
                      by {e.author.name} &lt;{e.author.email}&gt;
                    </span>
                  )}
                </div>

                {/* Commit message */}
                {e.commitMessage && (
                  <div className="text-[11px] text-text-secondary mt-1 truncate font-mono">
                    {e.commitMessage}
                  </div>
                )}

                {/* Gate result */}
                {isCommit && e.gateResult?.enabled && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] font-mono ${e.gateResult.passed ? 'text-green-400' : 'text-accent-red'}`}>
                      pre-commit gate: {e.gateResult.passed ? 'PASSED ✓' : 'FAILED ✗'}
                    </span>
                    {e.gateResult.diagnostics.length > 0 && (
                      <span className="text-[10px] text-accent-yellow flex items-center gap-0.5">
                        <AlertTriangle size={9} /> {e.gateResult.diagnostics.length} issue(s)
                      </span>
                    )}
                  </div>
                )}

                {/* Error */}
                {e.error && (
                  <div className="text-[10px] text-accent-red mt-1 font-mono truncate">
                    {e.error}
                  </div>
                )}

                {/* Gate diagnostics (expandable on hover) */}
                {e.gateResult && e.gateResult.diagnostics.length > 0 && (
                  <div className="hidden group-hover:block mt-1 rounded bg-bg-primary/60 p-2 text-[10px] font-mono text-accent-red/80">
                    {e.gateResult.diagnostics.map((d, i) => (
                      <div key={i} className="truncate">{d}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function GitActivityView() {
  const { t } = useTranslation();
  const allEvents = useGitActivityStore((s) => s.events);
  const clear = useGitActivityStore((s) => s.clear);
  const sessionId = useSessionStore((s) => s.sessionId);

  // Session isolation: only show events for the current session
  const events = useMemo(
    () => allEvents.filter((e) => e.sessionId === sessionId),
    [allEvents, sessionId],
  );

  const stats = useMemo(() => {
    const total = events.length;
    const commits = events.filter((e) => e.action === 'commit').length;
    const pushes = events.filter((e) => e.action === 'push').length;
    const failures = events.filter((e) => !e.success).length;
    const gateEnabled = events.filter((e) => e.gateResult?.enabled);
    const gatePasses = gateEnabled.filter((e) => e.gateResult!.passed).length;
    const gateFails = gateEnabled.filter((e) => !e.gateResult!.passed).length;
    const uniqueAgents = new Set(events.map((e) => e.agentId)).size;
    const successRate = total > 0 ? Math.round(((total - failures) / total) * 100) : 100;
    return { total, commits, pushes, failures, gatePasses, gateFails, uniqueAgents, successRate };
  }, [events]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="codex-topbar flex items-center gap-2 px-5 py-3 border-b border-border-muted backdrop-blur-2xl shrink-0">
        <GitCommitHorizontal size={15} className="text-accent-brand" />
        <span className="text-sm font-semibold text-text-primary">{t('sidebar.gitActivity', 'Git Activity')}</span>
        <span className="text-[11px] text-text-tertiary font-mono">{stats.total} events</span>
        <div className="flex-1" />
        {events.length > 0 && (
          <button
            onClick={clear}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-text-tertiary hover:text-accent-red transition-colors rounded"
            title="Clear activity log"
          >
            <Trash2 size={12} />
            Clear
          </button>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border-muted shrink-0 overflow-x-auto">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Commits" value={stats.commits} accent="text-accent-brand" />
        <StatCard label="Pushes" value={stats.pushes} />
        <StatCard label="Success" value={`${stats.successRate}%`} accent={stats.successRate === 100 ? 'text-green-400' : 'text-accent-yellow'} />
        {stats.gatePasses + stats.gateFails > 0 && (
          <StatCard label="Gate Pass" value={`${stats.gatePasses}/${stats.gatePasses + stats.gateFails}`} accent={stats.gateFails > 0 ? 'text-accent-yellow' : 'text-green-400'} />
        )}
        <StatCard label="Agents" value={stats.uniqueAgents} />
      </div>

      {/* Two-panel layout: timeline + agent stats */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: timeline (main) */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden p-3">
          <div className="flex items-center gap-2 px-1 pb-2">
            <Clock size={12} className="text-text-tertiary" />
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Timeline</h3>
          </div>
          <ActivityTimeline events={events} />
        </div>

        {/* Right: agent stats sidebar */}
        <div className="w-64 shrink-0 border-l border-border-muted flex flex-col overflow-hidden p-3 gap-3">
          <AgentStats events={events} />
        </div>
      </div>
    </div>
  );
}
