/**
 * RetryEngine — LLM 重试引擎
 *
 * Canonical provider-attempt retry primitive. LlmGuard owns cross-attempt
 * orchestration; retryProviderOperation uses this class for the single provider
 * attempt wrapper and CircuitBreaker accounting.
 *
 * 实现：
 * - 循环步长退避（500/1000/2000ms 循环）
 * - Retry-After 头尊重（通过 RetryableError.retryAfterMs，由 classifyLLMError 解析）
 */

import { classifyLLMError } from './errors.js';
import { sleep } from '../utils/sleep.js';

const DEBUG_LLM_RETRY = process.env.LINGXIAO_DEBUG_LLM_RETRY === '1';

/**
 * 重试配置
 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 循环步长序列 ms，按 attempt % steps.length 循环取值 */
  steps: number[];
  /** 最大延迟 ms（仅对 Retry-After 头生效的上限） */
  maxDelayMs: number;
}

/**
 * 默认 0.5-1-2s 循环重试配置
 *
 * 设计理由：
 * - 固定步长循环（0.5→1→2→0.5→1→2…）让瞬时网络抖动快速恢复
 * - 无指数爆炸：最坏情况 N 次重试 ≤ ~3.5×ceil(N/3)s 总等待
 * - Retry-After 头仍然优先，服务端明确告知等待时间时尊重
 *
 * 注 (2026-05-29)：maxRetries 默认与 LLM.MAX_RETRIES 对齐为 5。实际 provider
 * generator 调用显式传 maxRetries=0，让 LlmGuard 作为跨 attempt 重试权威；
 * 其他直接调用方可显式选择本地 retry 预算。
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  steps: [500, 1000, 2000],
  maxDelayMs: 60000,
};

/**
 * 重试回调
 */
export interface RetryCallbacks {
  /** 重试前调用 */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** 最终失败时调用 */
  onError?: (error: Error) => void;
  /** 日志前缀 */
  logPrefix?: string;
}

/**
 * 可重试错误上下文
 */
export interface RetryableError extends Error {
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

/**
 * 计算循环步长退避延迟（叠加 ±20% full-jitter）
 *
 * 按 steps 数组循环取值：attempt 0→steps[0], 1→steps[1], 2→steps[2], 3→steps[0], ...
 *
 * jitter：在 base 基础上乘以 [0.8, 1.2) 的随机系数，打散多 agent 并发重试的
 * 同步化，避免固定步长形成 mini 雪崩。范围 = base*(0.8 + random*0.4)。
 * 注：Retry-After 头路径在 calculateDelay 中直接 return，不经过本函数，
 * 服务端明确告知的等待时间保持原样不抖动。
 */
export function calculateBackoff(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const steps = config.steps;
  const base = steps[attempt % steps.length];
  const jittered = base * (0.8 + Math.random() * 0.4);
  return Math.min(jittered, config.maxDelayMs);
}

/**
 * RetryEngine 类
 *
 * 封装 provider-attempt 重试状态和策略。
 */
export class RetryEngine {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * 执行带重试的操作
   */
  async execute<T>(
    operation: () => Promise<T>,
    callbacks?: RetryCallbacks,
  ): Promise<T> {
    const logPrefix = callbacks?.logPrefix || '[RetryEngine]';

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const classified = this.classifyError(error);

        // 不可重试错误，立即失败
        if (!classified.retryable) {
          callbacks?.onError?.(classified);
          throw classified;
        }

        // 达到最大重试次数
        if (attempt >= this.config.maxRetries) {
          callbacks?.onError?.(classified);
          throw classified;
        }

        // 计算延迟
        const delayMs = this.calculateDelay(attempt, classified);

        // 回调通知
        callbacks?.onRetry?.(attempt + 1, classified, delayMs);
        if (DEBUG_LLM_RETRY) {
          console.warn(`${logPrefix}，第 ${attempt + 1} 次重试 (${delayMs}ms): ${classified.message}`);
        }

        // 等待后重试
        await sleep(delayMs);
      }
    }

    throw new Error('RetryEngine exhausted unexpectedly');
  }

  /**
   * 分类错误
   */
  private classifyError(error: unknown): RetryableError {
    // 已经是可重试错误
    if (error instanceof Error && 'retryable' in error) {
      return error as RetryableError;
    }

    // 使用现有分类
    const classified = classifyLLMError(error, {});
    return Object.assign(classified, {
      retryable: classified.retryable !== false,
    }) as RetryableError;
  }

  /**
   * 计算退避延迟
   *
   * 优先级: Retry-After 头 > 循环步长
   */
  private calculateDelay(attempt: number, error: RetryableError): number {
    // 1. Retry-After 头优先（服务端明确告知等待时间）
    if (error.retryAfterMs && error.retryAfterMs > 0) {
      return Math.min(error.retryAfterMs, this.config.maxDelayMs);
    }

    // 2. 循环步长
    return calculateBackoff(attempt, this.config);
  }
}
