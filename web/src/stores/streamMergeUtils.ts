// ─── Pure utility functions for stream merging and message manipulation ───
// No store imports — all state is passed as parameters.

import { splitThinkContent } from '@contracts/adapters/ThinkContent';
import { createEventProcessorState } from '@contracts/adapters/EventAdapter';
import type {
  AgentConversation,
  AgentMessage,
  AgentRuntime,
  ContentBlock,
  Message,
  SessionPhase,
  SessionRuntimeSnapshot,
  SessionRuntimeWorkerSummary,
  SessionState,
  TokenUsage,
  ToolCall,
} from './sessionStoreTypes.ts';
import type { ProjectBlueprint } from '../types/blueprint';
import {
  deriveRuntimeWaitGate,
  deriveRuntimeWorkerFacts,
  isAgentActiveStatus,
  isAgentTerminalStatus,
  isOpenToolCall,
  isRunActiveStatus,
  mergeAgentStatus,
  mergeToolCall,
  normalizeRunStatus,
  runtimeImpliesBusy,
  shouldMergeToolCall,
  toolNamesCompatible,
} from './sessionStoreHelpers.ts';
import { updateMessage } from '../utils/historyDB';
import { usePermissionStore } from './permissionStore';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function toolSettleReason(value: unknown): ToolCall['settleReason'] | undefined {
  return value === 'idle' || value === 'interrupted' || value === 'runtime_idle'
    ? value
    : undefined;
}

function historyToolCallStatus(value: unknown, hasError: boolean): ToolCall['status'] {
  if (
    value === 'streaming_input'
    || value === 'pending'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value;
  }
  return hasError ? 'failed' : 'completed';
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function firstPresentValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function getPathValue(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    const record = asRecord(current);
    if (!hasOwn(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

// ─── Token usage helpers ───

export function addTokenUsage(acc: TokenUsage, usage?: Partial<TokenUsage>): TokenUsage {
  if (!usage) return acc;
  return {
    prompt: acc.prompt + (usage.prompt || 0),
    completion: acc.completion + (usage.completion || 0),
    total: acc.total + (usage.total || 0),
    cache_read: (acc.cache_read ?? 0) + (usage.cache_read || 0),
    cache_creation: (acc.cache_creation ?? 0) + (usage.cache_creation || 0),
    reasoning: (acc.reasoning ?? 0) + (usage.reasoning || 0),
    credit: (acc.credit ?? 0) + (usage.credit || 0),
  };
}

export function computeGlobalTokenUsage(
  agentConversations: Record<string, AgentConversation>,
  pendingTokens?: Record<string, TokenUsage>,
): TokenUsage {
  let total: TokenUsage = emptyTokenUsage();
  for (const conversation of Object.values(agentConversations)) {
    total = addTokenUsage(total, conversation.tokenUsage);
  }
  for (const pending of Object.values(pendingTokens || {})) {
    total = addTokenUsage(total, pending);
  }
  return total;
}

export function emptyTokenUsage(): TokenUsage {
  return { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0, reasoning: 0, credit: 0 };
}

export function emptySessionRuntimeState(): Partial<SessionState> {
  return {
    messages: [],
    phase: 'idle',
    agents: [],
    agentConversations: {},
    streamingLastActivityAt: Date.now(),
    tokenUsage: emptyTokenUsage(),
    leaderStatusText: '',
    lastCompressedAt: null,
    compactingProgress: null,
    contextRuntimeState: null,
    pendingPlan: null,
    activePlan: null,
    watchdogAlert: null,
    progressStagnant: null,
    orchestrationStatus: null,
    dagSnapshot: null,
    runExplanation: null,
    runtimeSnapshot: null,
    eventProcessorState: createEventProcessorState(),
    _pendingTokens: undefined,
    notifications: [],
    teamMessages: [],
    leaderQueueLength: 0,
    streamingToolName: undefined,
    controlMode: 'manual',
    permissionMode: undefined,
  };
}

// ─── Stream save throttle ───

export const streamSaveTimers = new Map<string, number>();
export const STREAM_SAVE_INTERVAL_MS = 3_000;

export function clearStreamSaveTimersForMessage(messageId: string | undefined): void {
  if (!messageId) return;
  streamSaveTimers.delete(messageId);
  streamSaveTimers.delete(`thinking_${messageId}`);
}

// ─── ContentBlock manipulation ───

export function appendContentBlock(blocks: ContentBlock[] | undefined, type: 'text' | 'thinking', text: string): ContentBlock[] | undefined {
  if (!text) return blocks;
  const next = [...(blocks || [])];
  const last = next[next.length - 1];
  if (last?.type === type) {
    next[next.length - 1] = { type, text: last.text + text };
  } else {
    next.push({ type, text });
  }
  return next;
}

export function replaceTextBlocks(blocks: ContentBlock[] | undefined, text: string): ContentBlock[] | undefined {
  const existing = blocks || [];
  const firstTextIndex = existing.findIndex((block) => block.type === 'text');
  const withoutText = existing.filter((block) => block.type !== 'text');
  if (!text) return withoutText.length ? withoutText : undefined;
  const insertIndex = firstTextIndex >= 0
    ? withoutText.filter((_, index) => index < firstTextIndex).length
    : withoutText.findIndex((block) => block.type !== 'thinking');
  const at = insertIndex >= 0 ? insertIndex : withoutText.length;
  const next: ContentBlock[] = [...withoutText];
  next.splice(at, 0, { type: 'text', text });
  return next;
}

export function replaceThinkingBlock(blocks: ContentBlock[] | undefined, thinking: string): ContentBlock[] | undefined {
  const existing = blocks || [];
  const withoutThinking = existing.filter((block) => block.type !== 'thinking');
  if (!thinking) return withoutThinking.length ? withoutThinking : undefined;
  return [{ type: 'thinking', text: thinking }, ...withoutThinking];
}

export function ensureToolCallBlocks(blocks: ContentBlock[] | undefined, toolCalls: ToolCall[] | undefined): ContentBlock[] | undefined {
  if (!toolCalls?.length) return blocks;
  const next = [...(blocks || [])];
  const covered = new Set(next.filter((block) => block.type === 'tool_call').map((block) => block.toolCallId));
  for (const toolCall of toolCalls) {
    if (!toolCall.id || covered.has(toolCall.id)) continue;
    next.push({ type: 'tool_call', toolCallId: toolCall.id });
    covered.add(toolCall.id);
  }
  return next.length ? next : undefined;
}

// ─── Assistant message segment helpers ───

export function applyAssistantTextSegment(message: Message, text: string, streaming = true): Message {
  if (!text) {
    return streaming ? { ...message, isStreaming: true, retrying: false, streamStartedAt: message.streamStartedAt ?? Date.now() } : message;
  }
  return {
    ...message,
    content: message.content + text,
    contentBlocks: appendContentBlock(message.contentBlocks, 'text', text),
    isStreaming: streaming ? true : message.isStreaming,
    retrying: false,
    streamStartedAt: message.streamStartedAt ?? Date.now(),
  };
}

export function applyAssistantThinkingSegment(message: Message, thinking: string, streaming = true): Message {
  if (!thinking) {
    return streaming ? { ...message, isStreaming: true, retrying: false, streamStartedAt: message.streamStartedAt ?? Date.now() } : message;
  }
  return {
    ...message,
    thinkingContent: (message.thinkingContent || '') + thinking,
    contentBlocks: appendContentBlock(message.contentBlocks, 'thinking', thinking),
    isStreaming: streaming ? true : message.isStreaming,
    retrying: false,
    streamStartedAt: message.streamStartedAt ?? Date.now(),
  };
}

export function finalizeAssistantMessage(message: Message, content?: string, reasoningContent?: string): Message {
  const rawContent = String(content || '');
  const parsed = splitThinkContent(rawContent);
  const finalText = parsed.sawThinkTag ? parsed.cleaned : rawContent;
  const finalThinking = String(reasoningContent || parsed.reasoning || '').trim();
  let next: Message = { ...message, isStreaming: false, retrying: false };
  if (finalText || (content !== undefined && parsed.sawThinkTag)) {
    next = { ...next, content: finalText, contentBlocks: replaceTextBlocks(next.contentBlocks, finalText) };
  }
  if (finalThinking) {
    next = { ...next, thinkingContent: finalThinking, contentBlocks: replaceThinkingBlock(next.contentBlocks, finalThinking) };
  }
  next = { ...next, contentBlocks: ensureToolCallBlocks(next.contentBlocks, next.toolCalls) };
  clearStreamSaveTimersForMessage(next.id);
  return next;
}

export function createFinalAssistantMessage(
  id: string, content: string, reasoningContent: string | undefined,
  toolCalls: ToolCall[] | undefined, timestamp: number,
): Message {
  return finalizeAssistantMessage(
    { id, role: 'assistant' as const, content: '', timestamp, isStreaming: false, retrying: false, toolCalls, contentBlocks: ensureToolCallBlocks(undefined, toolCalls) },
    content, reasoningContent,
  );
}

// ─── Agent message segment helpers ───

let msgIdCounter = 0;
export function nextMsgId(): number { return ++msgIdCounter; }

export function appendAgentTextSegment(messages: AgentMessage[], text: string): AgentMessage[] {
  if (!text) return messages;
  const msgs = [...messages];
  const last = msgs[msgs.length - 1];
  if (last && last.type === 'text' && last.isStreaming) {
    msgs[msgs.length - 1] = { ...last, content: last.content + text, isStreaming: true };
  } else {
    msgs.push({ id: `am-${nextMsgId()}`, type: 'text', content: text, timestamp: Date.now(), isStreaming: true });
  }
  return msgs;
}

export function appendAgentThinkingSegment(messages: AgentMessage[], thinking: string): AgentMessage[] {
  if (!thinking) return messages;
  const msgs = [...messages];
  const last = msgs[msgs.length - 1];
  if (last && last.type === 'thinking' && last.isStreaming) {
    msgs[msgs.length - 1] = { ...last, content: last.content + thinking, isStreaming: true };
  } else {
    msgs.push({ id: `ath-${nextMsgId()}`, type: 'thinking', content: thinking, timestamp: Date.now(), isStreaming: true });
  }
  return msgs;
}

export function findRecentAgentContentIndex(
  messages: AgentMessage[], type: 'text' | 'thinking', finalContent: string,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === type) {
      const sameStream = message.isStreaming === true;
      const sameFinal = !!finalContent
        && (finalContent.startsWith(message.content) || message.content.startsWith(finalContent));
      if (sameStream || sameFinal) return i;
      if (!sameStream) break;
    }
    if (message.type === 'status' || message.type === 'tool_call' || message.type === 'tool_result') break;
  }
  return -1;
}

export function findRecentAssistantIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return i;
    if (messages[i].role === 'user') break;
  }
  return -1;
}

export function isActiveAssistantDraft(message: Message | undefined): message is Message {
  return message?.role === 'assistant' && (message.isStreaming === true || message.retrying === true);
}

export function ensureStreamingAssistantMessage(messages: Message[]): { messages: Message[]; index: number } {
  const msgs = [...messages];
  const recentAssistantIndex = findRecentAssistantIndex(msgs);
  if (recentAssistantIndex >= 0) {
    const recent = msgs[recentAssistantIndex];
    if (isActiveAssistantDraft(recent)) {
      msgs[recentAssistantIndex] = { ...recent, isStreaming: true, retrying: false, streamStartedAt: recent.streamStartedAt ?? Date.now() };
      return { messages: msgs, index: recentAssistantIndex };
    }
  }
  msgs.push({ id: `msg-${nextMsgId()}`, role: 'assistant' as const, content: '', timestamp: Date.now(), isStreaming: true, streamStartedAt: Date.now() });
  return { messages: msgs, index: msgs.length - 1 };
}

export function ensureFinalAssistantMessage(messages: Message[]): { messages: Message[]; index: number } {
  const msgs = [...messages];
  const recentAssistantIndex = findRecentAssistantIndex(msgs);
  if (recentAssistantIndex >= 0 && isActiveAssistantDraft(msgs[recentAssistantIndex])) {
    return { messages: msgs, index: recentAssistantIndex };
  }
  msgs.push({ id: `msg-${nextMsgId()}`, role: 'assistant' as const, content: '', timestamp: Date.now(), isStreaming: false });
  return { messages: msgs, index: msgs.length - 1 };
}

// ─── Phase / state transition helpers ───

export function phaseForBusySignal(current: SessionPhase): SessionPhase {
  if (
    current === 'model_requesting' || current === 'streaming' || current === 'thinking'
    || current === 'tool_executing' || current === 'observing' || current === 'waiting_for_permission'
    || current === 'waiting_for_user' || current === 'retrying' || current === 'compacting'
    || current === 'cancelling'
  ) {
    return current;
  }
  return 'preparing';
}

/**
 * pendingStreamIsEmpty check — requires access to the pending stream state.
 * Passed as a callback from sseStore where the buffer lives.
 */
export function hasOpenSessionWork(
  state: SessionState,
  pendingStreamIsEmpty: boolean,
): boolean {
  const hasOpenLeaderMessage = state.messages.some((message) =>
    message.role === 'assistant'
    && (
      message.isStreaming === true
      || message.retrying === true
      || message.toolCalls?.some((toolCall) => isOpenToolCall(toolCall.status))
      || message.agentActivity?.some((activity) => isAgentActiveStatus(activity.status))
    )
  );
  const hasActiveAgents = state.agents.some((agent) => isAgentActiveStatus(agent.status))
    || Object.values(state.agentConversations).some((conversation) =>
      isAgentActiveStatus(conversation.status)
      || conversation.messages.some((message) =>
        message.isStreaming === true
        || (message.type === 'tool_call' && message.toolStatus !== undefined && isOpenToolCall(message.toolStatus as ToolCall['status']))
      )
    );
  const hasActiveRun = Boolean(
    state.orchestrationStatus
    && (state.orchestrationStatus.active || state.orchestrationStatus.busy || isRunActiveStatus(state.orchestrationStatus.state))
  );
  const hasCurrentPermission = usePermissionStore.getState().pendingRequests.some((request) =>
    !state.sessionId || request.sessionId === state.sessionId
  );
  return !pendingStreamIsEmpty
    || hasOpenLeaderMessage
    || hasActiveAgents
    || hasActiveRun
    || Boolean(state.pendingPlan)
    || hasCurrentPermission;
}

// ─── Leader tool call / state settling ───

export function settleOpenLeaderToolCalls(
  state: SessionState,
  status: Extract<ToolCall['status'], 'failed' | 'cancelled'>,
  settle?: LeaderSyntheticToolSettleResult,
): Partial<SessionState> {
  let changed = false;
  const endedAt = Date.now();
  const messages = state.messages.map((message) => {
    if (message.role !== 'assistant' || !message.toolCalls?.some((toolCall) => isOpenToolCall(toolCall.status))) {
      return message;
    }
    changed = true;
    const nextMessage = {
      ...message,
      isStreaming: false,
      retrying: false,
      toolCalls: message.toolCalls.map((toolCall) =>
        isOpenToolCall(toolCall.status)
          ? {
              ...toolCall,
              status,
              ...(settle ? {
                settleReason: settle.reason,
                settleDetail: settle.detail,
                displayStatus: settle.message,
              } : {}),
              endedAt: toolCall.endedAt ?? endedAt,
            }
          : toolCall
      ),
    };
    clearStreamSaveTimersForMessage(message.id);
    if (state.sessionId) { updateMessage(state.sessionId, nextMessage).catch(() => {}); }
    return nextMessage;
  });
  return changed ? { messages, streamingToolName: undefined } : {};
}

export type LeaderSyntheticToolSettleReason = 'idle' | 'interrupted' | 'runtime_idle';

export interface LeaderSyntheticToolSettleResult {
  kind: 'leader_tool_settle';
  reason: LeaderSyntheticToolSettleReason;
  detail: string;
  message: string;
}

export function createLeaderSyntheticToolSettleResult(
  reason: LeaderSyntheticToolSettleReason,
  detail: unknown,
): LeaderSyntheticToolSettleResult {
  const detailText = String(detail || reason);
  const message = reason === 'interrupted'
    ? `Leader stopped before this tool executed: ${detailText}`
    : reason === 'runtime_idle'
      ? `Runtime snapshot reported idle before this tool produced a final result: ${detailText}`
      : `Leader became idle before this tool produced a final result: ${detailText}`;
  return { kind: 'leader_tool_settle', reason, detail: detailText, message };
}

const LEGACY_LEADER_SYNTHETIC_TOOL_SETTLE_PREFIXES = [
  'Leader became idle before this tool produced a final result:',
  'Leader stopped before this tool executed:',
] as const;

export function isLeaderSyntheticToolSettleResult(result: unknown): boolean {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return (result as { kind?: unknown }).kind === 'leader_tool_settle';
  }
  if (typeof result !== 'string') return false;
  return LEGACY_LEADER_SYNTHETIC_TOOL_SETTLE_PREFIXES.some((prefix) =>
    result.slice(0, prefix.length) === prefix
  );
}

export function clearAssistantRetrying(messages: Message[]): Message[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || (!message.retrying && !message.error)) return message;
    changed = true;
    return { ...message, retrying: false, isStreaming: message.error ? false : message.isStreaming };
  });
  return changed ? next : messages;
}

export function settleLeaderIdlePlaceholders(state: SessionState): Partial<SessionState> {
  let changed = false;
  const messages = state.messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (message.toolCalls?.some((toolCall) => isOpenToolCall(toolCall.status))) return message;
    if (!message.isStreaming && !message.retrying) return message;
    changed = true;
    const nextMessage = { ...message, isStreaming: false, retrying: false };
    clearStreamSaveTimersForMessage(message.id);
    if (state.sessionId) { updateMessage(state.sessionId, nextMessage).catch(() => {}); }
    return nextMessage;
  });
  return changed ? { messages } : {};
}

export function settleRuntimeIdleResidue(
  state: SessionState,
  options: { cancelToolCalls?: boolean } = {},
): Partial<SessionState> {
  // cancelToolCalls=false 保留开放工具调用的状态不动。当存在 wait gate 时必须如此:普通的
  // 'waiting' gate 可能隐藏 ask_user(它在压缩后的快照里只表现为 leader.waitingForUser),
  // ask_user/permission/review 的工具调用正在等待用户,绝不能取消。此时仍清理纯显示用的
  // isStreaming/retrying 标志(那是卡住 UI 不肯进 idle 的真凶),但不动工具调用。
  const cancelToolCalls = options.cancelToolCalls !== false;
  const endedAt = Date.now();
  let messagesChanged = false;
  const messages = state.messages.map((message) => {
    if (message.role !== 'assistant') return message;
    let nextMessage = message;
    const hasOpenTools = message.toolCalls?.some((toolCall) => isOpenToolCall(toolCall.status)) ?? false;
    const hasActiveAgentActivity = message.agentActivity?.some((activity) => isAgentActiveStatus(activity.status)) ?? false;
    const needsStreamingClear = message.isStreaming || message.retrying || hasActiveAgentActivity;
    if (needsStreamingClear || (cancelToolCalls && hasOpenTools)) {
      messagesChanged = true;
      clearStreamSaveTimersForMessage(message.id);
      nextMessage = {
        ...nextMessage,
        isStreaming: false,
        retrying: false,
        agentActivity: nextMessage.agentActivity?.map((activity) =>
          isAgentActiveStatus(activity.status) ? { ...activity, status: 'completed' as const } : activity
        ),
        toolCalls: cancelToolCalls
          ? nextMessage.toolCalls?.map((toolCall) => {
            if (!isOpenToolCall(toolCall.status)) return toolCall;
            if (toolCall.result !== undefined) {
              return { ...toolCall, status: 'completed' as const, endedAt: toolCall.endedAt ?? endedAt };
            }
            const settle = createLeaderSyntheticToolSettleResult('runtime_idle', 'runtime snapshot idle');
            return {
              ...toolCall,
              status: 'cancelled' as const,
              settleReason: settle.reason,
              settleDetail: settle.detail,
              displayStatus: settle.message,
              endedAt: toolCall.endedAt ?? endedAt,
            };
          })
          : nextMessage.toolCalls,
      };
      if (state.sessionId) { updateMessage(state.sessionId, nextMessage).catch(() => {}); }
    }
    return nextMessage;
  });

  let agentsChanged = false;
  const agents = state.agents.map((agent) => {
    if (!isAgentActiveStatus(agent.status)) return agent;
    agentsChanged = true;
    return { ...agent, status: 'completed' as const };
  });

  let agentConversationsChanged = false;
  const agentConversations = Object.fromEntries(
    Object.entries(state.agentConversations).map(([agentId, conversation]) => {
      let conversationChanged = false;
      const convMessages = conversation.messages.map((message) => {
        const hasOpenTool = message.type === 'tool_call' && message.toolStatus !== undefined && isOpenToolCall(message.toolStatus as ToolCall['status']);
        if (!message.isStreaming && !hasOpenTool) return message;
        conversationChanged = true;
        return { ...message, isStreaming: false, toolStatus: hasOpenTool ? 'cancelled' as AgentMessage['toolStatus'] : message.toolStatus, endedAt: message.type === 'tool_call' ? (message.endedAt ?? endedAt) : message.endedAt };
      });
      const status = isAgentActiveStatus(conversation.status) ? 'completed' as AgentConversation['status'] : conversation.status;
      if (status !== conversation.status) conversationChanged = true;
      if (!conversationChanged) return [agentId, conversation];
      agentConversationsChanged = true;
      return [agentId, { ...conversation, status, messages: convMessages }];
    }),
  ) as Record<string, AgentConversation>;

  const patch: Partial<SessionState> = { streamingToolName: undefined };
  if (messagesChanged) patch.messages = messages;
  if (agentsChanged) patch.agents = agents;
  if (agentConversationsChanged) patch.agentConversations = agentConversations;
  return patch;
}

// ─── Conversation message merge / snapshot ───

function normalizeAssistantSnapshotText(value: string | undefined): string {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function hasSameToolCallShape(existing: ToolCall[] | undefined, incoming: ToolCall[] | undefined): boolean {
  if (!existing?.length || !incoming?.length) return false;
  return incoming.every((next) => existing.some((prev) =>
    prev.id === next.id || (prev.tool === next.tool && String(prev.input ?? '') === String(next.input ?? ''))
  ));
}

export function shouldMergeAssistantSnapshot(existing: Message, incoming: Message): boolean {
  if (existing.role !== 'assistant' || incoming.role !== 'assistant') return false;
  const existingText = normalizeAssistantSnapshotText(existing.content);
  const incomingText = normalizeAssistantSnapshotText(incoming.content);
  const existingThinking = normalizeAssistantSnapshotText(existing.thinkingContent);
  const incomingThinking = normalizeAssistantSnapshotText(incoming.thinkingContent);
  const sameText = existingText === incomingText;
  const sameThinking = existingThinking === incomingThinking;
  const sameToolShape = hasSameToolCallShape(existing.toolCalls, incoming.toolCalls);
  if (isActiveAssistantDraft(existing)) {
    if (incomingText && existingText && !incomingText.startsWith(existingText) && incomingText !== existingText) return false;
    return true;
  }
  if (existingText || incomingText) {
    return sameText && sameThinking;
  }
  return (!!existingThinking || !!incomingThinking) && sameThinking && sameToolShape;
}

export function mergeToolCallArrays(existing: ToolCall[], incoming: ToolCall[]): ToolCall[] {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  const out: ToolCall[] = [...existing];
  for (const next of incoming) {
    const idx = out.findIndex((prev) => shouldMergeToolCall(prev, next));
    if (idx >= 0) { out[idx] = mergeToolCall(out[idx], next); } else { out.push(next); }
  }
  return out;
}

export function mergeAssistantSnapshot(existing: Message, incoming: Message): Message {
  const existingTools = existing.toolCalls || [];
  const incomingTools = incoming.toolCalls || [];
  const mergedTools = mergeToolCallArrays(existingTools, incomingTools);
  const finalized = finalizeAssistantMessage(
    { ...existing, toolCalls: mergedTools.length ? mergedTools : undefined },
    incoming.content || existing.content,
    incoming.thinkingContent || existing.thinkingContent,
  );
  return { ...finalized, timestamp: existing.timestamp, isStreaming: false, retrying: false, toolCalls: mergedTools.length ? mergedTools : undefined };
}

// ─── Complete / idle UI state ───

export function completeSessionUiState(state: SessionState): Partial<SessionState> {
  const agentConversations = Object.fromEntries(
    Object.entries(state.agentConversations).map(([agentId, conversation]) => [
      agentId,
      isAgentTerminalStatus(conversation.status) ? conversation : { ...conversation, status: 'completed' as AgentConversation['status'] },
    ]),
  );
  return {
    phase: 'idle',
    leaderStatusText: '',
    runExplanation: null,
    streamingToolName: undefined,
    orchestrationStatus: isRunActiveStatus(state.orchestrationStatus?.state)
      ? { ...state.orchestrationStatus, active: false, state: 'completed', summary: 'completed', updatedAt: Date.now() }
      : state.orchestrationStatus,
    messages: state.messages.map((message) => {
      if (message.role !== 'assistant') return message;
      return { ...message, isStreaming: false, retrying: false, agentActivity: message.agentActivity?.map((activity) => isAgentActiveStatus(activity.status) ? { ...activity, status: 'completed' as const } : activity) };
    }),
    agents: state.agents.map((agent) => isAgentTerminalStatus(agent.status) ? agent : { ...agent, status: 'completed' as const }),
    agentConversations,
  };
}

export function completeAgentUiState(state: SessionState, agentId: string): Partial<SessionState> {
  const conv = state.agentConversations[agentId];
  const agentConversations = conv
    ? {
        ...state.agentConversations,
        [agentId]: {
          ...conv,
          status: 'completed' as AgentConversation['status'],
          messages: conv.messages.map((message) =>
            message.isStreaming || message.toolStatus === 'running' || message.toolStatus === 'streaming_input'
              ? { ...message, isStreaming: false, toolStatus: message.type === 'tool_call' ? 'completed' as AgentMessage['toolStatus'] : message.toolStatus, endedAt: message.type === 'tool_call' ? (message.endedAt ?? Date.now()) : message.endedAt }
              : message
          ),
        },
      }
    : state.agentConversations;
  const agents = state.agents.map((agent) => agent.agentId === agentId ? { ...agent, status: 'completed' as const } : agent);
  const messages = state.messages.map((message) => {
    if (message.role !== 'assistant' || !message.agentActivity?.length) return message;
    return { ...message, agentActivity: message.agentActivity.map((activity) => activity.agentId === agentId ? { ...activity, status: 'completed' as const } : activity) };
  });
  return { agents, agentConversations, messages };
}

// ─── Runtime snapshot coercion / patching ───

export function coerceEternalRuntimeSnapshot(raw: unknown): SessionRuntimeSnapshot['eternal'] {
  const data = asRecord(raw);
  const status = typeof data.status === 'string' ? data.status : '';
  const knownStatus = (status === 'ready' || status === 'paused' || status === 'waiting' || status === 'patrolling' || status === 'silenced' || status === 'budget_exhausted' || status === 'circuit_open' || status === 'disabled') ? status : 'disabled';
  const outcome = data.lastPatrolOutcome === 'productive' || data.lastPatrolOutcome === 'idle' ? data.lastPatrolOutcome : 'never';
  const goalData = asRecord(data.goal);
  const goal = typeof goalData.description === 'string'
    ? { description: goalData.description, paused: Boolean(goalData.paused), createdAt: Number(goalData.createdAt || 0), updatedAt: Number(goalData.updatedAt || 0) }
    : null;
  return {
    enabled: Boolean(data.enabled),
    status: knownStatus,
    goal,
    currentPatrolIntervalMs: Number(data.currentPatrolIntervalMs || 0),
    consecutiveIdlePatrols: Number(data.consecutiveIdlePatrols || 0),
    lastPatrolAtMs: Number(data.lastPatrolAtMs || 0),
    nextPatrolDueAtMs: Number(data.nextPatrolDueAtMs || 0),
    currentWindowTokens: Number(data.currentWindowTokens || 0),
    tokenBudgetPerHour: Number(data.tokenBudgetPerHour || 0),
    windowStartMs: Number(data.windowStartMs || 0),
    consecutiveApiFailures: Number(data.consecutiveApiFailures || 0),
    circuitOpenUntilMs: Number(data.circuitOpenUntilMs || 0),
    totalPatrols: Number(data.totalPatrols || 0),
    silenceLockEngaged: Boolean(data.silenceLockEngaged),
    lastPatrolOutcome: outcome,
    workerCompletionCount: Number(data.workerCompletionCount || 0),
    patrolInFlight: Boolean(data.patrolInFlight),
    lastFingerprintKnown: Boolean(data.lastFingerprintKnown),
  };
}

function defaultCapabilityIntentProfile(): SessionRuntimeSnapshot['modes']['intentProfile'] {
  return {
    primaryIntent: 'diagnose',
    scope: { kind: 'read_only' },
    phase: 'understand',
    grants: ['read'],
    denies: ['write', 'shell', 'task', 'dispatch'],
    requiredGates: ['confirm_before_write', 'confirm_before_command', 'confirm_before_dispatch', 'confirm_before_workflow_apply', 'confirm_before_scope_expansion'],
    constraints: { maxRisk: 'low', requireEvidence: false },
    confidence: 0,
    reason: 'intent_profile_not_recorded',
    turnId: null,
    recordedAt: 0,
    source: 'runtime_default',
  };
}

function coerceStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}

function coerceCapabilityIntentProfile(raw: unknown): SessionRuntimeSnapshot['modes']['intentProfile'] {
  const record = asRecord(raw);
  const scope = asRecord(record.scope);
  const primaryIntent = stringValue(record.primaryIntent) as SessionRuntimeSnapshot['modes']['intentProfile']['primaryIntent'] | undefined;
  const phase = stringValue(record.phase) as SessionRuntimeSnapshot['modes']['intentProfile']['phase'] | undefined;
  const scopeKind = stringValue(scope.kind) as SessionRuntimeSnapshot['modes']['intentProfile']['scope']['kind'] | undefined;
  const reason = stringValue(record.reason);
  if (!primaryIntent || !phase || !scopeKind || !reason) return defaultCapabilityIntentProfile();
  return {
    primaryIntent,
    scope: {
      kind: scopeKind,
      paths: coerceStringArray(scope.paths),
      surfaces: coerceStringArray(scope.surfaces),
      taskIds: coerceStringArray(scope.taskIds),
      subsystemIds: coerceStringArray(scope.subsystemIds),
      externalTargets: coerceStringArray(scope.externalTargets),
    },
    phase,
    grants: coerceStringArray(record.grants) as SessionRuntimeSnapshot['modes']['intentProfile']['grants'],
    denies: coerceStringArray(record.denies) as SessionRuntimeSnapshot['modes']['intentProfile']['denies'],
    requiredGates: coerceStringArray(record.requiredGates) as SessionRuntimeSnapshot['modes']['intentProfile']['requiredGates'],
    constraints: asRecord(record.constraints) as SessionRuntimeSnapshot['modes']['intentProfile']['constraints'],
    confidence: Math.max(0, Math.min(1, numberValue(record.confidence) ?? 0)),
    reason,
    turnId: numberValue(record.turnId) ?? null,
    recordedAt: numberValue(record.recordedAt) ?? 0,
    source: stringValue(record.source) ?? 'record_capability_intent',
  };
}

function coerceAutonomyDecisionTrace(raw: unknown): SessionRuntimeSnapshot['modes']['lastDecisionTrace'] {
  const record = asRecord(raw);
  const decision = asRecord(record.decision);
  const toolName = stringValue(record.toolName);
  const recordedAt = numberValue(record.recordedAt);
  const gateResult = record.gateResult === 'allow' || record.gateResult === 'blocked' || record.gateResult === 'confirmation_required'
    ? record.gateResult
    : null;
  if (!toolName || recordedAt === undefined || !gateResult || Object.keys(decision).length === 0) return null;
  return {
    toolName,
    decision: decision as NonNullable<SessionRuntimeSnapshot['modes']['lastDecisionTrace']>['decision'],
    gateResult,
    gateKind: record.gateKind === 'forbidden' || record.gateKind === 'confirmation_required' ? record.gateKind : null,
    recordedAt,
    source: stringValue(record.source) ?? 'leader_tool_gate',
  };
}

function coerceSessionModeRuntimeProjection(raw: unknown, leader: Record<string, unknown>): SessionRuntimeSnapshot['modes'] {
  const modes = asRecord(raw);
  const route = asRecord(modes.route);
  const collaboration = asRecord(modes.collaboration);
  const workflow = asRecord(modes.workflow);
  const blackboard = asRecord(modes.blackboard);
  const permission = asRecord(modes.permission);
  const controlMode = modes.controlMode === 'eternal' ? 'eternal' : 'manual';
  const routeMode = route.mode === 'direct' || route.mode === 'hybrid' || route.mode === 'delegate' || route.mode === 'unknown'
    ? route.mode
    : stringValue(leader.executionMode) === 'direct' || stringValue(leader.executionMode) === 'hybrid' || stringValue(leader.executionMode) === 'delegate'
      ? stringValue(leader.executionMode) as 'direct' | 'hybrid' | 'delegate'
      : 'direct';
  const routePreference = route.preference === 'direct' || route.preference === 'hybrid' || route.preference === 'delegate'
    ? route.preference
    : 'auto';
  const collaborationMode = collaboration.mode === 'team' ? 'team' : 'solo';
  const collaborationSource = collaboration.source === 'explicit' || collaboration.source === 'legacy' ? collaboration.source : 'default';
  const blackboardMode = blackboard.mode === 'summary' || blackboard.mode === 'full' ? blackboard.mode : 'off';
  const blackboardSource =
    blackboard.source === 'explicit' ||
    blackboard.source === 'team' ||
    blackboard.source === 'workflow' ||
    blackboard.source === 'contract_bound'
      ? blackboard.source
      : 'default';
  const permissionMode =
    permission.mode === 'strict' ||
    permission.mode === 'dev' ||
    permission.mode === 'networked' ||
    permission.mode === 'yolo'
      ? permission.mode
      : 'yolo';
  const autonomy = modes.autonomy === 'review_first' || modes.autonomy === 'autonomous'
    ? modes.autonomy
    : 'balanced';
  const intentProfile = coerceCapabilityIntentProfile(modes.intentProfile);
  const lifecyclePhase = modes.lifecyclePhase === 'active' || modes.lifecyclePhase === 'recovery' || modes.lifecyclePhase === 'stable'
    ? modes.lifecyclePhase
    : 'bootstrap';
  const modeGeneration = (() => {
    const n = numberValue(modes.modeGeneration);
    return n !== undefined && n >= 1 ? Math.trunc(n) : 1;
  })();

  return {
    controlMode,
    route: {
      mode: routeMode,
      preference: routePreference,
      reason: stringValue(route.reason),
      source: route.source === 'leader' || route.source === 'session' ? route.source : 'default',
    },
    collaboration: {
      mode: collaborationMode,
      source: collaborationSource,
      activeTeamName: typeof collaboration.activeTeamName === 'string' ? collaboration.activeTeamName : null,
      teamEnabled: Boolean(collaboration.teamEnabled),
    },
    workflow: {
      enabled: Boolean(workflow.enabled),
      activeExecutionCount: numberValue(workflow.activeExecutionCount) ?? 0,
    },
    blackboard: {
      mode: blackboardMode,
      source: blackboardSource,
    },
    permission: {
      mode: permissionMode,
      summary: stringValue(permission.summary),
    },
    blueprint: (modes.blueprint ?? null) as ProjectBlueprint | null,
    autonomy,
    intentProfile,
    lifecyclePhase,
    modeGeneration,
    policyId: stringValue(modes.policyId) ?? null,
    policyHash: stringValue(modes.policyHash) ?? null,
    lastDecisionTrace: coerceAutonomyDecisionTrace(modes.lastDecisionTrace),
  };
}

export function coerceSessionRuntimeSnapshot(raw: unknown): SessionRuntimeSnapshot | null {
  const rawRecord = asRecord(raw);
  const runtimeState = Object.keys(asRecord(rawRecord.runtimeState)).length > 0 ? asRecord(rawRecord.runtimeState) : rawRecord;
  if (!runtimeState.sessionId) return null;
  const leader = asRecord(runtimeState.leader);
  const pendingInput = asRecord(runtimeState.pendingUserInput);
  const pendingKind = pendingInput.kind === 'empty' || pendingInput.kind === 'message' || pendingInput.kind === 'permission_request' || pendingInput.kind === 'plan_review' || pendingInput.kind === 'unknown'
    ? pendingInput.kind
    : undefined;
  const workerFacts = deriveRuntimeWorkerFacts<SessionRuntimeWorkerSummary>(runtimeState);
  const recoveringTasks = Array.isArray(runtimeState.recoveringTasks)
    ? runtimeState.recoveringTasks
        .map((record) => {
          const entry = asRecord(record);
          return {
            taskId: String(entry.taskId || ''),
            agentName: String(entry.agentName || ''),
            category: String(entry.category || ''),
            faultClass: String(entry.faultClass || ''),
            recoveryAction: String(entry.recoveryAction || ''),
            ...(numberValue(entry.lastActivityAt) !== undefined ? { lastActivityAt: numberValue(entry.lastActivityAt) } : {}),
          };
        })
        .filter((record) => record.taskId && record.agentName && record.category && record.faultClass && record.recoveryAction)
    : [];
  const recoveringTaskCount = numberValue(runtimeState.recoveringTaskCount) ?? recoveringTasks.length;
  return {
    sessionId: String(runtimeState.sessionId),
    workspace: String(runtimeState.workspace || ''),
    sessionStatus: String(runtimeState.sessionStatus || 'active'),
    modes: coerceSessionModeRuntimeProjection(runtimeState.modes, leader),
    leader: {
      running: Boolean(leader.running),
      busy: Boolean(leader.busy),
      finished: Boolean(leader.finished),
      waitingForUser: Boolean(leader.waitingForUser),
      pendingReview: Boolean(leader.pendingReview),
      planApproved: Boolean(leader.planApproved),
      executionMode: stringValue(leader.executionMode),
      executionReason: stringValue(leader.executionReason),
      permissionSummary: stringValue(leader.permissionSummary),
      leaderModel: stringValue(leader.leaderModel) || undefined,
      agentModel: stringValue(leader.agentModel) || undefined,
    },
    pendingUserInput: Object.keys(pendingInput).length > 0
      ? { raw: pendingInput.raw, kind: pendingKind, preview: stringValue(pendingInput.preview) }
      : undefined,
    runningWorkers: workerFacts.runningWorkers,
    runningWorkerCount: workerFacts.runningWorkerCount,
    hasRunningWorkers: workerFacts.hasRunningWorkers,
    recoveringTasks,
    recoveringTaskCount,
    hasRecoveringTasks: Boolean(runtimeState.hasRecoveringTasks ?? recoveringTaskCount > 0),
    dispatchableTaskCount: numberValue(runtimeState.dispatchableTaskCount) ?? 0,
    hasDispatchableTasks: Boolean(runtimeState.hasDispatchableTasks),
    allTasksTerminal: Boolean(runtimeState.allTasksTerminal),
    eternal: coerceEternalRuntimeSnapshot(runtimeState.eternal),
  };
}

export type AgentResyncConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface AgentResyncAccumulator {
  /** True once at least one 'connected' has been observed in this connection lifecycle. */
  hasConnectedOnce: boolean;
}

/**
 * Decide whether a full agent-history resync should fire on a connection-state
 * transition, returning the (possibly updated) accumulator alongside the decision.
 *
 * WHY this is its own function: sseStore previously gated the post-reconnect
 * agent-history refetch on `previousState === 'reconnecting' || 'disconnected'`.
 * That gate was defeated by the state sequence AcpClient emits on EVERY reconnect:
 *
 *   watchdog / visibilitychange / 401 → 'connecting' (startSse) → 'connected'
 *
 * The intermediate 'connecting' overwrote previousState, so by the time 'connected'
 * arrived the gate no longer matched — and visibilitychange-driven reconnects go
 * straight connecting→connected with no 'reconnecting' at all. After any silent
 * mid-session reconnect the agent panel was therefore never re-hydrated (the server
 * SSE sends only {method:'connected'}, no agent snapshot), so it froze on stale
 * state until a manual page refresh (connectToSession has its own /agents hydrate).
 *
 * "Has the client connected once before?" is the only signal that separates the
 * initial connect (connectToSession already hydrates agents → skip) from every
 * subsequent reconnect (must refetch). The accumulator is reset on session
 * switch / connect / disconnect via clearPendingStreamBuffers.
 */
export function applyConnectionStateForResync(
  acc: AgentResyncAccumulator,
  state: AgentResyncConnectionState,
): { resync: boolean; acc: AgentResyncAccumulator } {
  if (state === 'connected') {
    return { resync: acc.hasConnectedOnce, acc: { hasConnectedOnce: true } };
  }
  return { resync: false, acc };
}

export function applyRuntimeSnapshotPatch(
  state: SessionState,
  snapshot: SessionRuntimeSnapshot,
  pendingStreamIsEmptyCheck: boolean,
): Partial<SessionState> {
  const busy = runtimeImpliesBusy({ runtimeState: snapshot });
  const runningWorkers = snapshot.runningWorkers || [];
  const runningIds = new Set(runningWorkers.map((worker) => worker.agentId));
  // 快照声明 not-busy 时,leader 消息上的 isStreaming/retrying 是陈旧显示残留(本轮输出已结束),
  // 必须清理才能让 UI 退出"处理中"——与 TUI 一致(它只按快照 runtimeActive 判 idle,不卡逐消息标志)。
  // 之前对「存在 wait gate」一律跳过清理,导致正常轮次结束(waiting gate)时占位消息永远
  // isStreaming=true → hasOpenSessionWork() 恒真 → phase 永不回 idle(只能刷新页面重连恢复)。
  // 工具调用仅在「无任何 wait gate」时才取消:waiting gate 可能隐藏 ask_user(压缩后快照里只
  // 表现为 leader.waitingForUser),其工具调用正在等待用户,绝不能被误取消。
  const waitGate = deriveRuntimeWaitGate(snapshot);
  const idleResiduePatch = !busy
    ? settleRuntimeIdleResidue(state, { cancelToolCalls: waitGate === null })
    : {};
  const baseState = { ...state, ...idleResiduePatch } as SessionState;
  const agentsById = new Map<string, AgentRuntime>(baseState.agents.map((agent) => [agent.agentId, agent]));

  for (const worker of runningWorkers) {
    const existing = agentsById.get(worker.agentId);
    agentsById.set(worker.agentId, {
      agentId: worker.agentId,
      agentName: existing?.agentName || worker.name || worker.agentId,
      role: existing?.role || worker.roleType || 'worker',
      status: 'running',
      taskId: existing?.taskId ?? worker.taskId,
      workingDirectory: existing?.workingDirectory,
      writeScope: existing?.writeScope,
      backend: existing?.backend,
      visibility: existing?.visibility ?? worker.visibility,
      owner: existing?.owner ?? worker.owner,
      interactive: existing?.interactive ?? worker.interactive,
      persistAcrossTurns: existing?.persistAcrossTurns ?? worker.persistAcrossTurns,
      teamMember: existing?.teamMember ?? worker.teamMember,
      externalSessionId: existing?.externalSessionId,
      pid: existing?.pid,
      spawnedAt: existing?.spawnedAt ?? worker.lastActivity ?? Date.now(),
    });
  }

  const noWorkersRemain = !snapshot.hasRunningWorkers && snapshot.runningWorkerCount === 0;
  if (noWorkersRemain && !busy) {
    for (const [agentId, agent] of agentsById) {
      if (runningIds.has(agentId) || !isAgentActiveStatus(agent.status)) continue;
      agentsById.set(agentId, { ...agent, status: 'completed' });
    }
  }

  const agentConversations: Record<string, AgentConversation> = { ...baseState.agentConversations };
  for (const worker of runningWorkers) {
    const existing = agentConversations[worker.agentId];
    if (!existing) {
      agentConversations[worker.agentId] = { agentId: worker.agentId, agentName: worker.name || worker.agentId, role: worker.roleType || 'worker', status: 'running', taskId: worker.taskId, messages: [] };
    } else {
      // runningWorkers is a backend liveness fact from the active AgentPool. It must
      // override a stale optimistic terminal status left by stopAgent(); otherwise a
      // stopped agent that is respawned keeps rendering as interrupted even though
      // the runtime snapshot already proves it is running again.
      agentConversations[worker.agentId] = { ...existing, agentName: existing.agentName || worker.name || worker.agentId, role: existing.role || worker.roleType || 'worker', status: 'running', taskId: existing.taskId ?? worker.taskId };
    }
  }
  if (noWorkersRemain && !busy) {
    for (const [agentId, conversation] of Object.entries(agentConversations)) {
      if (runningIds.has(agentId) || !isAgentActiveStatus(conversation.status)) continue;
      agentConversations[agentId] = { ...conversation, status: 'completed' };
    }
  }

  const nextStateForIdleCheck = { ...baseState, agents: Array.from(agentsById.values()), agentConversations, runtimeSnapshot: snapshot } as SessionState;
  const terminalStatus = normalizeRunStatus(snapshot.sessionStatus);
  const phase =
    terminalStatus === 'completed' ? 'done'
      : terminalStatus === 'failed' ? 'error'
        : terminalStatus === 'cancelled' ? 'interrupted'
          : busy ? phaseForBusySignal(state.phase)
            : !hasOpenSessionWork(nextStateForIdleCheck, pendingStreamIsEmptyCheck) ? 'idle' : state.phase;

  return {
    runtimeSnapshot: snapshot,
    agents: Array.from(agentsById.values()),
    agentConversations,
    phase,
    messages: baseState.messages,
    controlMode: snapshot.modes.controlMode,
    blueprint: snapshot.modes.blueprint ?? null,
    permissionMode: snapshot.modes.permission.mode,
    pendingPlan: snapshot.eternal.enabled ? null : baseState.pendingPlan,
    leaderStatusText: !busy && phase === 'idle' ? '' : baseState.leaderStatusText,
    streamingToolName: !busy ? undefined : baseState.streamingToolName,
    sessions: baseState.sessions.map((session) =>
      session.id === snapshot.sessionId
        ? { ...session, status: snapshot.sessionStatus, workspace: snapshot.workspace || session.workspace, runtimeSnapshot: snapshot }
        : session
    ),
  };
}

// ─── History normalization ───

export function normalizeHistoryToolCalls(rawToolCalls: unknown, rowIndex: number, toolResultMap: Map<string, unknown>): ToolCall[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return undefined;
  return rawToolCalls.map((rawToolCall, j: number) => {
    const tc = asRecord(rawToolCall);
    const fn = asRecord(tc.function);
    const toolCallId = stringValue(tc.id);
    const id = toolCallId ?? `tc-${rowIndex}-${j}`;
    const tool = stringValue(fn.name) ?? stringValue(tc.name) ?? stringValue(tc.tool) ?? 'unknown';
    const input = firstPresentValue(
      hasOwn(fn, 'arguments') ? fn.arguments : undefined,
      hasOwn(tc, 'input') ? tc.input : undefined,
      hasOwn(tc, 'arguments') ? tc.arguments : undefined,
      '',
    );
    const result = hasOwn(tc, 'result') ? tc.result : (toolCallId ? toolResultMap.get(toolCallId) : undefined);
    const status = historyToolCallStatus(tc.status, Boolean(tc.error));
    const settleReason = toolSettleReason(tc.settleReason);
    const settleDetail = stringValue(tc.settleDetail);
    const displayStatus = stringValue(tc.displayStatus);
    return {
      id,
      tool,
      input,
      result,
      status,
      ...(settleReason ? { settleReason } : {}),
      ...(settleDetail ? { settleDetail } : {}),
      ...(displayStatus ? { displayStatus } : {}),
    } satisfies ToolCall;
  });
}

export function normalizeCachedMessages(messages: Message[]): Message[] {
  if (!messages.length) return messages;
  let mutated = false;
  const next = messages.map((message, idx) => {
    if (message.role !== 'assistant') return message;
    let nextMessage = message;
    const parsed = splitThinkContent(message.content || '');
    const effectiveContent = parsed.sawThinkTag ? parsed.cleaned : message.content;
    const effectiveThinking = String(message.thinkingContent || parsed.reasoning || '').trim();
    const hasBlocks = !!message.contentBlocks?.length;
    const hasTextBlock = !!message.contentBlocks?.some((block) => block.type === 'text' && block.text);
    const hasThinkingBlock = !!message.contentBlocks?.some((block) => block.type === 'thinking' && block.text);
    const missingVisibleTextBlock = !!effectiveContent && !hasTextBlock;
    const missingThinkingBlock = !!effectiveThinking && !hasThinkingBlock;
    const missingToolBlocks = !!message.toolCalls?.some((toolCall) =>
      !message.contentBlocks?.some((block) => block.type === 'tool_call' && block.toolCallId === toolCall.id)
    );
    if (parsed.sawThinkTag || missingVisibleTextBlock || missingThinkingBlock || missingToolBlocks) {
      nextMessage = finalizeAssistantMessage(message, effectiveContent, effectiveThinking || undefined);
      mutated = mutated || nextMessage !== message;
    }
    if (!nextMessage.toolCalls?.length) return nextMessage;
    const isLastAssistantStreaming = idx === messages.length - 1 && nextMessage.isStreaming === true;
    let toolMutated = false;
    const toolCalls = nextMessage.toolCalls.map((tc) => {
      if (!isOpenToolCall(tc.status)) return tc;
      const hasResult = tc.result !== undefined && tc.result !== null && tc.result !== '';
      if (isLastAssistantStreaming && !hasResult) return tc;
      toolMutated = true;
      return { ...tc, status: 'completed' as const, endedAt: tc.endedAt ?? nextMessage.timestamp ?? Date.now() };
    });
    if (!toolMutated) return nextMessage;
    mutated = true;
    return { ...nextMessage, isStreaming: false, retrying: false, toolCalls };
  });
  return mutated ? next : messages;
}

// ─── SSE event session ID extraction ───

export function extractEventSessionId(data: unknown, update: unknown): string | undefined {
  const candidates = [
    getPathValue(data, ['sessionId']),
    getPathValue(data, ['session_id']),
    getPathValue(data, ['params', 'sessionId']),
    getPathValue(data, ['params', 'session_id']),
    getPathValue(update, ['sessionId']),
    getPathValue(update, ['session_id']),
    getPathValue(update, ['params', 'sessionId']),
    getPathValue(update, ['params', 'session_id']),
    getPathValue(update, ['task', 'sessionId']),
    getPathValue(update, ['task', 'session_id']),
    getPathValue(update, ['dag', 'sessionId']),
    getPathValue(update, ['dag', 'session_id']),
    getPathValue(update, ['explanation', 'sessionId']),
    getPathValue(update, ['explanation', 'session_id']),
    getPathValue(update, ['message', 'sessionId']),
    getPathValue(update, ['message', 'session_id']),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
