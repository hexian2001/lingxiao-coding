import { isRunTerminalStatus, normalizeRunStatus, runtimeImpliesBusy } from '../stores/sessionStoreHelpers.ts';
import type { SessionPhase, SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

export interface RuntimeRefreshInput {
  sessionId?: string | null;
  phase: SessionPhase;
  runtimeSnapshot: SessionRuntimeSnapshot | null;
}

export interface RuntimeRefreshViewModel {
  source: 'runtime' | 'phase';
  ready: boolean;
  backendBusy: boolean;
  refreshKey: string;
}

const LEGACY_REFRESH_PHASES = new Set<SessionPhase>([
  'idle',
  'done',
  'error',
  'interrupted',
]);

export function buildRuntimeRefreshViewModel(input: RuntimeRefreshInput): RuntimeRefreshViewModel {
  const sessionId = input.sessionId || null;
  const snapshot = input.runtimeSnapshot;
  const snapshotMatchesSession = Boolean(
    snapshot
    && (!sessionId || snapshot.sessionId === sessionId)
  );

  if (snapshot && snapshotMatchesSession) {
    const backendBusy = runtimeImpliesBusy({ runtimeState: snapshot });
    const normalizedStatus = normalizeRunStatus(snapshot.sessionStatus);
    const ready = !backendBusy || isRunTerminalStatus(snapshot.sessionStatus);
    return {
      source: 'runtime',
      ready,
      backendBusy,
      refreshKey: `runtime:${snapshot.sessionId}:${ready ? 'ready' : 'busy'}:${normalizedStatus}`,
    };
  }

  const ready = LEGACY_REFRESH_PHASES.has(input.phase);
  return {
    source: 'phase',
    ready,
    backendBusy: !ready,
    refreshKey: `phase:${input.phase}`,
  };
}
