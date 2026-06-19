export type ActiveSessionSource = 'startup' | 'tui' | 'web' | 'daemon' | 'command' | 'server';

export interface ActiveSessionSnapshot {
  sessionId: string | undefined;
  source: ActiveSessionSource;
  updatedAt: number;
}

/**
 * Single in-process owner for the "currently focused session".
 *
 * Web, TUI, and backend routes must not each infer their own current session from
 * recent activity. They read/write this coordinator instead, so display focus and
 * submit routing stay attached to the same session id.
 */
export class ActiveSessionCoordinator {
  private sessionId: string | undefined;
  private source: ActiveSessionSource;
  private updatedAt: number;

  constructor(initialSessionId?: string, source: ActiveSessionSource = 'startup') {
    this.sessionId = initialSessionId || undefined;
    this.source = source;
    this.updatedAt = Date.now();
  }

  getActiveSessionId(): string | undefined {
    return this.sessionId;
  }

  getSnapshot(): ActiveSessionSnapshot {
    return {
      sessionId: this.sessionId,
      source: this.source,
      updatedAt: this.updatedAt,
    };
  }

  setActiveSessionId(sessionId: string | undefined, source: ActiveSessionSource): void {
    const normalized = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : undefined;
    this.sessionId = normalized;
    this.source = source;
    this.updatedAt = Date.now();
  }
}
