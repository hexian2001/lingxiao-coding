/**
 * VercelAIContentGenerator — Unified provider implementation via Vercel AI SDK v5
 *
 * Implements the ContentGenerator interface using the `ai` package, supporting
 * 5+ providers (Anthropic, OpenAI, Google, Bedrock, custom) through a single
 * code path. Activated via feature flag LINGXIAO_USE_VERCEL_AI=1.
 *
 * Key responsibilities:
 * - Convert Lingxiao's ChatMessage[] to AI SDK ModelMessage[]
 * - Convert Lingxiao ToolDefinition[] to AI SDK tool format
 * - Map AI SDK streaming events (TextStreamPart) to Lingxiao StreamEvent
 * - Handle thinking/reasoning blocks for Anthropic
 * - Propagate abort signals and token usage
 */

import { generateText, streamText, type ToolSet } from 'ai';
import { jsonSchema, tool as aiTool } from '@ai-sdk/provider-utils';
import type { LanguageModelV2, JSONValue } from '@ai-sdk/provider';
import type { ModelMessage, ProviderOptions } from '@ai-sdk/provider-utils';
import type {
  ContentGenerator,
  CountTokensParams,
  CountTokensResult,
  GenerateContentParams,
  StreamEvent,
} from './ContentGenerator.js';
import { consumeGeneratorToResponse } from './ContentGenerator.js';
import type {
  ChatMessage,
  ChatResponse,
  MessageContent,
  StreamCallbacks,
  ThinkingBlock,
  ToolCall,
  TokenUsage,
  ToolDefinition,
} from './types.js';
import { contentToPlainText, isContentPartArray } from './types.js';
import { createProviderModel, type VercelAIProviderConfig } from './providers/index.js';
import { estimateTokens } from './token_counter.js';
import { supportsThinking, getThinkingParams } from './model_capabilities.js';
import { getConfigValue } from '../config.js';
import { resolveGuardedTemperature } from './reasoningSampling.js';

// ─── VercelAIContentGenerator ────────────────────────────────────────────────

export class VercelAIContentGenerator implements ContentGenerator {
  private model: LanguageModelV2;
  private readonly config: VercelAIProviderConfig;

  constructor(config: VercelAIProviderConfig) {
    this.config = config;
    this.model = createProviderModel(config);
  }

  /**
   * 防漂移：推理/编排/判定调用默认采样温度 0(确定性解码)。
   * 但 Anthropic extended thinking 经 Vercel SDK 转发时同样要求 temperature=1，
   * thinking 开启时不得下发 temperature(保留 provider 默认)，否则 400。
   * thinkingActive 三条件：模型支持 + 配置开启 + 本次实际会发 thinking 参数。
   *
   * A1 全局兜底：未显式指定 sampling.temperature 时也锁定确定性解码温度(默认 0)，
   * 避免新调用点漏锁 sampling 静默走 provider 默认(~1.0)导致漂移。
   */
  private resolveTemperature(params: GenerateContentParams): number | undefined {
    // getConfigValue 返回 unknown，用 Boolean() 收窄为 boolean(确定性，非启发式)。
    const thinkingActive = Boolean(
      supportsThinking(params.model)
        && getConfigValue('llm.enable_extended_thinking')
        && getThinkingParams(params.model) != null,
    );
    return resolveGuardedTemperature(params.sampling?.temperature, thinkingActive);
  }

  // ─── ContentGenerator interface ──────────────────────────────────────────
  async generateContent(params: GenerateContentParams): Promise<ChatResponse> {
    const { system, messages } = this.splitSystemMessages(params.messages);
    const tools = this.convertTools(params.tools);
    const providerOptions = this.buildProviderOptions();

    const result = await generateText({
      model: this.model,
      system,
      messages,
      tools: tools as ToolSet | undefined,
      maxOutputTokens: params.maxTokens,
      temperature: this.resolveTemperature(params),
      topP: params.sampling?.top_p,
      abortSignal: params.signal,
      providerOptions: providerOptions as ProviderOptions | undefined,
      maxRetries: 0, // Let LlmGuard handle retries
    });

    return this.buildChatResponse(result);
  }

  async *generateContentStream(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): AsyncGenerator<StreamEvent, ChatResponse, undefined> {
    const { system, messages } = this.splitSystemMessages(params.messages);
    const tools = this.convertTools(params.tools);
    const providerOptions = this.buildProviderOptions();

    const result = streamText({
      model: this.model,
      system,
      messages,
      tools: tools as ToolSet | undefined,
      maxOutputTokens: params.maxTokens,
      temperature: this.resolveTemperature(params),
      topP: params.sampling?.top_p,
      abortSignal: params.signal,
      providerOptions: providerOptions as ProviderOptions | undefined,
      maxRetries: 0,
    });

    let text = '';
    let firstTokenEmitted = false;
    const thinkingBlocks: ThinkingBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage | undefined;
    let finishReason = '';
    // Track tool call deltas by id
    const toolCallInputBuffers = new Map<string, { name: string; json: string; index: number }>();
    let toolCallIndex = 0;
    let currentReasoningId: string | undefined;
    let currentReasoningText = '';

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            callbacks?.onFirstToken?.();
            yield { type: 'text', text: '' } as StreamEvent; // signal first token
          }
          text += part.text;
          callbacks?.onText?.(part.text);
          yield { type: 'text', text: part.text };
          break;
        }
        case 'reasoning-delta': {
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            callbacks?.onFirstToken?.();
          }
          currentReasoningId = part.id;
          currentReasoningText += part.text;
          callbacks?.onThinking?.(part.text);
          yield { type: 'thinking', text: part.text };
          break;
        }

        case 'reasoning-end': {
          // Finalize the thinking block
          if (currentReasoningText) {
            const block: ThinkingBlock = {
              type: 'thinking',
              text: currentReasoningText,
              signature: part.providerMetadata?.['anthropic']?.['signature'] as string | undefined,
            };
            thinkingBlocks.push(block);
          }
          currentReasoningId = undefined;
          currentReasoningText = '';
          break;
        }

        case 'tool-input-start': {
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            callbacks?.onFirstToken?.();
          }
          const idx = toolCallIndex++;
          toolCallInputBuffers.set(part.id, { name: part.toolName, json: '', index: idx });
          callbacks?.onToolCallDelta?.({
            index: idx,
            id: part.id,
            name: part.toolName,
            partialJson: '',
          });
          yield {
            type: 'tool_call_delta',
            delta: { index: idx, id: part.id, name: part.toolName, partialJson: '' },
          };
          break;
        }

        case 'tool-input-delta': {
          const buf = toolCallInputBuffers.get(part.id);
          if (buf) {
            buf.json += part.delta;
            callbacks?.onToolCallDelta?.({
              index: buf.index,
              partialJson: part.delta,
            });
            yield {
              type: 'tool_call_delta',
              delta: { index: buf.index, partialJson: part.delta },
            };
          }
          break;
        }
        case 'tool-input-end': {
          const buf = toolCallInputBuffers.get(part.id);
          if (buf) {
            const tc: ToolCall = {
              id: part.id,
              type: 'function',
              function: { name: buf.name, arguments: buf.json },
            };
            toolCalls.push(tc);
            callbacks?.onToolCall?.(tc);
            yield { type: 'tool_call', toolCall: tc };
            toolCallInputBuffers.delete(part.id);
          }
          break;
        }

        case 'tool-call': {
          // Some providers emit tool-call directly without input-start/delta/end
          const buf2 = toolCallInputBuffers.get(part.toolCallId);
          if (!buf2) {
            const tc: ToolCall = {
              id: part.toolCallId,
              type: 'function',
              function: {
                name: part.toolName,
                arguments: typeof part.input === 'string'
                  ? part.input
                  : JSON.stringify(part.input ?? {}),
              },
            };
            toolCalls.push(tc);
            callbacks?.onToolCall?.(tc);
            yield { type: 'tool_call', toolCall: tc };
          }
          break;
        }

        case 'finish-step': {
          usage = this.convertUsage(part.usage);
          finishReason = part.finishReason ?? '';
          if (usage) {
            callbacks?.onUsage?.(usage);
            yield { type: 'usage', usage };
          }
          break;
        }

        case 'finish': {
          finishReason = part.finishReason ?? finishReason;
          if (part.totalUsage) {
            usage = this.convertUsage(part.totalUsage);
          }
          break;
        }

        case 'error': {
          const err = part.error instanceof Error
            ? part.error
            : new Error(String(part.error));
          callbacks?.onError?.(err);
          yield { type: 'error', error: err };
          break;
        }

        default:
          // Ignore other event types (source, file, raw, start, start-step, etc.)
          break;
      }
    }

    yield { type: 'finish', finishReason: finishReason || 'stop' };

    const response: ChatResponse = {
      content: text || null,
      thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: this.config.apiModelName,
      finish_reason: finishReason || 'stop',
      was_output_truncated: finishReason === 'length',
    };
    return response;
  }

  async generateContentWithCallbacks(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): Promise<ChatResponse> {
    return consumeGeneratorToResponse(this.generateContentStream(params, callbacks));
  }
  async countTokens(params: CountTokensParams): Promise<CountTokensResult> {
    // AI SDK does not provide a built-in token counting API.
    // Fall back to the project's estimateTokens utility.
    const totalTokens = estimateTokens(
      params.messages.map((m) => contentToPlainText(m.content)).join('\n'),
    );
    return { totalTokens };
  }

  async close(): Promise<void> {
    // AI SDK models are stateless; no cleanup needed.
  }

  recycle(): void {
    // Rebuild model instance (stateless, but ensures fresh config pickup)
    this.model = createProviderModel(this.config);
  }

  getProviderKey(model: string): string | null {
    return `${this.config.baseUrl || 'default'}::${model}`;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Split system messages from conversation messages.
   * AI SDK prefers system as a separate `system` param (first system message),
   * though subsequent system messages must stay inline with allowSystemInMessages.
   */
  private splitSystemMessages(messages: ChatMessage[]): {
    system: string | undefined;
    messages: ModelMessage[];
  } {
    let system: string | undefined;
    const converted: ModelMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = contentToPlainText(msg.content);
        if (!system) {
          system = text;
        } else {
          // Additional system messages go inline
          converted.push({ role: 'system', content: text });
        }
      } else {
        converted.push(this.convertMessage(msg));
      }
    }

    return { system, messages: converted };
  }
  private convertMessage(msg: ChatMessage): ModelMessage {
    switch (msg.role) {
      case 'user':
        return { role: 'user', content: this.convertUserContent(msg.content) };

      case 'assistant':
        return {
          role: 'assistant',
          content: this.convertAssistantContent(msg),
        };

      case 'tool':
        return {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: msg.tool_call_id || '',
            toolName: msg.name || '',
            output: { type: 'text', value: contentToPlainText(msg.content) },
          }],
        };

      default:
        // Fallback: treat as user message
        return { role: 'user', content: contentToPlainText(msg.content) };
    }
  }

  private convertUserContent(content: MessageContent): string | Array<{type: 'text'; text: string} | {type: 'image'; image: URL; mediaType?: string}> {
    if (!content || typeof content === 'string') {
      return content || '';
    }

    if (!isContentPartArray(content)) {
      return '';
    }

    const parts: Array<{type: 'text'; text: string} | {type: 'image'; image: URL; mediaType?: string}> = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        parts.push({
          type: 'image',
          image: new URL(part.image_url.url),
        });
      }
      // image_blob_ref parts are skipped (not directly supported by AI SDK URL-based images)
    }
    return parts.length > 0 ? parts : '';
  }
  private convertAssistantContent(
    msg: ChatMessage,
  ): string | Array<
    | {type: 'text'; text: string}
    | {type: 'reasoning'; text: string; providerOptions?: ProviderOptions}
    | {type: 'tool-call'; toolCallId: string; toolName: string; input: unknown}
  > {
    const parts: Array<
      | {type: 'text'; text: string}
      | {type: 'reasoning'; text: string; providerOptions?: ProviderOptions}
      | {type: 'tool-call'; toolCallId: string; toolName: string; input: unknown}
    > = [];

    // Thinking blocks → reasoning parts
    if (msg.thinking) {
      for (const tb of msg.thinking) {
        if (tb.type === 'thinking') {
          parts.push({
            type: 'reasoning',
            text: tb.text,
            providerOptions: tb.signature
              ? { anthropic: { signature: tb.signature as JSONValue } }
              : undefined,
          });
        }
        // redacted_thinking blocks cannot be meaningfully passed back
      }
    }

    // Text content
    const text = contentToPlainText(msg.content);
    if (text) {
      parts.push({ type: 'text', text });
    }

    // Tool calls
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // arguments 非合法 JSON（流式截断 / 双层转义毒化历史）。Vercel 路径不走
          // OpenAI 的 sanitizeMessages，需在此自带防御：传裸字符串会让 AI SDK 再次
          // JSON.stringify 产生双层转义（'"{\\"..."}"'）→ provider 以
          // `invalid function arguments json string (2013)` 拒绝。降级为空对象
          // （确定性，非启发式），保 tool_call 配对完整。
          input = {};
        }
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input,
        });
      }
    }

    if (parts.length === 0) return '';
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
  }

  /**
   * Convert Lingxiao ToolDefinition[] to AI SDK tool format.
   * AI SDK tools require an `inputSchema` (via jsonSchema helper) and optionally `execute`.
   * We provide schema-only tools (no execute) since Lingxiao handles execution externally.
   */
  private convertTools(
    tools?: ToolDefinition[],
  ): Record<string, ReturnType<typeof aiTool>> | undefined {
    if (!tools || tools.length === 0) return undefined;

    const result: Record<string, ReturnType<typeof aiTool>> = {};
    for (const t of tools) {
      const schema = t.function.parameters || { type: 'object', properties: {} };
      result[t.function.name] = aiTool({
        description: t.function.description,
        inputSchema: jsonSchema(schema),
      });
    }
    return result;
  }
  /**
   * Build provider-specific options (thinking/reasoning),复用 getThinkingParams 单一事实源。
   *
   * 与原生 AnthropicContentGenerator / OpenAIContentGenerator 路径对齐(消除漂移):
   * enable_extended_thinking 默认 true + 家族兜底(claude/o系列/gpt-5),安装即开,
   * 无需额外配置。映射到 Vercel AI SDK providerOptions 命名约定(camelCase):
   *   - anthropic thinking_block → { anthropic: { thinking: { type, budgetTokens? } } }
   *     (snake budget_tokens → camel budgetTokens;adaptive/enabled/disabled 三态透传)
   *   - openai reasoning_effort → { openai: { reasoningEffort } }
   */
  private buildProviderOptions(): Record<string, Record<string, JSONValue>> | undefined {
    const params = getThinkingParams(this.config.modelId);
    if (!params) return undefined;

    const provider = this.config.provider;
    if (provider === 'anthropic' && typeof params.thinking === 'object' && params.thinking !== null) {
      const src = params.thinking as Record<string, unknown>;
      const mapped: Record<string, unknown> = { type: src.type };
      if (typeof src.budget_tokens === 'number') mapped.budgetTokens = src.budget_tokens;
      return { anthropic: { thinking: mapped as JSONValue } };
    }
    if (provider === 'openai' && typeof params.reasoning_effort === 'string') {
      return { openai: { reasoningEffort: params.reasoning_effort } };
    }
    // extra_body 类(deepseek/kimi/qwen)Vercel 统一路径不在本映射范围(与原生 extra_body 路径并存)。
    return undefined;
  }

  /**
   * Convert generateText result to Lingxiao ChatResponse.
   */
  private buildChatResponse(result: {
    text: string;
    reasoning: Array<{type: 'reasoning'; text: string; providerMetadata?: Record<string, Record<string, unknown>>}>;
    toolCalls: Array<{toolCallId: string; toolName: string; input?: unknown; args?: unknown}>;
    usage: {inputTokens?: number; outputTokens?: number; totalTokens?: number};
    finishReason: string;
    response?: {modelId?: string};
  }): ChatResponse {
    const thinkingBlocks: ThinkingBlock[] = result.reasoning.map((r) => ({
      type: 'thinking' as const,
      text: r.text,
      signature: r.providerMetadata?.['anthropic']?.['signature'] as string | undefined,
    }));

    const toolCalls: ToolCall[] = result.toolCalls.map((tc) => ({
      id: tc.toolCallId,
      type: 'function' as const,
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.input ?? tc.args ?? {}),
      },
    }));

    return {
      content: result.text || null,
      thinking: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: this.convertUsage(result.usage),
      model: result.response?.modelId ?? this.config.apiModelName,
      finish_reason: result.finishReason,
      was_output_truncated: result.finishReason === 'length',
    };
  }

  private convertUsage(usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  }): TokenUsage {
    const prompt = usage.inputTokens ?? 0;
    const completion = usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? (prompt + completion);
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    };
  }
}



