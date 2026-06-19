// ─── Pure helper functions for sessionStore ───

import { mapDbRoleToAgentType, type AgentConversation, type AgentHistoryMessageRow, type AgentHistoryResponse, type AgentMessage, type AgentRuntime, type Message, type SessionState, type TokenUsage, type ToolCall } from './sessionStoreTypes.js';
import { isToolCallOpenStatus, isToolCallTerminalStatus, mergeAgentStatus } from '@contracts/adapters/StatusAdapter';
import { splitThinkContent } from '@contracts/adapters/ThinkContent';
// Web store 只转发核心状态合同，避免前端再维护一份重复状态机。
export {
  isAgentActiveStatus,
  isAgentTerminalStatus,
  isRunActiveStatus,
  isRunTerminalStatus,
  mergeAgentStatus,
  normalizeAgentStatus,
  normalizeLeaderStatusKind,
  normalizeTaskDisplayState,
  normalizeRunStatus,
  normalizeTaskStatus,
  isToolCallOpenStatus,
  isToolCallTerminalStatus,
  normalizeToolCallStatus,
  deriveRuntimeWaitGate,
  deriveRuntimeWorkerFacts,
  leaderStatusTextImpliesActive,
  runtimeImpliesBusy,
  type NormalizedAgentStatus,
  type RuntimeWaitGate,
} from '@contracts/adapters/StatusAdapter';

/**
 * 流式 phase 的兜底超时 — 600s（10 分钟）。
 *
 * PR4.2 (2026-05-22)：改为 lastActivity 模式。
 * 之前的实现在 setPhase('streaming') 时启动一次性 setTimeout，只有再次调用
 * setPhase 才会清/重置；长 LLM 调用即使在持续 emit text_chunk / token:usage / round_complete
 * 也会被强降级为 idle。新模式由 sessionStore 内的 watchdog 周期检查
 * `now - lastActivity > STREAMING_TIMEOUT_MS` 才降级，每条活动信号刷新 lastActivity。
 *
 * P1-9 (2026-05-14)：从 180s 提到 600s，原值对 thinking 模型 + 长工具调用经常误杀。
 * 子审计：docs/audit/audit-24-webui-state.md
 */
export const STREAMING_TIMEOUT_MS = 600_000;
/** lastActivity 检查周期 — 30s 即可，足够准确且不消耗 CPU */
export const STREAMING_WATCHDOG_INTERVAL_MS = 30_000;

// ─── Memory bounds (deterministic caps) ───
// historyDB caps persisted messages at 500/session on save, but the live Zustand
// arrays never mirrored that cap — a long (eternal) session grew `messages` and
// every `agentConversations[*].messages` without bound for the whole session.
// These caps bound the live heap. They never drop anything newer than historyDB
// retains on reconnect, and the chat has no scroll-up pagination to conflict with.

/** Keep the most recent chat messages in memory (>= historyDB's 500-msg cap). */
export const MAX_INMEMORY_MESSAGES = 800;
export function trimMessageWindow(messages: Message[]): Message[] {
  return messages.length > MAX_INMEMORY_MESSAGES ? messages.slice(-MAX_INMEMORY_MESSAGES) : messages;
}

/** Max retained messages per agent (compacted on agent completion). */
export const MAX_AGENT_MESSAGES_PER_AGENT = 200;
/** Max retained agent conversations; running agents are never evicted. */
export const MAX_AGENT_CONVERSATIONS = 30;
/** Max retained agent metadata entries in s.agents (resets per-session on switch); running agents never evicted. */
export const MAX_AGENTS = 100;
export const TERMINAL_AGENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'interrupted', 'failed']);

/**
 * Bound agentConversations: compact each conversation's retained messages to the
 * last MAX_AGENT_MESSAGES_PER_AGENT, then evict the oldest TERMINAL conversations
 * once the total exceeds MAX_AGENT_CONVERSATIONS (running agents are always kept).
 * No-op (returns the same ref) when nothing is over cap, so it stays cheap on the
 * common path and avoids needless store churn.
 */
export function pruneAgentConversations(convs: Record<string, AgentConversation>): Record<string, AgentConversation> {
  let compacted = convs;
  for (const id in convs) {
    const c = convs[id];
    if (!c || c.messages.length <= MAX_AGENT_MESSAGES_PER_AGENT) continue;
    if (compacted === convs) compacted = { ...convs };
    compacted[id] = { ...c, messages: c.messages.slice(-MAX_AGENT_MESSAGES_PER_AGENT) };
  }
  const ids = Object.keys(compacted).filter((id) => compacted[id]);
  if (ids.length <= MAX_AGENT_CONVERSATIONS) return compacted;
  const next: Record<string, AgentConversation> = {};
  let dropped = 0;
  const toDrop = ids.length - MAX_AGENT_CONVERSATIONS;
  for (const id of ids) {
    const c = compacted[id];
    if (dropped < toDrop && TERMINAL_AGENT_STATUSES.has(c.status)) { dropped++; continue; }
    next[id] = c;
  }
  return next;
}

/**
 * Bound s.agents metadata: evict oldest TERMINAL agents once over MAX_AGENTS
 * (running agents always kept). No-op (returns same ref) when under cap.
 * Mirrors pruneAgentConversations. s.agents also resets per-session on switch.
 */
export function pruneAgents<T extends { agentId: string; status: string }>(agents: T[]): T[] {
  if (agents.length <= MAX_AGENTS) return agents;
  const kept: T[] = [];
  let dropped = 0;
  const toDrop = agents.length - MAX_AGENTS;
  for (const a of agents) {
    if (dropped < toDrop && TERMINAL_AGENT_STATUSES.has(a.status)) { dropped++; continue; }
    kept.push(a);
  }
  return kept;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractContentPartText(part: unknown): string {
  if (typeof part === 'string') return part;
  const record = asRecord(part);
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (record.type === 'image_url' || record.type === 'image_blob_ref') return '[image]';
  return '';
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(extractContentPartText)
      .filter(Boolean)
      .join('');
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

export function stableInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  try { return JSON.stringify(input); } catch { return String(input); }
}

export function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

export function syntheticToolCallId(tool: unknown, input: unknown): string {
  return `tc-${String(tool || 'unknown')}-${hashString(stableInput(input))}`;
}

export function isSyntheticToolCallId(id: string): boolean {
  return id.startsWith('tc-');
}

export function isOpenToolCall(status: ToolCall['status']): boolean {
  return isToolCallOpenStatus(status);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeTokenUsageView(value: unknown): TokenUsage {
  const record = asRecord(value);
  const prompt = numberValue(record.prompt) ?? 0;
  const completion = numberValue(record.completion) ?? 0;
  const total = numberValue(record.total) ?? prompt + completion;
  return {
    prompt,
    completion,
    total,
    cache_read: numberValue(record.cache_read),
    cache_creation: numberValue(record.cache_creation),
  };
}

function normalizedToolName(tool: unknown): string {
  return typeof tool === 'string' ? tool.trim() : '';
}

function isUnknownToolName(tool: unknown): boolean {
  const normalized = normalizedToolName(tool).toLowerCase();
  return normalized === '' || normalized === 'unknown' || normalized === 'tool';
}

export function toolNamesCompatible(a: unknown, b: unknown): boolean {
  if (isUnknownToolName(a) || isUnknownToolName(b)) return true;
  return normalizedToolName(a) === normalizedToolName(b);
}

function preferToolName(incoming: unknown, existing: unknown): string {
  return isUnknownToolName(incoming)
    ? (normalizedToolName(existing) || 'unknown')
    : normalizedToolName(incoming);
}

export function shouldMergeToolCall(existing: ToolCall, incoming: ToolCall): boolean {
  if (existing.id === incoming.id) return toolNamesCompatible(existing.tool, incoming.tool);
  return (
    toolNamesCompatible(existing.tool, incoming.tool)
    && stableInput(existing.input) === stableInput(incoming.input)
    && (isOpenToolCall(existing.status) || isOpenToolCall(incoming.status) || existing.result == null)
  );
}

export function mergeToolCall(existing: ToolCall, incoming: ToolCall): ToolCall {
  const existingTerminal = isToolCallTerminalStatus(existing.status);
  const incomingHasRealId = !isSyntheticToolCallId(incoming.id);
  return {
    ...existing,
    ...incoming,
    id: incomingHasRealId || isSyntheticToolCallId(existing.id) ? incoming.id : existing.id,
    tool: preferToolName(incoming.tool, existing.tool),
    input: incoming.input ?? existing.input,
    result: incoming.result ?? existing.result,
    status: existingTerminal && isOpenToolCall(incoming.status) ? existing.status : incoming.status,
    // 保留时间戳字段：incoming 没传时不要把 existing 的覆盖成 undefined
    firstDeltaAt: incoming.firstDeltaAt ?? existing.firstDeltaAt,
    startedAt: incoming.startedAt ?? existing.startedAt,
    endedAt: incoming.endedAt ?? existing.endedAt,
    inputCharCount: incoming.inputCharCount ?? existing.inputCharCount,
  };
}

export function mergeAgentHistoryIntoState(
  state: SessionState,
  incomingConversations: Record<string, AgentConversation>,
  opts?: { forceIncoming?: boolean },
): Pick<SessionState, 'agentConversations' | 'agents'> {
  const agentConversations = { ...state.agentConversations };
  for (const [agentId, incoming] of Object.entries(incomingConversations)) {
    const existing = agentConversations[agentId];
    const mergedStatus = mergeAgentStatus(existing?.status, incoming.status) as AgentConversation['status'];
    // 历史快照合并策略：
    // - 实时 SSE 已经累积 > 1 条真消息（不止启动占位 status）→ 优先保留实时记录
    // - 否则用后端历史，避免"agent_spawned 仅插了一条 'Agent started' status 占位"导致
    //   后端历史完整 messages 整段被丢，刷新后只剩一行的 bug
    const existingMessages = existing?.messages ?? [];
    const existingHasReal = existingMessages.some((m) => m.type !== 'status');
    const useExisting = opts?.forceIncoming ? false : existingHasReal;
    const existingTotal = existing?.tokenUsage?.total ?? 0;
    const incomingTotal = incoming.tokenUsage?.total ?? 0;
    const tokenUsage = existingTotal > incomingTotal ? existing?.tokenUsage : (incoming.tokenUsage || existing?.tokenUsage);
    agentConversations[agentId] = existing
      ? {
          ...incoming,
          ...existing,
          agentName: existing.agentName || incoming.agentName,
          role: existing.role || incoming.role,
          status: mergedStatus,
          taskId: existing.taskId ?? incoming.taskId,
          workingDirectory: existing.workingDirectory ?? incoming.workingDirectory,
          writeScope: existing.writeScope ?? incoming.writeScope,
          backend: existing.backend ?? incoming.backend,
          externalSessionId: existing.externalSessionId ?? incoming.externalSessionId,
          pid: existing.pid ?? incoming.pid,
          logPath: existing.logPath ?? incoming.logPath,
          messages: useExisting ? existingMessages : incoming.messages,
          ...(tokenUsage ? { tokenUsage } : {}),
        }
      : { ...incoming, status: mergedStatus };
  }

  const byId = new Map<string, AgentRuntime>(state.agents.map((agent) => [agent.agentId, agent]));
  // 历史合并后用插入序补齐缺失的 spawnedAt（保证刷新/重连后排序仍稳定）。
  // byId 的迭代顺序 = 已有 agents 顺序 + 新出现 conv 的插入序，近似首次出现序。
  let synthOrder = 0;
  for (const conv of Object.values(agentConversations)) {
    const existing = byId.get(conv.agentId);
    byId.set(conv.agentId, {
      agentId: conv.agentId,
      agentName: existing?.agentName || conv.agentName,
      role: existing?.role || conv.role || 'worker',
      status: mergeAgentStatus(existing?.status, conv.status),
      taskId: existing?.taskId ?? conv.taskId,
      workingDirectory: existing?.workingDirectory ?? conv.workingDirectory,
      writeScope: existing?.writeScope ?? conv.writeScope,
      backend: existing?.backend ?? conv.backend,
      externalSessionId: existing?.externalSessionId ?? conv.externalSessionId,
      pid: existing?.pid ?? conv.pid,
      // 保留首次出现时间戳作为稳定排序键；历史合并缺失则按插入序补一个递增值
      spawnedAt: existing?.spawnedAt ?? synthOrder++,
    });
  }

  return { agentConversations, agents: Array.from(byId.values()) };
}

/**
 * 把后端 /api/v1/sessions/:id/agents 返回的 conversation rows 还原成
 * Agent 面板可渲染的 AgentMessage 列表。
 *
 * 修复点（issue: agent 面板刷新后部分渲染丢失）：
 * - assistant + 多 tool_calls 行原本只生成一条卡片 → 改为按数组展开，多并行 tool 全部出现
 * - tool_call 卡片 content 改为 tool_calls[].arguments，原来塞的是 assistant 文本（通常空）→ 卡片输入区永远空白
 * - tool_call 终态字段补齐：toolStatus='completed'、startedAt/endedAt = row 时间戳，
 *   AgentPanel.tsx 的耗时 chip / spinner / loading 才能正确停在终态
 * - tool 行（role='tool'）按 tool_call_id 注入对应 tool_result 卡片
 */
export function expandAgentHistoryRows(
  agentId: string,
  rows: AgentHistoryMessageRow[],
): AgentMessage[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out: AgentMessage[] = [];
  let counter = 0;
  for (const row of rows) {
    const role = String(row.role || '');
    const timestamp = numberValue(row.timestamp);
    const tsMs = timestamp ? timestamp * 1000 : Date.now();
    const baseId = `${agentId}-${timestamp || Date.now()}-${counter++}`;
    const rawContent = typeof row.content === 'string'
      ? row.content
      : (row.content ? safeStringify(row.content) : '');
    const parsedContent = role === 'assistant' ? splitThinkContent(rawContent) : undefined;
    const textContent = parsedContent?.sawThinkTag ? parsedContent.cleaned : rawContent;
    const rowThinking = Array.isArray(row.thinking) && row.thinking.length > 0
      ? row.thinking
          .map((block) => {
            const thinkingBlock = asRecord(block);
            return thinkingBlock.type === 'thinking' ? String(thinkingBlock.text || '') : '[redacted]';
          })
          .filter(Boolean)
          .join('\n')
          .trim()
      : '';
    const thinkingContent = rowThinking || parsedContent?.reasoning;

    if (role === 'tool') {
      out.push({
        id: `atr-hist-${row.tool_call_id || baseId}`,
        type: 'tool_result',
        content: rawContent,
        timestamp: tsMs,
        isStreaming: false,
      });
      continue;
    }

    if (role === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
      if (thinkingContent) {
        out.push({
          id: `${baseId}-thinking`,
          type: 'thinking',
          content: thinkingContent,
          timestamp: tsMs,
          isStreaming: false,
        });
      }
      // 文本内容（如有）独立一条 text 卡片，避免和 tool_call 卡混渲
      if (textContent && textContent.trim().length > 0) {
        out.push({
          id: `${baseId}-text`,
          type: 'text',
          content: textContent,
          timestamp: tsMs,
          isStreaming: false,
        });
      }
      for (let j = 0; j < row.tool_calls.length; j++) {
        const tc = row.tool_calls[j];
        const fn = tc.function;
        const tool = stringValue(fn.name) ?? 'unknown';
        const args = fn.arguments;
        const argsStr = typeof args === 'string' ? args : safeStringify(args);
        const callIdHint = String(tc.id || `${baseId}-tc-${j}`);
        out.push({
          id: `atc-hist-${callIdHint}`,
          type: 'tool_call',
          content: argsStr,
          tool,
          timestamp: tsMs,
          isStreaming: false,
          toolStatus: 'completed',
          startedAt: tsMs,
          endedAt: tsMs,
          inputCharCount: argsStr.length || undefined,
        });
      }
      continue;
    }

    // 其它行（assistant 文本 / status / user）走默认映射
    if (role === 'assistant' && thinkingContent) {
      out.push({
        id: `${baseId}-thinking`,
        type: 'thinking',
        content: thinkingContent,
        timestamp: tsMs,
        isStreaming: false,
      });
      if (!textContent) continue;
    }
    out.push({
      id: baseId,
      type: mapDbRoleToAgentType(role, Array.isArray(row.tool_calls) ? row.tool_calls : undefined, stringValue(row.tool_call_id)),
      content: textContent,
      timestamp: tsMs,
      isStreaming: false,
    });
  }
  return out;
}

export function normalizeAgentSnapshotMap(snapshot: unknown): Record<string, AgentConversation> {
  const data = asRecord(snapshot) as AgentHistoryResponse;
  const conversations: Record<string, AgentConversation> = {};

  for (const [agentId, info] of Object.entries(data)) {
    const rows = info.messages;
    const tokenUsage = normalizeTokenUsageView(info.tokenUsage);
    conversations[agentId] = {
      agentId,
      agentName: stringValue(info.agentName) || agentId,
      role: stringValue(info.role) || 'worker',
      status: stringValue(info.status) || 'completed',
      taskId: stringValue(info.taskId),
      messages: expandAgentHistoryRows(agentId, rows),
      tokenUsage,
    };
  }

  return conversations;
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
