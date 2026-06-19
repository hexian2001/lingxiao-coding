/**
 * TeamEditTool — team_manage(action="edit") 的内部实现：增删改查已存在 team 的成员名册。
 *
 * 动作（action）：
 *   - add     : 向 roster 追加成员（同时注册到 TeamMemberRegistry）
 *   - remove  : 从 roster 移除成员（同时从 registry 注销）；leader 切换使用 set_leader
 *   - rename  : 把某成员改名（registry 注销旧名 + 注册新名，并更新 roster）
 *   - list    : 列出当前 roster + leader（等价 team_manage(action="list_members") 的精简视图）
 *
 * 主键 name + sessionId 不变；leader 通过 set_leader 单独切换。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../../core/TeamMailbox.js';

export class TeamEditTool extends Tool {
  readonly name = '__team_manage_edit';
  readonly description = 'team_manage(action="edit") 内部实现：action=add 增员 / remove 删员 / rename 改名 / set_leader 换 leader / list 查询。leader 切换使用 set_leader；增删改会同步 TeamMemberRegistry 和 teams.members_json。';
  readonly parameters = z.object({
    team_name: z.string().min(1).describe('目标 team 名'),
    action: z.enum(['add', 'remove', 'rename', 'set_leader', 'list']).describe('操作类型：add 增员 / remove 删员 / rename 改名 / set_leader 换 leader / list 查询'),
    member: z.string().min(1).optional().describe('add/remove/rename/set_leader 的目标成员名。rename 时为旧名；set_leader 时为新 leader 名。批量操作时改用 members 数组'),
    members: z.array(z.string().min(1)).min(1).max(20).optional().describe('批量 add/remove 时的成员名列表。与 member 互斥；同时提供时 members 优先'),
    new_name: z.string().min(1).optional().describe('action=rename 时的新成员名'),
    description: z.string().max(1024).optional().describe('可选：顺带更新 team 描述'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as {
      team_name: string;
      action: 'add' | 'remove' | 'rename' | 'set_leader' | 'list';
      member?: string;
      members?: string[];
      new_name?: string;
      description?: string;
    };

    const mailbox = getTeamMailbox();
    const registry = getTeamMemberRegistry();
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return {
        success: false,
        data: null,
        error: 'team_manage(action="edit") 必须在明确 sessionId 的上下文中调用。',
      };
    }
    const mailboxSessionId = sessionId;

    const normalize = (n: string) => n.trim().replace(/^@+/, '');

    const team = mailbox.getTeam(params.team_name, mailboxSessionId);
    if (!team) {
      return { success: false, data: null, error: `Team "${params.team_name}" 不存在。先用 team_manage(action="create") 建团。` };
    }

    const renderRoster = (note: string): ToolResult => {
      const fresh = mailbox.getTeam(params.team_name, mailboxSessionId)!;
      return {
        success: true,
        data: {
          team: fresh.name,
          leader: fresh.leader,
          members: fresh.members,
          description: fresh.description,
          note,
        },
      };
    };

    if (params.action === 'list') {
      return renderRoster('当前 roster');
    }

    const workspace = team.workspace || context?.workspace || process.cwd();

    if (params.action === 'add') {
      // 批量支持：members 数组优先，回退到单个 member
      const isBatch = !!params.members && params.members.length > 0;
      const rawNames = params.members ?? (params.member ? [params.member] : []);
      if (rawNames.length === 0) {
        return { success: false, data: null, error: 'action=add 必须提供 member 或 members。' };
      }
      const names = rawNames.map(normalize).filter(Boolean);
      // 单成员模式：保持原有精确错误消息（向后兼容测试和调用方）
      if (!isBatch && names.length === 1) {
        const member = names[0];
        if (member === normalize(team.leader)) {
          return { success: false, data: null, error: `"${member}" 已是该 team 的 leader，无需作为成员添加。` };
        }
        if (team.members.some(m => normalize(m) === member)) {
          return { success: false, data: null, error: `成员 "${member}" 已在 team "${params.team_name}" 中。` };
        }
        const nextMembers = [...team.members, member];
        mailbox.updateTeam(params.team_name, mailboxSessionId, {
          members: nextMembers,
          description: params.description,
        });
        registry.register({ name: member, team: params.team_name, role: 'member', workspace, sessionId: mailboxSessionId });
        this.syncBlackboard(context, params.team_name, team.leader, nextMembers, workspace, params.description ?? team.description);
        return renderRoster(`已添加成员 "${member}"`);
      }
      // 批量模式：收集成功 + 跳过
      const added: string[] = [];
      const skipped: string[] = [];
      let nextMembers = [...team.members];
      for (const member of names) {
        if (member === normalize(team.leader)) { skipped.push(`${member}(leader)`); continue; }
        if (nextMembers.some(m => normalize(m) === member)) { skipped.push(`${member}(exists)`); continue; }
        nextMembers.push(member);
        registry.register({ name: member, team: params.team_name, role: 'member', workspace, sessionId: mailboxSessionId });
        added.push(member);
      }
      if (added.length === 0) {
        return { success: false, data: null, error: `没有新成员被添加。跳过：${skipped.join(', ')}` };
      }
      mailbox.updateTeam(params.team_name, mailboxSessionId, {
        members: nextMembers,
        description: params.description,
      });
      this.syncBlackboard(context, params.team_name, team.leader, nextMembers, workspace, params.description ?? team.description);
      const note = `已批量添加 ${added.length} 名成员：${added.join(', ')}` + (skipped.length > 0 ? `；跳过：${skipped.join(', ')}` : '');
      return renderRoster(note);
    }

    if (params.action === 'remove') {
      // 批量支持：members 数组优先，回退到单个 member
      const isBatch = !!params.members && params.members.length > 0;
      const rawNames = params.members ?? (params.member ? [params.member] : []);
      if (rawNames.length === 0) {
        return { success: false, data: null, error: 'action=remove 必须提供 member 或 members。' };
      }
      const names = rawNames.map(normalize).filter(Boolean);
      // 单成员模式：保持原有精确错误消息（向后兼容测试和调用方）
      if (!isBatch && names.length === 1) {
        const member = names[0];
        if (member === normalize(team.leader)) {
          return { success: false, data: null, error: `leader "${member}" 的切换请使用 action=set_leader。` };
        }
        if (!team.members.some(m => normalize(m) === member)) {
          return { success: false, data: null, error: `成员 "${member}" 不在 team "${params.team_name}" 中。` };
        }
        const nextMembers = team.members.filter(m => normalize(m) !== member);
        mailbox.updateTeam(params.team_name, mailboxSessionId, {
          members: nextMembers,
          description: params.description,
        });
        registry.unregister(member, mailboxSessionId);
        this.syncBlackboard(context, params.team_name, team.leader, nextMembers, workspace, params.description ?? team.description);
        return renderRoster(`已移除成员 "${member}"`);
      }
      // 批量模式：收集成功 + 跳过
      const removed: string[] = [];
      const skipped: string[] = [];
      for (const member of names) {
        if (member === normalize(team.leader)) { skipped.push(`${member}(leader)`); continue; }
        if (!team.members.some(m => normalize(m) === member)) { skipped.push(`${member}(not_found)`); continue; }
        registry.unregister(member, mailboxSessionId);
        removed.push(member);
      }
      if (removed.length === 0) {
        return { success: false, data: null, error: `没有成员被移除。跳过：${skipped.join(', ')}` };
      }
      const removedSet = new Set(removed.map(normalize));
      const nextMembers = team.members.filter(m => !removedSet.has(normalize(m)));
      mailbox.updateTeam(params.team_name, mailboxSessionId, {
        members: nextMembers,
        description: params.description,
      });
      this.syncBlackboard(context, params.team_name, team.leader, nextMembers, workspace, params.description ?? team.description);
      const note = `已批量移除 ${removed.length} 名成员：${removed.join(', ')}` + (skipped.length > 0 ? `；跳过：${skipped.join(', ')}` : '');
      return renderRoster(note);
    }

    if (params.action === 'rename') {
      const oldName = params.member && normalize(params.member);
      const newName = params.new_name && normalize(params.new_name);
      if (!oldName || !newName) {
        return { success: false, data: null, error: 'action=rename 必须同时提供 member（旧名）和 new_name（新名）。' };
      }
      if (oldName === newName) {
        return { success: false, data: null, error: '新旧名相同，无需 rename。' };
      }
      const isLeader = oldName === normalize(team.leader);
      const inMembers = team.members.some(m => normalize(m) === oldName);
      if (!isLeader && !inMembers) {
        return { success: false, data: null, error: `成员 "${oldName}" 不在 team "${params.team_name}" 中。` };
      }
      if (team.members.some(m => normalize(m) === newName) || normalize(team.leader) === newName) {
        return { success: false, data: null, error: `新名 "${newName}" 已被该 team 占用。` };
      }
      const nextMembers = inMembers
        ? team.members.map(m => (normalize(m) === oldName ? newName : m))
        : team.members;
      const nextLeader = isLeader ? newName : team.leader;
      mailbox.updateTeam(params.team_name, mailboxSessionId, {
        members: nextMembers,
        leader: nextLeader,
        description: params.description,
      });
      registry.unregister(oldName, mailboxSessionId);
      registry.register({
        name: newName,
        team: params.team_name,
        role: isLeader ? 'leader' : 'member',
        workspace,
        sessionId: mailboxSessionId,
      });
      this.syncBlackboard(context, params.team_name, nextLeader, nextMembers, workspace, params.description ?? team.description);
      return renderRoster(`已将 "${oldName}" 改名为 "${newName}"`);
    }

    if (params.action === 'set_leader') {
      const newLeader = params.member && normalize(params.member);
      if (!newLeader) {
        return { success: false, data: null, error: 'action=set_leader 必须提供 member（新 leader 名）。' };
      }
      if (newLeader === normalize(team.leader)) {
        return { success: false, data: null, error: `"${newLeader}" 已经是 leader。` };
      }
      // 新 leader 必须已是成员；旧 leader 降级为普通成员
      const wasMember = team.members.some(m => normalize(m) === newLeader);
      if (!wasMember) {
        return { success: false, data: null, error: `新 leader "${newLeader}" 必须先是 team 成员（用 action=add 加入后再 set_leader）。` };
      }
      const oldLeader = normalize(team.leader);
      const nextMembers = team.members
        .filter(m => normalize(m) !== newLeader)
        .concat(oldLeader);
      mailbox.updateTeam(params.team_name, mailboxSessionId, {
        leader: newLeader,
        members: nextMembers,
        description: params.description,
      });
      // registry 角色同步
      registry.register({ name: newLeader, team: params.team_name, role: 'leader', workspace, sessionId: mailboxSessionId });
      registry.register({ name: oldLeader, team: params.team_name, role: 'member', workspace, sessionId: mailboxSessionId });
      this.syncBlackboard(context, params.team_name, newLeader, nextMembers, workspace, params.description ?? team.description);
      return renderRoster(`已将 leader 从 "${oldLeader}" 切换为 "${newLeader}"`);
    }

    return { success: false, data: null, error: `未知 action: ${String(params.action)}` };
  }

  /** 同步黑板 group 投影，让消费方拿到最新 roster。失败不影响主流程。 */
  private syncBlackboard(
    context: ToolContext | undefined,
    teamName: string,
    leader: string,
    members: string[],
    workspace: string,
    description?: string,
  ): void {
    if (context?.blackboardGraph && context?.sessionId) {
      try {
        context.blackboardGraph.addGroupTag(context.sessionId, teamName, {
          leader,
          members,
          workspace,
          description,
        });
      } catch (err) {
        console.warn(`[TeamEdit] blackboard group projection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
