import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import {
  normalizeWorkflowExecutionStatus,
  normalizeWorkflowNodeStatus,
} from '../../../core/StateSemantics.js';
import type { ExecutionContext, ExecutionLog, NodeExecutionState } from '../../../core/workflow/types.js';

const WorkflowGetStatusSchema = z.object({
  execution_id: z.string().describe('执行 ID'),
  include_logs: z.boolean().default(false).describe('是否包含详细日志')
}).strict();

interface WorkflowStatusResult {
  executionId: string;
  workflowId: string;
  status: string;
  progress: {
    completedNodes: number;
    totalNodes: number;
    percentage: number;
  };
  startTime: number;
  endTime?: number;
  nodeExecutions: NodeExecutionState[];
  runningNodes: string[];
  failedNode?: string;
  output?: unknown;
  error?: string;
  logs?: ExecutionLog[];
}

export class WorkflowGetStatusTool extends Tool {
  readonly name = '__workflow_delegate_get_status';
  readonly description = `查询 workflow 执行状态。

返回信息：
- executionId: 执行 ID
- workflowId: Workflow ID
- status: running | completed | failed | paused
- progress: 当前已记录的节点执行状态统计（completed / total / percentage）
- startTime: 开始时间
- endTime: 结束时间（如果已完成）
- output: 执行结果（如果已完成）
- error: 错误信息（如果失败）
- logs: 执行日志（如果 include_logs=true）
- nodeExecutions: 每个节点的执行状态

注意：progress 基于当前 executionContext 中已记录的节点执行条目，不是 workflow 静态总节点数。`;

  readonly parameters = WorkflowGetStatusSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowGetStatusSchema.parse(args);

    const workflowEngine = context?.workflowEngine as { getStatus: (id: string) => ExecutionContext | undefined } | undefined;
    if (!workflowEngine) {
      return {
        success: false,
        data: null,
        error: 'WorkflowEngine not available in context'
      };
    }

    try {
      const executionContext = workflowEngine.getStatus(params.execution_id);

      if (!executionContext) {
        return {
          success: false,
          data: null,
          error: 'Execution not found'
        };
      }

      const nodeEntries: NodeExecutionState[] = Array.from(executionContext.nodeExecutions.values());
      const totalNodes = nodeEntries.length;
      const completedNodes = nodeEntries.filter((e) => normalizeWorkflowNodeStatus(e.status) === 'completed').length;
      const executionStatus = normalizeWorkflowExecutionStatus(executionContext.status);

      const result: WorkflowStatusResult = {
        executionId: params.execution_id,
        workflowId: executionContext.workflowId,
        status: executionStatus,
        progress: {
          completedNodes,
          totalNodes,
          percentage: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0
        },
        startTime: executionContext.startTime,
        endTime: executionContext.endTime,
        nodeExecutions: nodeEntries,
        runningNodes: nodeEntries.filter((e) => normalizeWorkflowNodeStatus(e.status) === 'running').map((e) => e.nodeId),
        failedNode: nodeEntries.find((e) => normalizeWorkflowNodeStatus(e.status) === 'failed')?.nodeId,
      };

      if (executionStatus === 'completed') {
        result.output = executionContext.variables.get('__output__');
      }

      if (executionStatus === 'failed') {
        result.error = executionContext.error;
      }

      if (params.include_logs) {
        result.logs = executionContext.logs;
      }

      return {
        success: true,
        data: result
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Failed to get status'
      };
    }
  }
}
