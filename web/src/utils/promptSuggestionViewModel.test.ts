import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPromptSuggestionViewModel } from './promptSuggestionViewModel.ts';
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

test('buildPromptSuggestionViewModel uses backend runtime before local phase', () => {
  const busy = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 3,
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
  assert.equal(busy.refreshKey, 'runtime:s1:blocked:running:clear');
});

test('buildPromptSuggestionViewModel allows suggestions from runtime idle even while local phase is stale', () => {
  const ready = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'streaming',
    messageCount: 2,
    runtimeSnapshot: runtimeSnapshot(),
  });

  assert.equal(ready.source, 'runtime');
  assert.equal(ready.ready, true);
  assert.equal(ready.refreshKey, 'runtime:s1:ready:running:clear');
});

test('buildPromptSuggestionViewModel blocks structured user and permission gates', () => {
  const permission = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 2,
    runtimeSnapshot: runtimeSnapshot({
      pendingUserInput: { kind: 'permission_request', preview: 'Approve shell?' },
    }),
  });
  const user = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 2,
    runtimeSnapshot: runtimeSnapshot({
      leader: {
        running: true,
        finished: false,
        waitingForUser: true,
        pendingReview: false,
        planApproved: false,
      },
      pendingUserInput: { kind: 'message', preview: 'Need answer' },
    }),
  });

  assert.equal(permission.ready, false);
  assert.equal(permission.refreshKey, 'runtime:s1:blocked:running:gate');
  assert.equal(user.ready, false);
  assert.equal(user.refreshKey, 'runtime:s1:blocked:running:gate');
});

test('buildPromptSuggestionViewModel treats queued messages as backend work, not wait gates', () => {
  const queuedMessage = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 2,
    runtimeSnapshot: runtimeSnapshot({
      pendingUserInput: { kind: 'message', preview: 'Continue' },
    }),
  });

  assert.equal(queuedMessage.source, 'runtime');
  assert.equal(queuedMessage.ready, false);
  assert.equal(queuedMessage.refreshKey, 'runtime:s1:blocked:running:clear');
});

test('buildPromptSuggestionViewModel blocks terminal sessions and empty conversations', () => {
  const terminal = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 3,
    runtimeSnapshot: runtimeSnapshot({ sessionStatus: 'completed' }),
  });
  const empty = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 0,
    runtimeSnapshot: runtimeSnapshot(),
  });

  assert.equal(terminal.ready, false);
  assert.equal(terminal.refreshKey, 'runtime:s1:blocked:completed:clear');
  assert.equal(empty.ready, false);
});

test('buildPromptSuggestionViewModel falls back to phase when runtime snapshot is absent or mismatched', () => {
  const missing = buildPromptSuggestionViewModel({
    sessionId: 's1',
    phase: 'idle',
    messageCount: 1,
    runtimeSnapshot: null,
  });
  const mismatched = buildPromptSuggestionViewModel({
    sessionId: 's2',
    phase: 'tool_executing',
    messageCount: 1,
    runtimeSnapshot: runtimeSnapshot({ sessionId: 's1' }),
  });

  assert.equal(missing.source, 'phase');
  assert.equal(missing.ready, true);
  assert.equal(mismatched.source, 'phase');
  assert.equal(mismatched.ready, false);
});
