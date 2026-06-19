import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseClient {
  connectionId: string;
  sessionToken: string;
  sessionId: string;
  reply: FastifyReply;
  connectedAt: number;
  lastActivity: number;  // 最后活动时间，用于检测过期连接
}

/** 批量写入缓冲区：按 session 聚合 SSE 事件，定时 flush 以减少 raw.write 系统调用 */
interface BatchBuffer {
  events: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

const BATCH_FLUSH_MS = 25; // 25ms 微批窗口 — 平衡延迟与吞吐

/** 最大 SSE 连接数 */
const MAX_TOTAL_CONNECTIONS = 100;
/** 单 session 最大连接数 */
const MAX_CONNECTIONS_PER_SESSION = 10;
/** 单客户端 SSE 写缓冲上限（字节）。超过即判定为慢/半开连接（客户端不再 ACK 读端），
 *  主动移除，防止缓冲无界增长拖垮 24/7 daemon（半开连接 write 不抛错但堆积在内核/socket 缓冲）。
 *  远大于 Node 默认 highWaterMark(16KB)，给正常网络抖动留足余量。 */
const MAX_SSE_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * 管理每个 session 的 SSE 连接池
 */
export class ConnectionManager {
  private clients = new Map<string, Set<SseClient>>();
  private connections = new Map<string, SseClient>(); // connectionId → client
  private batchBuffers = new Map<string, BatchBuffer>();

  /**
   * 添加 SSE 客户端。达到上限时返回 null。
   */
  addClient(sessionId: string, reply: FastifyReply): SseClient | null {
    // 全局连接数上限
    if (this.connections.size >= MAX_TOTAL_CONNECTIONS) {
      return null;
    }
    // 单 session 连接数上限
    const sessionClients = this.clients.get(sessionId);
    if (sessionClients && sessionClients.size >= MAX_CONNECTIONS_PER_SESSION) {
      return null;
    }

    const connectionId = randomUUID();
    const sessionToken = randomUUID();

    const client: SseClient = {
      connectionId,
      sessionToken,
      sessionId,
      reply,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };

    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId)!.add(client);
    this.connections.set(connectionId, client);

    return client;
  }

  /**
   * 移除 SSE 客户端
   */
  removeClient(connectionId: string) {
    const client = this.connections.get(connectionId);
    if (!client) return;

    this.connections.delete(connectionId);
    const sessionClients = this.clients.get(client.sessionId);
    if (sessionClients) {
      sessionClients.delete(client);
      if (sessionClients.size === 0) {
        this.clients.delete(client.sessionId);
      }
    }
    this.flushBatch(client.sessionId);
  }

  /**
   * 获取指定 session 的所有客户端
   */
  getClients(sessionId: string): SseClient[] {
    return Array.from(this.clients.get(sessionId) ?? []);
  }

  /**
   * 获取客户端信息
   */
  getClient(connectionId: string): SseClient | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * 验证连接 token
   */
  validateClient(connectionId: string, sessionToken: string): SseClient | undefined {
    const client = this.connections.get(connectionId);
    if (client && client.sessionToken === sessionToken) {
      return client;
    }
    return undefined;
  }

  /**
   * 向指定 session 的所有客户端广播 SSE 事件（微批缓冲，减少系统调用）
   */
  broadcastToSession(sessionId: string, event: Record<string, unknown>) {
    const data = JSON.stringify(event);
    const sseLine = `data: ${data}\n\n`;

    let batch = this.batchBuffers.get(sessionId);
    if (!batch) {
      batch = { events: [], timer: null };
      this.batchBuffers.set(sessionId, batch);
    }
    batch.events.push(sseLine);

    // 已有定时器则等待；否则启动 25ms 微批定时器
    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        this.flushBatch(sessionId);
      }, BATCH_FLUSH_MS);
    }
  }

  /**
   * 立即广播（绕过批处理，用于延迟敏感的关键事件）
   */
  broadcastToSessionImmediate(sessionId: string, event: Record<string, unknown>) {
    const clients = this.getClients(sessionId);
    if (clients.length === 0) return;
    const data = JSON.stringify(event);
    const sseLine = `data: ${data}\n\n`;

    for (const client of clients) {
      this.writeToClient(client, sseLine);
    }
  }

  /**
   * 心跳 ping 写入。复用 writeToClient 的背压/死流判定，保证心跳路径与广播路径一致：
   * 半开/黑盒客户端的 ping 会堆积进缓冲、writableLength 超限即被移除。
   * 返回 false 表示该客户端已被移除（调用方可据此跳过后续处理）。
   */
  pingClient(client: SseClient): boolean {
    if (!this.connections.has(client.connectionId)) return false;
    this.writeToClient(client, ':ping\n\n');
    return this.connections.has(client.connectionId);
  }

  /**
   * 向单个客户端写 SSE 负载。统一处理背压与死流：
   *  - 已 destroyed/writableEnded 的流直接移除（不写）。
   *  - 写抛错（socket 已断）→ 移除。
   *  - 写后 writableLength 超上限（半开/黑盒客户端不再 ACK）→ 移除，防缓冲无界增长 OOM。
   *  - 正常写入：bump lastActivity（TCP 栈接受写 = 连接在 TCP 层存活）。
   */
  private writeToClient(client: SseClient, payload: string): void {
    try {
      const raw = client.reply.raw;
      if (raw.destroyed || raw.writableEnded) {
        this.removeClient(client.connectionId);
        return;
      }
      raw.write(payload);
      client.lastActivity = Date.now();
      if (raw.writableLength > MAX_SSE_BUFFERED_BYTES) {
        this.removeClient(client.connectionId);
      }
    } catch {/* 写失败 = 连接已断 */
      this.removeClient(client.connectionId);
    }
  }

  /**
   * 刷新指定 session 的批量缓冲区
   */
  private flushBatch(sessionId: string) {
    const batch = this.batchBuffers.get(sessionId);
    if (!batch) return;

    // 先清除 timer，再删除 batch，避免在 flush 期间有新的 broadcastToSession 误判
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    this.batchBuffers.delete(sessionId);

    if (batch.events.length === 0) return;

    const clients = this.getClients(sessionId);
    if (clients.length === 0) return;

    // 将所有缓冲的 SSE 事件拼接成单次 write，大幅减少系统调用
    const payload = batch.events.join('');
    for (const client of clients) {
      this.writeToClient(client, payload);
    }
  }

  /**
   * 获取连接统计
   */
  getStats() {
    return {
      totalConnections: this.connections.size,
      sessions: this.clients.size,
      perSession: Array.from(this.clients.entries()).map(([sid, clients]) => ({
        sessionId: sid,
        clientCount: clients.size,
      })),
    };
  }

  /**
   * 清理所有资源（用于优雅关闭）
   */
  destroy() {
    // 关闭前先同步 flush，避免 25ms 微批窗口里的终态/错误尾包在优雅关闭时丢失。
    for (const sessionId of Array.from(this.batchBuffers.keys())) {
      this.flushBatch(sessionId);
    }

    // 关闭所有 SSE 连接
    for (const client of this.connections.values()) {
      try {
        client.reply.raw.end();
      } catch {
        // 忽略已关闭的连接
      }
    }
    this.connections.clear();
    this.clients.clear();
  }
}
