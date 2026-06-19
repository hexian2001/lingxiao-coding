import { create } from 'zustand';
import { browserClient, type BrowserElementSelection, type BrowserHealth, type BrowserSessionSummary } from '../api/BrowserClient';

type BrowserIntent = 'fix' | 'review' | 'style' | 'explain';

interface BrowserState {
  sessions: BrowserSessionSummary[];
  activeSessionId: string | null;
  session: BrowserSessionSummary | null;
  screenshotUrl: string | null;
  selection: BrowserElementSelection | null;
  isOpen: boolean;
  isInspecting: boolean;
  isLoading: boolean;
  error: string | null;
  health: BrowserHealth | null;
  healthError: string | null;
  intent: BrowserIntent;
  open: () => void;
  close: () => void;
  loadHealth: (launch?: boolean) => Promise<void>;
  loadSessions: () => Promise<void>;
  newSession: (url?: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  setInspecting: (enabled: boolean) => void;
  setIntent: (intent: BrowserIntent) => void;
  clearSelection: () => void;
  openUrl: (url: string) => Promise<void>;
  refreshScreenshot: () => void;
  inspectAt: (x: number, y: number) => Promise<void>;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  session: null,
  screenshotUrl: null,
  selection: null,
  isOpen: false,
  isInspecting: false,
  isLoading: false,
  error: null,
  health: null,
  healthError: null,
  intent: 'fix',

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, isInspecting: false }),
  loadHealth: async (launch = false) => {
    try {
      const health = await browserClient.health(launch);
      set({ health, healthError: null });
    } catch (error) {
      set({ healthError: error instanceof Error ? error.message : String(error) });
    }
  },
  loadSessions: async () => {
    set({ error: null });
    try {
      const sessions = await browserClient.listSessions();
      const activeSessionId = get().activeSessionId && sessions.some((item) => item.id === get().activeSessionId)
        ? get().activeSessionId
        : sessions[0]?.id || null;
      const session = sessions.find((item) => item.id === activeSessionId) || null;
      set({
        sessions,
        activeSessionId,
        session,
        screenshotUrl: session ? browserClient.screenshotUrl(session.id) : null,
        selection: session?.id === get().selection?.browserSessionId ? get().selection : null,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  newSession: async (url) => {
    set({ isOpen: true, isLoading: true, error: null, selection: null });
    try {
      const session = await browserClient.createSession(url);
      const sessions = [session, ...get().sessions.filter((item) => item.id !== session.id)];
      set({
        sessions,
        activeSessionId: session.id,
        session,
        screenshotUrl: browserClient.screenshotUrl(session.id),
        isInspecting: !!url,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ isLoading: false });
    }
  },
  closeSession: async (sessionId) => {
    set({ isLoading: true, error: null });
    try {
      await browserClient.closeSession(sessionId);
      const sessions = get().sessions.filter((item) => item.id !== sessionId);
      const activeSessionId = get().activeSessionId === sessionId
        ? sessions[0]?.id || null
        : get().activeSessionId;
      const session = sessions.find((item) => item.id === activeSessionId) || null;
      set({
        sessions,
        activeSessionId,
        session,
        screenshotUrl: session ? browserClient.screenshotUrl(session.id) : null,
        selection: null,
        isInspecting: false,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ isLoading: false });
    }
  },
  setActiveSession: (sessionId) => {
    const session = get().sessions.find((item) => item.id === sessionId) || null;
    set({
      activeSessionId: session?.id || null,
      session,
      screenshotUrl: session ? browserClient.screenshotUrl(session.id) : null,
      selection: null,
      isOpen: true,
    });
  },
  setInspecting: (enabled) => set({ isInspecting: enabled }),
  setIntent: (intent) => set({ intent }),
  clearSelection: () => set({ selection: null }),

  openUrl: async (url) => {
    set({ isOpen: true, isLoading: true, error: null, selection: null });
    try {
      const existing = get().session;
      const session = existing
        ? await browserClient.navigate(existing.id, url)
        : await browserClient.createSession(url);
      const sessions = [session, ...get().sessions.filter((item) => item.id !== session.id)];
      set({
        sessions,
        activeSessionId: session.id,
        session,
        screenshotUrl: browserClient.screenshotUrl(session.id),
        isInspecting: true,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ isLoading: false });
    }
  },

  refreshScreenshot: () => {
    const session = get().session;
    if (!session) return;
    set({ screenshotUrl: browserClient.screenshotUrl(session.id) });
  },

  inspectAt: async (x, y) => {
    const session = get().session;
    if (!session) return;
    set({ isLoading: true, error: null });
    try {
      const selection = await browserClient.inspect(session.id, x, y);
      selection.screenshotUrl = browserClient.screenshotUrl(session.id);
      const nextSession = { ...session, url: selection.url, title: selection.title, viewport: selection.viewport };
      set({
        selection,
        session: nextSession,
        sessions: get().sessions.map((item) => item.id === nextSession.id ? nextSession : item),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ isLoading: false });
    }
  },
}));
