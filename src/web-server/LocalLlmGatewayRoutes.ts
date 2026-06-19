import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import {
  authorizeLocalLlmGatewayToken,
  commitLocalLlmGatewayUsage,
  reserveLocalLlmGatewayQuota,
  type LocalLlmGatewayAccess,
  type LocalLlmGatewayQuotaReservation,
} from '../core/LocalLlmGateway.js';
import { LLMClientManager, createLLMClient } from '../llm/Client.js';
import type { ContentGenerator, GenerateContentParams } from '../llm/ContentGenerator.js';
import type { ChatMessage, ChatResponse, MessageContent, MessageContentPart, StreamCallbacks, ToolCall, ToolDefinition, TokenUsage } from '../llm/types.js';
import { contentToPlainText } from '../llm/types.js';
import { countMessagesTokens } from '../llm/token_counter.js';
import { classifyLLMError, type LLMError } from '../llm/errors.js';
import type { EventMap } from '../core/EventEmitter.js';

type EmitterLike = {
  emit<EventName extends keyof EventMap>(event: EventName, payload: EventMap[EventName]): unknown;
};

type LlmGuardOptions = {
  actorLabel: string;
  maxRetries?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  classifyError?: (error: unknown) => LLMError;
  onRetry?: (attempt: number, error: unknown) => void;
  onError?: (error: unknown) => void;
  onCompactNeeded?: () => Promise<void>;
  cbScope?: string;
};

type LlmGuard = {
  call(
    llm: ContentGenerator,
    messages: ChatMessage[],
    model: string,
    tools?: ToolDefinition[],
    streamingEnabled?: boolean,
    signal?: AbortSignal,
    hooks?: StreamCallbacks,
    gatewayContext?: Record<string, unknown>,
    generateOptions?: { maxTokens?: number; sampling?: { temperature?: number; top_p?: number } },
  ): Promise<ChatResponse>;
};

type LlmGuardFactory = (options: LlmGuardOptions) => LlmGuard;

export type GatewayDeps = {
  repos: DatabaseRepositoryAdapter;
  emitter?: EmitterLike;
  getActiveSessionId?: () => string | undefined;
  createLlmGuard: LlmGuardFactory;
};

function resolveLlmGuardFactory(deps: GatewayDeps): LlmGuardFactory {
  if (deps.createLlmGuard) return deps.createLlmGuard;
  throw new Error('LocalLlmGatewayRoutes requires createLlmGuard dependency');
}

function cors(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, x-lingxiao-session-id, x-lingxiao-agent-id, x-lingxiao-agent-name, x-lingxiao-task-id');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function headerValue(request: FastifyRequest, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function bearerToken(request: FastifyRequest): string {
  const auth = headerValue(request, 'authorization');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return headerValue(request, 'x-api-key').trim();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function completionId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Deterministic pseudo-embedding fallback: generates a fixed-dimension vector
 * from text using a hash-based approach. Not semantically meaningful but provides
 * a stable vector for cosine similarity when no real embedding model is available.
 */
function deterministicPseudoEmbedding(text: string, dimensions: number = 256): number[] {
  const result = new Array(dimensions).fill(0);
  // Simple character-level hash distribution into vector slots
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    const slot = (charCode * 31 + i) % dimensions;
    result[slot] += Math.sin(charCode * 0.01 + i * 0.001);
  }
  // Normalize to unit length for cosine similarity compatibility
  const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      result[i] /= norm;
    }
  }
  return result;
}

function usageOrZero(usage?: TokenUsage): TokenUsage {
  return usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function requestMeta(deps: GatewayDeps, request: FastifyRequest): { sessionId: string; agentId: string; agentName: string; taskId?: string } {
  const sessionId =
    headerValue(request, 'x-lingxiao-session-id') ||
    deps.getActiveSessionId?.() ||
    '';
  return {
    sessionId,
    agentId: headerValue(request, 'x-lingxiao-agent-id') || 'llm-gateway',
    agentName: headerValue(request, 'x-lingxiao-agent-name') || 'LLM Gateway',
    taskId: headerValue(request, 'x-lingxiao-task-id') || undefined,
  };
}

function recordUsage(deps: GatewayDeps, request: FastifyRequest, usage: TokenUsage | undefined, model: string): void {
  const normalized = usageOrZero(usage);
  if (normalized.total_tokens <= 0) return;

  const meta = requestMeta(deps, request);
  if (!meta.sessionId) return;

  deps.repos.tokenUsage.insert(
    meta.sessionId,
    meta.agentId,
    meta.agentName,
    normalized.prompt_tokens || 0,
    normalized.completion_tokens || 0,
    normalized.total_tokens || 0,
    model,
    normalized.cache_read_input_tokens || 0,
    normalized.cache_creation_input_tokens || 0,
  );
  deps.emitter?.emit('token:usage', {
    sessionId: meta.sessionId,
    agentId: meta.agentId,
    ts: Date.now(),
    usage: {
      prompt: normalized.prompt_tokens || 0,
      completion: normalized.completion_tokens || 0,
      total: normalized.total_tokens || 0,
      cache_read: normalized.cache_read_input_tokens || 0,
      cache_creation: normalized.cache_creation_input_tokens || 0,
    },
  });
}

function traceId(prefix = 'lgw'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {/* expected: resource not available */
    return undefined;
  }
}

function recordGatewayRequest(input: {
  deps: GatewayDeps;
  request: FastifyRequest;
  access?: LocalLlmGatewayAccess;
  response?: ChatResponse;
  status: 'success' | 'failed' | 'rate_limited' | 'auth_failed';
  requestedModel?: string;
  selectedModel?: string;
  provider?: string;
  startedAt: number;
  errorKind?: string;
  errorMessage?: string;
  fallbackTraceId?: string;
  /** 失败路径覆盖：从抛出 error.gatewayTrace 提取的 attempts 明细（成功路径走 response.gateway） */
  attemptsOverride?: unknown[];
}): void {
  if (input.access?.gateway.traceEnabled === false) return;
  const meta = requestMeta(input.deps, input.request);
  const usage = usageOrZero(input.response?.usage);
  const gateway = input.response?.gateway;
  try {
    input.deps.repos.tokenUsage.insertGatewayRequest({
      trace_id: gateway?.traceId || input.fallbackTraceId || traceId(),
      session_id: meta.sessionId || undefined,
      agent_id: meta.agentId,
      agent_name: meta.agentName,
      key_id: input.access?.keyId,
      key_label: input.access?.keyLabel,
      profile: gateway?.profile || 'local_gateway',
      requested_model: input.requestedModel || input.access?.modelId,
      selected_model: gateway?.selectedModel || input.selectedModel || input.access?.modelId,
      final_model: gateway?.finalModel || input.response?.model || input.access?.modelId,
      provider: input.provider || input.access?.provider,
      status: input.status,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      latency_ms: Date.now() - input.startedAt,
      attempts_json: safeStringify(input.attemptsOverride ?? gateway?.attempts ?? []),
      error_kind: input.errorKind,
      error_message: input.errorMessage,
      created_at: input.startedAt / 1000,
    });
  } catch {
    // Gateway tracing must not break the local model API surface.
  }
}

function authorize(request: FastifyRequest, reply: FastifyReply): LocalLlmGatewayAccess | null {
  cors(reply);
  const result = authorizeLocalLlmGatewayToken(bearerToken(request));
  if (!result.ok) {
    reply.status(result.error.statusCode).send({ error: { message: result.error.message, type: result.error.type } });
    return null;
  }
  return result.access;
}

function normalizeOpenAIContent(content: unknown): MessageContent {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts: MessageContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if ((p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text });
      continue;
    }
    if (p.type === 'image_url' && p.image_url && typeof p.image_url === 'object') {
      const image = p.image_url as Record<string, unknown>;
      if (typeof image.url === 'string') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: image.url,
            detail: image.detail === 'low' || image.detail === 'high' || image.detail === 'auto' ? image.detail : undefined,
          },
        });
      }
    }
  }
  return parts.length > 0 ? parts : '';
}

function openAIMessagesToInternal(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((msg) => {
      const m = msg as Record<string, unknown>;
      const role = m.role === 'system' || m.role === 'assistant' || m.role === 'tool' ? m.role : 'user';
      const out: ChatMessage = {
        role,
        content: normalizeOpenAIContent(m.content),
      };
      if (typeof m.tool_call_id === 'string') out.tool_call_id = m.tool_call_id;
      if (Array.isArray(m.tool_calls)) out.tool_calls = openAIToolCallsToInternal(m.tool_calls);
      return out;
    });
}

function openAIToolCallsToInternal(toolCalls: unknown[]): ToolCall[] {
  return toolCalls
    .map((tc, index) => {
      const t = tc as Record<string, unknown>;
      const fn = t.function as Record<string, unknown> | undefined;
      if (!fn || typeof fn.name !== 'string') return null;
      return {
        id: typeof t.id === 'string' ? t.id : `call_${index}`,
        type: 'function' as const,
        function: {
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
        },
      };
    })
    .filter(Boolean) as ToolCall[];
}

function openAIToolsToInternal(tools: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .map((tool) => {
      const t = tool as Record<string, unknown>;
      const fn = t.function as Record<string, unknown> | undefined;
      if (t.type !== 'function' || !fn || typeof fn.name !== 'string') return null;
      return {
        type: 'function' as const,
        function: {
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: (fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : {}) as Record<string, unknown>,
        },
      };
    })
    .filter(Boolean) as ToolDefinition[];
  return out.length > 0 ? out : undefined;
}

function internalToolCallsToOpenAI(toolCalls?: ToolCall[]) {
  return toolCalls?.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}

function openAIResponse(response: ChatResponse, model: string) {
  const toolCalls = internalToolCallsToOpenAI(response.tool_calls);
  return {
    id: completionId('chatcmpl'),
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: contentToPlainText(response.content),
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: response.finish_reason || (toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: response.usage ? {
      prompt_tokens: response.usage.prompt_tokens || 0,
      completion_tokens: response.usage.completion_tokens || 0,
      total_tokens: response.usage.total_tokens || 0,
    } : undefined,
  };
}

function anthropicTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const p = part as Record<string, unknown>;
    if (p.type === 'text' && typeof p.text === 'string') return p.text;
    return '';
  }).filter(Boolean).join('\n');
}

function anthropicMessagesToInternal(body: Record<string, unknown>): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (typeof body.system === 'string' && body.system.trim()) {
    out.push({ role: 'system', content: body.system });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: anthropicTextContent(m.content) });
  }
  return out;
}

function anthropicToolsToInternal(tools: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map((tool) => {
    const t = tool as Record<string, unknown>;
    if (typeof t.name !== 'string') return null;
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: (t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : {}) as Record<string, unknown>,
      },
    };
  }).filter(Boolean) as ToolDefinition[];
  return out.length > 0 ? out : undefined;
}

function anthropicResponse(response: ChatResponse, model: string) {
  const text = contentToPlainText(response.content);
  return {
    id: completionId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: response.finish_reason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    },
  };
}

function sseWrite(raw: NodeJS.WritableStream, event: string | null, data: unknown): void {
  // 客户端断连后 raw 可能 destroyed/writableEnded：写守卫避免 ERR_STREAM_DESTROYED 上抛、
  // 阻塞上游流式回调。向死流写是 no-op（客户端已走）。
  const w = raw as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean };
  if (w.destroyed || w.writableEnded) return;
  try {
    if (event) w.write(`event: ${event}\n`);
    w.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* 客户端已断连，忽略写 */ }
}

function gatewayStreamErrorPayload(error: unknown, fallbackType: string): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (isQuotaError(error)) {
    return {
      message,
      type: error.quota.reason || 'rate_limit_exceeded',
      status: 429,
      statusCode: 429,
      retryAfterMs: error.quota.retryAfterMs,
    };
  }

  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const classified = record.classified && typeof record.classified === 'object'
    ? record.classified as Record<string, unknown>
    : undefined;
  const statusRaw = record.statusCode ?? record.status ?? classified?.statusCode ?? classified?.status;
  const statusCode = typeof statusRaw === 'number' ? statusRaw : undefined;
  const typeRaw = record.type ?? record.errorType ?? classified?.errorType;
  const retryAfterRaw = record.retryAfterMs ?? classified?.retryAfterMs;
  const payload: Record<string, unknown> = {
    message,
    type: typeof typeRaw === 'string' && typeRaw.trim() ? typeRaw : fallbackType,
  };
  if (statusCode !== undefined) {
    payload.status = statusCode;
    payload.statusCode = statusCode;
  }
  if (typeof retryAfterRaw === 'number') {
    payload.retryAfterMs = retryAfterRaw;
  }
  return payload;
}

function estimateRequestTokens(params: GenerateContentParams): number {
  let total = countMessagesTokens(params.messages);
  if (params.tools) {
    for (const tool of params.tools) {
      total += countMessagesTokens([{ role: 'system', content: JSON.stringify(tool) }]);
    }
  }
  if (params.maxTokens && params.maxTokens > 0) {
    total += Math.min(params.maxTokens, 4096);
  }
  return Math.max(1, total);
}

function sendRateLimit(reply: FastifyReply, quota: ReturnType<typeof reserveLocalLlmGatewayQuota>): void {
  if (quota.retryAfterMs) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(quota.retryAfterMs / 1000))));
  }
  reply.status(429).send({
    error: {
      message: quota.message || 'Local LLM gateway rate limit exceeded',
      type: quota.reason || 'rate_limit_exceeded',
      status: 429,
      statusCode: 429,
      retryAfterMs: quota.retryAfterMs,
    },
  });
}

async function callLocalGateway(
  deps: GatewayDeps,
  request: FastifyRequest,
  access: LocalLlmGatewayAccess,
  params: GenerateContentParams,
  streamingEnabled: boolean,
  hooks?: StreamCallbacks,
  signal?: AbortSignal,
): Promise<{ response: ChatResponse; reservation?: LocalLlmGatewayQuotaReservation; startedAt: number }> {
  const startedAt = Date.now();
  const quota = reserveLocalLlmGatewayQuota(access, estimateRequestTokens(params));
  if (!quota.allowed) {
    recordGatewayRequest({
      deps,
      request,
      access,
      status: 'rate_limited',
      requestedModel: params.model,
      selectedModel: access.modelId,
      provider: access.provider,
      startedAt,
      errorKind: quota.reason,
      errorMessage: quota.message,
      fallbackTraceId: traceId(),
    });
    const err = new Error(quota.message || 'Local LLM gateway rate limit exceeded') as Error & {
      quota?: typeof quota;
      statusCode?: number;
    };
    err.quota = quota;
    err.statusCode = 429;
    throw err;
  }

  const llm = new LLMClientManager(access.modelId);
  const createGuard = await resolveLlmGuardFactory(deps);
  const guard = createGuard({
    actorLabel: `LocalGateway:${access.keyId}`,
    classifyError: classifyLLMError,
    cbScope: `local_gateway::${access.keyId}`,
  });
  const meta = requestMeta(deps, request);
  const response = await guard.call(
    llm,
    params.messages,
    params.model,
    params.tools,
    streamingEnabled,
    signal,
    hooks,
    {
      actorType: 'local_gateway',
      actorLabel: meta.agentName,
      purpose: 'local_gateway',
      sessionId: meta.sessionId,
      agentId: meta.agentId,
      agentName: meta.agentName,
      taskId: meta.taskId,
      requestedModel: params.model,
    },
  );
  commitLocalLlmGatewayUsage(access, response.usage?.total_tokens || 0, quota.reservation);
  recordUsage(deps, request, response.usage, access.apiModel);
  recordGatewayRequest({
    deps,
    request,
    access,
    response,
    status: 'success',
    requestedModel: params.model,
    selectedModel: access.modelId,
    provider: access.provider,
    startedAt,
  });
  return { response, reservation: quota.reservation, startedAt };
}

function isQuotaError(error: unknown): error is Error & { quota: ReturnType<typeof reserveLocalLlmGatewayQuota>; statusCode: number } {
  return !!error && typeof error === 'object' && (error as { statusCode?: number }).statusCode === 429 && !!(error as { quota?: unknown }).quota;
}

/**
 * 从 LlmGuard 失败 throw 的 error 上提取 gatewayTrace.attempts 明细。
 * LlmGuard 失败时通过 attachGatewayTrace 把 trace 摘要附在 error.gatewayTrace（见 LlmGuard.ts）；
 * 成功路径走 response.gateway，失败路径用此函数补 attempts_json，避免失败请求 attempts 为空。
 */
export function extractAttemptsFromError(error: unknown): unknown[] {
  const gatewayTrace = (error as Record<string, unknown> | null | undefined)?.gatewayTrace as
    | { attempts?: unknown[] }
    | undefined;
  return Array.isArray(gatewayTrace?.attempts) ? gatewayTrace!.attempts : [];
}

function recordFailure(input: {
  deps: GatewayDeps;
  request: FastifyRequest;
  access: LocalLlmGatewayAccess;
  params: GenerateContentParams;
  startedAt: number;
  error: unknown;
}): void {
  const classified = classifyLLMError(input.error);
  recordGatewayRequest({
    deps: input.deps,
    request: input.request,
    access: input.access,
    status: 'failed',
    requestedModel: input.params.model,
    selectedModel: input.access.modelId,
    provider: input.access.provider,
    startedAt: input.startedAt,
    errorKind: classified.llmErrorKind,
    errorMessage: classified.message,
    fallbackTraceId: traceId(),
    attemptsOverride: extractAttemptsFromError(input.error),
  });
}

function openAIStreamChunk(text: string, model: string) {
  return {
    id: completionId('chatcmpl'),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

export function registerLocalLlmGatewayRoutes(fastify: FastifyInstance, deps: GatewayDeps): void {
  fastify.options('/llm/openai/v1/*', async (_request, reply) => {
    cors(reply);
    return reply.status(204).send();
  });
  fastify.options('/llm/anthropic/v1/*', async (_request, reply) => {
    cors(reply);
    return reply.status(204).send();
  });

  fastify.get('/llm/openai/v1/models', async (request, reply) => {
    const gateway = authorize(request, reply);
    if (!gateway) return;
    return {
      object: 'list',
      data: [{
        id: gateway.apiModel,
        object: 'model',
        created: nowSeconds(),
        owned_by: 'lingxiao-local',
      }],
    };
  });

  fastify.get('/llm/anthropic/v1/models', async (request, reply) => {
    const gateway = authorize(request, reply);
    if (!gateway) return;
    return {
      data: [{
        id: gateway.apiModel,
        type: 'model',
        display_name: gateway.apiModel,
        created_at: new Date().toISOString(),
      }],
      has_more: false,
      first_id: gateway.apiModel,
      last_id: gateway.apiModel,
    };
  });

  // ── P1: Embeddings endpoint (OpenAI-compatible) ──
  // Provides /llm/openai/v1/embeddings for memory embedding generation.
  // Uses the same gateway auth as chat completions.
  fastify.post('/llm/openai/v1/embeddings', async (request, reply) => {
    const gateway = authorize(request, reply);
    if (!gateway) return;

    const body = (request.body || {}) as Record<string, unknown>;
    const input = body.input;
    if (input === undefined || input === null) {
      reply.status(400).send({ error: { message: 'input is required', type: 'invalid_request_error' } });
      return;
    }

    // Normalize input to string[]
    const inputs: string[] = Array.isArray(input)
      ? input.map((v) => String(v))
      : [String(input)];

    if (inputs.length === 0 || inputs.some((s) => s.length === 0)) {
      reply.status(400).send({ error: { message: 'input must be a non-empty string or array of non-empty strings', type: 'invalid_request_error' } });
      return;
    }

    // Use LLM client to generate embeddings.
    // The local gateway routes embedding requests through the LLMClientManager
    // which delegates to the configured provider's embedding endpoint.
    try {
      const client = createLLMClient();
      const model = (typeof body.model === 'string' ? body.model : undefined) || gateway.modelId;

      // Generate embedding for each input string.
      // Most OpenAI-compatible APIs accept batch input; we call per-item for compatibility.
      const embeddings: Array<{ object: string; embedding: number[]; index: number }> = [];
      let totalTokens = 0;

      for (let i = 0; i < inputs.length; i++) {
        const text = inputs[i];
        // Approximate token count (4 chars per token heuristic)
        totalTokens += Math.ceil(text.length / 4);

        // Call the LLM client's embedding method if available;
        // otherwise generate a deterministic hash-based pseudo-embedding as fallback.
        let embedding: number[];
        if (typeof (client as unknown as { embed?: (text: string, model: string) => Promise<number[]> }).embed === 'function') {
          embedding = await (client as unknown as { embed: (text: string, model: string) => Promise<number[]> }).embed(text, model);
        } else {
          // Deterministic fallback: hash-based pseudo-embedding (not semantic, but stable).
          // This allows the embedding pipeline to function even without a real embedding model.
          embedding = deterministicPseudoEmbedding(text, 256);
        }
        embeddings.push({ object: 'embedding', embedding, index: i });
      }

      return {
        object: 'list',
        data: embeddings,
        model,
        usage: {
          prompt_tokens: totalTokens,
          total_tokens: totalTokens,
        },
      };
    } catch (err) {
      const startedAt = Date.now();
      recordFailure({ deps, request, access: gateway, params: { messages: [], model: '' } as GenerateContentParams, startedAt, error: err });
      reply.status(500).send({
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'server_error',
        },
      });
    }
  });

  fastify.post('/llm/openai/v1/chat/completions', async (request, reply) => {
    const gateway = authorize(request, reply);
    if (!gateway) return;

    const body = (request.body || {}) as Record<string, unknown>;
    const params: GenerateContentParams = {
      messages: openAIMessagesToInternal(body.messages),
      model: gateway.modelId,
      tools: openAIToolsToInternal(body.tools),
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      sampling: {
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
      },
    };

    if (body.stream === true) {
      const startedAt = Date.now();
      reply.hijack();
      cors(reply);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // 客户端断连即中止上游 LLM 调用：避免 provider 在客户端已走后仍跑满生成（烧 token），
      // 且防止 reply.raw.write 向死流缓冲无界增长。
      const abortController = new AbortController();
      const onClientClose = () => abortController.abort();
      request.raw.once('close', onClientClose);
      const safeWrite = (chunk: string): void => {
        const raw = reply.raw;
        if (raw.destroyed || raw.writableEnded) return;
        try { raw.write(chunk); } catch { /* 客户端已断连 */ }
      };
      try {
        const { response: finalResponse } = await callLocalGateway(
          deps,
          request,
          gateway,
          params,
          true,
          {
            onText: (text) => {
              safeWrite(`data: ${JSON.stringify(openAIStreamChunk(text, gateway.apiModel))}\n\n`);
            },
          },
          abortController.signal,
        );
        if (finalResponse.usage) {
          safeWrite(`data: ${JSON.stringify({
            id: completionId('chatcmpl'),
            object: 'chat.completion.chunk',
            created: nowSeconds(),
            model: gateway.apiModel,
            choices: [],
            usage: finalResponse.usage,
          })}\n\n`);
        }
        safeWrite('data: [DONE]\n\n');
      } catch (err) {
        if (isQuotaError(err)) {
          safeWrite(`data: ${JSON.stringify({ error: gatewayStreamErrorPayload(err, 'rate_limit_exceeded') })}\n\n`);
        } else {
          recordFailure({ deps, request, access: gateway, params, startedAt, error: err });
          safeWrite(`data: ${JSON.stringify({ error: gatewayStreamErrorPayload(err, 'server_error') })}\n\n`);
        }
      } finally {
        request.raw.off('close', onClientClose);
        try { reply.raw.end(); } catch { /* 已关闭 */ }
      }
      return;
    }

    const startedAt = Date.now();
    try {
      const { response } = await callLocalGateway(deps, request, gateway, params, false);
      return openAIResponse(response, gateway.apiModel);
    } catch (err) {
      if (isQuotaError(err)) {
        sendRateLimit(reply, err.quota);
        return;
      }
      recordFailure({ deps, request, access: gateway, params, startedAt, error: err });
      throw err;
    }
  });

  fastify.post('/llm/anthropic/v1/messages', async (request, reply) => {
    const gateway = authorize(request, reply);
    if (!gateway) return;

    const body = (request.body || {}) as Record<string, unknown>;
    const params: GenerateContentParams = {
      messages: anthropicMessagesToInternal(body),
      model: gateway.modelId,
      tools: anthropicToolsToInternal(body.tools),
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      sampling: {
        temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
        top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
      },
    };

    if (body.stream === true) {
      const startedAt = Date.now();
      reply.hijack();
      cors(reply);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const messageId = completionId('msg');
      // 客户端断连即中止上游 LLM（同 OpenAI 路径）；sseWrite 已对死流守卫。
      const abortController = new AbortController();
      const onClientClose = () => abortController.abort();
      request.raw.once('close', onClientClose);
      try {
        sseWrite(reply.raw, 'message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: gateway.apiModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        sseWrite(reply.raw, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        const { response: finalResponse } = await callLocalGateway(
          deps,
          request,
          gateway,
          params,
          true,
          {
            onText: (text) => {
              if (!text) return;
              sseWrite(reply.raw, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              });
            },
          },
          abortController.signal,
        );
        sseWrite(reply.raw, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sseWrite(reply.raw, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: finalResponse?.finish_reason || 'end_turn', stop_sequence: null },
          usage: { output_tokens: finalResponse?.usage?.completion_tokens || 0 },
        });
        sseWrite(reply.raw, 'message_stop', { type: 'message_stop' });
      } catch (err) {
        if (!isQuotaError(err)) {
          recordFailure({ deps, request, access: gateway, params, startedAt, error: err });
        }
        sseWrite(reply.raw, 'error', {
          type: 'error',
          error: gatewayStreamErrorPayload(err, isQuotaError(err) ? 'rate_limit_exceeded' : 'api_error'),
        });
      } finally {
        request.raw.off('close', onClientClose);
        try { reply.raw.end(); } catch { /* 已关闭 */ }
      }
      return;
    }

    const startedAt = Date.now();
    try {
      const { response } = await callLocalGateway(deps, request, gateway, params, false);
      return anthropicResponse(response, gateway.apiModel);
    } catch (err) {
      if (isQuotaError(err)) {
        sendRateLimit(reply, err.quota);
        return;
      }
      recordFailure({ deps, request, access: gateway, params, startedAt, error: err });
      throw err;
    }
  });
}
