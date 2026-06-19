/**
 * DaemonRoutes — Daemon 管理路由 + QQ Bot 路由
 *
 * 核心规则：
 * - daemon 控制（start/stop/restart）只在主进程可用
 * - daemon 进程内禁止启动新 daemon（防嵌套）
 * - QQ Bot 配置读写：文件（跨进程共享）
 * - QQ Bot 启停：daemon 进程内直接操作，主进程代理到 daemon
 */

import type { FastifyInstance } from 'fastify';
import type { AuthFn } from './types.js';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { DatabaseManager } from '../core/Database.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import { getEventEmitter } from '../core/EventEmitter.js';
import { DaemonManager } from '../core/DaemonManager.js';
import { gracefulShutdown } from '../core/RuntimeGuards.js';
import { isDaemonActiveStatus } from '../core/StateSemantics.js';
import type { QQBotConfig, QQBotRuntimeStatus } from '../bot/types.js';

type JsonRecord = Record<string, unknown>;
type ProxyMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface DaemonStartPayload {
  port: number;
  host: string;
}

interface DaemonRestartPayload {
  port?: number;
  host?: string;
}

interface DaemonSupervisorStartPayload extends DaemonStartPayload {
  maxRestarts?: number;
}

interface SwitchSessionPayload {
  session_id: string;
}

interface DaemonQQBotInstance {
  start(): Promise<void>;
  stop(): void;
  getStatus(): QQBotRuntimeStatus;
  switchSession?(sessionId: string): void;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeBody(body: unknown): JsonRecord {
  if (isRecord(body)) return body;
  return {};
}

function stringField(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanField(body: JsonRecord, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayField(body: JsonRecord, key: string): string[] | undefined {
  const value = body[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : undefined;
}

function getDaemonStartPayload(body: unknown): DaemonStartPayload {
  const record = safeBody(body);
  return {
    port: numberField(record, 'port') ?? 8080,
    host: stringField(record, 'host') ?? '127.0.0.1',
  };
}

function getDaemonRestartPayload(body: unknown): DaemonRestartPayload {
  const record = safeBody(body);
  return {
    port: numberField(record, 'port'),
    host: stringField(record, 'host'),
  };
}

function getDaemonSupervisorStartPayload(body: unknown): DaemonSupervisorStartPayload {
  const record = safeBody(body);
  return {
    ...getDaemonStartPayload(record),
    maxRestarts: numberField(record, 'maxRestarts'),
  };
}

function getQQBotConfigPatch(body: unknown): Partial<QQBotConfig> {
  const record = safeBody(body);
  const patch: Partial<QQBotConfig> = {};
  const enabled = booleanField(record, 'enabled');
  const appId = stringField(record, 'appId');
  const secret = stringField(record, 'secret');
  const sandbox = booleanField(record, 'sandbox');
  const allowedGuilds = stringArrayField(record, 'allowedGuilds');
  const allowedUsers = stringArrayField(record, 'allowedUsers');
  const allowAnyone = booleanField(record, 'allowAnyone');

  if (enabled !== undefined) patch.enabled = enabled;
  if (appId !== undefined) patch.appId = appId;
  if (secret !== undefined) patch.secret = secret;
  if (sandbox !== undefined) patch.sandbox = sandbox;
  if (allowedGuilds !== undefined) patch.allowedGuilds = allowedGuilds;
  if (allowedUsers !== undefined) patch.allowedUsers = allowedUsers;
  if (allowAnyone !== undefined) patch.allowAnyone = allowAnyone;

  return patch;
}

function getSwitchSessionPayload(body: unknown): SwitchSessionPayload | null {
  const sessionId = stringField(safeBody(body), 'session_id');
  return sessionId ? { session_id: sessionId } : null;
}

function messageFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

async function readJsonResponse(resp: Response): Promise<unknown> {
  return await resp.json();
}

async function readJsonResponseOrNull(resp: Response): Promise<unknown> {
  try {
    return await readJsonResponse(resp);
  } catch {
    return null;
  }
}

function proxyErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  return fallback;
}

/** 全局 QQ Bot 实例引用（daemon 进程内唯一） */
let qqBotInstance: DaemonQQBotInstance | null = null;

/** daemon 守护会话 ID（由 initQQBotInDaemon 设置） */
let daemonSessionId: string | null = null;

/** 当前进程是否为 daemon 进程 */
let isDaemonProcess = false;

/**
 * 向 daemon 进程发送 HTTP 请求
 */
async function proxyToDaemon(path: string, method: ProxyMethod, body?: unknown): Promise<unknown> {
  const status = DaemonManager.getStatus();
  if (!isDaemonActiveStatus(status.status) || !status.url) {
    throw new Error('Daemon is not running');
  }
  const url = `${status.url}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (status.token) headers['x-lingxiao-token'] = status.token;
  const resp = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await readJsonResponseOrNull(resp);
    throw new Error(proxyErrorMessage(errBody, resp.statusText || `Daemon returned ${resp.status}`));
  }
  return readJsonResponse(resp);
}

export function registerDaemonRoutes(
  fastify: FastifyInstance,
  deps: {
    requireServerToken: AuthFn;
    repos?: DatabaseRepositoryAdapter;
    sessionManager?: SessionManager;
    emitter?: EventEmitter;
    serverToken?: string;
    isDaemon?: boolean;
  },
): void {
  const { requireServerToken, repos, sessionManager } = deps;
  const routeEmitter = deps.emitter ?? getEventEmitter();
  if (deps.isDaemon) isDaemonProcess = true;

  // ═══ Daemon 控制（仅主进程可用）═══

  fastify.get('/api/v1/daemon/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    // daemon 进程内：直接返回 running（自己就是 daemon）
    if (isDaemonProcess) {
      const info = DaemonManager.getStatus();
      return { data: { ...info, status: 'running' } };
    }
    return { data: DaemonManager.getStatus() };
  });

  fastify.post('/api/v1/daemon/start', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    // daemon 进程内禁止启动新 daemon
    if (isDaemonProcess) {
      reply.status(400);
      return { error: 'Cannot start daemon from within daemon process' };
    }
    const payload = getDaemonStartPayload(request.body);
    try {
      const status = await DaemonManager.startDaemon(payload.port, payload.host);
      return { data: status };
    } catch (err) {
      reply.status(500);
      return { error: messageFromUnknown(err, 'Daemon operation failed') };
    }
  });

  fastify.post('/api/v1/daemon/stop', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (isDaemonProcess) {
      // daemon 进程自杀 — 先清理 QQBot
      if (qqBotInstance) {
        qqBotInstance.stop();
        qqBotInstance = null;
      }
      try {
        const { setQQBotConfig } = await import('../bot/QQBotConfig.js');
        setQQBotConfig({ enabled: false });
      } catch {/* expected: best-effort cleanup */}
      void gracefulShutdown(0); // 先 runAllCleanups(收割 worker / 关 db / removePortFile)再退,#7
      return { success: true };
    }
    const result = await DaemonManager.stopDaemon();
    if (!result.success) {
      reply.status(500);
      return { error: result.error };
    }
    return { success: true };
  });

  fastify.post('/api/v1/daemon/restart', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (isDaemonProcess) {
      reply.status(400);
      return { error: 'Cannot restart daemon from within daemon process' };
    }
    const payload = getDaemonRestartPayload(request.body);
    try {
      const status = await DaemonManager.restartDaemon(payload.port, payload.host);
      return { data: status };
    } catch (err) {
      reply.status(500);
      return { error: messageFromUnknown(err, 'Daemon operation failed') };
    }
  });

  fastify.post('/api/v1/daemon/start-with-supervisor', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (isDaemonProcess) {
      reply.status(400);
      return { error: 'Cannot start supervisor from within daemon process' };
    }
    const payload = getDaemonSupervisorStartPayload(request.body);
    try {
      const status = await DaemonManager.startDaemonWithSupervisor(
        payload.port, payload.host, payload.maxRestarts ? { maxRestarts: payload.maxRestarts } : undefined,
      );
      return { data: status };
    } catch (err) {
      reply.status(500);
      return { error: messageFromUnknown(err, 'Daemon operation failed') };
    }
  });

  fastify.get('/api/v1/daemon/supervisor-status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return { data: DaemonManager.getSupervisorStatus() };
  });

  fastify.post('/api/v1/daemon/stop-supervisor', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    DaemonManager.stopSupervisor();
    return { success: true };
  });

  // ═══ QQ Bot 管理 ═══

  fastify.get('/api/v1/daemon/qqbot/config', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { getQQBotConfig } = await import('../bot/QQBotConfig.js');
    return { data: getQQBotConfig() };
  });

  fastify.put('/api/v1/daemon/qqbot/config', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { setQQBotConfig } = await import('../bot/QQBotConfig.js');
    const config = setQQBotConfig(getQQBotConfigPatch(request.body));
    return { data: config };
  });

  fastify.get('/api/v1/daemon/qqbot/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (qqBotInstance) {
      return { data: qqBotInstance.getStatus() };
    }
    // 主进程：尝试从 daemon 获取
    if (!isDaemonProcess) {
      try {
        return await proxyToDaemon('/api/v1/daemon/qqbot/status', 'GET');
      } catch (err) {
        // daemon 不可达 → 返回 disconnected 但声明 reason，供前端显示
        return { data: { status: 'disconnected', daemonUnreachable: true, reason: messageFromUnknown(err, 'daemon unreachable') } };
      }
    }
    return { data: { status: 'disconnected' } };
  });

  fastify.post('/api/v1/daemon/qqbot/start', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    // daemon 进程内：直接启动
    if (sessionManager && repos) {
      try {
        const { getQQBotConfig, isConfigValid, setQQBotConfig } = await import('../bot/QQBotConfig.js');
        const { QQBot } = await import('../bot/QQBot.js');
        const config = getQQBotConfig();
        if (!isConfigValid(config)) {
          reply.status(400);
          return { error: 'QQ Bot config is incomplete (appId and secret required)' };
        }
        if (qqBotInstance) {
          qqBotInstance.stop();
          qqBotInstance = null;
        }
        // 启动时标记 enabled=true
        setQQBotConfig({ enabled: true });
        // 如果没有守护会话（手动启动），创建一个
        if (!daemonSessionId) {
          daemonSessionId = await sessionManager.createSession('', process.cwd(), { idle: true });
        }
        qqBotInstance = new QQBot({ ...config, enabled: true }, sessionManager, repos.raw, routeEmitter, daemonSessionId);
        await qqBotInstance.start();
        return { data: qqBotInstance.getStatus() };
      } catch (err) {
        reply.status(500);
        return { error: messageFromUnknown(err, 'Failed to start QQ Bot') };
      }
    }
    // 主进程：代理到 daemon
    try {
      return await proxyToDaemon('/api/v1/daemon/qqbot/start', 'POST', {});
    } catch (err) {
      reply.status(500);
      return { error: messageFromUnknown(err, 'Failed to start QQ Bot (is daemon running?)') };
    }
  });

  fastify.post('/api/v1/daemon/qqbot/stop', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    if (qqBotInstance) {
      qqBotInstance.stop();
      qqBotInstance = null;
      // 停止时标记 enabled=false
      try {
        const { setQQBotConfig } = await import('../bot/QQBotConfig.js');
        setQQBotConfig({ enabled: false });
      } catch (err) {
        // 配置持久化失败不阻塞停止，但应透传到响应
        return { data: { status: 'disconnected' }, warning: `config persist failed: ${messageFromUnknown(err, String(err))}` };
      }
      return { data: { status: 'disconnected' } };
    }
    if (!isDaemonProcess) {
      try {
        return await proxyToDaemon('/api/v1/daemon/qqbot/stop', 'POST');
      } catch (err) {
        reply.status(502);
        return { error: messageFromUnknown(err, 'Failed to stop QQ Bot (daemon unreachable)') };
      }
    }
    return { data: { status: 'disconnected' } };
  });

  // ═══ Daemon 会话列表 ═══

  fastify.get('/api/v1/daemon/sessions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    // daemon 进程内：直接查自己的 db
    if (isDaemonProcess && repos) {
      const sessions = repos.sessions.list();
      return { data: sessions };
    }
    // 主进程：代理到 daemon
    try {
      return await proxyToDaemon('/api/v1/daemon/sessions', 'GET');
    } catch (err) {
      // daemon 不可达 → 返回 502，不再返回假空数组
      reply.status(502);
      return { error: messageFromUnknown(err, 'daemon unreachable'), data: [] };
    }
  });

  // ═══ 切换活跃会话 ═══

  fastify.post('/api/v1/daemon/switch-session', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const payload = getSwitchSessionPayload(request.body);
    if (!payload) {
      reply.code(400);
      return { error: 'session_id is required' };
    }

    if (isDaemonProcess) {
      switchDaemonSession(payload.session_id);
      return { data: { session_id: payload.session_id } };
    }

    // 主进程：代理到 daemon
    try {
      return await proxyToDaemon('/api/v1/daemon/switch-session', 'POST', payload);
    } catch (err) {
      reply.code(500);
      return { error: messageFromUnknown(err, 'daemon unreachable') };
    }
  });
}

/**
 * 切换 daemon 的活跃会话（内部调用）
 */
function switchDaemonSession(newSessionId: string): void {
  daemonSessionId = newSessionId;
  if (qqBotInstance?.switchSession) {
    qqBotInstance.switchSession(newSessionId);
  }
}

/**
 * 在 daemon 进程中初始化 QQ Bot（由 cli.ts daemon-mode 调用）
 */
export async function initQQBotInDaemon(
  db: DatabaseManager,
  sessionManager: SessionManager,
  sessionId: string,
  emitter: EventEmitter = getEventEmitter(),
): Promise<void> {
  isDaemonProcess = true;
  daemonSessionId = sessionId;

  // 监听新会话创建事件 — 自动切换 QQ Bot 到新会话
  emitter.subscribe('session:created', (data: { sessionId: string }) => {
    if (data.sessionId !== daemonSessionId) {
      switchDaemonSession(data.sessionId);
    }
  });

  try {
    const { getQQBotConfig, isConfigValid } = await import('../bot/QQBotConfig.js');
    const config = getQQBotConfig();
    if (!config.enabled || !isConfigValid(config)) {
      return;
    }
    const { QQBot } = await import('../bot/QQBot.js');
    qqBotInstance = new QQBot(config, sessionManager, db, emitter, sessionId);
    await qqBotInstance.start();
  } catch (err) {
    // QQBot 构造/启动失败（配置错、网络、websocket）必须在此记录 ——
    // 不能依赖 QQBot 内部 logger：构造抛出时它可能尚未接线，错误将彻底无声。
    console.warn(`[DaemonRoutes] QQBot 启动失败 (session=${sessionId}):`, err instanceof Error ? err.message : String(err));
  }
}
