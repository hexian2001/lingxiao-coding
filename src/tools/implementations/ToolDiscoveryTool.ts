import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { ToolRegistry } from '../Registry.js';
import { SESSION_KEYS } from '../../core/SessionStateKeys.js';
import { isOfficeToolName } from '../officeToolContract.js';
import type { ToolDefinitionScope } from '../Registry.js';
import { BUGHUNT_MODE_TOOL_NAMES } from '../../contracts/constants/toolNames.js';
import { resolveModeRuntimeProjection } from '../../core/ModeRuntimeProjection.js';
import { getToolPermissionContextFromToolContext } from '../../core/PermissionSystem.js';
import { getTeamMemberRegistry } from '../../core/TeamMailbox.js';

const FindToolsSchema = z.object({
  query: z.string().optional().describe('按工具名、描述、分类、tier、schema 字段搜索'),
  category: z.string().optional().describe('只返回指定 category，如 file/browser/office'),
  tier: z.enum(['read', 'write', 'execute', 'compute']).optional().describe('只返回指定能力层级'),
  include_schema: z.boolean().optional().default(false).describe('是否返回 JSON schema 和示例参数'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('最多返回数量'),
});

function scoreTool(query: string, text: string, name: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const haystack = text.toLowerCase();
  let score = 0;
  if (name.toLowerCase() === q) score += 100;
  if (name.toLowerCase().includes(q)) score += 50;
  if (haystack.includes(q)) score += 20;
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) score += 5;
  }
  return score;
}

export class ToolDiscoveryTool extends Tool {
  readonly name = 'find_tools';
  readonly description = '发现当前可用工具：按名称/描述/category/tier/schema 搜索，返回元数据、风险和示例参数。先用它确认工具名，再调用 tool_preflight 或目标工具。';
  readonly parameters = FindToolsSchema;

  constructor(private readonly registry: ToolRegistry) {
    super();
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof FindToolsSchema>;
    const query = (params.query || '').trim();
    const officeMode = Boolean(
      context?.sessionId &&
      context.db?.getSessionState(context.sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true',
    );
    const bughuntMode = Boolean(
      context?.sessionId &&
      context.db?.getSessionState(context.sessionId, SESSION_KEYS.BUGHUNT_MODE_ACTIVE) === 'true',
    );
    const workflowMode = Boolean(
      context?.sessionId &&
      context.db?.getSessionState(context.sessionId, SESSION_KEYS.WORKFLOW_MODE_ACTIVE) === 'true',
    );
    const blackboardAvailable = Boolean(context?.blackboardGraph);
    const scope: ToolDefinitionScope =
      context?.agentId === 'leader' || context?.agentName === 'leader' || context?.leaderToolsExecutor
        ? 'all'
        : 'worker';
    const modes = (() => {
      if (!context?.sessionId || !context.db) return undefined;
      try {
        return resolveModeRuntimeProjection({
          sessionId: context.sessionId,
          db: context.db,
          permissionContext: getToolPermissionContextFromToolContext(context),
          blackboardAvailable,
        });
      } catch {
        return undefined;
      }
    })();
    let callerInTeamRoster = scope === 'all';
    let callerIsTeamLeader = scope === 'all';
    if (scope !== 'all' && modes?.collaboration.teamEnabled && context?.agentName && context.sessionId) {
      try {
        const member = getTeamMemberRegistry().getByName(context.agentName, context.sessionId);
        callerInTeamRoster = Boolean(member);
        callerIsTeamLeader = member?.role === 'leader';
      } catch {
        callerInTeamRoster = false;
        callerIsTeamLeader = false;
      }
    }
    const bughuntTools = new Set<string>(BUGHUNT_MODE_TOOL_NAMES);
    const all = this.registry.listToolInspections({
      includeSchema: params.include_schema === true,
      scope,
      ...(modes
        ? {
            modePolicy: {
              modes,
              actor: scope === 'all' ? 'leader' : callerInTeamRoster ? 'team_member' : 'worker',
              agentName: typeof context?.agentName === 'string' ? context.agentName : undefined,
              callerInTeamRoster,
              callerIsTeamLeader,
            },
          }
        : {}),
    })
      .filter((tool) => officeMode || !isOfficeToolName(tool.name))
      .filter((tool) => bughuntMode || !bughuntTools.has(tool.name))
      .filter((tool) => workflowMode || tool.name !== 'workflow')
      .filter((tool) => blackboardAvailable || tool.name !== 'blackboard');

    const ranked = all
      .filter((tool) => !params.category || tool.metadata.category === params.category)
      .filter((tool) => !params.tier || tool.metadata.tier === params.tier)
      .map((tool) => {
        const schemaText = params.include_schema && tool.schema ? JSON.stringify(tool.schema) : '';
        const text = [tool.name, tool.description, tool.metadata.category, tool.metadata.tier, schemaText].join(' ');
        return { tool, score: scoreTool(query, text, tool.name) };
      })
      .filter((item) => !query || item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, params.limit ?? 20)
      .map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        loaded: tool.loaded,
        deferred: tool.deferred,
        metadata: tool.metadata,
        schema: tool.schema,
        example_args: tool.example_args,
        next_tool_hints: ['tool_preflight', ...(tool.metadata.nextToolHints || [])],
      }));

    return {
      success: true,
      data: {
        query,
        mode: officeMode ? 'office' : bughuntMode ? 'bughunt' : workflowMode ? 'workflow' : 'normal',
        mode_flags: { office: officeMode, bughunt: bughuntMode, workflow: workflowMode, blackboard: blackboardAvailable },
        count: ranked.length,
        tools: ranked,
      },
    };
  }
}

export default ToolDiscoveryTool;
