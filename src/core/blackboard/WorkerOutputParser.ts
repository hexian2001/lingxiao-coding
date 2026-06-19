/**
 * WorkerOutputParser — 从 Worker 文本输出中提取图结构化数据
 *
 * 支持 6 种代码块格式：
 *   ```graph_fact   — 写入 Fact 节点
 *   ```graph_intent — 声明 Intent 节点
 *   ```graph_contract — 写入跨 Agent 契约节点
 *   ```graph_design_doc — 写入跨 Agent 设计文档节点
 *   ```graph_edge   — 添加关系边
 *   ```graph_supersede — 替代旧节点
 *
 * 每个块体经 schemas.ts 的 zod schema safeParse 校验:
 *  - 成功:用 .data 构造结构化节点进图。
 *  - 失败:把校验错误 push 进 errors,该块跳过,其他块继续(不 throw,保持"单块失败不影响其他块"契约)。
 *  - confidence/priority 用 .catch 降级到合理默认;title/content/surface 等关键字段 required 失败则整块拒绝。
 *
 * 解析失败(JSON/YAML 都不可解析)的块同样静默跳过。
 */

import { parse as parseYaml } from 'yaml';
import type { WorkerGraphOutput } from './types.js';
import {
  GraphFactBlockSchema,
  GraphIntentBlockSchema,
  GraphContractBlockSchema,
  GraphDesignDocBlockSchema,
  GraphEdgeBlockSchema,
  GraphSupersedeBlockSchema,
} from './schemas.js';

/**
 * 容错解析 graph_* 代码块体。
 *
 * LLM 经常无视"必须是 JSON"的指令，改用 YAML 风格（如 `surface: POST /api/login`）。
 * YAML 是 JSON 的超集，因此先尝试严格 JSON，失败再用 YAML 解析——后者同样能吃下合法 JSON，
 * 也能吃下裸键值、单引号、未加引号的值等常见 LLM 变体。
 *
 * 两者都失败时抛出原始 JSON 错误，由调用方记录到 errors。
 */
function parseGraphBlockBody(jsonStr: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch (jsonErr) {
    try {
      const parsed = parseYaml(jsonStr);
      // YAML 会把纯标量（如单行字符串）也解析成功，但 graph 块必须是对象
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 落到下面抛 JSON 错误
    }
    throw jsonErr;
  }
}

/** 把 zod 错误压成单行 message。 */
function formatZodError(error: { issues?: Array<{ path?: PropertyKey[]; message?: string }> }): string {
  const issues = error.issues ?? [];
  if (issues.length === 0) return '校验失败';
  return issues
    .map((issue) => {
      const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message ?? 'invalid'}`;
    })
    .join('; ');
}

// ═══════════════════════════════════════════════════════════════
// 解析结果
// ═══════════════════════════════════════════════════════════════

export interface ParseResult {
  output: WorkerGraphOutput;
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════
// 解析器
// ═══════════════════════════════════════════════════════════════

const CODE_BLOCK_RE = /```(graph_fact|graph_intent|graph_contract|graph_design_doc|graph_edge|graph_supersede)\s*\n([\s\S]*?)```/g;

export function parseWorkerOutput(rawOutput: string, sessionId: string): ParseResult {
  const result: WorkerGraphOutput = {
    newFacts: [],
    newIntents: [],
    newContracts: [],
    newDesignDocs: [],
    newEdges: [],
    supersededNodeIds: [],
    completionSummary: '',
  };
  const errors: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(rawOutput)) !== null) {
    const blockType = match[1];
    const jsonStr = match[2].trim();

    let data: unknown;
    try {
      data = parseGraphBlockBody(jsonStr);
    } catch (err) {
      errors.push(`${blockType}: 解析失败（JSON/YAML 均不可解析）— ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    switch (blockType) {
      case 'graph_fact': {
        const parsed = GraphFactBlockSchema.safeParse(data);
        if (!parsed.success) { errors.push(`graph_fact: ${formatZodError(parsed.error)}`); break; }
        const d = parsed.data;
        result.newFacts.push({
          sessionId, title: d.title, content: d.content, tags: d.tags,
          createdBy: 'worker', confidence: d.confidence, evidence: d.evidence,
        });
        break;
      }
      case 'graph_intent': {
        const parsed = GraphIntentBlockSchema.safeParse(data);
        if (!parsed.success) { errors.push(`graph_intent: ${formatZodError(parsed.error)}`); break; }
        const d = parsed.data;
        result.newIntents.push({
          sessionId, title: d.title, content: d.content, tags: d.tags,
          createdBy: 'worker', intentStatus: 'open', priority: d.priority,
        });
        break;
      }
      case 'graph_contract': {
        const parsed = GraphContractBlockSchema.safeParse(data);
        if (!parsed.success) { errors.push(`graph_contract: ${formatZodError(parsed.error)}`); break; }
        const d = parsed.data;
        const rawVersion = typeof d.version === 'number' || typeof d.version === 'string' ? Number(d.version) : undefined;
        const versionTag = rawVersion !== undefined && Number.isFinite(rawVersion) && rawVersion > 0
          ? `contract-version:${Math.floor(rawVersion)}`
          : undefined;
        result.newContracts ??= [];
        result.newContracts.push({
          sessionId,
          title: d.title,
          content: d.content,
          tags: Array.from(new Set(['contract', `contract:${d.surface}`, ...(versionTag ? [versionTag] : []), ...d.tags])),
          createdBy: 'worker',
          confidence: d.confidence,
          evidence: d.evidence,
          // A3: 把 LLM 边界的 snake_case allowed_scope 映射为内部 camelCase contractAllowedScope。
          // 只在契约显式声明了非空 allow 时激活——空 allow(显式只读或 schema 降级)不映射,避免误锁。
          ...(d.allowed_scope && d.allowed_scope.allow.length > 0 ? {
            contractAllowedScope: {
              allow: d.allowed_scope.allow,
              ...(d.allowed_scope.forbid && d.allowed_scope.forbid.length > 0 ? { forbid: d.allowed_scope.forbid } : {}),
              ...(d.allowed_scope.allow_create !== undefined ? { allowCreate: d.allowed_scope.allow_create } : {}),
            },
          } : {}),
        });
        break;
      }
      case 'graph_design_doc': {
        const parsed = GraphDesignDocBlockSchema.safeParse(data);
        if (!parsed.success) { errors.push(`graph_design_doc: ${formatZodError(parsed.error)}`); break; }
        const d = parsed.data;
        result.newDesignDocs ??= [];
        result.newDesignDocs.push({
          sessionId,
          title: d.title,
          content: d.content,
          tags: Array.from(new Set(['design_doc', ...d.tags])),
          createdBy: 'worker',
          confidence: d.confidence,
          evidence: d.evidence,
        });
        break;
      }
      case 'graph_edge': {
        const parsed = GraphEdgeBlockSchema.safeParse(data);
        if (!parsed.success) { errors.push(`graph_edge: ${formatZodError(parsed.error)}`); break; }
        const d = parsed.data;
        result.newEdges.push({
          sessionId, fromNodeId: d.from, toNodeId: d.to, edgeType: d.type,
          createdBy: 'worker', metadata: d.metadata,
        });
        break;
      }
      case 'graph_supersede': {
        const parsed = GraphSupersedeBlockSchema.safeParse(data);
        if (!parsed.success) { errors.push(`graph_supersede: ${formatZodError(parsed.error)}`); break; }
        result.supersededNodeIds.push(parsed.data.old_node_id);
        break;
      }
    }
  }

  return { output: result, errors };
}
