import { getServerToken, tryRecoverToken } from './headers';

export interface AcpConnection {
  connectionId: string;
  sessionToken: string;
  sessionId: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ConnectionStateEvent {
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  sessionId: string | null;
  isConnected: boolean;
  attempts: number;
  reconnectCycle: number;
  reason?: string;
}

export interface AcpEventMap {
  'connection/state': ConnectionStateEvent;
  'connection/failed': { attempts: number; reason: string };
  'session/update': { method: 'session/update'; params: { update: unknown; sessionId?: unknown; [key: string]: unknown }; [key: string]: unknown };
  '*': unknown;
}

type AcpEventHandler<K extends keyof AcpEventMap> = (data: AcpEventMap[K]) => void;

let rpcId = 0;

/**
 * ACP Client — 连接凌霄后端 SSE + JSON-RPC
 * Uses fetch-based SSE for custom header support
 */
export class AcpClient {
  private connection: AcpConnection | null = null;
  private abortController: AbortController | null = null;
  private listeners = new Map<keyof AcpEventMap | string, Set<(data: unknown) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectCycle = 0;
  private manuallyDisconnected = false;
  private sseActive = false;
  /** 最近一次收到 SSE 数据（含 ping）的时间戳。用于 visibilitychange 时检测 stale 连接。 */
  private lastSseEventAt = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveParseErrors = 0;
  private handshakeInProgress = false;
  private handshakeReconnectCount = 0;
  private visibilityHandler: (() => void) | null = null;
  /**
   * emitConnectionState 去重 (2026-05-28)：
   * processChunk 每次 SSE 帧解析成功后都会调一次 emitConnectionState('connected')。
   * 没有去重时下游订阅会被持续触发，长跑积累后造成主线程负载升高、页面卡顿；
   * 表现之一是 web chat agent 面板"时间久了不更新"。
   * 这里在底层做一次状态去重；上层 sessionStore 的 lastSseState 也仍保留，
   * 双层兜底无副作用。
   */
  private lastEmittedConnectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | null = null;

  private static readonly RECONNECT_BASE_MS = 3000;
  private static readonly RECONNECT_MAX_DELAY_MS = 60_000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 50;
  private static readonly MAX_RECONNECT_HANDSHAKES = 10;
  /**
   * 未按 \n 切分的 SSE 缓冲上限（字符）。畸形流或单行巨型帧会让 buffer 无限增长,
   * 截断到最近 1MB 避免单条失控帧吃光内存。正常 SSE 每帧都有 \n,不会触及该上限。
   */
  private static readonly MAX_SSE_BUFFER_CHARS = 1_000_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 60_000;
  private static readonly MAX_PARSE_ERRORS = 5;

  /**
   * 连接到凌霄后端
   */
  async connect(sessionId: string): Promise<AcpConnection> {
    this.manuallyDisconnected = false;
    this.clearReconnectTimer();
    this.abortCurrentSse();

    // 1. Handshake
    const res = await fetch('/api/v1/acp/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-lingxiao-token': getServerToken(),
      },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) {
      throw new Error(`ACP connect failed: ${res.status}`);
    }

    const data = await res.json();
    this.connection = {
      connectionId: data.connectionId,
      sessionToken: data.sessionToken,
      sessionId,
    };

    // 2. Start SSE via fetch
    this.startSse();

    // 3. 监听 visibilitychange，后台 tab 回到前台时重新握手同步状态
    this.attachVisibilityListener();

    this.reconnectAttempts = 0;
    this.reconnectCycle = 0;
    return this.connection;
  }

  private async reconnectHandshake(options?: { immediate?: boolean }) {
    if (!this.connection || this.manuallyDisconnected || this.handshakeInProgress) return;

    // No server token — try to recover from localhost-only endpoint first
    if (!getServerToken()) {
      const recovered = await tryRecoverToken();
      if (!recovered) {
        this.sseActive = false;
        this.emitConnectionState('disconnected', { reason: 'no_token' });
        return;
      }
    }

    this.handshakeReconnectCount++;

    // Stop after too many reconnect cycles — avoid infinite loop
    if (this.handshakeReconnectCount > AcpClient.MAX_RECONNECT_HANDSHAKES) {
      this.sseActive = false;
      this.emitConnectionState('disconnected', { reason: 'max_reconnect_cycles_exceeded' });
      if (this.listeners.has('connection/failed')) {
        for (const handler of this.listeners.get('connection/failed')!) {
          handler({ attempts: this.handshakeReconnectCount, reason: 'max_reconnect_cycles_exceeded' });
        }
      }
      return;
    }

    const sessionId = this.connection.sessionId;
    this.handshakeInProgress = true;

    // immediate=true 时跳过退避延迟（visibilitychange 触发的确定性 stale 重连）
    const delay = options?.immediate ? 0 : Math.min(
      AcpClient.RECONNECT_BASE_MS * Math.pow(2, Math.min(this.handshakeReconnectCount - 1, 5)),
      AcpClient.RECONNECT_MAX_DELAY_MS,
    );

    this.emitConnectionState('reconnecting', { delayMs: delay, attempt: this.handshakeReconnectCount, cycle: this.reconnectCycle });

    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    if (this.manuallyDisconnected) {
      this.handshakeInProgress = false;
      return;
    }

    try {
      await this.connect(sessionId);
      // connect() succeeded and called startSse() (fire-and-forget).
      // If SSE fails again, reconnectHandshake() will be called again with backoff.
    } catch (err) {
      console.warn('[AcpClient] ACP reconnect handshake failed:', err instanceof Error ? err.message : String(err));
      this.sseActive = false;
      this.emitConnectionState('disconnected', { reason: 'handshake_failed' });
      // Schedule next attempt after backoff
      setTimeout(() => { void this.reconnectHandshake(); }, 0);
    } finally {
      this.handshakeInProgress = false;
    }
  }

  /**
   * 启动 fetch-based SSE 连接（支持自定义 headers）
   */
  private startSse() {
    if (!this.connection || this.manuallyDisconnected) return;

    this.abortCurrentSse();
    this.abortController = new AbortController();
    const controller = this.abortController;
    const connectionId = this.connection.connectionId;

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      'x-lingxiao-token': getServerToken(),
      'acp-connection-id': this.connection.connectionId,
      'acp-session-token': this.connection.sessionToken,
    };

    this.sseActive = true;
    this.lastSseEventAt = Date.now();
    this.emitConnectionState('connecting');

    fetch('/api/v1/acp', { headers, signal: controller.signal })
      .then(response => {
        if (this.manuallyDisconnected || controller.signal.aborted || this.connection?.connectionId !== connectionId) return;
        if (!response.ok || !response.body) {
          this.sseActive = false;
          if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
            // 401 可能是 token 丢失，先尝试恢复再重连
            if (response.status === 401 && !getServerToken()) {
              void tryRecoverToken().then(recovered => {
                if (recovered) {
                  void this.reconnectHandshake();
                } else {
                  this.emitConnectionState('disconnected', { reason: 'no_token' });
                }
              });
            } else {
              void this.reconnectHandshake();
            }
          } else {
            this.scheduleReconnect();
          }
          return;
        }

        this.emitConnectionState('connected');
        this.handshakeReconnectCount = 0;
        this.startHeartbeat();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processChunk = (): Promise<void> => {
          return reader.read().then(({ done, value }) => {
            if (this.manuallyDisconnected || controller.signal.aborted || this.connection?.connectionId !== connectionId) return;
            if (done) {
              this.sseActive = false;
              this.scheduleReconnect();
              return;
            }
            // 更新最近 SSE 数据时间戳，用于 visibilitychange stale 检测
            this.lastSseEventAt = Date.now();
            buffer += decoder.decode(value, { stream: true });
            // Bound the buffer so a single runaway frame (no newline) cannot grow it
            // without limit; keep the most recent MAX_SSE_BUFFER_CHARS chars.
            if (buffer.length > AcpClient.MAX_SSE_BUFFER_CHARS) {
              buffer = buffer.slice(-AcpClient.MAX_SSE_BUFFER_CHARS);
            }

            // Parse SSE events from buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            const eventDataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                eventDataLines.push(line.slice(6));
              } else if (line.startsWith('event: ')) {
                // Named event — we handle all via data parsing
              } else if (line.startsWith(':')) {
                // SSE comment (e.g. `:ping` heartbeat from server) — reset heartbeat timer
                this.resetHeartbeat();
              } else if (line === '' && eventDataLines.length > 0) {
                // Empty line = end of event, dispatch it
                try {
                  const parsed = JSON.parse(eventDataLines.join('\n').trim());
                  const method = parsed.method;
                  if (import.meta.env.DEV) console.debug('[ACP SSE]', method, parsed);
                  if (method && this.listeners.has(method)) {
                    for (const handler of this.listeners.get(method)!) {
                      handler(parsed);
                    }
                  }
                  if (this.listeners.has('*')) {
                    for (const handler of this.listeners.get('*')!) {
                      handler(parsed);
                    }
                  }
                  // Reset reconnect attempts on valid data
                  this.reconnectAttempts = 0;
                  this.reconnectCycle = 0;
                  this.consecutiveParseErrors = 0;
                  this.resetHeartbeat();
                  this.emitConnectionState('connected');
                } catch (err) {
                  this.consecutiveParseErrors++;
                  console.debug('[AcpClient] SSE parse error:', err, `(${this.consecutiveParseErrors}/${AcpClient.MAX_PARSE_ERRORS})`);
                  if (this.consecutiveParseErrors >= AcpClient.MAX_PARSE_ERRORS) {
                    console.warn('[AcpClient] Too many consecutive parse errors, triggering reconnect');
                    this.consecutiveParseErrors = 0;
                    this.abortCurrentSse();
                    this.scheduleReconnect();
                    return;
                  }
                }
                eventDataLines.length = 0;
              }
            }

            return processChunk();
          });
        };

        processChunk().catch((err) => {
          if (this.manuallyDisconnected || controller.signal.aborted || this.connection?.connectionId !== connectionId) return;
          console.warn('[AcpClient] SSE stream error:', err instanceof Error ? err.message : String(err));
          this.sseActive = false;
          this.scheduleReconnect();
        });
      })
      .catch((err) => {
        if (this.manuallyDisconnected || controller.signal.aborted || this.connection?.connectionId !== connectionId) return;
        console.warn('[AcpClient] SSE connection error:', err instanceof Error ? err.message : String(err));
        this.sseActive = false;
        this.scheduleReconnect();
      });
  }

  /**
   * 发送 JSON-RPC 请求
   */
  async sendJsonRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connection) {
      throw new Error('Not connected');
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++rpcId,
      method,
      params,
    };

    const res = await fetch('/api/v1/acp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-lingxiao-token': getServerToken(),
        'acp-connection-id': this.connection.connectionId,
        'acp-session-token': this.connection.sessionToken,
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`JSON-RPC failed: ${res.status}`);
    }

    const response = await res.json();
    if (response.error) {
      throw new Error(response.error.message || 'JSON-RPC error');
    }
    return response.result;
  }

  async setAutonomyMode(
    mode: 'review_first' | 'balanced' | 'autonomous' | 'full_auto',
    options?: { lifecyclePhase?: 'bootstrap' | 'active' | 'recovery' | 'stable'; reason?: string; updatedBy?: 'web' | 'tui' | 'leader' | 'runtime_policy' },
  ): Promise<unknown> {
    return this.sendJsonRpc('session/set_autonomy_mode', {
      mode,
      ...(options?.lifecyclePhase ? { lifecycle_phase: options.lifecyclePhase } : {}),
      ...(options?.reason ? { reason: options.reason } : {}),
      updated_by: options?.updatedBy ?? 'web',
    });
  }

  /**
   * 订阅 SSE 事件
   */
  on<K extends keyof AcpEventMap>(method: K, handler: AcpEventHandler<K>): () => void;
  on(method: string, handler: (data: unknown) => void): () => void;
  on(method: string, handler: (data: unknown) => void): () => void {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method)!.add(handler);
    return () => {
      const handlers = this.listeners.get(method);
      handlers?.delete(handler);
      if (handlers && handlers.size === 0) {
        this.listeners.delete(method);
      }
    };
  }

  /**
   * 断开连接
   */
  async disconnect() {
    this.manuallyDisconnected = true;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    this.detachVisibilityListener();
    this.abortCurrentSse();

    if (this.connection) {
      try {
        await fetch('/api/v1/acp', {
          method: 'DELETE',
          headers: {
            'x-lingxiao-token': getServerToken(),
            'acp-connection-id': this.connection.connectionId,
            'acp-session-token': this.connection.sessionToken,
          },
        });
      } catch (err) {
        console.warn('[AcpClient] ACP disconnect request failed:', err instanceof Error ? err.message : String(err));
      }
    }
    this.connection = null;
    this.reconnectAttempts = 0;
    this.reconnectCycle = 0;
    this.handshakeReconnectCount = 0;
    this.emitConnectionState('disconnected');
    // NOTE: Do NOT clear listeners — they are registered once and persist across reconnects.
    // Clearing them would cause SSE events to be silently dropped after reconnect.
  }

  /**
   * 自动重连（指数退避 + 最大尝试次数）
   */
  private scheduleReconnect() {
    if (!this.connection || this.manuallyDisconnected) return;
    if (this.reconnectTimer) return;

    // Stop reusing stale SSE credentials after max attempts; try a fresh ACP handshake.
    if (this.reconnectAttempts >= AcpClient.MAX_RECONNECT_ATTEMPTS) {
      this.sseActive = false;
      if (this.listeners.has('connection/failed')) {
        for (const handler of this.listeners.get('connection/failed')!) {
          handler({ attempts: this.reconnectAttempts, reason: 'max_retries_exceeded' });
        }
      }
      // P4: Emit resync failed event for UI alert
      if (this.listeners.has('session/update')) {
        for (const handler of this.listeners.get('session/update')!) {
          (handler as (data: unknown) => void)({
            method: 'session/update',
            params: {
              update: {
                type: 'session:resync_failed',
                payload: { reason: 'max_retries_exceeded', attempts: this.reconnectAttempts },
              },
              sessionId: this.connection?.sessionId,
            },
          });
        }
      }
      void this.reconnectHandshake();
      return;
    }

    this.sseActive = false;
    // Exponential backoff: base * 2^attempt, capped at maxDelay
    const delay = Math.min(
      AcpClient.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      AcpClient.RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts++;
    this.emitConnectionState('reconnecting', { delayMs: delay, attempt: this.reconnectAttempts, cycle: this.reconnectCycle });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.connection) {
        this.startSse();
      }
    }, delay);
  }

  /**
   * Reset reconnect attempts (call when SSE receives valid data)
   */
  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
    this.reconnectCycle = 0;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      if (!this.sseActive || this.manuallyDisconnected) return;
      console.warn('[AcpClient] No SSE event received in 60s, triggering reconnect');
      this.abortCurrentSse();
      this.scheduleReconnect();
    }, AcpClient.HEARTBEAT_TIMEOUT_MS);
  }

  private resetHeartbeat() {
    if (this.heartbeatTimer) {
      this.startHeartbeat();
    }
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private abortCurrentSse() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.sseActive = false;
    this.clearHeartbeat();
  }

  /**
   * 监听 visibilitychange，后台 tab 回到前台时重新握手
   */
  private attachVisibilityListener() {
    this.detachVisibilityListener();
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this.connection && !this.manuallyDisconnected) {
        // 后台 tab 被浏览器节流时 setTimeout/watchdog 可能不触发，SSE 流被静默杀死
        // 但 sseActive 仍为 true。回到前台时检查是否 stale（超过 45s 无数据，
        // 服务端 ping 周期 30s），如果是则主动重连；否则按原逻辑仅在 sseActive=false 时重连。
        const now = Date.now();
        const isStale = this.sseActive && this.lastSseEventAt > 0 && (now - this.lastSseEventAt) > 45_000;
        if (!this.sseActive || isStale) {
          if (isStale) {
            console.warn(`[AcpClient] SSE stale detected on visibilitychange: last event ${Math.round((now - this.lastSseEventAt) / 1000)}s ago, forcing reconnect`);
            this.abortCurrentSse();
          }
          // 确定性 stale 重连：重置计数器 + 立即连接，不走指数退避
          this.handshakeReconnectCount = 0;
          this.reconnectHandshake({ immediate: true });
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private detachVisibilityListener() {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private emitConnectionState(state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected', extra?: Record<string, unknown>) {
    // 去重：connected/connecting/disconnected 这种"裸"状态如果与上次相同，跳过分发。
    // reconnecting 通常携带 attempt/delayMs 变化的 extra，每次都分发以反馈进度。
    if (!extra && this.lastEmittedConnectionState === state) {
      return;
    }
    this.lastEmittedConnectionState = state;
    const payload = {
      state,
      sessionId: this.connection?.sessionId ?? null,
      connectionId: this.connection?.connectionId ?? null,
      sseActive: this.sseActive,
      reconnectAttempts: this.reconnectAttempts,
      reconnectCycle: this.reconnectCycle,
      ...(extra || {}),
    };
    if (this.listeners.has('connection/state')) {
      for (const handler of this.listeners.get('connection/state')!) handler(payload);
    }
    if (this.listeners.has('*')) {
      for (const handler of this.listeners.get('*')!) handler({ method: 'connection/state', params: payload });
    }
  }

  get isConnected() {
    return this.connection !== null && this.sseActive;
  }

  get sessionId() {
    return this.connection?.sessionId;
  }

  getSessionId() {
    return this.connection?.sessionId;
  }
}

// Singleton
export const acpClient = new AcpClient();
