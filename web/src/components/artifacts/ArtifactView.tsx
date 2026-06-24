import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import SafeMarkdown from '../ui/SafeMarkdown';
import {
  AlertTriangle, Archive, Columns2, Copy, Download, Edit3, Eye, FileText,
  Image as ImageIcon, Loader2, RefreshCw, Save, Table, XCircle,
} from 'lucide-react';
import { apiHeaders, getServerToken } from '../../api/headers';
import { useSessionStore } from '../../stores/sessionStore';
import { useArtifactStore, type ArtifactTarget } from '../../stores/artifactStore';
import { useTranslation } from 'react-i18next';

// Monaco 按需加载，避免影响初始 bundle 体积
const MonacoEditor = lazy(() => import('@monaco-editor/react').then(m => ({ default: m.default })));

// ======================== 类型定义 ========================

type JsonRecord = Record<string, unknown>;
type ArtifactPreviewStatus = 'ok' | 'partial' | 'parse_error';
type ArtifactTrustLevel = 'raw' | 'rich_text' | 'structure' | 'table' | 'text' | 'untrusted';
type ArtifactRenderer = 'text' | 'html' | 'pptx-structure' | 'xlsx-table' | 'raw';
type ArtifactEditableKind = 'text' | 'markdown' | 'html' | 'office-native' | 'read-only';

interface ArtifactPreview {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  format: string;
  status?: ArtifactPreviewStatus;
  trustLevel?: ArtifactTrustLevel;
  warnings?: string[];
  content: string;
  metadata?: {
    pages?: number;
    hasTextLayer?: boolean;
    imageOnly?: boolean;
    sheets?: string[];
    entries?: string[];
    slides?: Array<{
      index: number;
      title?: string;
      text: string;
      bullets: string[];
      notes?: string;
    }>;
    renderer?: ArtifactRenderer;
    editableKind?: ArtifactEditableKind;
    warnings?: string[];
    plainText?: string;
    wordCount?: number;
    totalChars?: number;
  };
  truncated: boolean;
  editable: boolean;
  rawPreviewable: boolean;
}

type MarkdownViewMode = 'preview' | 'edit' | 'split';

// ======================== 工具函数 ========================

const MIME_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
};

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const RASTER_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const TABLE_FORMATS = new Set(['csv', 'xlsx', 'xls']);
const ARCHIVE_FORMATS = new Set(['zip', 'tar', 'gzip']);
const VIDEO_FORMATS = new Set(['video', 'mp4', 'webm', 'mov']);
const AUDIO_FORMATS = new Set(['audio', 'mp3', 'wav']);
const RAW_PREVIEWABLE_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'audio', 'video', 'mp4', 'webm', 'mov']);
const PREVIEW_TOGGLE_HIDDEN_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'video', 'audio']);
const SPREADSHEET_FORMATS = new Set(['xlsx', 'xls']);
const PREVIEW_STATUS_VALUES = new Set<ArtifactPreviewStatus>(['ok', 'partial', 'parse_error']);
const TRUST_LEVEL_VALUES = new Set<ArtifactTrustLevel>(['raw', 'rich_text', 'structure', 'table', 'text', 'untrusted']);
const RENDERER_VALUES = new Set<ArtifactRenderer>(['text', 'html', 'pptx-structure', 'xlsx-table', 'raw']);
const EDITABLE_KIND_VALUES = new Set<ArtifactEditableKind>(['text', 'markdown', 'html', 'office-native', 'read-only']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined;
}

function formatFileSize(size?: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function normalizeFormat(value?: string): string {
  const raw = (value || '').toLowerCase();
  const compact = raw.replace(/^\./, '').split(';')[0].trim();
  if (MIME_FORMATS[compact]) return MIME_FORMATS[compact];
  const slashIndex = compact.indexOf('/');
  if (slashIndex >= 0) {
    const subtype = compact.slice(slashIndex + 1) || compact;
    return subtype.replace(/^x-/, '');
  }
  return compact;
}

function iconFor(format?: string) {
  const normalized = normalizeFormat(format);
  if (IMAGE_FORMATS.has(normalized)) return <ImageIcon size={18} />;
  if (TABLE_FORMATS.has(normalized)) return <Table size={18} />;
  if (ARCHIVE_FORMATS.has(normalized)) return <Archive size={18} />;
  return <FileText size={18} />;
}

function isImage(format: string): boolean {
  return RASTER_IMAGE_FORMATS.has(normalizeFormat(format));
}
function isVideo(format: string): boolean {
  return VIDEO_FORMATS.has(normalizeFormat(format));
}
function isAudio(format: string): boolean {
  return AUDIO_FORMATS.has(normalizeFormat(format));
}
function isRawPreviewableFormat(format: string): boolean {
  return RAW_PREVIEWABLE_FORMATS.has(normalizeFormat(format));
}
function hidesPreviewModeToggle(format?: string): boolean {
  return PREVIEW_TOGGLE_HIDDEN_FORMATS.has(normalizeFormat(format));
}
function isMarkdown(name: string, format?: string): boolean {
  const normalized = normalizeFormat(format);
  return normalized === 'markdown' || /\.(md|markdown)$/i.test(name);
}

/** 根据文件扩展名推断 Monaco language id */
function monacoLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
    json: 'json', jsonl: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', md: 'markdown', markdown: 'markdown',
    dockerfile: 'dockerfile', makefile: 'makefile',
    env: 'ini', gitignore: 'ini', txt: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

/**
 * 正确解析 CSV 行（处理带逗号的引号单元格）
 */
function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let cell = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { cell += line[i++]; }
      }
      cells.push(cell);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { cells.push(line.slice(i)); break; }
      cells.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return cells;
}

function parseCsvTable(csv: string, maxRows = 500): { headers: string[]; rows: string[][]; total: number; truncated: boolean } {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  const total = lines.length;
  const slice = lines.slice(0, maxRows + 1);
  const parsed = slice.map(parseCsvRow);
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);
  return { headers, rows, total, truncated: total > maxRows };
}

function warningText(warning: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  const known: Record<string, string> = {
    'preview-truncated': t('artifact.preview.warning.truncated'),
    'pptx-structure-preview-not-layout-faithful': t('artifact.preview.warning.pptxStructure'),
    'table-preview-omits-formulas-styles': t('artifact.preview.warning.tableStructure'),
    'office-binary-readonly': t('artifact.preview.warning.officeBinary'),
  };
  if (known[warning]) return known[warning];
  if (warning.startsWith('xlsx-sheet-not-found:')) {
    return t('artifact.preview.warning.sheetMissing', { name: warning.slice('xlsx-sheet-not-found:'.length) });
  }
  return warning;
}

function parsePreviewSlide(value: unknown): NonNullable<NonNullable<ArtifactPreview['metadata']>['slides']>[number] | null {
  if (!isRecord(value)) return null;
  return {
    index: readNumber(value.index),
    title: readOptionalString(value.title),
    text: readString(value.text),
    bullets: readStringArray(value.bullets),
    notes: readOptionalString(value.notes),
  };
}

function parsePreviewMetadata(value: unknown): ArtifactPreview['metadata'] | undefined {
  if (!isRecord(value)) return undefined;
  const slides = Array.isArray(value.slides)
    ? value.slides.flatMap((item) => {
      const parsed = parsePreviewSlide(item);
      return parsed ? [parsed] : [];
    })
    : undefined;
  return {
    pages: readOptionalNumber(value.pages),
    hasTextLayer: readOptionalBoolean(value.hasTextLayer),
    imageOnly: readOptionalBoolean(value.imageOnly),
    sheets: readStringArray(value.sheets),
    entries: readStringArray(value.entries),
    slides,
    renderer: parseOneOf(value.renderer, RENDERER_VALUES),
    editableKind: parseOneOf(value.editableKind, EDITABLE_KIND_VALUES),
    warnings: readStringArray(value.warnings),
    plainText: readOptionalString(value.plainText),
    wordCount: readOptionalNumber(value.wordCount),
    totalChars: readOptionalNumber(value.totalChars),
  };
}

function parseArtifactPreview(value: unknown): ArtifactPreview {
  const record = isRecord(value) ? value : {};
  const mimeType = readString(record.mimeType);
  const format = normalizeFormat(readString(record.format, mimeType));
  const path = readString(record.path);
  return {
    path,
    name: readString(record.name, path),
    size: readNumber(record.size),
    mimeType,
    format,
    status: parseOneOf(record.status, PREVIEW_STATUS_VALUES),
    trustLevel: parseOneOf(record.trustLevel, TRUST_LEVEL_VALUES),
    warnings: readStringArray(record.warnings),
    content: readString(record.content),
    metadata: parsePreviewMetadata(record.metadata),
    truncated: readBoolean(record.truncated),
    editable: readBoolean(record.editable),
    rawPreviewable: readBoolean(record.rawPreviewable, isRawPreviewableFormat(format)),
  };
}

function artifactErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const error = readOptionalString(value.error);
  if (error) return error;
  return readStringArray(value.warnings)[0] ?? null;
}

function PreviewWarningStrip({ preview, extra }: { preview: ArtifactPreview | null; extra?: string | null }) {
  const { t } = useTranslation();
  const warnings = [
    ...(preview?.status === 'parse_error' ? [t('artifact.preview.parseError')] : []),
    ...(preview?.status === 'partial' ? [t('artifact.preview.partial')] : []),
    ...(preview?.warnings ?? []).map((warning) => warningText(warning, t)),
    ...(extra ? [extra] : []),
  ].filter(Boolean);
  const uniqueWarnings = Array.from(new Set(warnings));
  if (uniqueWarnings.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-accent-yellow/25 bg-accent-yellow/10 px-3 py-2 text-[11px] text-accent-yellow">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          {uniqueWarnings.slice(0, 4).map((warning, index) => (
            <div key={`${warning}-${index}`} className="break-words">{warning}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ======================== XLSX / CSV 表格渲染组件 ========================

interface XlsxPreviewProps {
  preview: ArtifactPreview;
  content: string;
  onSheetChange: (sheetName: string) => void;
  currentSheet: string | null;
  loadingSheet: boolean;
}

function XlsxPreview({ preview, content, onSheetChange, currentSheet, loadingSheet }: XlsxPreviewProps) {
  const { t } = useTranslation();
  const sheets = preview.metadata?.sheets ?? [];
  const { headers, rows, total, truncated } = useMemo(() => parseCsvTable(content), [content]);

  const activeSheet = currentSheet ?? sheets[0] ?? '';

  return (
    <div className="flex h-full flex-col min-h-0">
      {/* Sheet Tab 栏 */}
      {sheets.length > 0 && (
        <div className="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-border-muted bg-bg-secondary/50 px-3 py-1.5">
          {sheets.map((name) => (
            <button
              key={name}
              onClick={() => onSheetChange(name)}
              disabled={loadingSheet}
              className={`shrink-0 rounded px-2.5 py-1 text-[11px] font-mono transition-colors ${
                name === activeSheet
                  ? 'bg-accent-brand/15 text-accent-brand'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {name}
            </button>
          ))}
          {loadingSheet && <Loader2 size={12} className="animate-spin text-text-tertiary ml-2 shrink-0" />}
        </div>
      )}

      {/* 表格区 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {headers.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-text-tertiary">{t('artifact.table.empty')}</div>
        ) : (
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="bg-bg-secondary">
                {/* 行号列 */}
                <th className="w-10 border border-border-muted px-2 py-1.5 text-right text-[10px] font-mono text-text-tertiary select-none">#</th>
                {headers.map((h, ci) => (
                  <th
                    key={ci}
                    className="min-w-[80px] max-w-[260px] border border-border-muted px-2 py-1.5 text-left font-semibold text-text-primary whitespace-nowrap"
                  >
                    {h || String.fromCharCode(65 + ci)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-bg-hover/50">
                  <td className="border border-border-muted px-2 py-1 text-right text-[10px] font-mono text-text-tertiary select-none">{ri + 1}</td>
                  {headers.map((_, ci) => (
                    <td
                      key={ci}
                      className="max-w-[260px] truncate border border-border-muted px-2 py-1 text-text-secondary"
                      title={row[ci] ?? ''}
                    >
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部信息 */}
      <div className="shrink-0 border-t border-border-muted bg-bg-secondary/50 px-3 py-1 text-[10px] text-text-tertiary flex items-center gap-3">
        <span>{t('artifact.xlsx.rows', { count: rows.length })}</span>
        {truncated && <span className="text-accent-yellow">{t('artifact.xlsx.tooManyRows', { limit: 500 })}</span>}
        {sheets.length > 0 && <span className="ml-auto">{t('artifact.xlsx.sheet', { name: activeSheet })}</span>}
      </div>
    </div>
  );
}

// ======================== SVG 内联渲染组件 ========================

function SvgPreview({ content, name }: { content: string; name: string }) {
  const isSvg = useMemo(() => {
    const trimmed = content.trim();
    return trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
  }, [content]);

  if (!isSvg) {
    return <div className="flex h-full items-center justify-center p-4"><img src={content} alt={name} className="max-h-full max-w-full rounded" /></div>;
  }

  return (
    <div className="h-full overflow-auto p-4 flex items-center justify-center">
      <div
        className="max-w-full max-h-full [&_svg]:max-w-full [&_svg]:h-auto"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content, { USE_PROFILES: { svg: true, svgFilters: true } }) }}
      />
    </div>
  );
}

// ======================== Markdown 编辑/预览组件 ========================

function MarkdownEditor({
  content,
  onChange,
  viewMode,
}: {
  content: string;
  onChange: (v: string) => void;
  viewMode: MarkdownViewMode;
}) {
  const { t } = useTranslation();
  const editorNode = (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-text-tertiary"><Loader2 size={14} className="animate-spin mr-1" />{t('artifact.loading.editor')}</div>}>
      <MonacoEditor
        height="100%"
        language="markdown"
        value={content}
        onChange={(v) => onChange(v ?? '')}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 22,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'gutter',
          padding: { top: 12, bottom: 12 },
        }}
      />
    </Suspense>
  );

  const previewNode = (
    <div className="artifact-prose h-full overflow-auto px-6 py-4 text-sm text-text-secondary">
      <SafeMarkdown>{content}</SafeMarkdown>
    </div>
  );

  if (viewMode === 'edit') return editorNode;
  if (viewMode === 'preview') return previewNode;

  // split
  return (
    <div className="flex h-full min-w-0">
      <div className="w-1/2 min-w-0 border-r border-border-muted">{editorNode}</div>
      <div className="w-1/2 min-w-0">{previewNode}</div>
    </div>
  );
}

// ======================== 代码文件 Monaco 编辑器 ========================

function CodeEditor({ content, onChange, language }: { content: string; onChange: (v: string) => void; language: string }) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-text-tertiary"><Loader2 size={14} className="animate-spin mr-1" />{t('artifact.loading.editor')}</div>}>
      <MonacoEditor
        height="100%"
        language={language}
        value={content}
        onChange={(v) => onChange(v ?? '')}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          renderLineHighlight: 'gutter',
          padding: { top: 12, bottom: 12 },
        }}
      />
    </Suspense>
  );
}

// ======================== 图片渲染（含元数据） ========================

function ImagePreview({ rawUrl, preview }: { rawUrl: string; preview: ArtifactPreview }) {
  return (
    <div className="h-full overflow-auto p-4 flex flex-col items-center gap-3">
      <img src={rawUrl} alt={preview.name} className="max-w-full rounded border border-border-muted bg-bg-secondary object-contain" />
      <div className="flex items-center gap-3 text-[10px] text-text-tertiary font-mono">
        <span>{preview.format.toUpperCase()}</span>
        <span>{formatFileSize(preview.size)}</span>
      </div>
    </div>
  );
}

function DocxPreview({ html }: { html: string }) {
  const { t } = useTranslation();
  const sanitized = useMemo(() => DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_ATTR: ['style'],
  }), [html]);
  return (
    <div className="artifact-office-scroll">
      <div className="artifact-office-page">
        <div className="mb-4 inline-flex rounded border border-border-muted bg-bg-secondary px-2 py-1 text-[10px] text-text-tertiary">
          {t('artifact.docx.htmlRenderNotice')}
        </div>
        <div
          className="artifact-docx-prose"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: sanitized }}
        />
      </div>
    </div>
  );
}

function PptxStructurePreview({ preview, content }: { preview: ArtifactPreview; content: string }) {
  const { t } = useTranslation();
  const slides = preview.metadata?.slides ?? [];
  if (slides.length === 0) {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-6 text-text-secondary">
        {content || t('artifact.pptx.structureFallback')}
      </pre>
    );
  }

  return (
    <div className="pptx-preview-container h-full overflow-auto bg-bg-secondary/45">
      <div className="w-full max-w-5xl text-[11px] text-text-tertiary">
        {t('artifact.pptx.renderNotice')} · {t('artifact.pptx.slides', { count: preview.metadata?.pages ?? slides.length })}
      </div>
      {slides.map((slide) => (
        <section key={slide.index} className="artifact-slide">
          <div className="artifact-slide-rune">{String(slide.index).padStart(2, '0')}</div>
          <div className="artifact-slide-content">
            <h2>{slide.title || t('artifact.pptx.untitledSlide', { index: slide.index })}</h2>
            {slide.bullets.length > 0 ? (
              <ul>
                {slide.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}
              </ul>
            ) : (
              <p>{slide.text}</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

// ======================== 主组件 ========================

export default function ArtifactView() {
  const { t } = useTranslation();
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const activeArtifact = useArtifactStore((s) => s.activeArtifact);
  const recentArtifacts = useArtifactStore((s) => s.recentArtifacts);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const clearArtifact = useArtifactStore((s) => s.clearArtifact);

  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'preview' | 'full'>('preview');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const previewRequestSeq = useRef(0);
  const sheetRequestSeq = useRef(0);

  // XLSX 多 Sheet 状态
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  const [loadingSheet, setLoadingSheet] = useState(false);

  // Markdown 视图模式
  const [mdViewMode, setMdViewMode] = useState<MarkdownViewMode>('preview');

  const rawUrl = useMemo(() => {
    if (!preview?.path) return activeArtifact?.url || '';
    const params = new URLSearchParams({ path: preview.path, token: getServerToken() });
    if (sessionId) params.set('sessionId', sessionId);
    return `/api/v1/artifacts/raw?${params.toString()}`;
  }, [activeArtifact?.url, preview?.path, sessionId]);

  const downloadPreview = useCallback(async () => {
    if (!preview || !rawUrl) return;
    const res = await fetch(rawUrl, { headers: apiHeaders() });
    if (!res.ok) throw new Error(t('artifact.error.downloadFailed', { status: res.status }));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = preview.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }, [preview, rawUrl, t]);

  const loadPreview = useCallback(async (artifact: ArtifactTarget | null, nextMode = mode, sheet?: string) => {
    const requestId = ++previewRequestSeq.current;
    if (!artifact?.path) {
      if (artifact?.url) {
        const format = normalizeFormat(artifact.mimeType || artifact.name.split('.').pop());
        setPreview({
          path: '',
          name: artifact.name,
          size: artifact.size || 0,
          mimeType: artifact.mimeType || '',
          format,
          status: 'ok',
          trustLevel: 'raw',
          content: '',
          truncated: false,
          editable: false,
          rawPreviewable: isRawPreviewableFormat(format),
        });
        setContent('');
        setError(null);
      } else {
        setPreview(null);
        setContent('');
        setError(artifact ? t('artifact.error.noPath') : null);
      }
      return;
    }

    setLoading(true);
    setError(null);
    setSheetError(null);
    setSaveMessage(null);
    try {
      const params = new URLSearchParams({ path: artifact.path, mode: nextMode });
      if (sessionId) params.set('sessionId', sessionId);
      if (sheet) { params.set('mode', 'sheet'); params.set('sheet', sheet); }
      const res = await fetch(`/api/v1/artifacts/preview?${params.toString()}`, { headers: apiHeaders() });
      const json: unknown = await res.json().catch(() => ({}));
      if (requestId !== previewRequestSeq.current) return;
      if (!res.ok) throw new Error(artifactErrorMessage(json) || t('artifact.error.previewFailed'));
      const nextPreview = parseArtifactPreview(json);
      setPreview(nextPreview);
      setContent(nextPreview.content);
      // 初始化选中 Sheet
      if (!sheet && nextPreview.metadata?.sheets?.length) {
        setSelectedSheet(nextPreview.metadata.sheets[0]);
      }
    } catch (err) {
      if (requestId !== previewRequestSeq.current) return;
      setPreview(null);
      setContent('');
      setError(err instanceof Error ? err.message : t('artifact.error.previewFailed'));
    } finally {
      if (requestId === previewRequestSeq.current) setLoading(false);
    }
  }, [mode, sessionId, t]);

  useEffect(() => {
    setSelectedSheet(null);
    setMdViewMode('preview');
    void loadPreview(activeArtifact, mode);
  }, [activeArtifact?.path, activeArtifact?.url, activeArtifact?.name, activeArtifact?.mimeType, sessionId]);

  const handleSheetChange = async (sheetName: string) => {
    if (!activeArtifact?.path || sheetName === selectedSheet) return;
    const requestId = ++sheetRequestSeq.current;
    setLoadingSheet(true);
    setSheetError(null);
    try {
      const params = new URLSearchParams({
        path: activeArtifact.path,
        mode: 'sheet',
        sheet: sheetName,
      });
      if (sessionId) params.set('sessionId', sessionId);
      const res = await fetch(`/api/v1/artifacts/preview?${params.toString()}`, { headers: apiHeaders() });
      const json: unknown = await res.json().catch(() => ({}));
      if (requestId !== sheetRequestSeq.current) return;
      const nextPreview = parseArtifactPreview(json);
      if (!res.ok || nextPreview.status === 'parse_error') throw new Error(artifactErrorMessage(json) || t('artifact.error.previewFailed'));
      setSelectedSheet(sheetName);
      setContent(nextPreview.content);
      setPreview(nextPreview);
    } catch (err) {
      if (requestId === sheetRequestSeq.current) {
        setSheetError(err instanceof Error ? err.message : t('artifact.error.previewFailed'));
      }
    } finally {
      if (requestId === sheetRequestSeq.current) setLoadingSheet(false);
    }
  };

  const save = async () => {
    if (!preview?.editable) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/v1/artifacts/save', {
        method: 'PUT',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ path: preview.path, sessionId, content }),
      });
      const json: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(artifactErrorMessage(json) || t('artifact.error.saveFailed'));
      const size = isRecord(json) ? readOptionalNumber(json.size) : undefined;
      setSaveMessage(t('artifact.status.saved', { size: formatFileSize(size) }));
      await loadPreview(activeArtifact, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifact.error.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const switchMode = (nextMode: 'preview' | 'full') => {
    setMode(nextMode);
    void loadPreview(activeArtifact, nextMode);
  };

  // SVG: 从后端拿到内容，如果 editable=false 且是 svg 格式，从 content 渲染
  const isSvgFormat = normalizeFormat(preview?.format) === 'svg';

  // Markdown 判断（editable 文本文件 + .md 扩展名）
  const isMarkdownFile = preview ? isMarkdown(preview.name, preview.format) : false;

  const renderContent = () => {
    if (loading) {
      return (
        <div className="h-full flex items-center justify-center text-text-tertiary">
          <Loader2 className="animate-spin mr-2" size={16} />{t('artifact.status.loading')}
        </div>
      );
    }
    if (error) {
      return <div className="m-4 rounded-lg border border-accent-red/30 bg-accent-red/5 p-4 text-sm text-accent-red">{error}</div>;
    }
    if (!preview) {
      return (
        <div className="h-full flex flex-col items-center justify-center text-center text-text-tertiary">
          <Eye size={28} className="mb-3 opacity-70" />
          <div className="text-sm text-text-secondary">{t('artifact.empty.title')}</div>
          <div className="mt-1 text-xs">{t('artifact.empty.subtitle')}</div>
        </div>
      );
    }

    // ── PDF ──
    const format = normalizeFormat(preview.format);

    if (preview.rawPreviewable && format === 'pdf') {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-border-muted bg-bg-secondary/70 px-3 py-1.5 text-[11px] text-text-tertiary">
            {preview.metadata?.imageOnly
              ? t('artifact.pdf.imageOnly')
              : preview.metadata?.hasTextLayer
                ? t('artifact.pdf.textLayer')
                : t('artifact.pdf.unknownLayer')}
          </div>
          <iframe src={rawUrl} className="min-h-0 flex-1 bg-bg-primary" title={preview.name} />
        </div>
      );
    }

    // ── 图片（非 SVG）──
    if (preview.rawPreviewable && isImage(format)) {
      return <ImagePreview rawUrl={rawUrl} preview={preview} />;
    }

    // ── SVG 内联 ──
    if (isSvgFormat) {
      // SVG 原始内容由 parseText 返回（svg 命中 extmap → text，rawPreviewable=true）
      // 先尝试用 content，content 为空则 fallback 到 img
      return content
        ? <SvgPreview content={content} name={preview.name} />
        : <div className="h-full overflow-auto p-4 flex items-center justify-center"><img src={rawUrl} alt={preview.name} className="max-w-full max-h-full rounded border border-border-muted" /></div>;
    }

    // ── 视频 ──
    if (preview.rawPreviewable && isVideo(format)) {
      return (
        <div className="h-full flex items-center justify-center p-4">
          <video src={rawUrl} controls className="max-h-full max-w-full rounded border border-border-muted" />
        </div>
      );
    }

    // ── 音频 ──
    if (preview.rawPreviewable && isAudio(format)) {
      return (
        <div className="h-full flex items-center justify-center p-4">
          <audio src={rawUrl} controls className="w-full max-w-xl" />
        </div>
      );
    }

    // ── HTML：sandbox iframe 渲染，避免把完整页面当普通文本/消毒片段展示 ──
    if (format === 'html') {
      return (
        <iframe
          src={rawUrl}
          className="h-full w-full bg-bg-primary"
          title={preview.name}
          sandbox="allow-forms allow-downloads"
          referrerPolicy="no-referrer"
        />
      );
    }

    // ── XLSX / XLS ──
    if (SPREADSHEET_FORMATS.has(format)) {
      return (
        <XlsxPreview
          preview={preview}
          content={content}
          onSheetChange={handleSheetChange}
          currentSheet={selectedSheet}
          loadingSheet={loadingSheet}
        />
      );
    }

    // ── DOCX：后端 mammoth 转 HTML 富文本渲染 ──
    if (format === 'docx' && preview.metadata?.renderer === 'html') {
      return <DocxPreview html={content} />;
    }

    // ── PPTX：后端 OOXML slide 结构渲染 ──
    if (format === 'pptx') {
      return <PptxStructurePreview preview={preview} content={content} />;
    }

    // ── CSV（纯 CSV 格式）──
    if (format === 'csv') {
      return (
        <XlsxPreview
          preview={preview}
          content={content}
          onSheetChange={handleSheetChange}
          currentSheet={selectedSheet}
          loadingSheet={loadingSheet}
        />
      );
    }

    // ── Markdown 编辑/预览 ──
    if (isMarkdownFile && preview.editable) {
      return (
        <MarkdownEditor
          content={content}
          onChange={setContent}
          viewMode={mdViewMode}
        />
      );
    }

    // ── Markdown 只读 ──
    if (isMarkdownFile) {
      return (
        <div className="artifact-prose h-full overflow-auto px-6 py-4 text-sm text-text-secondary">
          <SafeMarkdown>{content}</SafeMarkdown>
        </div>
      );
    }

    // ── 可编辑文本/代码文件 → Monaco ──
    if (preview.editable) {
      const lang = monacoLanguage(preview.name);
      return <CodeEditor content={content} onChange={setContent} language={lang} />;
    }

    // ── 纯文本回退 ──
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-6 text-text-secondary">
        {content}
      </pre>
    );
  };

  // Markdown 视图模式切换按钮
  const renderMdModeButtons = () => {
    if (!isMarkdownFile || !preview?.editable) return null;
    return (
      <div className="flex items-center rounded border border-border-muted overflow-hidden">
        {([['edit', <Edit3 size={12} />, t('artifact.md.modeEdit')], ['preview', <Eye size={12} />, t('artifact.md.modePreview')], ['split', <Columns2 size={12} />, t('artifact.md.modeSplit')]] as const).map(([m, icon, label]) => (
          <button
            key={m}
            onClick={() => setMdViewMode(m as MarkdownViewMode)}
            className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${mdViewMode === m ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {icon}{label}
          </button>
        ))}
      </div>
    );
  };

  const hasUnsavedChanges = preview?.editable && content !== preview.content;

  return (
    <div className="flex h-full min-w-0 bg-bg-primary">
      {/* 左侧：最近文件列表 */}
      <aside className="artifact-recent-pane w-56 shrink-0 border-r border-border-muted bg-bg-secondary/50 flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-border-muted">
          <div className="text-xs font-mono font-semibold text-text-primary">{t('artifact.title')}</div>
          <div className="mt-0.5 text-[10px] text-text-tertiary">{t('artifact.subtitle')}</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {recentArtifacts.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-text-tertiary">{t('artifact.recent.empty')}</div>
          )}
          {recentArtifacts.map((artifact) => (
            <button
              key={artifact.path || artifact.url || artifact.name}
              onClick={() => openArtifact(artifact)}
              className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${
                artifact.path === activeArtifact?.path
                  ? 'bg-accent-brand/10 text-accent-brand'
                  : 'text-text-secondary hover:bg-bg-hover'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0">{iconFor(artifact.mimeType)}</span>
                <span className="truncate font-mono">{artifact.name}</span>
              </div>
              <div className="mt-1 truncate text-[10px] text-text-tertiary">
                {artifact.path ? `${artifact.path}${artifact.line ? `:${artifact.line}` : ''}` : artifact.url || formatFileSize(artifact.size)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* 右侧：主内容区 */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* 顶部工具栏 */}
        <div className="shrink-0 border-b border-border-muted bg-bg-secondary/70 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-muted bg-bg-primary text-accent-brand">
              {iconFor(preview?.format)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-text-primary">
                {preview?.name || activeArtifact?.name || t('artifact.title')}
              </div>
              <div className="mt-0.5 flex items-center gap-2 truncate text-[10px] font-mono text-text-tertiary">
                {preview && <span>{preview.format}</span>}
                {preview && <span>{formatFileSize(preview.size)}</span>}
                {activeArtifact?.line && <span>line {activeArtifact.line}</span>}
                {preview?.metadata?.pages && <span>{preview.metadata.pages} {t('artifact.meta.pages')}</span>}
                {preview?.metadata?.wordCount && <span>{preview.metadata.wordCount} {t('artifact.meta.words')}</span>}
                {preview?.truncated && <span className="text-accent-yellow">{t('artifact.meta.truncated')}</span>}
                {preview?.editable && !hasUnsavedChanges && <span className="text-accent-green">{t('artifact.meta.editable')}</span>}
                {preview?.metadata?.editableKind === 'office-native' && <span className="text-accent-blue">{t('artifact.meta.officeNative')}</span>}
                {hasUnsavedChanges && <span className="text-accent-yellow">{t('artifact.meta.unsaved')}</span>}
                {saveMessage && <span className="text-accent-green">{saveMessage}</span>}
              </div>
            </div>

            {/* Markdown 模式切换 */}
            {renderMdModeButtons()}

            {/* 预览/全文切换（非二进制格式） */}
            {!hidesPreviewModeToggle(preview?.format) && (
              <button
                onClick={() => switchMode(mode === 'preview' ? 'full' : 'preview')}
                disabled={!activeArtifact?.path || loading}
                className="rounded border border-border-muted px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                {mode === 'preview' ? t('artifact.action.full') : t('artifact.action.preview')}
              </button>
            )}

            <button
              onClick={() => void loadPreview(activeArtifact, mode)}
              disabled={!activeArtifact?.path || loading}
              className="rounded border border-border-muted p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40"
              title={t('artifact.action.refresh')}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>

            {preview?.path && (
              <button
                onClick={() => navigator.clipboard?.writeText(preview.path)}
                className="rounded border border-border-muted p-1.5 text-text-secondary hover:text-text-primary"
                title={t('artifact.action.copyPath')}
              >
                <Copy size={14} />
              </button>
            )}

            {preview && (
              <button
                type="button"
                onClick={() => { void downloadPreview(); }}
                className="rounded border border-border-muted p-1.5 text-text-secondary hover:text-text-primary"
                title={t('artifact.action.download')}
              >
                <Download size={14} />
              </button>
            )}

            {preview?.editable && (
              <button
                onClick={save}
                disabled={saving || !hasUnsavedChanges}
                className="inline-flex items-center gap-1 rounded border border-accent-brand/40 bg-accent-brand/10 px-2 py-1 text-xs text-accent-brand disabled:opacity-40"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {t('artifact.action.save')}
              </button>
            )}

            <button
              onClick={clearArtifact}
              disabled={!activeArtifact}
              className="rounded border border-border-muted p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40"
              title={t('artifact.action.close')}
            >
              <XCircle size={14} />
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div className="min-h-0 flex-1 flex flex-col">
          {!loading && !error && <PreviewWarningStrip preview={preview} extra={sheetError} />}
          <div className="min-h-0 flex-1">{renderContent()}</div>
        </div>
      </main>
    </div>
  );
}
