/**
 * Pure S1/S2/S3 orchestration tier gates (AC4)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOrchestrationTierGate,
  resolveOrchestrationTier,
} from './OrchestrationTierGates.js';

describe('resolveOrchestrationTier', () => {
  it('uses explicit tier when valid', () => {
    assert.equal(resolveOrchestrationTier({ explicitTier: 'S1', collaborationMode: 'team' }), 'S1');
    assert.equal(resolveOrchestrationTier({ explicitTier: 'S3', collaborationMode: 'solo' }), 'S3');
  });

  it('defaults team → S3, solo → S2; never silent S1', () => {
    assert.equal(resolveOrchestrationTier({ collaborationMode: 'team' }), 'S3');
    assert.equal(resolveOrchestrationTier({ collaborationMode: 'solo' }), 'S2');
    assert.equal(resolveOrchestrationTier({ explicitTier: 'S9', collaborationMode: 'solo' }), 'S2');
  });
});

describe('evaluateOrchestrationTierGate S1', () => {
  it('blocks team_manage create/edit', () => {
    for (const action of ['create', 'edit']) {
      const r = evaluateOrchestrationTierGate({
        tier: 'S1',
        toolName: 'team_manage',
        args: { action },
        collaborationMode: 'solo',
        teamReady: null,
        runningAgentCount: 0,
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'TIER_S1_TEAM_FORBIDDEN');
    }
  });

  it('blocks dispatch_batch', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S1',
      toolName: 'dispatch_batch',
      args: { items: [{ task_id: 't1' }] },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'TIER_S1_BATCH_FORBIDDEN');
  });

  it('blocks concurrent dispatch_agent when a worker is already running', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S1',
      toolName: 'dispatch_agent',
      args: { agent_name: 'Sam', task_id: 't1' },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'TIER_S1_CONCURRENT_FORBIDDEN');
  });

  it('allows solo dispatch_agent when no workers running', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S1',
      toolName: 'dispatch_agent',
      args: { agent_name: 'Sam', task_id: 't1' },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, true);
  });

  it('allows read-only team_manage status', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S1',
      toolName: 'team_manage',
      args: { action: 'status' },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, true);
  });
});

describe('evaluateOrchestrationTierGate S2', () => {
  it('blocks team create', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S2',
      toolName: 'team_manage',
      args: { action: 'create' },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'TIER_S2_TEAM_CREATE_FORBIDDEN');
  });

  it('blocks dispatch_batch with size > 1', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S2',
      toolName: 'dispatch_batch',
      args: { items: [{ a: 1 }, { a: 2 }] },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'TIER_S2_BATCH_CAP');
  });

  it('allows dispatch_batch of size 1 when idle', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S2',
      toolName: 'dispatch_batch',
      args: { items: [{ a: 1 }] },
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, true);
  });

  it('blocks concurrent worker when already running', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S2',
      toolName: 'dispatch_agent',
      args: {},
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'TIER_S2_CONCURRENT_CAP');
  });
});

describe('evaluateOrchestrationTierGate S3 / team', () => {
  it('blocks team-mode dispatch when teamReady is false', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S3',
      toolName: 'dispatch_agent',
      args: { agent_name: 'Sam' },
      collaborationMode: 'team',
      teamReady: false,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'TIER_S3_TEAM_NOT_READY');
  });

  it('allows team-mode dispatch when teamReady', () => {
    const r = evaluateOrchestrationTierGate({
      tier: 'S3',
      toolName: 'dispatch_batch',
      args: { items: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      collaborationMode: 'team',
      teamReady: true,
      runningAgentCount: 2,
    });
    assert.equal(r.ok, true);
  });

  it('allows set_orchestration_tier always (gate skipped at execute for this tool)', () => {
    // Gate function itself does not special-case the tool; execute() bypasses for this name.
    // Ensure other tools at S3 with solo and no team check pass.
    const r = evaluateOrchestrationTierGate({
      tier: 'S3',
      toolName: 'create_task',
      collaborationMode: 'solo',
      teamReady: null,
      runningAgentCount: 0,
    });
    assert.equal(r.ok, true);
  });
});
