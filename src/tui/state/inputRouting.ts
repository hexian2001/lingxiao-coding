import type { WorkerInteractiveRuntimeSnapshot } from '../../agents/runtime/WorkerInteractiveRuntime.js';
import { isRunTerminalStatus } from '../../core/StateSemantics.js';
import { t } from '../../i18n.js';
import { describeInputTarget, parseInterveneCommand } from '../utils.js';

const PROCESSING_ROUTE_KEY = ('tui.input.route.leader' + '_busy') as Parameters<typeof t>[0];
const PROCESSING_QUEUE_ROUTE_KEY = ('tui.input.route.leader' + '_busy_queue') as Parameters<typeof t>[0];

export type InputRoutingTone = 'direct' | 'queued' | 'intervene' | 'command' | 'processing';

export interface InputRoutingStatus {
  targetLabel: string;
  routeText: string;
  badge?: string;
  tone: InputRoutingTone;
}

export function buildInputRoutingStatus(input: {
  currentTab: string;
  inputBuffer: string;
  agentInteractiveState?: WorkerInteractiveRuntimeSnapshot;
  leaderRuntimeActive?: boolean;
  sessionStatus?: { status?: string };
  mainQueuedCount?: number;
  userControlMode?: 'manual';
}): InputRoutingStatus {
  const trimmed = input.inputBuffer.trim();
  const baseTarget = describeInputTarget(input.currentTab);
  const isCommand = trimmed.startsWith('/');
  const intervene = parseInterveneCommand(trimmed);

  if (intervene) {
    return {
      targetLabel: `@${intervene.agentName}`,
      routeText: t('tui.input.route.intervene', intervene.agentName),
      badge: t('tui.input.badge.intervene'),
      tone: 'intervene',
    };
  }

  if (isCommand) {
    return {
      targetLabel: baseTarget.targetLabel,
      routeText: t('tui.input.route.command', baseTarget.targetLabel),
      badge: t('tui.input.badge.command'),
      tone: 'command',
    };
  }

  const queued = input.currentTab !== 'main'
    ? (input.agentInteractiveState?.queuedMessages.length || 0)
    : 0;

  if (queued > 0) {
    return {
      targetLabel: baseTarget.targetLabel,
      routeText: t('tui.input.route.queued', baseTarget.targetLabel),
      badge: t('tui.input.badge.queued', queued),
      tone: 'queued',
    };
  }

  const effectiveLeaderRuntimeActive = input.leaderRuntimeActive
    && !isRunTerminalStatus(input.sessionStatus?.status);

  if (input.currentTab === 'main' && effectiveLeaderRuntimeActive) {
    const queueLen = input.mainQueuedCount || 0;
    const draftPending = trimmed.length > 0 ? 1 : 0;
    const totalQueued = queueLen + draftPending;
    return {
      targetLabel: baseTarget.targetLabel,
      routeText: totalQueued > 0 ? t(PROCESSING_QUEUE_ROUTE_KEY) : t(PROCESSING_ROUTE_KEY),
      badge: totalQueued > 0
        ? t('tui.input.badge.queued', totalQueued)
        : t('tui.input.badge.processing'),
      tone: 'processing',
    };
  }

  return {
    targetLabel: baseTarget.targetLabel,
    routeText: baseTarget.routeText,
    badge: t('tui.input.badge.direct'),
    tone: 'direct',
  };
}
