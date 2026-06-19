import { ExecutionGraph } from './ExecutionGraph.js';
import { getNextCronTime } from '../ScheduledTaskManager.js';
import type { EdgeDefinition, NodeDefinition, WorkflowDefinition } from './types.js';

export type WorkflowIssueSeverity = 'error' | 'warning' | 'info';

export interface WorkflowIssue {
  severity: WorkflowIssueSeverity;
  type: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  fixHint?: string;
  suggestedToolCall?: string;
}

export interface WorkflowAnalysis {
  summary: {
    workflowId: string;
    name: string;
    nodeCount: number;
    edgeCount: number;
    nodeTypes: Record<string, number>;
    startNodes: string[];
    terminalNodes: string[];
    maxDepth?: number;
    layerCount?: number;
  };
  difyParity: {
    supported: string[];
    partial: string[];
    missing: string[];
    notes: string[];
  };
  issues: WorkflowIssue[];
  nextSuggestedActions: string[];
  llmDslHint: {
    recommendedActions: string[];
    nodeTypes: string[];
    edgeTypes: string[];
    variableSyntax: string[];
  };
}

const LINGXIAO_NODE_TYPES = [
  'start',
  'input',
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
  'output',
];

const SCHEDULE_INTENSITIES = new Set(['gentle', 'normal', 'aggressive', 'critical']);
const SCHEDULE_AUDIENCES = new Set(['personal', 'team', 'ops', 'customer']);

export function analyzeWorkflow(workflow: WorkflowDefinition): WorkflowAnalysis {
  const issues: WorkflowIssue[] = [];
  const nodeById = new Map(workflow.nodes.map(node => [node.id, node]));
  const nodeTypes: Record<string, number> = {};

  for (const node of workflow.nodes) {
    const type = node.data?.type ?? '<missing>';
    nodeTypes[type] = (nodeTypes[type] ?? 0) + 1;
    analyzeNode(workflow.id, node, workflow.edges, issues);
  }

  analyzeEdges(workflow.id, workflow.nodes, workflow.edges, issues);

  let graphStats: ReturnType<ExecutionGraph['getStats']> | undefined;
  let startNodes: string[] = [];
  try {
    const graph = new ExecutionGraph(workflow);
    const validation = graph.validate();
    if (!validation.valid) {
      for (const error of validation.errors) {
        issues.push({
          severity: 'error',
          type: 'graph_error',
          message: error,
          fixHint: 'Inspect graph edges and remove cycles, dangling references, or isolated nodes.',
          suggestedToolCall: `workflow(action="inspect", workflow_id="${workflow.id}")`,
        });
      }
    }
    graphStats = graph.getStats();
    startNodes = graph.getStartNodes();
  } catch (error) {
    issues.push({
      severity: 'error',
      type: 'graph_error',
      message: error instanceof Error ? error.message : String(error),
      fixHint: 'Rebuild the graph with valid source/target node IDs.',
      suggestedToolCall: `workflow(action="inspect", workflow_id="${workflow.id}")`,
    });
  }

  const outgoingControl = new Set(workflow.edges
    .filter(edge => (edge.data?.type ?? 'sequence') !== 'data' && (edge.data?.type ?? 'sequence') !== 'loop')
    .map(edge => edge.source));
  const terminalNodes = workflow.nodes
    .filter(node => !outgoingControl.has(node.id))
    .map(node => node.id);

  if (workflow.nodes.length === 0) {
    issues.push({
      severity: 'error',
      type: 'empty_workflow',
      message: 'workflow has no nodes',
      fixHint: 'Create at least input/start and output nodes.',
      suggestedToolCall: `workflow(action="apply", mode="replace", workflow_id="${workflow.id}", nodes=[...], edges=[...])`,
    });
  }

  if (!workflow.nodes.some(node => node.data?.type === 'output')) {
    issues.push({
      severity: 'warning',
      type: 'missing_output_node',
      message: 'workflow has no output node, so full execution may not expose a final __output__',
      fixHint: 'Add an output node and connect terminal branches to it.',
      suggestedToolCall: `workflow(action="add_node", workflow_id="${workflow.id}", node_id="output", node_type="output", label="Output")`,
    });
  }

  for (const node of findUnreachableNodes(workflow.nodes, workflow.edges)) {
    issues.push({
      severity: 'warning',
      type: 'unreachable_node',
      nodeId: node.id,
      message: `node ${node.id} has no incoming control edge and is not an input/start/schedule_trigger node`,
      fixHint: 'Connect it from an upstream control node or make it an intentional graph entry.',
      suggestedToolCall: `workflow(action="connect", workflow_id="${workflow.id}", source_node_id="<upstream>", target_node_id="${node.id}", edge_type="sequence")`,
    });
  }

  const errors = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  const nextSuggestedActions = errors.length > 0
    ? errors.slice(0, 6).map(issue => issue.suggestedToolCall || issue.fixHint || `Fix ${issue.type}`)
    : warnings.length > 0
      ? warnings.slice(0, 5).map(issue => issue.suggestedToolCall || issue.fixHint || `Review ${issue.type}`)
      : [
        `workflow(action="execute", workflow_id="${workflow.id}", options={"mode":"sync"})`,
        `workflow(action="audit", workflow_id="${workflow.id}")`,
      ];

  return {
    summary: {
      workflowId: workflow.id,
      name: workflow.name,
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length,
      nodeTypes,
      startNodes,
      terminalNodes,
      maxDepth: graphStats?.maxDepth,
      layerCount: graphStats?.layerCount,
    },
    difyParity: buildDifyParity(workflow, nodeById),
    issues,
    nextSuggestedActions,
    llmDslHint: {
      recommendedActions: [
        'Use workflow(action="apply") for full DAG creation/replacement.',
        'Use stable node ids so later connect/merge calls are deterministic.',
        'Run workflow(action="validate") before execute.',
      ],
      nodeTypes: LINGXIAO_NODE_TYPES,
      edgeTypes: ['sequence', 'condition', 'data', 'loop'],
      variableSyntax: [
        '${input.field}',
        '${workflow.variables.name}',
        '${nodes.nodeId.outputs.key}',
        '${nodeId.result}',
        '${workflow.variables.loop.item}',
      ],
    },
  };
}

function analyzeNode(workflowId: string, node: NodeDefinition, edges: EdgeDefinition[], issues: WorkflowIssue[]): void {
  const type = node.data?.type;
  const config = node.data?.config ?? {};

  if (!node.id) {
    issues.push({ severity: 'error', type: 'missing_node_id', message: 'node is missing id' });
  }
  if (!type) {
    issues.push({ severity: 'error', type: 'missing_node_type', nodeId: node.id, message: 'node is missing data.type' });
    return;
  }

  if (type === 'tool' && !config.toolName) {
    issues.push(requiredConfig(workflowId, node.id, 'missing_tool_name', 'tool node requires config.toolName'));
  }
  if (type === 'template' && config.template === undefined) {
    issues.push(requiredConfig(workflowId, node.id, 'missing_template', 'template node requires config.template'));
  }
  if (type === 'variable_assigner' && !config.assignments) {
    issues.push(requiredConfig(workflowId, node.id, 'missing_assignments', 'variable_assigner requires config.assignments'));
  }
  if (type === 'list_operator' && !config.listSource && !node.data.inputs?.items && !node.data.inputs?.input) {
    issues.push({
      severity: 'warning',
      type: 'missing_list_source',
      nodeId: node.id,
      message: 'list_operator should define config.listSource or receive items/input from upstream',
      fixHint: 'Set listSource to a variable reference such as ${input.items}.',
    });
  }
  if (type === 'http_request' && !config.httpRequest?.url) {
    issues.push(requiredConfig(workflowId, node.id, 'missing_http_url', 'http_request node requires config.httpRequest.url'));
  }
  if (type === 'json_extractor' && !config.jsonSource && !config.extractPaths) {
    issues.push({
      severity: 'warning',
      type: 'json_extractor_no_paths',
      nodeId: node.id,
      message: 'json_extractor without jsonSource or extractPaths only parses/pass-throughs input',
      fixHint: 'Set jsonSource and extractPaths for deterministic extraction.',
    });
  }
  if (type === 'condition') {
    if (!config.conditionType) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_condition_type', 'condition node requires config.conditionType'));
    }
    if (config.conditionType === 'expression' && !config.expression) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_condition_expression', 'expression condition requires config.expression'));
    }
    if (config.conditionType === 'llm') {
      if (!config.llmPrompt) issues.push(requiredConfig(workflowId, node.id, 'missing_condition_llm_prompt', 'llm condition requires config.llmPrompt'));
      if (!config.conditionAgentRole) issues.push(requiredConfig(workflowId, node.id, 'missing_condition_agent_role', 'llm condition requires config.conditionAgentRole'));
    }
    const values = edges.filter(edge => edge.source === node.id && edge.data?.type === 'condition').map(edge => edge.data?.conditionValue);
    if (!values.includes(true)) {
      issues.push(branchIssue(workflowId, node.id, true));
    }
    if (!values.includes(false)) {
      issues.push(branchIssue(workflowId, node.id, false));
    }
  }
  if (type === 'loop') {
    if (!config.loopType) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_loop_type', 'loop node requires config.loopType'));
    }
    if (config.loopType === 'count' && config.loopCount == null) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_loop_count', 'count loop requires config.loopCount'));
    }
    if (config.loopType === 'while' && !config.loopCondition) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_loop_condition', 'while loop requires config.loopCondition'));
    }
    if (config.loopType === 'foreach' && !config.loopItems) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_loop_items', 'foreach loop requires config.loopItems'));
    }
    if (!edges.some(edge => edge.source === node.id && edge.data?.type === 'loop')) {
      issues.push({
        severity: 'error',
        type: 'missing_loop_body',
        nodeId: node.id,
        message: 'loop node needs a loop body edge',
        fixHint: 'Connect the loop node to its body entry with edge_type="loop".',
        suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${node.id}", target_node_id="<body_entry>", edge_type="loop")`,
      });
    }
  }
  if (type === 'parallel') {
    const branches = edges.filter(edge => edge.source === node.id && (edge.data?.type ?? 'sequence') === 'sequence');
    if (branches.length < 2) {
      issues.push({
        severity: 'error',
        type: 'missing_parallel_branches',
        nodeId: node.id,
        message: 'parallel node needs at least two sequence branch edges',
        fixHint: 'Connect at least two branch entry nodes with edge_type="sequence".',
        suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${node.id}", target_node_id="<branch_entry>", edge_type="sequence")`,
      });
    }
  }
  if (type === 'schedule_trigger') {
    const cron = typeof config.scheduleCron === 'string' && config.scheduleCron.trim()
      ? config.scheduleCron.trim()
      : '';
    if (!cron) {
      issues.push(requiredConfig(workflowId, node.id, 'missing_schedule_cron', 'schedule_trigger requires config.scheduleCron'));
    } else if (getNextCronTime(cron, Date.now()) === null) {
      issues.push({
        severity: 'error',
        type: 'invalid_schedule_cron',
        nodeId: node.id,
        message: `schedule_trigger has invalid cron: ${cron}`,
        fixHint: 'Use a five-field cron expression such as "0 9 * * *" or "*/15 * * * *".',
        suggestedToolCall: `workflow(action="inspect", workflow_id="${workflowId}")`,
      });
    }
    if (config.scheduleIntensity !== undefined && !SCHEDULE_INTENSITIES.has(String(config.scheduleIntensity))) {
      issues.push({
        severity: 'error',
        type: 'invalid_schedule_intensity',
        nodeId: node.id,
        message: 'schedule_trigger scheduleIntensity must be gentle, normal, aggressive, or critical',
        fixHint: 'Set scheduleIntensity according to how proactive the automation should be.',
      });
    }
    if (config.scheduleAudience !== undefined && !SCHEDULE_AUDIENCES.has(String(config.scheduleAudience))) {
      issues.push({
        severity: 'error',
        type: 'invalid_schedule_audience',
        nodeId: node.id,
        message: 'schedule_trigger scheduleAudience must be personal, team, ops, or customer',
        fixHint: 'Set scheduleAudience according to the expected consumer of the automation result.',
      });
    }
  }
}

function analyzeEdges(workflowId: string, nodes: NodeDefinition[], edges: EdgeDefinition[], issues: WorkflowIssue[]): void {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set<string>();

  for (const edge of edges) {
    const edgeType = edge.data?.type ?? 'sequence';
    const key = `${edge.source}->${edge.target}:${edgeType}:${edge.data?.conditionValue ?? ''}`;
    if (seen.has(key)) {
      issues.push({
        severity: 'warning',
        type: 'duplicate_edge',
        edgeId: edge.id,
        message: 'duplicate edge with same source/target/type',
        fixHint: 'Remove duplicate edges or rebuild via workflow(action="apply", mode="replace").',
      });
    }
    seen.add(key);

    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      issues.push({
        severity: 'error',
        type: 'dangling_edge',
        edgeId: edge.id,
        message: `edge references missing node: ${edge.source} -> ${edge.target}`,
        fixHint: 'Remove or recreate dangling edge with valid node ids.',
        suggestedToolCall: `workflow(action="inspect", workflow_id="${workflowId}")`,
      });
      continue;
    }
    if (edgeType === 'condition' && source.data.type !== 'condition') {
      issues.push({ severity: 'error', type: 'invalid_condition_edge', edgeId: edge.id, message: 'condition edge source must be a condition node' });
    }
    if (edgeType === 'condition' && edge.data?.conditionValue === undefined) {
      issues.push({ severity: 'error', type: 'missing_condition_value', edgeId: edge.id, message: 'condition edge requires conditionValue true/false' });
    }
    if (edgeType === 'loop' && source.data.type !== 'loop') {
      issues.push({ severity: 'error', type: 'invalid_loop_edge', edgeId: edge.id, message: 'loop edge source must be a loop node' });
    }
    if (source.data.type === 'parallel' && edgeType !== 'sequence' && edgeType !== 'data') {
      issues.push({ severity: 'error', type: 'invalid_parallel_edge', edgeId: edge.id, message: 'parallel node branch edges must be sequence edges' });
    }
  }
}

function buildDifyParity(workflow: WorkflowDefinition, nodeById: Map<string, NodeDefinition>) {
  const typeSet = new Set(workflow.nodes.map(node => node.data?.type));
  const supported = [
    'DAG canvas execution',
    'Start/User Input nodes',
    'LLM/Agent nodes',
    'Tool nodes',
    'If/Else condition nodes',
    'Loop/Iteration style subgraphs',
    'Parallel fan-out/fan-in',
    'Schedule trigger nodes synced to real scheduled tasks',
    'Template nodes',
    'Variable Assigner nodes',
    'Variable Aggregator nodes',
    'HTTP Request nodes',
    'List Operator nodes',
    'JSON/Parameter extraction nodes',
    'Workflow DSL apply/import via tool',
  ];
  const partial = [
    'Knowledge Retrieval (available through tools/agents, not a first-class workflow node yet)',
    'Human Input (can be modeled by agent/tool prompting, not a blocking workflow node yet)',
    'Answer/streaming chatflow output (output node exists; chat-turn streaming semantics are partial)',
    'Code node (use tool/python/shell nodes today; no sandboxed first-class code node yet)',
  ];
  const missing = [
    'Dify-compatible YAML import/export',
    'Visual run log parity at every node field',
    'Knowledge pipeline nodes',
    'File variable propagation for HTTP binary responses',
  ];
  const notes = [
    'No Docker is required: all added nodes run in-process or delegate to existing registered tools.',
    'HTTP requests delegate to the existing http_request tool so network policy and SSRF checks stay centralized.',
    `Current workflow uses: ${Array.from(typeSet).filter(Boolean).join(', ') || 'no node types'}.`,
    `Node ids are ${Array.from(nodeById.keys()).length === workflow.nodes.length ? 'unique' : 'not unique'}.`,
  ];
  return { supported, partial, missing, notes };
}

function requiredConfig(workflowId: string, nodeId: string, type: string, message: string): WorkflowIssue {
  return {
    severity: 'error',
    type,
    nodeId,
    message,
    fixHint: 'Update the node config or recreate it with workflow(action="apply").',
    suggestedToolCall: `workflow(action="inspect", workflow_id="${workflowId}")`,
  };
}

function branchIssue(workflowId: string, nodeId: string, value: boolean): WorkflowIssue {
  return {
    severity: 'error',
    type: value ? 'missing_true_branch' : 'missing_false_branch',
    nodeId,
    message: `condition node needs a ${value ? 'true' : 'false'} branch`,
    fixHint: `Connect a ${value ? 'true' : 'false'} branch.`,
    suggestedToolCall: `workflow(action="connect", workflow_id="${workflowId}", source_node_id="${nodeId}", target_node_id="<${value ? 'true' : 'false'}_node>", edge_type="condition", condition_value=${value})`,
  };
}

function findUnreachableNodes(nodes: NodeDefinition[], edges: EdgeDefinition[]): NodeDefinition[] {
  const incomingControl = new Set(edges
    .filter(edge => (edge.data?.type ?? 'sequence') !== 'data')
    .map(edge => edge.target));
  return nodes.filter(node => node.data?.type !== 'start' && node.data?.type !== 'input' && node.data?.type !== 'schedule_trigger' && !incomingControl.has(node.id));
}
