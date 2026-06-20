/**
 * McpAppRenderer — MCP Apps 交互式 UI 组件渲染器。
 *
 * 将 MCP Server 通过 _meta.lingxiao_app 标记返回的交互式 HTML 以 sandbox iframe
 * 安全渲染。HTML 经 DOMPurify 清洗后注入 iframe srcdoc。
 *
 * 安全约束：
 * - iframe sandbox='allow-scripts allow-forms'（不含 allow-same-origin，防止访问父页面）
 * - DOMPurify 移除 script 标签和危险事件属性
 * - HTML 大小限制 256KB
 * - 不允许外部资源加载
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify, { type Config as DomPurifyConfig } from 'dompurify';
import { useThemeStore } from '../../stores/themeStore';
import { AlertTriangle, ExternalLink } from 'lucide-react';

export interface McpAppRendererProps {
  html: string;
  title?: string;
  height?: number | 'auto';
  actions?: Array<{ label: string; event: string; data?: unknown }>;
}

const MAX_HTML_SIZE = 256 * 1024; // 256KB

/**
 * DOMPurify 配置：允许交互式 HTML 组件所需的标签，禁止脚本和危险属性。
 */
const PURIFY_CONFIG: DomPurifyConfig = {
  ALLOWED_TAGS: [
    'div', 'span', 'p', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'ul', 'ol', 'li', 'code', 'pre', 'strong', 'em', 'b', 'i', 'u', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'button', 'input', 'label', 'select', 'option', 'textarea', 'form',
    'details', 'summary', 'dialog', 'canvas', 'svg', 'path', 'rect', 'circle',
    'line', 'polyline', 'polygon', 'ellipse', 'g', 'defs', 'text', 'tspan',
    'style', 'header', 'footer', 'nav', 'main', 'section', 'article', 'aside',
  ],
  ALLOWED_ATTR: [
    'class', 'id', 'style', 'href', 'src', 'alt', 'title', 'width', 'height',
    'type', 'value', 'name', 'placeholder', 'disabled', 'checked', 'selected',
    'for', 'colspan', 'rowspan', 'target', 'rel', 'download',
    'viewBox', 'fill', 'stroke', 'stroke-width', 'cx', 'cy', 'r', 'rx', 'ry',
    'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'd', 'transform',
    'xmlns', 'data-event', 'data-action',
  ],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta'],
};

/**
 * 判断 HTML 是否为完整 HTML（以 < 开头且包含闭合标签），否则视为 markdown。
 */
function isCompleteHtml(html: string): boolean {
  const trimmed = html.trim();
  return trimmed.startsWith('<') && /<\/[a-zA-Z][^>]*>/.test(trimmed);
}

/**
 * 构建 iframe srcdoc：包装 sanitized HTML，注入主题样式和高度自适应脚本。
 */
function buildSrcDoc(html: string, theme: 'light' | 'dark'): string {
  const bgColor = theme === 'dark' ? '#1a1a2e' : '#ffffff';
  const textColor = theme === 'dark' ? '#e0e0e0' : '#1a1a1a';
  const fontFamily = 'system-ui, -apple-system, sans-serif';

  return `<!DOCTYPE html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: ${bgColor};
    color: ${textColor};
    font-family: ${fontFamily};
    font-size: 14px;
    line-height: 1.6;
    overflow-x: hidden;
  }
  body { padding: 12px; }
  a { color: ${theme === 'dark' ? '#6cb6ff' : '#0066cc'}; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid ${theme === 'dark' ? '#444' : '#ddd'}; padding: 4px 8px; }
  img { max-width: 100%; height: auto; }
  pre, code { font-family: 'SF Mono', 'Fira Code', monospace; }
  pre { background: ${theme === 'dark' ? '#16213e' : '#f5f5f5'}; padding: 8px; border-radius: 4px; overflow-x: auto; }
  button {
    cursor: pointer; padding: 4px 12px; border-radius: 4px;
    border: 1px solid ${theme === 'dark' ? '#555' : '#ccc'};
    background: ${theme === 'dark' ? '#16213e' : '#f8f8f8'};
    color: ${textColor};
  }
  button:hover { background: ${theme === 'dark' ? '#1a1a3e' : '#eee'}; }
  input, textarea, select {
    border: 1px solid ${theme === 'dark' ? '#555' : '#ccc'};
    border-radius: 4px; padding: 4px 8px;
    background: ${theme === 'dark' ? '#16213e' : '#fff'};
    color: ${textColor};
  }
</style>
</head>
<body>
${html}
<script>
(function() {
  // 高度自适应：通过 ResizeObserver 监听 body 高度变化，postMessage 通知父窗口
  function sendHeight() {
    var h = document.body.scrollHeight;
    window.parent.postMessage({ source: 'mcp-app', type: 'resize', height: h }, window.location.origin);
  }
  // 初始延迟发送（等待内容渲染）
  setTimeout(sendHeight, 100);
  // DOM 变化时重新发送
  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function() { sendHeight(); });
    ro.observe(document.body);
  } else {
    // 降级：定期轮询
    setInterval(sendHeight, 500);
  }
  // 监听父窗口主题变更消息
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'theme-change') {
      document.documentElement.setAttribute('data-theme', e.data.theme);
    }
    // 监听 action 按钮事件
    if (e.data && e.data.type === 'mcp-action') {
      var evt = new CustomEvent(e.data.event, { detail: e.data.data });
      window.dispatchEvent(evt);
    }
  });
})();
</script>
</body>
</html>`;
}

function McpAppRenderer({ html, title, height, actions }: McpAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedTheme = useThemeStore(s => s.resolved);
  const [error, setError] = useState<string | null>(null);
  const [autoHeight, setAutoHeight] = useState(150);
  const [loaded, setLoaded] = useState(false);

  // 1. HTML 大小检查
  const tooLarge = html.length > MAX_HTML_SIZE;

  // 2. DOMPurify 清洗
  const sanitizedHtml = useMemo(() => {
    if (tooLarge) return '';
    try {
      return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
    } catch {
      setError('DOMPurify sanitize failed');
      return '';
    }
  }, [html, tooLarge]);

  // 3. 判断是否为完整 HTML
  const isHtml = useMemo(() => isCompleteHtml(sanitizedHtml), [sanitizedHtml]);

  // 4. 构建 srcdoc
  const srcDoc = useMemo(() => {
    if (!isHtml || !sanitizedHtml) return '';
    return buildSrcDoc(sanitizedHtml, resolvedTheme);
  }, [sanitizedHtml, isHtml, resolvedTheme]);

  // 5. iframe 高度
  const effectiveHeight = height === 'auto' || height === undefined
    ? Math.min(Math.max(autoHeight, 100), 800)
    : Math.min(Math.max(height, 100), 800);

  // 6. 监听 iframe postMessage（高度自适应）
  useEffect(() => {
    if (!isHtml) return;
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data;
      if (data && data.source === 'mcp-app' && data.type === 'resize' && typeof data.height === 'number') {
        setAutoHeight(data.height);
        setLoaded(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isHtml]);

  // 7. 主题变更时通知 iframe
  useEffect(() => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'theme-change', theme: resolvedTheme },
        window.location.origin,
      );
    }
  }, [resolvedTheme]);

  // 8. iframe 加载超时检测
  useEffect(() => {
    if (!isHtml) return;
    const timer = setTimeout(() => {
      if (!loaded) {
        setError('iframe load timeout');
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [isHtml, loaded]);

  // 9. action 按钮点击 → postMessage 到 iframe
  const handleAction = useCallback((action: { label: string; event: string; data?: unknown }) => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      win.postMessage({ type: 'mcp-action', event: action.event, data: action.data }, window.location.origin);
    }
  }, []);

  // ── 错误回退渲染 ──
  if (tooLarge) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
          <AlertTriangle size={16} />
          <span className="font-medium">MCP App HTML Too Large</span>
        </div>
        <p className="mt-1 text-text-secondary">
          HTML 内容超过 256KB 限制（当前 {(html.length / 1024).toFixed(0)}KB），已回退到纯文本显示。
        </p>
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-bg-secondary p-2 text-xs text-text-tertiary">
          {html.slice(0, 500)}...
        </pre>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
        <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
          <AlertTriangle size={16} />
          <span className="font-medium">MCP App Render Error</span>
        </div>
        <p className="mt-1 text-text-secondary">{error}</p>
        <p className="mt-1 text-text-tertiary text-xs">[MCP App: {title ?? 'Interactive Component'}]</p>
      </div>
    );
  }

  // ── Markdown 回退渲染（非完整 HTML）──
  if (isHtml && sanitizedHtml === '' && !tooLarge) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-3 text-sm text-text-secondary">
        [MCP App: {title ?? 'Interactive Component'}]
      </div>
    );
  }

  // ── 主渲染：sandbox iframe ──
  return (
    <div ref={containerRef} className="my-2 overflow-hidden rounded-lg border border-border bg-bg-secondary">
      {/* 卡片 header */}
      {title && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <ExternalLink size={14} className="text-text-tertiary" />
          <span className="text-xs font-medium text-text-secondary">{title}</span>
        </div>
      )}

      {/* iframe 渲染区域 */}
      {isHtml ? (
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          title={title ?? 'MCP App'}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          style={{ height: effectiveHeight, width: '100%', border: 'none' }}
          onLoad={() => setLoaded(true)}
        />
      ) : (
        /* 非完整 HTML（markdown）回退到纯文本显示 */
        <div className="p-3 text-sm text-text-secondary whitespace-pre-wrap">
          {sanitizedHtml || html.slice(0, 1000)}
        </div>
      )}

      {/* action 按钮 */}
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={() => handleAction(action)}
              className="rounded-md border border-border bg-bg-tertiary px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-hover"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(McpAppRenderer);
