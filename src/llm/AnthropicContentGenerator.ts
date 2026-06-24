/**
 * AnthropicContentGenerator — Anthropic Claude 的 ContentGenerator 实现
 *
 * 与 OpenAIContentGenerator 对称，实现相同的 ContentGenerator 接口。
 * 内部处理 Anthropic 特有的：
 *   - thinking blocks (含 signature 多轮回传)
 *   - redacted_thinking
 *   - tool_use / tool_result 格式转换
 *   - cache_control 断点策略
 *   - 连续 assistant 消息合并
 *   - 孤立 tool_result 清理
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSharedFetch } from './http_dispatcher.js';
import type {
  MessageParam,
  Tool as AnthropicTool,
  ContentBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
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
  type ChatMessage,
  type ChatResponse,
  type ImageUrlContentPart,
  type MessageContentPart,
  type StreamCallbacks,
  type ThinkingBlock,
  type ToolCall,
  type TokenUsage,
} from './types.js';
import { classifyLLMError, createLLMError } from './errors.js';
import { extractTokenUsage } from './usageExtractor.js';
import { applyThinkingParams, supportsThinking, getThinkingParams } from './model_capabilities.js';
import { getInitialMaxTokens, getEscalatedMaxTokens, getModelOutputLimit } from './tokenLimits.js';
import { createHeartbeatTimer } from './provider_runtime.js';
import {
  createProviderStreamRuntime,
  finalizeProviderStream,
  classifyProviderStreamError,
} from './ContentGenerationPipeline.js';
import { sanitizeMessageSequence } from './message_sanitizer.js';
import { t } from '../i18n.js';
import { config as runtimeConfig, getConfigValue } from '../config.js';
import { estimateTokens } from './token_counter.js';
import { retryProviderOperation } from './provider_runtime.js';
import { normalizeAnthropicToolInputSchema } from './AnthropicToolSchema.js';
import { resolveGuardedTemperature } from './reasoningSampling.js';

const CACHE_CONTROL_EPHEMERAL = { type: 'ephemeral' as const };

type AnthropicTextBlockDto = {
  type: 'text';
  text: string;
};

type AnthropicThinkingBlockDto = {
  type: 'thinking';
  thinking?: string;
  signature?: string;
};

type AnthropicRedactedThinkingBlockDto = {
  type: 'redacted_thinking';
  data?: string;
};

type AnthropicToolUseBlockDto = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

type AnthropicResponseBlockDto =
  | AnthropicTextBlockDto
  | AnthropicThinkingBlockDto
  | AnthropicRedactedThinkingBlockDto
  | AnthropicToolUseBlockDto;

interface AnthropicNonStreamResponseDto {
  content: AnthropicResponseBlockDto[];
  usage?: unknown;
  model?: string;
  stopReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeAnthropicResponseBlock(value: unknown): AnthropicResponseBlockDto | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'text': {
      const text = optionalString(value.text);
      return text === undefined ? null : { type: 'text', text };
    }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: optionalString(value.thinking),
        signature: optionalString(value.signature),
      };
    case 'redacted_thinking':
      return {
        type: 'redacted_thinking',
        data: optionalString(value.data),
      };
    case 'tool_use': {
      const id = optionalString(value.id);
      const name = optionalString(value.name);
      if (!id || !name) return null;
      return {
        type: 'tool_use',
        id,
        name,
        input: value.input,
      };
    }
    default:
      return null;
  }
}

function normalizeAnthropicNonStreamResponse(response: unknown): AnthropicNonStreamResponseDto {
  if (!isRecord(response)) {
    return { content: [] };
  }
  const rawContent = Array.isArray(response.content) ? response.content : [];
  return {
    content: rawContent.flatMap((block) => {
      const normalized = normalizeAnthropicResponseBlock(block);
      return normalized ? [normalized] : [];
    }),
    usage: response.usage,
    model: optionalString(response.model),
    stopReason: optionalString(response.stop_reason),
  };
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function parseToolUseInput(argumentsJson: string | undefined, toolCallId: string): unknown {
  const raw = argumentsJson || '{}';
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createLLMError(
      'parse_error',
      `Anthropic tool_call arguments parse failed for ${toolCallId}: ${message}`,
      { provider: 'anthropic', retryable: false },
    );
  }
}

// ─── AnthropicContentGenerator ──────────────────────────────────────────────

export class AnthropicContentGenerator implements ContentGenerator {
  private client: Anthropic;
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

  private buildClient(): Anthropic {
    const customFetch = getSharedFetch();
    return new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      // 2026-05-28：与 OpenAIContentGenerator 对齐，关闭 SDK 内置 retry。
      // Anthropic SDK 默认 maxRetries=2，同样会用旧 dispatcher 静默重试，
      // 拖延 LlmGuard 的 recycle 时机。把唯一重试权威收归 LlmGuard。
      maxRetries: 0,
      ...(customFetch ? { fetch: customFetch } : {}),
    });
  }

  /** 销毁旧 SDK client，下次请求走新 client + 共享 dispatcher（caller 已 rebuildSharedFetch） */
  recycle(): void {
    try {
      this.client = this.buildClient();
    } catch {
      // tolerate
    }
  }

  // ─── Stage 1: Build Request ─────────────────────────────────────────────

  private buildRequest(params: GenerateContentParams, stream: boolean) {
    // cache_control 断点策略在 convertMessages 内部、基于真实 Anthropic block 打点
    // （system / tools / 用户消息边界）。旧的 applyCacheBreakpoints 在 ChatMessage 级打点，
    // 其输出会被 convertMessages 丢弃（后者从不读取 msg.cache_control），属死代码，已删除。
    const { system, messages: anthropicMessages } = this.convertMessages(params.messages);
    const convertedTools = this.convertTools(params.tools);
    const maxTokens = params.maxTokens ?? this.getMaxOutputTokens(params.model);

    const requestBody: Record<string, unknown> = {
      model: params.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
    };

    if (stream) {
      requestBody.stream = true;
    }

    if (system) {
      requestBody.system = system;
    }

    if (convertedTools && convertedTools.length > 0) {
      requestBody.tools = convertedTools;
    }

    applyThinkingParams(this.modelId, requestBody);
    this.clampThinkingBudget(requestBody);

    // 防漂移：推理/编排/判定调用默认采样温度 0(确定性解码)。
    // 注意：Anthropic extended thinking 开启时 API 强制要求 temperature=1，此时
    // 不得发送 temperature 字段(保留 provider 默认)，否则返回 400。
    // thinkingActive 三条件：模型支持 thinking + 配置开启 + 本次实际会发 thinking 参数。
    // getConfigValue 返回 unknown，用 Boolean() 收窄为 boolean 供下游守卫签名使用(确定性，非启发式)。
    const thinkingActive = Boolean(
      supportsThinking(this.modelId)
        && getConfigValue('llm.enable_extended_thinking')
        && getThinkingParams(this.modelId) != null,
    );
    // A1 全局兜底：未显式指定 temperature 时也锁定确定性解码温度(0)，避免新调用点
    // 漏锁 sampling 静默走 provider 默认(~1.0)导致漂移。thinkingActive 时仍不下发。
    const guardedTemperature = resolveGuardedTemperature(params.sampling?.temperature, thinkingActive);
    if (guardedTemperature !== undefined) {
      requestBody.temperature = guardedTemperature;
    }

    return { requestBody, maxTokens };
  }

  // ─── Stage 2: Non-streaming execution ──────────────────────────────────

  async generateContent(params: GenerateContentParams): Promise<ChatResponse> {
    const { requestBody, maxTokens } = this.buildRequest(params, false);

    // 重试收口 (2026-05-29)：与 OpenAIContentGenerator 对齐，generator 层只做单次 attempt
    // (maxRetries=0) + CircuitBreaker 记账；重试/backoff/recycle 唯一权威是 LlmGuard。
    // 详见 OpenAIContentGenerator.generateContent 注释。
    const result = await retryProviderOperation({
      maxRetries: 0,
      logPrefix: t('llm.anthropic.request_failed'),
      classify: (error) => classifyLLMError(error, { provider: 'anthropic', model: params.model }),
      callbacks: undefined,
      providerKey: `${this.baseUrl}::${params.model}`,
      operation: async () => {
        const heartbeat = createHeartbeatTimer({ onProgress: undefined });
        try {
          const response = await this.client.messages.create(
            requestBody as unknown as Parameters<typeof this.client.messages.create>[0],
            { timeout: this.timeoutMs, signal: params.signal },
          );
          heartbeat.clear();
          return this.parseNonStreamResponse(response, params.model);
        } catch (error) {
          heartbeat.clear();
          throw error;
        }
      },
    });

    // MAX_TOKENS 升级
    if (result.was_output_truncated) {
      const escalated = await this.tryEscalate(requestBody, maxTokens, params);
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
    const { requestBody } = this.buildRequest(params, true);
    const model = params.model;

    const runtime = createProviderStreamRuntime({
      supportsThinking: supportsThinking(this.modelId),
      callbacks,
    });

    // fullContent 声明提到 try 外：catch 块需在中断时抢救已累积的纯文本 partial（供 LlmGuard 续写）。
    // try 内块作用域的 let 对 catch 不可见（曾导致 TS2304 + 运行时 ReferenceError 覆盖正确错误）。
    let fullContent = '';

    try {
      const stream = await this.client.messages.create(
        requestBody as unknown as Parameters<typeof this.client.messages.create>[0],
        {
          timeout: this.timeoutMs,
          signal: params.signal,
        },
      );

      // ─── Stage 4: Process stream events ────────────────────────────

      const thinkingBlocks: ThinkingBlock[] = [];
      let usage: TokenUsage | undefined;
      let responseModel: string | undefined;
      let finishReason: string | undefined;
      let currentToolIndex = 0;
      let currentToolId: string | undefined;
      let currentToolName: string | undefined;
      let currentThinking: { text: string; signature?: string } | null = null;
      let currentRedacted: { data: string } | null = null;
      let firstTokenEmitted = false;

      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        runtime.tickAtChunk();
        // P1-10 对齐: abort check at top of loop
        if (params.signal?.aborted) break;

        const eventType = event.type as string;

        // P1-14: Anthropic SSE error event（如 overloaded_error mid-stream）
        if (eventType === 'error') {
          const errPayload = event.error;
          if (errPayload && typeof errPayload === 'object') {
            const record = errPayload as Record<string, unknown>;
            const message = typeof record.message === 'string' ? record.message : 'stream error event';
            const structuredError = Object.assign(new Error(message), record);
            throw classifyLLMError(structuredError, {
              provider: 'anthropic',
              model,
              retryAfterMs: typeof record.retryAfterMs === 'number' ? record.retryAfterMs : undefined,
            });
          }
          throw classifyLLMError(new Error(String(errPayload ?? 'stream error event')), { provider: 'anthropic', model });
        }

        if (eventType === 'message_start') {
          const msg = event.message as Record<string, unknown>;
          responseModel = msg.model as string;
          if (msg.usage) {
            usage = this.extractAnthropicUsage(msg.usage, undefined);
          }
        } else if (eventType === 'content_block_start') {
          const block = event.content_block as Record<string, unknown>;
          const blockType = block.type as string;

          if (blockType === 'tool_use') {
            currentToolIndex = typeof event.index === 'number' ? event.index : currentToolIndex;
            currentToolId = block.id as string;
            currentToolName = block.name as string;
            runtime.parser.appendChunk(currentToolIndex, '', currentToolId, currentToolName);
            // tool_use start：先发一次空 delta，让前端立刻渲染"参数生成中"卡片
            const startDelta = {
              index: currentToolIndex,
              id: currentToolId,
              name: currentToolName,
              partialJson: '',
            };
            callbacks?.onToolCallDelta?.(startDelta);
            yield { type: 'tool_call_delta', delta: startDelta };
          } else if (blockType === 'thinking') {
            currentThinking = {
              text: (block.thinking as string) || '',
              signature: block.signature as string | undefined,
            };
            if (currentThinking.text) {
              callbacks?.onThinking?.(currentThinking.text);
              yield { type: 'thinking', text: currentThinking.text };
            }
          } else if (blockType === 'redacted_thinking') {
            currentRedacted = { data: (block.data as string) || '' };
          }
        } else if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          const deltaType = delta.type as string;

          if (deltaType === 'text_delta') {
            const text = (delta.text as string) || '';
            if (!firstTokenEmitted) { firstTokenEmitted = true; callbacks?.onFirstToken?.(); }
            fullContent += text;
            callbacks?.onText?.(text);
            yield { type: 'text', text };
          } else if (deltaType === 'input_json_delta') {
            if (currentToolId || currentToolName) {
              if (!firstTokenEmitted) { firstTokenEmitted = true; callbacks?.onFirstToken?.(); }
              const partialJson = (delta.partial_json as string) || '';
              runtime.parser.appendChunk(currentToolIndex, partialJson, currentToolId, currentToolName);
              const argsDelta = {
                index: currentToolIndex,
                id: currentToolId,
                name: currentToolName,
                partialJson,
              };
              callbacks?.onToolCallDelta?.(argsDelta);
              yield { type: 'tool_call_delta', delta: argsDelta };
            }
          } else if (deltaType === 'thinking_delta') {
            if (!currentThinking) currentThinking = { text: '' };
            const text = (delta.thinking as string) || '';
            if (!firstTokenEmitted) { firstTokenEmitted = true; callbacks?.onFirstToken?.(); }
            currentThinking.text += text;
            callbacks?.onThinking?.(text);
            yield { type: 'thinking', text };
          } else if (deltaType === 'signature_delta') {
            if (!currentThinking) currentThinking = { text: '' };
            currentThinking.signature = (currentThinking.signature || '') + ((delta.signature as string) || '');
          } else if (deltaType === 'redacted_thinking_delta') {
            if (!currentRedacted) currentRedacted = { data: '' };
            currentRedacted.data += (delta.data as string) || '';
          }
        } else if (eventType === 'content_block_stop') {
          if (currentThinking) {
            thinkingBlocks.push({
              type: 'thinking',
              text: currentThinking.text,
              signature: currentThinking.signature,
            });
            currentThinking = null;
          } else if (currentRedacted) {
            thinkingBlocks.push({
              type: 'redacted_thinking',
              data: currentRedacted.data,
            });
            currentRedacted = null;
          } else if (currentToolId || currentToolName) {
            currentToolIndex++;
            currentToolId = undefined;
            currentToolName = undefined;
          }
        } else if (eventType === 'message_delta') {
          const msgDelta = event.delta as Record<string, unknown>;
          if (msgDelta.stop_reason) {
            finishReason = msgDelta.stop_reason as string;
          }
          if (msgDelta.usage || event.usage) {
            const deltaUsage = (msgDelta.usage || event.usage) as Record<string, unknown>;
            usage = this.extractAnthropicUsage(usage, deltaUsage);
          }
        }
      }

      // ─── Stage 5: Finalize ───────────────────────────────────────────

      const finalized = finalizeProviderStream({
        runtime,
        provider: 'anthropic',
        model,
        fullContent,
        hasThinking: thinkingBlocks.length > 0,
        truncationFinishReason: 'max_tokens',
        finishReason,
      });
      const { toolCalls } = finalized;

      // 触发 tool call 事件
      for (const tc of toolCalls) {
        callbacks?.onToolCall?.(tc);
        yield { type: 'tool_call', toolCall: tc };
      }

      // <think> 标签回退提取
      const thinkMatch = fullContent.match(/<think>([\s\S]*?)<\/think>/s);
      if (thinkMatch && thinkingBlocks.length === 0) {
        thinkingBlocks.push({ type: 'thinking', text: thinkMatch[1].trim() });
        fullContent = fullContent.replace(/<think>[\s\S]*?<\/think>/gs, '').trim();
      }

      // 触发 usage 事件
      if (usage) {
        callbacks?.onUsage?.(usage);
        yield { type: 'usage', usage };
      }

      // 空流检测：provider 返回 200 但无任何内容，按 network_error 处理 →
      // LlmGuard recycle 旧 socket 后用新连接重发（空流多由连接抖动产生）。
      if (!fullContent.trim() && toolCalls.length === 0 && thinkingBlocks.length === 0) {
        throw createLLMError('network_error', 'Empty stream: no content, tool calls, or thinking in response', {
          provider: 'anthropic', model, retryable: true,
        });
      }

      if (finishReason) {
        yield { type: 'finish', finishReason };
      }

      const response: ChatResponse = {
        content: fullContent,
        thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        model: responseModel,
        finish_reason: finishReason,
        was_output_truncated: finalized.wasOutputTruncated,
      };

      return response;
    } catch (error) {
      const classified = classifyProviderStreamError(error, runtime, 'anthropic', model);
      // 抢救中断瞬间的纯文本 partial → LlmGuard 续写时作为 assistant prefill，避免从头重新生成。
      // fullContent 只累积 text delta（tool_call partial_json 单独走 parser，不污染）；thinking 不并入。
      if (fullContent.trim()) {
        classified.partialAssistantContent = { content: fullContent };
      }
      yield { type: 'error', error: classified };
      throw classified;
    } finally {
      // P1-9: 确保 generator 被 .return() 终止（abort/取消）时 heartbeat timer 不泄漏
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
      const { requestBody, maxTokens } = this.buildRequest(params, false);
      const escalated = await this.tryEscalate(requestBody, maxTokens, params);
      if (escalated) return escalated;
    }

    return result;
  }

  // ─── Token counting ────────────────────────────────────────────────────

  async countTokens(params: CountTokensParams): Promise<CountTokensResult> {
    const perMessage: number[] = [];
    let total = 0;

    for (const msg of params.messages) {
      const text = contentToPlainText(msg.content);
      const tokens = estimateTokens(text);
      perMessage.push(tokens);
      total += tokens;
    }

    if (params.tools) {
      const toolsText = JSON.stringify(params.tools);
      total += estimateTokens(toolsText);
    }

    return { totalTokens: total, perMessage };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // Anthropic client 无需显式关闭
  }

  /** Provider key 用于 CircuitBreaker 跨流式/非流式路径共享熔断状态 */
  getProviderKey(model: string): string {
    return `${this.baseUrl}::${model}`;
  }

  async warmup(): Promise<void> {
    try {
      const url = new URL(this.baseUrl);
      const customFetch = getSharedFetch() ?? fetch;
      await (customFetch as typeof fetch)(url.origin, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    } catch {
      // 预热失败非致命
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private clampThinkingBudget(requestBody: Record<string, unknown>): void {
    const thinking = requestBody.thinking as Record<string, unknown> | undefined;
    if (!thinking || thinking.type !== 'enabled') return;

    // 2026-06-23 修复「思考预算被压扁」：旧实现只用本次请求的 max_tokens（默认上限仅
    // 16384，见 CAPPED_MAX_TOKENS）来夹预算，导致高强度档位（xhigh=48000 / max=64000）
    // 即便正确生成也会被 clamp 回 ~12k，等于变相关闭深度思考。
    // 现在以「模型真实输出上限」作为 budget 的硬天花板，再以「本次请求 max_tokens」
    // 保证可见输出有预留空间，两者取较宽松但仍安全的上界。
    const requestMaxTokens = typeof requestBody.max_tokens === 'number'
      ? requestBody.max_tokens
      : 0;
    const modelOutputLimit = getModelOutputLimit(String(requestBody.model || ''));
    const currentBudget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0;

    // budget 不得超模型输出上限；同时给可见输出预留 max(1024, 25% 请求 max_tokens)。
    // 当请求 max_tokens 较小（如 16384）时，仍允许 budget 上探到模型输出上限附近，
    // 由 provider 侧自行约束（Anthropic 要求 budget_tokens < max_tokens，下面统一收敛）。
    const reserveFromRequest = Math.max(1_024, Math.floor(requestMaxTokens * 0.25));
    const maxBudgetFromRequest = requestMaxTokens > 0
      ? Math.max(1_024, requestMaxTokens - reserveFromRequest)
      : modelOutputLimit;
    // Anthropic API 硬约束：budget_tokens 必须 < max_tokens。最终 budget 取
    // min(用户/effort 预算, 请求级上限, 模型输出上限 - 1)，并兜底 ≥1024。
    const maxBudget = Math.max(1_024, Math.min(maxBudgetFromRequest, modelOutputLimit - 1));
    if (!currentBudget || currentBudget > maxBudget) {
      requestBody.thinking = { ...thinking, budget_tokens: maxBudget };
    }
  }

  private getMaxOutputTokens(model: string, escalated = false): number {
    return escalated ? getEscalatedMaxTokens(model) : getInitialMaxTokens(model);
  }

  private async tryEscalate(
    requestBody: Record<string, unknown>,
    originalMaxTokens: number,
    params: GenerateContentParams,
  ): Promise<ChatResponse | null> {
    const escalatedMaxTokens = this.getMaxOutputTokens(params.model, true);
    if (escalatedMaxTokens <= originalMaxTokens) return null;

    const escalatedBody = { ...requestBody, max_tokens: escalatedMaxTokens };
    applyThinkingParams(this.modelId, escalatedBody);
    this.clampThinkingBudget(escalatedBody);

    try {
      // Don't attempt escalation during abort
      if (params.signal?.aborted) return null;
      const response = await this.client.messages.create(
        escalatedBody as unknown as Parameters<typeof this.client.messages.create>[0],
        { timeout: this.timeoutMs, signal: params.signal },
      );
      return this.parseNonStreamResponse(response, params.model);
    } catch (err: unknown) {
      // AbortError must propagate — user cancelled, don't silently swallow
      if (params.signal?.aborted || isAbortError(err)) throw err;
      return null;
    }
  }

  private parseNonStreamResponse(response: unknown, model: string): ChatResponse {
    const normalized = normalizeAnthropicNonStreamResponse(response);
    let content = '';
    const thinkingBlocks: ThinkingBlock[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of normalized.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        thinkingBlocks.push({
          type: 'thinking',
          text: block.thinking || '',
          signature: block.signature,
        });
      } else if (block.type === 'redacted_thinking') {
        thinkingBlocks.push({
          type: 'redacted_thinking',
          data: block.data || '',
        });
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    // <think> 标签回退
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/s);
    if (thinkMatch && thinkingBlocks.length === 0) {
      thinkingBlocks.push({ type: 'thinking', text: thinkMatch[1].trim() });
      content = content.replace(/<think>[\s\S]*?<\/think>/gs, '').trim();
    }

    if (!content.trim() && toolCalls.length === 0 && thinkingBlocks.length === 0) {
      throw createLLMError('network_error', 'Provider returned an empty completion', {
        provider: 'anthropic', model, retryable: true,
      });
    }

    const usage = this.extractAnthropicUsage(normalized.usage, undefined);

    return {
      content,
      thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: normalized.model,
      finish_reason: normalized.stopReason,
      was_output_truncated: normalized.stopReason === 'max_tokens',
    };
  }

  private extractAnthropicUsage(
    existing: unknown,
    delta: Record<string, unknown> | undefined,
  ): TokenUsage | undefined {
    return extractTokenUsage(existing, delta);
  }

  // ─── Message conversion ────────────────────────────────────────────────

  private parseDataUrl(url: string): { mediaType: string; data: string } | null {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mediaType: match[1], data: match[2] };
  }

  private toAnthropicContent(content: string | MessageContentPart[]): ContentBlockParam[] {
    if (!Array.isArray(content)) {
      return [{ type: 'text', text: content }];
    }

    return content.flatMap((part): ContentBlockParam[] => {
      if (part.type === 'text') {
        return [{ type: 'text', text: part.text }];
      }
      if (part.type === 'image_blob_ref') {
        return [{ type: 'text', text: `[image stored as blob:${part.blob_id.slice(0, 12)}]` }];
      }
      if (part.type === 'mcp_app') {
        return [{ type: 'text', text: part.title ? `[mcp-app: ${part.title}]` : '[mcp-app]' }];
      }
      const parsed = this.parseDataUrl(part.image_url.url);
      if (!parsed) {
        return [{ type: 'text', text: `[image] ${part.image_url.url}` }];
      }
      return [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType as ImageUrlContentPart['image_url']['url'] & string,
          data: parsed.data,
        },
      } as ContentBlockParam];
    });
  }

  private convertMessages(messages: ChatMessage[]): {
    system?: TextBlockParam[];
    messages: MessageParam[];
  } {
    // 统一净化管线：合并连续 user/assistant、合并中间 system、清理孤儿 tool result、
    // 填充空内容、修复 tool_call/tool_result 配对。
    const sanitized = sanitizeMessageSequence(messages);

    const systemBlocks: TextBlockParam[] = [];
    const anthropicMessages: MessageParam[] = [];

    for (const msg of sanitized) {
      if (msg.role === 'system') {
        const text = contentToPlainText(msg.content);
        if (text) systemBlocks.push({ type: 'text', text });
        continue;
      }

      if (msg.role === 'tool') {
        const toolResultBlock = {
          type: 'tool_result' as const,
          tool_use_id: msg.tool_call_id || '',
          content: contentToPlainText(msg.content),
        };
        const previous = anthropicMessages[anthropicMessages.length - 1];
        const previousBlocks = previous && previous.role === 'user' && Array.isArray(previous.content)
          ? previous.content as unknown as Array<Record<string, unknown>>
          : undefined;
        if (previousBlocks?.length && previousBlocks.every((block) => block.type === 'tool_result')) {
          previousBlocks.push(toolResultBlock);
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      } else if (msg.role === 'assistant') {
        const content: ContentBlockParam[] = [];

        // thinking blocks 必须在 text/tool_use 之前
        if (msg.thinking && msg.thinking.length > 0) {
          for (const block of msg.thinking) {
            if (block.type === 'thinking') {
              if (block.signature) {
                content.push({
                  type: 'thinking',
                  thinking: block.text,
                  signature: block.signature,
                } as ContentBlockParam);
              }
            } else {
              if (block.data) {
                content.push({
                  type: 'redacted_thinking',
                  data: block.data,
                } as ContentBlockParam);
              }
            }
          }
        }

        if (msg.content) {
          content.push(...this.toAnthropicContent(
            isContentPartArray(msg.content) ? msg.content : contentToPlainText(msg.content),
          ));
        }

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parseToolUseInput(tc.function.arguments, tc.id),
            });
          }
        }

        if (content.length === 0) {
          content.push({ type: 'text', text: '' });
        }

        anthropicMessages.push({ role: 'assistant', content });
      } else {
        anthropicMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: this.toAnthropicContent(
            isContentPartArray(msg.content) ? msg.content : contentToPlainText(msg.content),
          ),
        });
      }
    }

    // ── Bedrock/Anthropic tool_result/tool_use 配对修复 ──────────────────────
    // Bedrock 严格要求每个 user 消息中的 tool_result 数量不超过前一个 assistant 的 tool_use 数量。
    // 历史消息损坏（压缩残留、resume 不完整、上游流截断）可能导致 mismatch。
    // 在发送前做最终验证和修复，避免 TOOL_USE_RESULT_MISMATCH 400 错误。
    for (let i = 1; i < anthropicMessages.length; i++) {
      const msg = anthropicMessages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      const toolResults = (msg.content as unknown as Array<Record<string, unknown>>).filter(b => b.type === 'tool_result');
      if (toolResults.length === 0) continue;

      // 找到前一个 assistant 消息
      let prevAssistant: MessageParam | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (anthropicMessages[j].role === 'assistant') {
          prevAssistant = anthropicMessages[j];
          break;
        }
      }
      if (!prevAssistant || !Array.isArray(prevAssistant.content)) continue;

      const toolUseIds = new Set(
        (prevAssistant.content as unknown as Array<Record<string, unknown>>)
          .filter(b => b.type === 'tool_use')
          .map(b => b.id as string),
      );

      // 只保留 tool_use_id 与前一个 assistant 的 tool_use 匹配的 tool_results
      if (toolResults.length > toolUseIds.size) {
        const filtered = (msg.content as unknown as Array<Record<string, unknown>>).filter(
          b => b.type !== 'tool_result' || toolUseIds.has(b.tool_use_id as string),
        );
        if (filtered.length === 0) {
          // 全部是孤儿 tool_results → 移除整个消息
          anthropicMessages.splice(i, 1);
          i--;
        } else {
          (msg as { content: unknown }).content = filtered;
        }
      }
    }

    // cache_control 策略：优先把断点放在最后一个稳定 system block。
    // runtime/context manifest、memory、blackboard、mode hint 等 system 块会频繁变化，
    // 如果盲目给最后一个 system block 打 cache_control，会把 volatile 内容纳入缓存前缀，
    // 造成频繁 cache miss。没有稳定块时回退到历史行为。
    if (systemBlocks.length > 0) {
      const isVolatileSystemBlock = (block: TextBlockParam): boolean => {
        const text = typeof block.text === 'string' ? block.text : '';
        return text.includes('slot=leader_runtime')
          || text.includes('slot=leader_memory')
          || text.includes('slot=leader_init')
          || text.includes('slot=worker_runtime')
          || text.includes('slot=worker_memory')
          || text.trimStart().startsWith('## 黑板图分析（自动注入')
          || text.includes('[Solo 模式]')
          || text.includes('[Team 模式]')
          || text.includes('[Execution preference]')
          || text.includes('[执行偏好]');
      };
      let cacheSystemIndex = systemBlocks.length - 1;
      for (let i = systemBlocks.length - 1; i >= 0; i -= 1) {
        if (!isVolatileSystemBlock(systemBlocks[i])) {
          cacheSystemIndex = i;
          break;
        }
      }
      systemBlocks[cacheSystemIndex] = {
        ...systemBlocks[cacheSystemIndex],
        cache_control: CACHE_CONTROL_EPHEMERAL,
      };
    }

    let cacheBreakpointsRemaining = 2;
    // cache_control 动态打点 (2026-06-06 优化)：
    //
    // 凌霄 agent 场景中，tool loop 会产生大量 user(tool_result) 消息。
    // 如果两个断点都落在连续的 tool_result 上，它们之间可能只隔几百 token，
    // 浪费了宝贵的断点位。
    //
    // 优化策略：区分「真实 user 输入」和「tool_result pseudo-user 消息」。
    //   断点 1: 最后一个 tool_result 或真实 user 消息（当前轮 prefix 终点）
    //   断点 2: 最后一个「真实 user 输入」消息（不含纯 tool_result）
    //           — 如果所有 user 消息都是 tool_result，则取倒数第 3+ 个 tool_result
    //
    // 这样断点 2 锚定了"上一轮用户输入"的位置，对话继续时 prefix 不变。
    // 断点 1 覆盖本轮最后的 tool_result，让 thinking model 的长 prefix 也能缓存。
    //
    // 参考 claude-code 的 4 断点策略：system + tools + 上轮 + 本轮。

    // 辅助：判断一个 user message 是否是纯 tool_result
    const isPureToolResult = (m: MessageParam): boolean => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      return (m.content as unknown as Array<Record<string, unknown>>).every(
        (b) => b.type === 'tool_result',
      );
    };

    // 第一个断点：倒数第 1 个 user 消息（不区分 tool_result / 真实输入）
    // 第二个断点：倒数第 1 个「真实 user 输入」消息（非纯 tool_result）
    //            如果不存在，退回到倒数第 2 个 user 消息（与旧行为兼容）
    const userBoundaries: Array<{ msgIdx: number; blockIdx: number }> = [];
    let foundFirstUser = false;
    let foundRealUser = false;

    for (let i = anthropicMessages.length - 1; i >= 0 && userBoundaries.length < cacheBreakpointsRemaining; i--) {
      const m = anthropicMessages[i];
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;

      const isToolOnly = isPureToolResult(m);

      // 第一个断点：任何 user 消息都行（覆盖本轮最新内容）
      if (!foundFirstUser) {
        foundFirstUser = true;
        const bp = this.findCacheableBlock(m);
        if (bp !== null) {
          userBoundaries.push({ msgIdx: i, blockIdx: bp });
          continue;
        }
      }

      // 第二个断点：优先找非 tool_result 的真实用户输入
      if (!foundRealUser && !isToolOnly) {
        foundRealUser = true;
        const bp = this.findCacheableBlock(m);
        if (bp !== null) {
          userBoundaries.push({ msgIdx: i, blockIdx: bp });
          continue;
        }
      }

      // 退回：如果还没填满且当前是 tool_result，也用它
      if (!foundRealUser && isToolOnly && userBoundaries.length < cacheBreakpointsRemaining) {
        const bp = this.findCacheableBlock(m);
        if (bp !== null) {
          userBoundaries.push({ msgIdx: i, blockIdx: bp });
        }
      }
    }

    for (const { msgIdx, blockIdx } of userBoundaries) {
      const m = anthropicMessages[msgIdx];
      const blocks = m.content as ContentBlockParam[];
      const block = blocks[blockIdx] as unknown as Record<string, unknown>;
      blocks[blockIdx] = { ...block, cache_control: CACHE_CONTROL_EPHEMERAL } as ContentBlockParam;
      cacheBreakpointsRemaining--;
    }
    // 兜底：如果两轮都没找到 user message（极少见，例如纯 assistant 历史），
    // 退回到旧的"倒数 N 个可打点 block"策略，至少保证 system+tools 之外
    // 还有一些 cache 利用率。
    if (cacheBreakpointsRemaining > 0) {
      for (let i = anthropicMessages.length - 1; i >= 0 && cacheBreakpointsRemaining > 0; i--) {
        const m = anthropicMessages[i];
        if (!Array.isArray(m.content)) continue;
        for (let j = m.content.length - 1; j >= 0 && cacheBreakpointsRemaining > 0; j--) {
          const block = m.content[j] as unknown as Record<string, unknown>;
          if ('cache_control' in block) continue;
          if (block.type === 'text' || block.type === 'tool_use' || block.type === 'tool_result') {
            (m.content as ContentBlockParam[])[j] = { ...block, cache_control: CACHE_CONTROL_EPHEMERAL } as ContentBlockParam;
            cacheBreakpointsRemaining--;
          }
        }
      }
    }

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: 'Continue with the instructions above.',
          cache_control: CACHE_CONTROL_EPHEMERAL,
        }],
      });
    }

    return {
      system: systemBlocks.length > 0 ? systemBlocks : undefined,
      messages: anthropicMessages,
    };
  }

  /** 在一个 user 消息中找最后一个可打 cache_control 的 block index */
  private findCacheableBlock(m: MessageParam): number | null {
    if (!Array.isArray(m.content)) return null;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j] as unknown as Record<string, unknown>;
      if ('cache_control' in block) continue;
      if (block.type === 'text' || block.type === 'tool_use' || block.type === 'tool_result') {
        return j;
      }
    }
    return null;
  }

  private convertTools(tools?: import('./types.js').ToolDefinition[]): AnthropicTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool, index) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: normalizeAnthropicToolInputSchema(tool.function.parameters) as AnthropicTool.InputSchema,
      ...(index === tools.length - 1 ? { cache_control: CACHE_CONTROL_EPHEMERAL } : {}),
    }));
  }
}
