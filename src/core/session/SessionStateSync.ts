export interface SessionStateStore {
  getSessionState?: (sessionId: string, key: string) => unknown;
  setSessionState?: (sessionId: string, key: string, value: unknown) => void;
  updateSessionState?: (sessionId: string, key: string, updater: (current: unknown) => unknown) => void;
}

export class SessionStateSync {
  private readonly store: SessionStateStore;

  constructor(store: SessionStateStore) {
    this.store = store;
  }

  load<T>(sessionId: string, key: string, fallback: T): T {
    const value = this.store.getSessionState?.(sessionId, key);
    return (value ?? fallback) as T;
  }

  save(sessionId: string, key: string, value: unknown): void {
    this.store.setSessionState?.(sessionId, key, value);
  }

  update<T>(sessionId: string, key: string, updater: (current: T | null | undefined) => T): void {
    if (this.store.updateSessionState) {
      this.store.updateSessionState(sessionId, key, (current) => updater(current as T | null | undefined));
      return;
    }
    const next = updater(this.store.getSessionState?.(sessionId, key) as T | null | undefined);
    this.save(sessionId, key, next);
  }
}

export default SessionStateSync;
