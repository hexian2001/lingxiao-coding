/**
 * AgentHealthMonitor start/stop on shared emitter — no listener stacking across recreate.
 * Drives shipped start() / stop() (the path LeaderAgent.dispose calls via healthMonitor.stop).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from './EventEmitter.js';
import { AgentHealthMonitor } from './AgentHealthMonitor.js';

describe('AgentHealthMonitor dispose / stop leak guard', () => {
  it('stop clears poll timer and event listeners; recreate does not stack', () => {
    const emitter = new EventEmitter();
    const reports: number[] = [];

    const make = () => new AgentHealthMonitor(
      emitter,
      () => { reports.push(Date.now()); },
      { pollIntervalMs: 60_000, eventDebounceMs: 5_000 },
    );

    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const mon = make();
      mon.start();
      // Sample a few agent events the monitor subscribes to
      const mid =
        emitter.listenerCount('agent:tool_call' as never)
        + emitter.listenerCount('agent:completed' as never)
        + emitter.listenerCount('agent:failed' as never)
        + emitter.listenerCount('agent:heartbeat' as never);
      counts.push(mid);
      mon.stop();
      const after =
        emitter.listenerCount('agent:tool_call' as never)
        + emitter.listenerCount('agent:completed' as never)
        + emitter.listenerCount('agent:failed' as never)
        + emitter.listenerCount('agent:heartbeat' as never);
      assert.equal(after, 0, `cycle ${i}: stop must clear agent listeners`);
    }

    assert.ok(counts[0]! > 0, 'start must subscribe agent events');
    for (let i = 1; i < counts.length; i++) {
      assert.equal(counts[i], counts[0], `cycle ${i} listener count must match first start`);
    }
  });

  it('start is idempotent (no double-subscribe without stop)', () => {
    const emitter = new EventEmitter();
    const mon = new AgentHealthMonitor(emitter, () => {}, { pollIntervalMs: 60_000 });
    mon.start();
    const n1 =
      emitter.listenerCount('agent:tool_call' as never)
      + emitter.listenerCount('agent:completed' as never);
    mon.start();
    mon.start();
    const n2 =
      emitter.listenerCount('agent:tool_call' as never)
      + emitter.listenerCount('agent:completed' as never);
    assert.equal(n2, n1, 'repeat start must not stack listeners');
    mon.stop();
    assert.equal(
      emitter.listenerCount('agent:tool_call' as never)
      + emitter.listenerCount('agent:completed' as never),
      0,
    );
  });
});
