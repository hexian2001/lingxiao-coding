/**
 * TeamStatusTool — 综合团队状态视图
 *
 * 聚合 mailbox.getTeam + registry 成员（按 agent name 主键），
 * Leader/Worker 一次拿到团队整体状态。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox } from '../../core/TeamMailbox.js';
import { normalizeAgentName, resolveTeamView } from '../../core/TeamView.js';
import { isTaskTerminalStatus, normalizeTaskStatus } from '../../core/StateSemantics.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TeamStatusTool extends Tool {
  readonly name = '__team_manage_status';
  readonly description = 'team_manage(action="status") 内部实现：成员 roster、dispatch/interactive 状态、任务统计、未读消息数。';
  readonly parameters = z.object({
    team_name: z.string().min(1).optional().describe('目标 team 名；省略则用调用者所在 team'),
    include_terminal: z.boolean().optional().describe('是否在任务统计中包含已完成/失败的任务，默认 true'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as { team_name?: string; include_terminal?: boolean };
    const includeTerminal = params.include_terminal !== false;
    const mailbox = getTeamMailbox();
    const resolved = resolveTeamView(context, params.team_name);
    if (!resolved.ok) return { success: false, data: null, error: resolved.error };
    const { team, members, hint } = resolved.view;
    const teamName = team.name;

    // unread：以调用者视角聚合（Leader 看自己 + 团队广播；Worker 看自己 + 自己 team 广播）
    let unreadCount = 0;
    const senderForInbox = context?.agentName;
    const sessionId = context?.sessionId;
    if (senderForInbox && sessionId) {
      try {
        unreadCount = mailbox.getInboxForMember(senderForInbox, {
          teamName,
          sessionId,
          unreadOnly: true,
        }).length;
      } catch (error) {
        return { success: false, data: null, error: `读取 team inbox 失败：${errorMessage(error)}` };
      }
    }

    // 任务统计：通过 sessionId 直接查 DB（跨进程一致），但 ready/blocked 必须按依赖派生。
    let taskStats: {
      total: number;
      dispatchableRaw: number;
      ready: number;
      blocked: number;
      running: number;
      terminal: number;
      completed: number;
      failed: number;
      cancelled: number;
      timeout: number;
    } | undefined;
    if (context?.db && context?.sessionId) {
      try {
        const rosterNames = new Set(members.map(m => normalizeAgentName(m.name)));
        const allTasks = context.db.getTasksBySession(context.sessionId);
        const tasks = allTasks.filter((task) => {
          const effectiveMember = task.assigned_agent || task.preferred_agent_name || '';
          if (!includeTerminal && isTaskTerminalStatus(task)) return false;
          return !effectiveMember || rosterNames.has(normalizeAgentName(effectiveMember));
        });
        const byId = new Map(allTasks.map(task => [task.id, task]));
        const isCompleted = (taskId: string): boolean => {
          const task = byId.get(taskId);
          return normalizeTaskStatus(task) === 'completed';
        };
        const isReady = (task: typeof tasks[number]): boolean => {
          // ready/blocked 是 dispatchable 的派生展示态；完成判定统一交给 StateSemantics。
          if (task.status !== 'dispatchable') return false;
          return (task.blocked_by || []).every(isCompleted);
        };
        const dispatchableRaw = tasks.filter(t => t.status === 'dispatchable');
        const ready = dispatchableRaw.filter(isReady);
        const terminal = tasks.filter(t => isTaskTerminalStatus(t));
        taskStats = {
          total: tasks.length,
          dispatchableRaw: dispatchableRaw.length,
          ready: ready.length,
          blocked: dispatchableRaw.length - ready.length,
          running: tasks.filter(t => normalizeTaskStatus(t) === 'running').length,
          terminal: terminal.length,
          completed: terminal.filter(t => normalizeTaskStatus(t) === 'completed').length,
          failed: terminal.filter(t => normalizeTaskStatus(t) === 'failed').length,
          cancelled: terminal.filter(t => normalizeTaskStatus(t) === 'cancelled').length,
          timeout: terminal.filter(t => t.exit_reason === 'timeout').length,
        };
      } catch (error) {
        return { success: false, data: null, error: `查询团队任务统计失败：${errorMessage(error)}` };
      }
    }

    return {
      success: true,
      data: {
        team: team.name,
        description: team.description,
        leader: team.leader,
        workspace: team.workspace,
        members,
        memberCount: members.length,
        unreadCount,
        hint,
        ...(taskStats ? { taskStats } : {}),
      },
    };
  }
}
