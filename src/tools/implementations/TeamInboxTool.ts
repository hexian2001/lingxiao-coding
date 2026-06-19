import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { TeamInboxCheckTool } from './TeamInboxCheck.js';

const TeamInboxSchema = z.object({
  unread_only: z.boolean().optional().describe('默认 true：只返回未读消息；false 时回看历史。'),
  mark_read: z.boolean().optional().describe('默认 true：返回后自动标记为已读。'),
  limit: z.number().int().min(1).max(50).optional().describe('返回条数上限，默认 20。'),
});

export class TeamInboxTool extends Tool {
  readonly name = 'team_inbox';
  readonly description = 'Team inbox 统一入口：读取未读消息、历史消息和 ack/request 闭环摘要，可选择返回后标记为已读。';
  readonly parameters = TeamInboxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    return new TeamInboxCheckTool().execute(args, context);
  }
}
