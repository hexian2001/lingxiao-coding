import type { MessageBus } from '../../core/MessageBus.js';
import type { TaskBoard } from '../../core/TaskBoard.js';
import { buildBlackboardNodeAwarenessBlock, buildWorkNoteAwarenessBlock } from '../../core/ArtifactAwareness.js';
import type { BlackboardDelta } from '../../core/blackboard/types.js';
import { isGlobalBroadcastNode } from '../../core/blackboard/types.js';
import type { WorkNote } from '../../core/WorkNoteManager.js';
import type { AgentHandle } from '../AgentPoolRuntime.js';

export function getHandleTaskTags(handle: AgentHandle, taskBoard: TaskBoard): Set<string> {
  const tags = new Set<string>();
  if (handle.roleType) tags.add(handle.roleType);
  if (handle.taskId) {
    tags.add(handle.taskId);
    const prefix = handle.taskId.split('-')[0];
    if (prefix) tags.add(prefix);
  }
  const task = handle.taskId ? taskBoard.getTask(handle.taskId) : undefined;
  if (task) {
    tags.add(task.agent_type);
  }
  return tags;
}

export function formatBlackboardDeltaMessage(delta: BlackboardDelta): string {
  const lines: string[] = [
    '### 黑板增量更新（系统自动注入）',
    '',
    `**事件**：${delta.humanSummary}`,
  ];
  if (delta.changedNodes.length > 0) {
    lines.push('', '**变更节点**：');
    for (const node of delta.changedNodes) {
      lines.push(`- [${node.kind}] **${node.title}**: ${node.content}`);
    }
    const awarenessBlocks = delta.changedNodes
      .map((node) => buildBlackboardNodeAwarenessBlock(node))
      .filter((block) => block.trim().length > 0);
    if (awarenessBlocks.length > 0) {
      lines.push('', '### 跨 Agent 产物感知（系统自动注入）');
      lines.push(...awarenessBlocks);
    }
  }
  if (delta.changedEdges.length > 0) {
    lines.push('', '**变更关系**：');
    for (const edge of delta.changedEdges) {
      lines.push(`- ${edge.fromNodeId} --[${edge.edgeType}]--> ${edge.toNodeId}`);
    }
  }
  lines.push('', '后续判断请优先参考以上已确认事实，避免与团队状态脱节。');
  return lines.join('\n');
}

export function broadcastBlackboardDelta(input: {
  delta: BlackboardDelta;
  excludeAgentName?: string;
  agents: Iterable<AgentHandle>;
  taskBoard: TaskBoard;
  bus: MessageBus;
  sessionId: string;
  sp: (name: string) => string;
}): number {
  let delivered = 0;
  const forceGlobal = input.delta.changedNodes.some((node) => isGlobalBroadcastNode(node));
  for (const handle of input.agents) {
    if (input.excludeAgentName && handle.name === input.excludeAgentName) continue;
    if (handle.status !== 'running' && handle.status !== 'starting') continue;
    if (!forceGlobal && input.delta.relatedTags.length > 0) {
      const handleTags = getHandleTaskTags(handle, input.taskBoard);
      if (!input.delta.relatedTags.some((tag) => handleTags.has(tag))) continue;
    }
    input.bus.send(`${input.sessionId}:blackboard`, input.sp(handle.name), 'message', formatBlackboardDeltaMessage(input.delta));
    delivered++;
  }
  return delivered;
}

export function broadcastWorkNoteAwareness(input: {
  note: WorkNote;
  sourceAgentId: string;
  agents: Iterable<AgentHandle>;
  bus: MessageBus;
  sessionId: string;
  sp: (name: string) => string;
}): number {
  const awareness = buildWorkNoteAwarenessBlock(input.note, input.sourceAgentId);
  if (!awareness.trim()) {
    return 0;
  }
  const content = [
    '### 工作笔记更新（系统自动注入）',
    '',
    awareness,
    '',
    '请把以上同伴产物/发现纳入当前判断，避免重复实现或接口漂移。',
  ].join('\n');
  let delivered = 0;
  for (const handle of input.agents) {
    if (handle.status !== 'running' && handle.status !== 'starting') continue;
    if (handle.agentId === input.sourceAgentId) continue;
    input.bus.send(`${input.sessionId}:work_note`, input.sp(handle.name), 'message', content);
    delivered++;
  }
  return delivered;
}
