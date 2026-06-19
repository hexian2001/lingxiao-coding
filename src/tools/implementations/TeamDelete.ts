import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../../core/TeamMailbox.js';

export class TeamDeleteTool extends Tool {
  readonly name = '__team_manage_delete';
  readonly description = 'team_manage(action="delete") 内部实现：删除多 Agent 团队并清理资源。';
  readonly parameters = z.object({
    team_name: z.string().min(1).describe('要删除的团队名称'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as { team_name: string };

    const mailbox = getTeamMailbox();
    const registry = getTeamMemberRegistry();
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return {
        success: false,
        data: null,
        error: 'team_manage(action="delete") 必须在明确 sessionId 的上下文中调用。',
      };
    }

    if (!mailbox.teamExists(params.team_name, sessionId)) {
      return {
        success: false,
        data: null,
        error: `Team "${params.team_name}" does not exist.`,
      };
    }

    const members = registry.getByTeam(params.team_name, sessionId);
    let unregisteredCount = 0;
    for (const member of members) {
      if (registry.unregister(member.name, sessionId)) unregisteredCount++;
    }

    // Clean up messages
    const cleanedMessages = mailbox.cleanupTeam(params.team_name, sessionId);

    // Delete team
    mailbox.deleteTeam(params.team_name, sessionId);

    // 黑板群组投影 — 释放 group:<name> 节点，让消费方知道团队已解散。
    if (context?.blackboardGraph && context?.sessionId) {
      try {
        context.blackboardGraph.releaseGroupTag(context.sessionId, params.team_name, 'team_manage(action="delete")');
      } catch (err) {
        console.warn(`[TeamDelete] blackboard group release failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      success: true,
      data: `Team "${params.team_name}" deleted. ${unregisteredCount} members unregistered, ${cleanedMessages} messages cleaned up.`,
    };
  }
}
