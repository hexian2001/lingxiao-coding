/**
 * LingXiaoTUI - Clean, working TUI
 * - Fixed message viewport with bottom-pinned chat output
 * - Per-message height constraining with Ctrl+S toggle (MaxSizedBox design)
 * - App-level mouse wheel scroll inside the message viewport
 * - Raw stdin with escape sequence buffering (passthrough mode)
 * - Large pastes folded to placeholder, expanded on submit via pendingPastesMapRef
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useStdout, useStdin } from 'ink';
import stringWidth from 'string-width';
import type { CommandArgItem } from './CommandArgPicker.js';
import type { QuestionDialogState } from './QuestionDialog.js';
import type { RewindDialogState } from './runtime/keyHandlers/useRewindDialogKeyHandler.js';
import { AgentRuntimePanel } from './AgentRuntimePanel.js';
import { BlueprintPanel } from './BlueprintPanel.js';
import { WelcomeBanner } from './components/WelcomeBanner.js';
import { HomeScreen } from './layout/HomeScreen.js';
import { config, setConfigValue, saveSettings, ConfigSchema } from '../config.js';
import { LLM } from '../config/defaults.js';
import { NotificationBanner } from './NotificationCenter.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import {
  MessageLog,
  getMessageLogSelectableText,
  getSelectedMessageText,
  type MessageSelectionPoint,
  type MessageSelectionRange,
} from './layout/MessageLog.js';
import { HeaderBar } from './layout/HeaderBar.js';
import { Composer } from './layout/Composer.js';
import { SuggestionsList } from './layout/SuggestionsList.js';
import { ModalHost } from './layout/ModalHost.js';
import { PanelFrame } from './components/PanelFrame.js';
import { useTuiEventBridge, type TuiEventHandler } from './runtime/useTuiEventBridge.js';
import { useTerminalSize } from './runtime/useTerminalSize.js';
import { useLeaderHeartbeat } from './runtime/useLeaderHeartbeat.js';
import { useRawTerminalInput } from './runtime/useRawTerminalInput.js';
import { useTuiKeyController } from './runtime/useTuiKeyController.js';
import { useTuiSubmitController } from './runtime/useTuiSubmitController.js';
import { useTuiModalOverlay } from './runtime/useTuiModalOverlay.js';
import { useTuiModalController } from './runtime/useTuiModalController.js';
import { useTuiPasteController } from './runtime/useTuiPasteController.js';
import { useTuiTokenBuffer } from './runtime/useTuiTokenBuffer.js';
import { useTuiLeaderHandlers } from './runtime/useTuiLeaderHandlers.js';
import { useTuiAgentHandlers } from './runtime/useTuiAgentHandlers.js';
import { t, setLanguage } from '../i18n.js';
import { TuiSidebar, getSidebarItemAtRow, type SidebarItem } from './layout/TuiSidebar.js';
import { resolveMessageLineScrollOffset } from './layout/messageViewport.js';
import {
  EMPTY_SETTINGS_EDIT, getFlatSettingsEntries, getSettingsItemAtRow, getSettingsItemCount,
  type SettingsEditState,
} from './SettingsPanel.js';
import type { MouseClickEvent } from '../ui/mouseWheel.js';
import { openUrlInSystemBrowser } from '../core/SystemBrowserOpener.js';
import { ServerAuth } from '../web-server/ServerAuth.js';

import type {
  CommandInitialChannelSeed as InitialChannelSeed,
  CommandListItem,
  CommandLogMessage as LogMessage,
  CommandResult,
  CommandSessionStatusData as SessionStatusData,
  CommandTaskData as TaskData,
} from '../commands/types.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import {
  getSlashCommandMetadata,
  getSlashCommands,
} from '../commands/slash_registry.js';
import {
  buildPermissionPreviewHint,
  buildPermissionPreviewPanel,
  buildMessageLogView,
  buildShortcutHintText,
  buildSuggestions,
  cycleSelectionIndex,
  describeInputTarget,
  LOCALIZED_AWAITING_INPUT_STATUSES,
  normalizeLocalizedAwaitingInputStatus,
  resolveModeForTabSwitch,
  resolveQuickTabTarget,
  sortTasksForDisplay,
  selectStreamFlushDelay,
  truncateDisplayText,
} from './utils.js';
import type { SuggestionItem, SuggestionType } from './utils.js';
import type {
  AgentRuntimeDiagnostic,
  ApprovalBannerState,
  ChannelState,
} from './state/types.js';
import type { WorkerBackend } from '../contracts/types/Agent.js';
import { createPermissionSync } from './state/permissionSync.js';
import type { WorkerInteractiveRuntimeSnapshot } from '../agents/runtime/WorkerInteractiveRuntime.js';
import {
  isRunTerminalStatus,
  normalizeLeaderStatusKind,
  normalizeRunStatus,
  type NormalizedLeaderStatusKind,
} from '../core/StateSemantics.js';
import { createStreamBufferCoordinator } from './state/streamBuffer.js';
import {
  appendChannelMessage as appendChannelMessageState,
  appendChannelStreamChunk,
  clearChannelStreams as clearChannelStreamsState,
  createInitialChannelMap,
  ensureChannelState as ensureChannelStateMap,
  getChannelDisplayStatus,
  resetChannelTransients,
  updateChannelState,
} from './state/channelState.js';
import { buildInteractiveRuntimePanelView } from './state/interactivePanel.js';
import { buildSubmittedPlanContent } from './state/planMessage.js';
import { buildTuiSessionRuntimeProjection } from './state/sessionRuntimeProjection.js';
import {
  buildTaskCounts,
  buildTaskSummaryText,
  buildTuiModeActionText,
  buildTuiLayoutBudget,
  buildTuiMetaLine,
  buildTuiStatusView,
  formatTuiAutonomyMode,
  formatTuiCollaborationMode,
  formatTuiPermissionMode,
  formatTuiRoutePreference,
  formatTuiRouteHint,
} from './state/tuiViewModel.js';
import { tuiTheme } from './theme.js';
import { isConstrainHeight } from './components/ConstrainedBox.js';
import { MaintenanceStatusLine } from './components/MaintenanceStatusLine.js';
import { copyToClipboard } from './clipboard.js';
import { getLastCodeBlock } from './state/codeBlockRegistry.js';
import { buildMemoryMaintenanceStatus } from '../memory/MemoryMaintenanceStatus.js';
import type { TuiMemoryStatus } from './MemoryPanel.js';

type TuiEventRecord = Record<string, unknown>;
const eventRecord = (event: object): TuiEventRecord => event as TuiEventRecord;
const readLeaderStatusKind = (value: unknown): NormalizedLeaderStatusKind | undefined => {
  return value === 'active'
    || value === 'idle'
    || value === 'waiting'
    || value === 'interrupted'
    || value === 'completed'
    ? value
    : undefined;
};
type TuiBlackboardNodeKind = 'fact' | 'intent' | 'hint' | 'origin' | 'goal';
type TuiBlackboardIntentStatus = 'open' | 'exploring' | 'resolved' | 'abandoned';
type TuiBlackboardNode = {
  id: string;
  kind: TuiBlackboardNodeKind;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: number;
  supersededBy?: string;
  confidence?: 'confirmed' | 'likely' | 'tentative';
  intentStatus?: TuiBlackboardIntentStatus;
  priority?: number;
};
type TuiBlackboardEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  createdAt: number;
};
type TuiSessionSnapshotChannelSeed = InitialChannelSeed & {
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
};

type TuiPermissionMode = 'yolo' | 'networked' | 'dev' | 'strict';
type TuiRoutePreference = 'auto' | 'direct' | 'delegate';
type TuiAutonomyMode = 'review_first' | 'balanced' | 'autonomous';
type TuiCollaborationMode = 'solo' | 'team';

const TUI_PERMISSION_MODES: readonly TuiPermissionMode[] = ['yolo', 'networked', 'dev', 'strict'];
const TUI_ROUTE_PREFERENCES: readonly TuiRoutePreference[] = ['auto', 'direct', 'delegate'];
const TUI_AUTONOMY_MODES: readonly TuiAutonomyMode[] = ['review_first', 'balanced', 'autonomous'];

function commandResultContent(result: CommandResult | string | void, fallback: string): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result && typeof result.content === 'string') {
    return result.content;
  }
  return fallback;
}

function readTuiPermissionMode(value: unknown): TuiPermissionMode | null {
  return TUI_PERMISSION_MODES.includes(value as TuiPermissionMode) ? value as TuiPermissionMode : null;
}

function readTuiRoutePreference(value: unknown): TuiRoutePreference | null {
  return TUI_ROUTE_PREFERENCES.includes(value as TuiRoutePreference) ? value as TuiRoutePreference : null;
}

function readTuiAutonomyMode(value: unknown): TuiAutonomyMode | null {
  return TUI_AUTONOMY_MODES.includes(value as TuiAutonomyMode) ? value as TuiAutonomyMode : null;
}
type TuiSessionSnapshotDto = {
  sessionStatus: SessionStatusData;
  tasks?: TaskData[];
  messages?: LogMessage[];
  channels?: TuiSessionSnapshotChannelSeed[];
  tokenUsage?: number;
  agentTokens?: Record<string, number>;
  leaderStatus?: string;
  leaderMode?: 'direct' | 'hybrid' | 'delegate';
  leaderReason?: string;
};

const TUI_BLACKBOARD_NODE_KINDS = new Set<TuiBlackboardNodeKind>(['fact', 'intent', 'hint', 'origin', 'goal']);
const TUI_BLACKBOARD_CONFIDENCE = new Set(['confirmed', 'likely', 'tentative']);
const TUI_BLACKBOARD_INTENT_STATUS = new Set<TuiBlackboardIntentStatus>(['open', 'exploring', 'resolved', 'abandoned']);

function isTuiBlackboardNode(value: unknown): value is TuiBlackboardNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as TuiEventRecord;
  return typeof node.id === 'string'
    && typeof node.kind === 'string'
    && TUI_BLACKBOARD_NODE_KINDS.has(node.kind as TuiBlackboardNodeKind)
    && typeof node.title === 'string'
    && typeof node.content === 'string'
    && Array.isArray(node.tags)
    && node.tags.every((tag) => typeof tag === 'string')
    && typeof node.createdBy === 'string'
    && typeof node.createdAt === 'number'
    && (node.supersededBy === undefined || typeof node.supersededBy === 'string')
    && (node.confidence === undefined || (typeof node.confidence === 'string' && TUI_BLACKBOARD_CONFIDENCE.has(node.confidence)))
    && (node.intentStatus === undefined || (typeof node.intentStatus === 'string' && TUI_BLACKBOARD_INTENT_STATUS.has(node.intentStatus as TuiBlackboardIntentStatus)))
    && (node.priority === undefined || typeof node.priority === 'number');
}

function isTuiBlackboardEdge(value: unknown): value is TuiBlackboardEdge {
  if (!value || typeof value !== 'object') return false;
  const edge = value as TuiEventRecord;
  return typeof edge.id === 'string'
    && typeof edge.fromNodeId === 'string'
    && typeof edge.toNodeId === 'string'
    && typeof edge.edgeType === 'string'
    && typeof edge.createdAt === 'number';
}

// ─── Module-level constants ───
/** DAG modal page size for arrow/page navigation */
const DAG_MODAL_PAGE_SIZE = 12;

interface LingXiaoTUIProps {
  emitter: EventEmitter;
  sessionId?: string;
  workspace: string;
  webUrl?: string;
  initialStatus: SessionStatusData;
  initialTasks: TaskData[];
  initialMessages: LogMessage[];
  initialChannels: InitialChannelSeed[];
  initialTokenUsage: number;
  initialAgentTokens: Record<string, number>;
  initialLeaderStatus: string;
  initialLeaderMode?: 'direct'|'hybrid'|'delegate';
  initialLeaderModeReason?: string;
  availableSkills: string[];
  /** 初始项目蓝图(cli 从 session state 读入,首屏展示)。 */
  initialBlueprint?: import('../core/ProjectBlueprint.js').ProjectBlueprint | null;
  /** 打开蓝图面板时按需拉取最新蓝图(cli 注入的 db reader)。 */
  readProjectBlueprint?: () => import('../core/ProjectBlueprint.js').ProjectBlueprint | null;
  onSubmit: (input: string, target: string) => Promise<void>;
  /** 非打断式发送：消息注入到 Leader 下一轮 LLM 调用，不中断当前思考 */
  onNudge?: (input: string) => Promise<void>;
  onCommand: (cmd: string) => Promise<CommandResult|string|void>;
  /** 查询当前会话累计费用($),host 经 calculateSessionCost(db.getTokenSummary) 算出。侧栏状态面板用。 */
  getCostSummary?: () => number;
  onSessionFocus?: (sessionId: string) => void;
  loadSessionSnapshot?: (sessionId: string) => Promise<TuiSessionSnapshotDto | null>;
  onInterrupt: () => Promise<boolean>;
  /** 停止单个 Agent（不影响 Leader 与其它 Agent）。参数为 agent name（= 渠道名）。 */
  onStopAgent?: (agentName: string) => Promise<boolean>;
  onClearPendingMessages?: () => Promise<void>;
}

// Ink's useInput Key type (not directly exported by ink)
type inkKey = {
  upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean;
  return: boolean; escape: boolean; ctrl: boolean; shift: boolean; tab: boolean;
  backspace: boolean; delete: boolean; pageDown: boolean; pageUp: boolean;
  home: boolean; end: boolean; meta: boolean;
  super: boolean; hyper: boolean; capsLock: boolean; numLock: boolean;
};

export const LingXiaoTUI: React.FC<LingXiaoTUIProps> = ({
  emitter, sessionId, workspace, webUrl, initialStatus, initialTasks, initialMessages,
  initialChannels, initialTokenUsage, initialAgentTokens, initialLeaderStatus,
  initialLeaderMode, initialLeaderModeReason, availableSkills, initialBlueprint, readProjectBlueprint, onSubmit, onNudge, onCommand, getCostSummary, onSessionFocus, loadSessionSnapshot, onInterrupt, onStopAgent, onClearPendingMessages,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin, setRawMode } = useStdin();
  const termSize = useTerminalSize(stdout);
  const processExitRequestedRef = useRef(false);
  const requestProcessExit = useCallback((reason: string) => {
    if (processExitRequestedRef.current) return;
    processExitRequestedRef.current = true;
    emitter.emit('shutdown', { reason });
    exit();
    setTimeout(() => {
      process.exit(0);
    }, 250).unref?.();
  }, [emitter, exit]);
  const initialLeaderDisplayStatus = normalizeLocalizedAwaitingInputStatus(initialLeaderStatus);
  const [sessionStatus, setSessionStatus] = useState(initialStatus);
  const [leaderStatus, setLeaderStatus] = useState(initialLeaderDisplayStatus);
  const [leaderMode, setLeaderMode] = useState(initialLeaderMode);
  const [leaderModeReason, setLeaderModeReason] = useState(initialLeaderModeReason || '');
  const [tasks, setTasks] = useState(initialTasks);
  // 黑板图状态
  const [graphNodes, setGraphNodes] = useState<TuiBlackboardNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<TuiBlackboardEdge[]>([]);
  const [graphEnabled, setGraphEnabled] = useState(config.blackboard?.enabled ?? false);
  const initialAgentChannels = useMemo(
    () => initialChannels.filter((channel) => channel.name !== 'main'),
    [initialChannels],
  );
  const initialLaunchedAgents = useMemo(
    () => initialAgentChannels.map((channel) => ({
      name: channel.name,
      role: channel.role || 'worker',
      taskId: channel.taskId || '',
      backend: (channel as TuiSessionSnapshotChannelSeed).backend,
      externalSessionId: (channel as TuiSessionSnapshotChannelSeed).externalSessionId,
      pid: (channel as TuiSessionSnapshotChannelSeed).pid,
    })),
    [initialAgentChannels],
  );
  const initialAgentIdMap = useMemo(
    () => Object.fromEntries(
      initialAgentChannels.flatMap((channel) => (
        channel.agentId ? [[channel.agentId, channel.name] as const] : []
      )),
    ),
    [initialAgentChannels],
  );
  const [currentTab, setCurrentTab] = useState('main');
  const [tabOrder, setTabOrder] = useState(() => ['main', ...initialAgentChannels.map((channel) => channel.name)]);
  const [languageVersion, setLanguageVersion] = useState(0);
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);
  const [messageSelection, setMessageSelection] = useState<MessageSelectionRange | null>(null);
  // 已展开的 thinking/tool 卡片 key 集合;未含于此 = 折叠态(默认全折叠)。逐卡鼠标点击 toggle。
  const [expandedCards, setExpandedCards] = useState<Set<string>>(() => new Set());
  // Mouse tracking on = in-TUI selection/sidebar clicks/wheel; off = native terminal selection
  const [mouseTrackingEnabled, setMouseTrackingEnabled] = useState(true);
  const [memoryStatus, setMemoryStatus] = useState<TuiMemoryStatus | null>(null);

  const refreshMemoryStatus = useCallback(() => {
    try {
      setMemoryStatus(buildMemoryMaintenanceStatus(workspace));
    } catch {
      setMemoryStatus(null);
    }
  }, [workspace]);

  useEffect(() => {
    refreshMemoryStatus();
  }, [refreshMemoryStatus]);

  // ── Sidebar ──
  const SIDEBAR_WIDTH = 20;
  const showSidebar = termSize.cols >= 80;
  const sidebarItems: SidebarItem[] = useMemo(() => {
    const fixed: SidebarItem[] = [
      { id: 'main', label: t('tui.sidebar.chat') },
      { id: '__tasks', label: t('tui.sidebar.tasks') },
      { id: '__blueprint', label: t('tui.sidebar.blueprint') },
      { id: '__contracts', label: '契约' },
      { id: '__agents', label: t('tui.sidebar.agents') },
      { id: '__blackboard', label: t('tui.sidebar.graph') },
      { id: '__git', label: t('tui.sidebar.git') },
      {
        id: '__memory',
        label: t('tui.sidebar.memory'),
        badge: memoryStatus?.pipelines.dream.due || memoryStatus?.pipelines.distill.due ? 1 : undefined,
      },
      { id: '__report', label: t('tui.sidebar.report') },
      { id: '__settings', label: t('tui.sidebar.settings') },
    ];
    // Add dynamic agent tabs
    const agentTabs = tabOrder.filter(tab => tab !== 'main').map((name) => ({
      id: name,
      label: `@${name}`,
    }));
    return [...fixed, ...agentTabs];
  }, [tabOrder, languageVersion, memoryStatus]);

  const handleMouseClickRef = useRef<(event: MouseClickEvent) => void>(() => {});
  const handleMouseClick = useCallback((event: MouseClickEvent) => {
    handleMouseClickRef.current(event);
  }, []);

  const [channels, setChannels] = useState<Record<string, ChannelState>>(() => createInitialChannelMap(initialMessages, initialChannels));
  const [inputBuffer, setInputBuffer] = useState('');
  const [inputCursor, setInputCursor] = useState(0);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pendingPermissionRequest, setPendingPermissionRequest] = useState<ApprovalBannerState|null>(null);
  const [currentMode, setCurrentMode] = useState<'chat'|'plan'|'agent'>('chat');
  // Command argument picker state
  const [commandArgPickerState, setCommandArgPickerState] = useState<{
    commandName: string;
    items: CommandArgItem[];
    cursor: number;
    filter: string;
  } | null>(null);

  // Agent question dialog state (when leader calls ask_user tool)
  const [agentQuestionState, setAgentQuestionState] = useState<QuestionDialogState | null>(null);
  const agentQuestionStateRef = useRef(agentQuestionState);

  // Rewind dialog state (interactive /rewind checkpoint picker)
  const [rewindDialogState, setRewindDialogState] = useState<RewindDialogState | null>(null);
  const rewindDialogStateRef = useRef(rewindDialogState);

  // Settings panel inline edit state
  const [settingsEditState, setSettingsEditState] = useState<SettingsEditState>(EMPTY_SETTINGS_EDIT);
  const settingsEditStateRef = useRef(settingsEditState);
  const [settingsFeedback, setSettingsFeedback] = useState<import('./SettingsPanel.js').SettingsFeedback | null>(null);
  const settingsFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSettingsFeedback = useCallback((text: string, type: 'success' | 'error') => {
    if (settingsFeedbackTimerRef.current) clearTimeout(settingsFeedbackTimerRef.current);
    setSettingsFeedback({ text, type });
    settingsFeedbackTimerRef.current = setTimeout(() => setSettingsFeedback(null), 2000);
  }, []);
  const [modeActionFlash, setModeActionFlash] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const modeActionFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showModeActionFlash = useCallback((text: string, tone: 'success' | 'error' = 'success') => {
    if (modeActionFlashTimerRef.current) clearTimeout(modeActionFlashTimerRef.current);
    setModeActionFlash({ text, tone });
    modeActionFlashTimerRef.current = setTimeout(() => setModeActionFlash(null), 1400);
  }, []);
  useEffect(() => {
    return () => {
      if (modeActionFlashTimerRef.current) clearTimeout(modeActionFlashTimerRef.current);
    };
  }, []);


  const pasteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [leaderRuntimeActive, setLeaderRuntimeActive] = useState(false);
  const [leaderRuntimeQueueLength, setLeaderRuntimeQueueLength] = useState(0);
  const [leaderRuntimeModel, setLeaderRuntimeModel] = useState<string | undefined>(undefined);
  const [mainQueuedCount, setMainQueuedCount] = useState(0);
  const leaderRuntimeActiveRef = useRef(false);
  const leaderRuntimeQueueLengthRef = useRef(0);
  // 当前正在等待响应的消息（用于在队列预览中显示）
  const [inFlightMessage, setInFlightMessage] = useState('');
  const inFlightMessageRef = useRef('');
  const [tokenUsage, setTokenUsage] = useState<{ total: number }>({ total: initialTokenUsage });
  // 会话累计费用($):token 变化时经 host getCostSummary 重算,供侧栏状态面板显示
  const [sessionCost, setSessionCost] = useState<number>(0);
  // token 变化时重算会话费用(host 经 db + calculateSessionCost);ref 避免闭包陈旧
  const getCostSummaryRef = useRef(getCostSummary);
  getCostSummaryRef.current = getCostSummary;
  useEffect(() => {
    const fn = getCostSummaryRef.current;
    if (!fn) { setSessionCost(0); return; }
    try { setSessionCost(fn() ?? 0); } catch { /* tolerate: 费用查询失败不影响主流程 */ }
  }, [tokenUsage.total]);
  const [agentTokens, setAgentTokens] = useState<Record<string, number>>(initialAgentTokens);
  const [currentContextTokenTotal, setCurrentContextTokenTotal] = useState<number|undefined>(undefined);
  const [currentContextLimit, setCurrentContextLimit] = useState<number|undefined>(undefined);
  const [currentContextPct, setCurrentContextPct] = useState<number|undefined>(undefined);
  const [agentDiagnostics, setAgentDiagnostics] = useState<Record<string, AgentRuntimeDiagnostic>>({});
  const [agentInteractiveStates, setAgentInteractiveStates] = useState<Record<string, WorkerInteractiveRuntimeSnapshot>>({});
  const [launchedAgents, setLaunchedAgents] = useState<Array<{name:string;role:string;taskId:string;backend?: WorkerBackend; externalSessionId?: string; pid?: number}>>(initialLaunchedAgents);
  const [, setUiClock] = useState(0);
  const [streamingTick, setStreamingTick] = useState(0);
  /** 工具执行实时状态 — 驱动 StreamingStatusLine tool_executing phase + 计时器 */
  const [toolExecutingState, setToolExecutingState] = useState<{ toolName?: string; startedAt?: number; partialJson?: string }>({});
  const toolExecutingStateRef = useRef(toolExecutingState);
  toolExecutingStateRef.current = toolExecutingState;
  /** 上下文压缩进行中状态（null = 未压缩）；驱动 StreamingStatusLine 显示压缩进度条 */
  const [compactingState, setCompactingState] = useState<{
    stage: string;
    chunkIndex?: number;
    chunkTotal?: number;
    percent?: number;
    oldTokens?: number;
    newTokens?: number;
    threshold?: number;
    messageCount?: number;
    label?: string;
    startedAt: number;
  } | null>(null);
  const [notifications, setNotifications] = useState<Array<import('./NotificationCenter.js').Notification>>([]);
  /** 记忆维护（dream/distill）进行中状态（null = 空闲）；驱动底部 MaintenanceStatusLine */
  const [maintenanceState, setMaintenanceState] = useState<{
    kind: 'dream' | 'distill';
    stage: string;
    progress: number;
    detail: string;
    startedAt: number;
  } | null>(null);
  const [workNotes, setWorkNotes] = useState<Array<import('./WorkNotesPanel.js').WorkNoteItem>>([]);
  const [gitData, setGitData] = useState<import('./GitPanel.js').GitPanelData | null>(null);
  const [blueprint, setBlueprint] = useState<import('../core/ProjectBlueprint.js').ProjectBlueprint | null>(initialBlueprint ?? null);
  const messageTimestampRef = useRef(0);
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const currentTabRef = useRef(currentTab);
  // 当前 TUI 正在展示的 session id（live）。emitter 跨 session 共享，事件桥据此过滤
  // 掉其它 session（如 Web UI 切走的会话）的 agent/leader/task 事件，防止串台。
  const sessionStatusRef = useRef(sessionStatus);
  sessionStatusRef.current = sessionStatus;
  const effectiveLeaderRuntimeActive = leaderRuntimeActive
    && !isRunTerminalStatus(sessionStatus.status);
  const clearLeaderRuntimeProjection = useCallback(() => {
    setLeaderRuntimeActive(false);
    leaderRuntimeActiveRef.current = false;
    setLeaderRuntimeQueueLength(0);
    leaderRuntimeQueueLengthRef.current = 0;
    setLeaderRuntimeModel(undefined);
  }, []);

  // 主 tab 只显示真实上下文 token（context:runtime_updated / context:compressed）。
  // API 累计用量单独显示，不能再拿来冒充上下文窗口占用。
  const mainContextTotal = currentContextTokenTotal;
  const currentTokenTotal = currentTab === 'main' ? (mainContextTotal ?? tokenUsage.total) : (agentTokens[currentTab] || 0);

  const channelsRef = useRef(channels);
  const leaderStatusRef = useRef(initialLeaderDisplayStatus);
  const leaderStatusKindRef = useRef<NormalizedLeaderStatusKind | undefined>(
    normalizeLeaderStatusKind(initialLeaderDisplayStatus),
  );
  const leaderPhaseRef = useRef<string | undefined>(undefined);
  const lastLeaderVisibleActivityAtRef = useRef(Date.now());
  const lastLeaderHeartbeatAtRef = useRef(0);
  const lastLeaderStatusLogRef = useRef('');
  const inputCursorRef = useRef(0);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef('');
  const inputHandlerRef = useRef<(input: string, key: unknown) => void>(() => {});
  const agentIdMapRef = useRef<Record<string,string>>(initialAgentIdMap);

  const currentChannel = channels[currentTab] || channels.main;
  const messageLogMaxLinesRef = useRef(0);
  const messageLogTotalLinesRef = useRef(0);
  const messageLogMetricsRef = useRef({ tab: currentTab, totalLines: 0 });
  const messageLogViewRef = useRef<ReturnType<typeof buildMessageLogView> | null>(null);
  const messageLogGeometryRef = useRef({ topRow: 1, bodyLeftCol: 1 });
  const messageSelectionRef = useRef<MessageSelectionRange | null>(null);
  const activeMessageSelectionRef = useRef<MessageSelectionRange | null>(null);
  const channelsForHeartbeatRef = useRef(channels);
  const sortedTasks = useMemo(() => sortTasksForDisplay(tasks), [tasks]);
  const taskCounts = useMemo(() => buildTaskCounts(tasks), [tasks]);

  const contextLimit = currentContextLimit && currentContextLimit > 0
    ? currentContextLimit
    : Math.max(currentContextTokenTotal ?? 0, Number(config.llm?.context_max_tokens) || LLM.CONTEXT_MAX_TOKENS);
  const inputTarget = useMemo(() => describeInputTarget(currentTab), [currentTab, languageVersion]);
  const shortcutHintText = useMemo(
    () => buildShortcutHintText({ maxWidth: Math.max(24, termSize.cols - 8) }),
    [termSize.cols, languageVersion],
  );
  const modeActionText = useMemo(
    () => buildTuiModeActionText(sessionStatus, Math.max(24, termSize.cols - 8), {
      feedback: modeActionFlash?.text,
      feedbackTone: modeActionFlash?.tone,
    }),
    [sessionStatus, termSize.cols, modeActionFlash, languageVersion],
  );
  const footerActivityText = truncateDisplayText(currentChannel?.currentNext || '', Math.max(32, termSize.cols - 24));
  const taskSummaryText = useMemo(() => buildTaskSummaryText(tasks, taskCounts), [tasks, taskCounts, languageVersion]);
  const currentAgentDiagnostic = currentTab !== 'main' ? agentDiagnostics[currentTab] : undefined;
  const currentAgentInteractiveState = currentTab !== 'main' ? agentInteractiveStates[currentTab] : undefined;
  const currentAgentRuntimePanel = useMemo(
    () => buildInteractiveRuntimePanelView(currentAgentInteractiveState, Math.max(24, termSize.cols - 4)),
    [currentAgentInteractiveState, termSize.cols, languageVersion],
  );
  const now = Date.now();
  const metaLine = useMemo(() => buildTuiMetaLine({
    sessionStatus,
    currentTab,
    tabOrder,
    channels,
    mainQueuedCount,
    taskSummaryText,
    currentAgentDiagnostic,
    currentAgentInteractiveState,
    maxWidth: Math.max(24, termSize.cols - 4),
    now,
  }), [sessionStatus, currentTab, tabOrder, channels, mainQueuedCount, taskSummaryText, currentAgentDiagnostic, currentAgentInteractiveState, termSize.cols, now, languageVersion]);
  const modelName = leaderRuntimeModel || config.llm.leader_model || config.llm.agent_model || 'default-model';
  const statusView = useMemo(() => buildTuiStatusView({
    modelName,
    currentTab,
    currentChannel,
    sessionStatus,
    leaderStatus,
    currentTokenTotal,
    footerActivityText,
    launchedAgents,
    channels,
    tabOrder,
    currentAgentDiagnostic,
    maxWidth: Math.max(24, termSize.cols - 4),
    now,
  }), [modelName, currentTab, currentChannel, sessionStatus, leaderStatus, currentTokenTotal, footerActivityText, launchedAgents, channels, tabOrder, currentAgentDiagnostic, termSize.cols, now, languageVersion]);
  const {
    currentAgentStatusDisplay,
    agentStatusItems,
    agentCandidates,
    statusSecondaryLine,
  } = statusView;
  const layoutBudget = useMemo(() => buildTuiLayoutBudget({
    termRows: termSize.rows,
    hasMetaLine: Boolean(metaLine),
    hasPermissionRequest: Boolean(pendingPermissionRequest),
    hasInteractiveRuntimePanel: currentTab !== 'main' && currentAgentRuntimePanel.visible,
    interactiveRuntimeLineCount: currentAgentRuntimePanel.lines.length,
    hasAgentStatusItems: agentStatusItems.length > 0,
    hasStatusSecondaryLine: Boolean(statusSecondaryLine),
    hasLeaderProcessingIndicator: effectiveLeaderRuntimeActive,
    hasModeActions: Boolean(modeActionText),
  }), [termSize.rows, metaLine, pendingPermissionRequest, currentTab, currentAgentRuntimePanel, agentStatusItems.length, statusSecondaryLine, effectiveLeaderRuntimeActive, modeActionText]);
  const { messageLogMaxLines } = layoutBudget;
  const mainAreaWidthForLog = showSidebar
    ? termSize.cols - SIDEBAR_WIDTH - 4
    : termSize.cols - 4;
  const messageLogWidth = Math.max(16, mainAreaWidthForLog - 4);
  const messageLogBodyWidth = Math.max(1, messageLogWidth - 3);
  useEffect(() => {
    messageLogMaxLinesRef.current = messageLogMaxLines;
  }, [messageLogMaxLines]);

  // Clock
  const ensureChannel = useCallback((name: string, role?: string, taskId?: string) => {
    setChannels(prev => ensureChannelStateMap(prev, name, role, taskId));
    setTabOrder(prev => prev.includes(name) ? prev : [...prev, name]);
  }, []);

  const appendMessage = useCallback((ch: string, msg: LogMessage) => {
    setChannels(prev => {
      // Use incrementing timestamp to ensure uniqueness
      messageTimestampRef.current += 1;
      return appendChannelMessageState(prev, ch, { ...msg, timestamp: msg.timestamp || messageTimestampRef.current });
    });
  }, []);

  const updateChannelStatus = useCallback((ch: string, status: string) => {
    setChannels(prev => {
      const c = prev[ch];
      if (!c || getChannelDisplayStatus(c) === status) return prev;
      return updateChannelState(prev, ch, { status });
    });
  }, []);

  const updateChannelNext = useCallback((ch: string, next: string) => {
    setChannels(prev => {
      const c = prev[ch];
      if (!c || c.currentNext === next) return prev;
      return updateChannelState(prev, ch, { currentNext: next });
    });
  }, []);

  const handleLanguageChanged = useCallback(() => {
    const awaitingInput = t('tui.leader.awaiting_input');

    setLanguageVersion((version) => version + 1);
    setLeaderStatus((prev) => {
      if (!LOCALIZED_AWAITING_INPUT_STATUSES.has(prev.trim())) return prev;
      leaderStatusRef.current = awaitingInput;
      return awaitingInput;
    });
    if (LOCALIZED_AWAITING_INPUT_STATUSES.has((leaderStatusRef.current || '').trim())) {
      leaderStatusRef.current = awaitingInput;
    }
    setChannels((prev) => {
      const main = prev.main;
      if (!main) return prev;
      let nextState = prev;
      let changed = false;
      if (LOCALIZED_AWAITING_INPUT_STATUSES.has(getChannelDisplayStatus(main).trim())) {
        nextState = updateChannelState(nextState, 'main', { status: awaitingInput });
        changed = true;
      }
      if (LOCALIZED_AWAITING_INPUT_STATUSES.has((main.currentNext || '').trim())) {
        nextState = updateChannelState(nextState, 'main', { currentNext: awaitingInput });
        changed = true;
      }
      return changed ? nextState : prev;
    });
  }, []);

  // Stream buffer flush delays — tuned for perceived smoothness.
  // Ink 框架每次 setState 触发全组件复绘，高频 flush 会形成视觉闪烁。
  // 折中方案：前台 30ms（~33fps 等效流畅感）、后台 200ms（大幅减少非活跃 agent 的渲染开销）。
  // 多 agent 并行时，后台 agent 流式数据会被合并批处理，显著降低 React 渲染压力。
  const STREAM_FLUSH_DELAY_MS = 30;
  const STREAM_FLUSH_BG_DELAY_MS = 200;

  const applyPendingStreamBuffer = useCallback((pending: Record<string, { currentStream?: string[]; currentThinkingStream?: string[] }>) => {
    setChannels(prev => {
      let next = prev;
      let changed = false;
      for (const ch of Object.keys(pending)) {
        const c = next[ch];
        if (!c) continue;
        const addStream = pending[ch].currentStream ? pending[ch].currentStream.join('') : '';
        const addThinking = pending[ch].currentThinkingStream ? pending[ch].currentThinkingStream.join('') : '';
        const curStream = c.currentStream || '';
        const curThinking = c.currentThinkingStream || '';

        const newStream = addStream ? `${curStream}${addStream}` : curStream;
        const newThinking = addThinking ? `${curThinking}${addThinking}` : curThinking;

        if (newStream === curStream && newThinking === curThinking) continue;
        if (next === prev) next = { ...prev };
        next[ch] = {
          ...c,
          currentStream: newStream,
          currentThinkingStream: newThinking,
          streamingState: (newStream || newThinking) ? 'responding' : c.streamingState,
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const streamBufferRef = useRef<ReturnType<typeof createStreamBufferCoordinator> | null>(null);
  if (!streamBufferRef.current) {
    streamBufferRef.current = createStreamBufferCoordinator({
      selectDelay: (channel?: string) => {
        if (!channel) return STREAM_FLUSH_DELAY_MS;
        return selectStreamFlushDelay({
          channel,
          currentTab: currentTabRef.current,
          foregroundMs: STREAM_FLUSH_DELAY_MS,
          backgroundMs: STREAM_FLUSH_BG_DELAY_MS,
        });
      },
      onFlush: applyPendingStreamBuffer,
      onFlushChannel: (channel, entry) => applyPendingStreamBuffer({ [channel]: entry }),
      maxChunksPerChannel: 50,
    });
  }

  const flushStreamBuffer = useCallback((onlyChannel?: string) => {
    streamBufferRef.current?.flush(onlyChannel);
  }, []);

  const dropPendingStream = useCallback((ch: string) => {
    streamBufferRef.current?.drop(ch);
  }, []);

  useEffect(() => {
    return () => {
      streamBufferRef.current?.dispose();
    };
  }, []);

  const appendChannelStream = useCallback((ch: string, field: 'currentStream'|'currentThinkingStream', chunk: string) => {
    streamBufferRef.current?.appendChunk(ch, field, chunk);
  }, []);

  const updateChannelStreams = useCallback((ch: string, updates: {currentStream?:string;currentThinkingStream?:string}) => {
    dropPendingStream(ch);
    setChannels(prev => {
      const c = prev[ch];
      if (!c) return prev;
      // Check whether a value actually changed
      let hasChange = false;
      if (updates.currentStream !== undefined && updates.currentStream !== c.currentStream) hasChange = true;
      if (updates.currentThinkingStream !== undefined && updates.currentThinkingStream !== c.currentThinkingStream) hasChange = true;
      if (!hasChange) return prev;
      const streamingState = (updates.currentStream || updates.currentThinkingStream) ? 'responding' : c.streamingState;
      return updateChannelState(prev, ch, { ...updates, streamingState });
    });
  }, [dropPendingStream]);

  const clearChannelStreams = useCallback((ch: string) => {
    dropPendingStream(ch);
    setChannels(prev => clearChannelStreamsState(prev, ch));
  }, [dropPendingStream]);

  const resetUiAfterInterrupt = useCallback(() => {
    const channelNames = Object.keys(channelsForHeartbeatRef.current || {});
    for (const name of channelNames) {
      streamBufferRef.current?.drop(name);
    }
    setChannels(prev => resetChannelTransients(prev, {
      mainStatus: 'Interrupted',
      defaultStatus: 'idle',
    }));
    setLeaderStatus('Interrupted');
    leaderStatusRef.current = 'Interrupted';
    setLeaderMode(undefined);
    setLeaderModeReason('');
    setSubmitting(false);
    clearLeaderRuntimeProjection();
    lastLeaderVisibleActivityAtRef.current = Date.now();
    lastLeaderHeartbeatAtRef.current = 0;
    lastLeaderStatusLogRef.current = '';
  }, [clearLeaderRuntimeProjection]);

  const markVisibleLeaderActivity = useCallback(() => { lastLeaderVisibleActivityAtRef.current = Date.now(); }, []);

  const throttledUpdateRef = useRef<{[key: string]: number}>({});
  const throttledUpdateChannelStatus = useCallback((ch: string, status: string) => {
    const now = Date.now();
    const key = `${ch}-${status}`;
    const lastCall = throttledUpdateRef.current[key] || 0;
    if (now - lastCall >= 500) {
      throttledUpdateRef.current[key] = now;
      updateChannelStatus(ch, status);
    }
  }, [updateChannelStatus]);

  const switchTabRef = useRef<(name: string) => void>(() => {});
  const switchTab = useCallback((name: string) => {
    setCurrentTab(name);
    setCurrentMode((prev) => {
      return resolveModeForTabSwitch(name, prev);
    });
  }, []);
  const tokenUsageHandlers = useTuiTokenBuffer({
    setTokenUsage,
    setAgentTokens,
    agentIdMapRef,
    setCurrentContextTokenTotal,
    setCurrentContextLimit,
    setCurrentContextPct,
    appendMessage,
    contextLimit,
  });

  const leaderHandlers = useTuiLeaderHandlers({
    appendMessage,
    setSessionStatus,
    resetUiAfterInterrupt,
    setLeaderStatus,
    setLeaderMode,
    setLeaderModeReason,
    setSubmitting,
    setInFlightMessage,
    leaderStatusRef,
    inFlightMessageRef,
    channelsRef,
    lastLeaderStatusLogRef,
    updateChannelStatus,
    updateChannelNext,
    appendChannelStream,
    clearChannelStreams,
    flushStreamBuffer,
    throttledUpdateChannelStatus,
    markVisibleLeaderActivity,
    switchTab,
    showThinkingContent: config.llm.show_thinking_content === true,
    setToolExecutingState,
    resetStreamingTokens: tokenUsageHandlers.resetStreamingTokens,
  });

  const permissionSync = useMemo(() => createPermissionSync({
    setSessionStatus,
    setPendingPermissionRequest,
    getPendingPermissionRequest: () => pendingPermissionRequest,
    appendMessage,
    buildPreviewHint: buildPermissionPreviewHint,
  }), [appendMessage, pendingPermissionRequest]);


  const _handleSessionInterrupted = leaderHandlers.handleSessionInterrupted;
  const handleSessionInterrupted = useCallback<TuiEventHandler<'session:interrupted'>>((event) => {
    _handleSessionInterrupted(event);
    leaderStatusKindRef.current = 'interrupted';
    leaderPhaseRef.current = undefined;
  }, [_handleSessionInterrupted]);
  const _handleSessionCompleted = leaderHandlers.handleSessionCompleted;
  const handleSessionCompletedWithKind = useCallback<TuiEventHandler<'session:completed'>>((event) => {
    _handleSessionCompleted(event);
    leaderStatusKindRef.current = 'completed';
    leaderPhaseRef.current = undefined;
  }, [_handleSessionCompleted]);
  const _handleLeaderStatus = leaderHandlers.handleLeaderStatus;
  const handleLeaderStatus = useCallback<TuiEventHandler<'leader:status'>>((event) => {
    const payload = eventRecord(event);
    leaderStatusKindRef.current = readLeaderStatusKind(payload.statusKind)
      ?? normalizeLeaderStatusKind(typeof payload.status === 'string' ? payload.status : '');
    _handleLeaderStatus(event);
  }, [_handleLeaderStatus]);
  const handleLeaderRoute = leaderHandlers.handleLeaderRoute;
  const _handleLeaderTextChunk = leaderHandlers.handleLeaderTextChunk;
  const handleLeaderTextChunk = useCallback<TuiEventHandler<'leader:text_chunk'>>((event) => {
    _handleLeaderTextChunk(event);
    tokenUsageHandlers.handleStreamingChunk({ chunk: typeof event.chunk === 'string' ? event.chunk : undefined });
  }, [_handleLeaderTextChunk, tokenUsageHandlers]);
  const handleLeaderThinkingChunk = leaderHandlers.handleLeaderThinkingChunk;
  const handleLeaderToolCall = leaderHandlers.handleLeaderToolCall;
  const handleLeaderToolResult = leaderHandlers.handleLeaderToolResult;
  const handleLeaderText = leaderHandlers.handleLeaderText;
  const handleLeaderPlanApproved = leaderHandlers.handleLeaderPlanApproved;
  const handleLeaderPlanRejected = leaderHandlers.handleLeaderPlanRejected;

  const agentHandlers = useTuiAgentHandlers({
    appendMessage,
    ensureChannel,
    clearChannelStreams,
    flushStreamBuffer,
    appendChannelStream,
    updateChannelStatus,
    updateChannelNext,
    throttledUpdateChannelStatus,
    setAgentDiagnostics,
    setAgentInteractiveStates,
    setTasks,
    setLaunchedAgents,
    setCurrentMode,
    setLeaderStatus,
    agentIdMapRef,
    channelsForHeartbeatRef,
    channelsRef,
    showThinkingContent: config.llm.show_thinking_content === true,
    setToolExecutingState,
  });

  const updateAgentDiagnostic = agentHandlers.updateAgentDiagnostic;
  const handleAgentSpawned = agentHandlers.handleAgentSpawned;
  const handleAgentCompleted = agentHandlers.handleAgentCompleted;
  const handleAgentStatus = agentHandlers.handleAgentStatus;
  const handleAgentProgress = agentHandlers.handleAgentProgress;
  const handleAgentToolCall = agentHandlers.handleAgentToolCall;
  const handleAgentToolResult = agentHandlers.handleAgentToolResult;
  const handleAgentTextChunk = agentHandlers.handleAgentTextChunk;
  const handleAgentThinkingChunk = agentHandlers.handleAgentThinkingChunk;
  const handleAgentText = agentHandlers.handleAgentText;
  const handleAgentFailed = agentHandlers.handleAgentFailed;
  const handleAgentHeartbeat = agentHandlers.handleAgentHeartbeat;
  const handleAgentInteractiveState = agentHandlers.handleAgentInteractiveState;
  const handleTaskCreated = agentHandlers.handleTaskCreated;
  const handleTaskUpdated = agentHandlers.handleTaskUpdated;

  const handleOrchestrationStatus = useCallback<TuiEventHandler<'orchestration:run_state' | 'orchestration:node_update' | 'orchestration:event_applied' | 'orchestration:event_rejected'>>((event) => {
    const payload = eventRecord(event);
    const summary = typeof payload.summary === 'string'
      ? payload.summary
      : typeof payload.bottleneck === 'string'
        ? payload.bottleneck
        : typeof payload.reason === 'string'
          ? payload.reason
          : undefined;
    setSessionStatus(prev => ({
      ...prev,
      orchestrationSummary: summary ?? prev.orchestrationSummary,
    }));
  }, []);

  const handlePermissionModeChanged = useCallback<TuiEventHandler<'permission:mode_changed'>>((event) => {
    const payload = eventRecord(event);
    const mode = payload.mode === 'strict' || payload.mode === 'dev' || payload.mode === 'networked' || payload.mode === 'yolo' ? payload.mode : undefined;
    permissionSync.handleModeChanged({ summary: String(payload.summary ?? ''), mode });
  }, [permissionSync]);

  const handlePermissionRequest = useCallback<TuiEventHandler<'permission:request'>>((event) => {
    const payload = eventRecord(event);
    permissionSync.handleRequest({
      requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
      source: typeof payload.source === 'string' ? payload.source : '',
      workerName: typeof payload.workerName === 'string' ? payload.workerName : undefined,
      toolName: typeof payload.toolName === 'string' ? payload.toolName : '',
      reason: typeof payload.reason === 'string' ? payload.reason : '',
    });
  }, [permissionSync]);

  const handlePermissionResolved = useCallback<TuiEventHandler<'permission:resolved'>>((event) => {
    const payload = eventRecord(event);
    permissionSync.handleResolved({
      requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
    });
  }, [permissionSync]);

  const handleControlModeChanged = useCallback<TuiEventHandler<'leader:control_mode_changed'>>((event) => {
    const mode = eventRecord(event).mode;
    if (mode !== 'manual' && mode !== 'eternal') return;
    setSessionStatus(prev => ({ ...prev, controlMode: mode }));
    appendMessage('main', {
      type: 'system',
      content: mode === 'eternal'
        ? t('tui.event.control_eternal')
        : t('tui.event.control_manual'),
    });
  }, [appendMessage]);

  const handleTokenUsage = tokenUsageHandlers.handleTokenUsage;
  const handleContextRuntimeUpdated = tokenUsageHandlers.handleContextRuntimeUpdated;
  const handleContextCompressed = useCallback<TuiEventHandler<'context:compressed'>>((event) => {
    // 兜底清除 compactingState：context:compacting 的 phase='end' 事件可能丢失
    // 或未发，但 context:compressed 是压缩完成的确定性信号，必须在此清除。
    setCompactingState(null);
    tokenUsageHandlers.handleContextCompressed(event);
  }, [tokenUsageHandlers]);

  const handleContextCompacting = useCallback<TuiEventHandler<'context:compacting'>>((event) => {
    const payload = eventRecord(event);
    if (payload.phase === 'end') {
      setCompactingState(null);
    } else {
      setCompactingState((prev) => ({
        stage: typeof payload.stage === 'string' ? payload.stage : 'llm_summary',
        chunkIndex: typeof payload.chunkIndex === 'number' ? payload.chunkIndex : undefined,
        chunkTotal: typeof payload.chunkTotal === 'number' ? payload.chunkTotal : undefined,
        percent: typeof payload.percent === 'number' ? payload.percent : undefined,
        oldTokens: typeof payload.oldTokens === 'number' ? payload.oldTokens : prev?.oldTokens,
        newTokens: typeof payload.newTokens === 'number' ? payload.newTokens : prev?.newTokens,
        threshold: typeof payload.threshold === 'number' ? payload.threshold : prev?.threshold,
        messageCount: typeof payload.messageCount === 'number' ? payload.messageCount : prev?.messageCount,
        label: typeof payload.label === 'string' ? payload.label : prev?.label,
        startedAt: prev?.startedAt ?? Date.now(),
      }));
    }
  }, []);

  const handlePlanSubmitted = useCallback<TuiEventHandler<'plan:submitted'>>((event) => {
    const payload = eventRecord(event);
    ensureChannel('plan', 'plan');
    updateChannelStatus('plan', 'waiting');
    updateChannelNext('plan', t('tui.plan.review_wait'));
    appendMessage('main', { type: 'system', content: t('tui.plan.submitted') });

    appendMessage('plan', { type: 'system', content: buildSubmittedPlanContent(payload.plan || {}) });
    switchTab('plan');
  }, [appendMessage, ensureChannel, switchTab, updateChannelNext, updateChannelStatus]);

  const handleEventBridgeCleanup = useCallback(() => {
    tokenUsageHandlers.cancelPendingFlush();
  }, [tokenUsageHandlers]);

  // 黑板增量事件 — 增量合并到 graphNodes/graphEdges，保留 supersededBy 等更新
  const handleBlackboardDelta = useCallback<TuiEventHandler<'blackboard:delta'>>((event) => {
    const payload = eventRecord(event);
    const incomingNodes = Array.isArray(payload.changedNodes)
      ? payload.changedNodes.filter(isTuiBlackboardNode)
      : [];
    const incomingEdges = Array.isArray(payload.changedEdges)
      ? payload.changedEdges.filter(isTuiBlackboardEdge)
      : [];
    if (incomingNodes.length === 0 && incomingEdges.length === 0) return;
    if (incomingNodes.length > 0) {
      setGraphNodes((prev) => {
        const map = new Map(prev.map((n) => [n.id, n]));
        for (const node of incomingNodes) {
          if (!node || !node.id) continue;
          map.set(node.id, node);
        }
        return [...map.values()];
      });
    }
    if (incomingEdges.length > 0) {
      setGraphEdges((prev) => {
        const map = new Map(prev.map((e) => [e.id, e]));
        for (const edge of incomingEdges) {
          if (!edge || !edge.id) continue;
          map.set(edge.id, edge);
        }
        return [...map.values()];
      });
    }
    // delta 到达本身证明黑板可用
    setGraphEnabled(true);
  }, []);

  const handleBlackboardInitialized = useCallback<TuiEventHandler<'blackboard:initialized'>>((event) => {
    const payload = eventRecord(event);
    setGraphEnabled(payload.enabled === true);
    if (payload.enabled === false && typeof payload.reason === 'string') {
      appendMessage('main', { type: 'system', content: t('tui.event.blackboard_disabled', payload.reason) });
    }
  }, [appendMessage]);

  // 工作笔记 — Worker/Leader 写入 work_note 时增量收集，供 /notes 面板查看（最近 100 条）
  const handleWorkNoteWritten = useCallback<TuiEventHandler<'work_note:written'>>((event) => {
    const payload = eventRecord(event);
    const note = payload.note && typeof payload.note === 'object'
      ? payload.note as TuiEventRecord
      : null;
    if (!note || typeof note.id !== 'string') return;
    const noteId = note.id;
    const noteAgentId = typeof note.agentId === 'string'
      ? note.agentId
      : typeof payload.agentId === 'string'
        ? payload.agentId
        : 'unknown';
    const noteTaskId = typeof note.taskId === 'string' ? note.taskId : '';
    const noteTimestamp = typeof note.timestamp === 'number' ? note.timestamp : Date.now();
    const notePhase = typeof note.phase === 'string' ? note.phase : 'other';
    const noteSummary = typeof note.summary === 'string' ? note.summary : '';
    const noteDetails = typeof note.details === 'string' ? note.details : undefined;
    const noteBlockers = Array.isArray(note.blockers)
      ? note.blockers.filter((blocker): blocker is string => typeof blocker === 'string')
      : undefined;
    setWorkNotes((prev) => {
      const item: import('./WorkNotesPanel.js').WorkNoteItem = {
        id: noteId,
        agentId: noteAgentId,
        taskId: noteTaskId,
        timestamp: noteTimestamp,
        phase: notePhase,
        summary: noteSummary,
        details: noteDetails,
        blockers: noteBlockers,
      };
      const existing = prev.findIndex((n) => n.id === item.id);
      const next = existing >= 0
        ? prev.map((n, i) => (i === existing ? item : n))
        : [item, ...prev];
      return next.slice(0, 100);
    });
  }, []);

  // Leader 输入队列深度 — leader:message_queued/dequeued 直接给出 queueLength
  const handleLeaderQueueChanged = useCallback<TuiEventHandler<'leader:message_queued' | 'leader:message_dequeued'>>((event) => {
    const payload = eventRecord(event);
    const len = typeof payload.queueLength === 'number' ? payload.queueLength : 0;
    setMainQueuedCount(Math.max(0, len));
  }, []);

  // LLM 重试 — leader/agent 通用，按通道落系统消息
  const handleLlmRetry = useCallback<TuiEventHandler<'leader:llm_retry' | 'agent:llm_retry'>>((event) => {
    const payload = eventRecord(event);
    const agentName = typeof payload.agentName === 'string' ? payload.agentName : undefined;
    const channel = agentName && channelsRef.current[agentName] ? agentName : 'main';
    const attempt = typeof payload.attempt === 'number' || typeof payload.attempt === 'string'
      ? t('tui.event.llm_retry_attempt', payload.attempt)
      : 'retry';
    const kind = typeof payload.errorKind === 'string' ? ` (${payload.errorKind})` : '';
    appendMessage(channel, {
      type: 'system',
      content: t(
        'tui.event.llm_retry',
        attempt,
        kind,
        typeof payload.message === 'string' ? payload.message : t('tui.event.network_fluctuation'),
      ),
    });
  }, [appendMessage, channelsRef]);

  // Agent 进程崩溃 — exitCode/signal 落错误消息并标记通道
  const handleAgentCrashed = useCallback<TuiEventHandler<'agent:crashed'>>((event) => {
    const payload = eventRecord(event);
    const agentName = typeof payload.agentName === 'string' ? payload.agentName : undefined;
    const name = agentName || (typeof payload.name === 'string' ? payload.name : 'agent');
    const detail = [
      payload.exitCode != null ? `exit ${String(payload.exitCode)}` : '',
      typeof payload.signal === 'string' ? `signal ${payload.signal}` : '',
      typeof payload.timeoutReason === 'string' ? payload.timeoutReason : '',
      typeof payload.recoveryAction === 'string' ? `recovery ${payload.recoveryAction}` : '',
      Array.isArray(payload.stderrTail) && payload.stderrTail.length > 0
        ? `stderr ${String(payload.stderrTail[payload.stderrTail.length - 1]).slice(0, 80)}`
        : '',
    ].filter(Boolean).join(' · ');
    appendMessage('main', {
      type: 'error',
      content: t('tui.event.agent_crashed', name, detail),
    });
    if (agentName && channelsRef.current[agentName]) {
      updateChannelStatus(agentName, 'crashed');
      updateChannelNext(agentName, typeof payload.recoveryAction === 'string' ? payload.recoveryAction : 'process crashed');
      updateAgentDiagnostic(agentName, {
        lastProgressMessage: typeof payload.error === 'string' ? payload.error : 'process crashed',
        lastProgressAt: Date.now(),
        backend: payload.backend === 'worker_process' || payload.backend === 'claude' || payload.backend === 'codex' || payload.backend === 'remote'
          ? payload.backend
          : undefined,
        pid: typeof payload.pid === 'number' ? payload.pid : undefined,
        recoverable: payload.recoverable === true,
        recoveryAction: typeof payload.recoveryAction === 'string' ? payload.recoveryAction : undefined,
        stderrTail: Array.isArray(payload.stderrTail) ? payload.stderrTail.map(String) : undefined,
        stdoutTail: Array.isArray(payload.stdoutTail) ? payload.stdoutTail.map(String) : undefined,
      });
    }
  }, [appendMessage, channelsRef, updateAgentDiagnostic, updateChannelNext, updateChannelStatus]);

  // 干预消息注入 — leader/用户向 agent 注入
  const handleAgentIntervention = useCallback<TuiEventHandler<'agent:intervention'>>((event) => {
    const payload = eventRecord(event);
    const agentName = typeof payload.agentName === 'string' ? payload.agentName : undefined;
    if (!agentName) return;
    const channel = channelsRef.current[agentName] ? agentName : 'main';
    appendMessage(channel, {
      type: 'system',
      content: t(
        'tui.event.intervention',
        agentName,
        typeof payload.message_type === 'string' ? payload.message_type : '',
        typeof payload.content === 'string' ? payload.content : '',
      ),
    });
  }, [appendMessage, channelsRef]);

  // 上下文溢出告警 — tokens 超过阈值
  const handleContextOverflow = useCallback<TuiEventHandler<'context:overflow'>>((event) => {
    const payload = eventRecord(event);
    const agentName = typeof payload.agentName === 'string' ? payload.agentName : undefined;
    const channel = payload.owner === 'agent' && agentName && channelsRef.current[agentName]
      ? agentName
      : 'main';
    appendMessage(channel, {
      type: 'system',
      content: t('tui.event.context_overflow', String(payload.tokens ?? '?'), String(payload.threshold ?? '?')),
    });
  }, [appendMessage, channelsRef]);

  // 工具入参流式增量 — 在状态行显示「构建参数…」，最终 tool_call 落定后由 handleLeaderToolCall 覆盖
  const handleLeaderToolCallDelta = useCallback<TuiEventHandler<'leader:tool_call_delta'>>((event) => {
    const payload = eventRecord(event);
    const tool = typeof payload.tool === 'string' ? payload.tool.replace(/_/g, ' ') : 'tool';
    const partialJson = typeof payload.partialJson === 'string' ? payload.partialJson : undefined;
    updateChannelNext('main', t('tui.event.building_args', tool));
    // 实时更新 partialJson 到工具执行状态，驱动 StreamingStatusLine 显示参数构建进度
    setToolExecutingState(prev => ({ ...prev, toolName: tool, partialJson }));
    tokenUsageHandlers.handleStreamingChunk({ partialJson });
  }, [updateChannelNext, setToolExecutingState, tokenUsageHandlers]);

  const handleLeaderPhaseChange = useCallback<TuiEventHandler<'leader:phase_change'>>((event) => {
    const payload = eventRecord(event);
    const phase = typeof payload.phase === 'string' ? payload.phase : undefined;
    leaderPhaseRef.current = phase === 'idle' ? undefined : phase;
    if (phase && phase !== 'idle') {
      leaderStatusKindRef.current = 'active';
    } else if (phase === 'idle') {
      leaderStatusKindRef.current = normalizeLeaderStatusKind(leaderStatusRef.current);
    }
  }, []);

  const handleAgentToolCallDelta = useCallback<TuiEventHandler<'agent:tool_call_delta'>>((event) => {
    const payload = eventRecord(event);
    const agentName = typeof payload.agentName === 'string' ? payload.agentName : undefined;
    if (!agentName) return;
    const tool = typeof payload.tool === 'string' ? payload.tool.replace(/_/g, ' ') : 'tool';
    const partialJson = typeof payload.partialJson === 'string' ? payload.partialJson : undefined;
    updateChannelNext(agentName, t('tui.event.building_args', tool));
    // 实时更新 partialJson 到工具执行状态
    setToolExecutingState(prev => ({ ...prev, toolName: tool, partialJson }));
  }, [updateChannelNext, setToolExecutingState]);

  const hydrateSessionSnapshot = useCallback((snapshot: TuiSessionSnapshotDto | null | undefined): boolean => {
    if (!snapshot?.sessionStatus) return false;
    setSessionStatus({ ...snapshot.sessionStatus });
    sessionStatusRef.current = { ...snapshot.sessionStatus };
    if (snapshot.tasks) setTasks(snapshot.tasks);
    const agentChannels = snapshot.channels || [];
    setChannels(createInitialChannelMap(snapshot.messages || [], agentChannels));
    if (snapshot.tokenUsage !== undefined) setTokenUsage({ total: snapshot.tokenUsage });
    if (snapshot.agentTokens) setAgentTokens(snapshot.agentTokens);
    if (snapshot.leaderStatus) {
      setLeaderStatus(snapshot.leaderStatus);
      leaderStatusRef.current = snapshot.leaderStatus;
    }
    if (snapshot.leaderMode) setLeaderMode(snapshot.leaderMode);
    if (snapshot.leaderReason) setLeaderModeReason(snapshot.leaderReason);
    const agentTabs = agentChannels.filter((channel) => channel.name !== 'main');
    // 从快照 channel 中填充 agentId→name 映射，使后续 token:usage 事件能按名称正确归集
    for (const channel of agentTabs) {
      if (channel.agentId && channel.name) {
        agentIdMapRef.current = { ...agentIdMapRef.current, [channel.agentId]: channel.name };
      }
    }
    setTabOrder(['main', ...agentTabs.map((channel) => channel.name)]);
    setLaunchedAgents(agentTabs.map((channel) => ({
      name: channel.name,
      role: channel.role || 'worker',
      taskId: channel.taskId || '',
      backend: channel.backend,
      externalSessionId: channel.externalSessionId,
      pid: channel.pid,
    })));
    setCurrentTab('main');
    return true;
  }, [setAgentTokens, setChannels, setCurrentTab, setLaunchedAgents, setLeaderMode, setLeaderModeReason, setLeaderStatus, setSessionStatus, setTabOrder, setTasks, setTokenUsage]);

  // Web UI 切会话 → TUI 同步：重置 UI 状态以匹配新会话
  const handleSessionFocus = useCallback((event: { sessionId: string; status?: string; workspace?: string } | string) => {
    const newSessionId = typeof event === 'string' ? event : event.sessionId;
    onSessionFocus?.(newSessionId);
    if (sessionStatusRef.current?.sessionId === newSessionId) return; // 同一会话只需同步提交目标

    // 更新 session ref（getActiveSessionId 依赖此 ref，scoped 过滤立即生效）
    const focusedRunStatus = typeof event === 'string'
      ? 'running'
      : normalizeRunStatus(event.status);
    const nextStatus = typeof event === 'string'
      ? 'active'
      : isRunTerminalStatus(focusedRunStatus)
        ? (focusedRunStatus === 'cancelled' ? 'interrupted' : focusedRunStatus)
        : 'active';
    sessionStatusRef.current = {
      ...(sessionStatusRef.current || {} as Partial<SessionStatusData>),
      sessionId: newSessionId,
      status: nextStatus,
      workspace: typeof event === 'string' ? sessionStatusRef.current?.workspace : (event.workspace || sessionStatusRef.current?.workspace),
    };
    setSessionStatus(prev => ({
      ...prev,
      sessionId: newSessionId,
      status: nextStatus,
      workspace: typeof event === 'string' ? prev.workspace : (event.workspace || prev.workspace),
    }));

    const hydratePromise = loadSessionSnapshot?.(newSessionId)
      .then((snapshot) => {
        if (!hydrateSessionSnapshot(snapshot)) {
          setChannels(createInitialChannelMap([], []));
          setTasks([]);
        }
      })
      .catch(() => {
        setChannels(createInitialChannelMap([], []));
        setTasks([]);
      });
    void hydratePromise;
    setNotifications([]);
    setAgentQuestionState(null);
    setInputBuffer('');
    setInputCursor(0);
    inputBufferRef.current = '';
    inputCursorRef.current = 0;
    setSubmitting(false);
    submittingRef.current = false;
    setInFlightMessage('');
    inFlightMessageRef.current = '';
    clearLeaderRuntimeProjection();
    setMainQueuedCount(0);
    setLeaderStatus(t('tui.event.session_switched'));
    leaderStatusRef.current = t('tui.event.session_switched');

    // 系统提示
    appendMessage('main', {
      type: 'system',
      content: t('tui.event.session_synced', newSessionId.slice(0, 8)),
    });
  }, [appendMessage, clearLeaderRuntimeProjection, hydrateSessionSnapshot, loadSessionSnapshot, onSessionFocus, setAgentQuestionState, setChannels, setInFlightMessage, setInputBuffer, setInputCursor, setLeaderStatus, setNotifications, setSessionStatus, setSubmitting, setTasks]);

  const handleSessionRuntimeState = useCallback<TuiEventHandler<'session:runtime_state'>>((event) => {
    const projection = buildTuiSessionRuntimeProjection({
      event,
      currentSessionStatus: sessionStatusRef.current,
      workspace,
      processingStatus: t('tui.input.processing'),
      awaitingInputStatus: t('tui.leader.awaiting_input'),
      idleStatus: t('tui.leader.awaiting_input'),
    });
    if (!projection) return;

    const {
      runtimeState,
      runtimeActive,
      sessionStatus,
      executionMode,
      executionReason,
      queueLength,
      runningWorkers,
      hasRunningWorkers,
      nextSessionStatus,
      nextLeaderStatus,
      leaderModel: projectedLeaderModel,
    } = projection;
    const wasRuntimeActive = leaderRuntimeActiveRef.current;
    sessionStatusRef.current = nextSessionStatus;
    setSessionStatus(prev => ({
      ...prev,
      ...nextSessionStatus,
      workspace: nextSessionStatus.workspace || prev.workspace,
      status: sessionStatus,
    }));

    if (executionMode === 'direct' || executionMode === 'hybrid' || executionMode === 'delegate') {
      setLeaderMode(executionMode);
      setLeaderModeReason(typeof executionReason === 'string' ? executionReason : '');
    }

    setLeaderRuntimeActive(runtimeActive);
    leaderRuntimeActiveRef.current = runtimeActive;
    setLeaderRuntimeQueueLength(queueLength);
    leaderRuntimeQueueLengthRef.current = queueLength;
    if (projectedLeaderModel) {
      setLeaderRuntimeModel(projectedLeaderModel);
    }
    if (runtimeActive && !wasRuntimeActive) {
      tokenUsageHandlers.resetStreamingTokens();
    }
    if (!runtimeActive) {
      leaderPhaseRef.current = undefined;
      // Leader 不再活跃时，清除残留的 streaming token 和工具执行状态。
      // 否则 startedAt/outputTokens 残留会让 streamingStatus 持续返回 active: true，
      // 状态栏永远显示「处理中」——尤其发生在 Leader 输出完成但 worker 仍在运行时
      // （runtimeImpliesBusy 因 worker 返回 true，导致 runtimeActive 不变）。
      tokenUsageHandlers.resetStreamingTokens();
      setToolExecutingState({});
    }

    if (nextLeaderStatus && nextLeaderStatus !== leaderStatusRef.current) {
      setLeaderStatus(nextLeaderStatus);
      leaderStatusRef.current = nextLeaderStatus;
    }

    setChannels(prev => {
      let next = updateChannelState(prev, 'main', {
        status: nextLeaderStatus || getChannelDisplayStatus(prev.main),
        currentNext: runtimeActive ? prev.main?.currentNext : '',
      });
      for (const worker of runningWorkers) {
        const name = worker.name || worker.agentId;
        next = ensureChannelStateMap(next, name, worker.roleType || 'worker', worker.taskId);
        next = updateChannelState(next, name, {
          role: worker.roleType || next[name]?.role,
          taskId: worker.taskId || next[name]?.taskId,
          status: worker.status || 'running',
        });
      }
      if (!hasRunningWorkers) {
        for (const [name, channel] of Object.entries(next)) {
          if (name === 'main') continue;
          if (channel.status === 'running' || channel.status === 'starting') {
            next = updateChannelState(next, name, { status: 'completed', currentNext: '' });
          }
        }
      }
      return next;
    });

    if (runningWorkers.length > 0) {
      // 从运行态 worker 列表中填充 agentId→name 映射，确保 token:usage 能按名称正确归集
      for (const worker of runningWorkers) {
        if (worker.agentId && worker.name) {
          agentIdMapRef.current = { ...agentIdMapRef.current, [worker.agentId]: worker.name };
        }
      }
      setLaunchedAgents(prev => {
        const byName = new Map(prev.map(agent => [agent.name, agent]));
        for (const worker of runningWorkers) {
          const name = worker.name || worker.agentId;
          const existing = byName.get(name);
          byName.set(name, {
            ...(existing || { name, role: 'worker', taskId: '' }),
            name,
            role: worker.roleType || existing?.role || 'worker',
            taskId: worker.taskId || existing?.taskId || '',
          });
        }
        return Array.from(byName.values());
      });
      setTabOrder(prev => {
        const next = [...prev];
        for (const worker of runningWorkers) {
          const name = worker.name || worker.agentId;
          if (!next.includes(name)) next.push(name);
        }
        return next;
      });
    }
  }, [leaderRuntimeActiveRef, leaderRuntimeQueueLengthRef, leaderStatusRef, setChannels, setLaunchedAgents, setLeaderMode, setLeaderModeReason, setLeaderRuntimeActive, setLeaderRuntimeQueueLength, setLeaderStatus, setSessionStatus, setTabOrder, tokenUsageHandlers, workspace]);

  // /git —— 在进程内通过 RealGitService 异步加载工作区状态
  const loadGitData = useCallback(async () => {
    setGitData(null); // 触发加载态
    const { loadGitPanelData } = await import('./state/gitPanelLoader.js');
    const data = await loadGitPanelData(workspace);
    setGitData(data);
  }, [workspace]);

  // 打开蓝图面板时按需拉取最新(蓝图写后无独立 TUI 事件,主动刷新;TUI 同进程直接读 db)。
  const loadBlueprint = useCallback(() => {
    if (readProjectBlueprint) setBlueprint(readProjectBlueprint());
  }, [readProjectBlueprint]);

  // Wiki 生成进度 —— /wiki generate|update 期间实时反馈（之前 TUI 静默阻塞数分钟）
  const wikiLastProgressRef = useRef(0);
  const wikiLastStreamRef = useRef(0);
  const wikiStreamSectionRef = useRef<string | null>(null);
  const handleWikiStarted = useCallback(() => {
    wikiLastProgressRef.current = 0;
    wikiLastStreamRef.current = 0;
    wikiStreamSectionRef.current = null;
    appendMessage('main', { type: 'system', content: t('tui.event.wiki_started') });
  }, [appendMessage]);
  const handleWikiProgress = useCallback<TuiEventHandler<'wiki:generation_progress'>>((event) => {
    // 节流：进度事件可能高频，至少间隔 800ms 或阶段变化才落消息
    const payload = eventRecord(event);
    const now = Date.now();
    if (now - wikiLastProgressRef.current < 800) return;
    wikiLastProgressRef.current = now;
    const pct = typeof payload.progress === 'number' ? ` ${Math.round(payload.progress * 100)}%` : '';
    const phase = typeof payload.phase === 'string' ? `[${payload.phase}]` : '';
    const detail = typeof payload.detail === 'string' ? payload.detail : '';
    appendMessage('main', { type: 'system', content: `Wiki ${phase}${pct} ${detail}`.trim() });
  }, [appendMessage]);
  const handleWikiStream = useCallback<TuiEventHandler<'wiki:generation_stream'>>((event) => {
    const payload = eventRecord(event);
    const now = Date.now();
    const sectionTitle = typeof payload.sectionTitle === 'string' && payload.sectionTitle.trim()
      ? payload.sectionTitle.trim()
      : typeof payload.sectionId === 'string' && payload.sectionId.trim()
        ? payload.sectionId.trim()
        : 'section';
    const sectionChanged = wikiStreamSectionRef.current !== sectionTitle;
    if (!sectionChanged && now - wikiLastStreamRef.current < 1500) return;
    wikiStreamSectionRef.current = sectionTitle;
    wikiLastStreamRef.current = now;

    const chunk = typeof payload.chunk === 'string' ? payload.chunk.replace(/\s+/g, ' ').trim() : '';
    const preview = chunk.length > 120 ? `${chunk.slice(0, 120)}...` : chunk;
    appendMessage('main', { type: 'system', content: preview ? `Wiki [${sectionTitle}] ${preview}` : `Wiki [${sectionTitle}]` });
  }, [appendMessage]);
  const handleWikiCompleted = useCallback<TuiEventHandler<'wiki:generation_completed'>>((event) => {
    const payload = eventRecord(event);
    const result = payload.result && typeof payload.result === 'object'
      ? payload.result as TuiEventRecord
      : {};
    const docs = result.documentsGenerated ?? result.documentsUpdated;
    appendMessage('main', { type: 'success', content: t('tui.event.wiki_completed', docs ?? null) });
  }, [appendMessage]);
  const handleWikiFailed = useCallback<TuiEventHandler<'wiki:generation_failed'>>((event) => {
    const payload = eventRecord(event);
    appendMessage('main', {
      type: 'error',
      content: t('tui.event.wiki_failed', typeof payload.error === 'string' ? payload.error : t('tui.event.unknown_error')),
    });
  }, [appendMessage]);

  // ── 记忆维护（dream/distill）事件 → 底部状态行 + 完成消息 ──
  const maintenanceKindLabel = useCallback((kind: unknown) => (kind === 'distill' ? '资产提炼' : '记忆整理'), []);
  const handleMaintenanceStarted = useCallback<TuiEventHandler<'memory:maintenance_started'>>((event) => {
    const payload = eventRecord(event);
    const kind = payload.kind === 'distill' ? 'distill' : 'dream';
    setMaintenanceState({ kind, stage: 'started', progress: 0.05, detail: '', startedAt: Date.now() });
  }, []);
  const handleMaintenanceProgress = useCallback<TuiEventHandler<'memory:maintenance_progress'>>((event) => {
    const payload = eventRecord(event);
    const kind = payload.kind === 'distill' ? 'distill' : 'dream';
    setMaintenanceState((prev) => ({
      kind,
      stage: typeof payload.phase === 'string' ? payload.phase : (prev?.stage ?? ''),
      // 进度只向前，避免事件交错回退
      progress: Math.max(prev?.kind === kind ? prev.progress : 0, typeof payload.progress === 'number' ? payload.progress : 0),
      detail: typeof payload.detail === 'string' ? payload.detail : '',
      startedAt: prev?.kind === kind ? prev.startedAt : Date.now(),
    }));
  }, []);
  const handleMaintenanceCompleted = useCallback<TuiEventHandler<'memory:maintenance_completed'>>((event) => {
    const payload = eventRecord(event);
    setMaintenanceState(null);
    refreshMemoryStatus();
    const summary = typeof payload.summary === 'string' && payload.summary ? `：${payload.summary}` : '';
    appendMessage('main', { type: 'success', content: `${maintenanceKindLabel(payload.kind)}完成${summary}` });
  }, [appendMessage, maintenanceKindLabel, refreshMemoryStatus]);
  const handleMaintenanceFailed = useCallback<TuiEventHandler<'memory:maintenance_failed'>>((event) => {
    const payload = eventRecord(event);
    setMaintenanceState(null);
    refreshMemoryStatus();
    const err = typeof payload.error === 'string' ? payload.error : t('tui.event.unknown_error');
    appendMessage('main', { type: 'error', content: `${maintenanceKindLabel(payload.kind)}失败: ${err}` });
  }, [appendMessage, maintenanceKindLabel, refreshMemoryStatus]);

  useTuiEventBridge({
    emitter,
    workspace,
    getActiveSessionId: () => sessionStatusRef.current?.sessionId,
    setSessionStatus,
    appendMessage,
    setNotifications,
    setAgentQuestionState,
    pasteTimeoutRef,
    onSessionInterrupted: handleSessionInterrupted,
    onSessionCompleted: handleSessionCompletedWithKind,
    onLeaderStatus: handleLeaderStatus,
    onLeaderRoute: handleLeaderRoute,
    onLeaderTextChunk: handleLeaderTextChunk,
    onLeaderThinkingChunk: handleLeaderThinkingChunk,
    onLeaderToolCall: handleLeaderToolCall,
    onLeaderToolResult: handleLeaderToolResult,
    onLeaderText: handleLeaderText,
    onLeaderPlanApproved: handleLeaderPlanApproved,
    onLeaderPlanRejected: handleLeaderPlanRejected,
    onAgentSpawned: handleAgentSpawned,
    onAgentCompleted: handleAgentCompleted,
    onAgentStatus: handleAgentStatus,
    onAgentProgress: handleAgentProgress,
    onAgentToolCall: handleAgentToolCall,
    onAgentToolResult: handleAgentToolResult,
    onAgentTextChunk: handleAgentTextChunk,
    onAgentThinkingChunk: handleAgentThinkingChunk,
    onAgentText: handleAgentText,
    onAgentFailed: handleAgentFailed,
    onAgentHeartbeat: handleAgentHeartbeat,
    onAgentInteractiveState: handleAgentInteractiveState,
    onTaskCreated: handleTaskCreated,
    onTaskUpdated: handleTaskUpdated,
    onOrchestrationStatus: handleOrchestrationStatus,
    onPermissionModeChanged: handlePermissionModeChanged,
    onPermissionRequest: handlePermissionRequest,
    onPermissionResolved: handlePermissionResolved,
    onControlModeChanged: handleControlModeChanged,
    onTokenUsage: handleTokenUsage,
    onContextRuntimeUpdated: handleContextRuntimeUpdated,
    onContextCompressed: handleContextCompressed,
    onContextCompacting: handleContextCompacting,
    onPlanSubmitted: handlePlanSubmitted,
    onBlackboardDelta: handleBlackboardDelta,
    onBlackboardInitialized: handleBlackboardInitialized,
    onWorkNoteWritten: handleWorkNoteWritten,
    onLeaderQueueChanged: handleLeaderQueueChanged,
    onLlmRetry: handleLlmRetry,
    onAgentCrashed: handleAgentCrashed,
    onAgentIntervention: handleAgentIntervention,
    onContextOverflow: handleContextOverflow,
    onLeaderToolCallDelta: handleLeaderToolCallDelta,
    onAgentToolCallDelta: handleAgentToolCallDelta,
    onLeaderPhaseChange: handleLeaderPhaseChange,
    onWikiStarted: handleWikiStarted,
    onWikiProgress: handleWikiProgress,
    onWikiStream: handleWikiStream,
    onWikiCompleted: handleWikiCompleted,
    onWikiFailed: handleWikiFailed,
    onMaintenanceStarted: handleMaintenanceStarted,
    onMaintenanceProgress: handleMaintenanceProgress,
    onMaintenanceCompleted: handleMaintenanceCompleted,
    onMaintenanceFailed: handleMaintenanceFailed,
    onSessionRuntimeState: handleSessionRuntimeState,
    onSessionFocus: handleSessionFocus,
    onCleanup: handleEventBridgeCleanup,
  });

  const resetHistoryNavigation = useCallback(() => {
    historyDraftRef.current = '';
    historyIndexRef.current = -1;
    setHistoryIndex(-1);
  }, []);

  // Guarded suggestion builder — only compute for slash/mention/skill triggers
  const maybeBuildSuggestions = useCallback((value: string) => {
    if (value.length > 0 && !value.startsWith('/') && !/(?:^|\s)[@$][^\s@$]*$/.test(value)) {
      return { items: [] as SuggestionItem[], type: null as SuggestionType };
    }
    return buildSuggestions({
      value,
      commandMetadata: getSlashCommandMetadata(),
      agentCandidates,
      skillCandidates: availableSkills.map(s => ({ name: s, desc: '' })),
      commandArgCompleters: argCompleterMapRef.current,
    });
  }, [agentCandidates, availableSkills, languageVersion]);

  const commitBuffer = useCallback((value: string) => {
    inputBufferRef.current = value;
    setInputBuffer(value);
    const cursor = value.length;
    setInputCursor(cursor);
    inputCursorRef.current = cursor;
    const r = maybeBuildSuggestions(value);
    setSuggestionItems(r.items);
    setSuggestionIndex(0);
  }, [maybeBuildSuggestions]);

  const navigateInputHistory = useCallback((direction: 'up' | 'down') => {
    const history = inputHistoryRef.current;
    if (history.length === 0) {
      return false;
    }

    if (direction === 'up') {
      if (historyIndexRef.current === -1) {
        historyDraftRef.current = inputBufferRef.current;
        const nextIndex = history.length - 1;
        historyIndexRef.current = nextIndex;
        setHistoryIndex(nextIndex);
        commitBuffer(history[nextIndex] || '');
        return true;
      }
      if (historyIndexRef.current > 0) {
        const nextIndex = historyIndexRef.current - 1;
        historyIndexRef.current = nextIndex;
        setHistoryIndex(nextIndex);
        commitBuffer(history[nextIndex] || '');
        return true;
      }
      return true;
    }

    if (historyIndexRef.current === -1) {
      return false;
    }
    if (historyIndexRef.current < history.length - 1) {
      const nextIndex = historyIndexRef.current + 1;
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex);
      commitBuffer(history[nextIndex] || '');
      return true;
    }

    commitBuffer(historyDraftRef.current);
    resetHistoryNavigation();
    return true;
  }, [commitBuffer, resetHistoryNavigation]);

  const breakHistoryNavigation = useCallback(() => {
    if (historyIndexRef.current !== -1) {
      resetHistoryNavigation();
    }
  }, [resetHistoryNavigation]);

  useEffect(() => {
    const timer = setInterval(() => setUiClock((v) => (v + 1) % 10_000), 30_000);
    return () => clearInterval(timer);
  }, []);

  // 流式 output token 感知 tick — 每 800ms 刷新一次 streaming 状态
  useEffect(() => {
    if (!effectiveLeaderRuntimeActive) {
      setStreamingTick(0);
      return;
    }
    const timer = setInterval(() => setStreamingTick((v) => (v + 1) % 10_000), 800);
    return () => clearInterval(timer);
  }, [effectiveLeaderRuntimeActive]);

  useLeaderHeartbeat({
    leaderStatusRef,
    leaderStatusKindRef,
    leaderPhaseRef,
    channelsForHeartbeatRef,
    lastLeaderVisibleActivityAtRef,
    lastLeaderHeartbeatAtRef,
    updateChannelNext,
    toolExecutingStateRef,
  });


  const updateSuggestions = useCallback((v: string) => {
    const r = maybeBuildSuggestions(v);
    setSuggestionItems(r.items); setSuggestionIndex(0);
  }, [maybeBuildSuggestions]);
  const closeSuggestions = useCallback(() => { setSuggestionItems([]); setSuggestionIndex(0); }, []);

  // 构建 argCompleter 映射（只构建一次）
  const argCompleterMapRef = useRef<Record<string, (partial: string) => Array<{ name: string; desc: string }>>>({});
  if (Object.keys(argCompleterMapRef.current).length === 0) {
    for (const cmd of getSlashCommands()) {
      if (cmd.argCompleter) {
        argCompleterMapRef.current[cmd.name] = cmd.argCompleter;
      }
    }
  }

  // Refs for stable handler access
  const inputBufferRef = useRef(inputBuffer);
  const submittingRef = useRef(submitting);
  const onCommandRef = useRef(onCommand);
  const onSubmitRef = useRef(onSubmit);
  const closeSuggestionsRef = useRef(closeSuggestions);

  const {
    pendingPastes,
    setPendingPastes,
    recentPasteTime,
    activePlaceholderIds,
    pendingPastesMapRef,
    parsePlaceholder,
    freePlaceholderId,
    handlePasteDirect,
  } = useTuiPasteController({
    breakHistoryNavigation,
    inputBufferRef,
    inputCursorRef,
    setInputBuffer,
    setInputCursor,
    setSuggestionItems,
    setSuggestionIndex,
    maybeBuildSuggestions,
    pasteTimeoutRef,
  });

  const {
    modalType,
    setModalType,
    modalCursor,
    setModalCursor,
    modalData,
    setModalData,
    modalTypeRef,
    modalCursorRef,
    modalDataRef,
    modalSync,
  } = useTuiModalController({
    onCommandRef,
    appendMessage,
    setSessionStatus,
    setTasks,
    setChannels,
    setTokenUsage,
    setAgentTokens,
    setLeaderStatus,
    setLeaderMode,
    setLeaderModeReason,
    setTabOrder,
    setLaunchedAgents,
    setCurrentTab,
    sortedTasks,
    launchedAgents,
    graphNodes,
    switchTab,
  });

  useEffect(() => {
    flushStreamBuffer(currentTab);
  }, [currentTab, flushStreamBuffer]);

  function resolveMessageSelectionPoint(event: MouseClickEvent, clamp: boolean): MessageSelectionPoint | null {
    const view = messageLogViewRef.current;
    if (!view || view.visibleLines.length === 0) return null;

    const { topRow, bodyLeftCol } = messageLogGeometryRef.current;
    const hiddenAboveIndicatorRows = view.hiddenAbove > 0 ? 1 : 0;
    const rawLineIndex = event.row - topRow - hiddenAboveIndicatorRows;
    if (!clamp && (rawLineIndex < 0 || rawLineIndex >= view.visibleLines.length)) {
      return null;
    }

    const lineIndex = Math.max(0, Math.min(rawLineIndex, view.visibleLines.length - 1));
    const line = view.visibleLines[lineIndex];
    if (!line) return null;

    const selectableText = getMessageLogSelectableText(line);
    if (!clamp && selectableText.length === 0) return null;

    const rawColumn = event.col - bodyLeftCol;
    if (!clamp && rawColumn < 0) return null;
    const maxColumn = stringWidth(selectableText);
    return {
      lineIndex,
      column: Math.max(0, Math.min(rawColumn, maxColumn)),
    };
  }

  /**
   * 把鼠标点击映射到它落点的卡片头行 cardKey(若命中)。
   * 仅消息正文区(侧栏右侧)、且该行带 cardKey 时返回 key,否则 null。
   * 用于逐卡鼠标点击展开/折叠 thinking、tool 卡片。
   */
  function resolveClickedCardKey(event: MouseClickEvent): string | null {
    const view = messageLogViewRef.current;
    if (!view || view.visibleLines.length === 0) return null;
    if (event.col <= (showSidebar ? SIDEBAR_WIDTH : 0)) return null;
    const { topRow } = messageLogGeometryRef.current;
    const hiddenAboveIndicatorRows = view.hiddenAbove > 0 ? 1 : 0;
    const rawLineIndex = event.row - topRow - hiddenAboveIndicatorRows;
    if (rawLineIndex < 0 || rawLineIndex >= view.visibleLines.length) return null;
    const line = view.visibleLines[rawLineIndex];
    if (!line || !line.cardKey) return null;
    return line.cardKey;
  }

  function updateMessageSelection(next: MessageSelectionRange | null): void {
    messageSelectionRef.current = next;
    setMessageSelection(next);
  }

  function copyMessageSelection(range: MessageSelectionRange): void {
    const view = messageLogViewRef.current;
    if (!view) return;
    const selectedText = getSelectedMessageText(view.visibleLines, range);
    if (!selectedText.trim()) return;
    copyToClipboard(selectedText);
    setNotifications(prev => [...prev, {
      id: `selection-copy-${Date.now()}`,
      type: 'info' as const,
      priority: 'normal' as const,
      title: t('tui.selection.copied'),
      message: `${selectedText.length} chars`,
      timestamp: Date.now(),
      read: false,
    }]);
  }

  /** Ctrl+C 时如果有选中文本，复制并清除选择，返回 true 表示已消费该按键 */
  function handleCopySelectionCtrlC(): boolean {
    const sel = messageSelectionRef.current;
    if (!sel) return false;
    const view = messageLogViewRef.current;
    if (!view) return false;
    const selectedText = getSelectedMessageText(view.visibleLines, sel);
    if (!selectedText.trim()) {
      updateMessageSelection(null);
      return false;
    }
    copyToClipboard(selectedText);
    setNotifications(prev => [...prev, {
      id: `selection-copy-${Date.now()}`,
      type: 'info' as const,
      priority: 'normal' as const,
      title: t('tui.selection.copied'),
      message: `${selectedText.length} chars`,
      timestamp: Date.now(),
      read: false,
    }]);
    updateMessageSelection(null);
    return true;
  }

  function handleCopyLastCode(): void {
    const lastBlock = getLastCodeBlock();
    if (!lastBlock) {
      setNotifications(prev => [...prev, {
        id: `copy-nocode-${Date.now()}`,
        type: 'info' as const,
        priority: 'normal' as const,
        title: t('tui.copy.no_code'),
        message: '',
        timestamp: Date.now(),
        read: false,
      }]);
      return;
    }
    copyToClipboard(lastBlock.content);
    const lineCount = lastBlock.content.split('\n').length;
    setNotifications(prev => [...prev, {
      id: `copy-code-${Date.now()}`,
      type: 'info' as const,
      priority: 'normal' as const,
      title: t('tui.copy.code_copied', lineCount),
      message: lastBlock.lang || '',
      timestamp: Date.now(),
      read: false,
    }]);
  }

  function handleToggleMouseTracking(): void {
    setMouseTrackingEnabled(prev => {
      const next = !prev;
      // Leaving tracking-off → clear any stale in-TUI selection state
      if (next) {
        activeMessageSelectionRef.current = null;
        updateMessageSelection(null);
      }
      setNotifications(notifPrev => [...notifPrev, {
        id: `mouse-track-${Date.now()}`,
        type: 'info' as const,
        priority: 'normal' as const,
        title: next ? t('tui.mouse.tracking_on') : t('tui.mouse.tracking_off'),
        message: '',
        timestamp: Date.now(),
        read: false,
      }]);
      return next;
    });
  }

  /**
   * Ctrl+E 降级:无鼠标时,展开/折叠可见区最后一张 thinking/tool 卡片。
   * 目标确定(最新的带 cardKey 卡头行),非启发式。
   */
  function handleToggleLastCard(): void {
    const view = messageLogViewRef.current;
    if (!view) return;
    for (let i = view.visibleLines.length - 1; i >= 0; i--) {
      const key = view.visibleLines[i].cardKey;
      if (key) {
        setExpandedCards(prev => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        });
        return;
      }
    }
  }

  /**
   * Ctrl+O: 在系统浏览器中打开 Web UI（带 token）。
   * 用户关掉网页后可在 TUI 里按 Ctrl+O 重新打开。
   */
  function handleOpenWebUI(): void {
    if (!webUrl) {
      appendMessage('main', { type: 'system', content: t('tui.webui.not_available') });
      return;
    }
    // 读取持久化的 server token，拼接带 token 的 URL
    const token = ServerAuth.readToken();
    const tokenUrl = token ? `${webUrl}?token=${token}` : webUrl;
    const result = openUrlInSystemBrowser(tokenUrl);
    if (result.launched) {
      appendMessage('main', { type: 'system', content: t('tui.webui.opened', tokenUrl) });
    } else {
      // 浏览器启动失败，打印 URL 供用户手动打开
      appendMessage('main', { type: 'system', content: `${t('tui.webui.open_failed')} ${tokenUrl}` });
    }
  }

  // ── Mouse click handler (sidebar + settings panel) ──
  handleMouseClickRef.current = (event: MouseClickEvent) => {
    if (event.button === 0 && event.motion && activeMessageSelectionRef.current) {
      const focus = resolveMessageSelectionPoint(event, true);
      if (focus) {
        const next = { anchor: activeMessageSelectionRef.current.anchor, focus };
        activeMessageSelectionRef.current = next;
        updateMessageSelection(next);
      }
      return;
    }

    if (event.button === 0 && event.action === 'up' && activeMessageSelectionRef.current) {
      const focus = resolveMessageSelectionPoint(event, true);
      const finalSelection = focus
        ? { anchor: activeMessageSelectionRef.current.anchor, focus }
        : activeMessageSelectionRef.current;
      activeMessageSelectionRef.current = null;
      updateMessageSelection(finalSelection);
      copyMessageSelection(finalSelection);
      return;
    }

    if (modalTypeRef.current && modalTypeRef.current !== 'settings') return;

    const rowInInteractive = event.row - 1;

    // Settings panel content click: select + activate edit
    if (event.action === 'down' && !event.motion && modalTypeRef.current === 'settings' && showSidebar && event.col > SIDEBAR_WIDTH) {
      // Row 0=header, row 1=meta/blank, row 2+=settings content
      const panelContentRow = rowInInteractive - 2;
      const idx = getSettingsItemAtRow(panelContentRow);
      if (idx >= 0 && idx < getSettingsItemCount()) {
        setModalCursor(idx);
        const entries = getFlatSettingsEntries();
        const entry = entries[idx];
        if (entry) {
          if (entry.type === 'boolean') {
            const keys = entry.path.split('.');
            let cur: unknown = config as unknown;
            for (const k of keys) cur = (cur as Record<string, unknown>)?.[k];
            setConfigValue(entry.path, cur !== true);
            try { ConfigSchema.parse(config); } catch {/* swallowed: unhandled error */ setConfigValue(entry.path, cur); showSettingsFeedback(t('tui.settings.feedback.schema_failed'), 'error'); setSettingsEditState({ ...EMPTY_SETTINGS_EDIT }); return; }
            try { saveSettings(config); showSettingsFeedback(t('tui.settings.feedback.value_set', entry.label, String(cur !== true)), 'success'); } catch {/* swallowed: unhandled error */ setConfigValue(entry.path, cur); showSettingsFeedback(t('tui.settings.feedback.save_failed'), 'error'); }
            setSettingsEditState({ ...EMPTY_SETTINGS_EDIT });
          } else if (entry.type === 'enum' && entry.enumValues && entry.enumValues.length > 0) {
            const keys = entry.path.split('.');
            let cur: unknown = config as unknown;
            for (const k of keys) cur = (cur as Record<string, unknown>)?.[k];
            const curIdx = entry.enumValues.indexOf(String(cur ?? ''));
            const nextVal = entry.enumValues[(curIdx + 1) % entry.enumValues.length];
            setConfigValue(entry.path, nextVal);
            try { ConfigSchema.parse(config); } catch {/* swallowed: unhandled error */ setConfigValue(entry.path, cur); showSettingsFeedback(t('tui.settings.feedback.schema_failed'), 'error'); setSettingsEditState({ ...EMPTY_SETTINGS_EDIT }); return; }
            try { saveSettings(config); showSettingsFeedback(t('tui.settings.feedback.value_set', entry.label, String(nextVal)), 'success'); if (entry.path === 'ui.language') { setLanguage(nextVal as 'zh' | 'en'); handleLanguageChanged(); } } catch {/* swallowed: unhandled error */ setConfigValue(entry.path, cur); showSettingsFeedback(t('tui.settings.feedback.save_failed'), 'error'); }
            setSettingsEditState({ ...EMPTY_SETTINGS_EDIT });
          } else {
            const keys = entry.path.split('.');
            let cur: unknown = config as unknown;
            for (const k of keys) cur = (cur as Record<string, unknown>)?.[k];
            const val = String(cur ?? '');
            setSettingsEditState({ editing: true, editText: val, editCursor: val.length });
          }
        }
      }
      return;
    }

    if (event.button === 0 && event.action === 'down' && !event.motion) {
      // 卡片头行点击 → toggle 该 thinking/tool 卡的展开态(优先于文本选择)
      const cardKey = resolveClickedCardKey(event);
      if (cardKey) {
        setExpandedCards(prev => {
          const next = new Set(prev);
          if (next.has(cardKey)) next.delete(cardKey); else next.add(cardKey);
          return next;
        });
        activeMessageSelectionRef.current = null;
        updateMessageSelection(null);
        return;
      }
      const anchor = resolveMessageSelectionPoint(event, false);
      if (anchor) {
        const next = { anchor, focus: anchor };
        activeMessageSelectionRef.current = next;
        updateMessageSelection(next);
        return;
      }
      if (messageSelectionRef.current) {
        updateMessageSelection(null);
      }
    }

    if (!showSidebar) return;
    if (event.action === 'down' && !event.motion && event.col <= SIDEBAR_WIDTH) {
      const item = getSidebarItemAtRow(sidebarItems, rowInInteractive);
      if (item) {
        if (!item) return;
        if (item.id === '__tasks') {
          setModalType(prev => prev === 'dag' ? null : 'dag');
          setModalCursor(0);
        } else if (item.id === '__blueprint') {
          loadBlueprint();
          setModalType(prev => prev === 'blueprint' ? null : 'blueprint');
          setModalCursor(0);
        } else if (item.id === '__contracts') {
          setModalType(prev => prev === 'contracts' ? null : 'contracts');
          setModalCursor(0);
        } else if (item.id === '__agents') {
          setModalType(prev => prev === 'team' ? null : 'team');
          setModalCursor(0);
        } else if (item.id === '__blackboard') {
          setModalType(prev => prev === 'graph' ? null : 'graph');
          setModalCursor(0);
        } else if (item.id === '__git') {
          loadGitData();
          setModalType(prev => prev === 'git' ? null : 'git');
          setModalCursor(0);
        } else if (item.id === '__memory') {
          refreshMemoryStatus();
          setModalType(prev => prev === 'memory' ? null : 'memory');
          setModalCursor(0);
        } else if (item.id === '__report') {
          // 消费 /cost 返回的 report_modal action 打开 ReportPanel。
          // submit 路径的 handleCommandResult 是私有函数,侧栏入口需自行消费 result ——
          // 否则返回值被丢弃,modal 不开、数据不设(点击无反应的根因)。
          void onCommandRef.current('/cost').then(
            (result) => {
              if (result && typeof result === 'object' && result.action === 'report_modal') {
                setModalData({ title: result.title, report: result.report });
                setModalCursor(0);
                setModalType('report');
              }
            },
            (error: unknown) => {
              // onCommand 抛错(db/会话异常)也必须有可见反馈,不能静默
              const msg = error instanceof Error ? error.message : String(error);
              appendMessage('main', { type: 'system', content: t('tui.command.error', msg) });
            },
          );
        } else if (item.id === '__settings') {
          setModalType(prev => prev === 'settings' ? null : 'settings');
          setModalCursor(0);
          setSettingsEditState(EMPTY_SETTINGS_EDIT);
        } else {
          setCurrentTab(item.id);
        }
      }
    }
  };

  const handleSubmitRef = useTuiSubmitController({
    inputBufferRef,
    submittingRef,
    currentTabRef,
    sessionStatusRef,
    pendingPastesMapRef,
    activePlaceholderIds,
    setPendingPastes,
    setInputBuffer,
    setInputCursor,
    inputCursorRef,
    appendMessage,
    flushStreamBuffer,
    updateChannelStreams,
    onNudge,
    setSubmitting,
    closeSuggestionsRef,
    resetHistoryNavigation,
    setInputHistory,
    inputHistoryRef,
    setInFlightMessage,
    inFlightMessageRef,
    setCommandArgPickerState,
    setRewindDialogState,
    onCommandRef,
    onCommand,
    onSubmitRef,
    setSessionStatus,
    setTasks,
    setChannels,
    setTokenUsage,
    setAgentTokens,
    setLeaderStatus,
    setLeaderMode,
    setLeaderModeReason,
    setTabOrder,
    setLaunchedAgents,
    setCurrentTab,
    setModalType,
    setModalData,
    setModalCursor,
    onLoadGitData: loadGitData,
    onLanguageChanged: handleLanguageChanged,
    requestProcessExit,
    workspace,
  });

  const handleSubmit = handleSubmitRef.current;

  // Stable handleInterrupt using refs
  const onInterruptRef = useRef(onInterrupt);
  // onStopAgent ref：ESC 在 Agent 渠道时只停这一个，而非全局中断。
  const onStopAgentRef = useRef(onStopAgent);
  useEffect(() => { onStopAgentRef.current = onStopAgent; }, [onStopAgent]);

  const handleInterruptRef = useRef<() => Promise<boolean>>(async () => {
    if (await onInterruptRef.current()) {
      appendMessage('main', { type: 'system', content: t('tui.interrupt.done') });
      resetUiAfterInterrupt();
      return true;
    }
    return false;
  });

  const handleInterrupt = handleInterruptRef.current;

  // ensureChannel ref for use in handleInputKey (stale closure workaround)
  const ensureChannelRef = useRef<(name: string, role?: string, taskId?: string) => void>(() => {});

  const handleTabSwitch = useCallback((dir: 'next'|'prev') => {
    const idx = tabOrder.indexOf(currentTab);
    const nx = dir === 'next'
      ? (idx+1)%tabOrder.length
      : (idx-1+tabOrder.length)%tabOrder.length;
    switchTab(tabOrder[nx]);
  }, [tabOrder, currentTab, switchTab]);

  // Stable handleTabSwitch using refs
  const tabOrderRef = useRef(tabOrder);

  const handleTabSwitchRef = useRef<(dir: 'next'|'prev') => void>((dir: 'next'|'prev') => {
    const idx = tabOrderRef.current.indexOf(currentTabRef.current);
    const nx = dir === 'next'
      ? (idx+1)%tabOrderRef.current.length
      : (idx-1+tabOrderRef.current.length)%tabOrderRef.current.length;
    const nextTab = tabOrderRef.current[nx];
    setCurrentTab(nextTab);
    setCurrentMode((prev) => {
      return resolveModeForTabSwitch(nextTab, prev);
    });
  });

  const handleTabSwitchFn = handleTabSwitchRef.current;

  // Additional refs for input handler
  const commandArgPickerStateRef = useRef(commandArgPickerState);
  const suggestionItemsRef = useRef(suggestionItems);
  const suggestionIndexRef = useRef(suggestionIndex);
  const sortedTasksRef = useRef(sortedTasks);
  const launchedAgentsRef = useRef(launchedAgents);

  // ─── Input handling: passthrough mode pattern ───
  //
  // Architecture (KeypressContext passthrough):
  // 1. stdin.on('data') → raw buffer → detect paste markers
  // 2. Non-paste data → PassThrough stream → readline.emitKeypressEvents → keypress events
  // 3. Paste data → accumulate between markers → single broadcast with full content
  //
  // This uses readline's battle-tested escape sequence parser instead of manual parsing.

  // 输入优化：基于 Claude Code 设计
  // - 快捷键立即响应（零延迟）
  // - 普通输入防抖（16ms，约 1 帧）
  const inputDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载时清理防抖定时器
  useEffect(() => {
    return () => {
      if (inputDebounceRef.current) {
        clearTimeout(inputDebounceRef.current);
      }
    };
  }, []);

  // 优化输入状态更新：批量处理
  const flushInputUpdate = useCallback(() => {
    if (inputDebounceRef.current) {
      clearTimeout(inputDebounceRef.current);
      inputDebounceRef.current = null;
    }
    // 强制触发重渲染
    setInputBuffer(prev => prev);
  }, []);

  const patchSessionStatus = useCallback((updater: (prev: SessionStatusData) => SessionStatusData) => {
    setSessionStatus((prev) => {
      const next = updater(prev);
      sessionStatusRef.current = next;
      return next;
    });
  }, []);

  const toggleCollaborationMode = useCallback(async () => {
    const current: TuiCollaborationMode = sessionStatusRef.current?.modes?.collaboration.mode === 'team' ? 'team' : 'solo';
    const next: TuiCollaborationMode = current === 'team' ? 'solo' : 'team';
    try {
      const result = await onCommandRef.current(`/team ${next === 'team' ? 'on' : 'off'}`);
      const display = formatTuiCollaborationMode(next);
      appendMessage('main', {
        type: 'system',
        content: commandResultContent(result, t('tui.event.collaboration_mode_changed', display)),
      });
      showModeActionFlash(t('tui.mode.switched.collaboration', display));
      patchSessionStatus((prev) => ({
        ...prev,
        modes: prev.modes ? {
          ...prev.modes,
          collaboration: {
            ...prev.modes.collaboration,
            mode: next,
            source: 'explicit',
            teamEnabled: next === 'team' ? prev.modes.collaboration.teamEnabled : false,
            activeTeamName: next === 'team' ? prev.modes.collaboration.activeTeamName : null,
          },
        } : prev.modes,
      }));
    } catch (error) {
      const display = formatTuiCollaborationMode(next);
      const message = t('tui.mode.error.collaboration', display, error instanceof Error ? error.message : String(error));
      appendMessage('main', { type: 'error', content: message });
      showModeActionFlash(message, 'error');
    }
  }, [appendMessage, patchSessionStatus, showModeActionFlash]);

  const cycleExecutionRoute = useCallback(async () => {
    const current = readTuiRoutePreference(sessionStatusRef.current?.modes?.route.preference) || 'auto';
    const next = TUI_ROUTE_PREFERENCES[(TUI_ROUTE_PREFERENCES.indexOf(current) + 1) % TUI_ROUTE_PREFERENCES.length];
    try {
      const result = await onCommandRef.current(`/route ${next}`);
      const display = formatTuiRoutePreference(next);
      const hint = formatTuiRouteHint(next);
      appendMessage('main', {
        type: 'system',
        content: commandResultContent(result, `${t('tui.event.route_changed', display)} — ${hint}`),
      });
      showModeActionFlash(`${t('tui.mode.switched.route', display)} · ${hint}`);
      patchSessionStatus((prev) => ({
        ...prev,
        modes: prev.modes ? {
          ...prev.modes,
          route: {
            ...prev.modes.route,
            preference: next,
            source: 'session',
          },
        } : prev.modes,
      }));
    } catch (error) {
      const display = formatTuiRoutePreference(next);
      const message = t('tui.mode.error.route', display, error instanceof Error ? error.message : String(error));
      appendMessage('main', { type: 'error', content: message });
      showModeActionFlash(message, 'error');
    }
  }, [appendMessage, patchSessionStatus, showModeActionFlash]);

  const cycleAutonomyMode = useCallback(async () => {
    const current = readTuiAutonomyMode(sessionStatusRef.current?.modes?.autonomy) || 'balanced';
    const next = TUI_AUTONOMY_MODES[(TUI_AUTONOMY_MODES.indexOf(current) + 1) % TUI_AUTONOMY_MODES.length];
    try {
      const result = await onCommandRef.current(`/autonomy ${next}`);
      const display = formatTuiAutonomyMode(next);
      appendMessage('main', {
        type: 'system',
        content: commandResultContent(result, t('tui.event.autonomy_mode_changed', display)),
      });
      showModeActionFlash(t('tui.mode.switched.autonomy', display));
      patchSessionStatus((prev) => ({
        ...prev,
        modes: prev.modes ? {
          ...prev.modes,
          autonomy: next,
          modeGeneration: Math.max(1, (prev.modes.modeGeneration || 1) + 1),
        } : prev.modes,
      }));
    } catch (error) {
      const display = formatTuiAutonomyMode(next);
      const message = t('tui.mode.error.autonomy', display, error instanceof Error ? error.message : String(error));
      appendMessage('main', { type: 'error', content: message });
      showModeActionFlash(message, 'error');
    }
  }, [appendMessage, patchSessionStatus, showModeActionFlash]);

  const cyclePermissionMode = useCallback(async () => {
    const current = readTuiPermissionMode(sessionStatusRef.current?.modes?.permission.mode)
      || readTuiPermissionMode(sessionStatusRef.current?.permissionMode)
      || 'yolo';
    const next = TUI_PERMISSION_MODES[(TUI_PERMISSION_MODES.indexOf(current) + 1) % TUI_PERMISSION_MODES.length];
    try {
      const result = await onCommandRef.current(`/mode ${next}`);
      const display = formatTuiPermissionMode(next);
      appendMessage('main', {
        type: 'system',
        content: commandResultContent(result, t('tui.event.permission_mode_changed', display)),
      });
      showModeActionFlash(t('tui.mode.switched.permission', display));
      patchSessionStatus((prev) => ({
        ...prev,
        permissionMode: next,
        modes: prev.modes ? {
          ...prev.modes,
          permission: {
            ...prev.modes.permission,
            mode: next,
          },
        } : prev.modes,
      }));
    } catch (error) {
      const display = formatTuiPermissionMode(next);
      const message = t('tui.mode.error.permission', display, error instanceof Error ? error.message : String(error));
      appendMessage('main', { type: 'error', content: message });
      showModeActionFlash(message, 'error');
    }
  }, [appendMessage, patchSessionStatus, showModeActionFlash]);

  const handleInputKey = useTuiKeyController({
    commandArgPickerStateRef,
    setCommandArgPickerState,
    agentQuestionStateRef,
    setAgentQuestionState,
    rewindDialogStateRef,
    setRewindDialogState,
    inputBufferRef,
    setInputBuffer,
    inputCursorRef,
    setInputCursor,
    handleSubmitRef,
    closeSuggestionsRef,
    handleInterruptRef,
    onStopAgentRef,
    currentTabRef,
    requestProcessExit,
    appendMessage,
    setSubmitting,
    setModalType,
    setModalCursor,
    setModalData,
    onOpenGit: loadGitData,
    modalTypeRef,
    modalCursorRef,
    modalSync,
    sortedTasksRef,
    launchedAgentsRef,
    sortedTasks,
    launchedAgents,
    ensureChannelRef,
    switchTabRef,
    suggestionItemsRef,
    suggestionIndexRef,
    setSuggestionIndex,
    setSuggestionItems,
    maybeBuildSuggestions,
    pendingPastesMapRef,
    setPendingPastes,
    parsePlaceholder,
    freePlaceholderId,
    breakHistoryNavigation,
    navigateInputHistory,
    handleTabSwitchRef,
    onToggleCollaborationMode: toggleCollaborationMode,
    onCycleExecutionRoute: cycleExecutionRoute,
    onCycleAutonomyMode: cycleAutonomyMode,
    onCyclePermissionMode: cyclePermissionMode,
    leaderRuntimeQueueLength,
    onClearPendingMessages,
    dagModalPageSize: DAG_MODAL_PAGE_SIZE,
    settingsEditStateRef,
    setSettingsEditState,
    onSettingsFeedback: showSettingsFeedback,
    onLanguageChanged: handleLanguageChanged,
    onCopyLastCode: handleCopyLastCode,
    onCopySelection: handleCopySelectionCtrlC,
    onToggleMouseTracking: handleToggleMouseTracking,
    onToggleLastCard: handleToggleLastCard,
    onOpenWebUI: handleOpenWebUI,
  });

  useRawTerminalInput({
    stdin,
    setRawMode,
    onKey: handleInputKey,
    onPaste: handlePasteDirect,
    onNonTty: () => requestProcessExit('stdin_not_tty'),
    onMouseClick: handleMouseClick,
    mouseTrackingEnabled,
    onMouseWheel: (direction) => {
      // Forward wheel events to modal page scroll when a modal is open
      if (modalTypeRef.current) {
        const step = 3;
        if (direction === 'up') {
          modalSync.handlePageUp(step);
        } else {
          modalSync.handlePageDown(step);
        }
        return;
      }

      const maxOffset = Math.max(0, messageLogTotalLinesRef.current - messageLogMaxLinesRef.current);
      setMessageScrollOffset((prev) => {
        const next = direction === 'up'
          ? Math.min(maxOffset, prev + 3)
          : Math.max(0, prev - 3);
        return next;
      });
    },
  });

  useEffect(() => {
    setMessageScrollOffset(0);
  }, [currentTab]);

  // ── Batch ref sync — single useEffect replaces 29 scattered ones ──
  useEffect(() => {
    channelsRef.current = channels;
    inputCursorRef.current = inputCursor;
    channelsForHeartbeatRef.current = channels;
    leaderStatusRef.current = leaderStatus;
    currentTabRef.current = currentTab;
    inputBufferRef.current = inputBuffer;
    inputHistoryRef.current = inputHistory;
    historyIndexRef.current = historyIndex;
    submittingRef.current = submitting;
    leaderRuntimeActiveRef.current = leaderRuntimeActive;
    inFlightMessageRef.current = inFlightMessage;
    if (onCommand) onCommandRef.current = onCommand;
    if (onSubmit) onSubmitRef.current = onSubmit;
    if (closeSuggestions) closeSuggestionsRef.current = closeSuggestions;
    if (onInterrupt) onInterruptRef.current = onInterrupt;
    if (switchTab) switchTabRef.current = switchTab;
    if (ensureChannel) ensureChannelRef.current = ensureChannel;
    tabOrderRef.current = tabOrder;
    modalTypeRef.current = modalType;
    modalCursorRef.current = modalCursor;
    modalDataRef.current = modalData;
    commandArgPickerStateRef.current = commandArgPickerState;
    agentQuestionStateRef.current = agentQuestionState;
    rewindDialogStateRef.current = rewindDialogState;
    settingsEditStateRef.current = settingsEditState;
    suggestionItemsRef.current = suggestionItems;
    suggestionIndexRef.current = suggestionIndex;
    sortedTasksRef.current = sortedTasks;
    launchedAgentsRef.current = launchedAgents;
  });

  // 消息显示限制：主输出区按真实终端行数固定裁剪，默认贴底；鼠标滚轮通过
  // messageScrollOffset 隐藏较新的行以查看上方历史。streaming 和 finalized
  // 消息走同一个 viewport，避免 finalize / interrupt 时布局跳动。
  const messageLogView = useMemo(() => {
    const build = (maxLines: number) => buildMessageLogView({
      messages: currentChannel?.messages || [],
      currentStream: currentChannel?.currentStream,
      currentThinkingStream: currentChannel?.currentThinkingStream,
      scrollOffset: messageScrollOffset,
      showThinking: config.llm.show_thinking_content === true,
      streamType: currentTab === 'main' ? 'leader' : 'agent',
      width: messageLogBodyWidth,
      maxLines,
      expandedCards,
    });
    const firstPass = build(Math.max(1, messageLogMaxLines));
    const indicatorRows = (firstPass.hiddenAbove > 0 ? 1 : 0) + (firstPass.hiddenBelow > 0 ? 1 : 0);
    if (indicatorRows === 0) return firstPass;
    return build(Math.max(1, messageLogMaxLines - indicatorRows));
  }, [
    currentChannel?.messages,
    currentChannel?.currentStream,
    currentChannel?.currentThinkingStream,
    currentTab,
    messageLogBodyWidth,
    messageLogMaxLines,
    messageScrollOffset,
    languageVersion,
    expandedCards,
  ]);

  messageLogTotalLinesRef.current = messageLogView.totalLines;
  messageLogViewRef.current = messageLogView;
  messageLogGeometryRef.current = {
    topRow: Math.max(1, termSize.rows - layoutBudget.composerLines - messageLogMaxLines + 1),
    bodyLeftCol: (showSidebar ? SIDEBAR_WIDTH : 0) + 2 + 3 + 1,
  };

  useEffect(() => {
    const previous = messageLogMetricsRef.current;
    const totalLines = messageLogView.totalLines;
    const maxOffset = Math.max(0, totalLines - messageLogMaxLines);
    setMessageScrollOffset((prev) => {
      const next = resolveMessageLineScrollOffset({
        previousOffset: prev,
        previousTotalLines: previous.totalLines,
        totalLines,
        maxLines: messageLogMaxLines,
        previousTab: previous.tab,
        currentTab,
      });
      return next === prev ? prev : next;
    });
    messageLogMetricsRef.current = { tab: currentTab, totalLines };
  }, [currentTab, messageLogMaxLines, messageLogView.totalLines]);

  useEffect(() => {
    activeMessageSelectionRef.current = null;
    messageSelectionRef.current = null;
    setMessageSelection(null);
  }, [currentTab, messageScrollOffset]);

  const permissionPreviewPanel = useMemo(() => {
    if (!pendingPermissionRequest) return null;
    const channelName = pendingPermissionRequest.workerName && channels[pendingPermissionRequest.workerName]
      ? pendingPermissionRequest.workerName
      : 'main';
    const messages = channels[channelName]?.messages || channels.main?.messages || [];
    return buildPermissionPreviewPanel({
      approval: pendingPermissionRequest,
      messages,
      maxWidth: Math.max(24, termSize.cols - 10),
    });
  }, [pendingPermissionRequest, channels, termSize.cols, languageVersion]);

  const modalOverlay = useTuiModalOverlay({
    modalType,
    modalData,
    modalCursor,
    termCols: termSize.cols,
    termRows: termSize.rows,
    sortedTasks,
    launchedAgents,
    agentDiagnostics,
    channels,
    notifications,
    workNotes,
    gitData,
    blueprint,
    graphNodes,
    graphEdges,
    graphEnabled,
    settingsEditState,
    settingsFeedback,
    memoryStatus,
  });

  // 构造 streaming prop — 由 streamingTick 驱动定时刷新
  // 注意：必须放在所有 early return 之前，确保每次渲染调用的 hook 数量恒定
  const streamingStatus = useMemo(() => {
    void streamingTick; // 触发 useMemo 重算
    // 压缩进行中：即使 runtime activity 的 token 还没动，也要显示「compacting context」，
    // 避免长压缩（尤其 LLM 分层摘要）期间状态条空白让用户以为卡死。
    if (compactingState) {
      const chunkSuffix = compactingState.chunkTotal
        ? ` ${compactingState.chunkIndex ?? '?'}/${compactingState.chunkTotal}`
        : '';
      return {
        active: true,
        outputTokens: 0,
        startedAt: compactingState.startedAt,
        phase: 'compacting',
        streamingToolName: undefined,
        toolName: compactingState.stage === 'llm_summary' ? `summary${chunkSuffix}` : undefined,
        compactingProgress: compactingState,
      };
    }
    // 工具执行中：优先显示 tool_executing phase + 工具名 + 计时器 + partialJson
    // 放在 effectiveLeaderRuntimeActive 检查之前，确保工具执行期间即使 runtime 状态有延迟也能显示
    if (toolExecutingState.toolName && toolExecutingState.startedAt) {
      return {
        active: true,
        outputTokens: 0,
        startedAt: toolExecutingState.startedAt,
        phase: 'tool_executing',
        streamingToolName: undefined,
        toolName: toolExecutingState.toolName,
        partialJson: toolExecutingState.partialJson,
      };
    }
    if (!effectiveLeaderRuntimeActive) return undefined;
    const outputTokens = tokenUsageHandlers.getStreamingOutputTokens();
    const startedAt = tokenUsageHandlers.getStreamingStartedAt();
    if (!outputTokens && !startedAt) return undefined;
    return {
      active: true,
      outputTokens,
      startedAt,
      phase: undefined,
      streamingToolName: undefined,
      toolName: undefined,
    };
  }, [streamingTick, effectiveLeaderRuntimeActive, leaderStatus, tokenUsageHandlers, compactingState, toolExecutingState]);

  // 侧栏底部实时状态面板数据（全部来自现成的运行时状态）
  // 注意：必须放在所有 early return 之前，确保每次渲染调用的 hook 数量恒定
  const activeWorkerCount = useMemo(
    () => Object.values(agentInteractiveStates).filter((s) => {
      const st = (s.status || '').toLowerCase();
      return st === 'running' || st === 'working' || st === 'processing' || st === 'thinking' || st === 'starting' || st === 'busy';
    }).length,
    [agentInteractiveStates],
  );
  const sidebarStatus = useMemo(() => ({
    mode: currentMode,
    activeWorkers: activeWorkerCount,
    totalWorkers: launchedAgents.length,
    leaderActive: effectiveLeaderRuntimeActive,
    contextTokens: mainContextTotal,
    contextLimit: mainContextTotal !== undefined ? contextLimit : undefined,
    contextPct: currentContextPct,
    totalTokens: tokenUsage.total,
    cost: sessionCost,
    modelName,
    memory: {
      activeKind: maintenanceState?.kind,
      dreamDue: memoryStatus?.pipelines.dream.due,
      distillDue: memoryStatus?.pipelines.distill.due,
      assets: memoryStatus?.assets.length,
      memoryLines: memoryStatus?.memoryLines,
    },
  }), [currentMode, activeWorkerCount, launchedAgents.length, effectiveLeaderRuntimeActive, mainContextTotal, contextLimit, currentContextPct, tokenUsage.total, modelName, maintenanceState, memoryStatus]);

  // ─── Render ──
  if (termSize.cols < 24) {
    return (
      <Box flexDirection="column">
        <Text bold color={tuiTheme.semantic.status.blocked}>{t('tui.terminal.too_narrow')}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.terminal.too_narrow_hint')}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.terminal.current_size', termSize.cols, termSize.rows)}</Text>
      </Box>
    );
  }

  const hasModal = Boolean(agentQuestionState || commandArgPickerState || rewindDialogState || (modalType && modalOverlay));
  if (hasModal) {
    return (
      <ModalHost
        termCols={termSize.cols}
        termRows={termSize.rows}
        agentQuestionState={agentQuestionState}
        commandArgPickerState={commandArgPickerState}
        rewindDialogState={rewindDialogState}
        modalVisible={Boolean(modalType && modalOverlay)}
        modalOverlay={modalOverlay}
        modalAlign={modalType === 'settings' || modalType === 'git' || modalType === 'dag' || modalType === 'team' || modalType === 'graph' ? 'top' : 'center'}
        onQuestionSubmit={(answer) => {
          setAgentQuestionState(null);
          inputBufferRef.current = answer;
          setInputBuffer(answer);
          handleSubmitRef.current();
        }}
        onQuestionCancel={() => setAgentQuestionState(null)}
        onCommandArgSelect={(item) => {
          const fullCmd = `${commandArgPickerState?.commandName || ''} ${item.name}`;
          setCommandArgPickerState(null);
          inputBufferRef.current = fullCmd;
          setInputBuffer(fullCmd);
          handleSubmitRef.current();
        }}
        onCommandArgCancel={() => setCommandArgPickerState(null)}
        onRewindCancel={() => setRewindDialogState(null)}
      />
    );
  }

  const mainAreaWidth = showSidebar
    ? termSize.cols - SIDEBAR_WIDTH - 4
    : termSize.cols - 4;

  const contentWidth = showSidebar ? termSize.cols - SIDEBAR_WIDTH : termSize.cols;

  // Determine which sidebar item should be highlighted
  const MODAL_TO_SIDEBAR: Record<string, string> = {
    dag: '__tasks',
    team: '__agents',
    graph: '__blackboard',
    git: '__git',
    blueprint: '__blueprint',
    memory: '__memory',
    report: '__report',
    settings: '__settings',
  };
  const activeSidebarItem = (modalType && MODAL_TO_SIDEBAR[modalType]) || currentTab;

  return (
    <Box flexDirection="row" width={termSize.cols} height={termSize.rows} overflow="hidden">
      {showSidebar && (
        <TuiSidebar
          items={sidebarItems}
          activeItem={activeSidebarItem}
          width={SIDEBAR_WIDTH}
          onSelect={setCurrentTab}
          status={sidebarStatus}
        />
      )}
      <Box flexDirection="column" width={contentWidth} height={termSize.rows} overflow="hidden">
      <HeaderBar
        modelName={modelName}
        currentTab={currentTab}
        currentAgentStatusDisplay={currentAgentStatusDisplay}
        currentTokenTotal={currentTokenTotal}
        createdAt={sessionStatus.createdAt}
        streaming={streamingStatus}
      />

      {/* ── Meta line: cwd · 权限 · 控制模式 · 队列 · tabs · 任务概览 ── */}
      {metaLine && (
        <Box marginLeft={2} marginRight={2} marginBottom={1}>
          <Text color={tuiTheme.semantic.text.secondary} wrap="truncate-end">{metaLine}</Text>
        </Box>
      )}

      {/* ── Notification Banner ── */}
      <Box marginLeft={2} marginRight={2}>
        <NotificationBanner notifications={notifications} width={mainAreaWidth} />
      </Box>

      {pendingPermissionRequest && (
        <Box flexDirection="column" marginBottom={1} marginLeft={2} marginRight={2}>
          <Text color={tuiTheme.semantic.runtime.approval} bold>
            {t(
              'tui.permission.request_title',
              pendingPermissionRequest.source,
              pendingPermissionRequest.workerName || '',
              pendingPermissionRequest.toolName,
            )}
          </Text>
          <Text color={tuiTheme.semantic.text.secondary}>{truncateDisplayText(pendingPermissionRequest.reason, Math.max(24, termSize.cols - 2))}</Text>
          <Text color={tuiTheme.semantic.panel.help}>
            {truncateDisplayText(t('tui.permission.approve_hint', buildPermissionPreviewHint(pendingPermissionRequest.toolName)), Math.max(24, termSize.cols - 2))}
          </Text>
          {permissionPreviewPanel && (
            <Box marginTop={1}>
              <PanelFrame
                title={permissionPreviewPanel.title}
                width={Math.max(24, termSize.cols - 4)}
                border
                paddingX={1}
              >
              {permissionPreviewPanel.lines.map((line, index) => (
                <Text
                  key={`perm-preview-${index}`}
                  color={line.kind === 'section' ? tuiTheme.semantic.text.secondary : tuiTheme.semantic.panel.help}
                  bold={line.kind === 'section'}
                >
                  {line.kind === 'section'
                    ? truncateDisplayText(line.label, Math.max(24, termSize.cols - 6))
                    : truncateDisplayText(`${line.label}: ${line.value || ''}`, Math.max(24, termSize.cols - 6))}
                </Text>
              ))}
              {permissionPreviewPanel.footer && (
                <Text color={tuiTheme.semantic.text.secondary}>
                  {truncateDisplayText(permissionPreviewPanel.footer, Math.max(24, termSize.cols - 6))}
                </Text>
              )}
              </PanelFrame>
            </Box>
          )}
        </Box>
      )}



      {currentTab !== 'main' && currentAgentRuntimePanel.visible && (
        <Box marginLeft={2} marginRight={2}>
          <AgentRuntimePanel
            snapshot={currentAgentInteractiveState}
            maxWidth={Math.max(24, mainAreaWidth)}
          />
        </Box>
      )}

      {/* ── Home Screen with sword animation (shown when no messages yet) ── */}
      {currentTab === 'main' && messageLogView.totalLines === 0 && (
        <Box marginLeft={2} marginRight={2} marginTop={1}>
          <HomeScreen
            workspace={workspace}
            width={mainAreaWidth}
            modelName={modelName}
          />
        </Box>
      )}

      {!isConstrainHeight() && (
        <Box marginBottom={1} marginLeft={2} marginRight={2}>
          <Text color={tuiTheme.semantic.status.blocked}>
            {t('tui.message.collapse_long')}
          </Text>
        </Box>
      )}

      {/* ── Message viewport: fixed chat-style output, bottom pinned by default ── */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        overflowY="hidden"
      >
        <Box marginLeft={2} marginRight={2}>
          <MessageLog
            lines={messageLogView.visibleLines}
            hiddenAbove={messageLogView.hiddenAbove}
            hiddenBelow={messageLogView.hiddenBelow}
            truncatedMessages={messageLogView.truncatedMessages}
            theme={tuiTheme}
            width={messageLogWidth}
            selection={messageSelection}
          />
        </Box>
      </Box>

      {/* MaintenanceStatusLine is now rendered inside Composer via maintenanceSlot */}

      <Composer
        showLeaderProcessingIndicator={effectiveLeaderRuntimeActive}
        agentStatusItems={agentStatusItems}
        termCols={termSize.cols}
        suggestionPanel={suggestionItems.length > 0 ? (
          <SuggestionsList
            items={suggestionItems}
            selectedIndex={suggestionIndex}
            theme={tuiTheme}
            userInput={inputBuffer}
            termWidth={termSize.cols}
          />
        ) : undefined}
        submitting={submitting}
        inputBuffer={inputBuffer}
        inputCursor={inputCursor}
        sessionStatus={sessionStatus}
        inputTarget={inputTarget}
        modeActionText={modeActionText}
        modeActionActive={Boolean(modeActionFlash)}
        modeActionTone={modeActionFlash?.tone}
        shortcutHintText={shortcutHintText}
        currentTab={currentTab}
        maintenanceSlot={maintenanceState ? (
          <MaintenanceStatusLine
            kind={maintenanceState.kind}
            stage={maintenanceState.stage}
            progress={maintenanceState.progress}
            detail={maintenanceState.detail}
            startedAt={maintenanceState.startedAt}
          />
        ) : undefined}
      />
    </Box>
    </Box>
  );
};

export default LingXiaoTUI;
