/**
 * ForgeJobList — 历史任务列表
 *
 * 展示所有 Forge 生成任务，支持:
 * - 状态过滤
 * - 分页
 * - 点击查看详情/进度
 * - 删除/取消操作
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Trash2,
  XCircle,
  Eye,
  Clock,
  Plus,
  Inbox,
} from 'lucide-react';
import { listJobs, deleteJob, cancelJob } from './api';
import {
  STATE_LABELS,
  stateBadgeClass,
  TERMINAL_STATES,
  FAILED_STATES,
  type ForgeJobSummary,
  type ForgeJobState,
} from './types';

interface ForgeJobListProps {
  onSelectJob: (jobId: string) => void;
  onNewJob: () => void;
}

const PAGE_SIZE = 20;

export default function ForgeJobList({ onSelectJob, onNewJob }: ForgeJobListProps) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<ForgeJobSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let stateFilter: string | undefined;
      if (filter === 'active') {
        stateFilter = ['pending', 'analyzing', 'analyzed', 'generating', 'generated', 'validating', 'validation_skipped', 'validated', 'registering', 'registered'].join(',');
      } else if (filter === 'completed') {
        stateFilter = 'completed';
      } else if (filter === 'failed') {
        stateFilter = ['analysis_failed', 'generation_failed', 'validation_failed', 'registration_failed', 'cancelled'].join(',');
      }

      const result = await listJobs({
        state: stateFilter,
        limit: PAGE_SIZE,
        offset,
        sort: 'createdAt_desc',
      });
      setJobs(result.jobs);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
    } finally {
      setLoading(false);
    }
  }, [filter, offset]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Auto-refresh when viewing active jobs
  useEffect(() => {
    if (filter !== 'all' && filter !== 'active') return;
    const hasActive = jobs.some((j) => !TERMINAL_STATES.has(j.state));
    if (!hasActive) return;
    const timer = setInterval(fetchJobs, 3000);
    return () => clearInterval(timer);
  }, [filter, jobs]);

  function handleDelete(jobId: string) {
    setActionLoading(jobId);
    deleteJob(jobId)
      .then(() => fetchJobs())
      .catch((err) => setError(err instanceof Error ? err.message : 'Delete failed'))
      .finally(() => setActionLoading(null));
  }

  function handleCancel(jobId: string) {
    setActionLoading(jobId);
    cancelJob(jobId)
      .then(() => fetchJobs())
      .catch((err) => setError(err instanceof Error ? err.message : 'Cancel failed'))
      .finally(() => setActionLoading(null));
  }

  const filters: { key: typeof filter; label: string }[] = [
    { key: 'all', label: t('forge.filter.all') || 'All' },
    { key: 'active', label: t('forge.filter.active') || 'Active' },
    { key: 'completed', label: t('forge.filter.completed') || 'Completed' },
    { key: 'failed', label: t('forge.filter.failed') || 'Failed' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border-muted">
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setOffset(0); }}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                filter === f.key
                  ? 'bg-accent-brand/20 text-accent-brand'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={fetchJobs}
          className="p-1.5 text-text-tertiary hover:text-text-secondary transition-colors"
          title={t('plugins.refresh') || 'Refresh'}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onNewJob}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('forge.newJob') || 'New'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-xs flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-accent-brand animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
            <Inbox className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">{t('forge.noJobs') || 'No Forge jobs yet'}</p>
            <button
              onClick={onNewJob}
              className="mt-3 flex items-center gap-1 px-3 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 transition-opacity"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('forge.createFirst') || 'Create your first MCP server'}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border-muted">
            {jobs.map((job) => {
              const isTerminal = TERMINAL_STATES.has(job.state);
              const isFailed = FAILED_STATES.has(job.state);
              const isActive = !isTerminal;
              return (
                <div
                  key={job.id}
                  className="px-5 py-3 flex items-center gap-3 hover:bg-bg-hover/70 transition-colors group"
                >
                  {/* Status icon */}
                  <div className="shrink-0">
                    {isActive ? (
                      <Loader2 className="w-4 h-4 text-accent-brand animate-spin" />
                    ) : isFailed ? (
                      <XCircle className="w-4 h-4 text-accent-red" />
                    ) : job.state === 'cancelled' ? (
                      <XCircle className="w-4 h-4 text-text-tertiary" />
                    ) : (
                      <div className="w-4 h-4 rounded-full bg-accent-green/20 flex items-center justify-center">
                        <div className="w-2 h-2 rounded-full bg-accent-green" />
                      </div>
                    )}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onSelectJob(job.id)}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-primary font-medium truncate">
                        {job.serverName}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${stateBadgeClass(job.state)}`}>
                        {STATE_LABELS[job.state]}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      {/* Progress bar */}
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 h-1 bg-bg-tertiary rounded-full overflow-hidden">
                          <div
                            className={`h-full ${isFailed ? 'bg-accent-red' : isActive ? 'bg-accent-brand' : 'bg-accent-green'}`}
                            style={{ width: `${Math.max(2, job.progress)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-text-tertiary">{Math.round(job.progress)}%</span>
                      </div>
                      <span className="text-[10px] text-text-tertiary flex items-center gap-0.5">
                        <Clock className="w-2.5 h-2.5" />
                        {new Date(job.createdAt).toLocaleString()}
                      </span>
                      {job.error && (
                        <span className="text-[10px] text-accent-red truncate max-w-32" title={job.error.message}>
                          {job.error.code}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => onSelectJob(job.id)}
                      className="p-1 text-text-tertiary hover:text-accent-brand transition-colors"
                      title={t('forge.viewDetails') || 'View details'}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    {isActive && (
                      <button
                        onClick={() => handleCancel(job.id)}
                        disabled={actionLoading === job.id}
                        className="p-1 text-text-tertiary hover:text-accent-yellow transition-colors disabled:opacity-30"
                        title={t('forge.cancel') || 'Cancel'}
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {isTerminal && (
                      <button
                        onClick={() => handleDelete(job.id)}
                        disabled={actionLoading === job.id}
                        className="p-1 text-text-tertiary hover:text-accent-red transition-colors disabled:opacity-30"
                        title={t('forge.delete') || 'Delete'}
                      >
                        {actionLoading === job.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-5 py-2 border-t border-border-muted">
          <span className="text-[10px] text-text-tertiary">
            {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} / {total}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary disabled:opacity-30 transition-colors"
            >
              {t('forge.prev') || 'Prev'}
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary disabled:opacity-30 transition-colors"
            >
              {t('forge.next') || 'Next'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
