/**
 * ScheduledTaskRoutes — 定时任务 API 路由
 */
import type { FastifyInstance } from 'fastify';
import type {
  ScheduledTaskCreateParams,
  ScheduledTaskManager,
} from '../core/ScheduledTaskManager.js';
import type {
  ScheduledTaskAudience,
  ScheduledTaskIntensity,
  ScheduledTaskType,
} from '../core/Database.js';
import type { AuthFn } from './types.js';

type ScheduledTaskCreateBody = {
  cron?: string;
  prompt?: string;
  recurring?: boolean;
  durable?: boolean;
  sessionId?: string;
  taskType?: ScheduledTaskType;
  intensity?: ScheduledTaskIntensity;
  audience?: ScheduledTaskAudience;
  workflowId?: string;
  workflowInput?: Record<string, unknown>;
};

const VALID_TASK_TYPES = new Set(['prompt', 'workflow']);
const VALID_INTENSITIES = new Set(['gentle', 'normal', 'aggressive', 'critical']);
const VALID_AUDIENCES = new Set(['personal', 'team', 'ops', 'customer']);
const UNSUPPORTED_CREATE_FIELDS: Record<string, string> = {
  task_type: 'taskType',
  workflow_id: 'workflowId',
  workflow_input: 'workflowInput',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toCreateParams(body: ScheduledTaskCreateBody): { params?: ScheduledTaskCreateParams; error?: string } {
  for (const [field, canonical] of Object.entries(UNSUPPORTED_CREATE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      return { error: `${field} is not accepted; use ${canonical}` };
    }
  }

  const taskType = (body.taskType ?? (body.workflowId ? 'workflow' : 'prompt')) as ScheduledTaskType;
  const workflowId = body.workflowId;
  const workflowInput = body.workflowInput;

  if (!body.cron || !body.sessionId) {
    return { error: 'cron and sessionId are required' };
  }
  if (!VALID_TASK_TYPES.has(taskType)) {
    return { error: 'taskType must be prompt or workflow' };
  }
  if (body.intensity && !VALID_INTENSITIES.has(body.intensity)) {
    return { error: 'intensity must be gentle, normal, aggressive, or critical' };
  }
  if (body.audience && !VALID_AUDIENCES.has(body.audience)) {
    return { error: 'audience must be personal, team, ops, or customer' };
  }
  if (taskType === 'prompt' && !body.prompt?.trim()) {
    return { error: 'prompt is required for prompt tasks' };
  }
  if (taskType === 'workflow' && !workflowId) {
    return { error: 'workflowId is required for workflow tasks' };
  }
  if (workflowInput !== undefined && workflowInput !== null && !isRecord(workflowInput)) {
    return { error: 'workflowInput must be an object' };
  }

  return {
    params: {
      cron: body.cron,
      prompt: body.prompt,
      recurring: body.recurring ?? true,
      durable: body.durable ?? false,
      sessionId: body.sessionId,
      taskType,
      intensity: body.intensity,
      audience: body.audience,
      workflowId,
      workflowInput: workflowInput ?? undefined,
    },
  };
}

export function registerScheduledTaskRoutes(
  fastify: FastifyInstance,
  deps: {
    scheduledTaskManager: ScheduledTaskManager;
    requireServerToken: AuthFn;
  },
): void {
  const { scheduledTaskManager, requireServerToken } = deps;

  fastify.get('/api/v1/scheduled-tasks', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId) {
      reply.status(400);
      return { error: { code: 'BAD_REQUEST', message: 'sessionId is required' } };
    }
    return { data: scheduledTaskManager.getTasks(sessionId) };
  });

  fastify.post('/api/v1/scheduled-tasks', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as ScheduledTaskCreateBody;
    const parsed = toCreateParams(body);
    if (!parsed.params) {
      reply.status(400);
      return { error: { code: 'BAD_REQUEST', message: parsed.error ?? 'Invalid scheduled task body' } };
    }
    try {
      const result = scheduledTaskManager.createTask(parsed.params);
      return { data: result };
    } catch (error) {
      reply.status(400);
      return { error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  fastify.post('/api/v1/scheduled-tasks/batch', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { tasks?: ScheduledTaskCreateBody[] } | ScheduledTaskCreateBody[];
    const tasks = Array.isArray(body) ? body : body.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      reply.status(400);
      return { error: { code: 'BAD_REQUEST', message: 'tasks array is required' } };
    }

    const created: Array<ReturnType<ScheduledTaskManager['createTask']>> = [];
    const errors: Array<{ index: number; message: string }> = [];
    tasks.forEach((task, index) => {
      const parsed = toCreateParams(task);
      if (!parsed.params) {
        errors.push({ index, message: parsed.error ?? 'Invalid scheduled task body' });
        return;
      }
      try {
        created.push(scheduledTaskManager.createTask(parsed.params));
      } catch (error) {
        errors.push({ index, message: error instanceof Error ? error.message : String(error) });
      }
    });

    if (errors.length > 0 && created.length === 0) {
      reply.status(400);
    } else if (errors.length > 0) {
      reply.status(207);
    }
    return { data: { created, errors } };
  });

  fastify.delete('/api/v1/scheduled-tasks/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    scheduledTaskManager.deleteTask(id);
    return { success: true };
  });

  fastify.post('/api/v1/scheduled-tasks/:id/fire', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const result = await scheduledTaskManager.fireTaskManually(id);
    if (!result.ok) {
      const notFound = result.error === 'Task not found';
      reply.status(notFound ? 404 : 500);
      return {
        error: {
          code: notFound ? 'NOT_FOUND' : 'SCHEDULED_TASK_FIRE_FAILED',
          message: result.error || 'Task not found',
        },
      };
    }
    return { success: true };
  });

  fastify.patch('/api/v1/scheduled-tasks/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: { code: 'BAD_REQUEST', message: 'enabled boolean is required' } };
    }
    scheduledTaskManager.toggleTask(id, body.enabled);
    return { success: true };
  });
}
