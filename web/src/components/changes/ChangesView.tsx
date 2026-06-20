/**
 * ChangesView — 文件变更与回退视图
 *
 * 双 Tab 布局：
 *   1. 文件变更 — 当前工作区与 HEAD 的 diff，可逐文件预览
 *   2. 会话回退 — 像 IDE 的 undo，点击回退到某个检查点
 *       同时还原文件和对话记录，操作前弹出确认对话框
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FilePlus2, FileMinus2, FileEdit, ArrowRightLeft,
  History, RotateCcw,
  AlertCircle, Loader2, FileText, Undo2,
  ShieldAlert, X, MessageSquare, ChevronDown, ChevronRight, CornerUpLeft,
  Target, HardDrive, Trash2, Zap,
} from 'lucide-react';
import { getServerToken } from '../../api/headers';
import { useFileChangesStore, type FileDiff, type Checkpoint, type SessionCheckpointGroup, type TurnCheckpointGroup } from '../../stores/fileChangesStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useDeliveryContextStore, type DeliveryContext } from '../../stores/deliveryContextStore';
import { buildRuntimeRefreshViewModel } from '../../utils/runtimeRefreshViewModel';
import DiffViewer from './DiffViewer';

const changeTypeIcons: Record<string, React.ReactNode> = {
  added: <FilePlus2 className="w-3.5 h-3.5 text-accent-green" />,
  modified: <FileEdit className="w-3.5 h-3.5 text-accent-blue" />,
  deleted: <FileMinus2 className="w-3.5 h-3.5 text-accent-red" />,
  renamed: <ArrowRightLeft className="w-3.5 h-3.5 text-accent-yellow" />,
};

const changeTypeBadge: Record<string, string> = {
  added: 'bg-accent-green/20 text-accent-green',
  modified: 'bg-accent-blue/20 text-accent-blue',
  deleted: 'bg-accent-red/20 text-accent-red',
  renamed: 'bg-accent-yellow/20 text-accent-yellow',
};

type TabKey = 'changes' | 'rollback';

function checkpointLabelDisplay(cp: Checkpoint): string {
  const cleaned = cp.label
    .replace(/^\[agent:[^\]]+\]\s*/, '')
    .replace(/^\[task:[^\]]+\]\s*/, '')
    .replace(/^\[turn:\d+\]\s*/, '')
    .replace(/^\[tool\]\s*/, '')
    .trim();
  return cleaned || (cp.toolName ? `Auto: ${cp.toolName}` : cp.label);
}

function compactPath(path?: string, max = 72): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= max) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts.slice(-3).join('/');
  return tail.length < max ? `.../${tail}` : `...${normalized.slice(-(max - 3))}`;
}

function DeliveryContextBanner({
  context,
  currentSessionId,
  targetSessionId,
  onClear,
}: {
  context: DeliveryContext;
  currentSessionId: string | null;
  targetSessionId: string;
  onClear: () => void;
}) {
  const filesCreated = context.filesCreated?.length ?? 0;
  const filesModified = context.filesModified?.length ?? 0;
  const verificationCount = context.verificationCount ?? 0;
  const isCrossSession = Boolean(currentSessionId && targetSessionId !== currentSessionId);
  const taskLabel = context.taskTitle || context.taskId || 'Task';

  return (
    <div className="shrink-0 border-b border-accent-brand/20 bg-accent-brand/5 px-4 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-accent-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-text-primary truncate">Pinned delivery: {taskLabel}</span>
            {context.taskId && <span className="font-mono text-text-tertiary">#{context.taskId.slice(0, 8)}</span>}
            {context.agentName && <span className="text-accent-brand">@{context.agentName}</span>}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
            <span className="font-mono">session {targetSessionId.slice(0, 8)}</span>
            {context.workspace && <span className="min-w-0 truncate font-mono">cwd {compactPath(context.workspace, 80)}</span>}
            {context.writeScope?.length ? <span>{context.writeScope.length} scoped paths</span> : null}
            {(filesCreated + filesModified) > 0 && <span>{filesCreated} created · {filesModified} modified</span>}
            {verificationCount > 0 && <span>{verificationCount} verification checks</span>}
          </div>
          {isCrossSession && (
            <div className="mt-1 text-[11px] text-accent-yellow">
              Diff scope is pinned to this task session; active chat session is {currentSessionId?.slice(0, 8)}.
            </div>
          )}
        </div>
        <button
          type="button"
          className="codex-icon-btn !h-7 !min-w-7 shrink-0"
          onClick={onClear}
          title="Clear delivery context"
          aria-label="Clear delivery context"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Confirmation Modal ──────────────────────────────────────────────
function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  files,
  scope,
  otherSessionWarning,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  files: string[];
  scope: 'code' | 'conversation' | 'all';
  otherSessionWarning?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="lx-overlay p-4" onClick={onCancel}>
      <div
        className="bg-bg-primary border border-border-default rounded-lg shadow-xl max-w-lg w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <ShieldAlert className="w-7 h-7 text-accent-red shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-text-primary mb-1">{title}</h3>
            <p className="text-xs text-text-secondary leading-relaxed">{message}</p>
          </div>
        </div>

        {/* Scope indicator */}
        <div className="flex items-center gap-1.5 mb-3 px-2 py-1.5 bg-bg-secondary rounded border border-border-default/50">
          {scope === 'code' && <RotateCcw className="w-3.5 h-3.5 text-accent-blue" />}
          {scope === 'conversation' && <MessageSquare className="w-3.5 h-3.5 text-accent-yellow" />}
          {scope === 'all' && <RotateCcw className="w-3.5 h-3.5 text-accent-red" />}
          <span className="text-xs text-text-secondary">
            {scope === 'code' && t('changes.scopeCode')}
            {scope === 'conversation' && t('changes.scopeConversation')}
            {scope === 'all' && t('changes.scopeAll')}
          </span>
        </div>

        {/* Affected files preview */}
        {files.length > 0 && scope !== 'conversation' && (
          <div className="mb-3 px-3 py-2 bg-bg-secondary border border-border-default rounded-md">
            <div className="text-xs font-medium text-text-tertiary mb-1.5">{t('fileChanges.affectedFiles')}:</div>
            <div className="flex flex-wrap gap-1">
              {files.slice(0, 10).map((f) => (
                <span key={f} className="px-1.5 py-0.5 text-[10px] bg-bg-tertiary rounded text-text-secondary font-mono max-w-[160px] truncate">
                  {f}
                </span>
              ))}
              {files.length > 10 && (
                <span className="px-1.5 py-0.5 text-[10px] text-text-tertiary">
                  +{files.length - 10} {t('fileChanges.moreFiles')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Cross-session warning */}
        {otherSessionWarning && (
          <div className="flex items-start gap-1.5 mb-3 px-2 py-1.5 bg-accent-yellow/5 rounded border border-accent-yellow/30">
            <AlertCircle className="w-3.5 h-3.5 text-accent-yellow shrink-0 mt-0.5" />
            <span className="text-[11px] text-accent-yellow leading-relaxed">{otherSessionWarning}</span>
          </div>
        )}

        {/* Warning */}
        <div className="flex items-center gap-1.5 mb-4 px-2 py-1.5 bg-accent-red/5 rounded border border-accent-red/20">
          <AlertCircle className="w-3.5 h-3.5 text-accent-red shrink-0" />
          <span className="text-[11px] text-accent-red font-medium">{t('fileChanges.rollbackWarning')}</span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs rounded border border-border-default text-text-secondary hover:bg-bg-hover transition-colors"
            onClick={onCancel}
          >
            {t('app.cancel')}
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-accent-red text-white hover:bg-accent-red/80 transition-colors font-medium"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── File Changes Tab ────────────────────────────────────────────────
function FileChangesTab({ sessionIdOverride }: { sessionIdOverride?: string }) {
  const { t } = useTranslation();
  const activeSessionId = useSessionStore((s) => s.sessionId);
  const sessionId = sessionIdOverride || activeSessionId;
  const phase = useSessionStore((s) => s.phase);
  const runtimeSnapshot = useSessionStore((s) => s.runtimeSnapshot);
  const {
    changes, selectedFilePath, selectedDiff, isLoading, error,
    fetchWorkingChanges, fetchFileDiff, setSelectedFilePath, clearError,
    revertFiles, revertAll,
  } = useFileChangesStore();
  const [confirmRevertAll, setConfirmRevertAll] = useState(false);
  const refreshView = useMemo(
    () => buildRuntimeRefreshViewModel({ sessionId: activeSessionId, phase, runtimeSnapshot }),
    [activeSessionId, phase, runtimeSnapshot],
  );

  useEffect(() => {
    setSelectedFilePath(null);
    if (sessionId) fetchWorkingChanges(sessionId);
  }, [sessionId, fetchWorkingChanges, setSelectedFilePath]);

  // Refresh only when the active runtime reaches a stable window.
  useEffect(() => {
    if (sessionId && sessionId === activeSessionId && refreshView.ready) {
      fetchWorkingChanges(sessionId);
    }
  }, [activeSessionId, sessionId, refreshView.ready, refreshView.refreshKey, fetchWorkingChanges]);

  const handleFileClick = (filePath: string) => {
    setSelectedFilePath(filePath);
    if (sessionId) fetchFileDiff(sessionId, filePath);
  };

  const changesByType = changes.reduce((acc, c) => {
    if (!acc[c.changeType]) acc[c.changeType] = [];
    acc[c.changeType].push(c);
    return acc;
  }, {} as Record<string, FileDiff[]>);

  const totalChanges = changes.length;
  const totalAdditions = changes.reduce((s, c) => s + c.additions, 0);
  const totalDeletions = changes.reduce((s, c) => s + c.deletions, 0);

  return (
    <div className="flex h-full">
      {/* Left — file list */}
      <div className="w-72 border-r border-border-default flex flex-col bg-bg-secondary overflow-hidden">
        {/* Summary header */}
        <div className="px-3 py-2.5 border-b border-border-default">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-primary">
              {t('fileChanges.changesSection')}
              {totalChanges > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-accent-brand/20 text-accent-brand rounded-full">
                  {totalChanges}
                </span>
              )}
            </h3>
            {totalChanges > 0 && (
              <button
                className="px-2 py-1 text-[11px] rounded border border-border-default text-text-secondary hover:bg-accent-red/10 hover:text-accent-red hover:border-accent-red/30 transition-colors flex items-center gap-1"
                onClick={() => setConfirmRevertAll(true)}
              >
                <RotateCcw className="w-3 h-3" />
                {t('changes.revertAllFiles')}
              </button>
            )}
          </div>
          {totalChanges > 0 && (
            <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary">
              {totalAdditions > 0 && <span className="text-accent-green">+{totalAdditions}</span>}
              {totalDeletions > 0 && <span className="text-accent-red">-{totalDeletions}</span>}
              <span className="text-text-tertiary">{totalChanges} {t('fileChanges.files')}</span>
            </div>
          )}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && changes.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-accent-brand animate-spin" />
            </div>
          ) : totalChanges === 0 ? (
            <div className="px-3 py-8 text-center">
              <FileText className="w-8 h-8 text-text-tertiary/30 mx-auto mb-2" />
              <p className="text-text-tertiary text-sm">{t('fileChanges.empty')}</p>
            </div>
          ) : (
            Object.entries(changesByType).map(([type, files]) => (
              <div key={type}>
                <div className="px-3 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider flex items-center gap-1.5 sticky top-0 bg-bg-secondary z-10">
                  {changeTypeIcons[type]}
                  {type} ({files.length})
                </div>
                {files.map((file) => (
                  <div key={file.path} className="group flex items-center">
                    <button
                      className={`flex-1 px-3 py-1.5 text-left text-xs hover:bg-bg-hover flex items-center gap-2 transition-colors ${
                        selectedFilePath === file.path ? 'bg-bg-hover text-text-primary' : 'text-text-secondary'
                      }`}
                      onClick={() => handleFileClick(file.path)}
                    >
                      <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${changeTypeBadge[file.changeType]}`}>
                        {file.changeType === 'added' ? '+A' : file.changeType === 'deleted' ? '-D' : file.changeType === 'renamed' ? 'R' : 'M'}
                      </span>
                      <span className="truncate flex-1">{file.path}</span>
                      <span className="text-text-tertiary whitespace-nowrap">
                        {file.additions > 0 && <span className="text-accent-green">+{file.additions}</span>}
                        {file.additions > 0 && file.deletions > 0 && <span> </span>}
                        {file.deletions > 0 && <span className="text-accent-red">-{file.deletions}</span>}
                      </span>
                    </button>
                    <button
                      className="px-1.5 py-1 text-[10px] text-text-tertiary hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={(e) => { e.stopPropagation(); if (sessionId) revertFiles(sessionId, [file.path]); }}
                      title={t('changes.revertFile')}
                    >
                      <Undo2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right — diff viewer */}
      <div className="flex-1 overflow-hidden">
        {error && (
          <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={clearError} className="text-xs hover:underline">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {selectedFilePath && selectedDiff ? (
          <DiffViewer diff={selectedDiff} />
        ) : selectedFilePath && isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
            {totalChanges > 0 ? t('fileChanges.showChanges') : t('fileChanges.empty')}
          </div>
        )}
      </div>

      {/* Revert All confirmation */}
      <ConfirmModal
        open={confirmRevertAll}
        title={t('changes.revertAllFiles')}
        message={t('changes.revertAllFilesConfirm')}
        confirmLabel={t('changes.revertAllFiles')}
        files={changes.map(c => c.path)}
        scope="code"
        onConfirm={() => { if (sessionId) { revertAll(sessionId); setConfirmRevertAll(false); } }}
        onCancel={() => setConfirmRevertAll(false)}
      />
    </div>
  );
}

// ── Session Rollback Tab ────────────────────────────────────────────
function SessionRollbackTab({ focusSessionId }: { focusSessionId?: string | null }) {
  const { t } = useTranslation();
  const currentSessionId = useSessionStore((s) => s.sessionId);
  const checkpointSessionId = focusSessionId || currentSessionId;
  const phase = useSessionStore((s) => s.phase);
  const runtimeSnapshot = useSessionStore((s) => s.runtimeSnapshot);
  const {
    sessionGroups, selectedCheckpoint, isLoading, error,
    fetchAllCheckpoints, revertToCheckpoint, setSelectedCheckpoint, clearError,
    diskUsage, isCleaningUp, cleanupMessage,
    fetchDiskUsage, runGc, purgeHistory, clearCleanupMessage,
  } = useFileChangesStore();

  const [confirmRevert, setConfirmRevert] = useState<{ cp: Checkpoint; sessionId: string; scope: 'all' | 'code' | 'conversation' } | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [otherSessionWarning, setOtherSessionWarning] = useState<string | undefined>();
  const [showCleanupPanel, setShowCleanupPanel] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const refreshView = useMemo(
    () => buildRuntimeRefreshViewModel({ sessionId: currentSessionId, phase, runtimeSnapshot }),
    [currentSessionId, phase, runtimeSnapshot],
  );

  // Load all checkpoints on mount
  useEffect(() => {
    fetchAllCheckpoints(checkpointSessionId ?? undefined);
  }, [checkpointSessionId, fetchAllCheckpoints]);

  // Load disk usage when cleanup panel is opened
  useEffect(() => {
    if (showCleanupPanel && checkpointSessionId) {
      fetchDiskUsage(checkpointSessionId);
    }
  }, [showCleanupPanel, checkpointSessionId, fetchDiskUsage]);

  // Auto-expand focused session
  useEffect(() => {
    if (checkpointSessionId) {
      setExpandedSessions(prev => new Set([...prev, checkpointSessionId]));
    }
  }, [checkpointSessionId]);

  // Refresh when backend runtime reaches a stable window.
  useEffect(() => {
    if (refreshView.ready) {
      fetchAllCheckpoints(checkpointSessionId ?? undefined);
    }
  }, [refreshView.ready, refreshView.refreshKey, checkpointSessionId, fetchAllCheckpoints]);

  const toggleSession = (sid: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const handleRevertClick = async (cp: Checkpoint, sessionId: string, scope: 'all' | 'code' | 'conversation' = 'all') => {
    // 先查询是否有其他 session 在此 checkpoint 之后有变更
    setOtherSessionWarning(undefined);
    try {
      const res = await fetch(
        `/api/v1/file-changes/other-session-changes?sessionId=${encodeURIComponent(sessionId)}&commitHash=${encodeURIComponent(cp.id)}`,
        { headers: { 'x-lingxiao-token': getServerToken() } },
      );
      if (res.ok) {
        const data = await res.json() as { hasOtherSessionChanges: boolean; otherSessionIds: string[] };
        if (data.hasOtherSessionChanges && data.otherSessionIds.length > 0) {
          setOtherSessionWarning(
            t('changes.otherSessionWarning', { ids: data.otherSessionIds.map(id => id.slice(0, 8)).join(', ') }),
          );
        }
      }
    } catch {
      // Non-critical: proceed without warning
    }
    setConfirmRevert({ cp, sessionId, scope });
  };

  const handleRevertCode = (cp: Checkpoint) => handleRevertClick(cp, currentSessionId || cp.id, 'code');
  const handleRevertConversation = (cp: Checkpoint) => handleRevertClick(cp, currentSessionId || cp.id, 'conversation');

  const handleConfirmRevert = () => {
    if (confirmRevert) {
      revertToCheckpoint(confirmRevert.sessionId, confirmRevert.cp.id, confirmRevert.scope);
      setConfirmRevert(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-default bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <Undo2 className="w-4 h-4 text-accent-brand" />
          <h3 className="text-sm font-medium text-text-primary">{t('fileChanges.rollbackTitle')}</h3>
          {/* 磁盘清理按钮 */}
          <button
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            onClick={() => setShowCleanupPanel(s => !s)}
          >
            <HardDrive className="w-3.5 h-3.5" />
            {t('fileChanges.diskCleanup', { defaultValue: 'Disk Cleanup' })}
          </button>
        </div>
        <p className="text-xs text-text-tertiary">{t('fileChanges.rollbackDesc')}</p>

        {/* 磁盘清理面板 */}
        {showCleanupPanel && (
          <div className="mt-3 p-3 rounded-lg border border-border-default bg-bg-tertiary/50 space-y-3">
            {/* 磁盘使用统计 */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5" />
                {t('fileChanges.diskUsage', { defaultValue: 'Disk Usage' })}
              </span>
              {diskUsage ? (
                <span className={diskUsage.sizeBytes > 500 * 1024 * 1024 ? 'text-accent-red font-medium' : 'text-text-tertiary'}>
                  {(diskUsage.sizeBytes / 1024 / 1024).toFixed(1)} MB · {diskUsage.commitCount} {t('fileChanges.checkpoints', { defaultValue: 'checkpoints' })}
                </span>
              ) : (
                <span className="text-text-tertiary">—</span>
              )}
            </div>

            {/* 清理消息 */}
            {cleanupMessage && (
              <div className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-bg-secondary border border-border-default">
                <Zap className="w-3.5 h-3.5 text-accent-yellow shrink-0" />
                <span className="flex-1 text-text-secondary">{cleanupMessage}</span>
                <button onClick={clearCleanupMessage}><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex items-center gap-2">
              {/* GC 清理 */}
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isCleaningUp || !checkpointSessionId}
                onClick={() => checkpointSessionId && runGc(checkpointSessionId)}
              >
                {isCleaningUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {t('fileChanges.runGc', { defaultValue: 'Run GC' })}
              </button>

              {/* 核弹级清理 */}
              {!confirmPurge ? (
                <button
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isCleaningUp || !checkpointSessionId}
                  onClick={() => setConfirmPurge(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('fileChanges.purgeAll', { defaultValue: 'Purge All' })}
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-accent-red font-medium">{t('fileChanges.purgeConfirm', { defaultValue: 'Delete all history?' })}</span>
                  <button
                    className="px-2 py-1 text-xs rounded bg-accent-red text-white hover:bg-accent-red/80 transition-colors"
                    disabled={isCleaningUp}
                    onClick={() => {
                      if (checkpointSessionId) purgeHistory(checkpointSessionId);
                      setConfirmPurge(false);
                    }}
                  >
                    {t('common.confirm', { defaultValue: 'Confirm' })}
                  </button>
                  <button
                    className="px-2 py-1 text-xs rounded border border-border-default text-text-secondary hover:text-text-primary transition-colors"
                    onClick={() => setConfirmPurge(false)}
                  >
                    {t('common.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </div>
              )}
            </div>

            {/* 说明文字 */}
            <p className="text-xs text-text-tertiary/70">
              {t('fileChanges.cleanupHint', { defaultValue: 'GC reclaims disk space while keeping snapshots. Purge deletes all history and rebuilds on next snapshot.' })}
            </p>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-sm flex items-center gap-2 shrink-0">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={clearError}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Session groups */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && sessionGroups.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent-brand animate-spin" />
          </div>
        ) : sessionGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
            <History className="w-10 h-10 text-text-tertiary/30 mb-3" />
            <p className="text-sm">{t('fileChanges.noCheckpoints')}</p>
            <p className="text-xs mt-1 text-text-tertiary/70">{t('fileChanges.checkpointHint')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border-default/50">
            {sessionGroups.map((group) => (
              <SessionGroup
                key={group.sessionId}
                group={group}
                currentSessionId={currentSessionId}
                expanded={expandedSessions.has(group.sessionId)}
                onToggle={() => toggleSession(group.sessionId)}
                selectedCheckpoint={selectedCheckpoint}
                onSelectCheckpoint={setSelectedCheckpoint}
                onRevert={(cp) => handleRevertClick(cp, group.sessionId, 'all')}
                onRevertCode={(cp) => handleRevertClick(cp, group.sessionId, 'code')}
                onRevertConversation={(cp) => handleRevertClick(cp, group.sessionId, 'conversation')}
              />
            ))}
          </div>
        )}
      </div>

      {/* Revert confirmation modal */}
      <ConfirmModal
        open={!!confirmRevert}
        title={t('fileChanges.revertConfirmTitle')}
        message={t('fileChanges.revertConfirmMsg', {
          label: confirmRevert?.cp.label || '',
          files: confirmRevert?.cp.files.length || 0,
        })}
        confirmLabel={t('changes.revert')}
        files={confirmRevert?.cp.files || []}
        scope={confirmRevert?.scope || 'all'}
        otherSessionWarning={otherSessionWarning}
        onConfirm={handleConfirmRevert}
        onCancel={() => { setConfirmRevert(null); setOtherSessionWarning(undefined); }}
      />
    </div>
  );
}

// ── Session Group ────────────────────────────────────────────────────
function CheckpointCard({
  cp,
  isLatest,
  isCurrent,
  selectedCheckpoint,
  onSelectCheckpoint,
  onRevert,
  onRevertCode,
  onRevertConversation,
  indent = false,
}: {
  cp: Checkpoint;
  isLatest: boolean;
  isCurrent: boolean;
  selectedCheckpoint: string | null;
  onSelectCheckpoint: (id: string | null) => void;
  onRevert: (cp: Checkpoint) => void;
  onRevertCode?: (cp: Checkpoint) => void;
  onRevertConversation?: (cp: Checkpoint) => void;
  indent?: boolean;
}) {
  const { t } = useTranslation();
  // DB-only checkpoints have no code snapshot, but their timestamp can still roll back conversation.
  const isDbOnly = cp.id.startsWith('db-');
  const canRevertCode = !isDbOnly;
  const canRevertConversation = true;
  const canRevertAll = !isDbOnly;
  const hasChanges = cp.files.length > 0;
  const isSelected = selectedCheckpoint === cp.id;
  const isRevertCommit = cp.label.startsWith('Revert to:');

  const typeColor = cp.type === 'turn'
    ? 'bg-accent-brand border-accent-brand'
    : cp.type === 'tool'
      ? 'bg-bg-primary border-border-default'
      : isRevertCommit
        ? 'bg-accent-yellow/60 border-accent-yellow'
        : 'bg-bg-secondary border-border-default/50';

  const labelDisplay = checkpointLabelDisplay(cp);
  const isAgentCheckpoint = cp.actorType === 'agent' || Boolean(cp.agentId && cp.agentId !== 'leader');
  const actorLabel = isAgentCheckpoint
    ? `@${cp.agentName || cp.agentId || t('changes.actorAgent')}`
    : cp.actorType === 'leader'
      ? t('changes.actorLeader')
      : null;
  const taskLabel = isAgentCheckpoint && cp.taskId && cp.taskId !== 'unknown' ? cp.taskId : null;

  return (
    <div className={`relative ${indent ? 'ml-4' : ''}`}>
      <div className={`absolute -left-[21px] top-3 w-2 h-2 rounded-full border-2 ${typeColor}`} />
      <div
        className={`border rounded-md cursor-pointer transition-colors ${
          isSelected
            ? 'border-accent-brand bg-accent-brand/5'
            : isRevertCommit
              ? 'border-accent-yellow/30 bg-accent-yellow/5 hover:border-accent-yellow/50'
              : hasChanges
                ? 'border-border-default hover:border-border-hover'
                : 'border-border-default/40 opacity-60'
        }`}
        onClick={() => onSelectCheckpoint(isSelected ? null : cp.id)}
      >
        <div className="px-3 py-2 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              {isLatest && isCurrent && (
                <span className="px-1 py-0.5 text-[10px] rounded bg-accent-brand/20 text-accent-brand font-medium">
                  {t('fileChanges.latest')}
                </span>
              )}
              {isRevertCommit && (
                <span className="px-1 py-0.5 text-[10px] rounded bg-accent-yellow/20 text-accent-yellow font-medium flex items-center gap-0.5">
                  <CornerUpLeft className="w-2.5 h-2.5" />{t('changes.revertRecord')}
                </span>
              )}
              {actorLabel && (
                <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                  isAgentCheckpoint
                    ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/20'
                    : 'bg-accent-brand/15 text-accent-brand border border-accent-brand/20'
                }`}>
                  {actorLabel}
                </span>
              )}
              {isAgentCheckpoint && cp.agentRole && (
                <span className="px-1 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary">
                  {cp.agentRole}
                </span>
              )}
              {taskLabel && (
                <span className="px-1 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary font-mono">
                  {taskLabel}
                </span>
              )}
              {cp.type === 'tool' && (
                <span className="px-1 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary font-mono">
                  {cp.toolName || 'tool'}
                </span>
              )}
              <span className={`text-xs truncate ${
                isRevertCommit ? 'text-accent-yellow/80' : hasChanges ? 'text-text-primary' : 'text-text-tertiary'
              }`}>
                {labelDisplay}
              </span>
            </div>
            <div className="text-[11px] text-text-tertiary mt-0.5 flex items-center gap-2">
              <span>{new Date(cp.createdAt).toLocaleString()}</span>
              {hasChanges && (
                <>
                  <span>·</span>
                  <span>{cp.files.length} {t('changes.files')}</span>
                  {cp.additions > 0 && <span className="text-accent-green">+{cp.additions}</span>}
                  {cp.deletions > 0 && <span className="text-accent-red">-{cp.deletions}</span>}
                </>
              )}
            </div>
          </div>
          {canRevertCode || canRevertConversation || canRevertAll ? (
            <div className="flex items-center gap-1 shrink-0">
              {canRevertCode && (
                <button
                  className="px-1.5 py-1 text-[10px] rounded border border-border-default text-text-secondary hover:bg-accent-blue/10 hover:text-accent-blue hover:border-accent-blue/30 transition-colors flex items-center gap-0.5"
                  onClick={(e) => { e.stopPropagation(); onRevertCode?.(cp); }}
                  title={t('changes.revertCode')}
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  {t('changes.revertCode')}
                </button>
              )}
              {canRevertConversation && (
                <button
                  className="px-1.5 py-1 text-[10px] rounded border border-border-default text-text-secondary hover:bg-accent-yellow/10 hover:text-accent-yellow hover:border-accent-yellow/30 transition-colors flex items-center gap-0.5"
                  onClick={(e) => { e.stopPropagation(); onRevertConversation?.(cp); }}
                  title={t('changes.revertConversation')}
                >
                  <MessageSquare className="w-2.5 h-2.5" />
                  {t('changes.revertConversation')}
                </button>
              )}
              {canRevertAll && (
                <button
                  className="px-1.5 py-1 text-[10px] rounded border border-border-default text-text-secondary hover:bg-accent-red/10 hover:text-accent-red hover:border-accent-red/30 transition-colors flex items-center gap-0.5"
                  onClick={(e) => { e.stopPropagation(); onRevert(cp); }}
                  title={t('changes.revertAll')}
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  {t('changes.revertAll')}
                </button>
              )}
              {isDbOnly && (
                <span className="px-1.5 py-1 text-[10px] text-text-tertiary italic">
                  {t('changes.noGitSnapshot')}
                </span>
              )}
            </div>
          ) : null}
        </div>
        {isSelected && cp.files.length > 0 && (
          <div className="px-3 pb-2 border-t border-border-default/40 pt-1.5">
            <div className="flex flex-wrap gap-1">
              {cp.files.slice(0, 15).map((f) => (
                <span key={f} className="px-1.5 py-0.5 text-[10px] bg-bg-tertiary rounded text-text-secondary font-mono max-w-[180px] truncate">
                  {f}
                </span>
              ))}
              {cp.files.length > 15 && (
                <span className="px-1.5 py-0.5 text-[10px] text-text-tertiary">
                  +{cp.files.length - 15} {t('fileChanges.moreFiles')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TurnGroup({
  turn,
  isFirstTurn,
  isCurrent,
  selectedCheckpoint,
  onSelectCheckpoint,
  onRevert,
  onRevertCode,
  onRevertConversation,
}: {
  turn: TurnCheckpointGroup;
  isFirstTurn: boolean;
  isCurrent: boolean;
  selectedCheckpoint: string | null;
  onSelectCheckpoint: (id: string | null) => void;
  onRevert: (cp: Checkpoint) => void;
  onRevertCode?: (cp: Checkpoint) => void;
  onRevertConversation?: (cp: Checkpoint) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(isFirstTurn);
  const hasTools = turn.toolCheckpoints.length > 0;

  const turnLabel = turn.turnStart
    ? turn.turnStart.label.replace(/^\[turn:\d+\]\s*/, '')
    : `Turn ${turn.turnNumber}`;

  const totalTurnAdditions = [...(turn.turnStart ? [turn.turnStart] : []), ...turn.toolCheckpoints].reduce((s, cp) => s + cp.additions, 0);
  const totalTurnDeletions = [...(turn.turnStart ? [turn.turnStart] : []), ...turn.toolCheckpoints].reduce((s, cp) => s + cp.deletions, 0);

  if (turn.turnNumber === 0) {
    // Render unassigned checkpoints (session_start, etc.) directly
    return (
      <div className="relative border-l border-border-default/60 ml-1.5 pl-4 space-y-1.5 pb-1.5">
        {turn.turnStart && (
          <CheckpointCard
            cp={turn.turnStart}
            isLatest={false}
            isCurrent={isCurrent}
            selectedCheckpoint={selectedCheckpoint}
            onSelectCheckpoint={onSelectCheckpoint}
            onRevert={onRevert}
            onRevertCode={onRevertCode}
            onRevertConversation={onRevertConversation}
          />
        )}
        {turn.toolCheckpoints.map(cp => (
          <CheckpointCard
            key={cp.id}
            cp={cp}
            isLatest={false}
            isCurrent={isCurrent}
            selectedCheckpoint={selectedCheckpoint}
            onSelectCheckpoint={onSelectCheckpoint}
            onRevert={onRevert}
            onRevertCode={onRevertCode}
            onRevertConversation={onRevertConversation}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="border border-border-default/50 rounded-md mb-1.5 overflow-hidden">
      {/* Turn header */}
      <button
        className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left bg-bg-secondary/50"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
          : <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
        }
        <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-accent-brand/15 text-accent-brand shrink-0">T{turn.turnNumber}</span>
        <span className="text-xs text-text-secondary truncate flex-1">{turnLabel}</span>
        <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary shrink-0">
          {hasTools && <span>{turn.toolCheckpoints.length} {t('changes.steps')}</span>}
          {totalTurnAdditions > 0 && <span className="text-accent-green">+{totalTurnAdditions}</span>}
          {totalTurnDeletions > 0 && <span className="text-accent-red">-{totalTurnDeletions}</span>}
        </div>
      </button>

      {/* Turn checkpoints */}
      {expanded && (
        <div className="px-3 pt-2 pb-2">
          <div className="relative border-l border-border-default/60 ml-1.5 pl-4 space-y-1.5">
            {turn.turnStart && (
              <CheckpointCard
                cp={turn.turnStart}
                isLatest={isFirstTurn}
                isCurrent={isCurrent}
                selectedCheckpoint={selectedCheckpoint}
                onSelectCheckpoint={onSelectCheckpoint}
                onRevert={onRevert}
                onRevertCode={onRevertCode}
                onRevertConversation={onRevertConversation}
              />
            )}
            {turn.toolCheckpoints.map((cp, tidx) => (
              <CheckpointCard
                key={cp.id}
                cp={cp}
                isLatest={isFirstTurn && !turn.turnStart && tidx === 0}
                isCurrent={isCurrent}
                selectedCheckpoint={selectedCheckpoint}
                onSelectCheckpoint={onSelectCheckpoint}
                onRevert={onRevert}
                onRevertCode={onRevertCode}
                onRevertConversation={onRevertConversation}
                indent
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionGroup({
  group,
  currentSessionId,
  expanded,
  onToggle,
  selectedCheckpoint,
  onSelectCheckpoint,
  onRevert,
  onRevertCode,
  onRevertConversation,
}: {
  group: SessionCheckpointGroup;
  currentSessionId: string | null;
  expanded: boolean;
  onToggle: () => void;
  selectedCheckpoint: string | null;
  onSelectCheckpoint: (id: string | null) => void;
  onRevert: (cp: Checkpoint) => void;
  onRevertCode?: (cp: Checkpoint) => void;
  onRevertConversation?: (cp: Checkpoint) => void;
}) {
  const { t } = useTranslation();
  const isCurrent = group.sessionId === currentSessionId;

  const totalAdditions = group.checkpoints.reduce((s, cp) => s + cp.additions, 0);
  const totalDeletions = group.checkpoints.reduce((s, cp) => s + cp.deletions, 0);
  const hasTurns = group.turns && group.turns.length > 0;

  const sessionLabel = group.summary
    ? (group.summary.length > 40 ? group.summary.slice(0, 40) + '…' : group.summary)
    : (group.sessionId === '__untagged__' ? t('changes.untaggedRecords') : group.sessionId.slice(0, 8));

  const sessionDate = new Date(group.createdAt * 1000).toLocaleString();

  return (
    <div className="bg-bg-primary">
      {/* Session header row */}
      <button
        className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left"
        onClick={onToggle}
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
        }
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {isCurrent && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-accent-brand/20 text-accent-brand font-medium shrink-0">
                {t('history.current')}
              </span>
            )}
            <span className="text-sm font-medium text-text-primary truncate">{sessionLabel}</span>
          </div>
          <div className="text-xs text-text-tertiary mt-0.5 flex items-center gap-2">
            <span>{sessionDate}</span>
            <span>·</span>
            <span>{group.checkpoints.length} {t('changes.snapshots')}</span>
            {totalAdditions > 0 && <span className="text-accent-green">+{totalAdditions}</span>}
            {totalDeletions > 0 && <span className="text-accent-red">-{totalDeletions}</span>}
          </div>
        </div>
      </button>

      {/* Turn/checkpoint timeline */}
      {expanded && (
        <div className="pl-4 pr-4 pb-3">
          {hasTurns ? (
            <div className="space-y-0">
              {group.turns.map((turn, idx) => (
                <TurnGroup
                  key={turn.turnNumber}
                  turn={turn}
                  isFirstTurn={idx === 0}
                  isCurrent={isCurrent}
                  selectedCheckpoint={selectedCheckpoint}
                  onSelectCheckpoint={onSelectCheckpoint}
                  onRevert={onRevert}
                  onRevertCode={onRevertCode}
                  onRevertConversation={onRevertConversation}
                />
              ))}
            </div>
          ) : (
            /* Fallback: flat list if no turns data */
            <div className="relative border-l border-border-default/60 ml-1.5 pl-4 space-y-1.5">
              {group.checkpoints.map((cp, idx) => (
                <CheckpointCard
                  key={cp.id}
                  cp={cp}
                  isLatest={idx === 0}
                  isCurrent={isCurrent}
                  selectedCheckpoint={selectedCheckpoint}
                  onSelectCheckpoint={onSelectCheckpoint}
                  onRevert={onRevert}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────
export default function ChangesView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const deliveryContext = useDeliveryContextStore((s) => s.context);
  const clearDeliveryContext = useDeliveryContextStore((s) => s.clearContext);
  const [activeTab, setActiveTab] = useState<TabKey>('changes');
  const targetSessionId = deliveryContext?.sessionId || sessionId;

  if (!targetSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        <p>{t('app.connecting')}</p>
      </div>
    );
  }

  const tabs: { key: TabKey; icon: React.ReactNode; label: string }[] = [
    { key: 'changes', icon: <FileText className="w-4 h-4" />, label: t('fileChanges.tabChanges') },
    { key: 'rollback', icon: <Undo2 className="w-4 h-4" />, label: t('fileChanges.tabRollback') },
  ];

  return (
    <div className="flex flex-col h-full">
      {deliveryContext && (
        <DeliveryContextBanner
          context={deliveryContext}
          currentSessionId={sessionId}
          targetSessionId={targetSessionId}
          onClear={clearDeliveryContext}
        />
      )}

      {/* Tab bar */}
      <div className="flex border-b border-border-default bg-bg-secondary shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-accent-brand text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'changes'
          ? <FileChangesTab sessionIdOverride={targetSessionId !== sessionId ? targetSessionId : undefined} />
          : <SessionRollbackTab focusSessionId={targetSessionId} />}
      </div>
    </div>
  );
}
