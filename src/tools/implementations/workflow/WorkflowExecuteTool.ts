import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import {
  normalizeWorkflowExecutionStatus,
  normalizeWorkflowNodeStatus,
} from '../../../core/StateSemantics.js';
import type { ExecutionContext, NodeExecutionState } from '../../../core/workflow/types.js';

const WorkflowExecuteOptionsSchema = z
  .object({
    mode: z.enum(['sync', 'async']).default('async').describe('执行模式'),
    timeout: z.number().optional().describe('超时时间（毫秒）'),
    onProgress: z.boolean().default(false).describe('是否返回进度事件')
  })
  .strict();

const WorkflowExecuteSchema = z.object({
  workflow_id: z.string().describe('Workflow ID'),
  input: z.record(z.string(), z.unknown()).optional().describe('输入数据'),
  options: WorkflowExecuteOptionsSchema.optional().describe('执行选项')
}).strict();

function summarizeStatus(status: ExecutionContext | undefined) {
  if (!status) return undefined;
  const entries: NodeExecutionState[] = Array.from(status.nodeExecutions.values());
  return {
    nodeExecutions: entries,
    runningNodes: entries.filter((e) => normalizeWorkflowNodeStatus(e.status) === 'running').map((e) => e.nodeId),
    failedNode: entries.find((e) => normalizeWorkflowNodeStatus(e.status) === 'failed'),
  };
}

export class WorkflowExecuteTool extends Tool {
  readonly name = '__workflow_delegate_execute';
  readonly description = `执行 workflow。

执行模式：
- sync: 同步执行，等待 workflow 完成后返回结果
- async: 异步执行，立即返回 execution_id，可用 workflow(action="get_status") 查询状态`;

  readonly parameters = WorkflowExecuteSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowExecuteSchema.parse(args);

    const workflowEngine = context?.workflowEngine as { execute: (id: string, input: unknown, opts: unknown) => Promise<string>; getStatus: (id: string) => ExecutionContext | undefined } | undefined;
    if (!workflowEngine) {
      return {
        success: false,
        data: null,
        error: 'WorkflowEngine not available in context'
      };
    }

    try {
      const mode = params.options?.mode || 'async';
      const sessionId = context?.sessionId;
      const commonOpts = {
        timeout: params.options?.timeout,
        sessionId,
      };

      if (mode === 'async') {
        const executionId = await workflowEngine.execute(
          params.workflow_id,
          params.input,
          commonOpts,
        );
        return {
          success: true,
          data: {
            executionId,
            status: 'running',
            nextSuggestedTool: 'workflow(action="get_status")',
            message: 'Workflow execution started. Use workflow(action="get_status") to check progress.'
          }
        };
      }

      // sync: 事件驱动等待；无 emitter 时轮询执行状态。
      const executionId = await workflowEngine.execute(
        params.workflow_id,
        params.input,
        commonOpts,
      );
      const emitter = context?.emitter;
      const timeoutMs = params.options?.timeout ?? 600_000;

      const waitedResult = await new Promise<{ kind: 'completed' | 'failed' | 'timeout' | 'cancelled' }>((resolve) => {
        let done = false;
        const finish = (payload: { kind: 'completed' | 'failed' | 'timeout' | 'cancelled' }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubOk?.();
          unsubFail?.();
          unsubCancel?.();
          resolve(payload);
        };
        const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);

        let unsubOk: (() => void) | undefined;
        let unsubFail: (() => void) | undefined;
        let unsubCancel: (() => void) | undefined;
        if (emitter && typeof emitter.subscribe === 'function') {
          unsubOk = emitter.subscribe('workflow:execution_completed', (data) => {
            if (data?.executionId === executionId) finish({ kind: 'completed' });
          });
          unsubFail = emitter.subscribe('workflow:execution_failed', (data) => {
            if (data?.executionId !== executionId) return;
            const isTimeout = data?.reason === 'timeout' || typeof data?.timeoutMs === 'number';
            finish({ kind: isTimeout ? 'timeout' : 'failed' });
          });
          unsubCancel = emitter.subscribe('workflow:execution_cancelled', (data) => {
            if (data?.executionId === executionId) finish({ kind: 'cancelled' });
          });
        } else {
          const poll = async () => {
            while (!done) {
              const status = workflowEngine.getStatus(executionId);
              if (!status) { finish({ kind: 'failed' }); return; }
              const normalized = normalizeWorkflowExecutionStatus(status.status);
              if (normalized === 'completed') { finish({ kind: 'completed' }); return; }
              if (normalized === 'failed') { finish({ kind: 'failed' }); return; }
              // 轮询路径也必须识别 cancelled，否则同步工具会一直等到 timeout。
              if (normalized === 'cancelled') { finish({ kind: 'cancelled' }); return; }
              await new Promise((r) => setTimeout(r, 250));
            }
          };
          void poll();
        }
      });

      const status = workflowEngine.getStatus(executionId);
      if (waitedResult.kind === 'timeout') {
        const latestStatus = status ? normalizeWorkflowExecutionStatus(status.status) : 'running';
        return {
          success: false,
          data: { executionId, status: latestStatus, debug: summarizeStatus(status) },
          error: `Workflow execution timed out after ${timeoutMs}ms (still ${latestStatus}). Use workflow(action="get_status") to keep polling.`,
        };
      }
      if (!status) {
        return { success: false, data: null, error: 'Execution not found' };
      }
      const debug = summarizeStatus(status);
      const normalizedStatus = normalizeWorkflowExecutionStatus(status.status);
      if (normalizedStatus === 'completed') {
        return {
          success: true,
          data: {
            executionId,
            status: normalizedStatus,
            output: status.variables.get('__output__'),
            metrics: {
              duration: status.endTime ? status.endTime - status.startTime : 0,
              nodesExecuted: status.nodeExecutions.size,
            },
            debug,
          },
        };
      }
      if (normalizedStatus === 'cancelled') {
        return {
          success: false,
          data: { executionId, status: normalizedStatus, error: status.error, debug },
          error: status.error || 'Workflow execution cancelled',
        };
      }
      return {
        success: false,
        data: { executionId, status: normalizedStatus, error: status.error, debug },
        error: status.error || debug?.failedNode?.error || 'Workflow execution failed',
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Failed to execute workflow'
      };
    }
  }
}
