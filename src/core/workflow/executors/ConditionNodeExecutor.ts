/**
 * ConditionNodeExecutor - Condition 节点执行器
 * 
 * 评估条件表达式，返回 true/false
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import type { WorkflowAgentExecutor } from './AgentNodeExecutor.js';
import type { NodeDefinition, ExecutionContext } from '../types.js';
import { evaluateExpression } from '../expressionEvaluator.js';
import { getPromptCatalog } from '../../../agents/prompts/i18n/catalog.js';

export class ConditionNodeExecutor extends BaseNodeExecutor {
  constructor(private readonly agentExecutor?: WorkflowAgentExecutor) {
    super();
  }

  async execute(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<boolean> {
    this.validateNode(node);

    const { config } = node.data;
    const { conditionType, expression, llmPrompt } = config;

    this.log(context, 'info', node.id, `Evaluating condition: ${conditionType}`);

    try {
      let result: boolean;

      if (conditionType === 'expression') {
        if (!expression) {
          throw new Error('Expression is required for expression-type condition');
        }
        result = this.evaluateExpression(expression, input, context);
      } else if (conditionType === 'llm') {
        if (!llmPrompt) {
          throw new Error('LLM prompt is required for llm-type condition');
        }
        result = await this.evaluateLLMCondition(node, llmPrompt, input, context);
      } else {
        throw new Error(`Unknown condition type: ${conditionType}`);
      }

      this.log(context, 'info', node.id, `Condition evaluated to: ${result}`);
      return result;

    } catch (error) {
      this.log(
        context,
        'error',
        node.id,
        `Condition evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * 通过真实 agent 执行器评估 LLM 条件
   */
  private async evaluateLLMCondition(
    node: NodeDefinition,
    prompt: string,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<boolean> {
    if (!this.agentExecutor) {
      throw new Error('Workflow agent executor is required for llm-type condition');
    }

    const result = await this.agentExecutor({
      node,
      input,
      context,
      task: [
        prompt,
        '',
        ...getPromptCatalog().judges.workflowCondition.taskInstructions,
        '',
        JSON.stringify(input, null, 2)
      ].join('\n')
    });

    return this.parseBooleanResult(result);
  }

  private parseBooleanResult(result: unknown): boolean {
    if (typeof result === 'boolean') {
      return result;
    }

    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>;
      for (const key of ['result', 'value', 'condition', 'decision', 'output']) {
        if (typeof record[key] === 'boolean') {
          return record[key];
        }
      }
    }

    if (typeof result === 'string') {
      const normalized = result.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;

      try {
        return this.parseBooleanResult(JSON.parse(result));
      } catch {
        // Fall through to structured parse error below.
      }
    }

    throw new Error(`LLM condition result must be boolean true/false, got: ${JSON.stringify(result)}`);
  }

  /**
   * 评估 JavaScript 表达式（委托给共享的 expressionEvaluator）
   *
   * 安全说明见 `src/core/workflow/expressionEvaluator.ts` 模块级注释。
   */
  private evaluateExpression(
    expression: string,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): boolean {
    const previousResult = input.result ?? input.input ?? input.value ?? input.output;
    const scope: Record<string, unknown> = {
      input,
      result: previousResult,
      value: previousResult,
      output: previousResult,
      variables: Object.fromEntries(context.variables),
      Math,
      Date,
      JSON,
      String,
      Number,
      Boolean,
      Array,
      Object
    };
    return evaluateExpression(expression, scope);
  }
}
