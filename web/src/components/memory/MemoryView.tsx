import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Brain, CheckCircle2, FileText, RefreshCw, Sparkles } from 'lucide-react';
import { acpClient } from '../../api/AcpClient';
import { useSessionStore } from '../../stores/sessionStore';
import { useMaintenanceStore } from '../../stores/maintenanceStore';

type MemoryKind = 'dream' | 'distill';
type AssetForm = 'skill' | 'command' | 'agent';

interface MemoryAssetSummary {
  form: AssetForm;
  name: string;
  path: string;
  bytes: number;
  updatedAt: number;
}

interface PipelineSummary {
  kind: MemoryKind;
  enabled: boolean;
  autoIntervalDays: number;
  sessionLookbackDays: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  due: boolean;
}

interface MemoryStatus {
  enabled: boolean;
  workspace: string;
  memoryRoot: string;
  memoryPath: string;
  memoryExists: boolean;
  memoryBytes: number;
  memoryLines: number;
  memoryUpdatedAt: number | null;
  checkpointsIndexed: number;
  assets: MemoryAssetSummary[];
  pipelines: {
    dream: PipelineSummary;
    distill: PipelineSummary;
  };
}

interface MemoryStatusResponse {
  success: true;
  status: MemoryStatus;
}

interface DreamRunResult {
  updatedPath: string;
  sectionsConsolidated: number;
  linesWritten: number;
  checkpointsProcessed: number;
}

interface DistillRunResult {
  created: Array<{ form: AssetForm; name: string; path: string }>;
  skipped: string[];
  needsMoreEvidence: string[];
  considered: number;
  conflicts: string[];
  invalid: string[];
}

type RunSummary =
  | { kind: 'dream'; result: DreamRunResult }
  | { kind: 'distill'; result: DistillRunResult };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: number | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function pipelineTone(pipeline: PipelineSummary): string {
  if (!pipeline.enabled) return 'text-text-tertiary';
  if (pipeline.due) return 'text-accent-yellow';
  return 'text-accent-green';
}

export default function MemoryView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const maintenance = useMaintenanceStore();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<MemoryKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await acpClient.sendJsonRpc('memory/status', sessionId ? { sessionId } : {}) as MemoryStatusResponse;
      setStatus(response.status);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const runPipeline = async (kind: MemoryKind) => {
    if (running) return;
    setRunning(kind);
    setError(null);
    try {
      const response = await acpClient.sendJsonRpc('memory/run', {
        kind,
        ...(sessionId ? { sessionId } : {}),
      }) as { kind: MemoryKind; result: DreamRunResult | DistillRunResult; status: MemoryStatus };
      setStatus(response.status);
      setLastRun(response.kind === 'dream'
        ? { kind: 'dream', result: response.result as DreamRunResult }
        : { kind: 'distill', result: response.result as DistillRunResult });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  const activeKind = running || (maintenance.phase === 'running' ? maintenance.kind : null);
  const assetsByForm = useMemo(() => {
    const counts: Record<AssetForm, number> = { skill: 0, command: 0, agent: 0 };
    for (const asset of status?.assets || []) counts[asset.form] += 1;
    return counts;
  }, [status?.assets]);

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <div className="codex-topbar px-5 py-4 border-b border-border-muted backdrop-blur-2xl shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <Brain className="w-4 h-4" />
              {t('memoryWorkbench.title')}
            </h2>
            <p className="text-xs text-text-tertiary truncate mt-1">
              {status?.workspace || t('memoryWorkbench.noWorkspace')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchStatus()}
            className="codex-icon-btn !h-8 !min-w-8"
            title={t('memoryWorkbench.refresh')}
            aria-label={t('memoryWorkbench.refresh')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-5 py-2 bg-accent-red/10 text-accent-red text-xs flex items-center gap-2 border-b border-accent-red/20">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {status && (
            <>
              <PipelineCard
                title={t('memoryWorkbench.dream.title')}
                icon={<Brain className="w-4 h-4" />}
                pipeline={status.pipelines.dream}
                active={activeKind === 'dream'}
                disabled={Boolean(running)}
                onRun={() => void runPipeline('dream')}
              />
              <PipelineCard
                title={t('memoryWorkbench.distill.title')}
                icon={<Sparkles className="w-4 h-4" />}
                pipeline={status.pipelines.distill}
                active={activeKind === 'distill'}
                disabled={Boolean(running)}
                onRun={() => void runPipeline('distill')}
              />
            </>
          )}
        </div>

        {lastRun && <RunResult result={lastRun} />}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-4">
          <section className="border border-border-default bg-bg-secondary rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border-muted flex items-center gap-2">
              <FileText className="w-4 h-4 text-accent-brand" />
              <h3 className="text-xs font-semibold text-text-primary">{t('memoryWorkbench.memoryFile')}</h3>
            </div>
            <div className="p-4 space-y-3">
              <Metric label={t('memoryWorkbench.memoryExists')} value={status?.memoryExists ? t('common.yes') : t('common.no')} />
              <Metric label={t('memoryWorkbench.memoryLines')} value={String(status?.memoryLines ?? 0)} />
              <Metric label={t('memoryWorkbench.memorySize')} value={formatBytes(status?.memoryBytes ?? 0)} />
              <Metric label={t('memoryWorkbench.checkpoints')} value={String(status?.checkpointsIndexed ?? 0)} />
              <div className="pt-2 border-t border-border-muted">
                <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">{t('memoryWorkbench.path')}</div>
                <div className="text-[11px] text-text-secondary break-all font-mono">{status?.memoryPath || '-'}</div>
              </div>
            </div>
          </section>

          <section className="border border-border-default bg-bg-secondary rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-border-muted flex items-center justify-between">
              <h3 className="text-xs font-semibold text-text-primary">{t('memoryWorkbench.assets')}</h3>
              <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
                <span>Skills {assetsByForm.skill}</span>
                <span>Commands {assetsByForm.command}</span>
                <span>Agents {assetsByForm.agent}</span>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {(status?.assets.length ?? 0) === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-text-tertiary">
                  {t('memoryWorkbench.noAssets')}
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-secondary border-b border-border-muted">
                    <tr className="text-left text-[10px] uppercase tracking-wide text-text-tertiary">
                      <th className="px-4 py-2 font-medium">{t('memoryWorkbench.asset')}</th>
                      <th className="px-4 py-2 font-medium">{t('memoryWorkbench.type')}</th>
                      <th className="px-4 py-2 font-medium">{t('memoryWorkbench.updated')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-muted">
                    {status?.assets.map((asset) => (
                      <tr key={`${asset.form}:${asset.path}`} className="hover:bg-bg-hover/60">
                        <td className="px-4 py-2 min-w-0">
                          <div className="text-text-primary font-medium">{asset.name}</div>
                          <div className="text-[10px] text-text-tertiary font-mono truncate max-w-[520px]">{asset.path}</div>
                        </td>
                        <td className="px-4 py-2 text-text-secondary">{asset.form}</td>
                        <td className="px-4 py-2 text-text-tertiary whitespace-nowrap">{formatDate(asset.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function PipelineCard({
  title,
  icon,
  pipeline,
  active,
  disabled,
  onRun,
}: {
  title: string;
  icon: React.ReactNode;
  pipeline: PipelineSummary;
  active: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="border border-border-default bg-bg-secondary rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={pipelineTone(pipeline)}>{icon}</span>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              {t('memoryWorkbench.interval', { interval: pipeline.autoIntervalDays, lookback: pipeline.sessionLookbackDays })}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={disabled || !pipeline.enabled}
          className="px-3 py-1.5 text-xs rounded-md border border-border-default bg-bg-tertiary text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {active ? t('memoryWorkbench.running') : t('memoryWorkbench.runNow')}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-4">
        <Metric label={t('memoryWorkbench.lastRun')} value={formatDate(pipeline.lastRunAt)} />
        <Metric label={t('memoryWorkbench.nextRun')} value={pipeline.nextRunAt ? formatDate(pipeline.nextRunAt) : t('memoryWorkbench.whenDue')} />
      </div>
      <div className={`mt-3 text-[11px] ${pipelineTone(pipeline)}`}>
        {pipeline.enabled ? (pipeline.due ? t('memoryWorkbench.due') : t('memoryWorkbench.scheduled')) : t('memoryWorkbench.disabled')}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className="text-xs text-text-primary mt-0.5 break-words">{value}</div>
    </div>
  );
}

function RunResult({ result }: { result: RunSummary }) {
  const { t } = useTranslation();
  if (result.kind === 'dream') {
    return (
      <div className="border border-accent-green/30 bg-accent-green/10 rounded-lg px-4 py-3 text-xs text-text-secondary flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-accent-green shrink-0 mt-0.5" />
        <span>
          {t('memoryWorkbench.dream.done', {
            checkpoints: result.result.checkpointsProcessed,
            sections: result.result.sectionsConsolidated,
            lines: result.result.linesWritten,
          })}
        </span>
      </div>
    );
  }
  return (
    <div className="border border-accent-green/30 bg-accent-green/10 rounded-lg px-4 py-3 text-xs text-text-secondary flex items-start gap-2">
      <CheckCircle2 className="w-4 h-4 text-accent-green shrink-0 mt-0.5" />
      <span>
        {t('memoryWorkbench.distill.done', {
          created: result.result.created.length,
          considered: result.result.considered,
          skipped: result.result.skipped.length,
          conflicts: result.result.conflicts.length,
        })}
      </span>
    </div>
  );
}
