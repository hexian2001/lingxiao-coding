/**
 * SQLite 数据库锁恢复机制
 *
 * 根因：多个 lingxiao 进程共享同一个 SQLite 数据库，异常退出（SIGKILL / 崩溃 / 终端被关）
 * 时 db.close() 未执行，WAL 写锁残留，下一个进程打开时撞 "database is locked"。
 *
 * 设计原则：
 * 1. 不删除 .db-wal / .db-shm 文件 —— WAL 模式下这些文件可能含有未 checkpoint 的提交，
 *    强删会丢数据。正确做法是让 SQLite 在下次打开时自动恢复（WAL 设计本就支持崩溃恢复）。
 * 2. "database is locked" 的真正成因往往是：
 *    a) 残留进程仍持有连接（最常见）—— 检测并提示。
 *    b) busy_timeout 不足 / 写并发过高 —— 已在 DatabaseManager 配置。
 *    c) NFS 等不支持 POSIX flock 的文件系统 —— 检测并告警。
 * 3. 进程退出时执行 PRAGMA wal_checkpoint(TRUNCATE) + db.close()，
 *    确保 WAL 被合并回主库、写锁彻底释放。
 */

import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { coreLogger } from './Log.js';

/**
 * 检查进程是否存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: 进程不存在
  }
}

/**
 * 查找所有 lingxiao 进程（排除当前进程）。
 * 用 ps + grep 而非 /proc 遍历，兼容 macOS / Linux。
 */
function findLingxiaoProcesses(): Array<{ pid: number; cmdline: string }> {
  try {
    const output = execSync('ps -eo pid=,command=', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });

    const results: Array<{ pid: number; cmdline: string }> = [];
    for (const line of output.split('\n')) {
      if (!line.includes('lingxiao')) continue;
      if (line.includes('grep')) continue;
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue; // 排除自己
      results.push({ pid, cmdline: match[2] });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 检测数据库所在文件系统是否支持 POSIX advisory locking。
 * NFS / 某些网络文件系统不支持，会导致 WAL 锁失效 / 误报 locked。
 */
function isPosixLockingSafe(dbPath: string): boolean {
  try {
    // 简单启发式：路径含 nfs / 挂载点检测
    if (/\/nfs\//i.test(dbPath) || /\/media\//i.test(dbPath)) return false;
    // mount 输出检查（Linux）
    if (process.platform === 'linux') {
      const mountOutput = execSync('mount 2>/dev/null', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const dir = dbPath;
      if (mountOutput.includes('nfs') && mountOutput.split('\n').some((m) => m.includes('nfs') && dir.startsWith(m.split(' ')[2]))) {
        return false;
      }
    }
    return true;
  } catch {
    return true; // 检测失败时乐观假设安全
  }
}

export interface LockRecoveryResult {
  /** 是否可以安全重试打开（无活跃竞争进程） */
  canRetry: boolean;
  /** 仍存活的竞争进程列表 */
  aliveProcesses: Array<{ pid: number; cmdline: string }>;
  /** 诊断信息 */
  diagnostics: string[];
}

/**
 * 诊断并尝试恢复数据库锁。
 *
 * 不删除 WAL 文件（会丢数据），而是：
 * - 检测残留 lingxiao 进程并报告
 * - 检测文件系统是否支持锁
 * - 给出可重试的判断
 */
export function tryRecoverDatabaseLock(dbPath: string): LockRecoveryResult {
  const diagnostics: string[] = [];
  coreLogger.warn(`[DatabaseLockRecovery] Diagnosing lock on: ${dbPath}`);

  // 1. 检测文件系统
  if (!isPosixLockingSafe(dbPath)) {
    diagnostics.push('Database is on a network/NFS filesystem — POSIX locking unreliable, consider moving to local disk');
    coreLogger.error('[DatabaseLockRecovery] WARNING: database on NFS/network filesystem');
  }

  // 2. 查找所有 lingxiao 进程
  const allProcs = findLingxiaoProcesses();
  const aliveProcs = allProcs.filter((p) => isProcessAlive(p.pid));

  diagnostics.push(`Found ${aliveProcs.length} other live lingxiao process(es)`);
  if (aliveProcs.length > 0) {
    for (const p of aliveProcs) {
      diagnostics.push(`  PID ${p.pid}: ${p.cmdline.slice(0, 80)}`);
    }
    coreLogger.warn(`[DatabaseLockRecovery] ${aliveProcs.length} live process(es) still holding DB: ${aliveProcs.map((p) => p.pid).join(', ')}`);
    // 有活跃进程时不能强制清锁，需等待 busy_timeout 自然排队
    return { canRetry: true, aliveProcesses: aliveProcs, diagnostics };
  }

  // 3. 无活跃进程 —— WAL 模式下 SQLite 打开时会自动恢复，
  //    "database is locked" 此时多半是瞬态文件句柄释放延迟，等待重试即可。
  diagnostics.push('No competing processes — WAL will auto-recover on next open');
  coreLogger.info('[DatabaseLockRecovery] No competing processes; safe to retry open (WAL auto-recovers)');

  // 4. WAL 文件存在性检查（仅诊断，不删除）
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) {
    const st = statSync(walPath);
    diagnostics.push(`WAL file exists: ${walPath} (${st.size} bytes) — will be replayed on open`);
  }
  if (existsSync(shmPath)) {
    diagnostics.push(`SHM file exists: ${shmPath} — will be rebuilt on open`);
  }

  return { canRetry: true, aliveProcesses: [], diagnostics };
}

/**
 * 增强的数据库关闭：
 * 1. 先执行 wal_checkpoint(TRUNCATE) 把 WAL 合并回主库并截断 WAL 文件
 * 2. 再 db.close() 释放文件句柄和写锁
 * 3. 同步等待 50ms 让 OS 释放文件描述符
 *
 * 这保证了：进程退出后 WAL 文件被截断到 0 字节，写锁彻底释放，
 * 下一个进程打开时不会撞到残留锁。
 */
export function robustDatabaseClose(db: { close: () => void; exec: (sql: string) => void } | null, dbPath: string): void {
  if (!db) return;

  // 1. checkpoint：把 WAL 的内容合并回主数据库文件，并截断 WAL。
  //    TRUNCATE 模式会把 -wal 文件截断到 0 字节，释放磁盘空间和写锁。
  //    即便 checkpoint 失败（例如仍有读连接），close() 也会兜底释放锁。
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    coreLogger.warn(`[DatabaseLockRecovery] wal_checkpoint failed (will still close): ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. 关闭连接，释放写锁
  try {
    db.close();
    coreLogger.info(`[DatabaseLockRecovery] Database closed cleanly: ${dbPath}`);
  } catch (error) {
    coreLogger.warn(`[DatabaseLockRecovery] Error closing database: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3. 给 OS 一点时间释放文件描述符（同步等待，避免立即重开时撞残留句柄）
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleepBuf, 0, 0, 50);
}
