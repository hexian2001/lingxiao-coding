import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatRunStateViewModel } from './chatRunStateViewModel.ts';
import type { AgentConversation, AgentRuntime, Message, SessionPhase, SessionRuntimeSnapshot } from '../stores/sessionStoreTypes.ts';

function runtimeSnapshot(patch: Partial<SessionRuntimeSnapshot> = {}): SessionRuntimeSnapshot {
  return {
    sessionId: 's1',
    workspace: '/tmp/work',
    sessionStatus: 'active',
    leader: {
      running: false,
      finished: false,
      waitingForUser: false,
      pendingReview: false,
      planApproved: false,
    },
    pendingUserInput: { kind: 'empty', preview: '' },
    runningWorkers: [],
    runningWorkerCount: 0,
    hasRunningWorkers: false,
    recoveringTaskCount: 0,
    hasRecoveringTasks: false,
    dispatchableTaskCount: 0,
    hasDispatchableTasks: false,
    allTasksTerminal: false,
    eternal: {
      enabled: false,
      status: 'disabled',
      currentPatrolIntervalMs: 0,
      consecutiveIdlePatrols: 0,
      lastPatrolAtMs: 0,
      nextPatrolDueAtMs: 0,
      currentWindowTokens: 0,
      tokenBudgetPerHour: 0,
      windowStartMs: 0,
      consecutiveApiFailures: 0,
      circuitOpenUntilMs: 0,
      totalPatrols: 0,
      silenceLockEngaged: false,
      lastPatrolOutcome: 'never',
      workerCompletionCount: 0,
      patrolInFlight: false,
      lastFingerprintKnown: false,
    },
    ...patch,
  };
}

function runState(input: {
  phase?: SessionPhase;
  agents?: AgentRuntime[];
  messages?: Message[];
  agentConversations?: Record<string, AgentConversation>;
  runtimeSnapshot?: SessionRuntimeSnapshot | null;
}) {
  return buildChatRunStateViewModel({
    phase: input.phase ?? 'idle',
    agents: input.agents ?? [],
    messages: input.messages ?? [],
    agentConversations: input.agentConversations ?? {},
    runtimeSnapshot: input.runtimeSnapshot ?? null,
  });
}

test('buildChatRunStateViewModel uses backend runtime as coarse busy truth', () => {
  const state = runState({
    runtimeSnapshot: runtimeSnapshot({
      leader: {
        running: true,
        finished: false,
        waitingForUser: false,
        pendingReview: false,
        planApproved: false,
      },
    }),
  });

  assert.equal(state.backendBusy, true);
  assert.equal(state.localActivity, false);
  assert.equal(state.active, true);
});

test('buildChatRunStateViewModel keeps local prompt activity before runtime snapshot arrives', () => {
  const preparing = runState({ phase: 'preparing' });
  const streamingMessage = runState({
    messages: [{
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      isStreaming: true,
    }],
  });
  const runningAgent = runState({
    agents: [{
      agentId: 'a1',
      agentName: 'Worker',
      role: 'worker',
      status: 'running',
    }],
  });

  assert.equal(preparing.backendBusy, false);
  assert.equal(preparing.localActivity, true);
  assert.equal(streamingMessage.localActivity, true);
  assert.equal(runningAgent.localActivity, true);
});

test('buildChatRunStateViewModel does not treat waiting-for-user snapshot as backend busy', () => {
  const state = runState({
    runtimeSnapshot: runtimeSnapshot({
      leader: {
        running: true,
        finished: false,
        waitingForUser: true,
        pendingReview: false,
        planApproved: false,
      },
      pendingUserInput: { kind: 'permission_request', preview: 'Approve?' },
    }),
  });

  assert.equal(state.backendBusy, false);
  assert.equal(state.localActivity, false);
  assert.equal(state.active, false);
});

test('buildChatRunStateViewModel tracks open tool activity as local stream residue', () => {
  const state = runState({
    messages: [{
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{
        id: 'tc1',
        tool: 'structured_patch',
        input: {},
        status: 'running',
      }],
    }],
    agentConversations: {
      a1: {
        agentId: 'a1',
        agentName: 'Worker',
        role: 'worker',
        status: 'completed',
        messages: [{
          id: 'am1',
          type: 'tool_call',
          content: '{}',
          timestamp: 2,
          toolStatus: 'streaming_input',
        }],
      },
    },
  });

  assert.equal(state.backendBusy, false);
  assert.equal(state.localActivity, true);
  assert.equal(state.active, true);
});

test('buildChatRunStateViewModel lets an idle runtime snapshot clear stale local streaming residue', () => {
  const state = runState({
    phase: 'streaming',
    runtimeSnapshot: runtimeSnapshot(),
    messages: [{
      id: 'm1',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      isStreaming: true,
      toolCalls: [{
        id: 'tc1',
        tool: 'shell',
        input: {},
        status: 'running',
      }],
    }],
    agents: [{
      agentId: 'a1',
      agentName: 'Worker',
      role: 'worker',
      status: 'running',
    }],
    agentConversations: {
      a1: {
        agentId: 'a1',
        agentName: 'Worker',
        role: 'worker',
        status: 'running',
        messages: [{
          id: 'am1',
          type: 'text',
          content: 'tail',
          timestamp: 2,
          isStreaming: true,
        }],
      },
    },
  });

  assert.equal(state.backendBusy, false);
  assert.equal(state.localActivity, false);
  assert.equal(state.active, false);
});

test('buildChatRunStateViewModel preserves immediate send feedback before backend busy arrives', () => {
  const state = runState({
    phase: 'preparing',
    runtimeSnapshot: runtimeSnapshot(),
  });

  assert.equal(state.backendBusy, false);
  assert.equal(state.localActivity, true);
  assert.equal(state.active, true);
});
