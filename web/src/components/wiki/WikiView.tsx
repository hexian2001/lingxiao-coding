import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useWikiStore } from '../../stores/wikiStore';
import { useSessionStore } from '../../stores/sessionStore';
import WikiHeader from './WikiHeader';
import WikiSidebar from './WikiSidebar';
import WikiDocument from './WikiDocument';
import WikiProgress from './WikiProgress';
import { RotateCcw, X, Zap, RefreshCw, Globe, Package } from 'lucide-react';

export default function WikiView() {
  const { t } = useTranslation();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const serverCwd = useSessionStore((s) => s.serverCwd);
  const fetchStatus = useWikiStore((s) => s.fetchStatus);
  const fetchDocuments = useWikiStore((s) => s.fetchDocuments);
  const fetchCheckpoint = useWikiStore((s) => s.fetchCheckpoint);
  const generateWiki = useWikiStore((s) => s.generateWiki);
  const status = useWikiStore((s) => s.status);
  const lang = useWikiStore((s) => s.lang);
  const error = useWikiStore((s) => s.error);
  const clearError = useWikiStore((s) => s.clearError);
  const isGenerating = useWikiStore((s) => s.isGenerating);
  const checkpoint = useWikiStore((s) => s.checkpoint);

  const isLoading = useWikiStore((s) => s.isLoading);

  // 优先用 session workspace，其次 serverCwd（启动目录）
  const projectPath = useMemo(() => {
    if (!activeSessionId || sessions.length === 0) return serverCwd || '';
    const active = sessions.find((s) => s.id === activeSessionId);
    return active?.workspace || serverCwd || '';
  }, [serverCwd, activeSessionId, sessions]);

  useEffect(() => {
    if (projectPath) {
      fetchStatus(projectPath);
      fetchCheckpoint(projectPath);
    }
  }, [projectPath, lang, fetchStatus, fetchCheckpoint]);

  useEffect(() => {
    if (status?.exists && projectPath) {
      fetchDocuments(projectPath);
    }
  }, [status?.exists, projectPath, lang, fetchDocuments]);

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <WikiHeader projectPath={projectPath} />

      {/* 断点续传提示条 */}
      {checkpoint && !isGenerating && (
        <div className="px-4 py-2 bg-accent-brand/8 border-b border-accent-brand/20 flex items-center gap-3 shrink-0">
          <RotateCcw size={13} className="text-accent-brand shrink-0" />
          <span className="text-xs text-accent-brand flex-1">
            {t('wiki.checkpoint.banner', { count: checkpoint.completedCount })}
          </span>
          <button
            onClick={() => generateWiki(projectPath)}
            className="px-3 py-1 text-xs bg-accent-brand/20 border border-accent-brand/40 text-accent-brand rounded hover:bg-accent-brand/30 transition-colors font-medium shrink-0"
          >
            {t('wiki.checkpoint.resume')}
          </button>
          <button
            onClick={() => useWikiStore.setState({ checkpoint: null })}
            className="text-xs text-text-tertiary hover:text-text-secondary shrink-0"
          >
            {t('wiki.checkpoint.dismiss')}
          </button>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div className="px-4 py-2 bg-error-bg text-accent-red text-xs flex items-center justify-between border-b border-accent-red/20">
          <span>{error}</span>
          <button onClick={clearError} className="hover:text-accent-red/70 ml-4"><X size={14} /></button>
        </div>
      )}

      {/* 生成中 — 大白盒进度全屏展示 */}
      {isGenerating ? (
        <WikiProgress />
      ) : isLoading || status === null ? (
        /* 加载中 — 还没拿到 status，不能判定为空 */
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-accent-brand/30 border-t-accent-brand rounded-full animate-spin" />
            <span className="text-xs text-text-tertiary">Loading...</span>
          </div>
        </div>
      ) : !status?.exists ? (
        /* 空状态 — 确认无 Wiki */
        <WikiEmptyState projectPath={projectPath} />
      ) : (
        /* 正常浏览模式 */
        <div className="flex flex-1 min-h-0">
          <div className="w-52 shrink-0 border-r border-border-default flex flex-col bg-bg-secondary">
            <WikiSidebar />
          </div>
          <div className="flex-1 flex flex-col min-w-0">
            <WikiDocument />
          </div>
        </div>
      )}
    </div>
  );
}

/** 空状态组件 */
function WikiEmptyState({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation();
  const generateWiki = useWikiStore((s) => s.generateWiki);
  const lang = useWikiStore((s) => s.lang);
  const setLang = useWikiStore((s) => s.setLang);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-6 max-w-md text-center px-4">
        {/* 图标 — 发光效果 */}
        <div className="relative">
          <div className="w-20 h-20 rounded-2xl bg-bg-secondary border border-border-default flex items-center justify-center"
               style={{ boxShadow: 'var(--glow-brand)' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                 className="text-accent-brand">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
              <path d="M8 7h6M8 11h8" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* 标题 */}
        <div>
          <h2 className="text-lg font-bold text-text-primary mb-1">Repo Wiki</h2>
          <p className="text-xs text-text-secondary leading-relaxed">
            {t('wiki.emptyState.desc')}
          </p>
        </div>

        {/* 语言选择 */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary">{t('wiki.emptyState.langLabel')}</span>
          <div className="flex items-center gap-1 bg-bg-tertiary rounded-lg px-1 py-0.5">
            <button
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                lang === 'zh'
                  ? 'bg-accent-brand text-bg-primary font-medium'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => setLang('zh')}
            >
              {t('wiki.lang.zh')}
            </button>
            <button
              className={`px-3 py-1 text-xs rounded-md transition-all ${
                lang === 'en'
                  ? 'bg-accent-brand text-bg-primary font-medium'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => setLang('en')}
            >
              {t('wiki.lang.en')}
            </button>
          </div>
        </div>

        {/* 生成按钮 */}
        <button
          className="px-6 py-2.5 text-sm font-medium bg-accent-brand text-bg-primary rounded-lg hover:opacity-90 transition-all disabled:opacity-40"
          style={{ boxShadow: 'var(--glow-brand)' }}
          onClick={() => generateWiki(projectPath)}
          disabled={!projectPath}
        >
          {t('wiki.emptyState.generateBtn')}
        </button>

        {!projectPath && (
          <p className="text-[11px] text-text-tertiary">{t('wiki.emptyState.needSession')}</p>
        )}

        {/* 特性说明 */}
        <div className="flex gap-6 mt-2">
          {[
            { icon: <Zap size={18} />, key: 'wiki.emptyState.feat.arch' },
            { icon: <RefreshCw size={18} />, key: 'wiki.emptyState.feat.incr' },
            { icon: <Globe size={18} />, key: 'wiki.emptyState.feat.i18n' },
            { icon: <Package size={18} />, key: 'wiki.emptyState.feat.git' },
          ].map(({ icon, key }) => (
            <div key={key} className="flex flex-col items-center gap-1">
              <span className="text-accent-brand">{icon}</span>
              <span className="text-[10px] text-text-tertiary">{t(key)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
