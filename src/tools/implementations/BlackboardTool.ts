import { z } from 'zod';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { AddEdgeTool } from './AddEdgeTool.js';
import { DeclareIntentTool } from './DeclareIntentTool.js';
import { ReadGraphTool } from './ReadGraphTool.js';
import { SupersedeNodeTool } from './SupersedeNodeTool.js';
import { WriteFactTool } from './WriteFactTool.js';

const BlackboardToolSchema = z.object({
  action: z.enum(['write_fact', 'declare_intent', 'add_edge', 'supersede_node', 'read_graph'])
    .describe([
      'Blackboard action to run.',
      'write_fact requires title and content.',
      'declare_intent requires title and content.',
      'add_edge requires from_node_id, to_node_id, and edge_type.',
      'supersede_node requires old_node_id, new_title, and new_content.',
      'read_graph requires query_type; node_id/kind/tag are required by some query types.',
    ].join(' ')),
  title: z.string().optional().describe('write_fact / declare_intent: node title.'),
  content: z.string().optional().describe('write_fact / declare_intent: node content.'),
  tags: z.array(z.string()).optional().describe('write_fact / declare_intent: tags.'),
  confidence: z.enum(['confirmed', 'likely', 'tentative']).optional().describe('write_fact: confidence.'),
  evidence: z.array(z.object({
    type: z.enum(['file', 'test_result', 'log_output', 'url', 'observation']),
    ref: z.string(),
    location: z.string().optional(),
    snippet: z.string().optional(),
  })).optional().describe('write_fact: supporting evidence.'),
  priority: z.number().int().min(1).max(10).optional().describe('declare_intent: priority 1-10, 1 highest.'),
  from_node_id: z.string().optional().describe('add_edge: source node id.'),
  to_node_id: z.string().optional().describe('add_edge: target node id.'),
  edge_type: z.enum(['depends_on', 'supports', 'contradicts', 'refines', 'supersedes', 'produces', 'consumes']).optional().describe('add_edge: relation type.'),
  metadata: z.record(z.string(), z.string()).optional().describe('add_edge: metadata.'),
  old_node_id: z.string().optional().describe('supersede_node: old node id.'),
  new_title: z.string().optional().describe('supersede_node: replacement fact title.'),
  new_content: z.string().optional().describe('supersede_node: replacement fact content.'),
  new_tags: z.array(z.string()).optional().describe('supersede_node: replacement fact tags.'),
  new_confidence: z.enum(['confirmed', 'likely', 'tentative']).optional().describe('supersede_node: replacement fact confidence.'),
  query_type: z.enum([
    'summary',
    'node_by_id',
    'nodes_by_kind',
    'nodes_by_tag',
    'edges_from',
    'edges_to',
    'subgraph',
  ]).optional().describe('read_graph: query type.'),
  node_id: z.string().optional().describe('read_graph: node id for node_by_id / edges_from / edges_to / subgraph.'),
  kind: z.enum(['fact', 'intent', 'hint', 'origin', 'goal', 'contract', 'design_doc']).optional().describe('read_graph: kind for nodes_by_kind.'),
  tag: z.string().optional().describe('read_graph: tag for nodes_by_tag.'),
  max_depth: z.number().int().min(1).max(5).optional().describe('read_graph: subgraph depth, default 2.'),
});

type BlackboardAction = z.infer<typeof BlackboardToolSchema>['action'];

const TARGETS: Record<BlackboardAction, Tool> = {
  write_fact: new WriteFactTool(),
  declare_intent: new DeclareIntentTool(),
  add_edge: new AddEdgeTool(),
  supersede_node: new SupersedeNodeTool(),
  read_graph: new ReadGraphTool(),
};

export class BlackboardTool extends Tool {
  readonly name = 'blackboard';
  readonly description = 'Blackboard 统一入口：用 action 选择 write_fact、declare_intent、add_edge、supersede_node 或 read_graph，在当前会话知识图中记录事实、意图、关系、替代关系或读取图谱。';
  readonly parameters = BlackboardToolSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = BlackboardToolSchema.parse(args);
    const { action, ...forwarded } = params as Record<string, unknown> & { action: BlackboardAction };
    const target = TARGETS[action];
    const parsed = target.parameters.safeParse(forwarded);
    if (!parsed.success) {
      const formatted = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return createToolError({
        code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
        message: `blackboard(action="${action}") 参数校验失败：${formatted}`,
        retryable: true,
        cause: formatted,
        fix: `按 ${target.name} 的参数要求补齐字段后重试。`,
        hints: parsed.error.issues.slice(0, 8).map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
    }
    return target.execute(parsed.data, context);
  }
}
