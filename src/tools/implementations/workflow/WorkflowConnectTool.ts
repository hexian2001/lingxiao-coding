import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import type { EdgeDefinition, NodeDefinition, WorkflowDefinition } from '../../../core/workflow/types.js';

const WorkflowConnectSchema = z.object({
  workflow_id: z.string().describe('Workflow ID'),
  source_node_id: z.string().describe('源节点 ID'),
  target_node_id: z.string().describe('目标节点 ID'),
  edge_type: z.enum(['sequence', 'condition', 'data', 'loop']).default('sequence')
    .describe('边类型。condition 节点到分支节点用 condition；loop 节点到循环体入口用 loop；parallel 节点到分支入口用 sequence；普通顺序连接也用 sequence'),
  condition_value: z.boolean().optional().describe('condition 边的分支值（true/false）；仅 condition 节点出边需要'),
  data_mapping: z.record(z.string(), z.string()).optional().describe('data 边的数据映射：键是源结果路径，值是目标输入路径，例如 {"score":"input.score"}'),
}).strict();

interface ExistingWorkflowNode {
  id: string;
  label?: string;
  type?: string;
}

interface WorkflowManagerPort {
  get(id: string): Promise<WorkflowDefinition | undefined>;
  addEdge(id: string, edge: Omit<EdgeDefinition, 'id'>): Promise<string>;
}

function toExistingWorkflowNode(node: NodeDefinition): ExistingWorkflowNode {
  return {
    id: node.id,
    label: node.data?.label,
    type: node.data?.type,
  };
}

function formatExistingNodes(nodes: ExistingWorkflowNode[]): string {
  return nodes.map((node) => `${node.id}${node.label ? `(${node.label})` : ''}`).join(', ');
}

export class WorkflowConnectTool extends Tool {
  readonly name = '__workflow_delegate_connect';
  readonly description = `连接两个节点，建立控制流或数据流。

边类型：
- sequence: 普通控制流；也用于 parallel 节点的分支入口边
- condition: 条件分支；仅 condition 节点出边需要 condition_value=true/false
- data: 数据流；不影响控制流，只负责把上游结果映射到下游输入
- loop: loop 节点到循环体入口的边

真实执行语义：
- condition 节点只会放行匹配 condition_value 的分支
- loop 节点会真实执行循环体，循环体必须通过 loop 边连接
- parallel 节点会按其分支边 fan-out，完成后再走出口边

示例：
1. 顺序连接：
   source_node_id="node1", target_node_id="node2", edge_type="sequence"

2. 条件分支：
   source_node_id="condition1", target_node_id="true_branch",
   edge_type="condition", condition_value=true

3. 循环体：
   source_node_id="loop1", target_node_id="body_start", edge_type="loop"

4. 数据流：
   source_node_id="node1", target_node_id="node2", edge_type="data", data_mapping={"result": "input"}

返回：
- edgeId: 生成的边 ID
- source: 源节点 ID
- target: 目标节点 ID
- type: 边类型
- message: 可直接续接的简短说明`;

  readonly parameters = WorkflowConnectSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowConnectSchema.parse(args);
    
    const workflowManager = context?.workflowManager as WorkflowManagerPort | undefined;
    if (!workflowManager) {
      return {
        success: false,
        data: null,
        error: 'WorkflowManager not available in context'
      };
    }

    try {
      const workflow = await workflowManager.get(params.workflow_id);
      if (!workflow) {
        return {
          success: false,
          data: null,
          error: `Workflow not found: ${params.workflow_id}`
        };
      }

      const sourceNode = workflow.nodes.find((node) => node.id === params.source_node_id);
      const targetNode = workflow.nodes.find((node) => node.id === params.target_node_id);
      if (!sourceNode || !targetNode) {
        const existingNodes = workflow.nodes.map(toExistingWorkflowNode);
        return {
          success: false,
          data: { existingNodes },
          error: `Unknown source or target node; existing nodes: ${formatExistingNodes(existingNodes)}`
        };
      }

      const sourceType = sourceNode.data?.type;
      if (params.edge_type === 'condition') {
        if (sourceType !== 'condition') {
          return {
            success: false,
            data: { sourceType, targetType: targetNode.data?.type },
            error: 'condition edge_type is only valid when the source node is a condition node'
          };
        }
        if (params.condition_value === undefined) {
          return {
            success: false,
            data: { sourceType, targetType: targetNode.data?.type },
            error: 'condition edge_type requires condition_value=true or condition_value=false'
          };
        }
      }

      if (params.edge_type === 'loop' && sourceType !== 'loop') {
        return {
          success: false,
          data: { sourceType, targetType: targetNode.data?.type },
          error: 'loop edge_type is only valid when the source node is a loop node'
        };
      }

      if (sourceType === 'parallel' && params.edge_type !== 'sequence' && params.edge_type !== 'data') {
        return {
          success: false,
          data: { sourceType, targetType: targetNode.data?.type },
          error: 'parallel node branches must use sequence edges; use data edges only for input mapping'
        };
      }

      if (params.edge_type === 'data' && params.data_mapping && Object.keys(params.data_mapping).length === 0) {
        return {
          success: false,
          data: { sourceType, targetType: targetNode.data?.type },
          error: 'data edge_type requires a non-empty data_mapping when data_mapping is provided'
        };
      }

      const edgeId = await workflowManager.addEdge(params.workflow_id, {
        source: params.source_node_id,
        target: params.target_node_id,
        type: 'workflow',
        data: {
          type: params.edge_type,
          conditionValue: params.condition_value,
          dataMapping: params.data_mapping,
          style: {
            stroke: params.edge_type === 'condition' ? '#e0af68' : '#333'
          }
        }
      });

      return {
        success: true,
        data: {
          edgeId,
          source: params.source_node_id,
          target: params.target_node_id,
          type: params.edge_type,
          diagnostics: {
            conditionValue: params.condition_value,
            dataMapping: params.data_mapping ?? null,
            nextHint: params.edge_type === 'loop'
              ? 'Add body nodes and optional loop exit edges next.'
              : params.edge_type === 'condition'
                ? 'Connect the opposite true/false branch if needed.'
                : 'Continue connecting remaining control/data edges or execute the workflow.'
          },
          message: 'Nodes connected successfully.'
        }
      };
    } catch (error) {
      let existingNodes: ExistingWorkflowNode[] = [];
      try {
        const workflow = await workflowManager.get(params.workflow_id);
        existingNodes = Array.isArray(workflow?.nodes)
          ? workflow.nodes.map(toExistingWorkflowNode)
          : [];
      } catch { /* ignore diagnostic failure */ }

      return {
        success: false,
        data: { existingNodes },
        error: `${error instanceof Error ? error.message : 'Failed to connect nodes'}${existingNodes.length > 0 ? `; existing nodes: ${formatExistingNodes(existingNodes)}` : '; no nodes exist in this workflow'}`
      };
    }
  }
}
