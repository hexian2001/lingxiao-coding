/**
 * AstGrepSecurityEngine — 基于 @ast-grep/napi 的多语言 AST 安全扫描引擎
 *
 * 文件名保留为 TreeSitterSecurityEngine.ts 以兼容历史导入路径，
 * 实现已迁移到 ast-grep（NAPI 预编译二进制，零编译），不再依赖 node-tree-sitter。
 *
 * 支持语言：JavaScript / TypeScript / Python / Go / Java / Rust / C / C++ / Ruby
 * 能力：
 *   - 内置 + 动态加载语言（@ast-grep/lang-*）
 *   - 节点类型 + 文本正则规则匹配（OWASP Top 10 + CWE）
 *   - 跨平台（Linux/macOS/Windows × x64/arm64，全部预编译，npm install 即用）
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import type { LanguageConfig, SecurityRule, SupportedLanguage } from './rules/schema.js';
import { getRulePack, type LoadedRulePack } from './rules/RuleLoader.js';

// 类型 re-export（保持现有 import 路径兼容：rules/schema.ts 是单一事实源）
export type { LanguageConfig, SecurityRule, SupportedLanguage } from './rules/schema.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 语言注册
// ═══════════════════════════════════════════════════════════════════════════════

// SupportedLanguage / LanguageConfig 类型从 ./rules/schema.js 导入（见文件顶部）。
// 语言配置（原 LANGUAGE_CONFIGS）已外部化到 rules/seed.ts，经 RuleLoader.getRulePack().languages
// 注入；扩展名集合（原 LANGUAGE_EXTENSION_SETS）改为 LoadedRulePack.languageExtensionSets。

const LANGUAGE_DETECT_SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build']);
const WALK_SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  '__pycache__',
  '.git',
  'venv',
  'env',
]);

function shouldSkipLanguageDetectEntry(name: string): boolean {
  return name[0] === '.' || LANGUAGE_DETECT_SKIP_DIRS.has(name);
}

function shouldSkipWalkEntry(name: string): boolean {
  return name[0] === '.' || WALK_SKIP_DIRS.has(name);
}

// JSX/TSX 单独映射到 ast-grep 的内置 Tsx
const EXT_OVERRIDE: Record<string, { lang: SupportedLanguage; agName: string }> = {
  '.tsx': { lang: 'typescript', agName: 'Tsx' },
  '.jsx': { lang: 'javascript', agName: 'JavaScript' }, // ast-grep JavaScript 内置 jsx
};

let registered = false;
let registerError: string | null = null;

interface AstGrepFindQuery {
  rule: {
    kind: string;
  };
}

interface AstGrepNode {
  findAll(query: AstGrepFindQuery): unknown;
  range(): unknown;
  text(): string;
}

interface AstGrepRoot {
  root(): unknown;
}

interface AstGrepApi {
  parse(lang: string, source: string): unknown;
  registerDynamicLanguage?: (langs: Record<string, unknown>) => void;
}

interface AstGrepPosition {
  line: number;
  column: number;
}

interface AstGrepRange {
  start: AstGrepPosition;
  end: AstGrepPosition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readDefaultExport(moduleValue: unknown): unknown {
  return isRecord(moduleValue) && 'default' in moduleValue ? moduleValue.default : moduleValue;
}

function isAstGrepApi(value: unknown): value is AstGrepApi {
  if (!isRecord(value) || typeof value.parse !== 'function') return false;
  return value.registerDynamicLanguage === undefined || typeof value.registerDynamicLanguage === 'function';
}

function isAstGrepRoot(value: unknown): value is AstGrepRoot {
  return isRecord(value) && typeof value.root === 'function';
}

function isAstGrepNode(value: unknown): value is AstGrepNode {
  return (
    isRecord(value) &&
    typeof value.findAll === 'function' &&
    typeof value.range === 'function' &&
    typeof value.text === 'function'
  );
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readAstGrepPosition(value: unknown): AstGrepPosition | null {
  if (!isRecord(value)) return null;
  return {
    line: readNumber(value.line) ?? readNumber(value.row) ?? 0,
    column: readNumber(value.column) ?? 0,
  };
}

function readAstGrepRange(value: unknown): AstGrepRange | null {
  if (!isRecord(value)) return null;
  const start = readAstGrepPosition(value.start);
  const end = readAstGrepPosition(value.end);
  return start && end ? { start, end } : null;
}

async function importAstGrepApi(): Promise<AstGrepApi | null> {
  const moduleValue: unknown = await import('@ast-grep/napi').catch((error: unknown) => {
    registerError = error instanceof Error ? error.message : String(error);
    return null;
  });
  return isAstGrepApi(moduleValue) ? moduleValue : null;
}

/** 一次性动态注册非内置语言（ast-grep 内置仅 JavaScript/TypeScript/Tsx/Css/Html） */
async function ensureLanguagesRegistered(): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    const ag = await importAstGrepApi();
    const dynamicLangs: Record<string, unknown> = {};
    const tryRequire = async (key: string, mod: string) => {
      try { dynamicLangs[key] = readDefaultExport(await import(mod)); } catch (e) {
        // 单语言加载失败仅降级，整体仍可用其他语言
      }
    };
    await Promise.all([
      tryRequire('python', '@ast-grep/lang-python'),
      tryRequire('go', '@ast-grep/lang-go'),
      tryRequire('java', '@ast-grep/lang-java'),
      tryRequire('rust', '@ast-grep/lang-rust'),
      tryRequire('c', '@ast-grep/lang-c'),
      tryRequire('cpp', '@ast-grep/lang-cpp'),
      tryRequire('ruby', '@ast-grep/lang-ruby'),
    ]);
    if (ag && Object.keys(dynamicLangs).length > 0 && ag.registerDynamicLanguage) {
      ag.registerDynamicLanguage(dynamicLangs);
    }
  } catch (e) {
    registerError = e instanceof Error ? e.message : String(e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 安全规则定义（按节点类型 + 文本正则匹配；移除依赖 tree-sitter Parser API 的复杂判定）
// ═══════════════════════════════════════════════════════════════════════════════

// SecurityRule 类型从 ./rules/schema.js 导入（见文件顶部）。
// 安全规则（原 SECURITY_RULES）已外部化到 rules/seed.ts，经 RuleLoader.getRulePack().rules 注入；
// 按语言过滤改为 LoadedRulePack.ruleLanguageSets（O(1) 查询，替代 securityRuleSupportsLanguage）。

// ═══════════════════════════════════════════════════════════════════════════════
// 类型与扫描入口
// ═══════════════════════════════════════════════════════════════════════════════

export interface AstScanFinding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  cwe?: string;
  owasp?: string;
  rule: string;
  title: string;
  message: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  code: string;
  language: string;
  source: 'ast-grep';
}

export interface AstScanResult {
  success: boolean;
  tool: string;
  languages: string[];
  filesScanned: number;
  findings: AstScanFinding[];
  summary: string;
  duration: number;
  partial?: boolean;
  filesSkipped?: number;
  scanErrors?: Array<{ file?: string; reason: string }>;
  walkErrors?: Array<{ dir: string; reason: string }>;
}

const MAX_FINDINGS = 300;

export class TreeSitterSecurityEngine {
  /** 检测目录中使用的语言 */
  async detectLanguages(targetPath: string, pack: LoadedRulePack = getRulePack()): Promise<SupportedLanguage[]> {
    await ensureLanguagesRegistered();
    const detected = new Set<SupportedLanguage>();
    const allExts = new Set<string>();

    const walk = (dir: string, depth = 0) => {
      if (depth > 5) return;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (shouldSkipLanguageDetectEntry(entry.name)) continue;
          if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
          else allExts.add(extname(entry.name).toLowerCase());
        }
      } catch {/* expected: best-effort cleanup */}
    };
    walk(targetPath);

    for (const [lang, config] of Object.entries(pack.languages)) {
      if (config.extensions.some(ext => allExts.has(ext))) {
        detected.add(lang as SupportedLanguage);
      }
    }
    if (allExts.has('.tsx')) detected.add('typescript');
    if (allExts.has('.jsx')) detected.add('javascript');
    return [...detected];
  }

  /** 扫描目录 */
  async scan(targetPath: string, options?: {
    languages?: SupportedLanguage[];
    maxFiles?: number;
    maxFileSize?: number;
    rules?: string[];
    rulePack?: LoadedRulePack;
  }): Promise<AstScanResult> {
    await ensureLanguagesRegistered();
    const pack = options?.rulePack ?? getRulePack();
    const startTime = Date.now();
    const maxFiles = options?.maxFiles ?? 500;
    const maxFileSize = options?.maxFileSize ?? 500_000;
    const scanErrors: Array<{ file?: string; reason: string }> = [];
    const walkErrors: Array<{ dir: string; reason: string }> = [];

    const ag = await importAstGrepApi();
    if (!ag) {
      return {
        success: false,
        tool: 'ast-grep',
        languages: [],
        filesScanned: 0,
        findings: [],
        summary: `ast-grep 不可用${registerError ? `: ${registerError}` : ''}`,
        duration: Date.now() - startTime,
      };
    }

    const languages = options?.languages ?? await this.detectLanguages(targetPath, pack);
    if (languages.length === 0) {
      return { success: true, tool: 'ast-grep', languages: [], filesScanned: 0, findings: [], summary: '未检测到支持的语言', duration: 0 };
    }

    const wantedExts = new Set<string>();
    for (const l of languages) for (const e of pack.languages[l].extensions) wantedExts.add(e);
    const selectedLanguages = new Set(languages);
    if (selectedLanguages.has('typescript')) wantedExts.add('.tsx');
    if (selectedLanguages.has('javascript')) wantedExts.add('.jsx');

    const files = this.walkFiles(targetPath, [...wantedExts], maxFiles, walkErrors);
    const findings: AstScanFinding[] = [];
    const allowedRuleIds = options?.rules ? new Set(options.rules) : null;

    for (const file of files) {
      if (findings.length >= MAX_FINDINGS) break;
      try {
        const content = readFileSync(file, 'utf-8');
        if (content.length > maxFileSize) continue;

        const ext = extname(file).toLowerCase();
        const override = EXT_OVERRIDE[ext];
        const lang: SupportedLanguage | null = override?.lang ?? this.detectFileLanguage(file, pack.languageExtensionSets);
        if (!lang) continue;
        const agName = override?.agName ?? pack.languages[lang].agName;

        let root: AstGrepNode;
        try {
          const parsed = ag.parse(agName, content);
          if (!isAstGrepRoot(parsed)) {
            throw new Error('ast-grep parse result is missing root()');
          }
          const parsedRoot = parsed.root();
          if (!isAstGrepNode(parsedRoot)) {
            throw new Error('ast-grep root node is missing expected methods');
          }
          root = parsedRoot;
        } catch (error) {
          scanErrors.push({ file: relative(targetPath, file), reason: `parse failed: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }

        const applicableRules = pack.rules.filter(r =>
          (pack.ruleLanguageSets.get(r.id)?.has(lang) ?? false) && (!allowedRuleIds || allowedRuleIds.has(r.id))
        );

        for (const rule of applicableRules) {
          if (findings.length >= MAX_FINDINGS) break;
          this.scanWithRule(root, rule, file, targetPath, lang, findings);
        }
      } catch (error) {
        scanErrors.push({ file: relative(targetPath, file), reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const duration = Date.now() - startTime;
    const highCritical = findings.filter(f => f.severity === 'HIGH' || f.severity === 'CRITICAL').length;
    const partial = scanErrors.length > 0 || walkErrors.length > 0;
    const errorSuffix = partial ? `，部分失败: scanErrors=${scanErrors.length}, walkErrors=${walkErrors.length}` : '';

    return {
      success: true,
      tool: 'ast-grep',
      languages,
      filesScanned: files.length,
      findings,
      summary: `ast-grep AST 扫描完成: ${files.length} 文件, ${languages.length} 种语言 (${languages.join('/')}), ${findings.length} 个安全问题 (${highCritical} 高危), 耗时 ${duration}ms${errorSuffix}`,
      duration,
      partial,
      filesSkipped: scanErrors.length,
      scanErrors: scanErrors.slice(0, 50),
      walkErrors: walkErrors.slice(0, 50),
    };
  }

  private scanWithRule(
    root: AstGrepNode,
    rule: SecurityRule,
    file: string,
    basePath: string,
    lang: SupportedLanguage,
    findings: AstScanFinding[],
  ): void {
    // 通过 ast-grep 的 kind 选择器一次拿到所有候选节点，再用正则做精确判断
    const candidates: AstGrepNode[] = [];
    for (const kind of rule.nodeKinds) {
      try {
        // findAll(kind: string) 等价于 findAll({ rule: { kind } })
        const list = root.findAll({ rule: { kind } });
        if (Array.isArray(list)) candidates.push(...list.filter(isAstGrepNode));
      } catch {
        // 该 kind 在当前语言不存在 → 忽略
      }
    }
    if (candidates.length === 0) return;

    for (const node of candidates) {
      if (findings.length >= MAX_FINDINGS) return;
      let text: string;
      try { text = node.text(); } catch {/* expected: skip invalid entry */ continue; }
      if (!text) continue;

      const patternHit = rule.patterns.some(p => { p.lastIndex = 0; return p.test(text); });
      if (!patternHit) continue;

      if (rule.contextPatterns && rule.contextPatterns.length > 0) {
        const allCtx = rule.contextPatterns.every(p => { p.lastIndex = 0; return p.test(text); });
        if (!allCtx) continue;
      }

      let range: AstGrepRange | null = null;
      try {
        range = readAstGrepRange(node.range());
      } catch {/* expected: best-effort cleanup */}

      findings.push({
        id: `${rule.id}-${findings.length + 1}`,
        severity: rule.severity,
        cwe: rule.cwe,
        owasp: rule.owasp,
        rule: rule.id,
        title: rule.title,
        message: rule.description,
        file: relative(basePath, file),
        line: (range?.start.line ?? 0) + 1,
        column: (range?.start.column ?? 0) + 1,
        endLine: range ? range.end.line + 1 : undefined,
        code: text.slice(0, 200),
        language: lang,
        source: 'ast-grep',
      });
    }
  }

  private detectFileLanguage(file: string, languageExtensionSets: Map<SupportedLanguage, ReadonlySet<string>>): SupportedLanguage | null {
    const ext = extname(file).toLowerCase();
    for (const [lang, exts] of languageExtensionSets) {
      if (exts.has(ext)) return lang;
    }
    return null;
  }

  private walkFiles(dir: string, exts: string[], maxFiles: number, walkErrors?: Array<{ dir: string; reason: string }>): string[] {
    const results: string[] = [];
    const extSet = new Set(exts);
    const walk = (d: string, depth = 0) => {
      if (results.length >= maxFiles || depth > 8) return;
      try {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (results.length >= maxFiles) return;
          const name = entry.name;
          if (shouldSkipWalkEntry(name)) continue;
          const full = join(d, name);
          if (entry.isDirectory()) walk(full, depth + 1);
          else if (extSet.has(extname(name).toLowerCase())) {
            try {
              if (statSync(full).size < 500_000) results.push(full);
            } catch {/* expected: best-effort cleanup */}
          }
        }
      } catch (error) {
        walkErrors?.push({ dir: d, reason: error instanceof Error ? error.message : String(error) });
      }
    };
    walk(dir);
    return results;
  }
}

export const treeSitterEngine = new TreeSitterSecurityEngine();
