import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { ToolRegistry } from '../Registry.js';

const ToolPreflightSchema = z.object({
  tool: z.string().describe('要检查的工具名'),
  args: z.unknown().optional().describe('准备传给工具的参数 object 或 JSON 字符串'),
  include_schema: z.boolean().optional().default(true).describe('是否返回该工具 schema'),
});

export class ToolPreflightTool extends Tool {
  readonly name = 'tool_preflight';
  readonly description = '工具调用预检：不执行目标工具，只检查工具是否存在、参数是否能解析/通过 schema、是否缺少先读文件等前置条件，并给出下一步修复建议。';
  readonly parameters = ToolPreflightSchema;

  constructor(private readonly registry: ToolRegistry) {
    super();
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ToolPreflightSchema>;
    const result = this.registry.preflight(params.tool, params.args ?? {}, context);
    if (params.include_schema === false) {
      delete (result as { schema?: unknown }).schema;
    }
    return { success: true, data: result };
  }
}

export default ToolPreflightTool;
