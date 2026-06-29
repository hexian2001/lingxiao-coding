import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { useSessionStore, type AgentActivity, type AgentRuntime, type SessionPhase } from '../../stores/sessionStore';

const log = createLogger('ChatView');
// 性能优化 (T-8)：useShallow 让返回新对象/数组的选择器用浅比较，避免 zustand
// 默认引用相等检查在不相关 store 更新时触发不必要的 re-render。
import { useShallow } from 'zustand/react/shallow';
import { usePermissionStore, type PermissionRequest } from '../../stores/permissionStore';
import { useViewStore } from '../../stores/viewStore';
import { useToast } from '../ui/Toast';
import { acpClient } from '../../api/AcpClient';
import { getServerToken } from '../../api/headers';
import { notifySettingChanged, SETTINGS_CHANGED_EVENT, settingsApiFetch, type SettingsChangedDetail } from '../settings/settingsApi';
import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { Send, Square, Paperclip, Sparkles, Shield, Check, X, Clock, Plus, MessageCircle, RefreshCw, Image as ImageIcon, Eye, AlertTriangle, Zap, Minimize2, Cpu, Loader2, CheckCircle2, XCircle, ChevronUp, ChevronDown, Wand2, Trash2, Bot, FileText, Table, Archive, ListOrdered, Search, ArrowUp, ArrowDown, Pencil, Workflow, PanelRightOpen, FileJson, Upload } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import MessageBubble from './MessageBubble';
import { usePopoverMaxHeight } from '../../hooks/usePopoverMaxHeight';
import AgentPanel from './AgentPanel';
import InterruptionBanner from './InterruptionBanner';
import { PlanApprovalBanner } from './PlanApprovalBanner';
import { TokenSparkline } from './TokenSparkline';
import { ControlModeToggle } from './ControlModeToggle';
import { ModeSplitControls } from './ModeSplitControls';
import { PermissionModeToggle } from './PermissionModeToggle';
import ChatGitBranchPicker from './ChatGitBranchPicker';
import WorkspacePicker from './WorkspacePicker';
import WorkbenchChangeStrip from './WorkbenchChangeStrip';
import JiangeCanvas from './JiangeCanvas';
import WorkbenchTerminalDock from './WorkbenchTerminalDock';
import RunStatusStrip from './RunStatusStrip';
import { useWorkbenchContext } from './useWorkbenchContext';
import ConfirmationDialog from '../ui/ConfirmationDialog';
import {
  messagesToMarkdown,
  messagesToJSON,
  downloadAsFile,
  downloadJSON,
  copyToClipboard,
  getExportFilename,
  parseLingxiaoJSON,
  readFileAsText,
} from '../../utils/exportConversation';
import { calculateCostDetailed, formatCost } from '../../utils/costCalculator';
import { estimateTokens, formatTokenCount } from '../../utils/estimateTokens';
import {
  deriveRuntimeWaitGate,
  isAgentActiveStatus,
  isRunTerminalStatus,
  normalizeRunStatus,
  runtimeImpliesBusy,
} from '../../stores/sessionStoreHelpers.ts';
import { getToolPhaseLabel } from '../../utils/toolPhaseLabels';
import { buildChatRunStateViewModel } from '../../utils/chatRunStateViewModel';
import { buildSessionBadgeViewModel, type SessionBadgeTone } from '../../utils/sessionListViewModel';
import { SessionUpdateKind, subscribeSessionUpdateEvents } from '../../stores/sseStore';

const logoSrc = `/logo.svg?v=${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}`;
const WORKBENCH_PANEL_COLLAPSED_STORAGE_KEY = 'lingxiao_workbench_panel_collapsed_v2';

type PendingImage = { type: 'image_url'; image_url: { url: string }; name: string; size: number };
type ModelEntry = { id: string; name: string; providerName: string; isBuiltin: boolean };
type ModelPickerTarget = 'leader' | 'agent';
type ModeBurst = { id: number; mode: 'bughunt' | 'office' | 'workflow'; enabled: boolean };
type ModeId = ModeBurst['mode'];
type ModeToolMeta = { count?: number; toolNames?: string[] };
type SkillSuggestion = { name: string; description: string };
type SlashCommand = { name: string; desc: string; usage?: string };
type SlashCommandRegistryStatus = 'loading' | 'ready' | 'empty' | 'error';
type SkillsListResponseDto = { data?: unknown };
type SessionCommandResponseDto = {
  action?: unknown;
  result?: unknown;
  message?: unknown;
  success?: unknown;
  error?: unknown;
};
type PromptEnhanceStats = {
  status: 'starting' | 'waiting' | 'streaming' | 'thinking' | 'retrying' | 'done' | 'error';
  inputTokens: number;
  inputChars: number;
  outputTokens: number;
  outputChars: number;
  elapsedMs: number;
  firstTokenMs?: number;
  model?: string;
  retryAttempt?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
};

function promptEnhanceStatusLabel(status: PromptEnhanceStats['status']): string {
  switch (status) {
    case 'starting': return '启笔';
    case 'waiting': return '凝神';
    case 'streaming': return '运笔';
    case 'thinking': return '凝思';
    case 'retrying': return '重试';
    case 'done': return '成';
    case 'error': return '败';
  }
}

type PendingFile = { path: string; name: string; size: number; format?: string; preview?: string; metadata?: { pages?: number; sheets?: string[]; entries?: string[] }; omitPreviewInPrompt?: boolean };
type UploadResponseFile = {
  success: boolean;
  name?: string;
  path?: string;
  size?: number;
  error?: string;
  preview?: {
    format?: string;
    content?: string;
    metadata?: PendingFile['metadata'];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function normalizeSkillSuggestion(value: unknown): SkillSuggestion | null {
  if (!isRecord(value) || !value.enabled || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    description: typeof value.description === 'string' ? value.description : '',
  };
}

function normalizeSlashCommand(value: unknown): SlashCommand | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name.startsWith('/')) return null;
  return {
    name,
    desc: typeof value.desc === 'string' ? value.desc : '',
    ...(typeof value.usage === 'string' && value.usage.trim() ? { usage: value.usage.trim() } : {}),
  };
}

function extractModeToolMeta(payload: unknown): ModeToolMeta | null {
  if (!isRecord(payload)) return null;
  const count = typeof payload.toolCount === 'number' && Number.isFinite(payload.toolCount) ? payload.toolCount : undefined;
  const toolNames = stringArrayValue(payload.toolNames);
  if (count === undefined && toolNames === undefined) return null;
  return {
    ...(count !== undefined ? { count } : {}),
    ...(toolNames !== undefined ? { toolNames } : {}),
  };
}

function pluginEnabled(payload: unknown): boolean {
  return isRecord(payload) ? Boolean(payload.enabled) : false;
}

function normalizePendingPermission(value: unknown, sessionId: string): PermissionRequest | null {
  if (!isRecord(value)) return null;
  const requestId = stringValue(value.requestId);
  const toolName = stringValue(value.toolName);
  if (!requestId || !toolName) return null;
  return {
    requestId,
    sessionId,
    source: value.source === 'worker' ? 'worker' : 'leader',
    toolName,
    reason: stringValue(value.reason) ?? '',
    requestedMode: stringValue(value.requestedMode),
    requestedHosts: stringArrayValue(value.requestedHosts),
    workerName: stringValue(value.workerName),
    autoApproved: typeof value.autoApproved === 'boolean' ? value.autoApproved : undefined,
    bypass: typeof value.bypass === 'boolean' ? value.bypass : undefined,
    timestamp: Date.now(),
  };
}

function normalizeSessionCommandResponse(value: unknown): SessionCommandResponseDto {
  return isRecord(value)
    ? {
      action: value.action,
      result: value.result,
      message: value.message,
      success: value.success,
      error: value.error,
    }
    : {};
}

const SESSION_BADGE_TONE_CLASS: Record<SessionBadgeTone, string> = {
  active: 'session-badge-tone session-badge-tone--active',
  warn: 'session-badge-tone session-badge-tone--warn',
  danger: 'session-badge-tone session-badge-tone--danger',
  ok: 'session-badge-tone session-badge-tone--ok',
  neutral: 'session-badge-tone session-badge-tone--neutral',
};

const MAX_UPLOAD_BATCH_FILES = 20;
const MAX_UPLOAD_CONCURRENCY = 3;
const LONG_INPUT_ATTACHMENT_THRESHOLD = 10_000;
const CHAT_INPUT_MIN_HEIGHT = 72;
const CHAT_INPUT_MAX_HEIGHT = 320;

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatModelLabel(entry: ModelEntry): string {
  const displayPart = (entry.name && entry.name !== entry.id) ? `${entry.name} · ${entry.id}` : entry.id;
  if (entry.isBuiltin) return displayPart;
  return `${displayPart}（via ${entry.providerName}）`;
}

function getSessionModelPreferenceKey(sessionId: string): string {
  return `lingxiao:model-preference:session:${sessionId || 'default'}`;
}

function readSessionModelPreference(sessionId: string): { leaderModel?: string; agentModel?: string } {
  try {
    const raw = localStorage.getItem(getSessionModelPreferenceKey(sessionId));
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      leaderModel: typeof parsed?.leaderModel === 'string' ? parsed.leaderModel : undefined,
      agentModel: typeof parsed?.agentModel === 'string' ? parsed.agentModel : undefined,
    };
  } catch {
    return {};
  }
}

function compactTimelineText(value: string | undefined): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'empty message';
  return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function makeLongInputAttachmentName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `long-message-${timestamp}.txt`;
}

function ChatTimelineRail({
  messages,
  activeIndex,
  onJump,
}: {
  messages: Array<{ role: string; content?: string; toolCalls?: unknown[]; agentActivity?: unknown[] }>;
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  const markers = useMemo(() => messages.map((message, index) => {
    const toolCount = Array.isArray(message.toolCalls) ? message.toolCalls.length : 0;
    const agentCount = Array.isArray(message.agentActivity) ? message.agentActivity.length : 0;
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
    const suffix = [
      toolCount > 0 ? `${toolCount} tool${toolCount > 1 ? 's' : ''}` : '',
      agentCount > 0 ? `${agentCount} agent${agentCount > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    return {
      index,
      role,
      toolCount,
      agentCount,
      title: `${index + 1}. ${role}${suffix ? ` · ${suffix}` : ''}: ${compactTimelineText(message.content)}`,
    };
  }), [messages]);

  if (markers.length < 2) return null;

  return (
    <div className="chat-timeline-rail" aria-label="Conversation timeline">
      <div className="chat-timeline-track">
        {markers.map((marker) => (
          <button
            key={marker.index}
            type="button"
            aria-label={marker.title}
            title={marker.title}
            onClick={() => onJump(marker.index)}
            className={[
              'chat-timeline-marker',
              marker.index === activeIndex ? 'is-active' : '',
              marker.role === 'User' ? 'is-user' : '',
              marker.toolCount > 0 ? 'has-tools' : '',
              marker.agentCount > 0 ? 'has-agents' : '',
            ].filter(Boolean).join(' ')}
          />
        ))}
      </div>
    </div>
  );
}

function writeSessionModelPreference(sessionId: string, patch: { leaderModel?: string; agentModel?: string }): void {
  try {
    const prev = readSessionModelPreference(sessionId);
    localStorage.setItem(getSessionModelPreferenceKey(sessionId), JSON.stringify({ ...prev, ...patch }));
  } catch (error) {
    log.warn('[ChatView] Failed to persist workspace model preference:', error);
  }
}

interface StreamingProgress {
  /** 'tool' | 'text' | 'thinking' | 'agent' — 用于决定文案前缀 */
  kind: 'tool' | 'text' | 'thinking' | 'agent_text' | 'agent_thinking' | 'agent_tool';
  /** 工具名 / agent 名（kind=text/thinking 时为 null） */
  label: string | null;
  /** 累计字符数 */
  chars: number;
  /** 估算的 token 数（启发式：CJK 1.5/token, 其他 4/token） */
  tokens: number;
  /** 实时 chars/s（无 firstAt 时为 null） */
  rate: number | null;
}

type CompactingProgress = {
  stage: string;
  chunkIndex?: number;
  chunkTotal?: number;
  percent?: number;
  oldTokens?: number;
  newTokens?: number;
  threshold?: number;
  messageCount?: number;
  label?: string;
  at?: number;
} | null;

function getCompactingStatusText(
  compactingProgress: CompactingProgress,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (compactingProgress?.stage === 'llm_summary') {
    const hasChunk = Number.isFinite(compactingProgress.chunkTotal) && (compactingProgress.chunkTotal ?? 0) > 0;
    if (!hasChunk) {
      return t('chat.status.compactingSummaryPreparing', {
        defaultValue: '压缩上下文中（LLM 摘要）',
      });
    }
    return t('chat.status.compactingSummary', {
      defaultValue: `压缩上下文中（摘要分块 ${compactingProgress.chunkIndex ?? '?'}/${compactingProgress.chunkTotal}）`,
      chunk: `${compactingProgress.chunkIndex ?? '?'}/${compactingProgress.chunkTotal}`,
      chunkIndex: compactingProgress.chunkIndex ?? 0,
      chunkTotal: compactingProgress.chunkTotal ?? 0,
    });
  }
  if (compactingProgress?.stage === 'finalizing') {
    return t('chat.status.compactingFinalizing', {
      defaultValue: '压缩上下文中（收尾）',
    });
  }
  return t('chat.status.compactingLlm', {
    defaultValue: '压缩上下文中（LLM 摘要）',
  });
}

function getInlineStatusText(
  phase: string,
  agents: Array<{ agentId?: string; agentName?: string; name?: string; status: string }>,
  progress: StreamingProgress | null,
  compactingProgress: CompactingProgress,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  const runningAgents = agents.filter(a => isAgentActiveStatus(a.status));

  // 任何流式增量都让用户看到数字在涨——优先级最高，覆盖泛化"处理中"。
  if (progress) {
    const rateSuffix = progress.rate !== null && progress.rate > 0
      ? ` · ${progress.rate}/s`
      : '';
    const tokenLabel = formatTokenCount(progress.tokens);
    if (progress.kind === 'tool' || progress.kind === 'agent_tool') {
      const label = getToolPhaseLabel(progress.label);
      return t('chat.status.toolInputStreaming', {
        defaultValue: `${label} (↓ ${tokenLabel} tokens · ${progress.chars} chars${rateSuffix})`,
        tool: progress.label || 'tool',
        label,
        tokens: tokenLabel,
        chars: progress.chars,
        rate: progress.rate ?? 0,
      });
    }
    if (progress.kind === 'thinking' || progress.kind === 'agent_thinking') {
      const owner = progress.label ? `@${progress.label} ` : '';
      return t('chat.status.thinkingStreaming', {
        defaultValue: `${owner}思考中（↓ ${tokenLabel} tokens · ${progress.chars} chars${rateSuffix}）`,
        owner,
        tokens: tokenLabel,
        chars: progress.chars,
        rate: progress.rate ?? 0,
      });
    }
    // text / agent_text
    const owner = progress.kind === 'agent_text' && progress.label ? `@${progress.label} ` : '';
    return t('chat.status.textStreaming', {
      defaultValue: `${owner}生成回复中（↓ ${tokenLabel} tokens · ${progress.chars} chars${rateSuffix}）`,
      owner,
      tokens: tokenLabel,
      chars: progress.chars,
      rate: progress.rate ?? 0,
    });
  }

  if (phase === 'thinking') {
    return t('chat.status.thinking');
  }
  if (phase === 'tool_executing') {
    return t('chat.status.toolExecuting');
  }
  if (phase === 'preparing') {
    return t('chat.status.preparing', { defaultValue: '准备中…' });
  }
  if (phase === 'model_requesting') {
    return t('chat.status.modelRequesting', { defaultValue: '等待模型响应…' });
  }
  if (phase === 'retrying') {
    return t('chat.status.retrying', { defaultValue: '重试中…' });
  }
  if (phase === 'compacting') {
    return getCompactingStatusText(compactingProgress, t);
  }
  if (phase === 'cancelling') {
    return t('chat.status.cancelling', { defaultValue: '取消中…' });
  }
  if (phase === 'waiting_for_permission') {
    return t('chat.status.waitingPermission', { defaultValue: '等待权限确认…' });
  }
  if (phase === 'waiting_for_user') {
    return t('chat.status.waitingUser', { defaultValue: '等待用户回答…' });
  }
  if (phase === 'observing') {
    return t('chat.status.observing', { defaultValue: '观察中…' });
  }
  if (runningAgents.length > 0) {
    const names = runningAgents.map(a => a.name || a.agentName || a.agentId || 'unknown');
    return t('chat.status.agentExecuting', { agents: names.map(n => `@${n}`).join(' ') });
  }

  return null;
}

interface LeaderStatusLineProps {
  leaderModelLabel: string;
  runActive: boolean;
  displayPhase: SessionPhase;
  displayAgents: AgentRuntime[];
}

/**
 * 性能优化 (T-3 P0)：状态行抽成 memo 叶子组件，自订阅 store。
 * 此前 streamingTick 的 600ms/1000ms setInterval 挂在 ChatView 顶层，每个 tick
 * 强制整棵 ChatView 子树重渲染，但 tick 唯一用途只是刷新这一行 Leader 状态文字
 * （streamingProgress 速率 + inlineStatusText）。迁入叶子后，tick 只重渲染本组件，
 * ChatView 主体不再受流式 tick 影响。
 */
const LeaderStatusLine = memo(function LeaderStatusLine({
  leaderModelLabel,
  runActive,
  displayPhase,
  displayAgents,
}: LeaderStatusLineProps) {
  const { t } = useTranslation();
  const messages = useSessionStore((s) => s.messages);
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const compactingProgress = useSessionStore(useShallow((s) => s.compactingProgress));
  const runtimeSnapshot = useSessionStore(useShallow((s) => s.runtimeSnapshot));
  const leaderStatusText = useSessionStore((s) => s.leaderStatusText);

  const [streamingTick, setStreamingTick] = useState(0);
  const streamingProgress = useMemo<StreamingProgress | null>(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

    // 1) Leader 工具入参流式（最高优先级——参数生成视觉最饥渴）
    const leaderStreamingTool = lastAssistant?.toolCalls?.find((tc) => tc.status === 'streaming_input');
    if (leaderStreamingTool) {
      const inputStr = typeof leaderStreamingTool.input === 'string'
        ? leaderStreamingTool.input
        : JSON.stringify(leaderStreamingTool.input ?? '');
      const chars = leaderStreamingTool.inputCharCount ?? inputStr.length;
      const rate = leaderStreamingTool.firstDeltaAt
        ? Math.round((chars * 1000) / Math.max(1, Date.now() - leaderStreamingTool.firstDeltaAt))
        : null;
      return { kind: 'tool', label: leaderStreamingTool.tool || 'tool', chars, tokens: estimateTokens(inputStr), rate };
    }

    // 2) Worker 工具入参流式
    for (const conv of Object.values(agentConversations)) {
      const streamMsg = [...conv.messages].reverse().find(
        (m) => m.type === 'tool_call' && m.isStreaming === true,
      );
      if (streamMsg) {
        const inputStr = typeof streamMsg.content === 'string'
          ? streamMsg.content
          : JSON.stringify(streamMsg.content ?? '');
        const chars = streamMsg.inputCharCount ?? inputStr.length;
        const rate = streamMsg.firstDeltaAt
          ? Math.round((chars * 1000) / Math.max(1, Date.now() - streamMsg.firstDeltaAt))
          : null;
        return {
          kind: 'agent_tool',
          label: streamMsg.tool || conv.agentName,
          chars,
          tokens: estimateTokens(inputStr),
          rate,
        };
      }
    }

    // 3) Leader 文本/思考流式
    if (lastAssistant?.isStreaming) {
      const textStr = lastAssistant.content || '';
      const thinkingStr = lastAssistant.thinkingContent || '';
      const startedAt = lastAssistant.streamStartedAt;
      // 优先展示当前正在涨的那一边：哪个 chars 多就跟谁
      if (textStr.length > 0 || thinkingStr.length > 0) {
        const useText = textStr.length >= thinkingStr.length;
        const str = useText ? textStr : thinkingStr;
        const chars = str.length;
        const rate = startedAt
          ? Math.round((chars * 1000) / Math.max(1, Date.now() - startedAt))
          : null;
        return {
          kind: useText ? 'text' : 'thinking',
          label: null,
          chars,
          tokens: estimateTokens(str),
          rate,
        };
      }
    }

    // 4) Worker 文本/思考流式
    for (const conv of Object.values(agentConversations)) {
      const streamMsg = [...conv.messages].reverse().find(
        (m) => (m.type === 'text' || m.type === 'thinking') && m.isStreaming === true,
      );
      if (streamMsg) {
        const str = streamMsg.content || '';
        const chars = str.length;
        // AgentMessage 没有 streamStartedAt 字段，退化用 timestamp 当起点
        const rate = streamMsg.timestamp
          ? Math.round((chars * 1000) / Math.max(1, Date.now() - streamMsg.timestamp))
          : null;
        return {
          kind: streamMsg.type === 'thinking' ? 'agent_thinking' : 'agent_text',
          label: conv.agentName,
          chars,
          tokens: estimateTokens(str),
          rate,
        };
      }
    }

    return null;
    // streamingTick 故意进依赖让速率每秒刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, agentConversations, streamingTick]);
  // 速率刷新 timer：只依赖"是否正在流式"布尔，避免 streamingProgress 因 messages
  // 每次变化都返回新引用导致 effect 反复 cleanup+重建 setInterval。
  const isStreaming = !!streamingProgress;
  const eternalRuntime = runtimeSnapshot?.eternal ?? null;
  const eternalNeedsTick = Boolean(
    eternalRuntime?.enabled
    && (eternalRuntime.status === 'waiting' || eternalRuntime.status === 'circuit_open')
  );
  useEffect(() => {
    if (!isStreaming && !eternalNeedsTick) return;
    const id = setInterval(() => setStreamingTick((n) => (n + 1) & 0xffff), isStreaming ? 600 : 1000);
    return () => clearInterval(id);
  }, [eternalNeedsTick, isStreaming]);

  const inlineStatusText = useMemo(() => {
    return getInlineStatusText(displayPhase, displayAgents, streamingProgress, compactingProgress, t);
  }, [displayAgents, compactingProgress, displayPhase, streamingProgress, t]);

  const leaderDisplayStatus = inlineStatusText
    || (runActive
      ? t('chat.status.processing')
      : leaderStatusText || (displayPhase === 'idle' ? t('chat.status.idleShort') : t('chat.status.processing')));

  return (
    <div className="min-w-0 flex-1 flex items-center gap-2 text-[11px] font-mono text-text-tertiary">
      <span
        className="min-w-0 flex-1 truncate whitespace-nowrap"
        title={`${leaderModelLabel} · Leader · ${leaderDisplayStatus}`}
      >
        {leaderModelLabel} · Leader · {(inlineStatusText || runActive) && (
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent-brand animate-pulse align-middle" />
        )}{leaderDisplayStatus}
      </span>
    </div>
  );
});

export default function ChatView() {
  const { t } = useTranslation();
  // 窄选择器 (2026-05-29)：此前用裸 useSessionStore() 订阅整个 store，任何一次 set()
  // （包括每个流式 chunk）都会 re-render 整个 ChatView 子树。改为按字段订阅，让流式
  // 文本更新只触发依赖 messages 的部分，其余字段不变则不重渲。
  // 性能优化 (T-8)：对象/数组类型选择器用 useShallow 包裹，避免引用变化导致不必要的
  // re-render；标量类型保持原样（引用相等即值相等）。
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore(useShallow((s) => s.sessions));
  const activeWorkspace = sessions.find((s) => s.id === sessionId)?.workspace || '';
  const messages = useSessionStore((s) => s.messages);
  const phase = useSessionStore((s) => s.phase);
  const isConnected = useSessionStore((s) => s.isConnected);
  const isLoadingHistory = useSessionStore((s) => s.isLoadingHistory);
  const tokenUsage = useSessionStore(useShallow((s) => s.tokenUsage));
  // token 消耗轨迹(火花图样本):事件驱动采样——tokenUsage.total 仅在 LLM 调用粒度变化,
  // 无需 setInterval。处理增长/去重/会话切换重置,封顶 24 样本。
  const [tokenHistory, setTokenHistory] = useState<number[]>([]);
  const lastTokenTotalRef = useRef<number>(0);
  useEffect(() => {
    const total = tokenUsage.total;
    if (total <= 0) {
      lastTokenTotalRef.current = 0;
      setTokenHistory([]);
      return;
    }
    if (total < lastTokenTotalRef.current) {
      // 会话切换/重置:total 回落,轨迹从头计
      lastTokenTotalRef.current = total;
      setTokenHistory([total]);
      return;
    }
    if (total === lastTokenTotalRef.current) return;
    lastTokenTotalRef.current = total;
    setTokenHistory((h) => {
      const next = h[h.length - 1] === total ? h : [...h, total];
      return next.length > 24 ? next.slice(next.length - 24) : next;
    });
  }, [tokenUsage.total]);
  const agents = useSessionStore((s) => s.agents);
  const contextRuntimeState = useSessionStore((s) => s.contextRuntimeState);
  const compactingProgress = useSessionStore(useShallow((s) => s.compactingProgress));
  const orchestrationStatus = useSessionStore(useShallow((s) => s.orchestrationStatus));
  const runExplanation = useSessionStore(useShallow((s) => s.runExplanation));
  const runtimeSnapshot = useSessionStore(useShallow((s) => s.runtimeSnapshot));
  // 性能优化 (T-8)：合并多个函数引用为单次 useShallow 订阅，减少订阅数量和比较开销。
  const { fetchSessions, connectToSession, createAndConnect, deleteSession,
    addMessage, setPhase, fetchTokenUsage, compressContext } =
    useSessionStore(useShallow((s) => ({
      fetchSessions: s.fetchSessions, connectToSession: s.connectToSession,
      createAndConnect: s.createAndConnect, deleteSession: s.deleteSession,
      addMessage: s.addMessage, setPhase: s.setPhase,
      fetchTokenUsage: s.fetchTokenUsage, compressContext: s.compressContext,
    })));
  const pendingPermissionRequests = usePermissionStore((s) => s.pendingRequests);
  const permissionHistory = usePermissionStore((s) => s.history);
  const { addToast } = useToast();
  const workbench = useWorkbenchContext(sessionId, activeWorkspace);
  // Eternal 自动放行 toast：监听 history 末项，autoApproved 才弹一条提示。
  // 不写 store 全量轮询，依赖 history 增量＋ ref 记录上次最大 index 即可。
  const lastAutoApprovedIndexRef = useRef<number>(-1);
  useEffect(() => {
    for (let i = lastAutoApprovedIndexRef.current + 1; i < permissionHistory.length; i++) {
      const entry = permissionHistory[i];
      if (entry?.autoApproved) {
        const modeTag = entry.bypass ? 'bypass' : (entry.requestedMode || 'dev');
        addToast({
          type: entry.bypass ? 'warning' : 'info',
          message: `[Eternal] 自动放行 ${entry.toolName} → ${modeTag}（${entry.workerName || entry.source}）`,
          duration: 4500,
        });
      }
    }
    lastAutoApprovedIndexRef.current = permissionHistory.length - 1;
  }, [permissionHistory, addToast]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [showPermHistory, setShowPermHistory] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [deepThinkingEnabled, setDeepThinkingEnabled] = useState(false);
  const [deepThinkingSaving, setDeepThinkingSaving] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceStats, setEnhanceStats] = useState<PromptEnhanceStats | null>(null);
  const [isDraggingOverChat, setIsDraggingOverChat] = useState(false);
  const [modelSupportsVision, setModelSupportsVision] = useState<boolean | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressResult, setCompressResult] = useState<{ oldTokens?: number; newTokens?: number; skipped?: boolean; inProgress?: boolean; reason?: string; error?: string } | null>(null);
  const [workbenchPanelCollapsed, setWorkbenchPanelCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(WORKBENCH_PANEL_COLLAPSED_STORAGE_KEY);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch {
      return true;
    }
    return true;
  });
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [agentPanelExpanded, setAgentPanelExpanded] = useState(false);
  const lastAutoOpenedAgentRunRef = useRef('');
  const manuallyClosedAgentRunRef = useRef('');
  const [displayPhase, setDisplayPhase] = useState<SessionPhase>(phase);
  const displaySessionRef = useRef<string | null>(sessionId);

  useEffect(() => {
    if (displaySessionRef.current !== sessionId) {
      displaySessionRef.current = sessionId;
      setDisplayPhase('idle');
      return;
    }
    if (phase !== 'idle' && phase !== 'done') {
      setDisplayPhase(phase);
      return;
    }
    const id = window.setTimeout(() => setDisplayPhase(phase), 1200);
    return () => window.clearTimeout(id);
  }, [phase, sessionId]);
  const [agentPanelWidth, setAgentPanelWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('lingxiao_agent_panel_width'));
      if (Number.isFinite(stored) && stored >= 320) return stored;
    } catch (error) {
      log.warn('[ChatView] Failed to read stored agent panel width:', error);
    }
    return 384;
  });
  const [bugHuntEnabled, setBugHuntEnabled] = useState(false);
  const [bugHuntLoading, setBugHuntLoading] = useState(false);
  const [officeEnabled, setOfficeEnabled] = useState(false);
  const [officeLoading, setOfficeLoading] = useState(false);
  const [workflowEnabled, setWorkflowEnabled] = useState(false);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [modeToolMeta, setModeToolMeta] = useState<Record<ModeId, ModeToolMeta>>({
    bughunt: {},
    office: {},
    workflow: {},
  });

  useEffect(() => {
    try {
      localStorage.setItem(WORKBENCH_PANEL_COLLAPSED_STORAGE_KEY, String(workbenchPanelCollapsed));
    } catch (error) {
      log.warn('[ChatView] Failed to persist workbench panel collapsed state:', error);
    }
  }, [workbenchPanelCollapsed]);
  const [modeBurst, setModeBurst] = useState<ModeBurst | null>(null);
  const modeBurstTimerRef = useRef<number | null>(null);
  const [workbenchTerminalOpen, setWorkbenchTerminalOpen] = useState(false);
  // 编辑消息状态
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // 模型切换器
  const [leaderModel, setLeaderModel] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
  const [showModelPicker, setShowModelPicker] = useState<ModelPickerTarget | null>(null);
  const [modelSwitching, setModelSwitching] = useState<ModelPickerTarget | null>(null);
  const [modelSwitchError, setModelSwitchError] = useState<string | null>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerBtnRef = useRef<HTMLButtonElement>(null);
  const modelPickerMaxH = usePopoverMaxHeight(modelPickerBtnRef, showModelPicker !== null, { cap: 320 });
  const [leaderModelContextWindow, setLeaderModelContextWindow] = useState<number | null>(null);
  const [agentModelContextWindow, setAgentModelContextWindow] = useState<number | null>(null);
  // Token popover — 顶栏 token/cost/sparkline 收进下拉气泡
  const [showTokenPopover, setShowTokenPopover] = useState(false);
  const tokenPopoverRef = useRef<HTMLDivElement>(null);
  const [deleteConfirmSession, setDeleteConfirmSession] = useState<string | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const isAtBottomRef = useRef(true);
  // 用户手动滚动标记：当用户用滚轮上翻时，暂停 followOutput 自动跟随，
  // 避免流式 chunk 的 auto 跳转和用户滚动互相打断造成抖动。
  const userScrolledAwayRef = useRef(false);
  // 初始滚动标记：sessionId 变化或历史首次加载完成时需要自动滚到底部。
  // followOutput 只在 data 变化时触发，首次渲染/切换 session 不会自动滚。
  const needsInitialScrollRef = useRef(true);
  const [timelineIndex, setTimelineIndex] = useState(0);
  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [searchIndex, setSearchIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Scroll-to-bottom button
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Export state
  const [exportCopied, setExportCopied] = useState(false);
  // Skill autocomplete
  const [availableSkills, setAvailableSkills] = useState<SkillSuggestion[]>([]);
  const [skillSuggestions, setSkillSuggestions] = useState<Array<{ name: string; description: string }>>([]);
  const [showSkillDropdown, setShowSkillDropdown] = useState(false);
  const [skillSelectedIndex, setSkillSelectedIndex] = useState(0);
  const skillDropdownRef = useRef<HTMLDivElement>(null);
  // Slash command autocomplete
  const [cmdSuggestions, setCmdSuggestions] = useState<Array<{ name: string; desc: string; usage?: string }>>([]);
  const [showCmdDropdown, setShowCmdDropdown] = useState(false);
  const [cmdSelectedIndex, setCmdSelectedIndex] = useState(0);
  const cmdDropdownRef = useRef<HTMLDivElement>(null);
  // Agent mention autocomplete
  const [agentSuggestions, setAgentSuggestions] = useState<Array<{ name: string; desc: string }>>([]);
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [agentSelectedIndex, setAgentSelectedIndex] = useState(0);
  const agentDropdownRef = useRef<HTMLDivElement>(null);
  // Esc+Esc shortcut — navigate to changes/rollback view
  const lastEscPressRef = useRef(0);
  const enhanceAbortRef = useRef<AbortController | null>(null);
  // 发送防重入锁：快速双击/连按回车时挡住同一瞬间的重复 session/prompt 提交
  const sendingLockRef = useRef(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 焦点守卫：焦点在剑阁浏览器 canvas 上时不拦截任何全局快捷键，
      // 让按键原样转发到 CDP 远程页面（修复浏览器键盘被劫持）
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl?.tagName === 'CANVAS' && activeEl.closest('.browser-screencast-container')) {
        return;
      }
      // Ctrl+E: 切换 Workers 视图
      if (e.key === 'e' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const { mainView, setMainView } = useViewStore.getState();
        setMainView(mainView === 'workers' ? 'chat' : 'workers');
        return;
      }
      if (e.key === 'Escape') {
        // Esc 关闭 token 气泡（优先级高于 Esc+Esc 导航）
        if (showTokenPopover) {
          e.preventDefault();
          setShowTokenPopover(false);
          return;
        }
        const now = Date.now();
        if (now - lastEscPressRef.current < 500 && input.trim() === '') {
          e.preventDefault();
          useViewStore.getState().setMainView('changes');
          lastEscPressRef.current = 0;
        } else {
          lastEscPressRef.current = now;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [input, showTokenPopover]);
  // Prompt suggestions
  const [promptSuggestions, setPromptSuggestions] = useState<string[]>([]);

  const leaderModelLabel = useMemo(() => {
    if (!leaderModel) return 'default';
    const entry = availableModels.find(m => m.id === leaderModel);
    return entry ? formatModelLabel(entry) : leaderModel;
  }, [leaderModel, availableModels]);

  const agentModelLabel = useMemo(() => {
    if (!agentModel) return leaderModelLabel;
    const entry = availableModels.find(m => m.id === agentModel);
    return entry ? formatModelLabel(entry) : agentModel;
  }, [agentModel, availableModels, leaderModelLabel]);

  // 流式进度：tool_input / leader_text / leader_thinking / agent_text / agent_thinking / agent_tool 六种
  // 都会在状态条显示"~N tokens · M chars · K/s"，让用户看到 token 在涨。每秒 tick 全局刷新一次。
  const agentConversations = useSessionStore((s) => s.agentConversations);
  const displayAgents = useMemo<AgentRuntime[]>(() => {
    const byId = new Map<string, AgentRuntime>();
    for (const agent of agents) {
      byId.set(agent.agentId, agent);
    }
    for (const conv of Object.values(agentConversations)) {
      const existing = byId.get(conv.agentId);
      byId.set(conv.agentId, {
        agentId: conv.agentId,
        agentName: existing?.agentName || conv.agentName || conv.agentId,
        role: existing?.role || conv.role || 'worker',
        status: existing?.status || conv.status || 'completed',
        taskId: existing?.taskId ?? conv.taskId,
        workingDirectory: existing?.workingDirectory ?? conv.workingDirectory,
        writeScope: existing?.writeScope ?? conv.writeScope,
        backend: existing?.backend ?? conv.backend,
        externalSessionId: existing?.externalSessionId ?? conv.externalSessionId,
        pid: existing?.pid ?? conv.pid,
        spawnedAt: existing?.spawnedAt ?? conv.messages[0]?.timestamp,
      });
    }
    return Array.from(byId.values()).sort((a, b) => (a.spawnedAt ?? 0) - (b.spawnedAt ?? 0));
  }, [agents, agentConversations]);

  const eternalRuntime = runtimeSnapshot?.eternal ?? null;

  const runState = useMemo(() => buildChatRunStateViewModel({
    phase,
    agents: displayAgents,
    messages,
    agentConversations,
    runtimeSnapshot,
  }), [agentConversations, displayAgents, messages, phase, runtimeSnapshot]);
  const runActive = runState.active;
  const promptSuggestionView = useMemo(() => {
    const hasMessages = messages.length > 0;
    if (!runtimeSnapshot || (sessionId && runtimeSnapshot.sessionId !== sessionId)) {
      return {
        source: 'runtime' as const,
        ready: false,
        refreshKey: `runtime:${sessionId || 'none'}:missing:${hasMessages ? 'messages' : 'empty'}`,
      };
    }
    const normalizedStatus = normalizeRunStatus(runtimeSnapshot.sessionStatus);
    const waitGate = deriveRuntimeWaitGate(runtimeSnapshot);
    const backendBusy = runtimeImpliesBusy({ runtimeState: runtimeSnapshot });
    const ready = hasMessages
      && !backendBusy
      && !waitGate
      && !isRunTerminalStatus(runtimeSnapshot.sessionStatus);
    return {
      source: 'runtime' as const,
      ready,
      refreshKey: `runtime:${runtimeSnapshot.sessionId}:${ready ? 'ready' : 'blocked'}:${normalizedStatus}:${waitGate ? 'gate' : 'clear'}`,
    };
  }, [sessionId, messages.length, runtimeSnapshot]);

  const agentMentionCandidates = useMemo(() => {
    const seen = new Map<string, { name: string; desc: string }>();
    for (const agent of displayAgents) {
      const rawName = agent.agentName || agent.agentId;
      if (!rawName) continue;
      const descParts = [agent.status, agent.agentId && agent.agentId !== rawName ? agent.agentId : undefined].filter(Boolean);
      seen.set(rawName, { name: `@${rawName}`, desc: descParts.join(' · ') });
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [displayAgents]);

  const pendingPermissions = useMemo(
    () => pendingPermissionRequests.filter((request) => !sessionId || request.sessionId === sessionId),
    [pendingPermissionRequests, sessionId],
  );

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/settings', {
        headers: { 'x-lingxiao-token': getServerToken() },
      });
      const json = await res.json();
      const data = json?.data || {};
      const sessionPreference = readSessionModelPreference(sessionId || '');
      const nextLeaderModel = sessionPreference.leaderModel || data.model || '';
      const nextAgentModel = sessionPreference.agentModel || sessionPreference.leaderModel || data.model || '';
      if (nextLeaderModel) setLeaderModel(nextLeaderModel);
      if (nextAgentModel) setAgentModel(nextAgentModel);
      const allModels: ModelEntry[] = [];
      for (const p of (data.providers || [])) {
        for (const m of (p.models || [])) {
          if (m.id) allModels.push({ id: m.id, name: m.name || '', providerName: p.name || p.id, isBuiltin: p.id === 'openai' || p.id === 'anthropic' });
        }
      }
      setAvailableModels(allModels);
    } catch (e) { log.warn('[ChatView] fetchModels failed:', e); }
  }, [sessionId, activeWorkspace]);

  // 获取当前模型 + 可用模型列表；Settings 是真实配置源，工作区偏好只作为旧版本兜底。
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);
  // 从 runtime snapshot 同步 leader/agent 模型：当服务端 setModel 改变模型后，
  // runtime state 会携带新的 leaderModel/agentModel，覆盖本地 localStorage 值。
  useEffect(() => {
    const snapLeaderModel = runtimeSnapshot?.leader?.leaderModel;
    const snapAgentModel = runtimeSnapshot?.leader?.agentModel;
    if (snapLeaderModel && snapLeaderModel !== leaderModel) {
      setLeaderModel(snapLeaderModel);
    }
    if (snapAgentModel && snapAgentModel !== agentModel) {
      setAgentModel(snapAgentModel);
    }
  }, [runtimeSnapshot?.leader?.leaderModel, runtimeSnapshot?.leader?.agentModel]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SettingsChangedDetail>).detail;
      // Only refresh on provider/model registry changes — NOT on 'model'/'agentModel' key changes,
      // because those are now session-scoped and should NOT propagate across sessions.
      if (detail?.key === 'modelRegistry' || detail?.key === 'providers') {
        fetchModels();
      }
      // 思考开关热加载：设置页改了也要即时跟随，避免顶栏开关与后端脱节。
      if (detail?.key === 'alwaysThinkingEnabled' && typeof detail.value === 'boolean') {
        setDeepThinkingEnabled(detail.value);
      }
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
  }, [fetchModels]);

  // Fetch available skills for $ autocomplete
  useEffect(() => {
    const fetchSkills = async () => {
      try {
        const params = new URLSearchParams();
        if (sessionId) params.set('sessionId', sessionId);
        const res = await fetch(`/api/v1/skills${params.size > 0 ? `?${params.toString()}` : ''}`, {
          headers: { 'x-lingxiao-token': getServerToken() },
        });
        const json = await res.json().catch(() => null) as SkillsListResponseDto | null;
        const skills = Array.isArray(json?.data) ? json.data : [];
        setAvailableSkills(skills
          .map(normalizeSkillSuggestion)
          .filter((skill): skill is SkillSuggestion => skill !== null));
      } catch (error) {
        log.warn('[ChatView] Failed to fetch skills:', error);
      }
    };
    fetchSkills();
  }, [sessionId]);

  // Slash command definitions — fetched dynamically from backend registry
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashCommandRegistryStatus, setSlashCommandRegistryStatus] = useState<SlashCommandRegistryStatus>('loading');
  useEffect(() => {
    let cancelled = false;
    const fetchCommands = async () => {
      setSlashCommandRegistryStatus('loading');
      try {
        const res = await acpClient.sendJsonRpc('commands/list', {}) as unknown;
        const commandsValue = isRecord(res) ? res.commands : undefined;
        if (!Array.isArray(commandsValue)) throw new Error('commands/list returned no command array');
        const commands = commandsValue
          .map(normalizeSlashCommand)
          .filter((cmd): cmd is SlashCommand => cmd !== null);
        if (cancelled) return;
        setSlashCommands(commands);
        setSlashCommandRegistryStatus(commands.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        log.warn('[ChatView] command registry unavailable:', error);
        if (cancelled) return;
        setSlashCommands([]);
        setSlashCommandRegistryStatus('error');
      }
    };
    if (isConnected) {
      fetchCommands();
    } else {
      setSlashCommands([]);
      setSlashCommandRegistryStatus('loading');
    }
    return () => { cancelled = true; };
  }, [isConnected]);
  const SLASH_COMMANDS = slashCommands;

  // Close command dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (cmdDropdownRef.current && !cmdDropdownRef.current.contains(e.target as Node)) {
        setShowCmdDropdown(false);
      }
    };
    if (showCmdDropdown) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCmdDropdown]);

  // Prompt suggestions wait for the canonical runtime snapshot to report idle.
  useEffect(() => {
    if (!promptSuggestionView.ready) {
      setPromptSuggestions([]);
      return;
    }
    let cancelled = false;
    const fetchSuggestions = async () => {
      try {
        const res = await fetch('/api/v1/prompt/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
          body: JSON.stringify({ messages: messages.slice(-6).map(m => ({ role: m.role, content: m.content })) }),
        });
        const json = await res.json();
        if (!cancelled && json?.data?.suggestions) {
          setPromptSuggestions(json.data.suggestions);
        }
      } catch (error) {
        log.warn('[ChatView] Failed to fetch prompt suggestions:', error);
      }
    };
    const timer = setTimeout(fetchSuggestions, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [promptSuggestionView.ready, promptSuggestionView.refreshKey, messages.length]);

  // 关闭模型选择器、技能/命令/Agent 下拉和 token 气泡的外部点击
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(null);
      }
      if (skillDropdownRef.current && !skillDropdownRef.current.contains(e.target as Node)) {
        setShowSkillDropdown(false);
      }
      if (cmdDropdownRef.current && !cmdDropdownRef.current.contains(e.target as Node)) {
        setShowCmdDropdown(false);
      }
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
        setShowAgentDropdown(false);
      }
      if (tokenPopoverRef.current && !tokenPopoverRef.current.contains(e.target as Node)) {
        setShowTokenPopover(false);
      }
    };
    if (showModelPicker || showSkillDropdown || showCmdDropdown || showAgentDropdown || showTokenPopover) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showModelPicker, showSkillDropdown, showCmdDropdown, showAgentDropdown, showTokenPopover]);

  const handleSwitchModel = async (target: ModelPickerTarget, model: string) => {
    const previousLeaderModel = leaderModel;
    const previousAgentModel = agentModel;
    setModelSwitching(target);
    setModelSwitchError(null);
    setShowModelPicker(null);
    if (target === 'leader') setLeaderModel(model);
    else setAgentModel(model);
    try {
      // Session-level model switch only — do NOT write global settings or broadcast
      // SETTINGS_CHANGED_EVENT, which would pollute other sessions' model state.
      writeSessionModelPreference(sessionId || '', target === 'leader' ? { leaderModel: model } : { agentModel: model });
      if (isConnected) {
        await acpClient.sendJsonRpc(target === 'leader' ? 'session/set_model' : 'session/set_agent_model', { model });
      } else {
        throw new Error('Not connected to server');
      }
    } catch (e) {
      setLeaderModel(previousLeaderModel);
      setAgentModel(previousAgentModel);
      writeSessionModelPreference(sessionId || '', { leaderModel: previousLeaderModel, agentModel: previousAgentModel });
      setModelSwitchError(e instanceof Error ? e.message : '模型切换失败');
    } finally {
      setModelSwitching(null);
    }
  };

  // Virtuoso handles scroll tracking via atBottomStateChange prop — no manual listener needed


  // Cancel any in-flight prompt-enhance stream when the view unmounts, so the
  // fetch + reader do not keep streaming into an unmounted component.
  useEffect(() => () => { enhanceAbortRef.current?.abort(); }, []);

  const enhancePrompt = useCallback(async () => {
    const source = input.trim();
    if (!source || isEnhancing) return;
    enhanceAbortRef.current?.abort();
    const controller = new AbortController();
    enhanceAbortRef.current = controller;
    const startedAt = Date.now();
    const inputTokens = estimateTokens(source);
    const resizeComposerSoon = () => {
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = `${CHAT_INPUT_MIN_HEIGHT}px`;
        const maxHeight = Math.min(CHAT_INPUT_MAX_HEIGHT, Math.round(window.innerHeight * 0.4));
        const nextHeight = Math.max(CHAT_INPUT_MIN_HEIGHT, Math.min(textarea.scrollHeight, maxHeight));
        textarea.style.height = `${nextHeight}px`;
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
      });
    };
    setIsEnhancing(true);
    setEnhanceStats({
      status: 'starting',
      inputTokens,
      inputChars: source.length,
      outputTokens: 0,
      outputChars: 0,
      elapsedMs: 0,
    });
    let enhanced = '';
    let lastUsage: PromptEnhanceStats['usage'];
    let firstTokenMs: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let streamCompleted = false;

    const updateStats = (patch: Partial<PromptEnhanceStats>) => {
      setEnhanceStats((current) => {
        const next: PromptEnhanceStats = {
          status: 'streaming',
          inputTokens,
          inputChars: source.length,
          outputTokens: estimateTokens(enhanced),
          outputChars: enhanced.length,
          elapsedMs: Date.now() - startedAt,
          firstTokenMs,
          usage: lastUsage,
          ...current,
          ...patch,
        };
        return {
          ...next,
          outputTokens: patch.outputTokens ?? estimateTokens(enhanced),
          outputChars: patch.outputChars ?? enhanced.length,
          elapsedMs: patch.elapsedMs ?? Date.now() - startedAt,
          firstTokenMs: patch.firstTokenMs ?? firstTokenMs ?? current?.firstTokenMs,
          usage: patch.usage ?? lastUsage ?? current?.usage,
        };
      });
    };

    try {
      const res = await fetch('/api/v1/prompt/enhance/stream', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json',
          'x-lingxiao-token': getServerToken(),
        },
        body: JSON.stringify({ prompt: source }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error || `Prompt enhance failed (${res.status})`);
      }
      if (!res.body) {
        const fallback = await fetch('/api/v1/prompt/enhance', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
          body: JSON.stringify({ prompt: source }),
        });
        if (!fallback.ok) {
          const errData = await fallback.json().catch(() => ({}));
          throw new Error(errData?.error || `Prompt enhance failed (${fallback.status})`);
        }
        const data = await fallback.json();
        enhanced = String(data.data?.enhanced || '');
        if (enhanced) {
          setInput(enhanced);
          resizeComposerSoon();
          setTimeout(() => textareaRef.current?.focus(), 50);
        }
        updateStats({
          status: enhanced ? 'done' : 'error',
          outputTokens: typeof data.data?.outputTokens === 'number' ? data.data.outputTokens : estimateTokens(enhanced),
          outputChars: typeof data.data?.outputChars === 'number' ? data.data.outputChars : enhanced.length,
          elapsedMs: Date.now() - startedAt,
          error: enhanced ? undefined : 'Empty response from LLM',
        });
        if (!enhanced) throw new Error('Empty response from LLM');
        setTimeout(() => {
          setEnhanceStats((current) => current?.status === 'done' ? null : current);
        }, 1800);
        return;
      }

      updateStats({ status: 'waiting' });
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handleEvent = (raw: string) => {
        const data = raw
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.replace(/^data:\s?/, ''))
          .join('\n')
          .trim();
        if (!data) return;
        const event = JSON.parse(data);
        if (event.type === 'start') {
          updateStats({
            status: 'waiting',
            model: typeof event.model === 'string' ? event.model : undefined,
            inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : inputTokens,
            inputChars: typeof event.inputChars === 'number' ? event.inputChars : source.length,
          });
          return;
        }
        if (event.type === 'first_token') {
          firstTokenMs = typeof event.elapsedMs === 'number' ? event.elapsedMs : Date.now() - startedAt;
          updateStats({ status: 'streaming', firstTokenMs });
          return;
        }
        if (event.type === 'delta') {
          enhanced += String(event.text || '');
          setInput(enhanced);
          resizeComposerSoon();
          updateStats({
            status: 'streaming',
            outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : estimateTokens(enhanced),
            outputChars: typeof event.outputChars === 'number' ? event.outputChars : enhanced.length,
            elapsedMs: typeof event.elapsedMs === 'number' ? event.elapsedMs : Date.now() - startedAt,
          });
          return;
        }
        if (event.type === 'thinking') {
          updateStats({
            status: 'thinking',
            elapsedMs: typeof event.elapsedMs === 'number' ? event.elapsedMs : Date.now() - startedAt,
          });
          return;
        }
        if (event.type === 'usage') {
          lastUsage = event.usage || undefined;
          updateStats({ usage: lastUsage });
          return;
        }
        if (event.type === 'retry') {
          enhanced = '';
          setInput(source);
          updateStats({ status: 'retrying', retryAttempt: Number(event.attempt) || 1 });
          return;
        }
        if (event.type === 'done') {
          enhanced = String(event.enhanced || enhanced).trim();
          lastUsage = event.usage || lastUsage;
          setInput(enhanced);
          resizeComposerSoon();
          updateStats({
            status: 'done',
            usage: lastUsage,
            outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : estimateTokens(enhanced),
            outputChars: typeof event.outputChars === 'number' ? event.outputChars : enhanced.length,
            elapsedMs: typeof event.elapsedMs === 'number' ? event.elapsedMs : Date.now() - startedAt,
          });
          return;
        }
        if (event.type === 'error') {
          throw new Error(String(event.error || 'Prompt enhance failed'));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamCompleted = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) handleEvent(part);
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!enhanced.trim()) throw new Error('Empty response from LLM');
      setTimeout(() => textareaRef.current?.focus(), 50);
      setTimeout(() => {
        setEnhanceStats((current) => current?.status === 'done' ? null : current);
      }, 1800);
    } catch (err) {
      if (controller.signal.aborted) {
        // Intentional cancel (unmount or a re-triggered enhance): restore the
        // source silently instead of surfacing a stream error.
        setInput(source);
        resizeComposerSoon();
      } else {
        const msg = err instanceof Error ? err.message : 'Prompt enhance failed';
        log.warn('[enhancePrompt]', msg);
        setInput(source);
        resizeComposerSoon();
        updateStats({ status: 'error', error: msg, elapsedMs: Date.now() - startedAt });
        addToast({ type: 'error', message: msg, duration: 5000 });
      }
    } finally {
      if (reader) {
        try {
          if (!streamCompleted) await reader.cancel();
        } catch {
          // best-effort: fetch abort / network close may already have released it
        }
        try {
          reader.releaseLock();
        } catch {
          // ignore: already released by browser implementation
        }
      }
      if (enhanceAbortRef.current === controller) enhanceAbortRef.current = null;
      setIsEnhancing(false);
    }
  }, [addToast, input, isEnhancing]);

  const toggleDeepThinking = useCallback(async () => {
    if (deepThinkingSaving) return;
    const next = !deepThinkingEnabled;
    setDeepThinkingSaving(true);
    try {
      await settingsApiFetch('/settings/behavior', {
        method: 'PUT',
        body: JSON.stringify({ key: 'alwaysThinkingEnabled', value: next }),
      });
      if (isConnected) {
        try {
          await acpClient.sendJsonRpc('session/set_extended_thinking', { enabled: next });
        } catch (rpcError) {
          log.warn('[ChatView] runtime thinking switch failed after settings save:', rpcError);
          addToast({
            type: 'info',
            message: t('settings.saved', '设置已保存，当前会话将在下一次请求前同步'),
            duration: 2500,
          });
        }
      }
      setDeepThinkingEnabled(next);
      notifySettingChanged({ key: 'alwaysThinkingEnabled', value: next });
      addToast({
        type: 'info',
        message: next ? t('chat.input.deepThinkingOn') : t('chat.input.deepThinkingOff'),
        duration: 2000,
      });
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('settings.saveFailed', '设置保存失败'),
        duration: 5000,
      });
    } finally {
      setDeepThinkingSaving(false);
    }
  }, [addToast, deepThinkingEnabled, deepThinkingSaving, isConnected, t]);

  // Search logic
  const doSearch = useCallback((query: string) => {
    if (!query.trim()) { setSearchMatches([]); setSearchIndex(-1); return; }
    const q = query.toLowerCase();
    const matches: number[] = [];
    messages.forEach((msg, i) => {
      if (msg.content && msg.content.toLowerCase().includes(q)) matches.push(i);
    });
    setSearchMatches(matches);
    setSearchIndex(matches.length > 0 ? 0 : -1);
    // Scroll to first match via Virtuoso
    if (matches.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: matches[0], align: 'center', behavior: 'smooth' });
    }
  }, [messages]);

  const searchNext = useCallback(() => {
    if (searchMatches.length === 0) return;
    const next = (searchIndex + 1) % searchMatches.length;
    setSearchIndex(next);
    virtuosoRef.current?.scrollToIndex({ index: searchMatches[next], align: 'center', behavior: 'smooth' });
  }, [searchMatches, searchIndex]);

  const searchPrev = useCallback(() => {
    if (searchMatches.length === 0) return;
    const prev = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    setSearchIndex(prev);
    virtuosoRef.current?.scrollToIndex({ index: searchMatches[prev], align: 'center', behavior: 'smooth' });
  }, [searchMatches, searchIndex]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setSearchIndex(-1);
  }, []);

  // Global Cmd+F / Ctrl+F listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && searchOpen) {
        closeSearch();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [searchOpen, closeSearch]);

  const scrollToBottom = useCallback(() => {
    userScrolledAwayRef.current = false;
    virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' });
  }, [messages.length]);

  // 智能初始滚动：切换 session 或历史首次加载完成时自动滚到底部。
  // followOutput 只在 data 变化时触发，首次渲染不触发 → 需要手动跳底。
  // 用 needsInitialScrollRef 标记避免每次 messages 变化都强制滚（尊重用户手动上翻）。
  // 消息异步加载时 scrollHeight 持续增长（代码高亮、图片加载等），
  // 用 setTimeout 轮询 + Virtuoso 原生 scrollToBottom 确保到位。
  useEffect(() => {
    if (messages.length === 0) {
      needsInitialScrollRef.current = true;
      return;
    }
    if (!needsInitialScrollRef.current) return;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20; // 最多重试 20 次（~2s）
    const tryScroll = () => {
      if (cancelled || attempts >= maxAttempts) {
        needsInitialScrollRef.current = false;
        return;
      }
      attempts++;
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
      isAtBottomRef.current = true;
      setShowScrollBtn(false);
      // 用 setTimeout(80ms) 给 Virtuoso 足够时间测量项高度和渲染。
      setTimeout(() => {
        if (cancelled) return;
        const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
        if (scroller) {
          const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          if (dist < 50) {
            needsInitialScrollRef.current = false;
            return;
          }
        }
        tryScroll();
      }, 80);
    };
    // 首次延迟 100ms 让 Virtuoso 完成初始 DOM 布局。
    const initial = setTimeout(tryScroll, 100);
    return () => { cancelled = true; clearTimeout(initial); needsInitialScrollRef.current = false; };
  }, [messages.length, sessionId]);

  const scrollToMessage = useCallback((index: number) => {
    virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
  }, []);

  const triggerModeBurst = useCallback((mode: ModeBurst['mode'], enabled: boolean) => {
    if (modeBurstTimerRef.current) window.clearTimeout(modeBurstTimerRef.current);
    setModeBurst({ id: Date.now(), mode, enabled });
    modeBurstTimerRef.current = window.setTimeout(() => setModeBurst(null), 1700);
  }, []);

  const rememberModeToolMeta = useCallback((mode: ModeId, payload: unknown) => {
    const meta = extractModeToolMeta(payload);
    if (!meta) return;
    setModeToolMeta((prev) => ({
      ...prev,
      [mode]: {
        ...prev[mode],
        ...meta,
      },
    }));
  }, []);

  const modeCountLabel = useCallback((mode: ModeId): string => {
    const count = modeToolMeta[mode]?.count;
    return typeof count === 'number' ? String(count) : '...';
  }, [modeToolMeta]);

  // Fetch BugHunt + Office + Workflow plugin status when session connects
  useEffect(() => {
    if (!isConnected) return;
    acpClient.sendJsonRpc('plugin/status', { pluginId: 'bughunt', sessionId })
      .then((res) => { setBugHuntEnabled(pluginEnabled(res)); rememberModeToolMeta('bughunt', res); })
      .catch((e) => { log.warn('[ChatView] bugHunt status fetch failed:', e); });
    acpClient.sendJsonRpc('plugin/status', { pluginId: 'office', sessionId })
      .then((res) => { setOfficeEnabled(pluginEnabled(res)); rememberModeToolMeta('office', res); })
      .catch((e) => { log.warn('[ChatView] office status fetch failed:', e); });
    acpClient.sendJsonRpc('plugin/status', { pluginId: 'workflow', sessionId })
      .then((res) => { setWorkflowEnabled(pluginEnabled(res)); rememberModeToolMeta('workflow', res); })
      .catch((e) => { log.warn('[ChatView] workflow status fetch failed:', e); });
  }, [isConnected, sessionId, rememberModeToolMeta]);

  useEffect(() => {
    const off = subscribeSessionUpdateEvents(acpClient, ({ kind, update, sessionId: eventSessionId }) => {
      if (kind !== SessionUpdateKind.PluginToggled || !update) return;
      if (eventSessionId && eventSessionId !== sessionId) return;
      const enabled = update.enabled === true;
      const pluginId = typeof update.pluginId === 'string' ? update.pluginId : '';
      if (pluginId === 'bughunt') { setBugHuntEnabled(enabled); rememberModeToolMeta('bughunt', update); triggerModeBurst('bughunt', enabled); }
      if (pluginId === 'office') { setOfficeEnabled(enabled); rememberModeToolMeta('office', update); triggerModeBurst('office', enabled); }
      if (pluginId === 'workflow') { setWorkflowEnabled(enabled); rememberModeToolMeta('workflow', update); triggerModeBurst('workflow', enabled); }
    });
    return off;
  }, [sessionId, triggerModeBurst, rememberModeToolMeta]);

  useEffect(() => () => {
    if (modeBurstTimerRef.current) window.clearTimeout(modeBurstTimerRef.current);
  }, []);

  const toggleBugHunt = async () => {
    if (bugHuntLoading) return;
    setBugHuntLoading(true);
    try {
      if (bugHuntEnabled) {
        const res = await acpClient.sendJsonRpc('plugin/disable', { pluginId: 'bughunt', sessionId });
        rememberModeToolMeta('bughunt', res);
        setBugHuntEnabled(false);
        triggerModeBurst('bughunt', false);
      } else {
        const res = await acpClient.sendJsonRpc('plugin/enable', { pluginId: 'bughunt', sessionId });
        rememberModeToolMeta('bughunt', res);
        setBugHuntEnabled(true);
        triggerModeBurst('bughunt', true);
      }
    } catch (e) { log.error('[BugHunt] toggle failed:', e); }
    finally { setBugHuntLoading(false); }
  };

  const toggleOffice = async () => {
    if (officeLoading) return;
    setOfficeLoading(true);
    try {
      if (officeEnabled) {
        const res = await acpClient.sendJsonRpc('plugin/disable', { pluginId: 'office', sessionId });
        rememberModeToolMeta('office', res);
        setOfficeEnabled(false);
        triggerModeBurst('office', false);
      } else {
        const res = await acpClient.sendJsonRpc('plugin/enable', { pluginId: 'office', sessionId });
        rememberModeToolMeta('office', res);
        setOfficeEnabled(true);
        triggerModeBurst('office', true);
      }
    } catch (e) { log.error('[Office] toggle failed:', e); }
    finally { setOfficeLoading(false); }
  };

  const toggleWorkflow = async () => {
    if (workflowLoading) return;
    setWorkflowLoading(true);
    try {
      if (workflowEnabled) {
        const res = await acpClient.sendJsonRpc('plugin/disable', { pluginId: 'workflow', sessionId });
        rememberModeToolMeta('workflow', res);
        setWorkflowEnabled(false);
        triggerModeBurst('workflow', false);
      } else {
        const res = await acpClient.sendJsonRpc('plugin/enable', { pluginId: 'workflow', sessionId });
        rememberModeToolMeta('workflow', res);
        setWorkflowEnabled(true);
        triggerModeBurst('workflow', true);
      }
    } catch (e) { log.error('[Workflow] toggle failed:', e); }
    finally { setWorkflowLoading(false); }
  };

  // Auto-show agent panel when agents are running
  const runningAgents = displayAgents.filter((a) => isAgentActiveStatus(a.status));
  const runningAgentRunKey = useMemo(
    () => runningAgents
      .map((agent) => `${agent.agentId}:${agent.taskId || ''}`)
      .sort()
      .join('|'),
    [runningAgents],
  );
  useEffect(() => {
    if (!runningAgentRunKey) {
      lastAutoOpenedAgentRunRef.current = '';
      manuallyClosedAgentRunRef.current = '';
      return;
    }
    if (showAgentPanel) {
      lastAutoOpenedAgentRunRef.current = runningAgentRunKey;
      return;
    }
    if (
      manuallyClosedAgentRunRef.current !== runningAgentRunKey
      && lastAutoOpenedAgentRunRef.current !== runningAgentRunKey
    ) {
      lastAutoOpenedAgentRunRef.current = runningAgentRunKey;
      setShowAgentPanel(true);
    }
  }, [runningAgentRunKey, showAgentPanel]);

  const openRunAgents = useCallback(() => {
    manuallyClosedAgentRunRef.current = '';
    setShowAgentPanel(true);
  }, []);

  const closeRunAgents = useCallback(() => {
    manuallyClosedAgentRunRef.current = runningAgentRunKey;
    setShowAgentPanel(false);
  }, [runningAgentRunKey]);

  const toggleRunAgents = useCallback(() => {
    if (showAgentPanel) {
      closeRunAgents();
    } else {
      openRunAgents();
    }
  }, [closeRunAgents, openRunAgents, showAgentPanel]);

  const openRunTasks = useCallback(() => {
    useViewStore.getState().setMainView('tasks');
  }, []);

  const openRunReview = useCallback(() => {
    // 剑阁已重构为 Canvas 工作台，审查入口仅展开剑阁（不再切 tab）。
    setWorkbenchPanelCollapsed(false);
  }, []);

  useEffect(() => {
    const handleOpenAgentPanel = () => setShowAgentPanel(true);
    const handleOpenWorkbenchReview = () => openRunReview();
    // 下载产物「在画布打开」：展开剑阁侧栏（产物由 openArtifact 驱动 JiangeCanvas 内的 ArtifactView 预览）。
    const handleOpenJiange = () => setWorkbenchPanelCollapsed(false);
    window.addEventListener('lingxiao:open-agent-panel', handleOpenAgentPanel);
    window.addEventListener('lingxiao:open-workbench-review', handleOpenWorkbenchReview);
    window.addEventListener('lingxiao:open-jiange', handleOpenJiange);
    return () => {
      window.removeEventListener('lingxiao:open-agent-panel', handleOpenAgentPanel);
      window.removeEventListener('lingxiao:open-workbench-review', handleOpenWorkbenchReview);
      window.removeEventListener('lingxiao:open-jiange', handleOpenJiange);
    };
  }, [openRunReview]);

  // Fetch model capabilities (vision + contextWindow) — re-runs when selected models change
  useEffect(() => {
    if (!leaderModel) return;
    (async () => {
      try {
        const url = `/api/v1/model/capabilities?model=${encodeURIComponent(leaderModel)}`;
        const res = await fetch(url, { headers: { 'x-lingxiao-token': getServerToken() } });
        if (res.ok) {
          const data = await res.json();
          setModelSupportsVision(data.data?.supportsVision ?? false);
          setLeaderModelContextWindow(data.data?.contextWindowSize ?? null);
        }
      } catch (e) { log.warn('[ChatView] leader model capabilities fetch failed:', e); }
    })();
  }, [leaderModel]);

  useEffect(() => {
    if (!agentModel) return;
    (async () => {
      try {
        const url = `/api/v1/model/capabilities?model=${encodeURIComponent(agentModel)}`;
        const res = await fetch(url, { headers: { 'x-lingxiao-token': getServerToken() } });
        if (res.ok) {
          const data = await res.json();
          setAgentModelContextWindow(data.data?.contextWindowSize ?? null);
        }
      } catch (e) { log.warn('[ChatView] agent model capabilities fetch failed:', e); }
    })();
  }, [agentModel]);

  const MAX_IMAGE_DIM = 1280;
  const JPEG_QUALITY = 0.7;

  const resizeImage = useCallback((file: File): Promise<string> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = document.createElement('img');
      // 超时保护：若 onload/onerror 永不触发，10s 后强制 revoke 并直接返回原始文件
      const timeoutId = setTimeout(() => {
        URL.revokeObjectURL(url);
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      }, 10_000);
      img.onload = () => {
        clearTimeout(timeoutId);
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width <= MAX_IMAGE_DIM && height <= MAX_IMAGE_DIM && file.size < 512 * 1024) {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
          return;
        }
        const scale = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height, 1);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.onerror = () => {
        clearTimeout(timeoutId);
        URL.revokeObjectURL(url);
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      };
      img.src = url;
    });
  }, []);

  const handleFileAttach = useCallback(async (files: FileList | File[]) => {
    const selected = Array.from(files).slice(0, MAX_UPLOAD_BATCH_FILES);
    const skipped = Array.from(files).length - selected.length;
    setAttachmentError(null);
    setUploadingCount((count) => count + selected.length);

    const readAsBase64 = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const failures: string[] = [];
    try {
      const images = selected.filter((file) => file.type.startsWith('image/'));
      const documents = selected.filter((file) => !file.type.startsWith('image/'));

      const imageResults = await runWithConcurrency(images, MAX_UPLOAD_CONCURRENCY, async (file) => {
        try {
          const dataUrl = await resizeImage(file);
          return { ok: true as const, value: { type: 'image_url' as const, image_url: { url: dataUrl }, name: file.name, size: file.size } };
        } catch (error) {
          return { ok: false as const, name: file.name, error };
        } finally {
          setUploadingCount((count) => Math.max(0, count - 1));
        }
      });
      const nextImages = imageResults.flatMap((result) => result.ok ? [result.value] : []);
      if (nextImages.length > 0) setPendingImages((prev) => [...prev, ...nextImages]);
      failures.push(...imageResults.filter((result) => !result.ok).map((result) => result.name));

      if (documents.length > 0) {
        const encodedDocuments = await runWithConcurrency(documents, MAX_UPLOAD_CONCURRENCY, async (file) => {
          try {
            const data = await readAsBase64(file);
            return { ok: true as const, file, data };
          } catch (error) {
            return { ok: false as const, file, error };
          }
        });
        failures.push(...encodedDocuments.filter((item) => !item.ok).map((item) => item.file.name));
        const uploadable = encodedDocuments.filter((item): item is { ok: true; file: File; data: string } => item.ok);

        if (uploadable.length > 0) {
          const res = await fetch('/api/v1/files/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
            body: JSON.stringify({
              files: uploadable.map(({ file, data }) => ({ name: file.name, mimeType: file.type, size: file.size, data })),
            }),
          });
          const json = await res.json().catch(() => ({}));
          const responseFiles: UploadResponseFile[] = Array.isArray(json.files) ? json.files : [json];
          const nextFiles = responseFiles.flatMap((item, index): PendingFile[] => {
            const fallbackFile = uploadable[index]?.file;
            if (!item?.success || !item.path) {
              failures.push(item?.name || fallbackFile?.name || 'unknown');
              return [];
            }
            return [{
              path: item.path,
              name: item.name || fallbackFile?.name || item.path,
              size: item.size ?? fallbackFile?.size ?? 0,
              format: item.preview?.format,
              preview: item.preview?.content,
              metadata: item.preview?.metadata,
            }];
          });
          if (nextFiles.length > 0) setPendingFiles((prev) => [...prev, ...nextFiles]);
          if (!res.ok && failures.length === 0) failures.push(json.error || `HTTP ${res.status}`);
        }
        setUploadingCount((count) => Math.max(0, count - documents.length));
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'upload failed');
      setUploadingCount((count) => Math.max(0, count - selected.length));
    }

    if (skipped > 0) failures.push(t('chat.input.skippedFiles', { count: skipped, max: MAX_UPLOAD_BATCH_FILES }));
    if (failures.length > 0) setAttachmentError(`${t('chat.input.attachmentFailed')}${failures.slice(0, 3).join(', ')}${failures.length > 3 ? ` +${failures.length - 3}` : ''}`);
  }, [resizeImage, t]);

  const uploadLongInputAsFile = useCallback(async (text: string): Promise<PendingFile | null> => {
    const name = makeLongInputAttachmentName();
    const size = new TextEncoder().encode(text).length;
    setAttachmentError(null);
    setUploadingCount((count) => count + 1);
    try {
      const res = await fetch('/api/v1/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
        body: JSON.stringify({
          files: [{
            name,
            mimeType: 'text/plain;charset=utf-8',
            size,
            data: encodeUtf8Base64(text),
          }],
        }),
      });
      const json = await res.json().catch(() => ({}));
      const responseFile: UploadResponseFile | undefined = Array.isArray(json.files) ? json.files[0] : json;
      if (!res.ok || !responseFile?.success || !responseFile.path) {
        throw new Error(responseFile?.error || json.error || `HTTP ${res.status}`);
      }
      return {
        path: responseFile.path,
        name: responseFile.name || name,
        size: responseFile.size ?? size,
        format: responseFile.preview?.format,
        preview: responseFile.preview?.content,
        metadata: responseFile.preview?.metadata,
        omitPreviewInPrompt: true,
      };
    } catch (error) {
      setAttachmentError(`${t('chat.input.attachmentFailed')}${error instanceof Error ? error.message : 'upload failed'}`);
      return null;
    } finally {
      setUploadingCount((count) => Math.max(0, count - 1));
    }
  }, [t]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/v1/settings', { headers: { 'x-lingxiao-token': getServerToken() } });
        if (res.ok) { const data = await res.json(); setDeepThinkingEnabled(!!data?.data?.alwaysThinkingEnabled); }
      } catch (error) {
        log.warn('[ChatView] Failed to fetch settings:', error);
      }
    })();
  }, []);

  // Session bootstrap (fetchSessions + auto-connect) is now in App.tsx

  useEffect(() => {
    if (!isConnected) return;
    let isMounted = true;

    // 连接建立后主动查询是否有 pending permission（防止 SSE 事件在监听器注册前到达）
    if (sessionId) {
      const controller = new AbortController();
      fetch(`/api/sessions/${sessionId}`, {
        headers: { 'x-lingxiao-token': getServerToken() || '' },
        signal: controller.signal,
      })
        .then(r => r.ok ? r.json() : null)
        .then((data: unknown) => {
          if (!isMounted) return;
          const p = normalizePendingPermission(isRecord(data) ? data.pendingPermission : null, sessionId);
          if (!p) return;
          // 只在还没有该 requestId 的情况下补发
          const existing = usePermissionStore.getState().pendingRequests;
          if (!existing.some((request) => request.requestId === p.requestId)) {
            usePermissionStore.getState().addRequest(p);
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
        });
      
      return () => { 
        isMounted = false;
        controller.abort();
      };
    }

    return () => { 
      isMounted = false;
    };
  }, [isConnected, sessionId]);

  // Virtuoso's followOutput="smooth" handles auto-scroll on new messages

  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => fetchTokenUsage(), 30000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const handleNewSession = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try { await createAndConnect(); setShowSessionList(false); }
    catch (e) { log.error('Failed to create session:', e); }
    finally { setIsCreating(false); }
  };

  const buildMessagePayload = (text: string, images: PendingImage[], files: PendingFile[]) => {
    const attachmentNames = [
      ...images.map((img) => `[附件] ${img.name}`),
      ...files.map((f) => `[附件] ${f.name}`),
    ].join('\n');
    const trimmed = text.trim();
    const displayContent = trimmed ? (attachmentNames ? `${trimmed}\n${attachmentNames}` : trimmed) : attachmentNames;
    const contentParts: Array<{type: string; text?: string; image_url?: {url: string}}> = [];
    if (trimmed) contentParts.push({ type: 'text', text: trimmed });
    for (const img of images) contentParts.push({ type: 'image_url', image_url: img.image_url });
    for (const f of files) {
      let fileRef = `[File: ${f.path}]`;
      if (f.format) fileRef += `\n[格式: ${f.format}${f.metadata?.pages ? `, ${f.metadata.pages}页` : ''}]`;
      if (f.preview && !f.omitPreviewInPrompt) fileRef += `\n[内容预览:\n${f.preview}\n]`;
      if (f.metadata?.sheets) fileRef += `\n[工作表: ${f.metadata.sheets.join(', ')}]`;
      contentParts.push({ type: 'text', text: fileRef });
    }
    return {
      displayContent,
      prompt: contentParts.length === 1 && contentParts[0].type === 'text' ? contentParts[0].text : contentParts,
    };
  };

  // 实际执行发送（不检查 busy 状态，由调用方保证）
  const doSend = async (text: string, images: PendingImage[], files: PendingFile[]) => {
    // 防重入：setInput 清空依赖 React 异步重渲染，快速双击/连按回车时会复用旧闭包穿透 guard，
    // 用同步 ref 锁挡住同一瞬间的重复提交。session/prompt 发出后立即释放，不影响用户排队发新消息。
    if (sendingLockRef.current) return;
    sendingLockRef.current = true;
    try {
      const payload = buildMessagePayload(text, images, files);
      const now = Date.now();
      const localId = `local-${now}-${Math.random().toString(36).slice(2)}`;
      addMessage({ id: `${localId}-user`, role: 'user', content: payload.displayContent, timestamp: now });
      setPhase('preparing');

      await acpClient.sendJsonRpc('session/prompt', {
        prompt: payload.prompt,
      });
    } catch (e) {
      log.error('Failed to send message:', e);
      useSessionStore.getState().updateLastMessage('[Error] Failed to send message');
      // 显示错误后自动恢复到 idle，允许用户重试
      setPhase('idle');
    } finally {
      sendingLockRef.current = false;
    }
  };

  const handleSend = async () => {
    if (phase === 'error') {
      setPhase('idle');
    }
    if ((!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) || !isConnected || uploadingCount > 0) return;
    let text = input.trim();
    const images = [...pendingImages];
    const files = [...pendingFiles];
    if (text.length > LONG_INPUT_ATTACHMENT_THRESHOLD) {
      const longInputFile = await uploadLongInputAsFile(text);
      if (!longInputFile) return;
      files.push(longInputFile);
      text = t('chat.input.longMessageAttachmentNotice', {
        count: text.length,
        name: longInputFile.name,
      });
    }

    // Slash command interception — route through session/command ACP
    const cmdMatch = text.match(/^\/([^\s]+)(.*)?$/s);
    if (cmdMatch) {
      const cmdName = `/${cmdMatch[1]}`;
      const cmdArgs = (cmdMatch[2] || '').trim();
      setInput(''); setShowCmdDropdown(false); setPromptSuggestions([]);

      // Client-only commands
      if (cmdName === '/rewind') {
        useViewStore.getState().setMainView('changes');
        return;
      }

      // Show command result in chat
      const now = Date.now();
      const localId = `cmd-${now}`;
      addMessage({ id: `${localId}-user`, role: 'user', content: text, timestamp: now });
      addMessage({ id: `${localId}-assistant`, role: 'assistant', content: '', timestamp: now + 1, isStreaming: false });
      setPhase('preparing');

      try {
        const result = normalizeSessionCommandResponse(await acpClient.sendJsonRpc('session/command', {
          command: cmdName,
          args: cmdArgs,
        }));
        // Handle special actions
        if (result?.action === 'clear') {
          // Clear frontend message store too
          useSessionStore.setState({ messages: [] });
          useSessionStore.getState().updateLastMessage('');
          // Remove the user+assistant bubble we just added
          useSessionStore.setState((s) => ({
            messages: s.messages.filter(m => !m.id.startsWith('cmd-')),
          }));
          setPhase('idle');
          return;
        }
        const resultContent = isRecord(result.result) ? result.result.content : undefined;
        const output = resultContent || result.message || (result.success ? `${cmdName} OK` : result.error || 'Command executed');
        const outputText = typeof output === 'string' ? output : JSON.stringify(output, null, 2) ?? 'Command executed';
        useSessionStore.getState().updateLastMessage(outputText);
        const delegatesToLeader = result?.action === 'approve'
          || result?.action === 'deny'
          || result?.action === 'intervene';
        setPhase(delegatesToLeader ? 'preparing' : 'idle');
      } catch (e) {
        useSessionStore.getState().updateLastMessage(`[Error] ${e instanceof Error ? e.message : 'Command failed'}`);
        setPhase('idle');
      }
      return;
    }
    const editId = editingMessageId;
    // 先清空输入状态，防止用户重复点击
    setInput(''); setPendingImages([]); setPendingFiles([]); setEditingMessageId(null); setShowSkillDropdown(false); setPromptSuggestions([]);

    // 编辑模式：移除被编辑消息之后的所有消息，然后重新发送
    if (editId) {
      const msgs = useSessionStore.getState().messages;
      const editIdx = msgs.findIndex(m => m.id === editId);
      if (editIdx >= 0) {
        useSessionStore.setState((s) => ({
          messages: s.messages.filter((_, idx) => idx < editIdx),
        }));
      }
    }

    await doSend(text, images, files);
  };

  const handleEditMessage = useCallback((messageId: string) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return;
    setEditingMessageId(messageId);
    setInput(msg.content);
  }, [messages]);

  const handleRetryMessage = useCallback((messageId: string) => {
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx < 0) return;
    // Find the last user message before this message
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userMsg = messages[userIdx];
    doSend(userMsg.content, [], []);
  }, [messages, doSend]);

  // Skill autocomplete: detect $ in input
  const resizeInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = `${CHAT_INPUT_MIN_HEIGHT}px`;
    const maxHeight = Math.min(CHAT_INPUT_MAX_HEIGHT, Math.round(window.innerHeight * 0.4));
    const nextHeight = Math.max(CHAT_INPUT_MIN_HEIGHT, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    requestAnimationFrame(resizeInput);
    requestAnimationFrame(() => requestAnimationFrame(resizeInput));
    // Clear prompt suggestions when user starts typing
    if (value.trim()) setPromptSuggestions([]);
    // Check for / command trigger (only at start of input)
    const cmdMatch = value.match(/^\/([^\s]*)$/);
    if (cmdMatch) {
      const query = cmdMatch[1].toLowerCase();
      const filtered = SLASH_COMMANDS.filter(c => c.name.slice(1).toLowerCase().includes(query)).slice(0, 12);
      setCmdSuggestions(filtered);
      setShowCmdDropdown(filtered.length > 0 || slashCommandRegistryStatus !== 'ready');
      setCmdSelectedIndex(0);
      setShowSkillDropdown(false);
      setShowAgentDropdown(false);
      return;
    }
    setShowCmdDropdown(false);
    // Check for @agent trigger
    const agentMatch = value.match(/(?:^|\s)@([^\s@]*)$/);
    if (agentMatch && agentMentionCandidates.length > 0) {
      const query = agentMatch[1].toLowerCase();
      const filtered = agentMentionCandidates.filter(a => a.name.slice(1).toLowerCase().includes(query));
      setAgentSuggestions(filtered);
      setShowAgentDropdown(filtered.length > 0);
      setAgentSelectedIndex(0);
      setShowSkillDropdown(false);
      return;
    }
    setShowAgentDropdown(false);
    // Check for $ skill trigger
    const match = value.match(/(?:^|\s)\$([^\s$]*)$/);
    if (match && availableSkills.length > 0) {
      const query = match[1].toLowerCase();
      const filtered = availableSkills.filter(s => s.name.toLowerCase().includes(query));
      setSkillSuggestions(filtered);
      setShowSkillDropdown(filtered.length > 0);
      setSkillSelectedIndex(0);
    } else {
      setShowSkillDropdown(false);
    }
  }, [agentMentionCandidates, availableSkills, resizeInput, SLASH_COMMANDS, slashCommandRegistryStatus]);

  useEffect(() => {
    if (!showCmdDropdown) return;
    const cmdMatch = input.match(/^\/([^\s]*)$/);
    if (!cmdMatch) return;
    const query = cmdMatch[1].toLowerCase();
    const filtered = SLASH_COMMANDS.filter(c => c.name.slice(1).toLowerCase().includes(query)).slice(0, 12);
    setCmdSuggestions(filtered);
    setShowCmdDropdown(filtered.length > 0 || slashCommandRegistryStatus !== 'ready');
    setCmdSelectedIndex(0);
  }, [input, showCmdDropdown, SLASH_COMMANDS, slashCommandRegistryStatus]);

  const insertWorkbenchGuidePrompt = useCallback((prompt: string) => {
    setInput((prev) => prev.trim() ? `${prev.trimEnd()}\n\n${prompt}` : prompt);
    setPromptSuggestions([]);
    setShowCmdDropdown(false);
    setShowSkillDropdown(false);
    setShowAgentDropdown(false);
    requestAnimationFrame(resizeInput);
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, [resizeInput]);

  const sendWorkbenchCommitNudge = useCallback(async (prompt: string) => {
    try {
      await acpClient.sendJsonRpc('session/nudge', { prompt });
      addToast({
        type: 'success',
        message: t('composer.commitNudgeSent', '已注入提交引导，不会中断当前模型运行'),
        duration: 3200,
      });
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('composer.commitNudgeFailed', '提交引导发送失败'),
        duration: 4200,
      });
      throw err;
    }
  }, [addToast, t]);

  const insertSkill = useCallback((skillName: string) => {
    setInput(prev => {
      const replaced = prev.replace(/(?:^|\s)\$[^\s$]*$/, `$${skillName} `);
      return replaced;
    });
    setShowSkillDropdown(false);
    textareaRef.current?.focus();
  }, []);

  const insertAgentMention = useCallback((mentionName: string) => {
    setInput(prev => prev.replace(/(?:^|\s)@[^\s@]*$/, (match) => {
      const leading = match.startsWith(' ') ? ' ' : '';
      return `${leading}${mentionName} `;
    }));
    setShowAgentDropdown(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle command dropdown navigation
    if (showCmdDropdown) {
      if (e.key === 'ArrowDown' && cmdSuggestions.length > 0) {
        e.preventDefault();
        setCmdSelectedIndex(i => Math.min(i + 1, cmdSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp' && cmdSuggestions.length > 0) {
        e.preventDefault();
        setCmdSelectedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (cmdSuggestions[cmdSelectedIndex]) {
          e.preventDefault();
          const cmd = cmdSuggestions[cmdSelectedIndex];
          setInput(cmd.name + ' ');
          setShowCmdDropdown(false);
          textareaRef.current?.focus();
          if (e.key === 'Enter') return; // Don't send on Enter when selecting command
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCmdDropdown(false);
        return;
      }
    }
    // Handle Agent mention dropdown navigation
    if (showAgentDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAgentSelectedIndex(i => Math.min(i + 1, agentSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAgentSelectedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (agentSuggestions[agentSelectedIndex]) {
          e.preventDefault();
          insertAgentMention(agentSuggestions[agentSelectedIndex].name);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAgentDropdown(false);
        return;
      }
    }
    // Handle skill dropdown navigation
    if (showSkillDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSkillSelectedIndex(i => Math.min(i + 1, skillSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillSelectedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (skillSuggestions[skillSelectedIndex]) {
          e.preventDefault();
          insertSkill(skillSuggestions[skillSelectedIndex].name);
          if (e.key === 'Enter') return; // Don't send on Enter when selecting skill
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSkillDropdown(false);
        return;
      }
    }
    if (e.key === 'Escape' && editingMessageId) {
      e.preventDefault();
      setEditingMessageId(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (uploadingCount === 0 && (input.trim() || pendingImages.length > 0 || pendingFiles.length > 0)) handleSend();
    }
  };

  const handleStop = async () => {
    try { await acpClient.sendJsonRpc('session/cancel'); } catch (error) { log.warn('[ChatView] Failed to cancel session:', error); }
    setPhase('idle');
    // 重置所有 Agent 状态，避免 hasRunningAgents() 残留阻塞后续状态转换
    useSessionStore.getState().agents.forEach(a => {
      if (isAgentActiveStatus(a.status)) {
        useSessionStore.getState().updateAgentStatus(a.agentId, 'interrupted');
      }
    });
    const msgs = useSessionStore.getState().messages;
    const last = msgs[msgs.length - 1];
    if (last && last.isStreaming) useSessionStore.getState().updateLastMessage(last.content || t('chat.interrupted'));
  };

  const handleCompress = async () => {
    setIsCompressing(true);
    try {
      const result = await compressContext();
      if (result) {
        const oldTokens = Number(result.oldTokens ?? 0);
        const newTokens = Number(result.newTokens ?? 0);
        const normalized = result.error
          ? result
          : result.inProgress
            ? { ...result, inProgress: true, skipped: false, reason: result.reason ?? t('chat.compacting') }
          : result.overflow
            ? { ...result, error: `Context still exceeds the window (${formatTokens(newTokens)})` }
            : result.skipped || result.compacted === false
              ? { ...result, skipped: true, reason: result.reason ?? t('chat.input.noCompressNeeded') }
              : oldTokens === newTokens
                ? { ...result, skipped: true, reason: t('chat.input.noCompressNeeded') }
                : result;
        setCompressResult(normalized);
        setTimeout(() => setCompressResult(null), 4000);
      }
    } finally { setIsCompressing(false); }
  };

  const handleExportMarkdown = useCallback(() => {
    const md = messagesToMarkdown(messages, `Session ${sessionId?.slice(0, 8) || 'unknown'}`);
    downloadAsFile(md, getExportFilename(sessionId || undefined));
  }, [messages, sessionId]);

  const handleCopyMarkdown = useCallback(async () => {
    const md = messagesToMarkdown(messages, `Session ${sessionId?.slice(0, 8) || 'unknown'}`);
    const ok = await copyToClipboard(md);
    if (ok) {
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    }
  }, [messages, sessionId]);

  // ── JSON 导出（凌霄对话格式）──
  const handleExportJSON = useCallback(() => {
    const jsonStr = messagesToJSON(messages, {
      sessionId: sessionId || undefined,
      title: `Session ${sessionId?.slice(0, 8) || 'unknown'}`,
    });
    downloadJSON(jsonStr, getExportFilename(sessionId || undefined, 'json'));
  }, [messages, sessionId]);

  // ── JSON 导入（凌霄对话格式）──
  const jsonImportInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<{ kind: 'idle' | 'loading' | 'success' | 'error'; message?: string }>({ kind: 'idle' });

  const handleImportJSON = useCallback(() => {
    jsonImportInputRef.current?.click();
  }, []);

  const handleImportFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 重置 input 以便重复选择同一文件
    e.target.value = '';
    if (!file) return;

    setImportStatus({ kind: 'loading' });
    try {
      const text = await readFileAsText(file);
      const parsed = parseLingxiaoJSON(text);

      if (parsed.messages.length === 0) {
        setImportStatus({ kind: 'error', message: '文件中没有可导入的消息。' });
        setTimeout(() => setImportStatus({ kind: 'idle' }), 4000);
        return;
      }

      // 调用后端导入 API，创建新会话并写入消息
      const res = await fetch('/api/sessions/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lingxiao-token': getServerToken(),
        },
        body: JSON.stringify({
          messages: parsed.messages,
          title: parsed.title || `Imported ${file.name}`,
          workspace: parsed.workspace,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `导入失败 (HTTP ${res.status})`);
      }

      const result = await res.json() as { id: string; messageCount: number };

      // 刷新会话列表并连接到新会话
      await fetchSessions();
      await connectToSession(result.id);

      setImportStatus({ kind: 'success', message: `已导入 ${result.messageCount} 条消息` });
      setTimeout(() => setImportStatus({ kind: 'idle' }), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导入失败，请检查文件格式。';
      setImportStatus({ kind: 'error', message: msg });
      setTimeout(() => setImportStatus({ kind: 'idle' }), 6000);
    }
  }, [fetchSessions, connectToSession]);

  const ctxPct = contextRuntimeState && contextRuntimeState.maxTokens > 0
    ? Math.round((contextRuntimeState.currentTokens / contextRuntimeState.maxTokens) * 100)
    : null;
  const compactingActive = phase === 'compacting';
  const compactingStatusText = useMemo(
    () => getCompactingStatusText(compactingProgress, t),
    [compactingProgress, t],
  );

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };
  const workbenchWorkspaceName = workbench.context?.workspace.name
    || activeWorkspace.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    || 'workspace';

  useEffect(() => {
    try {
      localStorage.setItem('lingxiao_agent_panel_width', String(agentPanelWidth));
    } catch (error) {
      log.warn('[ChatView] Failed to persist agent panel width:', error);
    }
  }, [agentPanelWidth]);

  const startAgentPanelResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch (error) {
      log.warn('[ChatView] Failed to capture resize pointer:', error);
    }
    const startX = event.clientX;
    const startWidth = agentPanelWidth;
    const minWidth = 320;
    const maxWidth = Math.max(360, Math.min(720, window.innerWidth - 520));
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (startX - moveEvent.clientX);
      setAgentPanelWidth(Math.min(maxWidth, Math.max(minWidth, next)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch (error) {
        log.warn('[ChatView] Failed to release resize pointer:', error);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [agentPanelWidth]);

  // Not connected state
  if (!isConnected && !isLoadingHistory) {
    return (
      <div className="codex-chat-surface flex-1 flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="codex-empty-state text-center max-w-xl px-6 -translate-y-8">
            <div className="lingxiao-empty-logo-shell mx-auto mb-8">
              <img src={logoSrc} alt="" aria-hidden="true" className="lingxiao-empty-logo" />
            </div>
            <h2 className="empty-state-slogan codex-empty-brand text-text-primary mb-4">{t('chat.brand')}</h2>
            <div className="flex justify-center mb-6"><span className="codex-empty-seal" aria-hidden="true">凌霄</span></div>
            {sessions.length === 0 ? (
              <>
                <p className="codex-empty-copy mb-6">{t('chat.noSessions', 'No sessions found. Create one or start from TUI.')}</p>
                <button onClick={handleNewSession} disabled={isCreating} className="cyber-btn cyber-btn-primary inline-flex items-center gap-2 disabled:opacity-50">
                  <Plus size={16} className="inline mr-1" />{t('chat.newSession', 'New Session')}
                </button>
              </>
            ) : (
              <>
                <p className="codex-empty-copy mb-5">{t('chat.selectSession', 'Select a session')}</p>
                <div className="reveal-stagger mx-auto max-w-md space-y-2 rounded-2xl border border-border-muted bg-bg-card/58 p-2 shadow-[0_20px_70px_rgba(0,0,0,0.10)] backdrop-blur-2xl">
                  {[...sessions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((s) => {
                    const rowRuntimeSnapshot = s.id === sessionId
                      ? runtimeSnapshot ?? s.runtimeSnapshot
                      : s.runtimeSnapshot;
                    const badge = buildSessionBadgeViewModel(s, {
                      currentSessionId: sessionId,
                      runtimeSnapshot: rowRuntimeSnapshot,
                    });
                    return (
                      <button key={s.id} onClick={() => connectToSession(s.id)} className="w-full text-left px-4 py-2.5 rounded-xl text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{s.name || s.id.slice(0, 8)}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${SESSION_BADGE_TONE_CLASS[badge.tone]}`}>{badge.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex h-full relative"
      onDragOver={(e) => { e.preventDefault(); setIsDraggingOverChat(true); }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDraggingOverChat(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOverChat(false);
        if (e.dataTransfer.files.length) handleFileAttach(e.dataTransfer.files);
      }}
    >
      {/* 全屏拖拽蒙层 */}
      {isDraggingOverChat && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-bg-primary/80 border-2 border-dashed border-accent-brand rounded-lg pointer-events-none">
          <div className="text-center">
            <ImageIcon size={48} className="mx-auto mb-3 text-accent-brand" />
            <p className="text-text-primary text-sm font-medium">{t('chat.upload.dragHint')}</p>
            <p className="text-text-tertiary text-xs mt-1">{t('chat.upload.supportedFormats')}</p>
          </div>
        </div>
      )}
      {/* Left: Main chat */}
      <div className={`codex-chat-surface flex-1 flex flex-col min-w-0 ${workbenchPanelCollapsed ? 'has-workbench-rail' : ''}`}>
        <RunStatusStrip
          phase={displayPhase}
          agents={displayAgents}
          orchestrationStatus={orchestrationStatus}
          runExplanation={runExplanation}
          contextRuntimeState={contextRuntimeState}
          eternalRuntime={eternalRuntime}
          compactingProgress={compactingProgress}
          now={Date.now()}
          onOpenAgents={openRunAgents}
          onOpenTasks={openRunTasks}
          onOpenEvidence={openRunReview}
        />
        {/* Session list overlay */}
        {showSessionList && (
          <>
            <div
              className="codex-session-popover-backdrop"
              onClick={() => { setShowSessionList(false); setSessionSearch(''); }}
            />
            <div className="codex-session-popover lingxiao-cloud-panel" role="dialog" aria-label={t('sidebar.sessions', 'Sessions')}>
              <div className="session-popover-header">
                <span>{t('sidebar.sessions', 'Sessions')}</span>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => fetchSessions()} className="codex-icon-btn !h-7 !min-w-7" title={t('chat.refresh', 'Refresh')}><RefreshCw size={14} /></button>
                  <button type="button" onClick={handleNewSession} disabled={isCreating} className="codex-icon-btn !h-7 !min-w-7" title={t('chat.newSession', 'New Session')}><Plus size={14} /></button>
                  <button type="button" onClick={() => { setShowSessionList(false); setSessionSearch(''); }} className="codex-icon-btn !h-7 !min-w-7" title={t('common.close', 'Close')}><X size={14} /></button>
                </div>
              </div>
              {/* Search input */}
              <div className="session-popover-search">
                <input
                  type="text"
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                  placeholder={t('sidebar.searchSessions', 'Search sessions...')}
                  className="session-search-input"
                />
              </div>
              <div className="session-popover-list">
                {sessions
                  .filter((s) => {
                    if (!sessionSearch.trim()) return true;
                    const q = sessionSearch.toLowerCase();
                    return (s.name || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.summary || '').toLowerCase().includes(q);
                  })
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((s) => {
                    const rowRuntimeSnapshot = s.id === sessionId
                      ? runtimeSnapshot ?? s.runtimeSnapshot
                      : s.runtimeSnapshot;
                    const badge = buildSessionBadgeViewModel(s, {
                      currentSessionId: sessionId,
                      runtimeSnapshot: rowRuntimeSnapshot,
                    });
                    return (
                  <div key={s.id} className={`session-row group ${s.id === sessionId ? 'is-active' : ''}`}>
                    <button type="button" onClick={() => { if (renamingSessionId !== s.id) { connectToSession(s.id); setShowSessionList(false); setSessionSearch(''); } }}
                      className="session-row-main">
                      <div className="session-row-content">
                        <MessageCircle size={12} className="session-row-icon" />
                        {renamingSessionId === s.id ? (
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={async () => {
                              const trimmed = renameValue.trim();
                              if (trimmed && trimmed !== s.name) {
                                try {
                                  await fetch(`/api/v1/sessions/${s.id}`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
                                    body: JSON.stringify({ name: trimmed }),
                                  });
                                  fetchSessions();
                                } catch (error) {
                                  log.warn('[ChatView] Failed to rename session:', error);
                                }
                              }
                              setRenamingSessionId(null);
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenamingSessionId(null); }}
                            autoFocus
                            className="session-rename-input"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span
                            className="session-row-title"
                          >
                            {s.name || s.id.slice(0, 8)}
                          </span>
                        )}
                        <span className={SESSION_BADGE_TONE_CLASS[badge.tone]}>{badge.label}</span>
                      </div>
                    </button>
                    <div className="session-row-actions">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setRenamingSessionId(s.id); setRenameValue(s.name || s.id.slice(0, 8)); }}
                        className="session-row-action"
                        title={t('sidebar.renameSession', 'Rename session')}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmSession(s.id); }}
                        className="session-row-action session-row-action-danger"
                        title={t('sidebar.deleteSession', 'Delete session')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                    );
                  })}
              </div>
            </div>
          </>
        )}

        {/* Top bar */}
        <div className="lingxiao-cloud-line codex-topbar relative flex items-center gap-2 px-5 py-3 border-b border-border-muted backdrop-blur-2xl text-xs shrink-0">
          <button onClick={() => setShowSessionList(!showSessionList)} className="codex-chip flex items-center gap-1.5 min-w-0 px-2.5 py-1 transition-colors">
            <MessageCircle size={12} className="shrink-0" />
            <span className="font-medium truncate max-w-[220px]">
              {sessionId
                ? (sessions.find((s) => s.id === sessionId)?.name || sessionId.slice(0, 8))
                : '—'}
            </span>
          </button>
          {sessionId && <span className={`px-1.5 py-0.5 rounded-full ${isConnected ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'}`}>{isConnected ? '●' : '○'}</span>}

          <div className="flex-1" />

          {modeBurst && (
            <div
              key={modeBurst.id}
              className={`mode-burst mode-burst--${modeBurst.mode} ${modeBurst.enabled ? 'is-enter' : 'is-exit'}`}
              role="status"
              aria-live="polite"
            >
              <span className="mode-burst__halo" />
              {modeBurst.mode === 'bughunt' && <Shield size={14} className="mode-burst__icon" />}
              {modeBurst.mode === 'office' && <FileText size={14} className="mode-burst__icon" />}
              {modeBurst.mode === 'workflow' && <Workflow size={14} className="mode-burst__icon" />}
              <span className="mode-burst__text">
                {t(`chat.modeBurst.${modeBurst.mode}.${modeBurst.enabled ? 'on' : 'off'}`)}
              </span>
            </div>
          )}

          {/* Token usage — 紧凑触发器 + popover 下拉详情 */}
          {tokenUsage.total > 0 && (
            <div className="flex items-center gap-1.5 mr-2 relative" ref={tokenPopoverRef}>
              <button
                onClick={() => setShowTokenPopover((v) => !v)}
                className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                  tokenUsage.total > 800000 ? 'border-accent-red/30 bg-accent-red/5' :
                  tokenUsage.total > 500000 ? 'border-accent-yellow/30 bg-accent-yellow/5' :
                  'border-border-default/50'
                }`}
              >
                <Zap size={10} className={tokenUsage.total > 800000 ? 'text-accent-red' : tokenUsage.total > 500000 ? 'text-accent-yellow' : 'text-text-tertiary'} />
                <span className={tokenUsage.total > 800000 ? 'text-accent-red' : tokenUsage.total > 500000 ? 'text-accent-yellow' : 'text-text-tertiary'}>{formatTokens(tokenUsage.total)}</span>
              </button>
              {tokenUsage.total > 500000 && (
                <AlertTriangle size={11} className={tokenUsage.total > 800000 ? 'text-accent-red animate-pulse' : 'text-accent-yellow'} />
              )}
              {showTokenPopover && (
                <div className="absolute top-full left-0 mt-1 min-w-[200px] bg-bg-card/92 backdrop-blur-2xl border border-border-default rounded-xl shadow-2xl z-[200] p-2 flex flex-col gap-1.5">
                  {/* 完整 token 分项 */}
                  <div className={`flex items-center gap-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                    tokenUsage.total > 800000 ? 'border-accent-red/30 bg-accent-red/5' :
                    tokenUsage.total > 500000 ? 'border-accent-yellow/30 bg-accent-yellow/5' :
                    'border-border-default/50'
                  }`}>
                    <Zap size={10} className={tokenUsage.total > 800000 ? 'text-accent-red' : tokenUsage.total > 500000 ? 'text-accent-yellow' : 'text-text-tertiary'} />
                    <span className={tokenUsage.total > 800000 ? 'text-accent-red' : tokenUsage.total > 500000 ? 'text-accent-yellow' : 'text-text-tertiary'}>{formatTokens(tokenUsage.total)}</span>
                    <span className="text-text-tertiary/40">↑{formatTokens(tokenUsage.prompt)}</span>
                    <span className="text-text-tertiary/40">↓{formatTokens(tokenUsage.completion)}</span>
                    {(tokenUsage.reasoning ?? 0) > 0 && <span className="text-text-tertiary/40">think {formatTokens(tokenUsage.reasoning ?? 0)}</span>}
                    {((tokenUsage.cache_read ?? 0) + (tokenUsage.cache_creation ?? 0)) > 0 && <span className="text-text-tertiary/40">cache {formatTokens((tokenUsage.cache_read ?? 0) + (tokenUsage.cache_creation ?? 0))}</span>}
                  </div>
                  {/* 消耗轨迹火花图:斜率即烧 token 速率 */}
                  <TokenSparkline data={tokenHistory} />
                  {/* Cost display — 区分 estimated/partial/cache hit,避免伪精确 */}
                  {(() => {
                    const cost = calculateCostDetailed(leaderModel || 'default', {
                      prompt: tokenUsage.prompt,
                      completion: tokenUsage.completion,
                      cache_read: tokenUsage.cache_read,
                      cache_creation: tokenUsage.cache_creation,
                    });
                    const tooltipKey = cost.partial
                      ? 'chat.cost.tooltipPartial'
                      : (cost.estimated ? 'chat.cost.tooltip' : 'chat.cost.tooltip');
                    const tooltip = cost.partial
                      ? t(tooltipKey, { rate: cost.cacheHitRate.toFixed(0) })
                      : t(tooltipKey);
                    const accentClass = cost.partial
                      ? 'text-accent-yellow/80'
                      : (cost.estimated ? 'text-accent-green/60' : 'text-accent-green/80');
                    return (
                      <span
                        className={`flex items-center gap-1 text-[10px] font-mono ${accentClass}`}
                        title={tooltip}
                        data-pricing-partial={cost.partial ? 'true' : undefined}
                        data-pricing-estimated={cost.estimated ? 'true' : undefined}
                      >
                        <span>~{formatCost(cost.total)}</span>
                        {cost.partial && (
                          <span className="px-1 rounded-sm bg-accent-yellow/15 text-accent-yellow/90 border border-accent-yellow/30">
                            {t('chat.cost.partialBadge')}
                          </span>
                        )}
                        {!cost.partial && cost.estimated && (
                          <span className="px-1 rounded-sm bg-text-tertiary/15 text-text-tertiary border border-text-tertiary/30">
                            {t('chat.cost.estimatedBadge')}
                          </span>
                        )}
                        {cost.cacheHitRate > 0 && (
                          <span className="text-text-tertiary/70">
                            {t('chat.cost.cacheHitSuffix', { rate: cost.cacheHitRate.toFixed(0) })}
                          </span>
                        )}
                      </span>
                    );
                  })()}
                  {/* Context window 占用 — 显示当前窗口已用/总量，而非累计消耗 */}
                  {ctxPct !== null && (
                    <div className={`flex items-center gap-0.5 text-[10px] font-mono px-1 ${
                      contextRuntimeState!.warningLevel === 'critical' ? 'text-accent-red' :
                      contextRuntimeState!.warningLevel === 'warning' ? 'text-accent-yellow' : 'text-text-tertiary'
                    }`} title={t('chat.input.contextWindowTooltip', { current: formatTokens(contextRuntimeState!.currentTokens), max: formatTokens(contextRuntimeState!.maxTokens) })}>
                      ctx≈{formatTokens(contextRuntimeState!.currentTokens)}/{formatTokens(contextRuntimeState!.maxTokens)}
                    </div>
                  )}
                  <button onClick={handleCompress} disabled={isCompressing || compactingActive || runActive}
                    className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                      isCompressing || compactingActive
                        ? 'border-accent-yellow/30 text-accent-yellow bg-accent-yellow/10'
                        : compressResult?.error
                          ? 'border-accent-red/30 text-accent-red bg-accent-red/10'
                          : compressResult?.inProgress
                            ? 'border-accent-yellow/30 text-accent-yellow bg-accent-yellow/10'
                          : compressResult && !compressResult.skipped
                            ? 'border-accent-green/30 text-accent-green bg-accent-green/10'
                            : compressResult?.skipped
                              ? 'border-text-tertiary/30 text-text-tertiary'
                              : 'border-border-default text-text-tertiary hover:text-accent-yellow hover:border-accent-yellow/30 disabled:opacity-40'
                    }`}
                    title={compressResult?.error || (compactingActive ? compactingStatusText : (compressResult?.inProgress ? compressResult.reason : (compressResult?.skipped ? compressResult.reason : t('chat.input.compressTooltip'))))}>
                    <Minimize2 size={10} className={isCompressing || compactingActive || compressResult?.inProgress ? 'animate-pulse' : ''} />
                    {isCompressing || compactingActive ? '...' : compressResult ? (compressResult.error ? '!' : (compressResult.inProgress ? '...' : (compressResult.skipped ? '—' : <Check size={10} className="text-accent-green" />))) : t('chat.input.compress')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* BugHunt plugin toggle */}
          {isConnected && (
            <button
              onClick={toggleBugHunt}
              disabled={bugHuntLoading}
              title={bugHuntEnabled ? t('chat.bugHunt.loaded', { count: modeToolMeta.bughunt.count ?? 0 }) : t('chat.bugHunt.load', { count: modeToolMeta.bughunt.count ?? 0 })}
              className={`mode-toggle mode-toggle--bughunt ${bugHuntEnabled ? 'is-active' : ''} ${bugHuntLoading ? 'is-loading' : ''}`}
            >
              <span className="mode-toggle__shine" />
              <Shield size={11} className="mode-toggle__icon" />
              <span>BugHunt</span>
              {bugHuntEnabled && typeof modeToolMeta.bughunt.count === 'number' && <span className="mode-toggle__count">×{modeToolMeta.bughunt.count}</span>}
            </button>
          )}

          {/* Office mode toggle */}
          {isConnected && (
            <button
              onClick={toggleOffice}
              disabled={officeLoading}
              title={officeEnabled ? t('chat.office.enabledTooltip', { count: modeToolMeta.office.count ?? 0 }) : t('chat.office.disabledTooltip', { count: modeToolMeta.office.count ?? 0 })}
              className={`mode-toggle mode-toggle--office ${officeEnabled ? 'is-active' : ''} ${officeLoading ? 'is-loading' : ''}`}
            >
              <span className="mode-toggle__shine" />
              <FileText size={11} className="mode-toggle__icon" />
              <span>Office</span>
              {officeEnabled && typeof modeToolMeta.office.count === 'number' && <span className="mode-toggle__count">×{modeToolMeta.office.count}</span>}
            </button>
          )}

          {/* Workflow mode toggle */}
          {isConnected && (
            <button
              onClick={toggleWorkflow}
              disabled={workflowLoading}
              title={workflowEnabled ? t('chat.workflow.enabledTooltip', { count: modeToolMeta.workflow.count ?? 0 }) : t('chat.workflow.disabledTooltip', { count: modeToolMeta.workflow.count ?? 0 })}
              className={`mode-toggle mode-toggle--workflow ${workflowEnabled ? 'is-active' : ''} ${workflowLoading ? 'is-loading' : ''}`}
            >
              <span className="mode-toggle__shine" />
              <Workflow size={11} className="mode-toggle__icon" />
              <span>Workflow</span>
              {workflowEnabled && typeof modeToolMeta.workflow.count === 'number' && <span className="mode-toggle__count">×{modeToolMeta.workflow.count}</span>}
            </button>
          )}

          {/* Agent panel toggle */}
          {displayAgents.length > 0 && (
            <button
              onClick={toggleRunAgents}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                showAgentPanel ? 'bg-accent-purple/10 text-accent-purple border border-accent-purple/30' :
                'text-text-tertiary hover:text-accent-purple hover:bg-accent-purple/5'
              }`}
            >
              <Cpu size={12} />
              <span>Agents</span>
              {runningAgents.length > 0 && (
                <span className="flex items-center gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-brand animate-pulse" />
                  <span className="text-accent-brand">{runningAgents.length}</span>
                </span>
              )}
            </button>
          )}

          {/* Export / Import buttons */}
          <div className="flex items-center gap-0.5">
            {messages.length > 0 && (
              <>
                <button
                  onClick={handleCopyMarkdown}
                  className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                    exportCopied
                      ? 'border-accent-green/30 text-accent-green bg-accent-green/10'
                      : 'border-border-default text-text-tertiary hover:text-accent-blue hover:border-accent-blue/30'
                  }`}
                  title={t('chat.export.copy', 'Copy as Markdown')}
                >
                  <FileText size={10} />
                  {exportCopied ? t('chat.export.copied', 'Copied!') : t('chat.export.copy', 'Copy')}
                </button>
                <button
                  onClick={handleExportMarkdown}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border border-border-default text-text-tertiary hover:text-accent-blue hover:border-accent-blue/30 transition-colors"
                  title={t('chat.export.download', 'Download as Markdown')}
                >
                  <Archive size={10} />
                  {t('chat.export.download', 'Export')}
                </button>
                <button
                  onClick={handleExportJSON}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border border-border-default text-text-tertiary hover:text-accent-green hover:border-accent-green/30 transition-colors"
                  title={t('chat.export.json', 'Export as JSON (凌霄对话格式)')}
                >
                  <FileJson size={10} />
                  {t('chat.export.jsonLabel', 'JSON')}
                </button>
              </>
            )}
            <button
              onClick={handleImportJSON}
              disabled={importStatus.kind === 'loading'}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                importStatus.kind === 'success'
                  ? 'border-accent-green/30 text-accent-green bg-accent-green/10'
                  : importStatus.kind === 'error'
                    ? 'border-red-500/30 text-red-400 bg-red-500/10'
                    : 'border-border-default text-text-tertiary hover:text-accent-blue hover:border-accent-blue/30'
              } ${importStatus.kind === 'loading' ? 'opacity-50 cursor-wait' : ''}`}
              title={t('chat.import.json', 'Import conversation from JSON')}
            >
              {importStatus.kind === 'loading'
                ? <Loader2 size={10} className="animate-spin" />
                : <Upload size={10} />}
              {importStatus.kind === 'success'
                ? t('chat.import.success', 'Imported!')
                : importStatus.kind === 'error'
                  ? t('chat.import.failed', 'Failed')
                  : t('chat.import.label', 'Import')}
            </button>
            <input
              ref={jsonImportInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportFileChange}
              className="hidden"
            />
          </div>

          {importStatus.kind === 'error' && importStatus.message && (
            <span className="text-[10px] text-red-400 font-mono max-w-[200px] truncate" title={importStatus.message}>
              {importStatus.message}
            </span>
          )}
          {importStatus.kind === 'success' && importStatus.message && (
            <span className="text-[10px] text-accent-green font-mono">{importStatus.message}</span>
          )}

          {isLoadingHistory && <span className="text-text-tertiary">Loading...</span>}
        </div>

        {/* Messages — only user ↔ leader */}
        <div className="relative flex-1 min-h-0">
          <ChatTimelineRail
            messages={messages}
            activeIndex={timelineIndex}
            onJump={scrollToMessage}
          />
          {/* Search bar overlay */}
          {searchOpen && (
            <div className="chat-search-popover absolute top-2 z-20 flex items-center gap-1.5 bg-bg-secondary border border-border-default rounded-lg shadow-lg px-2 py-1.5">
              <Search size={13} className="text-text-tertiary shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); doSearch(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext(); } if (e.key === 'Escape') closeSearch(); }}
                placeholder={t('chat.searchPlaceholder')}
                className="chat-search-input text-text-secondary text-xs font-mono outline-none w-48 placeholder:text-text-tertiary"
                autoFocus
              />
              {searchQuery && (
                <span className="text-[10px] text-text-tertiary font-mono whitespace-nowrap">
                  {searchMatches.length > 0 ? t('chat.searchResults', { current: searchIndex + 1, total: searchMatches.length }) : t('chat.searchNoResults')}
                </span>
              )}
              <button onClick={searchPrev} disabled={searchMatches.length === 0} className="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"><ArrowUp size={12} /></button>
              <button onClick={searchNext} disabled={searchMatches.length === 0} className="p-0.5 text-text-tertiary hover:text-text-primary disabled:opacity-30"><ArrowDown size={12} /></button>
              <button onClick={closeSearch} className="p-0.5 text-text-tertiary hover:text-text-primary"><X size={12} /></button>
            </div>
          )}
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full px-4 py-6">
              <div className="codex-empty-state text-center -translate-y-12">
                <div className="lingxiao-empty-logo-shell is-compact mx-auto mb-5">
                  <img src={logoSrc} alt="" aria-hidden="true" className="lingxiao-empty-logo" />
                </div>
                <h2 className="empty-state-slogan codex-empty-brand text-text-primary mb-2">{t('chat.brand')}</h2>
                <div className="flex justify-center mb-4"><span className="codex-empty-seal is-compact" aria-hidden="true">凌霄</span></div>
                <p className="codex-empty-copy">{t('input.placeholder')}</p>
              </div>
            </div>
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              data={messages}
              initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
              followOutput={(isAtBottom) => {
                // 初始加载期间无条件跟随到底部：initialTopMostItemIndex 定位到最后一项顶部，
                // isAtBottom 初始为 false，followOutput 返回 false 不滚动 → 死锁。
                // 用 needsInitialScrollRef 在初始加载完成前强制返回 'auto'。
                if (needsInitialScrollRef.current) return 'auto';
                // 用户手动上翻后暂停自动跟随，直到用户滚回底部或点滚动按钮
                if (userScrolledAwayRef.current) return false;
                if (!isAtBottom) return false;
                // 流式期间用 'auto'（瞬时跳转）而非 'smooth'：每帧 chunk 触发一次 smooth
                // 滚动动画会互相打断、抖动。仅在非流式（离散新消息）时用平滑滚动。
                return runActive
                  ? 'auto'
                  : 'smooth';
              }}
              atBottomStateChange={(atBottom) => {
                isAtBottomRef.current = atBottom;
                setShowScrollBtn(!atBottom);
                // 用户滚回底部时清除手动滚动标记，恢复自动跟随
                if (atBottom) userScrolledAwayRef.current = false;
              }}
              onWheel={() => {
                // 用户主动滚动且不在底部时，标记为手动上翻，暂停 followOutput
                if (!isAtBottomRef.current) {
                  userScrolledAwayRef.current = true;
                }
              }}
              rangeChanged={(range) => {
                setTimelineIndex(range.startIndex);
              }}
              increaseViewportBy={{ top: 400, bottom: 400 }}
              className="min-w-0 max-w-full overflow-x-hidden"
              itemContent={(idx, msg) => {
                const prev = messages[idx - 1];
                const duplicateThinkingOnly = prev?.role === 'assistant'
                  && msg.role === 'assistant'
                  && !prev.content?.trim()
                  && !msg.content?.trim()
                  && prev.thinkingContent?.trim()
                  && prev.thinkingContent.trim() === msg.thinkingContent?.trim();
                if (duplicateThinkingOnly) {
                  return <div className="chat-message-row h-px min-w-0" aria-hidden="true" data-msg-idx={idx} />;
                }
                return (
                  <div className="chat-message-row min-w-0 max-w-full overflow-hidden py-1" data-msg-idx={idx} id={`msg-${idx}`}>
                    <div className={searchMatches.includes(idx) && searchIndex >= 0 && searchMatches[searchIndex] === idx ? 'ring-1 ring-accent-brand/50 rounded-lg' : ''}>
                      <MessageBubble message={msg} onAgentClick={() => setShowAgentPanel(true)} onEdit={handleEditMessage} onRetry={handleRetryMessage} />
                    </div>
                  </div>
                );
              }}
            />
          )}
          {/* Scroll-to-bottom button */}
          {showScrollBtn && (
            <button
              onClick={scrollToBottom}
              className="chat-scroll-bottom-button absolute bottom-4 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-bg-secondary border border-border-default shadow-lg text-text-tertiary hover:text-text-primary hover:border-accent-brand/50 transition-colors"
              title={t('chat.scrollToBottom')}
            >
              <ChevronDown size={16} />
            </button>
          )}
        </div>

        {/* Plan approval */}
        <PlanApprovalBanner />

        {/* Interruption */}
        {pendingPermissions.length > 0 && (
          <InterruptionBanner request={pendingPermissions[0]} queuePosition={1} queueTotal={pendingPermissions.length} />
        )}

        {/* Permission history */}
        {permissionHistory.length > 0 && (
          <div className="border-t border-border-default">
            <button className="w-full px-4 py-1.5 flex items-center gap-2 text-xs text-text-tertiary hover:bg-bg-hover" onClick={() => setShowPermHistory(!showPermHistory)}>
              <Clock size={12} />{t('permission.history')} ({permissionHistory.length})
            </button>
            {showPermHistory && (
              <div className="px-4 pb-2 max-h-32 overflow-y-auto space-y-1">
                {permissionHistory.slice().reverse().map((rec, i) => {
                  // Web 只负责展示协议状态：approved/allowAll 都是放行，rejected 才是拒绝。
                  const accepted = rec.decision === 'approved' || rec.decision === 'allowAll';
                  return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Shield size={10} className={accepted ? 'text-accent-green' : 'text-accent-red'} />
                    <span className="font-mono text-text-primary">{rec.toolName}</span>
                    <span className={accepted ? 'text-accent-green' : 'text-accent-red'}>{accepted ? <Check size={10} /> : <X size={10} />}</span>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Input */}
        <div className="lingxiao-cloud-panel chat-composer-area border-t border-border-muted bg-bg-primary/58 backdrop-blur-2xl px-4 py-4 relative flex justify-center">
          <div className="w-full max-w-[900px]">
            <WorkbenchChangeStrip
              context={workbench.context}
              isLoading={workbench.isLoading}
              onRefresh={workbench.refresh}
              onGuideChanges={insertWorkbenchGuidePrompt}
              onCommitNudge={sendWorkbenchCommitNudge}
            />
            <ModeSplitControls />
            {/* 模型切换器 */}
          {availableModels.length > 0 && (
            <div className="flex flex-wrap items-center mb-2 gap-2 min-w-0" ref={modelPickerRef}>
              {([
                { target: 'leader' as const, label: 'Leader', model: leaderModel, modelLabel: leaderModelLabel, contextWindow: leaderModelContextWindow },
                { target: 'agent' as const, label: 'Agent', model: agentModel, modelLabel: agentModelLabel, contextWindow: agentModelContextWindow },
              ]).map((picker) => (
                <div key={picker.target} className="relative shrink-0">
                  <button
                    ref={showModelPicker === picker.target ? modelPickerBtnRef : undefined}
                    onClick={() => setShowModelPicker((v) => v === picker.target ? null : picker.target)}
                    className="codex-chip flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium transition-colors max-w-[240px]"
                    title={picker.label}
                  >
                    <Bot size={10} className="shrink-0" />
                    <span className="max-w-[120px] truncate">{picker.modelLabel}</span>
                    {modelSwitching === picker.target && <Loader2 size={10} className="animate-spin text-accent-brand shrink-0" />}
                    {picker.target === 'leader' && modelSupportsVision && <span className="inline-flex shrink-0" title={t('chat.model.supportsVision')}><Eye size={9} className="text-accent-brand/70" /></span>}
                    <ChevronDown size={10} className={`transition-transform shrink-0 ${showModelPicker === picker.target ? 'rotate-180' : ''}`} />
                  </button>
                  {showModelPicker === picker.target && (
                    <div style={{ maxHeight: modelPickerMaxH ?? undefined }} className="absolute bottom-full left-0 mb-1 min-w-[200px] max-w-[300px] max-h-[85vh] bg-bg-card/92 backdrop-blur-2xl border border-border-default rounded-xl shadow-2xl z-[200] overflow-hidden">
                      <div className="px-3 py-1.5 border-b border-border-muted">
                        <span className="text-[11px] text-text-tertiary">{picker.label} · {t('chat.switchModel')}</span>
                      </div>
                      <div className="max-h-48 overflow-y-auto py-1">
                        {availableModels.map((m) => (
                          <button
                            key={`${picker.target}-${m.id}-${m.providerName}`}
                            onClick={() => handleSwitchModel(picker.target, m.id)}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-left hover:bg-bg-tertiary transition-colors ${
                              m.id === picker.model ? 'text-accent-brand' : 'text-text-secondary'
                            }`}
                          >
                            {m.id === picker.model && <span className="w-1.5 h-1.5 rounded-full bg-accent-brand shrink-0" />}
                            {m.id !== picker.model && <span className="w-1.5 h-1.5 shrink-0" />}
                            <span className="truncate">{formatModelLabel(m)}</span>
                            {m.id === picker.model && picker.contextWindow && (
                              <span className="text-[10px] text-text-tertiary/60 font-mono shrink-0 ml-auto">{picker.contextWindow >= 1000 ? `${Math.round(picker.contextWindow / 1000)}k` : picker.contextWindow}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {modelSwitchError && (
                <span className="shrink-0 text-[11px] font-mono text-accent-red truncate max-w-[260px]" title={modelSwitchError}>
                  {modelSwitchError}
                </span>
              )}
              <ControlModeToggle />
              <PermissionModeToggle />
              <ChatGitBranchPicker workspace={activeWorkspace} />
              <WorkspacePicker />
              {isConnected && (
                <LeaderStatusLine
                  leaderModelLabel={leaderModelLabel}
                  runActive={runActive}
                  displayPhase={displayPhase}
                  displayAgents={displayAgents}
                />
              )}
            </div>
          )}
          {availableModels.length === 0 && (
            <div className="flex flex-wrap items-center mb-2 gap-2 min-w-0">
              <ControlModeToggle />
              <PermissionModeToggle />
              <ChatGitBranchPicker workspace={activeWorkspace} />
              <WorkspacePicker />
            </div>
          )}
          {(pendingImages.length > 0 || pendingFiles.length > 0 || uploadingCount > 0 || attachmentError) && (
            <div className="flex flex-wrap gap-2 mb-2">
              {uploadingCount > 0 && (
                <div className="flex items-center gap-1.5 bg-bg-tertiary border border-border-default rounded-lg px-2 py-1 text-xs text-text-secondary">
                  <Loader2 size={12} className="animate-spin text-accent-brand" />
                  {t('chat.input.uploadingAttachments', { count: uploadingCount })}
                </div>
              )}
              {attachmentError && (
                <div className="flex items-center gap-1.5 bg-accent-red/10 border border-accent-red/30 rounded-lg px-2 py-1 text-xs text-accent-red">
                  <AlertTriangle size={12} />
                  <span className="max-w-[360px] truncate" title={attachmentError}>{attachmentError}</span>
                  <button onClick={() => setAttachmentError(null)} className="text-accent-red/70 hover:text-accent-red"><X size={12} /></button>
                </div>
              )}
              {pendingImages.map((img, i) => (
                <div key={`img-${i}`} className="flex items-center gap-1.5 bg-bg-tertiary border border-border-default rounded-lg px-2 py-1">
                  <img src={img.image_url.url} alt={img.name} className="w-8 h-8 rounded object-cover" />
                  <span className="text-xs text-text-secondary max-w-[80px] truncate">{img.name}</span>
                  <button onClick={() => setPendingImages((prev) => prev.filter((_, idx) => idx !== i))} className="text-text-tertiary hover:text-accent-red"><X size={12} /></button>
                </div>
              ))}
              {pendingFiles.map((f, i) => {
                const FileIcon = f.format === 'pdf' || f.format === 'docx' ? FileText :
                  f.format === 'xlsx' || f.format === 'csv' ? Table :
                  f.format === 'zip' || f.format === 'pptx' ? Archive : Paperclip;
                const iconColor = f.format === 'pdf' ? 'text-accent-red' :
                  f.format === 'docx' ? 'text-accent-blue' :
                  f.format === 'xlsx' || f.format === 'csv' ? 'text-accent-green' :
                  f.format === 'zip' || f.format === 'pptx' ? 'text-accent-yellow' : 'text-text-tertiary';
                return (
                  <div key={`file-${i}`} className="flex items-center gap-1.5 bg-bg-tertiary border border-border-default rounded-lg px-2 py-1">
                    <FileIcon size={12} className={iconColor} />
                    <span className="text-xs text-text-secondary max-w-[120px] truncate" title={f.name}>{f.name}</span>
                    <button onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))} className="text-text-tertiary hover:text-accent-red"><X size={12} /></button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Editing indicator */}
          {editingMessageId && (
            <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-accent-brand/10 border border-accent-brand/30 rounded-md text-xs text-accent-brand">
              <Pencil size={12} />
              <span className="font-mono">{t('message.editing')}</span>
              <span className="text-text-tertiary">{t('message.editingCancel')}</span>
            </div>
          )}
          {/* Prompt suggestions */}
          {promptSuggestionView.ready && promptSuggestions.length > 0 && !input.trim() && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {promptSuggestions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => { setInput(s); setPromptSuggestions([]); textareaRef.current?.focus(); }}
                  className="codex-chip px-3 py-1.5 text-xs transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {/* Slash command autocomplete dropdown */}
          {showCmdDropdown && (cmdSuggestions.length > 0 || slashCommandRegistryStatus !== 'ready') && (
            <div ref={cmdDropdownRef} className="mb-1 bg-bg-primary border border-border-default rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto">
              <div className="px-2 py-1.5 text-[10px] text-text-muted uppercase tracking-wide border-b border-border-default bg-bg-secondary">
                {t('chat.commands', 'Commands')} ({cmdSuggestions.length})
              </div>
              {cmdSuggestions.length > 0 ? (
                cmdSuggestions.map((cmd, i) => (
                  <button
                    key={cmd.name}
                    onClick={() => { setInput(cmd.name + ' '); setShowCmdDropdown(false); textareaRef.current?.focus(); }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                      i === cmdSelectedIndex ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    <span className="font-mono font-medium shrink-0">{cmd.name}</span>
                    <span className="text-text-muted truncate text-[11px]">{cmd.desc}</span>
                    {cmd.usage && <span className="text-text-tertiary/60 text-[10px] font-mono shrink-0 hidden sm:inline">{cmd.usage}</span>}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-text-tertiary flex items-center gap-2">
                  {slashCommandRegistryStatus === 'loading' && <Loader2 size={13} className="animate-spin text-accent-brand" />}
                  <span>
                    {slashCommandRegistryStatus === 'loading'
                      ? t('chat.commandsLoading', 'Loading commands...')
                      : slashCommandRegistryStatus === 'error'
                        ? t('chat.commandsUnavailable', 'Command registry unavailable')
                        : t('chat.commandsEmpty', 'No commands are available')}
                  </span>
                </div>
              )}
            </div>
          )}
          {/* Agent mention autocomplete dropdown */}
          {showAgentDropdown && agentSuggestions.length > 0 && (
            <div ref={agentDropdownRef} className="mb-1 bg-bg-primary border border-border-default rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto">
              <div className="px-2 py-1.5 text-[10px] text-text-muted uppercase tracking-wide border-b border-border-default bg-bg-secondary">
                Agents ({agentSuggestions.length}/{agentMentionCandidates.length})
              </div>
              {agentSuggestions.map((agent, i) => (
                <button
                  key={agent.name}
                  onClick={() => insertAgentMention(agent.name)}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                    i === agentSelectedIndex ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  <span className="font-mono font-medium shrink-0">{agent.name}</span>
                  {agent.desc && <span className="text-text-muted truncate text-[11px]">{agent.desc}</span>}
                </button>
              ))}
            </div>
          )}
          {/* Skill autocomplete dropdown */}
          {showSkillDropdown && skillSuggestions.length > 0 && (
            <div ref={skillDropdownRef} className="mb-1 bg-bg-primary border border-border-default rounded-lg shadow-lg overflow-hidden max-h-[50vh] overflow-y-auto">
              <div className="px-2 py-1.5 text-[10px] text-text-muted uppercase tracking-wide border-b border-border-default bg-bg-secondary">
                Skills ({skillSuggestions.length}/{availableSkills.length})
              </div>
              {skillSuggestions.map((skill, i) => (
                <button
                  key={skill.name}
                  onClick={() => insertSkill(skill.name)}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                    i === skillSelectedIndex ? 'bg-accent-brand/15 text-accent-brand' : 'text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  <span className="font-mono font-medium">${skill.name}</span>
                  {skill.description && (
                    <span className="text-text-muted truncate text-[11px]">{skill.description.slice(0, 60)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
            <div className="codex-composer-shell flex items-end gap-2 px-3 py-2">
            <button onClick={() => { const el = document.createElement('input'); el.type = 'file'; el.multiple = true; el.onchange = () => { if (el.files) handleFileAttach(el.files); }; el.click(); }}
              disabled={uploadingCount > 0}
              className="codex-icon-btn !h-8 !min-w-8 disabled:opacity-50" title="Attach file"><Paperclip size={16} /></button>
            <textarea ref={textareaRef} value={input} onChange={(e) => handleInputChange(e.target.value)} onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                const files: File[] = [];
                for (let i = 0; i < items.length; i++) {
                  const item = items[i];
                  if (item.kind === 'file') {
                    const file = item.getAsFile();
                    if (file) files.push(file);
                  }
                }
                if (files.length > 0) {
                  e.preventDefault();
                  handleFileAttach(files);
                  return;
                }
                // 大文本粘贴拦截：超过阈值时直接转为文件附件，不让巨量文本进入 textarea。
                // 解决 308K 字符粘贴导致浏览器卡死的问题。
                const pastedText = e.clipboardData?.getData('text/plain');
                if (pastedText && pastedText.length > LONG_INPUT_ATTACHMENT_THRESHOLD) {
                  e.preventDefault();
                  // 异步上传，不阻塞 UI
                  void (async () => {
                    const longFile = await uploadLongInputAsFile(pastedText);
                    if (longFile) {
                      setPendingFiles((prev) => [...prev, longFile]);
                      // 在输入框显示简短提示（而不是 308K 原文）
                      const notice = t('chat.input.longMessageAttachmentNotice', {
                        count: pastedText.length,
                        name: longFile.name,
                      });
                      setInput((prev) => prev ? `${prev}\n${notice}` : notice);
                    }
                  })();
                }
              }}
              placeholder={!isConnected ? t('connection.disconnected') : `${t('input.placeholder')} (Enter ${t('input.send')}, Shift+Enter)`}
              className="chat-composer-textarea flex-1 min-w-0 text-text-primary text-[15px] resize-none outline-none min-h-[72px] max-h-[40vh] leading-6 overflow-y-hidden overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] placeholder:text-text-muted" rows={3} disabled={!isConnected} />
            <button onClick={toggleDeepThinking}
              disabled={deepThinkingSaving}
              className={`codex-icon-btn !h-8 !min-w-8 ${deepThinkingEnabled ? 'is-awakened' : ''}`}
              title={deepThinkingEnabled ? t('chat.input.deepThinkingOn') : t('chat.input.deepThinkingOff')}>
              {deepThinkingSaving ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} className={deepThinkingEnabled ? 'awakened-icon' : ''} />}
            </button>
            {/* Prompt Helper */}
            <div className="relative">
              <button
                onClick={enhancePrompt}
                className={`codex-icon-btn !h-8 !min-w-8 ${isEnhancing ? 'text-text-primary bg-bg-hover' : ''}`}
                title={t('chat.input.aiEnhance')}
                disabled={!isConnected || !input.trim() || isEnhancing}
              >
                {isEnhancing ? <Loader2 size={16} className="animate-spin text-accent-brand" /> : <Wand2 size={16} />}
              </button>
              {enhanceStats && (
                <div className={`prompt-enhance-status is-${enhanceStats.status}`} aria-live="polite">
                  <span className="prompt-enhance-status__badge">
                    <span className="prompt-enhance-status__dot" />
                    {promptEnhanceStatusLabel(enhanceStats.status)}
                  </span>
                  <span className="prompt-enhance-status__tok" key={enhanceStats.outputTokens}>
                    <span className="prompt-enhance-status__toknum">{formatTokenCount(enhanceStats.outputTokens)}</span>
                    <span className="prompt-enhance-status__unit">tok</span>
                  </span>
                  {enhanceStats.status === 'streaming' && (
                    <span className="prompt-enhance-status__rate">{Math.round(enhanceStats.outputTokens / Math.max(0.3, enhanceStats.elapsedMs / 1000))}/s</span>
                  )}
                  <span className="prompt-enhance-status__sep">{enhanceStats.outputChars}ch</span>
                  {enhanceStats.firstTokenMs !== undefined && <span className="prompt-enhance-status__dim">ttft{Math.round(enhanceStats.firstTokenMs)}ms</span>}
                  <span className="prompt-enhance-status__dim">{Math.max(0, Math.round(enhanceStats.elapsedMs / 1000))}s</span>
                  {enhanceStats.usage?.total_tokens !== undefined && <span className="prompt-enhance-status__dim">≈{formatTokenCount(enhanceStats.usage.total_tokens)}</span>}
                  {enhanceStats.model && <span className="prompt-enhance-status__dim prompt-enhance-status__model">{enhanceStats.model}</span>}
                </div>
              )}
            </div>
            {runActive ? (
              <div className="flex items-center gap-1">
                <button onClick={handleStop} className="codex-primary-icon-btn !bg-accent-red !text-white" title={t('chat.stopGenerate')}><Square size={15} /></button>
              </div>
            ) : (
              <button onClick={handleSend} disabled={(!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) || !isConnected || uploadingCount > 0}
                className="codex-primary-icon-btn" title={t('chat.send')}><Send size={15} /></button>
            )}
            </div>
          </div>
        </div>
        <WorkbenchTerminalDock
          open={workbenchTerminalOpen}
          workspaceName={workbenchWorkspaceName}
          onOpenChange={setWorkbenchTerminalOpen}
        />
      </div>

      {/* Compression result toast */}
      {compressResult && (
        <div className={`absolute top-14 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 border text-xs font-mono rounded-lg shadow-lg animate-fade-in ${
          compressResult.error
            ? 'bg-accent-red/10 border-accent-red/30 text-accent-red'
            : compressResult.inProgress
              ? 'bg-accent-yellow/10 border-accent-yellow/30 text-accent-yellow'
            : compressResult.skipped
              ? 'bg-text-tertiary/10 border-text-tertiary/30 text-text-secondary'
              : 'bg-accent-green/10 border-accent-green/30 text-accent-green'
        }`}>
          {compressResult.error ? <XCircle size={14} /> : compressResult.inProgress ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {compressResult.error
            ? <span>{compressResult.error}</span>
            : compressResult.inProgress
              ? <span>{compressResult.reason ?? t('chat.compacting')}</span>
            : compressResult.skipped
              ? <span>{compressResult.reason ?? t('chat.input.noCompressNeeded')}</span>
              : <span>{t('chat.input.compressDone', { old: formatTokens(compressResult.oldTokens ?? 0), new: formatTokens(compressResult.newTokens ?? 0) })}</span>
          }
        </div>
      )}

      {workbenchPanelCollapsed ? (
        <div className="workbench-collapsed-rail hidden xl:flex">
          <button
            type="button"
            className="workbench-collapsed-button"
            onClick={() => setWorkbenchPanelCollapsed(false)}
            title={t('workbench.expandPavilion', '展开剑阁')}
            aria-label={t('workbench.expandPavilion', '展开剑阁')}
          >
            <PanelRightOpen size={16} />
            <span>{t('workbench.pavilion', '剑阁')}</span>
          </button>
        </div>
      ) : (
        <JiangeCanvas
          workspaceName={workbenchWorkspaceName}
          onRefresh={workbench.refresh}
          onCollapse={() => setWorkbenchPanelCollapsed(true)}
        />
      )}

      {/* Right: Agent panel */}
      {showAgentPanel && (
        <div
          className={`agent-side-panel-frame ${agentPanelExpanded ? 'is-expanded' : ''}`}
          style={{ width: agentPanelExpanded ? Math.max(agentPanelWidth, 480) : agentPanelWidth }}
        >
          <div
            className="agent-panel-resize-handle"
            role="separator"
            aria-orientation="vertical"
            title={t('workbench.resize', '拖动调整宽度')}
            onPointerDown={startAgentPanelResize}
          />
          <AgentPanel onClose={closeRunAgents} onExpandChange={setAgentPanelExpanded} />
        </div>
      )}

      <ConfirmationDialog
        open={deleteConfirmSession !== null}
        title={t('chat.deleteConfirmTitle')}
        message={t('chat.deleteConfirmMessage')}
        confirmLabel={t('chat.deleteConfirmOk')}
        cancelLabel={t('chat.deleteConfirmCancel')}
        variant="danger"
        onConfirm={() => { if (deleteConfirmSession) { deleteSession(deleteConfirmSession); } setDeleteConfirmSession(null); }}
        onCancel={() => setDeleteConfirmSession(null)}
      />
    </div>
  );
}
