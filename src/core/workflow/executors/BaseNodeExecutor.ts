/**
 * BaseNodeExecutor - 节点执行器抽象基类
 */

import type { NodeDefinition, ExecutionContext } from '../types.js';

export abstract class BaseNodeExecutor {
  /**
   * 执行节点
   * @param node 节点定义
   * @param input 输入数据
   * @param context 执行上下文
   * @returns 执行结果
   */
  abstract execute(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<unknown>;

  /**
   * 验证节点配置
   * @param node 节点定义
   */
  protected validateNode(node: NodeDefinition): void {
    if (!node.id) {
      throw new Error('Node ID is required');
    }
    if (!node.data) {
      throw new Error('Node data is required');
    }
  }

  /**
   * 记录日志
   */
  protected log(
    context: ExecutionContext,
    level: 'info' | 'warn' | 'error' | 'debug',
    nodeId: string,
    message: string,
    data?: unknown
  ): void {
    context.logs.push({
      timestamp: Date.now(),
      level,
      nodeId,
      message,
      data
    });
  }
}
