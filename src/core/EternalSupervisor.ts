/**
 * EternalSupervisor — 进程级健康守护
 *
 * 多层健康检查：
 *   Layer 1: platform-aware PID probe — 进程存活
 *   Layer 2: watchdog 文件新鲜度 — ~/.lingxiao/watchdog.json (< 30s)
 *   Layer 3: HTTP /health — 服务可达
 *
 * 重启策略：
 *   - 指数退避：1m → 2m → 4m → 8m → 15m (cap)
 *   - 连续健康 >5min 后重置重启计数器
 *   - 达到 maxRestarts 后放弃
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { coreLogger } from './Log.js';
import {
  isSupervisorGivenUpStatus,
  normalizeSupervisorStatus,
  type CoreSupervisorStatus,
} from './StateSemantics.js';
import { sleep } from '../utils/sleep.js';
import { processExists } from '../utils/platform.js';

export interface SupervisorConfig {
  /** Daemon 健康检查 URL */
  healthUrl: string;
  /** 期望的 daemon PID */
  pid: number;
  /** 启动 daemon 的回调 (返回新 PID 和 URL) */
  onRestart: () => Promise<{ pid: number; healthUrl: string }>;
  /** 放弃前的最大重启次数 (默认 5) */
  maxRestarts?: number;
  /** 重启间隔基数 ms (默认 60_000) */
  baseRestartDelayMs?: number;
  /** 最大重启间隔 ms (默认 900_000 = 15分钟) */
  maxRestartDelayMs?: number;
  /** 健康检查间隔 ms (默认 15_000) */
  healthCheckIntervalMs?: number;
  /** 健康检查超时 ms (默认 5_000) */
  healthCheckTimeoutMs?: number;
  /** Watchdog 文件路径 (默认 ~/.lingxiao/watchdog.json) */
  watchdogFile?: string;
  /** Watchdog 文件最大允许年龄 ms (默认 30_000) */
  watchdogMaxAgeMs?: number;
  /** 连续健康多久后重置重启计数器 ms (默认 300_000 = 5min) */
  healthyResetMs?: number;
  /**
   * 软健康（watchdog/HTTP）连续失败多少次才判定不健康并重启（默认 3）。
   * 防止单次瞬时事件循环阻塞（如重 LLM 流式 / 大文件 IO 卡住一拍心跳）被误判成宕机，
   * 进而 stopDaemon → SIGTERM 把正在干活的 daemon（连同 worker agent）整窝杀掉。
   * 注意：Layer 1 进程真死不受此约束，立即重启。
   */
  unhealthyThreshold?: number;
  /** 放弃回调 */
  onGiveUp?: (reason: string) => void;
  /** 告警回调 (non-blocking) */
  onAlert?: (alert: SupervisorAlert) => void;
}

export interface SupervisorAlert {
  type: 'restart' | 'restart_failed' | 'give_up' | 'health_degraded';
  message: string;
  attempt?: number;
  maxRestarts?: number;
  timestamp: number;
}

export interface SupervisorState {
  status: CoreSupervisorStatus;
  restartCount: number;
  lastHealthCheckAt: number;
  lastHealthyAt: number;
  currentPid: number;
  currentHealthUrl: string;
  /** 连续软健康失败次数（watchdog/HTTP）；达到 unhealthyThreshold 才触发重启 */
  consecutiveSoftFailures: number;
}

export class EternalSupervisor {
  private config: Omit<Required<SupervisorConfig>, 'onGiveUp' | 'onAlert'> & {
    onGiveUp?: (reason: string) => void;
    onAlert?: (alert: SupervisorAlert) => void;
  };
  private state: SupervisorState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  /**
   * In-flight 重启 Promise（P0 #4 单飞锁）。
   *
   * setInterval 每 healthCheckIntervalMs(15s) 触发 healthCheck()，而一次 attemptRestart
   * 内部 `await sleep(60s/2min/4min/...)` 会让出事件循环，导致同一时间窗内 healthCheck
   * 反复进入 attemptRestart：每次 restartCount++，几个 tick 后 maxRestarts(5) 被耗尽，
   * 触发 give_up，daemon 永远不再被拉起。
   *
   * 这里把 attemptRestart 串行化：第二次进入直接 await 上次 promise，等其完成。
   */
  private restartInFlight: Promise<void> | null = null;

  constructor(config: SupervisorConfig) {
    this.config = {
      maxRestarts: 5,
      baseRestartDelayMs: 60_000,
      maxRestartDelayMs: 900_000,
      healthCheckIntervalMs: 15_000,
      healthCheckTimeoutMs: 5_000,
      watchdogFile: join(homedir(), '.lingxiao', 'watchdog.json'),
      watchdogMaxAgeMs: 30_000,
      healthyResetMs: 300_000,
      unhealthyThreshold: 3,
      ...config,
    };
    this.state = {
      status: 'stopped',
      restartCount: 0,
      lastHealthCheckAt: 0,
      lastHealthyAt: Date.now(),
      currentPid: config.pid,
      currentHealthUrl: config.healthUrl,
      consecutiveSoftFailures: 0,
    };
  }

  /** 启动守护循环。永不 resolve（除非停止）。 */
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.state.status = 'watching';
    this.state.lastHealthCheckAt = Date.now();

    this.timer = setInterval(() => {
      void this.healthCheck();
    }, this.config.healthCheckIntervalMs);
    this.timer.unref?.();

    // Immediate first check
    void this.healthCheck();
  }

  /** 优雅停止 */
  stop(): void {
    this.stopping = true;
    this.state.status = 'stopped';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getState(): Readonly<SupervisorState> {
    return { ...this.state };
  }

  // ── private ──

  private async healthCheck(): Promise<void> {
    if (this.stopping || isSupervisorGivenUpStatus(this.state.status)) return;
    // P0 #4: backoff sleep 期间 setInterval 仍按 15s 触发，必须跳过；否则 restartCount
    // 会在一次 backoff 内被叠加 ≥30 次，瞬间触达 maxRestarts → give_up。
    if (normalizeSupervisorStatus(this.state.status) === 'restarting' || this.restartInFlight) return;

    this.state.lastHealthCheckAt = Date.now();

    // Layer 1：进程真死 = 硬失败，立即重启，不走连续失败阈值。
    if (!this.isProcessAlive(this.state.currentPid)) {
      coreLogger.warn('[Supervisor] Daemon process not alive — restarting immediately', {
        pid: this.state.currentPid,
        attempt: this.state.restartCount + 1,
      });
      this.state.consecutiveSoftFailures = 0;
      await this.attemptRestart();
      return;
    }

    // Layer 2/3：watchdog 新鲜度 + HTTP /health = 软健康。
    // 单次失败可能只是事件循环被重 LLM 流式/大文件 IO 卡了一拍，不足以判定宕机。
    const soft = await this.isSoftHealthy();
    const now = Date.now();

    if (soft) {
      this.state.consecutiveSoftFailures = 0;
      // Reset restart counter after sustained health
      if (this.state.restartCount > 0 && now - this.state.lastHealthyAt > this.config.healthyResetMs) {
        coreLogger.info('[Supervisor] Sustained health — resetting restart counter', {
          restartCount: this.state.restartCount,
          healthyDurationSec: Math.round((now - this.state.lastHealthyAt) / 1000),
        });
        this.state.restartCount = 0;
      }
      this.state.lastHealthyAt = now;
      return;
    }

    // 软失败累积
    this.state.consecutiveSoftFailures += 1;
    if (this.state.consecutiveSoftFailures < this.config.unhealthyThreshold) {
      coreLogger.warn('[Supervisor] Soft health check failed — within tolerance, not restarting yet', {
        pid: this.state.currentPid,
        consecutive: this.state.consecutiveSoftFailures,
        threshold: this.config.unhealthyThreshold,
      });
      this.emitAlert(
        'health_degraded',
        `Soft health degraded (${this.state.consecutiveSoftFailures}/${this.config.unhealthyThreshold})`,
      );
      return;
    }

    coreLogger.warn('[Supervisor] Daemon unhealthy — attempting restart', {
      pid: this.state.currentPid,
      attempt: this.state.restartCount + 1,
      consecutiveSoftFailures: this.state.consecutiveSoftFailures,
    });
    this.state.consecutiveSoftFailures = 0;
    await this.attemptRestart();
  }

  /**
   * 软健康检查：Layer 2 watchdog 新鲜度 + Layer 3 HTTP /health。
   * 不含 Layer 1（进程存活），那是硬失败、由 healthCheck 单独优先处理。
   */
  private async isSoftHealthy(): Promise<boolean> {
    // Layer 2: Watchdog file freshness
    if (!this.isWatchdogFresh()) {
      coreLogger.debug('[Supervisor] Layer 2 failed: watchdog stale');
      return false;
    }

    // Layer 3: HTTP health check
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.healthCheckTimeoutMs);
      const res = await fetch(`${this.state.currentHealthUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        coreLogger.debug('[Supervisor] Layer 3 failed: HTTP not ok', { status: res.status });
        return false;
      }
      return true;
    } catch {/* swallowed: unhandled error */
      coreLogger.debug('[Supervisor] Layer 3 failed: HTTP unreachable');
      return false;
    }
  }

  private isWatchdogFresh(): boolean {
    const file = this.config.watchdogFile;
    if (!file || !existsSync(file)) return true; // No watchdog file = skip this layer
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const age = Date.now() - (data.ts || 0);
      return age < this.config.watchdogMaxAgeMs;
    } catch (err) {
      coreLogger.warn('[Supervisor] Layer 2 failed: watchdog unreadable', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    return processExists(pid);
  }

  private async attemptRestart(): Promise<void> {
    // 单飞锁：若已有 attemptRestart 在跑，复用其 Promise，避免 backoff sleep 期间被并发进入。
    if (this.restartInFlight) {
      return this.restartInFlight;
    }
    const promise = this._attemptRestartImpl();
    this.restartInFlight = promise;
    promise.finally(() => {
      if (this.restartInFlight === promise) {
        this.restartInFlight = null;
      }
    }).catch(() => { /* impl 内部已处理错误 */ });
    return promise;
  }

  private async _attemptRestartImpl(): Promise<void> {
    if (this.state.restartCount >= this.config.maxRestarts) {
      this.state.status = 'given_up';
      const reason = `Supervisor gave up after ${this.state.restartCount} restart attempts`;
      this.config.onGiveUp?.(reason);
      this.emitAlert('give_up', reason);
      return;
    }

    this.state.status = 'restarting';
    this.state.restartCount++;
    const attempt = this.state.restartCount;

    this.emitAlert('restart', `Attempting restart ${attempt}/${this.config.maxRestarts}`, attempt);

    try {
      // Exponential backoff
      const delay = Math.min(
        this.config.baseRestartDelayMs * Math.pow(2, attempt - 1),
        this.config.maxRestartDelayMs,
      );
      await sleep(delay);
      // sleep 后再确认未被 stop()，避免对已经停止的 supervisor 触发 onRestart
      if (this.stopping) {
        this.state.status = 'stopped';
        return;
      }

      const { pid, healthUrl } = await this.config.onRestart();
      this.state.currentPid = pid;
      this.state.currentHealthUrl = healthUrl;
      this.state.status = 'watching';
      this.state.lastHealthyAt = Date.now();
      this.state.consecutiveSoftFailures = 0;
    } catch (err) {
      this.state.status = 'watching'; // Continue watching (will retry next cycle)
      this.emitAlert(
        'restart_failed',
        `Restart ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
        attempt,
      );
    }
  }

  private emitAlert(type: SupervisorAlert['type'], message: string, attempt?: number): void {
    this.config.onAlert?.({
      type,
      message,
      attempt,
      maxRestarts: this.config.maxRestarts,
      timestamp: Date.now(),
    });
  }
}
/**
 * Write watchdog heartbeat file. Call this from the daemon process every 10s.
 */
export function writeWatchdog(filePath?: string): void {
  const file = filePath || join(homedir(), '.lingxiao', 'watchdog.json');
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now(), healthy: true }), 'utf-8');
  } catch {
    // Best-effort
  }
}
