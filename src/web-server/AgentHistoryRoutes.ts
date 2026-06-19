import type { AgentConversationRepository, AgentStateRecord, TokenSummaryRow } from '../core/DatabaseRepositories.js';

export type AgentConversationMessages = Array<{
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  thinking?: unknown[];
  timestamp?: number;
  agentName?: string;
}>;

export type AgentHistoryEntry = {
  agentName: string;
  role: string;
  status: string;
  taskId?: string;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
    cache_read?: number;
    cache_creation?: number;
  };
  messages: AgentConversationMessages;
};

export interface AgentHistoryRepos {
  agentState: {
    listBySession(sessionId: string): AgentStateRecord[];
  };
  agentConversation: Pick<AgentConversationRepository, 'getSessionAgentIds' | 'get'>;
  tokenUsage: {
    getSummary(sessionId: string): TokenSummaryRow[];
  };
}

function tokenUsageByAgent(rows: TokenSummaryRow[]): Map<string, AgentHistoryEntry['tokenUsage']> {
  const out = new Map<string, AgentHistoryEntry['tokenUsage']>();
  for (const row of rows) {
    out.set(row.agent_id, {
      prompt: row.prompt || 0,
      completion: row.completion || 0,
      total: row.total || 0,
      cache_read: row.cache_read || 0,
      cache_creation: row.cache_creation || 0,
    });
  }
  return out;
}

function withAgentName(messages: AgentConversationMessages, agentName: string): AgentConversationMessages {
  return messages.map((message) => ({ ...message, agentName: message.agentName || agentName }));
}

export function agentStateActive(status: string | undefined, stopped: number | undefined): boolean {
  if (stopped) return false;
  return new Set(['starting', 'running', 'processing', 'active', 'recovering', 'waiting', 'queued'])
    .has(String(status || '').trim().toLowerCase());
}

export function syntheticAgentStatusMessage(state: { agent_name: string; status: string; stopped?: number; timestamp: number }): AgentConversationMessages[number] {
  return {
    role: 'status',
    content: agentStateActive(state.status, state.stopped)
      ? `Agent ${state.agent_name} 已恢复，等待实时输出...`
      : `Agent ${state.agent_name} 状态：${state.status}`,
    timestamp: state.timestamp || Date.now() / 1000,
    agentName: state.agent_name,
  };
}

export async function buildSessionAgentHistory(
  repos: AgentHistoryRepos,
  sessionId: string,
): Promise<Record<string, AgentHistoryEntry>> {
  const agentStates = repos.agentState.listBySession(sessionId);
  const stateMap = new Map(agentStates.map((state) => [state.agent_id, state]));
  const tokenMap = tokenUsageByAgent(repos.tokenUsage.getSummary(sessionId));
  const agentIds = repos.agentConversation.getSessionAgentIds(sessionId);
  const seen = new Set<string>();
  const result: Record<string, AgentHistoryEntry> = {};

  for (const { agentId, agentName } of agentIds) {
    seen.add(agentId);
    const state = stateMap.get(agentId);
    const displayName = state?.agent_name || agentName || agentId;
    const messages = await repos.agentConversation.get(sessionId, agentId) as AgentConversationMessages;
    result[agentId] = {
      agentName: displayName,
      role: state?.agent_role || 'worker',
      status: state?.status || 'completed',
      taskId: state?.task_id || undefined,
      tokenUsage: tokenMap.get(agentId) || { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0 },
      messages: withAgentName(messages || [], displayName),
    };
  }

  for (const state of agentStates) {
    if (seen.has(state.agent_id)) continue;
    const messages = await repos.agentConversation.get(sessionId, state.agent_id) as AgentConversationMessages;
    const restoredMessages = messages?.length ? messages : [syntheticAgentStatusMessage(state)];
    result[state.agent_id] = {
      agentName: state.agent_name,
      role: state.agent_role,
      status: state.status,
      taskId: state.task_id || undefined,
      tokenUsage: tokenMap.get(state.agent_id) || { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0 },
      messages: withAgentName(restoredMessages, state.agent_name),
    };
  }

  return result;
}
