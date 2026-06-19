import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import { getToolScaffold, validateToolArgsWithRegistry } from './WorkflowSchemaUtils.js';
import { getNextCronTime } from '../../../core/ScheduledTaskManager.js';
import { syncWorkflowScheduleTriggers } from '../../../core/workflow/ScheduleTriggerSync.js';
import type { NodeConfig, NodeDefinition, NodeInput, NodeOutput, WorkflowDefinition } from '../../../core/workflow/types.js';

const DATA_CONTROL_NODE_TYPES = new Set<string>([
  'template',
  'variable_assigner',
  'variable_aggregator',
  'list_operator',
  'http_request',
  'json_extractor',
]);

const WorkflowAddNodeSchema = z.object({
  workflow_id: z.string().describe('Workflow ID'),
  node_id: z.string().optional().describe('可选的稳定节点 ID；需要后续连接时传入自定义 ID，方便后续 workflow(action="connect") 引用'),
  node_type: z.enum([
    'agent',
    'tool',
    'template',
    'variable_assigner',
    'variable_aggregator',
    'list_operator',
    'http_request',
    'json_extractor',
    'condition',
    'loop',
    'parallel',
    'schedule_trigger',
    'input',
    'output',
  ])
    .describe('节点类型'),
  label: z.string().describe('节点标签'),
  description: z.string().optional().describe('节点描述'),
  
  // Agent 节点配置
  agent_role: z.string().optional().describe('Agent 角色（如 researcher, coder）'),
  agent_model: z.string().optional().describe('LLM 模型名称'),
  system_prompt: z.string().optional().describe('系统提示词'),
  
  // Tool 节点配置
  tool_name: z.string().optional().describe('工具名称（如 file_read, shell）'),
  tool_args: z.record(z.string(), z.unknown()).optional().describe('工具参数'),

  // Built-in data 节点配置
  template: z.string().optional().describe('template 节点模板文本，支持 ${input.foo} / ${workflow.variables.foo}'),
  template_format: z.enum(['text', 'json']).optional().describe('template 输出格式'),
  output_key: z.string().optional().describe('template 输出字段 key'),
  assignments: z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.object({ name: z.string(), value: z.unknown() })),
  ]).optional().describe('variable_assigner 变量赋值表'),
  aggregate: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional().describe('variable_aggregator 聚合映射'),
  list_source: z.string().optional().describe('list_operator 列表来源变量引用，例如 ${input.items}'),
  list_operation: z.enum(['first', 'last', 'length', 'slice', 'join', 'flatten', 'unique', 'reverse', 'sort', 'pluck', 'compact']).optional().describe('list_operator 操作'),
  list_property: z.string().optional().describe('pluck 操作的属性路径'),
  list_start: z.number().optional().describe('slice 起点'),
  list_end: z.number().optional().describe('slice 终点'),
  list_delimiter: z.string().optional().describe('join 分隔符'),
  http_request: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']).optional(),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    timeout: z.number().optional(),
    maxResponseSize: z.number().optional(),
    followRedirects: z.boolean().optional(),
  }).optional().describe('http_request 节点请求配置；执行时委托已注册 http_request tool'),
  json_source: z.string().optional().describe('json_extractor JSON 来源变量引用'),
  extract_paths: z.record(z.string(), z.string()).optional().describe('json_extractor 路径提取映射'),
  
  // Condition 节点配置
  condition_type: z.enum(['expression', 'llm']).optional().describe('条件类型'),
  expression: z.string().optional().describe('JavaScript 表达式'),
  llm_prompt: z.string().optional().describe('LLM 判断提示词'),
  condition_agent_role: z.string().optional().describe('LLM 条件使用的 Agent 角色，condition_type=llm 时必填，建议 evaluator'),
  condition_model: z.string().optional().describe('LLM 条件使用的模型，condition_type=llm 时建议显式指定'),
  
  // Loop 节点配置
  loop_type: z.enum(['count', 'while', 'foreach']).optional().describe('循环类型'),
  loop_count: z.number().optional().describe('循环次数'),
  loop_condition: z.string().optional().describe('循环条件表达式'),
  loop_items: z.string().optional().describe('遍历的数组变量引用'),

  // Schedule Trigger 节点配置
  scheduleCron: z.string().optional().describe('schedule_trigger cron 表达式，例如 "0 9 * * *" 或 "*/15 * * * *"'),
  scheduleSessionId: z.string().optional().describe('schedule_trigger 触发时使用的 sessionId；不传则使用 workflow.config.sessionId 或 default'),
  schedulePrompt: z.string().optional().describe('schedule_trigger 在 scheduled_tasks 中展示/记录的提示说明'),
  scheduleWorkflowInput: z.record(z.string(), z.unknown()).optional().describe('schedule_trigger 触发 workflow 时注入的 workflow input'),
  scheduleRecurring: z.boolean().optional().describe('schedule_trigger 是否循环触发，默认 true'),
  scheduleDurable: z.boolean().optional().describe('schedule_trigger 是否持久化，默认 true'),
  scheduleEnabled: z.boolean().optional().describe('schedule_trigger 是否启用，默认 true'),
  scheduleIntensity: z.enum(['gentle', 'normal', 'aggressive', 'critical']).optional().describe('schedule_trigger 执行强度'),
  scheduleAudience: z.enum(['personal', 'team', 'ops', 'customer']).optional().describe('schedule_trigger 面向用户群体'),
  
  // 输入输出配置
  inputs: z.record(z.string(), z.object({
    type: z.string(),
    required: z.boolean().default(false),
    source: z.string().optional()
  })).optional().describe('输入配置'),
  
  outputs: z.record(z.string(), z.object({
    type: z.string()
  })).optional().describe('输出配置'),
  
  // 位置（可选，用于可视化）
  position_x: z.number().optional().describe('X 坐标'),
  position_y: z.number().optional().describe('Y 坐标'),
}).strict();

interface WorkflowManagerPort {
  addNode(id: string, node: Omit<NodeDefinition, 'id'> & { id?: string }): Promise<string>;
  get(id: string): Promise<WorkflowDefinition | undefined>;
}

export class WorkflowAddNodeTool extends Tool {
  readonly name = '__workflow_delegate_add_node';
  readonly description = `向 workflow 添加节点。

节点类型：
- agent: 调用 AI Agent 执行任务（必填 agent_role 或 system_prompt）
- tool: 调用工具（必填 tool_name；tool_args 要匹配该工具 Zod schema）
- template: 文本/JSON 模板节点（必填 template）
- variable_assigner: 设置 workflow 变量（必填 assignments）
- variable_aggregator: 聚合上游/变量为结构化对象（aggregate 可选，默认聚合 input）
- list_operator: first/last/length/slice/join/flatten/unique/reverse/sort/pluck/compact
- http_request: HTTP 请求节点（必填 http_request.url；委托现有 http_request tool，不绕过网络治理）
- json_extractor: JSON/参数提取节点（json_source/extract_paths 可选但建议显式提供）
- condition: 条件分支；必填 condition_type；expression 模式要有 expression；llm 模式要有 llm_prompt 和 condition_agent_role，建议同时指定 condition_model
- loop: 循环节点；必填 loop_type；count 要 loop_count；while 要 loop_condition；foreach 要 loop_items。循环体要再 add_node 并用 workflow(action="connect", edge_type="loop") 连接
- parallel: 并行分发节点；分支入口用 sequence 边连接，至少两条
- schedule_trigger: 定时触发入口节点；必填 scheduleCron。保存后同步为真实 scheduled_tasks，并可设置 scheduleIntensity/scheduleAudience 区分自动化强度和用户群体
- input: 输入节点（透传外部数据）
- output: 输出节点（设置 __output__，会在 workflow(action="execute") 结果中返回）

执行器行为备注：
- tool 节点返回值是 ToolResult.data（例如 file_read 返回裸 string，不是 { content })，data 边映射裸值时可用 source path "." / "result" / "content" / "text"
- condition_type="llm" 会真实调用 workflow agent executor
- parallel 的分支探测只看出边的 edge_type=="sequence"，填入 parallel_branches 字段不会被引擎读取

需要后续引用时传入稳定 node_id。

返回：
- nodeId: 生成的节点 ID
- label: 节点标签
- type: 节点类型
- diagnostics.recommendedNextStep: 针对节点类型的续接提示
- warnings: 静态校验发现的问题（缺必填、工具名未注册等）
- message: 可直接续接的简短说明`;

  readonly parameters = WorkflowAddNodeSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowAddNodeSchema.parse(args);

    if (!context) {
      return { success: false, data: null, error: 'Tool context not available' };
    }
    const workflowManager = context.workflowManager as WorkflowManagerPort | undefined;
    if (!workflowManager) {
      return {
        success: false,
        data: null,
        error: 'WorkflowManager not available in context'
      };
    }

    // ─── 静态校验：缺必填字段时直接报错，不产生残废节点 ───
    const validationErrors: string[] = [];
    const warnings: string[] = [];
    switch (params.node_type) {
      case 'tool':
        if (!params.tool_name) {
          validationErrors.push('node_type=tool requires tool_name (must match a registered ToolRegistry name).');
        } else {
          const toolArgsValidation = validateToolArgsWithRegistry(context.toolRegistry, params.tool_name, params.tool_args ?? {});
          if (toolArgsValidation.registryAvailable && !toolArgsValidation.toolFound) {
            validationErrors.push(`Unknown tool_name: "${params.tool_name}". Use a name registered in the current ToolRegistry.`);
          }
          if (toolArgsValidation.errors.length > 0) {
            validationErrors.push(`Invalid tool_args for "${params.tool_name}": ${toolArgsValidation.errors.join('; ')}.`);
          }
        }
        break;
      case 'condition':
        if (!params.condition_type) {
          validationErrors.push('node_type=condition requires condition_type ("expression" or "llm").');
        } else if (params.condition_type === 'expression' && !params.expression) {
          validationErrors.push('condition_type="expression" requires expression (a JavaScript boolean expression).');
        } else if (params.condition_type === 'llm') {
          if (!params.llm_prompt) {
            validationErrors.push('condition_type="llm" requires llm_prompt.');
          }
          if (!params.condition_agent_role) {
            validationErrors.push('condition_type="llm" requires condition_agent_role, e.g. "evaluator".');
          }
        }
        break;
      case 'template':
        if (params.template === undefined) {
          validationErrors.push('node_type=template requires template.');
        }
        break;
      case 'variable_assigner':
        if (!params.assignments) {
          validationErrors.push('node_type=variable_assigner requires assignments.');
        }
        break;
      case 'http_request':
        if (!params.http_request?.url) {
          validationErrors.push('node_type=http_request requires http_request.url.');
        }
        break;
      case 'list_operator':
        if (params.list_operation === 'pluck' && !params.list_property) {
          validationErrors.push('list_operation=pluck requires list_property.');
        }
        break;
      case 'loop': {
        const loopType = params.loop_type ?? 'count';
        if (loopType === 'while' && !params.loop_condition) {
          validationErrors.push('loop_type="while" requires loop_condition (expression).');
        } else if (loopType === 'foreach' && !params.loop_items) {
          validationErrors.push('loop_type="foreach" requires loop_items (variable reference, e.g. ${variables.items}).');
        }
        break;
      }
      case 'schedule_trigger':
        if (!params.scheduleCron?.trim()) {
          validationErrors.push('node_type=schedule_trigger requires scheduleCron.');
        } else if (getNextCronTime(params.scheduleCron, Date.now()) === null) {
          validationErrors.push(`Invalid scheduleCron for schedule_trigger: "${params.scheduleCron}". Use five-field cron such as "0 9 * * *".`);
        }
        break;
      case 'agent':
        if (!params.agent_role && !params.system_prompt) {
          warnings.push('agent node without agent_role or system_prompt will use the default role.');
        }
        break;
      default:
        break;
    }

    if (validationErrors.length > 0) {
      return { success: false, data: { warnings }, error: validationErrors.join(' ') };
    }

    try {
      // 构建节点配置
      const config: NodeConfig = {};
      if (params.agent_role) config.agentRole = params.agent_role;
      if (params.agent_model) config.agentModel = params.agent_model;
      if (params.system_prompt) config.systemPrompt = params.system_prompt;
      let toolScaffold: ReturnType<typeof getToolScaffold> | undefined;
      if (params.tool_name) {
        config.toolName = params.tool_name;
        const registry = context.toolRegistry as { get: (name: string) => unknown } | undefined;
        const tool = registry && typeof registry.get === 'function' ? registry.get(params.tool_name) : undefined;
        if (tool) toolScaffold = getToolScaffold(tool);
      }
      if (params.tool_args) config.toolArgs = params.tool_args;
      if (params.template !== undefined) config.template = params.template;
      if (params.template_format) config.templateFormat = params.template_format;
      if (params.output_key) config.outputKey = params.output_key;
      if (params.assignments) config.assignments = params.assignments;
      if (params.aggregate) config.aggregate = params.aggregate;
      if (params.list_source) config.listSource = params.list_source;
      if (params.list_operation) config.listOperation = params.list_operation;
      if (params.list_property) config.listProperty = params.list_property;
      if (params.list_start !== undefined) config.listStart = params.list_start;
      if (params.list_end !== undefined) config.listEnd = params.list_end;
      if (params.list_delimiter) config.listDelimiter = params.list_delimiter;
      if (params.http_request) config.httpRequest = params.http_request;
      if (params.json_source) config.jsonSource = params.json_source;
      if (params.extract_paths) config.extractPaths = params.extract_paths;
      if (params.condition_type || params.node_type === 'condition') config.conditionType = params.condition_type ?? 'expression';
      if (params.expression) config.expression = params.expression;
      if (params.llm_prompt) config.llmPrompt = params.llm_prompt;
      if (params.condition_agent_role) config.conditionAgentRole = params.condition_agent_role;
      if (params.condition_model) config.conditionModel = params.condition_model;
      if (params.node_type === 'loop') {
        config.loopType = params.loop_type ?? 'count';
        config.loopCount = config.loopType === 'count' ? (params.loop_count ?? 3) : undefined;
      }
      if (params.loop_condition) config.loopCondition = params.loop_condition;
      if (params.loop_items) config.loopItems = params.loop_items;
      if (params.node_type === 'parallel') {
        config.parallelBranches = [];
        config.waitAll = true;
      }
      if (params.node_type === 'schedule_trigger') {
        config.scheduleCron = params.scheduleCron;
        if (params.scheduleSessionId) config.scheduleSessionId = params.scheduleSessionId;
        if (params.schedulePrompt) config.schedulePrompt = params.schedulePrompt;
        config.scheduleWorkflowInput = params.scheduleWorkflowInput ?? {};
        config.scheduleRecurring = params.scheduleRecurring ?? true;
        config.scheduleDurable = params.scheduleDurable ?? true;
        config.scheduleEnabled = params.scheduleEnabled ?? true;
        config.scheduleIntensity = params.scheduleIntensity ?? 'normal';
        config.scheduleAudience = params.scheduleAudience ?? 'personal';
      }

      // 构建输入配置
      const inputs: Record<string, NodeInput> = {};
      if (params.inputs) {
        for (const [key, inputDef] of Object.entries(params.inputs)) {
          inputs[key] = {
            name: key,
            type: inputDef.type as NodeInput['type'],
            required: inputDef.required,
            source: inputDef.source
          };
        }
      }

      // 构建输出配置
      const outputs: Record<string, NodeOutput> = {};
      if (params.outputs) {
        for (const [key, outputDef] of Object.entries(params.outputs)) {
          outputs[key] = {
            name: key,
            type: outputDef.type as NodeOutput['type']
          };
        }
      }

      // 添加节点
      const nodeId = await workflowManager.addNode(params.workflow_id, {
        id: params.node_id,
        type: 'workflow',
        position: {
          x: params.position_x ?? 300,
          y: params.position_y ?? 200
        },
        data: {
          label: params.label,
          type: params.node_type,
          status: 'idle',
          description: params.description,
          config,
          inputs,
          outputs
        }
      });
      const workflow = await workflowManager.get(params.workflow_id);
      const scheduledTaskManager = context.scheduledTaskManager as Parameters<typeof syncWorkflowScheduleTriggers>[1] | undefined;
      const scheduleSync = workflow && scheduledTaskManager
        ? syncWorkflowScheduleTriggers(workflow, scheduledTaskManager)
        : undefined;

      return {
        success: true,
        data: {
          nodeId,
          label: params.label,
          type: params.node_type,
          config,
          toolArgsScaffold: toolScaffold?.argsScaffold,
          missingRequiredToolArgs: toolScaffold && !params.tool_args ? toolScaffold.requiredFields : undefined,
          scheduleSync,
          warnings: warnings.length > 0 ? warnings : undefined,
          diagnostics: {
            stableIdProvided: Boolean(params.node_id),
            recommendedNextStep: params.node_type === 'schedule_trigger'
              ? 'Connect this schedule trigger to the first workflow node; saving has synced it to scheduled tasks when a scheduler is available.'
              : params.node_type === 'loop'
              ? 'Add loop body nodes, then connect the loop node to the body with edge_type="loop".'
              : params.node_type === 'parallel'
                ? 'Add at least two branch nodes, then connect this parallel node to each branch with edge_type="sequence".'
                : params.node_type === 'condition'
                  ? 'Connect true/false branches with edge_type="condition" and condition_value=true/false.'
                  : DATA_CONTROL_NODE_TYPES.has(params.node_type)
                    ? 'Connect data/control edges, then run workflow(action="audit") to verify data flow.'
                  : 'Connect this node to upstream/downstream nodes or add data edges as needed.'
          },
          message: 'Node added successfully. Use workflow(action="connect") to connect it to other nodes.'
        }
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : 'Failed to add node'
      };
    }
  }
}
