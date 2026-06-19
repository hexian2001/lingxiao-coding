/**
 * #4 回归:blackboardStore 单例不能跨整会话无限增长。
 *
 * 主修复 = subscribed 门控(GraphView 未挂载时 applyDelta 不累积)+ 确定性上限(节点 500/边 1000,
 * 按 createdAt 降序保留最新)+ reset 清图但保留 subscribed。
 *
 * 运行:`npx tsx --test web/src/stores/blackboardStore.test.ts`(web store 测试不走 dist 管线)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// headers.ts 在 import 时读取 window(从 URL 解析 token);Node 下需先 polyfill 再动态导入 store。
// 静态 import 会被提升,故用动态 import 确保赋值先生效。
(globalThis as any).window = { location: { search: '' } };

const { useBlackboardStore } = await import('./blackboardStore.ts');

function resetStore(): void {
  const s = useBlackboardStore.getState();
  s.setSubscribed(false);
  s.reset();
}

function mkNode(id: string, createdAt: number) {
  return { id, kind: 'fact' as const, title: 't', content: 'c', tags: [], createdBy: 'a', createdAt };
}
function mkEdge(id: string, createdAt: number) {
  return { id, fromNodeId: 'a', toNodeId: 'b', edgeType: 'rel', createdAt, createdBy: 'a' };
}

test('applyDelta 未订阅时不累积(GraphView 未挂载——#4 主修复)', () => {
  resetStore();
  const { applyDelta } = useBlackboardStore.getState();
  applyDelta({ changedNodes: [mkNode('n1', 1)], changedEdges: [] });
  applyDelta({ changedNodes: [mkNode('n2', 2)], changedEdges: [] });
  assert.equal(useBlackboardStore.getState().nodes.length, 0);
});

test('applyDelta 订阅后正常累积', () => {
  resetStore();
  const { setSubscribed, applyDelta } = useBlackboardStore.getState();
  setSubscribed(true);
  applyDelta({ changedNodes: [mkNode('n1', 1)], changedEdges: [] });
  applyDelta({ changedNodes: [mkNode('n2', 2)], changedEdges: [] });
  assert.equal(useBlackboardStore.getState().nodes.length, 2);
});

test('applyDelta 节点超 500 按 createdAt 降序裁剪(保留最新,淘汰被取代的旧版本)', () => {
  resetStore();
  const { setSubscribed, applyDelta } = useBlackboardStore.getState();
  setSubscribed(true);
  const big = Array.from({ length: 600 }, (_, i) => mkNode('x' + i, i));
  applyDelta({ changedNodes: big, changedEdges: [] });
  const ns = useBlackboardStore.getState().nodes;
  assert.equal(ns.length, 500);
  const maxCreatedAt = Math.max(...ns.map((n) => n.createdAt));
  assert.equal(maxCreatedAt, 599, '应保留 createdAt 最大的 500 个');
});

test('applyDelta 边超 1000 裁剪', () => {
  resetStore();
  const { setSubscribed, applyDelta } = useBlackboardStore.getState();
  setSubscribed(true);
  const big = Array.from({ length: 1200 }, (_, i) => mkEdge('e' + i, i));
  applyDelta({ changedNodes: [], changedEdges: big });
  assert.equal(useBlackboardStore.getState().edges.length, 1000);
});

test('reset 清空图数据但保留 subscribed(视图生命周期标志不随会话切换复位)', () => {
  resetStore();
  const { setSubscribed, applyDelta } = useBlackboardStore.getState();
  setSubscribed(true);
  applyDelta({ changedNodes: [mkNode('n1', 1)], changedEdges: [] });
  assert.equal(useBlackboardStore.getState().nodes.length, 1);
  useBlackboardStore.getState().reset();
  assert.equal(useBlackboardStore.getState().nodes.length, 0);
  assert.equal(useBlackboardStore.getState().subscribed, true, 'reset 不应复位 subscribed');
});

test('setSubscribed 切换门控', () => {
  resetStore();
  const st = useBlackboardStore.getState();
  st.setSubscribed(true);
  assert.equal(useBlackboardStore.getState().subscribed, true);
  st.setSubscribed(false);
  assert.equal(useBlackboardStore.getState().subscribed, false);
});
