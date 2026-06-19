import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import { analyzeWorkflow } from '../../../core/workflow/WorkflowAnalyzer.js';
import { syncWorkflowScheduleTriggers } from '../../../core/workflow/ScheduleTriggerSync.js';
import { validateToolArgsWithRegistry } from './WorkflowSchemaUtils.js';
import type { EdgeDefinition, NodeDefinition, NodeInput, NodeOutput, NodeType, WorkflowDefinition } from '../../../core/workflow/types.js';

const NodeTypeSchema = z.enum([
  'start',
  'leader',
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
]);

const NodeIOTypeSchema = z.enum(['string', 'number', 'boolean', 'object', 'array', 'any']);

const NodeInputSchema = z.object({
  type: NodeIOTypeSchema.default('any'),
  required: z.boolean().default(false),
  source: z.string().optional(),
  defaultValue: z.unknown().optional(),
});

const NodeOutputSchema = z.object({
  type: NodeIOTypeSchema.default('any'),
});

const WorkflowApplyNodeSchema = z.object({
  id: z.string().min(1).describe('Stable node id. Required so LLMs can refer to nodes deterministically.'),
  type: NodeTypeSchema,
  label: z.string().optional(),
  description: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  inputs: z.record(z.string(), NodeInputSchema).optional(),
  outputs: z.record(z.string(), NodeOutputSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const EdgeTypeSchema = z.enum(['sequence', 'condition', 'data', 'loop']);

const WorkflowApplyEdgeSchema = z.object({
  id: z.string().optional(),
  source: z.string().min(1),
  target: z.string().min(1),
  type: EdgeTypeSchema.default('sequence'),
  conditionValue: z.boolean().optional(),
  dataMapping: z.record(z.string(), z.string()).optional(),
});

const WorkflowApplySchema = z.object({
  mode: z.enum(['create', 'replace', 'merge']).default('create').describe('create: new workflow; replace: replace nodes/edges on existing workflow; merge: upsert nodes/edges by id.'),
  workflow_id: z.string().optional().describe('Existing workflow id for replace/merge; optional stable id for create.'),
  name: z.string().optional().describe('Workflow name; required when creating.'),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  config: z.object({
    maxExecutionTime: z.number().optional(),
    maxIterations: z.number().optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    workspace: z.string().optional(),
    sessionId: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    permissionMode: z.enum(['ask', 'allow', 'deny']).optional(),
  }).optional(),
  nodes: z.array(WorkflowApplyNodeSchema).default([]),
  edges: z.array(WorkflowApplyEdgeSchema).default([]),
  dry_run: z.boolean().default(false).describe('Analyze the DSL without persisting it.'),
}).strict();

type WorkflowApplyInput = z.infer<typeof WorkflowApplySchema>;

interface WorkflowCreateDraft {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  version: string;
  config: WorkflowDefinition['config'];
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  createdBy?: string;
}

interface WorkflowUpdateDraft {
  name?: string;
  description?: string;
  tags?: string[];
  config?: WorkflowDefinition['config'];
  nodes?: NodeDefinition[];
  edges?: EdgeDefinition[];
}

interface WorkflowManagerPort {
  create(definition: WorkflowCreateDraft): Promise<string>;
  get(id: string): Promise<WorkflowDefinition | undefined>;
  update(id: string, data: WorkflowUpdateDraft): Promise<void>;
}

export class WorkflowApplyTool extends Tool {
  readonly name = '__workflow_delegate_apply';
  readonly description = `一次性应用 workflow DSL，适合 LLM 直接构建或改造完整 DAG。

推荐用法：
- create: 提交 name + nodes + edges，创建完整 workflow
- replace: 提交 workflow_id + nodes + edges，整体替换图结构
- merge: 提交 workflow_id + nodes/edges，按稳定 id upsert

支持节点：start/input/schedule_trigger/leader/agent/tool/template/variable_assigner/variable_aggregator/list_operator/http_request/json_extractor/condition/loop/parallel/output。

schedule_trigger 节点保存后会同步为真实定时任务；config 至少需要 scheduleCron，可选 scheduleSessionId、scheduleWorkflowInput、scheduleIntensity、scheduleAudience、scheduleEnabled。

返回会包含 analyzer 结果、Dify 对标信息、errors/warnings 和下一步工具调用建议。`;

  readonly parameters = WorkflowApplySchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowApplySchema.parse(args);
    const workflowManager = context?.workflowManager as WorkflowManagerPort | undefined;
    if (!workflowManager) {
      return { success: false, data: null, error: 'WorkflowManager not available in context' };
    }

    try {
      const workflow = await buildWorkflow(params, workflowManager, context);
      const toolValidationErrors = validateWorkflowToolNodes(workflow, context);
      const analysis = analyzeWorkflow(workflow);
      const blockingErrors = [
        ...analysis.issues.filter(issue => issue.severity === 'error').map(issue => issue.message),
        ...toolValidationErrors,
      ];

      if (params.dry_run) {
        return {
          success: blockingErrors.length === 0,
          data: { workflow, analysis, dryRun: true, toolValidationErrors },
          error: blockingErrors.length > 0 ? `Workflow DSL has ${blockingErrors.length} blocking issue(s)` : undefined,
        };
      }

      if (toolValidationErrors.length > 0) {
        return {
          success: false,
          data: { workflow, analysis, toolValidationErrors },
          error: `Workflow DSL has invalid tool node(s): ${toolValidationErrors.join('; ')}`,
        };
      }

      let workflowId = workflow.id;
      if (params.mode === 'create') {
        workflowId = await workflowManager.create({
          id: params.workflow_id,
          name: workflow.name,
          description: workflow.description,
          tags: workflow.tags,
          version: workflow.version,
          config: workflow.config,
          nodes: workflow.nodes,
          edges: workflow.edges,
          createdBy: context?.agentName || context?.agentId,
        });
      } else {
        if (!params.workflow_id) {
          return { success: false, data: null, error: 'workflow_id is required for replace/merge mode' };
        }
        const existing = await workflowManager.get(params.workflow_id);
        if (!existing) {
          return { success: false, data: null, error: `Workflow not found: ${params.workflow_id}` };
        }
        await workflowManager.update(existing.id, {
          name: params.name,
          description: params.description,
          tags: params.tags,
          config: workflow.config,
          nodes: workflow.nodes,
          edges: workflow.edges,
        });
        workflowId = existing.id;
      }

      const saved = await workflowManager.get(workflowId);
      const savedAnalysis = saved ? analyzeWorkflow(saved) : analysis;
      const scheduledTaskManager = context?.scheduledTaskManager as Parameters<typeof syncWorkflowScheduleTriggers>[1] | undefined;
      const scheduleSync = saved && scheduledTaskManager
        ? syncWorkflowScheduleTriggers(saved, scheduledTaskManager)
        : undefined;
      return {
        success: savedAnalysis.issues.every(issue => issue.severity !== 'error'),
        data: {
          workflowId,
          mode: params.mode,
          nodeCount: saved?.nodes.length ?? workflow.nodes.length,
          edgeCount: saved?.edges.length ?? workflow.edges.length,
          analysis: savedAnalysis,
          scheduleSync,
          nextSuggestedActions: savedAnalysis.nextSuggestedActions,
          message: 'Workflow DSL applied. Run validate/audit before execute if analysis reports warnings.',
        },
        error: savedAnalysis.issues.some(issue => issue.severity === 'error')
          ? `Workflow applied but has ${savedAnalysis.issues.filter(issue => issue.severity === 'error').length} blocking issue(s)`
          : undefined,
      };
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : 'Failed to apply workflow DSL' };
    }
  }
}

function validateWorkflowToolNodes(workflow: WorkflowDefinition, context?: ToolContext): string[] {
  const errors: string[] = [];
  for (const node of workflow.nodes) {
    if (node.data?.type !== 'tool') continue;
    const config = node.data.config ?? {};
    const toolName = typeof config.toolName === 'string' && config.toolName.trim()
      ? config.toolName.trim()
      : '';
    if (!toolName) {
      errors.push(`${node.id}: tool node requires config.toolName`);
      continue;
    }
    const validation = validateToolArgsWithRegistry(context?.toolRegistry, toolName, config.toolArgs ?? {});
    if (validation.registryAvailable && !validation.toolFound) {
      errors.push(`${node.id}: unknown toolName "${toolName}"`);
      continue;
    }
    if (validation.errors.length > 0) {
      errors.push(`${node.id}: invalid toolArgs for "${toolName}": ${validation.errors.join('; ')}`);
    }
  }
  return errors;
}

async function buildWorkflow(params: WorkflowApplyInput, workflowManager: Pick<WorkflowManagerPort, 'get'>, context?: ToolContext): Promise<WorkflowDefinition> {
  const now = Date.now();
  const existing = params.workflow_id ? await workflowManager.get(params.workflow_id) : null;

  if (params.mode !== 'create' && !params.workflow_id) {
    throw new Error(`workflow_id is required for mode=${params.mode}`);
  }
  if (params.mode === 'create' && !params.name) {
    throw new Error('name is required for mode=create');
  }
  if ((params.mode === 'replace' || params.mode === 'merge') && !existing) {
    throw new Error(`Workflow not found: ${params.workflow_id}`);
  }

  const base: WorkflowDefinition = existing
    ? cloneWorkflow(existing)
    : {
      id: params.workflow_id || `wf-${Date.now().toString(36)}`,
      name: params.name!,
      description: params.description,
      version: '1.0.0',
      nodes: [],
      edges: [],
      config: {
        maxExecutionTime: 3600,
        maxIterations: 1000,
        variables: {},
        workspace: context?.workspace,
        sessionId: context?.sessionId,
        permissionMode: 'ask',
      },
      createdAt: now,
      updatedAt: now,
      tags: params.tags,
    };

  base.name = params.name ?? base.name;
  base.description = params.description ?? base.description;
  base.tags = params.tags ?? base.tags;
  base.config = {
    ...base.config,
    ...params.config,
    variables: {
      ...(base.config.variables ?? {}),
      ...(params.config?.variables ?? {}),
    },
    workspace: params.config?.workspace ?? base.config.workspace ?? context?.workspace,
    sessionId: params.config?.sessionId ?? base.config.sessionId ?? context?.sessionId,
  };
  base.updatedAt = now;

  const newNodes = params.nodes.map((node, index) => toNodeDefinition(node, index));
  const newEdges = params.edges.map((edge, index) => toEdgeDefinition(edge, index));

  if (params.mode === 'merge') {
    base.nodes = upsertById(base.nodes, newNodes);
    base.edges = upsertById(base.edges, newEdges);
  } else {
    base.nodes = newNodes;
    base.edges = newEdges;
  }

  ensureUniqueIds(base.nodes.map(node => node.id), 'node');
  ensureUniqueIds(base.edges.map(edge => edge.id), 'edge');
  return base;
}

function toNodeDefinition(input: z.infer<typeof WorkflowApplyNodeSchema>, index: number): NodeDefinition {
  return {
    id: input.id,
    type: 'workflow',
    position: input.position ?? { x: 280 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 140 },
    data: {
      label: input.label ?? input.id,
      type: input.type as NodeType,
      status: 'idle',
      description: input.description,
      config: input.config ?? {},
      inputs: normalizeInputs(input.inputs),
      outputs: normalizeOutputs(input.outputs),
      metadata: input.metadata,
    },
  };
}

function toEdgeDefinition(input: z.infer<typeof WorkflowApplyEdgeSchema>, index: number): EdgeDefinition {
  return {
    id: input.id ?? `e-${input.source}-${input.target}-${index}`,
    source: input.source,
    target: input.target,
    type: 'workflow',
    data: {
      type: input.type,
      conditionValue: input.conditionValue,
      dataMapping: input.dataMapping,
    },
  };
}

function normalizeInputs(inputs?: Record<string, z.infer<typeof NodeInputSchema>>): Record<string, NodeInput> {
  const out: Record<string, NodeInput> = {};
  for (const [name, input] of Object.entries(inputs ?? {})) {
    out[name] = {
      name,
      type: input.type,
      required: input.required,
      source: input.source,
      defaultValue: input.defaultValue,
    };
  }
  return out;
}

function normalizeOutputs(outputs?: Record<string, z.infer<typeof NodeOutputSchema>>): Record<string, NodeOutput> {
  const out: Record<string, NodeOutput> = {};
  for (const [name, output] of Object.entries(outputs ?? {})) {
    out[name] = { name, type: output.type };
  }
  return out;
}

function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
}

function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  const map = new Map(current.map(item => [item.id, item]));
  for (const update of updates) map.set(update.id, update);
  return Array.from(map.values());
}

function ensureUniqueIds(ids: string[], kind: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${kind} id: ${id}`);
    }
    seen.add(id);
  }
}
