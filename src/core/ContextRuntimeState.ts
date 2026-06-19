export interface ContextRuntimeOwner {
  kind: 'leader' | 'agent';
  workspace?: string;
  agentId?: string;
  agentName?: string;
}

const MAX_COMPACT_HISTORY = 8;

export interface RecentFileSnapshot {
  path: string;
  timestamp: number;
  charCount: number;
  tokenEstimate: number;
}

export interface ContextCompactRecord {
  timestamp: number;
  oldTokens: number;
  newTokens: number;
  compactType: string;
  archivePath?: string;
  messageCount: number;
}

export interface ContextRuntimeState {
  owner: ContextRuntimeOwner;
  sessionId?: string;
  maxTokens: number;
  threshold: number;
  currentTokens: number;
  warningLevel: 'ok' | 'warning' | 'critical';
  consecutiveFailures: number;
  recentFileCount: number;
  recentFiles: RecentFileSnapshot[];
  lastArchivePath?: string;
  lastCompact?: ContextCompactRecord;
  compactHistory: ContextCompactRecord[];
}

export function getContextRuntimeStateKey(owner: ContextRuntimeOwner): string {
  if (owner.kind === 'agent') {
    return `context_runtime:agent:${owner.agentId || owner.agentName || 'unknown'}`;
  }
  return 'context_runtime:leader';
}

export function getContextWarningLevel(
  currentTokens: number,
  threshold: number,
): ContextRuntimeState['warningLevel'] {
  if (threshold <= 0) {
    return 'ok';
  }
  const ratio = currentTokens / threshold;
  if (ratio >= 1) {
    return 'critical';
  }
  if (ratio >= 0.7) {
    return 'warning';
  }
  return 'ok';
}

export function createInitialContextRuntimeState(
  owner: ContextRuntimeOwner,
  threshold: number,
  sessionId?: string,
  maxTokens = threshold,
): ContextRuntimeState {
  return {
    owner,
    sessionId,
    maxTokens,
    threshold,
    currentTokens: 0,
    warningLevel: 'ok',
    consecutiveFailures: 0,
    recentFileCount: 0,
    recentFiles: [],
    compactHistory: [],
  };
}

export function updateContextRuntimeObservation(
  state: ContextRuntimeState,
  patch: Partial<Omit<ContextRuntimeState, 'owner' | 'sessionId' | 'compactHistory' | 'lastCompact'>>,
): ContextRuntimeState {
  const currentTokens = patch.currentTokens ?? state.currentTokens;
  const threshold = patch.threshold ?? state.threshold;
  return {
    ...state,
    ...patch,
    currentTokens,
    threshold,
    warningLevel: patch.warningLevel ?? getContextWarningLevel(currentTokens, threshold),
  };
}

export function recordContextCompaction(
  state: ContextRuntimeState,
  record: ContextCompactRecord,
): ContextRuntimeState {
  return {
    ...state,
    currentTokens: record.newTokens,
    warningLevel: getContextWarningLevel(record.newTokens, state.threshold),
    lastArchivePath: record.archivePath,
    lastCompact: record,
    compactHistory: [...state.compactHistory, record].slice(-MAX_COMPACT_HISTORY),
  };
}

export function loadPersistedContextRuntimeState(
  db: { getSessionState(sessionId: string, key: string): unknown | null },
  sessionId: string,
  owner: ContextRuntimeOwner,
): ContextRuntimeState | null {
  const raw = db.getSessionState(sessionId, getContextRuntimeStateKey(owner));
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<ContextRuntimeState>;
  return {
    owner,
    sessionId,
    maxTokens: typeof candidate.maxTokens === 'number' ? candidate.maxTokens : 0,
    threshold: typeof candidate.threshold === 'number' ? candidate.threshold : 0,
    currentTokens: typeof candidate.currentTokens === 'number' ? candidate.currentTokens : 0,
    warningLevel:
      candidate.warningLevel === 'warning' || candidate.warningLevel === 'critical'
        ? candidate.warningLevel
        : getContextWarningLevel(
            typeof candidate.currentTokens === 'number' ? candidate.currentTokens : 0,
            typeof candidate.threshold === 'number' ? candidate.threshold : 0,
          ),
    consecutiveFailures: typeof candidate.consecutiveFailures === 'number' ? candidate.consecutiveFailures : 0,
    recentFileCount: typeof candidate.recentFileCount === 'number' ? candidate.recentFileCount : 0,
    recentFiles: Array.isArray(candidate.recentFiles) ? candidate.recentFiles : [],
    lastArchivePath: typeof candidate.lastArchivePath === 'string' ? candidate.lastArchivePath : undefined,
    lastCompact: candidate.lastCompact as ContextCompactRecord | undefined,
    compactHistory: Array.isArray(candidate.compactHistory) ? candidate.compactHistory as ContextCompactRecord[] : [],
  };
}
