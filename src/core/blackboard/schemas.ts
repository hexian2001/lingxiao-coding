/**
 * 黑板图摄入 zod schema — 以 types.ts 的 enum 为单一事实源。
 *
 * 消灭 WorkerOutputParser 旧实现的 `Record<string,unknown>` + `String()` 强转 +
 * `as Confidence` 断言。所有 LLM 输出经 safeParse 校验,非法 confidence/evidence/edgeType
 * 进 errors 不进图。
 *
 * 这里导出的 ConfidenceSchema / EdgeTypeSchema / EvidenceItemSchema 也是 LLM 工具
 * (WriteFactTool/AddEdgeTool/SupersedeNodeTool)的单一事实源,根除工具与 types.ts 的 enum 漂移。
 *
 * 容错策略(对齐旧行为):
 *  - confidence/priority 有合理默认 → 用 .catch 降级,保住主信息(title/content)。
 *  - title/content/surface/from/to/old_node_id 这类无默认的关键字段 → required,失败整块拒绝。
 *  - evidence 数组元素经 EvidenceItemSchema 校验(ref 必需);非法元素被过滤而非整块拒绝。
 */

import { z } from 'zod';

// ── 枚举(单一事实源,对齐 types.ts) ───────────────────────────────
export const ConfidenceSchema = z.enum(['confirmed', 'likely', 'tentative']);
export const EdgeTypeSchema = z.enum([
  'depends_on', 'supports', 'contradicts', 'refines', 'supersedes', 'produces', 'consumes',
]);
/** EvidenceItem.type 的 9 种(types.ts:65)。工具与 parser 共用,杜绝漂移。 */
export const EvidenceTypeSchema = z.enum([
  'file', 'test_result', 'log_output', 'url', 'observation',
  'artifact', 'tool_result', 'task_result', 'blackboard_node',
]);

export const EvidenceItemSchema = z.object({
  type: EvidenceTypeSchema,
  ref: z.string(),
  location: z.string().optional(),
  snippet: z.string().optional(),
});

/**
 * 证据列表:lenient。逐元素 safeParse,**过滤掉非法元素**(如 type 不在 9 种、缺 ref),
 * 保留合法元素,不因单条坏 evidence 整块拒绝(保住 title/content 主信息)。
 * 非数组/全非法 → 降级为 undefined(等同未提供 evidence)。
 */
const EvidenceListSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.flatMap((item) => {
      const r = EvidenceItemSchema.safeParse(item);
      return r.success ? [r.data] : [];
    }),
  )
  .optional()
  .catch(undefined);

const TagsSchema = z.array(z.string()).catch([]);

/** 边 metadata:lenient。非 Record<string,string> → 降级为 undefined(丢弃 metadata,保住 from/to/type)。 */
const EdgeMetadataSchema = z.record(z.string(), z.string()).optional().catch(undefined);

// ── 6 种 graph_* 代码块的 raw schema(LLM 字段名) ──────────────────
export const GraphFactBlockSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: TagsSchema,
  confidence: ConfidenceSchema.catch('confirmed'),
  evidence: EvidenceListSchema,
});

export const GraphIntentBlockSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: TagsSchema,
  priority: z.number().int().min(1).max(10).catch(5),
});

/**
 * 契约结构化允许面(LLM 输入边界,snake_case 键)。
 * safeParse 失败时 .catch 降级为空,保住 title/content 主信息——
 * 非法 allowed_scope 不整块拒绝契约(对齐 confidence/evidence 的容错策略)。
 * 内部存储为 camelCase 的 ContractAllowedScope(types.ts GraphNode.contractAllowedScope)。
 *
 * `.optional()` 是向后兼容的关键:旧契约块无此字段仍能 parse 通过。
 */
const ContractAllowedScopeSchema = z.object({
  allow: z.array(z.string().min(1)).catch([]).default([]),
  forbid: z.array(z.string().min(1)).catch([]).optional(),
  allow_create: z.boolean().catch(false).optional(),
}).optional();

export const GraphContractBlockSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: TagsSchema,
  surface: z.string().min(1),
  version: z.union([z.number(), z.string()]).optional(),
  allowed_scope: ContractAllowedScopeSchema,
  confidence: ConfidenceSchema.catch('confirmed'),
  evidence: EvidenceListSchema,
});

export const GraphDesignDocBlockSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: TagsSchema,
  confidence: ConfidenceSchema.catch('confirmed'),
  evidence: EvidenceListSchema,
});

export const GraphEdgeBlockSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: EdgeTypeSchema,
  metadata: EdgeMetadataSchema,
});

export const GraphSupersedeBlockSchema = z.object({
  old_node_id: z.string().min(1),
});
