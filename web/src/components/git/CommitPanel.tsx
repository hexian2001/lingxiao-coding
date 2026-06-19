import { useState } from 'react';
import { CheckSquare, Square, Plus, Minus, GitCommit, RefreshCw } from 'lucide-react';
import { useGitStore, type FileStatus } from '../../stores/gitStore';

export default function CommitPanel() {
  const {
    status,
    selectedFiles,
    toggleSelectedFile,
    setSelectedFiles,
    stageFiles,
    unstageFiles,
    commit,
    fetchStatus,
    isLoading,
  } = useGitStore();

  const [commitMsg, setCommitMsg] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isStagingAll, setIsStagingAll] = useState(false);

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const untracked = (status?.untracked ?? []).map(path => ({ path, index: '?', working_dir: '?' }));
  const allUnstaged = [...unstaged, ...untracked];

  const handleStageSelected = async () => {
    if (selectedFiles.length === 0) return;
    await stageFiles(selectedFiles);
    setSelectedFiles([]);
  };

  const handleStageAll = async () => {
    setIsStagingAll(true);
    try {
      await stageFiles([]);
    } finally {
      setIsStagingAll(false);
    }
  };

  const handleUnstageFile = async (path: string) => {
    await unstageFiles([path]);
  };

  const handleCommit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return;
    setIsCommitting(true);
    try {
      await commit(commitMsg.trim());
      setCommitMsg('');
    } finally {
      setIsCommitting(false);
    }
  };

  const statusIcon = (f: FileStatus) => {
    const s = f.index !== ' ' && f.index !== '?' ? f.index : f.working_dir;
    if (s === 'A' || s === '?') return <span className="text-green-400 font-mono text-[10px] w-3 shrink-0">A</span>;
    if (s === 'D') return <span className="text-red-400 font-mono text-[10px] w-3 shrink-0">D</span>;
    if (s === 'R') return <span className="text-yellow-400 font-mono text-[10px] w-3 shrink-0">R</span>;
    return <span className="text-blue-400 font-mono text-[10px] w-3 shrink-0">M</span>;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-muted shrink-0">
        <div className="flex items-center gap-1.5 text-xs font-mono text-text-secondary">
          <GitCommit size={13} className="text-accent-brand" />
          <span>Changes</span>
        </div>
        <button
          onClick={() => fetchStatus()}
          disabled={isLoading}
          className="p-1 rounded text-text-tertiary hover:text-accent-brand hover:bg-accent-brand/10 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
        {/* Staged files */}
        <div className="shrink-0">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-mono tracking-widest text-text-tertiary uppercase">
              Staged ({staged.length})
            </span>
          </div>
          {staged.length === 0 ? (
            <div className="px-3 pb-2 text-[11px] text-text-tertiary font-mono">No staged changes</div>
          ) : (
            staged.map(f => (
              <div
                key={f.path}
                className="group flex items-center gap-2 px-3 py-1 hover:bg-bg-hover transition-colors"
              >
                {statusIcon(f)}
                <span className="flex-1 text-[11px] font-mono text-text-primary truncate" title={f.path}>
                  {f.path}
                </span>
                <button
                  onClick={() => handleUnstageFile(f.path)}
                  className="p-0.5 rounded text-text-tertiary hover:text-yellow-400 opacity-0 group-hover:opacity-100 transition-all"
                  title="Unstage"
                >
                  <Minus size={11} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Unstaged files */}
        <div className="shrink-0">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-mono tracking-widest text-text-tertiary uppercase">
              Unstaged ({allUnstaged.length})
            </span>
            <div className="flex items-center gap-1">
              {selectedFiles.length > 0 && (
                <button
                  onClick={handleStageSelected}
                  className="px-2 py-0.5 text-[10px] font-mono bg-accent-brand/20 border border-accent-brand/30 text-accent-brand rounded hover:bg-accent-brand/30 transition-colors"
                >
                  Stage ({selectedFiles.length})
                </button>
              )}
              <button
                onClick={handleStageAll}
                disabled={isStagingAll || allUnstaged.length === 0}
                className="px-2 py-0.5 text-[10px] font-mono border border-border-default text-text-secondary rounded hover:bg-bg-hover disabled:opacity-40 transition-colors"
              >
                {isStagingAll ? <RefreshCw size={10} className="animate-spin" /> : 'Stage All'}
              </button>
            </div>
          </div>
          {allUnstaged.length === 0 ? (
            <div className="px-3 pb-2 text-[11px] text-text-tertiary font-mono">No unstaged changes</div>
          ) : (
            allUnstaged.map(f => {
              const isSelected = selectedFiles.includes(f.path);
              return (
                <div
                  key={f.path}
                  className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors
                    ${isSelected ? 'bg-accent-brand/8' : 'hover:bg-bg-hover'}
                  `}
                  onClick={() => toggleSelectedFile(f.path)}
                >
                  <div className="shrink-0">
                    {isSelected ? (
                      <CheckSquare size={12} className="text-accent-brand" />
                    ) : (
                      <Square size={12} className="text-text-tertiary" />
                    )}
                  </div>
                  {statusIcon(f)}
                  <span className="flex-1 text-[11px] font-mono text-text-secondary truncate" title={f.path}>
                    {f.path}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); stageFiles([f.path]); }}
                    className="p-0.5 rounded text-text-tertiary hover:text-green-400 transition-colors"
                    title="Stage this file"
                  >
                    <Plus size={11} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Commit area */}
        <div className="shrink-0 border-t border-border-muted p-3 space-y-2">
          <textarea
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            placeholder="Commit message (required)"
            rows={3}
            className="w-full px-2 py-1.5 text-xs font-mono bg-bg-input border border-border-input rounded text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-brand resize-none"
          />
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || staged.length === 0 || isCommitting}
            className="w-full py-1.5 text-xs font-mono bg-accent-brand/20 border border-accent-brand/40 text-accent-brand rounded hover:bg-accent-brand/30 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
          >
            {isCommitting ? (
              <><RefreshCw size={12} className="animate-spin" /> Committing...</>
            ) : (
              <><GitCommit size={12} /> Commit {staged.length > 0 ? `(${staged.length} files)` : ''}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
