/**
 * WorkerFlushRegistry — pipeline-flush 回调注册表
 *
 * 从 WorkerProcessEntry.ts 抽出，避免 BaseAgentRuntime → WorkerProcessEntry 的 import 链
 * 触发 WorkerProcessEntry 顶层 `process.exit(1)` 守卫。
 */

let pendingFlushFn: (() => void | Promise<void>) | null = null;

export function setWorkerFlushFn(fn: (() => void | Promise<void>) | null): void {
  pendingFlushFn = fn;
}

export function getWorkerFlushFn(): (() => void | Promise<void>) | null {
  return pendingFlushFn;
}

/**
 * pipeline-flush：在退出路径中调用 pending flush。
 * 幂等：pendingFlushFn 为 null 时直接返回。
 * 超时保护：最多等待 3s，防止 flush 阻塞退出。
 */
export async function flushPendingToolResults(): Promise<void> {
  if (!pendingFlushFn) return;
  try {
    await Promise.race([
      Promise.resolve(pendingFlushFn()),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // tolerate flush errors during shutdown
  }
  pendingFlushFn = null;
}
