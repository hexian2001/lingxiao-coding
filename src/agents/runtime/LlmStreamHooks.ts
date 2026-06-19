/**
 * LlmStreamHooks — 把 LLM 流式回调（onText / onThinking / onToolCall /
 * onToolCallDelta / onProgress / onRetry）统一桥接到 EventEmitter。
 *
 * 历史上 Leader（LeaderThinkingEngine）和 Worker（BaseAgent）各有 ~80 行回
 * 调样板，且 BaseAgent.conclude 还有第三份只接 onText 的简化版本。三处通过
 * scope 区分事件前缀（leader:* / agent:*），但事件 payload 形状相同；本工
 * 厂收口这部分样板。
 *
 * 用法：
 * ```ts
 * const buffers = createStreamHookBuffers({ scope: 'agent', emitter, ... });
 * const hooks = wrapLlmHooksForEmitter({ scope: 'agent', emitter, ... }, buffers);
 * await guard.call(llm, ..., hooks);
 * buffers.flushAll();
 * buffers.dispose();
 * ```
 */

import type { EventEmitter } from '../../core/EventEmitter.js';
import type { StreamCallbacks, ToolCall, ToolCallDeltaInfo } from '../../llm/types.js';
import { classifyLLMError, formatLLMErrorLabel } from '../../llm/errors.js';
import { createStreamChunkBuffer, type StreamChunkBuffer } from './StreamChunkBuffer.js';

/** 安全 emit：吞掉订阅者抛出的异常，避免一个坏 listener 炸掉整条流 */
function safeEmit(emitter: EventEmitter, event: string, payload: unknown): void {
  try {
    // Dynamic event dispatch — event name is constructed at runtime from scope+base
    (emitter as unknown as { emit(event: string, data: unknown): void }).emit(event, payload);
  } catch {
    // 订阅者错误不应影响流处理
  }
}

export type LlmHookScope = 'leader' | 'agent';

/**
 * 根据 scope 确定性地组装 event name 和 payload 后 emit。
 * - leader → event = "leader:{eventBase}", payload = { sessionId, ...extra }
 * - agent  → event = "agent:{eventBase}",  payload = { agentId, agentName, sessionId, ...extra }
 */
function emitScoped(
  emitter: EventEmitter,
  scope: LlmHookScope,
  ctx: { sessionId: string; agentId?: string; agentName?: string },
  eventBase: string,
  extra: Record<string, unknown>,
): void {
  const event = `${scope}:${eventBase}`;
  const base = scope === 'leader'
    ? { sessionId: ctx.sessionId }
    : { agentId: ctx.agentId!, agentName: ctx.agentName!, sessionId: ctx.sessionId };
  safeEmit(emitter, event, { ...base, ...extra });
}

export interface LlmHookContext {
  scope: LlmHookScope;
  emitter: EventEmitter;
  sessionId: string;
  /** Leader 不需要；Worker 必填 */
  agentId?: string;
  /** Leader 不需要；Worker 必填 */
  agentName?: string;
}

export interface StreamHookBuffers {
  textBuffer: StreamChunkBuffer;
  thinkingBuffer: StreamChunkBuffer;
  flushAll(): void;
  resetAll(): void;
  dispose(): void;
}

export interface CreateStreamHookBuffersOptions extends LlmHookContext {
  flushThreshold: number;
  /** 仅 Worker 用：BaseAgent.onStreamChunk 是 Wiki 等下游订阅者的原始 chunk 直通 */
  onRawTextChunk?: (chunk: string) => void;
}

/** 创建 text/thinking 两条 chunk buffer，绑定到对应事件 */
export function createStreamHookBuffers(opts: CreateStreamHookBuffersOptions): StreamHookBuffers {
  const { scope, emitter, sessionId, agentId, agentName, flushThreshold } = opts;

  const ctx = { sessionId, agentId, agentName };

  const textBuffer = createStreamChunkBuffer({
    flushThreshold,
    onFlush: (chunk) => emitScoped(emitter, scope, ctx, 'text_chunk', { chunk }),
  });

  const thinkingBuffer = createStreamChunkBuffer({
    flushThreshold,
    onFlush: (chunk) => emitScoped(emitter, scope, ctx, 'thinking_chunk', { chunk }),
  });

  return {
    textBuffer,
    thinkingBuffer,
    flushAll() {
      textBuffer.flush();
      thinkingBuffer.flush();
    },
    resetAll() {
      textBuffer.reset();
      thinkingBuffer.reset();
    },
    dispose() {
      textBuffer.dispose();
      thinkingBuffer.dispose();
    },
  };
}

export interface WrapLlmHooksOptions extends LlmHookContext {
  /** 透传到 onText：Wiki 等下游的原始 chunk 订阅 */
  onRawTextChunk?: (chunk: string) => void;
  /** 工具调用日志记录器（leaderLogger / agentLogger.debug） */
  logToolCall?: (name: string) => void;
}

/**
 * 把 emitter 桥接成一组 StreamCallbacks。
 * - text / thinking 走传入的 buffers
 * - tool_call / tool_call_delta / progress / retry 直接 emit
 * - retry 时同步 reset 两条 buffer，保证半截输出不被拼到下一次 attempt 前
 */
export function wrapLlmHooksForEmitter(
  ctx: WrapLlmHooksOptions,
  buffers: StreamHookBuffers,
): StreamCallbacks {
  const { scope, emitter, sessionId, agentId, agentName, onRawTextChunk, logToolCall } = ctx;
  const scopeCtx = { sessionId, agentId, agentName };

  const onText = (text: string) => {
    buffers.textBuffer.append(text);
    if (onRawTextChunk) onRawTextChunk(text);
  };

  const onThinking = (thinking: string) => {
    buffers.thinkingBuffer.append(thinking);
  };

  const onToolCall = (tc: ToolCall) => {
    if (logToolCall) logToolCall(tc.function.name);
    emitScoped(emitter, scope, scopeCtx, 'tool_call', {
      tool: tc.function.name,
      input: tc.function.arguments,
      callId: tc.id,
    });
  };

  const onToolCallDelta = (delta: ToolCallDeltaInfo) => {
    // Leader-only: 首次收到某工具的 delta 时 emit phase_change 让前端显示人类友好文案
    if (scope === 'leader' && delta.name) {
      safeEmit(emitter, 'leader:phase_change', { sessionId, phase: 'streaming', streamingToolName: delta.name });
    }
    emitScoped(emitter, scope, scopeCtx, 'tool_call_delta', {
      index: delta.index,
      callId: delta.id,
      tool: delta.name,
      partialJson: delta.partialJson,
    });
  };

  const onProgress = (progress: { elapsed: number; status: string }) => {
    emitScoped(emitter, scope, scopeCtx, 'status', { status: progress.status });
  };

  const onRetry = (attempt: number, error: Error) => {
    const classified = classifyLLMError(error);
    // 重试前 reset 流缓冲：与前端 canonical *_llm_retry 处理保持一致，
    // 否则下次 attempt 会拼到半截 assistant 消息前面。
    buffers.resetAll();
    // Leader-only: 推 phase_change=retrying
    if (scope === 'leader') {
      safeEmit(emitter, 'leader:phase_change', { sessionId, phase: 'retrying' });
    }
    emitScoped(emitter, scope, scopeCtx, 'llm_retry', {
      attempt,
      message: classified.message,
      errorKind: classified.llmErrorKind,
      retryable: classified.retryable,
    });
    emitScoped(emitter, scope, scopeCtx, 'status', {
      status: `LLM ${formatLLMErrorLabel(classified)}，第 ${attempt} 次重试: ${classified.message}`,
    });
  };

  const onFirstToken = () => {
    if (scope === 'leader') {
      safeEmit(emitter, 'leader:phase_change', { sessionId, phase: 'streaming' });
    }
    // Worker 不需要推 phase_change（前端通过 agent:text_chunk 感知）
  };

  return { onText, onThinking, onToolCall, onToolCallDelta, onProgress, onRetry, onFirstToken };
}
