import type { Message, ToolCall, AgentActivity, ContentBlock } from '../../stores/sessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import SafeMarkdown, { type SafeMarkdownComponents } from '../ui/SafeMarkdown';
// PrismAsync (2026-05-29)：异步/按需加载语言定义，把代码高亮 tokenize 移出同步 render 路径。
// 旧的同步 `Prism` 会在流式每帧对消息内所有代码块做全量重高亮，是 web 端流式卡顿的主因之一。
import { PrismAsync as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Bot, User, Cpu, Brain, ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle, Loader2, Zap, RefreshCw, Copy, Pencil, RotateCcw, AlertTriangle, Download, FileArchive, FileText, Eye, Search, Terminal, FilePlus2, PencilLine, Files, Network, ImageIcon, ExternalLink } from 'lucide-react';
import { apiHeaders } from '../../api/headers';
import { memo, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useArtifactStore } from '../../stores/artifactStore';
import { useViewStore } from '../../stores/viewStore';
import { useTranslation } from 'react-i18next';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import PreCopyButton from './PreCopyButton';
import { acpClient } from '../../api/AcpClient';
import { getServerToken } from '../../api/headers';
import { isToolCallOpenStatus, normalizeAgentStatus, normalizeToolCallStatus } from '../../stores/sessionStoreHelpers';
import { formatFileChangeSummary } from '../../utils/fileChangeSummary';
import { classifyTool, type ToolUiKind } from './toolClassification';
import ToolOutputView from './ToolOutputView';import McpAppRenderer from './McpAppRenderer';
import { inferInputLanguage, inferOutputLanguage } from './toolOutputFormat';

// Module-level settings cache for hook output collapse preference
let _hookOutputCollapsed: boolean | null = null;
let _settingsFetched = false;
async function fetchHookOutputSetting(): Promise<boolean> {
  if (_settingsFetched) return _hookOutputCollapsed !== false;
  _settingsFetched = true;
  try {
    const res = await fetch('/api/v1/settings', { headers: { 'x-lingxiao-token': getServerToken() } });
    const json = await res.json();
    _hookOutputCollapsed = json?.data?.hookOutputCollapsed !== false;
  } catch { _hookOutputCollapsed = true; }
  return _hookOutputCollapsed !== false;
}

interface Props {
  message: Message;
  onAgentClick?: () => void;
  onEdit?: (messageId: string, content: string) => void;
  onRetry?: (messageId: string) => void;
}

interface DownloadArtifact {
  type: 'download_artifact';
  url: string;
  name: string;
  path?: string;
  size?: number;
  mimeType?: string;
  expiresAt?: string;
}

type ToolResultPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'image_blob_ref'; blob_id: string; mime: string; size: number; blob_path: string; source?: string }
  | {
      type: 'mcp_app';
      html: string;
      title?: string;
      height?: number | 'auto';
      actions?: Array<{ label: string; event: string; data?: unknown }>;
    };

function parseDownloadArtifact(value: unknown): DownloadArtifact | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const artifact = parsed as Partial<DownloadArtifact>;
  if (artifact.type !== 'download_artifact' || typeof artifact.url !== 'string' || typeof artifact.name !== 'string') {
    return null;
  }
  return artifact as DownloadArtifact;
}

function normalizeToolResultPart(part: unknown): ToolResultPart | null {
  if (!part || typeof part !== 'object') return null;
  const raw = part as Record<string, unknown>;
  if (raw.type === 'text' && typeof raw.text === 'string') {
    return { type: 'text', text: raw.text };
  }
  const imageUrl = raw.image_url && typeof raw.image_url === 'object'
    ? raw.image_url as Record<string, unknown>
    : null;
  if (
    raw.type === 'image_url' &&
    imageUrl &&
    typeof imageUrl.url === 'string'
  ) {
    const detail = imageUrl.detail === 'low' || imageUrl.detail === 'high' || imageUrl.detail === 'auto'
      ? imageUrl.detail
      : undefined;
    return { type: 'image_url', image_url: { url: imageUrl.url, detail } };
  }
  if (
    raw.type === 'image_blob_ref' &&
    typeof raw.blob_id === 'string' &&
    typeof raw.mime === 'string' &&
    typeof raw.size === 'number' &&
    typeof raw.blob_path === 'string'
  ) {
    return {
      type: 'image_blob_ref',
      blob_id: raw.blob_id,
      mime: raw.mime,
      size: raw.size,
      blob_path: raw.blob_path,
      source: typeof raw.source === 'string' ? raw.source : undefined,
    };
  }
  // ── MCP App 交互式组件 ──
  if (raw.type === 'mcp_app'
      && typeof raw.html === 'string'
      && raw.html.length > 0) {
    return {
      type: 'mcp_app',
      html: raw.html,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      height: typeof raw.height === 'number'
        ? Math.min(Math.max(raw.height, 100), 800)
        : 'auto',
      actions: Array.isArray(raw.actions)
        ? raw.actions.filter(
            (a: any) => typeof a.label === 'string' && typeof a.event === 'string')
        : undefined,
    };
  }
  return null;
}

function parseToolResultParts(value: unknown): ToolResultPart[] | null {
  let candidate = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[')) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(candidate)) return null;
  const parts = candidate.map(normalizeToolResultPart).filter((part): part is ToolResultPart => !!part);
  return parts.length > 0 ? parts : null;
}

function toolResultPartsToText(parts: ToolResultPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image_url') return '[image]';
      if (part.type === 'mcp_app') return `[MCP App: ${part.title ?? 'Interactive Component'}]`;
      return `[image: ${part.mime}, ${formatFileSize(part.size)}]`;
    })
    .filter(Boolean)
    .join('\n');
}

function structuredToolResultText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : null;
}

function isLeaderSyntheticToolSettleResult(value: unknown): boolean {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as { kind?: unknown }).kind === 'leader_tool_settle';
  }
  if (typeof value !== 'string') return false;
  return value.startsWith('Leader became idle before this tool produced a final result:')
    || value.startsWith('Runtime snapshot reported idle before this tool produced a final result:');
}

function realToolResult(value: unknown): unknown | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return isLeaderSyntheticToolSettleResult(value) ? undefined : value;
}

function settleDisplayStatus(value: unknown): string {
  if (!isLeaderSyntheticToolSettleResult(value)) return '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof value === 'string' ? value : '';
}

function toolDisplayStatus(tc: ToolCall, hasResult: boolean): string {
  if (hasResult) return '';
  if (typeof tc.displayStatus === 'string' && tc.displayStatus.trim()) return tc.displayStatus.trim();
  return settleDisplayStatus(tc.result);
}

function formatFileSize(size?: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function imageSrcForToolPart(part: Extract<ToolResultPart, { type: 'image_url' | 'image_blob_ref' }>): string | null {
  if (part.type === 'image_url') return part.image_url.url;
  if (!part.blob_path) return null;
  const params = new URLSearchParams({ path: part.blob_path, token: getServerToken() });
  return `/api/v1/artifacts/raw?${params.toString()}`;
}

function imageMetaForToolPart(part: Extract<ToolResultPart, { type: 'image_url' | 'image_blob_ref' }>): string {
  if (part.type === 'image_blob_ref') {
    return [part.mime, formatFileSize(part.size), part.source].filter(Boolean).join(' · ');
  }
  return part.image_url.detail ? `detail: ${part.image_url.detail}` : '';
}

function ToolResultImageCard({
  part,
  index,
  total,
}: {
  part: Extract<ToolResultPart, { type: 'image_url' | 'image_blob_ref' }>;
  index: number;
  total: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = imageSrcForToolPart(part);
  const meta = imageMetaForToolPart(part);
  const title = total > 1 ? `Image ${index + 1}` : 'Image result';

  if (!src || failed) {
    return (
      <div className="flex min-h-[132px] items-center justify-center rounded-lg border border-dashed border-border-muted bg-bg-secondary text-text-tertiary">
        <ImageIcon size={18} />
      </div>
    );
  }

  return (
    <figure className="group/image overflow-hidden rounded-lg border border-border-muted bg-bg-card shadow-sm transition-colors hover:border-border-default">
      <div className="flex items-center gap-2 border-b border-border-muted bg-bg-secondary/70 px-2.5 py-1.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border-muted bg-bg-card text-accent-blue">
          <ImageIcon size={13} />
        </span>
        <figcaption className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-text-secondary">{title}</div>
          {meta && <div className="truncate text-[10px] text-text-tertiary">{meta}</div>}
        </figcaption>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-70 transition hover:bg-bg-hover hover:text-accent-blue group-hover/image:opacity-100"
          title="Open image"
        >
          <ExternalLink size={13} />
        </a>
      </div>
      <a href={src} target="_blank" rel="noreferrer" className="block bg-bg-secondary">
        <img
          src={src}
          alt={meta || title}
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-[460px] min-h-[132px] w-full object-contain"
        />
      </a>
    </figure>
  );
}

function ToolResultPartView({ parts }: { parts: ToolResultPart[] }) {
  const textParts = parts.filter((part): part is Extract<ToolResultPart, { type: 'text' }> =>
    part.type === 'text' && part.text.trim().length > 0
  );
  const imageParts = parts.filter((part): part is Extract<ToolResultPart, { type: 'image_url' | 'image_blob_ref' }> =>
    part.type === 'image_url' || part.type === 'image_blob_ref'
  );
  const mcpAppParts = parts.filter(
    (part): part is Extract<ToolResultPart, { type: 'mcp_app' }> =>
      part.type === 'mcp_app'
  );

  return (
    <div className="space-y-2">
      {textParts.map((part, index) => (
        <ToolOutputView key={`text-${index}`} text={part.text} language="plaintext" />
      ))}
      {mcpAppParts.map((part, index) => (
        <McpAppRenderer
          key={`mcp-app-${index}`}
          html={part.html}
          title={part.title}
          height={part.height}
          actions={part.actions}
        />
      ))}
      {imageParts.length > 0 && (
        <div className={imageParts.length === 1 ? 'space-y-2' : 'grid gap-2 sm:grid-cols-2'}>
          {imageParts.map((part, index) => (
            <ToolResultImageCard key={`image-${index}`} part={part} index={index} total={imageParts.length} />
          ))}
        </div>
      )}
    </div>
  );
}


function decodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripHrefDecorations(href: string): string {
  return href.split('#')[0].split('?')[0];
}

function parseLocalFileHref(href?: string): { path: string; line?: number; column?: number; name: string } | null {
  if (!href) return null;
  const raw = decodeHrefPath(stripHrefDecorations(href.trim()));
  if (!raw || raw.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (raw.startsWith('//')) return null;
  if (raw.startsWith('/api/') || raw.startsWith('/assets/') || raw.startsWith('/static/')) return null;

  const lineMatch = raw.match(/^(.+?):(\d+)(?::(\d+))?$/);
  const path = lineMatch ? lineMatch[1] : raw;
  const isLocal = path.startsWith('/') || path.startsWith('./') || path.startsWith('../') || /^[\w@.-]+(?:\/[\w@.+ -]+)+$/.test(path);
  if (!isLocal) return null;

  const name = path.split('/').filter(Boolean).pop() || path;
  return {
    path,
    line: lineMatch ? Number(lineMatch[2]) : undefined,
    column: lineMatch?.[3] ? Number(lineMatch[3]) : undefined,
    name,
  };
}

function DownloadArtifactCard({ artifact }: { artifact: DownloadArtifact }) {
  const { t } = useTranslation();
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const setMainView = useViewStore((s) => s.setMainView);
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const lower = artifact.name.toLowerCase();
  const Icon = lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.gz') ? FileArchive : FileText;
  const meta = [
    formatFileSize(artifact.size),
    artifact.mimeType,
    artifact.expiresAt ? t('artifact.meta.expiresAt', { time: new Date(artifact.expiresAt).toLocaleString() }) : '',
  ].filter(Boolean).join(' · ');

  const handlePreview = () => {
    openArtifact({
      name: artifact.name,
      path: artifact.path,
      url: artifact.url,
      size: artifact.size,
      mimeType: artifact.mimeType,
      expiresAt: artifact.expiresAt,
    });
    setMainView('artifact');
  };

  const handleDownload = async () => {
    const candidates: string[] = [];
    if (artifact.path) {
      const params = new URLSearchParams({ path: artifact.path, token: getServerToken() });
      if (sessionId) params.set('sessionId', sessionId);
      candidates.push(`/api/v1/artifacts/raw?${params.toString()}`);
    }
    candidates.push(artifact.url);

    let lastError: Error | null = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { headers: apiHeaders() });
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const blob = await res.blob();
        if (blob.size === 0) throw new Error('Download returned empty content');
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = artifact.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError || new Error('Download failed');
  };

  return (
    <div
      className="group flex items-center gap-3 rounded-lg border border-border-muted bg-bg-secondary px-3 py-2 text-left transition-colors hover:border-border-default hover:bg-bg-hover"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-bg-card text-accent-blue border border-border-muted">
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary">{artifact.name}</div>
        {meta && <div className="mt-0.5 truncate text-[11px] text-text-tertiary">{meta}</div>}
      </div>
      <button
        type="button"
        onClick={handlePreview}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-muted text-text-tertiary hover:text-accent-blue hover:bg-bg-hover disabled:opacity-40"
        disabled={!artifact.path}
        title={artifact.path ? t('artifact.action.previewInCanvas') : t('artifact.error.noPath')}
      >
        <Eye size={14} />
      </button>
      <button
        type="button"
        onClick={() => { void handleDownload(); }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-muted text-text-tertiary hover:text-accent-blue hover:bg-bg-hover"
        title={t('artifact.action.download')}
      >
        <Download size={14} />
      </button>
    </div>
  );
}

function formatElapsedShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function summarizeMetaTool(tool: string, input: unknown, result: unknown): string | null {
  const args = parseMaybeJsonObject(input);
  const output = parseMaybeJsonObject(result);
  if (tool === 'create_task') {
    const subject = typeof args?.subject === 'string' ? args.subject : '未命名任务';
    return `已创建任务：${subject}`;
  }
  if (tool === 'dispatch_agent') {
    const agentName = typeof args?.agent_name === 'string' ? args.agent_name : 'agent';
    const taskId = typeof args?.task_id === 'string' ? args.task_id : '任务';
    return `已派发 ${agentName} 执行 ${taskId}`;
  }
  if (tool === 'team_manage') {
    const action = typeof args?.action === 'string' ? args.action : 'status';
    const teamName = typeof args?.team_name === 'string'
      ? args.team_name
      : typeof output?.team === 'string' ? output.team : '当前团队';
    if (action === 'create') {
      const members = Array.isArray(args?.members)
        ? args.members.length
        : typeof output?.memberCount === 'number' ? output.memberCount : 0;
      return `已创建团队 ${teamName}，成员 ${members} 个`;
    }
    if (action === 'delete') return `已清理团队 ${teamName}`;
    if (action === 'edit') return `已更新团队名册：${teamName}`;
    if (action === 'list_members') {
      const members = typeof output?.memberCount === 'number' ? output.memberCount : undefined;
      return members !== undefined ? `团队 ${teamName}：${members} 个成员` : `已查看团队成员：${teamName}`;
    }
    if (action === 'task_board') return `已查看团队任务板：${teamName}`;
    const members = typeof output?.memberCount === 'number' ? output.memberCount : undefined;
    return members !== undefined
      ? `团队 ${teamName}：${members} 个成员`
      : `已查看团队状态：${teamName}`;
  }
  if (tool === 'team_message') {
    const target = typeof args?.target === 'string' ? args.target : '团队成员';
    return `已发送团队消息：${target}`;
  }
  if (tool === 'team_inbox') {
    return '已读取团队收件箱';
  }
  return null;
}

function stringifyCompact(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pickStringField(value: unknown, keys: string[]): string | null {
  const parsed = parseMaybeJsonObject(value);
  if (!parsed) return null;
  for (const key of keys) {
    const raw = parsed[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

function basename(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return normalized || value;
}

function countArrayFields(value: unknown, keys: string[]): number {
  const parsed = parseMaybeJsonObject(value);
  if (!parsed) return 0;
  for (const key of keys) {
    const raw = parsed[key];
    if (Array.isArray(raw)) return raw.length;
  }
  return 0;
}

function countFileRefs(...values: unknown[]): number {
  const joined = values.map(stringifyCompact).join('\n');
  const matches = joined.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|css|json|md|py|go|rs|java|html|yml|yaml|toml|sql|sh|mjs|cjs)/g);
  return matches ? new Set(matches).size : 0;
}

function statusVerb(status: ToolCall['status'], verb: string): string {
  const normalized = normalizeToolCallStatus(status);
  if (status === 'streaming_input') return `正在准备${verb}`;
  if (normalized === 'pending' || normalized === 'running') return `正在${verb}`;
  if (normalized === 'failed') return `${verb}失败`;
  return `已${verb}`;
}

function iconForToolKind(kind: ToolUiKind, size: number): ReactNode {
  switch (kind) {
    case 'search':
      return <Search size={size} />;
    case 'shell':
      return <Terminal size={size} />;
    case 'orchestration':
      return <Network size={size} />;
    case 'file_create':
      return <FilePlus2 size={size} />;
    case 'file_edit':
      return <PencilLine size={size} />;
    case 'read':
      return <Files size={size} />;
    default:
      return <Wrench size={size} />;
  }
}

function toolEventIcon(tc: ToolCall): ReactNode {
  const normalized = normalizeToolCallStatus(tc.status);
  if (isToolCallOpenStatus(tc.status)) {
    return <Loader2 size={13} className="animate-spin" />;
  }
  if (normalized === 'failed') return <XCircle size={13} className="text-accent-red" />;
  return iconForToolKind(classifyTool(tc.tool, { input: tc.input, result: tc.result }).kind, 13);
}

function describeToolEvent(tc: ToolCall): { title: string; detail: string; meta: string } {
  const classification = classifyTool(tc.tool, { input: tc.input, result: tc.result });
  const fileName = basename(pickStringField(tc.input, ['path', 'file', 'filePath', 'targetPath', 'filename']));
  const command = pickStringField(tc.input, ['command', 'cmd']);
  const query = pickStringField(tc.input, ['query', 'pattern', 'search']);
  const elapsedFrom = tc.status === 'streaming_input' ? tc.firstDeltaAt : tc.startedAt;
  const elapsedTo = isToolCallOpenStatus(tc.status) ? Date.now() : tc.endedAt;
  const elapsedMs = elapsedFrom && elapsedTo ? Math.max(0, elapsedTo - elapsedFrom) : null;
  const elapsed = elapsedMs !== null ? formatElapsedShort(elapsedMs) : '';

  switch (classification.kind) {
    case 'orchestration':
      return {
        title: statusVerb(tc.status, '编排'),
        detail: summarizeMetaTool(tc.tool, tc.input, tc.result) || tc.tool,
        meta: elapsed,
      };
    case 'shell':
      return {
        title: statusVerb(tc.status, '运行'),
        detail: command ? command.replace(/\s+/g, ' ').slice(0, 96) : '1 条命令',
        meta: elapsed,
      };
    case 'search': {
      const files = countArrayFields(tc.result, ['files', 'matches', 'results']) || countFileRefs(tc.input, tc.result);
      const searches = query ? '1 次搜索' : '';
      return {
        title: statusVerb(tc.status, '探索'),
        detail: [files > 0 ? `${files} 个文件` : '', searches].filter(Boolean).join(' · ') || query || tc.tool,
        meta: elapsed,
      };
    }
    case 'read': {
      const files = countArrayFields(tc.result, ['files', 'entries', 'items']) || countFileRefs(tc.input, tc.result);
      return {
        title: statusVerb(tc.status, '探索'),
        detail: files > 0 ? `${files} 个文件` : (fileName || tc.tool),
        meta: elapsed,
      };
    }
    case 'file_create':
      return {
        title: statusVerb(tc.status, '创建'),
        detail: [fileName || tc.tool, formatFileChangeSummary(tc.input, tc.result, 'create')].filter(Boolean).join(' '),
        meta: elapsed,
      };
    case 'file_edit':
      return {
        title: statusVerb(tc.status, '编辑'),
        detail: [fileName || `${countFileRefs(tc.input, tc.result) || 1} 个文件`, formatFileChangeSummary(tc.input, tc.result, 'edit')].filter(Boolean).join(' '),
        meta: elapsed,
      };
    default:
      break;
  }

  return {
    title: statusVerb(tc.status, '调用'),
    detail: tc.tool,
    meta: elapsed,
  };
}

function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(() => {
    // streaming_input / running 阶段默认展开，让用户实时看到参数生成和执行输出
    if (isToolCallOpenStatus(tc.status)) return true;
    return _hookOutputCollapsed === false;
  });
  const { t } = useTranslation();
  const outputRef = useRef<HTMLPreElement>(null);

  // Fetch collapse preference on mount
  useEffect(() => {
    fetchHookOutputSetting().then((collapsed) => {
      if (!collapsed) setExpanded(true);
    });
  }, []);

  // streaming_input / running 切入时自动展开
  useEffect(() => {
    if (isToolCallOpenStatus(tc.status)) setExpanded(true);
  }, [tc.status]);

  // 流式输出自动滚到底部
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [tc.streamingOutput]);

  const isStreaming = tc.status === 'streaming_input';
  const normalizedStatus = normalizeToolCallStatus(tc.status);
  const isRunning = isToolCallOpenStatus(tc.status);
  const isDone = normalizedStatus === 'completed';
  const isFailed = normalizedStatus === 'failed';
  const resultValue = realToolResult(tc.result);
  const hasResult = resultValue !== undefined;
  const displayStatus = toolDisplayStatus(tc, hasResult);
  const downloadArtifact = parseDownloadArtifact(resultValue);

  // Truncate input for display
  const inputStr = tc.input
    ? (typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2))
    : '';
  const inputPreview = inputStr.length > 120 ? inputStr.slice(0, 120) + '...' : inputStr;

  // Truncate result for display — 终态优先显示 result，fallback 到 streamingOutput
  const effectiveResult = hasResult ? resultValue : (isDone || isFailed ? tc.streamingOutput : undefined);
  const resultParts = parseToolResultParts(effectiveResult);
  const resultStr = effectiveResult
    ? (resultParts ? toolResultPartsToText(resultParts) : typeof effectiveResult === 'string' ? effectiveResult : structuredToolResultText(effectiveResult) ?? JSON.stringify(effectiveResult, null, 2))
    : '';
  const metaSummary = summarizeMetaTool(tc.tool, tc.input, tc.result);
  const event = describeToolEvent(tc);

  // 计时器：running / streaming_input 期间每秒重渲染，让用户看到耗时在涨。
  // 终态后不再 tick，定格在最终耗时。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const kind = classifyTool(tc.tool, { input: tc.input, result: tc.result }).kind;

  return (
    <div data-kind={kind} className={`tool-event-card text-xs ${
      isRunning ? 'is-running' :
      isFailed ? 'is-failed' :
      'is-completed'
    } ${expanded ? 'is-expanded' : ''}`}>
      {/* Header */}
      <button
        className="tool-event-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="tool-event-icon">{toolEventIcon(tc)}</span>
        <span className="tool-event-title">
          <strong>{event.title}</strong>{event.detail ? ` ${event.detail}` : ''}
        </span>
        {isStreaming && tc.inputCharCount !== undefined && tc.inputCharCount > 0 && (
          <span className="tool-status-chip shrink-0 font-mono text-accent-yellow tabular-nums">
            {tc.inputCharCount} chars
          </span>
        )}
        {isRunning && <span className="codex-live-dot" />}
        {event.meta && <span className="tool-status-chip shrink-0 font-mono tabular-nums">{event.meta}</span>}
        {expanded ? <ChevronDown size={12} className="text-text-tertiary shrink-0" /> : <ChevronRight size={12} className="text-text-tertiary shrink-0" />}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="tool-detail-block space-y-2">
          {downloadArtifact && (
            <DownloadArtifactCard artifact={downloadArtifact} />
          )}
          {inputStr && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-tertiary">{t('tool.input')}</span>
                <PreCopyButton text={inputStr} />
              </div>
              {isStreaming ? (
                <pre className="tool-code-block text-[11px]">{inputStr}</pre>
              ) : (
                <ToolOutputView text={inputStr} language={inferInputLanguage(tc.tool, kind, tc.input)} />
              )}
            </div>
          )}
          {/* 执行期间流式输出（Shell stdout/stderr） */}
          {tc.streamingOutput && !isDone && !isFailed && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-tertiary">Output</span>
                <PreCopyButton text={tc.streamingOutput} />
              </div>
              <pre ref={outputRef} className="tool-code-block text-[11px]">{tc.streamingOutput}</pre>
            </div>
          )}
          {/* 非 Shell 工具心跳进度 */}
          {!tc.streamingOutput && tc.progressMessage && isRunning && !isStreaming && (
            <div className="text-[10px] text-text-tertiary italic">{tc.progressMessage}</div>
          )}
          {displayStatus && (
            <div className="text-[10px] text-text-tertiary italic">{displayStatus}</div>
          )}
          {resultParts && !downloadArtifact && (
            <div className="animate-[fadeIn_0.3s_ease-in]">
              <div className="text-[10px] text-text-tertiary mb-1">{t('tool.output')}</div>
              <ToolResultPartView parts={resultParts} />
            </div>
          )}
          {resultStr && !downloadArtifact && !resultParts && (
            <div className="animate-[fadeIn_0.3s_ease-in]">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-tertiary">{t('tool.output')}</span>
                <PreCopyButton text={resultStr} />
              </div>
              <ToolOutputView
                text={resultStr}
                language={inferOutputLanguage(tc.tool, kind, tc.input, resultStr)}
                failed={isFailed}
              />
            </div>
          )}
        </div>
      )}

      {/* Quick preview when collapsed */}
      {!expanded && (displayStatus || metaSummary || inputPreview) && (
        <div className={`px-3 pb-2 text-[11px] truncate ${metaSummary ? 'text-text-secondary' : 'text-text-tertiary'}`}>
          {displayStatus || metaSummary || inputPreview}
        </div>
      )}
      {!expanded && downloadArtifact && (
        <div className="px-3 pb-2">
          <DownloadArtifactCard artifact={downloadArtifact} />
        </div>
      )}
    </div>
  );
}

/** Inline badge showing agent activity on an assistant message */
function AgentActivityBadge({ activity, onClick }: { activity: AgentActivity; onClick?: () => void }) {
  const normalizedStatus = normalizeAgentStatus(activity.status);
  const isRunning = normalizedStatus === 'running';
  const isCompleted = normalizedStatus === 'completed';
  const isFailed = normalizedStatus === 'failed';
  const isInterrupted = normalizedStatus === 'interrupted';

  return (
    <button
      onClick={onClick}
      className={`agent-activity-chip ${
        isRunning ? 'is-running' :
        isCompleted ? 'is-completed' :
        isInterrupted ? 'is-interrupted' :
        'is-failed'
      }`}
    >
      {isRunning ? <Loader2 size={10} className="animate-spin" /> :
       isCompleted ? <CheckCircle2 size={10} /> :
       <XCircle size={10} />}
      <span className="truncate max-w-[100px]">{activity.agentName}</span>
      {isRunning && <span className="w-1 h-1 rounded-full bg-accent-brand animate-pulse" />}
    </button>
  );
}

/** 语言图标映射 */
const langIcons: Record<string, string> = {
  javascript: 'JS', typescript: 'TS', python: 'PY', bash: '$_', sh: '$_',
  rust: 'RS', go: 'GO', java: 'JV', cpp: 'C+', c: 'C', html: '<>', css: '#',
  json: '{}', yaml: 'YM', markdown: 'MD', sql: 'DB', dockerfile: 'DK',
  jsx: 'JX', tsx: 'TX', ruby: 'RB', php: 'PH', swift: 'SW', kotlin: 'KT',
};

/** 代码块组件 — 凌霄主题集成 + 复制反馈 */
// memo (2026-05-29)：流式期间直播 MessageBubble 每帧 re-render，已完成的代码块
// props（code/lang/isDark）不变就跳过重渲染，避免对历史代码块反复高亮。
const CodeBlock = memo(function CodeBlock({ code, lang, isDark }: { code: string; lang: string; isDark: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [code]);

  const icon = langIcons[lang.toLowerCase()] || lang.slice(0, 2).toUpperCase();

  return (
    <div className="my-3 max-w-full min-w-0 rounded-lg overflow-hidden border border-border-muted group/code"
         style={{ boxShadow: isDark ? '0 10px 24px rgba(0,0,0,0.18)' : '0 1px 2px rgba(15,23,42,0.04)' }}>
      {/* 头部栏 */}
      <div className="flex items-center justify-between px-3 py-1.5"
           style={{ background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border-muted)' }}>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold"
                style={{ background: 'var(--color-bg-card)', color: 'var(--color-accent-blue)', border: '1px solid var(--color-border-muted)' }}>
            {icon}
          </span>
          <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">{lang}</span>
        </div>
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono transition-all duration-200"
          style={{
            background: copied
              ? 'var(--color-success-bg)'
              : 'transparent',
            color: copied ? 'var(--color-accent-green)' : 'var(--color-text-tertiary)',
          }}
          onClick={handleCopy}
          onMouseEnter={(e) => { if (!copied) e.currentTarget.style.background = 'var(--color-bg-hover)'; }}
          onMouseLeave={(e) => { if (!copied) e.currentTarget.style.background = 'transparent'; }}
        >
          {copied ? (
            <>
              <CheckCircle2 size={11} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy size={11} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* 代码区 */}
      <SyntaxHighlighter
        style={isDark ? oneDark : oneLight}
        language={lang}
        PreTag="div"
        showLineNumbers={code.split('\n').length > 3}
        lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', opacity: 0.3, fontSize: '11px', userSelect: 'none' }}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '12px',
          lineHeight: '1.6',
          padding: '12px 16px',
          maxWidth: '100%',
          overflowX: 'auto',
          background: 'var(--color-bg-code)',
          color: isDark ? '#c9d1d9' : '#24292e',
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

const langMap: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', sh: 'bash', shell: 'bash', zsh: 'bash',
  yml: 'yaml', md: 'markdown', dockerfile: 'dockerfile',
};

function MessageBubble({ message, onAgentClick, onEdit, onRetry }: Props) {
  const resolved = useThemeStore((s) => s.resolved);
  const { t } = useTranslation();
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const markQuestionAnswered = useSessionStore((s) => s.markQuestionAnswered);
  const addMessage = useSessionStore((s) => s.addMessage);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const setMainView = useViewStore((s) => s.setMainView);
  const isUser = message.role === 'user';
  const isError = !isUser && message.error === true;
  const normalizedThinking = (message.thinkingContent || '').trim();
  const normalizedContent = (message.content || '').trim();
  const hasThinking = !!normalizedThinking && normalizedThinking !== normalizedContent;
  const contentBlocks = message.contentBlocks || [];
  const hasOrderedThinkingBlocks = contentBlocks.some((block) => block.type === 'thinking');
  const showTopThinking = hasThinking && !hasOrderedThinkingBlocks;
  const hasAgentActivity = message.agentActivity && message.agentActivity.length > 0;
  // useMemo (2026-05-29)：markdownComponents 仅依赖主题 resolved。此前每次 render 都新建
  // 整个对象，让 memo 化的 SafeMarkdown 仍然认为 props 变了而重解析。固定引用后，流式
  // 期间只要 resolved 不变就复用，配合 rAF 批处理把重解析降到每帧一次。
  const markdownComponents: SafeMarkdownComponents = useMemo(() => ({
    h1: ({ children }) => <h1 className="text-lg font-bold text-text-primary mt-4 mb-2 pb-1 border-b border-border-muted">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-bold text-text-primary mt-3 mb-1.5">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-bold text-text-primary mt-2 mb-1">{children}</h3>,
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="text-text-secondary">{children}</li>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-accent-blue/40 pl-3 my-2 text-text-tertiary italic">{children}</blockquote>,
    strong: ({ children }) => <strong className="text-text-primary font-semibold">{children}</strong>,
    em: ({ children }) => <em className="text-accent-blue">{children}</em>,
    a: ({ href, children }) => {
      const localFile = parseLocalFileHref(href);
      if (localFile) {
        return (
          <button
            type="button"
            className="inline-flex max-w-full items-baseline gap-1 rounded px-1 py-0.5 text-left font-mono text-[0.92em] text-accent-blue underline underline-offset-2 hover:bg-accent-blue/10 hover:text-accent-blue"
            title={localFile.line ? `${localFile.path}:${localFile.line}` : localFile.path}
            onClick={() => {
              openArtifact({
                name: localFile.line ? `${localFile.name}:${localFile.line}` : localFile.name,
                path: localFile.path,
                line: localFile.line,
                column: localFile.column,
              });
              if (window.innerWidth < 1280) setMainView('artifact');
            }}
          >
            <FileText size={12} className="shrink-0 translate-y-[1px]" />
            <span className="truncate">{children}</span>
          </button>
        );
      }
      return <a href={href} className="text-accent-blue hover:text-accent-blue underline underline-offset-2" target="_blank" rel="noreferrer">{children}</a>;
    },
    hr: () => <hr className="border-border-muted my-3" />,
    table: ({ children }) => <div className="overflow-x-auto my-2"><table className="w-full text-xs border-collapse">{children}</table></div>,
    thead: ({ children }) => <thead className="bg-bg-hover">{children}</thead>,
    th: ({ children }) => <th className="px-3 py-1.5 text-left text-accent-blue font-mono border border-border-muted">{children}</th>,
    td: ({ children }) => <td className="px-3 py-1.5 border border-border-muted text-text-secondary">{children}</td>,
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '');
      const code = String(children).replace(/\n$/, '');
      const lang = match ? (langMap[match[1]] || match[1]) : null;
      const isDark = resolved === 'dark';
      if (lang) return <CodeBlock code={code} lang={lang} isDark={isDark} />;
      return <code className="px-1.5 py-0.5 bg-bg-hover text-accent-pink text-[12px] font-mono rounded-md" {...props}>{children}</code>;
    },
  }), [openArtifact, resolved, setMainView]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }, [message.content]);

  const handleEdit = useCallback(() => {
    onEdit?.(message.id, message.content);
  }, [onEdit, message.id, message.content]);

  const handleRetry = useCallback(() => {
    onRetry?.(message.id);
  }, [onRetry, message.id]);

  const showCopy = !isUser && message.content && !message.isStreaming;
  const showEdit = isUser && message.content && !message.isStreaming;
  const showRetry = !isUser && !message.isStreaming && !!message.content && message.role === 'assistant';
  const renderThinkingBlock = (text: string, key?: string) => text ? (
    <div key={key} className="mb-2.5">
      <button
        onClick={() => setShowThinking(!showThinking)}
        className="flex items-center gap-1.5 text-[11px] font-mono text-accent-brand/70 hover:text-accent-brand transition-colors group"
      >
        <Brain size={12} />
        <span>{t('message.thinking')}</span>
        <span className="text-[9px] text-text-tertiary">
          {text.length} chars
        </span>
        {showThinking
          ? <ChevronDown size={12} className="ml-0.5 text-text-tertiary" />
          : <ChevronRight size={12} className="ml-0.5 text-text-tertiary" />
        }
      </button>
      {showThinking && (
        <div className="message-thought mt-2 px-3 py-2.5 rounded-lg text-xs text-text-tertiary leading-5 max-h-64 overflow-y-auto font-mono break-all overflow-x-hidden">
          <SafeMarkdown>
            {text}
          </SafeMarkdown>
        </div>
      )}
    </div>
  ) : null;

  // If this message is purely an ask_user_question card, render it standalone
  if (message.askUserQuestion && !message.content) {
    const q = message.askUserQuestion;
    return (
      <div className="mb-3 ml-11">
        <AskUserQuestionCard
          question={q.question}
          options={q.options}
          multiSelect={q.multiSelect}
          questions={q.questions}
          answered={q.answered}
          answeredValue={q.answeredValue}
          onSubmit={async (answer, structured) => {
            markQuestionAnswered(message.id, answer);
            addMessage({ id: String(Date.now()), role: 'user', content: answer, timestamp: Date.now() });
            addMessage({ id: String(Date.now() + 1), role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true });
            try {
              await acpClient.sendJsonRpc('session/prompt', { prompt: answer, askUserAnswer: structured });
            } catch (e) { console.error('Failed to send answer:', e); }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`animate-message-in flex min-w-0 max-w-full gap-3 mb-8 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-bg-secondary flex items-center justify-center border border-border-muted">
          <Bot size={15} className="text-accent-blue" />
        </div>
      )}

      {/* Content */}
      <div className={`group/msg relative min-w-0 overflow-visible ${isUser ? 'user-message-card max-w-[min(76%,720px)]' : isError ? 'max-w-[88%] rounded-lg border border-accent-red/35 bg-accent-red/5 px-3 py-2.5' : 'assistant-message-card max-w-[88%]'}`}>
        {/* Action bar — shown on hover */}
        {(showCopy || showEdit || showRetry) && (
          <div className="absolute -top-3 right-0 flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity bg-bg-secondary border border-border-muted rounded-md shadow-sm px-0.5 py-0.5 z-10">
            {showCopy && (
              <button
                onClick={handleCopy}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                title={copied ? t('message.copied') : t('message.copy')}
              >
                {copied ? <CheckCircle2 size={12} className="text-accent-green" /> : <Copy size={12} />}
              </button>
            )}
            {showEdit && (
              <button
                onClick={handleEdit}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
                title={t('message.edit')}
              >
                <Pencil size={12} />
              </button>
            )}
            {showRetry && (
              <button
                onClick={handleRetry}
                className="p-1 text-text-tertiary hover:text-accent-yellow hover:bg-bg-hover rounded transition-colors"
                title={t('message.retry')}
              >
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        )}
        {/* Thinking block */}
        {showTopThinking && renderThinkingBlock(message.thinkingContent!)}

        {/* Message body — interleaved content blocks */}
        <div className={`min-w-0 max-w-full overflow-hidden text-sm leading-7 ${isUser ? 'text-text-primary' : 'text-text-secondary'}`}>
          {isUser ? (
            <p className="whitespace-pre-wrap break-words overflow-x-hidden [overflow-wrap:anywhere]">{message.content}</p>
          ) : isError ? (
            <div className="flex min-w-0 gap-2 text-accent-red">
              <AlertTriangle size={15} className="mt-1 shrink-0" />
              <div className="min-w-0">
                <div className="mb-1 text-xs font-mono uppercase tracking-wide text-accent-red/80">
                  {message.errorKind || t('message.error', 'Error')}
                </div>
                <p className="whitespace-pre-wrap break-words overflow-x-hidden [overflow-wrap:anywhere] text-text-primary">{message.content}</p>
              </div>
            </div>
          ) : (
            <>
              {contentBlocks.map((block, idx) => {
                if (block.type === 'text') {
                  return block.text ? (
                    <div key={`text-${idx}`} className="markdown-body min-w-0 max-w-full overflow-hidden">
                      <SafeMarkdown components={markdownComponents}>{block.text}</SafeMarkdown>
                    </div>
                  ) : null;
                }
                if (block.type === 'thinking') {
                  return renderThinkingBlock(block.text, `thinking-${idx}`);
                }
                // block.type === 'tool_call'
                const tc = message.toolCalls?.find(t => t.id === block.toolCallId);
                return tc ? (
                  <div key={`tc-${block.toolCallId}`} className="my-1.5">
                    <ToolCallCard tc={tc} />
                  </div>
                ) : null;
              })}
            </>
          )}

          {message.retrying && !isUser && !isError && (
            <span className="inline-flex items-center gap-1.5 text-xs text-accent-yellow font-mono">
              <RefreshCw size={12} className="animate-spin" />
              {t('phase.retrying')}
            </span>
          )}

          {/* Streaming indicator */}
          {message.isStreaming && !isError && (
            <span className="message-typing-caret ml-0.5" />
          )}
        </div>

        {/* Agent activity badges — inline on assistant messages */}
        {hasAgentActivity && !isUser && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Cpu size={11} className="text-text-tertiary shrink-0" />
            {message.agentActivity!.map((a) => (
              <AgentActivityBadge key={a.agentId} activity={a} onClick={onAgentClick} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(MessageBubble);
