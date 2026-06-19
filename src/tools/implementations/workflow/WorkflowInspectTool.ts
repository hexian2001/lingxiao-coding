import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../../Tool.js';
import type {
  EdgeType,
  NodeConfig,
  NodeInput,
  NodeOutput,
  WorkflowDefinition,
} from '../../../core/workflow/types.js';

const WorkflowInspectSchema = z.object({
  workflow_id: z.string().describe('Workflow ID')
}).strict();

type InspectNode = {
  id: string;
  label?: string;
  type?: string;
  config: NodeConfig;
  inputs: Record<string, NodeInput>;
  outputs: Record<string, NodeOutput>;
};

type InspectEdge = {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  conditionValue?: boolean;
  dataMapping: Record<string, string> | null;
};

type InspectEdgeRef = {
  edgeId: string;
  source: string;
  target: string;
  type: EdgeType;
  conditionValue?: boolean;
  dataMapping: Record<string, string> | null;
};

type InspectGraphNode = {
  id: string;
  label?: string;
  type?: string;
  config: NodeConfig;
  incoming: InspectEdgeRef[];
  outgoing: InspectEdgeRef[];
  outgoingControl: InspectEdgeRef[];
  outgoingData: InspectEdgeRef[];
  trueBranch?: InspectEdgeRef | null;
  falseBranch?: InspectEdgeRef | null;
  bodyEdges?: InspectEdgeRef[];
  exitEdges?: InspectEdgeRef[];
  branchEdges?: InspectEdgeRef[];
};

interface WorkflowManagerPort {
  get(id: string): Promise<WorkflowDefinition | undefined>;
}

export class WorkflowInspectTool extends Tool {
  readonly name = '__workflow_delegate_inspect';
  readonly description = `查看 workflow 当前图结构，返回 LLM 可续接的节点、边、按节点聚合视图和下一步建议。

用途：
- 连接节点前确认当前 node_id
- 失败后检查已有节点/边
- 执行前确认 condition / loop / parallel 结构是否完整

返回：
- workflowId / name / version
- nodes: 当前节点列表（id / label / type / config）
- edges: 当前边列表（id / source / target / type / conditionValue / dataMapping）
- graph: 按节点聚合的 incoming/outgoing/body/branch/exit 边，适合 LLM 读图
- llmSummary: 可直接阅读的文本摘要
- diagnostics.nextSuggestedActions: 可执行的下一步工具建议`;

  readonly parameters = WorkflowInspectSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = WorkflowInspectSchema.parse(args);
    const workflowManager = context?.workflowManager as WorkflowManagerPort | undefined;
    if (!workflowManager) {
      return { success: false, data: null, error: 'WorkflowManager not available in context' };
    }

    try {
      const workflow = await workflowManager.get(params.workflow_id);
      if (!workflow) {
        return { success: false, data: null, error: `Workflow not found: ${params.workflow_id}` };
      }

      const nodes: InspectNode[] = workflow.nodes.map((node) => ({
        id: node.id,
        label: node.data?.label,
        type: node.data?.type,
        config: node.data?.config ?? {},
        inputs: node.data?.inputs ?? {},
        outputs: node.data?.outputs ?? {}
      }));
      const edges: InspectEdge[] = workflow.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.data?.type ?? 'sequence',
        conditionValue: edge.data?.conditionValue,
        dataMapping: edge.data?.dataMapping ?? null
      }));
      const graph = buildGraph(nodes, edges);
      const diagnostics = buildDiagnostics(nodes, edges, graph);

      return {
        success: true,
        data: {
          workflowId: workflow.id,
          name: workflow.name,
          version: workflow.version,
          nodes,
          edges,
          graph,
          llmSummary: buildLlmSummary(nodes, edges, graph, diagnostics.nextSuggestedActions),
          diagnostics
        }
      };
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : 'Failed to inspect workflow' };
    }
  }
}

function edgeRef(edge: InspectEdge): InspectEdgeRef {
  return {
    edgeId: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    conditionValue: edge.conditionValue,
    dataMapping: edge.dataMapping
  };
}

function buildGraph(nodes: InspectNode[], edges: InspectEdge[]): InspectGraphNode[] {
  return nodes.map(node => {
    const incoming = edges.filter(edge => edge.target === node.id).map(edgeRef);
    const outgoing = edges.filter(edge => edge.source === node.id).map(edgeRef);
    const outgoingControl = outgoing.filter(edge => edge.type !== 'data');
    const outgoingData = outgoing.filter(edge => edge.type === 'data');
    const summary: Partial<Pick<InspectGraphNode, 'trueBranch' | 'falseBranch' | 'bodyEdges' | 'exitEdges' | 'branchEdges'>> = {};

    if (node.type === 'condition') {
      const trueBranch = outgoing.find(edge => edge.type === 'condition' && edge.conditionValue === true) ?? null;
      const falseBranch = outgoing.find(edge => edge.type === 'condition' && edge.conditionValue === false) ?? null;
      summary.trueBranch = trueBranch;
      summary.falseBranch = falseBranch;
    }

    if (node.type === 'loop') {
      const bodyEdges = outgoing.filter(edge => edge.type === 'loop');
      const exitEdges = outgoing.filter(edge => edge.type !== 'loop' && edge.type !== 'data');
      summary.bodyEdges = bodyEdges;
      summary.exitEdges = exitEdges;
    }

    if (node.type === 'parallel') {
      const branchEdges = outgoing.filter(edge => edge.type === 'sequence');
      const exitEdges = outgoing.filter(edge => edge.type !== 'sequence' && edge.type !== 'data');
      summary.branchEdges = branchEdges;
      summary.exitEdges = exitEdges;
    }

    return {
      id: node.id,
      label: node.label,
      type: node.type,
      config: node.config,
      incoming,
      outgoing,
      outgoingControl,
      outgoingData,
      ...summary
    };
  });
}

function buildDiagnostics(nodes: InspectNode[], edges: InspectEdge[], graph: InspectGraphNode[]) {
  const nextSuggestedActions: string[] = [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const danglingEdges = edges.filter(edge => !nodeIds.has(edge.source) || !nodeIds.has(edge.target));
  const unconnectedNodes = nodes.filter(node => !edges.some(edge => edge.source === node.id || edge.target === node.id));
  const conditionNodes = graph.filter(node => node.type === 'condition');
  const loopNodes = graph.filter(node => node.type === 'loop');
  const parallelNodes = graph.filter(node => node.type === 'parallel');

  for (const node of conditionNodes) {
    if (!node.trueBranch) nextSuggestedActions.push(`workflow(action="connect", workflow_id="<workflow_id>", source_node_id="${node.id}", target_node_id="<true_node>", edge_type="condition", condition_value=true)`);
    if (!node.falseBranch) nextSuggestedActions.push(`workflow(action="connect", workflow_id="<workflow_id>", source_node_id="${node.id}", target_node_id="<false_node>", edge_type="condition", condition_value=false)`);
  }

  for (const node of loopNodes) {
    if (!node.bodyEdges || node.bodyEdges.length === 0) {
      nextSuggestedActions.push(`workflow(action="connect", workflow_id="<workflow_id>", source_node_id="${node.id}", target_node_id="<body_entry>", edge_type="loop")`);
    }
  }

  for (const node of parallelNodes) {
    const branchCount = node.branchEdges?.length ?? 0;
    if (branchCount < 2) nextSuggestedActions.push(`workflow(action="connect", workflow_id="<workflow_id>", source_node_id="${node.id}", target_node_id="<branch_entry>", edge_type="sequence") — add ${2 - branchCount} more branch edge(s)`);
  }

  if (danglingEdges.length > 0) nextSuggestedActions.push('Recreate the workflow without dangling edges');
  if (nodes.length === 0) nextSuggestedActions.push('workflow(action="add_node", workflow_id="<workflow_id>", node_id="start", node_type="input", label="Input")');
  if (nodes.length > 0 && edges.length === 0) nextSuggestedActions.push('Connect nodes with workflow(action="connect").');
  if (nextSuggestedActions.length === 0) nextSuggestedActions.push('workflow(action="validate", workflow_id="<workflow_id>") then workflow(action="execute", workflow_id="<workflow_id>", options={mode:"sync"})');

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    danglingEdges,
    unconnectedNodes,
    nextSuggestedActions
  };
}

function buildLlmSummary(nodes: InspectNode[], edges: InspectEdge[], graph: InspectGraphNode[], actions: string[]): string {
  const lines: string[] = [];
  lines.push(`Workflow graph: ${nodes.length} node(s), ${edges.length} edge(s).`);
  for (const node of graph) {
    lines.push(`- ${node.id} [${node.type}] ${node.label ?? ''}`.trim());
    if (node.type === 'condition') {
      lines.push(`  condition: true -> ${node.trueBranch?.target ?? 'MISSING'}, false -> ${node.falseBranch?.target ?? 'MISSING'}`);
    } else if (node.type === 'loop') {
      const body = (node.bodyEdges ?? []).map((edge) => edge.target).join(', ') || 'MISSING';
      const exits = (node.exitEdges ?? []).map((edge) => edge.target).join(', ') || 'none';
      lines.push(`  loop body -> ${body}; exits -> ${exits}`);
    } else if (node.type === 'parallel') {
      const branches = (node.branchEdges ?? []).map((edge) => edge.target).join(', ') || 'MISSING';
      const exits = (node.exitEdges ?? []).map((edge) => edge.target).join(', ') || 'none';
      lines.push(`  parallel branches -> ${branches}; exits -> ${exits}`);
    } else if (node.outgoing.length > 0) {
      lines.push(`  outgoing -> ${node.outgoing.map((edge) => `${edge.target}(${edge.type})`).join(', ')}`);
    }
  }
  lines.push('Next suggested actions:');
  for (const action of actions.slice(0, 5)) lines.push(`- ${action}`);
  return lines.join('\n');
}
