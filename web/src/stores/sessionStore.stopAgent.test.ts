/**
 * 回归:stopAgent store action 发 DELETE /api/v1/workers/:id(带 server token),
 * 并乐观把目标 Agent 置为 interrupted,不动其它 Agent。
 *
 * 运行:`npx tsx --test web/src/stores/sessionStore.stopAgent.test.ts`(web store 测试不走 dist 管线)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// headers.ts 在 import 时读 window;Node 下需先 polyfill 再动态导入 store。
(globalThis as any).window = { location: { search: '' }, __LINGXIAO_TOKEN__: 'test-token' };

const { useSessionStore } = await import('./sessionStore.ts');

type FetchCall = { url: string; method?: string; headers?: Record<string, string> };

function mockFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    return { ok: true, json: async () => ({ success: true }) };
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

function seedAgents(): void {
  useSessionStore.setState({
    sessionId: 'sess-1',
    agents: [
      { agentId: 'agent-rex', agentName: 'Rex', role: 'coding', status: 'running', spawnedAt: 1 },
      { agentId: 'agent-dino', agentName: 'Dino', role: 'coding', status: 'completed', spawnedAt: 2 },
    ],
  });
}

test('stopAgent 发 DELETE /api/v1/workers/:id 并带 server token', async () => {
  seedAgents();
  const { calls, restore } = mockFetch();
  try {
    await useSessionStore.getState().stopAgent('agent-rex');
  } finally {
    restore();
  }

  const stopCall = calls.find((c) => c.method === 'DELETE');
  assert.ok(stopCall, '应发起一次 DELETE');
  assert.equal(stopCall!.url, '/api/v1/workers/agent-rex');
  assert.equal(stopCall!.headers?.['x-lingxiao-token'], 'test-token', '必须携带 server token');
});

test('stopAgent 乐观置目标 Agent 为 interrupted,不动其它 Agent', async () => {
  seedAgents();
  const { restore } = mockFetch();
  try {
    await useSessionStore.getState().stopAgent('agent-rex');
  } finally {
    restore();
  }

  const agents = useSessionStore.getState().agents;
  const rex = agents.find((a) => a.agentId === 'agent-rex');
  const dino = agents.find((a) => a.agentId === 'agent-dino');
  assert.equal(rex?.status, 'interrupted', 'Rex 应被乐观置为 interrupted');
  assert.equal(dino?.status, 'completed', 'Dino 不受影响');
});

test('stopAgent 无 sessionId 时直接返回不发请求', async () => {
  useSessionStore.setState({ sessionId: null, agents: [{ agentId: 'a', agentName: 'A', role: 'coding', status: 'running', spawnedAt: 1 }] });
  const { calls, restore } = mockFetch();
  try {
    await useSessionStore.getState().stopAgent('a');
  } finally {
    restore();
  }
  assert.equal(calls.length, 0, '无 sessionId 时不应发起任何请求');
});
