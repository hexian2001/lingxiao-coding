import { t } from '../i18n.js';
import type { SessionRuntimeState } from './SessionRuntimeState.js';
import { deriveRuntimeWaitGate } from './StateSemantics.js';

export type InteractionTurnKind =
  | 'permission_approval'
  | 'review'
  | 'user_intervention'
  | 'user_input'
  | 'worker_report'
  | 'worker_recovery'
  | 'waiting'
  | 'leader_processing'
  | 'idle';

export interface InteractionTurnState {
  kind: InteractionTurnKind;
  waiting: boolean;
  source: 'system' | 'user' | 'worker' | 'leader' | 'unknown';
  summary: string;
}

export class TurnCoordinator {
  classify(state: SessionRuntimeState): InteractionTurnState {
    const waitGate = deriveRuntimeWaitGate(state);

    if (waitGate?.kind === 'permission') {
      const request = state.leader.pendingPermissionRequest;
      return {
        kind: 'permission_approval',
        waiting: true,
        source: waitGate.source,
        summary: request?.toolName ? t('turn.waiting_permission_tool', request.toolName) : t('turn.waiting_permission'),
      };
    }

    if (waitGate?.kind === 'review') {
      return {
        kind: 'review',
        waiting: true,
        source: waitGate.source,
        summary: t('turn.waiting_review'),
      };
    }

    if (waitGate?.kind === 'ask_user') {
      return {
        kind: 'waiting',
        waiting: true,
        source: waitGate.source,
        summary: state.pendingUserGate?.preview
          ? t('turn.waiting_user_answer_preview', state.pendingUserGate.preview)
          : t('turn.waiting_user_answer'),
      };
    }

    if (waitGate?.kind === 'idle') {
      return {
        kind: 'idle',
        waiting: false,
        source: waitGate.source,
        summary: state.pendingUserGate?.preview || t('turn.session_idle_waiting_instruction'),
      };
    }

    if (waitGate?.kind === 'waiting') {
      return {
        kind: 'waiting',
        waiting: true,
        source: waitGate.source,
        summary: t('turn.waiting_user_input'),
      };
    }

    const hasActiveWork =
      state.leader.busy ||
      state.leader.running ||
      state.hasRunningWorkers ||
      state.hasRecoveringTasks ||
      state.hasDispatchableTasks;

    if (
      state.pendingUserInput.kind === 'message' &&
      hasActiveWork &&
      !state.leader.waitingForUser
    ) {
      return {
        kind: 'user_intervention',
        waiting: false,
        source: 'user',
        summary: state.pendingUserInput.preview
          ? t('turn.user_intervention_preview', state.pendingUserInput.preview)
          : t('turn.user_intervention'),
      };
    }

    if (state.pendingUserInput.kind === 'message') {
      return {
        kind: 'user_input',
        waiting: false,
        source: 'user',
        summary: state.pendingUserInput.preview
          ? t('turn.processing_user_input_preview', state.pendingUserInput.preview)
          : t('turn.processing_user_input'),
      };
    }

    if (state.hasRunningWorkers) {
      return {
        kind: 'worker_report',
        waiting: false,
        source: 'worker',
        summary: t('turn.waiting_workers', state.runningWorkerCount),
      };
    }

    if (state.hasRecoveringTasks) {
      return {
        kind: 'worker_recovery',
        waiting: false,
        source: 'worker',
        summary: t('turn.worker_recovery', state.recoveringTaskCount),
      };
    }

    if (
      state.leader.busy ||
      (state.leader.running && !state.leader.waitingForUser) ||
      state.hasDispatchableTasks
    ) {
      return {
        kind: 'leader_processing',
        waiting: false,
        source: 'leader',
        summary: state.hasDispatchableTasks
          ? t('turn.leader_processing_dispatchable', state.dispatchableTaskCount)
          : t('turn.leader_processing_session'),
      };
    }

    return {
      kind: 'idle',
      waiting: false,
      source: 'system',
      summary: t('turn.session_idle'),
    };
  }
}
