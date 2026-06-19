import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { Confidence } from '../../core/blackboard/types.js';
import { ConfidenceSchema } from '../../core/blackboard/schemas.js';

const SupersedeNodeSchema = z.object({
  old_node_id: z.string().describe('要被替代的旧节点 ID'),
  new_title: z.string().describe('新 Fact 的标题'),
  new_content: z.string().describe('新 Fact 的内容'),
  new_tags: z.array(z.string()).optional().describe('新 Fact 的标签'),
  new_confidence: ConfidenceSchema.optional().describe('新 Fact 的置信度'),
});

export class SupersedeNodeTool extends Tool {
  readonly name = 'supersede_node';
  readonly description = '用一条新 Fact 替代旧节点。旧节点被标记为 superseded，新 Fact 成为其替代者。用于修正过时或错误的信息。';
  readonly parameters = SupersedeNodeSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof SupersedeNodeSchema>;
    const graph = context?.blackboardGraph;
    const sessionId = context?.sessionId;

    if (!graph || !sessionId) {
      return { success: false, data: null, error: '黑板图未初始化或 sessionId 缺失' };
    }

    try {
      const oldNode = graph.getNode(params.old_node_id, sessionId);
      if (!oldNode) {
        return { success: false, data: null, error: `节点 ${params.old_node_id} 不存在` };
      }

      if (oldNode.kind === 'origin' || oldNode.kind === 'goal') {
        return { success: false, data: null, error: '请选择 Origin / Goal 之外的普通节点进行替代。' };
      }

      const newFact = graph.addFact({
        sessionId,
        title: params.new_title,
        content: params.new_content,
        tags: params.new_tags ?? oldNode.tags,
        createdBy: context.taskId ?? context.agentId ?? 'unknown',
        confidence: (params.new_confidence as Confidence) ?? 'confirmed',
      });

      graph.supersedeNode(params.old_node_id, sessionId, newFact.id);

      return {
        success: true,
        data: `节点 ${params.old_node_id} 已被 ${newFact.id} 替代`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `替代节点失败: ${msg}` };
    }
  }
}
