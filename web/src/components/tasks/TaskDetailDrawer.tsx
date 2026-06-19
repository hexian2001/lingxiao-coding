import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  FileText,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Layers,
  Link,
  Network,
  X,
  XCircle,
} from 'lucide-react';
import type { DeliveryEvidenceArtifactRef, DeliveryEvidenceViewModel } from '../../utils/deliveryEvidence';

export type TaskDisplayState =
  | 'pending'
  | 'dispatchable'
  | 'blocked'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskDetail {
  id: string;
  subject: string;
  description: string | object;
  status: string;
  displayState?: TaskDisplayState;
  exitReason?: 'completed' | 'failed' | 'cancelled' | 'timeout';
  agent_type: string;
  blocked_by: string[];
  blocks: string[];
  assigned_agent: string;
  working_directory?: string;
  write_scope?: string[];
  result?: string | object;
  orchestration?: {
    orchestrationRunId?: string;
    nodeKind?: string;
    generation?: number;
    stage?: string;
    verdict?: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN' | string;
    contract?: unknown;
    evaluationPolicy?: unknown;
    acceptance?: {
      status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
      summary?: string;
      criteria?: string[];
      evidenceTaskIds?: string[];
      artifactRefs?: Array<{ path: string; label?: string; kind?: string }>;
      evaluatedAt?: number;
    };
    blockedReason?: string;
    nextAction?: string;
    explainReason?: string;
    mainPathRank?: number;
  };
  created_at: number;
  updated_at: number;
}

export interface TaskDisplayConfig {
  label: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
  border: string;
}

interface TaskDetailDrawerProps {
  task: TaskDetail | null;
  state: TaskDisplayState;
  display: TaskDisplayConfig;
  deliveryEvidence: DeliveryEvidenceViewModel[];
  onClose: () => void;
  onOpenAgent: () => void;
  onOpenReview: () => void;
  onOpenArtifacts: () => void;
  onOpenChanges: () => void;
  onOpenGit: () => void;
  onOpenArtifactRef: (ref: DeliveryEvidenceArtifactRef) => void;
  onSelectTask: (taskId: string) => void;
}

function compactPath(path?: string, max = 60): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= max) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts.slice(-3).join('/');
  return tail.length < max ? `.../${tail}` : `...${normalized.slice(-(max - 3))}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(value: number | undefined): string {
  if (!value) return 'unknown';
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(value);
  }
}

function evidenceForTask(task: TaskDetail, items: DeliveryEvidenceViewModel[]): DeliveryEvidenceViewModel[] {
  const assigned = task.assigned_agent.toLowerCase();
  const agentType = task.agent_type.toLowerCase();
  const direct = items.filter((item) => {
    if (item.taskId && item.taskId === task.id) return true;
    const agentName = (item.agentName || item.agentId || '').toLowerCase();
    return Boolean(assigned && agentName === assigned) || Boolean(agentType && agentName === agentType);
  });
  return direct.length > 0 ? direct : items.slice(0, 3);
}

function mergeArtifactRefs(task: TaskDetail, evidence: DeliveryEvidenceViewModel[]): DeliveryEvidenceArtifactRef[] {
  const refs: DeliveryEvidenceArtifactRef[] = [];
  for (const ref of task.orchestration?.acceptance?.artifactRefs ?? []) {
    refs.push({ path: ref.path, label: ref.label || ref.path, kind: ref.kind || 'acceptance' });
  }
  for (const item of evidence) {
    refs.push(...item.artifactRefs);
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.path || ref.url || ref.label || '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function TaskDetailDrawer({
  task,
  state,
  display,
  deliveryEvidence,
  onClose,
  onOpenAgent,
  onOpenReview,
  onOpenArtifacts,
  onOpenChanges,
  onOpenGit,
  onOpenArtifactRef,
  onSelectTask,
}: TaskDetailDrawerProps) {
  if (!task) {
    return (
      <aside className="hidden w-[360px] shrink-0 border-l border-border-muted bg-bg-primary/70 xl:flex xl:flex-col">
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div>
            <Network size={28} className="mx-auto mb-3 text-text-tertiary/40" />
            <p className="text-sm font-medium text-text-secondary">Select a task</p>
            <p className="mt-1 text-xs text-text-tertiary">Inspect contract, worker, evidence, and delivery outputs.</p>
          </div>
        </div>
      </aside>
    );
  }

  const relatedEvidence = evidenceForTask(task, deliveryEvidence);
  const artifactRefs = mergeArtifactRefs(task, relatedEvidence);
  const verification = relatedEvidence.flatMap((item) => item.verification);
  const filesCreated = Array.from(new Set(relatedEvidence.flatMap((item) => item.filesCreated)));
  const filesModified = Array.from(new Set(relatedEvidence.flatMap((item) => item.filesModified)));
  const commandsRun = Array.from(new Set(relatedEvidence.flatMap((item) => item.commandsRun)));
  const risks = Array.from(new Set(relatedEvidence.flatMap((item) => item.risks)));
  const hasEvidence = relatedEvidence.length > 0 || artifactRefs.length > 0 || verification.length > 0 || filesCreated.length > 0 || filesModified.length > 0 || commandsRun.length > 0;

  return (
    <aside className="hidden w-[400px] shrink-0 border-l border-border-muted bg-bg-primary/78 backdrop-blur-2xl xl:flex xl:flex-col">
      <div className="flex items-start gap-3 border-b border-border-muted px-4 py-3">
        <span className={`${display.color} mt-0.5 shrink-0`}>{display.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${display.border} ${display.color} ${display.bg}`}>
              {display.label}
            </span>
            <span className="truncate font-mono text-[10px] text-text-tertiary">#{task.id}</span>
          </div>
          <h2 className="mt-2 text-sm font-semibold leading-5 text-text-primary">{task.subject}</h2>
        </div>
        <button type="button" className="codex-icon-btn !h-7 !min-w-7" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 grid grid-cols-2 gap-2">
          <ActionButton icon={<Bot size={13} />} label="Agent" onClick={onOpenAgent} disabled={!task.assigned_agent} />
          <ActionButton icon={<GitPullRequest size={13} />} label="Review" onClick={onOpenReview} />
          <ActionButton icon={<FileText size={13} />} label="Artifacts" onClick={onOpenArtifacts} />
          <ActionButton icon={<GitBranch size={13} />} label="Changes" onClick={onOpenChanges} />
          <ActionButton icon={<GitCommit size={13} />} label="Git" onClick={onOpenGit} />
        </div>

        <Section title="Contract" icon={<Layers size={13} />}>
          {task.description && (
            <p className="mb-2 whitespace-pre-wrap text-xs leading-5 text-text-secondary">{stringify(task.description)}</p>
          )}
          <KeyValue label="type" value={task.agent_type || 'unknown'} />
          <KeyValue label="status" value={`${task.status}${task.exitReason ? ` / ${task.exitReason}` : ''}`} />
          {task.orchestration?.nodeKind && <KeyValue label="node" value={task.orchestration.nodeKind} />}
          {task.orchestration?.stage && <KeyValue label="stage" value={task.orchestration.stage} />}
          {task.orchestration?.verdict && <KeyValue label="verdict" value={task.orchestration.verdict} tone={task.orchestration.verdict === 'FAIL' ? 'danger' : task.orchestration.verdict === 'PASS' ? 'ok' : 'neutral'} />}
          {task.orchestration?.acceptance?.status && <KeyValue label="acceptance" value={task.orchestration.acceptance.status} />}
          {task.orchestration?.acceptance?.summary && <p className="mt-2 text-xs leading-5 text-text-secondary">{task.orchestration.acceptance.summary}</p>}
          {task.orchestration?.acceptance?.criteria?.length ? (
            <CompactList values={task.orchestration.acceptance.criteria} />
          ) : null}
        </Section>

        <Section title="Worker" icon={<Bot size={13} />}>
          <KeyValue label="agent" value={task.assigned_agent || 'unassigned'} />
          {task.working_directory && <KeyValue label="cwd" value={compactPath(task.working_directory, 86)} mono />}
          {task.write_scope?.length ? (
            <div className="mt-2 space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary">write scope</div>
              <CompactList values={task.write_scope.map((entry) => compactPath(entry, 78))} mono />
            </div>
          ) : null}
        </Section>

        <Section title="Dependencies" icon={<Network size={13} />}>
          <DependencyRow label="blocked_by" values={task.blocked_by} tone="warn" onSelectTask={onSelectTask} />
          <DependencyRow label="blocks" values={task.blocks} tone="neutral" onSelectTask={onSelectTask} />
          {task.orchestration?.blockedReason && (
            <div className="mt-2 rounded border border-accent-yellow/30 bg-accent-yellow/10 px-2 py-1.5 text-xs text-accent-yellow">
              {task.orchestration.blockedReason}
            </div>
          )}
          {task.orchestration?.nextAction && (
            <div className="mt-2 rounded border border-accent-brand/30 bg-accent-brand/10 px-2 py-1.5 text-xs text-accent-brand">
              next: {task.orchestration.nextAction}
            </div>
          )}
        </Section>

        <Section title="Result" icon={state === 'failed' ? <XCircle size={13} /> : <CheckCircle2 size={13} />}>
          {task.result ? (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-border-muted bg-bg-secondary p-2 text-[10px] leading-4 text-text-secondary">
              {stringify(task.result)}
            </pre>
          ) : (
            <EmptyLine label="No task result yet." />
          )}
        </Section>

        <Section title="Delivery Evidence" icon={<Link size={13} />}>
          {!hasEvidence ? (
            <EmptyLine label="No delivery evidence linked yet." />
          ) : (
            <div className="space-y-3">
              {relatedEvidence.slice(0, 4).map((item) => (
                <div key={item.id} className="rounded-md border border-border-muted bg-bg-secondary px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium text-text-primary">{item.title}</span>
                    <span className="shrink-0 rounded border border-border-muted px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">{item.status}</span>
                  </div>
                  {item.summary && <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-text-secondary">{item.summary}</p>}
                </div>
              ))}
              <EvidenceCounts created={filesCreated.length} modified={filesModified.length} commands={commandsRun.length} verification={verification.length} />
              {artifactRefs.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-text-tertiary">refs</div>
                  {artifactRefs.slice(0, 8).map((ref, index) => (
                    <button
                      key={`${ref.path || ref.url || ref.label}-${index}`}
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 rounded border border-border-muted bg-bg-card px-2 py-1.5 text-left text-[11px] text-text-secondary hover:border-border-default hover:bg-bg-hover hover:text-text-primary"
                      onClick={() => onOpenArtifactRef(ref)}
                      title={ref.path || ref.url || ref.label}
                    >
                      <FileText size={12} className="shrink-0 text-text-tertiary" />
                      <span className="min-w-0 flex-1 truncate">{ref.label || compactPath(ref.path || ref.url || '', 72)}</span>
                      {ref.kind && <span className="shrink-0 text-[10px] text-text-tertiary">{ref.kind}</span>}
                    </button>
                  ))}
                </div>
              )}
              {verification.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-text-tertiary">verification</div>
                  {verification.slice(0, 5).map((item, index) => (
                    <div key={`${item.kind}-${index}`} className="flex items-start gap-1.5 rounded border border-border-muted bg-bg-card px-2 py-1 text-[10px] text-text-secondary">
                      {item.passed ? <CheckCircle2 size={11} className="mt-0.5 shrink-0 text-accent-green" /> : <AlertTriangle size={11} className="mt-0.5 shrink-0 text-accent-red" />}
                      <span className="min-w-0 flex-1">{item.kind}: {item.detail}</span>
                    </div>
                  ))}
                </div>
              )}
              {risks.length > 0 && (
                <div className="rounded border border-accent-red/30 bg-accent-red/10 px-2 py-1.5 text-xs text-accent-red">
                  {risks[0]}
                </div>
              )}
            </div>
          )}
        </Section>

        <div className="mt-3 rounded-md border border-border-muted bg-bg-secondary px-2 py-1.5 text-[10px] text-text-tertiary">
          <div>created: {formatTime(task.created_at)}</div>
          <div>updated: {formatTime(task.updated_at)}</div>
        </div>
      </div>
    </aside>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-3 rounded-md border border-border-muted bg-bg-primary/35 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function ActionButton({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-border-muted bg-bg-secondary text-xs text-text-secondary transition-colors hover:border-border-default hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function KeyValue({ label, value, mono, tone = 'neutral' }: { label: string; value: string; mono?: boolean; tone?: 'neutral' | 'ok' | 'danger' }) {
  const toneClass = tone === 'ok' ? 'text-accent-green' : tone === 'danger' ? 'text-accent-red' : 'text-text-secondary';
  return (
    <div className="mb-1 flex min-w-0 items-start gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-text-tertiary">{label}</span>
      <span className={`min-w-0 flex-1 break-words ${toneClass} ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function CompactList({ values, mono }: { values: string[]; mono?: boolean }) {
  return (
    <div className="mt-1 space-y-1">
      {values.slice(0, 8).map((value) => (
        <div key={value} className={`truncate rounded border border-border-muted bg-bg-secondary px-2 py-1 text-[10px] text-text-secondary ${mono ? 'font-mono' : ''}`} title={value}>
          {value}
        </div>
      ))}
    </div>
  );
}

function DependencyRow({ label, values, tone, onSelectTask }: { label: string; values: string[]; tone: 'warn' | 'neutral'; onSelectTask: (taskId: string) => void }) {
  if (values.length === 0) return <KeyValue label={label} value="none" mono />;
  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono ${
              tone === 'warn'
                ? 'border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow'
                : 'border-border-muted bg-bg-secondary text-text-tertiary hover:text-text-secondary'
            }`}
            onClick={() => onSelectTask(value)}
            title={value}
          >
            <span className="truncate">{value.slice(0, 12)}</span>
            <ArrowRight size={10} />
          </button>
        ))}
      </div>
    </div>
  );
}

function EvidenceCounts({ created, modified, commands, verification }: { created: number; modified: number; commands: number; verification: number }) {
  const items = [
    { label: 'created', value: created },
    { label: 'modified', value: modified },
    { label: 'commands', value: commands },
    { label: 'verify', value: verification },
  ];
  return (
    <div className="grid grid-cols-4 gap-1">
      {items.map((item) => (
        <div key={item.label} className="rounded border border-border-muted bg-bg-card px-1.5 py-1 text-center">
          <div className="font-mono text-xs text-text-primary">{item.value}</div>
          <div className="text-[9px] text-text-tertiary">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ label }: { label: string }) {
  return <div className="rounded border border-border-muted bg-bg-secondary px-2 py-2 text-center text-xs text-text-tertiary">{label}</div>;
}
