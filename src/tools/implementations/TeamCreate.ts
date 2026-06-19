/**
 * TeamCreateTool — Create a new multi-agent team with a leader and member roster.
 *
 * 团队成员的主键直接是 (sessionId, agent name)，不再生成内部 member id。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../../core/TeamMailbox.js';

export class TeamCreateTool extends Tool {
  readonly name = '__team_manage_create';
  readonly description = 'team_manage(action="create") 内部实现：创建多 Agent 协作团队，指定 Leader 和成员列表。';
  readonly parameters = z.object({
    team_name: z.string().min(1).max(128).describe('团队唯一标识名'),
    description: z.string().max(1024).optional().describe('团队用途描述'),
    leader: z.string().min(1).describe('团队 Leader 的 Agent 名称'),
    members: z.array(z.string()).min(1).max(20).describe('团队成员的 Agent 名称列表'),
    workspace: z.string().optional().describe('团队共享的工作区路径'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as {
      team_name: string;
      description?: string;
      leader: string;
      members: string[];
      workspace?: string;
    };

    const registry = getTeamMemberRegistry();
    const mailbox = getTeamMailbox();
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return {
        success: false,
        data: null,
        error: 'team_manage(action="create") 必须在明确 sessionId 的上下文中调用。',
      };
    }
    const mailboxSessionId = sessionId;

    if (mailbox.teamExists(params.team_name, mailboxSessionId)) {
      return {
        success: false,
        data: null,
        error: `Team "${params.team_name}" already exists. Use team_manage(action="delete") first if you need to recreate it.`,
      };
    }

    const workspace = params.workspace || context?.workspace || process.cwd();
    const allMembers = [params.leader, ...params.members];

    for (const memberName of allMembers) {
      registry.register({
        name: memberName,
        team: params.team_name,
        role: memberName === params.leader ? 'leader' : 'member',
        workspace,
        sessionId: mailboxSessionId,
      });
    }

    try {
      mailbox.createTeam({
        name: params.team_name,
        description: params.description,
        leader: params.leader,
        members: params.members,
        workspace,
        sessionId: mailboxSessionId,
      });
    } catch (err) {
      // mailbox 创建失败 — 回滚 registry 中刚注册的成员，避免悬挂
      const rollbackErrors: string[] = [];
      for (const name of allMembers) {
        try {
          registry.unregister(name, mailboxSessionId);
        } catch (rollbackError) {
          rollbackErrors.push(`${name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      return {
        success: false,
        data: null,
        error: `Team "${params.team_name}" creation failed: ${err instanceof Error ? err.message : String(err)}${rollbackErrors.length > 0 ? `；rollback failed: ${rollbackErrors.join('; ')}` : ''}`,
      };
    }

    // 黑板群组投影 — 让 DispatcherEngine / Reviewer / Worker payload 可以通过 group:<name> tag 拿到组上下文。
    if (context?.blackboardGraph && context?.sessionId) {
      try {
        context.blackboardGraph.addGroupTag(context.sessionId, params.team_name, {
          leader: params.leader,
          members: params.members,
          workspace,
          description: params.description,
        });
      } catch (err) {
        // 投影失败不应让 team 创建失败 — 用户视角 mailbox 已 OK，黑板侧仅是观测增强。
        console.warn(`[TeamCreate] blackboard group projection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      success: true,
      data: `Team "${params.team_name}" created with ${allMembers.length} members.\nLeader: ${params.leader}\nMembers: ${params.members.join(', ')}`,
    };
  }
}
