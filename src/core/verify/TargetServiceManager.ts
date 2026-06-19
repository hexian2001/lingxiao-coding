/**
 * TargetServiceManager — 验证执行器的目标服务生命周期（blackbox 验证层）。
 *
 * 职责：spawn 目标服务进程 + 分配临时端口（net.createServer listen(0)，
 *   复用 SlidevServerManager 模式）+ 健康检查（HTTP GET healthPath 或 TCP connect）
 *   + CleanupRegistry 回收（进程退出 + map 清理）。
 *
 * 安全边界：仅监听 127.0.0.1，绝不暴露公网；blackbox 层默认关闭，需 Leader 显式授权。
 * 跨平台：纯 node:net + node:child_process，无新依赖、无 Docker（Linux/macOS/Windows × x64/arm64）。
 */
import { createServer as netCreateServer, createConnection, type AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import { registerCleanup } from '../CleanupRegistry.js';
import { coreLogger } from '../Log.js';

export interface TargetServiceConfig {
  cwd: string;
  command: string;
  args?: string[];
  host?: string;            // 默认 127.0.0.1（绝不公网）
  env?: Record<string, string>;
  healthPath?: string;      // 提供=HTTP GET 探活；缺省=TCP connect
  readyTimeoutMs?: number;  // 默认 10000
}

export interface TargetServiceHandle {
  pid: number;
  host: string;
  port: number;
  baseUrl: string;
  stdoutTail: string;
  stderrTail: string;
}

const READY_TIMEOUT_DEFAULT = 10_000;
const TAIL_MAX = 4096;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function findAvailablePort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = netCreateServer();
    server.listen(0, host, () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

function appendTail(buf: string, chunk: Buffer | string): string {
  const next = buf + chunk.toString();
  return next.length > TAIL_MAX ? next.slice(next.length - TAIL_MAX) : next;
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolveProbe(false); }, timeoutMs);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolveProbe(true); });
    socket.on('error', () => { clearTimeout(timer); resolveProbe(false); });
  });
}

function probeHttp(host: string, port: number, path: string, timeoutMs: number): Promise<{ ok: boolean; status?: number }> {
  return new Promise((resolveProbe) => {
    const req = get({ host, port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolveProbe({ ok: (res.statusCode ?? 0) < 500, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolveProbe({ ok: false }); });
    req.on('error', () => resolveProbe({ ok: false }));
  });
}

export class TargetServiceManager {
  private readonly processes = new Map<string, ChildProcess>();

  async start(config: TargetServiceConfig): Promise<TargetServiceHandle> {
    const host = config.host ?? '127.0.0.1';
    const port = await findAvailablePort(host);
    const env = { ...process.env, ...config.env, PORT: String(port), HOST: host };
    const child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env,
      shell: process.platform === 'win32', // Windows 需 shell 解析命令字串
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutTail = '';
    let stderrTail = '';
    child.stdout?.on('data', (c: Buffer) => { stdoutTail = appendTail(stdoutTail, c); });
    child.stderr?.on('data', (c: Buffer) => { stderrTail = appendTail(stderrTail, c); });

    const id = `${child.pid ?? 'svc'}:${port}`;
    this.processes.set(id, child);
    // CleanupRegistry 回收：进程级 SIGTERM→SIGKILL，避免泄漏
    registerCleanup(() => this.kill(id), 60);

    const timeout = config.readyTimeoutMs ?? READY_TIMEOUT_DEFAULT;
    const deadline = Date.now() + timeout;
    let healthy = false;
    while (Date.now() < deadline) {
      await sleep(150);
      if (child.exitCode !== null) break; // 进程已退出，不再探活
      const ok = config.healthPath
        ? (await probeHttp(host, port, config.healthPath, 800)).ok
        : await probeTcp(host, port, 800);
      if (ok) { healthy = true; break; }
    }
    if (!healthy) {
      this.kill(id);
      throw new Error(
        `目标服务未在 ${timeout}ms 内通过健康检查（host=${host}:${port}）。stdout 尾：${stdoutTail.slice(-384)}；stderr 尾：${stderrTail.slice(-384)}`,
      );
    }
    return { pid: child.pid ?? 0, host, port, baseUrl: `http://${host}:${port}`, stdoutTail, stderrTail };
  }

  async stop(id: string): Promise<void> {
    this.kill(id);
  }

  private kill(id: string): void {
    const child = this.processes.get(id);
    if (!child || child.killed) {
      this.processes.delete(id);
      return;
    }
    try {
      // Windows 无 SIGTERM 语义；传 undefined 走平台默认终止
      child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      }, 500);
    } catch (err) {
      coreLogger.debug(`[verify] target service kill failed (id=${id}): ${err instanceof Error ? err.message : String(err)}`);
    }
    this.processes.delete(id);
  }
}
