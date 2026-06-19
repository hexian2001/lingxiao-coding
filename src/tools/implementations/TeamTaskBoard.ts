/**
 * TeamTaskBoardTool — 共享进度可见：让 team 成员只读查询同伴的任务状态/进度。
 *
 * 解决「成员不靠发消息也能知道同伴在干什么」：worker 调用本工具即可看到
 * 同 team 所有成员当前的任务（subject / status / 归属 / 是否阻塞），以及哪些
 * 任务 ready/blocked。数据源是共享 SQLite（DB 是任务的真源，worker 子进程
 * 持有自己的 DB 连接），因此跨进程无需 IPC。
 *
 * 只读、脱敏：仅返回本 session、本 team roster 成员相关的任务，不暴露其它 session。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { normalizeAgentName, resolveCallerTeamView } from '../../core/TeamView.js';
import { isTaskTerminalStatus, normalizeTaskStatus } from '../../core/StateSemantics.js';

interface BoardTaskView {
  id: string;
  subject: string;
  status: string;             // dispatchable / running / terminal
  exit_reason?: string;       // completed / failed / cancelled / timeout
  assigned_agent?: string;    // 当前归属成员（运行中/已完成）
  preferred_agent_name?: string;
  effective_member?: string;  // assigned_agent || preferred_agent_name
  blocked_by: string[];
  is_ready: boolean;          // dispatchable 且所有依赖已 completed
}

function isCompleted(t: { status: string; exit_reason?: string }): boolean {
  return normalizeTaskStatus(t) === 'completed';
}

function normalizeMemberFilter(member?: string): string | undefined {
  const value = member?.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'all') return undefined;
  return value;
}

export class TeamTaskBoardTool extends Tool {
  readonly name = '__team_manage_task_board';
  readonly description = 'team_manage(action="task_board") 的内部实现：只读查看同 team 成员任务进度、归属、ready/blocked。';
  readonly parameters = z.object({
    member: z.string().min(1).optional().describe('只看某个成员的任务；省略则看全队'),
    include_terminal: z.boolean().optional().describe('是否包含已完成/失败的任务，默认 true'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as { member?: string; include_terminal?: boolean };
    const includeTerminal = params.include_terminal !== false;

    const senderName = context?.agentName;
    const sessionId = context?.sessionId;
    if (!senderName) {
      return { success: false, data: null, error: '当前调用没有 agentName，无法定位所属 team。' };
    }
    if (!sessionId) {
      return { success: false, data: null, error: '当前调用没有 sessionId，无法查询任务。' };
    }
    if (!context?.db) {
      return { success: false, data: null, error: '当前进程没有 DB 连接，无法查询任务板。' };
    }

    const resolved = resolveCallerTeamView(context);
    if (!resolved.ok) return { success: false, data: null, error: resolved.error };
    const teamName = resolved.view.team.name;
    const rosterNames = resolved.view.rosterNames;

    // 从共享 DB 拉本 session 的任务（DB 是真源，跨进程安全）
    let rawTasks: Array<{
      id: string; subject: string; status: string; exit_reason?: string;
      assigned_agent: string; preferred_agent_name?: string; blocked_by: string[];
    }>;
    try {
      rawTasks = context.db.getTasksBySession(sessionId) as never;
    } catch (err) {
      return { success: false, data: null, error: `查询任务失败：${err instanceof Error ? err.message : String(err)}` };
    }

    const byId = new Map(rawTasks.map(t => [t.id, t]));
    const isReady = (t: { status: string; blocked_by: string[] }): boolean => {
      // dispatchable 是 TaskBoard 内核状态；依赖是否完成统一用 StateSemantics 解释。
      if (t.status !== 'dispatchable') return false;
      for (const depId of t.blocked_by || []) {
        const dep = byId.get(depId);
        if (!dep || !isCompleted(dep)) return false;
      }
      return true;
    };

    const filterMember = normalizeMemberFilter(params.member);

    const views: BoardTaskView[] = rawTasks
      .filter(t => {
        if (!includeTerminal && isTaskTerminalStatus(t)) return false;
        const effectiveMember = t.assigned_agent || t.preferred_agent_name || '';
        if (rosterNames && effectiveMember && !rosterNames.has(normalizeAgentName(effectiveMember))) return false;
        if (filterMember && normalizeAgentName(effectiveMember) !== normalizeAgentName(filterMember)) return false;
        return true;
      })
      .map(t => {
        const effectiveMember = t.assigned_agent || t.preferred_agent_name || '';
        return {
          id: t.id,
          subject: t.subject,
          status: t.status,
          exit_reason: t.exit_reason,
          assigned_agent: t.assigned_agent || undefined,
          preferred_agent_name: t.preferred_agent_name || undefined,
          effective_member: effectiveMember || undefined,
          blocked_by: t.blocked_by || [],
          is_ready: isReady(t),
        };
      });

    const running = views.filter(v => normalizeTaskStatus(v) === 'running');
    const ready = views.filter(v => v.is_ready);
    const blocked = views.filter(v => v.status === 'dispatchable' && !v.is_ready);
    const done = views.filter(v => isTaskTerminalStatus(v));

    return {
      success: true,
      data: {
        team: teamName || '(session)',
        viewer: senderName,
        summary: {
          running: running.length,
          ready: ready.length,
          blocked: blocked.length,
          terminal: done.length,
        },
        tasks: views,
      },
    };
  }
}
