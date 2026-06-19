/**
 * CompletionChecker - 完成判断器
 * 
 * 检查黑板图中是否存在从 origin 到 goal 的完整路径
 * 使用 BFS 算法查找路径
 */

import type { BlackboardGraph } from './BlackboardGraph.js';
import type { GraphNode, GraphEdge, EdgeType } from './types.js';

export interface CompletionResult {
  completed: boolean;
  path?: string[];  // 从 origin 到 goal 的节点 ID 路径
  reason: string;
}

/**
 * 完成判定只能沿"正向推进"语义边传播可达性。
 * - supports/refines/produces/consumes/depends_on：表达"由前提推进到结论/产物"的正向关系。
 * - contradicts：负向边，A 反驳 B 不代表 B 被达成，绝不能算作可达。
 * - supersedes：A 废弃 B，沿它前进会把可达性传播到被废弃节点，同样排除。
 * 若把全部边类型都纳入邻接表，goal 会经由 contradicts/supersedes 被误判为 completed。
 */
const PROGRESS_EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  'supports',
  'refines',
  'produces',
  'consumes',
  'depends_on',
]);

export class CompletionChecker {
  /**
   * 检查是否完成
   * @param blackboardGraph 黑板图实例
   * @param sessionId 会话 ID
   * @param originId 起点节点 ID
   * @param goalId 目标节点 ID
   */
  static checkCompletion(
    blackboardGraph: BlackboardGraph,
    sessionId: string,
    originId: string,
    goalId: string,
  ): CompletionResult {
    const snapshot = blackboardGraph.getSnapshot(sessionId);
    
    // 检查 origin 和 goal 是否存在
    const originNode = snapshot.nodes.find(n => n.id === originId);
    const goalNode = snapshot.nodes.find(n => n.id === goalId);
    
    if (!originNode) {
      return {
        completed: false,
        reason: `Origin node ${originId} not found`,
      };
    }
    
    if (!goalNode) {
      return {
        completed: false,
        reason: `Goal node ${goalId} not found`,
      };
    }
    
    // 使用 BFS 查找路径
    const path = this.findPath(snapshot.nodes, snapshot.edges, originId, goalId);
    
    if (path) {
      return {
        completed: true,
        path,
        reason: `Found path from ${originId} to ${goalId} with ${path.length} nodes`,
      };
    }
    
    return {
      completed: false,
      reason: `No path found from ${originId} to ${goalId}`,
    };
  }

  /**
   * 使用 BFS 查找从 start 到 end 的路径
   */
  private static findPath(
    nodes: GraphNode[],
    edges: GraphEdge[],
    startId: string,
    endId: string,
  ): string[] | null {
    // 被 supersedes 边指向、或已标记 supersededBy 的节点视为废弃，不参与可达性传播
    const deprecatedNodeIds = new Set<string>();
    for (const node of nodes) {
      if (node.supersededBy) {
        deprecatedNodeIds.add(node.id);
      }
    }
    for (const edge of edges) {
      if (edge.edgeType === 'supersedes') {
        deprecatedNodeIds.add(edge.toNodeId);
      }
    }

    // 构建邻接表：只允许正向推进语义边，排除 contradicts / supersedes，跳过废弃节点
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      if (!PROGRESS_EDGE_TYPES.has(edge.edgeType)) {
        continue;
      }
      if (deprecatedNodeIds.has(edge.fromNodeId) || deprecatedNodeIds.has(edge.toNodeId)) {
        continue;
      }
      if (!adjacency.has(edge.fromNodeId)) {
        adjacency.set(edge.fromNodeId, []);
      }
      adjacency.get(edge.fromNodeId)!.push(edge.toNodeId);
    }
    
    // BFS 队列：[当前节点ID, 路径]
    const queue: Array<[string, string[]]> = [[startId, [startId]]];
    const visited = new Set<string>([startId]);
    
    while (queue.length > 0) {
      const [currentId, path] = queue.shift()!;
      
      // 找到目标
      if (currentId === endId) {
        return path;
      }
      
      // 遍历邻居
      const neighbors = adjacency.get(currentId) || [];
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push([neighborId, [...path, neighborId]]);
        }
      }
    }
    
    // 没有找到路径
    return null;
  }

  /**
   * 查找所有从 origin 到 goal 的路径（用于调试和分析）
   */
  static findAllPaths(
    blackboardGraph: BlackboardGraph,
    sessionId: string,
    originId: string,
    goalId: string,
    maxPaths = 10,
  ): string[][] {
    const snapshot = blackboardGraph.getSnapshot(sessionId);
    
    // 构建邻接表
    const adjacency = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      if (!adjacency.has(edge.fromNodeId)) {
        adjacency.set(edge.fromNodeId, []);
      }
      adjacency.get(edge.fromNodeId)!.push(edge.toNodeId);
    }
    
    const allPaths: string[][] = [];
    const currentPath: string[] = [originId];
    const visited = new Set<string>([originId]);
    
    // DFS 查找所有路径
    const dfs = (currentId: string) => {
      if (allPaths.length >= maxPaths) {
        return;
      }
      
      if (currentId === goalId) {
        allPaths.push([...currentPath]);
        return;
      }
      
      const neighbors = adjacency.get(currentId) || [];
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          currentPath.push(neighborId);
          dfs(neighborId);
          currentPath.pop();
          visited.delete(neighborId);
        }
      }
    };
    
    dfs(originId);
    return allPaths;
  }

  /**
   * 获取节点的所有前置条件（依赖的 Fact）
   */
  static getPrerequisites(
    blackboardGraph: BlackboardGraph,
    sessionId: string,
    nodeId: string,
  ): Set<string> {
    const snapshot = blackboardGraph.getSnapshot(sessionId);
    const prerequisites = new Set<string>();
    
    // 查找所有指向该节点的边
    for (const edge of snapshot.edges) {
      if (edge.toNodeId === nodeId) {
        prerequisites.add(edge.fromNodeId);
      }
    }
    
    return prerequisites;
  }

  /**
   * 获取节点的所有依赖者（依赖该节点的其他节点）
   */
  static getDependents(
    blackboardGraph: BlackboardGraph,
    sessionId: string,
    nodeId: string,
  ): Set<string> {
    const snapshot = blackboardGraph.getSnapshot(sessionId);
    const dependents = new Set<string>();
    
    // 查找所有从该节点出发的边
    for (const edge of snapshot.edges) {
      if (edge.fromNodeId === nodeId) {
        dependents.add(edge.toNodeId);
      }
    }
    
    return dependents;
  }
}
