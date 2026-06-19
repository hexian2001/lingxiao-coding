import {
  Activity,
  Bot,
  CircleAlert,
  GitPullRequest,
  Infinity as InfinityIcon,
  ListTodo,
  Loader2,
  Network,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { OrchestrationStatus, RunExplanation, SessionEternalRuntimeSnapshot, SessionPhase } from '../../stores/sessionStoreTypes';
import { isAgentActiveStatus } from '../../stores/sessionStoreHelpers.ts';
import { buildEternalRuntimeViewModel } from '../../utils/eternalRuntimeViewModel';

type AgentRuntime = {
  agentId?: string;
  agentName?: string;
  role?: string;
  status: string;
  taskId?: string;
};

type ContextRuntimeState = {
  currentTokens: number;
  maxTokens: number;
  threshold: number;
  warningLevel: 'ok' | 'warning' | 'critical';
};

type CompactingProgress = {
  stage: string;
  chunkIndex?: number;
  chunkTotal?: number;
  percent?: number;
  oldTokens?: number;
  newTokens?: number;
  threshold?: number;
  messageCount?: number;
  label?: string;
  at?: number;
} | null;

interface RunStatusStripProps {
  phase: SessionPhase;
  agents: AgentRuntime[];
  orchestrationStatus: OrchestrationStatus | null;
  runExplanation: RunExplanation | null;
  contextRuntimeState: ContextRuntimeState | null;
  eternalRuntime: SessionEternalRuntimeSnapshot | null;
  compactingProgress?: CompactingProgress;
  now?: number;
  onOpenAgents: () => void;
  onOpenTasks: () => void;
  onOpenEvidence: () => void;
}

const ACTIVE_PHASES = new Set<SessionPhase>([
  'preparing',
  'model_requesting',
  'streaming',
  'thinking',
  'tool_executing',
  'observing',
  'waiting_for_permission',
  'waiting_for_user',
  'retrying',
  'compacting',
  'cancelling',
]);

function normalizeText(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function isCompletedAgent(agent: AgentRuntime): boolean {
  const status = normalizeText(agent.status);
  return status === 'completed' || status === 'done' || status === 'success';
}

function isFailedAgent(agent: AgentRuntime): boolean {
  const status = normalizeText(agent.status);
  return status === 'failed' || status === 'error' || status === 'interrupted' || status === 'cancelled' || status === 'canceled';
}

function phaseLabel(t: TFunction, phase: SessionPhase, compactingProgress?: CompactingProgress): string {
  if (phase === 'compacting') {
    if (compactingProgress?.stage === 'llm_summary') {
      const chunk = compactingProgress.chunkTotal
        ? ` ${compactingProgress.chunkIndex ?? '?'}/${compactingProgress.chunkTotal}`
        : '';
      return `${t('runStatus.phase.compactingSummary')}${chunk}`;
    }
    if (compactingProgress?.stage === 'finalizing') return t('runStatus.phase.compactingFinalizing');
    return t('runStatus.phase.compacting');
  }
  return t(`runStatus.phase.${phase}`, { defaultValue: phase });
}

function compactingPercent(progress?: CompactingProgress): number {
  if (!progress) return 6;
  if (typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
    return Math.max(0, Math.min(100, Math.round(progress.percent)));
  }
  if (progress.chunkTotal && progress.chunkTotal > 0 && progress.chunkIndex) {
    return Math.max(12, Math.min(92, Math.round((progress.chunkIndex / progress.chunkTotal) * 76 + 14)));
  }
  if (progress.stage === 'finalizing') return 94;
  if (progress.stage === 'llm_summary') return 18;
  return 6;
}

function formatCompactTokens(value?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatCompactElapsed(startedAt?: number, now = Date.now()): string | null {
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function orchestrationLabel(t: TFunction, status: OrchestrationStatus): string {
  return t(`runStatus.orchestration.${status.state}`, { defaultValue: t('runStatus.orchestration.idle') });
}

function formatNodes(t: TFunction, status: OrchestrationStatus): string | null {
  const total = status.totalNodes ?? 0;
  if (total <= 0) return null;
  const done = status.completedNodes ?? 0;
  const failed = status.failedNodes ?? 0;
  const blocked = status.blockedNodes ?? 0;
  const extras = [
    blocked > 0 ? t('runStatus.nodes.blocked', { count: blocked }) : '',
    failed > 0 ? t('runStatus.nodes.failed', { count: failed }) : '',
  ].filter(Boolean);
  return `${t('runStatus.nodes.done', { done, total })}${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`;
}

function contextLabel(t: TFunction, context: ContextRuntimeState): string | null {
  if (context.maxTokens <= 0) return null;
  return t('runStatus.context.percent', { percent: Math.round((context.currentTokens / context.maxTokens) * 100) });
}

function toneClass(tone: 'active' | 'ok' | 'warn' | 'danger' | 'neutral'): string {
  if (tone === 'active') return 'border-accent-brand/35 bg-accent-brand/10 text-accent-brand';
  if (tone === 'ok') return 'border-accent-green/35 bg-accent-green/10 text-accent-green';
  if (tone === 'warn') return 'border-accent-yellow/35 bg-accent-yellow/10 text-accent-yellow';
  if (tone === 'danger') return 'border-accent-red/35 bg-accent-red/10 text-accent-red';
  return 'border-border-muted bg-bg-card/70 text-text-secondary';
}

function phaseTone(phase: SessionPhase): 'active' | 'ok' | 'warn' | 'danger' | 'neutral' {
  if (phase === 'error' || phase === 'interrupted') return 'danger';
  if (phase === 'waiting_for_permission' || phase === 'waiting_for_user' || phase === 'cancelling') return 'warn';
  if (phase === 'done') return 'ok';
  if (ACTIVE_PHASES.has(phase)) return 'active';
  return 'neutral';
}

function orchestrationTone(status: OrchestrationStatus): 'active' | 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status.state === 'failed' || status.state === 'cancelled') return 'danger';
  if (status.state === 'blocked') return 'warn';
  if (status.state === 'completed') return 'ok';
  if (status.state === 'planning' || status.state === 'running' || status.active || status.busy) return 'active';
  return 'neutral';
}

function explanationTone(runExplanation: RunExplanation): 'active' | 'ok' | 'warn' | 'danger' | 'neutral' {
  if (runExplanation.state === 'blocked') return 'danger';
  if (runExplanation.state === 'waiting_for_dependency' || runExplanation.state === 'waiting_for_user') return 'warn';
  if (runExplanation.state === 'idle') return 'neutral';
  return 'active';
}

function contextTone(context: ContextRuntimeState): 'active' | 'ok' | 'warn' | 'danger' | 'neutral' {
  if (context.warningLevel === 'critical') return 'danger';
  if (context.warningLevel === 'warning') return 'warn';
  return 'neutral';
}

export default function RunStatusStrip({
  phase,
  agents,
  orchestrationStatus,
  runExplanation,
  contextRuntimeState,
  eternalRuntime,
  compactingProgress,
  now = Date.now(),
  onOpenAgents,
  onOpenTasks,
  onOpenEvidence,
}: RunStatusStripProps) {
  const { t } = useTranslation();
  const runningAgents = agents.filter((agent) => isAgentActiveStatus(agent.status));
  const completedAgents = agents.filter(isCompletedAgent);
  const failedAgents = agents.filter(isFailedAgent);
  const phaseVisible = phase !== 'idle' && phase !== 'done';
  const showOrchestration = Boolean(orchestrationStatus && (
    orchestrationStatus.active
    || orchestrationStatus.busy
    || orchestrationStatus.state !== 'idle'
    || (orchestrationStatus.totalNodes ?? 0) > 0
  ));
  const showExplanation = Boolean(runExplanation && runExplanation.state !== 'idle');
  const showContext = Boolean(contextRuntimeState && contextRuntimeState.maxTokens > 0);
  const eternalView = buildEternalRuntimeViewModel(eternalRuntime, now);
  const showCompactingBar = phase === 'compacting' && Boolean(compactingProgress);
  const hasSignal = phaseVisible || agents.length > 0 || showOrchestration || showExplanation || showContext || Boolean(eternalView) || showCompactingBar;

  if (!hasSignal) return null;

  const agentTone = failedAgents.length > 0
    ? 'danger'
    : runningAgents.length > 0
      ? 'active'
      : completedAgents.length > 0
        ? 'ok'
        : 'neutral';
  const nodeProgress = orchestrationStatus ? formatNodes(t, orchestrationStatus) : null;
  const ctxText = contextRuntimeState ? contextLabel(t, contextRuntimeState) : null;
  const compactPercent = compactingPercent(compactingProgress);
  const compactTokenLabel = formatCompactTokens(compactingProgress?.oldTokens);
  const compactElapsed = formatCompactElapsed(compactingProgress?.at, now);
  const compactLabel = compactingProgress?.label || phaseLabel(t, phase, compactingProgress);

  return (
    <div className="border-b border-border-muted bg-bg-secondary/62 px-3 py-1.5 backdrop-blur-2xl">
      <div className="mx-auto flex h-8 max-w-[1240px] items-center gap-1.5 overflow-hidden text-[11px] text-text-secondary">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {phaseVisible && (
            <StatusPill tone={phaseTone(phase)} title={t('runStatus.phaseTitle', { phase })}>
              {ACTIVE_PHASES.has(phase) ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
              <span className="font-medium">{t('runStatus.now')}</span>
              <span>{phaseLabel(t, phase, compactingProgress)}</span>
            </StatusPill>
          )}

          {showOrchestration && orchestrationStatus && (
            <StatusPill tone={orchestrationTone(orchestrationStatus)} title={orchestrationStatus.reason || orchestrationStatus.bottleneck || orchestrationStatus.summary}>
              <Network size={12} />
              <span className="font-medium">{t('runStatus.tasks')}</span>
              <span>{orchestrationLabel(t, orchestrationStatus)}</span>
              {nodeProgress && <span className="text-text-tertiary">{nodeProgress}</span>}
            </StatusPill>
          )}

          {agents.length > 0 && (
            <StatusPill tone={agentTone} title={runningAgents.map((agent) => agent.agentName || agent.agentId).filter(Boolean).join(', ') || t('runStatus.agents')}>
              <Bot size={12} />
              <span className="font-medium">{t('runStatus.agents')}</span>
              {runningAgents.length > 0 && <span>{t('runStatus.agentsRunning', { count: runningAgents.length })}</span>}
              {completedAgents.length > 0 && <span>{t('runStatus.agentsDone', { count: completedAgents.length })}</span>}
              {failedAgents.length > 0 && <span>{t('runStatus.agentsFailed', { count: failedAgents.length })}</span>}
              <span className="text-text-tertiary">{t('runStatus.agentsOf', { count: agents.length })}</span>
            </StatusPill>
          )}

          {showExplanation && runExplanation && (
            <StatusPill
              tone={explanationTone(runExplanation)}
              title={[runExplanation.reason, runExplanation.nextAction].filter(Boolean).join(' | ')}
              className="hidden min-w-0 flex-1 md:inline-flex"
            >
              <CircleAlert size={12} className="shrink-0" />
              <span className="shrink-0 font-medium">{t(`runStatus.explanation.${runExplanation.state}`, { defaultValue: runExplanation.state })}</span>
              <span className="min-w-0 flex-1 truncate text-text-secondary">{runExplanation.reason}</span>
              {runExplanation.nextAction && <span className="hidden max-w-[200px] truncate text-accent-yellow/80 sm:inline">{t('runStatus.nextAction', { action: runExplanation.nextAction })}</span>}
            </StatusPill>
          )}

          {showContext && contextRuntimeState && contextRuntimeState.maxTokens > 0 && (
            <StatusPill tone={contextTone(contextRuntimeState)} title={`${ctxText} · ${contextRuntimeState.currentTokens}/${contextRuntimeState.maxTokens}`}>
              <Activity size={12} />
              <ContextBar context={contextRuntimeState} />
              <span className="font-medium tabular-nums">{Math.round((contextRuntimeState.currentTokens / contextRuntimeState.maxTokens) * 100)}%</span>
            </StatusPill>
          )}

          {eternalView && (
            <StatusPill tone={eternalView.tone} title={eternalView.title}>
              {eternalView.spinning ? <Loader2 size={12} className="animate-spin" /> : <InfinityIcon size={12} />}
              <span className="font-medium">{t('runStatus.eternal')}</span>
              <span className="font-mono">{eternalView.statusLabel}</span>
              {eternalView.detailLabel && <span className="font-mono text-text-tertiary">{eternalView.detailLabel}</span>}
            </StatusPill>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
          <StripButton icon={<Bot size={12} />} label={t('runStatus.agents')} onClick={onOpenAgents} disabled={agents.length === 0} />
          <StripButton icon={<ListTodo size={12} />} label={t('runStatus.tasks')} onClick={onOpenTasks} />
          <StripButton icon={<GitPullRequest size={12} />} label={t('runStatus.review')} onClick={onOpenEvidence} />
        </div>
      </div>
      {showCompactingBar && (
        <div className="mx-auto mt-1.5 flex max-w-[1240px] items-center gap-2 text-[11px] text-text-secondary">
          <span className="shrink-0 text-accent-brand">{t('runStatus.compactingConversation')}</span>
          <span className="hidden shrink-0 text-text-tertiary sm:inline">
            {[compactElapsed, compactLabel, compactTokenLabel ? t('runStatus.compactTokens', { tokens: compactTokenLabel }) : ''].filter(Boolean).join(' · ')}
          </span>
          <div className="h-2 min-w-[96px] flex-1 overflow-hidden rounded-sm bg-border-muted">
            <div
              className="h-full bg-accent-brand transition-[width] duration-300"
              style={{ width: `${compactPercent}%` }}
            />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-text-tertiary">{compactPercent}%</span>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  tone,
  title,
  className = '',
  children,
}: {
  tone: 'active' | 'ok' | 'warn' | 'danger' | 'neutral';
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md border px-2 ${toneClass(tone)} ${className}`}
      title={title}
    >
      {children}
    </div>
  );
}

function StripButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-1 rounded-md border border-border-muted bg-bg-card px-1.5 text-[11px] font-medium text-text-tertiary transition-colors hover:border-border-default hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 sm:px-2"
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ContextBar({ context }: { context: ContextRuntimeState }) {
  const pct = context.maxTokens > 0
    ? Math.min(100, Math.round((context.currentTokens / context.maxTokens) * 100))
    : 0;
  const color = pct >= 85
    ? 'var(--color-accent-red)'
    : pct >= 65
      ? 'var(--color-accent-yellow)'
      : 'var(--lingxiao-sword)';
  return (
    <span className="inline-flex h-1.5 w-10 items-center overflow-hidden rounded-full bg-border-muted/70" aria-hidden="true">
      <span
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${Math.max(5, pct)}%`, background: color }}
      />
    </span>
  );
}
