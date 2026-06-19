/**
 * rules/schema.ts — bughunt 静态分析规则的类型 + 外部规则包 zod schema（单一事实源）。
 *
 * 设计：
 *   - 类型层（Severity / SupportedLanguage / LanguageConfig / SecurityRule / SecurityPattern）
 *     供引擎（TreeSitterSecurityEngine / BughuntScanTools）与规则包（seed / RuleLoader）共享，
 *     杜绝三处各自定义导致的漂移。
 *   - zod schema（RulePackInputSchema）用于解析「用户提供的 JSON 规则包」；
 *     内置默认规则在 seed.ts 用 RegExp 字面量定义（零转换、字节级稳定）。
 *   - RuleLoader 合并 seed + 用户包（按 id 覆盖/追加）。
 *
 * P3 预留：structuralRule / taint 字段为 TaintFlowEngine 预留。本阶段（P1）规则不填充，
 * 引擎按「字段缺省 = 不启用」处理，扫描行为与外部化前完全一致（字节级不变）。
 */
import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════════
// 共享类型（单一事实源）
// ═══════════════════════════════════════════════════════════════════════════════

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'ruby';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'javascript', 'typescript', 'python', 'go', 'java', 'rust', 'c', 'cpp', 'ruby',
];

export interface LanguageConfig {
  /** ast-grep 内部语言名（注册后可用） */
  agName: string;
  extensions: string[];
  sources: string[];
  sinks: string[];
}

/** P3 预留：结构化 ast-grep 规则（pattern + 元变量约束）。 */
export interface StructuralRule {
  /** ast-grep 结构化 pattern，如 'exec($CMD)' */
  pattern: string;
  /** 元变量约束（$CMD 必须匹配的子规则） */
  constraints?: Record<string, unknown>;
}

/** P3 预留：污点传播配置。 */
export interface TaintSpec {
  /** source 槽位 pattern（如 'req.body'） */
  source?: string;
  /** sink 参数槽位 pattern（如 '$CMD'） */
  sinkArg?: string;
  /** 净化器名称覆盖（缺省用 taintFacts 默认表） */
  sanitizers?: string[];
}

export interface SecurityRule {
  id: string;
  severity: Severity;
  cwe?: string;
  owasp?: string;
  title: string;
  description: string;
  languages: SupportedLanguage[];
  /** ast-grep 节点 kind 列表（白名单） */
  nodeKinds: string[];
  /** 节点文本必须匹配（任一） */
  patterns: RegExp[];
  /** 节点文本附加上下文模式（可选，全部满足才报告） */
  contextPatterns?: RegExp[];
  /** P3 预留：结构化 ast-grep 规则（缺省=不启用，扫描行为不变） */
  structuralRule?: StructuralRule;
  /** P3 预留：污点传播配置（缺省=不启用） */
  taint?: TaintSpec;
}

export interface SecurityPattern {
  id: string;
  severity: Severity;
  rule: string;
  message: string;
  pattern: RegExp;
  fileExts: string[];
  cwe?: string;
  owasp?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 用户 JSON 规则包 zod schema（patterns 字符串化以 JSON 友好）
// ═══════════════════════════════════════════════════════════════════════════════

const LANGUAGE_ENUM = z.enum([
  'javascript', 'typescript', 'python', 'go', 'java', 'rust', 'c', 'cpp', 'ruby',
]);

const SEVERITY_ENUM = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

/** 正则的可序列化表示：source + flags。加载时 new RegExp(source, flags) 精确还原。 */
const RegexpSpecSchema = z.object({
  source: z.string(),
  flags: z.string().default(''),
});

const StructuralRuleInputSchema = z.object({
  pattern: z.string(),
  constraints: z.record(z.string(), z.unknown()).optional(),
});

const TaintSpecInputSchema = z.object({
  source: z.string().optional(),
  sinkArg: z.string().optional(),
  sanitizers: z.array(z.string()).optional(),
});

const LanguageConfigInputSchema = z.object({
  agName: z.string(),
  extensions: z.array(z.string()),
  sources: z.array(z.string()),
  sinks: z.array(z.string()),
});

const SecurityRuleInputSchema = z.object({
  id: z.string(),
  severity: SEVERITY_ENUM,
  cwe: z.string().optional(),
  owasp: z.string().optional(),
  title: z.string(),
  description: z.string(),
  languages: z.array(LANGUAGE_ENUM),
  nodeKinds: z.array(z.string()),
  patterns: z.array(RegexpSpecSchema),
  contextPatterns: z.array(RegexpSpecSchema).optional(),
  structuralRule: StructuralRuleInputSchema.optional(),
  taint: TaintSpecInputSchema.optional(),
});

const SecurityPatternInputSchema = z.object({
  id: z.string(),
  severity: SEVERITY_ENUM,
  rule: z.string(),
  message: z.string(),
  pattern: RegexpSpecSchema,
  fileExts: z.array(z.string()),
  cwe: z.string().optional(),
  owasp: z.string().optional(),
});

export const RulePackInputSchema = z.object({
  rules: z.array(SecurityRuleInputSchema).optional(),
  patterns: z.array(SecurityPatternInputSchema).optional(),
  languages: z.record(LANGUAGE_ENUM, LanguageConfigInputSchema).optional(),
});

export type RulePackInput = z.infer<typeof RulePackInputSchema>;
export type SecurityRuleInput = z.infer<typeof SecurityRuleInputSchema>;
export type SecurityPatternInput = z.infer<typeof SecurityPatternInputSchema>;
export type LanguageConfigInput = z.infer<typeof LanguageConfigInputSchema>;

/** 把 {source, flags} 编译回 RegExp（确定性，失败抛错而非静默降级）。 */
export function compileRegexp(spec: { source: string; flags: string }): RegExp {
  return new RegExp(spec.source, spec.flags || '');
}

/** 把用户包输入规则编译成引擎可用的 SecurityRule（含 RegExp）。 */
export function compileRule(input: SecurityRuleInput): SecurityRule {
  return {
    id: input.id,
    severity: input.severity,
    cwe: input.cwe,
    owasp: input.owasp,
    title: input.title,
    description: input.description,
    languages: input.languages,
    nodeKinds: input.nodeKinds,
    patterns: input.patterns.map(compileRegexp),
    contextPatterns: input.contextPatterns?.map(compileRegexp),
    structuralRule: input.structuralRule,
    taint: input.taint,
  };
}

/** 把用户包输入 pattern 编译成引擎可用的 SecurityPattern（含 RegExp）。 */
export function compilePattern(input: SecurityPatternInput): SecurityPattern {
  return {
    id: input.id,
    severity: input.severity,
    rule: input.rule,
    message: input.message,
    pattern: compileRegexp(input.pattern),
    fileExts: input.fileExts,
    cwe: input.cwe,
    owasp: input.owasp,
  };
}

/** 把用户包输入语言配置编译成 LanguageConfig。 */
export function compileLanguageConfig(input: LanguageConfigInput): LanguageConfig {
  return {
    agName: input.agName,
    extensions: input.extensions,
    sources: input.sources,
    sinks: input.sinks,
  };
}
