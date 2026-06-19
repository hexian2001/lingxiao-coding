/**
 * Shared buildVariableScope utility.
 *
 * Constructs a VariableScope from an ExecutionContext, used by WorkflowEngine
 * and node executors to resolve template variables.
 */

import type { ExecutionContext, VariableScope, WorkflowConfig } from './types.js';

export interface BuildVariableScopeOptions {
  /** Workflow config to include; defaults to `{}` when omitted. */
  config?: WorkflowConfig;
  /** Explicit input record; when omitted falls back to `context.variables.get('__input__')`. */
  input?: Record<string, unknown>;
  /** Whether to extract result fields as node outputs. Defaults to true. */
  extractOutputs?: boolean;
}

/**
 * Build a VariableScope from an ExecutionContext.
 */
export function buildVariableScope(
  context: ExecutionContext,
  options: BuildVariableScopeOptions = {}
): VariableScope {
  const {
    config = {},
    input,
    extractOutputs = true,
  } = options;

  const nodes: VariableScope['nodes'] = {};

  for (const [nodeId, execution] of context.nodeExecutions) {
    nodes[nodeId] = {
      outputs: extractOutputs
        ? extractNodeOutputs(execution.result)
        : {},
      result: execution.result,
    };
  }

  return {
    workflow: {
      variables: Object.fromEntries(context.variables),
      config,
    },
    context: {
      workflowId: context.workflowId,
      executionId: context.executionId,
      sessionId: context.sessionId,
      startTime: context.startTime,
    },
    nodes,
    input: input ?? (context.variables.get('__input__') as Record<string, unknown>),
    env: process.env as Record<string, string | undefined>,
  };
}

function extractNodeOutputs(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}
