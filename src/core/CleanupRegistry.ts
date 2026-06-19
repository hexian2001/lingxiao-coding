/**
 * 清理注册表 - 参考 Claude Code 的优雅关闭设计
 * 用于注册需要在程序退出时执行的清理函数
 */

import { coreLogger } from './Log.js';

export type CleanupFn = () => void | Promise<void>;

interface CleanupEntry {
  id: string;
  fn: CleanupFn;
  priority: number; // 优先级，数字越小越早执行
}

export class CleanupRegistry {
  private cleanups: Map<string, CleanupEntry> = new Map();
  private isShuttingDown = false;

  /**
   * 注册清理函数
   * @param fn 清理函数
   * @param priority 优先级（数字越小越早执行，默认 100）
   * @returns 清理函数 ID，可用于取消注册
   */
  register(fn: CleanupFn, priority = 100): string {
    const id = `cleanup_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.cleanups.set(id, { id, fn, priority });
    return id;
  }

  /**
   * 取消注册清理函数
   */
  unregister(id: string): boolean {
    return this.cleanups.delete(id);
  }

  /**
   * 执行所有清理函数
   * @param timeout 超时时间（毫秒）
   * @returns 成功执行的清理函数数量
   */
  async runAll(timeout = 30000): Promise<number> {
    if (this.isShuttingDown) {
      coreLogger.warn('已经在关闭中，跳过重复调用');
      return 0;
    }

    this.isShuttingDown = true;
    coreLogger.info(`开始执行 ${this.cleanups.size} 个清理函数...`);

    // 按优先级排序
    const sortedCleanups = Array.from(this.cleanups.values()).sort((a, b) => a.priority - b.priority);

    let successCount = 0;
    const startTime = Date.now();

    for (const entry of sortedCleanups) {
      // 检查是否超时
      if (Date.now() - startTime > timeout) {
        console.warn('[Cleanup] 超时，停止执行剩余清理函数');
        break;
      }

      try {
        const result = entry.fn();
        if (result instanceof Promise) {
          // 为单个清理函数设置超时
          const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('Cleanup timeout')), 5000);
          });
          await Promise.race([result, timeoutPromise]);
        }
        successCount++;
      } catch (error) {
        console.error(`[Cleanup] 清理函数执行失败:`, error);
      }
    }

    coreLogger.info(`完成: ${successCount}/${this.cleanups.size} 个清理函数执行成功`);
    this.cleanups.clear();
    this.isShuttingDown = false;
    return successCount;
  }

  /**
   * 获取已注册的清理函数数量
   */
  get count(): number {
    return this.cleanups.size;
  }

  /**
   * 检查是否正在关闭
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }
}

// 导出单例实例
export const cleanupRegistry = new CleanupRegistry();

// 便捷函数
export function registerCleanup(fn: CleanupFn, priority?: number): string {
  return cleanupRegistry.register(fn, priority);
}

export async function runAllCleanups(timeout?: number): Promise<number> {
  return cleanupRegistry.runAll(timeout);
}

export default CleanupRegistry;
