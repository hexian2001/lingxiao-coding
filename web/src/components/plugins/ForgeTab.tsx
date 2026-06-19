/**
 * ForgeTab — MCP Forge 主标签页
 *
 * 管理 Forge 功能的视图状态机:
 * - list: 任务列表（默认）
 * - wizard: 生成向导
 * - progress: 生成进度（SSE）
 * - preview: 结果预览
 *
 * 用户流程:
 *   list → [New] → wizard → [Generate] → progress → [completed] → preview → [Done] → list
 *                                          ↓ [cancelled/failed] → list
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Hammer } from 'lucide-react';
import ForgeWizard from './forge/ForgeWizard';
import ForgeProgress from './forge/ForgeProgress';
import ForgeResultPreview from './forge/ForgeResultPreview';
import ForgeJobList from './forge/ForgeJobList';
import { generate, getJob, ForgeApiError } from './forge/api';
import type { GenerateRequest, ForgeJobDetail } from './forge/types';

type ForgeView = 'list' | 'wizard' | 'progress' | 'preview';

export default function ForgeTab() {
  const { t } = useTranslation();
  const [view, setView] = useState<ForgeView>('list');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const handleNewJob = useCallback(() => {
    setError(null);
    setView('wizard');
  }, []);

  const handleSelectJob = useCallback(async (jobId: string) => {
    setActiveJobId(jobId);
    setError(null);
    // Check job state to determine which view to show
    try {
      const job = await getJob(jobId);
      if (job.state === 'completed') {
        setView('preview');
      } else if (
        job.state === 'analysis_failed' ||
        job.state === 'generation_failed' ||
        job.state === 'validation_failed' ||
        job.state === 'registration_failed' ||
        job.state === 'cancelled'
      ) {
        // Failed/cancelled — show progress (which will display the error)
        setView('progress');
      } else {
        // Active job — show progress
        setView('progress');
      }
    } catch {
      // If fetch fails, default to progress view
      setView('progress');
    }
  }, []);

  const handleGenerate = useCallback(async (req: GenerateRequest) => {
    setGenerating(true);
    setError(null);
    try {
      const result = await generate(req);
      setActiveJobId(result.job.id);
      setView('progress');
    } catch (err) {
      if (err instanceof ForgeApiError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : 'Generation failed');
      }
      // Stay on wizard so user can retry
    } finally {
      setGenerating(false);
    }
  }, []);

  const handleCompleted = useCallback((job: ForgeJobDetail) => {
    setActiveJobId(job.id);
    setView('preview');
  }, []);

  const handleCancelled = useCallback(() => {
    setView('list');
    setActiveJobId(null);
  }, []);

  const handleRegenerate = useCallback(() => {
    setView('wizard');
    setActiveJobId(null);
  }, []);

  const handleClose = useCallback(() => {
    setView('list');
    setActiveJobId(null);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-xs flex items-center gap-2">
          <span className="font-medium">{t('forge.error.title') || 'Error'}:</span>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-accent-red/60 hover:text-accent-red"
          >
            ✕
          </button>
        </div>
      )}

      {/* Generating overlay */}
      {generating && view === 'wizard' && (
        <div className="absolute inset-0 bg-bg-primary/50 flex items-center justify-center z-10">
          <div className="flex items-center gap-2 text-sm text-accent-brand">
            <Hammer className="w-4 h-4 animate-pulse" />
            {t('forge.starting') || 'Starting generation...'}
          </div>
        </div>
      )}

      {/* View routing */}
      {view === 'list' && (
        <ForgeJobList onSelectJob={handleSelectJob} onNewJob={handleNewJob} />
      )}
      {view === 'wizard' && (
        <ForgeWizard onGenerate={handleGenerate} onCancel={handleClose} />
      )}
      {view === 'progress' && activeJobId && (
        <ForgeProgress
          jobId={activeJobId}
          onCompleted={handleCompleted}
          onCancelled={handleCancelled}
        />
      )}
      {view === 'preview' && activeJobId && (
        <ForgeResultPreview
          jobId={activeJobId}
          onRegenerate={handleRegenerate}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
