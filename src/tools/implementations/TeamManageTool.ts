import { z } from 'zod';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { TeamCreateTool } from './TeamCreate.js';
import { TeamDeleteTool } from './TeamDelete.js';
import { TeamEditTool } from './TeamEdit.js';
import { TeamListMembersTool } from './TeamListMembers.js';
import { TeamStatusTool } from './TeamStatus.js';
import { TeamTaskBoardTool } from './TeamTaskBoard.js';

const TeamManageSchema = z.object({
  action: z.enum(['create', 'delete', 'edit', 'list_members', 'status', 'task_board'])
    .describe([
      'Team action to run.',
      'create requires team_name, leader, members.',
      'delete requires team_name.',
      'edit requires edit_action and team_name.',
      'list_members/status accept optional team_name.',
      'task_board accepts optional member and include_terminal.',
    ].join(' ')),
  team_name: z.string().min(1).max(128).optional().describe('目标 team 名；create/delete/edit 需要，list_members/status 可省略'),
  description: z.string().max(1024).optional().describe('create/edit: 团队用途描述'),
  leader: z.string().min(1).optional().describe('create: 团队 Leader 的 Agent 名称'),
  members: z.array(z.string().min(1)).min(1).max(20).optional().describe('create: 团队成员列表; edit add/remove: 批量成员名列表（与 member 互斥，同时提供时 members 优先）'),
  workspace: z.string().optional().describe('create: 团队共享工作区路径'),
  edit_action: z.enum(['add', 'remove', 'rename', 'set_leader', 'list']).optional().describe('edit: roster operation'),
  member: z.string().min(1).optional().describe('edit/task_board: 单个成员名。批量 add/remove 时改用 members 数组'),
  new_name: z.string().min(1).optional().describe('edit rename: 新成员名'),
  include_terminal: z.boolean().optional().describe('status/task_board: 是否包含已完成/失败任务，默认 true'),
});

type TeamManageAction = z.infer<typeof TeamManageSchema>['action'];

const TARGETS: Record<TeamManageAction, Tool> = {
  create: new TeamCreateTool(),
  delete: new TeamDeleteTool(),
  edit: new TeamEditTool(),
  list_members: new TeamListMembersTool(),
  status: new TeamStatusTool(),
  task_board: new TeamTaskBoardTool(),
};

export class TeamManageTool extends Tool {
  readonly name = 'team_manage';
  readonly description = 'Team 管理/状态统一入口。重要前置条件：team 模式下分配/派发 Agent 前必须先有 active team；没有 active team 时先调用 action=create 建团，并把后续 dispatch_agent 使用的精确 agent_name 放入 members。可用 action=create/delete/edit/list_members/status/task_board 创建、删除、维护 roster、查看成员、检查团队状态或读取任务板。';
  readonly parameters = TeamManageSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = TeamManageSchema.parse(args);
    const { action, edit_action, ...forwarded } = params as Record<string, unknown> & { action: TeamManageAction; edit_action?: string };
    if (action === 'edit' && edit_action) {
      forwarded.action = edit_action;
    }
    const target = TARGETS[action];
    const parsed = target.parameters.safeParse(forwarded);
    if (!parsed.success) {
      const formatted = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return createToolError({
        code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
        message: `team_manage(action="${action}") 参数校验失败：${formatted}`,
        retryable: true,
        cause: formatted,
        fix: `按 ${target.name} 的参数要求补齐字段后重试。`,
        hints: parsed.error.issues.slice(0, 8).map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
    }
    return target.execute(parsed.data, context);
  }
}
