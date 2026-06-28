import {
  deriveRuntimeWaitGate,
  isRunTerminalStatus,
  normalizeRunStatus,
  runtimeImpliesBusy,
} from '../stores/sessionStoreHelpers.ts';
import type { SessionInfo, SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';
import { createLogger } from './logger';

const log = createLogger('sessionListViewModel');

const LAST_SELECTED_SESSION_KEY = 'lingxiao-last-selected-session-id';

export type SessionBadgeTone = 'active' | 'warn' | 'danger' | 'ok' | 'neutral';

export interface SessionBadgeViewModel {
  label: string;
  tone: SessionBadgeTone;
  runtimeBacked: boolean;
}

export interface SessionBadgeInput {
  currentSessionId?: string | null;
  runtimeSnapshot?: SessionRuntimeSnapshot | null;
}

export function loadLastSelectedSessionId(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const stored = localStorage.getItem(LAST_SELECTED_SESSION_KEY);
    return stored && stored.trim() ? stored : null;
  } catch (err) {
    log.warn('Failed to load last selected session:', err);
    return null;
  }
}

export function saveLastSelectedSessionId(sessionId: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (sessionId && sessionId.trim()) {
      localStorage.setItem(LAST_SELECTED_SESSION_KEY, sessionId);
    } else {
      localStorage.removeItem(LAST_SELECTED_SESSION_KEY);
    }
  } catch (err) {
    log.warn('Failed to save last selected session:', err);
  }
}

function isMatchingRuntimeSnapshot(sessionId: string, snapshot?: SessionRuntimeSnapshot | null): snapshot is SessionRuntimeSnapshot {
  return Boolean(snapshot && snapshot.sessionId === sessionId);
}

function labelForTerminalStatus(status: unknown): Pick<SessionBadgeViewModel, 'label' | 'tone'> {
  const normalized = normalizeRunStatus(status);
  if (normalized === 'completed') return { label: 'done', tone: 'ok' };
  if (normalized === 'failed') return { label: 'failed', tone: 'danger' };
  return { label: 'interrupted', tone: 'danger' };
}

export function buildSessionBadgeViewModel(
  session: Pick<SessionInfo, 'id' | 'status' | 'isActive'>,
  input: SessionBadgeInput = {},
): SessionBadgeViewModel {
  const snapshot = isMatchingRuntimeSnapshot(session.id, input.runtimeSnapshot)
    ? input.runtimeSnapshot
    : null;

  if (snapshot) {
    if (isRunTerminalStatus(snapshot.sessionStatus)) {
      return { ...labelForTerminalStatus(snapshot.sessionStatus), runtimeBacked: true };
    }

    const waitGate = deriveRuntimeWaitGate(snapshot);
    if (waitGate) return { label: waitGate.kind, tone: 'warn', runtimeBacked: true };

    const backendBusy = runtimeImpliesBusy({ runtimeState: snapshot });
    if (backendBusy) return { label: 'running', tone: 'active', runtimeBacked: true };

    return { label: 'idle', tone: 'neutral', runtimeBacked: true };
  }

  if (isRunTerminalStatus(session.status)) {
    return { ...labelForTerminalStatus(session.status), runtimeBacked: false };
  }

  const rawStatus = String(session.status || '').trim();
  const lower = rawStatus.toLowerCase();
  if (lower === 'running' || lower === 'busy') {
    return { label: 'running', tone: 'active', runtimeBacked: false };
  }
  if (session.isActive) {
    return { label: 'loaded', tone: 'neutral', runtimeBacked: false };
  }
  return {
    label: rawStatus || 'idle',
    tone: 'neutral',
    runtimeBacked: false,
  };
}

function isDeletedSession(session: Pick<SessionInfo, 'status'>): boolean {
  return String(session.status || '').trim().toLowerCase() === 'deleted';
}

function isResumableSession(session: Pick<SessionInfo, 'status'>): boolean {
  return !isDeletedSession(session) && !isRunTerminalStatus(session.status);
}

function sessionRuntimeBusy(session: SessionInfo): boolean {
  const snapshot = session.runtimeSnapshot;
  return Boolean(snapshot && snapshot.sessionId === session.id && runtimeImpliesBusy({ runtimeState: snapshot }));
}

function sessionRuntimeHasWorkers(session: SessionInfo): boolean {
  const snapshot = session.runtimeSnapshot;
  return Boolean(snapshot && snapshot.sessionId === session.id && (snapshot.hasRunningWorkers || snapshot.runningWorkerCount > 0 || snapshot.runningWorkers.length > 0));
}

function latestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function pickBootstrapSessionId(
  sessions: SessionInfo[],
  activeSessionId?: string | null,
  lastSelectedSessionId?: string | null,
): string | null {
  const selectable = sessions.filter((session) => !isDeletedSession(session));
  const runningWorkerSession = latestSession(selectable.filter(sessionRuntimeHasWorkers));
  if (runningWorkerSession) return runningWorkerSession.id;

  const busyRuntimeSession = latestSession(selectable.filter(sessionRuntimeBusy));
  if (busyRuntimeSession) return busyRuntimeSession.id;

  // 后端 active session 优先于 localStorage 旧会话：
  // 启动时后端刚 createSession 新会话并设为 active，应优先载入它，
  // 而不是回退到上次使用的旧会话（避免每次启动都载入旧会话而非新会话）。
  if (activeSessionId && selectable.some((session) => session.id === activeSessionId)) {
    return activeSessionId;
  }

  if (lastSelectedSessionId && selectable.some((session) => session.id === lastSelectedSessionId)) {
    return lastSelectedSessionId;
  }

  const memoryActive = latestSession(selectable.filter((session) => session.isActive));
  if (memoryActive) return memoryActive.id;

  const latestResumable = latestSession(selectable.filter(isResumableSession));
  if (latestResumable) return latestResumable.id;

  return latestSession(selectable)?.id ?? null;
}
