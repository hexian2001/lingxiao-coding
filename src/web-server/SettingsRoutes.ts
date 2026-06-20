/**
 * SettingsRoutes — 设置、模型管理、提示词增强、直觉系统路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { SessionManager } from '../core/SessionManager.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { getConfigValue, setConfigValue, saveSettings, ConfigSchema, config as runtimeConfig, syncDerivedConstants, fireConfigReload, type ModelProvidersConfig, type ModelProviderConfig } from '../config.js';
import { getModelManager } from '../config/ModelManager.js';
import { isHardenedMode, isHardenedModeLocked } from '../core/HardeningPolicy.js';
import { LLM, TOOLS } from '../config/defaults.js';
import { toErrorMessage } from '../core/errors.js';
import { resolveLocalLlmGateway } from '../core/LocalLlmGateway.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ChatMessage, ChatResponse, StreamCallbacks, ToolDefinition } from '../llm/types.js';
import type { LLMError } from '../llm/errors.js';
import { estimateTokens } from '../llm/token_counter.js';
import { DEFAULT_LINGXIAO_USER_AGENT, isLingxiaoDefaultUserAgent, normalizeLingxiaoUserAgent } from '../version.js';
import type { AuthFn } from './types.js';

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

type ExternalAgentAvailabilityProvider = () => unknown;

interface SettingsRoutesDeps {
  repos: DatabaseRepositoryAdapter;
  sessionManager: SessionManager;
  requireServerToken: AuthFn;
  getActiveSessionId?: () => string | undefined;
  createLlmGuard: LlmGuardFactory;
  getExternalAgentAvailability: ExternalAgentAvailabilityProvider;
}

function resolveLlmGuardFactory(deps: SettingsRoutesDeps): LlmGuardFactory {
  if (deps.createLlmGuard) return deps.createLlmGuard;
  throw new Error('SettingsRoutes requires createLlmGuard dependency');
}

function resolveExternalAgentAvailability(deps: SettingsRoutesDeps): ExternalAgentAvailabilityProvider {
  if (deps.getExternalAgentAvailability) return deps.getExternalAgentAvailability;
  throw new Error('SettingsRoutes requires getExternalAgentAvailability dependency');
}

function buildPromptEnhanceMessages(prompt: string) {
  const systemPrompt = `你是一个提示词优化专家。用户会给你一段提示词，你需要将其优化为更清晰、更具体、更有效的形式。
要求：
1. 保留用户的核心意图，不改变要求的方向
2. 补充必要的上下文信息（如：角色设定、输出格式、约束条件）
3. 使表达更加明确，消除歧义
4. 适当增加结构化（如分点、分步骤）让 LLM 更容易理解
5. 直接返回优化后的提示词文本，不要加任何解释或前缀`;
  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: `请优化以下提示词：\n\n${prompt}` },
  ];
}

function extractPromptEnhanceText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string }) => part?.type === 'text' ? String(part.text || '') : '')
    .join('')
    .trim();
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOwnField(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function optionalPlainRecord(body: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  if (!hasOwnField(body, field) || body[field] == null) return undefined;
  const record = plainRecord(body[field]);
  if (!record) throw new Error(`${field} must be an object`);
  return record;
}

/** Maps frontend setting key → config.ts hierarchical path */
const SETTINGS_MAP: Record<string, string> = {
  'provider': 'llm.provider',
  'model': 'llm.leader_model',
  'agentModel': 'llm.agent_model',
  // v3: openai/anthropic global key 已废弃，通过 model_providers 管理
  'reasoningEffort': 'llm.reasoning_effort',
  'thinkingBudgetTokens': 'llm.thinking_budget_tokens',
  'alwaysThinkingEnabled': 'llm.enable_extended_thinking',
  'showThinkingContent': 'llm.show_thinking_content',
  'enableStreaming': 'llm.enable_streaming',
  'enableThinkingInstruction': 'llm.enable_thinking_instruction',
  'localLlmGatewayEnabled': 'llm_gateway.enabled',
  'localLlmGatewayProvider': 'llm_gateway.provider',
  'localLlmGatewayModel': 'llm_gateway.model',
  'localLlmGatewayHost': 'llm_gateway.host',
  'localLlmGatewayPort': 'llm_gateway.port',
  'localLlmGatewayInjectEnv': 'llm_gateway.inject_env',
  'localLlmGatewayOverrideExistingEnv': 'llm_gateway.override_existing_env',
  'fileCheckpointingEnabled': 'checkpoint.file_checkpointing_enabled',
  'checkpointMaxCheckpoints': 'checkpoint.max_checkpoints',
  'checkpointAutoGcEnabled': 'checkpoint.auto_gc_enabled',
  'checkpointMaxWorkspaceFiles': 'checkpoint.max_workspace_files',
  'autoCompactEnabled': 'context.autocompact_enabled',
  'memoryEnabled': 'memory.enabled',
  'autoMemoryEnabled': 'memory.auto_memory_enabled',
  'intuitionEnabled': 'memory.intuition_enabled',
  'tacitModeEnabled': 'memory.tacit_mode_enabled',
  'intuitionProfile': 'memory.intuition_profile',
  'planReviewEnabled': 'leader.plan_review_enabled',
  'maxConcurrency': 'agents.max_concurrent',
  'maxIterations': 'agents.max_iterations',
  'workerCompletionJudgeEnabled': 'agents.worker_completion_judge_enabled',
  'externalAgentsEnabled': 'agents.external_agents_enabled',
  'uiLanguage': 'ui.language',
  // Git integration
  'gitPlatform': 'git.platform',
  'gitToken': 'git.token',
  'gitApiUrl': 'git.api_url',
  'gitDefaultTargetBranch': 'git.default_target_branch',
  'gitPreCommitGateEnabled': 'git.pre_commit_gate.enabled',
  'gitPreCommitGateTypeCheck': 'git.pre_commit_gate.type_check',
  'gitPreCommitGateCommand': 'git.pre_commit_gate.command',
  // Server
  'serverRandomPort': 'server.random_port',
  // Network proxy
  'userAgent': 'network.user_agent',
  'proxyProtocol': 'network.proxy.protocol',
  'proxyHost': 'network.proxy.host',
  'proxyPort': 'network.proxy.port',
  'proxyUsername': 'network.proxy.username',
  'proxyPassword': 'network.proxy.password',
  'proxyNoProxy': 'network.proxy.no_proxy',
  'proxyUrl': 'network.proxy.url',
  'proxyLlmRequests': 'network.proxy.llm_enabled',
  'proxyToolRequests': 'network.proxy.tools_enabled',
  // MCP
  'mcpEnabled': 'mcp.enabled',
  'mcpToolTimeoutMs': 'mcp.tool_timeout_ms',
  'toolExecutionTimeoutMs': 'tools.execution_timeout_ms',
  // UI
  'includeCoAuthoredBy': 'ui.include_co_authored_by',
  'promptSuggestionEnabled': 'ui.prompt_suggestion_enabled',
  // Security sandbox
  'permissionMode': 'security.permission_mode',
  'sandboxAutoAllowBashIfSandboxed': 'security.auto_allow_bash_if_sandboxed',
  'dangerousCommandGuard': 'security.dangerous_command_guard',
  'blockPrivateNetwork': 'security.block_private_network',
  'identityJudgeLlmEnabled': 'security.identity_judge_llm_enabled',
  // Security hardened mode（企业内网加固）
  'hardenedMode': 'security.hardened_mode',
  'envAllowlist': 'security.env_allowlist',
  // Advanced
  'cleanupPeriodDays': 'advanced.cleanup_period_days',
  'imageHistoryRetainRounds': 'advanced.image_history_retain_rounds',
  'deferToolLoading': 'advanced.defer_tool_loading',
  'ignoreGitIgnore': 'advanced.ignore_gitignore',
  'hookOutputCollapsed': 'advanced.hook_output_collapsed',
  'env': 'advanced.env',
  // Langfuse observability
  'langfuseEnabled': 'observability.langfuse.enabled',
  'langfuseBaseUrl': 'observability.langfuse.baseUrl',
  'langfuseSecretKey': 'observability.langfuse.secretKey',
  'langfusePublicKey': 'observability.langfuse.publicKey',
  'langfuseTraceLlmCalls': 'observability.langfuse.traceLlmCalls',
  'langfuseTraceToolCalls': 'observability.langfuse.traceToolCalls',
  'langfuseTraceAgentLifecycle': 'observability.langfuse.traceAgentLifecycle',
  'langfuseSampleRate': 'observability.langfuse.sampleRate',
  'langfuseMaskSensitive': 'observability.langfuse.maskSensitive',
  // Workspace initialization flag
  'initialized': 'initialized',
};

const MODEL_PROVIDER_CREATE_FIELDS = new Set([
  'provider',
  'name',
  'model',
  'apiKey',
  'envKey',
  'baseUrl',
  'contextWindowSize',
  'generationConfig',
  'capabilities',
]);

const MODEL_PROVIDER_UPDATE_FIELDS = new Set([
  'contextWindowSize',
  'apiKey',
  'envKey',
  'baseUrl',
  'model',
  'provider',
  'generationConfig',
  'capabilities',
]);

function findUnsupportedField(body: Record<string, unknown>, allowedFields: ReadonlySet<string>): string | undefined {
  return Object.keys(body).find((field) => !allowedFields.has(field));
}

export function registerSettingsRoutes(
  fastify: FastifyInstance,
  deps: SettingsRoutesDeps,
): void {
  const { repos, sessionManager, requireServerToken, getActiveSessionId } = deps;

  // GET /api/v1/settings — 读取所有设置
  fastify.get('/api/v1/settings', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const data: Record<string, unknown> = {};
    for (const [key, configPath] of Object.entries(SETTINGS_MAP)) {
      data[key] = getConfigValue(configPath);
    }
    data.userAgent = normalizeLingxiaoUserAgent(data.userAgent);
    // Normalize booleans
    data.alwaysThinkingEnabled = !!data.alwaysThinkingEnabled;
    data.showThinkingContent = data.showThinkingContent === true;
    data.enableStreaming = data.enableStreaming !== false;
    data.enableThinkingInstruction = data.enableThinkingInstruction !== false;
    data.localLlmGatewayEnabled = !!data.localLlmGatewayEnabled;
    data.localLlmGatewayProvider = data.localLlmGatewayProvider || 'openai';
    data.localLlmGatewayModel = data.localLlmGatewayModel || data.model || '';
    data.localLlmGatewayHost = typeof data.localLlmGatewayHost === 'string' && data.localLlmGatewayHost ? data.localLlmGatewayHost : '127.0.0.1';
    data.localLlmGatewayPort = typeof data.localLlmGatewayPort === 'number' && data.localLlmGatewayPort > 0 ? data.localLlmGatewayPort : 62000;
    data.localLlmGatewayInjectEnv = data.localLlmGatewayInjectEnv !== false;
    data.localLlmGatewayOverrideExistingEnv = !!data.localLlmGatewayOverrideExistingEnv;
    data.fileCheckpointingEnabled = data.fileCheckpointingEnabled !== false;
    data.checkpointMaxCheckpoints = typeof data.checkpointMaxCheckpoints === 'number' && data.checkpointMaxCheckpoints >= 5 ? data.checkpointMaxCheckpoints : 50;
    data.checkpointAutoGcEnabled = data.checkpointAutoGcEnabled !== false;
    data.checkpointMaxWorkspaceFiles = typeof data.checkpointMaxWorkspaceFiles === 'number' && data.checkpointMaxWorkspaceFiles >= 1000 ? data.checkpointMaxWorkspaceFiles : 100000;
    data.autoCompactEnabled = data.autoCompactEnabled !== false;
    data.memoryEnabled = data.memoryEnabled !== false;
    data.autoMemoryEnabled = data.autoMemoryEnabled !== false;
    data.intuitionEnabled = data.intuitionEnabled !== false;
    data.tacitModeEnabled = data.tacitModeEnabled !== false;
    data.planReviewEnabled = data.planReviewEnabled !== false;
    data.enableWorkerProcess = !!data.enableWorkerProcess;
    data.workerCompletionJudgeEnabled = data.workerCompletionJudgeEnabled === true;
    data.externalAgentsEnabled = data.externalAgentsEnabled !== false;
    data.includeCoAuthoredBy = data.includeCoAuthoredBy !== false;
    data.promptSuggestionEnabled = data.promptSuggestionEnabled !== false;
    data.mcpEnabled = data.mcpEnabled !== false;
    data.mcpToolTimeoutMs = typeof data.mcpToolTimeoutMs === 'number' ? data.mcpToolTimeoutMs : 60000;
    data.toolExecutionTimeoutMs = typeof data.toolExecutionTimeoutMs === 'number' ? data.toolExecutionTimeoutMs : TOOLS.EXECUTION_TIMEOUT_MS;
    data.defaultUserAgent = DEFAULT_LINGXIAO_USER_AGENT;
    data.permissionMode = typeof data.permissionMode === 'string' ? data.permissionMode : 'yolo';
    data.sandboxAutoAllowBashIfSandboxed = data.sandboxAutoAllowBashIfSandboxed !== false;
    data.identityJudgeLlmEnabled = data.identityJudgeLlmEnabled === true;
    data.deferToolLoading = !!data.deferToolLoading;
    data.ignoreGitIgnore = !!data.ignoreGitIgnore;
    data.hookOutputCollapsed = data.hookOutputCollapsed !== false;
    // Security hardened mode：hardenedMode 必须反映 env 覆盖后的有效值（不能只读 config），
    // 这样 LINGXIAO_HARDENED_MODE 锁定时 UI 显示与实际行为一致。
    data.hardenedMode = isHardenedMode();
    data.hardenedModeLocked = isHardenedModeLocked();
    data.envAllowlist = Array.isArray(data.envAllowlist) ? data.envAllowlist : [];
    // Mask credentials keys in model_providers (handled separately below)
    if (data.gitToken) data.gitToken = String(data.gitToken).slice(0, 6) + '***';
    // Mask Langfuse secret/public keys in GET response
    if (data.langfuseSecretKey) data.langfuseSecretKey = String(data.langfuseSecretKey).slice(0, 6) + '***';
    if (data.langfusePublicKey) data.langfusePublicKey = String(data.langfusePublicKey).slice(0, 6) + '***';
    try {
      const gateway = resolveLocalLlmGateway();
      if (gateway) {
        data.localLlmGatewayOpenaiBaseUrl = gateway.openaiBaseUrl;
        data.localLlmGatewayAnthropicBaseUrl = gateway.anthropicBaseUrl;
        data.localLlmGatewayEffectiveModel = gateway.apiModel;
      }
    } catch { /* expected: gateway config may not be initialized */
      data.localLlmGatewayEffectiveModel = '';
    }
    // Expose model_providers list (provider names + model ids) for UI selection
    try {
      const mp = getConfigValue('llm.model_providers') as ModelProvidersConfig | undefined;
      if (mp && typeof mp === 'object') {
        data.providers = Object.entries(mp).map(([provider, models]) => ({
          id: provider,
          name: provider,
          models: (Array.isArray(models) ? models : []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
            model: m.model || m.id,
            provider: m.provider,
            baseUrl: m.baseUrl || '',
            envKey: m.envKey || undefined,
            generationConfig: m.generationConfig,
            capabilities: m.capabilities,
            contextWindowSize: typeof m.contextWindowSize === 'number' ? m.contextWindowSize : undefined,
          })),
        }));
      } else {
        data.providers = [];
      }
    } catch {
      data.providers = [];
    }
    return { data };
  });

  // GET /api/v1/settings/external-agents/status — 外部 Agent 开关与 CLI 可用性
  fastify.get('/api/v1/settings/external-agents/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const getExternalAgentAvailability = await resolveExternalAgentAvailability(deps);
    return { data: getExternalAgentAvailability() };
  });

  // GET /api/v1/model/capabilities — 模型能力查询
  fastify.get('/api/v1/model/capabilities', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const { supportsVisionFromProvider, getContextWindowSizeFromProvider } = await import('../llm/model_capabilities.js');
      const { getModelDevInfo } = await import('../llm/ModelsDevRegistry.js');
      const { LLM } = await import('../config/defaults.js');

      // 优先用请求参数里的 model，否则用 leader_model 配置
      const queryModel = (request.query as Record<string, string>).model;
      const currentModel = queryModel || (getConfigValue('llm.leader_model') as string) || '';

      const supportsVision = supportsVisionFromProvider(currentModel);

      // context window 大小：优先 ModelManager 用户配置 > ModelsDevRegistry > 默认值
      const providerCtx = currentModel ? getContextWindowSizeFromProvider(currentModel) : undefined;
      const devInfo = currentModel ? getModelDevInfo(currentModel) : undefined;
      const contextWindowSize = (providerCtx && providerCtx > 0)
        ? providerCtx
        : (devInfo?.contextLimit && devInfo.contextLimit > 0)
          ? devInfo.contextLimit
          : runtimeConfig.llm.context_max_tokens;

      return { data: { model: currentModel, supportsVision, ocrAvailable: true, contextWindowSize } };
    } catch { /* expected: model info may not be available before first LLM init */
      return { data: { model: '', supportsVision: false, ocrAvailable: false, contextWindowSize: runtimeConfig.llm.context_max_tokens || LLM.CONTEXT_MAX_TOKENS } };
    }
  });

  // GET /api/v1/model/registry/status — models.dev 数据库状态
  fastify.get('/api/v1/model/registry/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const { getModelsDevRegistry } = await import('../llm/ModelsDevRegistry.js');
      const reg = getModelsDevRegistry();
      const cache = reg.getCacheStatus();
      return {
        data: {
          available: reg.isAvailable(),
          modelCount: reg.size(),
          cache,
        },
      };
    } catch (err) {
      reply.status(500).send({ error: toErrorMessage(err) });
    }
  });

  // GET /api/v1/model/info?model=<modelId> — 查询模型能力信息（来自 models.dev）
  fastify.get('/api/v1/model/info', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { model: modelId } = request.query as { model?: string };
    if (!modelId?.trim()) {
      reply.status(400).send({ error: 'Missing model parameter' });
      return;
    }
    try {
      const { getModelDevInfo } = await import('../llm/ModelsDevRegistry.js');
      const info = getModelDevInfo(modelId.trim());
      if (!info) {
        return { data: { found: false } };
      }
      return {
        data: {
          found: true,
          outputLimit: info.outputLimit,
          contextLimit: info.contextLimit,
          vision: info.vision,
          reasoning: info.reasoning,
          toolCall: info.toolCall,
        },
      };
    } catch (err) {
      reply.status(500).send({ error: toErrorMessage(err) });
    }
  });

  // POST /api/v1/model/registry/refresh — 用户手动从 models.dev 拉取最新数据
  fastify.post('/api/v1/model/registry/refresh', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const { getModelsDevRegistry } = await import('../llm/ModelsDevRegistry.js');
      const result = await getModelsDevRegistry().refresh();
      return { data: result };
    } catch (err) {
      reply.status(500).send({ error: toErrorMessage(err) });
    }
  });

  // POST /api/v1/prompt/enhance — 提示词增强
  fastify.post('/api/v1/prompt/enhance', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { prompt } = request.body as { prompt?: string };
    if (!prompt?.trim()) {
      reply.status(400).send({ error: 'Missing prompt' });
      return;
    }
    const promptEnhanceMaxChars = runtimeConfig.web_api.prompt_enhance_max_chars;
    if (prompt.length > promptEnhanceMaxChars) {
      reply.status(413).send({ error: `Prompt too large (max ${promptEnhanceMaxChars} chars)` });
      return;
    }
    try {
      const { LLMClientManager } = await import('../llm/Client.js');
      const llm = new LLMClientManager();
      const modelId = llm.getModelId();
      const createGuard = await resolveLlmGuardFactory(deps);
      const guard = createGuard({
        actorLabel: 'PromptEnhance',
        maxRetries: 2,
        cbScope: 'settings_prompt_enhance',
      });
      const response = await guard.call(
        llm,
        buildPromptEnhanceMessages(prompt.trim()),
        modelId,
        undefined,
        false,
        undefined,
        undefined,
        {
          actorType: 'system',
          actorLabel: 'PromptEnhance',
          purpose: 'settings_test',
          requestedModel: modelId,
        },
      );
      const enhanced = extractPromptEnhanceText(response.content);
      if (!enhanced) {
        reply.status(500).send({ error: 'Empty response from LLM' });
        return;
      }
      return {
        data: {
          enhanced,
          inputTokens: estimateTokens(prompt.trim()),
          outputTokens: estimateTokens(enhanced),
          outputChars: enhanced.length,
        },
      };
    } catch (e: unknown) {
      request.log.error({ err: e }, 'prompt enhance failed');
      const msg = toErrorMessage(e);
      const normalizedMsg = msg.toLowerCase();
      const isConfigError = normalizedMsg.includes('api key') || normalizedMsg.includes('lingxiao init') || msg.includes('需要设置');
      reply.status(isConfigError ? 503 : 500).send({ error: msg });
    }
  });

  // POST /api/v1/prompt/enhance/stream — 提示词增强（SSE 流式）
  fastify.post('/api/v1/prompt/enhance/stream', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { prompt } = request.body as { prompt?: string };
    if (!prompt?.trim()) {
      reply.status(400).send({ error: 'Missing prompt' });
      return;
    }
    const promptEnhanceMaxChars = runtimeConfig.web_api.prompt_enhance_max_chars;
    if (prompt.length > promptEnhanceMaxChars) {
      reply.status(413).send({ error: `Prompt too large (max ${promptEnhanceMaxChars} chars)` });
      return;
    }

    const abortController = new AbortController();
    let closed = false;
    const send = (payload: Record<string, unknown>) => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const finish = () => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return;
      closed = true;
      reply.raw.end();
    };
    request.raw.on('close', () => {
      if (!closed) abortController.abort();
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const { LLMClientManager } = await import('../llm/Client.js');
      const llm = new LLMClientManager();
      const modelId = llm.getModelId();
      const createGuard = await resolveLlmGuardFactory(deps);
      const guard = createGuard({
        actorLabel: 'PromptEnhance',
        maxRetries: 2,
        cbScope: 'settings_prompt_enhance',
      });
      let enhanced = '';
      const startedAt = Date.now();
      const trimmedPrompt = prompt.trim();
      send({
        type: 'start',
        model: modelId,
        inputChars: trimmedPrompt.length,
        inputTokens: estimateTokens(trimmedPrompt),
      });
      const response = await guard.call(
        llm,
        buildPromptEnhanceMessages(trimmedPrompt),
        modelId,
        undefined,
        true,
        abortController.signal,
        {
          onFirstToken: () => send({ type: 'first_token', elapsedMs: Date.now() - startedAt }),
          onText: (chunk) => {
            enhanced += chunk;
            const outputTokens = estimateTokens(enhanced);
            send({
              type: 'delta',
              text: chunk,
              outputChars: enhanced.length,
              outputTokens,
              elapsedMs: Date.now() - startedAt,
            });
          },
          onThinking: (chunk) => send({
            type: 'thinking',
            text: chunk,
            elapsedMs: Date.now() - startedAt,
          }),
          onProgress: (progress) => send({ type: 'progress', progress }),
          onUsage: (usage) => send({ type: 'usage', usage }),
          onRetry: (attempt, error) => {
            enhanced = '';
            send({ type: 'retry', attempt, error: toErrorMessage(error) });
          },
          onStreamRetry: (attempt, error) => {
            enhanced = '';
            send({ type: 'retry', attempt, error: toErrorMessage(error) });
          },
        },
        {
          actorType: 'system',
          actorLabel: 'PromptEnhance',
          purpose: 'settings_test',
          requestedModel: modelId,
        },
      );
      const finalText = enhanced.trim() || extractPromptEnhanceText(response.content);
      if (!finalText) {
        send({ type: 'error', error: 'Empty response from LLM' });
        finish();
        return;
      }
      send({
        type: 'done',
        enhanced: finalText,
        usage: response.usage,
        outputChars: finalText.length,
        outputTokens: estimateTokens(finalText),
        elapsedMs: Date.now() - startedAt,
      });
      finish();
    } catch (e: unknown) {
      request.log.error({ err: e }, 'stream prompt enhance failed');
      send({ type: 'error', error: toErrorMessage(e) });
      finish();
    }
  });

  // POST /api/v1/prompt/suggest — 提示建议（根据最近对话生成后续操作建议）
  fastify.post('/api/v1/prompt/suggest', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    // 检查是否启用提示建议
    if (getConfigValue('ui.prompt_suggestion_enabled') === false) {
      return { data: { suggestions: [] } };
    }
    const { messages, sessionId } = request.body as { messages?: Array<{ role: string; content: string }>; sessionId?: string };
    if (!messages || messages.length === 0) {
      return { data: { suggestions: [] } };
    }
    try {
      const { LLMClientManager } = await import('../llm/Client.js');
      const llm = new LLMClientManager();
      const modelId = llm.getModelId();
      const createGuard = await resolveLlmGuardFactory(deps);
      const guard = createGuard({
        actorLabel: 'PromptSuggest',
        maxRetries: 2,
        cbScope: 'settings_prompt_suggest',
      });
      // 取最近 6 条消息作为上下文
      const recent = messages.slice(-6).map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 500) : ''}`).join('\n');
      const systemPrompt = `你是一个智能助手。根据用户最近的对话内容，生成 3 个简短的后续操作建议。
要求：
1. 每个建议不超过 30 个字
2. 建议应该是用户接下来可能想做的事情
3. 直接返回 JSON 数组格式：["建议1", "建议2", "建议3"]
4. 不要加任何解释或前缀`;
      const response = await guard.call(
        llm,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `最近对话：\n${recent}` },
        ],
        modelId,
        undefined,
        false,
        undefined,
        undefined,
        {
          actorType: 'system',
          actorLabel: 'PromptSuggest',
          purpose: 'summary',
          sessionId,
          requestedModel: modelId,
        },
      );
      const text = typeof response.content === 'string'
        ? response.content.trim()
        : Array.isArray(response.content)
          ? ((response.content as Array<{ type?: string; text?: string }>).find((c) => c.type === 'text'))?.text?.trim() || ''
          : '';
      let suggestions: string[] = [];
      try {
        // 提取 JSON 数组
        const jsonMatch = text.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          suggestions = JSON.parse(jsonMatch[0]);
        }
      } catch { /* expected: LLM response may not contain valid JSON */ }
      return { data: { suggestions: suggestions.slice(0, 3) } };
    } catch (e: unknown) {
      request.log.error({ err: e }, 'prompt suggest failed');
      return { data: { suggestions: [] } };
    }
  });

  // PUT /api/v1/settings/:group — 更新设置
  fastify.put('/api/v1/settings/:group', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { key?: string; value: unknown };
    const key = body.key;
    if (!key) {
      reply.status(400).send({ error: 'Missing key in body' });
      return;
    }
    const configPath = SETTINGS_MAP[key];
    if (!configPath) {
      reply.status(400).send({ error: `Unknown setting: ${key}` });
      return;
    }
    // 安全敏感字段不允许通过 API 修改
    const RESTRICTED_PATHS = ['git.token'];
    if (RESTRICTED_PATHS.includes(configPath)) {
      reply.status(403).send({ error: 'This setting cannot be modified via API' });
      return;
    }
    // 加固模式 env 单向锁定：LINGXIAO_HARDENED_MODE 强制开启时，拒绝经 API 关闭。
    if (
      configPath === 'security.hardened_mode' &&
      body.value !== true &&
      isHardenedModeLocked()
    ) {
      reply.status(403).send({ error: 'Hardened mode is locked by deployment environment' });
      return;
    }
    const oldValue = getConfigValue(configPath);
    try {
      if ((key === 'model' || key === 'agentModel' || key === 'localLlmGatewayModel') && typeof body.value === 'string' && body.value.trim()) {
        getModelManager().getModelByIdStrict(body.value.trim());
      }
      const nextValue = configPath === 'network.user_agent' &&
        typeof body.value === 'string' &&
        (!body.value.trim() || isLingxiaoDefaultUserAgent(body.value))
        ? DEFAULT_LINGXIAO_USER_AGENT
        : body.value;
      setConfigValue(configPath, nextValue);
      ConfigSchema.parse(runtimeConfig);
      saveSettings(runtimeConfig);
      // 立即同步派生常量（export let 变量）并触发 onConfigReload 回调，
      // 不必等 chokidar watcher 的 500ms 防抖。
      // syncDerivedConstants 将 config 对象的最新值写回 AGENT_MAX_ITERATIONS、
      // ENABLE_STREAMING、HEALTH_* 等 19 个 let 变量，让消费方立即读到新值。
      // fireConfigReload 通知 AgentPoolRuntime（slotScheduler.resize）、
      // BaseAgentRuntime（maxIterations 更新）等订阅者立即响应配置变更。
      syncDerivedConstants();
      fireConfigReload();
      if (configPath === 'llm.model_providers') {
        getModelManager().updateModelProvidersConfig(runtimeConfig.llm.model_providers);
      }
      if (configPath.startsWith('network.proxy.')) {
        const { rebuildSharedFetch } = await import('../llm/http_dispatcher.js');
        rebuildSharedFetch();
      }
      // 语言切换实时刷新服务端 i18n 态（与 model/proxy 同款运行时刷新钩子）：
      // 否则 prompt locale(getPromptLocale 读 session>current) 要等进程重启才更新。
      if (configPath === 'ui.language') {
        const { setLanguage, setSessionLanguage } = await import('../i18n.js');
        const lang = String(nextValue) === 'zh' || String(nextValue) === 'en' ? String(nextValue) : 'zh';
        setLanguage(lang as 'zh' | 'en');
        setSessionLanguage(lang as 'zh' | 'en');
      }
      if (key === 'model' && typeof body.value === 'string' && body.value.trim()) {
        sessionManager.setModelForActiveSessions(body.value.trim());
      }
      if (key === 'agentModel' && typeof body.value === 'string' && body.value.trim()) {
        sessionManager.setAgentModelForActiveSessions(body.value.trim());
      }
      // MCP 配置变更：重置运行时 MCP 客户端，让新配置（enabled / tool_timeout_ms）
      // 在下次工具调用时生效，而不需要重启进程。
      if (configPath === 'mcp.enabled' || configPath === 'mcp.tool_timeout_ms') {
        try {
          const { resetRuntimeMcpClient } = await import('../core/McpClient.js');
          await resetRuntimeMcpClient();
        } catch (e) {
          request.log.warn({ err: e }, 'MCP client reset failed after config change');
        }
      }
      const effectiveValue = configPath === 'network.user_agent'
        ? normalizeLingxiaoUserAgent(getConfigValue(configPath))
        : nextValue;
      return { success: true, key, value: effectiveValue };
    } catch (e: unknown) {
      // Rollback
      setConfigValue(configPath, oldValue);
      if (configPath === 'llm.model_providers') {
        getModelManager().updateModelProvidersConfig((oldValue || {}) as ModelProvidersConfig);
      }
      return reply.status(400).send({ error: toErrorMessage(e) });
    }
  });

  // POST /api/v1/settings/model-provider — 添加模型提供者
  fastify.post('/api/v1/settings/model-provider', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = (request.body || {}) as {
      provider?: unknown;
      name?: unknown;
      model?: unknown;
      apiKey?: unknown;
      envKey?: unknown;
      baseUrl?: unknown;
      contextWindowSize?: unknown;
      generationConfig?: unknown;
      capabilities?: unknown;
    };
    const unsupportedField = findUnsupportedField(body as Record<string, unknown>, MODEL_PROVIDER_CREATE_FIELDS);
    if (unsupportedField) {
      reply.status(400).send({ error: `Unsupported model provider field: ${unsupportedField}` });
      return;
    }

    const provider = String(body.provider ?? '').trim().toLowerCase();
    const model = String(body.model ?? '').trim();
    const displayName = String(body.name ?? '').trim();
    const id = displayName || model;
    const name = displayName || model;
    const apiKey = String(body.apiKey ?? '').trim();
    const envKey = String(body.envKey ?? '').trim();
    const baseUrl = String(body.baseUrl ?? '').trim();
    const contextWindowSize = typeof body.contextWindowSize === 'number' && body.contextWindowSize > 0
      ? body.contextWindowSize
      : undefined;
    let generationConfig: Record<string, unknown> | undefined;
    let capabilities: Record<string, unknown> | undefined;
    try {
      generationConfig = optionalPlainRecord(body as Record<string, unknown>, 'generationConfig');
      capabilities = optionalPlainRecord(body as Record<string, unknown>, 'capabilities');
    } catch (e: unknown) {
      reply.status(400).send({ error: toErrorMessage(e) });
      return;
    }

    if (provider !== 'openai' && provider !== 'anthropic') {
      reply.status(400).send({ error: 'Provider must be openai or anthropic' });
      return;
    }
    if (!model) {
      reply.status(400).send({ error: 'Model is required' });
      return;
    }
    if (!apiKey && !envKey) {
      reply.status(400).send({ error: 'API key or envKey is required' });
      return;
    }
    if (!baseUrl) {
      reply.status(400).send({ error: 'Base URL is required' });
      return;
    }
    try {
      new URL(baseUrl);
    } catch { /* expected: user provided invalid URL */
      reply.status(400).send({ error: 'Base URL must be a valid URL' });
      return;
    }

    const current = getConfigValue('llm.model_providers') as ModelProvidersConfig | undefined;
    const next: Record<string, ModelProviderConfig[]> = {};
    for (const [providerKey, models] of Object.entries(current || {})) {
      next[providerKey] = Array.isArray(models) ? models.map((m) => ({ ...m })) : [];
    }

    // 重复检测按 id（即 display name）而非 model 进行。重复保存视为更新，
    // 避免前端”保存模型”因为二次点击或修改已有模型直接 409。
    const duplicateProvider = Object.entries(next).find(([, models]) =>
      models.some((m) => m?.id === id),
    )?.[0];

    const modelConfig: Record<string, unknown> = {
      id,
      name,
      model,  // 实际 API 模型名
      provider,
      apiKey,
      baseUrl,
    };
    if (envKey) {
      modelConfig.envKey = envKey;
    }
    if (contextWindowSize !== undefined) {
      modelConfig.contextWindowSize = contextWindowSize;
    }
    if (generationConfig) {
      modelConfig.generationConfig = generationConfig;
    }
    if (capabilities) {
      modelConfig.capabilities = capabilities;
    }

    const oldValue = current;
    try {
      const oldProvider = duplicateProvider;
      if (oldProvider) {
        next[oldProvider] = (next[oldProvider] || []).filter((m) => m?.id !== id);
      }
      next[provider] = [...(next[provider] || []), modelConfig as unknown as ModelProviderConfig];
      setConfigValue('llm.model_providers', next);
      ConfigSchema.parse(runtimeConfig);
      saveSettings(runtimeConfig);
      getModelManager().updateModelProvidersConfig(runtimeConfig.llm.model_providers);
      return { success: true, data: { id, name, model, provider, baseUrl, envKey: envKey || undefined, generationConfig, capabilities, updated: Boolean(oldProvider) } };
    } catch (e: unknown) {
      setConfigValue('llm.model_providers', oldValue || {});
      getModelManager().updateModelProvidersConfig((oldValue || {}) as ModelProvidersConfig);
      reply.status(400).send({ error: toErrorMessage(e) });
    }
  });

  // PUT /api/v1/settings/model-provider/:id — 更新已有模型的配置
  fastify.put('/api/v1/settings/model-provider/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as {
      contextWindowSize?: unknown;
      apiKey?: unknown;
      envKey?: unknown;
      baseUrl?: unknown;
      model?: unknown;
      provider?: unknown;
      generationConfig?: unknown;
      capabilities?: unknown;
    };
    if (!id) {
      reply.status(400).send({ error: 'id is required' });
      return;
    }
    const unsupportedField = findUnsupportedField(body as Record<string, unknown>, MODEL_PROVIDER_UPDATE_FIELDS);
    if (unsupportedField) {
      reply.status(400).send({ error: `Unsupported model provider field: ${unsupportedField}` });
      return;
    }
    const current = getConfigValue('llm.model_providers') as ModelProvidersConfig | undefined;
    if (!current) {
      reply.status(404).send({ error: 'No model providers configured' });
      return;
    }
    // 查找模型
    let foundProvider = '';
    let foundIndex = -1;
    for (const [providerKey, models] of Object.entries(current)) {
      const idx = Array.isArray(models) ? models.findIndex((m) => m?.id === id) : -1;
      if (idx !== -1) {
        foundProvider = providerKey;
        foundIndex = idx;
        break;
      }
    }
    if (foundIndex === -1) {
      reply.status(404).send({ error: `Model '${id}' not found` });
      return;
    }
    const next: Record<string, ModelProviderConfig[]> = {};
    for (const [providerKey, models] of Object.entries(current)) {
      next[providerKey] = Array.isArray(models) ? models.map((m) => ({ ...m })) : [];
    }
    if (typeof body.contextWindowSize === 'number' && body.contextWindowSize > 0) {
      next[foundProvider][foundIndex].contextWindowSize = body.contextWindowSize;
    } else if (body.contextWindowSize === null || (typeof body.contextWindowSize === 'number' && body.contextWindowSize <= 0)) {
      delete next[foundProvider][foundIndex].contextWindowSize;
    }
    if (typeof body.apiKey === 'string') {
      const apiKey = body.apiKey.trim();
      if (apiKey) next[foundProvider][foundIndex].apiKey = apiKey;
    }
    if (typeof body.envKey === 'string') {
      const envKey = body.envKey.trim();
      if (envKey) next[foundProvider][foundIndex].envKey = envKey;
    } else if (body.envKey === null) {
      delete next[foundProvider][foundIndex].envKey;
    }
    if (typeof body.baseUrl === 'string') {
      const baseUrl = body.baseUrl.trim();
      if (baseUrl) {
        try {
          new URL(baseUrl);
        } catch { /* expected: user provided invalid URL */
          reply.status(400).send({ error: 'Base URL must be a valid URL' });
          return;
        }
        next[foundProvider][foundIndex].baseUrl = baseUrl;
      }
    }
    if (typeof body.model === 'string') {
      const model = body.model.trim();
      if (model) next[foundProvider][foundIndex].model = model;
    }
    let generationConfig: Record<string, unknown> | undefined;
    let capabilities: Record<string, unknown> | undefined;
    try {
      generationConfig = optionalPlainRecord(body as Record<string, unknown>, 'generationConfig');
      capabilities = optionalPlainRecord(body as Record<string, unknown>, 'capabilities');
    } catch (e: unknown) {
      reply.status(400).send({ error: toErrorMessage(e) });
      return;
    }

    if (body.generationConfig === null) {
      delete next[foundProvider][foundIndex].generationConfig;
    } else if (generationConfig) {
      next[foundProvider][foundIndex].generationConfig = generationConfig;
    }
    if (body.capabilities === null) {
      delete next[foundProvider][foundIndex].capabilities;
    } else if (capabilities) {
      next[foundProvider][foundIndex].capabilities = capabilities;
    }
    if (hasOwnField(body as Record<string, unknown>, 'provider')) {
      const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
      if (provider !== 'openai' && provider !== 'anthropic') {
        reply.status(400).send({ error: 'Provider must be openai or anthropic' });
        return;
      }
      // 同步更新模型对象的 provider 字段，并把记录从旧桶迁移到新桶，
      // 否则 validateModelProvidersConfig 会因 "provider 字段与配置键不匹配" 报错。
      next[foundProvider][foundIndex].provider = provider;
      if (provider !== foundProvider) {
        const [moved] = next[foundProvider].splice(foundIndex, 1);
        if (!next[provider]) next[provider] = [];
        next[provider].push(moved);
        foundProvider = provider;
        foundIndex = next[provider].length - 1;
      }
    }

    const oldValue = current;
    try {
      setConfigValue('llm.model_providers', next);
      ConfigSchema.parse(runtimeConfig);
      saveSettings(runtimeConfig);
      getModelManager().updateModelProvidersConfig(runtimeConfig.llm.model_providers);
      return { success: true, data: next[foundProvider][foundIndex] };
    } catch (e: unknown) {
      setConfigValue('llm.model_providers', oldValue || {});
      getModelManager().updateModelProvidersConfig((oldValue || {}) as ModelProvidersConfig);
      reply.status(400).send({ error: toErrorMessage(e) });
    }
  });

  // DELETE /api/v1/settings/model-provider/:id — 删除已有模型配置
  fastify.delete('/api/v1/settings/model-provider/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!id) {
      reply.status(400).send({ error: 'id is required' });
      return;
    }

    const referencedBy = [
      ['llm.leader_model', getConfigValue('llm.leader_model')],
      ['llm.agent_model', getConfigValue('llm.agent_model')],
      ['llm.wiki_model', getConfigValue('llm.wiki_model')],
      ['llm_gateway.model', getConfigValue('llm_gateway.model')],
    ]
      .filter(([, value]) => typeof value === 'string' && value === id)
      .map(([path]) => path);

    if (referencedBy.length > 0) {
      reply.status(409).send({ error: `Model '${id}' is still referenced by ${referencedBy.join(', ')}` });
      return;
    }

    const current = getConfigValue('llm.model_providers') as ModelProvidersConfig | undefined;
    if (!current) {
      reply.status(404).send({ error: 'No model providers configured' });
      return;
    }

    let found = false;
    const next: Record<string, ModelProviderConfig[]> = {};
    for (const [providerKey, models] of Object.entries(current)) {
      const list = Array.isArray(models) ? models.map((m) => ({ ...m })) : [];
      const filtered = list.filter((m) => {
        if (m?.id === id) {
          found = true;
          return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        next[providerKey] = filtered;
      }
    }

    if (!found) {
      reply.status(404).send({ error: `Model '${id}' not found` });
      return;
    }

    const oldValue = current;
    try {
      setConfigValue('llm.model_providers', next);
      ConfigSchema.parse(runtimeConfig);
      saveSettings(runtimeConfig);
      getModelManager().updateModelProvidersConfig(runtimeConfig.llm.model_providers);
      return { success: true, data: { id } };
    } catch (e: unknown) {
      setConfigValue('llm.model_providers', oldValue || {});
      getModelManager().updateModelProvidersConfig((oldValue || {}) as ModelProvidersConfig);
      reply.status(400).send({ error: toErrorMessage(e) });
    }
  });

  // GET /api/v1/intuition — 直觉系统状态
  fastify.get('/api/v1/intuition', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const q = request.query as { sessionId?: string };
    const sessionId = q.sessionId || getActiveSessionId?.();
    const settings = {
      enabled: getConfigValue('memory.intuition_enabled') !== false,
      tacitMode: getConfigValue('memory.tacit_mode_enabled') !== false,
      profile: getConfigValue('memory.intuition_profile') || 'autonomous_partner',
    };
    let snapshot: unknown = null;
    if (sessionId) {
      try {
        snapshot = repos.sessionState.get(sessionId, SESSION_KEYS.INTUITION_SNAPSHOT);
      } catch { /* expected: session may not have intuition state */
        snapshot = null;
      }
    }
    return { data: { settings, sessionId: sessionId || null, snapshot } };
  });
}
