/**
 * AcpRoutes — ACP Protocol (connect/SSE/JSON-RPC/disconnect) 路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { ConnectionManager } from './ConnectionManager.js';
import type { AcpHandler } from './AcpHandler.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { AuthFn } from './types.js';

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function registerAcpRoutes(
  fastify: FastifyInstance,
  deps: {
    sessionManager: SessionManager;
    connectionManager: ConnectionManager;
    acpHandler: AcpHandler;
    requireServerToken: AuthFn;
  },
): void {
  const { sessionManager, connectionManager, acpHandler, requireServerToken } = deps;

  // POST /api/v1/acp/connect — 握手，返回 connectionId + sessionToken
  fastify.post('/api/v1/acp/connect', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const body = request.body as { sessionId?: unknown } | undefined;
    const sessionId = nonEmptyString(body?.sessionId);

    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }

    // Auto-resume session into memory so SSE events can be routed correctly
    if (!sessionManager.getSession(sessionId)) {
      await sessionManager.resumeSession(sessionId).catch(() => {});
    }

    const client = connectionManager.addClient(sessionId, reply);
    if (!client) {
      reply.status(429).send({ error: 'SSE connection limit reached' });
      return;
    }
    return {
      connectionId: client.connectionId,
      sessionToken: client.sessionToken,
    };
  });

  // GET /api/v1/acp — SSE stream
  // ACP session token is validated separately via acp-connection-id + acp-session-token headers.
  fastify.get('/api/v1/acp', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const connId = nonEmptyString(request.headers['acp-connection-id']);
    const sessionToken = nonEmptyString(request.headers['acp-session-token']);

    if (!connId || !sessionToken) {
      reply.status(401);
      return { error: 'Missing acp-connection-id or acp-session-token' };
    }

    const client = connectionManager.validateClient(connId, sessionToken);
    if (!client) {
      reply.status(401);
      return { error: 'Invalid connection credentials' };
    }

    // Upgrade to SSE. hijack() prevents Fastify from sending a second response
    // after we have already written headers to reply.raw.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 启用 TCP keepalive：半开连接（NAT 静默丢弃、移动网络切换）应用层无数据往返，
    // 仅靠写超时检测要等数小时；keepalive 让内核在 ~30s 内探测到死连接并触发 close/error，
    // 配合下方 removeClient 即时回收，防 24/7 daemon 僵尸连接堆积。
    reply.raw.socket?.setKeepAlive(true, 30_000);

    // Update client reply to the SSE connection
    client.reply = reply;
    client.lastActivity = Date.now();

    // Send initial connected event
    reply.raw.write(`data: ${JSON.stringify({ method: 'connected', params: { connectionId: connId } })}\n\n`);

    // 真实断连即移除：不再仅置 lastActivity=0 等 30s 心跳兜底——直接 removeClient，
    // 消除最长 30s 的幽灵投递窗口与连接预算（MAX_TOTAL_CONNECTIONS）被已断客户端假占用。
    // reconnect race 守卫保留：仅当此 reply 仍是该 client 的活跃流时才移除；若已有更新的
    // reconnect 把 client.reply 换成新流，旧流的 close 是 no-op（removeClient 幂等）。
    const cleanup = () => {
      if (client.reply === reply) {
        connectionManager.removeClient(connId);
      }
    };
    reply.raw.once('close', cleanup);
    reply.raw.once('error', cleanup);
  });

  // POST /api/v1/acp — JSON-RPC
  fastify.post('/api/v1/acp', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const rpcRequest = request.body as {
      jsonrpc: '2.0';
      id?: string | number | null;
      method: string;
      params?: Record<string, unknown>;
    };

    // Determine sessionId from connection headers or params
    const connId = request.headers['acp-connection-id'] as string;
    const client = connId ? connectionManager.getClient(connId) : undefined;
    const sessionId = client?.sessionId || nonEmptyString(rpcRequest.params?.sessionId);

    const response = await acpHandler.handle(rpcRequest, sessionId);
    return response;
  });

  // DELETE /api/v1/acp — 断开连接
  fastify.delete('/api/v1/acp', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const connId = request.headers['acp-connection-id'] as string;
    if (connId) {
      connectionManager.removeClient(connId);
    }
    return { success: true };
  });
}
