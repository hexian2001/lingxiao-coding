/**
 * OfficeResultCard — 聊天流内嵌的 Office 文件富预览卡片
 *
 * 当工具结果包含 pptx/docx/xlsx/pdf 路径或下载链接时展示富预览。
 * 覆盖：HTTP /api office generate 名、office_ops、shell 产物、create_download_link。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2, Download, ExternalLink, Loader2, Presentation,
  FileText, Sheet, FileEdit, ChevronRight, AlertCircle,
} from 'lucide-react';
import { useArtifactStore } from '../../stores/artifactStore';
import { officeClient, type OfficePreviewModel } from '../../api/OfficeClient';

// ─── 类型 ───

interface OfficeResultData {
  type?: string;
  url?: string;
  name?: string;
  path?: string;
  size?: number;
  mimeType?: string;
  slideCount?: number;
  success?: boolean;
  format?: string;
}

interface Props {
  toolName: string;
  result: unknown;
}

const OFFICE_TOOLS = new Set([
  // Web HTTP generate 后端仍可能以这些名出现在会话回放中
  'generate_pptx', 'generate_docx', 'generate_xlsx', 'generate_pdf',
  // Agent 面真实工具
  'office_ops', 'parse_file', 'shell', 'create_download_link', 'session_artifacts',
]);

const OFFICE_EXT_RE = /\.(pptx|docx|xlsx|pdf)(?:$|[?#])/i;

function looksLikeOfficePath(value: unknown): boolean {
  return typeof value === 'string' && OFFICE_EXT_RE.test(value);
}

const FORMAT_ICONS: Record<string, React.ReactNode> = {
  pptx: <Presentation size={16} />,
  docx: <FileEdit size={16} />,
  xlsx: <Sheet size={16} />,
  pdf: <FileText size={16} />,
};

const FORMAT_LABELS: Record<string, string> = {
  pptx: 'PPTX 演示',
  docx: 'DOCX 文档',
  xlsx: 'XLSX 表格',
  pdf: 'PDF 文档',
};

function detectFormat(toolName: string, mimeType?: string, path?: string): string {
  const fromTool = toolName.match(/(pptx|docx|xlsx|pdf)/i)?.[1]?.toLowerCase();
  if (fromTool) return fromTool;
  if (mimeType?.includes('presentation')) return 'pptx';
  if (mimeType?.includes('wordprocessing')) return 'docx';
  if (mimeType?.includes('spreadsheet')) return 'xlsx';
  if (mimeType?.includes('pdf')) return 'pdf';
  const ext = path?.match(/\.(\w+)$/)?.[1]?.toLowerCase();
  if (ext && ['pptx', 'docx', 'xlsx', 'pdf'].includes(ext)) return ext;
  return 'pptx';
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── 解析 tool result ───

function parseOfficeResult(toolName: string, result: unknown): OfficeResultData | null {
  if (!OFFICE_TOOLS.has(toolName)) return null;

  let data = result;
  if (typeof result === 'string') {
    // shell 输出里直接出现 office 路径
    if (looksLikeOfficePath(result)) {
      const path = result.trim().split(/\s+/).find((tok) => looksLikeOfficePath(tok)) || result.trim();
      return { path, name: path.split(/[\\/]/).pop() || 'document', success: true };
    }
    try { data = JSON.parse(result); } catch { return null; }
  }

  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // tool result 可能是 { success, data: { url, path, ... } } 或直接 { url, path, ... }
  const inner = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
    ? obj.data as Record<string, unknown>
    : obj;
  const success = obj.success !== false && inner.success !== false;
  if (!success) return null;

  const url = (inner.url as string) || (inner.downloadUrl as string) || (obj.url as string);
  let path = (inner.path as string) || (inner.output_path as string) || (obj.path as string);
  // shell / office_ops 嵌套字段
  if (!path) {
    for (const key of ['file', 'file_path', 'outputPath', 'artifact_path']) {
      const v = inner[key] ?? obj[key];
      if (looksLikeOfficePath(v)) { path = String(v); break; }
    }
  }
  // 文本 data 中挖路径
  if (!path && typeof inner === 'object') {
    const blob = JSON.stringify(inner);
    const m = blob.match(/[^"'\s]+\.(pptx|docx|xlsx|pdf)/i);
    if (m) path = m[0];
  }

  const name = (inner.name as string) || (obj.name as string) || path?.split(/[\\/]/).pop() || 'document';
  const size = (inner.size as number) || (obj.size as number);
  const mimeType = (inner.mimeType as string) || (obj.mimeType as string);
  const slideCount = (inner.slideCount as number) || (obj.slideCount as number);

  if (!url && !path) return null;
  // shell 杂项结果：必须真是 office 扩展名
  if ((toolName === 'shell' || toolName === 'session_artifacts') && !looksLikeOfficePath(path) && !looksLikeOfficePath(url)) {
    return null;
  }

  return { url, path, name, size, mimeType, slideCount, success, type: inner.type as string };
}

// ─── 组件 ───

export function isOfficeToolResult(toolName: string, result: unknown): boolean {
  return parseOfficeResult(toolName, result) !== null;
}

export default function OfficeResultCard({ toolName, result }: Props) {
  const [preview, setPreview] = useState<OfficePreviewModel | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const { openArtifact } = useArtifactStore();

  const data = parseOfficeResult(toolName, result);
  const format = detectFormat(toolName, data?.mimeType, data?.path);

  // 对于 PPTX/DOCX，自动加载预览模型以展示页面摘要
  const canPreview = (format === 'pptx' || format === 'docx') && !!data?.path;

  useEffect(() => {
    if (!canPreview || !data?.path) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(false);

    officeClient.getPreview(data.path, { format: format as 'pptx' | 'docx', slideLimit: 10 })
      .then((model) => {
        if (!cancelled) {
          setPreview(model);
          setPreviewLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewError(true);
          setPreviewLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [canPreview, data?.path, format]);

  const handleDownload = useCallback(() => {
    if (data?.url) {
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } else if (data?.path) {
      // 通过 artifact store 触发下载
      openArtifact({ name: data.name || 'document', path: data.path, mimeType: data.mimeType });
    }
  }, [data, openArtifact]);

  const handleOpenInCanvas = useCallback(() => {
    if (!data?.path) return;
    // 打开产物即驱动剑阁 Canvas 舞台（ArtifactView 监听 activeArtifact 自动预览）；
    // 切到 chat 视图并派发事件展开剑阁侧栏，确保产物在画布中可见。
    openArtifact({ name: data.name || 'document', path: data.path, mimeType: data.mimeType });
    window.dispatchEvent(new CustomEvent('lingxiao:open-jiange'));
  }, [data, openArtifact]);

  if (!data) return null;

  const icon = FORMAT_ICONS[format] || <FileText size={16} />;
  const label = FORMAT_LABELS[format] || format.toUpperCase();

  return (
    <div className="rounded-lg border border-border-muted bg-bg-secondary overflow-hidden">
      {/* 头部：格式 + 文件名 + 成功标识 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-bg-tertiary/50">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-brand/10 text-accent-brand shrink-0">
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 size={12} className="text-accent-green shrink-0" />
            <span className="text-[12px] font-medium text-text-primary truncate">{data.name}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-text-tertiary mt-0.5">
            <span>{label}</span>
            {data.size ? (<><span>·</span><span>{formatSize(data.size)}</span></>) : null}
            {data.slideCount ? (<><span>·</span><span>{data.slideCount} 页</span></>) : null}
          </div>
        </div>
      </div>

      {/* 预览摘要区域 */}
      {canPreview && (
        <div className="px-3 py-2 border-b border-border-subtle">
          {previewLoading ? (
            <div className="flex items-center gap-2 text-[10px] text-text-tertiary">
              <Loader2 size={10} className="animate-spin" />
              <span>加载预览中...</span>
            </div>
          ) : previewError ? (
            <div className="flex items-center gap-1 text-[10px] text-text-tertiary">
              <AlertCircle size={10} />
              <span>预览不可用</span>
            </div>
          ) : preview ? (
            <div className="space-y-1">
              {/* 页面摘要 */}
              <div className="text-[10px] text-text-tertiary">
                {preview.stats.pageCount} 页 · {preview.stats.elementCount} 元素
                {preview.stats.imageCount > 0 ? ` · ${preview.stats.imageCount} 图片` : ''}
                {preview.stats.tableCount > 0 ? ` · ${preview.stats.tableCount} 表格` : ''}
              </div>
              {/* 前 3 页标题预览 */}
              <div className="flex flex-wrap gap-1">
                {preview.pages.slice(0, 5).map((page, idx) => {
                  const title = page.elements.find((e) => e.kind === 'text' && e.text)?.text?.slice(0, 20) || `P${idx + 1}`;
                  return (
                    <span
                      key={page.id}
                      className="inline-flex items-center gap-1 rounded bg-bg-hover px-1.5 py-0.5 text-[9px] text-text-secondary"
                    >
                      <span className="font-mono text-text-quaternary">{idx + 1}</span>
                      {title}
                    </span>
                  );
                })}
                {preview.pages.length > 5 && (
                  <span className="text-[9px] text-text-quaternary">+{preview.pages.length - 5}</span>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 rounded-md bg-accent-brand px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent-brand/90 transition-colors"
        >
          <Download size={12} />
          下载
        </button>
        <button
          onClick={handleOpenInCanvas}
          className="flex items-center gap-1.5 rounded-md border border-border-muted px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <ExternalLink size={12} />
          在画布中打开
        </button>
        <ChevronRight size={12} className="ml-auto text-text-quaternary" />
      </div>
    </div>
  );
}
