import {
  deriveRuntimeWaitGate,
  isRunTerminalStatus,
  normalizeRunStatus,
  runtimeImpliesBusy,
} from '../stores/sessionStoreHelpers.ts';
import type { SessionPhase, SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

export interface PromptSuggestionInput {
  sessionId?: string | null;
  phase: SessionPhase;
  messageCount: number;
  runtimeSnapshot: SessionRuntimeSnapshot | null;
}

export interface PromptSuggestionViewModel {
  source: 'runtime' | 'phase';
  ready: boolean;
  refreshKey: string;
}

export function buildPromptSuggestionViewModel(input: PromptSuggestionInput): PromptSuggestionViewModel {
  const hasMessages = input.messageCount > 0;
  const snapshot = input.runtimeSnapshot;
  const sessionId = input.sessionId || null;
  const snapshotMatchesSession = Boolean(
    snapshot
    && (!sessionId || snapshot.sessionId === sessionId)
  );

  if (snapshot && snapshotMatchesSession) {
    const normalizedStatus = normalizeRunStatus(snapshot.sessionStatus);
    const waitGate = deriveRuntimeWaitGate(snapshot);
    const backendBusy = runtimeImpliesBusy({ runtimeState: snapshot });
    const ready = hasMessages
      && !backendBusy
      && !waitGate
      && !isRunTerminalStatus(snapshot.sessionStatus);

    return {
      source: 'runtime',
      ready,
      refreshKey: `runtime:${snapshot.sessionId}:${ready ? 'ready' : 'blocked'}:${normalizedStatus}:${waitGate ? 'gate' : 'clear'}`,
    };
  }

  const ready = hasMessages && input.phase === 'idle';
  return {
    source: 'phase',
    ready,
    refreshKey: `phase:${input.phase}:${hasMessages ? 'messages' : 'empty'}`,
  };
}
