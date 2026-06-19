import { EventEmitter } from './EventEmitter.js';
import { config as runtimeConfig } from '../config.js';
import { coreLogger } from './Log.js';
import { globalTracer } from './Tracing.js';
import type { Transport, TransportEnvelope } from './transport/Transport.js';
import { createEnvelope } from './transport/Transport.js';
import { LocalTransport } from './transport/LocalTransport.js';

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Default byte budget for messageHistory (50 MB) */
const DEFAULT_MAX_HISTORY_BYTES = 50 * 1024 * 1024;
/** Inbox is considered stale if no dequeue (poll) for this duration */
const STALE_INBOX_MS = 5 * 60 * 1000;
// #49: idle 超此且无 waiter 视为真正死亡的收件人,P0/P1 也无消费者 → 整箱清理(含 P0/P1)。
// STALE_MS(5min)内仍保留 P0/P1,兼容短暂卡顿后恢复的收件人。
const DEAD_INBOX_MS = 30 * 60 * 1000;
/** pendingAcks entries older than 2x their timeout are force-reaped */
const ACK_REAP_FACTOR = 2;

/**
 * 消息类型定义 —— BusMessage 判别联合(完全结构化)。
 * 旧 `{type: string; payload: unknown}` 已升级为按 type 收窄 payload 的判别联合,
 * 详见 BusMessageTypes.ts。这里 re-export 保持现有 `import { BusMessage } from './MessageBus.js'` 不破。
 */
import {
  type BusMessage,
  type BusMessageType,
  type BusMessagePayloadMap,
  parseBusMessage,
} from './BusMessageTypes.js';
export type { BusMessage, BusMessageType, BusMessagePayloadMap } from './BusMessageTypes.js';

/**
 * 消息优先级枚举
 * P0_CRITICAL: task_complete, task_failed, worker_recovery, user_intervention, force_terminate
 * P1_HIGH: permission_request, permission_response, agent_error, message
 * P2_NORMAL: default, regular messages
 * P3_LOW: supervision_probe
 */
export enum MessagePriority {
  P0_CRITICAL = 0,
  P1_HIGH = 1,
  P2_NORMAL = 2,
  P3_LOW = 3,
}

/**
 * 优先级邮箱 — 四个桶分别存放不同优先级的消息
 */
export interface PriorityInbox {
  p0: BusMessage[];  // CRITICAL
  p1: BusMessage[];  // HIGH
  p2: BusMessage[];  // NORMAL
  p3: BusMessage[];  // LOW
  /** Timestamp of last poll/dequeue operation — used for stale inbox detection */
  lastAccessTime: number;
}

/** Keys that correspond to priority message buckets (excludes metadata fields) */
export type PriorityBucketKey = 'p0' | 'p1' | 'p2' | 'p3';

/**
 * 优先级计数
 */
export interface PriorityCounts {
  p0: number;
  p1: number;
  p2: number;
  p3: number;
}

/**
 * 消息处理器类型
 */
export type MessageHandler = (message: BusMessage) => void | Promise<void>;

export interface MessageHandlerFailure {
  messageId: string;
  to: string;
  handlerRecipient: string;
  type: string;
  error: string;
  timestamp: number;
}

export interface ReliableSendOptions {
  sessionId?: string;
  retries?: number;
  backoffMs?: number;
}

export type ReliableSendResult =
  | { ok: true; messageId: string; attempts: number }
  | { ok: false; attempts: number; error: string };

/**
 * 消息类型 → 优先级的映射规则
 * P0 消息类型
 */
const P0_MESSAGE_TYPES = new Set([
  'task_complete',
  'task_failed',
  'worker_recovery',
  'agent_health_critical',
  'user_intervention',
  'force_terminate',
]);

/**
 * P1 消息类型
 */
const P1_MESSAGE_TYPES = new Set([
  'permission_request',
  'permission_response',
  'agent_error',
  'system_context',
  'message',  // Leader → Worker 的普通消息也需要高优先级中断，否则被卡住的 Worker 无法收到
]);

const RELIABLE_CRITICAL_MESSAGE_TYPES = new Set([
  'task_complete',
  'task_failed',
  'worker_recovery',
  'permission_request',
  'permission_response',
  'user_intervention',
  'agent_health_critical',
]);

/**
 * P3 消息类型
 */
const P3_MESSAGE_TYPES = new Set([
  'supervision_probe',
]);

/**
 * 根据消息类型自动分类优先级
 */
export function classifyPriority(type: string): MessagePriority {
  if (P0_MESSAGE_TYPES.has(type)) {
    return MessagePriority.P0_CRITICAL;
  }
  if (P1_MESSAGE_TYPES.has(type)) {
    return MessagePriority.P1_HIGH;
  }
  if (P3_MESSAGE_TYPES.has(type)) {
    return MessagePriority.P3_LOW;
  }
  return MessagePriority.P2_NORMAL;
}

export function isReliableCriticalMessageType(type: string): boolean {
  return RELIABLE_CRITICAL_MESSAGE_TYPES.has(type);
}

/**
 * 优先级桶名称 → 枚举映射
 */
function priorityKeyToEnum(key: PriorityBucketKey): MessagePriority {
  const map: Record<PriorityBucketKey, MessagePriority> = {
    p0: MessagePriority.P0_CRITICAL,
    p1: MessagePriority.P1_HIGH,
    p2: MessagePriority.P2_NORMAL,
    p3: MessagePriority.P3_LOW,
  };
  return map[key];
}

/**
 * 消息总线 - 用于 Agent 间通信
 * 支持四级优先级队列，P0 消息可立即唤醒等待者
 */
export class MessageBus {
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private messageHistory: BusMessage[] = [];
  private inboxes: Map<string, PriorityInbox> = new Map();
  private waiters: Map<string, Set<(message: BusMessage | null) => void>> = new Map();
  private p0Waiters: Map<string, Set<(message: BusMessage) => void>> = new Map();
  /** 等待 ACK 的回调: messageId -> { resolve, timeoutId, deadline } */
  private pendingAcks: Map<string, { resolve: (value: boolean) => void; timeoutId: ReturnType<typeof setTimeout>; deadline: number }> = new Map();
  private handlerFailures: MessageHandlerFailure[] = [];
  private maxHistorySize: number;
  private maxHistoryBytes: number;
  private historyBytes: number = 0;
  private emitter: EventEmitter;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private transport: Transport;
  private nextSeq = 1;

  constructor(maxHistorySize = 1000, emitter?: EventEmitter, maxHistoryBytes = DEFAULT_MAX_HISTORY_BYTES, transport?: Transport) {
    this.maxHistorySize = maxHistorySize;
    this.maxHistoryBytes = maxHistoryBytes;
    this.emitter = emitter || new EventEmitter();
    this.transport = transport ?? new LocalTransport();
    this.transport.onMessage((envelope) => {
      this.handleTransportEnvelope(envelope);
    });

    // 每 5 分钟清理过大的 inbox，防止长时间运行后内存膨胀
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleInboxes();
    }, 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * 生成唯一消息 ID
   */
  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * 创建空的优先级邮箱
   */
  private createEmptyInbox(): PriorityInbox {
    return { p0: [], p1: [], p2: [], p3: [], lastAccessTime: Date.now() };
  }

  /**
   * 获取优先级桶的 key
   */
  private priorityKey(priority: MessagePriority): PriorityBucketKey {
    switch (priority) {
      case MessagePriority.P0_CRITICAL: return 'p0';
      case MessagePriority.P1_HIGH: return 'p1';
      case MessagePriority.P2_NORMAL: return 'p2';
      case MessagePriority.P3_LOW: return 'p3';
    }
  }

  private estimatePayloadBytes(payload: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch {/* expected: use string form for non-serializable values */
      return Buffer.byteLength(String(payload), 'utf8');
    }
  }

  private ensureMessageSize(type: string, payload: unknown): void {
    const bytes = this.estimatePayloadBytes(payload);
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new Error(`MessageBus rejected ${type} message: ${bytes} bytes exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
  }

  private enforceInboxBudget(recipient: string, inbox: PriorityInbox): void {
    const threshold = runtimeConfig.message_bus.critical_threshold;
    let total = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
    if (total <= threshold) return;

    const dropFrom = (bucket: BusMessage[], count: number) => bucket.splice(0, Math.min(bucket.length, count));
    let overflow = total - threshold;
    overflow -= dropFrom(inbox.p3, overflow).length;
    overflow -= dropFrom(inbox.p2, overflow).length;
    // P2 修复：enforceInboxBudget 与 cleanupStaleInboxes 对齐 — P0/P1 永不丢弃。
    // 旧实现会 splice P1（permission_request/response/agent_error 等），导致权限链路
    // 死锁或普通消息丢失。若 P0+P1 已超 threshold，说明 inbox 已经极度异常，
    // 继续丢 P1 也无济于事，不如保留高优先级消息并打 error 日志。
    const afterTotal = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
    if (overflow > 0) {
      coreLogger.error(`[MessageBus] Inbox budget exhausted for ${recipient}: P0=${inbox.p0.length} P1=${inbox.p1.length} still exceed threshold ${threshold} by ${overflow}; P1 messages NOT dropped (P0+P1 must never be lost).`);
    } else {
      coreLogger.warn(`[MessageBus] Trimmed inbox for ${recipient} to ${afterTotal}/${threshold} messages`);
    }
  }

  register(recipient: string): void {
    if (!this.inboxes.has(recipient)) {
      this.inboxes.set(recipient, this.createEmptyInbox());
    }
    if (!this.waiters.has(recipient)) {
      this.waiters.set(recipient, new Set());
    }
    if (!this.p0Waiters.has(recipient)) {
      this.p0Waiters.set(recipient, new Set());
    }
  }

  /**
   * 注销收件人，清理其所有状态（inbox、waiters、handlers、p0Waiters）
   */
  unregister(recipient: string): void {
    this.inboxes.delete(recipient);
    this.waiters.delete(recipient);
    this.p0Waiters.delete(recipient);
    this.handlers.delete(recipient);
  }

  /**
   * 获取收件人邮箱（展平为单一数组，按优先级排序）
   */
  private getFlattenedInbox(recipient: string): BusMessage[] {
    this.register(recipient);
    const inbox = this.inboxes.get(recipient)!;
    return [
      ...this.orderBucketMessages(inbox.p0),
      ...inbox.p1,
      ...inbox.p2,
      ...inbox.p3,
    ];
  }

  /**
   * 同一 P0 桶内，用户介入永远优先于自治/worker 事件。
   * FIFO 仍在 user_intervention 子集内保持，避免连续用户输入倒序。
   */
  private orderBucketMessages(bucket: BusMessage[]): BusMessage[] {
    const userInterventions = bucket.filter((message) => message.type === 'user_intervention');
    const others = bucket.filter((message) => message.type !== 'user_intervention');
    return [...userInterventions, ...others];
  }

  /**
   * 发送消息
   * @param from 发送者 ID
   * @param to 接收者 ID (或 '*' 表示广播)
   * @param type 消息类型
   * @param payload 消息内容
   * @returns 消息 ID
   */
  // 泛型重载:字面量 type → payload 按字面量收窄。typo('task_complte')编译期报错。
  send<K extends BusMessageType>(from: string, to: string, type: K, payload: BusMessagePayloadMap[K]): string;
  // 透传重载:仅用于已通过 parseBusMessage 校验的逃逸口(transport/IPC)整体投递。
  send(message: BusMessage): string;
  send(fromOrMessage: string | BusMessage, to?: string, type?: BusMessageType, payload?: unknown): string {
    if (typeof fromOrMessage === 'object' && fromOrMessage !== null) {
      // 透传路径:已是合法 BusMessage,直接投递。
      this.ensureMessageSize(fromOrMessage.type, fromOrMessage.payload);
      this.deliverMessage(fromOrMessage);
      return fromOrMessage.id;
    }
    if (arguments.length !== 4) {
      throw new Error('MessageBus.send requires canonical arguments: from, to, type, payload');
    }
    const from = fromOrMessage as string;
    this.ensureMessageSize(type as string, payload);
    const activeSpan = globalTracer.currentSpan();

    // 单一可信构造点:泛型重载已在编译期保证 type/payload 对应,此处用受控 cast 桥接到判别联合。
    const message = {
      id: this.generateId(),
      from,
      to: to as string,
      type,
      payload,
      timestamp: Date.now(),
      seq: this.nextSeq++,
      traceId: activeSpan?.context.traceId,
      parentSpanId: activeSpan?.context.spanId,
    } as BusMessage;

    this.deliverMessage(message);

    return message.id;
  }

  async sendReliable<K extends BusMessageType>(
    from: string,
    to: string,
    type: K,
    payload: BusMessagePayloadMap[K],
    options: ReliableSendOptions = {},
  ): Promise<ReliableSendResult> {
    const retries = Math.max(0, Math.floor(options.retries ?? (isReliableCriticalMessageType(type) ? 3 : 0)));
    const backoffMs = Math.max(0, Math.floor(options.backoffMs ?? 100));
    const maxAttempts = retries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const messageId = this.send(from, to, type, payload);
        return { ok: true, messageId, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && backoffMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs * attempt));
        } else if (attempt < maxAttempts) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    const error = lastError instanceof Error ? lastError.message : String(lastError);
    const attempts = maxAttempts;
    const timestamp = Date.now();
    coreLogger.error(`[MessageBus] Reliable send dead-lettered ${type} ${from} -> ${to}: ${error}`);
    this.emitter.emit('bus:dead_letter', {
      sessionId: options.sessionId ?? '',
      from,
      to,
      type,
      payload,
      error,
      attempts,
      timestamp,
    });
    return { ok: false, attempts, error };
  }

  getTransport(): Transport {
    return this.transport;
  }

  sendTransportEnvelope(type: TransportEnvelope['type'], payload: unknown): void {
    this.transport.send(createEnvelope(type, payload));
  }

  private handleTransportEnvelope(envelope: TransportEnvelope): void {
    if (envelope.type === 'bus_message') {
      // 反序列化守卫:校验 type 字面量合法 + 信封字段齐全,堵住远端脏 payload。
      const msg = parseBusMessage(envelope.payload);
      if (msg) {
        this.deliverMessage(msg);
        return;
      }
    }
    this.emitter.emit('transport:envelope', envelope);
  }


  /**
   * 内部消息投递 — 路由到正确的优先级桶并唤醒等待者
   */
  private deliverMessage(message: BusMessage): void {
    const seq = message.seq;
    if (!Number.isFinite(seq) || (seq ?? 0) <= 0) {
      message.seq = this.nextSeq++;
    } else if (seq! >= this.nextSeq) {
      this.nextSeq = seq! + 1;
    }

    // 保存到历史（count + byte budget）
    const msgBytes = this.estimatePayloadBytes(message);
    this.messageHistory.push(message);
    this.historyBytes += msgBytes;
    // Enforce count limit
    while (this.messageHistory.length > this.maxHistorySize) {
      const removed = this.messageHistory.shift();
      if (removed) this.historyBytes -= this.estimatePayloadBytes(removed);
    }
    // Enforce byte limit — shift incrementally
    while (this.historyBytes > this.maxHistoryBytes && this.messageHistory.length > 0) {
      const removed = this.messageHistory.shift();
      if (removed) this.historyBytes -= this.estimatePayloadBytes(removed);
    }

    if (this.shouldRouteViaTransport(message)) {
      this.transport.send(createEnvelope('bus_message', message));
      return;
    }

    // 广播消息（to === '*'）只走 handler dispatch，不写入 inbox。
    // 没有任何消费者会 poll('*')，若写入会导致 '*' inbox 永久积累内存泄漏。
    if (message.to === '*') {
      this.dispatch(message);
      return;
    }

    this.register(message.to);
    const inbox = this.inboxes.get(message.to)!;
    const priority = classifyPriority(message.type);
    const key = this.priorityKey(priority);
    inbox[key].push(message);

    this.enforceInboxBudget(message.to, inbox);
    const totalMessages = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
    if (totalMessages > runtimeConfig.message_bus.warning_threshold) {
      coreLogger.warn(`[MessageBus] Inbox backlog warning for ${message.to}: ${totalMessages} messages queued`);
    }

    // P0 消息：立即唤醒所有 critical waiters
    if (priority === MessagePriority.P0_CRITICAL) {
      const criticalWaiters = this.p0Waiters.get(message.to);
      if (criticalWaiters && criticalWaiters.size > 0) {
        for (const resolve of criticalWaiters) {
          resolve(message);
        }
        criticalWaiters.clear();
      }
    }

    // 所有消息都唤醒普通 waiters
    const waiters = this.waiters.get(message.to);
    if (waiters && waiters.size > 0) {
      for (const resolve of waiters) {
        resolve(message);
      }
      waiters.clear();
    }

    // 优先级事件使用 canonical BusMessage shape，外加 priority 元数据。
    this.emitter.emit('message:bus:priority', {
      ...message,
      priority,
    });

    // 分发消息
    this.dispatch(message);
  }

  private shouldRouteViaTransport(message: BusMessage): boolean {
    return this.transport.type !== 'local' && message.to.startsWith('remote:');
  }

  /**
   * 广播消息（发送给所有订阅者）
   */
  broadcast<K extends BusMessageType>(from: string, type: K, payload: BusMessagePayloadMap[K]): string {
    return this.send(from, '*', type, payload);
  }

  /**
   * 分发消息到对应的处理器
   */
  private dispatch(message: BusMessage): void {
    const invokeHandler = (handlerRecipient: string, handler: MessageHandler) => {
      try {
        Promise.resolve(handler(message)).catch((error) => {
          this.recordHandlerFailure(message, handlerRecipient, error);
        });
      } catch (error) {
        this.recordHandlerFailure(message, handlerRecipient, error);
      }
    };

    // 特定接收者的处理器
    const specificHandlers = this.handlers.get(message.to);
    if (specificHandlers) {
      for (const handler of specificHandlers) {
        invokeHandler(message.to, handler);
      }
    }

    // 广播处理器
    const broadcastHandlers = this.handlers.get('*');
    if (broadcastHandlers && message.to !== '*') {
      for (const handler of broadcastHandlers) {
        invokeHandler('*', handler);
      }
    }
  }

  private recordHandlerFailure(message: BusMessage, handlerRecipient: string, error: unknown): void {
    const failure: MessageHandlerFailure = {
      messageId: message.id,
      to: message.to,
      handlerRecipient,
      type: message.type,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    this.handlerFailures.push(failure);
    if (this.handlerFailures.length > this.maxHistorySize) {
      this.handlerFailures.shift();
    }
    coreLogger.error(`[MessageBus] Handler error for ${handlerRecipient}: ${failure.error}`);
    this.emitter.emit('message:bus:handler_failed', failure);
  }

  getHandlerFailures(limit = DEFAULT_HISTORY_LIMIT): MessageHandlerFailure[] {
    return this.handlerFailures.slice(-limit);
  }

  /**
   * 订阅消息
   * @param recipient 接收者 ID (或 '*' 接收所有消息)
   * @param handler 消息处理器
   */
  subscribe(recipient: string, handler: MessageHandler): () => void {
    this.register(recipient);
    if (!this.handlers.has(recipient)) {
      this.handlers.set(recipient, new Set());
    }
    this.handlers.get(recipient)!.add(handler);

    // 返回取消订阅函数
    return () => {
      this.unsubscribe(recipient, handler);
    };
  }

  /**
   * 取消订阅
   */
  unsubscribe(recipient: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(recipient);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(recipient);
      }
    }
  }

  /**
   * 获取消息历史
   * @param recipient 过滤接收者（可选）
   * @param from 过滤发送者（可选）
   * @param limit 限制数量
   */
  getHistory(
    recipient?: string,
    from?: string,
    limit = DEFAULT_HISTORY_LIMIT
  ): BusMessage[] {
    let history = this.messageHistory;

    if (recipient) {
      history = history.filter(m => m.to === recipient || m.to === '*');
    }

    if (from) {
      history = history.filter(m => m.from === from);
    }

    return history.slice(-limit);
  }

  /**
   * 轮询获取新消息 — 按优先级顺序 P0 → P1 → P2 → P3
   * @param recipient 接收者 ID
   * @param from 最后一条消息的时间戳（可选）
   */
  poll(recipient: string, from?: number): BusMessage[] {
    this.register(recipient);
    const inbox = this.inboxes.get(recipient)!;
    inbox.lastAccessTime = Date.now();

    const allMessages: BusMessage[] = [];
    // 按优先级顺序消费
    for (const key of (['p0', 'p1', 'p2', 'p3'] as PriorityBucketKey[])) {
      const bucket = inbox[key];
      // 返回集与保留集必须互补：并集 = 原 bucket、交集 = ∅，任何消息都不能既不返回也不保留。
      // 返回 timestamp >= from（含同毫秒边界消息），保留 timestamp < from。
      // 旧实现返回 > from、保留 < from，导致 timestamp === from 的同毫秒新消息被静默丢弃。
      // 用 >= from 消费边界：已投递过的消息上一轮已从 bucket 移除（保留集为 < from 不含它们），
      // 因此正常游标推进不会重复投递；而同毫秒到达的新消息得以投递，避免静默丢失/永久滞留。
      const filtered = from !== undefined ? bucket.filter((m) => m.timestamp >= from) : bucket;
      const ordered = key === 'p0' ? this.orderBucketMessages(filtered) : filtered;
      allMessages.push(...ordered);
      // 清空已消费的消息：保留严格早于 from 的（与返回集互补），无 from 时全量清空。
      if (from !== undefined) {
        inbox[key] = bucket.filter((m) => m.timestamp < from);
      } else {
        inbox[key] = [];
      }
    }

    return allMessages;
  }

  /**
   * 只消费指定类型的消息，保留其他消息在收件箱中。
   * 用于 Leader 在执行自治动作前抢占式抽取 user_intervention。
   */
  pollByType(recipient: string, types: string[]): BusMessage[] {
    this.register(recipient);
    const inbox = this.inboxes.get(recipient)!;
    inbox.lastAccessTime = Date.now();
    const wanted = new Set(types);
    const matched: BusMessage[] = [];

    for (const key of (['p0', 'p1', 'p2', 'p3'] as PriorityBucketKey[])) {
      const bucket = inbox[key];
      const ordered = key === 'p0' ? this.orderBucketMessages(bucket) : bucket;
      matched.push(...ordered.filter((message) => wanted.has(message.type)));
      inbox[key] = bucket.filter((message) => !wanted.has(message.type));
    }

    return matched;
  }

  /**
   * 查看当前收件箱快照（不消费消息）— 按优先级排序
   */
  peek(recipient: string): BusMessage[] {
    return this.getFlattenedInbox(recipient);
  }

  removeMessages(recipient: string, messageIds: string[]): number {
    this.register(recipient);
    const inbox = this.inboxes.get(recipient)!;
    const ids = new Set(messageIds);
    let removed = 0;
    for (const key of (['p0', 'p1', 'p2', 'p3'] as PriorityBucketKey[])) {
      const before = inbox[key].length;
      inbox[key] = inbox[key].filter(message => !ids.has(message.id));
      removed += before - inbox[key].length;
    }
    return removed;
  }

  pollAfterSeq(recipient: string, afterSeq = 0): BusMessage[] {
    return this.peek(recipient).filter(message => (message.seq ?? 0) > afterSeq);
  }

  /**
   * 获取两个 Agent 之间的消息
   */
  getConversation(agentA: string, agentB: string, limit = DEFAULT_HISTORY_LIMIT): BusMessage[] {
    return this.messageHistory
      .filter(
        m =>
          (m.from === agentA && m.to === agentB) ||
          (m.from === agentB && m.to === agentA)
      )
      .slice(-limit);
  }

  /**
   * 清空历史
   */
  clearHistory(): void {
    this.messageHistory = [];
    this.historyBytes = 0;
  }

  /**
   * 获取各优先级的待处理消息数量
   */
  getPendingPriorityCounts(recipient: string): PriorityCounts {
    this.register(recipient);
    const inbox = this.inboxes.get(recipient)!;
    return {
      p0: inbox.p0.length,
      p1: inbox.p1.length,
      p2: inbox.p2.length,
      p3: inbox.p3.length,
    };
  }

  /**
   * 发送消息并等待接收方 ACK 确认
   * @returns { delivered: true, ackTime: number } 如果收到 ACK
   * @returns { delivered: false } 如果超时未收到 ACK
   */
  async sendWithAck<K extends BusMessageType>(
    from: string,
    to: string,
    type: K,
    payload: BusMessagePayloadMap[K],
    timeout = 10000,
  ): Promise<{ delivered: boolean; ackTime?: number }> {
    const messageId = this.send(from, to, type, payload);
    const start = Date.now();

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingAcks.delete(messageId);
        resolve({ delivered: false });
      }, timeout);

      this.pendingAcks.set(messageId, {
        resolve: (delivered: boolean) => {
          clearTimeout(timeoutId);
          this.pendingAcks.delete(messageId);
          resolve({ delivered, ackTime: Date.now() - start });
        },
        timeoutId,
        deadline: Date.now() + timeout * ACK_REAP_FACTOR,
      });
    });
  }

  /**
   * 接收方调用：确认收到消息
   */
  acknowledge(recipient: string, messageId: string): void {
    const pending = this.pendingAcks.get(messageId);
    if (pending) {
      pending.resolve(true);
    }
    // recipient 仅供调用上下文使用；原 message:ack 事件已无消费者，故不再 emit。
    void recipient;
  }

  /**
   * 获取等待消息（阻塞直到收到消息或超时）
   * @param recipient 接收者 ID
   * @param timeout 超时时间（毫秒）
   */
  async waitForMessage(
    recipient: string,
    timeout = 30000
  ): Promise<BusMessage | null> {
    this.register(recipient);

    // ★ 先检查是否有已有的消息（避免 Leader 错过刚投递的消息）
    const existing = this.getFlattenedInbox(recipient)[0];
    if (existing) return existing;

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          this.waiters.get(recipient)?.delete(waiter);
        }
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);

      const waiter = (message: BusMessage | null) => {
        cleanup();
        resolve(message);
      };

      this.waiters.get(recipient)!.add(waiter);
    });
  }

  /**
   * 等待 P0 关键消息 — 收到 P0 消息时立即 resolve
   * 用于 Leader 主循环的即时唤醒
   * @param recipient 接收者 ID
   * @param timeout 超时时间（毫秒）
   */
  async waitForCriticalMessage(
    recipient: string,
    timeout = 30000
  ): Promise<BusMessage | null> {
    this.register(recipient);

    // 立即检查 P0 邮箱
    const inbox = this.inboxes.get(recipient)!;
    if (inbox.p0.length > 0) {
      return this.orderBucketMessages(inbox.p0)[0] || null;
    }

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          this.p0Waiters.get(recipient)?.delete(waiter);
        }
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);

      const waiter = (message: BusMessage) => {
        cleanup();
        resolve(message);
      };

      this.p0Waiters.get(recipient)!.add(waiter);
    });
  }

  /**
   * 等待特定类型的消息
   */
  async waitForMessageType(
    recipient: string,
    type: string,
    timeout = 30000
  ): Promise<BusMessage | null> {
    this.register(recipient);
    const flatInbox = this.getFlattenedInbox(recipient);
    const existing = flatInbox.find((message) => message.type === type);
    if (existing) {
      return existing;
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeout);

      const unsubscribe = this.subscribe(recipient, (message) => {
        if (message.type === type) {
          clearTimeout(timeoutId);
          unsubscribe();
          resolve(message);
        }
      });
    });
  }

  /**
   * 获取订阅者数量
   */
  getSubscriberCount(recipient?: string): number {
    if (recipient) {
      return this.handlers.get(recipient)?.size || 0;
    }
    let total = 0;
    for (const handlers of this.handlers.values()) {
      total += handlers.size;
    }
    return total;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  cleanupStaleInboxesForTest(): void {
    this.cleanupStaleInboxes();
  }

  setInboxLastAccessTimeForTest(recipient: string, lastAccessTime: number): void {
    this.register(recipient);
    this.inboxes.get(recipient)!.lastAccessTime = lastAccessTime;
  }

  /**
   * 清理过大的 inbox 以及 dead inbox（超过 STALE_INBOX_MS 未被 poll）。
   * 同时清理超期的 pendingAcks 条目。
   */
  private cleanupStaleInboxes(): void {
    const now = Date.now();
    const threshold = runtimeConfig.message_bus.critical_threshold;

    // --- Fix 1: Dead inbox 自动清理 ---
    // 渐进式：每轮最多清理 50 个 dead inbox，避免 CPU spike
    let deadCleaned = 0;
    const maxDeadPerRound = 50;
    for (const [name, inbox] of this.inboxes) {
      if (deadCleaned >= maxDeadPerRound) break;
      const age = now - inbox.lastAccessTime;
      // #49: 真正死亡的收件人(idle > DEAD_INBOX_MS 且无 waiter)P0/P1 也无消费者,整箱删除,
      // 防止死收件人 P0/P1 无限累积。STALE_MS(5min)内仍保留 P0/P1 兼容短暂卡顿后恢复。
      if (age > DEAD_INBOX_MS && (this.waiters.get(name)?.size ?? 0) === 0 && (this.p0Waiters.get(name)?.size ?? 0) === 0) {
        const deadTotal = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
        this.inboxes.delete(name);
        this.waiters.delete(name);
        this.p0Waiters.delete(name);
        deadCleaned++;
        if (deadTotal > 0) {
          coreLogger.warn(`[MessageBus] Reaped DEAD inbox for ${name}: ${deadTotal} messages discarded incl P0/P1 (idle ${Math.round(age / 1000)}s > DEAD_INBOX_MS, recipient truly dead, #49)`);
        }
        continue;
      }
      if (age > STALE_INBOX_MS) {
        const total = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
        // Only delete truly dead inboxes (not actively waited on)
        const hasWaiters = (this.waiters.get(name)?.size ?? 0) > 0 || (this.p0Waiters.get(name)?.size ?? 0) > 0;
        if (!hasWaiters) {
          const p0 = inbox.p0.length;
          const p1 = inbox.p1.length;
          if (p0 + p1 > 0) {
            const clearedP2 = inbox.p2.length;
            const clearedP3 = inbox.p3.length;
            inbox.p2 = [];
            inbox.p3 = [];
            deadCleaned++;
            coreLogger.warn(
              `[MessageBus] Preserved stale high-priority inbox for ${name}: P0=${p0} P1=${p1}, cleared P2=${clearedP2} P3=${clearedP3} (idle ${Math.round(age / 1000)}s)`,
            );
            this.emitter.emit('message:bus:stale_p0p1_preserved', {
              recipient: name,
              p0,
              p1,
              clearedP2,
              clearedP3,
              ageMs: age,
              timestamp: now,
            });
            continue;
          }
          this.inboxes.delete(name);
          this.waiters.delete(name);
          this.p0Waiters.delete(name);
          deadCleaned++;
          if (total > 0) {
            coreLogger.warn(
              `[MessageBus] Reaped dead inbox for ${name}: ${total} unread messages discarded (idle ${Math.round(age / 1000)}s)`,
            );
          }
          continue;
        }
      }

      // --- Original oversized-inbox cleanup ---
      const total = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
      if (total > threshold * 2) {
        const keep = threshold;
        // P0 和 P1 永不丢弃
        const p0p1Count = inbox.p0.length + inbox.p1.length;
        const budgetForLow = Math.max(0, keep - p0p1Count);
        // P2 优先保留，P3 最后丢弃
        if (inbox.p2.length + inbox.p3.length > budgetForLow) {
          const p3Keep = Math.max(0, budgetForLow - inbox.p2.length);
          inbox.p3 = inbox.p3.slice(-p3Keep);
          if (inbox.p2.length > budgetForLow) {
            inbox.p2 = inbox.p2.slice(-budgetForLow);
          }
        }
        const afterTotal = inbox.p0.length + inbox.p1.length + inbox.p2.length + inbox.p3.length;
        coreLogger.warn(
          `[MessageBus] Force-truncated inbox for ${name}: ${total} → ${afterTotal} messages`,
        );
      }
    }

    // --- Fix 2: pendingAcks 超时兜底 ---
    // 渐进式：每轮最多清理 100 个
    let acksReaped = 0;
    const maxAcksPerRound = 100;
    for (const [messageId, entry] of this.pendingAcks) {
      if (acksReaped >= maxAcksPerRound) break;
      if (now > entry.deadline) {
        clearTimeout(entry.timeoutId);
        this.pendingAcks.delete(messageId);
        // Resolve as undelivered so the caller's Promise doesn't hang forever
        entry.resolve(false);
        acksReaped++;
      }
    }
    if (acksReaped > 0) {
      coreLogger.warn(`[MessageBus] Reaped ${acksReaped} stale pendingAcks entries`);
    }
  }
}

let defaultMessageBus: MessageBus | undefined;

export function createMessageBus(
  maxHistorySize?: number,
  emitter?: EventEmitter,
  maxHistoryBytes?: number,
  transport?: Transport,
): MessageBus {
  return new MessageBus(maxHistorySize, emitter, maxHistoryBytes, transport);
}

export function getMessageBus(): MessageBus {
  defaultMessageBus ??= createMessageBus();
  return defaultMessageBus;
}

export default MessageBus;
