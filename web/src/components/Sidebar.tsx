import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useViewStore, type ViewName } from '../stores/viewStore';
import { useThemeStore } from '../stores/themeStore';
import { usePermissionStore } from '../stores/permissionStore';
import { useSessionStore } from '../stores/sessionStore';
import { normalizeLanguage, persistLanguage, type WebLanguage } from '../i18n';
import { notifySettingChanged, settingsApiFetch } from './settings/settingsApi';
import { UsageCard } from './sidebar/UsageCard';
import { SidebarVersionBadge } from './sidebar/SidebarVersionBadge';
import { BetaBadge } from './sidebar/BetaBadge';
import {
  MessageCircle, Server, ListTodo, Terminal, LayoutDashboard,
  FileCode, FileEdit, Puzzle, BarChart3, Activity, Cpu,
  Settings, Keyboard, BookOpen, ChevronLeft, ChevronRight, Sun, Moon,
  Monitor, AlertCircle, Languages, Plus, RefreshCw, BookMarked, GitBranch,
  Network, GalleryVerticalEnd, Users, Palette, Brain, LayoutGrid,
  Radar, GitCommitHorizontal, Swords,
} from 'lucide-react';

interface NavItem {
  view: ViewName;
  icon: React.ReactNode;
  labelKey: string;
  action?: () => void; // Optional action button (e.g. + for new chat)
  actionIcon?: React.ReactNode;
  actionTitle?: string;
  isBeta?: boolean;
}

const topNav: NavItem[] = [
  { view: 'chat', icon: <MessageCircle size={16} />, labelKey: 'sidebar.chatMode' },
  { view: 'workers', icon: <Server size={16} />, labelKey: 'sidebar.daemon' },
];

const workspaceNav: NavItem[] = [
  { view: 'tasks', icon: <ListTodo size={16} />, labelKey: 'sidebar.tasks' },  { view: 'jiange', icon: <Swords size={16} />, labelKey: 'sidebar.jiange', isBeta: true },
  { view: 'blueprint', icon: <LayoutGrid size={16} />, labelKey: 'sidebar.blueprint' },
  { view: 'blackboard', icon: <Network size={16} />, labelKey: 'sidebar.blackboard' },
  { view: 'terminal', icon: <Terminal size={16} />, labelKey: 'sidebar.terminalMode' },
  { view: 'canvas', icon: <LayoutDashboard size={16} />, labelKey: 'sidebar.canvas', isBeta: true },
  { view: 'artifact', icon: <GalleryVerticalEnd size={16} />, labelKey: 'sidebar.artifacts' },
  { view: 'editor', icon: <FileCode size={16} />, labelKey: 'sidebar.editor' },
  { view: 'changes', icon: <FileEdit size={16} />, labelKey: 'sidebar.changes' },
  { view: 'git', icon: <GitBranch size={16} />, labelKey: 'sidebar.git' },
  { view: 'git-activity', icon: <GitCommitHorizontal size={16} />, labelKey: 'sidebar.gitActivity', isBeta: true },
  { view: 'agent-activity', icon: <Activity size={16} />, labelKey: 'sidebar.agentActivity' },
  { view: 'wiki', icon: <BookMarked size={16} />, labelKey: 'sidebar.wiki' },
  { view: 'memory', icon: <Brain size={16} />, labelKey: 'sidebar.memory' },
  { view: 'plugins', icon: <Puzzle size={16} />, labelKey: 'sidebar.plugins' },
  { view: 'design-market', icon: <Palette size={16} />, labelKey: 'sidebar.designMarket', isBeta: true },
];

const observabilityNav: NavItem[] = [
  { view: 'stats', icon: <BarChart3 size={16} />, labelKey: 'sidebar.stats' },
  { view: 'traces', icon: <Activity size={16} />, labelKey: 'sidebar.traces' },
  { view: 'team', icon: <Users size={16} />, labelKey: 'sidebar.team' },
  { view: 'metrics', icon: <Cpu size={16} />, labelKey: 'sidebar.metrics' },
  { view: 'langfuse', icon: <Radar size={16} />, labelKey: 'sidebar.langfuse' },
];

const preferencesNav: NavItem[] = [
  { view: 'settings', icon: <Settings size={16} />, labelKey: 'sidebar.status' },
  { view: 'keybindings', icon: <Keyboard size={16} />, labelKey: 'sidebar.keybindings' },
  { view: 'docs', icon: <BookOpen size={16} />, labelKey: 'sidebar.docs' },
];

const appVersion = typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0
  ? __APP_VERSION__
  : 'dev';
const logoSrc = `/logo.svg?v=${appVersion}`;

function NavSection({ title, items, id }: { title: string; items: NavItem[]; id?: string }) {
  const { t } = useTranslation();
  const mainView = useViewStore((s) => s.mainView);
  const setMainView = useViewStore((s) => s.setMainView);
  const sidebarCollapsed = useViewStore((s) => s.sidebarCollapsed);
  const pendingPermissions = usePermissionStore((s) => s.pendingRequests.length);

  // 仅带标题的分组(WORKSPACE / OBSERVABILITY / PREFERENCES)可折叠;chat/workers 固定
  const collapsible = !!title;
  const storageKey = collapsible ? `lx.nav.collapsed.${id ?? title}` : null;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!storageKey) return false;
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      if (storageKey) { try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* noop */ } }
      return next;
    });
  };

  // 活跃项所在分组必须可见:折叠态下命中活跃项则强制展开,避免当前视图消失
  const hasActive = items.some((it) => it.view === mainView);
  const effectivelyCollapsed = collapsible && collapsed && !hasActive && !sidebarCollapsed;
  const showHeader = !sidebarCollapsed && !!title;

  return (
    <div className="mb-1">
      {showHeader && (
        <button
          type="button"
          onClick={collapsible ? toggle : undefined}
          aria-expanded={collapsible ? !effectivelyCollapsed : undefined}
          className={`w-full flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-text-tertiary uppercase ${
            collapsible ? 'group/hdr hover:text-text-secondary transition-colors' : 'cursor-default'
          }`}
        >
          <span className="flex-1 text-left">{title}</span>
          {collapsible && (
            <ChevronRight
              size={11}
              className={`text-text-tertiary/55 transition-transform duration-150 group-hover/hdr:text-text-secondary ${
                effectivelyCollapsed ? '' : 'rotate-90'
              }`}
            />
          )}
        </button>
      )}
      {!effectivelyCollapsed && items.map((item) => {
        const isActive = mainView === item.view;
        return (
          <button
            key={item.view}
            onClick={() => setMainView(item.view)}
            aria-current={isActive ? 'page' : undefined}
            className={`codex-nav-item w-full flex items-center gap-2.5 px-3 py-2 text-xs relative group
              ${sidebarCollapsed ? 'justify-center px-2' : ''}
              ${isActive ? 'is-active' : ''}
            `}
            title={sidebarCollapsed ? t(item.labelKey) : undefined}
          >
            <span className="transition-colors">
              {item.icon}
            </span>
            {!sidebarCollapsed && (
              <>
                <span className="font-medium text-[12px]">{t(item.labelKey)}</span>
                {item.isBeta && <BetaBadge className="ml-1.5" />}
              </>
            )}
            {/* Action button on the right side of nav item */}
            {item.action && !sidebarCollapsed && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); item.action!(); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); item.action!(); } }}
                className="ml-auto codex-icon-btn !h-6 !min-w-6 opacity-0 group-hover:opacity-100"
                title={item.actionTitle}
              >
                {item.actionIcon || <Plus size={12} />}
              </span>
            )}
            {item.view === 'changes' && pendingPermissions > 0 && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 bg-accent-red text-bg-primary text-[10px] font-mono px-1 min-w-4 h-4 flex items-center justify-center border border-accent-red">
                {pendingPermissions}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function Sidebar() {
  const { t, i18n } = useTranslation();
  const sidebarCollapsed = useViewStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useViewStore((s) => s.toggleSidebar);
  const mode = useThemeStore((s) => s.mode);
  const toggle = useThemeStore((s) => s.toggle);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const createAndConnect = useSessionStore((s) => s.createAndConnect);
  const [isCreating, setIsCreating] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);

  const themeIcon = mode === 'dark' ? <Moon size={14} /> : mode === 'light' ? <Sun size={14} /> : <Monitor size={14} />;
  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage) || normalizeLanguage(i18n.language) || 'zh';

  const setLocale = async (language: WebLanguage) => {
    await i18n.changeLanguage(language);
    persistLanguage(language);
    settingsApiFetch('/settings/general', {
      method: 'PUT',
      body: JSON.stringify({ key: 'uiLanguage', value: language }),
    }).then(() => notifySettingChanged({ key: 'uiLanguage', value: language })).catch(() => {});
    setLanguageMenuOpen(false);
  };

  const handleNewSession = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await createAndConnect();
    } finally {
      setIsCreating(false);
    }
  };

  const handleRefreshSessions = () => {
    fetchSessions();
  };

  // Inject action into chat nav item
  const chatNavItem: NavItem = {
    ...topNav[0],
    action: handleNewSession,
    actionIcon: isCreating ? <RefreshCw size={12} className="animate-spin" /> : <Plus size={12} />,
    actionTitle: t('chat.newSession', 'New Session'),
  };

  return (
    <div
      className={`codex-sidebar flex flex-col h-full border-r border-border-muted transition-all duration-200 relative ${
        sidebarCollapsed ? 'w-12' : 'w-60'
      }`}
    >
      {/* Header */}
      <div className={`lingxiao-cloud-line flex items-center px-2.5 py-2.5 sidebar-glow-top ${
        sidebarCollapsed ? 'justify-center' : 'justify-between'
      }`}>
        {!sidebarCollapsed ? (
          <div className="flex items-center gap-2">
            <img src={logoSrc} alt="" aria-hidden="true" className="lingxiao-logo-mark h-6 w-6 shrink-0" />
            <span className="sidebar-brand lingxiao-brand text-[13px] font-semibold">
              {t('sidebar.brand')}
            </span>
            <span className="text-[11px] text-text-tertiary">v{appVersion}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={toggleSidebar}
            className="sidebar-collapsed-expand"
            title={t('sidebar.toggle')}
            aria-label={t('sidebar.toggle')}
          >
            <img src={logoSrc} alt="" aria-hidden="true" className="lingxiao-logo-mark h-7 w-7" />
            <ChevronRight size={11} className="sidebar-collapsed-expand-icon" aria-hidden="true" />
          </button>
        )}
        {!sidebarCollapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            className="codex-icon-btn !h-7 !min-w-7"
            title={t('sidebar.toggle')}
            aria-label={t('sidebar.toggle')}
          >
            <ChevronLeft size={14} />
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="cyber-divider" />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {/* Chat nav with + button */}
        <NavSection title="" items={[chatNavItem]} />
        <NavSection title="" items={topNav.slice(1)} />
        <div className="cyber-divider my-1" />
        <NavSection title={t('sidebar.workspace')} id="workspace" items={workspaceNav} />
        <div className="cyber-divider my-1" />
        <NavSection title={t('sidebar.group.observability', 'OBSERVABILITY')} id="observability" items={observabilityNav} />
        <UsageCard />
        <NavSection title={t('sidebar.preferences')} id="preferences" items={preferencesNav} />
      </nav>

      {/* Bottom divider */}
      <div className="cyber-divider" />

      {/* Footer */}
      <div className="relative px-2 py-2 flex items-center gap-1.5">
        <button
          onClick={toggle}
          className="codex-icon-btn !h-7 !min-w-7"
          title={t(`theme.${mode}`)}
          aria-label={t(`theme.${mode}`)}
        >
          {themeIcon}
        </button>
        <button
          onClick={() => setLanguageMenuOpen((open) => !open)}
          className="codex-icon-btn !h-7 !min-w-7"
          title={currentLanguage === 'zh' ? t('sidebar.switchToEnglish') : t('sidebar.switchToChinese')}
          aria-label={currentLanguage === 'zh' ? t('sidebar.switchToEnglish') : t('sidebar.switchToChinese')}
        >
          <Languages size={14} />
        </button>
        {languageMenuOpen && (
          <div className="sidebar-language-menu">
            <button
              type="button"
              className={currentLanguage === 'zh' ? 'is-active' : ''}
              onClick={() => void setLocale('zh')}
            >
              <span>中文</span>
              <small>ZH</small>
            </button>
            <button
              type="button"
              className={currentLanguage === 'en' ? 'is-active' : ''}
              onClick={() => void setLocale('en')}
            >
              <span>English</span>
              <small>EN</small>
            </button>
          </div>
        )}
        <button
          onClick={handleRefreshSessions}
          className="codex-icon-btn !h-7 !min-w-7"
          title={t('chat.refresh', 'Refresh')}
          aria-label={t('chat.refresh', 'Refresh')}
        >
          <RefreshCw size={14} />
        </button>
        {!sidebarCollapsed && (
          <>
            <span className="text-[10px] text-text-tertiary">
              {currentLanguage === 'zh' ? '中' : 'EN'}
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-text-tertiary">
              <SidebarVersionBadge />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
