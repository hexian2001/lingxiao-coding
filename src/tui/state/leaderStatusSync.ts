import type { CommandLogMessage } from '../../commands/types.js';
import type { NormalizedLeaderStatusKind } from '../../core/StateSemantics.js';
import { t } from '../../i18n.js';
import { normalizeLocalizedAwaitingInputStatus, type LeaderStatusSurfaceOptions } from '../utils.js';

export type LeaderStatusSyncDeps = {
  setLeaderStatus: (status: string) => void;
  leaderStatusRef: { current: string };
  updateChannelStatus: (channel: string, status: string) => void;
  updateChannelNext: (channel: string, next: string) => void;
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  shouldSurfaceLeaderStatus: (status: string, lastStatus: string, options?: LeaderStatusSurfaceOptions) => boolean;
  lastLeaderStatusLogRef: { current: string };
  markVisibleLeaderActivity: () => void;
};

export type LeaderStatusEvent = {
  status: string;
  statusKind?: NormalizedLeaderStatusKind;
  surface?: boolean;
  /** Display-only worker hint; never participates in leader activity derivation. */
  runningAgents?: string[];
};

export type LeaderStatusSync = {
  handleLeaderStatusEvent: (event: LeaderStatusEvent) => void;
  setLeaderStatusForMain: (status: string) => void;
};

export const createLeaderStatusSync = (deps: LeaderStatusSyncDeps): LeaderStatusSync => {
  const setLeaderStatusForMain = (status: string) => {
    const displayStatus = normalizeLocalizedAwaitingInputStatus(status);
    // Skip React state updates if the status hasn't changed — avoids
    // unnecessary re-renders that cause screen flicker with multiple agents.
    if (deps.leaderStatusRef.current !== displayStatus) {
      deps.setLeaderStatus(displayStatus);
      deps.leaderStatusRef.current = displayStatus;
      deps.updateChannelStatus('main', displayStatus);
    }
    return displayStatus;
  };

  const handleLeaderStatusEvent = (event: LeaderStatusEvent) => {
    const displayStatus = setLeaderStatusForMain(event.status);

    const statusKind = event.statusKind;
    if (deps.shouldSurfaceLeaderStatus(displayStatus, deps.lastLeaderStatusLogRef.current, {
      statusKind,
      surface: event.surface,
    })) {
      deps.appendMessage('main', { type: 'system', content: t('tui.leader.status_log', displayStatus) });
      deps.lastLeaderStatusLogRef.current = displayStatus;
      deps.markVisibleLeaderActivity();
    }

    const displayRunningAgents = event.runningAgents || [];
    if (displayRunningAgents.length) {
      deps.updateChannelNext(
        'main',
        displayRunningAgents.length === 1
          ? t('tui.leader.agents_working_one', displayRunningAgents[0])
          : t('tui.leader.agents_working_many', displayRunningAgents.length),
      );
    } else if (statusKind !== 'active') {
      deps.updateChannelNext('main', '');
    }
  };

  return {
    handleLeaderStatusEvent,
    setLeaderStatusForMain,
  };
};
