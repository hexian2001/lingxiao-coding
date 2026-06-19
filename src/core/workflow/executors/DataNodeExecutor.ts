/**
 * DataNodeExecutor - built-in data/transformation nodes.
 *
 * These nodes intentionally avoid external services unless they delegate through
 * an already registered tool such as http_request.
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { VariableResolver } from '../VariableResolver.js';
import { buildVariableScope } from '../variableScope.js';
import type { ExecutionContext, NodeDefinition } from '../types.js';
import type { ToolContext, ToolRegistryContract, ToolResult } from '../../../contracts/types/Tool.js';

type DataNodeType =
  | 'template'
  | 'variable_assigner'
  | 'variable_aggregator'
  | 'list_operator'
  | 'http_request'
  | 'json_extractor';

interface ExecutableToolRegistry extends ToolRegistryContract {
  execute(name: string, args: unknown, context?: ToolContext): Promise<ToolResult> | ToolResult;
}

function hasCanonicalExecute(registry: ToolRegistryContract): registry is ExecutableToolRegistry {
  return typeof (registry as { execute?: unknown }).execute === 'function';
}

export class DataNodeExecutor extends BaseNodeExecutor {
  private variableResolver = new VariableResolver();

  constructor(private readonly toolRegistry?: ToolRegistryContract) {
    super();
  }

  async execute(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<unknown> {
    this.validateNode(node);
    const nodeType = node.data.type as DataNodeType;
    this.log(context, 'info', node.id, `Executing data node: ${nodeType}`);

    switch (nodeType) {
      case 'template':
        return this.executeTemplate(node, input, context);
      case 'variable_assigner':
        return this.executeVariableAssigner(node, input, context);
      case 'variable_aggregator':
        return this.executeVariableAggregator(node, input, context);
      case 'list_operator':
        return this.executeListOperator(node, input, context);
      case 'http_request':
        return this.executeHttpRequest(node, input, context);
      case 'json_extractor':
        return this.executeJsonExtractor(node, input, context);
      default:
        throw new Error(`Unsupported data node type: ${nodeType}`);
    }
  }

  private executeTemplate(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Record<string, unknown> {
    const template = node.data.config.template;
    if (template === undefined) {
      throw new Error(`Template node ${node.id} requires config.template`);
    }

    const resolved = this.resolveValue(template, context, input);
    const outputKey = node.data.config.outputKey;

    if (node.data.config.templateFormat === 'json') {
      const parsed = typeof resolved === 'string' ? parseJsonLike(resolved) : resolved;
      return {
        value: parsed,
        json: parsed,
        ...(outputKey ? { [outputKey]: parsed } : {}),
      };
    }

    const text = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    return {
      value: text,
      text,
      ...(outputKey ? { [outputKey]: text } : {}),
    };
  }

  private executeVariableAssigner(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Record<string, unknown> {
    const assignments = normalizeAssignments(node.data.config.assignments);
    if (assignments.length === 0) {
      throw new Error(`Variable assigner node ${node.id} requires config.assignments`);
    }

    const assigned: Record<string, unknown> = {};
    for (const { name, value } of assignments) {
      const resolved = this.resolveValue(value, context, input);
      context.variables.set(name, resolved);
      assigned[name] = resolved;
    }

    return {
      assigned,
      variables: Object.fromEntries(context.variables),
    };
  }

  private executeVariableAggregator(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Record<string, unknown> {
    const aggregate = node.data.config.aggregate;
    const aggregated: Record<string, unknown> = {};

    if (Array.isArray(aggregate)) {
      for (const ref of aggregate) {
        const key = ref.split('.').filter(Boolean).at(-1) || ref;
        aggregated[key] = this.resolveReference(ref, context, input);
      }
    } else if (aggregate && typeof aggregate === 'object') {
      for (const [key, ref] of Object.entries(aggregate)) {
        aggregated[key] = this.resolveReference(ref, context, input);
      }
    } else {
      Object.assign(aggregated, input);
    }

    return {
      result: aggregated,
      variables: aggregated,
      ...aggregated,
    };
  }

  private executeListOperator(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Record<string, unknown> {
    const list = this.resolveList(node, input, context);
    const config = node.data.config;
    const op = config.listOperation ?? 'length';
    let result: unknown;

    switch (op) {
      case 'first':
        result = list[0];
        break;
      case 'last':
        result = list.at(-1);
        break;
      case 'length':
        result = list.length;
        break;
      case 'slice':
        result = list.slice(config.listStart ?? 0, config.listEnd);
        break;
      case 'join':
        result = list.map(item => item == null ? '' : String(item)).join(config.listDelimiter ?? ',');
        break;
      case 'flatten':
        result = list.flat();
        break;
      case 'unique':
        result = Array.from(new Set(list.map(item => stableKey(item)))).map(key => JSON.parse(key));
        break;
      case 'reverse':
        result = [...list].reverse();
        break;
      case 'sort':
        result = [...list].sort((a, b) => String(a).localeCompare(String(b)));
        break;
      case 'pluck':
        if (!config.listProperty) {
          throw new Error(`list_operator pluck requires config.listProperty on node ${node.id}`);
        }
        result = list.map(item => getPathValue(item, config.listProperty!));
        break;
      case 'compact':
        result = list.filter(item => item !== null && item !== undefined && item !== '');
        break;
      default:
        throw new Error(`Unsupported list operation: ${op}`);
    }

    return {
      result,
      items: Array.isArray(result) ? result : undefined,
      count: Array.isArray(result) ? result.length : list.length,
    };
  }

  private async executeHttpRequest(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<Record<string, unknown>> {
    const requestConfig = node.data.config.httpRequest;
    if (!requestConfig?.url) {
      throw new Error(`HTTP request node ${node.id} requires config.httpRequest.url`);
    }
    const toolRegistry = this.toolRegistry;
    if (!toolRegistry) {
      throw new Error('http_request tool is not registered; cannot execute http_request workflow node');
    }

    const resolved = this.resolveValue(requestConfig, context, input) as Record<string, unknown>;
    const args = {
      method: resolved.method,
      url: resolved.url,
      headers: resolved.headers,
      body: resolved.body,
      timeout: resolved.timeout,
      max_response_size: resolved.maxResponseSize,
      follow_redirects: resolved.followRedirects,
    };
    const toolContext: ToolContext = {
      workspace: context.variables.get('workspace') as string | undefined,
      sessionId: context.sessionId,
      agentId: `workflow-${context.workflowId}`,
      taskId: context.executionId,
    };
    const result = await this.executeHttpRequestTool(toolRegistry, args, toolContext);

    if (isToolResult(result) && !result.success) {
      throw new Error(result.error || 'http_request workflow node failed');
    }
    const data = isToolResult(result) ? result.data : result;
    return {
      response: data,
      text: typeof data === 'string' ? data : JSON.stringify(data),
      result: data,
    };
  }

  private async executeHttpRequestTool(
    toolRegistry: ToolRegistryContract,
    args: Record<string, unknown>,
    toolContext: ToolContext,
  ): Promise<ToolResult | unknown> {
    if (!hasCanonicalExecute(toolRegistry)) {
      throw new Error('http_request workflow node requires ToolRegistry.execute; direct tool.execute fallback is not allowed');
    }

    return toolRegistry.execute('http_request', args, toolContext);
  }

  private executeJsonExtractor(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): Record<string, unknown> {
    const source = node.data.config.jsonSource
      ? this.resolveReference(node.data.config.jsonSource, context, input)
      : input.input ?? input.response ?? input.text ?? input;
    const parsed = typeof source === 'string' ? parseJsonLike(source) : source;
    const paths = node.data.config.extractPaths;

    if (!paths || Object.keys(paths).length === 0) {
      return {
        result: parsed,
        value: parsed,
      };
    }

    const extracted: Record<string, unknown> = {};
    for (const [key, path] of Object.entries(paths)) {
      extracted[key] = getPathValue(parsed, path);
    }
    return {
      result: extracted,
      ...extracted,
    };
  }

  private resolveList(
    node: NodeDefinition,
    input: Record<string, unknown>,
    context: ExecutionContext
  ): unknown[] {
    const source = node.data.config.listSource
      ? this.resolveReference(node.data.config.listSource, context, input)
      : input.items ?? input.list ?? input.input ?? input;
    if (Array.isArray(source)) return source;
    if (source && typeof source === 'object' && Array.isArray((source as Record<string, unknown>).items)) {
      return (source as Record<string, unknown>).items as unknown[];
    }
    throw new Error(`list_operator node ${node.id} source must resolve to an array`);
  }

  private resolveReference(ref: string, context: ExecutionContext, input: Record<string, unknown>): unknown {
    if (ref.startsWith('${')) {
      return this.variableResolver.resolve(ref, buildVariableScope(context, { input }));
    }
    if (ref === 'input') return input;
    if (ref.startsWith('input.')) return getPathValue(input, ref.slice('input.'.length));
    if (ref === 'variables') return Object.fromEntries(context.variables);
    if (ref.startsWith('variables.')) return context.variables.get(ref.slice('variables.'.length));
    return this.variableResolver.resolve(`\${${ref}}`, buildVariableScope(context, { input }));
  }

  private resolveValue(value: unknown, context: ExecutionContext, input: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      return this.variableResolver.resolve(value, buildVariableScope(context, { input }));
    }
    if (Array.isArray(value)) {
      return value.map(item => this.resolveValue(item, context, input));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.resolveValue(child, context, input);
      }
      return out;
    }
    return value;
  }
}

function normalizeAssignments(assignments: unknown): Array<{ name: string; value: unknown }> {
  if (Array.isArray(assignments)) {
    return assignments
      .filter(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string')
      .map(item => ({ name: (item as Record<string, unknown>).name as string, value: (item as Record<string, unknown>).value }));
  }
  if (assignments && typeof assignments === 'object') {
    return Object.entries(assignments as Record<string, unknown>).map(([name, value]) => ({ name, value }));
  }
  return [];
}

function parseJsonLike(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {/* swallowed: unhandled error */
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ?? trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) {
      throw new Error('Expected JSON value or fenced JSON block');
    }
    return JSON.parse(match[1].trim());
  }
}

function getPathValue(source: unknown, path: string): unknown {
  if (path === '' || path === '.' || path === 'result') return source;
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const arrayValue = getPathProperty(current, arrayMatch[1]);
      current = Array.isArray(arrayValue) ? arrayValue[Number(arrayMatch[2])] : undefined;
    } else {
      current = getPathProperty(current, part);
    }
  }
  return current;
}

function getPathProperty(source: unknown, key: string): unknown {
  if (Array.isArray(source)) {
    return /^\d+$/.test(key) ? source[Number(key)] : undefined;
  }
  if (source !== null && typeof source === 'object') {
    return (source as Record<string, unknown>)[key];
  }
  return undefined;
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === 'object' && 'success' in value && 'data' in value);
}
