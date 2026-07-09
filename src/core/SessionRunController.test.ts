/**
 * SessionRunController / deriveSessionRunPhase 单测
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionRunController,
  deriveSessionRunPhase,
} from './SessionRunController.js';
import type { SessionRunSignals } from '../contracts/types/SessionRun.js';

function base(over: Partial<SessionRunSignals> = {}): SessionRunSignals {
  return {
    isBusyThinking: false,
    waitingForUserFlag: false,
    explicitUserGate: false,
    pendingReview: false,
    readyTaskCount: 0,
    runningAgentCount: 0,
    recoveringCount: 0,
    controlMode: 'manual',
    collaborationMode: 'solo',
    teamReady: null,
    allTasksTerminal: false,
    ...over,
  };
}

describe('deriveSessionRunPhase', () => {
  it('marks thinking when busy', () => {
    const d = deriveSessionRunPhase(base({ isBusyThinking: true, readyTaskCount: 2 }));
    assert.equal(d.phase, 'thinking');
    assert.equal(d.reason, 'busy_thinking');
  });

  it('marks waiting_workers when agents running', () => {
    const d = deriveSessionRunPhase(base({ runningAgentCount: 2, readyTaskCount: 1 }));
    assert.equal(d.phase, 'waiting_workers');
  });

  it('never idles with deferred ready work (waiting latch)', () => {
    const d = deriveSessionRunPhase(base({
      readyTaskCount: 3,
      runningAgentCount: 0,
      waitingForUserFlag: true,
      controlMode: 'manual',
    }));
    assert.equal(d.phase, 'waiting_user');
    assert.equal(d.reason, 'leader_deferred_ready_tasks');
    assert.equal(d.hasDeferredReadyWork, true);
    assert.equal(d.silentIdleViolation, false);
  });

  it('ready without latch needs decision (not idle)', () => {
    const d = deriveSessionRunPhase(base({
      readyTaskCount: 2,
      runningAgentCount: 0,
      waitingForUserFlag: false,
      controlMode: 'manual',
    }));
    assert.equal(d.phase, 'thinking');
    assert.equal(d.reason, 'ready_needs_decision');
  });

  it('explicit user gate wins over ready tasks', () => {
    const d = deriveSessionRunPhase(base({
      readyTaskCount: 5,
      explicitUserGate: true,
      waitingForUserFlag: true,
    }));
    assert.equal(d.phase, 'waiting_user');
    assert.equal(d.reason, 'explicit_user_gate');
  });

  it('recovering has highest priority among work phases', () => {
    const d = deriveSessionRunPhase(base({
      recoveringCount: 1,
      isBusyThinking: true,
      runningAgentCount: 2,
    }));
    assert.equal(d.phase, 'recovering');
  });

  it('idle only when no open work', () => {
    const d = deriveSessionRunPhase(base({ allTasksTerminal: true }));
    assert.equal(d.phase, 'idle');
    assert.equal(d.reason, 'all_work_terminal');
  });

  it('eternal patrol when idle patrol flag set', () => {
    const d = deriveSessionRunPhase(base({
      controlMode: 'eternal',
      isEternalPatrolIdle: true,
      allTasksTerminal: false,
    }));
    assert.equal(d.phase, 'eternal_patrol');
  });
});

describe('SessionRunController', () => {
  it('bumps generation only on meaningful change', () => {
    const c = new SessionRunController();
    const a = c.recompute(base({ readyTaskCount: 1 }));
    assert.equal(a.phase, 'thinking');
    assert.ok(a.generation >= 1);
    const gen = a.generation;
    const b = c.recompute(base({ readyTaskCount: 1 }));
    assert.equal(b.generation, gen);
    const c2 = c.recompute(base({ readyTaskCount: 1, runningAgentCount: 1 }));
    assert.equal(c2.phase, 'waiting_workers');
    assert.equal(c2.generation, gen + 1);
  });

  it('notifies listeners on phase change', () => {
    const c = new SessionRunController();
    let calls = 0;
    c.onChange(() => { calls += 1; });
    c.recompute(base({ isBusyThinking: true }));
    c.recompute(base({ isBusyThinking: true }));
    c.recompute(base({ runningAgentCount: 1 }));
    assert.equal(calls, 2);
  });
});
