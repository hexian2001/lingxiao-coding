/**
 * ToolFailureLoopGuard 单元测试
 *
 * 覆盖：key 计算、errorKind 分类、计数+熔断、状态类错误升级、reset/emitter。
 * 用 node:test（与项目 scripts/run-tests.mjs 风格一致），不依赖 vitest。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, type EventMap } from '../../core/EventEmitter.js';
import {
  ToolFailureLoopGuard,
  classifyToolFailure,
  getToolFailureLoopGuard,
  resetToolFailureLoopGuard,
  STATE_ERROR_KINDS,
} from './ToolFailureLoopGuard.js';

describe('ToolFailureLoopGuard', () => {
  it('classifies errorKind by errorCode', () => {
    assert.equal(classifyToolFailure('PERMISSION_REQUIRED', '需要 dev 权限'), 'permission');
    assert.equal(classifyToolFailure('MODE_TOOL_FORBIDDEN', 'office 模式禁止'), 'mode');
    assert.equal(classifyToolFailure('WRITE_SCOPE_FORBIDDEN', '出 scope'), 'write_scope');
    assert.equal(classifyToolFailure('SANDBOX_BLOCKED', '沙盒拦截'), 'sandbox');
    assert.equal(classifyToolFailure('NETWORK_FORBIDDEN', '网络禁止'), 'network');
    assert.equal(classifyToolFailure('TOOL_ARGUMENT_VALIDATION_FAILED', '参数错'), 'schema');
    assert.equal(classifyToolFailure('FILE_MUST_BE_READ_FIRST', '需要先 file_read'), 'precondition');
    assert.equal(classifyToolFailure('TOOL_TIMEOUT', '超时'), 'timeout');
    assert.equal(classifyToolFailure('UNKNOWN_CODE', '任意错误'), 'other');
  });

  it('STATE_ERROR_KINDS contains stateful errors', () => {
    assert.equal(STATE_ERROR_KINDS.has('permission'), true);
    assert.equal(STATE_ERROR_KINDS.has('mode'), true);
    assert.equal(STATE_ERROR_KINDS.has('execution'), false);
    assert.equal(STATE_ERROR_KINDS.has('precondition'), false);
    assert.equal(STATE_ERROR_KINDS.has('other'), false);
  });

  it('trips after threshold=3 on same key', () => {
    const guard = new ToolFailureLoopGuard({ threshold: 3 });
    const base = { sessionId: 's1', agentId: 'a1', agentName: 'A1', toolName: 'shell', args: { cmd: 'ls' }, errorCode: 'PERMISSION_REQUIRED', errorMessage: '需要权限' };

    const d1 = guard.record(base);
    const d2 = guard.record(base);
    const d3 = guard.record(base);

    assert.equal(d1.tripped, false);
    assert.equal(d1.count, 1);
    assert.equal(d1.requiresEscalation, true);

    assert.equal(d2.tripped, false);
    assert.equal(d2.count, 2);

    assert.equal(d3.tripped, true);
    assert.equal(d3.count, 3);
    assert.equal(d3.requiresEscalation, true);
  });

  it('different argsHash keeps counts separate', () => {
    const guard = new ToolFailureLoopGuard({ threshold: 2 });
    const base = { sessionId: 's1', agentId: 'a1', agentName: 'A1', toolName: 'shell', errorCode: 'PERMISSION_REQUIRED', errorMessage: '需要权限' };

    const d1 = guard.record({ ...base, args: { cmd: 'ls' } });
    const d2 = guard.record({ ...base, args: { cmd: 'ls' } });
    const d3 = guard.record({ ...base, args: { cmd: 'pwd' } });

    assert.equal(d1.count, 1);
    assert.equal(d2.tripped, true);
    assert.equal(d2.count, 2);
    assert.equal(d3.count, 1);
    assert.equal(d3.tripped, false);
  });

  it('different errorKind keeps counts separate', () => {
    const guard = new ToolFailureLoopGuard({ threshold: 2 });
    const base = { sessionId: 's1', agentId: 'a1', agentName: 'A1', toolName: 'shell', args: { cmd: 'ls' }, errorMessage: '' };

    const d1 = guard.record({ ...base, errorCode: 'PERMISSION_REQUIRED' });
    const d2 = guard.record({ ...base, errorCode: 'PERMISSION_REQUIRED' });
    const d3 = guard.record({ ...base, errorCode: 'TOOL_TIMEOUT' });

    assert.equal(d1.count, 1);
    assert.equal(d2.tripped, true);
    assert.equal(d3.count, 1);
    assert.equal(d3.tripped, false);
    assert.equal(d3.errorKind, 'timeout');
  });

  it('does not trip guided precondition failures such as FILE_MUST_BE_READ_FIRST', () => {
    const guard = new ToolFailureLoopGuard({ threshold: 3 });
    const base = {
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'A1',
      toolName: 'structured_patch',
      args: { path: 'src/example.ts', hunks: [{ search: 'a', replace: 'b' }], dry_run: false },
      errorCode: 'FILE_MUST_BE_READ_FIRST',
      errorMessage: '编辑前必须 file_read。LLM_RECOVERY={"next_tool":{"name":"file_read"}}',
    };

    let last = guard.record(base);
    last = guard.record(base);
    last = guard.record(base);
    last = guard.record(base);

    assert.equal(last.errorKind, 'precondition');
    assert.equal(last.count, 4);
    assert.equal(last.tripped, false, '前置条件错误应保留原始 next_tool 指引，不应被熔断替换');
    assert.equal(last.requiresEscalation, false);
    assert.equal(guard.countTripped('s1'), 0);
  });

  it('emits agent:tool_failure_loop event on trip', () => {
    const emitter = new EventEmitter();
    const guard = new ToolFailureLoopGuard({ threshold: 2 }, emitter);
    const received: EventMap['agent:tool_failure_loop'][] = [];
    emitter.on('agent:tool_failure_loop', (data) => { received.push(data); });

    const base = { sessionId: 's1', agentId: 'a1', agentName: 'A1', toolName: 'shell', args: { cmd: 'ls' }, errorCode: 'MODE_TOOL_FORBIDDEN', errorMessage: 'office 模式禁止' };
    guard.record(base);
    guard.record(base);

    const event = received[0];
    assert.ok(event);
    assert.equal(event.requiresEscalation, true);
    assert.equal(event.count, 2);
    assert.equal(event.signature.errorKind, 'mode');
  });

  it('subsequent failures after trip return tripped=true without re-emitting', () => {
    const emitter = new EventEmitter();
    const guard = new ToolFailureLoopGuard({ threshold: 1 }, emitter);
    let emitCount = 0;
    emitter.on('agent:tool_failure_loop', () => { emitCount += 1; });

    const base = { sessionId: 's1', agentId: 'a1', agentName: 'A1', toolName: 'shell', args: { cmd: 'ls' }, errorCode: 'PERMISSION_REQUIRED', errorMessage: '需要权限' };
    guard.record(base);
    guard.record(base);
    guard.record(base);

    assert.equal(emitCount, 1);
  });

  it('clearOnSuccess wipes matching records', () => {
    const guard = new ToolFailureLoopGuard({ threshold: 2 });
    const base = { sessionId: 's1', agentId: 'a1', agentName: 'A1', toolName: 'shell', args: { cmd: 'ls' }, errorCode: 'PERMISSION_REQUIRED', errorMessage: '' };

    guard.record(base);
    guard.record(base);
    assert.equal(guard.countTripped('s1'), 1);

    guard.clearOnSuccess('s1', 'shell', { cmd: 'ls' });
    assert.equal(guard.countTripped('s1'), 0);
  });

  it('snapshot returns records per session', () => {
    const guard = new ToolFailureLoopGuard({ threshold: 5 });
    const base = { sessionId: 'sX', agentId: 'a1', agentName: 'A1', args: { cmd: 'ls' }, errorCode: 'PERMISSION_REQUIRED', errorMessage: '' };

    guard.record({ ...base, toolName: 'shell' });
    guard.record({ ...base, toolName: 'file_read', args: { path: 'a.ts' } });

    const snap = guard.snapshot('sX');
    assert.equal(snap.length, 2);
  });

  it('global singleton returns same instance', () => {
    resetToolFailureLoopGuard();
    const g1 = getToolFailureLoopGuard();
    const g2 = getToolFailureLoopGuard();
    assert.equal(g1, g2);
  });
});
