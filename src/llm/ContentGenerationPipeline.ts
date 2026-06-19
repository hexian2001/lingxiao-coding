/**
 * ContentGenerationPipeline — provider-stream 共享工具
 *
 * Anthropic / OpenAI 两个 ContentGenerator 的流式实现差异主要在
 *   - 协议事件类型（Anthropic: content_block_start/_delta/_stop；OpenAI: choices[].delta）
 *   - thinking 表示形态（Anthropic: 多个 ThinkingBlock；OpenAI: reasoning_content 字符串）
 * 但**生命周期外壳**完全一致：
 *   1. 创建 heartbeat + parser
 *   2. 每个 chunk 入口 heartbeat reset
 *   3. 流末 parser.finalize() + 截断软标志
 *   4. 把 CompletedToolCall 映射成 ToolCall
 *   5. 异常路径 classifyLLMError + yield error + throw
 *
 * 2026-05-27：删除应用层 stream timeout（chunk-idle / first-token guard）。
 * 之前我们自己叠了一层心跳超时，120s 没收到 chunk 就 abort，导致 thinking
 * 模型偶发 ~107s 卡顿被误判失败、刷出大量 retry 死循环。现在让 SDK 的
 * `timeout`（默认 600s 与 OpenAI/Anthropic SDK 默认对齐）作为唯一权威
 * socket-level 兜底；其它情况严格依赖 API 信号。
 */

import type { ToolCall, StreamCallbacks } from './types.js';
import { StreamingToolCallParser } from './StreamingToolCallParser.js';
import {
  createHeartbeatTimerWithReset,
  type HeartbeatTimer,
} from './provider_runtime.js';
import { classifyLLMError, type LLMError } from './errors.js';

/**
 * Provider-stream 运行时：parser + heartbeat 一次性打包，
 * caller 通过 tickAtChunk() 在每个 chunk 入口刷新 UI 心跳，finishStream() 结束清理。
 */
export interface ProviderStreamRuntime {
  /** 工具调用流式拼接器，由 caller 在 chunk 处理中 appendChunk，流末在 finalizeProviderStream 中 finalize */
  readonly parser: StreamingToolCallParser;
  /** UI 心跳进度回调器 */
  readonly heartbeat: HeartbeatTimer;
  /** 在每个 stream chunk 处理之前调用：刷新 UI 心跳进度 */
  tickAtChunk(): void;
  /** 在所有 chunk 处理完毕、进入 finalize 之前调用：清 heartbeat */
  finishStream(): void;
}

export interface CreateProviderStreamRuntimeOptions {
  /**
   * 该模型是否支持 thinking。当前仅作为信息字段保留，应用层不再据此设置首 token 超时；
   * SDK 自身的 request timeout 是唯一权威。
   */
  supportsThinking: boolean;
  /** 透传给 heartbeat 的 callbacks，用于 UI 进度反馈 */
  callbacks?: StreamCallbacks;
}

export function createProviderStreamRuntime(
  options: CreateProviderStreamRuntimeOptions,
): ProviderStreamRuntime {
  // supportsThinking 当前仅保留语义；不再用于首 token 超时。读一下避免 noUnusedLocals。
  void options.supportsThinking;
  const heartbeat = createHeartbeatTimerWithReset({ onProgress: options.callbacks?.onProgress });
  const heartbeatHelpers = heartbeat.helpers();
  const parser = new StreamingToolCallParser();

  return {
    parser,
    heartbeat,
    tickAtChunk(): void {
      heartbeatHelpers.onText?.();
    },
    finishStream(): void {
      heartbeat.clear();
    },
  };
}

/**
 * finalizeProviderStream 输入：caller 在流末把已聚集的 fullContent / thinking
 * 是否非空 / finishReason / usage 等汇总传入。
 */
export interface FinalizeProviderStreamInput {
  runtime: ProviderStreamRuntime;
  provider: 'anthropic' | 'openai';
  model: string;
  /** 当前流期间累计的纯文本（用于 hasUsefulPayload 判断） */
  fullContent: string;
  /**
   * 当前流是否产出过 thinking。
   * Anthropic 传 thinkingBlocks.length > 0；
   * OpenAI 传 reasoningContent.trim().length > 0。
   */
  hasThinking: boolean;
  /**
   * 该 provider 表示"输出被截断"的 finish_reason 字面量值。
   * Anthropic = 'max_tokens'；OpenAI = 'length'。
   * 用于把权威截断信号提升为 was_output_truncated。
   */
  truncationFinishReason: string;
  finishReason: string | undefined;
}

export interface FinalizeProviderStreamOutput {
  /** 流末汇总后的 ToolCall 数组（已补齐 id） */
  toolCalls: ToolCall[];
  /** parser 状态机判断"流末仍未闭合"，作为兜底软标志 */
  wasIncompleteAtFinalize: boolean;
  /** ChatResponse.was_output_truncated 应取的值（finish_reason 截断 || finalize 不完整） */
  wasOutputTruncated: boolean;
}

/**
 * 流末通用收尾：runtime.finishStream → parser.finalize → toolCalls 生成 →
 * was_output_truncated 计算。
 *
 * 关键规则（P0 #5/#6）：
 *   - 截断不再 throw parse_error。`hasIncompleteToolCalls()` 仅作为软标志，
 *     上抛 was_output_truncated=true，让 ToolCallSafety 兜底拒掉文件编辑类工具，
 *     其它工具仍照常执行。
 *   - 空流不在此处抛错；caller（OpenAI/Anthropic generator）在自己的流末
 *     做空流检测并抛 network_error，由 LlmGuard recycle 旧 socket 后重发。
 *
 * 不在此 helper 内 yield 任何 StreamEvent —— 由 caller 顺序调用 onToolCall +
 * yield，保留对协议特异 thinking 提取的插入点。
 */
export function finalizeProviderStream(
  input: FinalizeProviderStreamInput,
): FinalizeProviderStreamOutput {
  const { runtime, truncationFinishReason, finishReason } = input;

  const completedToolCalls = runtime.parser.finalize();
  const wasIncompleteAtFinalize = runtime.parser.hasIncompleteToolCalls();

  runtime.finishStream();

  const toolCalls: ToolCall[] = completedToolCalls.map((tc) => ({
    id: tc.id || `call_${tc.index}_${Date.now()}`,
    type: 'function' as const,
    function: {
      name: tc.name || '',
      arguments: tc.malformed ? (tc.rawArguments || '') : JSON.stringify(tc.args),
    },
  }));

  return {
    toolCalls,
    wasIncompleteAtFinalize,
    wasOutputTruncated: finishReason === truncationFinishReason || wasIncompleteAtFinalize,
  };
}

/**
 * Provider-stream 异常包装：当 chunk 循环或 finalize 抛错时统一处理：
 *   1. 关闭 runtime 的 guard / heartbeat（避免泄漏定时器）
 *   2. classifyLLMError 标准化错误形态
 *
 * 注意：caller 仍需自己 yield { type: 'error', error } + throw，
 * 因为 yield 必须在 generator 内部，不能跨 helper 边界。
 */
export function classifyProviderStreamError(
  error: unknown,
  runtime: ProviderStreamRuntime,
  provider: 'anthropic' | 'openai',
  model: string,
): LLMError {
  runtime.finishStream();
  return classifyLLMError(error, { provider, model });
}
