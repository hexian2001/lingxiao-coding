/**
 * WorkflowRoutes — 工作流 CRUD + 执行路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 *
 * ⚠️ 安全提示（RCE 风险）：通过这些路由（POST/PUT /api/v1/workflows、
 * execute、execute-node）创建 / 更新 / 执行的 workflow，其 condition / loop
 * 表达式会由执行引擎经 `new Function` 在**本进程**直接求值，等价于运行任意
 * JavaScript 代码（详见 core/workflow/WorkflowManager.ts 与各 executor 的注释）。
 * 这些端点已要求 server token 鉴权，但调用方仍须确保只创建 / 导入**可信来源**
 * 的 workflow，切勿把这些写入入口转发给不可信的最终用户。
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { AcpHandler } from './AcpHandler.js';
import type { AuthFn } from './types.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';
import {
  deleteWorkflowScheduleTriggers,
  syncWorkflowScheduleTriggers,
  type WorkflowScheduleTriggerSyncResult,
} from '../core/workflow/ScheduleTriggerSync.js';
import { analyzeWorkflow } from '../core/workflow/WorkflowAnalyzer.js';
import type { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import type { WorkflowDefinition, NodeDefinition, EdgeDefinition, WorkflowNodeData } from '../core/workflow/types.js';

function workflowSummaryPayload(workflow: WorkflowDefinition) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? null,
    workspace: workflow.config.workspace ?? null,
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    scheduleTriggerCount: workflow.nodes.filter(node => node.data?.type === 'schedule_trigger').length,
    tags: workflow.tags ?? null,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function workflowPayload(workflow: WorkflowDefinition, scheduleSync?: WorkflowScheduleTriggerSyncResult) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? null,
    workspace: workflow.config.workspace ?? null,
    nodes: workflow.nodes,
    edges: workflow.edges,
    version: workflow.version,
    config: workflow.config,
    tags: workflow.tags ?? null,
    created_by: workflow.createdBy ?? null,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(scheduleSync ? { scheduleSync } : {}),
  };
}

function safeSyncWorkflowScheduleTriggers(
  workflow: WorkflowDefinition,
  scheduledTaskManager?: ScheduledTaskManager,
): WorkflowScheduleTriggerSyncResult | undefined {
  if (!scheduledTaskManager) return undefined;
  try {
    return syncWorkflowScheduleTriggers(workflow, scheduledTaskManager);
  } catch (error) {
    return {
      workflowId: workflow.id,
      synced: [],
      deleted: [],
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

type SessionScopedWorkflowManager = SessionManager & {
  getSessionWorkflowEngine?: (sessionId?: string) => WorkflowEngine | undefined;
};

class WorkflowRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRouteError';
  }
}

type RequiredFieldResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; fields: string[]; error: string };

function requestBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireStringFields(body: unknown, fields: string[]): RequiredFieldResult {
  const record = requestBodyRecord(body);
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(field);
    } else {
      values[field] = value.trim();
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      fields: missing,
      error: fields.length === 1 ? `${fields[0]} is required` : `${fields.join(' and ')} are required`,
    };
  }
  return { ok: true, values };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function singleNodeWorkflowId(value: unknown, nodeId: string): string {
  return optionalString(value) ?? `__single_node__${nodeId}`;
}

interface SingleNodeLifecycle {
  workflowId: string;
  executionId: string;
  sessionId: string;
  nodeId: string;
  startTime: number;
}

function startSingleNodeWorkflowLifecycle(
  emitter: EventEmitter | undefined,
  params: Pick<SingleNodeLifecycle, 'workflowId' | 'sessionId' | 'nodeId'>,
): SingleNodeLifecycle {
  const lifecycle: SingleNodeLifecycle = {
    ...params,
    executionId: randomUUID(),
    startTime: Date.now(),
  };
  emitter?.emit('workflow:execution_started', {
    workflowId: lifecycle.workflowId,
    executionId: lifecycle.executionId,
    sessionId: lifecycle.sessionId,
    startTime: lifecycle.startTime,
    nodeCount: 1,
    reason: 'single_node',
  });
  emitter?.emit('workflow:node_started', {
    workflowId: lifecycle.workflowId,
    executionId: lifecycle.executionId,
    sessionId: lifecycle.sessionId,
    nodeId: lifecycle.nodeId,
    startTime: lifecycle.startTime,
    reason: 'single_node',
  });
  return lifecycle;
}

function completeSingleNodeWorkflowLifecycle(
  emitter: EventEmitter | undefined,
  lifecycle: SingleNodeLifecycle,
  result: unknown,
): void {
  const endTime = Date.now();
  const duration = endTime - lifecycle.startTime;
  emitter?.emit('workflow:node_completed', {
    workflowId: lifecycle.workflowId,
    executionId: lifecycle.executionId,
    sessionId: lifecycle.sessionId,
    nodeId: lifecycle.nodeId,
    result,
    startTime: lifecycle.startTime,
    endTime,
    duration,
    reason: 'single_node',
  });
  emitter?.emit('workflow:execution_completed', {
    workflowId: lifecycle.workflowId,
    executionId: lifecycle.executionId,
    sessionId: lifecycle.sessionId,
    output: result,
    startTime: lifecycle.startTime,
    endTime,
    duration,
    reason: 'single_node',
  });
}

function failSingleNodeWorkflowLifecycle(
  emitter: EventEmitter | undefined,
  lifecycle: SingleNodeLifecycle,
  error: string,
): void {
  const endTime = Date.now();
  const duration = endTime - lifecycle.startTime;
  emitter?.emit('workflow:node_failed', {
    workflowId: lifecycle.workflowId,
    executionId: lifecycle.executionId,
    sessionId: lifecycle.sessionId,
    nodeId: lifecycle.nodeId,
    error,
    startTime: lifecycle.startTime,
    endTime,
    duration,
    reason: 'single_node_error',
  });
  emitter?.emit('workflow:execution_failed', {
    workflowId: lifecycle.workflowId,
    executionId: lifecycle.executionId,
    sessionId: lifecycle.sessionId,
    error,
    startTime: lifecycle.startTime,
    endTime,
    duration,
    reason: 'single_node_error',
  });
}

function requiredFieldErrorPayload(error: Extract<RequiredFieldResult, { ok: false }>) {
  return {
    success: false,
    error: error.error,
    code: 'missing_required_fields',
    details: { fields: error.fields },
  };
}

function workflowRouteErrorPayload(error: WorkflowRouteError, extra?: Record<string, unknown>) {
  return {
    success: false,
    error: error.message,
    code: error.code,
    ...(extra || {}),
  };
}

const WORKFLOW_EXECUTE_BODY_FIELDS = new Set(['input']);

function validateWorkflowExecuteBody(body: unknown): { ok: true; input?: Record<string, unknown> } | { ok: false; error: string; field?: string } {
  if (body === undefined || body === null) return { ok: true };
  const record = plainRecord(body);
  if (!record) return { ok: false, error: 'Workflow execute body must be an object' };
  const unsupportedField = Object.keys(record).find((field) => !WORKFLOW_EXECUTE_BODY_FIELDS.has(field));
  if (unsupportedField) {
    return { ok: false, field: unsupportedField, error: `Unsupported workflow execute field: ${unsupportedField}` };
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'input') || record.input === undefined) {
    return { ok: true };
  }
  const input = plainRecord(record.input);
  if (!input) return { ok: false, field: 'input', error: 'Workflow execute input must be an object' };
  return { ok: true, input };
}

function resolveWorkflowEngine(
  sessionManager: SessionManager,
  sessionId?: string,
): { engine: WorkflowEngine; sessionScoped: boolean } {
  const manager = sessionManager as SessionScopedWorkflowManager;
  if (typeof manager.getSessionWorkflowEngine === 'function') {
    if (!sessionId) throw new WorkflowRouteError(400, 'session_id_required', 'sessionId is required');
    const scoped = manager.getSessionWorkflowEngine(sessionId);
    if (scoped) return { engine: scoped, sessionScoped: true };
    throw new WorkflowRouteError(404, 'workflow_session_not_active', `Workflow session runtime is not active: ${sessionId}`);
  }
  return { engine: sessionManager.getWorkflowEngine(), sessionScoped: false };
}

function resolveExecutionWorkflowEngine(
  sessionManager: SessionManager,
  executionId: string,
): WorkflowEngine {
  const manager = sessionManager as SessionScopedWorkflowManager;
  if (typeof manager.getSessionWorkflowEngine === 'function') {
    for (const sessionId of sessionManager.getActiveSessionIds()) {
      const scoped = manager.getSessionWorkflowEngine(sessionId);
      if (scoped?.getStatus(executionId)) return scoped;
    }
  }
  return sessionManager.getWorkflowEngine();
}

export function registerWorkflowRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    acpHandler: AcpHandler;
    requireServerToken: AuthFn;
    sessionManager?: SessionManager;
    emitter?: EventEmitter;
    scheduledTaskManager?: ScheduledTaskManager;
  },
): void {
  const { acpHandler, requireServerToken, sessionManager, emitter, scheduledTaskManager } = deps;
  const workflowManager = sessionManager?.getWorkflowManager();

  fastify.get('/api/v1/workflows', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { workspace } = request.query as { workspace?: string };
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    return (await workflowManager.list())
      .filter((workflow) => workspace ? workflow.config.workspace === workspace : true)
      .map(workflowSummaryPayload);
  });

  fastify.post('/api/v1/workflows', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    const body = request.body as { id?: string; name?: string; description?: string; workspace?: string; config?: unknown; nodes?: unknown; edges?: unknown };
    if (!body.name) {
      reply.status(400);
      return { error: 'name is required' };
    }
    const config = body.config === undefined ? undefined : plainRecord(body.config);
    if (body.config !== undefined && !config) {
      reply.status(400);
      return { error: 'workflow config must be an object' };
    }
    const createConfig = {
      ...(config ?? {}),
      ...(body.workspace !== undefined ? { workspace: body.workspace } : {}),
    };
    try {
      const id = await workflowManager.create({
        id: body.id,
        name: body.name,
        description: body.description,
        nodes: Array.isArray(body.nodes) ? body.nodes as NodeDefinition[] : undefined,
        edges: Array.isArray(body.edges) ? body.edges as EdgeDefinition[] : undefined,
        config: Object.keys(createConfig).length > 0 ? createConfig : undefined,
      });
      const workflow = await workflowManager.get(id);
      const scheduleSync = workflow ? safeSyncWorkflowScheduleTriggers(workflow, scheduledTaskManager) : undefined;
      return workflow ? workflowPayload(workflow, scheduleSync) : null;
    } catch (err) {
      reply.status(500);
      return { error: err instanceof Error ? err.message : 'Failed to create workflow' };
    }
  });

  fastify.get('/api/v1/workflows/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    const { id } = request.params as { id: string };
    const workflow = await workflowManager.get(id);
    if (!workflow) {
      reply.status(404);
      return { error: 'Workflow not found' };
    }
    return workflowPayload(workflow);
  });

  fastify.get('/api/v1/workflows/:id/audit', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    const { id } = request.params as { id: string };
    const workflow = await workflowManager.get(id);
    if (!workflow) {
      reply.status(404);
      return { error: 'Workflow not found' };
    }
    const analysis = analyzeWorkflow(workflow);
    const scheduleTasks = scheduledTaskManager
      ? scheduledTaskManager.getTasksBySource('workflow_trigger', id)
      : [];
    return {
      workflowId: id,
      valid: analysis.issues.every(issue => issue.severity !== 'error'),
      analysis,
      scheduleTasks,
    };
  });

  fastify.put('/api/v1/workflows/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; workspace?: string; config?: unknown; nodes?: unknown; edges?: unknown };
    const existing = await workflowManager.get(id);
    if (!existing) {
      reply.status(404);
      return { error: 'Workflow not found' };
    }
    const config = body.config === undefined ? undefined : plainRecord(body.config);
    if (body.config !== undefined && !config) {
      reply.status(400);
      return { error: 'workflow config must be an object' };
    }
    const nextConfig = {
      ...(config ?? {}),
      ...(body.workspace !== undefined ? { workspace: body.workspace } : {}),
    };
    await workflowManager.update(id, {
      name: body.name,
      description: body.description,
      config: Object.keys(nextConfig).length > 0 ? nextConfig : undefined,
      nodes: Array.isArray(body.nodes) ? body.nodes as NodeDefinition[] : undefined,
      edges: Array.isArray(body.edges) ? body.edges as EdgeDefinition[] : undefined,
    });
    const workflow = await workflowManager.get(id);
    const scheduleSync = workflow ? safeSyncWorkflowScheduleTriggers(workflow, scheduledTaskManager) : undefined;
    return workflow ? workflowPayload(workflow, scheduleSync) : null;
  });

  fastify.delete('/api/v1/workflows/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    const { id } = request.params as { id: string };
    const existing = await workflowManager.get(id);
    if (!existing) {
      reply.status(404);
      return { error: 'Workflow not found' };
    }
    const scheduleSync = scheduledTaskManager
      ? deleteWorkflowScheduleTriggers(id, scheduledTaskManager)
      : undefined;
    await workflowManager.delete(id);
    return { success: true, ...(scheduleSync ? { scheduleSync } : {}) };
  });

  // Execute a whole workflow through WorkflowEngine
  fastify.post('/api/v1/workflows/:id/execute', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!sessionManager) {
      reply.status(503);
      return { error: 'Workflow execution is not available' };
    }
    if (!workflowManager) {
      reply.status(503);
      return { error: 'Workflow manager is not available' };
    }
    const { id } = request.params as { id: string };
    const body = validateWorkflowExecuteBody(request.body);
    if (!body.ok) {
      reply.status(400);
      return {
        success: false,
        error: body.error,
        code: 'unsupported_workflow_execute_field',
        ...(body.field ? { details: { field: body.field } } : {}),
      };
    }
    const workflow = await workflowManager.get(id);
    if (!workflow) {
      reply.status(404);
      return { error: 'Workflow not found' };
    }

    const workflowSessionId = optionalString(workflow.config.sessionId);
    if (!workflowSessionId) {
      reply.status(400);
      return {
        success: false,
        error: `workflow.config.sessionId is required to execute workflow: ${id}`,
        code: 'workflow_session_id_required',
      };
    }

    try {
      const { engine, sessionScoped } = resolveWorkflowEngine(sessionManager, workflowSessionId);
      if (!sessionScoped) {
        engine.setAgentExecutor(async ({ node, task, context }) => {
          const nodeData = node.data as WorkflowNodeData;
          const config = nodeData.config || {};
          const nodeType = nodeData.type;
          const prompt = [
            `Execute workflow node "${nodeData.label || node.id}" (${nodeType}).`,
            config.agentRole ? `Role: ${config.agentRole}` : '',
            task,
          ].filter(Boolean).join('\n\n');

          if (nodeType === 'agent') {
            const session = sessionManager.getSession(context.sessionId);
            if (!session) {
              throw new Error(`Session not found: ${context.sessionId}`);
            }
            const roleType = config.agentRole || (nodeData.metadata?.agentId as string) || 'coding';
            const agentName = `workflow-${node.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            const taskId = `WF-${context.executionId}-${node.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
            const workflowTask = session.board.createTask(
              taskId,
              nodeData.label || `Workflow node ${node.id}`,
              task,
              roleType,
              [],
              [],
              { working_directory: session.workspace },
              [
                `Workflow ID: ${context.workflowId}`,
                `Execution ID: ${context.executionId}`,
                `Node ID: ${node.id}`,
                `Node input: ${JSON.stringify(nodeData.inputs || {})}`,
              ].join('\n'),
            );
            const handle = session.pool.register(agentName, roleType, workflowTask.id);
            const assignedTask = session.board.assignTask(workflowTask.id, handle.name) ?? workflowTask;
            handle.taskRunGeneration = assignedTask.runGeneration;
            session.pool.prepareWorkerRuntime(handle, assignedTask);
            const taskPromise = session.pool.runAgentWrapper(handle, assignedTask);
            handle.asyncTask = taskPromise;
            return await taskPromise;
          }

          let result: unknown;
          const waitForCompletion = emitter ? new Promise((resolve, reject) => {
            let done = false;
            let unsubRound: (() => void) | undefined;
            let unsubError: (() => void) | undefined;
            const finish = (value: unknown, failed = false) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              unsubRound?.();
              unsubError?.();
              failed ? reject(value) : resolve(value);
            };
            const timer = setTimeout(() => finish(new Error('Workflow agent node timed out'), true), config.timeout || 300_000);
            unsubRound = emitter.subscribe('leader:round_complete', ((data: { sessionId: string }) => {
              if (data.sessionId === context.sessionId) finish({ success: true, nodeId: node.id, result });
            }));
            unsubError = emitter.subscribe('leader:error', ((data: { sessionId: string; error: Error }) => {
              if (data.sessionId === context.sessionId) finish(new Error(data.error?.message || String(data.error || 'Leader error')), true);
            }));
          }) : null;

          result = await acpHandler.handle(
            {
              jsonrpc: '2.0',
              id: `wf-${context.executionId}-${node.id}`,
              method: 'session/prompt',
              params: {
                sessionId: context.sessionId,
                prompt,
                systemPrompt: config.systemPrompt,
                model: config.agentModel,
              },
            },
            context.sessionId,
          );

          return waitForCompletion ? await waitForCompletion : result;
        });
      }

      const executionId = await engine.execute(id, body.input);
      return { success: true, workflowId: id, executionId };
    } catch (err) {
      if (err instanceof WorkflowRouteError) {
        reply.status(err.statusCode);
        return workflowRouteErrorPayload(err);
      }
      reply.status(500);
      return { success: false, error: err instanceof Error ? err.message : 'Workflow execution failed' };
    }
  });

  // Execute a workflow node — sends prompt to session
  fastify.post('/api/v1/workflows/execute-node', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as {
      sessionId?: unknown;
      nodeId?: unknown;
      nodeType?: string;
      label?: string;
      prompt?: string;
      systemPrompt?: string;
      model?: string;
      workflowId?: string;
      input?: Record<string, unknown>;
      variables?: Record<string, unknown>;
    };
    const requiredFields = requireStringFields(body, ['sessionId', 'nodeId']);
    if (!requiredFields.ok) {
      reply.status(400);
      return requiredFieldErrorPayload(requiredFields);
    }

    const sessionId = requiredFields.values.sessionId;
    const nodeId = requiredFields.values.nodeId;
    const { nodeType, label, prompt, systemPrompt, model } = body;
    const workflowId = singleNodeWorkflowId(body.workflowId, nodeId);

    // For leader/agent nodes, send a real prompt through the session
    if (nodeType === 'leader' || nodeType === 'agent') {
      const lifecycle = startSingleNodeWorkflowLifecycle(emitter, { workflowId, sessionId, nodeId });
      try {
        const result = await acpHandler.handle(
          {
            jsonrpc: '2.0',
            id: `wf-${Date.now()}`,
            method: 'session/prompt',
            params: {
              sessionId,
              prompt: prompt || label || `Execute workflow node: ${label || nodeId}`,
              systemPrompt,
              model,
            },
          },
          sessionId,
        );
        completeSingleNodeWorkflowLifecycle(emitter, lifecycle, result);
        return { success: true, workflowId, executionId: lifecycle.executionId, nodeId, result };
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Execution failed';
        failSingleNodeWorkflowLifecycle(emitter, lifecycle, error);
        return { success: false, workflowId, executionId: lifecycle.executionId, nodeId, error };
      }
    }

    // P0 修复：condition/tool/input/output 节点走真实 WorkflowEngine.executeSingleNode
    if (!sessionManager) {
      reply.status(503);
      return { success: false, error: 'SessionManager not available' };
    }

    try {
      const { engine } = resolveWorkflowEngine(sessionManager, sessionId);
      const manager = sessionManager.getWorkflowManager();
      if (!manager) {
        reply.status(503);
        return { success: false, error: 'WorkflowManager not available' };
      }

      // 若调用方提供 workflowId，从中提取节点；否则构造一个最小节点定义
      let node: NodeDefinition;
      if (body.workflowId) {
        const wf = await manager.get(body.workflowId);
        if (!wf) {
          reply.status(404);
          return { success: false, error: `Workflow not found: ${body.workflowId}` };
        }
        const found = wf.nodes.find((n) => n.id === nodeId);
        if (!found) {
          reply.status(404);
          return { success: false, error: `Node not found: ${nodeId}` };
        }
        node = found;
      } else {
        // Canvas 直跑单节点场景：用请求中的 nodeType/label 构造临时节点
        node = {
          id: nodeId,
          type: (nodeType || 'tool') as NodeDefinition['type'],
          position: { x: 0, y: 0 },
          data: {
            label: label || nodeId,
            type: (nodeType || 'tool') as WorkflowNodeData['type'],
            status: 'idle' as const,
            config: { systemPrompt, agentModel: model, template: prompt },
            inputs: {},
            outputs: {},
          },
        };
      }

      const result = await engine.executeSingleNode({
        node,
        sessionId,
        workflowId,
        input: body.input,
        variables: body.variables,
      });
      return { success: true, nodeId, result };
    } catch (err) {
      if (err instanceof WorkflowRouteError) {
        reply.status(err.statusCode);
        return workflowRouteErrorPayload(err, { nodeId });
      }
      return {
        success: false,
        nodeId,
        error: err instanceof Error ? err.message : 'Node execution failed',
      };
    }
  });

  // ─── Execution control: cancel / pause / resume ───

  fastify.post('/api/v1/workflows/executions/:executionId/cancel', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!sessionManager) {
      reply.status(503);
      return { success: false, error: 'Workflow execution is not available' };
    }
    const { executionId } = request.params as { executionId: string };
    try {
      await resolveExecutionWorkflowEngine(sessionManager, executionId).cancel(executionId);
      return { success: true };
    } catch (err) {
      reply.status(404);
      return { success: false, error: err instanceof Error ? err.message : 'cancel failed' };
    }
  });

  fastify.post('/api/v1/workflows/executions/:executionId/pause', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!sessionManager) {
      reply.status(503);
      return { success: false, error: 'Workflow execution is not available' };
    }
    const { executionId } = request.params as { executionId: string };
    try {
      resolveExecutionWorkflowEngine(sessionManager, executionId).pause(executionId);
      return { success: true };
    } catch (err) {
      reply.status(400);
      return { success: false, error: err instanceof Error ? err.message : 'pause failed' };
    }
  });

  fastify.post('/api/v1/workflows/executions/:executionId/resume', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!sessionManager) {
      reply.status(503);
      return { success: false, error: 'Workflow execution is not available' };
    }
    const { executionId } = request.params as { executionId: string };
    try {
      resolveExecutionWorkflowEngine(sessionManager, executionId).resume(executionId);
      return { success: true };
    } catch (err) {
      reply.status(400);
      return { success: false, error: err instanceof Error ? err.message : 'resume failed' };
    }
  });

  fastify.get('/api/v1/workflows/executions/:executionId', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (!sessionManager) {
      reply.status(503);
      return { error: 'Workflow execution is not available' };
    }
    const { executionId } = request.params as { executionId: string };
    const ctx = resolveExecutionWorkflowEngine(sessionManager, executionId).getStatus(executionId);
    if (!ctx) {
      reply.status(404);
      return { error: 'Execution not found' };
    }
    return {
      executionId,
      status: ctx.status,
      workflowId: ctx.workflowId,
      sessionId: ctx.sessionId,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
      error: ctx.error,
      nodeExecutions: Array.from(ctx.nodeExecutions.entries()).map(([nodeId, exec]) => ({
        nodeId,
        status: exec.status,
        startTime: exec.startTime,
        endTime: exec.endTime,
        duration: exec.endTime && exec.startTime ? exec.endTime - exec.startTime : undefined,
        error: exec.error,
        retryCount: exec.retryCount,
      })),
    };
  });

  // 注：GET /api/v1/tools 已迁移至 ToolsRoutes.ts，提供完整的 CRUD + 测试能力。
}
