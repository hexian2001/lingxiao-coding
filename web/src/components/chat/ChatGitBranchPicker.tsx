import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, GitBranch, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useGitStore, type GitBranch as GitBranchType } from '../../stores/gitStore';
import { useViewStore } from '../../stores/viewStore';
import { useTranslation } from 'react-i18next';
import { usePopoverMaxHeight } from '../../hooks/usePopoverMaxHeight';

interface ChatGitBranchPickerProps {
  workspace: string;
}

function getWorkspaceName(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || workspace || 'workspace';
}

function getDirtyCount(status: ReturnType<typeof useGitStore.getState>['status']): number {
  if (!status) return 0;
  return status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;
}

function stripRemotePrefix(name: string): string {
  const idx = name.indexOf('/');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

export default function ChatGitBranchPicker({ workspace }: ChatGitBranchPickerProps) {
  const {
    status,
    branches,
    isLoading,
    error,
    setWorkspace,
    fetchStatus,
    fetchBranches,
    switchBranch,
    createBranch,
    clearError,
  } = useGitStore();
  const setMainView = useViewStore((s) => s.setMainView);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const maxHeight = usePopoverMaxHeight(triggerRef, open, { cap: 460 });

  useEffect(() => {
    if (!workspace) return;
    setWorkspace(workspace);
  }, [setWorkspace, workspace]);

  useEffect(() => {
    if (!workspace) return;
    void fetchStatus();
    void fetchBranches();
  }, [fetchBranches, fetchStatus, workspace]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const filteredBranches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ordered = [...branches].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.remote !== b.remote) return a.remote ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    if (!q) return ordered;
    return ordered.filter((branch) => branch.name.toLowerCase().includes(q));
  }, [branches, query]);

  const dirtyCount = getDirtyCount(status);
  const workspaceName = getWorkspaceName(workspace);
  const visibleError = localError || error;

  const refresh = async () => {
    setLocalError(null);
    clearError();
    await Promise.all([fetchStatus(), fetchBranches()]);
  };

  const handleSwitch = async (branch: GitBranchType) => {
    if (branch.current) {
      setOpen(false);
      return;
    }
    const target = branch.remote ? stripRemotePrefix(branch.name) : branch.name;
    setSwitchingTo(branch.name);
    setLocalError(null);
    clearError();
    try {
      await switchBranch(target);
      setOpen(false);
      setQuery('');
    } catch (event) {
      setLocalError(event instanceof Error ? event.message : String(event));
    } finally {
      setSwitchingTo(null);
    }
  };

  const handleCreate = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setCreating(true);
    setLocalError(null);
    clearError();
    try {
      await createBranch(name);
      setNewBranchName('');
      setQuery('');
      setOpen(false);
    } catch (event) {
      setLocalError(event instanceof Error ? event.message : String(event));
    } finally {
      setCreating(false);
    }
  };

  if (!workspace) return null;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refresh();
        }}
        className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-[11px] font-mono text-text-tertiary transition-colors hover:border-border-default hover:text-text-primary"
        title={`${workspace}\n${status?.branch || t('git.noBranch', '无分支')}${dirtyCount > 0 ? ` · ${t('git.changed', `${dirtyCount} changed`)}` : ''}`}
      >
        <GitBranch size={11} className="shrink-0" />
        <span className="truncate">{status?.branch || t('git.placeholder', 'git')}</span>
        {dirtyCount > 0 && (
          <span className="shrink-0 text-text-tertiary/70">{dirtyCount}</span>
        )}
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          style={{ maxHeight: maxHeight ?? undefined }}
          className="absolute bottom-full left-0 z-[220] mb-1 flex max-h-[85vh] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border-default bg-bg-card shadow-2xl"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-muted">
            <Search size={14} className="shrink-0 text-text-tertiary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('chat.git.searchPlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-border-input bg-bg-input px-2 py-1 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              autoFocus
            />
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
              title={t('chat.git.refreshTitle')}
            >
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
              title={t('chat.git.closeTitle')}
            >
              <X size={13} />
            </button>
          </div>

          <div className="px-4 py-2 text-sm text-text-tertiary">{t('chat.git.branches')}</div>

          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
            {filteredBranches.map((branch) => (
              <button
                key={`${branch.remote ? 'remote' : 'local'}:${branch.name}`}
                type="button"
                onClick={() => handleSwitch(branch)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-hover"
              >
                <GitBranch size={16} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm ${branch.current ? 'text-text-primary' : 'text-text-secondary'}`}>
                    {branch.name}
                  </span>
                  <span className="block truncate text-xs text-text-tertiary">
                    {branch.current ? t('chat.git.current') : branch.remote ? t('chat.git.remote') : t('chat.git.local')}
                    {branch.lastCommitMsg ? ` · ${branch.lastCommitMsg}` : ''}
                  </span>
                </span>
                {switchingTo === branch.name ? (
                  <Loader2 size={15} className="shrink-0 animate-spin text-accent-brand" />
                ) : branch.current ? (
                  <Check size={16} className="shrink-0 text-text-secondary" />
                ) : null}
              </button>
            ))}
            {filteredBranches.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-text-tertiary">{t('chat.git.noMatch')}</div>
            )}
          </div>

          {visibleError && (
            <div className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
              <span className="min-w-0 flex-1 break-words">{visibleError.split('\n')[0]}</span>
              <button type="button" onClick={() => { setLocalError(null); clearError(); }} className="shrink-0 text-accent-red/70 hover:text-accent-red">
                <X size={12} />
              </button>
            </div>
          )}

          <div className="border-t border-border-muted px-4 py-2">
            <div className="mb-2 flex items-center gap-2 text-xs text-text-tertiary">
              <span className="truncate">{workspaceName}</span>
              {dirtyCount > 0 && <span className="shrink-0">{t('chat.git.uncommitted', { count: dirtyCount })}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Plus size={16} className="shrink-0 text-text-tertiary" />
              <input
                value={newBranchName}
                onChange={(event) => setNewBranchName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleCreate();
                }}
                placeholder={t('chat.git.createPlaceholder')}
                className="min-w-0 flex-1 rounded-md border border-border-input bg-bg-input px-2 py-1 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newBranchName.trim() || creating}
                className="rounded-md border border-border-default px-2 py-1 text-xs text-text-secondary transition-colors hover:border-accent-brand/50 hover:text-accent-brand disabled:opacity-40"
              >
                {creating ? <Loader2 size={12} className="animate-spin" /> : t('chat.git.create')}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setMainView('git');
            }}
            className="border-t border-border-muted px-4 py-2 text-left text-xs text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {t('chat.git.openFullPanel')}
          </button>
        </div>
      )}
    </div>
  );
}
