import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionBadgeViewModel,
  pickBootstrapSessionId,
} from './sessionListViewModel.ts';
import type { SessionInfo, SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    workspace: '/tmp/work',
    status: 'active',
    createdAt: 1,
    ...patch,
  };
}

function runtimeSnapshot(patch: Partial<SessionRuntimeSnapshot> = {}): SessionRuntimeSnapshot {
  return {
    sessionId: 's1',
    workspace: '/tmp/work',
    sessionStatus: 'active',
    leader: {
      running: false,
      finished: false,
      waitingForUser: false,
      pendingReview: false,
      planApproved: false,
    },
    pendingUserInput: { kind: 'empty', preview: '' },
    runningWorkers: [],
    runningWorkerCount: 0,
    hasRunningWorkers: false,
    recoveringTaskCount: 0,
    hasRecoveringTasks: false,
    dispatchableTaskCount: 0,
    hasDispatchableTasks: false,
    allTasksTerminal: false,
    eternal: {
      enabled: false,
      status: 'disabled',
      currentPatrolIntervalMs: 0,
      consecutiveIdlePatrols: 0,
      lastPatrolAtMs: 0,
      nextPatrolDueAtMs: 0,
      currentWindowTokens: 0,
      tokenBudgetPerHour: 0,
      windowStartMs: 0,
      consecutiveApiFailures: 0,
      circuitOpenUntilMs: 0,
      totalPatrols: 0,
      silenceLockEngaged: false,
      lastPatrolOutcome: 'never',
      workerCompletionCount: 0,
      patrolInFlight: false,
      lastFingerprintKnown: false,
    },
    ...patch,
  };
}

test('buildSessionBadgeViewModel does not paint persisted active status as running', () => {
  const badge = buildSessionBadgeViewModel(session({ status: 'active' }));

  assert.equal(badge.label, 'active');
  assert.equal(badge.tone, 'neutral');
  assert.equal(badge.runtimeBacked, false);
});

test('buildSessionBadgeViewModel uses matching runtime snapshot as badge truth', () => {
  const running = buildSessionBadgeViewModel(session(), {
    currentSessionId: 's1',
    runtimeSnapshot: runtimeSnapshot({
      leader: {
        running: true,
        finished: false,
        waitingForUser: false,
        pendingReview: false,
        planApproved: false,
      },
    }),
  });
  const idle = buildSessionBadgeViewModel(session(), {
    currentSessionId: 's1',
    runtimeSnapshot: runtimeSnapshot(),
  });

  assert.deepEqual(running, { label: 'running', tone: 'active', runtimeBacked: true });
  assert.deepEqual(idle, { label: 'idle', tone: 'neutral', runtimeBacked: true });
});

test('buildSessionBadgeViewModel surfaces structured wait gates without busy inference', () => {
  const permission = buildSessionBadgeViewModel(session(), {
    runtimeSnapshot: runtimeSnapshot({
      pendingUserInput: { kind: 'permission_request', preview: 'Approve shell?' },
      leader: {
        running: true,
        finished: false,
        waitingForUser: false,
        pendingReview: false,
        planApproved: false,
      },
    }),
  });
  const review = buildSessionBadgeViewModel(session(), {
    runtimeSnapshot: runtimeSnapshot({
      pendingUserInput: { kind: 'plan_review', preview: 'Plan' },
    }),
  });

  assert.deepEqual(permission, { label: 'permission', tone: 'warn', runtimeBacked: true });
  assert.deepEqual(review, { label: 'review', tone: 'warn', runtimeBacked: true });
});

test('buildSessionBadgeViewModel treats queued messages as running work, not a wait badge', () => {
  const badge = buildSessionBadgeViewModel(session(), {
    runtimeSnapshot: runtimeSnapshot({
      pendingUserInput: { kind: 'message', preview: 'Continue' },
    }),
  });

  assert.deepEqual(badge, { label: 'running', tone: 'active', runtimeBacked: true });
});

test('buildSessionBadgeViewModel ignores mismatched runtime snapshots', () => {
  const badge = buildSessionBadgeViewModel(session({ id: 's2', status: 'active' }), {
    runtimeSnapshot: runtimeSnapshot({ sessionId: 's1' }),
  });

  assert.equal(badge.label, 'active');
  assert.equal(badge.tone, 'neutral');
  assert.equal(badge.runtimeBacked, false);
});

test('buildSessionBadgeViewModel supports per-row runtime snapshots for non-current sessions', () => {
  const badge = buildSessionBadgeViewModel(session({ id: 's2', status: 'active' }), {
    currentSessionId: 's1',
    runtimeSnapshot: runtimeSnapshot({
      sessionId: 's2',
      leader: {
        running: true,
        finished: false,
        waitingForUser: false,
        pendingReview: false,
        planApproved: false,
      },
    }),
  });

  assert.deepEqual(badge, { label: 'running', tone: 'active', runtimeBacked: true });
});

test('pickBootstrapSessionId prefers running worker sessions over stale activeSessionId', () => {
  const selected = pickBootstrapSessionId([
    session({ id: 'stale-active', status: 'active', isActive: true, createdAt: 3 }),
    session({
      id: 'worker-live',
      status: 'active',
      isActive: true,
      createdAt: 2,
      runtimeSnapshot: runtimeSnapshot({
        sessionId: 'worker-live',
        hasRunningWorkers: true,
        runningWorkerCount: 1,
        runningWorkers: [{ agentId: 'a1', name: 'Architect', roleType: 'architect', taskId: 'T-1', status: 'running' }],
      }),
    }),
  ], 'stale-active');

  assert.equal(selected, 'worker-live');
});

test('pickBootstrapSessionId prefers active memory sessions before resumable persisted sessions', () => {
  const selected = pickBootstrapSessionId([
    session({ id: 'old-resumable', status: 'active', createdAt: 1 }),
    session({ id: 'live', status: 'active', isActive: true, createdAt: 2 }),
    session({ id: 'done', status: 'completed', createdAt: 3 }),
  ]);

  assert.equal(selected, 'live');
});

test('pickBootstrapSessionId treats persisted active as resumable, not running', () => {
  const selected = pickBootstrapSessionId([
    session({ id: 'done-latest', status: 'completed', createdAt: 3 }),
    session({ id: 'resumable', status: 'active', createdAt: 2 }),
    session({ id: 'deleted', status: 'deleted', createdAt: 4 }),
  ]);

  assert.equal(selected, 'resumable');
});
