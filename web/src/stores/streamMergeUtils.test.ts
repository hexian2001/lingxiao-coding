import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from './sessionStoreTypes.ts';

globalThis.window = {
  location: { search: '' },
  __LINGXIAO_TOKEN__: '',
} as unknown as Window & typeof globalThis;

const utils = await import('./streamMergeUtils.ts');
const {
  applyConnectionStateForResync,
  applyRuntimeSnapshotPatch,
  coerceSessionRuntimeSnapshot,
  createFinalAssistantMessage,
  emptySessionRuntimeState,
  ensureFinalAssistantMessage,
  ensureStreamingAssistantMessage,
  finalizeAssistantMessage,
  shouldMergeAssistantSnapshot,
} = utils;

function assistant(id: string, content: string, patch: Partial<Message> = {}): Message {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 1,
    isStreaming: false,
    retrying: false,
    ...patch,
  };
}

test('leader streaming starts a new assistant after previous final output', () => {
  const first = assistant('a1', 'first answer');
  const { messages, index } = ensureStreamingAssistantMessage([first]);

  assert.equal(messages.length, 2);
  assert.equal(index, 1);
  assert.equal(messages[0].content, 'first answer');
  assert.equal(messages[1].content, '');
  assert.equal(messages[1].isStreaming, true);
});

test('leader final without active draft does not overwrite previous assistant', () => {
  const first = assistant('a1', 'first answer');
  const { messages, index } = ensureFinalAssistantMessage([first]);
  messages[index] = finalizeAssistantMessage(messages[index], 'second answer');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'first answer');
  assert.equal(messages[1].content, 'second answer');
});

test('thinking-only final message is not reused by a later text stream', () => {
  const thinkingOnly = assistant('a1', '', { thinkingContent: 'thoughts' });
  const { messages, index } = ensureStreamingAssistantMessage([thinkingOnly]);

  assert.equal(messages.length, 2);
  assert.equal(index, 1);
  assert.equal(messages[0].thinkingContent, 'thoughts');
});

test('conversation snapshot merges only active drafts or exact duplicates', () => {
  const draft = assistant('draft', 'hel', { isStreaming: true });
  const final = createFinalAssistantMessage('srv-1', 'hello', undefined, undefined, 2);
  assert.equal(shouldMergeAssistantSnapshot(draft, final), true);

  const previousFinal = assistant('a1', 'first answer');
  const nextFinal = createFinalAssistantMessage('srv-2', 'second answer', undefined, undefined, 3);
  assert.equal(shouldMergeAssistantSnapshot(previousFinal, nextFinal), false);

  const duplicate = createFinalAssistantMessage('srv-3', 'first answer', undefined, undefined, 4);
  assert.equal(shouldMergeAssistantSnapshot(previousFinal, duplicate), true);
});

test('runtime snapshot modes default to Solo/manual/yolo/direct when omitted', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    sessionId: 's1',
    workspace: '/repo',
    sessionStatus: 'active',
    leader: { running: false },
    runningWorkers: [],
    eternal: { enabled: false },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.modes.controlMode, 'manual');
  assert.equal(snapshot.modes.permission.mode, 'yolo');
  assert.equal(snapshot.modes.route.mode, 'direct');
  assert.equal(snapshot.modes.route.preference, 'auto');
  assert.equal(snapshot.modes.collaboration.mode, 'solo');
  assert.equal(snapshot.modes.collaboration.teamEnabled, false);
});

test('runtime snapshot modes are preserved and mirrored into local control/permission fields', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      modes: {
        controlMode: 'eternal',
        route: { mode: 'hybrid', preference: 'delegate', source: 'leader', reason: 'large change' },
        collaboration: { mode: 'team', source: 'explicit', activeTeamName: 'alpha', teamEnabled: true },
        workflow: { enabled: true, activeExecutionCount: 2 },
        blackboard: { mode: 'full', source: 'team' },
        permission: { mode: 'networked', summary: 'networked mode' },
      },
      leader: { running: false },
      runningWorkers: [],
      eternal: { enabled: false },
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.modes.controlMode, 'eternal');
  assert.equal(snapshot.modes.route.mode, 'hybrid');
  assert.equal(snapshot.modes.route.preference, 'delegate');
  assert.equal(snapshot.modes.collaboration.mode, 'team');
  assert.equal(snapshot.modes.collaboration.activeTeamName, 'alpha');
  assert.equal(snapshot.modes.workflow.enabled, true);
  assert.equal(snapshot.modes.workflow.activeExecutionCount, 2);
  assert.equal(snapshot.modes.blackboard.mode, 'full');
  assert.equal(snapshot.modes.permission.mode, 'networked');

  const patch = applyRuntimeSnapshotPatch({
    ...emptySessionRuntimeState(),
    sessionId: 's1',
    activeSessionId: 's1',
    sessions: [{ id: 's1', workspace: '/old', status: 'active', createdAt: 1 }],
  } as never, snapshot, true);

  assert.equal(patch.controlMode, 'eternal');
  assert.equal(patch.permissionMode, 'networked');
  assert.equal(patch.runtimeSnapshot?.modes.collaboration.activeTeamName, 'alpha');
});

// 回归:Web 蓝图页不显示内容。根因 coerceSessionModeRuntimeProjection 漏了 blueprint 字段,
// 导致快照补水合时 snapshot.modes.blueprint 恒 undefined → applyRuntimeSnapshotPatch
// 把 store.blueprint 冲回 null(覆盖 leader:blueprint_updated reducer 刚写的值),
// BlueprintView 永远读到 null 停在空态。修复后 coerce 透传 blueprint,两路同源。
test('runtime snapshot preserves project blueprint through coerce and snapshot patch', () => {
  const blueprint = {
    projectType: 'content-platform',
    subsystems: [
      { subsystemId: 'auth', name: '认证', description: '登录', status: 'implement', taskIds: ['T-1'] },
      { subsystemId: 'search', name: '搜索', description: '全文检索', status: 'implement', taskIds: [] },
      { subsystemId: 'billing', name: '计费', description: '订阅计费', status: 'defer', taskIds: [], rationale: '二期' },
    ],
    createdAt: 1,
    updatedAt: 2,
    notes: '小说自动化平台',
  };
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      modes: { controlMode: 'manual', blueprint },
      leader: { running: false },
      runningWorkers: [],
      eternal: { enabled: false },
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.modes.blueprint, blueprint);
  assert.equal(snapshot.modes.blueprint?.projectType, 'content-platform');
  assert.equal(snapshot.modes.blueprint?.subsystems.length, 3);

  const patch = applyRuntimeSnapshotPatch({
    ...emptySessionRuntimeState(),
    sessionId: 's1',
    activeSessionId: 's1',
    sessions: [{ id: 's1', workspace: '/repo', status: 'active', createdAt: 1 }],
  } as never, snapshot, true);

  // 旧码此处恒为 null(快照补水合冲回)→ 蓝图页空态;新码透传保留。
  assert.equal(patch.blueprint, blueprint);
  assert.equal(patch.runtimeSnapshot?.modes.blueprint, blueprint);
});

test('runtime snapshot preserves recovering task details', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      leader: { running: false },
      runningWorkers: [],
      recoveringTasks: [{
        taskId: 'T-9',
        agentName: 'Rex',
        category: 'internal_recoverable',
        faultClass: 'worker_stopped',
        recoveryAction: 'worker_redispatch',
        lastActivityAt: 123,
      }],
      eternal: { enabled: false },
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.recoveringTaskCount, 1);
  assert.equal(snapshot.hasRecoveringTasks, true);
  assert.equal(snapshot.recoveringTasks[0]?.taskId, 'T-9');
  assert.equal(snapshot.recoveringTasks[0]?.faultClass, 'worker_stopped');
});

test('runtime snapshot preserves explicit leader busy for reconnect resync', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      leader: {
        running: true,
        busy: true,
        waitingForUser: false,
      },
      runningWorkers: [],
      runningWorkerCount: 0,
      hasRunningWorkers: false,
      eternal: { enabled: false },
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.leader.busy, true);

  const patch = applyRuntimeSnapshotPatch({
    ...emptySessionRuntimeState(),
    sessionId: 's1',
    activeSessionId: 's1',
    sessions: [{ id: 's1', workspace: '/repo', status: 'active', createdAt: 1 }],
  } as never, snapshot, true);

  assert.equal(patch.phase, 'preparing');
});

// 回归:正常轮次结束后(waiting gate)Web UI 卡在"处理中",要刷新页面才回 idle。
// 根因:applyRuntimeSnapshotPatch 对「存在 wait gate」一律跳过 settleRuntimeIdleResidue,
// 导致纯工具/无文本响应留下的 isStreaming 占位消息永不被清理 → hasOpenSessionWork() 恒真
// → phase 永不回 idle。TUI 不卡是因为它只按快照 runtimeActive 判 idle,不卡逐消息标志。
test('waiting gate at turn-end clears a stale streaming placeholder and returns to idle', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      leader: { running: false, busy: false, waitingForUser: true },
      runningWorkers: [],
      runningWorkerCount: 0,
      hasRunningWorkers: false,
      eternal: { enabled: false },
    },
  });

  assert.ok(snapshot);

  const stale = assistant('a1', '已完成的回复', { isStreaming: true });
  const patch = applyRuntimeSnapshotPatch({
    ...emptySessionRuntimeState(),
    sessionId: '',
    phase: 'streaming',
    messages: [stale],
    sessions: [{ id: 's1', workspace: '/repo', status: 'active', createdAt: 1 }],
  } as never, snapshot, true);

  assert.equal(patch.phase, 'idle');
  assert.equal(patch.messages?.[0].isStreaming, false);
});

// 安全闸:waiting gate 可能隐藏 ask_user(它在压缩后快照里只表现为 leader.waitingForUser)。
// ask_user 的工具调用正在等待用户回答,绝不能被当作陈旧残留取消掉——只清理 isStreaming 显示标志。
test('waiting gate preserves a live open tool call (ask_user) while clearing streaming flag', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      leader: { running: false, busy: false, waitingForUser: true },
      runningWorkers: [],
      runningWorkerCount: 0,
      hasRunningWorkers: false,
      eternal: { enabled: false },
    },
  });

  const withOpenTool = assistant('a1', '', {
    isStreaming: true,
    toolCalls: [{ id: 'tc-ask', tool: 'ask_user', input: { question: '继续吗?' }, status: 'running' }],
  });
  const patch = applyRuntimeSnapshotPatch({
    ...emptySessionRuntimeState(),
    sessionId: '',
    phase: 'streaming',
    messages: [withOpenTool],
    sessions: [{ id: 's1', workspace: '/repo', status: 'active', createdAt: 1 }],
  } as never, snapshot, true);

  // 工具调用保留(未被取消),因此仍有开放工作 → 不进 idle
  assert.equal(patch.messages?.[0].toolCalls?.[0].status, 'running');
  assert.notEqual(patch.phase, 'idle');
  // 但 isStreaming 显示标志已清理
  assert.equal(patch.messages?.[0].isStreaming, false);
});

// 无 gate 时仍按既有行为取消陈旧开放工具调用(本轮真的结束了)。
test('no gate cancels a stale open tool call without result and returns to idle', () => {
  const snapshot = coerceSessionRuntimeSnapshot({
    runtimeState: {
      sessionId: 's1',
      workspace: '/repo',
      sessionStatus: 'active',
      leader: { running: false, busy: false },
      runningWorkers: [],
      runningWorkerCount: 0,
      hasRunningWorkers: false,
      eternal: { enabled: false },
    },
  });

  const withOpenTool = assistant('a1', '', {
    isStreaming: true,
    toolCalls: [{ id: 'tc-stale', tool: 'shell', input: { cmd: 'ls' }, status: 'running' }],
  });
  const patch = applyRuntimeSnapshotPatch({
    ...emptySessionRuntimeState(),
    sessionId: '',
    phase: 'tool_executing',
    messages: [withOpenTool],
    sessions: [{ id: 's1', workspace: '/repo', status: 'active', createdAt: 1 }],
  } as never, snapshot, true);

  assert.equal(patch.messages?.[0].toolCalls?.[0].status, 'cancelled');
  assert.equal(patch.phase, 'idle');
});

// Run a sequence of connection states through the resync reducer, returning the
// list of per-transition resync decisions.
function runResyncSequence(states) {
  let acc = { hasConnectedOnce: false };
  return states.map((state) => {
    const result = applyConnectionStateForResync(acc, state);
    acc = result.acc;
    return result.resync;
  });
}

test('agent-history resync does NOT fire on the initial connect', () => {
  // Initial page load: connecting -> connected. connectToSession already hydrates
  // agent history, so the first 'connected' must not trigger a redundant /agents refetch.
  const decisions = runResyncSequence(['connecting', 'connected']);
  assert.deepEqual(decisions, [false, false]);
});

test('agent-history resync fires after a watchdog reconnect (reconnecting→connecting→connected)', () => {
  // Long session → silent stall → 60s watchdog → reconnect. The intermediate
  // 'connecting' (emitted by AcpClient.startSse) defeated the old
  // `previousState === 'reconnecting'` gate; the accumulator must still fire resync.
  const decisions = runResyncSequence([
    'connecting', 'connected',        // initial connect
    'reconnecting', 'connecting', 'connected', // watchdog reconnect
  ]);
  assert.deepEqual(decisions, [false, false, false, false, true]);
});

test('agent-history resync fires after a visibilitychange reconnect (connecting→connected, no reconnecting)', () => {
  // Backgrounded tab returns to foreground; reconnectHandshake -> connect() emits
  // connecting→connected with NO 'reconnecting' in between. The old gate (which only
  // matched 'reconnecting'/'disconnected') missed this path entirely.
  const decisions = runResyncSequence([
    'connecting', 'connected',        // initial connect
    'connecting', 'connected',        // visibilitychange reconnect (no 'reconnecting')
  ]);
  assert.deepEqual(decisions, [false, false, false, true]);
});

test('agent-history resync accumulator flips exactly once and stays armed for further reconnects', () => {
  const decisions = runResyncSequence([
    'connecting', 'connected',              // initial (no resync)
    'reconnecting', 'connecting', 'connected', // reconnect #1 (resync)
    'disconnected', 'connecting', 'connected', // reconnect #2 (resync)
  ]);
  assert.deepEqual(decisions, [false, false, false, false, true, false, false, true]);
});
