import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import { WorkflowAddNodeTool } from './WorkflowAddNodeTool.js';
import { WorkflowApplyTool } from './WorkflowApplyTool.js';
import { WorkflowAuditTool } from './WorkflowAuditTool.js';
import { WorkflowConnectTool } from './WorkflowConnectTool.js';
import { WorkflowCreateTool } from './WorkflowCreateTool.js';
import { WorkflowExecuteTool } from './WorkflowExecuteTool.js';
import { WorkflowGetStatusTool } from './WorkflowGetStatusTool.js';
import { WorkflowInspectTool } from './WorkflowInspectTool.js';
import { WorkflowValidateTool } from './WorkflowValidateTool.js';

const WorkflowToolSchema = z.object({
  action: z.enum(['create', 'apply', 'audit', 'add_node', 'connect', 'execute', 'get_status', 'inspect', 'validate'])
    .describe('Workflow action to run.'),

  // create/apply shared fields
  name: z.string().optional().describe('create/apply(create): workflow name. Required for action=create and for apply create mode.'),
  description: z.string().optional().describe('Workflow description.'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('create metadata such as tags/author/version.'),
  workflow_id: z.string().optional().describe('Existing workflow id. Required for add_node/connect/execute/inspect/validate/audit and apply replace/merge.'),

  // apply fields
  mode: z.enum(['create', 'replace', 'merge']).optional().describe('apply mode; create makes a new workflow, replace/merge update an existing workflow_id.'),
  tags: z.array(z.string()).optional().describe('apply: workflow tags.'),
  config: z.record(z.string(), z.unknown()).optional().describe('apply: workflow config.'),
  nodes: z.array(z.record(z.string(), z.unknown())).optional().describe('apply: workflow nodes DSL.'),
  edges: z.array(z.record(z.string(), z.unknown())).optional().describe('apply: workflow edges DSL.'),
  dry_run: z.boolean().optional().describe('apply: analyze without persisting.'),

  // add_node fields
  node_id: z.string().optional().describe('add_node: stable node id.'),
  node_type: z.string().optional().describe('add_node: node type such as agent/tool/condition/loop/parallel.'),
  label: z.string().optional().describe('add_node: node label.'),
  agent_role: z.string().optional().describe('add_node(agent): agent role.'),
  agent_model: z.string().optional().describe('add_node(agent): model name.'),
  system_prompt: z.string().optional().describe('add_node(agent): system prompt.'),
  tool_name: z.string().optional().describe('add_node(tool): registered tool name.'),
  tool_args: z.record(z.string(), z.unknown()).optional().describe('add_node(tool): tool arguments.'),
  template: z.string().optional().describe('add_node(template): template text.'),
  template_format: z.enum(['text', 'json']).optional().describe('add_node(template): output format.'),
  output_key: z.string().optional().describe('add_node(template/output): output key.'),
  assignments: z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.object({ name: z.string(), value: z.unknown() })),
  ]).optional().describe('add_node(variable_assigner): assignments.'),
  aggregate: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional().describe('add_node(variable_aggregator): aggregate mapping.'),
  list_source: z.string().optional().describe('add_node(list_operator): list source reference.'),
  list_operation: z.enum(['first', 'last', 'length', 'slice', 'join', 'flatten', 'unique', 'reverse', 'sort', 'pluck', 'compact']).optional().describe('add_node(list_operator): operation.'),
  list_property: z.string().optional().describe('add_node(list_operator): property for pluck.'),
  list_start: z.number().optional().describe('add_node(list_operator): slice start.'),
  list_end: z.number().optional().describe('add_node(list_operator): slice end.'),
  list_delimiter: z.string().optional().describe('add_node(list_operator): join delimiter.'),
  http_request: z.record(z.string(), z.unknown()).optional().describe('add_node(http_request): request config.'),
  json_source: z.string().optional().describe('add_node(json_extractor): JSON source reference.'),
  extract_paths: z.record(z.string(), z.string()).optional().describe('add_node(json_extractor): output-to-path mapping.'),
  condition_type: z.enum(['expression', 'llm']).optional().describe('add_node(condition): condition type.'),
  expression: z.string().optional().describe('add_node(condition): expression.'),
  llm_prompt: z.string().optional().describe('add_node(condition): LLM prompt.'),
  condition_agent_role: z.string().optional().describe('add_node(condition): agent role for LLM condition.'),
  condition_model: z.string().optional().describe('add_node(condition): model for LLM condition.'),
  loop_type: z.enum(['count', 'while', 'foreach']).optional().describe('add_node(loop): loop type.'),
  loop_count: z.number().optional().describe('add_node(loop): iteration count.'),
  loop_condition: z.string().optional().describe('add_node(loop): while condition.'),
  loop_items: z.string().optional().describe('add_node(loop): foreach item reference.'),
  scheduleCron: z.string().optional().describe('add_node(schedule_trigger): cron expression.'),
  scheduleSessionId: z.string().optional().describe('add_node(schedule_trigger): session id used when fired.'),
  schedulePrompt: z.string().optional().describe('add_node(schedule_trigger): note stored on the task.'),
  scheduleWorkflowInput: z.record(z.string(), z.unknown()).optional().describe('add_node(schedule_trigger): workflow input when fired.'),
  scheduleRecurring: z.boolean().optional().describe('add_node(schedule_trigger): recurring flag.'),
  scheduleDurable: z.boolean().optional().describe('add_node(schedule_trigger): durable flag.'),
  scheduleEnabled: z.boolean().optional().describe('add_node(schedule_trigger): enabled flag.'),
  scheduleIntensity: z.enum(['gentle', 'normal', 'aggressive', 'critical']).optional().describe('add_node(schedule_trigger): task intensity.'),
  scheduleAudience: z.enum(['personal', 'team', 'ops', 'customer']).optional().describe('add_node(schedule_trigger): task audience.'),
  inputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('add_node: node input definitions.'),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('add_node: node output definitions.'),
  position_x: z.number().optional().describe('add_node: x position.'),
  position_y: z.number().optional().describe('add_node: y position.'),

  // connect fields
  source_node_id: z.string().optional().describe('connect: source node id.'),
  target_node_id: z.string().optional().describe('connect: target node id.'),
  edge_type: z.enum(['sequence', 'condition', 'data', 'loop']).optional().describe('connect: edge type.'),
  condition_value: z.boolean().optional().describe('connect(condition): condition branch value.'),
  data_mapping: z.record(z.string(), z.string()).optional().describe('connect(data): source-to-target mapping.'),

  // execute/get_status/audit fields
  execution_id: z.string().optional().describe('get_status: execution id returned by action=execute.'),
  input: z.record(z.string(), z.unknown()).optional().describe('execute: workflow input variables.'),
  options: z.record(z.string(), z.unknown()).optional().describe('execute: execution options, e.g. {mode:"async"}.'),
  include_logs: z.boolean().optional().describe('get_status: include detailed logs.'),
  include_dify_parity: z.boolean().optional().describe('audit: include Dify parity notes.'),
}).strict().superRefine((value, ctx) => {
  const requireField = (field: string) => {
    if (!value[field as keyof typeof value]) {
      ctx.addIssue({ code: 'custom', path: [field], message: `action=${value.action} requires ${field}` });
    }
  };
  if (value.action === 'create') requireField('name');
  if (value.action === 'apply') {
    const applyMode = value.mode ?? 'create';
    if (applyMode === 'create') requireField('name');
    if (applyMode === 'replace' || applyMode === 'merge') requireField('workflow_id');
  }
  if (value.action === 'add_node') {
    requireField('workflow_id');
    requireField('node_type');
    requireField('label');
    if (value.node_type === 'schedule_trigger') requireField('scheduleCron');
  }
  if (value.action === 'connect') {
    requireField('workflow_id');
    requireField('source_node_id');
    requireField('target_node_id');
  }
  if (value.action === 'execute' || value.action === 'inspect' || value.action === 'validate' || value.action === 'audit') {
    requireField('workflow_id');
  }
  if (value.action === 'get_status') requireField('execution_id');
});

type WorkflowAction = z.infer<typeof WorkflowToolSchema>['action'];
type WorkflowToolInput = z.infer<typeof WorkflowToolSchema>;

const TARGETS: Record<WorkflowAction, Tool> = {
  create: new WorkflowCreateTool(),
  apply: new WorkflowApplyTool(),
  audit: new WorkflowAuditTool(),
  add_node: new WorkflowAddNodeTool(),
  connect: new WorkflowConnectTool(),
  execute: new WorkflowExecuteTool(),
  get_status: new WorkflowGetStatusTool(),
  inspect: new WorkflowInspectTool(),
  validate: new WorkflowValidateTool(),
};

export class WorkflowTool extends Tool {
  readonly name = 'workflow';
  readonly description = 'Workflow 统一入口：优先用 action=apply 一次性提交完整 DAG DSL；也支持 create/add_node/connect/execute/get_status/inspect/validate/audit。用于构建、审计、执行和修复本地轻量 workflow。';
  readonly parameters = WorkflowToolSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowToolSchema.parse(args);
    const { action, ...forwarded } = params as Record<string, unknown> & { action: WorkflowAction };
    return TARGETS[action].execute(forwarded, context);
  }
}
