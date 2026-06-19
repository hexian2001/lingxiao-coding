import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { ConfidenceSchema, EvidenceItemSchema } from '../../core/blackboard/schemas.js';

const WriteFactSchema = z.object({
  title: z.string().describe('Fact 标题'),
  content: z.string().describe('Fact 详细内容'),
  tags: z.array(z.string()).optional().describe('标签列表，用于分类和检索'),
  confidence: ConfidenceSchema.optional().describe('置信度: confirmed=已确认, likely=很可能, tentative=待验证'),
  evidence: z.array(EvidenceItemSchema).optional().describe('支撑证据列表'),
});

export class WriteFactTool extends Tool {
  readonly name = 'write_fact';
  readonly description = '向知识图谱写入一条已确认事实。Fact 一旦写入不可修改，只能被新 Fact 替代。';
  readonly parameters = WriteFactSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof WriteFactSchema>;
    const graph = context?.blackboardGraph;
    const sessionId = context?.sessionId;

    if (!graph || !sessionId) {
      return { success: false, data: null, error: '黑板图未初始化或 sessionId 缺失' };
    }

    try {
      const node = graph.addFact({
        sessionId,
        title: params.title,
        content: params.content,
        tags: params.tags ?? [],
        createdBy: context.taskId ?? context.agentId ?? 'unknown',
        confidence: params.confidence ?? 'confirmed',
        evidence: params.evidence,
      });

      return {
        success: true,
        data: `Fact ${node.id} 已写入: ${node.title}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `写入 Fact 失败: ${msg}` };
    }
  }
}
