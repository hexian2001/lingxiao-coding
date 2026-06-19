/**
 * ForgeProgress — 生成进度展示（SSE 实时更新 + 状态机可视化）
 *
 * 连接 SSE 事件流，实时展示:
 * - 当前状态 + 进度条
 * - 步骤历史时间线
 * - 实时日志
 * - 错误展示
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  XCircle,
  Clock,
  Terminal,
} from 'lucide-react';
import { subscribeJobEvents, getJob } from './api';
import {
  TERMINAL_STATES,
  FAILED_STATES,
  STATE_LABELS,
  stateColorClass,
  stateBadgeClass,
  type ForgeJobDetail,
  type ForgeJobState,
  type ForgeStepRecord,
} from './types';

interface ForgeProgressProps {
  jobId: string;
  onCompleted: (job: ForgeJobDetail) => void;
  onCancelled: () => void;
}

interface LogEntry {
  timestamp: number;
  message: string;
  type: 'log' | 'state' | 'error';
  state?: ForgeJobState;
  progress?: number;
}

export default function ForgeProgress({ jobId, onCompleted, onCancelled }: ForgeProgressProps) {
  const { t } = useTranslation();
  const [job, setJob] = useState<ForgeJobDetail | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Initial fetch
  useEffect(() => {
    getJob(jobId).then(setJob).catch(() => { /* ignore */ });
  }, [jobId]);

  // SSE subscription
  useEffect(() => {
    const cleanup = subscribeJobEvents(jobId, {
      onOpen: () => setConnected(true),
      onStateChange: (event) => {
        setLogs((prev) => [...prev, {
          timestamp: Date.now(),
          message: event.message || `State → ${event.state || 'unknown'}`,
          type: 'state',
          state: event.state as ForgeJobState | undefined,
          progress: event.progress,
        }]);
        // Refresh job detail on state change
        getJob(jobId).then(setJob).catch(() => { /* ignore */ });
      },
      onProgress: (event) => {
        setLogs((prev) => [...prev, {
          timestamp: Date.now(),
          message: event.message || `Progress: ${event.progress ?? 0}%`,
          type: 'log',
          state: event.step as ForgeJobState | undefined,
          progress: event.progress,
        }]);
        if (event.progress !== undefined) {
          setJob((prev) => prev ? { ...prev, progress: event.progress! } : prev);
        }
      },
      onLog: (event) => {
        setLogs((prev) => [...prev, {
          timestamp: Date.now(),
          message: event.message || '',
          type: 'log',
          state: event.state as ForgeJobState | undefined,
          progress: event.progress,
        }]);
      },
      onError: (event) => {
        const msg = event.error?.message || 'Unknown error';
        setLogs((prev) => [...prev, {
          timestamp: Date.now(),
          message: msg,
          type: 'error',
        }]);
      },
      onDone: () => {
        setConnected(false);
        // Final fetch
        getJob(jobId, { includeCode: true }).then((finalJob) => {
          setJob(finalJob);
          if (finalJob.state === 'completed') {
            onCompleted(finalJob);
          }
        }).catch(() => { /* ignore */ });
      },
    });

    return cleanup;
  }, [jobId, onCompleted]);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const currentState = job?.state || 'pending';
  const progress = job?.progress ?? 0;
  const isTerminal = TERMINAL_STATES.has(currentState);
  const isFailed = FAILED_STATES.has(currentState);
  const stepHistory: ForgeStepRecord[] = job?.stepHistory || [];

  // Pipeline stages
  const stages: { state: ForgeJobState; label: string }[] = [
    { state: 'analyzing', label: t('forge.stage.analysis') || 'Analysis' },
    { state: 'generating', label: t('forge.stage.generation') || 'Generation' },
    { state: 'validating', label: t('forge.stage.validation') || 'Validation' },
    { state: 'registering', label: t('forge.stage.registration') || 'Registration' },
  ];

  function getStageStatus(stageState: ForgeJobState): 'pending' | 'active' | 'done' | 'failed' | 'skipped' {
    if (isFailed) {
      // Determine which stage failed
      const failedStage = currentState.replace('_failed', '') as ForgeJobState;
      if (stageState === failedStage) return 'failed';
      // Check if this stage completed before the failure
      const stageIdx = stages.findIndex((s) => s.state === stageState);
      const failedIdx = stages.findIndex((s) => s.state === failedStage);
      if (stageIdx < failedIdx) return 'done';
      return 'pending';
    }
    if (currentState === 'completed') return 'done';
    if (currentState === 'validation_skipped' && stageState === 'validating') return 'skipped';
    const stageIdx = stages.findIndex((s) => s.state === stageState);
    const currentIdx = stages.findIndex((s) => s.state === currentState);
    if (currentIdx === -1) {
      // Handle intermediate states (analyzed, generated, validated, registered)
      const stateOrder: ForgeJobState[] = ['analyzing', 'analyzed', 'generating', 'generated', 'validating', 'validation_skipped', 'validated', 'registering', 'registered'];
      const currentOrder = stateOrder.indexOf(currentState);
      const stageOrder = stateOrder.indexOf(stageState);
      if (stageOrder < currentOrder) return 'done';
      if (stageOrder === currentOrder) return 'active';
      return 'pending';
    }
    if (stageIdx < currentIdx) return 'done';
    if (stageIdx === currentIdx) return 'active';
    return 'pending';
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header: status + progress bar */}
      <div className="px-5 py-3 border-b border-border-muted">
        <div className="flex items-center gap-2 mb-2">
          {isTerminal ? (
            isFailed ? <XCircle className="w-4 h-4 text-accent-red" /> :
            currentState === 'cancelled' ? <XCircle className="w-4 h-4 text-text-tertiary" /> :
            <CheckCircle className="w-4 h-4 text-accent-green" />
          ) : (
            <Loader2 className="w-4 h-4 text-accent-brand animate-spin" />
          )}
          <span className={`text-sm font-medium ${stateColorClass(currentState)}`}>
            {STATE_LABELS[currentState]}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${stateBadgeClass(currentState)}`}>
            {Math.round(progress)}%
          </span>
          {/* SSE connection indicator */}
          <div className="flex items-center gap-1 ml-auto">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-accent-green animate-pulse' : 'bg-text-tertiary'}`} />
            <span className="text-[10px] text-text-tertiary">
              {connected ? (t('forge.sseConnected') || 'SSE') : (t('forge.sseDisconnected') || 'Offline')}
            </span>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              isFailed ? 'bg-accent-red' : isTerminal ? 'bg-accent-green' : 'bg-accent-brand'
            }`}
            style={{ width: `${Math.max(2, progress)}%` }}
          />
        </div>
      </div>

      {/* Pipeline stages */}
      <div className="px-5 py-3 border-b border-border-muted">
        <div className="flex items-center gap-1">
          {stages.map((stage, i) => {
            const status = getStageStatus(stage.state);
            return (
              <div key={stage.state} className="flex items-center gap-1 flex-1">
                <div className="flex flex-col items-center gap-1 flex-1">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs ${
                      status === 'done' ? 'bg-accent-green/20 text-accent-green' :
                      status === 'active' ? 'bg-accent-brand/20 text-accent-brand' :
                      status === 'failed' ? 'bg-accent-red/20 text-accent-red' :
                      status === 'skipped' ? 'bg-bg-tertiary text-text-tertiary' :
                      'bg-bg-tertiary text-text-tertiary'
                    }`}
                  >
                    {status === 'done' ? <CheckCircle className="w-4 h-4" /> :
                     status === 'active' ? <Loader2 className="w-4 h-4 animate-spin" /> :
                     status === 'failed' ? <XCircle className="w-4 h-4" /> :
                     i + 1}
                  </div>
                  <span className={`text-[10px] ${status === 'pending' ? 'text-text-tertiary' : 'text-text-secondary'}`}>
                    {stage.label}
                  </span>
                </div>
                {i < stages.length - 1 && (
                  <div className={`h-px flex-1 min-w-4 ${
                    status === 'done' ? 'bg-accent-green' : 'bg-border-default'
                  }`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Error display */}
      {job?.error && (
        <div className="px-5 py-2.5 bg-accent-red/10 border-b border-accent-red/20">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-accent-red shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-accent-red">
                {job.error.code}
              </div>
              <div className="text-xs text-accent-red/80 mt-0.5">
                {job.error.message}
              </div>
              {job.error.detail && (
                <div className="text-[10px] text-accent-red/60 mt-1 font-mono">
                  {job.error.detail}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main content: step history + logs */}
      <div className="flex-1 overflow-y-auto">
        {/* Step history timeline */}
        {stepHistory.length > 0 && (
          <div className="px-5 py-3 border-b border-border-muted">
            <h4 className="text-[10px] uppercase text-text-tertiary font-medium mb-2 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {t('forge.stepHistory') || 'Step History'}
            </h4>
            <div className="space-y-1">
              {stepHistory.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {step.success ? (
                    <CheckCircle className="w-3 h-3 text-accent-green shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-accent-red shrink-0" />
                  )}
                  <span className="text-text-secondary">{STATE_LABELS[step.state]}</span>
                  <span className="text-text-tertiary text-[10px] ml-auto">
                    {new Date(step.timestamp).toLocaleTimeString()}
                  </span>
                  {step.detail && (
                    <span className="text-text-tertiary text-[10px] truncate max-w-48" title={step.detail}>
                      {step.detail}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Live logs */}
        <div className="px-5 py-3">
          <h4 className="text-[10px] uppercase text-text-tertiary font-medium mb-2 flex items-center gap-1">
            <Terminal className="w-3 h-3" />
            {t('forge.liveLogs') || 'Live Logs'}
          </h4>
          <div className="space-y-0.5 font-mono text-[11px] max-h-64 overflow-y-auto">
            {logs.length === 0 && (
              <p className="text-text-tertiary italic">
                {t('forge.waitingForLogs') || 'Waiting for events...'}
              </p>
            )}
            {logs.map((log, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 ${
                  log.type === 'error' ? 'text-accent-red' :
                  log.type === 'state' ? 'text-accent-brand' :
                  'text-text-secondary'
                }`}
              >
                <span className="text-text-tertiary shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="break-all">{log.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-border-muted">
        <button
          onClick={onCancelled}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {t('forge.backToList') || 'Back to list'}
        </button>
        {isTerminal && job?.state === 'completed' && (
          <button
            onClick={() => onCompleted(job)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 transition-opacity"
          >
            <CheckCircle className="w-3.5 h-3.5" />
            {t('forge.viewResult') || 'View result'}
          </button>
        )}
        {isTerminal && isFailed && (
          <span className="text-xs text-accent-red">
            {t('forge.generationFailed') || 'Generation failed'}
          </span>
        )}
      </div>
    </div>
  );
}
