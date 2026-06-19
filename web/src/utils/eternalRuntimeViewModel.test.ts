import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEternalControlModeViewModel, buildEternalRuntimeViewModel } from './eternalRuntimeViewModel.ts';
import type { SessionEternalRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

function snapshot(patch: Partial<SessionEternalRuntimeSnapshot> = {}): SessionEternalRuntimeSnapshot {
  return {
    enabled: true,
    status: 'waiting',
    goal: null,
    currentPatrolIntervalMs: 60_000,
    consecutiveIdlePatrols: 2,
    lastPatrolAtMs: 1_000,
    nextPatrolDueAtMs: 10_000,
    currentWindowTokens: 10,
    tokenBudgetPerHour: 100,
    windowStartMs: 0,
    consecutiveApiFailures: 0,
    circuitOpenUntilMs: 0,
    totalPatrols: 5,
    silenceLockEngaged: false,
    lastPatrolOutcome: 'idle',
    workerCompletionCount: 3,
    patrolInFlight: false,
    lastFingerprintKnown: true,
    ...patch,
  };
}

test('buildEternalRuntimeViewModel hides disabled or missing snapshots', () => {
  assert.equal(buildEternalRuntimeViewModel(null), null);
  assert.equal(buildEternalRuntimeViewModel(snapshot({ enabled: false, status: 'disabled' })), null);
});

test('buildEternalRuntimeViewModel renders waiting countdown from backend due time', () => {
  const view = buildEternalRuntimeViewModel(snapshot({ nextPatrolDueAtMs: 65_000 }), 5_000);

  assert.equal(view?.tone, 'neutral');
  assert.equal(view?.statusLabel, 'waiting');
  assert.equal(view?.detailLabel, 'next 1m');
  assert.match(view?.title ?? '', /patrols 5/);
  assert.match(view?.title ?? '', /idle 2/);
});

test('buildEternalRuntimeViewModel marks only in-flight patrol as spinning', () => {
  const running = buildEternalRuntimeViewModel(snapshot({ status: 'patrolling', patrolInFlight: true }));
  const notInFlight = buildEternalRuntimeViewModel(snapshot({ status: 'patrolling', patrolInFlight: false }));

  assert.equal(running?.tone, 'active');
  assert.equal(running?.statusLabel, 'patrolling');
  assert.equal(running?.detailLabel, 'in flight');
  assert.equal(running?.spinning, true);
  assert.equal(notInFlight?.spinning, false);
});

test('buildEternalRuntimeViewModel exposes guard states without inference', () => {
  const budget = buildEternalRuntimeViewModel(snapshot({
    status: 'budget_exhausted',
    currentWindowTokens: 120,
    tokenBudgetPerHour: 100,
  }));
  const circuit = buildEternalRuntimeViewModel(snapshot({
    status: 'circuit_open',
    circuitOpenUntilMs: 125_000,
    consecutiveApiFailures: 3,
  }), 5_000);
  const silenced = buildEternalRuntimeViewModel(snapshot({
    status: 'silenced',
    silenceLockEngaged: true,
  }));

  assert.equal(budget?.tone, 'danger');
  assert.equal(budget?.statusLabel, 'budget');
  assert.equal(budget?.detailLabel, '120/100');
  assert.equal(circuit?.tone, 'danger');
  assert.equal(circuit?.detailLabel, 'retry 2m');
  assert.match(circuit?.title ?? '', /api failures 3/);
  assert.equal(silenced?.tone, 'warn');
  assert.equal(silenced?.detailLabel, 'lock');
});

test('buildEternalControlModeViewModel separates mode from runtime state', () => {
  const manual = buildEternalControlModeViewModel('manual', snapshot({ status: 'patrolling', patrolInFlight: true }));
  const missingRuntime = buildEternalControlModeViewModel('eternal', null);
  const disabledRuntime = buildEternalControlModeViewModel('eternal', snapshot({ enabled: false, status: 'disabled' }));

  assert.equal(manual.isEternal, false);
  assert.equal(manual.modeLabel, 'Manual');
  assert.equal(manual.runtimeLabel, null);
  assert.equal(manual.runtimeTone, null);
  assert.equal(manual.spinning, false);

  assert.equal(missingRuntime.isEternal, true);
  assert.equal(missingRuntime.modeLabel, 'Eternal');
  assert.equal(missingRuntime.runtimeLabel, null);
  assert.equal(missingRuntime.runtimeTone, null);
  assert.equal(missingRuntime.spinning, false);
  assert.match(missingRuntime.title, /unavailable/);

  assert.equal(disabledRuntime.runtimeLabel, null);
  assert.equal(disabledRuntime.runtimeTone, null);
  assert.equal(disabledRuntime.spinning, false);
});

test('buildEternalControlModeViewModel uses backend runtime for labels and spinner', () => {
  const waiting = buildEternalControlModeViewModel('eternal', snapshot({ nextPatrolDueAtMs: 65_000 }), 5_000);
  const inFlight = buildEternalControlModeViewModel('eternal', snapshot({
    status: 'patrolling',
    patrolInFlight: true,
  }));

  assert.equal(waiting.runtimeLabel, 'waiting next 1m');
  assert.equal(waiting.runtimeTone, 'neutral');
  assert.equal(waiting.spinning, false);
  assert.equal(inFlight.runtimeLabel, 'patrolling in flight');
  assert.equal(inFlight.runtimeTone, 'active');
  assert.equal(inFlight.spinning, true);
});
