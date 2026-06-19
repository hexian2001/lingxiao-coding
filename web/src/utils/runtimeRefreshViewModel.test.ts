import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRuntimeRefreshViewModel } from './runtimeRefreshViewModel.ts';
import type { SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

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

test('buildRuntimeRefreshViewModel uses backend runtime snapshot before local phase', () => {
  const busy = buildRuntimeRefreshViewModel({
    sessionId: 's1',
    phase: 'idle',
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

  assert.equal(busy.source, 'runtime');
  assert.equal(busy.ready, false);
  assert.equal(busy.backendBusy, true);
  assert.equal(busy.refreshKey, 'runtime:s1:busy:running');
});

test('buildRuntimeRefreshViewModel opens a refresh window when backend becomes idle', () => {
  const ready = buildRuntimeRefreshViewModel({
    sessionId: 's1',
    phase: 'streaming',
    runtimeSnapshot: runtimeSnapshot(),
  });

  assert.equal(ready.source, 'runtime');
  assert.equal(ready.ready, true);
  assert.equal(ready.backendBusy, false);
  assert.equal(ready.refreshKey, 'runtime:s1:ready:running');
});

test('buildRuntimeRefreshViewModel treats terminal session snapshots as refreshable', () => {
  const terminal = buildRuntimeRefreshViewModel({
    sessionId: 's1',
    phase: 'streaming',
    runtimeSnapshot: runtimeSnapshot({
      sessionStatus: 'failed',
      leader: {
        running: true,
        finished: true,
        waitingForUser: false,
        pendingReview: false,
        planApproved: false,
      },
    }),
  });

  assert.equal(terminal.source, 'runtime');
  assert.equal(terminal.ready, true);
  assert.equal(terminal.backendBusy, true);
  assert.equal(terminal.refreshKey, 'runtime:s1:ready:failed');
});

test('buildRuntimeRefreshViewModel falls back to phase when runtime snapshot is absent or mismatched', () => {
  const missing = buildRuntimeRefreshViewModel({
    sessionId: 's1',
    phase: 'error',
    runtimeSnapshot: null,
  });
  const mismatched = buildRuntimeRefreshViewModel({
    sessionId: 's2',
    phase: 'tool_executing',
    runtimeSnapshot: runtimeSnapshot(),
  });

  assert.equal(missing.source, 'phase');
  assert.equal(missing.ready, true);
  assert.equal(missing.refreshKey, 'phase:error');
  assert.equal(mismatched.source, 'phase');
  assert.equal(mismatched.ready, false);
  assert.equal(mismatched.refreshKey, 'phase:tool_executing');
});
