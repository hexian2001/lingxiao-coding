/**
 * OpenAIContentGenerator — OpenAI API provider 的 ContentGenerator 实现
 *
 * 参考 qwen-code openaiContentGenerator/pipeline.ts 的 5 阶段管道设计：
 *   1. buildRequest — 构建请求参数
 *   2. createStream — 发起 HTTP 请求
 *   3. processStream — 逐 chunk 解析与转换
 *   4. handleErrors — 错误检测与分类
 *   5. yieldResult — 产出最终结果
 *
 * 将原 OpenAIProvider.chatStream 的 800+ 行逻辑拆解为清晰的管道阶段。
 */

import OpenAI from 'openai';
import { getSharedFetch } from './http_dispatcher.js';
import { llmLogger } from '../core/Log.js';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
  CountTokensParams,
  CountTokensResult,
  GenerateContentParams,
  StreamEvent,
} from './ContentGenerator.js';
import { consumeGeneratorToResponse } from './ContentGenerator.js';
import {
  contentToPlainText,
  isContentPartArray,
  isEmptyContent,
  normalizeMessageContent,
  thinkingBlocksToText,
  type ChatMessage,
  type ChatResponse,
  type ImageUrlContentPart,
  type MessageContent,
  type MessageContentPart,
  type StreamCallbacks,
  type ThinkingBlock,
  type ToolCall,
  type TokenUsage,
} from './types.js';
import { classifyLLMError, createLLMError } from './errors.js';
import { extractTokenUsage } from './usageExtractor.js';
// computePromptCacheKey 保留用于日志/统计（如 /stats 里展示 cache key 分布），
// 但不再注入到 OpenAI 请求体。
// import { computePromptCacheKey } from './promptCacheKey.js';
import {
  extractReasoningContent as extractCapabilityReasoningContent,
  getGenerationConfigFromProvider,
  getThinkingParams,
  supportsThinking,
} from './model_capabilities.js';
import { retryProviderOperation, createHeartbeatTimer } from './provider_runtime.js';
import { getInitialMaxTokens, getEscalatedMaxTokens } from './tokenLimits.js';
import { t } from '../i18n.js';
import { config as runtimeConfig } from '../config.js';
import {
  createProviderStreamRuntime,
  finalizeProviderStream,
  classifyProviderStreamError,
} from './ContentGenerationPipeline.js';
import {
  sanitizeMessageSequence,
} from './message_sanitizer.js';
import { estimateTokens } from './token_counter.js';
import { removeJsonSchemaDialect } from '../tools/Tool.js';
import { resolveGuardedTemperature } from './reasoningSampling.js';

const LLM_PHASE_DEBUG = process.env.LINGXIAO_DEBUG_LLM_PHASE === '1';
function logPhase(msg: string): void {
  if (LLM_PHASE_DEBUG) llmLogger.debug(msg);
}

// ─── Pipeline 内部类型 ──────────────────────────────────────────────────────

interface PipelineRequest {
  params: (ChatCompletionCreateParamsStreaming | ChatCompletionCreateParamsNonStreaming) & Record<string, unknown>;
  model: string;
  initialMaxTokens: number;
}

type OpenAIStreamErrorLike = Error & {
  status?: number;
  statusCode?: number;
  code?: string;
  type?: string;
  errorCode?: string;
  errorType?: string;
  error?: unknown;
};

// ─── OpenAIContentGenerator ─────────────────────────────────────────────────

export class OpenAIContentGenerator implements ContentGenerator {
  private client: OpenAI;
  private readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ContentGeneratorConfig) {
    this.modelId = config.modelId;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = runtimeConfig.llm.request_timeout_s * 1000;

    this.client = this.buildClient();
  }

  private buildClient(): OpenAI {
    const customFetch = getSharedFetch();
    return new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      // 2026-05-28：SDK 内置 retry 关掉，让 LlmGuard 成为唯一重试权威。
      // 旧设 maxRetries=1：APIConnectionError 时 SDK 会用同一 dispatcher 静默重试一次，
      // 而上层 LlmGuard 的 recycle 路径只在拿到错误后才触发，导致连续 2 次都用旧死 socket
      // 才进 recycle —— 浪费一次预算 + 拖长一次错误时间。
      // 改 0 后：SDK 立刻把第一次 Connection error 丢给 LlmGuard → 立即 recycle → 第二次起新 dispatcher。
      maxRetries: 0,
      ...(customFetch ? { fetch: customFetch } : {}),
    });
  }

  /** 销毁旧 SDK client，下次请求走新 client + 共享 dispatcher（已被 caller rebuildSharedFetch） */
  recycle(): void {
    try {
      this.client = this.buildClient();
    } catch {
      // tolerate — 下次调用前再次重建
    }
  }

  // ─── Stage 1: Build Request ─────────────────────────────────────────────

  private buildRequest(params: GenerateContentParams, stream: boolean): PipelineRequest {
    const sanitizedMessages = this.sanitizeMessages(params.messages);
    const convertedTools = this.convertTools(params.tools);
    const initialMaxTokens = params.maxTokens ?? getInitialMaxTokens(params.model);

    const requestBody: Record<string, unknown> = {
      model: params.model,
      messages: sanitizedMessages.map((m) => this.toMessageParam(m)),
      max_tokens: initialMaxTokens,
    };

    if (stream) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }

    if (convertedTools && convertedTools.length > 0) {
      requestBody.tools = convertedTools;
      requestBody.tool_choice = 'auto';
    }

    // OpenAI prompt caching 是完全自动的 prefix matching，无需客户端传 key。
    // 旧实现传 `prompt_cache_key`（OpenAI 不认该字段）+ 用 hash 回填 `user`
    // （滥用 abuse-tracking 字段，可能触发误报）。
    //
    // 第三方 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）：
    //   - DeepSeek: 自动 prefix cache，无需额外字段
    //   - Kimi/Moonshot: 支持 `cache_id` 字段（非 prompt_cache_key），当前不适配
    //   - Qwen: 自动 prefix cache
    //
    // 保留 computePromptCacheKey 用于统计/日志，但不再注入请求体。
    // 若上层需要 user 字段（审计/rate-limit 隔离），应由 config 显式提供。

    this.applyOpenAICompatibleThinkingParams(this.modelId, requestBody);
    this.applyModelGenerationConfig(this.modelId, requestBody);

    // A1 全局温度兜底：未显式指定 temperature 时锁定确定性解码温度(默认 0)，避免新调用点
    // 漏锁 sampling 静默走 provider 默认(~1.0)导致漂移。优先级(确定性，非启发式)：
    //   1. 调用方显式 sampling.temperature — 最高优先级
    //   2. 模型 generationConfig.temperature — 注册表显式配置(applyModelGenerationConfig 已写入)
    //   3. 兜底 reasoning_temperature(默认 0)
    // OpenAI 路径无 extended-thinking 强制 temp=1 的硬约束(reasoning_effort 走独立字段)，
    // 故 thinkingActive 恒 false。
    const explicitOrModelTemp = params.sampling?.temperature ?? requestBody.temperature;
    const guardedTemperature = resolveGuardedTemperature(
      typeof explicitOrModelTemp === 'number' ? explicitOrModelTemp : undefined,
      false,
    );
    if (guardedTemperature !== undefined) requestBody.temperature = guardedTemperature;
    if (params.sampling?.top_p !== undefined) requestBody.top_p = params.sampling.top_p;

    return {
      params: requestBody as PipelineRequest['params'],
      model: params.model,
      initialMaxTokens,
    };
  }

  private classifyStreamChunkError(rawError: unknown, model: string) {
    const record = rawError && typeof rawError === 'object' ? rawError as Record<string, unknown> : undefined;
    const message = typeof rawError === 'string'
      ? rawError
      : typeof record?.message === 'string'
        ? record.message
        : JSON.stringify(rawError) ?? String(rawError);
    const structuredError: OpenAIStreamErrorLike = Object.assign(new Error(message), {
      error: rawError,
    });

    const statusCode = typeof record?.statusCode === 'number'
      ? record.statusCode
      : typeof record?.status === 'number'
        ? record.status
        : undefined;
    const errorCode = typeof record?.code === 'string'
      ? record.code
      : typeof record?.errorCode === 'string'
        ? record.errorCode
        : undefined;
    const errorType = typeof record?.type === 'string'
      ? record.type
      : typeof record?.errorType === 'string'
        ? record.errorType
        : undefined;

    if (statusCode !== undefined) {
      structuredError.status = statusCode;
      structuredError.statusCode = statusCode;
    }
    if (errorCode) {
      structuredError.code = errorCode;
      structuredError.errorCode = errorCode;
    }
    if (errorType) {
      structuredError.type = errorType;
      structuredError.errorType = errorType;
    }

    return classifyLLMError(structuredError, {
      provider: 'openai',
      model,
      statusCode,
      errorCode,
      errorType,
    });
  }

  // ─── Stage 2: Non-streaming execution ──────────────────────────────────

  async generateContent(params: GenerateContentParams): Promise<ChatResponse> {
    const request = this.buildRequest(params, false);
    const callbacks: StreamCallbacks | undefined = undefined;

    // 重试收口 (2026-05-29)：generator 层只做「单次 attempt + CircuitBreaker 记账 + 分类」，
    // maxRetries=0。重试/backoff/recycle 的唯一权威是 LlmGuard。
    //   旧实现 maxRetries=LLM_MAX_RETRIES(5) 会与外层 LlmGuard(5×) 叠成双层重试（最坏 25 次、
    //   两套 backoff 曲线），这是用户报「重试逻辑乱七八糟」的根因之一。流式路径
    //   (generateContentStream) 本来就不在 generator 层重试，这里把非流式对齐成同样语义。
    //   注：保留 retryProviderOperation 外壳（maxRetries=0）是为了让不经 LlmGuard 的直接调用方
    //   （多数带 try/catch fallback）仍享有 CircuitBreaker 快速熔断；唯一无 fallback 的
    //   WikiGenerator.generateOutline 已在调用方包了 LlmGuard。
    const result = await retryProviderOperation({
      maxRetries: 0,
      logPrefix: t('llm.request_failed'),
      classify: (error) => classifyLLMError(error, { provider: 'openai', model: params.model }),
      callbacks,
      providerKey: `${this.baseUrl}::${params.model}`,
      operation: async () => {
        const heartbeat = createHeartbeatTimer({ onProgress: undefined });
        try {
          const response = await this.client.chat.completions.create(
            request.params as ChatCompletionCreateParamsNonStreaming,
            { timeout: this.timeoutMs, signal: params.signal },
          );
          heartbeat.clear();

          if (!response.choices?.length) {
            throw createLLMError('network_error', 'Empty response: no choices returned', {
              provider: 'openai', model: params.model, retryable: true,
            });
          }

          const choice = response.choices[0];
          const message = choice.message;
          const content = normalizeMessageContent(message.content);
          let reasoningContent = extractCapabilityReasoningContent(message as unknown as Record<string, unknown>) || undefined;
          const toolCalls = this.extractToolCalls(message.tool_calls);

          const contentStr = typeof content === 'string' ? content : '';
          const thinkMatch = contentStr.match(/<think>([\s\S]*?)<\/think>/s);
          let finalContent: MessageContent = content;
          if (thinkMatch && !reasoningContent) {
            reasoningContent = thinkMatch[1].trim();
            finalContent = contentStr.replace(/<think>[\s\S]*?<\/think>/gs, '').trim();
          }

          if (isEmptyContent(finalContent) && !reasoningContent && (!toolCalls || toolCalls.length === 0)) {
            throw createLLMError('network_error', 'Provider returned an empty completion', {
              provider: 'openai', model: params.model, retryable: true,
            });
          }

          const usage = this.extractUsage(response.usage);
          return {
            content: finalContent,
            thinking: this.wrapReasoningText(reasoningContent),
            tool_calls: toolCalls,
            usage,
            model: response.model,
            finish_reason: choice.finish_reason ?? undefined,
            was_output_truncated: choice.finish_reason === 'length',
          };
        } catch (error) {
          heartbeat.clear();
          throw error;
        }
      },
    });

    // MAX_TOKENS 升级
    if (result.was_output_truncated) {
      const escalated = await this.tryEscalate(request, params);
      if (escalated) return escalated;
    }

    return result;
  }

  // ─── Stage 3: Streaming execution (AsyncGenerator) ─────────────────────

  /**
   * 流式生成内容。
   *
   * 注意：流式请求不在 generator 层重试。一旦流开始消费字节，遇到的错误
   * （如连接中断）会直接向上抛出，由上层 executeLlmRound
   * 通过 onStreamRetry 回调决定是否重启整轮。这是有意的设计取舍——已经
   * yield 出去的 token 无法撤回，generator 层无法安全地自动重试。
   * 非流式的 generateContent 同样不在 generator 层重试（2026-05-29 收口到 LlmGuard）。
   */
  async *generateContentStream(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): AsyncGenerator<StreamEvent, ChatResponse, undefined> {
    const request = this.buildRequest(params, true);
    const model = params.model;

    const runtime = createProviderStreamRuntime({
      supportsThinking: supportsThinking(this.modelId),
      callbacks,
    });

    // fullContent 声明提到 try 外：catch 块需在中断时抢救已累积的纯文本 partial（供 LlmGuard 续写）。
    // try 内块作用域的 let 对 catch 不可见（曾导致 TS2304 + 运行时 ReferenceError 覆盖正确错误）。
    let fullContent = '';

    try {
      const requestStartedAt = Date.now();
      const stream = await this.client.chat.completions.create(
        request.params as ChatCompletionCreateParamsStreaming,
        {
          timeout: this.timeoutMs,
          signal: params.signal,
        },
      );
      logPhase(`openai_request_create=${Date.now() - requestStartedAt}ms`);

      // ─── Stage 4: Process stream chunks ──────────────────────────────

      let reasoningContent = '';
      let usage: TokenUsage | undefined;
      let responseModel: string | undefined;
      let finishReason: string | undefined;
      let pendingFinishChunk = false;
      let finishYielded = false;
      let firstTokenEmitted = false;

      for await (const chunk of stream) {
        runtime.tickAtChunk();
        // P1-10: abort check at top of loop — don't rely solely on SDK propagation
        if (params.signal?.aborted) break;

        const rawChunk = chunk as unknown as Record<string, unknown>;
        if (rawChunk.error) {
          throw this.classifyStreamChunkError(rawChunk.error, model);
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        // finish/usage chunk 合并
        if (pendingFinishChunk && !finishYielded) {
          if (chunk.usage) {
            usage = this.extractUsage(chunk.usage);
          }
          finishYielded = true;
          if (!delta) continue;
        }

        if (!delta) {
          if (chunk.usage) {
            usage = this.extractUsage(chunk.usage);
          }
          continue;
        }

        responseModel = chunk.model;

        // 检测 finish_reason
        const fr = choice?.finish_reason;
        if (fr) {
          finishReason = fr;
          const frStr = fr as string;
          if (frStr === 'error_finish' || frStr === 'content_filter') {
            const errorMsg = delta?.content?.trim() || `Stream ended with finish_reason: ${frStr}`;
            throw createLLMError('provider_error', errorMsg, {
              provider: 'openai', model, retryable: frStr !== 'content_filter',
            });
          }
          pendingFinishChunk = true;
        }

        // 处理文本内容
        if (delta.content) {
          if (!firstTokenEmitted) { firstTokenEmitted = true; callbacks?.onFirstToken?.(); }
          fullContent += delta.content;
          callbacks?.onText?.(delta.content);
          yield { type: 'text', text: delta.content };
        }

        // 处理 thinking / reasoning delta。不同 OpenAI-compatible provider 字段名不完全一致。
        const rawDelta = delta as Record<string, unknown>;
        const reasoningDelta = extractCapabilityReasoningContent(rawDelta);
        if (reasoningDelta) {
          if (!firstTokenEmitted) { firstTokenEmitted = true; callbacks?.onFirstToken?.(); }
          reasoningContent += reasoningDelta;
          callbacks?.onThinking?.(reasoningDelta);
          yield { type: 'thinking', text: reasoningDelta };
        }

        // 处理 usage
        if (chunk.usage) {
          usage = this.extractUsage(chunk.usage);
        }

        // 处理工具调用 — 流式期间只拼接 buffer，最终在 stage 5 一次性产出
        // 但额外向上层 emit tool_call_delta，让前端能在参数生成阶段就看到进度
        if (delta.tool_calls) {
          if (!firstTokenEmitted) { firstTokenEmitted = true; callbacks?.onFirstToken?.(); }
          for (const tc of delta.tool_calls as Array<{
            index?: number; id?: string; function?: { name?: string; arguments?: string };
          }>) {
            const index = typeof tc.index === 'number' ? tc.index : 0;
            const partialJson = tc.function?.arguments || '';
            // OpenAI 流式：id/name 仅在首个 chunk 出现，后续 chunk 只带 arguments。
            // 从 parser 维护的 index→meta 映射回填稳定 id/name，否则前端会因 callId/tool
            // 缺失而把后续 delta 误判为新工具调用，渲染出第二张 "unknown" 卡片。
            const { actualIndex } = runtime.parser.appendChunk(index, partialJson, tc.id, tc.function?.name);
            const meta = runtime.parser.getToolCallMeta(actualIndex);
            const deltaInfo = {
              index: actualIndex,
              id: tc.id || meta.id,
              name: tc.function?.name || meta.name,
              partialJson,
            };
            callbacks?.onToolCallDelta?.(deltaInfo);
            yield { type: 'tool_call_delta', delta: deltaInfo };
          }
        }
      }

      // ─── Stage 5: Finalize ───────────────────────────────────────────

      const finalized = finalizeProviderStream({
        runtime,
        provider: 'openai',
        model,
        fullContent,
        hasThinking: reasoningContent.trim().length > 0,
        truncationFinishReason: 'length',
        finishReason,
      });
      const { toolCalls } = finalized;
      // 流末统一触发 onToolCall + yield，保留旧消费者契约
      for (const toolCall of toolCalls) {
        callbacks?.onToolCall?.(toolCall);
        yield { type: 'tool_call', toolCall };
      }

      // <think> 标签提取
      const thinkMatch = fullContent.match(/<think>([\s\S]*?)<\/think>/s);
      if (thinkMatch && !reasoningContent) {
        reasoningContent = thinkMatch[1].trim();
        fullContent = fullContent.replace(/<think>[\s\S]*?<\/think>/gs, '').trim();
      }

      // 触发 usage 事件
      if (usage) {
        callbacks?.onUsage?.(usage);
        yield { type: 'usage', usage };
      }

      // 空流检测：provider 返回 200 但无任何内容，按 network_error 处理 →
      // LlmGuard recycle 旧 socket 后用新连接重发（空流多由连接抖动产生）。
      if (!fullContent.trim() && toolCalls.length === 0 && !reasoningContent.trim()) {
        throw createLLMError('network_error', 'Empty stream: no content, tool calls, or reasoning in response', {
          provider: 'openai', model, retryable: true,
        });
      }

      if (finishReason) {
        yield { type: 'finish', finishReason };
      }

      const response: ChatResponse = {
        content: fullContent,
        thinking: this.wrapReasoningText(reasoningContent),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        model: responseModel,
        finish_reason: finishReason,
        was_output_truncated: finalized.wasOutputTruncated,
      };

      return response;
    } catch (error) {
      const classified = classifyProviderStreamError(error, runtime, 'openai', model);
      // 抢救中断瞬间的纯文本 partial → LlmGuard 续写时作为 assistant prefill，避免从头重新生成。
      // fullContent 只累积 delta.content 文本（tool_call JSON 单独走 parser，不污染）；thinking 不并入。
      if (fullContent.trim()) {
        classified.partialAssistantContent = { content: fullContent };
      }
      yield { type: 'error', error: classified };
      throw classified;
    } finally {
      // P1-9: 确保 generator 被 .return() 终止（abort/取消）时 heartbeat timer 不泄漏。
      // 对齐 Anthropic generateContentStream 的 finally；finishStream/heartbeat.clear
      // 由 provider_runtime 的 cleared 标志保证幂等，重复调用安全。
      runtime.finishStream();
    }
  }

  // ─── Convenience: stream + consume → Promise<ChatResponse> ──────────

  async generateContentWithCallbacks(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): Promise<ChatResponse> {
    const result = await consumeGeneratorToResponse(this.generateContentStream(params, callbacks));

    // 流式路径的 escalation：如果输出被截断且有 tool_calls（参数可能不完整），
    // 用非流式 escalated max_tokens 重试。纯文本截断不 escalate（可继续对话）。
    if (result.was_output_truncated && result.tool_calls?.length) {
      const request = this.buildRequest(params, false);
      const escalated = await this.tryEscalate(request, params);
      if (escalated) return escalated;
    }

    return result;
  }

  // ─── Token counting ────────────────────────────────────────────────────

  async countTokens(params: CountTokensParams): Promise<CountTokensResult> {
    // 使用本地估算（tiktoken 或字符估算），避免额外 API 调用
    const perMessage: number[] = [];
    let total = 0;

    for (const msg of params.messages) {
      const text = contentToPlainText(msg.content);
      const tokens = estimateTokens(text);
      perMessage.push(tokens);
      total += tokens;
    }

    // 工具定义也占 token
    if (params.tools) {
      const toolsText = JSON.stringify(params.tools);
      total += estimateTokens(toolsText);
    }

    return { totalTokens: total, perMessage };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // OpenAI client 无需显式关闭
  }

  /** Provider key 用于 CircuitBreaker 跨流式/非流式路径共享熔断状态 */
  getProviderKey(model: string): string {
    return `${this.baseUrl}::${model}`;
  }

  async warmup(): Promise<void> {
    try {
      const origin = new URL(this.baseUrl).origin;
      const customFetch = getSharedFetch() ?? fetch;
      await (customFetch as typeof fetch)(origin, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // 预热失败非致命
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private async tryEscalate(
    request: PipelineRequest,
    params: GenerateContentParams,
  ): Promise<ChatResponse | null> {
    const escalatedMaxTokens = getEscalatedMaxTokens(request.model);
    if (escalatedMaxTokens <= request.initialMaxTokens) return null;

    const escalatedParams = { ...request.params, max_tokens: escalatedMaxTokens, stream: false };
    this.applyOpenAICompatibleThinkingParams(this.modelId, escalatedParams);
    this.applyModelGenerationConfig(this.modelId, escalatedParams);

    try {
      const response = await this.client.chat.completions.create(
        escalatedParams as ChatCompletionCreateParamsNonStreaming,
        { timeout: this.timeoutMs, signal: params.signal },
      );

      const choice = response.choices[0];
      const message = choice.message;
      const content = normalizeMessageContent(message.content);
      const reasoningContent = extractCapabilityReasoningContent(message as unknown as Record<string, unknown>) || undefined;
      const toolCalls = this.extractToolCalls(message.tool_calls);
      const usage = this.extractUsage(response.usage);

      return {
        content,
        thinking: this.wrapReasoningText(reasoningContent),
        tool_calls: toolCalls,
        usage,
        model: response.model,
        finish_reason: choice.finish_reason ?? undefined,
        was_output_truncated: choice.finish_reason === 'length',
      };
    } catch {/* expected: operation may fail gracefully */
      return null; // 升级失败，返回 null 让调用者用原始结果
    }
  }

  private extractToolCalls(
    rawToolCalls?: Array<{ id: string; type: string; function?: { name: string; arguments: string } }>,
  ): ToolCall[] | undefined {
    if (!rawToolCalls || rawToolCalls.length === 0) return undefined;
    return rawToolCalls
      .filter((tc) => tc.type === 'function' && tc.function)
      .map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function!.name || '', arguments: tc.function!.arguments || '' },
      }));
  }

  private extractUsage(rawUsage: unknown): TokenUsage | undefined {
    return extractTokenUsage(rawUsage);
  }

  private sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    // 统一净化管线：合并连续 user/assistant、合并中间 system、清理孤儿 tool result、
    // 填充空内容、修复 tool_call/tool_result 配对。
    // 防止 GLM/Qwen 等 OpenAI-compatible API 因消息格式问题返回 400。
    return sanitizeMessageSequence(messages);
  }

  private convertTools(tools?: import('./types.js').ToolDefinition[]): ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: this.normalizeOpenAIToolParameters(tool.function.parameters),
      },
    }));
  }

  private normalizeOpenAIToolParameters(schema: unknown): Record<string, unknown> {
    const cleaned = removeJsonSchemaDialect(schema) as Record<string, unknown>;
    const out = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : {};
    if (out.type !== 'object') out.type = 'object';
    if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) out.properties = {};
    return out;
  }

  private toOpenAIContentParts(parts: MessageContentPart[]): Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: ImageUrlContentPart['image_url'] }
  > {
    return parts.map((part) => {
      if (part.type === 'text') return { type: 'text' as const, text: part.text };
      if (part.type === 'image_url') return { type: 'image_url' as const, image_url: part.image_url };
      if (part.type === 'mcp_app') return { type: 'text' as const, text: part.title ? `[mcp-app: ${part.title}]` : '[mcp-app]' };
      const blobId = part.blob_id ?? 'unknown';
      return { type: 'text' as const, text: `[image stored as blob:${blobId.slice(0, 12)}]` };
    });
  }

  private toMessageParam(message: ChatMessage): ChatCompletionMessageParam {
    const isAssistantWithToolCalls = message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0;

    // assistant+tool_calls 消息：content 为 null/空时，用 null 而非空字符串。
    // OpenAI 和大多数 Provider 接受 null；某些 Provider（DashScope/Qwen 等）
    // 对 assistant+tool_calls 消息要求 content 必须为 null。
    let content: unknown;
    if (isAssistantWithToolCalls && isEmptyContent(message.content)) {
      content = null;
    } else if (isContentPartArray(message.content)) {
      content = this.toOpenAIContentParts(message.content);
    } else {
      content = contentToPlainText(message.content);
    }

    const param = {
      role: message.role,
      content,
    } as ChatCompletionMessageParam & {
      name?: string; tool_calls?: ToolCall[]; tool_call_id?: string; reasoning_content?: string;
    };

    if (message.name) param.name = message.name;
    if (message.tool_calls) param.tool_calls = message.tool_calls;
    if (message.tool_call_id) param.tool_call_id = message.tool_call_id;
    if (message.role === 'assistant' && message.thinking && message.thinking.length > 0) {
      const reasoningText = thinkingBlocksToText(message.thinking);
      if (reasoningText) param.reasoning_content = reasoningText;
    }

    return param;
  }

  private applyOpenAICompatibleThinkingParams(model: string, requestBody: Record<string, unknown>): void {
    const params = getThinkingParams(model);
    if (!params) return;
    if ('reasoning_effort' in params) {
      requestBody.reasoning_effort = params.reasoning_effort;
    }
    if (params.extra_body && typeof params.extra_body === 'object') {
      const currentExtraBody =
        typeof requestBody.extra_body === 'object' && requestBody.extra_body !== null
          ? requestBody.extra_body as Record<string, unknown>
          : {};
      requestBody.extra_body = { ...currentExtraBody, ...(params.extra_body as Record<string, unknown>) };
    }
  }

  private applyModelGenerationConfig(model: string, requestBody: Record<string, unknown>): void {
    const generationConfig = getGenerationConfigFromProvider(model) as Record<string, unknown> | undefined;
    if (!generationConfig || typeof generationConfig !== 'object') return;

    for (const field of ['temperature', 'top_p', 'max_tokens'] as const) {
      if (generationConfig[field] !== undefined) requestBody[field] = generationConfig[field];
    }

    if (generationConfig.extra_body && typeof generationConfig.extra_body === 'object') {
      const currentExtraBody =
        typeof requestBody.extra_body === 'object' && requestBody.extra_body !== null
          ? requestBody.extra_body as Record<string, unknown>
          : {};
      requestBody.extra_body = { ...currentExtraBody, ...(generationConfig.extra_body as Record<string, unknown>) };
    }
  }

  private wrapReasoningText(text: string | undefined | null): ThinkingBlock[] | undefined {
    if (!text) return undefined;
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return [{ type: 'thinking', text }];
  }
}
