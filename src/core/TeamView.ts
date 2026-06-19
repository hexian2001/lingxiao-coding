import type { ToolContext } from '../contracts/types/Tool.js';
import { getTeamMailbox, getTeamMemberRegistry, type TeamDefinition, type TeamMember } from './TeamMailbox.js';
import { SESSION_KEYS } from './SessionStateKeys.js';

export interface TeamMemberView {
  name: string;
  role: 'leader' | 'member';
  workspace: string;
  registered_at: number;
  dispatched: boolean;
  interactive: boolean;
  status: string;
  agent_id?: string;
  task_id?: string;
  stopped?: boolean;
  last_seen_at?: number;
}

export interface TeamView {
  team: TeamDefinition;
  viewer?: string;
  members: TeamMemberView[];
  rosterNames: Set<string>;
  membersByName: Map<string, TeamMemberView>;
  hint: string;
}

export type TeamResolveResult = {
  ok: true;
  view: TeamView;
} | {
  ok: false;
  error: string;
};

interface AgentStateLike {
  agent_id: string;
  agent_name: string;
  task_id: string;
  status: string;
  stopped: number;
  timestamp: number;
}

interface AgentStateReader {
  getAgentStates(sessionId: string): AgentStateLike[];
}

export function normalizeAgentName(name: string): string {
  return name.trim().replace(/^@+/, '');
}

function isAgentStateReader(value: unknown): value is AgentStateReader {
  return !!value && typeof value === 'object' && typeof (value as { getAgentStates?: unknown }).getAgentStates === 'function';
}

function latestAgentStatesByName(context?: ToolContext): Map<string, AgentStateLike> {
  const map = new Map<string, AgentStateLike>();
  if (!isAgentStateReader(context?.db) || !context.sessionId) return map;
  try {
    for (const state of context.db.getAgentStates(context.sessionId)) {
      const key = normalizeAgentName(state.agent_name);
      const prev = map.get(key);
      if (!prev || state.timestamp > prev.timestamp) map.set(key, state);
    }
  } catch {
    // tolerate DB absence/errors; callers still get roster view
  }
  return map;
}

function inferCallerTeamName(
  callerName: string | undefined,
  sessionId: string,
  db?: unknown,
): string | undefined | { error: string } {
  if (!callerName) return { error: '没有 agentName 也没有显式 team_name，无法解析目标 team。' };
  const registry = getTeamMemberRegistry();
  const normalizedCaller = normalizeAgentName(callerName);
  const me = registry.getByName(normalizedCaller, sessionId);
  if (me) return me.team;
  // 回退：leader 进程身份恒等于它所 lead 的 active team 的 leader，与团队 leader 的显示名
  // （如 'lingxiao-leader'）无关。按 'leader' 查 roster 查不到时，直接解析到 session 的 active team，
  // 杜绝 task_board 报"leader 不在 roster"与 edit 报"已是 leader"自相矛盾。
  if (normalizedCaller === 'leader' && !!db && typeof db === 'object'
    && typeof (db as { getSessionState?: unknown }).getSessionState === 'function') {
    const activeTeam = String((db as { getSessionState(s: string, k: string): unknown }).getSessionState(sessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM) || '').trim();
    if (activeTeam) return activeTeam;
  }
  return { error: `调用者 "${callerName}" 不在当前 session 的 TeamMemberRegistry roster 中。请先 team_manage(action="create"|"edit") 显式登记成员。` };
}

export function resolveTeamView(context?: ToolContext, explicitTeamName?: string): TeamResolveResult {
  const mailbox = getTeamMailbox();
  const registry = getTeamMemberRegistry();
  const sessionId = context?.sessionId;
  if (!sessionId) return { ok: false, error: '缺少 sessionId，无法解析 team。' };
  const inferred = explicitTeamName || inferCallerTeamName(context?.agentName, sessionId, context?.db);
  if (!inferred) return { ok: false, error: '无法解析目标 team。' };
  if (typeof inferred !== 'string') return { ok: false, error: inferred.error };

  const team = mailbox.getTeam(inferred, sessionId);
  if (!team) return { ok: false, error: `Team "${inferred}" 不存在。` };

  const stateByName = latestAgentStatesByName(context);
  const registryMembers = registry.getByTeam(team.name, sessionId);
  const byName = new Map<string, TeamMember>();
  for (const member of registryMembers) byName.set(normalizeAgentName(member.name), member);
  const expectedRoster = [team.leader, ...team.members].map(normalizeAgentName);
  const missing = expectedRoster.filter(name => !byName.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Team "${team.name}" roster 与 TeamMemberRegistry 不一致，缺少成员: ${missing.join(', ')}。请用 team_manage(action="edit") 修复 roster。`,
    };
  }

  const members = Array.from(byName.values()).map((member) => {
    const normalized = normalizeAgentName(member.name);
    const state = stateByName.get(normalized);
    const isLeader = member.role === 'leader' || normalizeAgentName(team.leader) === normalized;
    const stopped = state ? Number(state.stopped) === 1 : undefined;
    const dispatched = isLeader || !!state;
    const interactive = dispatched && (isLeader || stopped !== true);
    return {
      name: member.name,
      role: isLeader ? 'leader' : 'member',
      workspace: member.workspace || team.workspace,
      registered_at: member.registeredAt,
      dispatched,
      interactive,
      status: isLeader ? 'leader' : (state?.status ?? 'not_dispatched'),
      ...(state?.agent_id ? { agent_id: state.agent_id } : {}),
      ...(state?.task_id ? { task_id: state.task_id } : {}),
      ...(stopped !== undefined ? { stopped } : {}),
      ...(state?.timestamp ? { last_seen_at: state.timestamp } : {}),
    } satisfies TeamMemberView;
  });

  const membersByName = new Map(members.map(member => [normalizeAgentName(member.name), member]));
  return {
    ok: true,
    view: {
      team,
      viewer: context?.agentName,
      members,
      rosterNames: new Set(members.map(member => normalizeAgentName(member.name))),
      membersByName,
      hint: 'P2P team_message 只能发给 interactive=true 的成员；not_dispatched 代表仅在名册中、没有运行实体，需先广播或请求 Leader dispatch。',
    },
  };
}

export function resolveCallerTeamView(context?: ToolContext): TeamResolveResult {
  return resolveTeamView(context);
}
