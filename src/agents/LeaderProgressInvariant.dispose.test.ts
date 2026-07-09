/**
 * ProgressInvariant dispose clears watchdog timer (path used by LeaderAgent.dispose).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../core/EventEmitter.js';
import { LeaderProgressInvariant } from './LeaderProgressInvariant.js';

function makeInvariant(): LeaderProgressInvariant {
  const emitter = new EventEmitter();
  // Minimal deps — dispose only needs stopWatchdog + eternal bindings
  return new LeaderProgressInvariant({
    sessionId: 'pi-dispose',
    db: {
      getSessionState: () => null,
      setSessionState: () => {},
    } as never,
    emitter,
    board: {
      getAllTasks: () => [],
      getReadyTasks: () => [],
      getDispatchable: () => [],
      allTerminal: () => true,
    } as never,
    pool: {
      getRunning: () => [],
      getStagnantAgents: () => [],
    } as never,
    isFinished: () => false,
    isWaitingForUser: () => false,
    isPendingReview: () => false,
    isEternalMode: () => false,
    isLeaderRunning: () => false,
    getConversation: () => [],
    getConversationLength: () => 0,
    addAndPersistMessage: async () => {},
    leaderThinkAndAct: async () => {},
    setWaitingForUser: async () => {},
    recordTokenUsage: () => {},
  });
}

describe('LeaderProgressInvariant dispose', () => {
  it('startWatchdog then dispose clears the interval', () => {
    const inv = makeInvariant();
    inv.startWatchdog();
    assert.equal(inv.isWatchdogRunning(), true);
    inv.dispose();
    assert.equal(inv.isWatchdogRunning(), false);
  });

  it('dispose is idempotent and safe without start', () => {
    const inv = makeInvariant();
    assert.equal(inv.isWatchdogRunning(), false);
    inv.dispose();
    inv.dispose();
    assert.equal(inv.isWatchdogRunning(), false);
  });
});
