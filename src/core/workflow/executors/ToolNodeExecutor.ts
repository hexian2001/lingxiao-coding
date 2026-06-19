/**
 * ToolNodeExecutor - Tool 节点执行器
 * 
 * 集成现有的 ToolRegistry
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { VariableResolver } from '../VariableResolver.js';
import { buildVariableScope } from '../variableScope.js';
import type { NodeDefinition, ExecutionContext } from '../types.js';
import type { ToolContext, ToolRegistryContract, ToolResult } from '../../../contracts/types/Tool.js';

interface SafeParseSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: unknown[]; message: string }> } };
}

function isSafeParseSchema(value: unknown): value is SafeParseSchema {
  return !!value && typeof value === 'object' && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

interface ExecutableToolRegistry extends ToolRegistryContract {
  execute(name: string, args: unknown, context?: ToolContext): Promise<ToolResult> | ToolResult;
}

function hasCanonicalExecute(registry: ToolRegistryContract): registry is ExecutableToolRegistry {
  return typeof (registry as { execute?: unknown }).execute === 'function';
}

export class ToolNodeExecutor extends BaseNodeExecutor {
  private variableResolver = new VariableResolver();

  constructor(private toolRegistry: ToolRegistryContract) {
    super();
  }

  async execute(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<unknown> {
    this.validateNode(node);

    const { config } = node.data;
    const { toolName, toolArgs } = config;

    if (!toolName) {
      throw new Error(`Tool name not specified for node ${node.id}`);
    }

    this.log(context, 'info', node.id, `Executing tool: ${toolName}`);

    try {
      // 合并配置参数和输入参数
      const resolvedToolArgs = this.variableResolver.resolveObject(toolArgs || {}, buildVariableScope(context, { input }));
      const args = { ...resolvedToolArgs, ...input };

      // 构建工具上下文
      const toolContext: ToolContext = {
        workspace: context.variables.get('workspace') as string || process.cwd(),
        sessionId: context.sessionId,
        agentId: `workflow-${context.workflowId}`,
        taskId: context.executionId,
        db: context.db,
        emitter: context.emitter,
        workflowManager: context.workflowManager,
        workflowEngine: context.workflowEngine,
        blackboardGraph: context.blackboardGraph,
      };

      this.log(context, 'debug', node.id, `Tool args: ${JSON.stringify(args)}`);

      if (hasCanonicalExecute(this.toolRegistry)) {
        const result = await this.toolRegistry.execute(toolName, args, toolContext);
        return this.unwrapToolResult(toolName, node.id, result, context);
      }

      // 兼容旧的最小 ToolRegistryContract；生产 Registry 应走上面的 canonical execute。
      const tool = this.toolRegistry.get(toolName);
      if (!tool) {
        throw new Error(`Tool not found: ${toolName}`);
      }

      const parameters = 'parameters' in tool ? tool.parameters : undefined;
      const parsedArgs = isSafeParseSchema(parameters) ? parameters.safeParse(args) : undefined;
      if (parsedArgs && !parsedArgs.success) {
        throw new Error(`Invalid args for tool ${toolName} on node ${node.id}: ${parsedArgs.error.issues.map((issue: { path: unknown[]; message: string }) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`).join('; ')}`);
      }
      const executableArgs = parsedArgs?.success ? parsedArgs.data : args;
      const result = await tool.execute(executableArgs, toolContext);
      return this.unwrapToolResult(toolName, node.id, result, context);

    } catch (error) {
      this.log(
        context,
        'error',
        node.id,
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  private unwrapToolResult(
    toolName: string,
    nodeId: string,
    result: ToolResult | unknown,
    context: ExecutionContext,
  ): unknown {
    if (typeof result === 'object' && result !== null && 'success' in result) {
      const toolResult = result as { success: boolean; error?: string; data?: unknown };
      if (!toolResult.success) {
        throw new Error(toolResult.error || 'Tool execution failed');
      }

      this.log(context, 'info', nodeId, `Tool ${toolName} completed successfully`);
      return toolResult.data;
    }

    this.log(context, 'info', nodeId, `Tool ${toolName} completed successfully`);
    return result;
  }
}
