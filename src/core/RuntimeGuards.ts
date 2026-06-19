import { cleanupRegistry } from './CleanupRegistry.js';

/**
 * Leader 侧 flush 回调注册接口。
 *
 * pipeline-flush 契约：LeaderToolDispatch 的 flushBatch 闭包通过此函数
 * 注册到 cleanupRegistry（priority=0，最先执行），确保 gracefulShutdown
 * → cleanupRegistry.runAll() 时 flush 被触发。
 *
 * 调用方在 createLeaderToolScheduler 返回后调用 registerLeaderFlush，
 * 在 dispatch 完成后调用 unregisterLeaderFlush。
 */
let leaderFlushCleanupId: string | null = null;

export function registerLeaderFlush(flushFn: () => void): void {
  // 先反注册旧的（幂等，防泄漏）
  if (leaderFlushCleanupId) {
    cleanupRegistry.unregister(leaderFlushCleanupId);
  }
  leaderFlushCleanupId = cleanupRegistry.register(flushFn, 0);
}

export function unregisterLeaderFlush(): void {
  if (leaderFlushCleanupId) {
    cleanupRegistry.unregister(leaderFlushCleanupId);
    leaderFlushCleanupId = null;
  }
}

let installed = false;

/**
 * Suppress uncaughtException exit for known safe errors (e.g. tesseract.js
 * worker errors that are handled by the caller via a temporary handler).
 * Call suppressNextUncaughtException() before the risky operation, then
 * check isSuppressedError() to see if the error was swallowed.
 */
let suppressedUncaughtCount = 0;
const suppressedErrors: Error[] = [];

export function suppressNextUncaughtException(): void {
  suppressedUncaughtCount++;
}

export function clearUncaughtSuppression(): void {
  suppressedUncaughtCount = Math.max(0, suppressedUncaughtCount - 1);
}

export function popSuppressedError(): Error | undefined {
  return suppressedErrors.shift();
}

/**
 * 判断异常是否属于可恢复的 DB/IO 错误（不应杀死主进程）。
 * SQLITE_BUSY、连接关闭、序列化失败等场景下，丢弃该操作好过整个 CLI 退出。
 */
function isRecoverableInfraError(error: Error): boolean {
  const msg = error.message || '';
  if (/SQLITE_BUSY|database is locked/i.test(msg)) return true;
  if (/Database has been closed/i.test(msg)) return true;
  if (/Database reconnection failed/i.test(msg)) return true;
  if (/must be JSON-serializable/i.test(msg)) return true;
  if (/requires sessionId/i.test(msg)) return true;
  // EventEmitter error from worker:exit / worker:timeout handler — 已在调用方加了 try-catch 但某些路径仍可能逃逸
  if (/Recovery record/i.test(msg)) return true;
  return false;
}

// 连续可恢复错误计数——超过阈值仍强制退出，避免无限循环
let consecutiveRecoverableCount = 0;
const MAX_CONSECUTIVE_RECOVERABLE = 10;

// ═══ 单一关停协调(F2) ═══
// 历史:SIGTERM/SIGINT/SIGHUP handler、uncaughtException、daemon 自停各自调 runAllCleanups + process.exit,
// 并发触发时(uncaughtException 期间收到信号)会竞态——CleanupRegistry 的可复位 latch + 各路径独立 forceExitTimer
// 导致清理窗口被抢跑、worker 被 half-SIGKILL、退出码错乱。单一 gracefulShutdown:永不复位 latch + 单一共享
// forceExitTimer + runAllCleanups 只跑一次(并发/迟到 caller join 同一 in-flight promise)。
let gracefulShutdownLatched = false;
let gracefulShutdownPromise: Promise<void> | null = null;
let gracefulShutdownForceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 单一优雅关停入口(F2)。原子永不复位 latch 保证只协调一次;单一共享 forceExitTimer 兜底强退;
 * runAllCleanups 只跑一次,并发/迟到 caller join 同一 in-flight promise。首触发者的 code/timeout 生效。
 * 所有关停路径(SIGTERM/SIGINT/SIGHUP、uncaughtException、daemon 自停)应收敛到此。
 */
export async function gracefulShutdown(code: number = 0, timeoutMs: number = 10_000): Promise<void> {
  if (gracefulShutdownPromise) {
    return gracefulShutdownPromise; // join 已 in-flight 的关停(latch 永不复位,绝不重跑 runAll)
  }
  gracefulShutdownLatched = true;
  // 单一共享 forceExitTimer:首次进入 arm,timeout 后强退(用本次 code)。unref 不阻塞事件循环。
  if (!gracefulShutdownForceTimer) {
    gracefulShutdownForceTimer = setTimeout(() => {
      console.error(`[gracefulShutdown] force-exit after ${timeoutMs}ms (code=${code})`);
      process.exit(code);
    }, timeoutMs);
    gracefulShutdownForceTimer.unref?.();
  }
  gracefulShutdownPromise = (async () => {
    try {
      await cleanupRegistry.runAll(timeoutMs);
    } catch {
      /* tolerate cleanup errors during shutdown */
    }
    process.exit(code);
  })();
  return gracefulShutdownPromise;
}

/** 是否已进入关停(供调用方短路)。 */
export function isGracefulShuttingDown(): boolean {
  return gracefulShutdownLatched;
}

export function installProcessRuntimeGuards(): void {
  if (installed) {
    return;
  }
  installed = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[RuntimeGuard] Unhandled promise rejection:', reason);
    const error = reason instanceof Error ? reason : new Error(String(reason));
    // 可恢复的基础设施错误（DB busy/closed 等）：与 uncaughtException 同口径，**不毒化 exitCode**。
    // 这些常来自 EventEmitter handler 中 fire-and-forget 的 DB/IO 操作；若每次都置 exitCode=1 且
    // 从不复位，一次瞬态拒绝会让后续每次正常退出都报 1，被 supervisor 误判崩溃触发无谓重启。
    if (isRecoverableInfraError(error)) {
      if (consecutiveRecoverableCount < MAX_CONSECUTIVE_RECOVERABLE) {
        consecutiveRecoverableCount++;
        console.warn(`[RuntimeGuard] Recoverable infra rejection (${consecutiveRecoverableCount}/${MAX_CONSECUTIVE_RECOVERABLE}), NOT poisoning exitCode:`, error.message);
        setTimeout(() => { consecutiveRecoverableCount = Math.max(0, consecutiveRecoverableCount - 1); }, 60_000).unref();
      }
      return;
    }
    // 真正未处理的拒绝（非基础设施类，确属 bug）：标记非零退出，但仍让进程自然 drain。
    process.exitCode = 1;
  });

  process.on('uncaughtException', (error) => {
    // 如果有调用方申请了抑制（如 tesseract.js worker 错误），
    // 将错误暂存而不是退出进程，由调用方在稍后检查和处理。
    if (suppressedUncaughtCount > 0) {
      suppressedErrors.push(error);
      suppressedUncaughtCount--;
      console.warn('[RuntimeGuard] Suppressed uncaught exception (handled by caller):', error.message);
      return;
    }

    // 可恢复的基础设施错误（DB busy/closed）：不杀进程，只告警。
    // 这些错误通常来自 EventEmitter handler 中未被内层 try-catch 捕获的 DB 操作。
    if (isRecoverableInfraError(error) && consecutiveRecoverableCount < MAX_CONSECUTIVE_RECOVERABLE) {
      consecutiveRecoverableCount++;
      console.warn(`[RuntimeGuard] Recoverable infra error (${consecutiveRecoverableCount}/${MAX_CONSECUTIVE_RECOVERABLE}), NOT exiting:`, error.message);
      // 安排降级重置
      setTimeout(() => { consecutiveRecoverableCount = Math.max(0, consecutiveRecoverableCount - 1); }, 60_000).unref();
      return;
    }

    console.error('[RuntimeGuard] Uncaught exception — exiting to avoid undefined state:', error);
    // Node.js 文档明确指出 uncaughtException 后继续运行是不安全的。
    // 收敛到单一 gracefulShutdown(F2):与信号 handler / daemon 自停共享 latch + force timer,
    // 避免并发关停时清理窗口被抢跑、worker 被 half-SIGKILL。
    void gracefulShutdown(1, 10000);
  });
}

export default installProcessRuntimeGuards;
