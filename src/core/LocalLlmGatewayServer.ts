/**
 * LocalLlmGatewayServer —— 本地 LLM 网关的专用固定端口监听器。
 *
 * 设计目标（见重构计划）：
 * - 网关不再挂在 Web 服务器的 Fastify 上（那样端口 = Web 端口，会随 EADDRINUSE 随机回退漂移）。
 *   这里给它一个**独立的固定大端口**监听器（同一进程内），地址确定性、重启不变。
 * - 多个 Lingxiao 实例共享同一个网关：首个进程绑定，其余经 `~/.lingxiao/gateway.json`
 *   归属文件 + PID/startMs 存活性判定**复用**已存在的监听，不重复 bind（单一共享实例）。
 * - 端口被占用且无活跃 owner → **fail-loud**，绝不随机回退端口（随机回退正是漂移 bug 根因）。
 *
 * 路由处理器（callLocalGateway）用网关配置模型、不绑定会话，故复用 deps 即可，无需 IPC。
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Fastify from 'fastify';
import { getConfigValue } from '../config.js';
import { registerCleanup } from './CleanupRegistry.js';
import { processExists, readProcessStartMs } from '../utils/platform.js';
import { registerLocalLlmGatewayRoutes, type GatewayDeps } from '../web-server/LocalLlmGatewayRoutes.js';
import { normalizeHost, readPositiveInt } from './LocalLlmGateway.js';

const DEFAULT_GATEWAY_FILE = join(homedir(), '.lingxiao', 'gateway.json');
/** 测试可覆盖的归属文件路径；生产路径恒为 ~/.lingxiao/gateway.json。 */
let gatewayFileOverride: string | null = null;
function gatewayFile(): string {
  return gatewayFileOverride ?? DEFAULT_GATEWAY_FILE;
}
/** 仅供测试：重定向归属文件到临时路径（传入 null 还原）。 */
export function _setGatewayFileForTest(path: string | null): void {
  gatewayFileOverride = path;
}

/** startMs 比较容忍度（毫秒）—— 吸收 /proc 时钟抖动、采样粒度差及 WSL2 btime 漂移。 */
const START_MS_TOLERANCE_MS = 30000;
/** EADDRINUSE 后探测 live owner 的重试间隔（给兄弟进程写归属文件的时间）。 */
const COLLISION_PROBE_INTERVAL_MS = 150;
/** EADDRINUSE 后探测次数。 */
const COLLISION_PROBE_ATTEMPTS = 3;

export interface LocalLlmGatewayEndpoint {
  host: string;
  port: number;
  origin: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  /** true = 已有活跃实例持有该端口，本进程复用而未绑定。 */
  reused: boolean;
}

export interface LocalLlmGatewayHandle extends LocalLlmGatewayEndpoint {
  /**
   * 关闭本进程绑定的监听器并清理归属文件（幂等）。
   * 复用路径为 no-op（不动他人的监听/文件）。生产退出由 cleanup 自动调用；测试可显式调用释放端口。
   */
  close(): Promise<void>;
}

interface GatewayFileInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
  startMs?: number | null;
}

function readGatewayFile(): GatewayFileInfo | null {
  const file = gatewayFile();
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as Partial<GatewayFileInfo>;
    if (typeof data.pid !== 'number' || typeof data.port !== 'number') return null;
    return {
      pid: data.pid,
      port: data.port,
      host: typeof data.host === 'string' ? data.host : '127.0.0.1',
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : 0,
      startMs: typeof data.startMs === 'number' ? data.startMs : null,
    };
  } catch (err) {
    // 归属文件损坏不能静默：否则会误判无 owner 而盲目重绑导致 EADDRINUSE。
    console.warn(
      `[LocalLlmGateway] 读取网关归属文件失败，按无 owner 处理 (${file}):`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function writeGatewayFile(info: GatewayFileInfo): void {
  const file = gatewayFile();
  try {
    writeFileSync(file, JSON.stringify(info), 'utf-8');
  } catch (err) {
    console.error(
      `[LocalLlmGateway] 写入网关归属文件失败 (${file}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 仅当归属文件仍记录本 pid 时删除——防误删兄弟进程的文件（复用竞态）。 */
function removeGatewayFileIfOwner(myPid: number): void {
  const info = readGatewayFile();
  if (info && info.pid === myPid) {
    try {
      unlinkSync(gatewayFile());
    } catch {
      /* 文件不存在时忽略 */
    }
  }
}

/**
 * 归属文件中的进程是否仍是该 host:port 的活跃 owner。
 * - 地址不匹配 → 否（配置改了端口/主机，旧归属失效）。
 * - pid 不存活 → 否。
 * - startMs 不匹配（PID 被回收、同 pid 指向新进程）→ 否。
 */
function isLiveOwner(info: GatewayFileInfo, host: string, port: number): boolean {
  if (info.port !== port || normalizeHost(info.host) !== normalizeHost(host)) return false;
  if (!processExists(info.pid)) return false;
  if (typeof info.startMs === 'number' && info.startMs > 0) {
    const current = readProcessStartMs(info.pid);
    if (current === null) return false; // 无法确认视为非 owner，保守重绑
    if (Math.abs(current - info.startMs) > START_MS_TOLERANCE_MS) return false;
  }
  return true;
}

function endpointOf(host: string, port: number, reused: boolean): LocalLlmGatewayEndpoint {
  const origin = `http://${host}:${port}`;
  return {
    host,
    port,
    origin,
    openaiBaseUrl: `${origin}/llm/openai/v1`,
    anthropicBaseUrl: `${origin}/llm/anthropic`,
    reused,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 启动本地 LLM 网关的专用固定端口监听器。
 *
 * @returns 监听句柄（含 close()）；网关未启用时返回 null（无监听/路由/文件）。
 * @throws 端口被非 owner 进程占用且重试后仍无活跃 owner 时 fail-loud。
 */
export async function startLocalLlmGatewayServer(deps: GatewayDeps): Promise<LocalLlmGatewayHandle | null> {
  if (getConfigValue('llm_gateway.enabled') !== true) return null;

  const host = normalizeHost(String(getConfigValue('llm_gateway.host') || '127.0.0.1'));
  const port = readPositiveInt('llm_gateway.port', 62000);
  const myPid = process.pid;
  const noopClose = async (): Promise<void> => { /* 复用路径：未绑定，无需关闭 */ };

  // 1) 复用检测：已有 live owner 持有同地址 → 直接复用，不绑定（单一共享实例）。
  const existing = readGatewayFile();
  if (existing && isLiveOwner(existing, host, port)) {
    console.log(`[LocalLlmGateway] 复用已存在的网关监听 ${host}:${port} (pid ${existing.pid})`);
    return { ...endpointOf(host, port, true), close: noopClose };
  }

  // 2) 绑定专用监听器。
  const gateway = Fastify({ logger: false });
  registerLocalLlmGatewayRoutes(gateway, deps);

  try {
    await gateway.listen({ host, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EADDRINUSE') throw err;
    // EADDRINUSE：(a) 兄弟实例刚 bind 还没写归属文件，或 (b) 非 Lingxiao 进程占用。
    // 短重试探测是否有 live owner 出现；仍无 → fail-loud（绝不随机回退端口）。
    for (let attempt = 0; attempt < COLLISION_PROBE_ATTEMPTS; attempt++) {
      await sleep(COLLISION_PROBE_INTERVAL_MS);
      const probe = readGatewayFile();
      if (probe && isLiveOwner(probe, host, port)) {
        console.log(`[LocalLlmGateway] 复用已存在的网关监听 ${host}:${port} (pid ${probe.pid})`);
        return { ...endpointOf(host, port, true), close: noopClose };
      }
    }
    throw new Error(
      `本地 LLM 网关端口 ${port} (llm_gateway.port) 被占用，且无活跃 Lingxiao 网关归属。` +
      `请释放该端口，或在配置中修改 llm_gateway.port 后重启（不随机回退端口，以避免地址漂移）。`,
    );
  }

  // 3) 绑定成功：写归属文件 + 注册清理（仅绑定方注册；复用方不动他人的监听/文件）。
  const startMs = readProcessStartMs(myPid);
  writeGatewayFile({ pid: myPid, port, host, startedAt: Date.now(), startMs });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await gateway.close();
    } catch {
      /* 关闭中，忽略 */
    }
    removeGatewayFileIfOwner(myPid);
  };
  registerCleanup(close, 3.5);

  const model = String(getConfigValue('llm_gateway.model') || '').trim();
  console.log(`[LocalLlmGateway] 网关监听已启动: ${host}:${port} (model: ${model || '<未配置>'})`);

  return { ...endpointOf(host, port, false), close };
}
