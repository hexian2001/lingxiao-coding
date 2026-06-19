import { createEnvelope, type Transport, type TransportEnvelope } from './Transport.js';

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(event: 'open' | 'message' | 'close' | 'error', handler: (event: Event | MessageEvent | CloseEvent) => void): void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;

export interface WebSocketTransportOptions {
  heartbeatInterval?: number;
  staleAfterMs?: number;
  reconnect?: boolean;
  websocketFactory?: WebSocketCtor;
}

export class WebSocketTransport implements Transport {
  readonly type = 'websocket' as const;
  private socket: WebSocketLike | null = null;
  private handler: ((envelope: TransportEnvelope) => void) | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private lastSeen = 0;
  private reconnectDelayMs = 1000;
  private readonly heartbeatInterval: number;
  private readonly staleAfterMs: number;
  private readonly reconnect: boolean;
  private readonly websocketFactory: WebSocketCtor;

  constructor(private readonly endpoint: string, opts: WebSocketTransportOptions = {}) {
    this.heartbeatInterval = opts.heartbeatInterval ?? 30_000;
    this.staleAfterMs = opts.staleAfterMs ?? 60_000;
    this.reconnect = opts.reconnect ?? false;
    this.websocketFactory = opts.websocketFactory ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  }

  async connect(): Promise<void> {
    if (!this.websocketFactory) {
      throw new Error('WebSocket is not available in this runtime');
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new this.websocketFactory(this.endpoint);
      this.socket = socket;
      const onOpen = () => {
        this.connected = true;
        this.lastSeen = Date.now();
        this.reconnectDelayMs = 1000;
        this.startHeartbeat();
        resolve();
      };
      const onMessage = (event: Event | MessageEvent) => {
        this.lastSeen = Date.now();
        const data = 'data' in event ? event.data : undefined;
        this.receive(data);
      };
      const onClose = () => {
        this.connected = false;
        this.stopHeartbeat();
        this.scheduleReconnect();
      };
      const onError = () => {
        if (!this.connected) reject(new Error(`WebSocket connection failed: ${this.endpoint}`));
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
    });
  }

  send(envelope: TransportEnvelope): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new Error(`WebSocket transport is not connected: ${this.endpoint}`);
    }
    this.socket.send(JSON.stringify(envelope));
  }

  onMessage(handler: (envelope: TransportEnvelope) => void): void {
    this.handler = handler;
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connected = false;
    this.socket?.close();
    this.socket = null;
  }

  isAlive(): boolean {
    if (!this.connected || !this.socket || this.socket.readyState !== WS_OPEN) return false;
    return Date.now() - this.lastSeen <= this.staleAfterMs;
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    try {
      const parsed = JSON.parse(data) as TransportEnvelope;
      if (parsed.version !== 1 || typeof parsed.type !== 'string') return;
      this.handler?.(parsed);
    } catch {
      // Ignore malformed remote frames.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WS_OPEN) return;
      this.send(createEnvelope('heartbeat', { endpoint: this.endpoint }));
    }, this.heartbeatInterval);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (!this.reconnect) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }
}
