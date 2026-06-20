/**
 * WorkspacePicker — 动态 workspace 选择器
 *
 * 在模式切换器右侧显示当前 workspace basename 的 chip 按钮，
 * 点击展开下拉面板：最近 workspace 列表 + 目录浏览对话框。
 * 选择新 workspace 后调用 createAndConnect({ workspace }) 创建新会话。
 *
 * API（T-3 产出）：
 *   GET  /api/v1/workspaces           → { data: { current, recent: string[] } }
 *   GET  /api/v1/workspace/browse     → { data: { path, directories: {name,path}[] } }
 *   POST /api/v1/workspaces/recent    → { data: { recent: string[] } }
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Folder,
  FolderOpen,
  Loader2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/sessionStore';
import { usePopoverMaxHeight } from '../../hooks/usePopoverMaxHeight';
import { getServerToken } from '../../api/headers';

// ─── helpers ──────────────────────────────────────────────────────

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const seg = normalized.split('/').filter(Boolean).pop();
  return seg || path || 'workspace';
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

// ─── types ────────────────────────────────────────────────────────

interface RecentResponse {
  data: { current: string; recent: string[] };
}
interface BrowseResponse {
  data: { path: string; directories: { name: string; path: string }[] };
}
interface DirEntry {
  name: string;
  path: string;
}

// ─── component ────────────────────────────────────────────────────

export default function WorkspacePicker() {
  const { t } = useTranslation();
  const createAndConnect = useSessionStore((s) => s.createAndConnect);
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);

  // activeWorkspace 来自当前 session
  const activeWorkspace = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.workspace || '',
    [sessions, sessionId],
  );

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'browse'>('main');
  const [recent, setRecent] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState(activeWorkspace);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [switching, setSwitching] = useState(false);

  // browse state
  const [browsePath, setBrowsePath] = useState('');
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const maxHeight = usePopoverMaxHeight(triggerRef, open, { cap: 460 });

  // ─── data fetching ──────────────────────────────────────────────

  const fetchRecent = useCallback(async () => {
    setLoadingRecent(true);
    try {
      const res = await fetch('/api/v1/workspaces', {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (res.ok) {
        const json = (await res.json()) as RecentResponse;
        setRecent(json.data?.recent ?? []);
        if (json.data?.current) setCurrentPath(json.data.current);
      }
    } catch {
      // silent fail
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  const browse = useCallback(async (path: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const res = await fetch(
        `/api/v1/workspace/browse?path=${encodeURIComponent(path)}`,
        { headers: { 'x-lingxiao-token': getServerToken() } },
      );
      if (res.ok) {
        const json = (await res.json()) as BrowseResponse;
        setBrowsePath(json.data.path);
        setBrowseDirs(json.data.directories ?? []);
      } else {
        const body = await res.json().catch(() => ({}));
        setBrowseError(body?.error || `HTTP ${res.status}`);
      }
    } catch (e: unknown) {
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // ─── actions ────────────────────────────────────────────────────

  const handleSelect = useCallback(
    async (newPath: string) => {
      if (newPath === activeWorkspace) {
        setOpen(false);
        return;
      }
      setSwitching(true);
      try {
        // 1. 记录到 recent
        await fetch('/api/v1/workspaces/recent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
          body: JSON.stringify({ path: newPath }),
        }).catch(() => {}); // best-effort

        // 2. 创建新会话并连接
        await createAndConnect({ workspace: newPath });
        setOpen(false);
        setView('main');
      } catch (e) {
        console.error('[WorkspacePicker] switch failed:', e);
      } finally {
        setSwitching(false);
      }
    },
    [activeWorkspace, createAndConnect],
  );

  const handleBrowse = useCallback(() => {
    setView('browse');
    const startPath = activeWorkspace || '/';
    void browse(startPath);
  }, [activeWorkspace, browse]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentPath);
    } catch {
      // ignore
    }
  }, [currentPath]);

  // ─── effects ────────────────────────────────────────────────────

  // sync activeWorkspace to currentPath when it changes externally
  useEffect(() => {
    if (activeWorkspace) setCurrentPath(activeWorkspace);
  }, [activeWorkspace]);

  // fetch recent on open
  useEffect(() => {
    if (open && view === 'main') {
      void fetchRecent();
    }
  }, [open, view, fetchRecent]);

  // outside click
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setView('main');
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // ─── render ─────────────────────────────────────────────────────

  const displayName = basename(currentPath);
  const recentFiltered = recent.filter((p) => p !== currentPath);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="codex-chip flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium transition-colors max-w-[200px]"
        title={currentPath}
        disabled={switching}
      >
        {switching ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-accent-brand" />
        ) : (
          <FolderOpen size={11} className="shrink-0" />
        )}
        <span className="max-w-[140px] truncate">{displayName}</span>
        {!switching && (
          <ChevronDown
            size={10}
            className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {open && (
        <div
          style={{ maxHeight: maxHeight ?? undefined }}
          className="absolute bottom-full left-0 z-[220] mb-1 flex max-h-[85vh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border-default bg-bg-card shadow-2xl"
        >
          {view === 'main' ? (
            <MainPanel
              t={t}
              currentPath={currentPath}
              recent={recentFiltered}
              loading={loadingRecent}
              switching={switching}
              onSelect={handleSelect}
              onBrowse={handleBrowse}
              onCopyPath={handleCopyPath}
              onClose={() => { setOpen(false); setView('main'); }}
            />
          ) : (
            <BrowsePanel
              t={t}
              browsePath={browsePath}
              directories={browseDirs}
              loading={browseLoading}
              error={browseError}
              switching={switching}
              onNavigate={browse}
              onSelect={handleSelect}
              onBack={() => setView('main')}
              onClose={() => { setOpen(false); setView('main'); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MainPanel — 最近 workspace 列表
// ═══════════════════════════════════════════════════════════════

interface MainPanelProps {
  t: (key: string, opts?: Record<string, unknown>) => string;
  currentPath: string;
  recent: string[];
  loading: boolean;
  switching: boolean;
  onSelect: (path: string) => void;
  onBrowse: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}

function MainPanel({ t, currentPath, recent, loading, switching, onSelect, onBrowse, onCopyPath, onClose }: MainPanelProps) {
  return (
    <>
      {/* Header: current path */}
      <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2">
        <Folder size={14} className="shrink-0 text-accent-brand" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary" title={currentPath}>
          {currentPath}
        </span>
        <button
          type="button"
          onClick={onCopyPath}
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title={t('chat.workspace.copyPath')}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title={t('chat.git.closeTitle')}
        >
          <X size={14} />
        </button>
      </div>

      {/* Recent list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin text-text-tertiary" />
          </div>
        )}
        {!loading && recent.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-text-tertiary">
            {t('chat.workspace.noRecent')}
          </div>
        )}
        {!loading && recent.length > 0 && (
          <div className="py-1">
            <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary/70">
              {t('chat.workspace.recent')}
            </div>
            {recent.map((path) => (
              <button
                key={path}
                type="button"
                disabled={switching}
                onClick={() => onSelect(path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-bg-hover disabled:opacity-40"
              >
                <Folder size={12} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{basename(path)}</span>
                <span className="shrink-0 text-[10px] text-text-tertiary/60 truncate max-w-[160px]" title={path}>
                  {path}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer: browse button */}
      <button
        type="button"
        disabled={switching}
        onClick={onBrowse}
        className="flex items-center gap-2 border-t border-border-muted px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
      >
        <FolderOpen size={13} className="shrink-0" />
        {t('chat.workspace.browse')}
      </button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// BrowsePanel — 目录浏览对话框
// ═══════════════════════════════════════════════════════════════

interface BrowsePanelProps {
  t: (key: string, opts?: Record<string, unknown>) => string;
  browsePath: string;
  directories: DirEntry[];
  loading: boolean;
  error: string | null;
  switching: boolean;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
  onBack: () => void;
  onClose: () => void;
}

function BrowsePanel({ t, browsePath, directories, loading, error, switching, onNavigate, onSelect, onBack, onClose }: BrowsePanelProps) {
  const [pathInput, setPathInput] = useState(browsePath);

  // Sync input when browsePath changes from navigation
  useEffect(() => { setPathInput(browsePath); }, [browsePath]);

  const handlePathSubmit = () => {
    const trimmed = pathInput.trim();
    if (trimmed && trimmed !== browsePath) {
      onNavigate(trimmed);
    }
  };
  return (
    <>
      {/* Header: path input + back + parent + close */}
      <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title={t('chat.workspace.back')}
        >
          <ArrowUp size={14} className="rotate-[-90deg]" />
        </button>
        <input
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePathSubmit(); } }}
          onBlur={handlePathSubmit}
          placeholder="/path/to/workspace"
          className="min-w-0 flex-1 rounded bg-bg-primary/60 px-2 py-1 font-mono text-xs text-text-primary outline-none ring-1 ring-border-muted focus:ring-accent-brand/40"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => onNavigate(parentDir(browsePath))}
          disabled={browsePath === '/' || browsePath.length <= 1}
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-30"
          title={t('chat.workspace.parentDir')}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title={t('chat.git.closeTitle')}
        >
          <X size={14} />
        </button>
      </div>

      {/* Directory list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin text-text-tertiary" />
          </div>
        )}
        {!loading && error && (
          <div className="px-3 py-4 text-center text-xs text-accent-red">{error}</div>
        )}
        {!loading && !error && directories.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-text-tertiary">
            {t('chat.workspace.noSubdirs')}
          </div>
        )}
        {!loading && !error && directories.length > 0 && (
          <div className="py-1">
            {directories.map((dir) => (
              <button
                key={dir.path}
                type="button"
                disabled={switching}
                onClick={() => onNavigate(dir.path)}
                onDoubleClick={() => onSelect(dir.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-bg-hover disabled:opacity-40"
              >
                <Folder size={12} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{dir.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer: select current dir */}
      <button
        type="button"
        disabled={switching || loading || !!error}
        onClick={() => onSelect(browsePath)}
        className="flex items-center justify-center gap-2 border-t border-border-muted px-3 py-2 text-left text-xs font-medium text-accent-brand transition-colors hover:bg-bg-hover disabled:opacity-40"
      >
        {switching ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Check size={13} className="shrink-0" />
        )}
        {t('chat.workspace.select')}
      </button>
    </>
  );
}
