/**
 * ContentGenerator 统一抽象层
 *
 * 参考 qwen-code contentGenerator.ts 设计，为 lingxiao 提供统一的 LLM 内容生成接口。
 * 所有 provider（OpenAI/Anthropic/未来扩展）都实现此接口，上层调用者无需关心底层差异。
 *
 * 架构：
 *   ContentGenerator (接口)
 *     ├─ OpenAIContentGenerator (实现)
 *     ├─ AnthropicContentGenerator (实现)
 *     └─ LoggingContentGenerator (装饰器，包装任意实现)
 */

import type {
  ChatMessage,
  ChatResponse,
  StreamCallbacks,
  ToolDefinition,
  TokenUsage,
} from './types.js';

// ─── 请求参数 ───────────────────────────────────────────────────────────────

export interface GenerateContentParams {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** 覆盖默认 max_tokens */
  maxTokens?: number;
  /** 采样参数覆盖 */
  sampling?: {
    temperature?: number;
    top_p?: number;
  };
}

// ─── 流式事件 ───────────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; toolCall: import('./types.js').ToolCall }
  | { type: 'tool_call_delta'; delta: import('./types.js').ToolCallDeltaInfo }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; finishReason: string }
  | { type: 'error'; error: Error };

// ─── Token 计数 ─────────────────────────────────────────────────────────────

export interface CountTokensParams {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
}

export interface CountTokensResult {
  totalTokens: number;
  /** 各消息的 token 数（可选，用于压缩决策） */
  perMessage?: number[];
}

// ─── ContentGenerator 接口 ──────────────────────────────────────────────────

export interface ContentGenerator {
  /**
   * 非流式生成（一次性返回完整结果）
   */
  generateContent(params: GenerateContentParams): Promise<ChatResponse>;

  /**
   * 流式生成（返回 AsyncGenerator，逐 chunk 产出事件）
   *
   * 调用者可通过 for-await-of 消费，也可传入 callbacks 接收聚合事件。
   * 两种消费方式互不冲突：callbacks 在 generator 内部触发，
   * yield 的事件供上层做更精细的控制（如 retry rollback）。
   */
  generateContentStream(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): AsyncGenerator<StreamEvent, ChatResponse, undefined>;

  /**
   * 便捷方法：流式生成 + 自动消费 generator + 触发 callbacks + 返回最终结果。
   *
   * 内部调用 generateContentStream 并 for-await-of 消费，最终返回 ChatResponse。
   */
  generateContentWithCallbacks(
    params: GenerateContentParams,
    callbacks?: StreamCallbacks,
  ): Promise<ChatResponse>;

  /**
   * Token 计数（用于上下文压缩决策）
   */
  countTokens(params: CountTokensParams): Promise<CountTokensResult>;

  /**
   * 释放资源（连接池等）
   */
  close(): Promise<void>;

  /**
   * 强制回收并重建底层 SDK 客户端。
   *
   * 长跑场景下偶发 provider socket 半开 / keep-alive 死连接 — 单纯重试无法救活，
   * 必须丢弃旧 client + dispatcher。此方法应该：
   *   1. 重新构造底层 OpenAI/Anthropic SDK 实例
   *   2. 触发 http_dispatcher.rebuildSharedFetch()（由 caller 视情况调）
   * 装饰器（Logging/Caching/Client）应转发给内部 generator。
   *
   * 实现要保证幂等 + 安全：调用时不应抛出。
   */
  recycle?(): void;

  /**
   * 预热连接
   */
  warmup?(): Promise<void>;

  /**
   * 返回 Provider key（baseUrl::model），供 CircuitBreaker 跨流式/非流式路径共享熔断状态。
   * 装饰器（Caching/Logging/Client）应转发给内部 generator。
   */
  getProviderKey?(model: string): string | null;
}

// ─── ContentGenerator 配置 ──────────────────────────────────────────────────

export interface ContentGeneratorConfig {
  /** 模型 ID（配置中的标识符） */
  modelId: string;
  /** 实际发送给 API 的模型名 */
  apiModelName: string;
  /** Provider 类型 */
  provider: 'openai' | 'anthropic';
  /** API Key */
  apiKey: string;
  /** Base URL */
  baseUrl: string;
  /** 强制使用 Vercel AI SDK 统一实现（也可通过 LINGXIAO_USE_VERCEL_AI=1 环境变量启用） */
  useVercelAI?: boolean;
}

// ─── 工厂函数 ────────────────────────────────────────────────────────────────

import { OpenAIContentGenerator } from './OpenAIContentGenerator.js';
import { AnthropicContentGenerator } from './AnthropicContentGenerator.js';
import { LoggingContentGenerator } from './LoggingContentGenerator.js';
import { VercelAIContentGenerator } from './VercelAIContentGenerator.js';

/**
 * 同步创建 ContentGenerator 实例。
 *
 * 根据 provider 类型创建对应实现，并用 LoggingContentGenerator 包装。
 * 这是上层代码获取 ContentGenerator 的唯一入口。
 *
 * Feature flag: 设置 LINGXIAO_USE_VERCEL_AI=1 或 config.useVercelAI=true
 * 使用 Vercel AI SDK 统一实现（支持 OpenAI/Anthropic/Google/Bedrock/custom）。
 */
export function createContentGenerator(
  config: ContentGeneratorConfig,
): ContentGenerator {
  // Vercel AI SDK unified path (feature-flagged)
  if (process.env.LINGXIAO_USE_VERCEL_AI === '1' || config.useVercelAI) {
    return new LoggingContentGenerator(new VercelAIContentGenerator(config), config);
  }

  const generator: ContentGenerator =
    config.provider === 'anthropic'
      ? new AnthropicContentGenerator(config)
      : new OpenAIContentGenerator(config);

  return new LoggingContentGenerator(generator, config);
}

// ─── 默认实现辅助：消费 generator 返回 ChatResponse ─────────────────────────

/**
 * 消费 AsyncGenerator 并返回最终 ChatResponse。
 * 供各实现类的 generateContentWithCallbacks 复用。
 */
export async function consumeGeneratorToResponse(
  generator: AsyncGenerator<StreamEvent, ChatResponse, undefined>,
): Promise<ChatResponse> {
  let result: IteratorResult<StreamEvent, ChatResponse>;
  while (!(result = await generator.next()).done) {
    // events already dispatched via callbacks inside the generator
  }
  return result.value;
}
