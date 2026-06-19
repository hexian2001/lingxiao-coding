import { createServer as netCreateServer, type AddressInfo } from 'net';
import { resolve } from 'path';
import { coreLogger } from './Log.js';

export interface SlidevServerHandle {
  id: string;
  projectDir: string;
  slidesPath: string;
  host: string;
  port: number;
  url: string;
  createdAt: number;
  lastAccessAt: number;
}

interface ManagedSlidevServer extends SlidevServerHandle {
  server: { close?: () => Promise<void> | void; listen?: (port?: number, isRestart?: boolean) => Promise<unknown> };
}

async function findAvailablePort(host: string, requestedPort?: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = netCreateServer();
    server.listen(requestedPort ?? 0, host, () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolvePort(port));
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (requestedPort && err.code === 'EADDRINUSE') {
        const fallback = netCreateServer();
        fallback.listen(0, host, () => {
          const port = (fallback.address() as AddressInfo).port;
          fallback.close(() => resolvePort(port));
        });
        fallback.on('error', reject);
      } else {
        reject(err);
      }
    });
  });
}

function idFromProjectDir(projectDir: string): string {
  return Buffer.from(resolve(projectDir)).toString('base64url');
}

export class SlidevServerManager {
  /**
   * in-flight + 已就绪的 server 创建 Promise，按 projectDir 派生的 id 去重。
   * 并发同一 projectDir 的 start 复用同一个 Promise，避免后到的调用重复 createServer
   * 覆盖前者的 server 实例，导致前一个 server 端口/内存泄漏（无人 close）。
   */
  private servers = new Map<string, Promise<ManagedSlidevServer>>();
  /** 已成功创建并就绪的 server，供同步 getter / 清理 / 销毁使用 */
  private resolved = new Map<string, ManagedSlidevServer>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly ttlMs = 60 * 60_000;

  async start(input: {
    projectDir: string;
    slidesPath: string;
    host?: string;
    port?: number;
  }): Promise<SlidevServerHandle> {
    const projectDir = resolve(input.projectDir);
    const id = idFromProjectDir(projectDir);

    // 并发去重：若已有同 projectDir 的 in-flight / 已就绪 Promise，复用它，
    // 绝不重复创建。占位在 createServer 之前完成，关闭并发竞态窗口。
    const inflight = this.servers.get(id);
    if (inflight) {
      try {
        const server = await inflight;
        server.lastAccessAt = Date.now();
        return this.publicHandle(server);
      } catch {
        // 之前那次创建失败：清掉坏槽位（若仍是同一个）后继续重新创建
        if (this.servers.get(id) === inflight) {
          this.servers.delete(id);
        }
      }
    }

    const startPromise = this.createManagedServer(id, projectDir, input);
    // 立刻占位：后续并发 start 会命中这个 Promise 而非另起一个 server
    this.servers.set(id, startPromise);

    try {
      const server = await startPromise;
      this.resolved.set(id, server);
      this.ensureCleanupTimer();
      return this.publicHandle(server);
    } catch (err) {
      // 创建失败：撤销占位，避免坏槽位永久卡住后续 start
      if (this.servers.get(id) === startPromise) {
        this.servers.delete(id);
      }
      throw err;
    }
  }

  private async createManagedServer(
    id: string,
    projectDir: string,
    input: { projectDir: string; slidesPath: string; host?: string; port?: number },
  ): Promise<ManagedSlidevServer> {
    const host = input.host || '127.0.0.1';
    const port = await findAvailablePort(host, input.port);
    const server = await this.instantiateSlidevServer(input.slidesPath, host, port);

    const url = `http://${host}:${port}/`;
    const handle: ManagedSlidevServer = {
      id,
      projectDir,
      slidesPath: input.slidesPath,
      host,
      port,
      url,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      server,
    };
    return handle;
  }

  /**
   * 真正拉起底层 @slidev/cli 服务。抽成独立的可重写方法，便于测试在不依赖真实
   * Slidev 运行时的前提下验证并发去重 / 生命周期逻辑。
   */
  protected async instantiateSlidevServer(
    slidesPath: string,
    host: string,
    port: number,
  ): Promise<ManagedSlidevServer['server']> {
    const { createServer, resolveOptions } = await import('@slidev/cli');
    const options = await resolveOptions({
      entry: slidesPath,
    }, 'dev');
    const server = await createServer(options, {
      server: {
        host,
        port,
        strictPort: true,
        open: false,
      },
      optimizeDeps: { force: true },
      clearScreen: false,
      logLevel: 'warn',
    });
    await server.listen(port);
    return server;
  }

  getById(id: string): SlidevServerHandle | undefined {
    const existing = this.resolved.get(id);
    if (!existing) return undefined;
    existing.lastAccessAt = Date.now();
    return this.publicHandle(existing);
  }

  getByProjectDir(projectDir: string): SlidevServerHandle | undefined {
    return this.getById(idFromProjectDir(projectDir));
  }

  async stopById(id: string): Promise<boolean> {
    const pending = this.servers.get(id);
    this.servers.delete(id);
    const existing = this.resolved.get(id);
    this.resolved.delete(id);
    if (existing) {
      await this.closeServer(existing);
      return true;
    }
    if (pending) {
      // 还在创建中：等它就绪后再关，避免泄漏刚起来的 server
      try {
        const server = await pending;
        await this.closeServer(server);
      } catch {
        // 创建本就失败，无需关闭
      }
      return true;
    }
    return false;
  }

  async destroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // servers 覆盖 in-flight + 已就绪的全部 Promise，先结算再统一关闭，避免漏关刚起来的 server
    const pending = Array.from(this.servers.values());
    this.servers.clear();
    this.resolved.clear();
    const settled = await Promise.allSettled(pending);
    const servers = settled
      .filter((r): r is PromiseFulfilledResult<ManagedSlidevServer> => r.status === 'fulfilled')
      .map(r => r.value);
    await Promise.allSettled(servers.map(server => this.closeServer(server)));
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, 5 * 60_000);
    this.cleanupTimer.unref();
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, server] of this.resolved) {
      if (now - server.lastAccessAt > this.ttlMs) {
        this.resolved.delete(id);
        this.servers.delete(id);
        await this.closeServer(server);
      }
    }
    if (this.resolved.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async closeServer(server: ManagedSlidevServer): Promise<void> {
    try {
      await server.server.close?.();
    } catch (err) {
      coreLogger.warn('Slidev server 关闭失败', { err: err instanceof Error ? err.message : String(err), projectDir: server.projectDir });
    }
  }

  private publicHandle(server: ManagedSlidevServer): SlidevServerHandle {
    const { id, projectDir, slidesPath, host, port, url, createdAt, lastAccessAt } = server;
    return { id, projectDir, slidesPath, host, port, url, createdAt, lastAccessAt };
  }
}

export const slidevServerManager = new SlidevServerManager();
