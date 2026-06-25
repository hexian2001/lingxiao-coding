import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Crosshair,
  Globe,
  Loader2,
  MessageSquare,
  Monitor,
  MousePointer2,
  Plus,
  Quote,
  RefreshCw,
  Send,
  X,
  Hand,
  Code2,
  Sparkles,
  Keyboard,
} from 'lucide-react';
import { browserClient } from '../../api/BrowserClient';
import { useBrowserStore } from '../../stores/browserStore';
import { getServerToken } from '../../api/headers';
import { BrowserScreencastCanvas } from './BrowserScreencastCanvas';

interface BrowserDockProps {
  workspaceName?: string;
  onInsertPrompt: (prompt: string) => void;
  onSendPrompt: (prompt: string) => void | Promise<void>;
}

const INTENTS = [
  { value: 'fix', labelKey: 'browser.intent.fix', fallback: '修' },
  { value: 'style', labelKey: 'browser.intent.style', fallback: '样式' },
  { value: 'review', labelKey: 'browser.intent.review', fallback: '审' },
  { value: 'explain', labelKey: 'browser.intent.explain', fallback: '问' },
] as const;

export default function BrowserDock({ workspaceName, onInsertPrompt, onSendPrompt }: BrowserDockProps) {
  const { t } = useTranslation();
  const {
    sessions,
    activeSessionId,
    session,
    screenshotUrl,
    selection,
    isInspecting,
    isLoading,
    error,
    health,
    healthError,
    intent,
    loadHealth,
    loadSessions,
    newSession,
    closeSession,
    setActiveSession,
    openUrl,
    refreshScreenshot,
    inspectAt,
    setInspecting,
    setIntent,
    clearSelection,
  } = useBrowserStore();
  const [url, setUrl] = useState('http://localhost:5173');
  const [comment, setComment] = useState('');
  const [commentBusy, setCommentBusy] = useState<'insert' | 'send' | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);  // v1.0.5: 交互模式
  const {
    interactionMode,
    setInteractionMode,
    clickAt,
    scrollBy,
    patchElement,
    evalJs,
  } = useBrowserStore();
  const [showHtmlEdit, setShowHtmlEdit] = useState(false);
  const [htmlEditContent, setHtmlEditContent] = useState('');
  const [jsInput, setJsInput] = useState('');
  const [evalResult, setEvalResult] = useState<string | null>(null);
  const [clickRipple, setClickRipple] = useState<{ x: number; y: number } | null>(null);  const [inputText, setInputText] = useState('');
  const [inputMode, setInputMode] = useState(false);
  const [lastClickPos, setLastClickPos] = useState<{ x: number; y: number } | null>(null);

  // v1.0.5: 键盘输入
  const { typeText, pressKey, typeAt } = useBrowserStore();

  const submitInput = async () => {
    if (!inputText || !session) return;
    if (lastClickPos) {
      await typeAt(lastClickPos.x, lastClickPos.y, inputText);
    } else {
      await typeText(inputText);
    }
    setInputText('');
  };

  useEffect(() => {
    void loadHealth(false);
    void loadSessions();
  }, [loadHealth, loadSessions]);

  const suggestions = useMemo(() => {
    const host = window.location.hostname || 'localhost';
    return Array.from(new Set([
      `http://${host}:5173`,
      `http://${host}:3000`,
      `http://${host}:8080`,
    ]));
  }, []);

  const selectionStyle = selection ? {
    left: `${(selection.rect.x / Math.max(1, selection.viewport.width)) * 100}%`,
    top: `${(selection.rect.y / Math.max(1, selection.viewport.height)) * 100}%`,
    width: `${(selection.rect.width / Math.max(1, selection.viewport.width)) * 100}%`,
    height: `${(selection.rect.height / Math.max(1, selection.viewport.height)) * 100}%`,
  } : undefined;

  const openCurrentUrl = () => {
    const next = url.trim();
    if (!next) return;
    void openUrl(next);
  };

  const handleViewportClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!session || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const relX = (event.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (event.clientY - rect.top) / Math.max(1, rect.height);
    const x = relX * session.viewport.width;
    const y = relY * session.viewport.height;

    // v1.0.5: 默认点击模式 → 真实点击；检视模式 → 选中元素
    if (interactionMode === 'inspect' || isInspecting) {
      void inspectAt(x, y);
    } else {
      // 真实点击!
      setClickRipple({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      setTimeout(() => setClickRipple(null), 600);
      setLastClickPos({ x, y });
      void clickAt(x, y);
    }
  };

  const handleViewportWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!session) return;
    void scrollBy(0, event.deltaY);
  };

  const submitDirectPatch = async () => {
    if (!selection || !comment.trim()) return;
    const isHtml = comment.trim().startsWith('<');
    const applied = await patchElement(selection.selector, {
      html: isHtml ? comment.trim() : undefined,
      text: isHtml ? undefined : comment.trim(),
    });
    if (applied) {
      setComment('');
      setShowHtmlEdit(false);
    }
  };

  const submitEval = async () => {
    if (!jsInput.trim()) return;
    const result = await evalJs(jsInput);
    setEvalResult(JSON.stringify(result, null, 2));
  };

  const buildPrompt = async (mode: 'insert' | 'send') => {
    if (!session || !selection || !comment.trim()) return;
    setCommentBusy(mode);
    try {
      const result = await browserClient.comment(session.id, selection, comment.trim(), intent);
      if (mode === 'insert') onInsertPrompt(result.prompt);
      else await onSendPrompt(result.prompt);
      setComment('');
    } finally {
      setCommentBusy(null);
    }
  };

  return (
    <section className="browser-dock-shell browser-dock-shell--expanded">
      <div className="browser-dock-header">
        <div className="browser-dock-title">
          <Globe size={15} />
          <span>{t('browser.title', 'Browser')}</span>
          {workspaceName && <span className="browser-dock-workspace">{workspaceName}</span>}
        </div>
        <div className="browser-dock-actions">
          <button type="button" className="codex-icon-btn !h-8 !min-w-8" onClick={() => void newSession()} title={t('browser.newTab', '新建浏览器标签')}>
            <Plus size={15} />
          </button>
          <button
            type="button"
            className={`codex-icon-btn !h-8 !min-w-8 ${isInspecting ? 'browser-action-active' : ''}`}
            onClick={() => setInspecting(!isInspecting)}
            title={isInspecting ? t('browser.stopInspect', '停止选择元素') : t('browser.inspect', '选择元素')}
          >
            <MousePointer2 size={15} />
          </button>
          <button type="button" className="codex-icon-btn !h-8 !min-w-8" onClick={refreshScreenshot} title={t('browser.refresh', '刷新截图')} disabled={!session}>
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="browser-tab-strip">
        {sessions.length === 0 ? (
          <button type="button" className="browser-tab-card is-empty" onClick={() => void newSession()}>
            <Monitor size={15} />
            <span>{t('browser.newTabShort', '新建标签')}</span>
          </button>
        ) : sessions.map((item) => (
          <div
            key={item.id}
            className={`browser-tab-card ${item.id === activeSessionId ? 'is-active' : ''}`}
            title={item.url || item.title || item.id}
          >
            <button
              type="button"
              className="browser-tab-main"
              onClick={() => setActiveSession(item.id)}
            >
              <Globe size={14} />
              <span className="browser-tab-copy">
                <span>{item.title || item.url || 'Untitled'}</span>
                <small>{item.url === 'about:blank' ? 'about:blank' : item.url.replace(/^https?:\/\//, '')}</small>
              </span>
            </button>
            <button
              type="button"
              className="browser-tab-close"
              title={t('browser.closeTab', '关闭标签')}
              onClick={(event) => {
                event.stopPropagation();
                void closeSession(item.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="browser-url-row">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') openCurrentUrl();
          }}
          className="browser-url-input"
          placeholder="http://localhost:5173"
        />
        <button type="button" className="browser-go-btn" onClick={openCurrentUrl} disabled={isLoading || !url.trim()} title={t('browser.open', '打开')}>
          {isLoading && !screenshotUrl ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
        </button>
      </div>

      {!session && (
        <div className="browser-suggestion-row">
          {suggestions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => { setUrl(item); void openUrl(item); }}
              className="browser-suggestion"
            >
              {item.replace(/^https?:\/\//, '')}
            </button>
          ))}
        </div>
      )}

      {/* v1.0.5: 交互模式切换 */}
      {session && (
        <div className="browser-mode-bar">
          <button
            type="button"
            className={`browser-mode-btn ${interactionMode === 'click' && !isInspecting ? 'is-active' : ''}`}
            onClick={() => setInteractionMode('click')}
            title="点击模式：直接点击页面元素"
          >
            <MousePointer2 size={13} />
            <span>点击</span>
          </button>
          <button
            type="button"
            className={`browser-mode-btn ${interactionMode === 'inspect' || isInspecting ? 'is-active' : ''}`}
            onClick={() => setInteractionMode('inspect')}
            title="检视模式：点击选中元素"
          >
            <Crosshair size={13} />
            <span>检视</span>
          </button>
          <div className="flex-1" />
          <input
            value={jsInput}
            onChange={(e) => setJsInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitEval()}
            placeholder="执行JS: document.title"
            className="browser-js-input"
          />
          <button type="button" className="browser-mode-btn" onClick={submitEval} title="执行">
            <Code2 size={13} />
          </button>
          {evalResult && (
            <details className="browser-eval-result">
              <summary className="text-[10px] text-text-tertiary cursor-pointer">Result</summary>
              <pre className="mt-1 p-1.5 bg-bg-primary border border-border-subtle rounded text-[10px] font-mono text-text-secondary max-h-32 overflow-auto">{evalResult}</pre>
            </details>
          )}
        </div>
      )}

      {/* v1.0.5: 文本输入栏 */}
      {session && (
        <div className="browser-input-bar">
          <Keyboard size={13} className="text-text-tertiary shrink-0" />
          <input
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submitInput(); }
            }}
            placeholder={lastClickPos ? "输入文字后回车，将输入到刚才点击的位置..." : "先点击页面上的输入框，再在此输入文字..."}
            className="browser-text-input"
          />
          <button type="button" onClick={() => void submitInput()} disabled={!inputText || isLoading} className="browser-mode-btn is-active" title="输入到页面">
            <Send size={12} />
          </button>
        </div>
      )}
      {error && (
        <div className="browser-error">
          <X size={13} />
          <span>{error}</span>
        </div>
      )}

      {(healthError || health?.diagnostics.length || health?.resolvedExecutablePath || health?.installCommand) && (
        <div className={`browser-health ${health?.executableExists ? 'is-ready' : 'is-warning'}`}>
          <div className="browser-health-main">
            <span>{health?.executableExists ? t('browser.health.ready', 'Runtime ready') : t('browser.health.setup', 'Runtime setup')}</span>
            <small>{health?.resolvedExecutablePath || health?.expectedExecutablePath || healthError || t('browser.health.noExecutable', 'No browser executable detected')}</small>
          </div>
          {health?.resolvedExecutableSource && <small>source: {health.resolvedExecutableSource}</small>}
          {health?.installCommand && !health.executableExists && <code>{health.installCommand}</code>}
          {health?.installDepsCommand && !health.executableExists && <code>{health.installDepsCommand}</code>}
          {health?.diagnostics.map((item) => <small key={item} className="browser-health-note">{item}</small>)}
        </div>
      )}

      <div className={`browser-workspace ${selection ? 'has-selection' : ''}`}>
        <div className="browser-preview-column">
          {/* v1.0.5: CDP Screencast — 实时画面 + 原生输入转发 */}
          {session ? (
            <BrowserScreencastCanvas
              sessionId={session.id}
              width={session.viewport.width}
              height={session.viewport.height}
            />
          ) : (
            <div className="browser-empty">
              <Crosshair size={28} />
              <span>{t('browser.empty', '打开页面后点击交互')}</span>
            </div>
          )}
          {session && (
            <div className="browser-page-meta">
              <span className="truncate">{session.title || 'Untitled'}</span>
              <span>{session.viewport.width}x{session.viewport.height}</span>
            </div>
          )}
        </div>

        <div className={`browser-selection-panel ${selection ? '' : 'is-placeholder'}`}>
          {!selection ? (
            <div className="browser-inspector-placeholder">
              <MousePointer2 size={20} />
              <span>{t('browser.inspectPlaceholder', '点击页面截图选择元素')}</span>
            </div>
          ) : (
            <>
              <div className="browser-selection-head">
                <div className="min-w-0">
                  <div className="browser-selection-tag">{selection.tag}{selection.role ? ` · ${selection.role}` : ''}</div>
                  <div className="browser-selection-selector" title={selection.selector}>{selection.selector}</div>
                </div>
                <button type="button" className="codex-icon-btn !h-7 !min-w-7" onClick={clearSelection} title={t('browser.clearSelection', '清除选择')}>
                  <X size={13} />
                </button>
              </div>
              {selection.text && <div className="browser-selection-text">{selection.text}</div>}
              <div className="browser-intent-row">
                {INTENTS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setIntent(item.value)}
                    className={intent === item.value ? 'is-active' : ''}
                  >
                    {t(item.labelKey, item.fallback)}
                  </button>
                ))}
              </div>
              <div className="browser-comment-box">
                <MessageSquare size={14} />
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void buildPrompt('send');
                    }
                  }}
                  placeholder={t('browser.commentPlaceholder', '评论这个元素...')}
                  rows={3}
                />
              </div>
              <div className="browser-comment-actions">
                <button
                  type="button"
                  onClick={() => void buildPrompt('insert')}
                  disabled={!comment.trim() || !!commentBusy}
                  className="browser-secondary-btn"
                >
                  {commentBusy === 'insert' ? <Loader2 size={13} className="animate-spin" /> : <Quote size={13} />}
                  {t('browser.quote', '引用')}
                </button>
                <button
                  type="button"
                  onClick={() => void buildPrompt('send')}
                  disabled={!comment.trim() || !!commentBusy}
                  className="browser-primary-btn"
                >
                  {commentBusy === 'send' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  {t('browser.send', '发送')}
                </button>
              </div>              <div className="browser-comment-actions">
                {/* v1.0.5: 直接修改 HTML */}
                <button
                  type="button"
                  onClick={() => void submitDirectPatch()}
                  disabled={!comment.trim() || isLoading}
                  className="browser-direct-patch-btn"
                  title="输入文本替换内容，或输入 <html> 替换 HTML，直接修改页面"
                >
                  {isLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  直接修改
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => { setShowHtmlEdit(!showHtmlEdit); if (!showHtmlEdit) setHtmlEditContent(selection.htmlSnippet); }}
                  className="browser-secondary-btn"
                  title="编辑选中元素的 HTML"
                >
                  <Code2 size={13} />
                  HTML
                </button>
                <button
                  type="button"
                  onClick={() => void buildPrompt('insert')}
                  disabled={!comment.trim() || !!commentBusy}
                  className="browser-secondary-btn"
                >
                  {commentBusy === 'insert' ? <Loader2 size={13} className="animate-spin" /> : <Quote size={13} />}
                  {t('browser.quote', '引用')}
                </button>
                <button
                  type="button"
                  onClick={() => void buildPrompt('send')}
                  disabled={!comment.trim() || !!commentBusy}
                  className="browser-primary-btn"
                >
                  {commentBusy === 'send' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  {t('browser.send', '发送')}
                </button>
              </div>
              {showHtmlEdit && (
                <div className="browser-html-edit">
                  <textarea
                    value={htmlEditContent}
                    onChange={(e) => setHtmlEditContent(e.target.value)}
                    className="browser-html-textarea"
                    rows={5}
                    spellCheck={false}
                  />
                  <div className="flex gap-1.5 mt-1">
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await patchElement(selection.selector, { html: htmlEditContent });
                        if (ok) setShowHtmlEdit(false);
                      }}
                      className="browser-primary-btn"
                    >
                      <Sparkles size={13} /> 应用修改
                    </button>
                    <button type="button" onClick={() => setShowHtmlEdit(false)} className="browser-secondary-btn">
                      取消
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
