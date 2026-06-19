/**
 * TeamListMembersTool — list members of a team.
 *
 * Defaults to the caller's own team if team_name omitted.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTeamView } from '../../core/TeamView.js';

export class TeamListMembersTool extends Tool {
  readonly name = '__team_manage_list_members';
  readonly description = 'team_manage(action="list_members") 内部实现：只看 leader/members 以及 dispatched/interactive 状态。';
  readonly parameters = z.object({
    team_name: z.string().min(1).optional().describe('目标 team 名；省略则用调用者所在 team'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as { team_name?: string };
    const resolved = resolveTeamView(context, params.team_name);
    if (!resolved.ok) return { success: false, data: null, error: resolved.error };
    const { team, members, hint } = resolved.view;

    return {
      success: true,
      data: {
        team: team.name,
        description: team.description,
        leader: team.leader,
        workspace: team.workspace,
        members,
        hint,
      },
    };
  }
}
