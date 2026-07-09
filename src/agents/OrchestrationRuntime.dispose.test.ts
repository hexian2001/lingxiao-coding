/**
 * Dispose / recreate must not stack shared-emitter listeners (H1 / slim AC2).
 * Drives shipped OrchestrationRuntime constructor+dispose — not a reimplementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../core/EventEmitter.js';
import { OrchestrationRuntime } from './OrchestrationRuntime.js';

const TASK_EVENTS = [
  'task:created',
  'task:updated',
  'task:assigned',
  'task:completed',
  'task:failed',
  'task:cancelled',
] as const;

function totalTaskListeners(emitter: EventEmitter): number {
  return TASK_EVENTS.reduce((sum, ev) => sum + emitter.listenerCount(ev as never), 0);
}

describe('OrchestrationRuntime dispose leak guard', () => {
  it('clears all task:* listeners on dispose', () => {
    const emitter = new EventEmitter();
    const baseline = totalTaskListeners(emitter);
    const runtime = new OrchestrationRuntime({
      sessionId: 'dispose-1',
      emitter,
      getTasks: () => [],
    });
    const armed = totalTaskListeners(emitter);
    assert.ok(armed > baseline, 'subscribe must add listeners');
    assert.equal(armed - baseline, TASK_EVENTS.length);

    runtime.dispose();
    assert.equal(totalTaskListeners(emitter), baseline, 'dispose must remove every task listener');
  });

  it('dispose is idempotent', () => {
    const emitter = new EventEmitter();
    const runtime = new OrchestrationRuntime({
      sessionId: 'dispose-idem',
      emitter,
      getTasks: () => [],
    });
    runtime.dispose();
    runtime.dispose();
    assert.equal(totalTaskListeners(emitter), 0);
  });

  it('recreate after dispose does not grow listener counts across cycles', () => {
    const emitter = new EventEmitter();
    let firstCycleCount = 0;

    for (let i = 0; i < 5; i++) {
      const runtime = new OrchestrationRuntime({
        sessionId: `dispose-cycle-${i}`,
        emitter,
        getTasks: () => [],
      });
      const mid = totalTaskListeners(emitter);
      if (i === 0) firstCycleCount = mid;
      else {
        assert.equal(
          mid,
          firstCycleCount,
          `cycle ${i}: listeners must match first cycle (got ${mid}, want ${firstCycleCount})`,
        );
      }
      runtime.dispose();
      assert.equal(totalTaskListeners(emitter), 0, `cycle ${i} dispose must zero listeners`);
    }
  });
});
