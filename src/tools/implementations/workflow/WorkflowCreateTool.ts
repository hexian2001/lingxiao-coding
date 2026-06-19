import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';

const WorkflowCreateSchema = z.object({
  name: z.string().describe('Workflow 名称'),
  description: z.string().optional().describe('Workflow 描述'),
  metadata: z.object({
    tags: z.array(z.string()).optional().describe('标签'),
    author: z.string().optional().describe('作者'),
    version: z.string().optional().describe('版本')
  }).strict().optional().describe('元数据')
}).strict();

export class WorkflowCreateTool extends Tool {
  readonly name = '__workflow_delegate_create';
  readonly description = `创建新的 workflow。

Workflow 是一个可视化任务流程图，包含节点、控制边和数据边。创建后返回 workflowId，可继续添加节点、连边、执行。

适用场景：
- 多步骤复杂任务
- 需要 condition / loop / parallel 控制流
- 需要 tool + agent 混合执行
- 需要可视化展示与可诊断执行状态

返回：
- workflowId: 生成的 workflow ID
- status: 'created'
- name: workflow 名称
- message: 下一步建议

	建议续接：
	1. 用 workflow(action="add_node") 添加稳定 node_id 的节点
	2. 用 workflow(action="connect") 建立控制流和 data mapping
	3. 用 workflow(action="execute") 运行，再用 workflow(action="get_status") 查看状态`;

  readonly parameters = WorkflowCreateSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowCreateSchema.parse(args);
    
    // 获取 WorkflowManager
    const workflowManager = context?.workflowManager as { create: (def: unknown) => Promise<string>; get: (id: string) => Promise<unknown> } | undefined;
    if (!workflowManager) {
      return {
        success: false,
        data: null,
        error: 'WorkflowManager not available in context'
      };
    }

    try {
      const workflowId = await workflowManager.create({
        name: params.name,
        description: params.description,
        tags: params.metadata?.tags,
        createdBy: params.metadata?.author,
        config: {
          variables: {},
          workspace: context?.workspace,
          sessionId: context?.sessionId,
        }
      });

      return {
        success: true,
        data: {
          workflowId,
          status: 'created',
          name: params.name,
          nextSuggestedTools: ['workflow(action="add_node")', 'workflow(action="connect")', 'workflow(action="execute")'],
          message: 'Workflow created successfully. Add stable node IDs with workflow(action="add_node"), then connect nodes and execute.'
        }
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Failed to create workflow'
      };
    }
  }
}
