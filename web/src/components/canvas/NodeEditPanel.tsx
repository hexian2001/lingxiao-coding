/**
 * NodeEditPanel — 画布内节点编辑面板（Dify 风格）
 *
 * 点击节点时在画布右侧弹出，支持编辑：
 * - 标签、描述
 * - 类型特定配置（Agent: model/prompt; Tool: params; Condition: expr）
 * - 保存/取消
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Save, RotateCcw, Play, Cpu, Wrench, GitBranch, Terminal, Zap, Bot, Repeat, GitMerge, Braces, List, Globe, Clock } from 'lucide-react';
import { getServerToken } from '../../api/headers';
import type { Node } from '@xyflow/react';
import type { WorkflowNodeConfig, WorkflowNodeData, NodeType } from './CanvasView';
import { useTranslation } from 'react-i18next';

interface ModelOption {
  id: string;
  provider: string;
  label: string;
}

interface ToolSchemaInfo {
  name: string;
  description: string;
  parameters?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
    required?: string[];
  };
}

type JsonRecord = Record<string, unknown>;
type ConditionType = NonNullable<WorkflowNodeConfig['conditionType']>;
type LoopType = NonNullable<WorkflowNodeConfig['loopType']>;
type ScheduleIntensity = NonNullable<WorkflowNodeConfig['scheduleIntensity']>;
type ScheduleAudience = NonNullable<WorkflowNodeConfig['scheduleAudience']>;
type InputSource = 'user' | 'file' | 'api' | 'webhook';
type OutputFormat = 'text' | 'json' | 'markdown' | 'file';

const NODE_TYPE_VALUES = [
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
] as const satisfies readonly NodeType[];
const CONDITION_TYPE_VALUES = ['expression', 'llm'] as const satisfies readonly ConditionType[];
const LOOP_TYPE_VALUES = ['count', 'while', 'foreach'] as const satisfies readonly LoopType[];
const SCHEDULE_INTENSITY_VALUES = ['gentle', 'normal', 'aggressive', 'critical'] as const satisfies readonly ScheduleIntensity[];
const SCHEDULE_AUDIENCE_VALUES = ['personal', 'team', 'ops', 'customer'] as const satisfies readonly ScheduleAudience[];
const INPUT_SOURCE_VALUES = ['user', 'file', 'api', 'webhook'] as const satisfies readonly InputSource[];
const OUTPUT_FORMAT_VALUES = ['text', 'json', 'markdown', 'file'] as const satisfies readonly OutputFormat[];
const NODE_TYPE_SET = new Set<NodeType>(NODE_TYPE_VALUES);
const CONDITION_TYPE_SET = new Set<ConditionType>(CONDITION_TYPE_VALUES);
const LOOP_TYPE_SET = new Set<LoopType>(LOOP_TYPE_VALUES);
const SCHEDULE_INTENSITY_SET = new Set<ScheduleIntensity>(SCHEDULE_INTENSITY_VALUES);
const SCHEDULE_AUDIENCE_SET = new Set<ScheduleAudience>(SCHEDULE_AUDIENCE_VALUES);
const INPUT_SOURCE_SET = new Set<InputSource>(INPUT_SOURCE_VALUES);
const OUTPUT_FORMAT_SET = new Set<OutputFormat>(OUTPUT_FORMAT_VALUES);
const SCHEDULE_TRIGGER_ALIAS_CONFIG_KEYS = [
  'cron',
  'sessionId',
  'prompt',
  'recurring',
  'durable',
  'enabled',
  'intensity',
  'audience',
  'workflowInput',
  'input',
  'workflow_input',
  'schedule_cron',
  'schedule_session_id',
  'schedule_prompt',
  'schedule_recurring',
  'schedule_durable',
  'schedule_enabled',
  'schedule_intensity',
  'schedule_audience',
  'schedule_workflow_input',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(values: unknown[], fallback = ''): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined;
}

function parseNodeType(value: unknown): NodeType {
  return parseOneOf(value, NODE_TYPE_SET) ?? 'agent';
}

function parseConditionType(value: unknown): ConditionType {
  return parseOneOf(value, CONDITION_TYPE_SET) ?? 'expression';
}

function parseLoopType(value: unknown): LoopType {
  return parseOneOf(value, LOOP_TYPE_SET) ?? 'count';
}

function parseScheduleIntensity(value: unknown): ScheduleIntensity | undefined {
  return parseOneOf(value, SCHEDULE_INTENSITY_SET);
}

function parseScheduleAudience(value: unknown): ScheduleAudience | undefined {
  return parseOneOf(value, SCHEDULE_AUDIENCE_SET);
}

function parseInputSource(value: unknown): InputSource {
  return parseOneOf(value, INPUT_SOURCE_SET) ?? 'user';
}

function parseOutputFormat(value: unknown): OutputFormat {
  return parseOneOf(value, OUTPUT_FORMAT_SET) ?? 'text';
}

function readConfig(value: unknown): WorkflowNodeConfig {
  const record = isRecord(value) ? value : {};
  return isRecord(record.config) ? { ...record.config } as WorkflowNodeConfig : {};
}

function removeScheduleTriggerAliasFields(config: WorkflowNodeConfig): void {
  for (const key of SCHEDULE_TRIGGER_ALIAS_CONFIG_KEYS) {
    delete config[key];
  }
}

function parseConfiguredModelsResponse(value: unknown): ModelOption[] {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : {};
  const models: ModelOption[] = [];
  const providers = Array.isArray(data.providers) ? data.providers : [];
  for (const provider of providers) {
    if (!isRecord(provider)) continue;
    const providerId = readString(provider.id);
    if (!providerId) continue;
    const providerModels = Array.isArray(provider.models) ? provider.models : [];
    for (const model of providerModels) {
      if (!isRecord(model)) continue;
      const id = readString(model.id);
      if (!id) continue;
      models.push({ id, provider: providerId, label: `${id} (${providerId})` });
    }
  }
  const currentModel = readOptionalString(data.model);
  const currentProvider = readString(data.provider, 'auto');
  if (currentModel && !models.find((model) => model.id === currentModel)) {
    models.unshift({ id: currentModel, provider: currentProvider, label: `${currentModel} (current)` });
  }
  return models;
}

function parseToolProperty(value: unknown): NonNullable<NonNullable<ToolSchemaInfo['parameters']>['properties']>[string] | null {
  if (!isRecord(value)) return null;
  return {
    type: readOptionalString(value.type),
    description: readOptionalString(value.description),
    enum: Array.isArray(value.enum) ? value.enum : undefined,
  };
}

function parseToolParameters(value: unknown): ToolSchemaInfo['parameters'] {
  if (!isRecord(value)) return undefined;
  const properties: NonNullable<NonNullable<ToolSchemaInfo['parameters']>['properties']> = {};
  if (isRecord(value.properties)) {
    for (const [key, property] of Object.entries(value.properties)) {
      const parsed = parseToolProperty(property);
      if (parsed) properties[key] = parsed;
    }
  }
  return {
    type: readOptionalString(value.type),
    properties,
    required: readStringArray(value.required),
  };
}

function parseToolSchemaInfo(value: unknown): ToolSchemaInfo | null {
  if (!isRecord(value)) return null;
  const name = readString(value.name).trim();
  if (!name) return null;
  return {
    name,
    description: readString(value.description),
    parameters: parseToolParameters(value.parameters),
  };
}

function parseToolRegistryResponse(value: unknown): ToolSchemaInfo[] {
  const tools = isRecord(value) && Array.isArray(value.tools) ? value.tools : [];
  return tools.flatMap((tool) => {
    const parsed = parseToolSchemaInfo(tool);
    return parsed ? [parsed] : [];
  });
}

/** Fetch configured models from backend settings API */
async function fetchConfiguredModels(): Promise<ModelOption[]> {
  try {
    const res = await fetch('/api/v1/settings', { headers: { 'x-lingxiao-token': getServerToken() } });
    if (!res.ok) return [];
    const body: unknown = await res.json().catch(() => ({}));
    return parseConfiguredModelsResponse(body);
  } catch (err) {
    console.warn('[NodeEditPanel] Failed to fetch configured models:', err);
  }
  return [];
}

async function fetchToolRegistry(): Promise<ToolSchemaInfo[]> {
  try {
    const res = await fetch('/api/v1/tools', { headers: { 'x-lingxiao-token': getServerToken() } });
    if (!res.ok) return [];
    const body: unknown = await res.json().catch(() => ({}));
    return parseToolRegistryResponse(body);
  } catch (err) {
    console.warn('[NodeEditPanel] Failed to fetch tool registry:', err);
    return [];
  }
}

interface NodeEditPanelProps {
  node: Node;
  onClose: () => void;
  onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
  onRun?: (nodeId: string) => void;
}

const typeOptions: { value: NodeType; label: string; icon: React.ReactNode }[] = [
  { value: 'leader', label: 'Leader', icon: <Bot size={14} /> },
  { value: 'agent', label: 'Agent', icon: <Cpu size={14} /> },
  { value: 'tool', label: 'Tool', icon: <Wrench size={14} /> },
  { value: 'template', label: 'Template', icon: <Terminal size={14} /> },
  { value: 'variable_assigner', label: 'Assigner', icon: <Braces size={14} /> },
  { value: 'variable_aggregator', label: 'Aggregator', icon: <GitMerge size={14} /> },
  { value: 'list_operator', label: 'List Op', icon: <List size={14} /> },
  { value: 'http_request', label: 'HTTP', icon: <Globe size={14} /> },
  { value: 'json_extractor', label: 'JSON', icon: <Braces size={14} /> },
  { value: 'condition', label: 'Condition', icon: <GitBranch size={14} /> },
  { value: 'loop', label: 'Loop', icon: <Repeat size={14} /> },
  { value: 'parallel', label: 'Parallel', icon: <GitMerge size={14} /> },
  { value: 'schedule_trigger', label: 'Schedule', icon: <Clock size={14} /> },
  { value: 'input', label: 'Input', icon: <Terminal size={14} /> },
  { value: 'output', label: 'Output', icon: <Zap size={14} /> },
];

const dataNodeTypes = new Set<NodeType>([
  'template',
  'variable_assigner',
  'variable_aggregator',
  'list_operator',
  'http_request',
  'json_extractor',
]);

function isDataNodeType(type: NodeType): boolean {
  return dataNodeTypes.has(type);
}

function defaultDataNodeConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'template':
      return { template: 'Hello ${input.name}', templateFormat: 'text' };
    case 'variable_assigner':
      return { assignments: { value: '${input.value}' } };
    case 'variable_aggregator':
      return { aggregate: {} };
    case 'list_operator':
      return { listSource: '${input.items}', listOperation: 'length' };
    case 'http_request':
      return { httpRequest: { method: 'GET', url: 'https://example.com' } };
    case 'json_extractor':
      return { jsonSource: '${input.text}', extractPaths: { value: '.' } };
    default:
      return {};
  }
}

function stringifyParams(value: unknown): string {
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); }
  catch (err) {
    if (import.meta.env.DEV) console.warn('[NodeEditPanel] Failed to stringify params:', err);
    return '';
  }
}

function parseWorkflowNodeConfig(value: string): WorkflowNodeConfig {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config must be a JSON object.');
  }
  return parsed as WorkflowNodeConfig;
}

function readNodeFormData(rawData: unknown) {
  const data = isRecord(rawData) ? rawData : {};
  const config = readConfig(rawData);
  const scheduleIntensity = parseScheduleIntensity(config.scheduleIntensity) ?? 'normal';
  const scheduleAudience = parseScheduleAudience(config.scheduleAudience) ?? 'personal';
  return {
    label: readString(data.label),
    description: readString(data.description),
    type: parseNodeType(data.type),
    agentModel: firstString([config.agentModel, data.agentModel, data.model]),
    agentPrompt: firstString([config.systemPrompt, data.agentPrompt, data.prompt]),
    agentId: firstString([config.agentRole, data.agentId]),
    toolName: firstString([config.toolName, data.toolName]),
    toolParams: stringifyParams(config.toolArgs ?? data.toolParams),
    conditionExpr: firstString([config.expression, data.conditionExpr, data.expression]),
    conditionType: parseConditionType(config.conditionType),
    llmPrompt: readString(config.llmPrompt),
    conditionAgentRole: firstString([config.conditionAgentRole], 'evaluator'),
    conditionModel: firstString([config.conditionModel, config.agentModel, data.agentModel, data.model]),
    conditionTrueTarget: readString(data.trueTarget),
    conditionFalseTarget: readString(data.falseTarget),
    loopType: parseLoopType(config.loopType),
    loopCount: typeof config.loopCount === 'number' ? String(config.loopCount) : firstString([config.loopCount], '10'),
    loopCondition: readString(config.loopCondition),
    loopItems: readString(config.loopItems),
    parallelBranches: readStringArray(config.parallelBranches).join(', '),
    scheduleCron: firstString([config.scheduleCron], '0 9 * * *'),
    scheduleSessionId: firstString([config.scheduleSessionId]),
    schedulePrompt: firstString([config.schedulePrompt]),
    scheduleRecurring: readBoolean(config.scheduleRecurring, true),
    scheduleDurable: readBoolean(config.scheduleDurable, true),
    scheduleEnabled: readBoolean(config.scheduleEnabled, true),
    scheduleIntensity,
    scheduleAudience,
    scheduleWorkflowInput: stringifyParams(config.scheduleWorkflowInput ?? {}),
    inputSource: parseInputSource(data.inputSource),
    outputFormat: parseOutputFormat(data.outputFormat),
    configJson: stringifyParams(config),
  };
}

export default function NodeEditPanel({ node, onClose, onUpdate, onRun }: NodeEditPanelProps) {
  const { t } = useTranslation();
  const initial = readNodeFormData(node.data);
  const lastSyncedNodeId = useRef(node.id);
  const [label, setLabel] = useState(initial.label);
  const [description, setDescription] = useState(initial.description);
  const [type, setType] = useState<NodeType>(initial.type);
  const [agentModel, setAgentModel] = useState(initial.agentModel);
  const [agentPrompt, setAgentPrompt] = useState(initial.agentPrompt);
  const [agentId, setAgentId] = useState(initial.agentId);
  const [toolName, setToolName] = useState(initial.toolName);
  const [toolParams, setToolParams] = useState(initial.toolParams);
  const [formError, setFormError] = useState('');
  const [conditionExpr, setConditionExpr] = useState(initial.conditionExpr);
  const [conditionType, setConditionType] = useState<'expression' | 'llm'>(initial.conditionType);
  const [llmPrompt, setLlmPrompt] = useState(initial.llmPrompt);
  const [conditionAgentRole, setConditionAgentRole] = useState(initial.conditionAgentRole);
  const [conditionModel, setConditionModel] = useState(initial.conditionModel);
  const [conditionTrueTarget, setConditionTrueTarget] = useState(initial.conditionTrueTarget);
  const [conditionFalseTarget, setConditionFalseTarget] = useState(initial.conditionFalseTarget);
  const [loopType, setLoopType] = useState<'count' | 'while' | 'foreach'>(initial.loopType);
  const [loopCount, setLoopCount] = useState(initial.loopCount);
  const [loopCondition, setLoopCondition] = useState(initial.loopCondition);
  const [loopItems, setLoopItems] = useState(initial.loopItems);
  const [parallelBranches, setParallelBranches] = useState(initial.parallelBranches);
  const [scheduleCron, setScheduleCron] = useState(initial.scheduleCron);
  const [scheduleSessionId, setScheduleSessionId] = useState(initial.scheduleSessionId);
  const [schedulePrompt, setSchedulePrompt] = useState(initial.schedulePrompt);
  const [scheduleRecurring, setScheduleRecurring] = useState(Boolean(initial.scheduleRecurring));
  const [scheduleDurable, setScheduleDurable] = useState(Boolean(initial.scheduleDurable));
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(initial.scheduleEnabled));
  const [scheduleIntensity, setScheduleIntensity] = useState<'gentle' | 'normal' | 'aggressive' | 'critical'>(initial.scheduleIntensity);
  const [scheduleAudience, setScheduleAudience] = useState<'personal' | 'team' | 'ops' | 'customer'>(initial.scheduleAudience);
  const [scheduleWorkflowInput, setScheduleWorkflowInput] = useState(initial.scheduleWorkflowInput);
  const [inputSource, setInputSource] = useState(initial.inputSource);
  const [outputFormat, setOutputFormat] = useState(initial.outputFormat);
  const [configJson, setConfigJson] = useState(initial.configJson);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [customModelInput, setCustomModelInput] = useState('');
  const [availableTools, setAvailableTools] = useState<ToolSchemaInfo[]>([]);

  // Fetch configured models from backend on mount
  useEffect(() => {
    fetchConfiguredModels().then(setAvailableModels);
    fetchToolRegistry().then(setAvailableTools);
  }, []);

  // Sync only when switching to another node. Parent node.data identity changes can be caused by autosave/SSE
  // and must not wipe in-progress edits in this panel.
  useEffect(() => {
    if (lastSyncedNodeId.current === node.id) return;
    lastSyncedNodeId.current = node.id;
    const next = readNodeFormData(node.data);
    setLabel(next.label);
    setDescription(next.description);
    setType(next.type);
    setAgentModel(next.agentModel);
    setAgentPrompt(next.agentPrompt);
    setAgentId(next.agentId);
    setToolName(next.toolName);
    setToolParams(next.toolParams);
    setFormError('');
    setConditionExpr(next.conditionExpr);
    setConditionType(next.conditionType);
    setLlmPrompt(next.llmPrompt);
    setConditionAgentRole(next.conditionAgentRole);
    setConditionModel(next.conditionModel);
    setConditionTrueTarget(next.conditionTrueTarget);
    setConditionFalseTarget(next.conditionFalseTarget);
    setLoopType(next.loopType);
    setLoopCount(next.loopCount);
    setLoopCondition(next.loopCondition);
    setLoopItems(next.loopItems);
    setParallelBranches(next.parallelBranches);
    setScheduleCron(next.scheduleCron);
    setScheduleSessionId(next.scheduleSessionId);
    setSchedulePrompt(next.schedulePrompt);
    setScheduleRecurring(Boolean(next.scheduleRecurring));
    setScheduleDurable(Boolean(next.scheduleDurable));
    setScheduleEnabled(Boolean(next.scheduleEnabled));
    setScheduleIntensity(next.scheduleIntensity);
    setScheduleAudience(next.scheduleAudience);
    setScheduleWorkflowInput(next.scheduleWorkflowInput);
    setInputSource(next.inputSource);
    setOutputFormat(next.outputFormat);
    setConfigJson(next.configJson);
  }, [node.id, node.data]);

  const handleSave = useCallback(() => {
    setFormError('');
    const patch: Partial<WorkflowNodeData> = { label, description, type };
    
    // Build config object without dropping existing fields.
    let config: WorkflowNodeConfig = readConfig(node.data);
    
    if (type === 'agent' || type === 'leader') {
      patch.agentModel = agentModel;
      patch.agentPrompt = agentPrompt;
      patch.agentId = agentId;
      config.agentRole = agentId;
      config.agentModel = agentModel;
      config.systemPrompt = agentPrompt;
    }
    if (type === 'tool') {
      const trimmedToolName = toolName.trim();
      if (!trimmedToolName) {
        setFormError('Tool node requires selecting a tool.');
        return;
      }
      if (availableTools.length > 0 && !availableTools.some((tool) => tool.name === trimmedToolName)) {
        setFormError(`Unknown tool: ${trimmedToolName}`);
        return;
      }
      let parsedToolParams: unknown = undefined;
      try {
        parsedToolParams = toolParams.trim() ? JSON.parse(toolParams) : {};
      } catch (error) {
        setFormError(`Parameters must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      patch.toolName = trimmedToolName;
      patch.toolParams = parsedToolParams;
      config.toolName = trimmedToolName;
      config.toolArgs = parsedToolParams;
    }
    if (isDataNodeType(type)) {
      try {
        config = parseWorkflowNodeConfig(configJson);
      } catch (error) {
        setFormError(`Config must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (type === 'template' && config.template === undefined) {
        setFormError('Template node requires config.template.');
        return;
      }
      if (type === 'variable_assigner' && !config.assignments) {
        setFormError('Variable assigner requires config.assignments.');
        return;
      }
      if (type === 'http_request' && !config.httpRequest?.url) {
        setFormError('HTTP request requires config.httpRequest.url.');
        return;
      }
    }
    if (type === 'condition') {
      if (conditionType === 'expression' && !conditionExpr.trim()) {
        setFormError('Expression condition requires an expression.');
        return;
      }
      if (conditionType === 'llm') {
        if (!llmPrompt.trim()) {
          setFormError('LLM condition requires a prompt.');
          return;
        }
        if (!conditionAgentRole.trim()) {
          setFormError('LLM condition requires an agent role.');
          return;
        }
      }
      patch.conditionExpr = conditionExpr;
      patch.trueTarget = conditionTrueTarget;
      patch.falseTarget = conditionFalseTarget;
      config.conditionType = conditionType;
      config.expression = conditionExpr;
      config.llmPrompt = llmPrompt;
      config.conditionAgentRole = conditionType === 'llm' ? conditionAgentRole.trim() : undefined;
      config.conditionModel = conditionType === 'llm' ? conditionModel.trim() : undefined;
    }
    if (type === 'loop') {
      config.loopType = loopType;
      config.loopCount = loopType === 'count' ? parseInt(loopCount) || 10 : undefined;
      config.loopCondition = loopType === 'while' ? loopCondition : undefined;
      config.loopItems = loopType === 'foreach' ? loopItems : undefined;
    }
    if (type === 'parallel') {
      config.parallelBranches = parallelBranches.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (type === 'schedule_trigger') {
      if (!scheduleCron.trim()) {
        setFormError('Schedule trigger requires a cron expression.');
        return;
      }
      let parsedWorkflowInput: unknown = {};
      try {
        parsedWorkflowInput = scheduleWorkflowInput.trim() ? JSON.parse(scheduleWorkflowInput) : {};
      } catch (error) {
        setFormError(`Workflow input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!parsedWorkflowInput || typeof parsedWorkflowInput !== 'object' || Array.isArray(parsedWorkflowInput)) {
        setFormError('Workflow input must be a JSON object.');
        return;
      }
      config.scheduleCron = scheduleCron.trim();
      config.scheduleSessionId = scheduleSessionId.trim() || undefined;
      config.schedulePrompt = schedulePrompt.trim() || undefined;
      config.scheduleRecurring = scheduleRecurring;
      config.scheduleDurable = scheduleDurable;
      config.scheduleEnabled = scheduleEnabled;
      config.scheduleIntensity = scheduleIntensity;
      config.scheduleAudience = scheduleAudience;
      config.scheduleWorkflowInput = parsedWorkflowInput as Record<string, unknown>;
      removeScheduleTriggerAliasFields(config);
    }
    if (type === 'input') {
      patch.inputSource = inputSource;
    }
    if (type === 'output') {
      patch.outputFormat = outputFormat;
    }

    patch.config = config;

    // Save through callback instead of canvasStore
    onUpdate(node.id, patch);
    onClose();
  }, [node.data, node.id, label, description, type, agentModel, agentPrompt, agentId, toolName, toolParams,
      availableTools, conditionExpr, conditionType, llmPrompt, conditionAgentRole, conditionModel, conditionTrueTarget, conditionFalseTarget,
      loopType, loopCount, loopCondition, loopItems, parallelBranches, scheduleCron, scheduleSessionId, schedulePrompt,
      scheduleRecurring, scheduleDurable, scheduleEnabled, scheduleIntensity, scheduleAudience, scheduleWorkflowInput,
      inputSource, outputFormat, configJson, onClose, onUpdate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSave(); }
  }, [onClose, handleSave]);

  const isStart = type === 'start';
  const canRunSingleNode = !isStart && type !== 'loop' && type !== 'parallel';
  const typeConfig = typeOptions.find((t) => t.value === type);

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-80 bg-bg-secondary border-l border-border-default z-40 flex flex-col shadow-xl animate-in slide-in-from-right duration-200"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default">
        {typeConfig?.icon || <Cpu size={14} />}
        <span className="text-xs font-mono text-text-primary flex-1 truncate">
          {isStart ? 'Start Node' : label || 'Edit Node'}
        </span>
        {canRunSingleNode && (
          <button
            className="p-1 text-text-tertiary hover:text-accent-green"
            onClick={() => {
              if (onRun) {
                onRun(node.id);
              }
            }}
            title="Run from this node"
          >
            <Play size={14} />
          </button>
        )}
        <button
          className="p-1 text-text-tertiary hover:text-text-primary"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X size={14} />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Label */}
        <div>
          <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={isStart}
            className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary disabled:opacity-50"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isStart}
            placeholder="Brief description..."
            className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary disabled:opacity-50"
          />
        </div>

        {/* Type selector (not for start node) */}
        {!isStart && (
          <div>
            <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Type</label>
            <div className="grid grid-cols-3 gap-1">
              {typeOptions.map((opt) => (
                <button
                  key={opt.value}
                  className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded border transition-colors ${
                    type === opt.value
                      ? 'border-accent-brand text-accent-brand bg-accent-brand/10'
                      : 'border-border-default text-text-tertiary hover:bg-bg-hover'
                  }`}
                  onClick={() => {
                    setType(opt.value);
                    if (isDataNodeType(opt.value) && opt.value !== type) {
                      setConfigJson(JSON.stringify(defaultDataNodeConfig(opt.value), null, 2));
                    }
                  }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Data node config */}
        {isDataNodeType(type) && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="flex items-center gap-2">
              <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider flex-1">Config JSON</div>
              <button
                type="button"
                className="p-1 text-text-tertiary hover:text-accent-brand border border-border-default rounded"
                title="Reset default config"
                onClick={() => setConfigJson(JSON.stringify(defaultDataNodeConfig(type), null, 2))}
              >
                <RotateCcw size={12} />
              </button>
            </div>
            <textarea
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
              rows={8}
              className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono resize-y min-h-[140px]"
            />
          </div>
        )}

        {/* Agent/Leader config */}
        {(type === 'agent' || type === 'leader') && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Agent Config</div>
            {type === 'agent' && (
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Agent ID</label>
                <input
                  type="text"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder="e.g. researcher"
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                />
              </div>
            )}
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Model</label>
              <div className="flex gap-1">
                <select
                  value={availableModels.find(m => m.id === agentModel) ? agentModel : '__custom__'}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      setCustomModelInput(agentModel);
                    } else {
                      setAgentModel(e.target.value);
                      setCustomModelInput('');
                    }
                  }}
                  className="flex-1 px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                >
                  {availableModels.length > 0 ? (
                    <>
                      {availableModels.map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                      <option value="__custom__">Custom...</option>
                    </>
                  ) : (
                    <option value="__custom__">No models configured</option>
                  )}
                </select>
                {(!availableModels.find(m => m.id === agentModel) || customModelInput) && (
                  <input
                    type="text"
                    value={customModelInput || agentModel}
                    onChange={(e) => {
                      setCustomModelInput(e.target.value);
                      setAgentModel(e.target.value);
                    }}
                    placeholder="e.g. glm-5.1, claude-sonnet-4"
                    className="flex-1 px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                  />
                )}
              </div>
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">System Prompt</label>
              <textarea
                value={agentPrompt}
                onChange={(e) => setAgentPrompt(e.target.value)}
                placeholder="You are a helpful assistant that..."
                rows={4}
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary resize-y min-h-[60px]"
              />
            </div>
          </div>
        )}

        {/* Tool config */}
        {type === 'tool' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Tool Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Tool Name</label>
              {availableTools.length > 0 ? (
                <select
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                >
                  <option value="">— pick a tool —</option>
                  {availableTools.map((t) => (
                    <option key={t.name} value={t.name}>{t.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  placeholder="e.g. file_read, shell"
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                />
              )}
              {(() => {
                const schema = availableTools.find((t) => t.name === toolName);
                if (!schema) return null;
                const required = schema.parameters?.required || [];
                const requiredSet = new Set(required);
                const props = schema.parameters?.properties || {};
                return (
                  <div className="mt-1.5 p-2 bg-bg-secondary/40 border border-border-muted rounded space-y-0.5">
                    <div className="text-[10px] text-text-secondary">{schema.description}</div>
                    {Object.keys(props).length > 0 && (
                      <div className="pt-1 border-t border-border-muted/50">
                        <div className="text-[9px] font-mono text-accent-brand/70 uppercase tracking-wider mb-1">Parameters</div>
                        {Object.entries(props).map(([key, p]) => (
                          <div key={key} className="text-[10px] font-mono text-text-tertiary flex gap-1.5">
                            <span className={requiredSet.has(key) ? 'text-accent-red' : ''}>{key}{requiredSet.has(key) ? '*' : '?'}</span>
                            <span className="text-text-tertiary/70">: {p.type || 'unknown'}</span>
                            {p.description && <span className="text-text-tertiary/50 truncate">— {p.description}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Parameters (JSON)</label>
              <textarea
                value={toolParams}
                onChange={(e) => setToolParams(e.target.value)}
                placeholder='{"path": "/tmp/file.txt"}'
                rows={3}
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono resize-y min-h-[40px]"
              />
              <button
                className="mt-1 text-[10px] text-accent-brand hover:underline"
                type="button"
                onClick={() => {
                  const schema = availableTools.find((t) => t.name === toolName);
                  if (!schema) return;
                  const props = schema.parameters?.properties || {};
                  const required = schema.parameters?.required || [];
                  const scaffold: Record<string, unknown> = {};
                  for (const key of required) {
                    const p = props[key];
                    scaffold[key] = p?.type === 'number' ? 0 : p?.type === 'boolean' ? false : '';
                  }
                  setToolParams(JSON.stringify(scaffold, null, 2));
                }}
              >
                Scaffold required params
              </button>
            </div>
          </div>
        )}

        {/* Condition config */}
        {type === 'condition' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Condition Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Condition Type</label>
              <div className="flex gap-2">
                <button
                  className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                    conditionType === 'expression'
                      ? 'border-accent-brand text-accent-brand bg-accent-brand/10'
                      : 'border-border-default text-text-tertiary hover:bg-bg-hover'
                  }`}
                  onClick={() => setConditionType('expression')}
                >
                  Expression
                </button>
                <button
                  className={`flex-1 px-2 py-1.5 text-xs rounded border transition-colors ${
                    conditionType === 'llm'
                      ? 'border-accent-brand text-accent-brand bg-accent-brand/10'
                      : 'border-border-default text-text-tertiary hover:bg-bg-hover'
                  }`}
                  onClick={() => setConditionType('llm')}
                >
                  LLM Judge
                </button>
              </div>
            </div>
            {conditionType === 'expression' ? (
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">
                  Expression <span className="text-text-tertiary/50">(JavaScript)</span>
                </label>
                <input
                  type="text"
                  value={conditionExpr}
                  onChange={(e) => setConditionExpr(e.target.value)}
                  placeholder="e.g. ${'{'}node_id.output{'}'}.includes('success')"
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                />
                <div className="mt-1 text-[9px] text-text-tertiary">
                  Use ${'{'}node_id.output{'}'} to reference node outputs
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">LLM Prompt</label>
                  <textarea
                    value={llmPrompt}
                    onChange={(e) => setLlmPrompt(e.target.value)}
                    placeholder="Evaluate if the result is successful..."
                    rows={3}
                    className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary resize-y min-h-[40px]"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Agent Role</label>
                  <input
                    type="text"
                    value={conditionAgentRole}
                    onChange={(e) => setConditionAgentRole(e.target.value)}
                    placeholder="e.g. evaluator"
                    className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Model</label>
                  <select
                    value={availableModels.find(m => m.id === conditionModel) ? conditionModel : '__custom__'}
                    onChange={(e) => {
                      if (e.target.value === '__custom__') return;
                      setConditionModel(e.target.value);
                    }}
                    className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                  >
                    {availableModels.map(m => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    <option value="__custom__">Custom / default</option>
                  </select>
                  {(!availableModels.find(m => m.id === conditionModel)) && (
                    <input
                      type="text"
                      value={conditionModel}
                      onChange={(e) => setConditionModel(e.target.value)}
                      placeholder="leave blank to use role default"
                      className="mt-1 w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                    />
                  )}
                </div>
              </>
            )}
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">True → Target Node</label>
              <input
                type="text"
                value={conditionTrueTarget}
                onChange={(e) => setConditionTrueTarget(e.target.value)}
                placeholder="node-id if true"
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">False → Target Node</label>
              <input
                type="text"
                value={conditionFalseTarget}
                onChange={(e) => setConditionFalseTarget(e.target.value)}
                placeholder="node-id if false"
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
              />
            </div>
          </div>
        )}

        {/* Loop config */}
        {type === 'loop' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Loop Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Loop Type</label>
              <div className="grid grid-cols-3 gap-1">
                <button
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    loopType === 'count'
                      ? 'border-accent-brand text-accent-brand bg-accent-brand/10'
                      : 'border-border-default text-text-tertiary hover:bg-bg-hover'
                  }`}
                  onClick={() => setLoopType('count')}
                >
                  Count
                </button>
                <button
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    loopType === 'while'
                      ? 'border-accent-brand text-accent-brand bg-accent-brand/10'
                      : 'border-border-default text-text-tertiary hover:bg-bg-hover'
                  }`}
                  onClick={() => setLoopType('while')}
                >
                  While
                </button>
                <button
                  className={`px-2 py-1 text-[10px] rounded border transition-colors ${
                    loopType === 'foreach'
                      ? 'border-accent-brand text-accent-brand bg-accent-brand/10'
                      : 'border-border-default text-text-tertiary hover:bg-bg-hover'
                  }`}
                  onClick={() => setLoopType('foreach')}
                >
                  ForEach
                </button>
              </div>
            </div>
            {loopType === 'count' && (
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Iteration Count</label>
                <input
                  type="number"
                  value={loopCount}
                  onChange={(e) => setLoopCount(e.target.value)}
                  placeholder="10"
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                />
              </div>
            )}
            {loopType === 'while' && (
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">While Condition</label>
                <input
                  type="text"
                  value={loopCondition}
                  onChange={(e) => setLoopCondition(e.target.value)}
                  placeholder="e.g. ${'{'}counter{'}'} < 10"
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                />
              </div>
            )}
            {loopType === 'foreach' && (
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Items (Variable Reference)</label>
                <input
                  type="text"
                  value={loopItems}
                  onChange={(e) => setLoopItems(e.target.value)}
                  placeholder="e.g. ${'{'}node_id.outputs.items{'}'}"
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
                />
              </div>
            )}
          </div>
        )}

        {/* Parallel config */}
        {type === 'parallel' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Parallel Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">
                Branch Node IDs <span className="text-text-tertiary/50">(comma-separated)</span>
              </label>
              <input
                type="text"
                value={parallelBranches}
                onChange={(e) => setParallelBranches(e.target.value)}
                placeholder="e.g. node-1, node-2, node-3"
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
              />
              <div className="mt-1 text-[9px] text-text-tertiary">
                These nodes will execute in parallel
              </div>
            </div>
          </div>
        )}

        {/* Schedule trigger config */}
        {type === 'schedule_trigger' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Schedule Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Cron</label>
              <input
                type="text"
                value={scheduleCron}
                onChange={(e) => setScheduleCron(e.target.value)}
                placeholder="0 9 * * *"
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Session ID</label>
              <input
                type="text"
                value={scheduleSessionId}
                onChange={(e) => setScheduleSessionId(e.target.value)}
                placeholder="default"
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Prompt / Note</label>
              <input
                type="text"
                value={schedulePrompt}
                onChange={(e) => setSchedulePrompt(e.target.value)}
                placeholder="Nightly workflow run"
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Intensity</label>
                <select
                  value={scheduleIntensity}
                  onChange={(e) => setScheduleIntensity(parseScheduleIntensity(e.target.value) ?? scheduleIntensity)}
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary"
                >
                  <option value="gentle">Gentle</option>
                  <option value="normal">Normal</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Audience</label>
                <select
                  value={scheduleAudience}
                  onChange={(e) => setScheduleAudience(parseScheduleAudience(e.target.value) ?? scheduleAudience)}
                  className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary"
                >
                  <option value="personal">Personal</option>
                  <option value="team">Team</option>
                  <option value="ops">Ops</option>
                  <option value="customer">Customer</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {[
                { text: 'Enabled', checked: scheduleEnabled, setChecked: setScheduleEnabled },
                { text: 'Recurring', checked: scheduleRecurring, setChecked: setScheduleRecurring },
                { text: 'Durable', checked: scheduleDurable, setChecked: setScheduleDurable },
              ].map((item) => (
                <label
                  key={item.text}
                  className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] border border-border-default rounded text-text-secondary hover:bg-bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={(e) => item.setChecked(e.target.checked)}
                    className="accent-accent-brand"
                  />
                  <span>{item.text}</span>
                </label>
              ))}
            </div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Workflow Input (JSON)</label>
              <textarea
                value={scheduleWorkflowInput}
                onChange={(e) => setScheduleWorkflowInput(e.target.value)}
                rows={5}
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary font-mono resize-y min-h-[90px]"
              />
            </div>
          </div>
        )}

        {/* Input config */}
        {type === 'input' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Input Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Source</label>
              <select
                value={inputSource}
                onChange={(e) => setInputSource(parseInputSource(e.target.value))}
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary"
              >
                <option value="user">User Input</option>
                <option value="file">File Upload</option>
                <option value="api">API Call</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
          </div>
        )}

        {/* Output config */}
        {type === 'output' && (
          <div className="space-y-3 pt-1">
            <div className="border-t border-border-default/50" />
            <div className="text-[10px] font-mono text-accent-brand/60 uppercase tracking-wider">Output Config</div>
            <div>
              <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Format</label>
              <select
                value={outputFormat}
                onChange={(e) => setOutputFormat(parseOutputFormat(e.target.value))}
                className="w-full px-2 py-1.5 text-xs bg-bg-input border border-border-input rounded text-text-primary"
              >
                <option value="text">Text</option>
                <option value="json">JSON</option>
                <option value="markdown">Markdown</option>
                <option value="file">File</option>
              </select>
            </div>
          </div>
        )}

        {/* Node ID (read-only) */}
        <div>
          <label className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider block mb-1">Node ID</label>
          <div className="px-2 py-1.5 text-[10px] font-mono text-text-tertiary bg-bg-tertiary border border-border-default rounded">
            {node.id}
          </div>
        </div>
      </div>

      {formError && (
        <div className="px-3 py-2 text-[11px] text-accent-red border-t border-border-default bg-accent-red/10">
          {formError}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border-default">
        <button
          className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-xs bg-accent-brand text-white rounded hover:bg-accent-brand/90 transition-colors"
          onClick={handleSave}
        >
          <Save size={12} />
          Save
        </button>
        <button
          className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary border border-border-default rounded transition-colors"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
