import stringWidth from 'string-width';
import { t } from '../i18n.js';
import { tuiGlyphs } from './design/tokens.js';
import {
  normalizeTaskDisplayState,
  type NormalizedLeaderStatusKind,
} from '../core/StateSemantics.js';
import { splitThinkContent } from '../core/ThinkContent.js';
import { fuzzySearchCommands } from './fuzzyCommand.js';
import { parsePipeTable, renderTableToLines } from './markdown/tableRender.js';
import { replaceInlineMath, extractDisplayMath } from './markdown/mathParse.js';
import { latexToUnicode } from './markdown/latexToUnicode.js';
import {
  AGENT_PROGRESS_STALE_MS,
  formatElapsedLabel,
  isBootstrappingOrConnectingStatus,
  isInactiveStatus,
  sliceByWidth,
  shouldShowAgentProgressMessage,
  truncateDisplayText,
} from './format/display.js';
export {
  deriveAgentStatusDisplay,
  formatAgentHeartbeatText,
  formatElapsedLabel,
  isBootstrappingOrConnectingStatus,
  shouldShowAgentProgressMessage,
  truncateDisplayText,
} from './format/display.js';

export function extractThinkBlock(content: string): { cleaned: string; reasoning?: string } {
  const split = splitThinkContent(content);
  return split.sawThinkTag
    ? { cleaned: split.cleaned, reasoning: split.reasoning }
    : { cleaned: content };
}

export interface LogMessageLike {
  type: 'system' | 'leader' | 'user' | 'agent' | 'thinking' | 'tool' | 'code' | 'table' | 'error' | 'success';
  content: string;
  timestamp?: number;
  toolName?: string;
  toolKind?: 'call' | 'result';
  toolSummary?: string;
  toolMeta?: string;
  isCode?: boolean;
  codeLang?: string;
  /** 文件编辑类工具的内联 diff 行(展开工具卡时渲染 +N -M 着色) */
  toolDiff?: Array<{ kind: 'add' | 'del' | 'context' | 'hunk'; text: string }>;
  /** 工具调用开始时间戳（用于实时计时器） */
  toolStartedAt?: number;
}

// ── 消息渲染窗口(虚拟化):只渲染最近一部分消息,避免长会话全量渲染卡死 ──
// 从最新消息(含流式虚拟消息)向前累积,条数/字符量任一触顶即停;
// 单条贡献封顶防超长消息/大代码 dump 独占窗口。与 channelState 的内存上限
// (4500 条,保留完整历史可 /rewind)正交——此处只裁渲染层。卡死根因见 buildMessageLogView。
export const MAX_RENDER_MESSAGES = 120;
export const MAX_RENDER_CHARS = 65536;
export const PER_MESSAGE_CHAR_CAP = 32768;

export interface RenderedLogLine {
  // spacer 是纯视觉占位行(空行呼吸间距),不属于逻辑消息类型(LogMessageLike['type'])。
  type: LogMessageLike['type'] | 'spacer';
  text: string;
  isContinuation?: boolean;
  /** If type === 'code', this stores the raw code content */
  codeContent?: string;
  codeLang?: string;
  /** Unique 0-based index for this code block (global across all messages) */
  codeBlockIndex?: number;
  /** If type === 'tool', tool summary info */
  toolName?: string;
  toolKind?: 'call' | 'result';
  toolSummary?: string;  // e.g. "Read lines 259-288 of 466 from path"
  toolMeta?: string;     // e.g. "src/llm/providers/OpenAIProvider.ts (lines 259-288)"
  toolStatus?: string;
  toolDuration?: number;
  /** 工具调用开始时间戳（用于实时计时器） */
  toolStartedAt?: number;
  toolInput?: string;
  toolOutput?: string;
  /** 卡片头行标识:落点命中该行 → toggle 此卡的展开态(thinking/tool 卡) */
  cardKey?: string;
  /** 该卡当前是否折叠(渲染层据此显示 ▸/▾) */
  cardCollapsed?: boolean;
  /** 展开工具卡时,diff 行的着色类别 */
  toolDiffKind?: 'add' | 'del' | 'context' | 'hunk';
  /** 工具卡 diff 统计,头行显示 +N -M */
  toolAdded?: number;
  toolRemoved?: number;
  /** 列表项标记(ul '•'/'◦'、ol '1.');有值表示该行是列表项,line.text 仅含正文 */
  listMarker?: string;
  /** 列表缩进级别(原 leadingWhitespace 宽度,用于嵌套对齐) */
  listIndent?: number;
  /** ol=true / ul=false */
  listOrdered?: boolean;
  /** 列表项续行(wrap 软换行或缩进续行):保留 listMarker 供宽度对齐,渲染时不显示 marker 字符 */
  listContinuation?: boolean;
  /** 流式未闭合代码块(无闭合 ``` 围栏),footer 渲染虚线底框 */
  codeOpenEnded?: boolean;
  /** 表格行/块级公式行:供选择/复制的纯文本(去 ANSI + markdown 标记)。表格行 text 是带 ANSI 的渲染串。 */
  tablePlainLine?: string;
  /** 块级公式行(由 $$...$$ 转换而来):type 仍为 'table',靠此标志区分渲染样式(secondary 色,不走 RenderInline)。 */
  mathLine?: boolean;
  /** 同一表格的多行关联(便于将来按表分组样式/选择)。 */
  tableGroupIndex?: number;
}

/** Viewport-relative row position of a code block's header line */
export interface CodeBlockMeta {
  index: number;          // unique code block index
  visibleRow: number;     // viewport row of the code block's first line (the header)
  content: string;
  lang: string;
  preview: string;
  lineCount: number;
}

export type SuggestionType = 'command' | 'agent' | 'skill' | null;

export interface SuggestionItem {
  name: string;
  desc: string;
  /** 模糊命中区间（针对 name，含 '/'），供高亮下划线 */
  nameMatches?: Array<[number, number]>;
}

export interface TabStripInputItem {
  key: string;
  activeLabel: string;
  inactiveLabel: string;
  active: boolean;
}

export interface TabStripViewItem {
  key: string;
  text: string;
  active: boolean;
}

export interface ModalSourceTask {
  id: string;
  subject: string;
  status: string;
  displayState?: string;
  display_state?: string;
  exitReason?: string;
  exit_reason?: string;
  agent_type?: string;
  assigned_agent?: string;
  blocked_by?: string[];
  working_directory?: string;
  write_scope?: string[];
}

/**
 * 按 id 幂等去重，保留首次出现。UI 任务列表语义上是「按 id 的集合」：
 * task:created 可能与 orchestration:node_update 或会话快照补水合携带同一任务先后到达，
 * 绝不能让同一 id 在列表中出现两次（否则 DAG/TaskBoard 把一个任务渲染成两条）。
 */
export function dedupTasksById<T extends ModalSourceTask>(tasks: T[]): T[] {
  const seen = new Set<string>();
  return tasks.filter(task => {
    const id = task.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function sortTasksForDisplay<T extends ModalSourceTask>(tasks: T[]): T[] {
  const statusPriority: Record<string, number> = {
    in_progress: 0,
    running: 0,
    pending: 1,
    dispatchable: 1,
    blocked: 2,
    failed: 3,
    cancelled: 4,
    completed: 5,
  };
  return dedupTasksById(tasks)
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const aStatus = normalizeTaskDisplayState(a.task);
      const bStatus = normalizeTaskDisplayState(b.task);
      const aPriority = statusPriority[aStatus] ?? 99;
      const bPriority = statusPriority[bStatus] ?? 99;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return a.index - b.index;
    })
    .map(({ task }) => task);
}

export interface ModalSourceSession {
  id: string;
  status?: string;
  preview: string;
  createdAt?: number;
}

export interface ModalSourceAgent {
  name: string;
  status: string;
  role?: string;
  taskId?: string;
  currentNext?: string;
  tokenUsage?: number;
  iterations?: number;
  toolCalls?: number;
}

export interface ModalSourceSkill {
  id: string;
  source?: string;
  preview: string;
  status?: string;
}

export interface ModalTableRow {
  primary: string;
  secondary?: string;
}

export interface ModalTableItem {
  title: string;
  detail: string;
  meta?: string;
}

export interface ModalTableView {
  header?: string;
  rows: ModalTableRow[];
  items?: ModalTableItem[];
}

export interface ModalTableViewOptions {
  modalType: 'dag' | 'resume' | 'history' | 'skills';
  tasks?: ModalSourceTask[];
  agents?: ModalSourceAgent[];
  sessions?: ModalSourceSession[];
  skills?: ModalSourceSkill[];
}

export interface BracketedPasteState {
  active: boolean;
  buffer: string;
}

export interface BracketedPasteResult {
  state: BracketedPasteState;
  completed?: string;
}

export interface RawBracketedPasteRoutingState {
  isPaste: boolean;
  pasteBuffer: string;
}

export interface RawBracketedPasteRoutingResult {
  state: RawBracketedPasteRoutingState;
  pasteContent?: string;
  keypressText?: string;
}

export interface SubmittedPasteExpansionResult {
  input: string;
  expandedPlaceholderCount: number;
  expandedCharCount: number;
  unresolvedMarkers: string[];
}

export function normalizeTerminalPasteContent(content: string): string {
  return content
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n');
}

export function resolveQuickTabTarget(tabOrder: string[], digit: number): string | null {
  if (digit === 0) {
    return 'main';
  }
  return digit < tabOrder.length ? tabOrder[digit] : null;
}

export const LOCALIZED_AWAITING_INPUT_STATUSES = new Set([
  '等待输入...',
  '等待输入…',
  'Awaiting input...',
  'Awaiting input…',
]);

export function normalizeLocalizedAwaitingInputStatus(status: string): string {
  return LOCALIZED_AWAITING_INPUT_STATUSES.has(status.trim())
    ? t('tui.leader.awaiting_input')
    : status;
}

export function buildIntervenePrefill(agentName: string): string {
  return `/intervene @${agentName} `;
}

export function describeInputTarget(currentTab: string): {
  targetLabel: string;
  routeText: string;
  placeholder: string;
} {
  if (currentTab === 'plan') {
    return {
      targetLabel: t('tui.input.target.plan'),
      routeText: t('tui.input.route.plan'),
      placeholder: t('tui.input.placeholder.plan'),
    };
  }

  if (currentTab === 'main') {
    return {
      targetLabel: t('tui.input.target.leader'),
      routeText: t('tui.input.route.leader'),
      placeholder: t('tui.input.placeholder.leader'),
    };
  }

  return {
    targetLabel: `@${currentTab}`,
    routeText: t('tui.input.route.agent', currentTab),
    placeholder: t('tui.input.placeholder.agent', currentTab),
  };
}

export function resolveModeForTabSwitch(
  targetTab: string,
  currentMode: 'chat' | 'plan' | 'agent',
): 'chat' | 'plan' | 'agent' {
  if (targetTab === 'plan') {
    return 'plan';
  }
  if (targetTab === 'main') {
    return currentMode === 'plan' ? 'plan' : 'chat';
  }
  return 'agent';
}

export function toggleUserControlMode(currentMode: 'manual' | 'eternal'): 'manual' | 'eternal' {
  return currentMode === 'manual' ? 'eternal' : 'manual';
}

export function buildAgentSpawnTree(agents: Array<{ name: string; role?: string; taskId?: string }>): string {
  if (agents.length === 0) return '';
  const lines: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const isLast = i === agents.length - 1;
    const prefix = isLast ? '└─' : '├─';
    const subPrefix = isLast ? '   ' : '│  ';
    const desc = [a.role, a.taskId ? t('tui.agent.spawn_task_desc', a.taskId) : ''].filter(Boolean).join(' · ') || '';
    lines.push(`   ${prefix} @${a.name}`);
    if (desc) {
      lines.push(`   ${subPrefix} ⎿ ${desc}`);
    }
  }
  return lines.join('\n');
}

export function parseInterveneCommand(input: string): { agentName: string; message: string } | null {
  const match = input.trim().match(/^\/intervene\s+@([^\s]+)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }
  return {
    agentName: match[1],
    message: match[2].trim(),
  };
}

export function shouldInterruptOnEscape(options: {
  currentTab: string;
  inputBuffer: string;
  sessionId?: string;
  sessionStatus?: string;
  channelStatus?: string;
}): boolean {
  const { currentTab, inputBuffer, sessionId, sessionStatus, channelStatus } = options;
  if (currentTab !== 'main' || inputBuffer.length > 0) {
    return false;
  }
  if (!sessionId || sessionId === '未创建' || sessionStatus !== 'active') {
    return false;
  }
  const status = (channelStatus || '').toLowerCase();
  if (!status) {
    return false;
  }
  return !isInactiveStatus(status);
}

function wrapLine(text: string, width: number): string[] {
  if (text.length === 0) {
    return [''];
  }
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let rest = text;
  while (stringWidth(rest) > safeWidth) {
    const { sliced } = sliceByWidth(rest, safeWidth);
    if (sliced.length === 0) {
      // Single character wider than width — take it to avoid infinite loop
      const ch = [...rest][0];
      lines.push(ch);
      rest = rest.slice(ch.length);
    } else {
      lines.push(sliced);
      rest = rest.slice(sliced.length);
    }
  }
  lines.push(rest);
  return lines;
}

export function buildPermissionPreviewHint(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (['apply_patch', 'file_write', 'writefile'].includes(normalized)) {
    return t('tui.permission.hint.file');
  }
  if (['bash', 'shell'].includes(normalized)) {
    return t('tui.permission.hint.shell');
  }
  return t('tui.permission.hint.generic');
}

export interface PermissionPreviewPanelLine {
  label: string;
  value?: string;
  kind?: 'section' | 'item';
}

export interface PermissionPreviewPanel {
  title: string;
  lines: PermissionPreviewPanelLine[];
  footer?: string;
}

export interface ToolMessageLike {
  type: string;
  content: string;
  toolName?: string;
  toolKind?: 'call' | 'result';
  toolSummary?: string;
  toolMeta?: string;
}

function formatToolPreviewLine(message: ToolMessageLike, maxWidth: number): string {
  const summary = message.toolSummary || '';
  const meta = message.toolMeta || '';
  const combined = [summary, meta].filter(Boolean).join(' · ') || message.content || '';
  return truncateDisplayText(combined, maxWidth);
}

function buildPermissionChecklist(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (['file_write', 'writefile', 'edit_file', 'apply_patch'].includes(normalized)) {
    return t('tui.permission.check.file');
  }
  if (['bash', 'shell'].includes(normalized)) {
    return t('tui.permission.check.shell');
  }
  if (['web_fetch', 'websearch', 'search_web', 'http_request'].includes(normalized)) {
    return t('tui.permission.check.network');
  }
  return t('tui.permission.check.generic');
}

function buildPermissionRisk(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (['file_write', 'writefile', 'edit_file', 'apply_patch'].includes(normalized)) {
    return t('tui.permission.risk.file');
  }
  if (['bash', 'shell'].includes(normalized)) {
    return t('tui.permission.risk.shell');
  }
  if (['file_read', 'read_file', 'read'].includes(normalized)) {
    return t('tui.permission.risk.read');
  }
  if (['file_search', 'search', 'rg'].includes(normalized)) {
    return t('tui.permission.risk.search');
  }
  if (['web_fetch', 'websearch', 'search_web', 'http_request'].includes(normalized)) {
    return t('tui.permission.risk.network');
  }
  return t('tui.permission.risk.generic');
}

function buildPermissionPreviewSummary(options: {
  toolName: string;
  lastCall?: ToolMessageLike;
  lastResult?: ToolMessageLike;
  maxWidth: number;
}): string {
  const { lastCall, lastResult, maxWidth } = options;
  if (!lastCall && !lastResult) {
    return truncateDisplayText(t('tui.permission.summary.empty'), maxWidth);
  }
  const parts: string[] = [];
  if (lastCall) {
    parts.push(t('tui.permission.summary.call', formatToolPreviewLine(lastCall, maxWidth)));
  }
  if (lastResult) {
    parts.push(t('tui.permission.summary.result', formatToolPreviewLine(lastResult, maxWidth)));
  }
  return truncateDisplayText(parts.join(' · '), maxWidth);
}

export function buildPermissionPreviewPanel(options: {
  approval: {
    toolName: string;
    reason: string;
    source?: string;
    workerName?: string;
  };
  messages: ToolMessageLike[];
  maxWidth: number;
}): PermissionPreviewPanel {
  const { approval, messages, maxWidth } = options;
  const normalizedTool = approval.toolName.toLowerCase();
  let lastCall: ToolMessageLike | undefined;
  let lastResult: ToolMessageLike | undefined;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.type !== 'tool' || !msg.toolName) continue;
    if (msg.toolName.toLowerCase() !== normalizedTool) continue;
    if (msg.toolKind === 'call' && !lastCall) lastCall = msg;
    if (msg.toolKind === 'result' && !lastResult) lastResult = msg;
    if (lastCall && lastResult) break;
  }

  const lines: PermissionPreviewPanelLine[] = [
    { label: t('tui.permission.section.overview'), kind: 'section' },
    {
      label: t('tui.permission.label.source'),
      value: truncateDisplayText(
        `${approval.source || 'unknown'}${approval.workerName ? ` @${approval.workerName}` : ''}`,
        maxWidth,
      ),
      kind: 'item',
    },
    { label: t('tui.permission.label.tool'), value: truncateDisplayText(approval.toolName, maxWidth), kind: 'item' },
    { label: t('tui.permission.label.reason'), value: truncateDisplayText(approval.reason, maxWidth), kind: 'item' },
    { label: t('tui.permission.section.risk'), kind: 'section' },
    { label: t('tui.permission.label.checklist'), value: truncateDisplayText(buildPermissionChecklist(approval.toolName), maxWidth), kind: 'item' },
    { label: t('tui.permission.label.risk'), value: truncateDisplayText(buildPermissionRisk(approval.toolName), maxWidth), kind: 'item' },
    { label: t('tui.permission.section.preview'), kind: 'section' },
  ];

  if (lastCall) {
    lines.push({ label: t('tui.permission.label.recent_call'), value: formatToolPreviewLine(lastCall, maxWidth), kind: 'item' });
  }
  if (lastResult) {
    lines.push({ label: t('tui.permission.label.recent_result'), value: formatToolPreviewLine(lastResult, maxWidth), kind: 'item' });
  }

  lines.push({
    label: t('tui.permission.label.latest_result'),
    value: buildPermissionPreviewSummary({
      toolName: approval.toolName,
      lastCall,
      lastResult,
      maxWidth,
    }),
    kind: 'item',
  });
  lines.push({ label: t('tui.permission.section.approval'), kind: 'section' });
  lines.push({
    label: t('tui.permission.label.action'),
    value: truncateDisplayText(t('tui.permission.action.approve_deny'), maxWidth),
    kind: 'item',
  });
  lines.push({ label: t('tui.permission.label.tip'), value: truncateDisplayText(buildPermissionPreviewHint(approval.toolName), maxWidth), kind: 'item' });

  return {
    title: t('tui.permission.panel_title'),
    lines,
    footer: t('tui.permission.panel_footer'),
  };
}

export function buildTabStripView(options: {
  items: TabStripInputItem[];
  maxWidth: number;
}): { items: TabStripViewItem[]; hiddenCount: number } {
  const { items, maxWidth } = options;
  if (items.length === 0 || maxWidth <= 0) {
    return { items: [], hiddenCount: 0 };
  }

  const reservedForOverflow = 10;
  const budget = Math.max(12, maxWidth);
  const result: TabStripViewItem[] = [];
  let used = 0;
  let hiddenCount = 0;

  for (const item of items) {
    const label = item.active ? item.activeLabel : item.inactiveLabel;
    const withGap = result.length > 0 ? `  ${label}` : label;
    const remaining = budget - used;
    const needsOverflowSpace = items.length - result.length - 1 > 0;
    const effectiveRemaining = needsOverflowSpace ? Math.max(0, remaining - reservedForOverflow) : remaining;

    if (stringWidth(withGap) <= effectiveRemaining || (item.active && result.length === 0)) {
      result.push({
        key: item.key,
        text: result.length > 0 ? `  ${label}` : label,
        active: item.active,
      });
      used += stringWidth(withGap);
      continue;
    }

    if (item.active) {
      const truncated = truncateDisplayText(label, Math.max(8, effectiveRemaining - (result.length > 0 ? 2 : 0)));
      result.push({
        key: item.key,
        text: result.length > 0 ? `  ${truncated}` : truncated,
        active: true,
      });
      used = budget;
    } else {
      hiddenCount += 1;
    }
  }

  const omitted = items.length - result.length - hiddenCount;
  if (omitted > 0) {
    hiddenCount += omitted;
  }

  return { items: result, hiddenCount };
}

export function buildShortcutHintText(options: {
  maxWidth: number;
}): string {
  const { maxWidth } = options;
  if (maxWidth < 80) {
    return t('tui.shortcut.compact');
  }
  if (maxWidth < 120) {
    return t('tui.shortcut.medium');
  }
  return t('tui.shortcut.full');
}

export interface LeaderStatusSurfaceOptions {
  /** Structured status from leader:status. */
  statusKind?: NormalizedLeaderStatusKind;
  /** Explicit surface decision from producer payloads. */
  surface?: boolean;
}

export function shouldSurfaceLeaderStatus(
  status: string,
  lastLoggedStatus = '',
  options: LeaderStatusSurfaceOptions = {},
): boolean {
  if (!status || status === lastLoggedStatus) {
    return false;
  }
  if (options.statusKind === 'idle' || options.statusKind === 'waiting') {
    return false;
  }
  return options.surface === true;
}

export function shouldPreferImmediateStreamFlush(channel: string, currentTab: string): boolean {
  if (!channel) return false;
  return channel === 'main' || channel === currentTab;
}

export function selectStreamFlushDelay(options: {
  channel: string;
  currentTab: string;
  foregroundMs: number;
  backgroundMs: number;
}): number {
  const { channel, currentTab, foregroundMs, backgroundMs } = options;
  return shouldPreferImmediateStreamFlush(channel, currentTab) ? foregroundMs : backgroundMs;
}

const LEADER_HEARTBEAT_PHASE_TEXT_MAP: Record<string, string> = {
  model_requesting: 'tui.leader.heartbeat.waiting_model',
  context_managing: 'tui.leader.heartbeat.organizing_context',
  context_managing_start: 'tui.leader.heartbeat.organizing_context',
  planning: 'tui.leader.heartbeat.planning_next',
  thinking: 'tui.leader.heartbeat.planning_next',
  preparing: 'tui.leader.heartbeat.planning_next',
  autonomous_recovery: 'tui.leader.heartbeat.autonomous_recovery',
  autonomous_orchestration: 'tui.leader.heartbeat.autonomous_orchestration',
};

export interface LeaderStatusActiveOptions {
  /** Structured status from leader runtime state. */
  statusKind?: NormalizedLeaderStatusKind;
}

export interface LeaderHeartbeatFormatOptions extends LeaderStatusActiveOptions {
  /** Structured phase from leader:phase_change events. */
  phase?: string;
  /** 工具执行状态（由 TUI 工具执行跟踪注入） */
  toolExecuting?: {
    toolName: string;
    startedAt: number;
  };
}

export function shouldEmitLeaderHeartbeat(options: {
  status: string;
  statusKind?: NormalizedLeaderStatusKind;
  hasVisibleStream: boolean;
  lastVisibleActivityAt: number;
  lastHeartbeatAt: number;
  now: number;
}): boolean {
  const { status, hasVisibleStream, lastVisibleActivityAt, lastHeartbeatAt, now } = options;
  if (hasVisibleStream) {
    return false;
  }

  if (!isLeaderStatusActive(status, { statusKind: options.statusKind })) {
    return false;
  }

  return (now - lastVisibleActivityAt) >= 5000 && (now - lastHeartbeatAt) >= 8000;
}

/** 判断 leader 当前是否处于活跃阶段；只信任结构化 statusKind。 */
export function isLeaderStatusActive(status: string, options: LeaderStatusActiveOptions = {}): boolean {
  void status;
  return options.statusKind === 'active';
}

export function formatLeaderHeartbeat(
  status: string,
  elapsedMs: number,
  options: LeaderHeartbeatFormatOptions = {},
): string {
  const seconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const cancelHint = seconds >= 15 ? t('tui.leader.heartbeat.cancel_hint') : '';

  // 工具执行中：显示「仍在执行 {toolName}（{elapsed}s）」
  if (options.toolExecuting?.toolName && options.toolExecuting?.startedAt) {
    const toolElapsed = Math.max(1, Math.floor((Date.now() - options.toolExecuting.startedAt) / 1000));
    return `${t('tui.leader.heartbeat.tool_executing', options.toolExecuting.toolName, toolElapsed)}${cancelHint}`;
  }

  const phase = options.phase?.trim();
  const phaseKey = phase ? LEADER_HEARTBEAT_PHASE_TEXT_MAP[phase] : undefined;
  if (phaseKey) {
    return `${t(phaseKey)}${cancelHint}`;
  }

  if (options.statusKind && options.statusKind !== 'active') {
    return `${t('tui.leader.heartbeat.working')}${cancelHint}`;
  }

  void status;
  return `${t('tui.leader.heartbeat.working')}${cancelHint}`;
}

// 分层视觉间距:决定相邻两条逻辑消息之间插入何种分隔行。
//   divider → system 空行,渲染 `─ · ─` 回合强分隔(user ↔ AI)
//   spacer  → 纯空行,轻量呼吸(正文 ↔ 思考/工具、正文 ↔ 错误/成功)
//   null    → 紧凑无间距(连续同类:tool 序列、正文段落)
// 纯结构化判定(基于消息 type 集合),无阈值/启发式。
const CONTENT_VIEW_TYPES = new Set<string>(['user', 'leader', 'agent', 'code', 'table']);
const META_VIEW_TYPES = new Set<string>(['thinking', 'tool']);
const ALERT_VIEW_TYPES = new Set<string>(['error', 'success']);

function separatorBetween(prev: string, curr: string): 'divider' | 'spacer' | null {
  if (prev === 'system' || curr === 'system') return null;        // system 是轻量状态/通知伴随,不参与间距
  if (prev === curr) return null;                                  // 同类消息紧凑(连续 tool 序列、连续正文段)
  const prevContent = CONTENT_VIEW_TYPES.has(prev);
  const currContent = CONTENT_VIEW_TYPES.has(curr);
  if (prevContent && currContent) return 'divider';               // 正文 ↔ 正文 → 回合强分隔
  const prevMeta = META_VIEW_TYPES.has(prev);
  const currMeta = META_VIEW_TYPES.has(curr);
  const prevAlert = ALERT_VIEW_TYPES.has(prev);
  const currAlert = ALERT_VIEW_TYPES.has(curr);
  if ((prevMeta && currMeta) || (prevAlert && currAlert)) return null;  // meta↔meta / alert↔alert 紧凑
  return 'spacer';                                                 // 其余跨界(content↔meta、*↔alert)→ 轻呼吸
}

// 列表项识别(ul `-`/`*`/`+`、ol `数字.`),marker 美化为 unicode 符号(非 emoji)。
const UL_ITEM_REGEX = /^(\s*)([-*+])\s+(.*)$/;
const OL_ITEM_REGEX = /^(\s*)(\d+)\.\s+(.*)$/;
const LEADING_SPACE_REGEX = /^(\s*)/;

interface ClassifiedLine {
  kind: 'plain' | 'ul' | 'ol';
  text: string;
  marker?: string;
  indent?: number;
  ordered?: boolean;
}

function classifyContentLine(rawLine: string): ClassifiedLine {
  const ul = rawLine.match(UL_ITEM_REGEX);
  if (ul) {
    const indent = ul[1].length;
    return {
      kind: 'ul',
      indent,
      marker: indent >= 2 ? tuiGlyphs.ulBulletNested : tuiGlyphs.ulBullet,
      text: ul[3],
      ordered: false,
    };
  }
  const ol = rawLine.match(OL_ITEM_REGEX);
  if (ol) {
    return { kind: 'ol', indent: ol[1].length, marker: `${ol[2]}.`, text: ol[3], ordered: true };
  }
  return { kind: 'plain', text: rawLine };
}

export function buildMessageLogView(options: {
  messages: LogMessageLike[];
  currentStream?: string;
  currentThinkingStream?: string;
  scrollOffset?: number;
  showThinking?: boolean;
  streamType?: 'leader' | 'agent';
  width: number;
  maxLines: number;
  expandThinking?: boolean;
  expandTools?: boolean;
  /** 已展开的卡片 key 集合(thinking/tool 卡);未含于此 = 折叠态 */
  expandedCards?: Set<string>;
}): {
  visibleLines: RenderedLogLine[];
  hiddenAbove: number;
  hasBelow: boolean;
  hiddenBelow: number;
  totalLines: number;
  truncatedMessages: number;
  codeBlocks: CodeBlockMeta[];
} {
  const {
    messages,
    currentStream,
    currentThinkingStream,
    scrollOffset = 0,
    showThinking = true,
    streamType = 'leader',
    width,
    maxLines,
    expandThinking = false,
    expandTools = false,
    expandedCards,
  } = options;

  // 卡片是否展开:缺省 expandedCards 时沿用旧的 expand* 总开关(向后兼容)。
  const isCardExpanded = (key: string): boolean =>
    expandedCards ? expandedCards.has(key) : false;

  // Build messages array with inline thinking
  // 每条消息附带稳定 cardKey(基于其在原 messages 数组的索引;流式消息用固定 key),
  // 供 thinking/tool 卡的逐卡折叠态索引——历史消息只追加、不重排,故索引稳定。
  const allMessages: Array<{ msg: LogMessageLike; cardKey: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (showThinking || message.type !== 'thinking') {
      allMessages.push({ msg: message, cardKey: `msg-${i}` });
    }
  }

  // Add streaming content inline
  // Thinking stream renders as inline message (same as text, just different color)
  if (showThinking && currentThinkingStream) {
    allMessages.push({ msg: { type: 'thinking', content: currentThinkingStream }, cardKey: 'think-stream' });
  }
  // Text stream renders as normal message
  if (currentStream) {
    allMessages.push({ msg: { type: streamType, content: currentStream }, cardKey: `stream-${streamType}` });
  }

  // ── 渲染窗口虚拟化:只把最近一部分消息送入渲染 ──
  // 内存层最多保留 4500 条,若全部渲染,流式时每个 token chunk 触发的 useMemo 重算会
  // 全量 wrap/拆代码块/识别列表 → 卡死。此处从末尾(最新,含流式虚拟消息)向前累积,
  // 条数/字符量任一触顶即停;cardKey 仍绑原 messages 索引 → expandedCards 折叠态稳定。
  let truncatedMessages = 0;
  let renderStart = 0;
  {
    let accChars = 0;
    let accCount = 0;
    for (let wi = allMessages.length - 1; wi >= 0; wi--) {
      const m = allMessages[wi].msg;
      // 单条贡献封顶:防一条超长消息独自撑满整个字符预算。
      const contribution = Math.min(
        PER_MESSAGE_CHAR_CAP,
        (m.content?.length ?? 0) + (m.toolDiff?.length ?? 0) * 40,
      );
      if (accCount >= MAX_RENDER_MESSAGES || (accCount > 0 && accChars + contribution > MAX_RENDER_CHARS)) {
        break;
      }
      accChars += contribution;
      accCount += 1;
      renderStart = wi;
    }
    truncatedMessages = renderStart;
  }
  const renderMessages = allMessages.slice(renderStart);

  // Message prefixes are rendered by MessageLog for richer visual hierarchy.
  const roleLabel: Record<LogMessageLike['type'], string> = {
    system: '',
    leader: '',
    user: '',
    agent: '',
    thinking: '',
    tool: '',
    code: '',
    table: '',
    error: '',
    success: '',
  };
  const roleIndent: Record<LogMessageLike['type'], string> = {
    system: '',
    leader: '',
    user: '',
    agent: '',
    thinking: '',
    tool: '',
    code: '',
    table: '',
    error: '',
    success: '',
  };

  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  // Detect file_read output: lines starting with "     1→" or "   123→" pattern
  const lineNumberRegex = /^\s*\d+→/;

  const rendered: RenderedLogLine[] = [];
  const viewportWidth = Math.max(1, Math.floor(width));
  const pushVisualLine = (line: RenderedLogLine) => {
    const sourceLines = line.text.split('\n');
    sourceLines.forEach((sourceLine, sourceIndex) => {
      const wrappedLines = wrapLine(sourceLine, viewportWidth);
      wrappedLines.forEach((wrappedLine, wrappedIndex) => {
        const isWrapContinuation = sourceIndex > 0 || wrappedIndex > 0;
        rendered.push({
          ...line,
          text: wrappedLine,
          isContinuation: Boolean(line.isContinuation || isWrapContinuation),
          // 列表项的 wrap/软换行续行:保留 listMarker(供宽度对齐),标记 listContinuation,
          // 渲染层据此用空格占位 marker、正文对齐首行正文位置。
          listContinuation: isWrapContinuation && line.listMarker != null ? true : line.listContinuation,
        });
      });
    });
  };
  // 把一段纯文本(可能含 markdown 列表项)按行拍平进 rendered。
  // 复用于"无代码块"与"有代码块的 text part"两个分支,统一列表识别 + 软换行续行处理。
  // startAsFirst = 本段首行是否同时也是消息首行;返回本段结束后是否仍是首行(供 code 块穿插衔接)。
  const pushTextLines = (
    content: string,
    type: LogMessageLike['type'],
    firstLinePrefix: string,
    continuationPrefix: string,
    startAsFirst: boolean,
  ): boolean => {
    let isFirstLine = startAsFirst;
    // 当前列表项上下文(用于识别其后的缩进软换行续行)
    let activeListMarker: string | null = null;
    let activeListIndent = 0;
    let activeListOrdered = false;

    // 行级扫描器(替代 forEach):表格/块级公式可能一次消费多行,需要按索引跳行。
    // 顺序:块级公式 $$ → pipe 表格 → 普通行(含行内 $ 公式替换 + 列表识别)。
    const rawLines = content.split('\n');
    let lineIdx = 0;
    while (lineIdx < rawLines.length) {
      const rawLine = rawLines[lineIdx]!;

      // (A) 块级公式 $$...$$:行首 $$ 且能配对闭合 → 整体转 Unicode,每行一个 math 行
      //     (type 复用 'table' 享受 divider 分隔,mathLine 标志区分渲染)。未闭合落普通行。
      if (rawLine.trimStart().startsWith('$$')) {
        const dm = extractDisplayMath(rawLines, lineIdx);
        if (dm.closed) {
          for (const uLine of latexToUnicode(dm.block).split('\n')) {
            rendered.push({
              type: 'table',
              mathLine: true,
              text: uLine,
              tablePlainLine: uLine,
              isContinuation: !isFirstLine,
            });
          }
          isFirstLine = false;
          activeListMarker = null; // 块级公式打断列表上下文
          lineIdx += dm.consumed;
          continue;
        }
      }

      // (B) pipe 表格:行含 | 且下一行是分隔行 → 整体渲染成多行 table 行(直接 push 绕过折行)
      if (rawLine.includes('|') && rawLine.trim() !== '') {
        const parsed = parsePipeTable(rawLines, lineIdx);
        if (parsed) {
          const { ansiLines, plainLines } = renderTableToLines(
            parsed.headers, parsed.rows, parsed.aligns, viewportWidth,
          );
          ansiLines.forEach((ansi, idx) => {
            rendered.push({
              type: 'table',
              text: ansi,
              tablePlainLine: plainLines[idx],
              isContinuation: !isFirstLine,
            });
          });
          isFirstLine = false;
          activeListMarker = null;
          lineIdx += parsed.consumed;
          continue;
        }
      }

      // (C) 普通行:先做行内 $...$ 公式替换,再列表识别 + 软换行续行处理
      const mathedLine = replaceInlineMath(rawLine);
      const classified = classifyContentLine(mathedLine);
      if (classified.kind === 'plain') {
        const leading = (mathedLine.match(LEADING_SPACE_REGEX)?.[1] ?? '').length;
        // 仍在列表项内、且为更深缩进的非空行 → 列表项软换行续行
        if (activeListMarker != null && mathedLine.trim() !== '' && leading > activeListIndent) {
          pushVisualLine({
            type,
            text: mathedLine.trimStart(),
            isContinuation: !isFirstLine,
            listMarker: activeListMarker,
            listIndent: activeListIndent,
            listOrdered: activeListOrdered,
            listContinuation: true,
          });
        } else {
          // 普通 plain 行;空行或缩进回退到列表层级之外 → 退出列表上下文
          if (mathedLine.trim() === '' || leading <= activeListIndent) {
            activeListMarker = null;
          }
          const prefix = isFirstLine ? firstLinePrefix : continuationPrefix;
          pushVisualLine({ type, text: prefix + classified.text, isContinuation: !isFirstLine });
        }
      } else {
        // 列表项:更新上下文,marker/缩进/有序走字段,正文不含 marker
        activeListMarker = classified.marker ?? null;
        activeListIndent = classified.indent ?? 0;
        activeListOrdered = !!classified.ordered;
        pushVisualLine({
          type,
          text: classified.text,
          isContinuation: !isFirstLine,
          listMarker: classified.marker,
          listIndent: classified.indent,
          listOrdered: classified.ordered,
        });
      }
      isFirstLine = false;
      lineIdx++;
    }
    return isFirstLine;
  };
  let nextCodeBlockIndex = 0;
  let prevType: string | null = null;
  const lastToolCallTimestamps = new Map<string, number>();

  const isMetaType = (type: LogMessageLike['type']) => type === 'system' || type === 'thinking' || type === 'tool';

  for (const { msg: message, cardKey } of renderMessages) {
    // 分层视觉间距:相邻不同类消息之间按 separatorBetween 决定插入分隔行。
    //   divider → system 空行(渲染 `─ · ─` 回合强分隔,如 user ↔ AI)
    //   spacer  → 纯空行(轻量呼吸,如正文 ↔ 思考/工具、正文 ↔ 错误/成功)
    //   null    → 紧凑无间距(连续同类:tool 序列、正文段落)
    if (prevType !== null) {
      const sep = separatorBetween(prevType, message.type);
      if (sep === 'divider') {
        pushVisualLine({ type: 'system', text: '' });
      } else if (sep === 'spacer') {
        // 单行空文本占位:直接 push 绕过 pushVisualLine(无需 wrap,也不走 roleLabel/roleIndent 路径)。
        rendered.push({ type: 'spacer', text: '', isContinuation: false });
      }
    }
    prevType = message.type;

    const label = roleLabel[message.type] || '  ';
    const indent = roleIndent[message.type] || '  ';
    let isFirstLine = true;

    const cbMatches = [...message.content.matchAll(codeBlockRegex)];

    // ─── Tool messages — render as compact summary cards ─────────────
    if (message.type === 'tool') {
      const toolName = message.toolName || 'tool';
      const isResult = message.toolKind === 'result';
      const toolKind = isResult ? 'result' : 'call';
      const toolSummary = message.toolSummary ?? (isResult ? t('tui.modal.tool_result') : t('tui.modal.tool_calling', toolName));
      const toolMeta = message.toolMeta ?? '';
      const toolDiff = message.toolDiff;
      const toolAdded = toolDiff ? toolDiff.filter((l) => l.kind === 'add').length : 0;
      const toolRemoved = toolDiff ? toolDiff.filter((l) => l.kind === 'del').length : 0;
      const toolCardKey = `card-tool-${cardKey}`;
      const toolExpanded = isCardExpanded(toolCardKey);

      const toolDuration = isResult
        ? Math.max(0, (message.timestamp || 0) - (lastToolCallTimestamps.get(toolName) || (message.timestamp || 0)))
        : 0;
      if (!isResult && message.timestamp) {
        lastToolCallTimestamps.set(toolName, message.timestamp);
      }

      // 头行:可点击折叠/展开。折叠态仅此一行;展开态其下追加摘要 + diff。
      rendered.push({
        type: 'tool',
        text: '',
        toolName,
        toolKind,
        toolSummary,
        toolMeta,
        toolStatus: isResult ? 'done' : 'running',
        toolDuration,
        toolStartedAt: message.toolStartedAt,
        toolInput: '',
        toolOutput: '',
        toolAdded,
        toolRemoved,
        cardKey: toolCardKey,
        cardCollapsed: !toolExpanded,
        isContinuation: false,
      });

      if (toolExpanded) {
        if (toolSummary && toolSummary !== toolName) {
          rendered.push({ type: 'tool', text: toolSummary, isContinuation: true });
        }
        if (toolDiff && toolDiff.length > 0) {
          for (const dline of toolDiff) {
            rendered.push({ type: 'tool', text: dline.text, toolDiffKind: dline.kind, isContinuation: true });
          }
        }
      }
      isFirstLine = false;
    } else if (message.type === 'thinking') {
      const thinkCardKey = `card-thinking-${cardKey}`;
      const thinkExpanded = isCardExpanded(thinkCardKey);
      const thinkCount = message.content.replace(/\s+/g, '').length;
      // 头行(可点击):▸ 折叠 / ▾ 展开 + 字数摘要
      pushVisualLine({
        type: 'thinking',
        text: t('tui.message.thinking_summary', thinkCount),
        cardKey: thinkCardKey,
        cardCollapsed: !thinkExpanded,
        isContinuation: false,
      });
      if (thinkExpanded) {
        // 展开态:全量内容,沿用既有 thinking 渲染通路
        pushVisualLine({
          type: 'thinking',
          text: message.content,
          isContinuation: false,
        });
      }
      isFirstLine = false;
    } else if (!message.content.includes('```')) {
      // 无任何代码围栏 → 纯文本(含列表)
      isFirstLine = pushTextLines(message.content, message.type, label, indent, isFirstLine);
    } else {
      const parts: { type: 'text' | 'code'; content: string; lang: string; idx: number; openEnded?: boolean }[] = [];
      let lastIndex = 0;
      for (const m of cbMatches) {
        const before = message.content.slice(lastIndex, m.index);
        if (before) parts.push({ type: 'text', content: before, lang: '', idx: -1 });
        parts.push({ type: 'code', content: m[2].trim(), lang: m[1] || 'text', idx: nextCodeBlockIndex++ });
        lastIndex = m.index! + m[0].length;
      }
      const after = message.content.slice(lastIndex);
      if (after) {
        // 检测未闭合的代码围栏:流式中 ``` 开头但尚无配对结尾。
        const fenceStart = after.indexOf('```');
        if (fenceStart >= 0) {
          const beforeFence = after.slice(0, fenceStart);
          if (beforeFence) parts.push({ type: 'text', content: beforeFence, lang: '', idx: -1 });
          const fenceSection = after.slice(fenceStart);
          const langMatch = fenceSection.match(/^```(\w*)[ \t]*\n?([\s\S]*)$/);
          parts.push({
            type: 'code',
            content: (langMatch?.[2] ?? '').replace(/\n$/, ''),
            lang: langMatch?.[1] || 'text',
            idx: nextCodeBlockIndex++,
            openEnded: true,
          });
        } else {
          parts.push({ type: 'text', content: after, lang: '', idx: -1 });
        }
      }

      for (const part of parts) {
        if (part.type === 'code') {
          pushVisualLine({
            type: 'code',
            text: `\`\`\`${part.lang}`,
            codeContent: part.content,
            codeLang: part.lang,
            codeBlockIndex: part.idx,
            codeOpenEnded: part.openEnded,
            isContinuation: false,
          });
          for (const rawCodeLine of part.content.split('\n')) {
            pushVisualLine({
              type: 'code',
              text: rawCodeLine,
              codeContent: part.content,
              codeLang: part.lang,
              codeBlockIndex: part.idx,
              codeOpenEnded: part.openEnded,
              isContinuation: true,
            });
          }
          pushVisualLine({
            type: 'code',
            text: '```',
            codeContent: part.content,
            codeLang: part.lang,
            codeBlockIndex: part.idx,
            codeOpenEnded: part.openEnded,
            isContinuation: true,
          });
          isFirstLine = false;
        } else {
          isFirstLine = pushTextLines(part.content, message.type, label, indent, isFirstLine);
        }
      }
    }
  }

  const totalLineCount = rendered.length;
  const maxScrollOffset = Math.max(0, totalLineCount - maxLines);
  const effectiveScrollOffset = Math.min(Math.max(0, scrollOffset), maxScrollOffset);
  const visibleEnd = Math.max(0, rendered.length - effectiveScrollOffset);
  const visibleStart = Math.max(0, visibleEnd - maxLines);
  const visibleLines = rendered.slice(visibleStart, visibleEnd);

  // Build viewport-relative code block positions
  const codeBlocks: CodeBlockMeta[] = [];
  const seenCodeBlocks = new Set<number>();
  for (let i = visibleStart; i < visibleEnd; i++) {
    const r = rendered[i];
    if (r.type === 'code' && r.codeContent != null && r.codeBlockIndex != null && !seenCodeBlocks.has(r.codeBlockIndex)) {
      seenCodeBlocks.add(r.codeBlockIndex);
      codeBlocks.push({
        index: r.codeBlockIndex!,
        visibleRow: i - visibleStart,
        content: r.codeContent,
        lang: r.codeLang!,
        preview: r.codeContent.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 72) || t('tui.code.empty'),
        lineCount: r.codeContent.split('\n').length,
      });
    }
  }

  return {
    visibleLines,
    hiddenAbove: visibleStart,
    hasBelow: effectiveScrollOffset > 0,
    hiddenBelow: effectiveScrollOffset,
    totalLines: totalLineCount,
    truncatedMessages,
    codeBlocks,
  };
}

export function normalizePastedText(pastedContent: string, previewLimit = 100): {
  cleaned: string;
  lineCount: number;
  previewBuffer: string;
  isMultiline: boolean;
} {
  const normalizedNewlines = normalizeTerminalPasteContent(pastedContent);
  const newlineMatches = normalizedNewlines.match(/\n/g);
  const newlineCount = newlineMatches ? newlineMatches.length : 0;
  const hasContent = normalizedNewlines.length > 0;
  const endsWithNewline = normalizedNewlines.endsWith('\n');
  const lineCount = hasContent ? newlineCount + (endsWithNewline ? 0 : 1) : 0;
  const cleaned = normalizedNewlines.split(/\s+/).filter(Boolean).join(' ');
  const isMultiline = lineCount > 1;
  const previewBuffer = isMultiline
    ? `[Pasted text +${lineCount} lines] ${cleaned.slice(0, previewLimit)}`
    : cleaned;
  return { cleaned, lineCount, previewBuffer, isMultiline };
}

function fitCell(text: string, width: number): string {
  if (width <= 1) return sliceByWidth(text, width).sliced;
  const tw = stringWidth(text);
  if (tw > width) {
    const { sliced } = sliceByWidth(text, width - 1);
    return `${sliced}…`;
  }
  // Pad with spaces to fill remaining display columns
  return text + ' '.repeat(Math.max(0, width - tw));
}

interface ModalTableDataPayload { header?: string; rows: ModalTableRow[]; items: ModalTableItem[] }

const buildTaskModalPayload = (tasks: ModalSourceTask[]): ModalTableDataPayload => {
  const header = `${fitCell(t('tui.modal.task.header.id'), 7)} ${fitCell(t('tui.modal.task.header.status'), 11)} ${fitCell(t('tui.modal.task.header.type'), 10)} ${fitCell(t('tui.modal.task.header.agent'), 12)} ${t('tui.modal.task.header.subject')}`;
  const rows: ModalTableRow[] = [];
  const items: ModalTableItem[] = [];
  for (const task of tasks) {
    const subjectPreview = truncateDisplayText(task.subject, 20);
    // TUI 弹窗展示任务状态时只读中心 displayState 语义，不直接解释 TaskBoard 内核 status。
    const normalizedStatus = normalizeTaskDisplayState(task);
    const statusLabel = normalizedStatus === 'dispatchable' ? 'pending' : normalizedStatus;
    const primary = `${fitCell(task.id, 7)} ${fitCell(statusLabel, 11)} ${fitCell(task.agent_type || '-', 10)} ${fitCell(task.assigned_agent ? `@${task.assigned_agent}` : '-', 12)} ${subjectPreview}`;
    const secondaryParts = [
      `${t('tui.modal.task.field.status')}: ${statusLabel}`,
      task.agent_type ? `${t('tui.modal.task.field.type')}: ${task.agent_type}` : undefined,
      task.assigned_agent ? `${t('tui.modal.task.field.agent')}: @${task.assigned_agent}` : undefined,
      task.blocked_by && task.blocked_by.length > 0 ? `${t('tui.modal.task.field.dependency')}: ${task.blocked_by.join(', ')}` : undefined,
      task.working_directory ? `${t('tui.modal.task.field.directory')}: ${task.working_directory}` : undefined,
    ].filter(Boolean);
    rows.push({
      primary,
      secondary: secondaryParts.length > 0 ? truncateDisplayText(secondaryParts.join(' · '), 96) : undefined,
    });
    items.push({
      title: truncateDisplayText(`${task.id} ${task.subject}`, 72),
      detail: truncateDisplayText([statusLabel, task.assigned_agent ? `@${task.assigned_agent}` : undefined].filter(Boolean).join(' · '), 84),
    });
  }
  return { header, rows, items };
};

const buildSessionModalPayload = (sessions: ModalSourceSession[]): ModalTableDataPayload => {
  const header = `${fitCell(t('tui.modal.session.header.session'), 12)} ${fitCell(t('tui.modal.session.header.status'), 12)} ${fitCell(t('tui.modal.session.header.time'), 12)} ${t('tui.modal.session.header.preview')}`;
  const rows: ModalTableRow[] = [];
  const items: ModalTableItem[] = [];
  for (const session of sessions) {
    const statusLabel = session.status || 'unknown';
    const timeStr = formatSessionTime(session.createdAt);
    const preview = truncateDisplayText(session.preview, 60);
    const primary = `${fitCell(session.id, 12)} ${fitCell(statusLabel, 12)} ${fitCell(timeStr, 12)} ${preview}`;
    rows.push({ primary, secondary: preview });
    items.push({ title: truncateDisplayText(session.id, 20), detail: truncateDisplayText(`[${statusLabel}] ${session.preview}`, 84) });
  }
  return { header, rows, items };
};

function formatSessionTime(createdAt?: number): string {
  if (!createdAt) return '';
  const ts = typeof createdAt === 'number' && createdAt > 1e12 ? createdAt : (createdAt * 1000);
  try {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {/* expected: use default */
    return '';
  }
}

const buildSkillModalPayload = (skills: ModalSourceSkill[]): ModalTableDataPayload => {
  const header = `${fitCell(t('tui.modal.skill.header.skill'), 18)} ${fitCell(t('tui.modal.skill.header.source'), 10)} ${t('tui.modal.skill.header.preview')}`;
  const rows: ModalTableRow[] = [];
  const items: ModalTableItem[] = [];
  for (const skill of skills) {
    const sourceLabel = skill.source ?? skill.status ?? '-';
    const preview = truncateDisplayText(skill.preview, 60);
    const primary = `${fitCell(`$${skill.id}`, 18)} ${fitCell(sourceLabel, 10)} ${preview}`;
    rows.push({ primary, secondary: preview });
    const statusLabel = skill.status ?? skill.source;
    items.push({ title: truncateDisplayText(`$${skill.id}`, 28), detail: truncateDisplayText(`${statusLabel ? `[${statusLabel}] ` : ''}${skill.preview}`, 84) });
  }
  return { header, rows, items };
};

const buildModalTablePayload = (options: ModalTableViewOptions): ModalTableDataPayload | null => {
  switch (options.modalType) {
    case 'dag': return buildTaskModalPayload(options.tasks || []);
    case 'skills': return buildSkillModalPayload(options.skills || []);
    case 'resume':
    case 'history': return buildSessionModalPayload(options.sessions || []);
    default: return null;
  }
};

export function buildModalTableView(options: ModalTableViewOptions): ModalTableView {
  const payload = buildModalTablePayload(options);
  if (!payload) return { header: undefined, rows: [], items: [] };
  return { header: payload.header, rows: payload.rows, items: payload.items };
}

export function buildModalItems(options: ModalTableViewOptions): ModalTableItem[] {
  return buildModalTableView(options).items || [];
}

export function consumeBracketedPasteChunk(state: BracketedPasteState, chunk: string): BracketedPasteResult {
  const startMarker = '\x1b[200~';
  const endMarker = '\x1b[201~';
  const tailLimit = Math.max(startMarker.length - 1, 0);
  const keepTail = (value: string) => {
    if (tailLimit === 0) return '';
    return value.length <= tailLimit ? value : value.slice(-tailLimit);
  };
  let working = `${state.buffer}${chunk}`;
  if (!state.active) {
    const startIndex = working.indexOf(startMarker);
    if (startIndex < 0) return { state: { active: false, buffer: keepTail(working) } };
    working = working.slice(startIndex + startMarker.length);
  }
  const endIndex = working.indexOf(endMarker);
  if (endIndex >= 0) {
    return { state: { active: false, buffer: keepTail(working.slice(endIndex + endMarker.length)) }, completed: working.slice(0, endIndex) };
  }
  return { state: { active: true, buffer: working } };
}

export function routeRawBracketedPasteChunk(
  state: RawBracketedPasteRoutingState,
  chunk: string,
): RawBracketedPasteRoutingResult {
  const startMarker = '\x1b[200~';
  const endMarker = '\x1b[201~';
  const startIdx = chunk.indexOf(startMarker);
  const endIdx = chunk.indexOf(endMarker);

  if (startIdx !== -1 && (endIdx === -1 || startIdx < endIdx)) {
    const afterStart = chunk.slice(startIdx + startMarker.length);
    const endInContent = afterStart.indexOf(endMarker);

    if (endInContent !== -1) {
      const remaining = afterStart.slice(endInContent + endMarker.length);
      return {
        state: { isPaste: false, pasteBuffer: '' },
        pasteContent: afterStart.slice(0, endInContent),
        keypressText: remaining || undefined,
      };
    }

    return {
      state: { isPaste: true, pasteBuffer: afterStart },
    };
  }

  if (endIdx !== -1) {
    if (state.isPaste) {
      const remaining = chunk.slice(endIdx + endMarker.length);
      return {
        state: { isPaste: false, pasteBuffer: '' },
        pasteContent: state.pasteBuffer + chunk.slice(0, endIdx),
        keypressText: remaining || undefined,
      };
    }

    const passthrough = `${chunk.slice(0, endIdx)}${chunk.slice(endIdx + endMarker.length)}`;
    return {
      state,
      keypressText: passthrough || undefined,
    };
  }

  if (state.isPaste) {
    return {
      state: {
        isPaste: true,
        pasteBuffer: state.pasteBuffer + chunk,
      },
    };
  }

  return {
    state,
    keypressText: chunk || undefined,
  };
}

export function expandSubmittedPasteInput(
  input: string,
  pendingPastes: Map<string, string>,
): SubmittedPasteExpansionResult {
  let expanded = input;
  let expandedPlaceholderCount = 0;
  let expandedCharCount = 0;

  for (const [placeholder, content] of pendingPastes) {
    const occurrences = expanded.split(placeholder).length - 1;
    if (occurrences <= 0) continue;
    expanded = expanded.split(placeholder).join(content);
    expandedPlaceholderCount += occurrences;
    expandedCharCount += content.length * occurrences;
  }

  expanded = normalizeTerminalPasteContent(expanded);

  return {
    input: expanded,
    expandedPlaceholderCount,
    expandedCharCount,
    unresolvedMarkers: [],
  };
}

export type ModalSelectionResult =
  | { action: 'show_task_detail'; content: string }
  | { action: 'resume_session'; sessionId: string }
  | { action: 'prefill_input'; tab: string; mode: 'agent'; inputBuffer: string }
  | { action: 'insert_text'; value: string }
  | { action: 'none' };

export function resolveModalSelection(options: {
  modalType: 'dag' | 'resume' | 'history' | 'skills';
  cursor: number;
  tasks?: ModalSourceTask[];
  agents?: ModalSourceAgent[];
  sessions?: ModalSourceSession[];
  skills?: Array<{ id: string }>;
}): ModalSelectionResult {
  const { modalType, cursor } = options;
  if (modalType === 'dag') {
    const tasks = options.tasks || [];
    const task = tasks[Math.min(cursor, Math.max(0, tasks.length - 1))];
    if (!task) return { action: 'none' };
    // DAG 详情和任务列表使用同一套 displayState，避免列表显示 pending、详情显示 blocked 的分裂。
    const normalizedStatus = normalizeTaskDisplayState(task);
    const statusLabel = normalizedStatus === 'dispatchable' ? 'pending' : normalizedStatus;
    return { action: 'show_task_detail', content: [
      t('tui.modal.task.detail_title', task.id), `${t('tui.modal.task.subject')}: ${task.subject}`, `${t('tui.modal.task.field.status')}: ${statusLabel}`,
      task.agent_type ? `${t('tui.modal.task.field.type')}: ${task.agent_type}` : '',
      task.assigned_agent ? `${t('tui.modal.task.field.agent')}: @${task.assigned_agent}` : '',
      task.blocked_by && task.blocked_by.length > 0 ? `${t('tui.modal.task.field.dependency')}: ${task.blocked_by.join(', ')}` : '',
      task.working_directory ? `${t('tui.modal.task.working_directory')}: ${task.working_directory}` : '',
      task.write_scope && task.write_scope.length > 0 ? `${t('tui.modal.task.write_scope')}: ${task.write_scope.join(', ')}` : '',
    ].filter(Boolean).join('\n') };
  }
  if (modalType === 'skills') {
    const skills = options.skills || [];
    const skill = skills[Math.min(cursor, Math.max(0, skills.length - 1))];
    if (!skill) return { action: 'none' };
    return { action: 'insert_text', value: `$${skill.id} ` };
  }
  const sessions = options.sessions || [];
  const session = sessions[Math.min(cursor, Math.max(0, sessions.length - 1))];
  if (!session) return { action: 'none' };
  return { action: 'resume_session', sessionId: session.id };
}

export function cycleSelectionIndex(current: number, length: number, direction: -1 | 1): number {
  if (length <= 0) return 0;
  return (current + direction + length) % length;
}

export function buildSuggestions(options: {
  value: string;
  commandMetadata: SuggestionItem[];
  agentCandidates: SuggestionItem[];
  skillCandidates: SuggestionItem[];
  commandArgCompleters?: Record<string, (partial: string) => SuggestionItem[]>;
}): { type: SuggestionType; items: SuggestionItem[] } {
  const { value, commandMetadata, agentCandidates, skillCandidates, commandArgCompleters } = options;

  // 斜杠命令参数补全：匹配 "/command " 模式（命令后有空格，正在输入参数）
  const argMatch = value.match(/^(\/[a-zA-Z0-9_-]+)\s+(.*)$/);
  if (argMatch && commandArgCompleters) {
    const cmdName = argMatch[1].toLowerCase();
    const partial = argMatch[2];
    const completer = commandArgCompleters[cmdName];
    if (completer) {
      const items = completer(partial);
      if (items.length > 0) return { type: 'command', items: items.slice(0, 8) };
    }
  }

  // 斜杠命令名补全 —— Claude 风格模糊搜索（匹配命令名 + 描述，含中文）
  const commandMatch = value.match(/(?:^|\s)(\/[^\s/]*)$/);
  if (commandMatch) {
    const query = commandMatch[1];
    const results = fuzzySearchCommands(commandMetadata, query, 8);
    const items: SuggestionItem[] = results.map((r) => ({
      name: r.name,
      desc: r.desc,
      nameMatches: r.nameMatches,
    }));
    return { type: items.length > 0 ? 'command' : null, items };
  }

  const agentMatch = value.match(/(?:^|\s)@([^\s@]*)$/);
  if (agentMatch) {
    const query = agentMatch[1].toLowerCase();
    const items = agentCandidates.filter((item) => item.name.toLowerCase().includes(`@${query}`)).slice(0, 8);
    return { type: items.length > 0 ? 'agent' : null, items };
  }
  const skillMatch = value.match(/(?:^|\s)\$([^\s$]*)$/);
  if (skillMatch) {
    const query = skillMatch[1].toLowerCase();
    const items = skillCandidates.filter((item) => item.name.toLowerCase().includes(`$${query}`)).slice(0, 8);
    return { type: items.length > 0 ? 'skill' : null, items };
  }
  return { type: null, items: [] };
}

export function applySuggestionToBuffer(value: string, suggestionName: string): string {
  const next = value.replace(/(?:^|\s)(\/[^\s/]*|@[^\s@]*|\$[^\s$]*)$/, (match) => {
    const leadingSpace = match.startsWith(' ') ? ' ' : '';
    return `${leadingSpace}${suggestionName}`;
  });
  return next.endsWith(' ') ? next : `${next} `;
}
