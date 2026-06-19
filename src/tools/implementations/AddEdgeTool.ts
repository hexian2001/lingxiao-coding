import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { EdgeType } from '../../core/blackboard/types.js';

const AddEdgeSchema = z.object({
  from_node_id: z.string().describe('源节点 ID'),
  to_node_id: z.string().describe('目标节点 ID'),
  edge_type: z.enum(['depends_on', 'supports', 'contradicts', 'refines', 'supersedes', 'produces', 'consumes']).describe('边类型'),
  metadata: z.record(z.string(), z.string()).optional().describe('附加元数据'),
});

export class AddEdgeTool extends Tool {
  readonly name = 'add_edge';
  readonly description = '在知识图谱的两个节点之间添加关系边。';
  readonly parameters = AddEdgeSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof AddEdgeSchema>;
    const graph = context?.blackboardGraph;
    const sessionId = context?.sessionId;

    if (!graph || !sessionId) {
      return { success: false, data: null, error: '黑板图未初始化或 sessionId 缺失' };
    }

    try {
      const edge = graph.addEdge({
        sessionId,
        fromNodeId: params.from_node_id,
        toNodeId: params.to_node_id,
        edgeType: params.edge_type as EdgeType,
        createdBy: context.taskId ?? context.agentId ?? 'unknown',
        metadata: params.metadata,
      });

      if (edge.id.startsWith('invalid-')) {
        return { success: false, data: null, error: '添加边失败：源节点或目标节点不存在' };
      }

      return {
        success: true,
        data: `Edge ${edge.id} 已添加: ${params.from_node_id} --[${params.edge_type}]--> ${params.to_node_id}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `添加边失败: ${msg}` };
    }
  }
}
