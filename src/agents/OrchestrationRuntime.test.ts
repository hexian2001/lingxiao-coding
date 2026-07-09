/**
 * OrchestrationRuntime G：裸 complete 不自动注入 evaluator；显式 evaluationPolicy 才注入。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../core/EventEmitter.js';
import type { Task } from '../core/TaskBoard.js';
import type { OrchestrationTaskMetadata } from '../core/OrchestrationTypes.js';
import { OrchestrationRuntime } from './OrchestrationRuntime.js';

function makeTask(input: {
  id: string;
  subject: string;
  orchestration?: OrchestrationTaskMetadata;
}): Task {
  return {
    id: input.id,
    session_id: 'sess-test',
    subject: input.subject,
    description: '',
    status: 'terminal',
    exitReason: 'completed',
    runGeneration: 0,
    agent_type: 'general',
    blocked_by: [],
    blocks: [],
    assigned_agent: '',
    working_directory: '/tmp',
    write_scope: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    orchestration: input.orchestration,
  };
}

describe('OrchestrationRuntime bare complete policy (G)', () => {
  it('does not create evaluator on bare complete without orchestrationRunId or evaluationPolicy', async () => {
    const followups: Array<{ subject: string; agentType: string }> = [];
    const emitter = new EventEmitter();
    const task = makeTask({
      id: 't-bare',
      subject: 'simple fix',
      orchestration: {
        nodeKind: 'implement',
        generation: 0,
        verdict: 'UNKNOWN',
      },
    });

    const runtime = new OrchestrationRuntime({
      sessionId: 'sess-bare',
      emitter,
      getTasks: () => [task],
      createFollowupTask: (input) => {
        followups.push({ subject: input.subject, agentType: input.agentType });
        return `follow-${followups.length}`;
      },
    });

    const result = await runtime.handleTaskResult(task, 'completed', { summary: 'done' });
    assert.equal(result.handled, false);
    assert.equal(result.accepted, true);
    assert.equal(followups.length, 0, 'bare complete must not auto-spawn evaluator');
    assert.equal(task.orchestration?.orchestrationRunId, undefined);
  });

  it('does not create evaluator when orchestration is entirely missing', async () => {
    const followups: string[] = [];
    const emitter = new EventEmitter();
    const task = makeTask({ id: 't-none', subject: 'no orch' });

    const runtime = new OrchestrationRuntime({
      sessionId: 'sess-none',
      emitter,
      getTasks: () => [task],
      createFollowupTask: (input) => {
        followups.push(input.subject);
        return 'f1';
      },
    });

    const result = await runtime.handleTaskResult(task, 'completed', 'ok');
    assert.equal(result.handled, false);
    assert.equal(result.accepted, true);
    assert.equal(followups.length, 0);
  });

  it('injects evaluator when evaluationPolicy is explicit even without prior runId', async () => {
    const followups: Array<{ agentType: string; nodeKind?: string }> = [];
    const emitter = new EventEmitter();
    const task = makeTask({
      id: 't-policy',
      subject: 'needs review',
      orchestration: {
        nodeKind: 'implement',
        generation: 0,
        verdict: 'UNKNOWN',
        evaluationPolicy: {
          required_evidence: ['diff'],
          critical_gates: [],
          max_repair: 1,
        },
      },
    });

    const runtime = new OrchestrationRuntime({
      sessionId: 'sess-policy',
      emitter,
      getTasks: () => [task],
      createFollowupTask: (input) => {
        followups.push({
          agentType: input.agentType,
          nodeKind: input.orchestration?.nodeKind,
        });
        return `eval-${followups.length}`;
      },
    });

    const result = await runtime.handleTaskResult(task, 'completed', { summary: 'impl done' });
    assert.equal(result.handled, false);
    assert.equal(result.accepted, true);
    assert.ok(task.orchestration?.orchestrationRunId?.startsWith('auto-orch-'));
    assert.equal(followups.length, 1);
    assert.equal(followups[0]!.agentType, 'verify');
    assert.equal(followups[0]!.nodeKind, 'evaluate');
  });
});
