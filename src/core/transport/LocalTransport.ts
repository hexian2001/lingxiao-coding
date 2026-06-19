import type { Transport, TransportEnvelope } from './Transport.js';

export class LocalTransport implements Transport {
  readonly type = 'local' as const;
  private handler: ((envelope: TransportEnvelope) => void) | null = null;

  send(envelope: TransportEnvelope): void {
    this.handler?.(envelope);
  }

  onMessage(handler: (envelope: TransportEnvelope) => void): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    // Local transport is always available.
  }

  async disconnect(): Promise<void> {
    // Local transport has no resources to release.
  }

  isAlive(): boolean {
    return true;
  }
}
