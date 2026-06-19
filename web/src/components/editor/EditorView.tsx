/**
 * EditorView — Monaco 代码编辑器 + 文件树
 *
 * 企业级代码编辑器体验：
 * - Monaco Editor（VS Code 同款引擎）
 * - 文件树浏览、代码高亮、行号、minimap
 * - 图片预览
 * - 保存文件
 * - 大文件保护、tab LRU 淘汰、二进制检测
 */

import { useEffect, useState, useCallback, useRef, Suspense, lazy, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileCode, Folder, FolderOpen, File, FilePlus2, FolderPlus,
  Save, RefreshCw, Loader2, AlertTriangle, X, ChevronRight, ChevronDown,
  Image, FileText, FileJson, FileCode2, Braces, AlertOctagon,
} from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { getServerToken } from '../../api/headers';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));
type MonacoEditorInstance = Parameters<NonNullable<import('@monaco-editor/react').EditorProps['onMount']>>[0];

// ─── Constants ───

const MAX_FILE_SIZE = 2 * 1024 * 1024;        // 2MB — 超过拒绝加载
const WARN_FILE_SIZE = 500 * 1024;             // 500KB — 超过显示警告
const MAX_TABS = 10;                           // 最多同时打开的 tab 数
const BINARY_CHECK_BYTES = 8192;               // 检测前 8KB 判断是否二进制

// ─── Types ───

interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FsEntry[];
}

interface EditorTab {
  path: string;
  name: string;
  content: string;
  modified: boolean;
  language?: string;
  size?: number;
  /** 最后访问时间戳，用于 LRU 淘汰 */
  lastAccess: number;
}

// ─── API ───

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Helpers ───

function mergeChildren(tree: FsEntry[], parentPath: string, children: FsEntry[]): FsEntry[] {
  return tree.map(entry => {
    if (entry.path === parentPath && entry.type === 'directory') {
      return { ...entry, children };
    }
    if (entry.children) {
      return { ...entry, children: mergeChildren(entry.children, parentPath, children) };
    }
    return entry;
  });
}

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
    html: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', graphql: 'graphql', vue: 'html', svelte: 'html',
    toml: 'ini', ini: 'ini', env: 'ini',
    dockerfile: 'dockerfile',
  };
  if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return map[ext] || 'plaintext';
}

function isImageFile(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp)$/i.test(path);
}

/** 检测内容是否为二进制（含 null 字节） */
function isBinaryContent(content: string): boolean {
  const checkLen = Math.min(content.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx'].includes(ext)) return <FileCode2 className="w-3.5 h-3.5 text-blue-400" />;
  if (['js', 'jsx'].includes(ext)) return <FileCode2 className="w-3.5 h-3.5 text-yellow-400" />;
  if (ext === 'json') return <Braces className="w-3.5 h-3.5 text-yellow-300" />;
  if (['css', 'scss', 'less'].includes(ext)) return <FileCode2 className="w-3.5 h-3.5 text-purple-400" />;
  if (['md', 'mdx'].includes(ext)) return <FileText className="w-3.5 h-3.5 text-gray-400" />;
  if (ext === 'svg') return <Image className="w-3.5 h-3.5 text-green-400" />;
  return <File className="w-3.5 h-3.5 text-text-tertiary" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ─── File Tree Node ───

function FileTreeNode({
  entry,
  depth,
  onFileClick,
  expanded,
  onToggle,
}: {
  entry: FsEntry;
  depth: number;
  onFileClick: (path: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isDir = entry.type === 'directory';
  const isOpen = expanded.has(entry.path);

  return (
    <div>
      <button
        className="w-full text-left py-[3px] text-xs hover:bg-bg-hover flex items-center gap-1.5 transition-colors group"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => isDir ? onToggle(entry.path) : onFileClick(entry.path)}
      >
        {isDir ? (
          <>
            {isOpen ? <ChevronDown className="w-3 h-3 text-text-tertiary" /> : <ChevronRight className="w-3 h-3 text-text-tertiary" />}
            {isOpen ? <FolderOpen className="w-3.5 h-3.5 text-yellow-500" /> : <Folder className="w-3.5 h-3.5 text-yellow-600" />}
          </>
        ) : (
          <>
            <span className="w-3" />
            {getFileIcon(entry.name)}
          </>
        )}
        <span className="text-text-secondary truncate flex-1 group-hover:text-text-primary transition-colors">{entry.name}</span>
        {!isDir && entry.size != null && (
          <span className="text-[10px] text-text-tertiary/50 pr-2 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatSize(entry.size)}
          </span>
        )}
      </button>
      {isDir && isOpen && entry.children?.map((child) => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          onFileClick={onFileClick}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

// ─── Image Preview ───

function ImagePreview({ path, sessionId }: { path: string; sessionId?: string | null }) {
  const [error, setError] = useState(false);
  const params = new URLSearchParams({ path, token: getServerToken() });
  if (sessionId) params.set('sessionId', sessionId);
  const src = `/api/v1/files/download?${params.toString()}`;

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        <div className="text-center">
          <Image className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Failed to load image</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4 bg-bg-primary">
      <img
        src={src}
        alt={path.split('/').pop()}
        className="max-w-full max-h-full object-contain"
        onError={() => setError(true)}
      />
    </div>
  );
}

// ─── File Too Large Placeholder ───

function FileTooLarge({ name, size }: { name: string; size: number }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
      <AlertOctagon className="w-12 h-12 mb-3 opacity-30" />
      <p className="text-sm mb-1 font-medium">{name}</p>
      <p className="text-xs text-text-tertiary/60 mb-3">
        {formatSize(size)} — exceeds {formatSize(MAX_FILE_SIZE)} limit
      </p>
      <p className="text-xs text-text-tertiary/40">Use an external editor for very large files</p>
    </div>
  );
}

// ─── Main Component ───

export default function EditorView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const serverCwd = useSessionStore((s) => s.serverCwd);
  const workspace = sessions.find(s => s.id === sessionId)?.workspace || serverCwd || '.';
  const [tree, setTree] = useState<FsEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditorInstance | null>(null);
  const pendingLineRef = useRef<number | null>(null);

  const fetchTree = useCallback(async (dirPath?: string) => {
    setIsLoading(true);
    try {
      const data = await apiFetch<{ entries: FsEntry[] }>('/fs/list', {
        method: 'POST',
        body: JSON.stringify({ path: dirPath || workspace, sessionId }),
      });
      if (dirPath) {
        setTree(prev => mergeChildren(prev, dirPath, data.entries || []));
      } else {
        setTree(data.entries || []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list files');
    } finally {
      setIsLoading(false);
    }
  }, [workspace, sessionId]);

  useEffect(() => { fetchTree(); }, [fetchTree]);

  /** LRU 淘汰：超过 MAX_TABS 时关闭最久未访问的 tab */
  const evictLRU = useCallback((currentTabs: EditorTab[]): EditorTab[] => {
    if (currentTabs.length < MAX_TABS) return currentTabs;
    const sorted = [...currentTabs].sort((a, b) => a.lastAccess - b.lastAccess);
    const toRemove = sorted[0];
    return currentTabs.filter(t => t.path !== toRemove.path);
  }, []);

  /** Open a file and optionally jump to a line number (1-based). */
  const openFileTo = useCallback(async (filePath: string, line?: number) => {
    if (line != null) pendingLineRef.current = line;
    const existing = tabs.find((t) => t.path === filePath);
    if (existing) {
      // 更新 lastAccess
      setTabs(prev => prev.map(t => t.path === filePath ? { ...t, lastAccess: Date.now() } : t));
      setActiveTab(filePath);
      return;
    }
    if (isImageFile(filePath)) {
      const name = filePath.split('/').pop() || filePath;
      setTabs((prev) => {
        const next = evictLRU(prev);
        return [...next, { path: filePath, name, content: '', modified: false, lastAccess: Date.now() }];
      });
      setActiveTab(filePath);
      return;
    }
    try {
      const params = new URLSearchParams({ path: filePath });
      if (sessionId) params.set('sessionId', sessionId);
      const res = await fetch(`/api/v1/files/download?${params.toString()}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      if (!res.ok) throw new Error('Failed to load file');
      const data = await res.json();
      const content = data.content || '';
      const fileSize = data.size || content.length;

      // 二进制文件检测
      if (isBinaryContent(content)) {
        setError(`${filePath.split('/').pop()}: binary file, cannot edit`);
        return;
      }

      // 大文件检测
      if (fileSize > MAX_FILE_SIZE) {
        const name = filePath.split('/').pop() || filePath;
        setTabs((prev) => {
          const next = evictLRU(prev);
          return [...next, { path: filePath, name, content: '', modified: false, size: fileSize, language: getLanguage(filePath), lastAccess: Date.now() }];
        });
        setActiveTab(filePath);
        return;
      }

      const name = filePath.split('/').pop() || filePath;
      const language = getLanguage(filePath);
      setTabs((prev) => {
        const next = evictLRU(prev);
        return [...next, { path: filePath, name, content, modified: false, language, size: fileSize, lastAccess: Date.now() }];
      });
      setActiveTab(filePath);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open file');
    }
  }, [tabs, sessionId, evictLRU]);

  // Listen for external open-file requests
  useEffect(() => {
    const handler = (e: Event) => {
      const { path, line } = (e as CustomEvent<{ path: string; line?: number }>).detail;
      if (path) openFileTo(path, line);
    };
    window.addEventListener('lingxiao:open-file', handler);
    return () => window.removeEventListener('lingxiao:open-file', handler);
  }, [openFileTo]);

  // When switching to a tab that already had a pending line, reveal it
  useEffect(() => {
    if (pendingLineRef.current != null && editorRef.current) {
      const line = pendingLineRef.current;
      pendingLineRef.current = null;
      setTimeout(() => {
        editorRef.current?.revealLineInCenter(line);
        editorRef.current?.setPosition({ lineNumber: line, column: 1 });
      }, 50);
    }
  }, [activeTab]);

  const handleToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    fetchTree(path);
  };

  const handleFileClick = async (filePath: string) => {
    await openFileTo(filePath);
  };

  const handleSave = async () => {
    if (!activeTab) return;
    const tab = tabs.find((t) => t.path === activeTab);
    if (!tab) return;

    try {
      await apiFetch('/fs/write', {
        method: 'POST',
        body: JSON.stringify({ path: tab.path, content: tab.content, sessionId }),
      });
      setTabs((prev) => prev.map((t) => t.path === activeTab ? { ...t, modified: false } : t));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const handleContentChange = (value: string | undefined) => {
    if (!activeTab || value === undefined) return;
    setTabs((prev) => prev.map((t) => t.path === activeTab ? { ...t, content: value, modified: true } : t));
  };

  const closeTab = (path: string) => {
    setTabs((prev) => prev.filter((t) => t.path !== path));
    if (activeTab === path) {
      setActiveTab(tabs.find((t) => t.path !== path)?.path || null);
    }
  };

  const currentTab = tabs.find((t) => t.path === activeTab);

  // 是否为超大文件（只读提示）
  const isOversized = currentTab && currentTab.size != null && currentTab.size > MAX_FILE_SIZE;
  // 是否显示大文件警告
  const showSizeWarning = currentTab && currentTab.size != null && currentTab.size > WARN_FILE_SIZE && !isOversized;

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab, tabs]);

  return (
    <div className="flex h-full bg-bg-primary">
      {/* Sidebar — file tree */}
      <div className="w-60 border-r border-border-muted flex flex-col bg-bg-secondary overflow-hidden">
        <div className="px-3 py-2 border-b border-border-muted flex items-center justify-between">
          <span className="text-[11px] font-mono tracking-wider text-text-tertiary uppercase flex items-center gap-1.5">
            <FileCode className="w-3 h-3" />
            Explorer
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => {
                const name = prompt('New file name (relative to workspace):');
                if (!name) return;
                const filePath = `${workspace}/${name}`;
                fetch('/api/v1/fs/write', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
                  body: JSON.stringify({ path: filePath, content: '', sessionId }),
                }).then(() => fetchTree());
              }}
              className="p-1 text-text-tertiary/50 hover:text-accent-brand" title="New File"
            >
              <FilePlus2 className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                const name = prompt('New folder name (relative to workspace):');
                if (!name) return;
                fetch('/api/v1/fs/mkdir', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
                  body: JSON.stringify({ path: `${workspace}/${name}`, recursive: true, sessionId }),
                }).then(() => fetchTree());
              }}
              className="p-1 text-text-tertiary/50 hover:text-accent-brand" title="New Folder"
            >
              <FolderPlus className="w-3 h-3" />
            </button>
            <button onClick={() => fetchTree()} className="p-1 text-text-tertiary/50 hover:text-accent-brand">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Workspace label */}
        <div className="px-3 py-1.5 text-[10px] font-mono text-accent-brand/60 tracking-wider border-b border-border-muted/50">
          {workspace.split('/').pop()?.toUpperCase() || 'WORKSPACE'}
        </div>

        <div className="flex-1 overflow-y-auto py-0.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 text-accent-brand animate-spin" />
            </div>
          ) : (
            tree.map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                onFileClick={handleFileClick}
                expanded={expanded}
                onToggle={handleToggle}
              />
            ))
          )}
        </div>
      </div>

      {/* Main — editor area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {error && (
          <div className="px-4 py-2 bg-accent-red/10 text-accent-red text-xs flex items-center gap-2 border-b border-accent-red/20 shrink-0">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="hover:underline"><X size={14} /></button>
          </div>
        )}

        {/* Tab bar */}
        {tabs.length > 0 && (
          <div className="flex bg-bg-secondary border-b border-border-muted overflow-x-auto shrink-0">
            {tabs.map((tab) => (
              <div
                key={tab.path}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border-muted cursor-pointer group min-w-0 ${
                  activeTab === tab.path
                    ? 'bg-bg-primary text-text-primary border-t-[2px] border-t-accent-brand'
                    : 'text-text-tertiary hover:text-text-secondary border-t-[2px] border-t-transparent'
                }`}
                onClick={() => {
                  setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, lastAccess: Date.now() } : t));
                  setActiveTab(tab.path);
                }}
              >
                {getFileIcon(tab.name)}
                <span className="truncate max-w-28">{tab.name}</span>
                {tab.modified && <span className="w-2 h-2 rounded-full bg-accent-brand shrink-0" />}
                <button
                  className="ml-1 text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Editor / Image content */}
        {currentTab ? (
          isImageFile(currentTab.path) ? (
            <ImagePreview path={currentTab.path} sessionId={sessionId} />
          ) : isOversized ? (
            <FileTooLarge name={currentTab.name} size={currentTab.size!} />
          ) : (
            <div className="flex-1 min-h-0 overflow-hidden relative">
              {/* 大文件警告 */}
              {showSizeWarning && (
                <div className="absolute top-2 right-2 z-10 px-2 py-1 bg-accent-yellow/20 text-accent-yellow text-[10px] rounded border border-accent-yellow/30">
                  Large file: {formatSize(currentTab.size!)}
                </div>
              )}
              <Suspense fallback={
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-5 h-5 text-accent-brand animate-spin" />
                </div>
              }>
                <MonacoEditor
                  height="100%"
                  language={currentTab.language || 'plaintext'}
                  value={currentTab.content}
                  onChange={handleContentChange}
                  theme="vs-dark"
                  options={{
                    fontSize: 13,
                    fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
                    minimap: { enabled: true, scale: 1 },
                    scrollBeyondLastLine: false,
                    wordWrap: 'off',
                    lineNumbers: 'on',
                    renderLineHighlight: 'all',
                    smoothScrolling: true,
                    cursorBlinking: 'smooth',
                    cursorSmoothCaretAnimation: 'on',
                    padding: { top: 12 },
                    automaticLayout: true,
                    tabSize: 2,
                    bracketPairColorization: { enabled: true },
                    scrollbar: {
                      vertical: 'auto',
                      horizontal: 'auto',
                      verticalScrollbarSize: 10,
                      horizontalScrollbarSize: 10,
                    },
                    // 大文件性能优化
                    ...(currentTab.size && currentTab.size > WARN_FILE_SIZE ? {
                      minimap: { enabled: false },
                      wordWrap: 'off',
                      renderValidationDecorations: 'off',
                    } : {}),
                  }}
                  onMount={(editor) => {
                    editorRef.current = editor;
                    if (pendingLineRef.current != null) {
                      const line = pendingLineRef.current;
                      pendingLineRef.current = null;
                      setTimeout(() => {
                        editor.revealLineInCenter(line);
                        editor.setPosition({ lineNumber: line, column: 1 });
                      }, 50);
                    }
                    editor.addCommand(2097 /* KeyMod.CtrlCmd | KeyCode.KeyS */, () => {
                      handleSave();
                    });
                  }}
                />
              </Suspense>

              {/* Status bar */}
              <div className="flex items-center justify-between px-3 py-0.5 bg-bg-secondary border-t border-border-muted text-[10px] text-text-tertiary/60 font-mono shrink-0">
                <div className="flex items-center gap-3">
                  <span>{currentTab.language?.toUpperCase() || 'PLAIN'}</span>
                  <span>UTF-8</span>
                  {currentTab.size != null && <span>{formatSize(currentTab.size)}</span>}
                </div>
                <div className="flex items-center gap-3">
                  {currentTab.modified && <span className="text-accent-brand">Modified</span>}
                  <span className="truncate max-w-64">{currentTab.path}</span>
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
            <FileCode className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm mb-1">No file open</p>
            <p className="text-xs text-text-tertiary/50">Select a file from the explorer to start editing</p>
          </div>
        )}
      </div>
    </div>
  );
}
