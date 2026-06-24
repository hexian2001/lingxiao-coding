/**
 * FileCanvasCompact — 剑阁侧边面板内的文件画布
 *
 * 左侧文件目录树 + 右侧全功能预览
 * 复用 /api/v1/fs/list 和 /api/v1/fs/read
 */

import { useCallback, useEffect, useState } from 'react';
import { apiHeaders } from '../../api/headers';
import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown,
  FileCode, FileText, Image, Loader2, RefreshCw, Eye, Code2,
} from 'lucide-react';

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

interface FileNode extends FsEntry {
  children?: FileNode[];
}

export default function FileCanvasCompact() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [previewMode, setPreviewMode] = useState<'render' | 'source'>('render');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (dirPath: string): Promise<FileNode[]> => {
    try {
      const res = await fetch(`/api/v1/fs/list?path=${encodeURIComponent(dirPath)}`, { headers: apiHeaders() });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      return (json?.data || []) as FileNode[];
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    loadDir('.').then((nodes) => { setTree(nodes); setIsLoading(false); });
  }, [loadDir]);

  const toggleDir = useCallback(async (node: FileNode) => {
    const newExpanded = new Set(expandedPaths);
    if (newExpanded.has(node.path)) {
      newExpanded.delete(node.path);
    } else {
      newExpanded.add(node.path);
      if (!node.children) {
        node.children = await loadDir(node.path);
      }
    }
    setExpandedPaths(newExpanded);
    setTree([...tree]);
  }, [expandedPaths, loadDir, tree]);

  const loadFile = useCallback(async (filePath: string) => {
    setIsLoadingFile(true);
    setActiveFile(filePath);
    try {
      const res = await fetch(`/api/v1/fs/read?path=${encodeURIComponent(filePath)}`, { headers: apiHeaders() });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setFileContent(json?.data?.content || '');
      const ext = filePath.split('.').pop()?.toLowerCase();
      setPreviewMode(['html', 'htm'].includes(ext || '') ? 'render' : 'source');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFileContent('');
    } finally {
      setIsLoadingFile(false);
    }
  }, []);

  return (
    <div className="flex h-full bg-bg-primary overflow-hidden">
      {/* File tree */}
      <div className="w-48 flex flex-col border-r border-border-subtle bg-bg-secondary flex-shrink-0">
        <div className="flex items-center gap-2 px-3 h-7 border-b border-border-subtle bg-bg-tertiary/50 flex-shrink-0">
          <span className="text-[11px] font-medium text-text-tertiary flex-1">文件</span>
          <button onClick={() => { setIsLoading(true); loadDir('.').then(n => { setTree(n); setExpandedPaths(new Set()); setIsLoading(false); }); }} className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary" title="刷新">
            <RefreshCw size={11} />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-0.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-text-tertiary"><Loader2 size={14} className="animate-spin" /></div>
          ) : (
            <TreeNodes nodes={tree} expandedPaths={expandedPaths} activeFile={activeFile} onToggleDir={toggleDir} onFileClick={loadFile} depth={0} />
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-7 border-b border-border-subtle bg-bg-tertiary/50 flex-shrink-0">
          {activeFile ? (
            <>
              <FileIcon size={11} className="text-text-tertiary" />
              <span className="text-[11px] font-mono text-text-secondary truncate flex-1">{activeFile}</span>
              <button onClick={() => setPreviewMode(p => p === 'render' ? 'source' : 'render')} className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${previewMode === 'render' ? 'text-accent-brand bg-accent-brand/10' : 'text-text-tertiary'}`}>
                {previewMode === 'render' ? <Eye size={10} /> : <Code2 size={10} />}
                {previewMode === 'render' ? '渲染' : '源码'}
              </button>
            </>
          ) : <span className="text-[11px] text-text-tertiary">选择文件</span>}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {isLoadingFile ? (
            <div className="flex items-center justify-center h-full text-text-tertiary"><Loader2 size={16} className="animate-spin" /></div>
          ) : activeFile ? (
            <Preview filePath={activeFile} content={fileContent} mode={previewMode} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-2">
              <FileText size={32} className="opacity-20" />
              <p className="text-[11px]">从左侧选择文件</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeNodes({ nodes, expandedPaths, activeFile, onToggleDir, onFileClick, depth }: {
  nodes: FileNode[]; expandedPaths: Set<string>; activeFile: string | null;
  onToggleDir: (n: FileNode) => void; onFileClick: (p: string) => void; depth: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isExpanded = expandedPaths.has(node.path);
        const isActive = activeFile === node.path;
        const ext = node.name.split('.').pop()?.toLowerCase() || '';
        return (
          <div key={node.path}>
            <button onClick={() => node.isDirectory ? onToggleDir(node) : onFileClick(node.path)} className={`w-full flex items-center gap-1 px-1.5 py-0.5 text-[11px] hover:bg-bg-hover text-left ${isActive ? 'bg-accent-brand/10 text-accent-brand' : 'text-text-secondary'}`} style={{ paddingLeft: `${depth * 10 + 4}px` }}>
              {node.isDirectory ? (
                <>{isExpanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}{isExpanded ? <FolderOpen size={11} className="text-accent-brand/60" /> : <Folder size={11} className="text-accent-brand/60" />}</>
              ) : (
                <><span className="w-[9px]" />{['ts','tsx','js','jsx','json','py'].includes(ext) ? <FileCode size={11} className="text-accent-blue/60" /> : ['html','htm','svg','xml'].includes(ext) ? <FileCode size={11} className="text-accent-orange/60" /> : ['png','jpg','jpeg','gif','webp'].includes(ext) ? <Image size={11} className="text-accent-green/60" /> : <FileIcon size={11} className="text-text-tertiary" />}</>
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {node.isDirectory && isExpanded && node.children && <TreeNodes nodes={node.children} expandedPaths={expandedPaths} activeFile={activeFile} onToggleDir={onToggleDir} onFileClick={onFileClick} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

function Preview({ filePath, content, mode }: { filePath: string; content: string; mode: 'render' | 'source' }) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (mode === 'render' && ['html', 'htm'].includes(ext)) {
    return <iframe srcDoc={content} className="w-full h-full border-none bg-white" sandbox="allow-scripts allow-same-origin" title="preview" />;
  }
  if (mode === 'render' && ext === 'svg') {
    return <div className="flex items-center justify-center h-full p-4 bg-white" dangerouslySetInnerHTML={{ __html: content }} />;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(ext)) {
    return <div className="flex items-center justify-center h-full p-4"><img src={`/api/v1/fs/read?path=${encodeURIComponent(filePath)}&raw=true`} alt={filePath} className="max-w-full max-h-full object-contain" /></div>;
  }
  return <pre className="p-2 text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all overflow-auto h-full">{content || '(空文件)'}</pre>;
}
