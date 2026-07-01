import { cleanupRegistry } from './CleanupRegistry.js';
import { writeCrashReport, listCrashReports } from './CrashReporter.js';
import { getLogDir } from './Log.js';
import { restoreTerminalState } from './terminalRestore.js';

// 本进程启动时刻（ms）。用于退出时识别「本次运行新产生」的崩溃报告，
// 避免把历史 crash 文件误报给用户。留 1s 容差应对时钟/写盘抖动。
const PROCESS_START_MS = Date.now();
let crashExitNoticeInstalled = false;

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
 * 判断是否为 TUI 写终端遇到的瞬态 I/O 错误（EIO/EPIPE）。
 *
 * 根因（audit-2026-07-01）：Ink.writeToStderr/writeToStdout 是同步 stream.write()，未包 try-catch。
 * 终端在窗口切换 / resize 竞态 / tty 短暂不可写时，底层 socket write 会抛 `Error: write EIO`
 * 逃逸成 uncaughtException，被本文件当作致命错误处理，直接 gracefulShutdown(1) 杀掉整个进程
 * （包括承载 Web UI 的 Web Server）。这类错误只是本次终端帧写入失败，不代表进程状态已损坏，
 * 应与 DB busy 等基础设施类错误同口径：丢弃本次写入，不杀进程。
 */
function isTerminalWriteError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EIO' || code === 'EPIPE') return true;
  const msg = error.message || '';
  if (/^write EIO$/i.test(msg) || /^write EPIPE$/i.test(msg)) return true;
  return false;
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
  // TUI 写终端瞬态 EIO/EPIPE（见 isTerminalWriteError 注释）
  if (isTerminalWriteError(error)) return true;
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

/**
 * 安装崩溃退出提示：进程退出时，若本次运行新产生了 crash 报告，
 * 向真实 stderr 直写一段醒目提示，引导用户提交 issue 时附带该文件。
 *
 * 设计要点：
 * - 注册到 process.on('exit')，覆盖所有退出路径（gracefulShutdown / TUI 卸载 / 自然退出）。
 * - 直写 process.stderr.write，绕过 Log.ts ConsoleSink（TUI 模式已关闭）与 muteConsole。
 * - 仅在 PROCESS_START_MS 之后新增的 crash 文件才提示，避免误报历史崩溃。
 * - best-effort：exit handler 内任何异常都被吞掉，绝不影响退出。
 */
function installCrashExitNotice(): void {
  if (crashExitNoticeInstalled) return;
  crashExitNoticeInstalled = true;

  process.on('exit', () => {
    try {
      const reports = listCrashReports();
      const fresh = reports.filter((r) => r.mtime >= PROCESS_START_MS - 1000);
      if (fresh.length === 0) return;

      const latest = fresh[0];
      const logDir = getLogDir();
      const lines = [
        '',
        '\u2501\u2501\u2501 \u5d29\u6e83\u62a5\u544a / Crash report \u2501\u2501\u2501',
        `\u672c\u6b21\u8fd0\u884c\u53d1\u751f\u4e86\u5d29\u6e83\uff0c\u5df2\u751f\u6210\u7ed3\u6784\u5316\u62a5\u544a\uff1a`,
        `  ${latest.path}`,
        `\u65e5\u5fd7\u76ee\u5f55\uff1a${logDir}`,
        `\u63d0\u4ea4 issue \u65f6\u8bf7\u9644\u4e0a\u8be5\u6587\u4ef6\uff0c\u6216\u8fd0\u884c \`lingxiao diagnose\` \u751f\u6210\u8bca\u65ad\u5305\u3002`,
        '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
        '',
      ];
      process.stderr.write(lines.join('\n') + '\n');
    } catch {
      // 退出提示 best-effort，绝不阻塞退出
    }
  });
}

export function installProcessRuntimeGuards(): void {
  if (installed) {
    return;
  }
  installed = true;

  installCrashExitNotice();

  // 终端状态还原兜底：所有退出路径（正常/crash/信号/强退）最终都会触发 'exit' 事件。
  // 在此统一关闭 mouse tracking / bracketed paste 并恢复光标，杜绝异常退出后宿主终端
  // 残留 raw 模式导致鼠标动作打出 SGR 上报序列（^[[<65;70;25M）。幂等 + best-effort。
  process.on('exit', () => {
    restoreTerminalState();
  });

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
    // 落盘结构化崩溃报告（best-effort，永不抛）。
    const crashPath = writeCrashReport({ error, source: 'unhandledRejection' });
    if (crashPath) {
      console.error(`[RuntimeGuard] 崩溃报告已保存: ${crashPath}`);
    }
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
    // 真崩溃落盘结构化报告（best-effort，永不抛）。recoverable/suppressed 分支已在上方短路，不会到这里。
    try {
      const crashPath = writeCrashReport({ error, source: 'uncaughtException' });
      if (crashPath) console.error(`[RuntimeGuard] 崩溃报告已保存: ${crashPath}`);
    } catch { /* crash report best-effort */ }
    // Node.js 文档明确指出 uncaughtException 后继续运行是不安全的。
    // 收敛到单一 gracefulShutdown(F2):与信号 handler / daemon 自停共享 latch + force timer,
    // 避免并发关停时清理窗口被抢跑、worker 被 half-SIGKILL。
    void gracefulShutdown(1, 10000);
  });
}

export default installProcessRuntimeGuards;
