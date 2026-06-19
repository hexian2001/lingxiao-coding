export interface CleanupSessionLike {
  sessionId: string;
  _roundCompleteUnsub?: () => void;
  _completedUnsub?: () => void;
  _disposeTeamCommunication?: () => void;
  pool?: { destroy?: () => void };
}

export class SessionCleanup {
  release(session: CleanupSessionLike): void {
    session._roundCompleteUnsub?.();
    session._completedUnsub?.();
    session._disposeTeamCommunication?.();
    session.pool?.destroy?.();
  }

  cleanupIdle<T extends CleanupSessionLike>(
    sessions: Map<string, T>,
    lastActivity: Map<string, number>,
    ttlMs: number,
    now = Date.now(),
  ): string[] {
    const released: string[] = [];
    for (const [sessionId, session] of sessions) {
      const lastSeen = lastActivity.get(sessionId) ?? now;
      if (now - lastSeen < ttlMs) {
        continue;
      }
      this.release(session);
      sessions.delete(sessionId);
      lastActivity.delete(sessionId);
      released.push(sessionId);
    }
    return released;
  }
}

export default SessionCleanup;
