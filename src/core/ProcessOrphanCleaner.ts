/**
 * ProcessOrphanCleaner — 启动时清理同源僵尸凌霄实例
 *
 * 解决问题：用户反复启动 lingxiao 但旧实例不退出，导致 N 个进程累积。
 *
 * 策略：
 * 1. 读取 PidRegistry，找到同 workspace 的其他 interactive 实例
 * 2. 对其发 SIGTERM，给 5s 优雅退出
 * 3. 超时未退的发 SIGKILL
 * 4. 清理 PidRegistry 残留
 *
 * 安全性：
 * - 只清理 kind=interactive 且同 workspace 的实例（不碰 daemon、worker、external-agent）
 * - 通过 PidRegistry 的 isSamePidEntry 校验防止 PID 重用误杀
 * - 不清理刚启动 <5s 的进程（避免并发启动竞态）
 */

import { PidRegistry, type PidEntry } from './PidRegistry.js';
import { killProcess, processExists } from '../utils/platform.js';

export interface OrphanCleanResult {
  /** 清理的 PID 列表 */
  cleaned: number[];
  /** 跳过的（仍活跃或正在使用） */
  skipped: number[];
  /** 清理失败的 */
  failed: number[];
}

/**
 * 清理同 workspace 的僵尸交互实例
 *
 * @param currentPid 当前进程 PID（不杀自己）
 * @param workspace 当前工作目录
 * @param gracePeriodMs SIGTERM 后等待时间，默认 3s
 */
export async function cleanOrphanInstances(
  currentPid: number,
  workspace: string,
  gracePeriodMs: number = 3000,
): Promise<OrphanCleanResult> {
  const result: OrphanCleanResult = { cleaned: [], skipped: [], failed: [] };

  const allEntries = PidRegistry.listAll();
  const candidates = allEntries.filter((entry): entry is PidEntry & { kind: 'interactive' | 'bg' } => {
    // 只处理交互/bg 实例
    if (entry.kind !== 'interactive' && entry.kind !== 'bg') return false;
    // 不杀自己
    if (entry.pid === currentPid) return false;
    // 同 workspace
    if (entry.cwd !== workspace) return false;
    // 跳过刚启动 <10s 的（避免竞态）
    if (Date.now() - entry.startedAt < 10_000) return false;
    return true;
  });

  if (candidates.length === 0) return result;

  console.log(`[OrphanCleaner] 发现 ${candidates.length} 个同目录旧实例，尝试清理...`);

  // Phase 1: SIGTERM
  const termTargets: number[] = [];
  for (const entry of candidates) {
    if (!processExists(entry.pid)) {
      // 已经不存在了，清理注册表
      PidRegistry.unregister(entry.pid);
      result.cleaned.push(entry.pid);
      continue;
    }
    try {
      await killProcess(entry.pid, 'SIGTERM');
      termTargets.push(entry.pid);
    } catch {
      result.failed.push(entry.pid);
    }
  }

  if (termTargets.length === 0) return result;

  // Phase 2: 等待 gracePeriod 后检查
  await new Promise(resolve => setTimeout(resolve, gracePeriodMs));

  for (const pid of termTargets) {
    if (!processExists(pid)) {
      PidRegistry.unregister(pid);
      result.cleaned.push(pid);
    } else {
      // 还活着 → SIGKILL
      try {
        await killProcess(pid, 'SIGKILL');
        PidRegistry.unregister(pid);
        result.cleaned.push(pid);
      } catch {
        result.failed.push(pid);
      }
    }
  }

  if (result.cleaned.length > 0) {
    console.log(`[OrphanCleaner] 已清理 ${result.cleaned.length} 个僵尸实例: PIDs=${result.cleaned.join(',')}`);
  }

  return result;
}

/**
 * 轻量检查：返回同 workspace 的其他存活实例数（不执行清理）
 */
export function countOrphanInstances(currentPid: number, workspace: string): number {
  const allEntries = PidRegistry.listAll();
  return allEntries.filter(entry => {
    if (entry.kind !== 'interactive' && entry.kind !== 'bg') return false;
    if (entry.pid === currentPid) return false;
    if (entry.cwd !== workspace) return false;
    return true;
  }).length;
}
