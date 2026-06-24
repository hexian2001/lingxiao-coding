import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Plus, Trash2, RefreshCw, Check, ChevronRight, AlertTriangle, X } from 'lucide-react';
import { useGitStore, type GitBranch as GitBranchType } from '../../stores/gitStore';
import ConfirmationDialog from '../ui/ConfirmationDialog';

/**
 * 从 "origin/feature/foo" 这样的 remote 分支名里剥掉 remote 前缀，
 * 得到本地分支名 "feature/foo"。对没有 "/" 的名字保持原样。
 */
function stripRemotePrefix(name: string): string {
  const idx = name.indexOf('/');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

export default function BranchPanel() {
  const { t } = useTranslation();
  const { status, branches, fetchBranches, fetchStatus, switchBranch, createBranch, deleteBranch, stash, isLoading } = useGitStore();
  const [newBranchName, setNewBranchName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<{ msg: string; targetBranch: string } | null>(null);
  const [stashing, setStashing] = useState(false);
  const [deleteConfirmBranch, setDeleteConfirmBranch] = useState<string | null>(null);

  const localBranches = branches.filter(b => !b.remote);
  const remoteBranches = branches.filter(b => b.remote);

  const handleSwitch = async (branch: GitBranchType) => {
    if (branch.current) return;
    setSwitchingTo(branch.name);
    setSwitchError(null);
    try {
      // 远程分支：git 会自动创建同名本地 tracking 分支并切换
      // (例如传入 'origin/feature/x'，本地检出 'feature/x')
      // 这依赖后端 /git/switch 直接调用 git checkout
      const target = branch.remote ? stripRemotePrefix(branch.name) : branch.name;
      await switchBranch(target);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSwitchError({ msg, targetBranch: branch.name });
    } finally {
      setSwitchingTo(null);
    }
  };

  const handleStashAndSwitch = async () => {
    if (!switchError) return;
    setStashing(true);
    try {
      await stash('auto-stash before branch switch');
      await switchBranch(switchError.targetBranch);
      setSwitchError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSwitchError({ msg, targetBranch: switchError.targetBranch });
    } finally {
      setStashing(false);
    }
  };

  const handleCreate = async () => {
    if (!newBranchName.trim()) return;
    try {
      await createBranch(newBranchName.trim());
      setNewBranchName('');
      setShowCreate(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (name: string) => {
    setDeleteConfirmBranch(name);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmBranch) return;
    const name = deleteConfirmBranch;
    setDeleteConfirmBranch(null);
    setDeletingBranch(name);
    try {
      await deleteBranch(name);
    } finally {
      setDeletingBranch(null);
    }
  };

  const handleRefresh = async () => {
    await Promise.all([fetchBranches(), fetchStatus()]);
  };

  const isOverwrittenError = switchError?.msg.includes('would be overwritten');

  return (
    <>
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-muted shrink-0">
        <div className="flex items-center gap-1.5 text-xs font-mono text-text-secondary">
          <GitBranch size={13} className="text-accent-brand" />
          <span>Branches</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowCreate(v => !v)}
            className="p-1 rounded text-text-tertiary hover:text-accent-brand hover:bg-accent-brand/10 transition-colors"
            title="Create new branch"
          >
            <Plus size={13} />
          </button>
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-1 rounded text-text-tertiary hover:text-accent-brand hover:bg-accent-brand/10 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Create branch input */}
      {showCreate && (
        <div className="px-3 py-2 border-b border-border-muted bg-bg-secondary shrink-0">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newBranchName}
              onChange={e => setNewBranchName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
              placeholder="New branch name..."
              autoFocus
              className="flex-1 px-2 py-1 text-xs font-mono bg-bg-input border border-border-input rounded text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand"
            />
            <button
              onClick={handleCreate}
              disabled={!newBranchName.trim()}
              className="px-2 py-1 text-xs bg-accent-brand/20 border border-accent-brand/30 text-accent-brand rounded hover:bg-accent-brand/30 disabled:opacity-40 transition-colors"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Switch error banner */}
      {switchError && (
        <div className="mx-2 mt-2 shrink-0">
          <div className="rounded border border-yellow-500/30 bg-yellow-500/8 px-3 py-2">
            <div className="flex items-start gap-2">
              <AlertTriangle size={12} className="text-yellow-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                {isOverwrittenError ? (
                  <>
                    <p className="text-xs text-yellow-300 font-medium mb-1">{t('git.branch.overwriteTitle')}</p>
                    <p className="text-[10px] text-text-tertiary mb-2">{t('git.branch.overwriteDesc', { branch: switchError.targetBranch })}</p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={handleStashAndSwitch}
                        disabled={stashing}
                        className="px-2 py-0.5 text-[10px] bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 rounded hover:bg-yellow-500/30 disabled:opacity-50 transition-colors font-mono"
                      >
                        {stashing ? <RefreshCw size={9} className="animate-spin inline mr-1" /> : null}
                        {t('git.branch.stashAndSwitch')}
                      </button>
                      <button
                        onClick={() => setSwitchError(null)}
                        className="px-2 py-0.5 text-[10px] border border-border-muted text-text-tertiary rounded hover:text-text-secondary transition-colors"
                      >
                        {t('git.branch.cancel')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-yellow-300 font-medium mb-1">{t('git.branch.switchFailed')}</p>
                    <p className="text-[10px] text-text-tertiary font-mono break-all">{switchError.msg.split('\n')[0]}</p>
                  </>
                )}
              </div>
              <button onClick={() => setSwitchError(null)} className="text-text-tertiary hover:text-text-secondary shrink-0">
                <X size={11} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Current branch indicator */}
      {status?.branch && (
        <div className="px-3 py-2 border-b border-border-muted shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent-brand shrink-0" />
            <span className="text-xs font-mono text-accent-brand font-medium truncate">{status.branch}</span>
            {status.tracking && (
              <span className="text-[10px] text-text-tertiary truncate">→ {status.tracking}</span>
            )}
          </div>
          {(status.ahead > 0 || status.behind > 0) && (
            <div className="mt-1 flex items-center gap-2 pl-4">
              {status.ahead > 0 && (
                <span className="text-[10px] text-green-400 font-mono">↑{status.ahead}</span>
              )}
              {status.behind > 0 && (
                <span className="text-[10px] text-yellow-400 font-mono">↓{status.behind}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Branch list */}
      <div className="flex-1 overflow-y-auto">
        {localBranches.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-mono tracking-widest text-text-tertiary uppercase">
              Local
            </div>
            {localBranches.map(branch => (
              <BranchRow
                key={branch.name}
                branch={branch}
                isSwitching={switchingTo === branch.name}
                isDeleting={deletingBranch === branch.name}
                onSwitch={() => handleSwitch(branch)}
                onDelete={() => handleDelete(branch.name)}
              />
            ))}
          </div>
        )}
        {remoteBranches.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-mono tracking-widest text-text-tertiary uppercase">
              Remote
            </div>
            {remoteBranches.map(branch => (
              <BranchRow
                key={branch.name}
                branch={branch}
                isSwitching={switchingTo === branch.name}
                isDeleting={false}
                onSwitch={() => handleSwitch(branch)}
                // 远程分支删除需要 git push --delete，后端不支持；
                // Button 组件内已通过 !branch.remote 隐藏删除按钮，无需传 onDelete。
              />
            ))}
          </div>
        )}
        {branches.length === 0 && (
          <div className="px-3 py-6 text-xs text-text-tertiary text-center font-mono">
            No branches found
          </div>
        )}
      </div>
    </div>

      <ConfirmationDialog
        open={deleteConfirmBranch !== null}
        title={t('git.deleteBranch', 'Delete Branch')}
        message={t('git.deleteBranchConfirm', { name: deleteConfirmBranch, defaultValue: `Delete branch "${deleteConfirmBranch}"?` })}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmBranch(null)}
      />
    </>
  );
}

function BranchRow({
  branch,
  isSwitching,
  isDeleting,
  onSwitch,
  onDelete,
}: {
  branch: GitBranchType;
  isSwitching: boolean;
  isDeleting: boolean;
  onSwitch: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors
        ${branch.current ? 'bg-accent-brand/8 text-accent-brand' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}
        ${branch.remote ? 'opacity-70' : ''}
      `}
      onClick={onSwitch}
      title={branch.lastCommitMsg || branch.name}
    >
      <div className="w-3 shrink-0 flex items-center justify-center">
        {branch.current ? (
          <Check size={11} className="text-accent-brand" />
        ) : (
          <ChevronRight size={11} className="opacity-0 group-hover:opacity-50" />
        )}
      </div>
      <span className="flex-1 text-xs font-mono truncate">{branch.name}</span>
      {isSwitching && (
        <RefreshCw size={11} className="animate-spin text-accent-brand shrink-0" />
      )}
      {!branch.current && !branch.remote && !isSwitching && (
        <button
          onClick={e => { e.stopPropagation(); onDelete?.(); }}
          disabled={isDeleting}
          className="p-0.5 rounded text-text-tertiary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
          title="Delete branch"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}
