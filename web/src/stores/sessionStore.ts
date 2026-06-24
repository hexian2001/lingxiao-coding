import { create } from 'zustand';
import { splitThinkContent, splitThinkStreamingChunk } from '@contracts/adapters/ThinkContent';
import { createEventProcessorState } from '@contracts/adapters/EventAdapter';
import { acpClient } from '../api/AcpClient';
import { getServerToken, tryRecoverToken } from '../api/headers';
import { saveMessages, appendMessage, updateMessage, loadMessages } from '../utils/historyDB';
import {
  extractText,
  isOpenToolCall,
  isToolCallTerminalStatus,
  mergeAgentHistoryIntoState,
  mergeToolCall,
  normalizeAgentSnapshotMap,
  runtimeImpliesBusy,
  shouldMergeToolCall,
  toolNamesCompatible,
  trimMessageWindow,
  pruneAgentConversations,
  pruneAgents,
} from './sessionStoreHelpers.ts';
export type {
  AgentActivity,
  AgentRuntime,
  AgentConversation,
  AgentMessage,
  ContentBlock,
  CreateSessionResponse,
  HistoryMessageRow,
  Message,
  SessionInfo,
  SessionListRow,
  SessionPhase,
  SessionState,
  TokenUsage,
  ToolCall,
  TeamMessageItem,
} from './sessionStoreTypes.ts';
import { type AgentConversation, type AgentMessage, type AgentRuntime, type CreateSessionResponse, type HistoryMessageRow, type Message, type SessionInfo, type SessionListRow, type SessionRuntimeSnapshot, type SessionState, type TokenUsage, type ToolCall } from './sessionStoreTypes.ts';
import { createTokenActions } from './sessionStoreTokens';
import { usePermissionStore } from './permissionStore';
import { useBlackboardStore } from './blackboardStore';
import { useGitStore } from './gitStore';
import { useGitActivityStore } from './gitActivityStore';
import { useAgentActivityStore } from './agentActivityStore';
import { loadLastSelectedSessionId, saveLastSelectedSessionId } from '../utils/sessionListViewModel';
import {
  appendAgentTextSegment,
  appendAgentThinkingSegment,
  applyAssistantTextSegment,
  applyAssistantThinkingSegment,
  applyRuntimeSnapshotPatch,
  coerceSessionRuntimeSnapshot,
  createFinalAssistantMessage,
  emptySessionRuntimeState,
  ensureFinalAssistantMessage,
  ensureStreamingAssistantMessage,
  finalizeAssistantMessage,
  findRecentAgentContentIndex,
  isLeaderSyntheticToolSettleResult,
  nextMsgId,
  normalizeHistoryToolCalls,
  normalizeCachedMessages,
  phaseForBusySignal,
  streamSaveTimers,
  STREAM_SAVE_INTERVAL_MS,
} from './streamMergeUtils';
import {
  clearPendingStreamBuffers,
  flushStreamBuffers,
  getAgentThinkStreamState,
  getLeaderThinkStreamState,
  markStreamingActivity,
  ensureStreamingWatchdog,
  pendingStreamIsEmpty,
  resetThinkStreamState,
  shouldAcceptIdleTransition,
  syncRuntimeSnapshotFromAcp,
  _injectSessionStore,
} from './sseStore';

// Re-export SSE utilities that are used by external components
export { subscribeTaskUpdates, applyRuntimeSnapshotFromRpcResult } from './sseStore';

// ─── Connection mutex ───
let connectingSessionId: string | null = null;
let connectAbortController: AbortController | null = null;
let streamingTimer: ReturnType<typeof setTimeout> | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function lingxiaoWindow(): Window & { __lingxiao_401_warned?: boolean } {
  return window;
}

function historyRowId(fallback: number): string {
  return String(fallback);
}

function historyTimestampMs(value: unknown): number {
  const seconds = typeof value === 'number' && Number.isFinite(value)
    ? value
    : Date.now() / 1000;
  return seconds * 1000;
}

function normalizeThinkingText(thinking: unknown): string | undefined {
  if (!Array.isArray(thinking) || thinking.length === 0) return undefined;
  return thinking
    .map((block) => {
      const record = asRecord(block);
      return record.type === 'thinking' ? String(record.text || '') : '[redacted]';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeSessionInfoRow(raw: SessionListRow): SessionInfo {
  const row = asRecord(raw);
  const createdAt = numberValue(row.created_at) ?? Date.now() / 1000;
  return {
    id: stringValue(row.id) ?? '',
    workspace: stringValue(row.workspace) ?? '',
    status: stringValue(row.status) ?? 'active',
    createdAt,
    created_at: createdAt,
    summary: stringValue(row.summary),
    isActive: booleanValue(row.isActive) ?? false,
    runtimeSnapshot: coerceSessionRuntimeSnapshot(row),
    name: stringValue(row.name),
  };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: null,
  sessions: [],
  activeSessionId: null,
  messages: [],
  phase: 'idle',
  agents: [],
  agentConversations: {},
  isConnected: false,
  isLoadingHistory: false,
  streamingLastActivityAt: Date.now(),
  streamingWatchdogInterval: null,
  tokenUsage: { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0, reasoning: 0, credit: 0 },
  lastCompressedAt: null,
  compactingProgress: null,
  contextRuntimeState: null,
  pendingPlan: null,
  serverCwd: '',
  watchdogAlert: null,
  progressStagnant: null,
  leaderStatusText: '',
  orchestrationStatus: null,
  dagSnapshot: null,
  runExplanation: null,
  runtimeSnapshot: null,
  eventProcessorState: createEventProcessorState(),
  sessionsLoaded: false,
  teamMessages: [],
  controlMode: 'manual',
  permissionMode: undefined,
  resyncAlert: null,
  dismissResyncAlert: () => set({ resyncAlert: null }),

  setSessionId: (id) => {
    clearPendingStreamBuffers();
    set({ sessionId: id, ...emptySessionRuntimeState() });
    // 切换活动会话:清空黑板图(旧会话的图属另一 session,不能带到新会话——#4)
    useBlackboardStore.getState().reset();
  },
  setSessions: (sessions) => set({ sessions }),

  addMessage: (msg) => set((s) => {
    const saved = { ...msg, id: msg.id || String(nextMsgId()) };
    // 调试：记录消息添加来源
    if (import.meta.env.DEV && msg.role === 'user') {
      console.log('[addMessage] Adding user message:', {
        id: saved.id,
        content: saved.content.substring(0, 50),
        timestamp: saved.timestamp,
        stack: new Error().stack?.split('\n').slice(2, 5).join('\n'),
      });
    }
    const next = trimMessageWindow([...s.messages, saved]);
    if (s.sessionId) appendMessage(s.sessionId, saved).catch(() => {});
    return { messages: next };
  }),

  updateLastMessage: (content, reasoningContent) => set((s) => {
    const { messages: msgs, index } = ensureFinalAssistantMessage(s.messages);
    msgs[index] = finalizeAssistantMessage(msgs[index], content, reasoningContent);
    if (s.sessionId) updateMessage(s.sessionId, msgs[index]).catch(() => {});
    return { messages: msgs };
  }),

  appendToLastMessage: (chunk) => set((s) => {
    const leaderState = getLeaderThinkStreamState();
    const split = splitThinkStreamingChunk(chunk, leaderState.inThinking, leaderState.pendingTag);
    leaderState.inThinking = split.inThinking;
    leaderState.pendingTag = split.pendingTag;
    const { messages: msgs, index } = ensureStreamingAssistantMessage(s.messages);
    let nextMessage = msgs[index];
    for (const segment of split.segments) {
      nextMessage = segment.type === 'thinking'
        ? applyAssistantThinkingSegment(nextMessage, segment.text)
        : applyAssistantTextSegment(nextMessage, segment.text);
    }
    if (split.segments.length === 0) {
      nextMessage = { ...nextMessage, isStreaming: true, retrying: false, streamStartedAt: nextMessage.streamStartedAt ?? Date.now() };
    }
    msgs[index] = nextMessage;
    if (s.sessionId) {
      const now = Date.now();
      const lastSave = streamSaveTimers.get(msgs[index].id) || 0;
      if (now - lastSave > STREAM_SAVE_INTERVAL_MS) {
        streamSaveTimers.set(msgs[index].id, now);
        updateMessage(s.sessionId, msgs[index]).catch(() => {});
      }
    }
    return { messages: msgs };
  }),

  appendToLastThinking: (chunk) => set((s) => {
    const { messages: msgs, index } = ensureStreamingAssistantMessage(s.messages);
    const prev = msgs[index];
    const duplicateChunk = !prev.isStreaming && !prev.content && prev.thinkingContent?.trim() === String(chunk || '').trim();
    msgs[index] = duplicateChunk
      ? { ...prev, isStreaming: true, retrying: false, streamStartedAt: prev.streamStartedAt ?? Date.now() }
      : applyAssistantThinkingSegment(prev, chunk);
    if (s.sessionId) {
      const now = Date.now();
      const key = `thinking_${msgs[index].id}`;
      const lastSave = streamSaveTimers.get(key) || 0;
      if (now - lastSave > STREAM_SAVE_INTERVAL_MS) {
        streamSaveTimers.set(key, now);
        updateMessage(s.sessionId, msgs[index]).catch(() => {});
      }
    }
    return { messages: msgs };
  }),

  setLeaderStatusText: (text) => set({ leaderStatusText: text }),

  setPhase: (phase) => {
    if (phase === 'streaming' || phase === 'tool_executing' || phase === 'thinking') {
      markStreamingActivity();
      ensureStreamingWatchdog();
    }
    if (phase === 'idle') {
      if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null; }
      set({ phase, leaderStatusText: '' });
    } else {
      set({ phase });
    }
  },

  addAgent: (agent) => set((s) => {
    const idx = s.agents.findIndex((a) => a.agentId === agent.agentId);
    if (idx >= 0) {
      const next = [...s.agents];
      next[idx] = { ...next[idx], ...agent, spawnedAt: next[idx].spawnedAt ?? Date.now() };
      return { agents: next };
    }
    // D9: s.agents 单会话内无界增长(只 append)。pruneAgents 超过 MAX_AGENTS 时优先驱逐最旧的终态 agent,
    // running agent 永不驱逐(与 pruneAgentConversations 同口径)。切换会话时整体重置。
    return { agents: pruneAgents([...s.agents, { ...agent, spawnedAt: Date.now() }]) };
  }),

  updateAgentStatus: (agentId, status) => set((s) => ({
    agents: s.agents.map(a => a.agentId === agentId ? { ...a, status } : a),
  })),

  stopAgent: async (agentId) => {
    const sid = get().sessionId;
    if (!sid) return;
    // 乐观：立刻把该 Agent 置为 interrupted，避免点击后 UI 仍显示 running。
    // 同时更新 agentConversations[agentId].status，因为组件渲染优先读 conv?.status。
    // 后端 stopAgent 完成后会推送 agent:terminated + session:runtime_state，SSE 侧据此对账。
    set((s) => ({
      agents: s.agents.map(a => a.agentId === agentId ? { ...a, status: 'interrupted' } : a),
      agentConversations: s.agentConversations[agentId]
        ? { ...s.agentConversations, [agentId]: { ...s.agentConversations[agentId], status: 'interrupted' } }
        : s.agentConversations,
    }));
    try {
      await fetch(`/api/v1/workers/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: { 'x-lingxiao-token': getServerToken() },
      });
    } catch {
      // 网络错误时静默：SSE 运行时快照会回滚到真实状态。
    }
  },

  addToolCall: (messageId, toolCall) => set((s) => {
    const messages = s.messages.map((m) => {
      if (m.id !== messageId) return m;
      const toolCalls = [...(m.toolCalls || [])];
      const existingIndex = toolCalls.findIndex((tc) => shouldMergeToolCall(tc, toolCall));
      let replacedToolCallId: { from: string; to: string } | undefined;
      if (existingIndex >= 0) {
        const previousId = toolCalls[existingIndex].id;
        toolCalls[existingIndex] = mergeToolCall(toolCalls[existingIndex], toolCall);
        if (previousId !== toolCalls[existingIndex].id) { replacedToolCallId = { from: previousId, to: toolCalls[existingIndex].id }; }
      } else { toolCalls.push(toolCall); }
      let contentBlocks = m.contentBlocks ? [...m.contentBlocks] : undefined;
      if (replacedToolCallId && contentBlocks) {
        contentBlocks = contentBlocks.map((block) => block.type === 'tool_call' && block.toolCallId === replacedToolCallId!.from ? { ...block, toolCallId: replacedToolCallId!.to } : block);
      }
      if (existingIndex < 0) {
        if (!contentBlocks) {
          contentBlocks = [];
          if (m.thinkingContent) contentBlocks.push({ type: 'thinking' as const, text: m.thinkingContent });
          if (m.content) contentBlocks.push({ type: 'text' as const, text: m.content });
        }
        if (!contentBlocks.some(b => b.type === 'tool_call' && b.toolCallId === toolCall.id)) {
          contentBlocks.push({ type: 'tool_call' as const, toolCallId: toolCall.id });
        }
      }
      return { ...m, toolCalls, contentBlocks, retrying: false };
    });
    if (s.sessionId) {
      const updated = messages.find(m => m.id === messageId);
      if (updated) {
        if (toolCall.status === 'streaming_input') {
          const now = Date.now();
          const lastSave = streamSaveTimers.get(messageId) || 0;
          if (now - lastSave > STREAM_SAVE_INTERVAL_MS) { streamSaveTimers.set(messageId, now); updateMessage(s.sessionId, updated).catch(() => {}); }
        } else { updateMessage(s.sessionId, updated).catch(() => {}); }
      }
    }
    return { messages };
  }),

  updateToolCall: (toolCallId, result, status, toolName) => set((s) => {
    const assistantMessages = [...s.messages].reverse().filter(m => m.role === 'assistant' && m.toolCalls?.length);
    const isTerminal = isToolCallTerminalStatus(status);
    let targetMessage = assistantMessages.find(m => m.toolCalls!.some(t =>
      t.id === toolCallId && toolNamesCompatible(t.tool, toolName)
    )) ?? assistantMessages.find(m => m.toolCalls!.some(t => t.id === toolCallId));
    let targetToolId = toolCallId;
    if (!targetMessage) {
      targetMessage = assistantMessages.find(m => m.toolCalls!.some(t =>
        isOpenToolCall(t.status) && toolNamesCompatible(t.tool, toolName)
      ));
      const fallbackTool = targetMessage?.toolCalls?.find(t =>
        isOpenToolCall(t.status) && toolNamesCompatible(t.tool, toolName)
      );
      if (fallbackTool) targetToolId = fallbackTool.id;
    }
    if (!targetMessage) {
      const openToolRefs = assistantMessages.flatMap(m => (m.toolCalls || []).filter(t => isOpenToolCall(t.status)).map(t => ({ message: m, tool: t })));
      if (openToolRefs.length === 1) { targetMessage = openToolRefs[0].message; targetToolId = openToolRefs[0].tool.id; }
    }
    if (!targetMessage) {
      targetMessage = assistantMessages.find(m => m.toolCalls!.some(t =>
        t.result == null && toolNamesCompatible(t.tool, toolName)
      ));
      const orphanTool = targetMessage?.toolCalls?.find(t =>
        t.result == null && toolNamesCompatible(t.tool, toolName)
      );
      if (orphanTool) targetToolId = orphanTool.id;
    }
    if (!targetMessage && isTerminal) {
      const settledToolRefs = assistantMessages.flatMap(m =>
        (m.toolCalls || [])
          .filter(t => t.status === 'cancelled' && (t.settleReason !== undefined || isLeaderSyntheticToolSettleResult(t.result)) && toolNamesCompatible(t.tool, toolName))
          .map(t => ({ message: m, tool: t }))
      );
      if (settledToolRefs.length === 1) { targetMessage = settledToolRefs[0].message; targetToolId = settledToolRefs[0].tool.id; }
    }
    if (!targetMessage) return s;
    const normalizedToolName = typeof toolName === 'string' && toolName.trim() && toolName !== 'unknown' ? toolName.trim() : undefined;
    const nextMessages = s.messages.map(m =>
      m.id === targetMessage.id
        ? { ...m, retrying: false, toolCalls: (m.toolCalls || []).map(tc => tc.id === targetToolId ? { ...tc, id: toolCallId, tool: normalizedToolName ?? tc.tool, result, status: status as ToolCall['status'], settleReason: undefined, settleDetail: undefined, displayStatus: undefined, ...(isTerminal ? { endedAt: Date.now() } : {}) } : tc), contentBlocks: targetToolId === toolCallId ? m.contentBlocks : m.contentBlocks?.map((block) => block.type === 'tool_call' && block.toolCallId === targetToolId ? { ...block, toolCallId } : block) }
        : m
    );
    if (s.sessionId) { const updated = nextMessages.find(m => m.id === targetMessage.id); if (updated) updateMessage(s.sessionId, updated).catch(() => {}); }
    return { messages: nextMessages };
  }),

  setConnected: (connected) => set({ isConnected: connected }),
  setIsLoadingHistory: (loading) => set({ isLoadingHistory: loading }),

  // ─── Agent conversation methods ───
  appendAgentMessage: (agentId, msg) => set((s) => {
    const conv = s.agentConversations[agentId];
    if (!conv) return s;
    return { agentConversations: { ...s.agentConversations, [agentId]: { ...conv, messages: [...conv.messages, { ...msg, id: msg.id || String(nextMsgId()) }] } } };
  }),

  appendToLastAgentThinking: (agentId, chunk) => set((s) => {
    const conv = s.agentConversations[agentId];
    if (!conv) return s;
    return { agentConversations: { ...s.agentConversations, [agentId]: { ...conv, messages: appendAgentThinkingSegment(conv.messages, chunk) } } };
  }),

  appendToLastAgentMessage: (agentId, chunk) => set((s) => {
    const conv = s.agentConversations[agentId];
    if (!conv) return s;
    const streamState = getAgentThinkStreamState(agentId);
    const split = splitThinkStreamingChunk(chunk, streamState.inThinking, streamState.pendingTag);
    streamState.inThinking = split.inThinking;
    streamState.pendingTag = split.pendingTag;
    let msgs = conv.messages;
    for (const segment of split.segments) {
      msgs = segment.type === 'thinking' ? appendAgentThinkingSegment(msgs, segment.text) : appendAgentTextSegment(msgs, segment.text);
    }
    return { agentConversations: { ...s.agentConversations, [agentId]: { ...conv, messages: msgs } } };
  }),

  finalizeLastAgentMessage: (agentId, content, reasoningContent) => set((s) => {
    const conv = s.agentConversations[agentId];
    if (!conv) return s;
    const parsed = splitThinkContent(String(content || ''));
    const finalContent = parsed.sawThinkTag ? parsed.cleaned : String(content || '');
    const finalThinking = String(reasoningContent || parsed.reasoning || '').trim();
    let targetTextIndex = findRecentAgentContentIndex(conv.messages, 'text', finalContent);
    let targetThinkingIndex = findRecentAgentContentIndex(conv.messages, 'thinking', finalThinking);
    const msgs = conv.messages.map(m => (m.isStreaming ? { ...m, isStreaming: false } : m));
    if (finalThinking) {
      if (targetThinkingIndex >= 0) { msgs[targetThinkingIndex] = { ...msgs[targetThinkingIndex], content: finalThinking, isStreaming: false }; }
      else if (targetTextIndex >= 0) { msgs.splice(targetTextIndex, 0, { id: `ath-${nextMsgId()}`, type: 'thinking', content: finalThinking, timestamp: Date.now(), isStreaming: false }); targetTextIndex += 1; }
      else { msgs.push({ id: `ath-${nextMsgId()}`, type: 'thinking', content: finalThinking, timestamp: Date.now(), isStreaming: false }); }
    }
    if (finalContent) {
      if (targetTextIndex >= 0) { msgs[targetTextIndex] = { ...msgs[targetTextIndex], content: finalContent, isStreaming: false }; }
      else { msgs.push({ id: `am-${nextMsgId()}`, type: 'text', content: finalContent, timestamp: Date.now(), isStreaming: false }); }
    }
    return { agentConversations: { ...s.agentConversations, [agentId]: { ...conv, messages: msgs } } };
  }),

  // ─── Token & compression ───
  ...createTokenActions(get, set),

  loadMessagesFromHistory: (history: HistoryMessageRow[]) => {
    const messages: Message[] = [];
    const toolResultMap = new Map<string, unknown>();
    for (const m of history) {
      if (m?.role === 'tool' && m.tool_call_id) { toolResultMap.set(String(m.tool_call_id), m.content); }
    }
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (!msg || msg.role === 'system' || msg.role === 'tool') continue;
      const role = msg.role === 'user' ? 'user' : 'assistant';
      const content = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      const thinkingText = normalizeThinkingText(msg.thinking);
      const toolCalls = normalizeHistoryToolCalls(msg.tool_calls, i, toolResultMap);
      const rowId = historyRowId(i);
      const timestamp = historyTimestampMs(msg.timestamp);
      const message: Message = role === 'assistant'
        ? createFinalAssistantMessage(`hist-${rowId}`, content, thinkingText, toolCalls, timestamp)
        : { id: `hist-${rowId}`, role, content: content || '', timestamp, isStreaming: false } satisfies Message;
      if (!message.content && !message.thinkingContent && !message.toolCalls?.length) continue;
      messages.push(message);
    }
    set({ messages: trimMessageWindow(messages) });
  },

  fetchSessions: async () => {
    try {
      const [sessionsRes, activeRes, infoRes] = await Promise.all([
        fetch('/api/sessions', { headers: { 'x-lingxiao-token': getServerToken() } }),
        fetch('/api/v1/sessions/active', { headers: { 'x-lingxiao-token': getServerToken() } }),
        fetch('/api/v1/info', { headers: { 'x-lingxiao-token': getServerToken(), 'x-lingxiao-request': '1' } }),
      ]);
      let activeSessionId: string | null = null;
      if (sessionsRes.status === 401) {
        // 尝试从 localhost-only 端点恢复 token，成功后重试一次
        const recovered = await tryRecoverToken();
        if (!recovered) {
          const appWindow = lingxiaoWindow();
          if (!appWindow.__lingxiao_401_warned) { appWindow.__lingxiao_401_warned = true; console.warn('[fetchSessions] 401 Unauthorized — token expired. Refresh page manually.'); }
          return;
        }
        // 恢复成功，重新拉取 sessions + active
        const retrySessionsRes = await fetch('/api/sessions', { headers: { 'x-lingxiao-token': getServerToken() } });
        if (!retrySessionsRes.ok) {
          const appWindow = lingxiaoWindow();
          if (!appWindow.__lingxiao_401_warned) { appWindow.__lingxiao_401_warned = true; console.warn('[fetchSessions] 401 after token recovery — token mismatch.'); }
          return;
        }
        const retryActiveRes = await fetch('/api/v1/sessions/active', { headers: { 'x-lingxiao-token': getServerToken() } });
        if (retryActiveRes.ok) { const activeData = asRecord(await retryActiveRes.json()); activeSessionId = stringValue(activeData.sessionId) ?? null; }
        const retryData = await retrySessionsRes.json();
        const sessions: SessionInfo[] = (Array.isArray(retryData) ? retryData : []).map((row) => normalizeSessionInfoRow(row as SessionListRow));
        set({ sessions, activeSessionId, sessionsLoaded: true });
        return;
      }
      if (activeRes.ok) { const activeData = asRecord(await activeRes.json()); activeSessionId = stringValue(activeData.sessionId) ?? null; }
      if (infoRes.ok) {
        const infoData = asRecord(await infoRes.json());
        const data = asRecord(infoData.data);
        const cwd = stringValue(data.cwd) ?? '';
        if (cwd) set({ serverCwd: cwd });
      }
      if (sessionsRes.ok) {
        const data = await sessionsRes.json();
        const sessions: SessionInfo[] = (Array.isArray(data) ? data : []).map((row) => normalizeSessionInfoRow(row as SessionListRow));
        set({ sessions, activeSessionId, sessionsLoaded: true });
      }
    } catch (e) { console.warn('[fetchSessions] failed:', e); }
    set((s) => s.sessionsLoaded ? s : { ...s, sessionsLoaded: true });
  },

  connectToSession: async (sessionId: string) => {
    if (connectingSessionId === sessionId) return;
    connectingSessionId = sessionId;
    connectAbortController?.abort();
    const abortController = new AbortController();
    connectAbortController = abortController;
    streamSaveTimers.clear();
    clearPendingStreamBuffers();
    try {
      await acpClient.disconnect();
      if (connectingSessionId !== sessionId) return;
      usePermissionStore.setState((s) => ({ pendingRequests: s.pendingRequests.filter((request) => request.sessionId === sessionId) }));
      set({ sessionId, activeSessionId: sessionId, ...emptySessionRuntimeState(), isConnected: false, isLoadingHistory: true });
      saveLastSelectedSessionId(sessionId);
      // 连接到(可能不同的)会话:清空黑板图,避免上一会话的图残留(#4)
      useBlackboardStore.getState().reset();
      // 清空 Git 状态，避免旧 workspace 数据残留
      useGitStore.getState().setWorkspace('');
      // Fetch persisted git activity from backend ring buffer.
      // Don't clear first — fetch then replace to avoid empty window if fetch fails.
      fetch(`/api/v1/git/activity/${encodeURIComponent(sessionId)}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      }).then(res => res.ok ? res.json() : null).then(data => {
        if (connectingSessionId !== sessionId) return;
        if (data?.data && Array.isArray(data.data)) {
          useGitActivityStore.getState().setEvents(data.data);
        } else {
          useGitActivityStore.getState().setEvents([]);
        }
      }).catch(() => {
        // Fetch failed — clear to avoid showing stale events from previous session
        if (connectingSessionId === sessionId) {
          useGitActivityStore.getState().setEvents([]);
        }
      });
      fetch(`/api/v1/agent/activity/${encodeURIComponent(sessionId)}`, {
        headers: { 'x-lingxiao-token': getServerToken() },
      }).then(res => res.ok ? res.json() : null).then(data => {
        if (connectingSessionId !== sessionId) return;
        if (data?.data && Array.isArray(data.data)) {
          useAgentActivityStore.getState().setEvents(data.data);
        } else {
          useAgentActivityStore.getState().setEvents([]);
        }
      }).catch(() => {
        // Fetch failed — clear to avoid showing stale events from previous session
        if (connectingSessionId === sessionId) {
          useAgentActivityStore.getState().setEvents([]);
        }
      });

      await acpClient.connect(sessionId);
      if (connectingSessionId !== sessionId) { await acpClient.disconnect(); return; }
      try {
        const focusResult = await acpClient.sendJsonRpc('session/focus', { sessionId });
        const snapshot = coerceSessionRuntimeSnapshot(asRecord(focusResult).runtime);
        if (snapshot && connectingSessionId === sessionId) { set((s) => applyRuntimeSnapshotPatch(s, snapshot, pendingStreamIsEmpty())); }
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[connectToSession] session/focus RPC failed:', e);
      }
      try { await syncRuntimeSnapshotFromAcp(sessionId); } catch (e) { if (import.meta.env.DEV) console.warn('[connectToSession] runtime_state RPC failed:', e); }
      try {
        const detailRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { headers: { 'x-lingxiao-token': getServerToken() }, signal: abortController.signal });
        if (connectingSessionId !== sessionId) return;
        if (detailRes.ok) {
          const detail = await detailRes.json();
          const snapshot = coerceSessionRuntimeSnapshot(detail?.runtime);
          if (snapshot && runtimeImpliesBusy({ runtimeState: snapshot })) { set((s) => ({ phase: phaseForBusySignal(s.phase) })); }
          else { set({ phase: 'idle' }); }
          const pendingPermission = detail?.pendingPermission;
          if (pendingPermission && typeof pendingPermission === 'object') { usePermissionStore.getState().addRequest(pendingPermission); }
        }
      } catch (e) { console.warn('[connectToSession] 同步运行态失败:', e); }
      try {
        const cached = await loadMessages(sessionId).catch(() => [] as Message[]);
        if (connectingSessionId !== sessionId) return;
        if (cached.length > 0) {
          const normalized = normalizeCachedMessages(cached);
          set({ messages: trimMessageWindow(normalized) });
          if (normalized !== cached) { saveMessages(sessionId, normalized).catch(() => {}); }
        }
        const histRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { headers: { 'x-lingxiao-token': getServerToken() }, signal: abortController.signal });
        if (connectingSessionId !== sessionId) return;
        if (histRes.ok) {
          const history = await histRes.json();
          if (connectingSessionId !== sessionId) return;
          if (Array.isArray(history) && history.length > 0) {
            get().loadMessagesFromHistory(history as HistoryMessageRow[]);
            saveMessages(sessionId, useSessionStore.getState().messages).catch(() => {});
          }
        }
      } catch (e: unknown) { if (e instanceof Error && e.name !== 'AbortError') { console.warn('[connectToSession] 加载消息历史失败:', (e as Error).message); } }
      try {
        const agentRes = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/agents`, { headers: { 'x-lingxiao-token': getServerToken() }, signal: abortController.signal });
        if (connectingSessionId !== sessionId) return;
        if (!agentRes.ok) {
          console.warn('[connectToSession] 加载 Agent 历史失败:', agentRes.status, await agentRes.text().catch(() => ''));
        } else {
          const agentData = await agentRes.json();
          if (connectingSessionId !== sessionId) return;
          if (agentData.data && typeof agentData.data === 'object') {
            const agentConvs = normalizeAgentSnapshotMap(agentData.data);
            if (Object.keys(agentConvs).length > 0) { set((s) => mergeAgentHistoryIntoState(s, agentConvs, { forceIncoming: true })); }
          }
        }
      } catch (e: unknown) { if (e instanceof Error && e.name !== 'AbortError') { console.warn('[connectToSession] 加载 Agent 历史失败:', e.message); } }
      set({ isLoadingHistory: false });
      get().fetchTokenUsage();
    } catch (e) { console.error('Failed to connect to session:', e); set({ isConnected: false, isLoadingHistory: false }); }
    finally { if (connectAbortController === abortController) connectAbortController = null; if (connectingSessionId === sessionId) connectingSessionId = null; }
  },

  createAndConnect: async (options = {}) => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
        body: JSON.stringify({ user_request: '', idle: true, workspace: options.workspace }),
      });
      if (res.ok) {
        const data = await res.json() as CreateSessionResponse;
        const newId = stringValue(data.id);
        if (newId) { await get().fetchSessions(); await get().connectToSession(newId); return newId; }
      }
      return undefined;
    } catch (e) { console.error('Failed to create session:', e); throw e; }
  },

  deleteSession: async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { 'x-lingxiao-token': getServerToken() } });
      if (res.ok) {
        const { sessionId: currentId } = get();
        if (loadLastSelectedSessionId() === sessionId) saveLastSelectedSessionId(null);
        if (currentId === sessionId) {
          connectAbortController?.abort(); connectAbortController = null; streamSaveTimers.clear(); clearPendingStreamBuffers();
          await acpClient.disconnect();
          usePermissionStore.setState((s) => ({ pendingRequests: s.pendingRequests.filter((request) => request.sessionId !== sessionId) }));
          set({ sessionId: null, activeSessionId: null, ...emptySessionRuntimeState(), isConnected: false });
          // 删除的是当前活动会话:清空黑板图(#4)
          useBlackboardStore.getState().reset();
        }
        set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== sessionId) }));
      }
    } catch (e) { console.error('Failed to delete session:', e); }
  },

  markQuestionAnswered: (messageId: string, answeredValue: string) => set((s) => ({
    messages: s.messages.map((m) => m.id === messageId && m.askUserQuestion ? { ...m, askUserQuestion: { ...m.askUserQuestion, answered: true, answeredValue } } : m),
  })),

  resolvePendingQuestions: (answeredValue?: string) => set((s) => {
    if (!s.messages.some((m) => m.askUserQuestion && !m.askUserQuestion.answered)) return {};
    return {
      messages: s.messages.map((m) =>
        m.askUserQuestion && !m.askUserQuestion.answered
          ? { ...m, askUserQuestion: { ...m.askUserQuestion, answered: true, ...(answeredValue ? { answeredValue } : {}) } }
          : m
      ),
    };
  }),

  reset: () => {
    connectAbortController?.abort(); connectAbortController = null; streamSaveTimers.clear(); clearPendingStreamBuffers();
    usePermissionStore.setState({ pendingRequests: [] });
    useBlackboardStore.getState().reset();
    set({ ...emptySessionRuntimeState(), isConnected: false, isLoadingHistory: false });
  },
}));

// Inject the store reference into sseStore to break the circular dependency
_injectSessionStore(useSessionStore);

// Mid-run compaction invariant. pruneAgentConversations also runs at agent
// completion, but a single long-running agent can push its own message list past
// the cap (MAX_AGENT_MESSAGES_PER_AGENT) before it terminates — via tool calls,
// tool/terminal output and status events appended from many sseStore sites. This
// subscriber enforces the cap reactively: whenever agentConversations changes and
// any conversation exceeds the bound, it is compacted (and old terminal
// conversations evicted) immediately. The ref-equality guard makes it free on the
// common streaming path (text-segment appends to `messages` don't touch
// agentConversations), and pruneAgentConversations returns the SAME ref when
// nothing is over cap, so it never fires a redundant setState (no feedback loop).
useSessionStore.subscribe((state, prevState) => {
  if (state.agentConversations === prevState.agentConversations) return;
  const pruned = pruneAgentConversations(state.agentConversations);
  if (pruned !== state.agentConversations) {
    useSessionStore.setState({ agentConversations: pruned });
  }
});

// Side-effect: import sseStore to register SSE listener (triggers ensureSseListener)
import './sseStore';
