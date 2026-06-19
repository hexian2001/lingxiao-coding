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
} from 'lucide-react';
import { browserClient } from '../../api/BrowserClient';
import { useBrowserStore } from '../../stores/browserStore';

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
  const imageRef = useRef<HTMLImageElement>(null);

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
    if (!session || !isInspecting || !imageRef.current) return;
    const rect = imageRef.current.getBoundingClientRect();
    const relX = (event.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (event.clientY - rect.top) / Math.max(1, rect.height);
    const x = relX * session.viewport.width;
    const y = relY * session.viewport.height;
    void inspectAt(x, y);
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
          {health?.resolvedExecutableSource && (
            <small className="browser-health-note">{health.resolvedExecutableSource}</small>
          )}
          {health && !health.playwrightCliExists && (
            <small className="browser-health-note">Playwright CLI missing</small>
          )}
          {health && health.detectedCandidates.length > 0 && !health.executableExists && (
            <small className="browser-health-note">{health.detectedCandidates.length} candidates checked</small>
          )}
          {!health?.executableExists && health?.installCommand && (
            <code>{health.installCommand}</code>
          )}
          {health?.installDepsCommand && !health.executableExists && (
            <code>{health.installDepsCommand}</code>
          )}
          {health?.diagnostics.map((item) => (
            <small key={item} className="browser-health-note">{item}</small>
          ))}
        </div>
      )}

      <div className={`browser-workspace ${selection ? 'has-selection' : ''}`}>
        <div className="browser-preview-column">
          <div className={`browser-viewport ${isInspecting ? 'is-inspecting' : ''}`} onClick={handleViewportClick}>
            {screenshotUrl ? (
              <>
                <img
                  ref={imageRef}
                  src={screenshotUrl}
                  alt={session?.title || session?.url || 'Browser screenshot'}
                  onLoad={() => {
                    if (!session) return;
                    setUrl(session.url && session.url !== 'about:blank' ? session.url : url);
                  }}
                  draggable={false}
                />
                {selection && <div className="browser-selection-box" style={selectionStyle} />}
                {isLoading && (
                  <div className="browser-loading-overlay">
                    <Loader2 size={20} className="animate-spin" />
                  </div>
                )}
              </>
            ) : (
              <div className="browser-empty">
                <Crosshair size={28} />
                <span>{t('browser.empty', '打开页面后点选元素')}</span>
              </div>
            )}
          </div>
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
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
