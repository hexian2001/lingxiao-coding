/**
 * FileCanvas — v1.0.5 剑阁文件画布
 *
 * 左侧：文件目录树（调用 /api/v1/fs/list）
 * 右侧：全功能预览（复用 ArtifactView 渲染器能力）
 * 联动：点击文件→预览；预览中可评论→修改文件内容
 */

import { useCallback, useEffect, useState } from 'react';
import { useJiangeStore, type JiangeFileNode } from '../../stores/jiangeStore';
import { apiHeaders } from '../../api/headers';
import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown,
  FileCode, FileText, Image, FileType, Loader2, RefreshCw, Eye, Code2,
} from 'lucide-react';

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}

export function FileCanvas() {
  const [tree, setTree] = useState<JiangeFileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [previewMode, setPreviewMode] = useState<'render' | 'source'>('render');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (dirPath: string): Promise<JiangeFileNode[]> => {
    try {
      const res = await fetch(`/api/v1/fs/list?path=${encodeURIComponent(dirPath)}`, {
        headers: apiHeaders(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const entries: FsEntry[] = json?.data || [];
      return entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: e.isDirectory,
        size: e.size,
        modified: e.modified,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, []);

  // Load root directory on mount
  useEffect(() => {
    setIsLoading(true);
    loadDir('.').then((nodes) => {
      setTree(nodes);
      setIsLoading(false);
    });
  }, [loadDir]);

  // Toggle directory expansion
  const toggleDir = useCallback(async (node: JiangeFileNode) => {
    const newExpanded = new Set(expandedPaths);
    if (newExpanded.has(node.path)) {
      newExpanded.delete(node.path);
    } else {
      newExpanded.add(node.path);
      if (!node.children) {
        const children = await loadDir(node.path);
        node.children = children;
      }
    }
    setExpandedPaths(newExpanded);
    setTree([...tree]);
  }, [expandedPaths, loadDir, tree]);

  // Load file for preview
  const loadFile = useCallback(async (filePath: string) => {
    setIsLoadingFile(true);
    setActiveFile(filePath);
    try {
      const res = await fetch(`/api/v1/fs/read?path=${encodeURIComponent(filePath)}`, {
        headers: apiHeaders(),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setFileContent(json?.data?.content || '');
      // Auto-detect preview mode
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (['html', 'htm'].includes(ext || '')) {
        setPreviewMode('render');
      } else {
        setPreviewMode('source');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFileContent('');
    } finally {
      setIsLoadingFile(false);
    }
  }, []);

  const refreshTree = useCallback(async () => {
    setIsLoading(true);
    const nodes = await loadDir('.');
    setTree(nodes);
    setExpandedPaths(new Set());
    setIsLoading(false);
  }, [loadDir]);

  return (
    <div className="flex h-full bg-bg-primary overflow-hidden">
      {/* Left: File Tree */}
      <div className="w-56 flex flex-col border-r border-border-subtle bg-bg-secondary flex-shrink-0">
        <div className="flex items-center gap-2 px-3 h-7 border-b border-border-subtle bg-bg-tertiary/50 flex-shrink-0">
          <span className="text-[11px] font-medium text-text-tertiary flex-1">文件目录</span>
          <button
            onClick={refreshTree}
            className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary"
            title="刷新"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-text-tertiary">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : (
            <FileTreeNodes
              nodes={tree}
              expandedPaths={expandedPaths}
              activeFile={activeFile}
              onToggleDir={toggleDir}
              onFileClick={loadFile}
              depth={0}
            />
          )}
        </div>
      </div>

      {/* Right: Preview */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-7 border-b border-border-subtle bg-bg-tertiary/50 flex-shrink-0">
          {activeFile ? (
            <>
              <FileIcon size={12} className="text-text-tertiary" />
              <span className="text-[11px] font-mono text-text-secondary truncate flex-1">{activeFile}</span>
              <button
                onClick={() => setPreviewMode(p => p === 'render' ? 'source' : 'render')}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${
                  previewMode === 'render' ? 'text-accent-brand bg-accent-brand/10' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {previewMode === 'render' ? <Eye size={10} /> : <Code2 size={10} />}
                {previewMode === 'render' ? '渲染' : '源码'}
              </button>
            </>
          ) : (
            <span className="text-[11px] text-text-tertiary">选择文件预览</span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {isLoadingFile ? (
            <div className="flex items-center justify-center h-full text-text-tertiary">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : activeFile ? (
            <FilePreview
              filePath={activeFile}
              content={fileContent}
              mode={previewMode}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-2">
              <FileText size={40} className="opacity-20" />
              <p className="text-[12px]">从左侧目录选择文件查看预览</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileTreeNodes({
  nodes, expandedPaths, activeFile, onToggleDir, onFileClick, depth,
}: {
  nodes: JiangeFileNode[];
  expandedPaths: Set<string>;
  activeFile: string | null;
  onToggleDir: (node: JiangeFileNode) => void;
  onFileClick: (path: string) => void;
  depth: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isExpanded = expandedPaths.has(node.path);
        const isActive = activeFile === node.path;
        const ext = node.name.split('.').pop()?.toLowerCase() || '';

        return (
          <div key={node.path}>
            <button
              onClick={() => node.isDirectory ? onToggleDir(node) : onFileClick(node.path)}
              className={`w-full flex items-center gap-1 px-1.5 py-0.5 text-[11px] hover:bg-bg-hover text-left ${
                isActive ? 'bg-accent-brand/10 text-accent-brand' : 'text-text-secondary'
              }`}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
            >
              {node.isDirectory ? (
                <>
                  {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {isExpanded ? <FolderOpen size={12} className="text-accent-brand/60" /> : <Folder size={12} className="text-accent-brand/60" />}
                </>
              ) : (
                <>
                  <span className="w-[10px]" />
                  <FileIconForExt ext={ext} />
                </>
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {node.isDirectory && isExpanded && node.children && (
              <FileTreeNodes
                nodes={node.children}
                expandedPaths={expandedPaths}
                activeFile={activeFile}
                onToggleDir={onToggleDir}
                onFileClick={onFileClick}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function FileIconForExt({ ext }: { ext: string }) {
  const iconClass = "size={12} text-text-tertiary";
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'go', 'rs'].includes(ext)) {
    return <FileCode size={12} className="text-accent-blue/60" />;
  }
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) {
    return <FileCode size={12} className="text-accent-orange/60" />;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(ext)) {
    return <Image size={12} className="text-accent-green/60" />;
  }
  if (['pdf', 'docx', 'pptx', 'xlsx'].includes(ext)) {
    return <FileType size={12} className="text-accent-red/60" />;
  }
  if (['md', 'txt', 'log'].includes(ext)) {
    return <FileText size={12} className="text-text-tertiary" />;
  }
  return <FileIcon size={12} className="text-text-tertiary" />;
}

function FilePreview({ filePath, content, mode }: {
  filePath: string;
  content: string;
  mode: 'render' | 'source';
}) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  // HTML render
  if (mode === 'render' && ['html', 'htm'].includes(ext)) {
    return (
      <iframe
        srcDoc={content}
        className="w-full h-full border-none bg-white"
        sandbox="allow-scripts allow-same-origin"
        title="File preview"
      />
    );
  }

  // SVG render
  if (mode === 'render' && ext === 'svg') {
    return (
      <div className="flex items-center justify-center h-full p-4 bg-white" dangerouslySetInnerHTML={{ __html: content }} />
    );
  }

  // Markdown render (simplified)
  if (mode === 'render' && ['md', 'markdown'].includes(ext)) {
    return (
      <div className="p-4 prose prose-sm dark:prose-invert max-w-none">
        <MarkdownLite content={content} />
      </div>
    );
  }

  // Image preview
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(ext)) {
    return (
      <div className="flex items-center justify-center h-full p-4 bg-bg-secondary/30">
        <img
          src={`/api/v1/fs/read?path=${encodeURIComponent(filePath)}&raw=true`}
          alt={filePath}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }

  // Source code
  return (
    <pre className="p-3 text-[12px] font-mono text-text-secondary whitespace-pre-wrap break-all overflow-auto h-full">
      {content || '(空文件)'}
    </pre>
  );
}

/** Simple markdown renderer — headings, bold, italic, code, lists */
function MarkdownLite({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];

  lines.forEach((line, i) => {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={`code-${i}`} className="bg-bg-tertiary p-2 rounded text-[12px] font-mono overflow-auto my-2">
            {codeBuffer.join('\n')}
          </pre>
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      return;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      return;
    }
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-xl font-bold mt-3 mb-1">{line.slice(2)}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-lg font-bold mt-2 mb-1">{line.slice(3)}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-base font-semibold mt-2 mb-1">{line.slice(4)}</h3>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(<li key={i} className="ml-4 text-sm">{renderInline(line.slice(2))}</li>);
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i} className="text-sm leading-relaxed">{renderInline(line)}</p>);
    }
  });

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  // Simple inline: **bold**, *italic*, `code`
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const m = match[0];
    if (m.startsWith('**')) {
      parts.push(<strong key={key++}>{m.slice(2, -2)}</strong>);
    } else if (m.startsWith('`')) {
      parts.push(<code key={key++} className="px-1 py-0.5 bg-bg-tertiary rounded text-[11px] font-mono">{m.slice(1, -1)}</code>);
    } else if (m.startsWith('*')) {
      parts.push(<em key={key++}>{m.slice(1, -1)}</em>);
    }
    lastIndex = match.index + m.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}
