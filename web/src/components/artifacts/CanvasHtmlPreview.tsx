/**
 * CanvasHtmlPreview — 剑阁可交互 HTML 产物预览（选区拾取版）。
 *
 * 与 ArtifactView 常规 HTML 预览的区别：
 *   - 常规预览：sandbox iframe，纯展示，不可拾取。
 *   - 本组件：same-origin iframe，onload 后扫描带 data-node-id 的元素，
 *     加 hover 高亮 + click 拾取，点击时从 data-* 读出 SourceProvenance 锚点，
 *     组装 CanvasSelection（含归一化 selectionBox）回调给上层。
 *
 * data-* 约定（生成 HTML 时注入，与 CanvasSourceMap / canvas_save_sourcemap 对齐）：
 *   data-node-id   稳定语义 ID（必备）
 *   data-anchor    "spec" | "script"
 *   spec  锚点：data-spec-path（spec 节点路径），可选 data-role
 *   script 锚点：data-src-file + data-src-range（"start-end"），可选 data-role
 *
 * 安全说明：产物是本地受信任的生成 HTML，同源加载以便拾取 DOM。
 * iframe 仅在「选区模式」开启时使用本组件；常规预览仍走 ArtifactView 的 sandbox iframe。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { CanvasSelection } from '../../stores/canvasArtifactStore';
import type { SourceProvenance } from '../../api/canvasApi';

interface CanvasHtmlPreviewProps {
  /** 产物原始内容 URL（/api/v1/artifacts/raw?...），与 ArtifactView 的 rawUrl 一致。 */
  src: string;
  /** iframe 标题。 */
  title: string;
  /** 选区拾取回调。 */
  onPick: (selection: CanvasSelection) => void;
  /** 当前已选中的 nodeId，用于在 iframe 内回显高亮。 */
  activeNodeId?: string | null;
}

const HIGHLIGHT_STYLE_ID = '__lingxiao_canvas_pick_style__';

/** 注入到 iframe 文档内的高亮样式。 */
const HIGHLIGHT_CSS = `
[data-node-id]{cursor:pointer;transition:outline .12s ease,outline-offset .12s ease;}
[data-node-id]:hover{outline:2px dashed var(--lx-pick,rgb(138,101,31))!important;outline-offset:2px!important;}
[data-node-id].__lx_pick_active__{outline:2px solid var(--lx-pick,rgb(138,101,31))!important;outline-offset:2px!important;box-shadow:0 0 0 4px rgba(138,101,31,.20)!important;}
`;

/** 从一个元素的 data-* 读出 SourceProvenance 锚点；读不出则返回 null。 */
function readAnchor(el: HTMLElement): { nodeId: string; anchor: SourceProvenance } | null {
  const nodeId = el.getAttribute('data-node-id');
  if (!nodeId) return null;
  const kind = el.getAttribute('data-anchor');
  const role = el.getAttribute('data-role') || undefined;

  if (kind === 'spec') {
    const specPath = el.getAttribute('data-spec-path');
    if (!specPath) return null;
    return { nodeId, anchor: { kind: 'spec', nodeId, specPath, role } };
  }

  if (kind === 'script') {
    const srcFile = el.getAttribute('data-src-file');
    const rangeRaw = el.getAttribute('data-src-range');
    if (!srcFile || !rangeRaw) return null;
    const parts = rangeRaw.split('-').map((s) => parseInt(s.trim(), 10));
    const start = Number.isFinite(parts[0]) ? parts[0] : 0;
    const end = Number.isFinite(parts[1]) ? parts[1] : start;
    return { nodeId, anchor: { kind: 'script', nodeId, srcFile, srcRange: [start, end], role } };
  }

  // 缺 data-anchor 时按 spec-path / src-file 兜底推断
  const specPath = el.getAttribute('data-spec-path');
  if (specPath) return { nodeId, anchor: { kind: 'spec', nodeId, specPath, role } };
  const srcFile = el.getAttribute('data-src-file');
  const rangeRaw = el.getAttribute('data-src-range');
  if (srcFile && rangeRaw) {
    const parts = rangeRaw.split('-').map((s) => parseInt(s.trim(), 10));
    const start = Number.isFinite(parts[0]) ? parts[0] : 0;
    const end = Number.isFinite(parts[1]) ? parts[1] : start;
    return { nodeId, anchor: { kind: 'script', nodeId, srcFile, srcRange: [start, end], role } };
  }
  return null;
}

/** 计算元素相对文档的归一化选区框（0..1）。 */
function normalizedBox(el: HTMLElement, doc: Document): { x: number; y: number; w: number; h: number } | undefined {
  const rect = el.getBoundingClientRect();
  const root = doc.documentElement;
  const docW = Math.max(root.scrollWidth, root.clientWidth, 1);
  const docH = Math.max(root.scrollHeight, root.clientHeight, 1);
  const winX = doc.defaultView?.scrollX ?? 0;
  const winY = doc.defaultView?.scrollY ?? 0;
  return {
    x: Math.max(0, (rect.left + winX) / docW),
    y: Math.max(0, (rect.top + winY) / docH),
    w: Math.min(1, rect.width / docW),
    h: Math.min(1, rect.height / docH),
  };
}

export default function CanvasHtmlPreview({ src, title, onPick, activeNodeId }: CanvasHtmlPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 保存当前 onPick，避免 wireUp 闭包过期
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  // 记录已注入监听的 cleanup
  const cleanupRef = useRef<(() => void) | null>(null);

  /** iframe 加载完成后注入高亮样式 + 点击监听。 */
  const wireUp = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument;
    } catch {
      // 跨源（理论上同源不会触发），无法拾取
      doc = null;
    }
    if (!doc) return;

    // 注入高亮样式（幂等）
    if (!doc.getElementById(HIGHLIGHT_STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = HIGHLIGHT_CSS;
      (doc.head || doc.documentElement).appendChild(style);
    }

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const el = target.closest('[data-node-id]') as HTMLElement | null;
      if (!el || !doc) return;
      const parsed = readAnchor(el);
      if (!parsed) return;
      e.preventDefault();
      e.stopPropagation();
      const selection: CanvasSelection = {
        nodeId: parsed.nodeId,
        anchor: parsed.anchor,
        currentContent: (el.innerText || el.textContent || '').trim().slice(0, 500) || undefined,
        selectionBox: normalizedBox(el, doc),
      };
      onPickRef.current(selection);
    };

    doc.addEventListener('click', handleClick, true);
    cleanupRef.current = () => {
      try { doc?.removeEventListener('click', handleClick, true); } catch { /* ignore */ }
    };
  }, []);

  // 回显当前选中元素的 active 高亮
  useEffect(() => {
    const iframe = iframeRef.current;
    let doc: Document | null = null;
    try { doc = iframe?.contentDocument ?? null; } catch { doc = null; }
    if (!doc) return;
    doc.querySelectorAll('.__lx_pick_active__').forEach((n) => n.classList.remove('__lx_pick_active__'));
    if (activeNodeId) {
      const el = doc.querySelector(`[data-node-id="${CSS.escape(activeNodeId)}"]`);
      el?.classList.add('__lx_pick_active__');
    }
  }, [activeNodeId]);

  // 卸载时清理监听
  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={title}
      onLoad={wireUp}
      className="h-full w-full bg-bg-primary"
      // same-origin 以便拾取 DOM；产物为本地受信任生成内容。allow-scripts 让图表等动态产物可运行。
      sandbox="allow-same-origin allow-scripts allow-forms allow-downloads"
      referrerPolicy="no-referrer"
    />
  );
}
