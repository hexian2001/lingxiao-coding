// ─── Token statistics & compression methods for sessionStore ───

import { getServerToken } from '../api/headers';
import type { SessionState, TokenUsage } from './sessionStoreTypes.ts';

type TokenUsageRow = Partial<TokenUsage>;

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Build the token/compression portion of the session store actions. */
export function createTokenActions(
  get: () => SessionState,
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
) {
  return {
    fetchTokenUsage: async () => {
      const sid = get().sessionId;
      if (!sid) return;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/tokens`, {
          headers: { 'x-lingxiao-token': getServerToken() },
        });
        if (res.ok) {
          const data = await res.json();
          const summary = (Array.isArray(data) ? data : []).reduce(
            (acc: TokenUsage, item: TokenUsageRow) => ({
              prompt: acc.prompt + tokenNumber(item.prompt),
              completion: acc.completion + tokenNumber(item.completion),
              total: acc.total + tokenNumber(item.total),
            }),
            { prompt: 0, completion: 0, total: 0 }
          );
          // Only overwrite in-memory SSE-accumulated data if DB has more info.
          // This prevents a race where fetchTokenUsage() resolves after SSE events
          // already populated tokenUsage, causing the UI to flash back to 0.
          const current = get().tokenUsage;
          if (summary.total >= current.total) {
            set({ tokenUsage: summary } as Partial<SessionState>);
          }
        }
      } catch (e) {
        console.warn('[fetchTokenUsage] failed:', e);
      }
    },

    compressContext: async () => {
      const sid = get().sessionId;
      if (!sid) return null;
      try {
        const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sid)}/compress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-lingxiao-token': getServerToken() },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          set({ lastCompressedAt: Date.now() } as Partial<SessionState>);
          get().fetchTokenUsage();
          return data;
        }
        return { error: String(data?.error || `HTTP ${res.status}`) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn('[compressContext] failed:', e);
        return { error: message };
      }
    },
  };
}
