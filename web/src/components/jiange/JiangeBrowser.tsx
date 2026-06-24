/**
 * JiangeBrowser — v1.0.5 剑阁浏览器面板
 * 
 * 真实浏览器交互：
 * - 点击截图 → 触发后端 click API → 自动刷新截图
 * - 选中元素 → 显示元素信息 → 可以直接修改 HTML
 * - 评论 → 通过 patch-element API 直接修改页面
 * - 地址栏导航、滚动、前进后退
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useJiangeStore } from '../../stores/jiangeStore';
import { browserClient, type BrowserElementSelection } from '../../api/BrowserClient';
import {
  ArrowLeft, ArrowRight, RotateCw, Globe, MousePointer2,
  Hand, Code2, Eye, Send, X, Loader2, ChevronDown,
} from 'lucide-react';

type InteractionMode = 'click' | 'inspect' | 'select';

export function JiangeBrowser() {
  const store = useJiangeStore();
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [mode, setMode] = useState<InteractionMode>('click');
  const [selection, setSelection] = useState<BrowserElementSelection | null>(null);
  const [comment, setComment] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshotKey, setScreenshotKey] = useState(0);
  const [showHtmlEditor, setShowHtmlEditor] = useState(false);
  const [htmlEditContent, setHtmlEditContent] = useState('');
  const [clickIndicator, setClickIndicator] = useState<{ x: number; y: number } | null>(null);

  // Create or reuse session
  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    try {
      setIsLoading(true);
      setError(null);
      const s = await browserClient.createSession(store.browserUrl);
      setSessionId(s.id);
      setUrlInput(s.url);
      setScreenshotKey(k => k + 1);
      return s.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, store.browserUrl]);

  // Navigate
  const navigate = useCallback(async (url: string) => {
    const sid = await ensureSession();
    if (!sid) return;
    try {
      setIsLoading(true);
      setError(null);
      await browserClient.navigate(sid, url);
      setScreenshotKey(k => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [ensureSession]);

  // Handle image click — coordinate-based interaction
  const handleImageClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    const sid = await ensureSession();
    if (!sid || !imgRef.current) return;

    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = imgRef.current.naturalWidth / rect.width;
    const scaleY = imgRef.current.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    // Show click indicator
    setClickIndicator({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setTimeout(() => setClickIndicator(null), 500);

    if (mode === 'inspect' || mode === 'select') {
      // Inspect element at point
      try {
        setIsLoading(true);
        const sel = await browserClient.inspect(sid, x, y);
        setSelection(sel);
        if (mode === 'select') {
          setShowHtmlEditor(true);
          setHtmlEditContent(sel.htmlSnippet);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    } else if (mode === 'click') {
      // Real click!
      try {
        setIsLoading(true);
        await browserClient.click(sid, x, y);
        // Wait a moment for page to settle
        await new Promise(r => setTimeout(r, 500));
        setScreenshotKey(k => k + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    }
  }, [ensureSession, mode]);

  // Handle scroll on image
  const handleImageWheel = useCallback(async (e: React.WheelEvent<HTMLImageElement>) => {
    const sid = await ensureSession();
    if (!sid) return;
    try {
      await browserClient.scroll(sid, 0, e.deltaY);
      setScreenshotKey(k => k + 1);
    } catch {
      // silent fail for scroll
    }
  }, [ensureSession]);

  // Submit comment → patch element HTML directly
  const submitComment = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid || !selection || !comment.trim()) return;
    try {
      setIsLoading(true);
      // Directly modify the element's text/HTML based on comment
      // If comment looks like HTML (starts with <), patch innerHTML
      // Otherwise, patch as text content
      const isHtml = comment.trim().startsWith('<');
      await browserClient.patchElement(sid, selection.selector, {
        html: isHtml ? comment.trim() : undefined,
        text: isHtml ? undefined : comment.trim(),
      });
      setComment('');
      // Refresh screenshot
      await new Promise(r => setTimeout(r, 300));
      setScreenshotKey(k => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [ensureSession, selection, comment]);

  // Apply HTML edit
  const applyHtmlEdit = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid || !selection) return;
    try {
      setIsLoading(true);
      await browserClient.patchElement(sid, selection.selector, { html: htmlEditContent });
      setShowHtmlEditor(false);
      setScreenshotKey(k => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [ensureSession, selection, htmlEditContent]);

  // Eval JS
  const [jsInput, setJsInput] = useState('');
  const [evalResult, setEvalResult] = useState<string | null>(null);
  const submitEval = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid || !jsInput.trim()) return;
    try {
      setIsLoading(true);
      const result = await browserClient.evalJs(sid, jsInput);
      setEvalResult(JSON.stringify(result.result, null, 2));
      setScreenshotKey(k => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, [ensureSession, jsInput]);

  const screenshotUrl = sessionId ? browserClient.screenshotUrl(sessionId) : null;

  return (
    <div className="flex h-full flex-col bg-bg-primary overflow-hidden">
      {/* Address bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border-subtle bg-bg-tertiary flex-shrink-0">
        <button
          onClick={() => navigate('about:blank')}
          className="p-1 rounded hover:bg-bg-hover text-text-tertiary"
          title="后退"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={() => setScreenshotKey(k => k + 1)}
          className="p-1 rounded hover:bg-bg-hover text-text-tertiary"
          title="刷新"
        >
          <RotateCw size={14} />
        </button>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && navigate(urlInput)}
          placeholder="输入地址..."
          className="flex-1 px-2 py-1 bg-bg-primary border border-border-subtle rounded text-[12px] text-text-primary focus:outline-none focus:border-accent-brand/50"
        />
        <button
          onClick={() => navigate(urlInput)}
          className="px-2 py-1 rounded bg-accent-brand/15 text-accent-brand text-[12px] font-medium hover:bg-accent-brand/25"
        >
          <Globe size={14} />
        </button>
      </div>

      {/* Interaction mode toolbar */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-border-subtle bg-bg-secondary flex-shrink-0">
        {(['click', 'inspect', 'select'] as InteractionMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
              mode === m ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {m === 'click' && <MousePointer2 size={12} />}
            {m === 'inspect' && <Eye size={12} />}
            {m === 'select' && <Code2 size={12} />}
            {m === 'click' ? '点击' : m === 'inspect' ? '检视' : '选择编辑'}
          </button>
        ))}
        <div className="flex-1" />
        {error && (
          <span className="text-[10px] text-accent-red font-mono max-w-[200px] truncate" title={error}>
            ⚠ {error}
          </span>
        )}
        {isLoading && (
          <Loader2 size={12} className="animate-spin text-accent-brand" />
        )}
      </div>

      {/* Browser viewport */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto flex items-start justify-center bg-bg-secondary/50 relative"
      >
        {screenshotUrl ? (
          <div className="relative inline-block" style={{ maxWidth: '100%' }}>
            <img
              ref={imgRef}
              key={screenshotKey}
              src={screenshotUrl}
              alt="Browser"
              onClick={handleImageClick}
              onWheel={handleImageWheel}
              className="block max-w-full h-auto cursor-pointer"
              style={{ cursor: mode === 'click' ? 'pointer' : mode === 'inspect' ? 'crosshair' : 'cell' }}
              draggable={false}
            />
            {clickIndicator && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: clickIndicator.x,
                  top: clickIndicator.y,
                  transform: 'translate(-50%, -50%)',
                }}
              >
                <div className="w-6 h-6 rounded-full border-2 border-accent-brand bg-accent-brand/20 animate-ping" />
              </div>
            )}
            {selection && mode === 'inspect' && (
              <div
                className="absolute pointer-events-none border-2 border-accent-brand bg-accent-brand/10"
                style={{
                  left: `${(selection.rect.x / (selection.viewport?.width || 1280)) * 100}%`,
                  top: `${(selection.rect.y / (selection.viewport?.height || 820)) * 100}%`,
                  width: `${(selection.rect.width / (selection.viewport?.width || 1280)) * 100}%`,
                  height: `${(selection.rect.height / (selection.viewport?.height || 820)) * 100}%`,
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3 py-20">
            <Globe size={48} className="opacity-30" />
            <p className="text-[13px]">点击地址栏导航或输入 URL 开始浏览</p>
            <button
              onClick={() => ensureSession()}
              className="px-4 py-1.5 rounded bg-accent-brand/15 text-accent-brand text-[12px] font-medium hover:bg-accent-brand/25"
            >
              启动浏览器
            </button>
          </div>
        )}
      </div>

      {/* Element info + comment bar */}
      {selection && (
        <div className="border-t border-border-subtle bg-bg-tertiary flex-shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
            <span className="text-[10px] font-mono text-accent-brand bg-accent-brand/10 px-1.5 py-0.5 rounded">
              {selection.tag}
            </span>
            <span className="text-[11px] font-mono text-text-tertiary truncate flex-1" title={selection.selector}>
              {selection.selector}
            </span>
            {selection.text && (
              <span className="text-[11px] text-text-tertiary truncate max-w-[200px]" title={selection.text}>
                "{selection.text}"
              </span>
            )}
            <button
              onClick={() => { setSelection(null); setShowHtmlEditor(false); }}
              className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary"
            >
              <X size={12} />
            </button>
          </div>
          {showHtmlEditor ? (
            <div className="p-2 space-y-1.5">
              <textarea
                value={htmlEditContent}
                onChange={(e) => setHtmlEditContent(e.target.value)}
                className="w-full h-20 px-2 py-1 bg-bg-primary border border-border-subtle rounded text-[11px] font-mono text-text-primary focus:outline-none focus:border-accent-brand/50 resize-y"
                placeholder="编辑 HTML..."
              />
              <div className="flex gap-1.5">
                <button
                  onClick={applyHtmlEdit}
                  className="px-2 py-1 rounded bg-accent-brand text-bg-primary text-[11px] font-medium hover:bg-accent-brand/90"
                >
                  应用修改
                </button>
                <button
                  onClick={() => setShowHtmlEditor(false)}
                  className="px-2 py-1 rounded text-text-tertiary text-[11px] hover:bg-bg-hover"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 p-1.5">
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitComment()}
                placeholder="评论/修改：输入文本替换内容，或输入 <html> 替换 HTML..."
                className="flex-1 px-2 py-1 bg-bg-primary border border-border-subtle rounded text-[11px] text-text-primary focus:outline-none focus:border-accent-brand/50"
              />
              <button
                onClick={submitComment}
                disabled={!comment.trim() || isLoading}
                className="flex items-center gap-1 px-2 py-1 rounded bg-accent-brand text-bg-primary text-[11px] font-medium hover:bg-accent-brand/90 disabled:opacity-50"
              >
                <Send size={12} />
                应用
              </button>
              <button
                onClick={() => { setShowHtmlEditor(true); setHtmlEditContent(selection.htmlSnippet); }}
                className="flex items-center gap-1 px-2 py-1 rounded text-text-tertiary text-[11px] hover:bg-bg-hover"
              >
                <Code2 size={12} />
                编辑HTML
              </button>
            </div>
          )}
        </div>
      )}

      {/* JS eval bar */}
      <div className="flex items-center gap-1.5 px-3 py-1 border-t border-border-subtle bg-bg-tertiary flex-shrink-0">
        <Code2 size={12} className="text-text-tertiary flex-shrink-0" />
        <input
          value={jsInput}
          onChange={(e) => setJsInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitEval()}
          placeholder="执行 JS: document.title"
          className="flex-1 px-1.5 py-0.5 bg-transparent border-none text-[11px] font-mono text-text-secondary focus:outline-none"
        />
        <button
          onClick={submitEval}
          disabled={!jsInput.trim()}
          className="px-1.5 py-0.5 rounded text-[10px] text-text-tertiary hover:text-accent-brand hover:bg-bg-hover disabled:opacity-50"
        >
          ▶
        </button>
        {evalResult && (
          <details className="absolute bottom-8 right-3 max-w-md">
            <summary className="text-[10px] text-text-tertiary cursor-pointer">Result</summary>
            <pre className="mt-1 p-2 bg-bg-primary border border-border-subtle rounded text-[10px] font-mono text-text-secondary max-h-40 overflow-auto">
              {evalResult}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
