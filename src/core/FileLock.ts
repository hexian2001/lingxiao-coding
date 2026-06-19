/**
 * 跨进程文件锁 - 参考 Claude Code proper-lockfile
 *
 * 特性:
 * 1. 支持重试和超时
 * 2. 自动释放
 * 3. 锁文件自动创建
 * 4. 异步接口
 * 5. 读写锁支持（多读者-单写者）
 *
 * 注意:
 * - Linux/macOS 使用 fcntl (fs 模块)
 * - Windows 需要特殊处理
 *
 * P0 #5 修复（2026-05-22）：原实现仅靠 mtime 判定 stale，写入空内容；持锁进程
 * 长时间不刷新 mtime，5min 后即使仍在合法持有也会被 unlink，导致跨进程互斥失效。
 * 现已改为：
 *   1. 锁文件内容写入 { pid, host, acquiredAt } JSON
 *   2. tryCleanStaleLock 必须先验证记录的 PID 已死（kill -0 失败）才会 unlink
 *      —— 同主机：直接验证；跨主机：只能依赖 mtime 兜底
 *   3. 持锁期间启动 heartbeat（默认 60s）刷新 mtime，让 stale 检测更可靠
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { t } from '../i18n.js';
import { processExists } from '../utils/platform.js';

interface ErrorWithCode {
  code?: string;
}

interface LockFileContent {
  pid: number;
  host: string;
  acquiredAt: number;
  /**
   * 持锁实例的随机一次性令牌。release() 删除锁文件前必须校验文件内容里的
     * token 仍等于自己持有的 token，否则只关闭 fd 不删文件——避免在崩溃/PID
     * 复用/stale 清理窗口里删掉其他进程刚获取的锁。缺少 token 的锁文件走 mtime 校验。
   */
  token?: string;
}

/**
 * 锁模式
 */
export enum LockMode {
  READ = 'read',   // 共享读锁
  WRITE = 'write', // 独占写锁
}

/**
 * 文件锁选项
 */
export interface FileLockOptions {
  timeout: number;        // 获取锁的超时时间（秒），默认 30
  retryInterval: number;  // 重试间隔（秒），默认 0.1
  /** 是否启动 mtime heartbeat 防止合法持锁被误判 stale，默认 true */
  heartbeat?: boolean;
  /** heartbeat 间隔（毫秒），默认 60_000 */
  heartbeatIntervalMs?: number;
}

const DEFAULT_OPTIONS: FileLockOptions = {
  timeout: 30,
  retryInterval: 0.1,
  heartbeat: true,
  heartbeatIntervalMs: 60_000,
};

/** 锁文件过期时间（5 分钟） */
const LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * 序列化锁文件内容（持锁进程的身份证）。
 */
function buildLockContent(token: string): string {
  const payload: LockFileContent = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: Date.now(),
    token,
  };
  return JSON.stringify(payload);
}

/** 生成一次性持锁令牌。 */
function newLockToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 校验锁文件当前内容是否仍属于本进程的某个持锁实例：
 * token 必须匹配，且 pid + host 也必须是当前进程。任一不符即视为不属于自己。
 */
function lockFileOwnedBy(lockPath: string, token: string | null): boolean {
  if (!token) return false;
  const content = parseLockContent(lockPath);
  return (
    !!content &&
    content.token === token &&
    content.pid === process.pid &&
    content.host === os.hostname()
  );
}

/**
 * 解析锁文件中的 { pid, host, acquiredAt }；空内容或无法解析时返回 null。
 */
function parseLockContent(lockPath: string): LockFileContent | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockFileContent;
    if (typeof parsed?.pid !== 'number') return null;
    return parsed;
  } catch { /* expected: lock file missing or malformed JSON */
    return null;
  }
}

/**
 * 同主机校验目标 PID 是否仍存活；不存在/无权限/PID 已重用都会返回 false。
 * 跨主机时（host !== os.hostname()）调用方应当走 mtime 兜底而不是 unlink。
 */
function isHolderAlive(content: LockFileContent | null): boolean {
  if (!content) return false;
  if (content.host && content.host !== os.hostname()) {
    // 跨主机无法本地校验，保守视为仍存活，避免误删共享存储上的锁。
    return true;
  }
  return processExists(content.pid);
}

/**
 * 检查锁文件是否过期（持锁进程已死，或跨主机/无法解析且超过 LOCK_STALE_MS），若是则清理。
 *
 * 原实现：statSync → parseLockContent → unlinkSync 三步分离，存在 TOCTOU：
 * 在「判定 stale」与「unlink」之间，原持锁进程可能已 release、另一进程已重新 acquire，
 * 此时 unlink 会删掉新持锁者刚获取的锁，破坏跨进程互斥。
 *
 * 现实现：rename-to-unique 两步法原子抢占——
 *   1. 先把疑似 stale 的锁文件 rename 到一个进程内唯一的临时名（rename 是原子的，
 *      只有一个清理者能成功搬走，其余拿到 ENOENT 直接放弃，杜绝并发双删）。
 *   2. 搬走后对「临时副本」二次校验 holder 是否确实已死/确实够旧。
 *      - 确认 stale → unlink 临时副本，返回 true（本次清理者重试 acquire）。
 *      - 误判（holder 其实还活着）→ 把临时副本 rename 回原路径，尽量还原现场，返回 false。
 *   因为搬走的是原文件本身（inode 随之转移），不存在「校验的是 A、删除的是 B」的窗口。
 */
function tryCleanStaleLock(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch { /* expected: lock file may not exist */
    return false; // 文件不存在
  }

  const content = parseLockContent(lockPath);
  const sameHost = !!content && content.host === os.hostname();

  // 先做一次廉价的预判，避免对「明显仍然有效」的锁做昂贵的 rename 抢占。
  if (sameHost) {
    // 同主机：holder 仍存活 → 绝不动它
    if (isHolderAlive(content)) return false;
  } else {
    // 跨主机/无法解析：只能靠 mtime 兜底，未超期 → 不动
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
  }

  // 原子抢占：把锁文件搬到进程内唯一的临时名。只有一个清理者能成功。
  const salvage = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockPath, salvage);
  } catch { /* expected: ENOENT or concurrent cleanup — abandon and retry */
    // ENOENT（已被 release/别的清理者搬走）或其它错误 → 放弃，让调用方重试 acquire
    return false;
  }

  // 搬走后二次校验：确认副本确实 stale 才删；否则尽力还原现场。
  const salvaged = parseLockContent(salvage);
  const salvagedSameHost = !!salvaged && salvaged.host === os.hostname();
  let stillStale: boolean;
  if (salvagedSameHost) {
    stillStale = !isHolderAlive(salvaged);
  } else {
    let salvageStat: fs.Stats | null = null;
    try {
      salvageStat = fs.statSync(salvage);
    } catch { /* 副本不见了，按 stale 处理 */ }
    stillStale = !salvageStat || Date.now() - salvageStat.mtimeMs > LOCK_STALE_MS;
  }

  if (stillStale) {
    try {
      fs.unlinkSync(salvage);
    } catch { /* 已不存在也算清理成功 */ }
    return true;
  }

  // 误判：holder 仍活着。把锁还原回原路径（若原路径已被新持锁者占用则丢弃副本）。
  try {
    fs.renameSync(salvage, lockPath);
  } catch { /* expected: rename back may fail if new holder acquired lock */
    try { fs.unlinkSync(salvage); } catch { /* ignore */ }
  }
  return false;
}

/**
 * 跨进程文件锁
 *
 * 使用 fs 模块的文件锁功能实现跨进程互斥
 */
export class FileLock {
  private lockPath: string;
  private options: FileLockOptions;
  private fd: number | null = null;
  private locked = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 本次持锁的一次性令牌；release 时用它校验锁文件仍属于自己。 */
  private token: string | null = null;

  constructor(lockPath: string, options?: Partial<FileLockOptions>) {
    this.lockPath = lockPath;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 获取锁
   */
  async acquire(blocking = true): Promise<boolean> {
    if (this.locked) return true;

    // 确保锁文件目录存在
    const dir = path.dirname(this.lockPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const startTime = Date.now();
    const timeoutMs = this.options.timeout * 1000;
    const retryMs = this.options.retryInterval * 1000;

    while (true) {
      try {
        // 使用独占创建近似实现跨进程互斥
        this.fd = fs.openSync(
          this.lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          0o644
        );
        // 写入持锁进程身份 + 一次性令牌，stale 检测与 release 校验才能精确判断
        this.token = newLockToken();
        try {
          fs.writeSync(this.fd, buildLockContent(this.token));
        } catch {
          // 写身份失败：无法校验所有权，release 将不删文件。清空 token 走 mtime 兜底。
          this.token = null;
        }
        this.locked = true;
        this.startHeartbeat();
        return true;
      } catch (e: unknown) {
        const error = e as ErrorWithCode;
        if (this.fd !== null) {
          try {
            fs.closeSync(this.fd);
          } catch { /* fd 可能已关闭 */ }
          this.fd = null;
        }

        if (error.code && error.code !== 'EEXIST') {
          throw e;
        }

        // 检查锁文件是否过期
        if (tryCleanStaleLock(this.lockPath)) {
          continue; // 清理后立即重试
        }

        if (!blocking) return false;

        // 检查超时
        if (Date.now() - startTime > timeoutMs) {
          throw new Error(t('error.filellock_timeout', this.lockPath, this.options.timeout));
        }

        // 等待重试
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  }

  /**
   * 释放锁
   */
  release(): void {
    if (!this.locked || this.fd === null) return;
    this.stopHeartbeat();

    try {
      fs.closeSync(this.fd);
    } catch { /* fd 可能已关闭 */ }

    // 只有在锁文件仍属于本实例（token+pid+host 均匹配）时才 unlink。
    // 否则：我们的锁可能已在 stale 误判后被别人重新获取，贸然 unlink 会删掉别人的锁。
    if (lockFileOwnedBy(this.lockPath, this.token)) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch { /* 锁文件可能已删除 */ }
    }

    this.fd = null;
    this.locked = false;
    this.token = null;
  }

  /**
   * 检查是否持有锁
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * 清理锁文件。
   *
   * 注意：只通过 release() 释放「本实例持有的锁」（含 token+pid+host 所有权校验），
   * 不再无条件 unlink——否则当本实例并未持锁、而锁文件已被其他进程合法持有时，
   * 直接 unlink 会删掉别人的锁，正是要修复的缺陷。
   */
  async cleanup(): Promise<void> {
    this.release();
  }

  /**
   * 启动 mtime heartbeat：每 heartbeatIntervalMs 触摸一次锁文件，
   * 确保合法持锁期间不会被 mtime 兜底逻辑误判 stale。
   */
  private startHeartbeat(): void {
    if (!this.options.heartbeat) return;
    const interval = this.options.heartbeatIntervalMs ?? 60_000;
    this.heartbeatTimer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(this.lockPath, now, now);
      } catch {
        // 锁文件已被外部删除，停掉 heartbeat 让下次操作自然报错
        this.stopHeartbeat();
      }
    }, interval);
    // 不要让锁文件 heartbeat 拖住进程退出
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/**
 * 异步文件锁
 */
export class AsyncFileLock {
  private lockPath: string;
  private options: FileLockOptions;
  private locked = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 本次持锁的一次性令牌；release 时用它校验锁文件仍属于自己。 */
  private token: string | null = null;

  constructor(lockPath: string, options?: Partial<FileLockOptions>) {
    this.lockPath = lockPath;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 异步获取锁
   */
  async acquire(blocking = true): Promise<boolean> {
    if (this.locked) return true;

    // 确保锁文件目录存在
    const dir = path.dirname(this.lockPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const startTime = Date.now();
    const timeoutMs = this.options.timeout * 1000;
    const retryMs = this.options.retryInterval * 1000;

    while (true) {
      try {
        // 尝试创建锁文件（独占模式）
        const fd = await fs.promises.open(
          this.lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          0o644
        );
        this.token = newLockToken();
        try {
          await fd.write(buildLockContent(this.token));
        } catch {
          // 写身份失败：无法校验所有权，release 将不删文件。清空 token 走 mtime 兜底。
          this.token = null;
        }
        await fd.close();
        this.locked = true;
        this.startHeartbeat();
        return true;
      } catch (e: unknown) {
        const error = e as ErrorWithCode;
        if (error.code === 'EEXIST') {
          // 检查锁文件是否过期
          if (tryCleanStaleLock(this.lockPath)) {
            continue; // 清理后立即重试
          }

          // 锁文件已存在
          if (!blocking) return false;

          // 检查超时
          if (Date.now() - startTime > timeoutMs) {
            throw new Error(t('error.filellock_timeout_waiting', this.lockPath));
          }

          // 等待重试
          await new Promise(resolve => setTimeout(resolve, retryMs));
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * 释放锁
   */
  async release(): Promise<void> {
    if (!this.locked) return;
    this.stopHeartbeat();

    // 只有在锁文件仍属于本实例（token+pid+host 均匹配）时才 unlink，
    // 避免删掉 stale 误判后被别人重新获取的锁。
    if (lockFileOwnedBy(this.lockPath, this.token)) {
      try {
        await fs.promises.unlink(this.lockPath);
      } catch { /* 锁文件可能已删除 */ }
    }

    this.locked = false;
    this.token = null;
  }

  /**
   * 检查是否持有锁
   */
  isLocked(): boolean {
    return this.locked;
  }

  private startHeartbeat(): void {
    if (!this.options.heartbeat) return;
    const interval = this.options.heartbeatIntervalMs ?? 60_000;
    this.heartbeatTimer = setInterval(() => {
      const now = new Date();
      fs.promises.utimes(this.lockPath, now, now).catch(() => this.stopHeartbeat());
    }, interval);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
