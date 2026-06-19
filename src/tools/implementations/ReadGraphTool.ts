import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import type { GraphNode, GraphEdge, GraphSnapshot, GraphAnalysis } from '../../core/blackboard/types.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

const QUERY_TYPE_VALUES = [
  'summary',
  'node_by_id',
  'nodes_by_kind',
  'nodes_by_tag',
  'edges_from',
  'edges_to',
  'subgraph',
] as const;

const NODE_KIND_VALUES = [
  'fact', 'intent', 'hint', 'origin', 'goal', 'contract', 'design_doc',
] as const;

const ReadGraphSchema = z.object({
  query_type: z.enum(QUERY_TYPE_VALUES).describe(
    '查询类型: summary=高层概览, node_by_id=单节点详情, nodes_by_kind=按类型列出所有节点, nodes_by_tag=按标签搜索, edges_from=节点出边, edges_to=节点入边, subgraph=邻域子图'
  ),
  node_id: z.string().optional().describe('目标节点 ID（node_by_id / edges_from / edges_to / subgraph 时必填）'),
  kind: z.enum(NODE_KIND_VALUES).optional().describe('节点类型（nodes_by_kind 时必填）'),
  tag: z.string().optional().describe('搜索标签（nodes_by_tag 时必填）'),
  max_depth: z.number().int().min(1).max(5).optional().describe('子图最大深度（subgraph 时可选，默认 2）'),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatNode(node: GraphNode, index?: number): string {
  const prefix = index !== undefined ? `**${index}.** ` : '';
  const statusPart = node.kind === 'intent' ? ` [${node.intentStatus ?? 'unknown'}]` : '';
  const confidencePart = node.confidence ? ` (${node.confidence})` : '';
  const tagsPart = node.tags.length > 0 ? ` \`${node.tags.join('`, `')}\`` : '';
  return `${prefix}**${node.title}**${statusPart}${confidencePart} — *${node.kind}* \`${node.id}\`${tagsPart}`;
}

function formatNodeDetail(node: GraphNode): string {
  const lines = [
    `## 节点: ${node.title}`,
    `- **ID**: \`${node.id}\``,
    `- **Kind**: ${node.kind}`,
    `- **创建者**: ${node.createdBy}`,
    `- **标签**: ${node.tags.length > 0 ? node.tags.join(', ') : '(无)'}`,
  ];
  if (node.confidence) lines.push(`- **置信度**: ${node.confidence}`);
  if (node.kind === 'intent') lines.push(`- **状态**: ${node.intentStatus ?? 'unknown'}`, `- **优先级**: ${node.priority ?? 'N/A'}`);
  if (node.supersededBy) lines.push(`- **被替代**: \`${node.supersededBy}\``);
  if (node.evidence && node.evidence.length > 0) {
    lines.push('', '### Evidence', ...node.evidence.map(e => `- ${e.type}: ${e.ref}`));
  }
  lines.push('', '### 内容', node.content);
  return lines.join('\n');
}

function formatEdge(edge: GraphEdge, nodeMap?: Map<string, GraphNode>, index?: number): string {
  const prefix = index !== undefined ? `**${index}.** ` : '';
  const fromTitle = nodeMap?.get(edge.fromNodeId)?.title ?? edge.fromNodeId;
  const toTitle = nodeMap?.get(edge.toNodeId)?.title ?? edge.toNodeId;
  return `${prefix}\`${fromTitle}\` --[**${edge.edgeType}**]--> \`${toTitle}\` _(edge: \`${edge.id}\`)_`;
}

function formatSummary(analysis: GraphAnalysis, snapshot: GraphSnapshot): string {
  const lines = ['## 黑板图概览'];
  lines.push(`- **总节点数**: ${snapshot.nodes.length}`);
  lines.push(`- **总边数**: ${snapshot.edges.length}`);

  const kindCounts = new Map<string, number>();
  for (const n of snapshot.nodes) {
    kindCounts.set(n.kind, (kindCounts.get(n.kind) ?? 0) + 1);
  }
  lines.push(`- **节点分布**: ${[...kindCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  if (snapshot.originNode) lines.push(`- **Origin**: \`${snapshot.originNode.title}\``);
  if (snapshot.goalNode) lines.push(`- **Goal**: \`${snapshot.goalNode.title}\``);

  lines.push('', `### 待探索 Intent (${analysis.openIntents.length})`);
  if (analysis.openIntents.length === 0) {
    lines.push('_(无)_');
  } else {
    analysis.openIntents.forEach((n, i) => { lines.push(formatNode(n, i + 1)); });
  }

  lines.push('', `### 被阻塞 Intent (${analysis.blockedIntents.length})`);
  if (analysis.blockedIntents.length === 0) {
    lines.push('_(无)_');
  } else {
    analysis.blockedIntents.forEach((n, i) => { lines.push(formatNode(n, i + 1)); });
  }

  lines.push('', `### 最新 Fact (${analysis.recentFacts.length})`);
  if (analysis.recentFacts.length === 0) {
    lines.push('_(无)_');
  } else {
    analysis.recentFacts.forEach((n, i) => { lines.push(formatNode(n, i + 1)); });
  }

  if (analysis.knowledgeGaps.length > 0) {
    lines.push('', `### 知识空白 (${analysis.knowledgeGaps.length})`);
    analysis.knowledgeGaps.forEach((g, i) => { lines.push(`${i + 1}. ${g}`); });
  }

  if (analysis.unresolvedContradictions.length > 0) {
    lines.push('', `### 未解决矛盾 (${analysis.unresolvedContradictions.length})`);
    analysis.unresolvedContradictions.forEach((c, i) => {
      lines.push(`${i + 1}. \`${c.nodeA.title}\` ↔ \`${c.nodeB.title}\``);
    });
  }

  if (analysis.completionSignals.length > 0) {
    lines.push('', `### 完成信号 (${analysis.completionSignals.length})`);
    analysis.completionSignals.forEach((s, i) => { lines.push(`${i + 1}. ${s}`); });
  }

  return lines.join('\n');
}

function formatSubgraph(subgraph: GraphSnapshot): string {
  const lines = [`## 子图 (中心: \`${subgraph.focusNodeId ?? '?'}\`)`];
  const nodeMap = new Map<string, GraphNode>();
  for (const n of subgraph.nodes) nodeMap.set(n.id, n);

  lines.push(`- **节点数**: ${subgraph.nodes.length}`, `- **边数**: ${subgraph.edges.length}`);

  if (subgraph.originNode) lines.push(`- **Origin**: \`${subgraph.originNode.title}\``);
  if (subgraph.goalNode) lines.push(`- **Goal**: \`${subgraph.goalNode.title}\``);

  lines.push('', '### 节点');
  subgraph.nodes.forEach((n, i) => { lines.push(formatNode(n, i + 1)); });

  lines.push('', '### 边');
  if (subgraph.edges.length === 0) {
    lines.push('_(无)_');
  } else {
    subgraph.edges.forEach((e, i) => { lines.push(formatEdge(e, nodeMap, i + 1)); });
  }

  return lines.join('\n');
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export class ReadGraphTool extends Tool {
  readonly name = 'read_graph';
  readonly description =
    '查询会话的黑板知识图谱。支持多种查询模式：summary(总览)、node_by_id(单节点)、nodes_by_kind(按类型)、nodes_by_tag(按标签)、edges_from/edges_to(关系边)、subgraph(邻域子图)。' +
    '查询失败时返回 success=false 和错误原因，黑板未启用时亦然。';
  readonly parameters = ReadGraphSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ReadGraphSchema>;
    const graph = context?.blackboardGraph;
    const sessionId = context?.sessionId;

    if (!graph || !sessionId) {
      return {
        success: false,
        data: null,
        error: '黑板图未初始化（blackboard 模式未开启或 sessionId 缺失）。使用 blackboard(action="read_graph") 前需先启用黑板模式。',
      };
    }

    try {
      switch (params.query_type) {
        case 'summary': {
          const analysis = graph.analyze(sessionId);
          const snapshot = graph.getSnapshot(sessionId);
          return {
            success: true,
            data: formatSummary(analysis, snapshot),
          };
        }

        case 'node_by_id': {
          if (!params.node_id) {
            return { success: false, data: null, error: 'query_type=node_by_id 时 node_id 为必填参数' };
          }
          const node = graph.getNode(params.node_id, sessionId);
          if (!node) {
            return { success: false, data: null, error: `节点 \`${params.node_id}\` 不存在` };
          }
          return { success: true, data: formatNodeDetail(node) };
        }

        case 'nodes_by_kind': {
          if (!params.kind) {
            return { success: false, data: null, error: 'query_type=nodes_by_kind 时 kind 为必填参数' };
          }
          const nodes = graph.getNodesByKind(sessionId, params.kind);
          if (nodes.length === 0) {
            return { success: true, data: `## ${params.kind} 节点\n_(无)_` };
          }
          const lines = [`## ${params.kind} 节点 (${nodes.length})`];
          nodes.forEach((n, i) => { lines.push('', formatNodeDetail(n)); });
          return { success: true, data: lines.join('\n') };
        }

        case 'nodes_by_tag': {
          if (!params.tag) {
            return { success: false, data: null, error: 'query_type=nodes_by_tag 时 tag 为必填参数' };
          }
          const nodes = graph.getNodesByTag(sessionId, params.tag);
          if (nodes.length === 0) {
            return { success: true, data: `## 标签 \`${params.tag}\`\n_(无匹配节点)_` };
          }
          const lines = [`## 标签 \`${params.tag}\` — ${nodes.length} 个节点`];
          nodes.forEach((n, i) => { lines.push(formatNode(n, i + 1)); });
          return { success: true, data: lines.join('\n') };
        }

        case 'edges_from':
        case 'edges_to': {
          if (!params.node_id) {
            return {
              success: false,
              data: null,
              error: `query_type=${params.query_type} 时 node_id 为必填参数`,
            };
          }
          const sourceNode = graph.getNode(params.node_id, sessionId);
          if (!sourceNode) {
            return { success: false, data: null, error: `节点 \`${params.node_id}\` 不存在` };
          }

          const edges =
            params.query_type === 'edges_from'
              ? graph.getEdgesFrom(sessionId, params.node_id)
              : graph.getEdgesTo(sessionId, params.node_id);

          // Build node map for titles
          const nodeMap = new Map<string, GraphNode>();
          nodeMap.set(sourceNode.id, sourceNode);
          const relatedIds = new Set<string>();
          for (const e of edges) {
            relatedIds.add(e.fromNodeId);
            relatedIds.add(e.toNodeId);
          }
          for (const id of relatedIds) {
            if (!nodeMap.has(id)) {
              const n = graph.getNode(id, sessionId);
              if (n) nodeMap.set(id, n);
            }
          }

          const direction = params.query_type === 'edges_from' ? '出边' : '入边';
          const lines = [
            `## ${sourceNode.title} 的${direction} (${edges.length})`,
            `源节点: ${formatNode(sourceNode)}`,
            '',
          ];
          if (edges.length === 0) {
            lines.push('_(无)_');
          } else {
            edges.forEach((e, i) => { lines.push(formatEdge(e, nodeMap, i + 1)); });
          }
          return { success: true, data: lines.join('\n') };
        }

        case 'subgraph': {
          if (!params.node_id) {
            return { success: false, data: null, error: 'query_type=subgraph 时 node_id 为必填参数' };
          }
          const maxDepth = params.max_depth ?? 2;
          const subgraph = graph.getSubgraph(sessionId, params.node_id, maxDepth);
          if (subgraph.nodes.length === 0) {
            return {
              success: false,
              data: null,
              error: `节点 \`${params.node_id}\` 不存在或子图为空`,
            };
          }
          return { success: true, data: formatSubgraph(subgraph) };
        }

        default:
          return { success: false, data: null, error: `未知的 query_type: ${params.query_type}` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `读取图失败: ${msg}` };
    }
  }
}
