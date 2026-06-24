/**
 * ProcessIdleGuard — 进程级 Idle 自动退出守卫
 *
 * 解决问题：凌霄交互模式在终端断开/TUI 退出后进程永生，累积僵尸实例导致 CPU 和 swap 爆炸。
 *
 * 设计：
 * 1. 跟踪"最后有意义活动"时间戳
 * 2. 所有 session idle + 无 running agent + 无 active connection 超过阈值 → gracefulShutdown
 * 3. 终端断开（SIGHUP/SIGTERM）后进入"有限存活"模式（短 TTL），给 Web UI 重连留窗口
 * 4. 可通过配置/环境变量覆盖阈值或禁用
 *
 * 资源降级：idle 时自动拉长 HealthMonitor / cleanup loop 周期，降低空转 CPU。
 */

import { gracefulShutdown, isGracefulShuttingDown } from './RuntimeGuards.js';

export interface ProcessIdleGuardConfig {
  /** 全 idle 自动退出阈值 (ms)。默认 10 分钟。设为 0 或 Infinity 禁用。 */
  idleExitMs: number;
  /** 终端断开后有限存活时间 (ms)。默认 5 分钟。 */
  detachedTtlMs: number;
  /** 检查间隔 (ms)。默认 30 秒。 */
  checkIntervalMs: number;
  /** 是否禁用自动退出（daemon 模式不退出） */
  disabled: boolean;
}

const DEFAULT_CONFIG: ProcessIdleGuardConfig = {
  idleExitMs: 10 * 60 * 1000,       // 10 分钟
  detachedTtlMs: 5 * 60 * 1000,     // 5 分钟
  checkIntervalMs: 30 * 1000,        // 30 秒
  disabled: false,
};

export type ActivityProbe = () => boolean;

export class ProcessIdleGuard {
  private config: ProcessIdleGuardConfig;
  private lastActivityMs: number = Date.now();
  private detachedAtMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probes: ActivityProbe[] = [];
  private idleCallbacks: Array<(idleMs: number) => void> = [];
  private started = false;

  constructor(config?: Partial<ProcessIdleGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 环境变量覆盖
    const envIdleMs = process.env.LINGXIAO_IDLE_EXIT_MS;
    if (envIdleMs) {
      const parsed = parseInt(envIdleMs, 10);
      if (!isNaN(parsed) && parsed >= 0) this.config.idleExitMs = parsed;
    }
    const envDisabled = process.env.LINGXIAO_IDLE_EXIT_DISABLED;
    if (envDisabled === '1' || envDisabled === 'true') {
      this.config.disabled = true;
    }
  }

  /**
   * 注册活跃探针 — 返回 true 表示当前有活跃工作，刷新 idle 计时器
   */
  registerProbe(probe: ActivityProbe): void {
    this.probes.push(probe);
  }

  /**
   * 注册 idle 回调 — 进入 idle 状态时调用（用于降级资源消耗）
   */
  onIdle(callback: (idleMs: number) => void): void {
    this.idleCallbacks.push(callback);
  }

  /**
   * 外部手动刷新活跃时间（用户操作、消息收发等）
   */
  touch(): void {
    this.lastActivityMs = Date.now();
    // 如果从 detached 模式恢复了连接
    if (this.detachedAtMs !== null) {
      this.detachedAtMs = null;
    }
  }

  /**
   * 标记终端已断开 — 进入有限存活模式
   */
  markDetached(): void {
    if (this.detachedAtMs === null) {
      this.detachedAtMs = Date.now();
    }
  }

  /**
   * 启动 idle 检查循环
   */
  start(): void {
    if (this.started || this.config.disabled) return;
    this.started = true;
    this.lastActivityMs = Date.now();

    this.timer = setInterval(() => {
      this.check();
    }, this.config.checkIntervalMs);

    // 不阻止进程自然退出
    this.timer.unref();
  }

  /**
   * 停止 idle guard（进程正在 graceful shutdown 时自动调用）
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /**
   * 获取当前 idle 时长 (ms)
   */
  getIdleMs(): number {
    return Date.now() - this.lastActivityMs;
  }

  /**
   * 获取诊断信息
   */
  getDiagnostics(): {
    idleMs: number;
    detachedAtMs: number | null;
    config: ProcessIdleGuardConfig;
    willExitIn: number | null;
  } {
    const idleMs = this.getIdleMs();
    let willExitIn: number | null = null;

    if (!this.config.disabled && this.config.idleExitMs > 0 && this.config.idleExitMs < Infinity) {
      if (this.detachedAtMs !== null) {
        willExitIn = Math.max(0, this.config.detachedTtlMs - (Date.now() - this.detachedAtMs));
      } else {
        willExitIn = Math.max(0, this.config.idleExitMs - idleMs);
      }
    }

    return { idleMs, detachedAtMs: this.detachedAtMs, config: this.config, willExitIn };
  }

  private check(): void {
    if (this.config.disabled || isGracefulShuttingDown()) return;

    const now = Date.now();

    // 探针检查：任何探针返回 true → 刷新活跃
    for (const probe of this.probes) {
      try {
        if (probe()) {
          this.lastActivityMs = now;
          return; // 有活跃工作，不需要继续检查
        }
      } catch {
        // 忽略探针异常
      }
    }

    const idleMs = now - this.lastActivityMs;

    // 通知 idle 回调（用于资源降级）
    if (idleMs > this.config.checkIntervalMs) {
      for (const cb of this.idleCallbacks) {
        try { cb(idleMs); } catch { /* ignore */ }
      }
    }

    // 检查是否该退出
    let shouldExit = false;
    let reason = '';

    if (this.detachedAtMs !== null) {
      // 终端已断开 — 使用短 TTL
      const detachedMs = now - this.detachedAtMs;
      if (detachedMs >= this.config.detachedTtlMs) {
        shouldExit = true;
        reason = `terminal detached ${Math.round(detachedMs / 1000)}s ago (TTL=${Math.round(this.config.detachedTtlMs / 1000)}s)`;
      }
    } else {
      // 正常 idle 超时
      if (this.config.idleExitMs > 0 && this.config.idleExitMs < Infinity && idleMs >= this.config.idleExitMs) {
        shouldExit = true;
        reason = `all sessions idle for ${Math.round(idleMs / 1000)}s (threshold=${Math.round(this.config.idleExitMs / 1000)}s)`;
      }
    }

    if (shouldExit) {
      console.log(`[ProcessIdleGuard] Auto-exit: ${reason}`);
      this.stop();
      void gracefulShutdown(0, 10_000);
    }
  }
}

/** 进程级单例 */
let _instance: ProcessIdleGuard | null = null;

export function getProcessIdleGuard(): ProcessIdleGuard {
  if (!_instance) {
    _instance = new ProcessIdleGuard();
  }
  return _instance;
}

export function createProcessIdleGuard(config?: Partial<ProcessIdleGuardConfig>): ProcessIdleGuard {
  _instance = new ProcessIdleGuard(config);
  return _instance;
}
