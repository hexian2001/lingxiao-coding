/**
 * rules/RuleLoader.ts — 规则包加载与合并（单一事实源入口）。
 *
 * - getRulePack()：返回内置 seed 包（缓存），引擎默认使用。
 * - loadRulePack({ rulePackPath })：读用户 JSON 规则包，按 id 覆盖/追加 seed，
 *   返回合并后的包（含派生索引）。用于用户自定义规则与测试注入。
 *
 * 合并语义：用户包中同 id 的规则**覆盖** seed；新 id 的规则**追加**。
 * 语言配置按 key 覆盖。确定性强类型合并，无启发式。
 */
import { readFileSync } from 'fs';
import {
  compileLanguageConfig,
  compilePattern,
  compileRule,
  RulePackInputSchema,
  type LanguageConfig,
  type SecurityPattern,
  type SecurityRule,
  type SupportedLanguage,
} from './schema.js';
import {
  SEED_LANGUAGE_CONFIGS,
  SEED_PATTERNS,
  SEED_RULES,
} from './seed.js';

export interface LoadedRulePack {
  rules: SecurityRule[];
  patterns: SecurityPattern[];
  languages: Record<SupportedLanguage, LanguageConfig>;
  /** rule.id → 支持的语言集合（O(1) 查询，替代 SECURITY_RULE_LANGUAGE_SETS） */
  ruleLanguageSets: Map<string, ReadonlySet<SupportedLanguage>>;
  /** pattern.id → 支持的扩展名集合（替代 SECURITY_PATTERN_EXT_SETS） */
  patternExtSets: Map<string, ReadonlySet<string>>;
  /** 语言 → 扩展名集合（替代 LANGUAGE_EXTENSION_SETS） */
  languageExtensionSets: Map<SupportedLanguage, ReadonlySet<string>>;
  /** 所有 pattern 涉及的扩展名并集（runBuiltinScan 的 walk 范围） */
  allPatternExts: ReadonlySet<string>;
}

function assemble(
  rules: SecurityRule[],
  patterns: SecurityPattern[],
  languages: Record<SupportedLanguage, LanguageConfig>,
): LoadedRulePack {
  return {
    rules,
    patterns,
    languages,
    ruleLanguageSets: new Map(rules.map((r) => [r.id, new Set(r.languages) as ReadonlySet<SupportedLanguage>])),
    patternExtSets: new Map(patterns.map((p) => [p.id, new Set(p.fileExts) as ReadonlySet<string>])),
    languageExtensionSets: new Map(
      (Object.entries(languages) as Array<[SupportedLanguage, LanguageConfig]>).map(
        ([lang, cfg]) => [lang, new Set(cfg.extensions) as ReadonlySet<string>],
      ),
    ),
    allPatternExts: new Set(patterns.flatMap((p) => p.fileExts)),
  };
}

function buildSeedPack(): LoadedRulePack {
  return assemble(SEED_RULES, SEED_PATTERNS, SEED_LANGUAGE_CONFIGS);
}

let cachedDefault: LoadedRulePack | null = null;

/** 内置 seed 包（缓存）。引擎默认数据源。 */
export function getRulePack(): LoadedRulePack {
  if (!cachedDefault) cachedDefault = buildSeedPack();
  return cachedDefault;
}

/** 测试/热重载用：清缓存（生产代码一般不需要）。 */
export function resetRulePackCache(): void {
  cachedDefault = null;
}

function mergeById<T extends { id: string }>(seed: readonly T[], user: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of seed) byId.set(item.id, item);
  for (const item of user) byId.set(item.id, item); // 同 id 覆盖；新 id 追加
  return [...byId.values()];
}

/**
 * 加载并合并规则包。
 * @param options.rulePackPath 用户 JSON 规则包路径（可选）。缺省 = 内置 seed。
 * @throws 当用户包 JSON 不符合 RulePackInputSchema 时抛 zod 错误（fail-fast，不静默降级）。
 */
export function loadRulePack(options?: { rulePackPath?: string }): LoadedRulePack {
  if (!options?.rulePackPath) return getRulePack();
  const raw = readFileSync(options.rulePackPath, 'utf-8');
  const parsed = RulePackInputSchema.parse(JSON.parse(raw));

  const userRules = (parsed.rules ?? []).map(compileRule);
  const userPatterns = (parsed.patterns ?? []).map(compilePattern);

  const rules = mergeById(SEED_RULES, userRules);
  const patterns = mergeById(SEED_PATTERNS, userPatterns);

  const languages: Record<SupportedLanguage, LanguageConfig> = { ...SEED_LANGUAGE_CONFIGS };
  if (parsed.languages) {
    for (const [key, cfg] of Object.entries(parsed.languages)) {
      languages[key as SupportedLanguage] = compileLanguageConfig(cfg);
    }
  }

  return assemble(rules, patterns, languages);
}
