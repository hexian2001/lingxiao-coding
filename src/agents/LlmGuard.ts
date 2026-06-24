/**
 * LlmGuard — 统一 LLM 调用守卫
 *
 * 封装 Leader 和 Agent 共用的 LLM 错误处理逻辑：
 * - 重试循环（最多 maxRetries 次）
 * - 错误分类（classifyError）
 * - backoff 退避（backoffBaseMs × attempt，封顶 maxBackoffMs）
 * - stop() 可中断当前调用
 *
 * 设计约束：**不修改消息内容**。thinking-mode 服务端要求原样回传
 * thinking/reasoning 字段；任何"剥离 reasoning 再重试"的策略都违反协议，
 * 反而把可修复的 400 永久化。错误处理只做重试 + 分类 + 退避。
 */

import { config as runtimeConfig } from '../config.js';
import { LLM } from '../config/defaults.js';
import { classifyLLMError, formatLLMErrorLabel, LLMError, type LLMErrorKind } from '../llm/errors.js';
import { getCircuitBreaker, CircuitOpenError } from '../llm/CircuitBreaker.js';
import type { ChatMessage, ChatResponse, StreamCallbacks, ToolDefinition } from '../llm/types.js';
import type { ContentGenerator, GenerateContentParams } from '../llm/ContentGenerator.js';
import { coreLogger } from '../core/Log.js';
import { getModelGateway, type GatewayRequestContext, type GatewayTrace } from '../llm/ModelGateway.js';
import { globalTracer, type Span } from '../core/Tracing.js';
import { langfuseIntegration } from '../core/LangfuseIntegration.js';
import { llmLatencyMs, llmRequestsTotal, llmTokensUsed } from '../core/Metrics.js';
import { supportsThinking } from '../llm/model_capabilities.js';
import { estimateTokens, countMessagesTokens } from '../llm/token_counter.js';
import { contentToPlainText, thinkingBlocksToText } from '../llm/types.js';

/**
 * 流式中断类错误：generator 中途因超时/网络断开，已累积非空 partial content。
 * 这类错误的重试值得把 partial 作为 assistant prefill 续写后半截，而非从头重新生成。
 */
const STREAM_INTERRUPT_KINDS = new Set<LLMErrorKind>([
  'request_timeout',
  'connect_timeout',
  'stream_timeout',
  'stream_idle_abort',
  'network_error',
]);

/**
 * 续写指令：与 BaseAgentRuntime.evaluateContinuation / LeaderThinkingLoop 同一文案。
 * 模型把 messages 末尾的 assistant 半截当作已输出，接着写未完成部分。
 */
const CONTINUATION_PROMPT = '请基于当前上下文接续未完成部分，已输出内容用承接方式处理。';

/**
 * Per-attempt hang watchdog 缓冲（毫秒）。
 *
 * SDK 的 request_timeout_s（默认 180s）是第一道权威 hang 兜底——provider 真卡住时它会在 180s
 * 抛 request/stream timeout，LlmGuard 正常 recycle+重试。watchdog 只兜底「SDK timeout 失效」盲区：
 * provider 建连后 socket 悬停、既不返回也不抛错（SDK/undici 的 timeout 配置 bug、代理半开连接等）。
 * 阈值 = SDK timeout + 60s buffer，让 SDK 先生效——正常调用 (<180s) SDK timeout 先抛，watchdog
 * 永不误杀；只有 SDK timeout 失效时 watchdog 在 SDK+60s 兜底 abort。触发后当 stream_timeout 走
 * recycle+重试（换连接池），连续 hang 由 retryCount 封顶。
 *
 * 已知边界（进程内不可解）：若 SDK 同步阻塞 event loop（现代 async SDK 不会），setTimeout tick
 * 不触发、watchdog 失效。worker 进程此场景由父进程 90s 心跳超时兜底；Leader 主进程无独立兜底。
 */
const HANG_WATCHDOG_BUFFER_MS = 60_000;
const HANG_WATCHDOG_REASON =
  'LlmGuard hang watchdog: per-attempt exceeded SDK timeout + buffer (SDK timeout likely ineffective)';
const HANG_CLASSIFIED_ERROR = new LLMError(
  'stream_timeout',
  'per-attempt hang watchdog 超时：SDK request_timeout 未生效，连接疑似悬停（已回收连接池并重试）',
  { classifiedBy: 'none' },
);

/**
 * 首 token 超时常量：provider 建连后未在阈值内输出任何 token 时触发。
 * 分类为 stream_timeout（可重试），触发 recycle + 重试。
 */
const FIRST_TOKEN_TIMEOUT_REASON =
  'LlmGuard first-token timeout: no token received within threshold';
const FIRST_TOKEN_CLASSIFIED_ERROR = new LLMError(
  'stream_timeout',
  '首 token 超时：provider 建连后未在阈值内输出任何 token（可能排队中或内部思考过长）',
  { classifiedBy: 'none' },
);

export type LlmGuardGenerateOptions = Pick<GenerateContentParams, 'maxTokens' | 'sampling'>;

export interface LlmGuardOptions {
  /** 调用方标签，用于日志输出（如 'Leader', 'Agent-xxx'） */
  actorLabel: string;
  /** Langfuse trace 上下文：sessionId，用于按会话分组 trace */
  langfuseSessionId?: string;
  /** Langfuse trace 上下文：agentId，用于按 agent 过滤 */
  langfuseAgentId?: string;
  /** Langfuse trace 上下文：taskId，关联当前任务 */
  langfuseTaskId?: string;
  /** 最大重试次数（默认 LLM.MAX_RETRIES = 5） */
  maxRetries: number;
  /** 退避基数毫秒（默认 LLM.BACKOFF_BASE_MS = 2000） */
  backoffBaseMs: number;
  /** 最大退避毫秒（默认 60_000，防止 backoff 无限增长） */
  maxBackoffMs: number;
  /** 错误分类函数（默认使用 classifyLLMError） */
  classifyError?: (error: unknown) => LLMError;
  /** 重试回调 */
  onRetry?: (attempt: number, error: LLMError) => void;
  /** 最终错误回调 */
  onError?: (error: LLMError) => void;
  /**
   * CircuitBreaker 拆分维度 (2026-05-28)：
   *   'leader' / 'agent' / 'conclude' / 'probe' / 'shared'。
   * 默认 'shared'，与 retryProviderOperation 同 CB；不同 scope 之间互不干扰，
   * 防止 Leader 一路失败把 agent 的 HALF_OPEN 探针机会抢光。
   */
  cbScope?: string;
  /**
   * 连续 unknown_error 达到重试上限时触发。实现方应执行上下文压缩（compact），
   * 清理可能的上下文碎片化/污染，然后 LlmGuard 会 reset 计数器给最后一次重试机会。
   */
  onCompactNeeded?: () => Promise<void>;
  /**
   * per-attempt hang watchdog 阈值（毫秒）。默认 = SDK request_timeout + 60s buffer。
   * 可注入小值用于测试。watchdog 只在 SDK timeout 失效（连接悬停不抛错）时兜底，
   * 触发后当 stream_timeout recycle+重试（不当用户中断）。
   */
  hangTimeoutMs?: number;
  /** 首 token 超时（毫秒），非 thinking 模型。默认从 config 读取。 */
  firstTokenTimeoutMs?: number;
  /** 首 token 超时（毫秒），thinking 模型。默认从 config 读取。 */
  firstTokenThinkingTimeoutMs?: number;
}

export class LlmGuard {
  private readonly actorLabel: string;
  private readonly langfuseSessionId?: string;
  private readonly langfuseAgentId?: string;
  private readonly langfuseTaskId?: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly classifyFn: (error: unknown) => LLMError;
  private readonly onRetry?: (attempt: number, error: LLMError) => void;
  private readonly onError?: (error: LLMError) => void;
  private readonly onCompactNeeded?: () => Promise<void>;
  private readonly cbScope: string;
  private readonly hangTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly firstTokenThinkingTimeoutMs: number;

  /**
   * AbortController 收敛 (2026-05-26)：
   *
   * 历史：每个 retry attempt 都 new 一个 AbortController + 转发 caller signal。
   *      实际只是把 caller signal 透传给底层，per-attempt controller 没增加任何能力，
   *      反而把 abort 链路从 [caller signal → fetch.signal] 拉长成
   *      [caller signal → 转发 listener → callController → fetch.signal]，
   *      容易在 listener 注册/删除路径上漏掉清理（旧实现里有过 once 注册 + 多次 catch 的死锁面）。
   *
   * 现在：LlmGuard 只持有一个长生命周期 stopController（仅 stop() 时 abort 它，
   *      平时不参与 abort）。caller signal 与 stopController.signal 通过 AbortSignal.any
   *      合一为 mergedSignal，直接透传给 ContentGenerator。retry 之间不再 new
   *      controller。这样从 caller 视角只有一条 abort 通道：
   *        1. 外部 caller signal （用户 ESC / agent stop / leader 干预）
   *      stopController 仅用于 LlmGuard.stop() API 兼容（测试 + 极少实际调用）。
   *
   *      2026-05-27：应用层 stream chunk timeout 已废除，不再有内部 timeoutGuard
   *      参与 abort；SDK 自身的 request timeout 是唯一权威 hang 兜底。
   */
  private readonly stopController = new AbortController();
  private retryCount = 0;
  private compactFired = false;
  /**
   * history 已被抛弃过一次的标记。true → 下一轮不可重试错误直接放弃，
   * 避免在恶性请求上 compact → 抛历史 → compact → 抛历史 无限循环。
   * 流程：compact 阶段 1 → history 阶段 2 → 仍失败 阶段 3 抛。
   */
  private historyDiscarded = false;

  constructor(options: LlmGuardOptions) {
    this.actorLabel = options.actorLabel;
    this.langfuseSessionId = options.langfuseSessionId;
    this.langfuseAgentId = options.langfuseAgentId;
    this.langfuseTaskId = options.langfuseTaskId;
    this.maxRetries = options.maxRetries;
    this.backoffBaseMs = options.backoffBaseMs;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.classifyFn = options.classifyError ?? classifyLLMError;
    this.onRetry = options.onRetry;
    this.onError = options.onError;
    this.onCompactNeeded = options.onCompactNeeded;
    this.cbScope = options.cbScope ?? 'shared';
    this.hangTimeoutMs = options.hangTimeoutMs
      ?? runtimeConfig.llm.request_timeout_s * 1000 + HANG_WATCHDOG_BUFFER_MS;
    this.firstTokenTimeoutMs = options.firstTokenTimeoutMs
      ?? runtimeConfig.llm.first_token_timeout_s * 1000;
    this.firstTokenThinkingTimeoutMs = options.firstTokenThinkingTimeoutMs
      ?? runtimeConfig.llm.first_token_timeout_thinking_s * 1000;
  }

  /**
   * 执行 LLM 调用（含重试逻辑）
   */
  async call(
    llm: ContentGenerator,
    messages: ChatMessage[],
    model: string,
    tools?: ToolDefinition[],
    streamingEnabled?: boolean,
    signal?: AbortSignal,
    /** 可选：透传给底层 LLM 调用的流式回调（onText/onThinking/onToolCall 等） */
    hooks?: StreamCallbacks,
    gatewayContext?: GatewayRequestContext,
    generateOptions?: LlmGuardGenerateOptions,
  ): Promise<ChatResponse> {
    const useStreaming = streamingEnabled ?? true;
    const gateway = getModelGateway();
    const decision = gateway.decide({
      actorLabel: this.actorLabel,
      requestedModel: model,
      ...gatewayContext,
    });
    const trace = gateway.createTrace({ actorLabel: this.actorLabel, requestedModel: model, ...gatewayContext }, decision);
    let currentModel = decision.selectedModel || model;
    const failedModels = new Set<string>();
    const llmSpan = globalTracer.startSpan('llm.call', globalTracer.currentSpan()?.context, {
      actor: this.actorLabel,
      model: currentModel,
      streaming: useStreaming,
    });
    const callStartedAt = Date.now();
    llmRequestsTotal.inc({ actor: this.actorLabel, model: currentModel });

    // caller signal × stopController 合并为单一 abort 通道。
    // 任一被 abort 都视作 "aborted by caller"，retry 循环一次性退出。
    const mergedSignal: AbortSignal = signal
      ? AbortSignal.any([signal, this.stopController.signal])
      : this.stopController.signal;

    // 续写状态（跨 retry 累积）：
    //   accumulatedPrefix — 已抢救的累积 partial（多次 stream-interrupt 拼接）
    //   continuationInjectedCount — 当前临时注入 messages 末尾的 prefill 消息条数，用于回滚
    let accumulatedPrefix = '';
    let continuationInjectedCount = 0;
    const rollbackContinuation = (): void => {
      if (continuationInjectedCount > 0) {
        messages.splice(messages.length - continuationInjectedCount, continuationInjectedCount);
        continuationInjectedCount = 0;
      }
    };

    while (true) {
      // 调用前先检查合并后的 abort 状态：caller / stop() 任一已触发就立即退出，不消耗 retryCount。
      if (mergedSignal.aborted) {
        this.finishLlmSpan(llmSpan, 'error', currentModel, callStartedAt, 'aborted', undefined, messages);
        throw new Error('LLM call aborted by caller');
      }

      // ── per-attempt hang watchdog ──
      // 独立 hangController 与 caller/stop 的 mergedSignal 分离：hang 只 abort attemptSignal，
      // 不污染 mergedSignal。上层 catch 据此区分「用户中断」(mergedSignal.aborted → aborted 退出)
      // 与「hang 超时」(hangController.signal.aborted → 当 stream_timeout 走 recycle+重试)。
      // 若混用同一 signal，hang 会被误判为用户 ESC → 上层 break/repeat 跳过 recycle 重试。
      const hangController = new AbortController();
      const firstTokenController = new AbortController();
      const attemptSignal: AbortSignal = AbortSignal.any([mergedSignal, hangController.signal, firstTokenController.signal]);
      const hangTimer = setTimeout(
        () => hangController.abort(new Error(HANG_WATCHDOG_REASON)),
        this.hangTimeoutMs,
      );
      hangTimer.unref?.();

      // ── per-attempt first-token watchdog (streaming only) ──
      // provider 建连后若在阈值内未发出任何 token，大概率是排队/内部思考过长/隐性 hang。
      // abort 当前 attempt 并按 stream_timeout 重试。thinking 模型用更长的阈值。
      // 非流式请求无 "首 token" 概念，由 SDK timeout + hang watchdog 兜底。
      const isThinkingModel = supportsThinking(currentModel);
      const firstTokenTimeoutMs = isThinkingModel
        ? this.firstTokenThinkingTimeoutMs
        : this.firstTokenTimeoutMs;
      let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
      if (useStreaming) {
        firstTokenTimer = setTimeout(
          () => firstTokenController.abort(new Error(FIRST_TOKEN_TIMEOUT_REASON)),
          firstTokenTimeoutMs,
        );
        firstTokenTimer.unref?.();
      }

      let response: ChatResponse;
      const attemptStartedAt = Date.now();
      const attempt = gateway.startAttempt(trace, currentModel);
      // PR3.3: CircuitBreaker 接入流式主路径。每个 attempt 都按当前 model 重新取 providerKey，
      // fallback 到其它 provider/model 时熔断状态随之切换。
      const providerKey = llm.getProviderKey?.(currentModel) ?? null;
      const cb = providerKey ? getCircuitBreaker(providerKey, this.cbScope) : null;
      try {
        // CircuitBreaker 检查：OPEN 状态直接 fast-fail（不消耗 retryCount）
        cb?.beforeRequest();

        const attemptStreaming = useStreaming;
        const callbacks: StreamCallbacks = attemptStreaming
          ? {
              onText: hooks?.onText,
              onThinking: hooks?.onThinking,
              onToolCall: hooks?.onToolCall,
              onToolCallDelta: hooks?.onToolCallDelta,
              onUsage: hooks?.onUsage,
              onProgress: hooks?.onProgress,
              onFirstToken: () => {
                if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = undefined; }
                hooks?.onFirstToken?.();
              },
              onRetry: this.onRetry
                ? (attempt: number, error: unknown) => this.onRetry!(attempt, this.classifyFn(error))
                : hooks?.onRetry,
              onError: this.onError
                ? (error: unknown) => this.onError!(this.classifyFn(error))
                : hooks?.onError,
            }
          : {
              onUsage: hooks?.onUsage,
              onRetry: this.onRetry
                ? (attempt: number, error: unknown) => this.onRetry!(attempt, this.classifyFn(error))
                : hooks?.onRetry,
              onError: this.onError
                ? (error: unknown) => this.onError!(this.classifyFn(error))
                : hooks?.onError,
            };

        if (attemptStreaming) {
          response = await llm.generateContentWithCallbacks({
            messages,
            model: currentModel,
            tools,
            signal: attemptSignal,
            ...generateOptions,
          }, callbacks);
        } else {
          response = await llm.generateContent({
            messages,
            model: currentModel,
            tools,
            signal: attemptSignal,
            ...generateOptions,
          });
        }

        // 成功 → CircuitBreaker 标记成功 + 返回
        cb?.onSuccess();
        clearTimeout(hangTimer);
        if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = undefined; }
        gateway.finishAttempt(attempt, { status: 'success' });
        // 续写拼接：把中断时抢救的累积 partial 前缀拼到本轮 response 前，组成完整内容。
        // 同时回滚临时注入的 prefill 消息——messages 回到调用方传入的原始状态，
        // 由上层 processResponse 把完整 content 当作本轮 assistant 输出正常入栈
        // （避免 partial 与完整 content 在 messages 中重复）。
        if (accumulatedPrefix) {
          response = { ...response, content: accumulatedPrefix + (response.content ?? '') };
        }
        rollbackContinuation();
        response.gateway = this.summarizeGatewayTrace(trace);
        this.finishLlmSpan(llmSpan, 'ok', currentModel, callStartedAt, undefined, response, messages);

        return response;
      } catch (error) {
        // 任何 catch 入口先 disarm hang watchdog + first-token watchdog（覆盖所有 continue/throw 出口）
        clearTimeout(hangTimer);
        if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = undefined; }
        // 再回滚上一轮续写注入的 prefill，保持 messages 干净
        // （aborted / CircuitOpen / compact / 续写再中断 等所有出口都不会残留注入消息）
        rollbackContinuation();

        // CircuitOpenError：CB 主动拒绝（不消耗 retryCount）
        // 语义与 timeout 路径对齐——CB OPEN 说明当前 socket 池/连接已经连续失败 8 次，
        // 旧 client + keep-alive socket 不可信，必须先 recycle 销毁再走 fallback。
        // 此前只 fallback 不 recycle：新 client 复用同一组病态 socket，fallback 模型
        // 也会立刻被同一根因打死，体感"卡死"。recycle 之后新 fallback 用全新连接池，
        // 如果根因是网络/握手级问题，重试有机会成功。
        if (error instanceof CircuitOpenError) {
          gateway.finishAttempt(attempt, {
            status: 'failed',
            errorKind: 'circuit_open',
            errorMessage: error.message,
            retryable: true,
          });
          failedModels.add(currentModel);

          // 与 timeout 路径一致的 recycle：换连接池，不重置 CB（CB 计数必须累积，
          // 否则阈值永远到不了——见下方 timeout 分支的"不重置 CircuitBreaker"注释）。
          try {
            llm.recycle?.();
            coreLogger.warn(
              `[LlmGuard:${this.actorLabel}] circuit open retry=${this.retryCount + 1} → recycled LLM client (fresh socket pool, CB count preserved) provider="${providerKey ?? '?'}"`,
            );
          } catch (recycleErr) {
            coreLogger.warn(
              `[LlmGuard:${this.actorLabel}] recycle 调用失败（已忽略）: ${recycleErr instanceof Error ? recycleErr.message : String(recycleErr)}`,
            );
          }

          const fallback = gateway.pickFallback(trace, failedModels);
          if (fallback && !mergedSignal.aborted && trace.attempts.length < this.maxRetries) {
            currentModel = fallback;
            hooks?.onRetry?.(this.retryCount, this.classifyFn(error));
            coreLogger.warn(`[LlmGuard:${this.actorLabel}] circuit open → fallback model="${fallback}"`);
            continue;
          }
          gateway.failTrace(trace);
          this.onError?.(this.classifyFn(error));
          this.finishLlmSpan(llmSpan, 'error', currentModel, callStartedAt, 'circuit_open', undefined, messages);
          this.attachGatewayTrace(error, trace);
          throw error;
        }

        // caller / stop() 已触发 → 不要再重试，直接抛 aborted
        if (mergedSignal.aborted) {
          this.finishLlmSpan(llmSpan, 'error', currentModel, callStartedAt, 'aborted', undefined, messages);
          const abortedError = new Error('LLM call aborted by caller');
          this.attachGatewayTrace(abortedError, trace);
          throw abortedError;
        }

        // hang watchdog 或 first-token watchdog 触发（attemptSignal 被 hangController/firstTokenController abort，但非用户中断）→ 当 stream_timeout：
        // recycle 换连接池 + 重试。用户中断已由上方 mergedSignal.aborted 分支拦截，不会落到这里。
        // 否则 SDK 因 attemptSignal abort 抛出的 AbortError 会被 classifyFn 判 unknown_error → hang 沦为不可重试。
        const classified = hangController.signal.aborted
          ? HANG_CLASSIFIED_ERROR
          : firstTokenController.signal.aborted
            ? FIRST_TOKEN_CLASSIFIED_ERROR
            : this.classifyFn(error);
        // unknown_error 不再强制可重试：分类器已对结构可识别的错误（4xx auth/quota/context、
        // 5xx、timeout、network）给出明确判定，残留的 unknown 多为不可恢复的致命错（代理返回
        // HTML、"model not found" 怪信封等），盲目重试纯浪费预算。unknown 的恢复路径改为
        // 「compact 一次给最后一次机会」（见下方 non-retryable 分支），而非烧光重试预算。
        // CircuitBreaker 计入失败：仅 retryable 才推进 CB 状态
        cb?.onFailure(classified.retryable);
        gateway.finishAttempt(attempt, {
          status: 'failed',
          errorKind: classified.llmErrorKind,
          errorMessage: classified.message,
          retryable: classified.retryable,
        });
        // 消息内容在此不做任何修改：thinking / reasoning 是协议语义必需字段。

        // === 强信号 recycle：超时 / 连接错误 / 网络断开 / 空流 / 空响应 —
        // 老 client 与底层 socket 已不可信，立刻 recycle 销毁旧 SDK client + undici Agent
        // （连带回收所有 keep-alive socket），下一次重试用全新连接池。
        //
        // 但 **不重置 CircuitBreaker**：recycle 只换连接池，CB 的失败计数必须累积——
        // 否则每次超时都被清零、阈值永远到不了、CB 永不熔断，挂起的 provider 会反复重试
        // ~180s×预算 直到烧光（历史回归）。CB 只在半开探测成功后由其内部复位。
        //
        // recycle 后 CB 不需要手动 reset：HALF_OPEN 探针使用的是 recycle 后的新 client，
        // 如果 provider 已恢复，探针成功 → onSuccess() → CB CLOSED；如果仍不可用，探针失败
        // → CB 重新 OPEN。这正是 CircuitBreaker 设计的预期行为。
        //
        // 历史 bug：此前在 recycle 后调用 resetCircuitBreakersForProvider，导致 CB 失败计数
        // 每次都被清零，FAILURE_THRESHOLD(8) 永远到不了，CB 形同虚设。provider 挂起时
        // 系统反复跑完整超时预算（最坏 9×180s=27min），前端/TUI/后端全部表现为卡死。
        //
        // 空流 / 空响应（provider 返回 200 但 body 全空）已在 errors.ts 归入 network_error。
        // 抖动靠 backoff（±20% jitter）+ CircuitBreaker 控制即可。
        if (
          classified.llmErrorKind === 'request_timeout' ||
          classified.llmErrorKind === 'connect_timeout' ||
          classified.llmErrorKind === 'stream_timeout' ||
          classified.llmErrorKind === 'network_error'
        ) {
          try {
            llm.recycle?.();
            const trigger = firstTokenController.signal.aborted ? 'first-token-timeout' : classified.llmErrorKind;
            coreLogger.warn(
              `[LlmGuard:${this.actorLabel}] ${trigger} retry=${this.retryCount + 1} → recycled LLM client (fresh socket pool, CB count preserved) provider="${providerKey ?? '?'}"`,
            );
          } catch (recycleErr) {
            coreLogger.warn(
              `[LlmGuard:${this.actorLabel}] recycle 调用失败（已忽略）: ${recycleErr instanceof Error ? recycleErr.message : String(recycleErr)}`,
            );
          }
        }

        // === 超时类错误：不重试，直接抛出 ===
        // 上层 catch 据此走 ESC 中断 + 重新请求语义（continue/repeat），而非 LlmGuard 内部重试。
        // CircuitBreaker 已在上方 onFailure 累积失败计数，持续超时最终熔断走 CircuitOpenError 停下。
        // network_error 仍走重试（网络抖动重试合理）；超时意味着 provider 卡住，重试同上下文无意义。
        if (
          classified.llmErrorKind === 'request_timeout' ||
          classified.llmErrorKind === 'connect_timeout' ||
          classified.llmErrorKind === 'stream_timeout'
        ) {
          this.onError?.(classified);
          gateway.failTrace(trace);
          this.finishLlmSpan(llmSpan, 'error', currentModel, callStartedAt, classified.llmErrorKind, undefined, messages);
          const timeoutError = this.buildFinalError(classified, 'timeout_no_retry', accumulatedPrefix);
          this.attachGatewayTrace(timeoutError, trace);
          throw timeoutError;
        }

        // ── 续写抢救：stream-interrupt 类错误 + 非空 partial → 注入 assistant prefill 续写 ──
        const partialText = classified.partialAssistantContent?.content?.trim() ?? '';
        const continueFromPartial =
          partialText.length > 0 &&
          STREAM_INTERRUPT_KINDS.has(classified.llmErrorKind) &&
          classified.retryable;

        this.retryCount++;
        failedModels.add(currentModel);

        if (continueFromPartial) {
          // 累积 prefix（多次中断拼接），注入 [assistant:prefix, user:续写] 作为 prefill。
          // 模型接着半截续写后半截；UI 已渲染的 partial 保留（不发 onStreamRetry）。
          accumulatedPrefix += partialText;
          messages.push({ role: 'assistant', content: accumulatedPrefix });
          messages.push({ role: 'user', content: CONTINUATION_PROMPT });
          continuationInjectedCount = 2;
          coreLogger.info(
            `[LlmGuard:${this.actorLabel}] stream interrupted with partial (${partialText.length} chars, total prefix ${accumulatedPrefix.length}) → continuation retry ${this.retryCount}`,
          );
        } else if (accumulatedPrefix) {
          // 本轮非续写（partial 空或非 stream-interrupt）：清空累积，后续重试从头
          accumulatedPrefix = '';
        }

        if (classified.retryable) {
          const fallback = gateway.pickFallback(trace, failedModels);
          if (fallback && this.retryCount < this.maxRetries) {
            currentModel = fallback;
            this.onRetry?.(this.retryCount, classified);
            hooks?.onRetry?.(this.retryCount, classified);
            // 仅"从头重试"才通知 UI 丢弃部分输出；续写路径保留 partial
            if (!continueFromPartial) {
              hooks?.onStreamRetry?.(this.retryCount, classified);
            }
            coreLogger.warn(
              `[LlmGuard:${this.actorLabel}] ${classified.llmErrorKind} after ${Date.now() - attemptStartedAt}ms → fallback model="${fallback}"`,
            );
            continue;
          }
        }

        // PR3.4：流式超时不再降级为非流式。
        // SDK 总超时是唯一权威，超时本身意味着 provider 真的卡住，
        // 切到非流式只是把同样的等待包成另一种调用形态，不能解决问题。
        // 直接走通用 retryCount，让 retry 预算+CircuitBreaker 控制总等待。

        // 通知上层丢弃已渲染的部分输出（仅从头重试路径；续写路径已在上方 continueFromPartial 分支跳过）
        if (classified.retryable && this.retryCount < this.maxRetries && !continueFromPartial) {
          hooks?.onStreamRetry?.(this.retryCount, classified);
        }

        // === 不可重试错误：默认立即终止 ===
        // 通用兜底：任何 retryable=false 的错误都应先尝试 compact（清理可能的
        // 消息格式污染/上下文碎片化），而不是直接抛。原实现仅对 unknown_error
        // 和 400 provider_error 启 compact，对 auth_error/quota_exhausted/
        // context_overflow/parse_error（malformed tool args）等"未兜底"错误
        // 直接抛，结果是编排层被这些错误卡死（rework、log 出 "被拒绝"，跟
        // 上面的 RepairLimitReached 一起把任务拉成未定义状态）。
        //
        // 两段式恢复：
        //   1) 第一次任何非可重试错误 → onCompactNeeded() 清理上下文后重试
        //   2) 第二次仍非可重试（compact 后仍裸）→ 抛弃历史：messages 仅留
        //      system + 最后一轮 user，清空 accumulatedPrefix、contination 注入
        //      和 toolCall 残留，last-ditch 重试
        //   3) 第三次还失败 → 放弃（避免在恶性请求上无限循环）
        //
        // 例外：context_overflow 和 quota_exhausted 本身就是 "压缩/减量" 问题
        // 的提示，只走 compact 路径，不走 "抛历史"，避免浪费一次抛弃重置。
        if (!classified.retryable) {
          const isOverflowOrQuota =
            classified.llmErrorKind === 'context_overflow' ||
            classified.llmErrorKind === 'quota_exhausted';
          const isAuthFatal =
            classified.llmErrorKind === 'auth_error' && this.compactFired;
          // parse_error 是消息格式/协议错误（如 TOOL_USE_RESULT_MISMATCH、malformed args），
          // 压缩不会修复格式问题，反而会破坏消息序列结构，直接抛出。
          const isFormatError = classified.llmErrorKind === 'parse_error';
          // auth 错误 compact 一次后仍 auth → 凭证问题不可能靠丢历史恢复
          const isLastResort =
            this.compactFired && !isOverflowOrQuota && !isAuthFatal;

          if (this.onCompactNeeded && !this.compactFired && !isFormatError) {
            // === 阶段 1：compact 清理 ===
            this.compactFired = true;
            this.historyDiscarded = false; // 重置下一阶段状态
            try {
              await this.onCompactNeeded();
              coreLogger.info(
                `[LlmGuard:${this.actorLabel}] ${classified.llmErrorKind} (status=${classified.statusCode ?? '?'}) → compact 完成，给最后一次重试机会`,
              );
            } catch (compactErr) {
              coreLogger.warn(
                `[LlmGuard:${this.actorLabel}] compact 失败: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
              );
            }
            this.retryCount++;
            this.onRetry?.(this.retryCount, classified);
            hooks?.onRetry?.(this.retryCount, classified);
            await this.backoff(this.retryCount, classified.retryAfterMs, mergedSignal);
            continue;
          }

          if (isLastResort) {
            // === 阶段 2：抛弃历史，last-ditch 重试 ===
            this.historyDiscarded = true;
            this.compactFired = true; // 不再走 compact
            // 清空续写前缀：旧 partial 来自被抛弃的历史，保留会污染新一轮
            accumulatedPrefix = '';
            continuationInjectedCount = 0;
            const discardedCount = this.discardHistory(messages, accumulatedPrefix);
            this.retryCount++;
            this.onRetry?.(this.retryCount, classified);
            hooks?.onRetry?.(this.retryCount, classified);
            coreLogger.warn(
              `[LlmGuard:${this.actorLabel}] ${classified.llmErrorKind} (status=${classified.statusCode ?? '?'}) → compact 后仍失败，抛弃 ${discardedCount} 条历史，仅留 system + 最后 user，last-ditch retry=${this.retryCount}`,
            );
            await this.backoff(this.retryCount, classified.retryAfterMs, mergedSignal);
            continue;
          }

          // 阶段 3：抛历史已丢过 / 溢出 / 配额 / 凭证已尝试过 → 放弃
          this.onError?.(classified);
          this.finishLlmSpan(llmSpan, 'error', currentModel, callStartedAt, classified.llmErrorKind, undefined, messages);
          const nonRetryableError = this.buildFinalError(
            classified,
            this.historyDiscarded ? 'history_discarded_still_failed' : 'non_retryable',
            accumulatedPrefix,
          );
          this.attachGatewayTrace(nonRetryableError, trace);
          throw nonRetryableError;
        }

        // === 可重试错误：有限重试，24/7 场景下防止永久阻塞 ===
        if (this.retryCount >= this.maxRetries) {
          this.onError?.(classified);
          gateway.failTrace(trace);
          this.finishLlmSpan(llmSpan, 'error', currentModel, callStartedAt, classified.llmErrorKind, undefined, messages);
          const exhaustedError = this.buildFinalError(classified, `max_retries_exceeded(${this.maxRetries})`, accumulatedPrefix);
          this.attachGatewayTrace(exhaustedError, trace);
          throw exhaustedError;
        }

        // 通知上层"正在第 N 次重试"。两条回调都要触发：
        // - this.onRetry：guard 构造选项（部分调用方用）
        // - hooks.onRetry：wrapLlmHooksForEmitter 提供的 emitter 桥（leader/agent 主路径用此）
        // 历史 bug：generic retryable 路径（request_timeout/network_error 等）此前只调
        // this.onRetry，而 BaseAgent/LeaderThinkingEngine 都没传该构造选项 → 重试期间
        // 零 agent:llm_retry/agent:status 事件 → worker 卡在超时重试循环时 UI 完全静默，
        // 用户"看不到任何告警，不知道是否在请求模型"。改为同时调 hooks.onRetry 后，
        // 每次重试都 emit agent:llm_retry + agent:status，既给 UI 可见反馈，也刷新
        // AgentHealthMonitor 的 lastActivity（让它把 agent 记为"重试中"而非误判活动）。
        this.onRetry?.(this.retryCount, classified);
        hooks?.onRetry?.(this.retryCount, classified);
        await this.backoff(this.retryCount, classified.retryAfterMs, mergedSignal);
      }
    }
  }

  private summarizeGatewayTrace(trace: GatewayTrace): NonNullable<ChatResponse['gateway']> {
    return {
      traceId: trace.traceId,
      profile: trace.decision.profile,
      selectedModel: trace.decision.selectedModel,
      finalModel: trace.finalModel,
      fallbackModels: trace.decision.fallbackModels,
      attempts: trace.attempts.map((attempt) => ({
        model: attempt.model,
        status: attempt.status,
        errorKind: attempt.errorKind,
        errorMessage: attempt.errorMessage,
        retryable: attempt.retryable,
        elapsedMs: attempt.elapsedMs,
      })),
    };
  }

  /**
   * 把 gateway trace 摘要附在抛出的 error 上，使失败路径（recordFailure）也能拿到
   * attempts 明细写入 llm_gateway_requests.attempts_json。成功路径已通过 response.gateway
   * 返回，不走此机制。失败时 4 个 throw 出口统一调用，避免 trace 随 throw 丢失。
   */
  private attachGatewayTrace(error: unknown, trace: GatewayTrace): void {
    if (error && typeof error === 'object') {
      (error as Record<string, unknown>).gatewayTrace = this.summarizeGatewayTrace(trace);
    }
  }

  private finishLlmSpan(
    span: Span,
    status: 'ok' | 'error',
    model: string,
    startedAt: number,
    errorKind?: string,
    response?: ChatResponse,
    messages?: ChatMessage[],
  ): void {
    if (span.endTs !== undefined) return;
    const latencyMs = Date.now() - startedAt;
    span.addAttribute('model', model);
    span.addAttribute('latency_ms', latencyMs);
    if (errorKind) span.addAttribute('error_kind', errorKind);
    const usage = response?.usage;
    // Remote API may not return usage (e.g. some OpenAI-compatible providers),
    // or may return only partial fields (e.g. completion_tokens present but
    // prompt_tokens missing). Previously we only estimated when totalTokens===0,
    // which left promptTokens permanently 0 whenever the provider returned a
    // non-zero completion_tokens but no prompt_tokens → Langfuse Input showed 0.
    // Fix: estimate each missing dimension independently.
    let promptTokens = usage?.prompt_tokens ?? 0;
    let completionTokens = usage?.completion_tokens ?? 0;
    let totalTokens = usage?.total_tokens ?? 0;
    if (promptTokens === 0 && messages) {
      promptTokens = countMessagesTokens(messages);
    }
    if (completionTokens === 0 && response) {
      completionTokens = estimateTokens(contentToPlainText(response.content)) + estimateTokens(thinkingBlocksToText(response.thinking));
      if (response?.tool_calls) {
        for (const tc of response.tool_calls) {
          completionTokens += estimateTokens(tc.function?.arguments ?? '');
        }
      }
    }
    if (totalTokens === 0) {
      totalTokens = promptTokens + completionTokens;
    }
    if (totalTokens > 0) {
      span.addAttribute('prompt_tokens', promptTokens);
      span.addAttribute('completion_tokens', completionTokens);
      span.addAttribute('total_tokens', totalTokens);
      llmTokensUsed.inc({ actor: this.actorLabel, model, kind: 'prompt' }, promptTokens);
      llmTokensUsed.inc({ actor: this.actorLabel, model, kind: 'completion' }, completionTokens);
      llmTokensUsed.inc({ actor: this.actorLabel, model, kind: 'total' }, totalTokens);
    }
    llmLatencyMs.observe({ actor: this.actorLabel, model, status }, latencyMs);
    span.end(status);

    // Langfuse generation span injection (non-fatal on error)
    // recordGeneration is async (must await startActiveObservation internally);
    // fire-and-forget here so the LLM call path stays synchronous.
    langfuseIntegration.recordGeneration({
      model,
      status,
      latencyMs,
      input: messages,
      output: response?.content,
      usage: totalTokens > 0 ? {
        promptTokens,
        completionTokens,
        totalTokens,
      } : undefined,
      errorKind,
      actor: this.actorLabel,
      sessionId: this.langfuseSessionId,
      agentId: this.langfuseAgentId,
      taskId: this.langfuseTaskId,
    }).catch(() => { /* Langfuse tracing errors must never affect LLM call flow */ });
  }

  /**
   * 中断当前 LLM 调用
   *
   * 实现：abort 内部 stopController；mergedSignal 立即转 aborted，底层 ContentGenerator
   * 收到 abort 后抛错，retry 循环出口检查 mergedSignal.aborted → 退出。
   *
   * 注：stopController 一旦 abort 就永久 abort（同一个 LlmGuard 实例不能再 call）。
   * 这与凌霄实际用法一致：每轮 LLM 都 createLlmGuard 一次，不复用。
   */
  stop(): void {
    if (!this.stopController.signal.aborted) {
      this.stopController.abort(new Error('LlmGuard.stop() called'));
    }
  }

  /**
   * 获取当前重试次数
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  private async backoff(attempt: number, retryAfterMs?: number, signal: AbortSignal = this.stopController.signal): Promise<void> {
    // ±20% jitter 打散并发重试：多 agent / 多 worker 同时命中 429/超时时，固定步长会在
    // 同一毫秒集体重发形成 mini 雪崩、再次触发限流。jitter 范围 = base*(0.8 + random*0.4)，
    // 与 RetryEngine.calculateBackoff 同口径。Retry-After 作为下限（服务端明确要求的最短等待）。
    const base = this.backoffBaseMs * attempt;
    const jittered = base * (0.8 + Math.random() * 0.4);
    const delay = Math.min(Math.max(jittered, retryAfterMs ?? 0), this.maxBackoffMs);
    // abort-aware sleep: 用户取消时立即中断而非 sleep 完整时长
    if (signal.aborted) throw new Error('LLM call aborted by caller');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delay);
      const onAbort = () => { clearTimeout(timer); reject(new Error('LLM call aborted by caller')); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private buildFinalError(classified: LLMError, reason: string, accumulatedPrefix?: string): Error {
    const msg = `LLM ${formatLLMErrorLabel(classified)} ${reason} (${this.actorLabel}): ${classified.message}`;
    const error = new Error(msg);
    (error as unknown as Record<string, unknown>).classified = classified;
    (error as unknown as Record<string, unknown>).reason = reason;
    // 附带已抢救的 partial content，让调用方可以注入对话历史而非完全丢失
    if (accumulatedPrefix && accumulatedPrefix.trim()) {
      (error as unknown as Record<string, unknown>).partialContent = accumulatedPrefix;
    }
    return error;
  }

  /**
   * Last-ditch 拋弃历史：仅保留 system prompt + 最后一轮 user 请求，其余全部丢弃。
   *
   * 背景：compact 阶段（onCompactNeeded）是"减量但保留语义"，对于消息格式被
   * 污染 / tool_call id 不匹配 / 中间 system 错位之类问题，compact 后仍会复现。
   * 这种情况下唯一可靠的恢复手段是"上轮上下文不再可信"，重置为最小集。
   *
   * 保留什么 / 丢什么：
   *   - 保留：所有 system（系统提示是角色语义，不该丢）
   *   - 保留：最后一个 user 消息（本轮请求语义必传）
   *   - 丢弃：中间所有 assistant / tool / user，避免历史污染问题重发
   *
   * 改造者注意：messages 是引用型 inout，本函数原地修改。返回值是被丢弃的消息数。
   */
  private discardHistory(messages: ChatMessage[], accumulatedPrefix: string): number {
    const originalLength = messages.length;
    // 重新走一遍：末位 user 为 "keep as last"，其之前反向扫描，第一个出现的 user 即为"最后一轮请求"。
    // 逻辑：扫到最后一个 user 时把它作为锚点；它之前的 assistant/tool/user/system 中，system 保留、其余丢。
    const lastUserIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return i;
      }
      return -1;
    })();

    if (lastUserIdx < 0) {
      // 未找到 user (不可能：Leader/Agent 主路径调用前必填了 user)，但作防御处理
      return 0;
    }

    // 保留所有 system + 最后一个 user
    const kept: ChatMessage[] = [];
    for (let i = 0; i < lastUserIdx; i++) {
      if (messages[i]?.role === 'system') kept.push(messages[i]);
    }
    kept.push(messages[lastUserIdx]);

    // 原地清空中间轮 messages，释放引用，让 GC 回收 toolCall 等大对象
    messages.length = 0;
    for (const m of kept) messages.push(m);

    // 注意：调用方传入的 accumulatedPrefix 是闭包变量，本函数不能直接重置为 ''
    // （需要上层控制 accumulatedPrefix 变量重置），所以本函数只动 messages。
    return originalLength - messages.length;
  }
}

/**
 * 创建 LlmGuard 实例的工厂函数
 */
export function createLlmGuard(options: Partial<LlmGuardOptions> & { actorLabel: string }): LlmGuard {
  const configuredBackoffBaseMs = Number(runtimeConfig.llm?.backoff_base_ms);
  const backoffBaseMs = options.backoffBaseMs
    ?? (Number.isFinite(configuredBackoffBaseMs) && configuredBackoffBaseMs > 0 ? configuredBackoffBaseMs : LLM.BACKOFF_BASE_MS);
  const configuredMaxRetries = Number(runtimeConfig.llm?.max_retries);
  const maxRetries = options.maxRetries
    ?? (Number.isFinite(configuredMaxRetries) && configuredMaxRetries >= 0 ? configuredMaxRetries : LLM.MAX_RETRIES);
  return new LlmGuard({
    actorLabel: options.actorLabel,
    langfuseSessionId: options.langfuseSessionId,
    langfuseAgentId: options.langfuseAgentId,
    langfuseTaskId: options.langfuseTaskId,
    maxRetries,
    backoffBaseMs,
    maxBackoffMs: options.maxBackoffMs ?? Math.max(60_000, backoffBaseMs),
    classifyError: options.classifyError,
    onRetry: options.onRetry,
    onError: options.onError,
    onCompactNeeded: options.onCompactNeeded,
    cbScope: options.cbScope,
    hangTimeoutMs: options.hangTimeoutMs,
    firstTokenTimeoutMs: options.firstTokenTimeoutMs,
    firstTokenThinkingTimeoutMs: options.firstTokenThinkingTimeoutMs,
  });
}
