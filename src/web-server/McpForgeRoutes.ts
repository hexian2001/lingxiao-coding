/**
 * McpForgeRoutes — MCP Forge REST API 端点
 *
 * 契约: contract:mcp-forge-api v1
 *
 * 14 个 REST 端点 + SSE 事件流:
 *   POST   /api/v1/mcp-forge/generate         — 一键生成
 *   GET    /api/v1/mcp-forge/status/:id        — 查询状态
 *   POST   /api/v1/mcp-forge/validate          — 验证
 *   POST   /api/v1/mcp-forge/jobs              — 创建任务
 *   GET    /api/v1/mcp-forge/jobs              — 列出任务
 *   GET    /api/v1/mcp-forge/jobs/:id          — 任务详情
 *   POST   /api/v1/mcp-forge/jobs/:id/run      — 运行
 *   POST   /api/v1/mcp-forge/jobs/:id/advance  — 推进
 *   POST   /api/v1/mcp-forge/jobs/:id/cancel   — 取消
 *   POST   /api/v1/mcp-forge/jobs/:id/retry    — 重试
 *   DELETE /api/v1/mcp-forge/jobs/:id          — 删除
 *   GET    /api/v1/mcp-forge/jobs/:id/events   — SSE 事件流
 *   GET    /api/v1/mcp-forge/templates         — 模板列表
 *   GET    /api/v1/mcp-forge/templates/:id     — 模板详情
 *
 * 鉴权: 所有端点经 requireServerToken 中间件
 * 响应格式: { success: boolean, data?: T, error?: { code, message, retryable? } }
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthFn } from './types.js';
import { getMcpForge, TemplateLibrary, ForgeError, ForgeErrorCode } from '../core/mcp-forge/McpForge.js';
import type { ForgeJob, ForgeJobState, ForgeRequest, ForgeEvent, TemplateMetadata } from '../core/mcp-forge/McpForge.js';
import { FORGE_ERROR_HTTP_STATUS } from '../core/mcp-forge/errors.js';
import { isTerminal } from '../core/mcp-forge/stateMachine.js';

// ── 类型 ──────────────────────────────────────────────────────────────────

interface GenerateRequestBody {
  description: string;
  serverName: string;
  templateId?: string;
  options?: {
    skipValidation?: boolean;
    autoRegister?: boolean;
    outputDir?: string;
    customTools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    skipInspector?: boolean;
    sandboxTimeoutMs?: number;
    llmModel?: string;
    customEnv?: Record<string, string>;
    transport?: 'stdio' | 'streamable-http';
  };
  timeoutMs?: number;
}

interface ValidateRequestBody {
  jobId: string;
  options?: {
    skipSandbox?: boolean;
    skipInspector?: boolean;
    timeoutMs?: number;
  };
}

interface AdvanceRequestBody {
  toState?: ForgeJobState;
}

interface RunRequestBody {
  timeoutMs?: number;
}

interface RetryRequestBody {
  patchRequest?: Partial<ForgeRequest>;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────

/** 统一设置动态响应头 */
function setDynamicHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
}

/** 成功响应 */
function success<T>(reply: FastifyReply, data: T, statusCode = 200): void {
  setDynamicHeaders(reply);
  reply.status(statusCode);
  reply.send({ success: true, data });
}

/** 分页成功响应 */
function successPaginated<T>(reply: FastifyReply, data: T[], total: number, limit: number, offset: number): void {
  setDynamicHeaders(reply);
  reply.status(200);
  reply.send({ success: true, data, pagination: { total, limit, offset } });
}

/** 错误响应 — 从 ForgeError 构建 */
function forgeErrorReply(reply: FastifyReply, err: ForgeError): void {
  setDynamicHeaders(reply);
  reply.status(err.httpStatus);
  reply.send({
    success: false,
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      ...(err.phase ? { phase: err.phase } : {}),
      ...(err.detail ? { detail: err.detail } : {}),
    },
  });
}

/** 通用错误响应 */
function errorReply(reply: FastifyReply, code: string, message: string, statusCode = 500, retryable = false): void {
  setDynamicHeaders(reply);
  reply.status(statusCode);
  reply.send({ success: false, error: { code, message, retryable } });
}

/**
 * 执行 Forge 操作并处理错误。
 * 将 McpForge 抛出的错误转换为统一响应格式。
 * 对 "Job not found" 类错误映射为 FORGE_JOB_NOT_FOUND (404)。
 */
async function handleForgeOperation<T>(
  reply: FastifyReply,
  operation: () => Promise<T> | T,
  successStatus = 200,
): Promise<void> {
  try {
    const result = await operation();
    success(reply, result, successStatus);
  } catch (err) {
    if (err instanceof ForgeError) {
      // McpForge.requireJob throws FORGE_INVALID_REQUEST for not-found;
      // map to FORGE_JOB_NOT_FOUND for API consumers
      if (err.code === ForgeErrorCode.FORGE_INVALID_REQUEST && err.message.includes('Job not found')) {
        errorReply(reply, 'FORGE_JOB_NOT_FOUND', err.message, 404, false);
        return;
      }
      forgeErrorReply(reply, err);
      return;
    }
    // Unknown error
    const message = err instanceof Error ? err.message : String(err);
    errorReply(reply, ForgeErrorCode.FORGE_INTERNAL_ERROR, message, 500, true);
  }
}

/** 验证 generate/create 请求体 */
function validateForgeRequest(body: GenerateRequestBody): string | null {
  if (!body.description || typeof body.description !== 'string' || body.description.trim().length === 0) {
    return 'description is required';
  }
  if (body.description.length > 4000) {
    return 'description must not exceed 4000 characters';
  }
  if (!body.serverName || typeof body.serverName !== 'string' || body.serverName.trim().length === 0) {
    return 'serverName is required';
  }
  if (body.serverName.length > 64) {
    return 'serverName must not exceed 64 characters';
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(body.serverName)) {
    return 'serverName must match pattern ^[a-z0-9][a-z0-9_-]*$';
  }
  return null;
}

/** 将 ForgeJob 序列化为精简版（列表用） */
function toJobSummary(job: ForgeJob) {
  return {
    id: job.id,
    state: job.state,
    serverName: job.request.serverName,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error ? { code: job.error.code, message: job.error.message } : undefined,
  };
}

/** 将 ForgeJob 序列化为完整版，支持 includeCode/includeHistory 参数 */
function toJobDetail(job: ForgeJob, includeCode = false, includeHistory = true) {
  const detail: Record<string, unknown> = {
    id: job.id,
    state: job.state,
    progress: job.progress,
    request: job.request,
    analysis: job.analysis,
    generatedCode: job.generatedCode
      ? includeCode
        ? job.generatedCode
        : {
            outputDir: job.generatedCode.outputDir,
            entryPoint: job.generatedCode.entryPoint,
            language: job.generatedCode.language,
            templateId: job.generatedCode.templateId,
            fileCount: job.generatedCode.files.length,
            totalSize: job.generatedCode.files.reduce((sum, f) => sum + f.content.length, 0),
          }
      : undefined,
    validationResult: job.validationResult,
    registeredServer: job.registeredServer,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stepHistory: includeHistory ? job.stepHistory : undefined,
  };
  return detail;
}

/** 将 TemplateMetadata 序列化为列表项 */
function toTemplateSummary(template: TemplateMetadata) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    language: template.language,
    transport: template.transport,
    framework: template.framework,
    placeholders: template.placeholders.map((p) => p.name),
  };
}

/** 将 TemplateMetadata 序列化为完整版 */
function toTemplateDetail(template: TemplateMetadata, includeCode = false) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    language: template.language,
    transport: template.transport,
    framework: template.framework,
    entryPoint: template.entryPoint,
    placeholders: template.placeholders,
    registrationConfig: template.registrationConfig,
    files: includeCode ? template.files : template.files.map((f) => ({ path: f.path, size: f.content.length })),
  };
}

// ── SSE 辅助 ──────────────────────────────────────────────────────────────

/**
 * SSE 事件类型映射:
 * ForgeEvent.type → SSE event name + data payload
 */
function forgeEventToSSE(event: ForgeEvent): string {
  const data: Record<string, unknown> = {
    jobId: event.jobId,
    timestamp: event.timestamp,
  };

  switch (event.type) {
    case 'state_change':
      data.progress = event.progress;
      data.state = event.state;
      data.message = event.message;
      break;
    case 'progress':
      data.progress = event.progress;
      data.step = event.state;
      data.message = event.message;
      break;
    case 'log':
      data.message = event.message;
      data.progress = event.progress;
      data.state = event.state;
      break;
    case 'error':
      data.error = event.data || { message: event.message };
      break;
  }

  return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── 路由注册 ──────────────────────────────────────────────────────────────

export function registerMcpForgeRoutes(
  fastify: FastifyInstance,
  deps: {
    requireServerToken: AuthFn;
  },
): void {
  const { requireServerToken } = deps;
  const forge = getMcpForge();

  // ── 4.1 POST /api/v1/mcp-forge/generate — 一键生成 ─────────────────
  fastify.post('/api/v1/mcp-forge/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const body = request.body as GenerateRequestBody;
    const validationError = validateForgeRequest(body);
    if (validationError) {
      errorReply(reply, ForgeErrorCode.FORGE_INVALID_REQUEST, validationError, 400, false);
      return;
    }

    const forgeRequest: ForgeRequest = {
      description: body.description,
      serverName: body.serverName,
      templateId: body.templateId,
      options: {
        skipValidation: body.options?.skipValidation,
        skipInspector: body.options?.skipInspector,
        autoRegister: body.options?.autoRegister,
        sandboxTimeoutMs: body.options?.sandboxTimeoutMs,
        llmModel: body.options?.llmModel,
        customEnv: body.options?.customEnv,
        transport: body.options?.transport,
      },
    };

    const timeoutMs = Math.min(body.timeoutMs ?? 120000, 600000);

    await handleForgeOperation(reply, async () => {
      const job = forge.createJob(forgeRequest);

      // Run pipeline with timeout
      const pipelinePromise = forge.runPipeline(job.id);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new ForgeError(
            ForgeErrorCode.FORGE_INTERNAL_ERROR,
            `Pipeline timed out after ${timeoutMs}ms`,
            { retryable: true, phase: 'pipeline' },
          ));
        }, timeoutMs);
      });

      try {
        await Promise.race([pipelinePromise, timeoutPromise]);
      } catch (err) {
        // Job may have already been set to a failed state by the pipeline
        // If timeout, try to cancel
        const currentJob = forge.getJob(job.id);
        if (currentJob && !isTerminal(currentJob.state)) {
          try { forge.cancel(job.id); } catch { /* ignore */ }
        }
        throw err;
      }

      const finalJob = forge.getJob(job.id);
      if (!finalJob) {
        throw new ForgeError(ForgeErrorCode.FORGE_INTERNAL_ERROR, 'Job disappeared after pipeline', { retryable: false });
      }

      return { job: toJobDetail(finalJob, true, true) };
    });
  });

  // ── 4.2 GET /api/v1/mcp-forge/status/:id — 查询状态 ────────────────
  fastify.get('/api/v1/mcp-forge/status/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const query = request.query as { includeCode?: string; includeHistory?: string };
    const includeCode = query.includeCode === 'true' || query.includeCode === '1';
    const includeHistory = query.includeHistory !== 'false' && query.includeHistory !== '0';

    await handleForgeOperation(reply, () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }
      return toJobDetail(job, includeCode, includeHistory);
    });
  });

  // ── 4.3 POST /api/v1/mcp-forge/validate — 验证 ─────────────────────
  fastify.post('/api/v1/mcp-forge/validate', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const body = request.body as ValidateRequestBody;
    if (!body?.jobId || typeof body.jobId !== 'string') {
      errorReply(reply, ForgeErrorCode.FORGE_INVALID_REQUEST, 'jobId is required', 400, false);
      return;
    }

    await handleForgeOperation(reply, async () => {
      const job = forge.getJob(body.jobId);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${body.jobId}`, { retryable: false });
      }

      // Validate state: job must be in 'generated' or 'validation_skipped' or 'validation_failed'
      const validStates: ForgeJobState[] = ['generated', 'validation_skipped', 'validation_failed'];
      if (!validStates.includes(job.state)) {
        throw new ForgeError(
          ForgeErrorCode.FORGE_STATE_VIOLATION,
          `Cannot validate job in state: ${job.state}. Expected one of: ${validStates.join(', ')}`,
          { phase: job.state, retryable: false },
        );
      }

      // If validation_failed, need to retry first to get back to a valid state
      if (job.state === 'validation_failed') {
        forge.retry(body.jobId);
      }

      // Apply options to job request
      if (body.options?.skipSandbox !== undefined) {
        job.request.options = job.request.options || {};
        // skipSandbox maps to skipValidation in the pipeline
      }
      if (body.options?.skipInspector !== undefined) {
        job.request.options = job.request.options || {};
        job.request.options.skipInspector = body.options.skipInspector;
      }
      if (body.options?.timeoutMs) {
        job.request.options = job.request.options || {};
        job.request.options.sandboxTimeoutMs = body.options.timeoutMs;
      }

      // Advance through validation
      await forge.advance(body.jobId);

      const updatedJob = forge.getJob(body.jobId);
      if (!updatedJob) {
        throw new ForgeError(ForgeErrorCode.FORGE_INTERNAL_ERROR, 'Job disappeared after validation', { retryable: false });
      }

      return { job: toJobDetail(updatedJob, false, true) };
    });
  });

  // ── 4.4 POST /api/v1/mcp-forge/jobs — 创建任务（不执行）─────────────
  fastify.post('/api/v1/mcp-forge/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const body = request.body as GenerateRequestBody;
    const validationError = validateForgeRequest(body);
    if (validationError) {
      errorReply(reply, ForgeErrorCode.FORGE_INVALID_REQUEST, validationError, 400, false);
      return;
    }

    const forgeRequest: ForgeRequest = {
      description: body.description,
      serverName: body.serverName,
      templateId: body.templateId,
      options: {
        skipValidation: body.options?.skipValidation,
        skipInspector: body.options?.skipInspector,
        autoRegister: body.options?.autoRegister,
        sandboxTimeoutMs: body.options?.sandboxTimeoutMs,
        llmModel: body.options?.llmModel,
        customEnv: body.options?.customEnv,
        transport: body.options?.transport,
      },
    };

    await handleForgeOperation(reply, () => {
      const job = forge.createJob(forgeRequest);
      return { job: toJobDetail(job, false, true) };
    }, 201);
  });

  // ── 4.5 GET /api/v1/mcp-forge/jobs — 列出任务 ──────────────────────
  fastify.get('/api/v1/mcp-forge/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as {
      state?: string;
      limit?: string;
      offset?: string;
      sort?: string;
    };

    const limit = Math.min(Math.max(parseInt(query.limit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
    const sort = query.sort ?? 'createdAt_desc';

    let jobs = forge.listJobs();

    // Filter by state
    if (query.state) {
      const states = query.state.split(',').map((s) => s.trim());
      jobs = jobs.filter((j) => states.includes(j.state));
    }

    // Sort
    switch (sort) {
      case 'createdAt_asc':
        jobs.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case 'updatedAt_desc':
        jobs.sort((a, b) => b.updatedAt - a.updatedAt);
        break;
      case 'createdAt_desc':
      default:
        jobs.sort((a, b) => b.createdAt - a.createdAt);
        break;
    }

    const total = jobs.length;
    const paged = jobs.slice(offset, offset + limit);

    successPaginated(
      reply,
      paged.map(toJobSummary),
      total,
      limit,
      offset,
    );
  });

  // ── 4.6 GET /api/v1/mcp-forge/jobs/:id — 任务详情 ──────────────────
  fastify.get('/api/v1/mcp-forge/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const query = request.query as { includeCode?: string; includeHistory?: string };
    const includeCode = query.includeCode === 'true' || query.includeCode === '1';
    const includeHistory = query.includeHistory !== 'false' && query.includeHistory !== '0';

    await handleForgeOperation(reply, () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }
      return toJobDetail(job, includeCode, includeHistory);
    });
  });

  // ── 4.7 POST /api/v1/mcp-forge/jobs/:id/run — 执行流水线 ───────────
  fastify.post('/api/v1/mcp-forge/jobs/:id/run', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const body = (request.body || {}) as RunRequestBody;
    const timeoutMs = Math.min(body.timeoutMs ?? 120000, 600000);

    await handleForgeOperation(reply, async () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }

      if (isTerminal(job.state) && job.state !== 'completed') {
        // For failed jobs, retry first
        forge.retry(id);
      }

      const pipelinePromise = forge.runPipeline(id);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new ForgeError(
            ForgeErrorCode.FORGE_INTERNAL_ERROR,
            `Pipeline timed out after ${timeoutMs}ms`,
            { retryable: true, phase: 'pipeline' },
          ));
        }, timeoutMs);
      });

      try {
        await Promise.race([pipelinePromise, timeoutPromise]);
      } catch (err) {
        const currentJob = forge.getJob(id);
        if (currentJob && !isTerminal(currentJob.state)) {
          try { forge.cancel(id); } catch { /* ignore */ }
        }
        throw err;
      }

      const finalJob = forge.getJob(id);
      if (!finalJob) {
        throw new ForgeError(ForgeErrorCode.FORGE_INTERNAL_ERROR, 'Job disappeared after pipeline', { retryable: false });
      }

      return { job: toJobDetail(finalJob, true, true) };
    });
  });

  // ── 4.8 POST /api/v1/mcp-forge/jobs/:id/advance — 推进单步 ─────────
  fastify.post('/api/v1/mcp-forge/jobs/:id/advance', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const body = (request.body || {}) as AdvanceRequestBody;

    await handleForgeOperation(reply, async () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }

      if (body.toState) {
        // Validate target state is reachable
        const current = job.state;
        if (current === body.toState) {
          throw new ForgeError(
            ForgeErrorCode.FORGE_STATE_VIOLATION,
            `Job is already in state: ${current}`,
            { phase: current, retryable: false },
          );
        }
      }

      // Advance one step
      await forge.advance(id);

      const updatedJob = forge.getJob(id);
      if (!updatedJob) {
        throw new ForgeError(ForgeErrorCode.FORGE_INTERNAL_ERROR, 'Job disappeared after advance', { retryable: false });
      }

      return { job: toJobDetail(updatedJob, false, true) };
    });
  });

  // ── 4.9 POST /api/v1/mcp-forge/jobs/:id/cancel — 取消任务 ──────────
  fastify.post('/api/v1/mcp-forge/jobs/:id/cancel', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };

    await handleForgeOperation(reply, () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }
      const cancelledJob = forge.cancel(id);
      return { job: toJobDetail(cancelledJob, false, true) };
    });
  });

  // ── 4.10 POST /api/v1/mcp-forge/jobs/:id/retry — 重试失败步骤 ──────
  fastify.post('/api/v1/mcp-forge/jobs/:id/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const body = (request.body || {}) as RetryRequestBody;

    await handleForgeOperation(reply, () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }

      // Apply patch request if provided
      if (body.patchRequest) {
        if (body.patchRequest.description) {
          job.request.description = body.patchRequest.description;
        }
        if (body.patchRequest.serverName) {
          job.request.serverName = body.patchRequest.serverName;
        }
        if (body.patchRequest.templateId) {
          job.request.templateId = body.patchRequest.templateId;
        }
        if (body.patchRequest.options) {
          job.request.options = { ...job.request.options, ...body.patchRequest.options };
        }
      }

      const retriedJob = forge.retry(id);
      return { job: toJobDetail(retriedJob, false, true) };
    });
  });

  // ── 4.11 DELETE /api/v1/mcp-forge/jobs/:id — 删除任务 ──────────────
  fastify.delete('/api/v1/mcp-forge/jobs/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };

    await handleForgeOperation(reply, () => {
      const job = forge.getJob(id);
      if (!job) {
        throw new ForgeError(ForgeErrorCode.FORGE_INVALID_REQUEST, `Job not found: ${id}`, { retryable: false });
      }
      const deleted = forge.removeJob(id);
      return { id, deleted };
    });
  });

  // ── 4.12 GET /api/v1/mcp-forge/jobs/:id/events — SSE 事件流 ────────
  fastify.get('/api/v1/mcp-forge/jobs/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };

    // Verify job exists before establishing SSE connection
    const job = forge.getJob(id);
    if (!job) {
      errorReply(reply, 'FORGE_JOB_NOT_FOUND', `Job not found: ${id}`, 404, false);
      return;
    }

    // Set SSE headers
    reply.header('Content-Type', 'text/event-stream');
    reply.header('Cache-Control', 'no-cache');
    reply.header('Connection', 'keep-alive');
    reply.header('X-Accel-Buffering', 'no');

    // If job is already in terminal state, send done event immediately
    if (isTerminal(job.state)) {
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ jobId: id, finalState: job.state, progress: job.progress, timestamp: Date.now() })}\n\n`);
      reply.raw.end();
      return;
    }

    // Send initial connection event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ jobId: id, state: job.state, progress: job.progress, timestamp: Date.now() })}\n\n`);

    // Create event listener that writes to SSE stream
    const listener = (event: ForgeEvent): void => {
      try {
        reply.raw.write(forgeEventToSSE(event));

        // If job reaches terminal state, send done event and close
        if (event.type === 'state_change' && event.state && isTerminal(event.state)) {
          const doneData = {
            jobId: id,
            finalState: event.state,
            progress: event.progress,
            timestamp: Date.now(),
          };
          reply.raw.write(`event: done\ndata: ${JSON.stringify(doneData)}\n\n`);
          reply.raw.end();
        }
      } catch {
        // Connection may have been closed
      }
    };

    forge.addEventListener(id, listener);

    // Handle client disconnect
    request.raw.on('close', () => {
      forge.removeEventListener(id, listener);
      try { reply.raw.end(); } catch { /* ignore */ }
    });

    // Send periodic heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 30000);

    // Clean up heartbeat when connection closes
    request.raw.on('close', () => {
      clearInterval(heartbeatInterval);
    });
  });

  // ── 4.13 GET /api/v1/mcp-forge/templates — 模板列表 ────────────────
  fastify.get('/api/v1/mcp-forge/templates', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { language?: string; transport?: string };

    let templates = TemplateLibrary.listTemplates();

    // Filter by language (map 'nodejs' → 'typescript')
    if (query.language) {
      const lang = query.language === 'nodejs' ? 'typescript' : query.language;
      templates = templates.filter((t) => t.language === lang);
    }

    // Filter by transport
    if (query.transport) {
      templates = templates.filter((t) => t.transport === query.transport);
    }

    success(reply, templates.map(toTemplateSummary));
  });

  // ── 4.14 GET /api/v1/mcp-forge/templates/:id — 模板详情 ────────────
  fastify.get('/api/v1/mcp-forge/templates/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireServerToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const query = request.query as { includeCode?: string };
    const includeCode = query.includeCode === 'true' || query.includeCode === '1';

    try {
      const template = TemplateLibrary.getTemplate(id as Parameters<typeof TemplateLibrary.getTemplate>[0]);
      success(reply, toTemplateDetail(template, includeCode));
    } catch (err) {
      if (err instanceof ForgeError) {
        forgeErrorReply(reply, err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      errorReply(reply, ForgeErrorCode.FORGE_TEMPLATE_NOT_FOUND, `Template not found: ${id}`, 404, false);
    }
  });
}
