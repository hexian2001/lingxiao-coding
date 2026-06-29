import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitBranch, Upload, Download, RefreshCw, AlertCircle, RotateCcw, GitMerge,
  Target, X,
} from 'lucide-react';
import { useGitStore } from '../../stores/gitStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useDeliveryContextStore, type DeliveryContext } from '../../stores/deliveryContextStore';
import BranchPanel from './BranchPanel';
import CommitPanel from './CommitPanel';
import MRPanel from './MRPanel';

function compactPath(path?: string, max = 72): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= max) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  const tail = parts.slice(-3).join('/');
  return tail.length < max ? `.../${tail}` : `...${normalized.slice(-(max - 3))}`;
}

function GitDeliveryContextBanner({
  context,
  workspace,
  onClear,
}: {
  context: DeliveryContext;
  workspace: string;
  onClear: () => void;
}) {
  const fileCount = (context.filesCreated?.length ?? 0) + (context.filesModified?.length ?? 0);
  const usingTaskWorkspace = Boolean(context.workspace);

  return (
    <div className="shrink-0 border-b border-accent-brand/20 bg-accent-brand/5 px-5 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-accent-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium text-text-primary truncate">Pinned delivery: {context.taskTitle || context.taskId || 'Task'}</span>
            {context.taskId && <span className="font-mono text-text-tertiary">#{context.taskId.slice(0, 8)}</span>}
            {context.agentName && <span className="text-accent-brand">@{context.agentName}</span>}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
            {context.sessionId && <span className="font-mono">session {context.sessionId.slice(0, 8)}</span>}
            {workspace && <span className="min-w-0 truncate font-mono">{usingTaskWorkspace ? 'cwd' : 'workspace'} {compactPath(workspace, 86)}</span>}
            {fileCount > 0 && <span>{fileCount} delivery files</span>}
            {context.verificationCount ? <span>{context.verificationCount} verification checks</span> : null}
          </div>
          {!usingTaskWorkspace && (
            <div className="mt-1 text-[11px] text-accent-yellow">
              This task has no isolated working directory; Git is using the best available session workspace.
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

export default function GitView() {
  const { t } = useTranslation();
  const {
    status,
    isLoading,
    error,
    push,
    pull,
    fetch: gitFetch,
    fetchStatus,
    fetchBranches,
    fetchLog,
    setWorkspace,
    clearError,
    initRepo,
  } = useGitStore();

  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const serverCwd = useSessionStore(s => s.serverCwd);
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const deliveryContext = useDeliveryContextStore((s) => s.context);
  const clearDeliveryContext = useDeliveryContextStore((s) => s.clearContext);
  const contextSession = deliveryContext?.sessionId
    ? sessions.find((s) => s.id === deliveryContext.sessionId)
    : null;

  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(true);
  const [isIniting, setIsIniting] = useState(false);
  const workspace = useGitStore(s => s.workspace);
  const resolvedWorkspace = deliveryContext?.workspace || contextSession?.workspace || activeSession?.workspace || serverCwd || '';

  // 优先用任务上下文，其次 session workspace，最后 serverCwd（启动目录）
  useEffect(() => {
    setWorkspace(resolvedWorkspace);
  }, [resolvedWorkspace, setWorkspace]);

  const deliveryBanner = deliveryContext ? (
    <GitDeliveryContextBanner
      context={deliveryContext}
      workspace={resolvedWorkspace}
      onClear={clearDeliveryContext}
    />
  ) : null;

  // Initial data fetch — only when workspace is non-empty (avoids flashing server-default repo data during session switch)
  useEffect(() => {
    if (!workspace) return;
    const init = async () => {
      await fetchStatus();
      const { status } = useGitStore.getState();
      if (!status) {
        setIsGitRepo(false);
        return;
      }
      setIsGitRepo(true);
      await Promise.all([fetchBranches(), fetchLog()]);
    };
    init();
  }, [workspace]);

  const handlePush = async () => {
    setIsPushing(true);
    try {
      await push({ setUpstream: !status?.tracking });
    } finally {
      setIsPushing(false);
    }
  };

  const handlePull = async () => {
    setIsPulling(true);
    try {
      await pull();
    } finally {
      setIsPulling(false);
    }
  };

  const handleFetch = async () => {
    setIsFetching(true);
    try {
      await gitFetch();
    } finally {
      setIsFetching(false);
    }
  };

  const handleRefreshAll = async () => {
    await Promise.all([fetchStatus(), fetchBranches(), fetchLog()]);
  };

  const handleInitRepo = async () => {
    if (isIniting || isLoading) return;
    setIsIniting(true);
    try {
      await initRepo();
      // initRepo 内部调用 fetchStatus，成功后 status 非 null → setIsGitRepo(true)
      const { status } = useGitStore.getState();
      if (status) {
        setIsGitRepo(true);
      }
    } finally {
      setIsIniting(false);
    }
  };

  if (!isGitRepo) {
    return (
      <div className="flex h-full flex-col">
        {deliveryBanner}
        <div className="codex-chat-surface flex flex-1 flex-col items-center justify-center gap-4 text-text-tertiary">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border-muted bg-bg-card/72 shadow-[0_22px_70px_rgba(0,0,0,0.12)] backdrop-blur-2xl">
            <AlertCircle size={30} className="opacity-60" />
          </div>
          <div className="text-sm font-semibold text-text-primary">Not a git repository</div>
          <div className="text-xs text-text-tertiary text-center px-6">
            {workspace
              ? <><span className="font-mono text-text-secondary">{workspace}</span> {t('git.noGitDir')}</>
              : t('git.openProjectHint')}
          </div>
          {error && (
            <div className="max-w-lg rounded-lg border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleInitRepo}
              disabled={isIniting || isLoading}
              className="cyber-btn cyber-btn-primary !py-1.5 !text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isIniting || isLoading ? (
                <RefreshCw size={12} className="animate-spin" />
              ) : (
                <GitMerge size={12} />
              )}
              {isIniting || isLoading ? t('git.initializing') : 'git init'}
            </button>
            <button
              onClick={handleRefreshAll}
              disabled={isIniting}
              className="cyber-btn !py-1.5 !text-xs flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="codex-topbar flex items-center gap-2 px-5 py-3 border-b border-border-muted backdrop-blur-2xl shrink-0">
        {/* Current branch */}
        <div className="flex items-center gap-1.5 mr-2">
          <GitBranch size={14} className="text-accent-brand" />
          <span className="text-xs font-mono text-accent-brand font-medium">
            {status?.branch || '—'}
          </span>
          {status?.tracking && (
            <>
              <span className="text-text-tertiary text-xs">→</span>
              <span className="text-xs font-mono text-text-tertiary">{status.tracking}</span>
            </>
          )}
        </div>

        {/* Ahead/behind */}
        {(status?.ahead || 0) + (status?.behind || 0) > 0 && (
          <div className="flex items-center gap-2 mr-2">
            {(status?.ahead ?? 0) > 0 && (
              <span className="text-[11px] font-mono text-green-400">↑{status!.ahead}</span>
            )}
            {(status?.behind ?? 0) > 0 && (
              <span className="text-[11px] font-mono text-yellow-400">↓{status!.behind}</span>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          <ToolbarBtn
            onClick={handleFetch}
            loading={isFetching}
            icon={<RotateCcw size={13} />}
            title="Fetch all remotes"
            label="Fetch"
          />
          <ToolbarBtn
            onClick={handlePull}
            loading={isPulling}
            icon={<Download size={13} />}
            title="Pull from remote"
            label="Pull"
          />
          <ToolbarBtn
            onClick={handlePush}
            loading={isPushing}
            icon={<Upload size={13} />}
            title="Push to remote"
            label="Push"
            accent
          />
          <button
            onClick={handleRefreshAll}
            disabled={isLoading}
            className="codex-icon-btn !h-8 !min-w-8"
            title="Refresh all"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {deliveryBanner}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs font-mono shrink-0">
          <AlertCircle size={12} />
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="hover:text-red-300">×</button>
        </div>
      )}

      {/* Three-panel layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden bg-bg-primary/40">
        {/* Left: branches */}
        <div className="w-56 shrink-0 border-r border-border-muted flex flex-col overflow-hidden">
          <BranchPanel />
        </div>

        {/* Center: staging + commit */}
        <div className="flex-1 min-w-0 border-r border-border-muted flex flex-col overflow-hidden">
          <CommitPanel />
        </div>

        {/* Right: MR/PR */}
        <div className="w-72 shrink-0 flex flex-col overflow-hidden">
          <MRPanel />
        </div>
      </div>
    </div>
  );
}

function ToolbarBtn({
  onClick, loading, icon, title, label, accent = false,
}: {
  onClick: () => void;
  loading: boolean;
  icon: React.ReactNode;
  title: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={title}
      className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors disabled:opacity-50
        ${accent
          ? 'bg-text-primary border-text-primary text-bg-primary hover:opacity-90'
          : 'border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary'
        }`}
    >
      {loading ? <RefreshCw size={12} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}
