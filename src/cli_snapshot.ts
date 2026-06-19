import type { DatabaseManager, AgentLog, AgentState, ConversationMessage, Task as DBTask } from './core/Database.js';
import type { Task } from './core/TaskBoard.js';
import type { CommandInitialChannelSeed, CommandLogMessage } from './commands/types.js';
import { withDisplayState } from './core/TaskDisplayState.js';
import { contentToPlainText } from './llm/types.js';
import { normalizeToolPermissionContext, summarizePermissionContextForDisplay } from './core/PermissionSystem.js';
import { listRecoveryRecords } from './core/RecoveryRecords.js';
import { SESSION_KEYS } from './core/SessionStateKeys.js';
import { normalizeAgentStatus, normalizeRunStatus, normalizeTaskDisplayState } from './core/StateSemantics.js';

function normalizeLeaderMode(value: unknown): 'direct' | 'hybrid' | 'delegate' | undefined {
  return value === 'direct' || value === 'hybrid' || value === 'delegate' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type RuntimeRecord = Record<string, unknown>;

export interface TuiRuntimeCalibrationInput {
  runtime?: unknown | null;
  processingStatus: string;
}

export type TuiRuntimeCalibratedSnapshot<T extends Record<string, unknown>> = T & {
  derivedLeaderBusy: boolean;
  displayLeaderQueueLength?: number;
};

function deriveLeaderBusyFromRuntimeState(runtimeState: RuntimeRecord | null): boolean {
  const leader = runtimeState?.leader && typeof runtimeState.leader === 'object'
    ? runtimeState.leader as RuntimeRecord
    : null;
  if (!leader) return false;
  return Boolean(
    leader.busy === true ||
    (leader.running === true && leader.waitingForUser !== true),
  );
}

export function calibrateTuiSnapshotFromRuntime<T extends Record<string, unknown>>(
  snapshot: T,
  input: TuiRuntimeCalibrationInput,
): TuiRuntimeCalibratedSnapshot<T>;
export function calibrateTuiSnapshotFromRuntime(
  snapshot: null,
  input: TuiRuntimeCalibrationInput,
): null;
export function calibrateTuiSnapshotFromRuntime(
  snapshot: Record<string, unknown> | null,
  input: TuiRuntimeCalibrationInput,
): TuiRuntimeCalibratedSnapshot<Record<string, unknown>> | null {
  if (!snapshot) return null;
  const runtime = input.runtime && typeof input.runtime === 'object'
    ? input.runtime as Record<string, unknown>
    : null;
  const runtimeState = runtime && typeof runtime.runtimeState === 'object'
    ? runtime.runtimeState
    : null;
  const derivedLeaderBusy = deriveLeaderBusyFromRuntimeState(runtimeState as RuntimeRecord | null);
  const nextSnapshot = {
    ...snapshot,
    derivedLeaderBusy,
    displayLeaderQueueLength: derivedLeaderBusy ? 0 : undefined,
    leaderStatus: derivedLeaderBusy ? input.processingStatus : snapshot.leaderStatus,
    sessionStatus: derivedLeaderBusy
      ? { ...asRecord(snapshot.sessionStatus), status: 'active' }
      : snapshot.sessionStatus,
  };
  return nextSnapshot;
}

export function toInitialMessages(history: ConversationMessage[]): Array<{
  type: 'system' | 'leader' | 'user' | 'agent';
  content: string;
}> {
  return history
    .map((message) => {
      const text = contentToPlainText(message.content);

      // assistant message with only tool_calls (no text): show tool call summary
      if (!text && message.role === 'assistant' && message.tool_calls?.length) {
        const names = message.tool_calls.map(tc => tc.function?.name || tc.id || 'tool').join(', ');
        return {
          type: 'leader' as const,
          content: `[调用工具: ${names}]`,
        };
      }

      // tool result message: show as system
      if (message.role === 'tool') {
        const preview = text ? text.slice(0, 500) : '[工具结果]';
        return {
          type: 'system' as const,
          content: preview,
        };
      }

      // skip truly empty messages (e.g. assistant with no text and no tool_calls)
      if (!text) return null;

      return {
        type: (
          message.role === 'user'
            ? 'user'
            : message.role === 'assistant'
              ? 'leader'
              : 'system'
        ) as 'system' | 'leader' | 'user' | 'agent',
        content: text,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

export function toInitialTasks(tasks: DBTask[]) {
  return tasks.map((task) => {
    const normalized: Task = {
      id: task.id,
      session_id: task.session_id,
      subject: task.subject,
      description: typeof task.description === 'string' ? task.description : JSON.stringify(task.description),
      context: task.context,
      status: task.status as Task['status'],
      exitReason: task.exit_reason as Task['exitReason'],
      runGeneration: Number(task.run_generation ?? 0),
      agent_type: task.agent_type,
      assigned_agent: task.assigned_agent || '',
      blocked_by: task.blocked_by || [],
      blocks: task.blocks || [],
      working_directory: task.working_directory || '',
      write_scope: task.write_scope || [],
      result: task.result,
      orchestration: task.orchestration,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
    return withDisplayState(normalized);
  });
}

export type AgentConversationSnapshot = {
  agentId: string;
  agentName: string;
  agentRole: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
};

type TuiSnapshotDb = Pick<DatabaseManager, 'getSession' | 'getTasksBySession' | 'getConversation' | 'getAgentLogs' | 'getSessionState' | 'getTokenSummary'>
  & Partial<Pick<DatabaseManager, 'getAllAgentConversationsSync' | 'getAgentStates' | 'listSessionStateByPrefix'>>;

function agentConversationMessageToLogMessage(message: AgentConversationSnapshot['messages'][number]): CommandLogMessage | null {
  const content = typeof message.content === 'string' ? message.content : String(message.content ?? '');
  if (!content.trim()) return null;
  const role = String(message.role || '').trim().toLowerCase();
  return {
    type: role === 'assistant' ? 'agent' : role === 'user' ? 'user' : 'system',
    content,
    timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
  };
}

function syntheticAgentStateMessage(state: AgentState): CommandLogMessage {
  return {
    type: 'system',
    content: `Agent ${state.agent_name} 状态：${state.status}`,
    timestamp: state.timestamp ? state.timestamp * 1000 : undefined,
  };
}

export function mergeAgentConversationChannels(
  channels: CommandInitialChannelSeed[],
  conversations: AgentConversationSnapshot[] = [],
  agentStates: AgentState[] = [],
): CommandInitialChannelSeed[] {
  const merged = [...channels];
  const stateById = new Map(agentStates.map((state) => [state.agent_id, state]));
  const channelByAgentId = new Map<string, CommandInitialChannelSeed>();
  const channelByName = new Map<string, CommandInitialChannelSeed>();

  for (const channel of merged) {
    if (channel.agentId) channelByAgentId.set(channel.agentId, channel);
    channelByName.set(channel.name, channel);
  }

  for (const conversation of conversations) {
    const state = stateById.get(conversation.agentId);
    const name = state?.agent_name || conversation.agentName || conversation.agentId;
    const existing = channelByAgentId.get(conversation.agentId) || channelByName.get(name);
    if (existing) {
      existing.agentId ||= conversation.agentId;
      existing.role ||= state?.agent_role || conversation.agentRole;
      existing.taskId ||= state?.task_id;
      continue;
    }

    const messages = conversation.messages
      .map(agentConversationMessageToLogMessage)
      .filter((message): message is CommandLogMessage => message !== null)
      .slice(-100);

    merged.push({
      agentId: conversation.agentId,
      name,
      role: state?.agent_role || conversation.agentRole || 'worker',
      taskId: state?.task_id || undefined,
      status: normalizeAgentStatus(state?.status || (messages.length > 0 ? 'completed' : 'idle')),
      messages: messages.length > 0 ? messages : state ? [syntheticAgentStateMessage(state)] : [],
    });
  }

  const knownAgentIds = new Set(merged.map((channel) => channel.agentId).filter((id): id is string => Boolean(id)));
  const knownNames = new Set(merged.map((channel) => channel.name));
  for (const state of agentStates) {
    if (knownAgentIds.has(state.agent_id) || knownNames.has(state.agent_name)) continue;
    merged.push({
      agentId: state.agent_id,
      name: state.agent_name,
      role: state.agent_role || 'worker',
      taskId: state.task_id || undefined,
      status: normalizeAgentStatus(state.status),
      messages: [syntheticAgentStateMessage(state)],
    });
  }

  return merged;
}

export function toInitialChannels(logs: AgentLog[], pendingPlan: unknown): CommandInitialChannelSeed[] {
  const channels: CommandInitialChannelSeed[] = [];
  const grouped = new Map<string, AgentLog[]>();
  for (const log of logs) {
    if (!grouped.has(log.agent_name)) {
      grouped.set(log.agent_name, []);
    }
    grouped.get(log.agent_name)!.push(log);
  }

  channels.push(...Array.from(grouped.entries()).map(([name, agentLogs]) => {
    const messages = agentLogs.slice(-100).map((log) => {
      if (log.event_type === 'tool_call_start') {
        try {
          const parsed = JSON.parse(log.content);
          const toolName = parsed.tool_name || parsed.name || 'unknown';
          return { type: 'system' as const, content: `调用工具: ${toolName}` };
        } catch {/* expected: fallback to default */
          return { type: 'system' as const, content: `调用工具: ${log.content}` };
        }
      }
      if (log.event_type === 'tool_result') {
        try {
          const parsed = JSON.parse(log.content);
          const preview = parsed.result_preview || parsed.result || log.content;
          return { type: 'system' as const, content: `工具结果: ${String(preview).slice(0, 300)}` };
        } catch {/* expected: fallback to default */
          return { type: 'system' as const, content: `工具结果: ${log.content.slice(0, 300)}` };
        }
      }
      return {
        type: 'system' as const,
        content: `${log.event_type}: ${log.content.slice(0, 300)}`,
      };
    });

    const lastEvent = agentLogs[agentLogs.length - 1]?.event_type || 'running';
    const status = normalizeAgentStatus(
      lastEvent.startsWith('agent_') ? lastEvent.slice('agent_'.length) : lastEvent,
    );

    return {
      agentId: agentLogs[0]?.agent_id,
      name,
      role: agentLogs[0]?.agent_role,
      taskId: agentLogs[0]?.task_id,
      status,
      messages,
    };
  }));

  if (pendingPlan && typeof pendingPlan === 'object') {
    const plan = pendingPlan as {
      goal?: string;
      analysis?: string;
      approach?: string;
      risks?: string;
      verification?: string;
    };
    channels.push({
      name: 'plan',
      role: 'plan',
      status: 'waiting',
      messages: [{
        type: 'system',
        content: [
          '方案评审',
          plan.goal ? `Goal: ${plan.goal}` : '',
          plan.analysis ? `Analysis: ${plan.analysis}` : '',
          plan.approach ? `Approach: ${plan.approach}` : '',
          plan.risks ? `Risks: ${plan.risks}` : '',
          plan.verification ? `Verification: ${plan.verification}` : '',
        ].filter(Boolean).join('\n\n'),
      }],
    });
  }

  return channels;
}

export function buildInitialChannels(db: TuiSnapshotDb, sessionId: string): CommandInitialChannelSeed[] {
  const agentLogs = db.getAgentLogs(sessionId);
  const pendingPlan = db.getSessionState(sessionId, SESSION_KEYS.PENDING_PLAN);
  const channels = toInitialChannels(agentLogs, pendingPlan);
  const conversations = typeof db.getAllAgentConversationsSync === 'function'
    ? db.getAllAgentConversationsSync(sessionId)
    : [];
  const agentStates = typeof db.getAgentStates === 'function'
    ? db.getAgentStates(sessionId)
    : [];
  return mergeAgentConversationChannels(channels, conversations, agentStates);
}

export function buildTuiSnapshot(
  db: TuiSnapshotDb,
  sessionId: string
) {
  const sessionInfo = db.getSession(sessionId);
  if (!sessionInfo) {
    return null;
  }

  const tasks = toInitialTasks(db.getTasksBySession(sessionId));

  // Use leader_conversation as single source of truth
  const messages = toInitialMessages(db.getConversation(sessionId));

  const leaderMode = db.getSessionState(sessionId, SESSION_KEYS.LEADER_EXECUTION_MODE);
  const leaderReason = db.getSessionState(sessionId, SESSION_KEYS.LEADER_EXECUTION_REASON);
  const permissionSummary = summarizePermissionContextForDisplay(
    normalizeToolPermissionContext(db.getSessionState(sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT))
  );
  const channels = buildInitialChannels(db, sessionId);
  const blockedCount = tasks.filter((task) => normalizeTaskDisplayState(task) === 'blocked').length;
  const recoveryRecords = typeof db.listSessionStateByPrefix === 'function'
    ? listRecoveryRecords(db as Pick<DatabaseManager, 'listSessionStateByPrefix'>, sessionId)
    : [];
  const recoveringCount = recoveryRecords.filter((record) => record.status === 'recovering').length;
  const recoveryBlockedCount = recoveryRecords.filter((record) => record.status === 'blocked').length;
  const sessionRunStatus = normalizeRunStatus(sessionInfo.status);
  const leaderStatus = recoveringCount > 0
      ? `Recovering (${recoveringCount})`
      : recoveryBlockedCount > 0
        ? `Recovery Blocked (${recoveryBlockedCount})`
        : blockedCount > 0
          ? `Blocked (${blockedCount})`
          : sessionRunStatus === 'cancelled'
            ? 'Interrupted'
            : sessionRunStatus === 'completed'
              ? 'Completed'
              : sessionRunStatus === 'failed'
                ? 'Failed'
                : 'Initializing...';

  // 计算 token 统计，确保会话切换时前端能热加载
  const tokenRows = db.getTokenSummary(sessionId);
  const tokenUsage = tokenRows.reduce((sum, r) => sum + (r.total || 0), 0);
  const nameByAgentId = new Map(channels.flatMap((channel) => (
    channel.agentId ? [[channel.agentId, channel.name] as const] : []
  )));
  const agentTokens: Record<string, number> = {};
  for (const row of tokenRows) {
    const visibleName = nameByAgentId.get(row.agent_id) || row.agent_name || row.agent_id;
    agentTokens[visibleName] = (agentTokens[visibleName] || 0) + (row.total || 0);
    agentTokens[row.agent_id] = (agentTokens[row.agent_id] || 0) + (row.total || 0);
  }

  return {
    sessionStatus: {
      sessionId: sessionInfo.id,
      workspace: sessionInfo.workspace,
      status: sessionInfo.status,
      createdAt: sessionInfo.created_at * 1000,
      permissionSummary,
    },
    tasks,
    messages,
    channels,
    tokenUsage,
    agentTokens,
    leaderStatus,
    leaderMode: normalizeLeaderMode(leaderMode),
    leaderReason: typeof leaderReason === 'string' ? leaderReason : undefined,
  };
}
