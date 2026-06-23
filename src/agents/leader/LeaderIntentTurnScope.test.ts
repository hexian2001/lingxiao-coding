import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_KEYS } from '../../core/SessionStateKeys.js';
import { LEADER_META_TOOLS } from '../../contracts/constants/leaderToolDefinitions.js';

function makeState() {
  const state = new Map<string, unknown>();
  return {
    getSessionState(_sessionId: string, key: string): unknown | null {
      return state.has(key) ? state.get(key)! : null;
    },
    setSessionState(_sessionId: string, key: string, value: unknown): void {
      state.set(key, value);
    },
    deleteSessionState(_sessionId: string, key: string): void {
      state.delete(key);
    },
    raw: state,
  };
}

function readTurnId(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function shouldExposeRecordCapabilityIntentTool(db: { getSessionState(sessionId: string, key: string): unknown | null }, sessionId: string): boolean {
  const currentTurnId = readTurnId(db.getSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID));
  const recordedTurnId = readTurnId(db.getSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID));
  if (currentTurnId <= 0) return true;
  return recordedTurnId !== currentTurnId;
}

function isToolUseSuppressedForCurrentTurn(db: { getSessionState(sessionId: string, key: string): unknown | null }, sessionId: string): boolean {
  const currentTurnId = readTurnId(db.getSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID));
  const suppressedTurnId = readTurnId(db.getSessionState(sessionId, SESSION_KEYS.TOOL_USE_SUPPRESSION_TURN_ID));
  return currentTurnId > 0 && suppressedTurnId === currentTurnId;
}

function visibleMetaToolNames(db: { getSessionState(sessionId: string, key: string): unknown | null }, sessionId: string): string[] {
  if (isToolUseSuppressedForCurrentTurn(db, sessionId)) return [];
  const metaTools = shouldExposeRecordCapabilityIntentTool(db, sessionId)
    ? LEADER_META_TOOLS
    : LEADER_META_TOOLS.filter((tool) => tool.function.name !== 'record_capability_intent');
  return metaTools.map((tool) => tool.function.name);
}

test('record_capability_intent is exposed before a turn is recorded and hidden afterwards', () => {
  const db = makeState();
  const sessionId = 's-intent';

  db.setSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, 7);
  assert.equal(visibleMetaToolNames(db, sessionId).includes('record_capability_intent'), true);

  db.setSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID, 7);
  assert.equal(visibleMetaToolNames(db, sessionId).includes('record_capability_intent'), false);

  db.setSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, 8);
  assert.equal(visibleMetaToolNames(db, sessionId).includes('record_capability_intent'), true);
});

test('tool-use suppression hides all meta tools for the current turn only', () => {
  const db = makeState();
  const sessionId = 's-no-tools';

  db.setSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, 9);
  db.setSessionState(sessionId, SESSION_KEYS.TOOL_USE_SUPPRESSION_TURN_ID, 9);
  assert.deepEqual(visibleMetaToolNames(db, sessionId), []);

  db.setSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, 10);
  assert.equal(visibleMetaToolNames(db, sessionId).includes('record_capability_intent'), true);
});

test('beginning a new user turn must clear stale intent state and traces', () => {
  const db = makeState();
  const sessionId = 's-intent-clear';

  db.setSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, 2);
  db.setSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_PROFILE, '{"primaryIntent":"implement"}');
  db.setSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID, 2);
  db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_DECISION_TRACE, '{"toolName":"create_task"}');

  const nextTurn = 3;
  db.setSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID, nextTurn);
  db.deleteSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_PROFILE);
  db.deleteSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID);
  db.deleteSessionState(sessionId, SESSION_KEYS.AUTONOMY_DECISION_TRACE);

  assert.equal(db.getSessionState(sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID), 3);
  assert.equal(db.getSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_PROFILE), null);
  assert.equal(db.getSessionState(sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID), null);
  assert.equal(db.getSessionState(sessionId, SESSION_KEYS.AUTONOMY_DECISION_TRACE), null);
});
