/**
 * GraphBridge — TaskBoard ↔ BlackboardGraph 双向桥
 *
 * TaskBoard 操作同步写入图节点，黑板调度决策反向创建 Task。
 */

import type { Task, TaskStatus, ExitReason } from '../TaskBoard.js';
import type { BlackboardGraph } from './BlackboardGraph.js';

// ═══════════════════════════════════════════════════════════════
// 状态映射
// ═══════════════════════════════════════════════════════════════

import type { IntentStatus } from './types.js';

function taskStatusToIntentStatus(status: TaskStatus, exitReason?: ExitReason): IntentStatus {
  switch (status) {
    case 'dispatchable': return 'open';
    case 'running': return 'claimed';
    case 'terminal': return 'resolved';  // 所有终止态都映射为 resolved
    default: return 'open';
  }
}

// ═══════════════════════════════════════════════════════════════
// GraphBridge
// ═══════════════════════════════════════════════════════════════

export class GraphBridge {
  private readonly graph: BlackboardGraph;
  /** Task ID → Intent Node ID 映射 */
  private readonly taskToNode: Map<string, string> = new Map();
  /** Intent Node ID → Task ID 反向映射 */
  private readonly nodeToTask: Map<string, string> = new Map();

  constructor(graph: BlackboardGraph) {
    this.graph = graph;
  }

  /**
   * TaskBoard.createTask() 的钩子 — 创建对应的 Intent 节点。
   * 重复调用幂等：若该 task 已建过 Intent 节点，直接复用，不重复 addIntent。
   */
  onTaskCreated(task: Task): void {
    const existing = this.taskToNode.get(task.id);
    if (existing) {
      // 已存在则保持映射不变，避免事件重放产生重复 Intent
      return;
    }
    const node = this.graph.addIntent({
      sessionId: task.session_id,
      title: task.subject,
      content: task.description || task.subject,
      tags: ['task', `agent:${task.agent_type}`],
      createdBy: task.id,
      intentStatus: 'open',
      priority: 5,
    });
    this.taskToNode.set(task.id, node.id);
    this.nodeToTask.set(node.id, task.id);
    this.syncDependencyEdges(task);
  }

  /**
   * TaskBoard.completeTask() 的钩子 — 创建 Fact 节点
   */
  onTaskCompleted(task: Task): void {
    const resultStr = typeof task.result === 'string'
      ? task.result
      : JSON.stringify(task.result ?? '');

    this.graph.addFact({
      sessionId: task.session_id,
      title: `Completed: ${task.subject}`,
      content: resultStr,
      tags: ['task_result', `task:${task.id}`],
      createdBy: task.id,
      confidence: 'confirmed',
    });

    // 更新 Intent 状态
    const nodeId = this.taskToNode.get(task.id);
    if (nodeId) {
      this.graph.updateIntentStatus(nodeId, task.session_id, 'resolved');
    }
  }

  /**
   * TaskBoard.failTask() 的钩子 — 创建失败 Fact 节点，并通过 supersededBy 链接
   * 原 Intent 节点，保留失败原因 / exitReason / result 供后续决策使用。
   */
  onTaskFailed(task: Task): void {
    const nodeId = this.taskToNode.get(task.id);
    if (!nodeId) return;

    // 1) 创建失败 Fact，承载失败原因 / exitReason / result 摘要
    const resultStr = typeof task.result === 'string'
      ? task.result
      : JSON.stringify(task.result ?? '');
    const failTitle = `Failed: ${task.subject}`;
    const failContent = [
      task.exitReason ? `exit_reason: ${task.exitReason}` : '',
      resultStr ? `result: ${resultStr}` : '',
    ].filter(Boolean).join('\n') || 'Task failed without result payload';

    const failFact = this.graph.addFact({
      sessionId: task.session_id,
      title: failTitle,
      content: failContent,
      tags: ['task_failed', `task:${task.id}`, task.exitReason ? `exit:${task.exitReason}` : 'exit:unknown'],
      createdBy: task.id,
      confidence: 'confirmed',
    });

    // 2) 将原 Intent 标记 resolved 并通过 supersededBy 链接到失败 Fact
    this.graph.updateIntentStatus(nodeId, task.session_id, 'resolved');
    this.graph.supersedeNode(nodeId, task.session_id, failFact.id);
  }

  /**
   * TaskBoard.updateTask() 的钩子 — 同步更新 Intent 节点 title / content / tags / status。
   * 仅当 Intent 节点已存在（在 onTaskCreated 中建过）才更新；否则补建一个，避免遗漏。
   */
  onTaskUpdated(task: Task): void {
    const nodeId = this.taskToNode.get(task.id);
    const status = taskStatusToIntentStatus(task.status as TaskStatus, task.exitReason as ExitReason | undefined);
    if (!nodeId) {
      this.onTaskCreated(task);
      return;
    }
    this.graph.updateNode(nodeId, task.session_id, {
      title: task.subject,
      content: typeof task.description === 'string' ? task.description : (task.subject || ''),
      tags: ['task', `agent:${task.agent_type}`],
      intentStatus: status,
    });
    this.syncDependencyEdges(task);
  }

  private syncDependencyEdges(task: Task): void {
    const toNodeId = this.taskToNode.get(task.id);
    if (!toNodeId) return;
    for (const depTaskId of task.blocked_by) {
      const fromNodeId = this.taskToNode.get(depTaskId);
      if (!fromNodeId) continue;
      const exists = this.graph.getEdgesTo(task.session_id, toNodeId).some((edge) =>
        edge.fromNodeId === fromNodeId &&
        edge.edgeType === 'depends_on' &&
        edge.metadata?.source === 'task_board'
      );
      if (exists) continue;
      this.graph.addEdge({
        sessionId: task.session_id,
        fromNodeId,
        toNodeId,
        edgeType: 'depends_on',
        createdBy: 'task_board',
        metadata: { source: 'task_board', fromTaskId: depTaskId, toTaskId: task.id },
      });
    }
  }

  /**
   * 获取 Task 对应的 Intent 节点 ID
   */
  getIntentNodeId(taskId: string): string | undefined {
    return this.taskToNode.get(taskId);
  }

  /**
   * 获取所有映射
   */
  getMappings(): Map<string, string> {
    return new Map(this.taskToNode);
  }

  /**
   * 检查 Intent 节点是否已有对应的 Task
   */
  hasTaskForNode(nodeId: string): boolean {
    return this.nodeToTask.has(nodeId);
  }

  /**
   * 获取 Intent 节点对应的 Task ID
   */
  getTaskId(nodeId: string): string | undefined {
    return this.nodeToTask.get(nodeId);
  }
}
