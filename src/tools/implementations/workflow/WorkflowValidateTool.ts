import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import { validateToolArgsWithRegistry } from './WorkflowSchemaUtils.js';
import { getNextCronTime } from '../../../core/ScheduledTaskManager.js';
import type { NodeDefinition, EdgeDefinition, NodeConfig, NodeType } from '../../../core/workflow/types.js';

const WorkflowValidateSchema = z.object({
  workflow_id: z.string().describe('Workflow ID')
}).strict();

type Issue = {
  type: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  fixHint?: string;
  suggestedToolCall?: string;
};

export class WorkflowValidateTool extends Tool {
  readonly name = '__workflow_delegate_validate';
  readonly description = `验证 workflow 图结构和执行语义契约，返回 LLM 可直接照做的修复建议。

会检查：
- WorkflowManager 静态验证结果
- dangling / duplicate / unreachable 节点边
- condition / loop / parallel 结构完整性
- schedule_trigger cron / intensity / audience 配置
- tool 节点 toolName 和明显缺失的必填参数
- template / variable / list / http / json 数据节点的必要配置
- data 边是否带 dataMapping

返回：
- valid: 是否可执行
- errors: 必须修复的问题，每项带 fixHint / suggestedToolCall
- warnings: 建议修复的问题
- nextSuggestedActions: 可直接执行的下一步建议`;

  readonly parameters = WorkflowValidateSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowValidateSchema.parse(args);
    const workflowManager = context?.workflowManager as { get: (id: string) => Promise<{ id: string; nodes: NodeDefinition[]; edges: EdgeDefinition[] } | null>; validate?: (id: string) => Promise<{ errors?: Array<{ type?: string; message?: string; nodeId?: string; edgeId?: string }> }> } | undefined;
    if (!workflowManager) {
      return { success: false, data: null, error: 'WorkflowManager not available in context' };
    }

    try {
      const workflow = await workflowManager.get(params.workflow_id);
      if (!workflow) {
        return { success: false, data: null, error: `Workflow not found: ${params.workflow_id}` };
      }

      const errors: Issue[] = [];
      const warnings: Issue[] = [];

      if (typeof workflowManager.validate === 'function') {
        const base = await workflowManager.validate(params.workflow_id);
        if (Array.isArray(base.errors)) {
          errors.push(...base.errors.map((error) => ({
            type: error.type ?? 'workflow_manager_validation',
            message: error.message ?? String(error),
            nodeId: error.nodeId,
            edgeId: error.edgeId,
            fixHint: 'Inspect the workflow and fix the reported graph validation error.',
	            suggestedToolCall: `workflow(action="inspect", workflow_id="${params.workflow_id}")`,
          })));
        }
      }

      const nodeById = new Map<string, NodeDefinition>(workflow.nodes.map((node: NodeDefinition) => [node.id, node]));
      const edgeKeys = new Set<string>();
      for (const edge of workflow.edges as EdgeDefinition[]) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        const edgeType = edge.data?.type ?? 'sequence';
        const key = `${edge.source}->${edge.target}:${edgeType}:${edge.data?.conditionValue ?? ''}`;

        if (edgeKeys.has(key)) {
          warnings.push(issue('duplicate_edge', 'duplicate edge with same source/target/type', { edgeId: edge.id, fixHint: 'Recreate the workflow without duplicate edges.' }));
        }
        edgeKeys.add(key);

        if (!source || !target) {
          errors.push(issue('dangling_edge', 'edge source or target node does not exist', { edgeId: edge.id, fixHint: 'Recreate the workflow without dangling edges.' }));
          continue;
        }

        if (edgeType === 'condition' && source.data?.type !== 'condition') {
          errors.push(issue('invalid_condition_edge', 'condition edge source must be a condition node', { edgeId: edge.id, fixHint: 'Make the source node a condition node, or rebuild the edge as sequence.' }));
        }
        if (edgeType === 'condition' && edge.data?.conditionValue === undefined) {
          errors.push(issue('missing_condition_value', 'condition edge requires conditionValue', { edgeId: edge.id, fixHint: 'Recreate the edge with condition_value=true/false.' }));
        }
        if (edgeType === 'loop' && source.data?.type !== 'loop') {
          errors.push(issue('invalid_loop_edge', 'loop edge source must be a loop node', { edgeId: edge.id, fixHint: 'Loop body edges must start at a loop node; rebuild as sequence otherwise.' }));
        }
        if (source.data?.type === 'parallel' && edgeType !== 'sequence' && edgeType !== 'data') {
          errors.push(issue('invalid_parallel_edge', 'parallel node branches must use sequence edges; use data edges only for mapping', { edgeId: edge.id, fixHint: 'Rebuild branch edge as sequence.' }));
        }
        if (edgeType === 'data' && (!edge.data?.dataMapping || Object.keys(edge.data.dataMapping).length === 0)) {
          warnings.push(issue('missing_data_mapping', 'data edge should define dataMapping', { edgeId: edge.id, fixHint: 'Add data_mapping when re-creating, e.g. {"content":"content"}.' }));
        }
      }

      for (const node of workflow.nodes as NodeDefinition[]) {
        const nodeType = node.data?.type;
        const config: NodeConfig = node.data?.config ?? {};
        if (nodeType === 'tool') validateToolNode(node, config, params.workflow_id, context, errors, warnings);
        if (nodeType === 'condition') validateConditionNode(node, config, workflow.edges, params.workflow_id, errors);
        if (nodeType === 'loop') validateLoopNode(node, config, workflow.edges, params.workflow_id, errors);
        if (nodeType === 'parallel') validateParallelNode(node, workflow.edges, params.workflow_id, errors);
        if (nodeType === 'schedule_trigger') validateScheduleTriggerNode(node, config, params.workflow_id, errors);
        validateDataNode(node, nodeType, config, errors, warnings);
      }

      for (const node of findUnreachableNodes(workflow.nodes as NodeDefinition[], workflow.edges as EdgeDefinition[])) {
        warnings.push(issue('unreachable_node', 'node has no incoming control edge and is not a graph entry; it may never run in intended order', { nodeId: node.id, fixHint: 'Connect it from an upstream node or confirm it is an intentional entry node.', suggestedToolCall: `workflow(action="connect", workflow_id="${params.workflow_id}", source_node_id="<upstream>", target_node_id="${node.id}", edge_type="sequence")` }));
      }
      const nextSuggestedActions = errors.length > 0
        ? errors.slice(0, 6).map(error => error.suggestedToolCall || error.fixHint || `Fix ${error.type}`)
        : warnings.length > 0
          ? warnings.slice(0, 4).map(warning => warning.suggestedToolCall || warning.fixHint || `Review ${warning.type}`)
          : [`workflow(action="execute", workflow_id="${params.workflow_id}", options={"mode":"sync"})`];

      return {
        success: true,
        data: {
          workflowId: workflow.id,
          valid: errors.length === 0,
          errors,
          warnings,
          nextSuggestedActions
        }
      };
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : 'Failed to validate workflow' };
    }
  }
}

function issue(type: string, message: string, rest: Partial<Issue>): Issue {
  return { type, message, ...rest };
}

function validateConditionNode(node: NodeDefinition, config: NodeConfig, edges: EdgeDefinition[], workflowId: string, errors: Issue[]) {
  if (!config.conditionType) {
    errors.push(issue('missing_condition_type', 'condition node requires config.conditionType', { nodeId: node.id, fixHint: 'Set condition_type to expression or llm.' }));
  }
  if (config.conditionType === 'expression' && !config.expression) {
    errors.push(issue('missing_condition_expression', 'expression condition requires config.expression', { nodeId: node.id, fixHint: 'Set a JavaScript boolean expression.' }));
  }
  if (config.conditionType === 'llm') {
    if (!config.llmPrompt) {
      errors.push(issue('missing_condition_llm_prompt', 'llm condition requires config.llmPrompt', { nodeId: node.id, fixHint: 'Set llmPrompt.' }));
    }
    if (!config.conditionAgentRole) {
      errors.push(issue('missing_condition_agent_role', 'llm condition requires config.conditionAgentRole', { nodeId: node.id, fixHint: 'Set conditionAgentRole, e.g. evaluator.' }));
    }
  }
  const branchValues = new Set(edges
    .filter((edge) => edge.source === node.id && edge.data?.type === 'condition')
    .map((edge) => edge.data?.conditionValue));
  if (!branchValues.has(true)) errors.push(issue('missing_true_branch', 'condition node needs a true branch', { nodeId: node.id, fixHint: 'Connect a true branch.', suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${node.id}", target_node_id="<true_node>", edge_type="condition", condition_value=true)` }));
  if (!branchValues.has(false)) errors.push(issue('missing_false_branch', 'condition node needs a false branch', { nodeId: node.id, fixHint: 'Connect a false branch.', suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${node.id}", target_node_id="<false_node>", edge_type="condition", condition_value=false)` }));
}

function validateLoopNode(node: NodeDefinition, config: NodeConfig, edges: EdgeDefinition[], workflowId: string, errors: Issue[]) {
  const loopType = config.loopType;
  if (!loopType) errors.push(issue('missing_loop_type', 'loop node requires config.loopType', { nodeId: node.id, fixHint: 'Use count, while, or foreach when re-creating.' }));
  if (loopType === 'count' && config.loopCount == null) errors.push(issue('missing_loop_count', 'count loop requires loopCount', { nodeId: node.id, fixHint: 'Set loopCount when re-creating.' }));
  if (loopType === 'while' && !config.loopCondition) errors.push(issue('missing_loop_condition', 'while loop requires loopCondition', { nodeId: node.id, fixHint: 'Set loopCondition when re-creating.' }));
  if (loopType === 'foreach' && !config.loopItems) errors.push(issue('missing_loop_items', 'foreach loop requires loopItems', { nodeId: node.id, fixHint: 'Set loopItems to an array reference when re-creating.' }));
  if (!edges.some((edge) => edge.source === node.id && edge.data?.type === 'loop')) {
    errors.push(issue('missing_loop_body', 'loop node needs a loop body edge', { nodeId: node.id, fixHint: 'Connect loop node to body entry with edge_type loop.', suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${node.id}", target_node_id="<body_entry>", edge_type="loop")` }));
  }
}

function validateParallelNode(node: NodeDefinition, edges: EdgeDefinition[], workflowId: string, errors: Issue[]) {
  const branches = edges.filter((edge) => edge.source === node.id && (edge.data?.type ?? 'sequence') === 'sequence');
  if (branches.length < 2) {
    errors.push(issue('missing_parallel_branches', 'parallel node needs at least two sequence branches', { nodeId: node.id, fixHint: 'Connect at least two branch entry nodes with edge_type sequence.', suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${node.id}", target_node_id="<branch_entry>", edge_type="sequence")` }));
  }
}

function validateScheduleTriggerNode(node: NodeDefinition, config: NodeConfig, workflowId: string, errors: Issue[]) {
  const cron = typeof config.scheduleCron === 'string' && config.scheduleCron.trim()
    ? config.scheduleCron.trim()
    : '';
  if (!cron) {
    errors.push(issue('missing_schedule_cron', 'schedule_trigger requires config.scheduleCron', {
      nodeId: node.id,
      fixHint: 'Set scheduleCron to a five-field cron expression such as "0 9 * * *".',
      suggestedToolCall: `workflow(action="inspect", workflow_id="${workflowId}")`,
    }));
  } else if (getNextCronTime(cron, Date.now()) === null) {
    errors.push(issue('invalid_schedule_cron', `schedule_trigger has invalid cron: ${cron}`, {
      nodeId: node.id,
      fixHint: 'Use a five-field cron expression such as "0 9 * * *" or "*/15 * * * *".',
      suggestedToolCall: `workflow(action="inspect", workflow_id="${workflowId}")`,
    }));
  }

  if (config.scheduleIntensity !== undefined && !['gentle', 'normal', 'aggressive', 'critical'].includes(String(config.scheduleIntensity))) {
    errors.push(issue('invalid_schedule_intensity', 'scheduleIntensity must be gentle, normal, aggressive, or critical', {
      nodeId: node.id,
      fixHint: 'Choose intensity based on automation proactivity.',
    }));
  }
  if (config.scheduleAudience !== undefined && !['personal', 'team', 'ops', 'customer'].includes(String(config.scheduleAudience))) {
    errors.push(issue('invalid_schedule_audience', 'scheduleAudience must be personal, team, ops, or customer', {
      nodeId: node.id,
      fixHint: 'Choose audience based on who consumes the scheduled result.',
    }));
  }
}

function validateDataNode(node: NodeDefinition, nodeType: NodeType | string | undefined, config: NodeConfig, errors: Issue[], warnings: Issue[]) {
  if (nodeType === 'template' && config.template === undefined) {
    errors.push(issue('missing_template', 'template node requires config.template', { nodeId: node.id, fixHint: 'Set config.template or recreate via workflow(action="apply").' }));
  }
  if (nodeType === 'variable_assigner' && !config.assignments) {
    errors.push(issue('missing_assignments', 'variable_assigner requires config.assignments', { nodeId: node.id, fixHint: 'Set config.assignments to an object or [{name,value}] array.' }));
  }
  if (nodeType === 'list_operator' && !config.listSource && !node.data?.inputs?.items && !node.data?.inputs?.input) {
    warnings.push(issue('missing_list_source', 'list_operator should define config.listSource or receive items/input', { nodeId: node.id, fixHint: 'Set listSource to a variable reference such as ${input.items}.' }));
  }
  if (nodeType === 'http_request' && !config.httpRequest?.url) {
    errors.push(issue('missing_http_url', 'http_request node requires config.httpRequest.url', { nodeId: node.id, fixHint: 'Set config.httpRequest.url; execution delegates to the registered http_request tool.' }));
  }
  if (nodeType === 'json_extractor' && !config.jsonSource && !config.extractPaths) {
    warnings.push(issue('json_extractor_no_paths', 'json_extractor without jsonSource or extractPaths only parses/pass-throughs input', { nodeId: node.id, fixHint: 'Set jsonSource and extractPaths for deterministic extraction.' }));
  }
}

function validateToolNode(node: NodeDefinition, config: NodeConfig, workflowId: string, context: ToolContext | undefined, errors: Issue[], warnings: Issue[]) {
  const toolName = config.toolName;
  if (!toolName) {
    errors.push(issue('missing_tool_name', 'tool node requires config.toolName', { nodeId: node.id, fixHint: 'Pick a registered tool name when adding the node.' }));
    return;
  }
  const validation = validateToolArgsWithRegistry(context?.toolRegistry, toolName, config.toolArgs ?? {});
  if (validation.registryAvailable && !validation.toolFound) {
    errors.push(issue('unknown_tool_name', `unknown toolName: ${toolName}`, { nodeId: node.id, fixHint: 'Use a name that is registered in the current ToolRegistry.' }));
    return;
  }
  if (validation.errors.length > 0) {
    errors.push(issue('invalid_tool_args', `tool ${toolName} has invalid toolArgs: ${validation.errors.join('; ')}`, { nodeId: node.id, fixHint: 'Fill toolArgs according to the tool schema.' }));
  }
  void warnings;
  void workflowId;
}

function findUnreachableNodes(nodes: NodeDefinition[], edges: EdgeDefinition[]): NodeDefinition[] {
  const incomingControl = new Set(edges.filter(edge => (edge.data?.type ?? 'sequence') !== 'data').map(edge => edge.target));
  return nodes.filter(node => node.data?.type !== 'start' && node.data?.type !== 'input' && node.data?.type !== 'schedule_trigger' && !incomingControl.has(node.id));
}
