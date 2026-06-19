import { randomUUID } from 'node:crypto';
import { globalTracer } from '../Tracing.js';

export interface TransportEnvelope {
  version: 1;
  type:
    | 'task_dispatch'
    | 'task_complete'
    | 'task_failed'
    | 'heartbeat'
    | 'bus_message'
    | 'worker_register'
    | 'worker_deregister'
    | 'ack';
  id: string;
  traceId?: string;
  timestamp: number;
  payload: unknown;
}

export interface Transport {
  readonly type: 'local' | 'websocket';
  send(envelope: TransportEnvelope): void;
  onMessage(handler: (envelope: TransportEnvelope) => void): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAlive(): boolean;
}

export function createEnvelope(type: TransportEnvelope['type'], payload: unknown): TransportEnvelope {
  const active = globalTracer.currentSpan();
  const envelope: TransportEnvelope = {
    version: 1,
    type,
    id: randomUUID(),
    timestamp: Date.now(),
    payload,
  };
  if (active?.context.traceId) {
    envelope.traceId = active.context.traceId;
  }
  return envelope;
}
