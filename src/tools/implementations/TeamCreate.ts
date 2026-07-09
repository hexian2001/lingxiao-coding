/**
 * TeamCreateTool — Create a new multi-agent team with a leader and member roster.
 *
 * 团队成员的主键直接是 (sessionId, agent name)，不再生成内部 member id。
 * E 阶段：经 TeamMailbox.createTeamWithRoster 原子写 definition + registry。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox } from '../../core/TeamMailbox.js';
import { coreLogger } from '../../core/Log.js';

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

    const mailbox = getTeamMailbox();
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return {
        success: false,
        data: null,
        error: 'team_manage(action="create") 必须在明确 sessionId 的上下文中调用。',
      };
    }

    if (mailbox.teamExists(params.team_name, sessionId)) {
      return {
        success: false,
        data: null,
        error: `Team "${params.team_name}" already exists. Use team_manage(action="delete") first if you need to recreate it.`,
      };
    }

    const workspace = params.workspace || context?.workspace || process.cwd();
    const allMembers = Array.from(new Set([params.leader, ...params.members]));

    try {
      mailbox.createTeamWithRoster({
        name: params.team_name,
        description: params.description,
        leader: params.leader,
        members: params.members,
        workspace,
        sessionId,
      });
    } catch (err) {
      return {
        success: false,
        data: null,
        error: `Team "${params.team_name}" creation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 黑板群组投影 — 观测增强，失败不阻断建团
    if (context?.blackboardGraph && context?.sessionId) {
      try {
        context.blackboardGraph.addGroupTag(context.sessionId, params.team_name, {
          leader: params.leader,
          members: params.members,
          workspace,
          description: params.description,
        });
      } catch (err) {
        coreLogger.warn(`[TeamCreate] blackboard group projection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      success: true,
      data: `Team "${params.team_name}" created with ${allMembers.length} members.\nLeader: ${params.leader}\nMembers: ${params.members.join(', ')}`,
    };
  }
}
