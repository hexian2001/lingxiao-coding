import { useState, useEffect } from 'react';
import { GitMerge, Plus, RefreshCw, ExternalLink, Check, X, ChevronDown, CloudOff } from 'lucide-react';
import { useGitStore, type MergeRequest, type CreateMRParams } from '../../stores/gitStore';
import ConfirmationDialog from '../ui/ConfirmationDialog';

export default function MRPanel() {
  const {
    mrs,
    status,
    detectedPlatform,
    isMRLoading,
    mrError,
    mrUnavailable,
    mrStateFilter,
    fetchMRs,
    createMR,
    mergeMR,
    closeMR,
    setMRStateFilter,
    detectPlatform,
  } = useGitStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newMR, setNewMR] = useState<Partial<CreateMRParams>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [mergingId, setMergingId] = useState<string | number | null>(null);
  const [mergeConfirmId, setMergeConfirmId] = useState<string | number | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | number | null>(null);

  useEffect(() => {
    detectPlatform();
    fetchMRs();
  }, []);

  const handleCreate = async () => {
    if (!newMR.title || !newMR.source_branch || !newMR.target_branch) return;
    setIsCreating(true);
    try {
      await createMR(newMR as CreateMRParams);
      setNewMR({});
      setShowCreate(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleMerge = async (id: string | number) => {
    setMergeConfirmId(id);
  };

  const confirmMerge = async () => {
    if (!mergeConfirmId) return;
    const id = mergeConfirmId;
    setMergeConfirmId(null);
    setMergingId(id);
    try {
      await mergeMR(id);
    } finally {
      setMergingId(null);
    }
  };

  const handleClose = async (id: string | number) => {
    setCloseConfirmId(id);
  };

  const confirmClose = async () => {
    if (!closeConfirmId) return;
    const id = closeConfirmId;
    setCloseConfirmId(null);
    await closeMR(id);
  };

  const platformLabel = detectedPlatform?.platform !== 'none' ? detectedPlatform?.platform : null;

  const stateOptions: Array<{ value: typeof mrStateFilter; label: string }> = [
    { value: 'open', label: 'Open' },
    { value: 'merged', label: 'Merged' },
    { value: 'closed', label: 'Closed' },
    { value: 'all', label: 'All' },
  ];

  return (
    <>
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-muted shrink-0">
        <div className="flex items-center gap-1.5 text-xs font-mono text-text-secondary">
          <GitMerge size={13} className="text-accent-brand" />
          <span>{platformLabel ? `${platformLabel.toUpperCase()} MR/PR` : 'MR / PR'}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowCreate(v => !v)}
            className="p-1 rounded text-text-tertiary hover:text-accent-brand hover:bg-accent-brand/10 transition-colors"
            title="Create MR/PR"
          >
            <Plus size={13} />
          </button>
          <button
            onClick={() => fetchMRs()}
            disabled={isMRLoading}
            className="p-1 rounded text-text-tertiary hover:text-accent-brand hover:bg-accent-brand/10 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} className={isMRLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* State filter */}
      <div className="flex border-b border-border-muted shrink-0">
        {stateOptions.map(opt => (
          <button
            key={opt.value}
            onClick={() => setMRStateFilter(opt.value)}
            className={`flex-1 py-1.5 text-[10px] font-mono uppercase tracking-wide transition-colors
              ${mrStateFilter === opt.value
                ? 'text-accent-brand border-b-2 border-accent-brand bg-accent-brand/5'
                : 'text-text-tertiary hover:text-text-secondary border-b-2 border-transparent'
              }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Create MR form */}
      {showCreate && (
        <div className="border-b border-border-muted p-3 space-y-2 bg-bg-secondary shrink-0">
          <div className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest mb-2">New MR/PR</div>
          <input
            type="text"
            placeholder="Title *"
            value={newMR.title || ''}
            onChange={e => setNewMR(v => ({ ...v, title: e.target.value }))}
            className="w-full px-2 py-1 text-xs font-mono bg-bg-input border border-border-input rounded text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand"
          />
          <textarea
            placeholder="Description (optional)"
            value={newMR.description || ''}
            onChange={e => setNewMR(v => ({ ...v, description: e.target.value }))}
            rows={2}
            className="w-full px-2 py-1 text-xs font-mono bg-bg-input border border-border-input rounded text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand resize-none"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <input
              type="text"
              placeholder={`Source: ${status?.branch || 'branch'}`}
              value={newMR.source_branch || ''}
              onChange={e => setNewMR(v => ({ ...v, source_branch: e.target.value }))}
              className="px-2 py-1 text-xs font-mono bg-bg-input border border-border-input rounded text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand"
            />
            <input
              type="text"
              placeholder="Target: main"
              value={newMR.target_branch || ''}
              onChange={e => setNewMR(v => ({ ...v, target_branch: e.target.value }))}
              className="px-2 py-1 text-xs font-mono bg-bg-input border border-border-input rounded text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand"
            />
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleCreate}
              disabled={isCreating || !newMR.title || !newMR.source_branch || !newMR.target_branch}
              className="flex-1 py-1 text-xs font-mono bg-accent-brand/20 border border-accent-brand/40 text-accent-brand rounded hover:bg-accent-brand/30 disabled:opacity-40 transition-colors"
            >
              {isCreating ? <RefreshCw size={12} className="animate-spin mx-auto" /> : 'Create MR/PR'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-3 py-1 text-xs font-mono border border-border-default text-text-secondary rounded hover:bg-bg-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {mrError && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-400/10 border-b border-red-400/20 shrink-0">
          {mrError}
        </div>
      )}

      {/* Platform unavailable banner — 后端优雅降级（未配置/未授权/仓库不可见），
          非真实错误，用琥珀色信息条提示，而非红色报错。 */}
      {!mrError && mrUnavailable && (
        <div className="px-3 py-2 text-xs text-amber-400 bg-amber-400/10 border-b border-amber-400/20 shrink-0 flex items-center gap-2">
          <CloudOff size={14} className="shrink-0" />
          <span>
            {mrUnavailable.reason === 'unauthorized' || mrUnavailable.reason === 'forbidden'
              ? 'Git platform token is missing or lacks access. Configure it in Settings.'
              : mrUnavailable.reason === 'not_found'
                ? 'Repository not visible to the configured token. Check owner/repo and token scopes.'
                : 'No git platform configured. Configure one in Settings to enable MR/PR management.'}
          </span>
        </div>
      )}

      {/* No platform configured warning (only when we never got an unavailable response, e.g. detect-only) */}
      {!mrError && !mrUnavailable && detectedPlatform?.platform === 'none' && (
        <div className="px-3 py-3 text-xs text-text-tertiary font-mono text-center shrink-0">
          Configure a Git platform in Settings to enable MR/PR management.
        </div>
      )}

      {/* MR list */}
      <div className="flex-1 overflow-y-auto">
        {isMRLoading && mrs.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw size={16} className="animate-spin text-accent-brand" />
          </div>
        ) : mrs.length === 0 ? (
          <div className="px-3 py-6 text-xs text-text-tertiary text-center font-mono">
            No {mrStateFilter === 'all' ? '' : mrStateFilter + ' '}MRs/PRs
          </div>
        ) : (
          mrs.map(mr => (
            <MRRow
              key={String(mr.id)}
              mr={mr}
              isMerging={mergingId === mr.id}
              onMerge={() => handleMerge(mr.id)}
              onClose={() => handleClose(mr.id)}
            />
          ))
        )}
      </div>
    </div>
    <ConfirmationDialog
      open={mergeConfirmId !== null}
      title="Merge MR"
      message={`Merge MR #${mergeConfirmId}?`}
      confirmLabel="Merge"
      cancelLabel="Cancel"
      variant="default"
      onConfirm={confirmMerge}
      onCancel={() => setMergeConfirmId(null)}
    />
    <ConfirmationDialog
      open={closeConfirmId !== null}
      title="Close MR"
      message={`Close MR #${closeConfirmId}?`}
      confirmLabel="Close"
      cancelLabel="Cancel"
      variant="danger"
      onConfirm={confirmClose}
      onCancel={() => setCloseConfirmId(null)}
    />
    </>
  );
}

function MRRow({
  mr,
  isMerging,
  onMerge,
  onClose,
}: {
  mr: MergeRequest;
  isMerging: boolean;
  onMerge: () => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const stateColor = mr.state === 'open'
    ? 'text-green-400 bg-green-400/10'
    : mr.state === 'merged'
    ? 'text-purple-400 bg-purple-400/10'
    : 'text-red-400 bg-red-400/10';

  return (
    <div className="border-b border-border-muted last:border-0">
      <div
        className="flex items-start gap-2 px-3 py-2.5 hover:bg-bg-hover cursor-pointer transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronDown size={12} className={`shrink-0 mt-0.5 text-text-tertiary transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${stateColor}`}>
              {mr.state}
            </span>
            {mr.draft && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono text-text-tertiary bg-bg-secondary border border-border-default">
                draft
              </span>
            )}
            <span className="text-[10px] text-text-tertiary font-mono">#{mr.id}</span>
          </div>
          <div className="mt-0.5 text-xs text-text-primary font-medium truncate" title={mr.title}>
            {mr.title}
          </div>
          <div className="mt-0.5 text-[10px] text-text-tertiary font-mono">
            {mr.sourceBranch} → {mr.targetBranch}
          </div>
        </div>
        {mr.url && (
          <a
            href={mr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="p-0.5 shrink-0 text-text-tertiary hover:text-accent-brand transition-colors"
            title="Open in browser"
          >
            <ExternalLink size={11} />
          </a>
        )}
      </div>

      {expanded && (
        <div className="px-7 pb-3 space-y-2">
          {mr.description && (
            <p className="text-xs text-text-secondary leading-relaxed">{mr.description}</p>
          )}
          <div className="text-[10px] text-text-tertiary font-mono">
            by {mr.author} · {new Date(mr.createdAt).toLocaleDateString()}
          </div>
          {mr.state === 'open' && (
            <div className="flex gap-1.5">
              <button
                onClick={onMerge}
                disabled={isMerging}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono bg-green-500/20 border border-green-500/30 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-40 transition-colors"
              >
                {isMerging ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
                Merge
              </button>
              <button
                onClick={onClose}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono bg-red-500/10 border border-red-500/20 text-red-400 rounded hover:bg-red-500/20 transition-colors"
              >
                <X size={10} />
                Close
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
