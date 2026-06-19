/**
 * DaemonManager — Daemon 进程管理
 *
 * 管理凌霄后台常驻服务 (daemon) 的生命周期。
 * Daemon 是一个 detached 子进程，在父进程退出后继续运行。
 * 状态通过 ~/.lingxiao/daemon.json 持久化。
 *
 * v2 新增：
 *   - startDaemonWithSupervisor(): 启动 daemon + 自动守护（崩溃自愈）
 *   - 内嵌 EternalSupervisor，指数退避重启
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { CONFIG_DIR } from '../config.js';
import { EternalSupervisor, type SupervisorConfig } from './EternalSupervisor.js';
import { alertManager } from './AlertManager.js';
import { isDaemonActiveStatus, type CoreDaemonStatus } from './StateSemantics.js';
import { killProcess, processExists } from '../utils/platform.js';
import { sleep } from '../utils/sleep.js';

const DAEMON_FILE = join(CONFIG_DIR, 'daemon.json');
const TOKEN_FILE = join(CONFIG_DIR, 'server-token');
const DAEMON_DB_PATH = join(CONFIG_DIR, 'daemon', 'daemon.db');
const STARTUP_HEALTH_TIMEOUT_MS = 30_000;
const STARTUP_HEALTH_POLL_MS = 500;

export type DaemonStartReason = 'manual_start' | 'manual_restart' | 'auto_recover';

export interface DaemonInfo {
  pid: number;
  port: number;
  host: string;
  url: string;
  startedAt: number;
  token?: string;
  lastStartReason?: DaemonStartReason;
  restartCount?: number;
  lastHealthCheckAt?: number;
  lastHealthCheckOk?: boolean;
  lastError?: string;
}

export interface DaemonStatus {
  status: CoreDaemonStatus;
  pid?: number;
  port?: number;
  host?: string;
  url?: string;
  token?: string;
  uptime?: number;
  startedAt?: number;
  lastStartReason?: DaemonStartReason;
  restartCount?: number;
  lastHealthCheckAt?: number;
  lastHealthCheckOk?: boolean;
  lastError?: string;
}

function isAlive(pid: number): boolean {
  return processExists(pid);
}

function readDaemonFile(): DaemonInfo | null {
  try {
    if (!existsSync(DAEMON_FILE)) return null;
    const raw = readFileSync(DAEMON_FILE, 'utf-8');
    return JSON.parse(raw) as DaemonInfo;
  } catch { /* expected: file missing or malformed JSON */
    return null;
  }
}

function writeDaemonFile(info: DaemonInfo): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2), 'utf-8');
}

function removeDaemonFile(): void {
  try {
    if (existsSync(DAEMON_FILE)) unlinkSync(DAEMON_FILE);
  } catch { /* expected: file already removed */ }
}

function readServerToken(): string | undefined {
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf-8').trim() || undefined;
  } catch { /* expected: file missing or unreadable */ }
  return undefined;
}
export async function waitForDaemonHealthy(input: {
  url: string;
  pid: number;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  isAliveImpl?: (pid: number) => boolean;
  now?: () => number;
}): Promise<{ ok: boolean; checkedAt: number; error?: string }> {
  const timeoutMs = input.timeoutMs ?? STARTUP_HEALTH_TIMEOUT_MS;
  const pollMs = input.pollMs ?? STARTUP_HEALTH_POLL_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const isAliveImpl = input.isAliveImpl ?? isAlive;
  const now = input.now ?? Date.now;

  const startedAt = now();
  let lastError = '';

  while (now() - startedAt < timeoutMs) {
    if (!isAliveImpl(input.pid)) {
      return {
        ok: false,
        checkedAt: now(),
        error: 'daemon process exited before passing health check',
      };
    }

    try {
      const response = await fetchImpl(`${input.url}/health`);
      if (response.ok) {
        return {
          ok: true,
          checkedAt: now(),
        };
      }
      lastError = `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(pollMs);
  }

  return {
    ok: false,
    checkedAt: now(),
    error: lastError || `health check timed out after ${timeoutMs}ms`,
  };
}

export const DaemonManager = {
  /**
   * 获取当前 daemon 状态
   */
  getStatus(): DaemonStatus {
    const info = readDaemonFile();
    if (!info) return { status: 'stopped' };

    if (!isAlive(info.pid)) {
      removeDaemonFile();
      return { status: 'stopped' };
    }

    return {
      status: 'running',
      pid: info.pid,
      port: info.port,
      host: info.host,
      url: info.url,
      token: info.token || readServerToken(),
      startedAt: info.startedAt,
      uptime: Math.floor((Date.now() - info.startedAt) / 1000),
      lastStartReason: info.lastStartReason,
      restartCount: info.restartCount,
      lastHealthCheckAt: info.lastHealthCheckAt,
      lastHealthCheckOk: info.lastHealthCheckOk,
      lastError: info.lastError,
    };
  },

  /**
   * 启动 daemon（幂等：已有运行中的 daemon 直接返回）
   * 文件锁防止并发启动
   */
  async startDaemon(port = 8080, host = '127.0.0.1', reason: DaemonStartReason = 'manual_start', sessionId?: string): Promise<DaemonStatus> {
    // 幂等检查：已有运行中的 daemon 直接返回
    const existing = DaemonManager.getStatus();
    if (isDaemonActiveStatus(existing.status)) {
      return existing;
    }

    // 文件锁：防止并发启动
    const lockFile = join(CONFIG_DIR, 'daemon.lock');
    const lockFd = (() => {
      try {
        // O_CREAT | O_EXCL — 原子创建，已存在则抛异常
        const fd = openSync(lockFile, 'wx');
        writeFileSync(lockFile, String(process.pid), 'utf-8');
        return fd;
      } catch { /* expected: lock file exists — check if holder is alive */
        // 锁文件存在，检查持有者是否还活着
        try {
          const lockPid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
          if (lockPid && isAlive(lockPid)) {
            // 另一个进程正在启动 daemon，等待它完成
            return -1;
          }
          // 持有者已死，清理残留锁
          unlinkSync(lockFile);
          const fd = openSync(lockFile, 'wx');
          writeFileSync(lockFile, String(process.pid), 'utf-8');
          return fd;
        } catch { /* expected: concurrent lock contention */
          return -1;
        }
      }
    })();

    if (lockFd === -1) {
      // 等待其他进程完成启动
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const s = DaemonManager.getStatus();
        if (isDaemonActiveStatus(s.status)) return s;
      }
      // 超时，清理锁文件重试
      try { unlinkSync(lockFile); } catch { /* expected: already removed */ }
      return DaemonManager.startDaemon(port, host, reason);
    }

    const releaseLock = () => {
      try { closeSync(lockFd); } catch { /* expected: fd may already be closed */ }
      try { unlinkSync(lockFile); } catch { /* expected: file may already be removed */ }
    };

    const previousInfo = readDaemonFile();

    // Find the CLI entry point
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // The CLI script is at dist/cli.js (relative to this compiled file in dist/core/)
    const cliPath = join(__dirname, '..', 'cli.js');

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'start', '--daemon-mode'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          LINGXIAO_WEB_PORT: String(port),
          LINGXIAO_WEB_HOST: host,
          LINGXIAO_DAEMON_MODE: '1',
          LINGXIAO_DAEMON_DB_PATH: DAEMON_DB_PATH,
          ...(sessionId ? { LINGXIAO_DAEMON_SESSION_ID: sessionId } : {}),
        },
      });

      child.on('error', (err) => { releaseLock(); reject(err); });
      child.unref();

      // 释放文件锁（子进程已启动）
      releaseLock();

      // Write daemon file optimistically — the child will overwrite with real PID/port
      const pid = child.pid!;
      const startedAt = Date.now();
      const url = `http://${host}:${port}`;
      const token = readServerToken();
      const info: DaemonInfo = {
        pid,
        port,
        host,
        url,
        startedAt,
        token,
        lastStartReason: reason,
        restartCount: (previousInfo?.restartCount || 0) + (reason === 'manual_restart' || reason === 'auto_recover' ? 1 : 0),
        lastHealthCheckAt: startedAt,
        lastHealthCheckOk: false,
      };
      writeDaemonFile(info);

      void (async () => {
        try {
          // 健康检查：轮询 daemon.json 获取真实 URL
          // daemon 启动后会通过 updateDaemonPid 写入真实端口到 daemon.json
          // 关键：初始 daemon.json 的 url 可能是占位的（随机端口时），必须等 updateDaemonPid 覆盖
          const initialUrl = url;
          let healthUrl = '';
          const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
          while (Date.now() < deadline) {
            if (!isAlive(pid)) {
              removeDaemonFile();
              reject(new Error('Daemon process exited before passing health check'));
              return;
            }
            // 每次循环都从 daemon.json 读取最新 URL
            // updateDaemonPid 会覆盖初始占位 URL
            const latestInfo = readDaemonFile();
            const latestUrl = latestInfo?.url || '';
            // 只有当 URL 被 updateDaemonPid 更新过（不同于初始占位 URL）才尝试健康检查
            if (latestUrl && latestUrl !== initialUrl) {
              healthUrl = latestUrl;
            }
            if (!healthUrl) {
              await sleep(STARTUP_HEALTH_POLL_MS);
              continue;
            }
            try {
              const resp = await fetch(`${healthUrl}/health`);
              if (resp.ok) {
                const finalInfo = readDaemonFile() || info;
                writeDaemonFile({
                  ...finalInfo,
                  lastHealthCheckAt: Date.now(),
                  lastHealthCheckOk: true,
                  lastError: '',
                });
                resolve(DaemonManager.getStatus());
                return;
              }
            } catch { /* expected: health check may fail during startup */ }
            await sleep(STARTUP_HEALTH_POLL_MS);
          }
          try { await killProcess(pid, 'SIGTERM', { tree: true }); } catch { /* expected: process may already be dead */ }
          removeDaemonFile();
          reject(new Error(`Daemon failed health check: timed out after ${STARTUP_HEALTH_TIMEOUT_MS}ms`));
        } catch (error) {
          try { await killProcess(pid, 'SIGTERM', { tree: true }); } catch { /* expected: process may already be dead */ }
          removeDaemonFile();
          reject(error);
        }
      })();
    });
  },

  /**
   * 停止 daemon
   */
  async stopDaemon(): Promise<{ success: boolean; error?: string }> {
    const info = readDaemonFile();
    if (!info) return { success: true };

    if (!isAlive(info.pid)) {
      removeDaemonFile();
      return { success: true };
    }

    try {
      await killProcess(info.pid, 'SIGTERM', { tree: true });
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          if (!isAlive(info.pid) || attempts > 30) {
            clearInterval(check);
            resolve();
          }
        }, 200);
      });

      // Force kill if still alive
      if (isAlive(info.pid)) {
        await killProcess(info.pid, 'SIGKILL', { tree: true });
      }

      removeDaemonFile();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * 重启 daemon
   */
  async restartDaemon(port?: number, host?: string): Promise<DaemonStatus> {
    const existing = readDaemonFile();
    const targetPort = port || existing?.port || 8080;
    const targetHost = host || existing?.host || '127.0.0.1';

    await DaemonManager.stopDaemon();
    await new Promise(r => setTimeout(r, 500));
    return DaemonManager.startDaemon(targetPort, targetHost, 'manual_restart');
  },

  /**
   * 由 daemon 进程本身调用，更新 PID 文件记录真实 PID
   */
  updateDaemonPid(pid: number, port: number, host: string): void {
    const existing = readDaemonFile();
    const startedAt = existing?.startedAt || Date.now();
    const url = `http://${host}:${port}`;
    writeDaemonFile({
      pid,
      port,
      host,
      url,
      startedAt,
      token: existing?.token || readServerToken(),
      lastStartReason: existing?.lastStartReason,
      restartCount: existing?.restartCount,
      lastHealthCheckAt: existing?.lastHealthCheckAt,
      lastHealthCheckOk: existing?.lastHealthCheckOk,
      lastError: existing?.lastError,
    });
  },

  // ─── Supervisor (v2: 进程级自愈) ───

  /** 内部 EternalSupervisor 实例引用 */
  _supervisor: undefined as EternalSupervisor | undefined,

  /**
   * 启动 daemon + 自动守护（崩溃自愈）。
   *
   * 与 startDaemon() 的区别：启动后启动 EternalSupervisor 后台监控，
   * daemon 进程崩溃时自动重启（指数退避，最多 5 次）。
   *
   * 适合「无人值守」场景 — 调用一次即进入永久守护模式。
   */
  async startDaemonWithSupervisor(
    port = 8080,
    host = '127.0.0.1',
    supervisorOptions?: {
      maxRestarts?: number;
      healthCheckIntervalMs?: number;
    },
    sessionId?: string,
  ): Promise<DaemonStatus> {
    // 先启动 daemon
    const status = await DaemonManager.startDaemon(port, host, 'auto_recover', sessionId);

    // 如果已有 supervisor 在跑，先停掉
    DaemonManager._supervisor?.stop();

    const info = readDaemonFile();
    if (!info) throw new Error('Daemon started but daemon.json not found');

    const supervisor = new EternalSupervisor({
      healthUrl: info.url,
      pid: info.pid,
      maxRestarts: supervisorOptions?.maxRestarts ?? 5,
      healthCheckIntervalMs: supervisorOptions?.healthCheckIntervalMs ?? 15_000,
      onRestart: async () => {
        // 重启 daemon（先停再起，复用已有端口/主机）
        const current = readDaemonFile();
        const p = current?.port ?? port;
        const h = current?.host ?? host;
        await DaemonManager.stopDaemon();
        await sleep(500);
        await DaemonManager.startDaemon(p, h, 'auto_recover');
        const newInfo = readDaemonFile();
        if (!newInfo) throw new Error('Restart failed: no daemon.json');
        return { pid: newInfo.pid, healthUrl: newInfo.url };
      },
      onGiveUp: (reason) => {
        alertManager.emit({
          type: 'supervisor_give_up',
          severity: 'critical',
          message: reason,
          source: 'DaemonManager',
        });
      },
      onAlert: (alert) => {
        alertManager.emit({
          type: `supervisor_${alert.type}`,
          severity: alert.type === 'give_up' ? 'critical' : 'warning',
          message: alert.message,
          source: 'DaemonManager',
          metadata: { attempt: alert.attempt, maxRestarts: alert.maxRestarts },
        });
      },
    });

    supervisor.start();
    DaemonManager._supervisor = supervisor;

    return status;
  },

  /** 停止 supervisor 守护循环 */
  stopSupervisor(): void {
    DaemonManager._supervisor?.stop();
    DaemonManager._supervisor = undefined;
  },

  /** 获取 supervisor 状态 */
  getSupervisorStatus() {
    return DaemonManager._supervisor?.getState() ?? null;
  },
};
