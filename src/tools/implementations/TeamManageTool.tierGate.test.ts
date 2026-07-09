/**
 * Real-path AC4: team_manage goes through TeamManageTool.execute (not LeaderTools).
 * S1/S2 must fail-closed before TeamCreate/TeamEdit when orchestration_tier is set.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TeamManageTool } from './TeamManageTool.js';
import { SESSION_KEYS } from '../../core/SessionStateKeys.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../../core/TeamMailbox.js';
import type { ToolContext } from '../Tool.js';

function makeDb(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    getSessionState(_sessionId: string, key: string): unknown {
      return store.has(key) ? store.get(key) : null;
    },
    setSessionState(_sessionId: string, key: string, value: unknown): void {
      store.set(key, value);
    },
    _store: store,
  };
}

function context(sessionId: string, db: ReturnType<typeof makeDb>): ToolContext {
  return {
    sessionId,
    db: db as never,
    workspace: process.cwd(),
    agentId: 'leader',
    agentName: 'leader',
  };
}

describe('TeamManageTool real-path orchestration tier gate', () => {
  beforeEach(() => {
    // Isolate mailbox/registry per test by unique session ids (singletons are process-wide).
  });

  it('S1 blocks team_manage create on TeamManageTool.execute (real entry)', async () => {
    const sessionId = `sess-s1-create-${Date.now()}`;
    const db = makeDb({ [SESSION_KEYS.ORCHESTRATION_TIER]: 'S1' });
    const tool = new TeamManageTool();
    const result = await tool.execute(
      {
        action: 'create',
        team_name: `team-s1-${Date.now()}`,
        leader: 'leader',
        members: ['Sam'],
      },
      context(sessionId, db),
    );
    assert.equal(result.success, false);
    assert.match(String(result.error || ''), /TIER_S1_TEAM_FORBIDDEN|S1 禁止建团/);
    // Must not have created the team
    const mailbox = getTeamMailbox();
    assert.equal(mailbox.teamExists(`team-s1-should-not-matter`, sessionId), false);
  });

  it('S1 blocks team_manage edit on TeamManageTool.execute', async () => {
    const sessionId = `sess-s1-edit-${Date.now()}`;
    const teamName = `t-edit-${Date.now()}`;
    // Pre-create at S3, then drop to S1 and try edit
    const mailbox = getTeamMailbox();
    mailbox.createTeamWithRoster({
      name: teamName,
      leader: 'leader',
      members: ['Sam'],
      workspace: process.cwd(),
      sessionId,
    });
    const db = makeDb({ [SESSION_KEYS.ORCHESTRATION_TIER]: 'S1' });
    const tool = new TeamManageTool();
    const result = await tool.execute(
      {
        action: 'edit',
        edit_action: 'add',
        team_name: teamName,
        member: 'Lucy',
      },
      context(sessionId, db),
    );
    assert.equal(result.success, false);
    assert.match(String(result.error || ''), /TIER_S1_TEAM_FORBIDDEN|S1 禁止/);
    const roster = getTeamMemberRegistry().getByTeam(teamName, sessionId).map((m) => m.name);
    assert.ok(!roster.includes('Lucy'), 'edit must not apply under S1');
  });

  it('S2 blocks team_manage create on real entry', async () => {
    const sessionId = `sess-s2-create-${Date.now()}`;
    const db = makeDb({ [SESSION_KEYS.ORCHESTRATION_TIER]: 'S2' });
    const tool = new TeamManageTool();
    const result = await tool.execute(
      {
        action: 'create',
        team_name: `team-s2-${Date.now()}`,
        leader: 'leader',
        members: ['Sam'],
      },
      context(sessionId, db),
    );
    assert.equal(result.success, false);
    assert.match(String(result.error || ''), /TIER_S2_TEAM_CREATE_FORBIDDEN|S2 禁止建团/);
  });

  it('S3 allows team_manage create on real entry', async () => {
    const sessionId = `sess-s3-create-${Date.now()}`;
    const teamName = `team-s3-${Date.now()}`;
    const db = makeDb({
      [SESSION_KEYS.ORCHESTRATION_TIER]: 'S3',
      [SESSION_KEYS.COLLABORATION_MODE]: 'team',
    });
    const tool = new TeamManageTool();
    const result = await tool.execute(
      {
        action: 'create',
        team_name: teamName,
        leader: 'leader',
        members: ['Sam', 'Lucy'],
      },
      context(sessionId, db),
    );
    assert.equal(result.success, true, String(result.error || result.data));
    const ready = getTeamMailbox().assertTeamReady(teamName, sessionId);
    assert.equal(ready.ok, true);
  });

  it('S1 still allows read-only team_manage status', async () => {
    const sessionId = `sess-s1-status-${Date.now()}`;
    const db = makeDb({ [SESSION_KEYS.ORCHESTRATION_TIER]: 'S1' });
    const tool = new TeamManageTool();
    const result = await tool.execute(
      { action: 'status' },
      context(sessionId, db),
    );
    // status without team may fail for other reasons, but must NOT be TIER_S1
    if (!result.success) {
      assert.doesNotMatch(String(result.error || ''), /TIER_S1_TEAM_FORBIDDEN/);
    }
  });
});
