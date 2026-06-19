/**
 * PidRegistry — 进程注册表
 *
 * 每个凌霄进程启动时在 ~/.lingxiao/sessions/ 注册一个 JSON 文件。
 * 文件名 = PID。通过 kill -0 检测进程存活。
 *
 * P1 修复（2026-05-22）：仅靠 process.kill(pid, 0) 判断存活在 PID 重用场景下不安全 —
 * 进程异常死亡未来得及 unregister，OS 把同 PID 分配给无关进程后，listAll 会把 stale 记录
 * 当成活 daemon 返回，导致 status 显示活的、新 daemon 因冲突拒绝拉起。
 *
 * 现在的策略：
 *   1. register 时记录 startedAt（毫秒精度）。
 *   2. isAlive 调用 isSamePidEntry：先 kill(pid,0) 验存活，再读进程真实启动时间
 *      （readProcessStartMs —— 跨平台：Linux /proc、macOS ps、Windows PowerShell），
 *      与 entry.startedAt 比对，差距 > 5s 视为 PID 重用，记为 stale。
 *   3. 本注册表同时承载 worker / external-agent 子进程条目；isOrphanedEntry 通过
 *      parentPid + parentStartedAt 判定「父进程已死」的真孤儿，供 killOrphan* 回收。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { CONFIG_DIR } from '../config.js';
import { processExists, readProcessStartMs } from '../utils/platform.js';

const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

export interface PidEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: 'interactive' | 'bg' | 'daemon' | 'external-agent' | 'worker';
  url?: string;
  name?: string;
  logPath?: string;
  hostname?: string;
  agentId?: string;
  agentName?: string;
  backend?: 'worker_process' | 'claude' | 'codex';
  taskId?: string;
  externalSessionId?: string;
  /** 派生该子进程的凌霄父进程 PID（worker / external-agent 条目）。 */
  parentPid?: number;
  /** parentPid 对应进程的真实启动时间（epoch ms），用于检测父进程 PID 重用。 */
  parentStartedAt?: number;
}

function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function entryPath(pid: number): string {
  return join(SESSIONS_DIR, `${pid}.json`);
}

/** 同主机存活检查（不区分 PID 重用） */
function isAlive(pid: number): boolean {
  return processExists(pid);
}

/**
 * 校验注册表条目对应的进程是否仍是 register 时那个进程（防 PID 重用）。
 *
 * @returns true 仍存活且是同一进程；false 已死或被 PID 重用
 */
function isSamePidEntry(entry: PidEntry): boolean {
  if (!isAlive(entry.pid)) return false;
  // 跨主机记录无法本地校验，保守视为活的（不删别人的注册表）
  if (entry.hostname && entry.hostname !== os.hostname()) return true;
  const procStartMs = readProcessStartMs(entry.pid);
  if (procStartMs === null) {
    // 无法读取进程启动时间（极少数无探测手段的环境）：退化为 kill -0 结果（已在上面通过）
    return true;
  }
  // 5 秒容差：探测抖动存在，但 PID 重用必然秒级以上差异。
  return Math.abs(procStartMs - entry.startedAt) < 5000;
}

/**
 * 判定一个子进程条目（worker / external-agent）是否已成为「真孤儿」——
 * 即派生它的凌霄父进程已退出（或父 PID 被无关进程重用）。
 *
 * - 无 parentPid 记录（旧版本遗留条目）：保守视为孤儿，交由回收。
 * - parentPid 已不存活：真孤儿。
 * - parentPid 仍存活但无法读取其启动时间复核：保守视为非孤儿（不误杀）。
 * - parentPid 仍存活但启动时间已变（PID 被重用）：原父已死，视为孤儿。
 *
 * 这是确定性、跨平台的孤儿判定 —— 不依赖 /proc environ 扫描，全平台一致。
 */
export function isOrphanedEntry(entry: PidEntry): boolean {
  if (!entry.parentPid) return true;
  if (!isAlive(entry.parentPid)) return true;
  if (entry.parentStartedAt == null) return false;
  const curParentStart = readProcessStartMs(entry.parentPid);
  if (curParentStart == null) return false;
  return Math.abs(curParentStart - entry.parentStartedAt) >= 5000;
}

export const PidRegistry = {
  register(entry: PidEntry): void {
    ensureDir();
    try {
      writeFileSync(entryPath(entry.pid), JSON.stringify(entry, null, 2), 'utf-8');
    } catch {
      // Non-critical — don't crash the process
    }
  },

  unregister(pid: number): void {
    try {
      const p = entryPath(pid);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // Non-critical
    }
  },

  listAll(): PidEntry[] {
    ensureDir();
    const entries: PidEntry[] = [];
    try {
      const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
          const entry: PidEntry = JSON.parse(raw);
          if (!isSamePidEntry(entry)) {
            // Clean up stale entry（已死或 PID 重用）
            try { unlinkSync(join(SESSIONS_DIR, file)); } catch { /* expected: concurrent cleanup */ }
            continue;
          }
          entries.push(entry);
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Return empty on error
    }
    return entries;
  },

  findByName(name: string): PidEntry | undefined {
    return PidRegistry.listAll().find(e => e.name === name || e.sessionId === name);
  },

  findByPid(pid: number): PidEntry | undefined {
    try {
      const p = entryPath(pid);
      if (!existsSync(p)) return undefined;
      const raw = readFileSync(p, 'utf-8');
      const entry = JSON.parse(raw) as PidEntry;
      // 保留与 listAll 一致的语义：发现 PID 重用时清掉残留
      if (!isSamePidEntry(entry)) {
        try { unlinkSync(p); } catch { /* expected: concurrent cleanup */ }
        return undefined;
      }
      return entry;
    } catch {/* expected: resource not available */
      return undefined;
    }
  },
};
