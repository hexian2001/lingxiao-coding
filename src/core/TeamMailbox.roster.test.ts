/**
 * Team roster 对齐（E）：assertTeamReady 语义单测（纯内存，无 DB）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTeamMailbox,
  getTeamMemberRegistry,
  resetTeamMailboxForTesting,
} from './TeamMailbox.js';

describe('TeamMailbox roster alignment', () => {
  beforeEach(() => {
    resetTeamMailboxForTesting();
  });

  it('createTeamWithRoster registers leader and members atomically', () => {
    const mailbox = getTeamMailbox();
    const def = mailbox.createTeamWithRoster({
      name: 't1',
      leader: 'leader',
      members: ['fe', 'be'],
      workspace: '/tmp/ws',
      sessionId: 'sess-1',
    });
    assert.equal(def.name, 't1');
    const ready = mailbox.assertTeamReady('t1', 'sess-1');
    assert.equal(ready.ok, true);
    if (ready.ok) {
      assert.ok(ready.roster.includes('leader'));
      assert.ok(ready.roster.includes('fe'));
      assert.ok(ready.roster.includes('be'));
    }
  });

  it('assertTeamReady fails when registry missing member', () => {
    const mailbox = getTeamMailbox();
    mailbox.createTeam({
      name: 't2',
      leader: 'leader',
      members: ['fe'],
      workspace: '/tmp/ws',
      sessionId: 'sess-2',
    });
    // only register leader — fe missing
    getTeamMemberRegistry().register({
      name: 'leader',
      team: 't2',
      role: 'leader',
      workspace: '/tmp/ws',
      sessionId: 'sess-2',
    });
    const ready = mailbox.assertTeamReady('t2', 'sess-2');
    assert.equal(ready.ok, false);
    if (!ready.ok) {
      assert.match(ready.message, /fe/);
    }
  });
});
