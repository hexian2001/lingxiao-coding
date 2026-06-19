import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  ChevronDown,
  BookOpen,
  Copy,
  FileText,
  GitBranch,
  Github,
  GitPullRequest,
  Globe,
  LayoutGrid,
  Loader2,
  MessageCirclePlus,
  PanelRightClose,
  Plus,
  RefreshCw,
  Send,
  SlidersHorizontal,
  TerminalSquare,
  X,
  XCircle,
} from 'lucide-react';
import { useGitStore } from '../../stores/gitStore';
import { useViewStore } from '../../stores/viewStore';
import type { WorkbenchContext } from './workbenchTypes';
import BrowserDock from '../browser/BrowserDock';
import { useArtifactStore } from '../../stores/artifactStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorktreeStore, type WorktreeInfo } from '../../stores/worktreeStore';
import { collectEvidenceReferences, type EvidenceReference } from '../../utils/evidenceReferences';
import { buildDeliveryEvidence, type DeliveryEvidenceArtifactRef, type DeliveryEvidenceViewModel } from '../../utils/deliveryEvidence';
import ConfirmationDialog from '../ui/ConfirmationDialog';
import { normalizeLeaderStatusKind, normalizeWorktreeStatus, runtimeImpliesBusy } from '@contracts/adapters/StatusAdapter';
import { AcpClient } from '../../api/AcpClient';
import { getServerToken } from '../../api/headers';
import { estimateTokens, formatTokenCount } from '../../utils/estimateTokens';
import { SessionUpdateKind, subscribeSessionUpdateEvents } from '../../stores/sseStore';

export type WorkbenchTool = 'launcher' | 'browser' | 'review' | 'terminal' | 'artifact' | 'references' | 'worktrees' | 'side-chat';
export type WorkbenchToolRequest = {
  tool: WorkbenchTool;
  id: number;
};

interface WorkbenchSidePanelProps {
  context: WorkbenchContext | null;
  isLoading: boolean;
  error: string | null;
  terminalOpen: boolean;
  toolRequest?: WorkbenchToolRequest | null;
  onRefresh: () => void;
  onCollapse: () => void;
  onToggleTerminal: () => void;
  onInsertBrowserPrompt: (prompt: string) => void;
  onSendBrowserPrompt: (prompt: string) => void | Promise<void>;
}

interface WorkbenchTab {
  id: string;
  tool: WorkbenchTool;
}
const ARTIFACT_TAB_ID = 'workbench-artifact';
const logoSrc = `/logo.svg?v=${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`;
const WORKBENCH_DEFAULT_WIDTH = 420;
const TerminalPane = lazy(() => import('../canvas/TerminalPane'));
const ArtifactView = lazy(() => import('../artifacts/ArtifactView'));

function WorkbenchPaneLoading() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
      <span className="mr-2 h-3 w-3 rounded-full border-2 border-accent-brand border-t-transparent animate-spin" />
      Loading tool...
    </div>
  );
}

function getWorkbenchMaxWidth(): number {
  return typeof window === 'undefined' ? 1200 : Math.max(420, window.innerWidth - 520);
}

function clampWorkbenchWidth(width: number, minWidth: number, maxWidth = getWorkbenchMaxWidth()): number {
  return Math.min(maxWidth, Math.max(minWidth, width));
}

function getWorkbenchMinWidth(tool: WorkbenchTool): number {
  if (tool === 'browser') return 780;
  if (tool === 'terminal') return 480;
  if (tool === 'artifact') return 560;
  if (tool === 'references') return 360;
  if (tool === 'worktrees') return 400;
  if (tool === 'side-chat') return 420;
  return 320;
}

function getWorkbenchPreferredWidth(tool: WorkbenchTool, baseWidth: number): number {
  if (tool === 'browser') return Math.max(baseWidth, 1120);
  if (tool === 'terminal') return Math.max(baseWidth, 560);
  if (tool === 'artifact') return Math.max(baseWidth, 620);
  if (tool === 'references') return Math.max(baseWidth, 420);
  if (tool === 'worktrees') return Math.max(baseWidth, 460);
  if (tool === 'side-chat') return Math.max(baseWidth, 520);
  return baseWidth;
}

function formatRemote(context: WorkbenchContext | null): string {
  const platform = context?.git.platform;
  if (!platform || platform.platform === 'none') return '暂无远程';
  if (platform.owner && platform.repo) return `${platform.owner}/${platform.repo}`;
  return platform.platform;
}

export default function WorkbenchSidePanel({
  context,
  isLoading,
  error,
  terminalOpen,
  toolRequest,
  onRefresh,
  onCollapse,
  onToggleTerminal,
  onInsertBrowserPrompt,
  onSendBrowserPrompt,
}: WorkbenchSidePanelProps) {
  const { t } = useTranslation();
  const setMainView = useViewStore((s) => s.setMainView);
  const activeArtifact = useArtifactStore((s) => s.activeArtifact);
  const openArtifact = useArtifactStore((s) => s.openArtifact);
  const messages = useSessionStore((s) => s.messages);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const sessionId = useSessionStore((s) => s.sessionId || s.activeSessionId);
  const createAndConnect = useSessionStore((s) => s.createAndConnect);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const worktreeLoading = useWorktreeStore((s) => s.isLoading);
  const worktreeError = useWorktreeStore((s) => s.error);
  const fetchWorktrees = useWorktreeStore((s) => s.fetchWorktrees);
  const createWorktree = useWorktreeStore((s) => s.createWorktree);
  const attachSession = useWorktreeStore((s) => s.attachSession);
  const mergeWorktree = useWorktreeStore((s) => s.mergeWorktree);
  const removeWorktree = useWorktreeStore((s) => s.removeWorktree);
  const pruneWorktrees = useWorktreeStore((s) => s.pruneWorktrees);
  const fetchWorktreeDiff = useWorktreeStore((s) => s.fetchWorktreeDiff);
  const commitWorktree = useWorktreeStore((s) => s.commitWorktree);
  const { status, push, commit, stageFiles, fetchMRs, mrs, isLoading: gitLoading, isMRLoading, setWorkspace } = useGitStore();
  const [tabs, setTabs] = useState<WorkbenchTab[]>(() => [{ id: 'workbench-launcher', tool: 'launcher' }]);
  const [activeTabId, setActiveTabId] = useState('workbench-launcher');
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const toolMenuBtnRef = useRef<HTMLButtonElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  // 点击外部关闭「+工具」菜单
  useEffect(() => {
    if (!toolMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (toolMenuBtnRef.current?.contains(target) || toolMenuRef.current?.contains(target)) return;
      setToolMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [toolMenuOpen]);
  const [commitMessage, setCommitMessage] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const activeTool = activeTab?.tool || 'launcher';
  const [basePanelWidth, setBasePanelWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('lingxiao_workbench_base_panel_width'));
      if (Number.isFinite(stored) && stored >= 320) {
        return clampWorkbenchWidth(stored, getWorkbenchMinWidth('launcher'));
      }
    } catch (error) {
      console.warn('[WorkbenchSidePanel] Failed to read stored panel width:', error);
    }
    return WORKBENCH_DEFAULT_WIDTH;
  });
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('lingxiao_workbench_base_panel_width'));
      if (Number.isFinite(stored) && stored >= 320) {
        return clampWorkbenchWidth(stored, getWorkbenchMinWidth('launcher'));
      }
    } catch (error) {
      console.warn('[WorkbenchSidePanel] Failed to read stored panel width:', error);
    }
    return WORKBENCH_DEFAULT_WIDTH;
  });

  const activeStatus = status || context?.git.status || null;
  const evidenceReferences = useMemo(() => collectEvidenceReferences(messages), [messages]);
  const deliveryEvidence = useMemo(() => buildDeliveryEvidence({
    sessionId,
    messages,
    agentConversations,
    evidenceReferences,
    limit: 6,
  }), [agentConversations, evidenceReferences, messages, sessionId]);
  const counts = context?.git.counts;
  const changedFiles = counts?.total ?? 0;
  const branch = activeStatus?.branch || context?.git.status?.branch || 'git';
  const remoteLabel = formatRemote(context);
  const workspaceName = context?.workspace.name || 'workspace';
  const repoRoot = context?.worktree?.repo_root || context?.workspace.path || '';
  const prCountLabel = useMemo(() => {
    if (isMRLoading) return t('workbench.checkingPrs', '正在检查拉取请求');
    if (!context?.git.platform || context.git.platform.platform === 'none') return t('workbench.platformMissing', '未配置平台');
    return mrs.length > 0 ? t('workbench.prCount', '{{count}} 个拉取请求', { count: mrs.length }) : t('workbench.noPrs', '暂无拉取请求');
  }, [context?.git.platform, isMRLoading, mrs.length, t]);

  useEffect(() => {
    if (!context?.workspace.path) return;
    if (!context.git.platform || context.git.platform.platform === 'none') return;
    setWorkspace(context.workspace.path);
    void fetchMRs('open');
  }, [context?.workspace.path, context?.git.platform?.platform, fetchMRs, setWorkspace]);

  useEffect(() => {
    if (!repoRoot) return;
    void fetchWorktrees({ repoRoot });
  }, [fetchWorktrees, repoRoot]);

  const runAction = async (name: string, fn: () => Promise<void>) => {
    setBusyAction(name);
    try {
      if (context?.workspace.path) setWorkspace(context.workspace.path);
      await fn();
      onRefresh();
    } finally {
      setBusyAction(null);
    }
  };

  const handleCommitAndPush = () => runAction('commit-push', async () => {
    const message = commitMessage.trim();
    if (message) {
      await stageFiles([]);
      await commit(message);
      setCommitMessage('');
    }
    await push({ setUpstream: !activeStatus?.tracking });
  });

  const openEvidenceArtifact = (ref: DeliveryEvidenceArtifactRef) => {
    if (ref.path) {
      openArtifact({
        name: ref.label || ref.path,
        path: ref.path,
      });
      openToolTab('artifact');
    } else if (ref.url) {
      window.open(ref.url, '_blank', 'noopener,noreferrer');
    }
  };

  const tabLabel = (tab: WorkbenchTab): string => {
    if (tab.tool === 'artifact') return activeArtifact?.name || t('workbench.filePreview', '文件预览');
    if (tab.tool === 'references') return t('workbench.references', '引用');
    if (tab.tool === 'worktrees') return t('workbench.worktrees', 'Worktrees');
    if (tab.tool === 'side-chat') return t('workbench.sideChat', '侧边聊天');
    if (tab.tool === 'browser') return t('workbench.browser', '浏览器');
    if (tab.tool === 'review') return t('workbench.review', '审查');
    if (tab.tool === 'terminal') {
      const index = tabs.filter((item) => item.tool === 'terminal').findIndex((item) => item.id === tab.id) + 1;
      return t('workbench.terminalTab', '终端 {{index}}', { index: Math.max(1, index) });
    }
    return t('workbench.tools', '工具');
  };

  const tabIcon = (tool: WorkbenchTool) => {
    if (tool === 'artifact') return <FileText size={13} />;
    if (tool === 'references') return <BookOpen size={13} />;
    if (tool === 'worktrees') return <GitBranch size={13} />;
    if (tool === 'side-chat') return <MessageCirclePlus size={13} />;
    if (tool === 'browser') return <Globe size={13} />;
    if (tool === 'review') return <GitPullRequest size={13} />;
    if (tool === 'terminal') return <TerminalSquare size={13} />;
    return <LayoutGrid size={13} />;
  };

  const openToolTab = (tool: WorkbenchTool) => {
    if (tool === 'artifact') {
      setTabs((current) => current.some((tab) => tab.id === ARTIFACT_TAB_ID)
        ? current
        : [...current, { id: ARTIFACT_TAB_ID, tool }]);
      setActiveTabId(ARTIFACT_TAB_ID);
      setPanelWidth(getWorkbenchPreferredWidth(tool, basePanelWidth));
      setToolMenuOpen(false);
      return;
    }
    const reusable = tool !== 'terminal'
      ? tabs.find((tab) => tab.tool === tool)
      : undefined;
    if (reusable) {
      setActiveTabId(reusable.id);
    } else {
      const tab: WorkbenchTab = { id: `workbench-${tool}-${crypto.randomUUID()}`, tool };
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
    }
    setPanelWidth(getWorkbenchPreferredWidth(tool, basePanelWidth));
    setToolMenuOpen(false);
  };

  useEffect(() => {
    if (!toolRequest) return;
    openToolTab(toolRequest.tool);
  }, [toolRequest?.id]);

  useEffect(() => {
    if (!activeArtifact?.path && !activeArtifact?.url) return;
    setTabs((current) => current.some((tab) => tab.id === ARTIFACT_TAB_ID)
      ? current
      : [...current, { id: ARTIFACT_TAB_ID, tool: 'artifact' }]);
    setActiveTabId(ARTIFACT_TAB_ID);
    setPanelWidth(getWorkbenchPreferredWidth('artifact', basePanelWidth));
  }, [activeArtifact?.path, activeArtifact?.url, basePanelWidth]);

  const switchToolTab = (tab: WorkbenchTab) => {
    setActiveTabId(tab.id);
    setPanelWidth(getWorkbenchPreferredWidth(tab.tool, basePanelWidth));
  };

  const closeToolTab = (id: string) => {
    setTabs((current) => {
      if (current.length <= 1) {
        const only = current[0];
        if (!only || only.tool === 'launcher') return current;
        const launcher: WorkbenchTab = { id: 'workbench-launcher', tool: 'launcher' };
        setActiveTabId(launcher.id);
        setPanelWidth(getWorkbenchPreferredWidth('launcher', basePanelWidth));
        return [launcher];
      }
      const closingIndex = current.findIndex((tab) => tab.id === id);
      if (closingIndex < 0) return current;
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabId === id) {
        const closingTab = current[closingIndex];
        const launcherTab = next.find((tab) => tab.tool === 'launcher');
        const fallback = closingTab?.tool !== 'launcher' && launcherTab
          ? launcherTab
          : next[Math.max(0, closingIndex - 1)] || next[0] || { id: 'workbench-launcher', tool: 'launcher' as const };
        setActiveTabId(fallback.id);
        setPanelWidth(getWorkbenchPreferredWidth(fallback.tool, basePanelWidth));
      }
      return next;
    });
  };

  useEffect(() => {
    try {
      localStorage.setItem('lingxiao_workbench_base_panel_width', String(basePanelWidth));
    } catch (error) {
      console.warn('[WorkbenchSidePanel] Failed to persist panel width:', error);
    }
  }, [basePanelWidth]);

  useEffect(() => {
    const preferred = getWorkbenchPreferredWidth(activeTool, basePanelWidth);
    const minWidth = getWorkbenchMinWidth(activeTool);
    const maxWidth = getWorkbenchMaxWidth();
    const normalized = clampWorkbenchWidth(activeTool === 'launcher' ? basePanelWidth : Math.max(panelWidth, preferred), minWidth, maxWidth);
    if (Math.abs(normalized - panelWidth) > 0.5) {
      setPanelWidth(normalized);
    }
  }, [activeTool, basePanelWidth, panelWidth]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch (error) {
      console.warn('[WorkbenchSidePanel] Failed to capture resize pointer:', error);
    }
    const startX = event.clientX;
    const startWidth = panelWidth;
    const maxWidth = getWorkbenchMaxWidth();
    const minWidth = getWorkbenchMinWidth(activeTool);
    const onMove = (moveEvent: PointerEvent) => {
      const next = clampWorkbenchWidth(startWidth + (startX - moveEvent.clientX), minWidth, maxWidth);
      setPanelWidth(next);
      if (activeTool === 'launcher') {
        setBasePanelWidth(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch (error) {
        console.warn('[WorkbenchSidePanel] Failed to release resize pointer:', error);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [activeTool, panelWidth]);

  return (
    <aside className={`workbench-panel hidden min-h-0 shrink-0 flex-col border-l border-border-muted xl:flex ${
      activeTool === 'browser' ? 'is-browser' : ''
    }`} style={{ width: panelWidth }}>
      <div
        className="workbench-resize-handle"
        role="separator"
        aria-orientation="vertical"
        title={t('workbench.resize', '拖动调整宽度')}
        onPointerDown={startResize}
      />
      <div className="workbench-panel-header">
        <div className="flex min-w-0 items-center gap-2">
          <div className="workbench-panel-title">
            <img src={logoSrc} alt="" aria-hidden="true" />
            <span>{t('workbench.pavilion', '剑阁')}</span>
          </div>
          <button
            type="button"
            onClick={onCollapse}
            className="workbench-panel-collapse-button"
            title={t('workbench.collapsePavilion', '收起剑阁')}
            aria-label={t('workbench.collapsePavilion', '收起剑阁')}
          >
            <PanelRightClose size={14} />
          </button>
          <div className="workbench-tab-strip">
            {tabs.map((tab) => (
              <div key={tab.id} className={`workbench-tab ${tab.id === activeTab?.id ? 'is-active' : ''}`}>
                <button type="button" className="workbench-tab-main" onClick={() => switchToolTab(tab)} title={tabLabel(tab)}>
                  {tabIcon(tab.tool)}
                  <span>{tabLabel(tab)}</span>
                </button>
                {(tabs.length > 1 || tab.tool !== 'launcher') && (
                  <button
                    type="button"
                    className="workbench-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeToolTab(tab.id);
                    }}
                    title={t('workbench.closeTab', '关闭标签')}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            ref={toolMenuBtnRef}
            className="workbench-tool-title"
            aria-haspopup="menu"
            aria-expanded={toolMenuOpen}
            onClick={() => setToolMenuOpen((open) => !open)}
          >
            <Plus size={15} />
            <span>{t('workbench.tools', '工具')}</span>
            <ChevronDown size={13} className={toolMenuOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {toolMenuOpen && (
            <div ref={toolMenuRef} role="menu" className="workbench-tool-menu">
              <ToolMenuItem icon={<FileText size={15} />} label={t('workbench.files', '文件')} shortcut="Ctrl+P" onClick={() => { setMainView('editor'); setToolMenuOpen(false); }} />
              <ToolMenuItem icon={<FileText size={15} />} label={t('workbench.filePreview', '文件预览')} onClick={() => openToolTab('artifact')} />
              <ToolMenuItem icon={<BookOpen size={15} />} label={t('workbench.references', '引用')} onClick={() => openToolTab('references')} />
              <ToolMenuItem icon={<GitBranch size={15} />} label={t('workbench.worktrees', 'Worktrees')} onClick={() => openToolTab('worktrees')} />
              <ToolMenuItem icon={<MessageCirclePlus size={15} />} label={t('workbench.sideChat', '侧边聊天')} onClick={() => openToolTab('side-chat')} />
              <ToolMenuItem icon={<Globe size={15} />} label={t('workbench.browser', '浏览器')} shortcut="Ctrl+T" onClick={() => openToolTab('browser')} />
              <ToolMenuItem icon={<GitPullRequest size={15} />} label={t('workbench.review', '审查')} shortcut="Ctrl+Shift+G" onClick={() => openToolTab('review')} />
              <ToolMenuItem icon={<TerminalSquare size={15} />} label={t('workbench.terminal', '终端')} shortcut="Ctrl+`" onClick={() => openToolTab('terminal')} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onRefresh} className="codex-icon-btn !h-8 !min-w-8" title={t('workbench.refresh', '刷新环境')}>
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="workbench-tab-content-stack">
        {tabs.map((tab) => (
          <div key={tab.id} className={`workbench-tab-content ${tab.id === activeTab?.id ? 'is-active' : ''}`}>
            {tab.tool === 'browser' ? (
              <div className="min-h-0 flex-1 overflow-hidden p-3">
                <BrowserDock
                  workspaceName={workspaceName}
                  onInsertPrompt={onInsertBrowserPrompt}
                  onSendPrompt={onSendBrowserPrompt}
                />
              </div>
            ) : tab.tool === 'artifact' ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={<WorkbenchPaneLoading />}>
                  <ArtifactView />
                </Suspense>
              </div>
            ) : tab.tool === 'references' ? (
              <ReferencesPanel
                refs={evidenceReferences}
                onOpen={(ref) => {
                  if (ref.path) {
                    openArtifact({
                      name: ref.label,
                      path: ref.path,
                      line: ref.line,
                      column: ref.column,
                    });
                    openToolTab('artifact');
                  } else if (ref.url) {
                    window.open(ref.url, '_blank', 'noopener,noreferrer');
                  }
                }}
              />
            ) : tab.tool === 'worktrees' ? (
              <WorktreesPanel
                repoRoot={repoRoot}
                sessionId={sessionId}
                currentWorktree={context?.worktree || null}
                worktrees={worktrees}
                isLoading={worktreeLoading}
                error={worktreeError}
                onRefresh={() => fetchWorktrees({ repoRoot })}
                onCreate={async (input) => {
                  const wt = await createWorktree(input);
                  const newSessionId = await createAndConnect({ workspace: wt.path });
                  if (newSessionId) await attachSession(wt.id, newSessionId);
                  onRefresh();
                }}
                onOpenSession={async (wt) => {
                  const newSessionId = await createAndConnect({ workspace: wt.path });
                  await attachSession(wt.id, newSessionId || sessionId || null);
                  onRefresh();
                }}
                onMerge={(id, opts) => mergeWorktree(id, { ffOnly: true, deleteAfterMerge: opts.deleteAfterMerge }).then(onRefresh)}
                onRemove={(id, opts) => removeWorktree(id, { keepBranch: opts.keepBranch }).then(onRefresh)}
                onPrune={() => pruneWorktrees(repoRoot).then(() => fetchWorktrees({ repoRoot }))}
                onDiff={(wt) => fetchWorktreeDiff(wt.path)}
                onCommit={(wt, message) => commitWorktree(wt.path, message, repoRoot).then(onRefresh)}
              />
            ) : tab.tool === 'side-chat' ? (
              <SideThreadPanel
                workspacePath={context?.workspace.path || ''}
                workspaceName={workspaceName}
                parentSessionId={sessionId || undefined}
              />
            ) : tab.tool === 'review' ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <ReviewTool
                  branch={branch}
                  changedFiles={changedFiles}
                  remoteLabel={remoteLabel}
                  prCountLabel={prCountLabel}
                  firstMrTitle={mrs[0]?.title}
                  isMRLoading={isMRLoading}
                  busyAction={busyAction}
                  gitLoading={gitLoading}
                  commitMessage={commitMessage}
	                  setCommitMessage={setCommitMessage}
	                  canCommitOrPush={!!commitMessage.trim() || !!activeStatus?.ahead}
	                  onFetchMRs={() => runAction('mrs', async () => { await fetchMRs('open'); })}
	                  onCommitAndPush={handleCommitAndPush}
	                  onOpenGit={() => setMainView('git')}
	                  deliveryEvidence={deliveryEvidence}
	                  onOpenEvidenceRef={openEvidenceArtifact}
	                />
              </div>
            ) : tab.tool === 'terminal' ? (
              <div className="workbench-side-terminal">
                <Suspense fallback={<WorkbenchPaneLoading />}>
                  <TerminalPane terminalId={tab.id} />
                </Suspense>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <Launcher
                  workspaceName={workspaceName}
                  workspacePath={context?.workspace.path}
                  branch={branch}
                  changedFiles={changedFiles}
                  terminalOpen={terminalOpen}
                  onOpenFiles={() => setMainView('editor')}
                  onOpenBrowser={() => openToolTab('browser')}
                  onOpenReview={() => openToolTab('review')}
                  onToggleTerminal={() => openToolTab('terminal')}
                  onOpenReferences={() => openToolTab('references')}
                  onOpenArtifact={() => openToolTab('artifact')}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="workbench-panel-footer">
        {error ? (
          <div className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs text-accent-red">{error}</div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <CheckCircle2 size={14} className="text-accent-green" />
            <span>{t('workbench.synced', '环境已同步')}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function ToolMenuItem({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="workbench-tool-menu-item" onClick={onClick}>
      {icon}
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

type SideThreadMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  timestamp: number;
  streaming?: boolean;
  retrying?: boolean;
};

type SideThreadRecord = {
  sessionId: string;
  parentSessionId?: string | null;
  inheritedUntil?: number | null;
};

type SideThreadLookupResponse = {
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSideThreadRecord(value: unknown): SideThreadRecord | null {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !value.sessionId) return null;
  return {
    sessionId: value.sessionId,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : null,
    inheritedUntil: typeof value.inheritedUntil === 'number' && Number.isFinite(value.inheritedUntil) ? value.inheritedUntil : null,
  };
}

function isSideThreadRole(value: unknown): value is SideThreadMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

function normalizeSideThreadHistoryRow(
  row: unknown,
  index: number,
  inheritedCutoff: number | null,
): SideThreadMessage | null {
  if (!isRecord(row) || !isSideThreadRole(row.role)) return null;
  const timestampSeconds = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp)
    ? row.timestamp
    : null;
  if (inheritedCutoff != null && timestampSeconds != null && timestampSeconds <= inheritedCutoff) return null;
  return {
    id: row.id != null ? `side-history-${String(row.id)}` : `side-history-${index}`,
    role: row.role,
    content: sideContentText(row.content),
    thinking: sideContentText(row.reasoningContent),
    timestamp: timestampSeconds != null ? timestampSeconds * 1000 : Date.now(),
    streaming: false,
  };
}

function sideThreadStorageKey(workspacePath: string, workspaceName: string, parentSessionId?: string | null): string {
  return `lingxiao_side_thread:${workspacePath || workspaceName || 'default'}:${parentSessionId || 'standalone'}`;
}

function readSideThreadRecord(storageKey: string): SideThreadRecord | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    if (raw.trim().startsWith('{')) {
      return normalizeSideThreadRecord(JSON.parse(raw) as unknown);
    }
    return { sessionId: raw, parentSessionId: null, inheritedUntil: null };
  } catch {
    return null;
  }
}

function writeSideThreadRecord(storageKey: string, record: SideThreadRecord): void {
  localStorage.setItem(storageKey, JSON.stringify(record));
}

async function fetchSideThreadRecord(parentSessionId: string | undefined, workspacePath: string): Promise<SideThreadRecord | null> {
  const params = new URLSearchParams();
  if (parentSessionId) params.set('parentSessionId', parentSessionId);
  if (workspacePath) params.set('workspace', workspacePath);
  const res = await fetch(`/api/v1/sessions/side-thread?${params.toString()}`, {
    headers: { 'x-lingxiao-token': getServerToken() },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null) as SideThreadLookupResponse | null;
  return normalizeSideThreadRecord(json?.data);
}

function sideContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : String(value);
  return value.map((part: unknown) => {
    if (!isRecord(part)) return '';
    if (part.type === 'text') return String(part.text || '');
    if (part.type === 'image_url') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

function appendToLastSideAssistant(
  messages: SideThreadMessage[],
  patch: { content?: string; thinking?: string; streaming?: boolean; retrying?: boolean },
): SideThreadMessage[] {
  const next = [...messages];
  let index = next.length - 1;
  while (index >= 0 && next[index].role !== 'assistant') index--;
  if (index < 0) {
    next.push({
      id: `side-assistant-${Date.now()}`,
      role: 'assistant',
      content: patch.content || '',
      thinking: patch.thinking,
      timestamp: Date.now(),
      streaming: patch.streaming ?? true,
      retrying: patch.retrying,
    });
    return next;
  }
  const previous = next[index];
  next[index] = {
    ...previous,
    content: patch.content !== undefined ? previous.content + patch.content : previous.content,
    thinking: patch.thinking !== undefined ? `${previous.thinking || ''}${patch.thinking}` : previous.thinking,
    streaming: patch.streaming ?? previous.streaming,
    retrying: patch.retrying ?? previous.retrying,
  };
  return next;
}

function replaceLastSideAssistant(
  messages: SideThreadMessage[],
  patch: { content?: string; thinking?: string; streaming?: boolean; retrying?: boolean },
): SideThreadMessage[] {
  const next = [...messages];
  let index = next.length - 1;
  while (index >= 0 && next[index].role !== 'assistant') index--;
  if (index < 0) {
    next.push({
      id: `side-assistant-${Date.now()}`,
      role: 'assistant',
      content: patch.content || '',
      thinking: patch.thinking,
      timestamp: Date.now(),
      streaming: patch.streaming ?? false,
      retrying: patch.retrying,
    });
    return next;
  }
  const previous = next[index];
  next[index] = {
    ...previous,
    content: patch.content !== undefined ? patch.content : previous.content,
    thinking: patch.thinking !== undefined ? patch.thinking : previous.thinking,
    streaming: patch.streaming ?? previous.streaming,
    retrying: patch.retrying ?? previous.retrying,
  };
  return next;
}

function SideThreadPanel({
  workspacePath,
  workspaceName,
  parentSessionId,
}: {
  workspacePath: string;
  workspaceName: string;
  parentSessionId?: string;
}) {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SideThreadMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'streaming' | 'thinking' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [inheritedUntil, setInheritedUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<AcpClient | null>(null);
  const connectingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const storageKey = useMemo(
    () => sideThreadStorageKey(workspacePath, workspaceName, parentSessionId),
    [parentSessionId, workspaceName, workspacePath],
  );

  const tokenStats = useMemo(() => {
    const latest = [...messages].reverse().find((message) => message.role === 'assistant' && message.streaming);
    const text = `${latest?.thinking || ''}${latest?.content || ''}`;
    return {
      inputTokens: estimateTokens(input),
      streamTokens: estimateTokens(text),
      streamChars: text.length,
    };
  }, [input, messages]);

  const loadHistory = useCallback(async (id: string, visibleAfter?: number | null) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      headers: { 'x-lingxiao-token': getServerToken() },
    });
    if (!res.ok) return;
    const rows = await res.json().catch(() => null) as unknown;
    if (!Array.isArray(rows)) return;
    const inheritedCutoff = visibleAfter ?? inheritedUntil;
    setMessages(rows
      .map((row, index) => normalizeSideThreadHistoryRow(row, index, inheritedCutoff))
      .filter((message): message is SideThreadMessage => message !== null));
  }, [inheritedUntil]);

  const connectSession = useCallback(async (id: string, visibleAfter?: number | null) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setStatus('connecting');
    setError(null);
    const client = new AcpClient();
    clientRef.current = client;
    client.on('connection/state', (event) => {
      const state = event.state;
      if (state === 'connected') {
        setStatus((current) => current === 'connecting' ? 'ready' : current);
      } else if (state === 'disconnected') {
        setStatus('error');
      }
    });
    subscribeSessionUpdateEvents(client, ({ kind, update }) => {
      if (!update) return;
      if (kind === SessionUpdateKind.LeaderTextDelta) {
        setStatus('streaming');
        setMessages((current) => appendToLastSideAssistant(current, { content: sideContentText(update.content), streaming: true, retrying: false }));
      } else if (kind === SessionUpdateKind.LeaderThinkingDelta) {
        setStatus('thinking');
        setMessages((current) => appendToLastSideAssistant(current, { thinking: sideContentText(update.content), streaming: true, retrying: false }));
      } else if (kind === SessionUpdateKind.LeaderTextFinal) {
        setMessages((current) => replaceLastSideAssistant(current, {
          content: sideContentText(update.content),
          thinking: sideContentText(update.reasoningContent),
          streaming: false,
          retrying: false,
        }));
      } else if (kind === SessionUpdateKind.LeaderLlmRetry) {
        setStatus('streaming');
        setMessages((current) => appendToLastSideAssistant(current, { content: '', thinking: '', streaming: true, retrying: true }));
      } else if (kind === SessionUpdateKind.UserMessage && update.source !== 'web') {
        const content = sideContentText(update.content);
        setMessages((current) => [...current, {
          id: `side-remote-user-${Date.now()}`,
          role: 'user',
          content,
          timestamp: Date.now(),
        }]);
      } else if (kind === SessionUpdateKind.ConversationMessage) {
        if (update.role !== 'assistant') return;
        const content = sideContentText(update.content);
        const thinking = sideContentText(update.reasoningContent);
        setMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === 'assistant' && last.streaming) {
            return current.map((message, index) => index === current.length - 1
              ? { ...message, content: content || message.content, thinking: thinking || message.thinking, streaming: false, retrying: false }
              : message);
          }
          return [...current, {
            id: update.id != null ? `side-srv-${update.id}` : `side-srv-${Date.now()}`,
            role: 'assistant',
            content,
            thinking,
            timestamp: typeof update.timestamp === 'number' ? update.timestamp * 1000 : Date.now(),
            streaming: false,
          }];
        });
      } else if (kind === SessionUpdateKind.LeaderToolCall) {
        const tool = typeof update.tool === 'string' && update.tool ? update.tool : 'tool';
        setStatus('streaming');
        setMessages((current) => appendToLastSideAssistant(current, {
          content: `\n\n[tool] ${tool} running...\n`,
          streaming: true,
        }));
      } else if (kind === SessionUpdateKind.LeaderToolResult) {
        const tool = typeof update.tool === 'string' && update.tool ? update.tool : 'tool';
        setMessages((current) => appendToLastSideAssistant(current, {
          content: `[tool] ${tool} ${update.error ? 'failed' : 'completed'}\n`,
          streaming: true,
        }));
      } else if (kind === SessionUpdateKind.SessionRuntimeState) {
        const runtimeBusy = runtimeImpliesBusy({ runtimeState: update });
        setBusy(runtimeBusy);
        if (!runtimeBusy) {
          setStatus('ready');
          setMessages((current) => current.map((message, index) => index === current.length - 1 && message.role === 'assistant'
            ? { ...message, streaming: false, retrying: false }
            : message));
        }
      } else if (kind === SessionUpdateKind.StatusChange || kind === SessionUpdateKind.SessionCompleted) {
        const statusKind = kind === SessionUpdateKind.SessionCompleted ? 'completed' : normalizeLeaderStatusKind(update.status);
        if (statusKind === 'idle' || statusKind === 'completed') {
          setStatus('ready');
          setMessages((current) => current.map((message) => message.streaming ? { ...message, streaming: false, retrying: false } : message));
        }
      } else if (kind === SessionUpdateKind.SessionFailed) {
        setStatus('error');
        setError(String(update.error || 'Session failed'));
      } else if (kind === SessionUpdateKind.Error) {
        setStatus('error');
        setError(String(update.error || 'Session error'));
      }
    });
    try {
      await client.connect(id);
      await loadHistory(id, visibleAfter);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      connectingRef.current = false;
    }
  }, [loadHistory]);

  const createSession = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
      body: JSON.stringify({
        user_request: 'Side chat',
        idle: true,
        workspace: workspacePath || undefined,
        parentSessionId,
        inheritParentConversation: Boolean(parentSessionId),
        sideThread: true,
      }),
    });
    if (!res.ok) throw new Error(`Session create failed (${res.status})`);
    const data = await res.json();
    const id = data.id || data.sessionId;
    if (!id) throw new Error('Session create returned no id');
    const cutoff = typeof data.inheritedUntil === 'number' ? data.inheritedUntil : null;
    writeSideThreadRecord(storageKey, {
      sessionId: id,
      parentSessionId: parentSessionId || null,
      inheritedUntil: cutoff,
    });
    setInheritedUntil(cutoff);
    setSessionId(id);
    setMessages([]);
    await clientRef.current?.disconnect().catch(() => {});
    await connectSession(id, cutoff);
  }, [connectSession, parentSessionId, storageKey, workspacePath]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const serverRecord = await fetchSideThreadRecord(parentSessionId, workspacePath);
        const stored = serverRecord || readSideThreadRecord(storageKey);
        if (stored?.sessionId && !cancelled) {
          writeSideThreadRecord(storageKey, stored);
          setSessionId(stored.sessionId);
          setInheritedUntil(stored.inheritedUntil ?? null);
          await connectSession(stored.sessionId, stored.inheritedUntil ?? null);
          return;
        }
        if (!cancelled) await createSession();
      } catch {
        if (!cancelled) {
          localStorage.removeItem(storageKey);
          if (!sessionId) {
            await createSession().catch((err) => {
              setError(err instanceof Error ? err.message : String(err));
              setStatus('error');
            });
          }
        }
      }
    };
    void boot();
    return () => {
      cancelled = true;
      void clientRef.current?.disconnect().catch(() => {});
      clientRef.current = null;
    };
  }, [connectSession, createSession, storageKey]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, tokenStats.streamChars]);

  const send = async () => {
    const text = input.trim();
    if (!text || !sessionId || !clientRef.current || busy) return;
    setInput('');
    setBusy(true);
    setStatus('streaming');
    const now = Date.now();
    setMessages((current) => [
      ...current,
      { id: `side-user-${now}`, role: 'user', content: text, timestamp: now },
      { id: `side-assistant-${now}`, role: 'assistant', content: '', timestamp: now + 1, streaming: true },
    ]);
    try {
      await clientRef.current.sendJsonRpc('session/prompt', { prompt: text });
    } catch (err) {
      setBusy(false);
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async () => {
    try {
      await clientRef.current?.sendJsonRpc('session/cancel');
    } catch (error) {
      console.warn('[WorkbenchSidePanel] Failed to cancel side session:', error);
    }
    setBusy(false);
    setStatus('ready');
    setMessages((current) => current.map((message) => message.streaming ? { ...message, streaming: false, retrying: false } : message));
  };

  return (
    <div className="side-thread-panel">
      <div className="side-thread-header">
        <div className="min-w-0">
          <div className="side-thread-title">
            <MessageCirclePlus size={15} />
            <span>{t('workbench.sideChat', '侧边聊天')}</span>
          </div>
          <div className="side-thread-meta">
            <span>{workspaceName}</span>
            {sessionId && <span className="font-mono">{sessionId.slice(0, 8)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="codex-icon-btn !h-7 !min-w-7" onClick={() => void createSession()} title={t('workbench.newSideChat', '新建侧边聊天')}>
            <Plus size={13} />
          </button>
          <button type="button" className="codex-icon-btn !h-7 !min-w-7" onClick={() => sessionId && void loadHistory(sessionId, inheritedUntil)} disabled={!sessionId} title={t('workbench.refresh', '刷新环境')}>
            <RefreshCw size={13} className={status === 'connecting' ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
      <div className="side-thread-status">
        <span className={`side-thread-dot is-${status}`} />
        <span>
          {status === 'connecting'
            ? t('workbench.sideChatConnecting', '正在连接侧边线程')
            : status === 'thinking'
              ? t('workbench.sideChatThinking', '思考中')
              : status === 'streaming'
                ? t('workbench.sideChatStreaming', '生成中')
                : status === 'error'
                  ? (error || t('workbench.sideChatError', '侧边聊天出错'))
                  : t('workbench.sideChatReady', '已连接')}
        </span>
        {tokenStats.streamChars > 0 && status !== 'ready' && (
          <span className="ml-auto font-mono">{formatTokenCount(tokenStats.streamTokens)} tok · {tokenStats.streamChars} chars</span>
        )}
      </div>
      <div ref={scrollRef} className="side-thread-messages">
        {messages.length === 0 && (
          <div className="side-thread-empty">
            <MessageCirclePlus size={20} />
            <span>{t('workbench.sideChatEmpty', '在这里开一条不打断主会话的侧边线程')}</span>
            {inheritedUntil != null && <small>{t('workbench.sideChatInherited', '已继承父线程上下文，侧边记录单独保存')}</small>}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`side-thread-message is-${message.role}`}>
            <div className="side-thread-message-role">
              {message.role === 'user' ? t('sideThread.you', 'You') : message.role === 'assistant' ? t('sideThread.assistant', '凌霄') : t('sideThread.system', 'System')}
              {message.retrying && <span>{t('sideThread.retrying', 'retrying')}</span>}
              {message.streaming && <Loader2 size={11} className="animate-spin" />}
            </div>
            {message.thinking?.trim() && (
              <details className="side-thread-thinking" open={message.streaming && !message.content.trim()}>
                <summary>{t('chat.status.thinking', '思考中')}</summary>
                <pre>{message.thinking}</pre>
              </details>
            )}
            {message.content.trim() ? (
              <pre className="side-thread-message-content">{message.content}</pre>
            ) : message.streaming ? (
              <div className="side-thread-placeholder">{t('chat.status.modelRequesting', { defaultValue: '等待模型响应...' })}</div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="side-thread-composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={!sessionId || status === 'connecting'}
          placeholder={t('workbench.sideChatPlaceholder', '问一个不打断主线程的问题...')}
        />
        <div className="side-thread-composer-actions">
          <span>{formatTokenCount(tokenStats.inputTokens)} tok</span>
          {busy ? (
            <button type="button" className="codex-secondary-btn h-8 text-xs" onClick={() => void stop()}>
              <X size={13} />
              <span>{t('chat.stop', '停止')}</span>
            </button>
          ) : (
            <button type="button" className="codex-primary-btn h-8 text-xs" onClick={() => void send()} disabled={!input.trim() || !sessionId || status === 'connecting'}>
              <Send size={13} />
              <span>{t('input.send', '发送')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Launcher({
  workspaceName,
  workspacePath,
  branch,
  changedFiles,
  terminalOpen,
  onOpenFiles,
  onOpenBrowser,
  onOpenReview,
  onToggleTerminal,
  onOpenReferences,
  onOpenArtifact,
}: {
  workspaceName: string;
  workspacePath?: string;
  branch: string;
  changedFiles: number;
  terminalOpen: boolean;
  onOpenFiles: () => void;
  onOpenBrowser: () => void;
  onOpenReview: () => void;
  onToggleTerminal: () => void;
  onOpenReferences: () => void;
  onOpenArtifact: () => void;
}) {
  const { t } = useTranslation();
  const workspaceDisplayPath = workspacePath || t('workbench.noWorkspace', '未选择工作区');
  return (
    <div className="workbench-launcher">
      <div className="workbench-context-summary">
        <div className="workbench-context-seal" aria-hidden="true">凌</div>
        <div className="workbench-context-text min-w-0 flex-1 overflow-hidden">
          <span title={workspaceName}>{workspaceName}</span>
          <small title={workspaceDisplayPath}>{workspaceDisplayPath}</small>
        </div>
        <div className="workbench-context-meta">
          <em>{branch}</em>
          <em>{changedFiles > 0 ? t('workbench.changedFilesShort', '{{count}} changed', { count: changedFiles }) : t('workbench.cleanShort', 'clean')}</em>
        </div>
      </div>
      {/* 玉简:知识/查阅类(查阅引用、预览文件) */}
      <div className="workbench-section-label">
        <span>{t('workbench.group.jadeSlips', '玉简')}</span>
      </div>
      <div className="workbench-jade-strip">
        <button type="button" className="workbench-jade-chip" onClick={onOpenReferences}>
          <BookOpen size={14} />
          <span>{t('workbench.references', '引用')}</span>
        </button>
        <button type="button" className="workbench-jade-chip" onClick={onOpenArtifact}>
          <FileText size={14} />
          <span>{t('workbench.filePreview', '预览')}</span>
        </button>
      </div>

      {/* 剑令:动作类(打开文件、浏览器、审查、终端) */}
      <div className="workbench-section-label">
        <span>{t('workbench.group.swordOrders', '剑令')}</span>
      </div>
      <div className="workbench-tool-grid">
        <ToolCard index="01" icon={<FileText size={18} />} label={t('workbench.files', '文件')} sublabel={t('workbench.openFiles', '打开项目文件')} onClick={onOpenFiles} />
        <ToolCard index="02" icon={<Globe size={19} />} label={t('workbench.browser', '浏览器')} sublabel={t('workbench.openWebsite', '打开网站')} shortcut="Ctrl+T" onClick={onOpenBrowser} />
        <ToolCard index="03" icon={<GitPullRequest size={18} />} label={t('workbench.review', '审查')} sublabel={changedFiles > 0 ? t('workbench.changedFiles', '{{count}} 个文件变更', { count: changedFiles }) : branch} shortcut="Ctrl+Shift+G" onClick={onOpenReview} />
        <ToolCard index="04" icon={<TerminalSquare size={18} />} label={t('workbench.terminal', '终端')} sublabel={terminalOpen ? t('workbench.expanded', '已展开') : t('workbench.startShell', '启动交互式 shell')} shortcut="Ctrl+`" onClick={onToggleTerminal} />
      </div>
    </div>
  );
}

function ToolCard({
  index,
  icon,
  label,
  sublabel,
  shortcut,
  onClick,
}: {
  index: string;
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="workbench-tool-card" onClick={onClick}>
      <span className="workbench-tool-card-index">{index}</span>
      <span className="workbench-tool-card-icon">{icon}</span>
      <span className="workbench-tool-card-copy">
        <span className="workbench-tool-card-label">{label}</span>
        <span className="workbench-tool-card-sub">{sublabel}</span>
      </span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

function ReferencesPanel({
  refs,
  onOpen,
}: {
  refs: EvidenceReference[];
  onOpen: (ref: EvidenceReference) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <BookOpen size={15} />
          <span>{t('workbench.references', '引用')}</span>
        </div>
        <span className="text-[11px] text-text-tertiary">{refs.length}</span>
      </div>
      {refs.length === 0 ? (
        <div className="rounded-md border border-border-muted bg-bg-secondary px-3 py-6 text-center text-xs text-text-tertiary">
          {t('workbench.noReferences', '暂无引用')}
        </div>
      ) : (
        <div className="space-y-1.5">
          {refs.map((ref) => (
            <button
              key={ref.id}
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border-muted bg-bg-secondary px-2.5 py-2 text-left hover:border-border-default hover:bg-bg-hover"
              onClick={() => onOpen(ref)}
              title={ref.path || ref.url || ref.label}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-muted bg-bg-card text-text-tertiary">
                {ref.kind === 'url' ? <Globe size={14} /> : <FileText size={14} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-text-primary">{ref.label}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-text-tertiary">
                  <span className="uppercase">{ref.kind}</span>
                  {ref.tool && <span className="truncate">· {ref.tool}</span>}
                  {ref.source === 'message' && <span>· chat</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WorktreesPanel({
  repoRoot,
  sessionId,
  currentWorktree,
  worktrees,
  isLoading,
  error,
  onRefresh,
  onCreate,
  onOpenSession,
  onMerge,
  onRemove,
  onPrune,
  onDiff,
  onCommit,
}: {
  repoRoot: string;
  sessionId: string | null;
  currentWorktree: WorktreeInfo | null;
  worktrees: WorktreeInfo[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
  onCreate: (input: { repoRoot: string; name?: string; branch?: string; baseBranch?: string; sessionId?: string }) => Promise<void>;
  onOpenSession: (wt: WorktreeInfo) => Promise<void>;
  onMerge: (id: string, opts: { deleteAfterMerge: boolean }) => Promise<void>;
  onRemove: (id: string, opts: { keepBranch: boolean }) => Promise<void>;
  onPrune: () => Promise<void>;
  onDiff: (wt: WorktreeInfo) => Promise<string>;
  onCommit: (wt: WorktreeInfo, message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState(currentWorktree?.base_branch || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteAfterMerge, setDeleteAfterMerge] = useState(false);
  const [keepBranchOnDelete, setKeepBranchOnDelete] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [expandedWorktreeId, setExpandedWorktreeId] = useState<string | null>(null);
  const [diffText, setDiffText] = useState('');
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const [confirmAction, setConfirmAction] = useState<
    | { type: 'merge'; worktree: WorktreeInfo }
    | { type: 'remove'; worktree: WorktreeInfo }
    | { type: 'prune' }
    | null
  >(null);

  useEffect(() => {
    if (!baseBranch && currentWorktree?.base_branch) setBaseBranch(currentWorktree.base_branch);
  }, [baseBranch, currentWorktree?.base_branch]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const create = () => run('create', async () => {
    if (!repoRoot) return;
    await onCreate({
      repoRoot,
      name: name.trim() || undefined,
      branch: branch.trim() || undefined,
      baseBranch: baseBranch.trim() || undefined,
      sessionId: sessionId || undefined,
    });
    setName('');
    setBranch('');
  });

  const confirmTitle = confirmAction?.type === 'merge'
    ? 'Merge worktree'
    : confirmAction?.type === 'remove'
      ? 'Delete worktree'
      : 'Prune worktrees';
  const confirmMessage = confirmAction?.type === 'merge'
    ? `Fast-forward merge "${confirmAction.worktree.branch}" into "${confirmAction.worktree.base_branch}"?${deleteAfterMerge ? ' The worktree and branch will be deleted after a successful merge.' : ''} The main repository must be clean and on the base branch.`
    : confirmAction?.type === 'remove'
      ? `Delete worktree "${confirmAction.worktree.name}"${keepBranchOnDelete ? ` but keep branch "${confirmAction.worktree.branch}"?` : ` and branch "${confirmAction.worktree.branch}"?`}`
      : 'Prune stale git worktree metadata for this repository?';
  const confirmVariant = confirmAction?.type === 'remove' || confirmAction?.type === 'prune' ? 'danger' : 'default';
  const confirmLabel = confirmAction?.type === 'merge' ? t('worktree.merge', 'Merge') : confirmAction?.type === 'remove' ? t('worktree.delete', 'Delete') : t('worktree.prune', 'Prune');

  const runConfirmedAction = () => {
    const action = confirmAction;
    if (!action) return;
    setConfirmAction(null);
    if (action.type === 'merge') {
      void run(`merge-${action.worktree.id}`, () => onMerge(action.worktree.id, { deleteAfterMerge }));
    } else if (action.type === 'remove') {
      void run(`remove-${action.worktree.id}`, () => onRemove(action.worktree.id, { keepBranch: keepBranchOnDelete }));
    } else {
      void run('prune', onPrune);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath((current) => current === path ? null : current), 1600);
    } catch {
      setCopiedPath(null);
    }
  };

  const toggleDiff = (wt: WorktreeInfo) => run(`diff-${wt.id}`, async () => {
    if (expandedWorktreeId === wt.id) {
      setExpandedWorktreeId(null);
      setDiffText('');
      return;
    }
    const diff = await onDiff(wt);
    setExpandedWorktreeId(wt.id);
    setDiffText(diff || 'No diff');
  });

  const commitCurrent = (wt: WorktreeInfo) => run(`commit-${wt.id}`, async () => {
    await onCommit(wt, commitMessages[wt.id] || '');
    setCommitMessages((current) => ({ ...current, [wt.id]: '' }));
    const diff = await onDiff(wt).catch(() => '');
    setDiffText(diff || 'No diff');
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
          <GitBranch size={15} />
          <span>{t('workbench.worktrees', 'Worktrees')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="codex-icon-btn !h-7 !min-w-7" onClick={() => void run('refresh', async () => { await onRefresh(); })} title={t('workbench.refresh', '刷新环境')}>
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button type="button" className="codex-icon-btn !h-7 !min-w-7" onClick={() => setConfirmAction({ type: 'prune' })} disabled={!repoRoot || busy === 'prune'} title="Prune">
            <SlidersHorizontal size={13} />
          </button>
        </div>
      </div>

      {currentWorktree && (
        <div className="mb-3 rounded-md border border-accent-green/30 bg-accent-green/10 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-accent-green">{currentWorktree.name}</span>
            <span className="text-text-tertiary">{currentWorktree.status}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-text-tertiary">{currentWorktree.branch}</div>
        </div>
      )}

      <div className="mb-3 space-y-2 rounded-md border border-border-muted bg-bg-secondary p-2.5">
        <input
          className="w-full rounded-md border border-border-muted bg-bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-blue"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="name"
        />
        <input
          className="w-full rounded-md border border-border-muted bg-bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-blue"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="branch"
        />
        <input
          className="w-full rounded-md border border-border-muted bg-bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-blue"
          value={baseBranch}
          onChange={(event) => setBaseBranch(event.target.value)}
          placeholder="base branch"
        />
        <button
          type="button"
          className="codex-primary-btn h-8 w-full text-xs"
          onClick={create}
          disabled={!repoRoot || busy === 'create'}
        >
          {busy === 'create' ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          <span>{t('worktree.newSession', 'New isolated session')}</span>
        </button>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-1.5 rounded-md border border-border-muted bg-bg-secondary px-2.5 py-2 text-[11px] text-text-secondary">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={deleteAfterMerge}
            onChange={(event) => setDeleteAfterMerge(event.target.checked)}
          />
          <span>{t('worktree.deleteAfterMerge', 'Delete after merge')}</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={keepBranchOnDelete}
            onChange={(event) => setKeepBranchOnDelete(event.target.checked)}
          />
          <span>{t('worktree.keepBranch', 'Keep branch on delete')}</span>
        </label>
      </div>

      {error && <div className="mb-2 rounded-md border border-accent-red/30 bg-accent-red/10 px-2 py-1.5 text-xs text-accent-red">{error}</div>}

      <div className="space-y-1.5">
        {worktrees.length === 0 && (
          <div className="rounded-md border border-border-muted bg-bg-secondary px-3 py-6 text-center text-xs text-text-tertiary">
            {t('worktree.noWorktrees', 'No worktrees')}
          </div>
        )}
        {worktrees.map((wt) => {
          const dirty = wt.live?.total || 0;
          const normalizedStatus = normalizeWorktreeStatus(wt.status);
          const canMerge = wt.exists && normalizedStatus !== 'removed' && normalizedStatus !== 'failed' && normalizedStatus !== 'merged' && dirty === 0 && normalizedStatus !== 'dirty';
          const canOpen = wt.exists && normalizedStatus !== 'removed' && normalizedStatus !== 'failed';
          const statusTitle = dirty > 0
            ? `${dirty} changed`
            : !wt.exists
              ? 'missing'
              : wt.status;
          return (
            <div key={wt.id} className="rounded-md border border-border-muted bg-bg-secondary p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-text-primary">{wt.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-text-tertiary">{wt.branch}</div>
                </div>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                  normalizedStatus === 'dirty' ? 'border-accent-yellow/40 text-accent-yellow' :
                  normalizedStatus === 'failed' ? 'border-accent-red/40 text-accent-red' :
                  normalizedStatus === 'merged' ? 'border-accent-green/40 text-accent-green' :
                  'border-border-muted text-text-tertiary'
                }`}>
                  {statusTitle}
                </span>
              </div>
              <div className="mt-1 truncate text-[10px] text-text-tertiary">{wt.path}</div>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-text-tertiary">
                <span>base {wt.base_branch}</span>
                {wt.live?.currentBranch && <span>current {wt.live.currentBranch}</span>}
                {wt.task_id && <span>task {wt.task_id}</span>}
                {wt.session_id && <span>session {wt.session_id}</span>}
              </div>
              {wt.last_error && <div className="mt-1 text-[10px] text-accent-red">{wt.last_error}</div>}
              <div className="mt-2 flex flex-wrap gap-1">
                <button type="button" className="codex-secondary-btn h-7 text-[11px]" onClick={() => void run(`open-${wt.id}`, () => onOpenSession(wt))} disabled={busy !== null || !canOpen}>
                  <Send size={12} />
                  <span>{t('worktree.open', 'Open')}</span>
                </button>
                <button type="button" className="codex-secondary-btn h-7 text-[11px]" onClick={() => void copyPath(wt.path)} disabled={busy !== null} title={t('worktree.copyPath', 'Copy path')}>
                  {copiedPath === wt.path ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                  <span>{copiedPath === wt.path ? t('common.copied', 'Copied') : t('worktree.path', 'Path')}</span>
                </button>
                <button type="button" className="codex-secondary-btn h-7 text-[11px]" onClick={() => void toggleDiff(wt)} disabled={busy !== null || !canOpen}>
                  <FileText size={12} />
                  <span>{t('worktree.diff', 'Diff')}</span>
                </button>
                <button type="button" className="codex-secondary-btn h-7 text-[11px]" onClick={() => setConfirmAction({ type: 'merge', worktree: wt })} disabled={busy !== null || !canMerge} title={!canMerge ? t('worktree.mergeDisabledHint', 'Worktree must exist, be clean, unmerged, and not be failed/removed') : undefined}>
                  <GitPullRequest size={12} />
                  <span>{t('worktree.merge', 'Merge')}</span>
                </button>
                <button type="button" className="codex-secondary-btn h-7 text-[11px] !text-accent-red" onClick={() => setConfirmAction({ type: 'remove', worktree: wt })} disabled={busy !== null || normalizedStatus === 'removed'}>
                  <X size={12} />
                  <span>{t('worktree.delete', 'Delete')}</span>
                </button>
              </div>
              {expandedWorktreeId === wt.id && (
                <div className="mt-2 space-y-2 rounded-md border border-border-muted bg-bg-card p-2">
                  <div className="flex gap-1">
                    <input
                      className="min-w-0 flex-1 rounded-md border border-border-muted bg-bg-secondary px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent-blue"
                      value={commitMessages[wt.id] || ''}
                      onChange={(event) => setCommitMessages((current) => ({ ...current, [wt.id]: event.target.value }))}
                      placeholder="commit message"
                    />
                    <button
                      type="button"
                      className="codex-secondary-btn h-8 text-[11px]"
                      onClick={() => void commitCurrent(wt)}
                      disabled={busy !== null || !(commitMessages[wt.id] || '').trim() || dirty === 0}
                    >
                      <CheckCircle2 size={12} />
                      <span>Commit</span>
                    </button>
                  </div>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border-muted bg-bg-secondary p-2 text-[10px] leading-4 text-text-secondary">
                    {diffText}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmationDialog
        open={confirmAction !== null}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        cancelLabel="Cancel"
        variant={confirmVariant}
        onConfirm={runConfirmedAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

function ReviewTool({
  branch,
  changedFiles,
  remoteLabel,
  prCountLabel,
  firstMrTitle,
  isMRLoading,
  busyAction,
  gitLoading,
  commitMessage,
  setCommitMessage,
  canCommitOrPush,
  onFetchMRs,
  onCommitAndPush,
  onOpenGit,
  deliveryEvidence,
  onOpenEvidenceRef,
}: {
  branch: string;
  changedFiles: number;
  remoteLabel: string;
  prCountLabel: string;
  firstMrTitle?: string;
  isMRLoading: boolean;
  busyAction: string | null;
  gitLoading: boolean;
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  canCommitOrPush: boolean;
  onFetchMRs: () => void;
  onCommitAndPush: () => void;
  onOpenGit: () => void;
  deliveryEvidence: DeliveryEvidenceViewModel[];
  onOpenEvidenceRef: (ref: DeliveryEvidenceArtifactRef) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workbench-review">
      <DeliveryEvidencePanel items={deliveryEvidence} onOpenRef={onOpenEvidenceRef} />

      <div className="my-4 border-t border-border-muted" />

      <div className="space-y-1.5">
        <PanelRow icon={<GitBranch size={15} />} label={branch} sublabel={changedFiles > 0 ? t('workbench.uncommittedFiles', '未提交 {{count}} 个文件', { count: changedFiles }) : t('workbench.clean', '工作区干净')} onClick={onOpenGit} />
        <PanelRow icon={<Github size={15} />} label={remoteLabel} sublabel={t('workbench.gitPlatform', '代码托管平台')} onClick={onOpenGit} />
        <PanelRow
          icon={<GitPullRequest size={15} />}
          label={prCountLabel}
          sublabel={firstMrTitle}
          onClick={onFetchMRs}
          trailing={isMRLoading ? <Loader2 size={13} className="animate-spin" /> : undefined}
        />
      </div>

      <div className="my-4 border-t border-border-muted" />

      <div className="space-y-2">
        <div className="text-xs text-text-tertiary">{t('workbench.commitOrPush', '提交或推送')}</div>
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder={t('workbench.commitPlaceholder', '提交信息（可留空只推送）')}
          className="h-24 w-full resize-none rounded-lg border border-border-input bg-bg-input px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-brand/50"
        />
        <button
          type="button"
          disabled={busyAction !== null || gitLoading || !canCommitOrPush}
          onClick={onCommitAndPush}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-text-primary px-3 py-2 text-sm text-bg-primary transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busyAction === 'commit-push' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {t('workbench.commitOrPush', '提交或推送')}
        </button>
      </div>

      <div className="my-4 border-t border-border-muted" />

      <button
        type="button"
        onClick={onOpenGit}
        className="flex w-full items-center gap-2 rounded-lg border border-border-default px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <SlidersHorizontal size={15} />
        {t('workbench.openGit', '打开完整 Git 管理')}
      </button>
    </div>
  );
}

function DeliveryEvidencePanel({
  items,
  onOpenRef,
}: {
  items: DeliveryEvidenceViewModel[];
  onOpenRef: (ref: DeliveryEvidenceArtifactRef) => void;
}) {
  const { t } = useTranslation();
  const latest = items[0];
  const completed = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length;
  const totalFiles = items.reduce((sum, item) => sum + item.filesCreated.length + item.filesModified.length, 0);
  const totalCommands = items.reduce((sum, item) => sum + item.commandsRun.length, 0);
  const totalVerification = items.reduce((sum, item) => sum + item.verification.length, 0);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <CheckCircle2 size={15} className={failed > 0 ? 'text-accent-yellow' : 'text-accent-green'} />
          <span>{t('workbench.deliveryEvidence', '交付证据')}</span>
        </div>
        <span className="rounded border border-border-muted px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">
          {items.length}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-border-muted bg-bg-secondary px-3 py-6 text-center text-xs text-text-tertiary">
          {t('workbench.noDeliveryEvidence', '暂无 worker 交付证据')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-1.5">
            <EvidenceMetric label={t('workbench.evidenceDone', '完成')} value={completed} tone="green" />
            <EvidenceMetric label={t('workbench.evidenceFiles', '文件')} value={totalFiles} />
            <EvidenceMetric label={t('workbench.evidenceCommands', '命令')} value={totalCommands} />
            <EvidenceMetric label={t('workbench.evidenceChecks', '验证')} value={totalVerification} tone={failed > 0 ? 'yellow' : 'default'} />
          </div>

          {latest && (
            <div className="rounded-lg border border-border-muted bg-bg-secondary p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-text-primary" title={latest.title}>{latest.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-text-tertiary">
                    {latest.agentName && <span>{latest.agentName}</span>}
                    {latest.taskId && <span className="font-mono">task {latest.taskId}</span>}
                    <span className="uppercase">{latest.status}</span>
                  </div>
                </div>
                {latest.status === 'failed' || latest.status === 'cancelled' ? (
                  <XCircle size={14} className="shrink-0 text-accent-red" />
                ) : (
                  <CheckCircle2 size={14} className="shrink-0 text-accent-green" />
                )}
              </div>

              {latest.summary && (
                <p className="mb-3 line-clamp-4 text-xs leading-5 text-text-secondary">{latest.summary}</p>
              )}

              <EvidenceList title={t('workbench.evidenceFilesChanged', '文件')} values={[...latest.filesCreated, ...latest.filesModified]} />
              <EvidenceList title={t('workbench.evidenceCommandsRun', '命令')} values={latest.commandsRun} monospace />
              <VerificationList items={latest.verification} />

              {latest.artifactRefs.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">{t('workbench.evidenceRefs', '引用')}</div>
                  <div className="flex flex-wrap gap-1">
                    {latest.artifactRefs.slice(0, 8).map((ref, index) => (
                      <button
                        key={`${ref.path || ref.url || ref.label || index}`}
                        type="button"
                        className="rounded border border-border-muted bg-bg-card px-2 py-1 text-[10px] text-text-secondary hover:border-border-default hover:bg-bg-hover hover:text-text-primary"
                        onClick={() => onOpenRef(ref)}
                        title={ref.path || ref.url || ref.label}
                      >
                        {ref.label || ref.path || ref.url}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {items.length > 1 && (
            <div className="space-y-1">
              {items.slice(1, 4).map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded-md border border-border-muted bg-bg-secondary px-2.5 py-2">
                  {item.status === 'failed' || item.status === 'cancelled' ? <XCircle size={12} className="text-accent-red" /> : <CheckCircle2 size={12} className="text-accent-green" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-text-secondary">{item.title}</div>
                    <div className="truncate text-[10px] text-text-tertiary">{item.agentName || item.taskId || item.status}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EvidenceMetric({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'green' | 'yellow' }) {
  const color = tone === 'green' ? 'text-accent-green' : tone === 'yellow' ? 'text-accent-yellow' : 'text-text-primary';
  return (
    <div className="rounded-md border border-border-muted bg-bg-secondary px-2 py-1.5">
      <div className={`font-mono text-sm font-semibold ${color}`}>{value}</div>
      <div className="truncate text-[10px] text-text-tertiary">{label}</div>
    </div>
  );
}

function EvidenceList({ title, values, monospace = false }: { title: string; values: string[]; monospace?: boolean }) {
  if (values.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">{title}</div>
      <div className="space-y-0.5">
        {values.slice(0, 5).map((value) => (
          <div key={value} className={`truncate rounded border border-border-muted bg-bg-card px-2 py-1 text-[10px] text-text-secondary ${monospace ? 'font-mono' : ''}`} title={value}>
            {value}
          </div>
        ))}
        {values.length > 5 && <div className="text-[10px] text-text-tertiary">+{values.length - 5}</div>}
      </div>
    </div>
  );
}

function VerificationList({ items }: { items: DeliveryEvidenceViewModel['verification'] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-tertiary">{t('workbench.evidenceVerification', '验证')}</div>
      <div className="space-y-0.5">
        {items.slice(0, 4).map((item, index) => (
          <div key={`${item.kind}-${item.detail}-${index}`} className="flex items-start gap-1.5 rounded border border-border-muted bg-bg-card px-2 py-1 text-[10px] text-text-secondary">
            {item.passed ? <CheckCircle2 size={11} className="mt-0.5 shrink-0 text-accent-green" /> : <XCircle size={11} className="mt-0.5 shrink-0 text-accent-red" />}
            <span className="min-w-0">
              <span className="font-medium">{item.kind}</span>
              <span className="text-text-tertiary"> · {item.detail}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelRow({
  icon,
  label,
  sublabel,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-hover">
      <span className="shrink-0 text-text-tertiary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-secondary">{label}</span>
        {sublabel && <span className="block truncate text-xs text-text-tertiary">{sublabel}</span>}
      </span>
      {trailing && <span className="shrink-0 text-text-tertiary">{trailing}</span>}
    </button>
  );
}
