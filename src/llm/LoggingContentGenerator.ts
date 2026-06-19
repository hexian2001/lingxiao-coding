/**
 * LoggingContentGenerator — 装饰器模式
 *
 * 参考 qwen-code loggingContentGenerator.ts，包装任意 ContentGenerator 实现，
 * 在不污染 provider 逻辑的前提下添加：
 * - 请求/响应审计日志
 * - 延迟测量（TTFT / 总耗时）
 * - 错误分类与记录
 */

import type {
  ContentGenerator,
  ContentGeneratorConfig,
  CountTokensParams,
  CountTokensResult,
  GenerateContentParams,
  StreamEvent,
} from './ContentGenerator.js';
import { consumeGeneratorToResponse } from './ContentGenerator.js';
import type { ChatResponse, StreamCallbacks } from './types.js';
import { llmLogger } from '../core/Log.js';

export class LoggingContentGenerator implements ContentGenerator {
  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly config: ContentGeneratorConfig,
  ) {}

  async generateContent(params: GenerateContentParams): Promise<ChatResponse> {
    const startTime = Date.now();

    llmLogger.debug(
      `[LLM:req] model=${params.model} messages=${params.messages.length} tools=${params.tools?.length ?? 0}`,
    );

    try {
      const response = await this.wrapped.generateContent(params);
      const elapsed = Date.now() - startTime;

      llmLogger.debug(
        `[LLM:res] model=${response.model ?? params.model} elapsed=${elapsed}ms ` +
        `tokens=${response.usage?.total_tokens ?? '?'} finish=${response.finish_reason ?? '?'}`,
      );

      return response;
    } catch (error) {
      const elapsed = Date.now() - startTime;

      llmLogger.warn(
        `[LLM:err] model=${params.model} elapsed=${elapsed}ms error=${(error as Error).message}`,
      );

      throw error;
    }
  }

  async *generateContentStream(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): AsyncGenerator<StreamEvent, ChatResponse, undefined> {
    const startTime = Date.now();
    let firstChunkTime: number | undefined;

    llmLogger.debug(
      `[LLM:stream:req] model=${params.model} messages=${params.messages.length} tools=${params.tools?.length ?? 0}`,
    );

    try {
      const stream = this.wrapped.generateContentStream(params, callbacks);
      let result: IteratorResult<StreamEvent, ChatResponse>;

      while (!(result = await stream.next()).done) {
        const event = result.value;

        if (!firstChunkTime && (event.type === 'text' || event.type === 'thinking')) {
          firstChunkTime = Date.now();
          llmLogger.debug(
            `[LLM:stream:ttft] model=${params.model} ttft=${firstChunkTime - startTime}ms`,
          );
        }

        yield event;
      }

      // Generator return value is the final ChatResponse
      const response = result.value;
      const elapsed = Date.now() - startTime;

      llmLogger.debug(
        `[LLM:stream:res] model=${response.model ?? params.model} elapsed=${elapsed}ms ` +
        `tokens=${response.usage?.total_tokens ?? '?'} finish=${response.finish_reason ?? '?'}`,
      );

      return response;
    } catch (error) {
      const elapsed = Date.now() - startTime;

      llmLogger.warn(
        `[LLM:stream:err] model=${params.model} elapsed=${elapsed}ms error=${(error as Error).message}`,
      );

      throw error;
    }
  }

  async countTokens(params: CountTokensParams): Promise<CountTokensResult> {
    return this.wrapped.countTokens(params);
  }

  async generateContentWithCallbacks(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): Promise<ChatResponse> {
    return consumeGeneratorToResponse(this.generateContentStream(params, callbacks));
  }

  async close(): Promise<void> {
    await this.wrapped.close();
  }

  async warmup(): Promise<void> {
    await this.wrapped.warmup?.();
  }

  recycle(): void {
    this.wrapped.recycle?.();
  }

  getProviderKey(model: string): string | null {
    return this.wrapped.getProviderKey?.(model) ?? null;
  }
}
