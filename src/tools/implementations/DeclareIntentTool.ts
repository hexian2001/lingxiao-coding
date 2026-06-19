import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';

const DeclareIntentSchema = z.object({
  title: z.string().describe('Intent 标题，简述探索方向'),
  content: z.string().describe('Intent 详细描述，说明为什么需要探索以及预期产出'),
  tags: z.array(z.string()).optional().describe('标签列表，用于匹配和优先级排序'),
  priority: z.number().int().min(1).max(10).optional().describe('优先级 1-10，1 最高'),
});

export class DeclareIntentTool extends Tool {
  readonly name = 'declare_intent';
  readonly description = '声明一条待探索方向。Intent 可被其他 Agent 认领并执行探索，完成后变为 resolved。';
  readonly parameters = DeclareIntentSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof DeclareIntentSchema>;
    const graph = context?.blackboardGraph;
    const sessionId = context?.sessionId;

    if (!graph || !sessionId) {
      return { success: false, data: null, error: '黑板图未初始化或 sessionId 缺失' };
    }

    try {
      const node = graph.addIntent({
        sessionId,
        title: params.title,
        content: params.content,
        tags: params.tags ?? [],
        createdBy: context.taskId ?? context.agentId ?? 'unknown',
        intentStatus: 'open',
        priority: params.priority ?? 5,
      });

      return {
        success: true,
        data: `Intent ${node.id} 已声明: ${node.title}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `声明 Intent 失败: ${msg}` };
    }
  }
}
