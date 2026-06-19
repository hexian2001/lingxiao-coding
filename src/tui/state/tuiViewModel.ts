import type { WorkerInteractiveRuntimeSnapshot } from '../../agents/runtime/WorkerInteractiveRuntime.js';
import type { CommandSessionStatusData, CommandTaskData } from '../../commands/types.js';
import type { WorkerBackend } from '../../contracts/types/Agent.js';
import { buildEternalRuntimeProjection } from '../../core/EternalRuntimeProjection.js';
import { normalizeAgentStatus, normalizeTaskDisplayState } from '../../core/StateSemantics.js';
import { t } from '../../i18n.js';
import type { AgentStatusItem } from '../components/AgentStatusBar.js';
import {
  buildTabStripView,
  deriveAgentStatusDisplay,
  formatElapsedLabel,
  shouldShowAgentProgressMessage,
  dedupTasksById,
  sortTasksForDisplay,
  truncateDisplayText,
} from '../utils.js';
import { getChannelDisplayStatus } from './channelState.js';
import type { AgentRuntimeDiagnostic, ChannelState } from './types.js';

export interface LaunchedAgentViewInput {
  name: string;
  role?: string;
  taskId?: string;
  backend?: WorkerBackend;
}

export interface TaskCountsView {
  pending: number;
  blocked: number;
  inProgress: number;
  completed: number;
  failed: number;
}

export interface AgentCandidateView {
  name: string;
  desc: string;
}

export function buildTuiEternalRuntimeMeta(sessionStatus: CommandSessionStatusData, now = Date.now()): string {
  const eternal = sessionStatus.eternal;
  if (!eternal) return '';
  const projection = buildEternalRuntimeProjection(eternal, now);
  if (!projection) return '';
  const goalLabel = eternal.goal?.description
    ? t('tui.meta.eternal_goal', truncateDisplayText(eternal.goal.description, 28))
    : '';
  const base = t(
    'tui.meta.eternal',
    projection.statusLabel,
    eternal.consecutiveIdlePatrols,
    eternal.totalPatrols,
  );
  return [base, projection.detailLabel, goalLabel].filter(Boolean).join(' · ');
}

export interface TuiStatusView {
  currentAgentStatusDisplay: string;
  agentStatusItems: AgentStatusItem[];
  agentCandidates: AgentCandidateView[];
  runningAgentCount: number;
  doneAgentCount: number;
  statusPrimaryLine: string;
  statusSecondaryLine: string;
}

export interface TuiLayoutBudget {
  topStatusLines: number;
  metaLineLines: number;
  permissionBannerLines: number;
  taskSummaryLines: number;
  interactiveRuntimeLines: number;
  footerLines: number;
  agentStatusBarLines: number;
  headerLines: number;
  composerLines: number;
  messageLogMaxLines: number;
  staticAreaMaxItemHeight: number;
}

export function buildAgentDiagnosticParts(
  diagnostic?: AgentRuntimeDiagnostic,
  interactiveState?: WorkerInteractiveRuntimeSnapshot,
  now = Date.now(),
): string[] {
  if (!diagnostic && !interactiveState) return [];

  const formatAge = (at?: number): string | null => {
    if (!at) return null;
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 60) return t('tui.meta.age.seconds', seconds);
    const minutes = Math.floor(seconds / 60);
    const remain = seconds % 60;
    return remain > 0
      ? t('tui.meta.age.minutes_seconds', minutes, remain)
      : t('tui.meta.age.minutes', minutes);
  };

  const showHeartbeat = diagnostic?.lastHeartbeatAt ? (now - diagnostic.lastHeartbeatAt) <= 45_000 : false;
  const showProgress = shouldShowAgentProgressMessage(diagnostic?.lastProgressMessage, diagnostic?.lastProgressAt, now);

  return [
    diagnostic?.lastToolName && diagnostic?.lastToolAt ? t('tui.meta.tool', diagnostic.lastToolName, formatAge(diagnostic.lastToolAt) || '') : '',
    diagnostic?.lastTextAt ? t('tui.meta.output', formatAge(diagnostic.lastTextAt) || '') : '',
    showHeartbeat ? t('tui.meta.heartbeat', formatAge(diagnostic?.lastHeartbeatAt) || '') : '',
    showProgress ? truncateDisplayText(t('tui.meta.progress', diagnostic?.lastProgressMessage || ''), 32) : '',
    diagnostic?.backend && diagnostic.backend !== 'worker_process' ? t('tui.meta.backend', diagnostic.backend) : '',
    diagnostic?.externalSessionId ? t('tui.meta.external_session', truncateDisplayText(diagnostic.externalSessionId, 12)) : '',
    diagnostic?.pid ? t('tui.meta.pid', diagnostic.pid) : '',
    diagnostic?.recoveryAction ? t('tui.meta.recovery', diagnostic.recoveryAction) : '',
    diagnostic?.stderrTail?.length ? t('tui.meta.stderr', truncateDisplayText(diagnostic.stderrTail[diagnostic.stderrTail.length - 1] || '', 24)) : '',
    interactiveState && interactiveState.pendingApprovals.length > 0 ? t('tui.meta.approvals', interactiveState.pendingApprovals.length) : '',
    interactiveState && interactiveState.liveOutputs.length > 0 ? t('tui.meta.stream_outputs', interactiveState.liveOutputs.length) : '',
    interactiveState && Object.values(interactiveState.shellPids).length > 0 ? t('tui.meta.shell', Object.values(interactiveState.shellPids).join(',')) : '',
  ].filter(Boolean);
}

export function buildTaskCounts(tasks: CommandTaskData[]): TaskCountsView {
  const counts: TaskCountsView = {
    pending: 0,
    blocked: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
  };

  for (const task of dedupTasksById(tasks)) {
    const state = normalizeTaskDisplayState(task);
    if (state === 'pending' || state === 'dispatchable') {
      counts.pending += 1;
    } else if (state === 'blocked') {
      counts.blocked += 1;
    } else if (state === 'running') {
      counts.inProgress += 1;
    } else if (state === 'completed') {
      counts.completed += 1;
    } else if (state === 'failed' || state === 'cancelled') {
      counts.failed += 1;
    }
  }

  return counts;
}

export function buildTaskSummaryText(tasks: CommandTaskData[], counts = buildTaskCounts(tasks)): string {
  const deduped = dedupTasksById(tasks);
  if (deduped.length === 0) return '';
  const sortedTasks = sortTasksForDisplay(deduped);
  if (sortedTasks.length === 0) return '';
  return t('tui.meta.tasks', deduped.length, counts.inProgress, counts.pending, counts.blocked, counts.completed, counts.failed);
}

export function buildAgentStatusItems(
  launchedAgents: LaunchedAgentViewInput[],
  channels: Record<string, ChannelState>,
): AgentStatusItem[] {
  return launchedAgents.map(agent => ({
    name: agent.name,
    status: channels[agent.name]?.status || 'idle',
  }));
}

export function buildAgentCandidates(input: {
  launchedAgents: LaunchedAgentViewInput[];
  channels: Record<string, ChannelState>;
  tabOrder: string[];
}): AgentCandidateView[] {
  const byName = new Map<string, AgentCandidateView>();

  for (const agent of input.launchedAgents) {
    const status = getChannelDisplayStatus(input.channels[agent.name]);
    const parts = [agent.role, status, agent.taskId].filter(Boolean);
    byName.set(agent.name, { name: `@${agent.name}`, desc: parts.join(' · ') });
  }

  for (const tab of input.tabOrder) {
    if (tab === 'main' || byName.has(tab)) continue;
    const ch = input.channels[tab];
    const parts = [ch?.role, getChannelDisplayStatus(ch), ch?.taskId].filter(Boolean);
    byName.set(tab, { name: `@${tab}`, desc: parts.join(' · ') });
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTuiMetaLine(input: {
  sessionStatus: CommandSessionStatusData;
  currentTab: string;
  tabOrder: string[];
  channels: Record<string, ChannelState>;
  mainQueuedCount: number;
  taskSummaryText: string;
  currentAgentDiagnostic?: AgentRuntimeDiagnostic;
  currentAgentInteractiveState?: WorkerInteractiveRuntimeSnapshot;
  maxWidth: number;
  now?: number;
}): string {
  const tabStrip = buildTabStripView({
    maxWidth: Math.max(24, input.maxWidth),
    items: input.tabOrder.map(tab => {
      const ch = input.channels[tab];
      const label = tab === 'main' ? 'main' : `@${tab}`;
      const parts = [label, getChannelDisplayStatus(ch), ch?.role, ch?.taskId].filter(Boolean);
      return {
        key: tab,
        activeLabel: `[${parts.join(' · ')}]`,
        inactiveLabel: label,
        active: tab === input.currentTab,
      };
    }),
  });

  const modes = input.sessionStatus.modes;
  const routeMeta = modes
    ? t('tui.meta.route', formatTuiRouteMode(modes.route.mode), modes.route.preference !== 'auto' ? formatTuiRoutePreference(modes.route.preference) : '')
    : '';
  const collabMeta = modes
    ? t(
      'tui.meta.collaboration',
      formatTuiCollaborationMode(modes.collaboration.mode),
      modes.collaboration.mode === 'team' && modes.collaboration.teamEnabled ? modes.collaboration.activeTeamName || '' : '',
    )
    : '';
  const metaSegments = [
    input.sessionStatus.workspace ? t('tui.meta.cwd', input.sessionStatus.workspace) : '',
    t('tui.meta.permission', input.sessionStatus.permissionSummary || t('tui.meta.unconfigured')),
    input.sessionStatus.controlMode ? t('tui.meta.control', input.sessionStatus.controlMode === 'eternal' ? t('tui.meta.control_eternal') : t('tui.meta.control_manual')) : '',
    routeMeta,
    collabMeta,
    buildTuiEternalRuntimeMeta(input.sessionStatus, input.now),
    input.mainQueuedCount > 0 ? t('tui.meta.queue', input.mainQueuedCount) : '',
    tabStrip.items.length > 0
      ? t('tui.meta.tabs', tabStrip.items.map(item => item.active ? `[${item.text}]` : item.text).join(' '), tabStrip.hiddenCount)
      : '',
    input.taskSummaryText,
  ].filter(Boolean);

  if (input.currentTab !== 'main') {
    const diagnosticSummary = buildAgentDiagnosticParts(
      input.currentAgentDiagnostic,
      input.currentAgentInteractiveState,
      input.now,
    ).join(' · ');
    if (diagnosticSummary) metaSegments.push(diagnosticSummary);
  }

  return truncateDisplayText(metaSegments.join(' · '), Math.max(24, input.maxWidth));
}

function nextPermissionMode(mode?: string): string {
  const modes = ['yolo', 'networked', 'dev', 'strict'];
  const index = modes.indexOf(mode || 'yolo');
  return modes[(index >= 0 ? index + 1 : 1) % modes.length];
}

function nextRoutePreference(mode?: string): string {
  const modes = ['auto', 'direct', 'delegate'];
  const index = modes.indexOf(mode || 'auto');
  return modes[(index >= 0 ? index + 1 : 1) % modes.length];
}

export function formatTuiCollaborationMode(mode?: string): string {
  return mode === 'team' ? t('tui.mode.collaboration.team') : t('tui.mode.collaboration.solo');
}

export function formatTuiRouteMode(mode?: string): string {
  if (mode === 'hybrid') return t('tui.mode.route.hybrid');
  if (mode === 'delegate') return t('tui.mode.route.delegate');
  if (mode === 'unknown') return t('tui.mode.route.unknown');
  return t('tui.mode.route.direct');
}

export function formatTuiRoutePreference(mode?: string): string {
  if (mode === 'direct') return t('tui.mode.route.direct');
  if (mode === 'delegate') return t('tui.mode.route.delegate');
  return t('tui.mode.route.auto');
}

// hybrid 不再作为用户偏好暴露（auto 运行时默认即解析为 hybrid）；此处仅给 auto/direct/delegate 配说明，供 cycle flash 展示
export function formatTuiRouteHint(mode?: string): string {
  if (mode === 'direct') return t('tui.mode.route.directHint');
  if (mode === 'delegate') return t('tui.mode.route.delegateHint');
  return t('tui.mode.route.autoHint');
}

export function formatTuiPermissionMode(mode?: string): string {
  if (mode === 'networked') return t('tui.mode.permission.networked');
  if (mode === 'dev') return t('tui.mode.permission.dev');
  if (mode === 'strict') return t('tui.mode.permission.strict');
  return t('tui.mode.permission.yolo');
}

export function buildTuiModeActionText(
  sessionStatus: CommandSessionStatusData,
  maxWidth: number,
  options: { feedback?: string; feedbackTone?: 'success' | 'error' } = {},
): string {
  const modes = sessionStatus.modes;
  const collabMode = modes?.collaboration.mode === 'team' ? 'team' : 'solo';
  const nextCollabMode = collabMode === 'team' ? 'solo' : 'team';
  const routePreference = modes?.route.preference || 'auto';
  const nextRoute = nextRoutePreference(routePreference);
  const permissionMode = modes?.permission.mode || sessionStatus.permissionMode || 'yolo';
  const width = Math.max(24, maxWidth);
  const header = options.feedback
    ? options.feedbackTone === 'error'
      ? t('tui.mode.feedback.error', options.feedback)
      : t('tui.mode.feedback.success', options.feedback)
    : t('tui.mode.header');
  const text = [
    header,
    t('tui.mode.collaboration', formatTuiCollaborationMode(collabMode), formatTuiCollaborationMode(nextCollabMode)),
    t('tui.mode.route', formatTuiRoutePreference(routePreference), formatTuiRoutePreference(nextRoute)),
    t('tui.mode.permission', formatTuiPermissionMode(permissionMode), formatTuiPermissionMode(nextPermissionMode(permissionMode))),
  ].filter(Boolean).join(' · ');
  if (text.length <= width) return text;

  const compact = [
    header,
    t('tui.mode.compact.collaboration', formatTuiCollaborationMode(collabMode)),
    t('tui.mode.compact.route', formatTuiRoutePreference(routePreference)),
    t('tui.mode.compact.permission', formatTuiPermissionMode(permissionMode)),
  ].filter(Boolean).join(' · ');
  if (compact.length <= width) return compact;

  const minimum = [
    header,
    'Alt+C Alt+R Alt+P',
  ].filter(Boolean).join(' · ');
  if (minimum.length <= width) return minimum;

  return truncateDisplayText('Alt+C Alt+R Alt+P', width);
}

export function buildTuiStatusView(input: {
  modelName: string;
  currentTab: string;
  currentChannel?: ChannelState;
  sessionStatus: CommandSessionStatusData;
  leaderStatus: string;
  currentTokenTotal: number;
  footerActivityText: string;
  launchedAgents: LaunchedAgentViewInput[];
  channels: Record<string, ChannelState>;
  tabOrder: string[];
  currentAgentDiagnostic?: AgentRuntimeDiagnostic;
  maxWidth: number;
  now?: number;
}): TuiStatusView {
  const now = input.now ?? Date.now();
  const currentAgentStatusDisplay = input.currentTab !== 'main'
    ? deriveAgentStatusDisplay({
        status: getChannelDisplayStatus(input.currentChannel),
        lastProgressAt: input.currentAgentDiagnostic?.lastProgressAt,
        lastProgressMessage: input.currentAgentDiagnostic?.lastProgressMessage,
        lastHeartbeatAt: input.currentAgentDiagnostic?.lastHeartbeatAt,
        lastTextAt: input.currentAgentDiagnostic?.lastTextAt,
        lastToolAt: input.currentAgentDiagnostic?.lastToolAt,
        hasVisibleStream: Boolean(input.currentChannel?.currentStream || input.currentChannel?.currentThinkingStream),
        now,
      })
    : input.leaderStatus;

  const agentStatusItems = buildAgentStatusItems(input.launchedAgents, input.channels);
  const agentCandidates = buildAgentCandidates({
    launchedAgents: input.launchedAgents,
    channels: input.channels,
    tabOrder: input.tabOrder,
  });
  const runningAgentCount = agentStatusItems.filter(agent => normalizeAgentStatus(agent.status) === 'running').length;
  const doneAgentCount = agentStatusItems.filter(agent => {
    const status = normalizeAgentStatus(agent.status);
    return status === 'completed' || status === 'idle';
  }).length;
  const tokenText = input.currentTokenTotal >= 1000
    ? `${(input.currentTokenTotal / 1000).toFixed(1)}k`
    : String(input.currentTokenTotal);

  const statusPrimarySegments = [
    t('tui.meta.model', input.modelName),
    t('tui.meta.tokens', tokenText),
    t('tui.meta.running', runningAgentCount),
    agentStatusItems.length > 0 ? t('tui.meta.done', doneAgentCount, agentStatusItems.length) : '',
    input.sessionStatus.createdAt ? t('tui.meta.duration', formatElapsedLabel(Math.floor((now - input.sessionStatus.createdAt) / 1000))) : '',
  ].filter(Boolean);
  const statusSecondarySegments = [
    input.sessionStatus.sessionId,
    input.currentTab === 'main' ? t('tui.leader.label') : `@${input.currentTab}`,
    currentAgentStatusDisplay,
    input.footerActivityText,
  ].filter(Boolean);

  return {
    currentAgentStatusDisplay,
    agentStatusItems,
    agentCandidates,
    runningAgentCount,
    doneAgentCount,
    statusPrimaryLine: truncateDisplayText(statusPrimarySegments.join(' · '), Math.max(24, input.maxWidth)),
    statusSecondaryLine: truncateDisplayText(statusSecondarySegments.join(' · '), Math.max(24, input.maxWidth)),
  };
}

export function buildTuiLayoutBudget(input: {
  termRows: number;
  hasMetaLine: boolean;
  hasPermissionRequest: boolean;
  hasInteractiveRuntimePanel: boolean;
  interactiveRuntimeLineCount: number;
  hasAgentStatusItems: boolean;
  hasStatusSecondaryLine: boolean;
  hasLeaderProcessingIndicator?: boolean;
  hasModeActions?: boolean;
}): TuiLayoutBudget {
  const topStatusLines = input.hasStatusSecondaryLine ? 2 : 1;
  const metaLineLines = input.hasMetaLine ? 2 : 0;
  const permissionBannerLines = input.hasPermissionRequest ? 3 : 0;
  const taskSummaryLines = 0;
  const interactiveRuntimeLines = input.hasInteractiveRuntimePanel
    ? input.interactiveRuntimeLineCount + 1
    : 0;
  // Composer real height: marginTop(1) + [processing indicator+margin(2)] + [mode actions+margin(2)] + inputBox(3) + shortcuts(1)
  const footerLines = (input.hasLeaderProcessingIndicator ? 7 : 5) + (input.hasModeActions ? 2 : 0);
  const agentStatusBarLines = input.hasAgentStatusItems ? 2 : 0;
  const headerLines = topStatusLines + metaLineLines + permissionBannerLines + taskSummaryLines + interactiveRuntimeLines;
  const composerLines = footerLines + agentStatusBarLines;

  return {
    topStatusLines,
    metaLineLines,
    permissionBannerLines,
    taskSummaryLines,
    interactiveRuntimeLines,
    footerLines,
    agentStatusBarLines,
    headerLines,
    composerLines,
    messageLogMaxLines: Math.max(8, input.termRows - headerLines - composerLines - 3),
    staticAreaMaxItemHeight: Math.max(4, Math.floor(Math.max(8, input.termRows - headerLines - composerLines - 3) * 0.8)),
  };
}
