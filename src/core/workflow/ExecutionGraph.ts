/**
 * ExecutionGraph - 构建和分析 workflow 执行依赖图
 * 
 * 职责：
 * - 构建节点依赖图
 * - 拓扑排序确定执行顺序
 * - 检测循环依赖
 * - 查找起始节点
 */

import type { WorkflowDefinition, EdgeDefinition } from './types.js';

export class ExecutionGraph {
  private adjacencyList: Map<string, string[]>;  // nodeId -> [依赖的节点ID列表]
  private reverseList: Map<string, string[]>;    // nodeId -> [依赖它的节点ID列表]
  private nodeIds: Set<string>;

  constructor(private workflow: WorkflowDefinition) {
    this.adjacencyList = new Map();
    this.reverseList = new Map();
    this.nodeIds = new Set();
    this.buildGraph();
  }

  /**
   * 构建依赖图
   * adjacencyList: target -> [sources] (节点依赖哪些节点)
   * reverseList: source -> [targets] (节点被哪些节点依赖)
   */
  private buildGraph(): void {
    // 初始化所有节点
    for (const node of this.workflow.nodes) {
      this.nodeIds.add(node.id);
      this.adjacencyList.set(node.id, []);
      this.reverseList.set(node.id, []);
    }

    // 构建边关系
    for (const edge of this.workflow.edges) {
      const { source, target } = edge;
      
      // 验证节点存在
      if (!this.nodeIds.has(source)) {
        throw new Error(`Edge references non-existent source node: ${source}`);
      }
      if (!this.nodeIds.has(target)) {
        throw new Error(`Edge references non-existent target node: ${target}`);
      }

      // target 依赖 source
      const deps = this.adjacencyList.get(target)!;
      if (!deps.includes(source)) {
        deps.push(source);
      }

      // source 被 target 依赖
      const dependents = this.reverseList.get(source)!;
      if (!dependents.includes(target)) {
        dependents.push(target);
      }
    }
  }

  /**
   * 拓扑排序 - 返回执行顺序
   * 使用 DFS 实现
   */
  topologicalSort(): string[] {
    const sorted: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();  // 用于检测循环

    const visit = (nodeId: string): void => {
      if (temp.has(nodeId)) {
        throw new Error(`Cycle detected in workflow involving node: ${nodeId}`);
      }
      if (visited.has(nodeId)) {
        return;
      }

      temp.add(nodeId);
      
      // 先访问所有依赖
      const deps = this.adjacencyList.get(nodeId) || [];
      for (const dep of deps) {
        visit(dep);
      }
      
      temp.delete(nodeId);
      visited.add(nodeId);
      sorted.push(nodeId);
    };

    // 访问所有节点
    for (const nodeId of this.nodeIds) {
      if (!visited.has(nodeId)) {
        visit(nodeId);
      }
    }

    return sorted;
  }

  /**
   * 检测循环依赖
   */
  detectCycles(): boolean {
    try {
      this.topologicalSort();
      return false;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cycle detected')) {
        return true;
      }
      throw error;
    }
  }

  /**
   * 获取起始节点（无依赖的节点）
   */
  getStartNodes(): string[] {
    const startNodes: string[] = [];
    
    for (const nodeId of this.nodeIds) {
      const deps = this.adjacencyList.get(nodeId) || [];
      if (deps.length === 0) {
        startNodes.push(nodeId);
      }
    }

    return startNodes;
  }

  /**
   * 获取节点的直接依赖
   */
  getDependencies(nodeId: string): string[] {
    return this.adjacencyList.get(nodeId) || [];
  }

  /**
   * 获取依赖该节点的节点列表
   */
  getDependents(nodeId: string): string[] {
    return this.reverseList.get(nodeId) || [];
  }

  /**
   * 获取节点的所有前置节点（递归）
   */
  getAllPredecessors(nodeId: string): Set<string> {
    const predecessors = new Set<string>();
    const visited = new Set<string>();

    const collect = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const deps = this.adjacencyList.get(id) || [];
      for (const dep of deps) {
        predecessors.add(dep);
        collect(dep);
      }
    };

    collect(nodeId);
    return predecessors;
  }

  /**
   * 获取节点的所有后继节点（递归）
   */
  getAllSuccessors(nodeId: string): Set<string> {
    const successors = new Set<string>();
    const visited = new Set<string>();

    const collect = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const dependents = this.reverseList.get(id) || [];
      for (const dependent of dependents) {
        successors.add(dependent);
        collect(dependent);
      }
    };

    collect(nodeId);
    return successors;
  }

  /**
   * 检查是否可以并行执行两个节点
   */
  canRunInParallel(nodeId1: string, nodeId2: string): boolean {
    // 如果一个节点依赖另一个，不能并行
    const predecessors1 = this.getAllPredecessors(nodeId1);
    const predecessors2 = this.getAllPredecessors(nodeId2);

    if (predecessors1.has(nodeId2) || predecessors2.has(nodeId1)) {
      return false;
    }

    return true;
  }

  /**
   * 获取可以并行执行的节点组
   * 返回按层级分组的节点
   */
  getParallelLayers(): string[][] {
    const layers: string[][] = [];
    const processed = new Set<string>();
    const remaining = new Set(this.nodeIds);

    while (remaining.size > 0) {
      const currentLayer: string[] = [];

      // 找到所有依赖已满足的节点
      for (const nodeId of remaining) {
        const deps = this.adjacencyList.get(nodeId) || [];
        const allDepsProcessed = deps.every(dep => processed.has(dep));
        
        if (allDepsProcessed) {
          currentLayer.push(nodeId);
        }
      }

      if (currentLayer.length === 0) {
        throw new Error('Unable to find next layer - possible cycle or logic error');
      }

      layers.push(currentLayer);
      
      // 标记为已处理
      for (const nodeId of currentLayer) {
        processed.add(nodeId);
        remaining.delete(nodeId);
      }
    }

    return layers;
  }

  /**
   * 验证图的完整性
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 检查是否有循环
    if (this.detectCycles()) {
      errors.push('Workflow contains cycles');
    }

    // 检查是否有孤立节点（既无输入也无输出）
    for (const nodeId of this.nodeIds) {
      const deps = this.adjacencyList.get(nodeId) || [];
      const dependents = this.reverseList.get(nodeId) || [];
      
      if (deps.length === 0 && dependents.length === 0 && this.nodeIds.size > 1) {
        errors.push(`Node ${nodeId} is isolated (no connections)`);
      }
    }

    // 检查是否至少有一个起始节点
    const startNodes = this.getStartNodes();
    if (startNodes.length === 0 && this.nodeIds.size > 0) {
      errors.push('Workflow has no start nodes (all nodes have dependencies)');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 获取图的统计信息
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    startNodeCount: number;
    maxDepth: number;
    layerCount: number;
  } {
    const layers = this.getParallelLayers();
    
    return {
      nodeCount: this.nodeIds.size,
      edgeCount: this.workflow.edges.length,
      startNodeCount: this.getStartNodes().length,
      maxDepth: this.calculateMaxDepth(),
      layerCount: layers.length
    };
  }

  /**
   * 计算图的最大深度
   */
  private calculateMaxDepth(): number {
    const depths = new Map<string, number>();

    const calculateDepth = (nodeId: string): number => {
      if (depths.has(nodeId)) {
        return depths.get(nodeId)!;
      }

      const deps = this.adjacencyList.get(nodeId) || [];
      if (deps.length === 0) {
        depths.set(nodeId, 0);
        return 0;
      }

      const maxDepDep = Math.max(...deps.map(dep => calculateDepth(dep)));
      const depth = maxDepDep + 1;
      depths.set(nodeId, depth);
      return depth;
    };

    let maxDepth = 0;
    for (const nodeId of this.nodeIds) {
      maxDepth = Math.max(maxDepth, calculateDepth(nodeId));
    }

    return maxDepth;
  }
}
