import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import type { EdgeDefinition, ExecutionContext, NodeDefinition, WorkflowDefinition } from '../types.js';

export interface ParallelNodeExecutorDelegate {
  getWorkflow(context: ExecutionContext): WorkflowDefinition;
  executeNode(workflow: WorkflowDefinition, context: ExecutionContext, nodeId: string): Promise<void>;
  collectParallelBodyNodeIds(workflow: WorkflowDefinition, parallelNodeId: string): Set<string>;
  shouldStopExecution(context: ExecutionContext): boolean;
  selectConditionEdges(edges: EdgeDefinition[], result: unknown): EdgeDefinition[];
  dependenciesSatisfiedWithin(nodeId: string, workflow: WorkflowDefinition, completed: Set<string>, allowedNodes: Set<string>): boolean;
}

export class ParallelNodeExecutor extends BaseNodeExecutor {
  constructor(private readonly delegate: ParallelNodeExecutorDelegate) {
    super();
  }

  async execute(node: NodeDefinition, _input: Record<string, unknown>, context: ExecutionContext): Promise<Record<string, unknown>> {
    this.validateNode(node);
    const workflow = this.delegate.getWorkflow(context);
    const bodyEntryEdges = workflow.edges.filter(edge => edge.source === node.id && edge.data?.type === 'sequence');
    if (bodyEntryEdges.length === 0) {
      throw new Error(`Parallel node ${node.id} has no branch edge`);
    }

    const bodyNodeIds = this.delegate.collectParallelBodyNodeIds(workflow, node.id);
    if (bodyNodeIds.size === 0) {
      throw new Error(`Parallel node ${node.id} has no executable branch`);
    }

    const branchResults = Object.assign(
      {},
      ...await Promise.all(bodyEntryEdges.map(edge => this.executeBranch(workflow, context, node.id, edge.target, bodyNodeIds)))
    );

    return branchResults;
  }

  private async executeBranch(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
    parallelNodeId: string,
    entryNodeId: string,
    bodyNodeIds: Set<string>
  ): Promise<Record<string, unknown>> {
    const branchResults: Record<string, unknown> = {};
    const completedBody = new Set<string>([parallelNodeId]);
    const queue = [entryNodeId];
    const queued = new Set(queue);

    while (queue.length > 0) {
      if (this.delegate.shouldStopExecution(context)) {
        break;
      }

      const branchNodeId = queue.shift()!;
      queued.delete(branchNodeId);
      if (!bodyNodeIds.has(branchNodeId) || completedBody.has(branchNodeId)) {
        continue;
      }

      await this.delegate.executeNode(workflow, context, branchNodeId);
      if (this.delegate.shouldStopExecution(context)) {
        break;
      }
      completedBody.add(branchNodeId);
      branchResults[branchNodeId] = context.nodeExecutions.get(branchNodeId)?.result;

      const branchNode = workflow.nodes.find(n => n.id === branchNodeId);
      const branchResult = context.nodeExecutions.get(branchNodeId)?.result;
      const outgoingEdges = workflow.edges.filter(edge => edge.source === branchNodeId && edge.data?.type !== 'data');
      const activeEdges = branchNode?.data.type === 'condition'
        ? this.delegate.selectConditionEdges(outgoingEdges, branchResult)
        : outgoingEdges;

      for (const edge of activeEdges) {
        if (bodyNodeIds.has(edge.target) && !queued.has(edge.target) && !completedBody.has(edge.target) && this.delegate.dependenciesSatisfiedWithin(edge.target, workflow, completedBody, bodyNodeIds)) {
          queue.push(edge.target);
          queued.add(edge.target);
        }
      }
    }

    return branchResults;
  }
}
