/**
 * Provider 级 Circuit Breaker — 快速熔断故障 provider，避免重复超时等待
 *
 * 状态机：
 *   CLOSED  → 正常，允许所有请求
 *   OPEN    → 熔断，直接抛出 CircuitOpenError（不等待 retry 延迟）
 *   HALF_OPEN → 探针状态，允许 1 个请求通过以检测 provider 是否恢复
 *
 * 转换规则：
 *   CLOSED  → OPEN      : 连续 FAILURE_THRESHOLD 次 retryable 失败
 *   OPEN    → HALF_OPEN : PROBE_INTERVAL_MS 后自动进入探针
 *   HALF_OPEN → CLOSED  : 探针请求成功
 *   HALF_OPEN → OPEN    : 探针请求失败（重新计时）
 *
 * 只计入 retryable 错误（5xx / timeout / network）；4xx 非 429 不触发熔断。
 */

import { coreLogger } from '../core/Log.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitOpenError extends Error {
  readonly providerKey: string;
  readonly openedAt: number;
  /**
   * 距离 HALF_OPEN 探针窗口开启的剩余时间（ms）。最少 1000ms，避免 caller
   * 拿到 0 后仍然立即重试形成死循环。
   */
  readonly retryAfterMs: number;

  constructor(providerKey: string, openedAt: number) {
    const remaining = Math.max(1000, PROBE_INTERVAL_MS - (Date.now() - openedAt));
    super(`Circuit breaker OPEN for provider "${providerKey}" — retry in ~${Math.ceil(remaining / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.providerKey = providerKey;
    this.openedAt = openedAt;
    this.retryAfterMs = remaining;
  }
}

/** 连续失败多少次后打开断路器 */
const FAILURE_THRESHOLD = 8;
/** 断路器保持 OPEN 的最短时间（ms）；之后进入 HALF_OPEN 探针 */
export const PROBE_INTERVAL_MS = 15_000;

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt = 0;
  // NOTE: halfOpenInFlight 无并发保护，但在 Node.js 单线程模型下安全——
  // beforeRequest() 是同步方法，不会被 await 中断，因此 check-then-set 不会竞态。
  private halfOpenInFlight = false;

  constructor(readonly providerKey: string) {}

  /** 当前状态 */
  getState(): CircuitState {
    this._maybeTransitionToHalfOpen();
    return this.state;
  }

  /** 当前连续失败计数（只读，主要供测试观测计数语义，无副作用） */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * 在发起请求前调用。
   * - OPEN → 立即抛出 CircuitOpenError
   * - HALF_OPEN 且已有探针在飞 → 也抛出（避免探针并发）
   * - 其他情况 → 放行
   */
  beforeRequest(): void {
    this._maybeTransitionToHalfOpen();

    if (this.state === CircuitState.OPEN) {
      throw new CircuitOpenError(this.providerKey, this.openedAt);
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenInFlight) {
        // 已经有一个探针在飞，其余请求快速失败
        throw new CircuitOpenError(this.providerKey, this.openedAt);
      }
      this.halfOpenInFlight = true;
    }
  }

  /**
   * 请求成功后调用。
   * - HALF_OPEN → CLOSED，重置计数
   * - CLOSED → 重置连续失败计数
   */
  onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      coreLogger.info(`[CircuitBreaker] provider="${this.providerKey}" HALF_OPEN→CLOSED (探针成功)`);
    }
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = false;
  }

  /**
   * 请求失败后调用。只有 retryable 错误才计入失败计数。
   * @param retryable  是否是可重试错误（5xx/timeout/network）
   */
  onFailure(retryable: boolean): void {
    this.halfOpenInFlight = false;

    if (!retryable) {
      // 4xx 客户端错误不触发熔断，但也不重置连续失败计数
      return;
    }

    this.consecutiveFailures++;

    if (this.state === CircuitState.HALF_OPEN) {
      // 探针失败 → 重新 OPEN
      this.openedAt = Date.now();
      this.state = CircuitState.OPEN;
      coreLogger.warn(
        `[CircuitBreaker] provider="${this.providerKey}" HALF_OPEN→OPEN (探针失败，连续 ${this.consecutiveFailures} 次)`,
      );
      return;
    }

    if (
      this.state === CircuitState.CLOSED &&
      this.consecutiveFailures >= FAILURE_THRESHOLD
    ) {
      this.openedAt = Date.now();
      this.state = CircuitState.OPEN;
      coreLogger.warn(
        `[CircuitBreaker] provider="${this.providerKey}" CLOSED→OPEN (连续 ${this.consecutiveFailures} 次 retryable 失败)`,
      );
    }
  }

  private _maybeTransitionToHalfOpen(): void {
    if (
      this.state === CircuitState.OPEN &&
      Date.now() - this.openedAt >= PROBE_INTERVAL_MS
    ) {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenInFlight = false;
      coreLogger.info(
        `[CircuitBreaker] provider="${this.providerKey}" OPEN→HALF_OPEN (探针窗口开启)`,
      );
    }
  }
}

/**
 * 全局 Circuit Breaker 注册表
 *
 * 以 (providerKey, scope) 复合 key 维护：每个 provider endpoint × 调用语境
 * 独立熔断。单例 Map，进程级共享（跨 session）——这是预期行为：
 * 如果某 endpoint 在某 scope 下对所有 session 都不可用，所有 session 都应快速失败。
 *
 * scope 拆分动机 (2026-05-28)：
 *   旧实现 key=providerKey，Leader 主对话、Agent worker、Conclude 三类调用
 *   全部共享同一 CB。任意一路连续 5 次 retryable 失败 → 全员 OPEN；
 *   HALF_OPEN 探针又只允许 1 个 in-flight，造成"探针饥饿"——
 *   一路 agent 抢到探针，其他几路只能 sleep 重试。
 *
 *   按 scope 拆分（'leader' / 'agent::<name>' / 'conclude::<name>' / 'shared'）后：
 *     - Leader 流式失败不会立即把 agent 路径也封死
 *     - 每个 worker agent 拥有独立 CB（agent::${name}），单 agent 故障不串扰其他 worker
 *     - 多 agent 并发各自有独立探针窗口
 *     - 共享熔断的核心价值（同 endpoint 真死则整体快失败）通过 scope='shared'
 *       （retryProviderOperation 默认值）保留
 *
 * 内存量级：providers × models × scopes ≈ O(数十~数百)，忽略不计。
 */
const _registry = new Map<string, CircuitBreaker>();

/** 默认 scope；retryProviderOperation 等不区分语境的 provider 调用方走这里 */
export const DEFAULT_CB_SCOPE = 'shared';

export function getCircuitBreaker(providerKey: string, scope: string = DEFAULT_CB_SCOPE): CircuitBreaker {
  const compoundKey = `${providerKey}::${scope}`;
  let cb = _registry.get(compoundKey);
  if (!cb) {
    cb = new CircuitBreaker(compoundKey);
    _registry.set(compoundKey, cb);
  }
  return cb;
}

/** 仅用于测试：重置所有断路器 */
export function _resetAllCircuitBreakers(): void {
  _registry.clear();
}

function isCircuitBreakerKeyForProvider(scopeKey: string, prefix: string): boolean {
  return scopeKey.startsWith(`${prefix}::`);
}

/**
 * 重置某 provider 在所有 scope 下的熔断状态。
 *
 * 用于 LLM client recycle 后立即解开熔断 — 老 socket / 死 client 已被丢弃，
 * 不应该让"上一代 client 攒下来的失败计数"继续阻塞新 client 的探针。
 */
export function resetCircuitBreakersForProvider(providerKey: string): void {
  for (const [key, cb] of _registry.entries()) {
    if (isCircuitBreakerKeyForProvider(key, providerKey)) {
      cb.onSuccess(); // 强制 CLOSED + 计数清零
    }
  }
}
