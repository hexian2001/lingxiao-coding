/**
 * AgentNodeExecutor - Agent 节点执行器
 * 
 * 集成现有的 Agent 系统（LeaderAgent/WorkerAgent）
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import type { NodeDefinition, ExecutionContext } from '../types.js';

export interface WorkflowAgentExecuteInput {
  node: NodeDefinition;
  input: Record<string, unknown>;
  context: ExecutionContext;
  task: string;
}

export type WorkflowAgentExecutor = (input: WorkflowAgentExecuteInput) => Promise<unknown>;

export class AgentNodeExecutor extends BaseNodeExecutor {
  constructor(private readonly agentExecutor?: WorkflowAgentExecutor) {
    super();
  }

  async execute(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<unknown> {
    this.validateNode(node);

    this.log(context, 'info', node.id, `Starting agent node: ${node.data.label}`);

    try {
      // 构建任务提示词
      const task = this.buildTaskPrompt(input, node);

      if (!this.agentExecutor) {
        throw new Error('Workflow agent executor is not configured');
      }

      const result = await this.agentExecutor({ node, input, context, task });

      this.log(context, 'info', node.id, 'Agent node completed');
      return result;

    } catch (error) {
      this.log(
        context,
        'error',
        node.id,
        `Agent node failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  private buildTaskPrompt(input: Record<string, unknown>, node: NodeDefinition): string {
    // 如果输入中有 task 字段，使用它
    if (input.task && typeof input.task === 'string') {
      return input.task;
    }

    // 否则使用节点描述
    if (node.data.description) {
      return node.data.description;
    }

    // 或者将所有输入序列化为提示词
    return `Process the following input:\n${JSON.stringify(input, null, 2)}`;
  }
}
