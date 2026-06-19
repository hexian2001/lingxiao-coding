/**
 * QQBot — QQ 官方机器人客户端
 *
 * 基于 QQ 开放平台 v2 API (bot.q.qq.com)
 * - WebSocket 长连接接收消息事件
 * - HTTP API 发送消息回复
 * - 绑定到 daemon 的 SessionManager
 *
 * 支持的消息场景：
 * - 群聊 @机器人 (GROUP_AT_MESSAGE_CREATE)
 * - 群聊普通消息 (GROUP_MESSAGE_CREATE, 需要开启"群消息"intent)
 * - C2C 单聊 (C2C_MESSAGE_CREATE)
 * - 频道 @机器人 (AT_MESSAGE_CREATE)
 * - 频道私信 (DIRECT_MESSAGE_CREATE)
 */

import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { QQBotConfig, QQBotStatus, QQBotRuntimeStatus, QQBotIncomingMessage } from './types.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { DatabaseManager } from '../core/Database.js';
import type { EventEmitter as LingxiaoEventEmitter, EventMap, EventName } from '../core/EventEmitter.js';
import { isQQBotActiveStatus, normalizeAgentStatus, normalizeTaskStatus } from '../core/StateSemantics.js';
import { taskActionForEvent } from '../contracts/adapters/EventAdapter.js';
import type { EventType } from '../contracts/types/Event.js';
import { contentToPlainText } from '../llm/types.js';
import { CONFIG_DIR } from '../config.js';

const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

const LOG_DIR = join(CONFIG_DIR, 'daemon');
const LOG_FILE = join(LOG_DIR, 'qqbot.log');

function log(level: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, msg + '\n');
  } catch {/* expected: best-effort cleanup */}
  if (level === 'ERROR') console.error(`[QQBot] ${args.join(' ')}`);
}

const botLogger = {
  info: (...args: unknown[]) => log('INFO', ...args),
  warn: (...args: unknown[]) => log('WARN', ...args),
  error: (...args: unknown[]) => log('ERROR', ...args),
};

// ─── QQ Bot WebSocket 协议常量 ───

/** Intents 位掩码 */
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,  // 频道消息
  DIRECT_MESSAGE: 1 << 12,         // 频道私信
  GROUP_AND_C2C: 1 << 25,          // 群聊 + C2C 单聊
} as const;

/** 完整 intents 掩码 */
const FULL_INTENTS =
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C;

/** Gateway opcodes */
const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 事件类型 */
const GatewayEvent = {
  READY: 'READY',
  C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
  AT_MESSAGE_CREATE: 'AT_MESSAGE_CREATE',
  DIRECT_MESSAGE_CREATE: 'DIRECT_MESSAGE_CREATE',
  GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
  GROUP_MESSAGE_CREATE: 'GROUP_MESSAGE_CREATE',
} as const;

interface QQWsPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface QQGatewayHelloPayload {
  heartbeat_interval?: number;
}

interface QQMessageAuthorPayload {
  id?: string;
  user_openid?: string;
  member_openid?: string;
  username?: string;
}

interface QQMessagePayloadBase {
  id?: string;
  author?: QQMessageAuthorPayload;
  content?: string;
}

interface QQGroupMessagePayload extends QQMessagePayloadBase {
  group_openid?: string;
}

type QQC2CMessagePayload = QQMessagePayloadBase;

interface QQGuildMessagePayload extends QQMessagePayloadBase {
  guild_id?: string;
  channel_id?: string;
}

interface QQDirectMessagePayload extends QQMessagePayloadBase {
  guild_id?: string;
}

/** 消息来源类型 */
type MessageSource = 'group' | 'c2c' | 'guild' | 'dm';
type TaskStatusEvent =
  | 'task:created'
  | 'task:updated'
  | 'task:deleted'
  | 'task:assigned'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled';
type CanonicalTaskStatusEvent = Exclude<TaskStatusEvent, 'task:deleted'> & EventType;
type AgentStatusEvent =
  | 'agent:spawned'
  | 'agent:started'
  | 'agent:status'
  | 'agent:progress'
  | 'agent:completed'
  | 'agent:failed'
  | 'agent:terminated'
  | 'agent:heartbeat'
  | 'agent:interactive_state'
  | 'agent:crashed';
type ToolStatusEvent =
  | 'leader:tool_call'
  | 'leader:tool_progress'
  | 'leader:tool_result'
  | 'agent:tool_call'
  | 'agent:tool_progress'
  | 'agent:tool_result';
const TOOL_STATUS_ACTION_LABEL: Record<ToolStatusEvent, string> = {
  'leader:tool_call': '开始',
  'leader:tool_progress': '进度',
  'leader:tool_result': '完成',
  'agent:tool_call': '开始',
  'agent:tool_progress': '进度',
  'agent:tool_result': '完成',
};
type TaskStatusPayload = EventMap[TaskStatusEvent];
type AgentStatusPayload = EventMap[AgentStatusEvent];
type ToolStatusPayload = EventMap[ToolStatusEvent];
type WorkNoteStatusPayload = EventMap['work_note:written'];
type TeamMessageStatusPayload = EventMap['team:message_sent'];

export class QQBot extends EventEmitter {
  private config: QQBotConfig;
  private sessionManager: SessionManager;
  private db: DatabaseManager;
  private emitter: LingxiaoEventEmitter;
  private daemonSessionId: string; // 绑定到 daemon 守护会话
  private ws: WebSocket | null = null;
  private status: QQBotStatus = 'disconnected';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private messageCount: number = 0;
  private lastMessageAt: number = 0;
  private connectedAt: number = 0;
  private replyWatchers: Map<string, { collected: string; timer: ReturnType<typeof setTimeout> | null }> = new Map();
  private eventUnsubscribes: (() => void)[] = [];
  private disposed: boolean = false;
  private reconnectCount: number = 0;
  private static MAX_RECONNECT = 3;
  /** 已处理过的 incoming message id (LRU 防重放/重复推送) */
  private processedMsgIds: Set<string> = new Set();
  private static MAX_PROCESSED_IDS = 1024;
  /** msg_seq 自增计数器，按 "source:target" 分组
   *  QQ 开放平台要求同一 msg_id 的多段回复 msg_seq 递增且唯一 */
  private msgSeqCounters: Map<string, number> = new Map();
  /** 单条 QQ 消息的最大字符数（留出少量 buffer，官方硬限 ~1000） */
  private static MAX_REPLY_CHARS = 800;
  /** 最近一个可回复的 QQ 目标；daemon 后台事件没有 original msg 时用它主动推送状态 */
  private lastReplyTarget: QQBotIncomingMessage | null = null;
  /** daemon 状态聚合队列，避免 task/agent/tool 高频事件刷屏 */
  private daemonStatusBuffer: Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> | null }> = new Map();
  private static STATUS_FLUSH_MS = 1200;

  constructor(config: QQBotConfig, sessionManager: SessionManager, db: DatabaseManager, emitter: LingxiaoEventEmitter, daemonSessionId: string) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
    this.db = db;
    this.emitter = emitter;
    this.daemonSessionId = daemonSessionId;
    this.setupEventListeners();
  }

  /** 获取运行时状态 */
  getStatus(): QQBotRuntimeStatus {
    return {
      status: this.status,
      appId: this.config.appId,
      connectedAt: this.connectedAt || undefined,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt || undefined,
    };
  }

  /** 获取当前绑定的会话 ID */
  getSessionId(): string {
    return this.daemonSessionId;
  }

  /**
   * 切换到新会话 — Web UI 创建新对话或用户切换对话时调用
   *
   * 把旧 session 的 reply watcher / pending message 一并迁移到新 session，
   * 避免在真实"QQ 消息处理中"切换会话导致这条消息没人发回复。
   */
  switchSession(newSessionId: string): void {
    const oldSessionId = this.daemonSessionId;
    if (oldSessionId === newSessionId) return;

    // 迁移 replyWatcher
    const oldWatcher = this.replyWatchers.get(oldSessionId);
    if (oldWatcher) {
      this.replyWatchers.delete(oldSessionId);
      // 不 reset collected / timer，直接挂到新 sessionId 上
      this.replyWatchers.set(newSessionId, oldWatcher);
    }
    // 迁移 pendingReply
    const oldPending = this.pendingReplies.get(oldSessionId);
    if (oldPending) {
      this.pendingReplies.delete(oldSessionId);
      this.pendingReplies.set(newSessionId, oldPending);
    }

    this.daemonSessionId = newSessionId;
    botLogger.info(`Session switched: ${oldSessionId} → ${newSessionId}${oldWatcher ? ' (watcher migrated)' : ''}`);
  }

  /** 启动 Bot */
  async start(): Promise<void> {
    if (isQQBotActiveStatus(this.status)) {
      botLogger.warn('Bot already running');
      return;
    }

    this.disposed = false;
    // reconnectCount 仅在显式 stop() → start() 手动循环时清零；此处不清零，
    // 保留 onclose 自动重连的累计次数，确保 MAX_RECONNECT 能生效。
    this.status = 'connecting';
    this.emit('status', this.status);

    // fail-open 安全告警：未配置 allowedUsers 白名单却开启 allowAnyone，
    // 等于把直达 daemon 会话的入口对全网任意 QQ 用户开放
    if (!this.config.allowedUsers?.length && this.config.allowAnyone === true) {
      botLogger.warn(
        '[SECURITY] allowAnyone=true 且未配置 allowedUsers 白名单：任意公网 QQ 用户均可与 Bot 交互并触达 daemon 会话工具权限，存在 prompt injection → RCE 风险，请尽快配置 allowedUsers。',
      );
    }

    try {
      botLogger.info('Authenticating...');
      await this.authenticate();
      botLogger.info('Authenticated, getting gateway...');

      const gatewayUrl = await this.getGateway();
      botLogger.info(`Gateway: ${gatewayUrl}`);

      await this.connectWs(gatewayUrl);

      botLogger.info(`QQ Bot started (appId: ${this.config.appId})`);
    } catch (err) {
      this.status = 'error';
      const errorMsg = err instanceof Error ? err.message : String(err);
      botLogger.error('Failed to start:', errorMsg);
      this.emit('status', this.status, errorMsg);
      throw err;
    }
  }

  /** 停止 Bot */
  stop(): void {
    this.disposed = true;
    this.status = 'disconnected';
    this.reconnectCount = 0;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {/* expected: already closed */}
      this.ws = null;
    }

    for (const unsub of this.eventUnsubscribes) {
      try { unsub(); } catch {/* expected: listener may already be removed */}
    }
    this.eventUnsubscribes = [];

    for (const [, watcher] of this.replyWatchers) {
      if (watcher.timer) clearTimeout(watcher.timer);
    }
    this.replyWatchers.clear();
    this.pendingReplies.clear();
    for (const [, bucket] of this.daemonStatusBuffer) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    this.daemonStatusBuffer.clear();
    this.lastReplyTarget = null;

    this.emit('status', this.status);
    botLogger.info('QQ Bot stopped');
  }

  /** 更新配置 */
  updateConfig(config: Partial<QQBotConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── 认证 ───

  private async authenticate(forceRefresh = false): Promise<void> {
    if (!forceRefresh && this.accessToken && Date.now() < this.tokenExpiresAt) return;

    // 失败时清空，避免 getApiHeaders() 用半坏的 token 继续发请求
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    const resp = await fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.config.appId,
        clientSecret: this.config.secret,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Authentication failed: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json() as { access_token: string; expires_in: string };
    this.accessToken = data.access_token;
    const expiresSec = parseInt(data.expires_in, 10) || 7200;
    this.tokenExpiresAt = Date.now() + (expiresSec - 60) * 1000;
    botLogger.info(`Authenticated successfully${forceRefresh ? ' (forced refresh)' : ''}`);
  }

  private async getApiHeaders(): Promise<Record<string, string>> {
    await this.authenticate();
    return {
      'Authorization': `QQBot ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── WebSocket ───

  private async getGateway(): Promise<string> {
    const baseUrl = this.config.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;
    const headers = await this.getApiHeaders();
    const resp = await fetch(`${baseUrl}/gateway/bot`, { headers });
    if (!resp.ok) throw new Error(`Gateway fetch failed: ${resp.status}`);
    const data = await resp.json() as { url: string };
    return data.url;
  }

  private async connectWs(gatewayUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let invalidSession = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const timeout = setTimeout(() => {
        settle(() => reject(new Error('WebSocket connect timeout (15s)')));
        try { this.ws?.close(); } catch {/* expected: already closed */}
      }, 15_000);

      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      ws.onopen = () => {
        botLogger.info('WebSocket connected, waiting for Hello...');
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as unknown;
          const payload = this.parseWsPayload(parsed);
          if (!payload) {
            botLogger.warn('WS message ignored: invalid payload shape');
            return;
          }
          botLogger.info('WS recv op=' + payload.op + ' t=' + (payload.t || '-') + ' s=' + (payload.s ?? '-'));
          this.handleWsMessage(payload,
            () => { clearTimeout(timeout); settle(resolve); },
            (err) => { clearTimeout(timeout); settle(() => reject(err)); },
            () => { invalidSession = true; },
          );
        } catch (err) {
          botLogger.error('WS message parse error:', err);
        }
      };

      ws.onclose = () => {
        botLogger.warn('WebSocket closed');
        this.ws = null;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        clearTimeout(timeout);
        if (invalidSession) {
          settle(() => reject(new Error('QQ Bot Invalid Session — 请在 QQ 开放平台检查：1) 机器人已注册 2) 已启用对应的 Intents')));
          this.status = 'error';
          this.emit('status', this.status, 'Invalid Session');
          return;
        }
        settle(() => reject(new Error('WebSocket closed before READY')));
        if (!this.disposed && this.reconnectCount < QQBot.MAX_RECONNECT) {
          this.reconnectCount++;
          this.status = 'disconnected';
          this.emit('status', this.status);
          this.reconnectTimer = setTimeout(() => {
            if (!this.disposed) {
              botLogger.info(`Attempting reconnect (${this.reconnectCount}/${QQBot.MAX_RECONNECT})...`);
              this.start().catch(err => botLogger.warn('Reconnect failed:', err instanceof Error ? err.message : String(err)));
            }
          }, 5000);
        } else if (!this.disposed) {
          this.status = 'error';
          this.emit('status', this.status, 'Max reconnect attempts reached');
        }
      };

      ws.onerror = (err) => {
        botLogger.error('WebSocket error:', err);
      };
    });
  }

  private handleWsMessage(
    payload: QQWsPayload,
    onReady: () => void,
    onError: (err: Error) => void,
    onInvalidSession?: () => void,
  ): void {
    switch (payload.op) {
      case GatewayOp.HELLO: {
        const heartbeatInterval = this.parseGatewayHello(payload.d).heartbeat_interval ?? 41250;
        this.startHeartbeat(heartbeatInterval);
        botLogger.info(`Hello received, heartbeat=${heartbeatInterval}ms, sending Identify...`);

        // v2 API intents
        // PUBLIC_GUILD_MESSAGES = 1<<30 (频道消息)
        // DIRECT_MESSAGE = 1<<12 (频道私信)
        // GROUP_AND_C2C = 1<<25 (群聊 + C2C 单聊)
        const identifyPayload = {
          op: GatewayOp.IDENTIFY,
          d: {
            token: `QQBot ${this.accessToken}`,
            intents: FULL_INTENTS,
            shard: [0, 1],
          },
        };
        botLogger.info(`Sending Identify, intents=${FULL_INTENTS} (0x${FULL_INTENTS.toString(16)}), token_prefix=QQBot ${this.accessToken?.slice(0, 8)}...`);
        this.wsSend(identifyPayload);
        break;
      }

      case GatewayOp.DISPATCH: {
        const eventType = payload.t;
        if (eventType === GatewayEvent.READY) {
          this.status = 'connected';
          this.connectedAt = Date.now();
          this.reconnectCount = 0;
          this.emit('status', this.status);
          botLogger.info('Bot READY');
          onReady();
        } else if (eventType === GatewayEvent.GROUP_AT_MESSAGE_CREATE || eventType === GatewayEvent.GROUP_MESSAGE_CREATE) {
          botLogger.info(`Received ${eventType} from group`);
          this.handleGroupMessage(payload.d, eventType);
        } else if (eventType === GatewayEvent.C2C_MESSAGE_CREATE) {
          botLogger.info('Received C2C_MESSAGE_CREATE');
          this.handleC2CMessage(payload.d);
        } else if (eventType === GatewayEvent.AT_MESSAGE_CREATE) {
          botLogger.info('Received AT_MESSAGE_CREATE (guild)');
          this.handleGuildMessage(payload.d);
        } else if (eventType === GatewayEvent.DIRECT_MESSAGE_CREATE) {
          botLogger.info('Received DIRECT_MESSAGE_CREATE');
          this.handleDirectMessage(payload.d);
        } else {
          botLogger.info(`Unhandled event type: ${eventType}`);
        }
        break;
      }

      case GatewayOp.HEARTBEAT_ACK:
        break;

      case GatewayOp.RECONNECT:
        botLogger.warn('Server requested reconnect');
        this.ws?.close();
        break;

      case GatewayOp.INVALID_SESSION: {
        const canResume = typeof payload.d === 'boolean' ? payload.d : false;
        botLogger.error(`Invalid session (canResume=${canResume}) — raw payload: ${JSON.stringify(payload)}`);
        botLogger.error('Check QQ Open Platform: 1) bot registered 2) intents enabled 3) correct appId/secret');
        onInvalidSession?.();
        this.ws?.close();
        break;
      }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.wsSend({ op: GatewayOp.HEARTBEAT, d: null });
    }, intervalMs);
  }

  private wsSend(data: QQWsPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private parseWsPayload(value: unknown): QQWsPayload | null {
    const payload = this.asRecord(value);
    if (!payload || typeof payload.op !== 'number') return null;
    return {
      op: payload.op,
      d: payload.d,
      s: typeof payload.s === 'number' ? payload.s : undefined,
      t: typeof payload.t === 'string' ? payload.t : undefined,
    };
  }

  private parseGatewayHello(value: unknown): QQGatewayHelloPayload {
    const payload = this.asRecord(value);
    const heartbeatInterval = payload?.heartbeat_interval;
    return {
      heartbeat_interval: typeof heartbeatInterval === 'number' && Number.isFinite(heartbeatInterval) && heartbeatInterval > 0
        ? heartbeatInterval
        : undefined,
    };
  }

  // ─── 消息处理 ───

  /**
   * 用户白名单校验（fail-closed）。
   *
   * 安全语义：
   * - 命中 allowedUsers 白名单 → 放行。
   * - 显式开启 allowAnyone:true → 放行（逃生开关，启动时已告警）。
   * - 其余情况（白名单为空且未开 allowAnyone）→ **拒绝**。
   *
   * 这条 fail-closed 规则统一适用于群聊 / 频道 / C2C 单聊 / 频道私信四条入口，
   * 因为它们最终都会把消息投喂给拥有完整工具权限的 daemon 守护会话。
   * authorId 为空（解析失败）一律拒绝。
   */
  private isUserAllowed(authorId: string): boolean {
    if (!authorId) return false;
    const allowed = this.config.allowedUsers;
    if (allowed?.length) return allowed.includes(authorId);
    // 白名单为空：仅在显式开启 allowAnyone 时放行，否则 fail-closed 拒绝
    return this.config.allowAnyone === true;
  }

  private parseQQMessageAuthor(value: unknown): QQMessageAuthorPayload | undefined {
    const author = this.asRecord(value);
    if (!author) return undefined;
    return {
      id: this.stringField(author, 'id'),
      user_openid: this.stringField(author, 'user_openid'),
      member_openid: this.stringField(author, 'member_openid'),
      username: this.stringField(author, 'username'),
    };
  }

  private parseQQMessageBase(value: unknown): QQMessagePayloadBase | undefined {
    const data = this.asRecord(value);
    if (!data) return undefined;
    return {
      id: this.stringField(data, 'id'),
      author: this.parseQQMessageAuthor(data.author),
      content: typeof data.content === 'string' ? data.content : undefined,
    };
  }

  private parseQQGroupMessage(value: unknown): QQGroupMessagePayload | undefined {
    const data = this.asRecord(value);
    const base = this.parseQQMessageBase(value);
    if (!data || !base) return undefined;
    return {
      ...base,
      group_openid: this.stringField(data, 'group_openid'),
    };
  }

  private parseQQC2CMessage(value: unknown): QQC2CMessagePayload | undefined {
    return this.parseQQMessageBase(value);
  }

  private parseQQGuildMessage(value: unknown): QQGuildMessagePayload | undefined {
    const data = this.asRecord(value);
    const base = this.parseQQMessageBase(value);
    if (!data || !base) return undefined;
    return {
      ...base,
      guild_id: this.stringField(data, 'guild_id'),
      channel_id: this.stringField(data, 'channel_id'),
    };
  }

  private parseQQDirectMessage(value: unknown): QQDirectMessagePayload | undefined {
    const data = this.asRecord(value);
    const base = this.parseQQMessageBase(value);
    if (!data || !base) return undefined;
    return {
      ...base,
      guild_id: this.stringField(data, 'guild_id'),
    };
  }

  /** 处理群聊消息 (GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE) */
  private handleGroupMessage(data: unknown, eventType: string): void {
    try {
      const payload = this.parseQQGroupMessage(data);
      if (!payload) return;
      const msg: QQBotIncomingMessage = {
        id: payload.id || '',
        authorId: payload.author?.member_openid || '',
        authorName: payload.author?.username || 'unknown',
        content: (payload.content || '').trim(),
        isDirectMessage: false,
        timestamp: Date.now(),
        // 群聊特有字段
        source: 'group',
        groupOpenid: payload.group_openid,
      };

      if (!msg.content) return;

      // 权限检查（fail-closed：白名单为空且未开 allowAnyone 时默认拒绝）
      if (!this.isUserAllowed(msg.authorId)) {
        botLogger.warn(`Group message rejected (not allowed): author=${msg.authorId}`);
        return;
      }

      this.messageCount++;
      this.lastMessageAt = Date.now();
      this.emit('message', msg);
      botLogger.info(`Group message from ${msg.authorName}: ${msg.content.substring(0, 50)}`);
      this.processMessage(msg).catch(err => botLogger.error('processMessage error:', err instanceof Error ? err.message : String(err)));
    } catch (err) {
      botLogger.error('handleGroupMessage error:', err);
    }
  }

  /** 处理 C2C 单聊消息 (C2C_MESSAGE_CREATE) */
  private handleC2CMessage(data: unknown): void {
    try {
      const payload = this.parseQQC2CMessage(data);
      if (!payload) return;
      const msg: QQBotIncomingMessage = {
        id: payload.id || '',
        authorId: payload.author?.user_openid || '',
        authorName: payload.author?.username || 'unknown',
        content: (payload.content || '').trim(),
        isDirectMessage: true,
        timestamp: Date.now(),
        source: 'c2c',
      };

      if (!msg.content) return;

      // 权限检查（fail-closed：白名单为空且未开 allowAnyone 时默认拒绝）
      // C2C 单聊是公网任意用户直达 daemon 会话的入口，必须与群聊/频道一致校验
      if (!this.isUserAllowed(msg.authorId)) {
        botLogger.warn(`C2C message rejected (not allowed): author=${msg.authorId}`);
        return;
      }

      this.messageCount++;
      this.lastMessageAt = Date.now();
      this.emit('message', msg);
      botLogger.info(`C2C message from ${msg.authorName}: ${msg.content.substring(0, 50)}`);
      this.processMessage(msg).catch(err => botLogger.error('processMessage error:', err instanceof Error ? err.message : String(err)));
    } catch (err) {
      botLogger.error('handleC2CMessage error:', err);
    }
  }

  /** 处理频道 @机器人消息 (AT_MESSAGE_CREATE) */
  private handleGuildMessage(data: unknown): void {
    try {
      const payload = this.parseQQGuildMessage(data);
      if (!payload) return;
      const msg: QQBotIncomingMessage = {
        id: payload.id || '',
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        authorId: payload.author?.id || '',
        authorName: payload.author?.username || 'unknown',
        content: (payload.content || '').trim(),
        isDirectMessage: false,
        timestamp: Date.now(),
        source: 'guild',
      };

      if (!msg.content || !msg.channelId) return;

      if (this.config.allowedGuilds?.length && msg.guildId && !this.config.allowedGuilds.includes(msg.guildId)) return;
      // 权限检查（fail-closed：白名单为空且未开 allowAnyone 时默认拒绝）
      if (!this.isUserAllowed(msg.authorId)) {
        botLogger.warn(`Guild message rejected (not allowed): author=${msg.authorId}`);
        return;
      }

      this.messageCount++;
      this.lastMessageAt = Date.now();
      this.emit('message', msg);
      botLogger.info(`Guild message from ${msg.authorName}: ${msg.content.substring(0, 50)}`);
      this.processMessage(msg).catch(err => botLogger.error('processMessage error:', err instanceof Error ? err.message : String(err)));
    } catch (err) {
      botLogger.error('handleGuildMessage error:', err);
    }
  }

  /** 处理频道私信 (DIRECT_MESSAGE_CREATE) */
  private handleDirectMessage(data: unknown): void {
    try {
      const payload = this.parseQQDirectMessage(data);
      if (!payload) return;
      const msg: QQBotIncomingMessage = {
        id: payload.id || '',
        guildId: payload.guild_id,
        authorId: payload.author?.id || '',
        authorName: payload.author?.username || 'unknown',
        content: (payload.content || '').trim(),
        isDirectMessage: true,
        timestamp: Date.now(),
        source: 'dm',
      };

      if (!msg.content) return;

      // 权限检查（fail-closed：白名单为空且未开 allowAnyone 时默认拒绝）
      // 频道私信同样是直达 daemon 会话的入口，必须与群聊/频道一致校验
      if (!this.isUserAllowed(msg.authorId)) {
        botLogger.warn(`DM message rejected (not allowed): author=${msg.authorId}`);
        return;
      }

      this.messageCount++;
      this.lastMessageAt = Date.now();
      this.emit('message', msg);
      botLogger.info(`DM message from ${msg.authorName}: ${msg.content.substring(0, 50)}`);
      this.processMessage(msg).catch(err => botLogger.error('processMessage error:', err instanceof Error ? err.message : String(err)));
    } catch (err) {
      botLogger.error('handleDirectMessage error:', err);
    }
  }

  // ─── 事件监听 (leader:text → round_complete → sendReply) ───

  private setupEventListeners(): void {
    this.eventUnsubscribes.push(
      this.emitter.subscribe('user:input_needed', (data) => {
        if (data.sessionId !== this.daemonSessionId) return;
        this.sendInteractivePrompt(data.sessionId, this.formatUserQuestionPrompt(data)).catch((err) => {
          botLogger.error('send ask_user prompt error:', err instanceof Error ? err.message : String(err));
        });
      }),
    );

    this.eventUnsubscribes.push(
      this.emitter.subscribe('user:question_answered', (data) => {
        if (data.sessionId !== this.daemonSessionId) return;
        const answer = typeof data.answer === 'string' && data.answer.trim() ? `：${data.answer.trim()}` : '';
        this.queueDaemonStatus(data.sessionId, `· ask_user 已回答${answer}`);
      }),
    );

    this.eventUnsubscribes.push(
      this.emitter.subscribe('plan:submitted', (data) => {
        if (data.sessionId !== this.daemonSessionId) return;
        this.sendInteractivePrompt(data.sessionId, this.formatPlanReviewPrompt(data.plan)).catch((err) => {
          botLogger.error('send plan review prompt error:', err instanceof Error ? err.message : String(err));
        });
      }),
    );

    this.eventUnsubscribes.push(
      this.emitter.subscribe('leader:plan_approved', (data) => {
        if (data.sessionId !== this.daemonSessionId) return;
        this.queueDaemonStatus(data.sessionId, '· 方案已批准，开始执行');
      }),
    );

    this.eventUnsubscribes.push(
      this.emitter.subscribe('leader:plan_rejected', (data) => {
        if (data.sessionId !== this.daemonSessionId) return;
        const feedback = typeof data.feedback === 'string' && data.feedback.trim() ? `：${data.feedback.trim()}` : '';
        this.queueDaemonStatus(data.sessionId, `· 方案已退回，等待重新规划${feedback}`);
      }),
    );

    const subscribeStatus = <T extends EventName>(
      event: T,
      formatter: (event: T, data: EventMap[T]) => string | null | undefined,
    ) => {
      this.eventUnsubscribes.push(
        this.emitter.subscribe(event, (data) => {
          const sessionId = this.resolveEventSessionId(data);
          if (sessionId !== this.daemonSessionId) return;
          const line = formatter(event, data);
          if (line) this.queueDaemonStatus(sessionId, line);
        }),
      );
    };

    for (const event of ['task:created', 'task:updated', 'task:deleted', 'task:assigned', 'task:completed', 'task:failed', 'task:cancelled'] as const) {
      subscribeStatus(event, (typedEvent, data) => this.formatTaskStatus(typedEvent, data));
    }
    for (const event of ['agent:spawned', 'agent:started', 'agent:status', 'agent:progress', 'agent:completed', 'agent:failed', 'agent:terminated', 'agent:heartbeat', 'agent:interactive_state', 'agent:crashed'] as const) {
      subscribeStatus(event, (typedEvent, data) => this.formatAgentStatus(typedEvent, data));
    }
    for (const event of ['leader:tool_call', 'leader:tool_progress', 'leader:tool_result', 'agent:tool_call', 'agent:tool_progress', 'agent:tool_result'] as const) {
      subscribeStatus(event, (typedEvent, data) => this.formatToolStatus(typedEvent, data));
    }
    subscribeStatus('work_note:written', (_event, data) => this.formatWorkNoteStatus(data));
    subscribeStatus('team:message_sent', (_event, data) => this.formatTeamMessageStatus(data));

    this.eventUnsubscribes.push(
      this.emitter.subscribe('leader:text', (data) => {
        const watcher = this.replyWatchers.get(data.sessionId);
        if (!watcher) return;
        const text = typeof data.content === 'string' ? data.content : contentToPlainText(data.content);
        if (text) {
          // leader:text 是终态快照，直接覆盖（而不是拼接）
          watcher.collected = text;
        }
      }),
    );

    // P0 死链修复：订阅 leader:text_chunk，纯流式场景下也能累积文本
    this.eventUnsubscribes.push(
      this.emitter.subscribe('leader:text_chunk', (data) => {
        const watcher = this.replyWatchers.get(data.sessionId);
        if (!watcher) return;
        const chunk = typeof data.chunk === 'string' ? data.chunk : '';
        if (chunk) {
          watcher.collected = (watcher.collected || '') + chunk;
        }
      }),
    );

    this.eventUnsubscribes.push(
      this.emitter.subscribe('leader:round_complete', (data) => {
        const watcher = this.replyWatchers.get(data.sessionId);
        if (!watcher || !watcher.collected) return;
        const replyText = watcher.collected;
        watcher.collected = '';
        const pendingMsg = this.pendingReplies.get(data.sessionId);
        if (!pendingMsg) return;
        this.sendReply(pendingMsg, replyText).catch((err) => {
          botLogger.error('sendReply error:', err);
        });
      }),
    );

    this.eventUnsubscribes.push(
      this.emitter.subscribe('session:completed', (data) => {
        this.cleanupReplyWatcher(data.sessionId);
      }),
    );
  }

  private pendingReplies: Map<string, QQBotIncomingMessage> = new Map();

  private setupReplyWatcher(sessionId: string, originalMsg: QQBotIncomingMessage): void {
    this.cleanupReplyWatcher(sessionId);
    this.lastReplyTarget = originalMsg;
    this.replyWatchers.set(sessionId, { collected: '', timer: null });
    this.pendingReplies.set(sessionId, originalMsg);

    const timer = setTimeout(() => {
      this.cleanupReplyWatcher(sessionId);
    }, 5 * 60 * 1000);
    const watcher = this.replyWatchers.get(sessionId);
    if (watcher) watcher.timer = timer;
  }

  private cleanupReplyWatcher(sessionId: string): void {
    const watcher = this.replyWatchers.get(sessionId);
    if (watcher) {
      if (watcher.timer) clearTimeout(watcher.timer);
      this.replyWatchers.delete(sessionId);
    }
    this.pendingReplies.delete(sessionId);
  }

  private getDaemonReplyTarget(sessionId: string): QQBotIncomingMessage | undefined {
    return this.pendingReplies.get(sessionId) || this.lastReplyTarget || undefined;
  }

  private async sendInteractivePrompt(sessionId: string, content: string): Promise<void> {
    const target = this.getDaemonReplyTarget(sessionId);
    if (!target) {
      botLogger.warn(`interactive prompt dropped: no QQ target session=${sessionId}`);
      return;
    }
    await this.sendReply(target, content);
  }

  private queueDaemonStatus(sessionId: string, line: string): void {
    if (sessionId !== this.daemonSessionId) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    const bucket = this.daemonStatusBuffer.get(sessionId) || { lines: [], timer: null };
    if (bucket.lines[bucket.lines.length - 1] !== trimmed) {
      bucket.lines.push(trimmed);
    }
    bucket.lines = bucket.lines.slice(-12);
    if (!bucket.timer) {
      bucket.timer = setTimeout(() => this.flushDaemonStatus(sessionId), QQBot.STATUS_FLUSH_MS);
      bucket.timer.unref?.();
    }
    this.daemonStatusBuffer.set(sessionId, bucket);
  }

  private flushDaemonStatus(sessionId: string): void {
    const bucket = this.daemonStatusBuffer.get(sessionId);
    if (!bucket) return;
    this.daemonStatusBuffer.delete(sessionId);
    if (bucket.timer) clearTimeout(bucket.timer);
    if (bucket.lines.length === 0) return;
    this.sendDaemonStatus(sessionId, bucket.lines.join('\n')).catch((err) => {
      botLogger.error('send daemon status error:', err instanceof Error ? err.message : String(err));
    });
  }

  private async sendDaemonStatus(sessionId: string, content: string): Promise<void> {
    const target = this.getDaemonReplyTarget(sessionId);
    if (!target) {
      botLogger.warn(`daemon status dropped: no QQ target session=${sessionId}, content=${content.slice(0, 120)}`);
      return;
    }
    await this.sendReply(target, content);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private firstStringField(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
    for (const key of keys) {
      const value = this.stringField(record, key);
      if (value) return value;
    }
    return undefined;
  }

  private taskFromPayload(data: TaskStatusPayload): unknown {
    return 'task' in data ? data.task : undefined;
  }

  private resolveEventSessionId<T extends EventName>(data: EventMap[T]): string | undefined {
    const payload = this.asRecord(data);
    const task = this.asRecord(payload?.task);
    const note = this.asRecord(payload?.note);
    return this.stringField(payload, 'sessionId')
      ?? this.stringField(task, 'session_id')
      ?? this.stringField(task, 'sessionId')
      ?? this.stringField(note, 'sessionId');
  }

  private shorten(value: unknown, max = 80): string {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  private formatUserQuestionPrompt(data: {
    question: string;
    options?: Array<{ value: string; label?: string }>;
    multiSelect?: boolean;
    questions?: Array<{ question: string; options?: Array<{ value: string; label?: string }>; multiSelect?: boolean }>;
  }): string {
    const lines = ['需要你确认：'];
    const questions = Array.isArray(data.questions) && data.questions.length > 0
      ? data.questions
      : [{ question: data.question, options: data.options, multiSelect: data.multiSelect }];

    questions.forEach((question, index) => {
      lines.push(`${questions.length > 1 ? `${index + 1}. ` : ''}${question.question}`);
      if (question.options?.length) {
        question.options.forEach((option, optionIndex) => {
          lines.push(`  ${optionIndex + 1}) ${option.label || option.value}`);
        });
      }
      if (question.multiSelect) {
        lines.push('  可多选，请用逗号分隔。');
      }
    });

    lines.push('请直接回复你的选择或补充说明。');
    return lines.join('\n');
  }

  private taskAction(event: TaskStatusEvent): string {
    return event === 'task:deleted'
      ? 'deleted'
      : taskActionForEvent(event as CanonicalTaskStatusEvent) ?? event.replace('task:', '');
  }

  private taskStatusLabel(event: TaskStatusEvent, task: unknown): string {
    if (task) return normalizeTaskStatus(task);
    return this.taskAction(event);
  }

  private formatTaskStatus(event: TaskStatusEvent, data: TaskStatusPayload): string | null {
    const task = this.taskFromPayload(data);
    const taskRecord = this.asRecord(task);
    const payload = this.asRecord(data);
    const idValue = this.stringField(taskRecord, 'id') ?? this.stringField(payload, 'taskId');
    const id = idValue ? `#${idValue}` : '';
    const subject = this.shorten(this.firstStringField(taskRecord, ['subject', 'title', 'description']) ?? '', 60);
    const agent = this.firstStringField(taskRecord, ['assigned_agent', 'assignedAgent', 'agentName'])
      ?? this.firstStringField(payload, ['agentId', 'agentName']);
    const action = this.taskAction(event);
    const status = this.taskStatusLabel(event, task);
    const suffix = agent ? ` @${agent}` : '';
    return `· 任务 ${action}/${status}: ${[id, subject].filter(Boolean).join(' ')}${suffix}`.trim();
  }

  private formatAgentStatus(event: AgentStatusEvent, data: AgentStatusPayload): string | null {
    const payload = this.asRecord(data);
    const name = this.firstStringField(payload, ['agentName', 'name', 'agentId']) ?? 'agent';
    const action = event.replace('agent:', '');
    if (action === 'heartbeat') return null;
    const normalized = normalizeAgentStatus(this.stringField(payload, 'status') ?? action);
    const status = normalized === 'idle' ? '' : ` ${normalized}`;
    const taskId = this.stringField(payload, 'taskId');
    const task = taskId ? ` task=${taskId}` : '';
    const messageValue = this.firstStringField(payload, ['message', 'statusText', 'summary']);
    const message = messageValue ? ` ${this.shorten(messageValue, 80)}` : '';
    const errorValue = this.firstStringField(payload, ['error', 'reason', 'errorDetail']);
    const error = errorValue ? ` ${this.shorten(errorValue, 80)}` : '';
    return `· Agent ${action}: ${name}${status}${task}${message}${error}`;
  }

  private formatToolStatus(event: ToolStatusEvent, data: ToolStatusPayload): string | null {
    const payload = this.asRecord(data);
    const tool = this.stringField(payload, 'tool');
    if (!tool) return null;
    const owner = this.firstStringField(payload, ['agentName', 'agentId']) ?? (event.startsWith('leader:') ? 'leader' : 'agent');
    const action = TOOL_STATUS_ACTION_LABEL[event];
    const messageValue = this.stringField(payload, 'message');
    const message = messageValue ? ` ${this.shorten(messageValue, 80)}` : '';
    return `· 工具${action}: ${owner} ${tool}${message}`;
  }

  private formatWorkNoteStatus(data: WorkNoteStatusPayload): string | null {
    const payload = this.asRecord(data);
    const note = this.asRecord(payload?.note) ?? payload;
    const agent = this.firstStringField(note, ['agentName', 'agentId'])
      ?? this.stringField(payload, 'agentId')
      ?? 'agent';
    const title = this.shorten(this.firstStringField(note, ['title', 'content', 'text']) ?? '', 80);
    return `· 工作笔记: ${agent}${title ? ` ${title}` : ''}`;
  }

  private formatTeamMessageStatus(data: TeamMessageStatusPayload): string | null {
    const payload = this.asRecord(data);
    const msg = this.asRecord(payload?.message) ?? payload;
    const from = this.firstStringField(msg, ['fromMember', 'from']) ?? 'team';
    const to = this.firstStringField(msg, ['toMember', 'toTeam'])
      ?? this.stringField(payload, 'toTeam')
      ?? 'team';
    const content = this.shorten(this.stringField(msg, 'content') ?? '', 100);
    return `· 团队消息: ${from} → ${to}${content ? ` ${content}` : ''}`;
  }

  private formatPlanReviewPrompt(plan: unknown): string {
    const planObj = plan && typeof plan === 'object' ? plan as Record<string, unknown> : {};
    const lines = ['方案等待审批：'];
    for (const key of ['goal', 'analysis', 'approach', 'risks', 'verification']) {
      const value = planObj[key];
      if (typeof value === 'string' && value.trim()) {
        lines.push(`${key}: ${value.trim()}`);
      }
    }
    if (Array.isArray(planObj.tasks) && planObj.tasks.length > 0) {
      lines.push('tasks:');
      for (const task of planObj.tasks.slice(0, 8)) {
        if (task && typeof task === 'object') {
          const taskObj = task as Record<string, unknown>;
          const id = typeof taskObj.id === 'string' ? taskObj.id : '';
          const title = typeof taskObj.title === 'string' ? taskObj.title : typeof taskObj.description === 'string' ? taskObj.description : '';
          if (id || title) lines.push(`- ${id}${id && title ? ': ' : ''}${title}`);
        }
      }
    }
    lines.push('回复 /approve 批准执行；回复修改意见则退回调整。');
    return lines.join('\n');
  }

  private async processMessage(msg: QQBotIncomingMessage): Promise<void> {
    // 去重：同一 msg.id 不重复处理（QQ Gateway 会在网络抖动时重推 DISPATCH）
    if (msg.id && this.processedMsgIds.has(msg.id)) {
      botLogger.info(`processMessage: duplicate msg id=${msg.id}, skip`);
      return;
    }
    if (msg.id) {
      this.processedMsgIds.add(msg.id);
      if (this.processedMsgIds.size > QQBot.MAX_PROCESSED_IDS) {
        // LRU 降级：Set 没有 FIFO 视图但保持插入顺序，丢最早的一批
        const overflow = this.processedMsgIds.size - QQBot.MAX_PROCESSED_IDS;
        let removed = 0;
        for (const id of this.processedMsgIds) {
          if (removed >= overflow) break;
          this.processedMsgIds.delete(id);
          removed++;
        }
      }
    }

    const sessionId = this.daemonSessionId;
    botLogger.info(`processMessage: sessionId=${sessionId}, source=${msg.source}, content=${msg.content.substring(0, 80)}`);

    // 确保 session 存在
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      botLogger.error(`processMessage: daemon session ${sessionId} not found, cannot process message`);
      return;
    }

    this.setupReplyWatcher(sessionId, msg);

    // 所有 QQ 消息都发送到同一个守护会话
    await this.sessionManager.sendUserInput(sessionId, msg.content, { source: 'qqbot' });
    botLogger.info(`processMessage: sent to daemon session ${sessionId}`);
  }

  // ─── 发送消息 ───

  /**
   * 按字符将长文本切成 QQ 可接受的分片
   * QQ 官方机器人文本长度上限约 1000 字符，这里保守取 MAX_REPLY_CHARS=800
   */
  private chunkReply(content: string): string[] {
    if (!content) return [];
    const max = QQBot.MAX_REPLY_CHARS;
    if (content.length <= max) return [content];
    const chunks: string[] = [];
    let i = 0;
    while (i < content.length) {
      chunks.push(content.slice(i, i + max));
      i += max;
    }
    return chunks;
  }

  /** 取下一个 msg_seq 值（同一 target 下单调递增） */
  private nextMsgSeq(target: string): number {
    const cur = this.msgSeqCounters.get(target) ?? 0;
    const next = cur + 1;
    this.msgSeqCounters.set(target, next);
    return next;
  }

  private async sendReply(originalMsg: QQBotIncomingMessage, content: string): Promise<void> {
    const chunks = this.chunkReply(content);
    if (chunks.length === 0) return;

    // 为这条 msg_id 分配一个独立 seq 计数器（不同 incoming 消息互不影响）
    const seqKey = `${originalMsg.source}:${originalMsg.id || originalMsg.authorId}`;

    for (let idx = 0; idx < chunks.length; idx++) {
      const piece = chunks[idx]!;
      const seq = this.nextMsgSeq(seqKey);
      const ok = await this.sendReplyChunk(originalMsg, piece, seq, idx, chunks.length);
      if (!ok) {
        // 一个分片失败后续就不再硬发，交由 reply_failed 事件处理
        return;
      }
    }
  }

  private async sendReplyChunk(
    originalMsg: QQBotIncomingMessage,
    content: string,
    msgSeq: number,
    idx: number,
    total: number,
  ): Promise<boolean> {
    const MAX_RETRY = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      let fatal = false;
      let needTokenRefresh = false;
      try {
        const headers = await this.getApiHeaders();
        const baseUrl = this.config.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;

        let url: string;
        let body: Record<string, unknown>;

        switch (originalMsg.source) {
          case 'group':
            // 群聊回复: POST /v2/groups/{group_openid}/messages
            url = `${baseUrl}/v2/groups/${originalMsg.groupOpenid}/messages`;
            body = { content, msg_type: 0, msg_id: originalMsg.id, msg_seq: msgSeq };
            break;

          case 'c2c':
            // C2C 单聊回复: POST /v2/users/{user_openid}/messages
            url = `${baseUrl}/v2/users/${originalMsg.authorId}/messages`;
            body = { content, msg_type: 0, msg_id: originalMsg.id, msg_seq: msgSeq };
            break;

          case 'guild':
            // 频道回复: POST /channels/{channel_id}/messages
            if (!originalMsg.channelId) return false;
            url = `${baseUrl}/channels/${originalMsg.channelId}/messages`;
            body = { content, msg_id: originalMsg.id };
            break;

          case 'dm':
            // 频道私信回复: POST /dms/{guild_id}/messages
            url = `${baseUrl}/dms/${originalMsg.guildId || originalMsg.authorId}/messages`;
            body = { content, msg_id: originalMsg.id };
            break;

          default:
            botLogger.error('sendReply: unknown message source', originalMsg.source);
            return false;
        }

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => resp.statusText);
          const err = new Error(`sendReply ${resp.status} ${errText} (url=${url})`);
          // 401: token 失效，刷新后重试
          if (resp.status === 401) {
            needTokenRefresh = true;
            throw err;
          }
          // 4xx 非 401/429 不重试（语义错误，重试无意义）
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            fatal = true;
            throw err;
          }
          throw err;
        }

        botLogger.info(
          `Reply chunk ${idx + 1}/${total} seq=${msgSeq} sent to ${originalMsg.source}:${originalMsg.authorId}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`,
        );
        return true;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (fatal) {
          botLogger.error(`sendReply client error (no retry): ${lastErr.message}`);
          this.emit('reply_failed', { msg: originalMsg, error: lastErr.message });
          return false;
        }
        if (needTokenRefresh) {
          botLogger.warn('sendReply: 401 Unauthorized, forcing token refresh');
          try {
            await this.authenticate(true);
          } catch (e) {
            botLogger.error('sendReply: token refresh failed:', e instanceof Error ? e.message : String(e));
          }
        }
        botLogger.warn(`sendReply attempt ${attempt}/${MAX_RETRY} failed: ${lastErr.message}`);
        if (attempt >= MAX_RETRY) {
          botLogger.error(`sendReply exhausted ${MAX_RETRY} retries:`, lastErr.message);
          this.emit('reply_failed', { msg: originalMsg, error: lastErr.message });
          return false;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    return false;
  }
}
