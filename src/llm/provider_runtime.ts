import { config as runtimeConfig } from '../config.js';
import { LLM } from '../config/defaults.js';
import { t } from '../i18n.js';
import { RetryEngine } from './RetryEngine.js';
import { getCircuitBreaker, CircuitOpenError } from './CircuitBreaker.js';

function llmMaxBackoffMs(): number {
  const configured = Number(runtimeConfig.llm?.backoff_base_ms);
  return Math.max(60_000, Number.isFinite(configured) && configured > 0 ? configured : LLM.BACKOFF_BASE_MS);
}

/**
 * 心跳定时器
 *
 * 用于在非流式 LLM 调用期间提供进度反馈，避免用户感知"卡死"。
 * 启动后每 5s 调用 onProgress 回调，携带已耗时和状态文本。
 */
export interface HeartbeatTimer {
  /** 清理心跳定时器 */
  clear(): void;
  /** 获取辅助回调包装器，可在现有回调中集成心跳重置 */
  helpers(): {
    /** 重置心跳计时器（收到文本时调用） */
    onText?: () => void;
    /** 重置心跳计时器（收到工具调用时调用） */
    onToolCall?: () => void;
  };
}

/**
 * 根据已耗时生成状态文本
 */
function getProgressStatus(elapsedMs: number): string {
  const elapsedSec = Math.round(elapsedMs / 1000);
  if (elapsedSec < 5) {
    return t('progress.connecting');
  } else if (elapsedSec < 15) {
    return t('progress.waiting_response');
  } else {
    return t('progress.processing', elapsedSec);
  }
}

function heartbeatIntervalMs(): number {
  const configured = Number(runtimeConfig.timeouts?.heartbeat_interval_ms);
  return Number.isFinite(configured) && configured > 0 ? configured : 5_000;
}

export function createHeartbeatTimer(
  callbacks: {
    onProgress?: (progress: { elapsed: number; status: string }) => void;
  },
): HeartbeatTimer {
  const startTime = Date.now();
  let timer: NodeJS.Timeout | null = null;
  let cleared = false;

  const fireHeartbeat = () => {
    if (cleared) return;
    if (!callbacks.onProgress) return;

    const elapsed = Date.now() - startTime;
    callbacks.onProgress({
      elapsed,
      status: getProgressStatus(elapsed),
    });
  };

  // 立即触发一次
  fireHeartbeat();
  timer = setInterval(fireHeartbeat, heartbeatIntervalMs());

  return {
    clear() {
      cleared = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    helpers() {
      return {
        onText: undefined,
        onToolCall: undefined,
      };
    },
  };
}

/**
 * 自适应心跳间隔计算
 *
 * 随等待时间指数增长，上限 10s：
 * 0-15s:   1s (快速感知)
 * 15-30s:  2s
 * 30-45s:  4s
 * 45s+:    10s (上限)
 */
export function calculateHeartbeatInterval(elapsedMs: number): number {
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const intervalMs = 1000 * Math.pow(2, Math.floor(elapsedSec / 15));
  return Math.min(intervalMs, 10000);
}

/**
 * 创建带心跳重置能力的包装器（流式调用使用）
 *
 * 设计：
 *  - 单一 setInterval 周期检查；间隔基于 elapsed 自适应（1s→10s）
 *  - reset() 仅更新 lastChunkAt，不再 clearInterval+setInterval
 *    （避免高 chunk rate 下每秒数十次定时器重建造成事件循环抖动）
 *  - 仅当当前 elapsed 对应的间隔与已设置的间隔不一致时才 reschedule
 */
export function createHeartbeatTimerWithReset(
  callbacks: {
    onProgress?: (progress: { elapsed: number; status: string }) => void;
  },
): HeartbeatTimer {
  const startTime = Date.now();
  let lastChunkAt = startTime;
  let timer: NodeJS.Timeout | null = null;
  let cleared = false;
  let currentInterval = 1000;

  const schedule = (intervalMs: number) => {
    if (timer) clearInterval(timer);
    currentInterval = intervalMs;
    timer = setInterval(tick, intervalMs);
  };

  const tick = () => {
    if (cleared) return;
    if (!callbacks.onProgress) return;

    const elapsed = Date.now() - startTime;
    callbacks.onProgress({
      elapsed,
      status: getProgressStatus(elapsed),
    });

    // 自适应：仅当 elapsed 跨入下一档时才 reschedule，避免每 tick 都重建定时器
    const nextInterval = calculateHeartbeatInterval(elapsed);
    if (nextInterval !== currentInterval) {
      schedule(nextInterval);
    }
  };

  const reset = () => {
    if (cleared) return;
    // 仅记录最后一次 chunk 时间。不再 clearInterval+setInterval。
    // UI 进度判断使用 (Date.now() - lastChunkAt) 即可获得"自上次 chunk 起的等待时间"。
    lastChunkAt = Date.now();
  };

  // 启动：立即触发一次 + 1s 间隔轮询
  tick();
  schedule(1000);

  return {
    clear() {
      cleared = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    helpers() {
      return {
        onText: () => reset(),
        onToolCall: () => reset(),
      };
    },
  };
}

export async function retryProviderOperation<T>(options: {
  maxRetries: number;
  operation: () => Promise<T>;
  classify: (error: unknown) => Error & { retryable?: boolean; retryAfterMs?: number };
  callbacks?: {
    onRetry?: (attempt: number, error: Error) => void;
    onError?: (error: Error) => void;
  };
  logPrefix: string;
  /** Provider 标识符（baseUrl）；传入后启用 Circuit Breaker 快速熔断 */
  providerKey?: string;
}): Promise<T> {
  const { maxRetries, operation, callbacks, logPrefix, providerKey } = options;
  const cb = providerKey ? getCircuitBreaker(providerKey) : null;

  // Circuit Breaker 前置检查：OPEN 时直接抛出，跳过所有重试等待
  cb?.beforeRequest();

  const engine = new RetryEngine({
    maxRetries,
    maxDelayMs: llmMaxBackoffMs(),
  });

  try {
    const result = await engine.execute(
      operation,
      {
        onRetry: (attempt, error, _delayMs) => {
          // 每次重试前让 Circuit Breaker 记录失败
          if (cb && !(error instanceof CircuitOpenError)) {
            const classified = error as { retryable?: boolean };
            cb.onFailure(classified.retryable !== false);
            // 如果刚打开，抛出让上层立即感知而不是继续等待
            cb.beforeRequest();
          }
          callbacks?.onRetry?.(attempt, error);
        },
        onError: (error) => {
          // 注意：终态失败的 CircuitBreaker 计数统一由下方外层 catch 负责（单一计数点），
          // 这里不再调用 cb.onFailure，否则一次逻辑失败会被计两次（onError + 外层 catch），
          // 导致熔断早于阈值触发。此回调仅透传用户 onError。
          callbacks?.onError?.(error);
        },
        logPrefix,
      },
    );
    cb?.onSuccess();
    return result;
  } catch (error) {
    // CircuitOpenError 已经在 beforeRequest 里记录，不重复计入
    if (cb && !(error instanceof CircuitOpenError)) {
      const classified = error as { retryable?: boolean };
      cb.onFailure(classified.retryable !== false);
    }
    throw error;
  }
}
