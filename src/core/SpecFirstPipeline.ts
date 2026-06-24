/**
 * SpecFirstPipeline — 结构化展开协议
 *
 * 不做任何硬编码关键词匹配或规则引擎式猜测。
 *
 * 设计哲学：
 * - 复杂度判断由 LLM（Leader）自行决定
 * - 本模块只提供「展开模板」的结构定义
 * - Leader 在 prompt 中被引导：遇到复杂任务时调用 expand，简单任务直接建
 * - Platform Completeness 由 Leader prompt 中的通用指导原则覆盖，不硬编码模块清单
 *
 * 职责：
 * 1. 定义 PipelineNode 结构（plan/contract/implement/evaluate）
 * 2. 提供 buildExpansion() 工具函数——接受 Leader 已决定的展开方案，输出标准化节点链
 * 3. 提供 renderExpansionHint()——格式化展开建议供 Leader 消费
 *
 * 不做：
 * - 不检测关键词
 * - 不计算复杂度评分
 * - 不硬编码"平台应该有什么功能"
 * - 不替 Leader 做决策
 */

export type PipelineNodeKind = 'plan' | 'contract' | 'implement' | 'evaluate';

export interface PipelineNode {
  /** 节点类型 */
  nodeKind: PipelineNodeKind;
  /** 任务标题 */
  subject: string;
  /** 任务描述 */
  description: string;
  /** 建议角色 */
  agentType: string;
  /** 依赖的前序节点索引（在返回数组中的位置） */
  dependsOnIndex: number[];
  /** 可选的 write_scope */
  writeScope?: string[];
  /** 可选的 contract_surface */
  contractSurface?: string;
}

export interface PipelineExpansion {
  /** 展开后的节点链 */
  nodes: PipelineNode[];
  /** 原始任务标题 */
  originalSubject: string;
  /** Leader 的展开理由 */
  reason: string;
}

/**
 * 构建标准化的展开节点链。
 *
 * Leader 自行决定要不要展开、怎么展开，本函数只负责格式化输出。
 * 参数全部由 Leader 传入——不做任何推断。
 */
export function buildExpansion(input: {
  subject: string;
  reason: string;
  layers: Array<{
    label: string;
    role: string;
    description: string;
    writeScope?: string[];
    contractSurface?: string;
  }>;
  /** 是否需要 plan 节点（Leader 决定） */
  includePlan?: boolean;
  /** 是否需要 contract 节点（Leader 决定） */
  includeContract?: boolean;
  /** plan 阶段的具体描述（Leader 写） */
  planDescription?: string;
  /** contract 阶段的具体描述（Leader 写） */
  contractDescription?: string;
}): PipelineExpansion {
  const nodes: PipelineNode[] = [];
  let lastPreImplIndex = -1;

  if (input.includePlan) {
    nodes.push({
      nodeKind: 'plan',
      subject: `设计规格: ${input.subject}`,
      description: input.planDescription || `将需求展开为完整产品规格和技术方案。`,
      agentType: 'planner',
      dependsOnIndex: [],
    });
    lastPreImplIndex = 0;
  }

  if (input.includeContract) {
    nodes.push({
      nodeKind: 'contract',
      subject: `架构契约: ${input.subject}`,
      description: input.contractDescription || `定义跨模块接口契约。`,
      agentType: 'architect',
      dependsOnIndex: lastPreImplIndex >= 0 ? [lastPreImplIndex] : [],
    });
    lastPreImplIndex = nodes.length - 1;
  }

  // 实现层——由 Leader 定义
  const implStartIndex = nodes.length;
  for (const layer of input.layers) {
    nodes.push({
      nodeKind: 'implement',
      subject: `实现 [${layer.label}]: ${input.subject}`,
      description: layer.description,
      agentType: layer.role,
      dependsOnIndex: lastPreImplIndex >= 0 ? [lastPreImplIndex] : [],
      writeScope: layer.writeScope,
      contractSurface: layer.contractSurface,
    });
  }

  // 验收节点
  const implIndices = Array.from({ length: input.layers.length }, (_, i) => implStartIndex + i);
  nodes.push({
    nodeKind: 'evaluate',
    subject: `验收: ${input.subject}`,
    description: '验收所有实现节点的集成结果。',
    agentType: 'evaluator',
    dependsOnIndex: implIndices,
  });

  return {
    nodes,
    originalSubject: input.subject,
    reason: input.reason,
  };
}

/**
 * 格式化展开建议——用于注入 Leader 的 tool call 返回值。
 */
export function renderExpansionHint(expansion: PipelineExpansion): string {
  const lines: string[] = [
    `⚠ 建议展开 (${expansion.reason}):`,
  ];
  for (const [i, node] of expansion.nodes.entries()) {
    const deps = node.dependsOnIndex.length > 0
      ? ` ← [${node.dependsOnIndex.map(d => d + 1).join(',')}]`
      : '';
    lines.push(`  ${i + 1}. [${node.nodeKind}] ${node.subject} (角色:${node.agentType})${deps}`);
  }
  return lines.join('\n');
}
