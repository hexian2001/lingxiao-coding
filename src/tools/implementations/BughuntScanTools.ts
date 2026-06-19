/**
 * BughuntScanTools — BugHunt 模式静态分析工具（跨平台）
 *
 * 3 层扫描架构：
 * - Tier 1（始终可用）：内建 OWASP 正则规则 + @nodesecure/js-x-ray AST 分析
 * - Tier 2（Node 项目）：tsc 类型检查 + npm audit 依赖漏洞
 * - Tier 3（可选增强）：semgrep 深度语义分析
 *
 * 跨平台：npm install 后即可使用 Tier 0/1，无需任何外部工具
 *   - Tier 0 多语言 AST：@ast-grep/napi（NAPI 预编译，9 平台均零编译）
 *   - Tier 1 内建 OWASP 正则 + js-x-ray
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, extname, relative } from 'path';
import { commandExists } from '../../utils/platform.js';
import { getRulePack, type LoadedRulePack } from './rules/RuleLoader.js';
import type { SecurityPattern } from './rules/schema.js';
import type { ScannerAdapter, ScanOptions } from './scanners/ScannerAdapter.js';

export interface ScanFinding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  rule: string;
  message: string;
  file: string;
  line?: number;
  endLine?: number;
  code?: string;
  cwe?: string;
  owasp?: string;
  source: string;
}

export interface ScanResult {
  success: boolean;
  tool: string;
  findings: ScanFinding[];
  summary: string;
  rawOutput?: string;
  error?: string;
  exitCode?: number | string;
}

function hasCommand(cmd: string): boolean {
  return commandExists(cmd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringOrNumber(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncatedErrorMessage(error: unknown, maxLength: number): string {
  return errorMessage(error).slice(0, maxLength);
}

function readOutputString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return undefined;
}

function commandFailureOutput(error: unknown): string {
  if (!isRecord(error)) return '';
  const stdout = readOutputString(error.stdout);
  if (stdout) return stdout;
  return readOutputString(error.stderr) ?? stdout ?? '';
}

function commandFailureExitCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) return undefined;
  return readStringOrNumber(error.status) ?? readStringOrNumber(error.code);
}

function commandFailureWasKilled(error: unknown): boolean {
  return isRecord(error) && error.killed === true;
}

function commandFailureSignal(error: unknown): string | number | undefined {
  return isRecord(error) ? readStringOrNumber(error.signal) : undefined;
}

export function detectAvailableScanners(): string[] {
  const available: string[] = ['builtin', 'ast-grep', 'js-x-ray'];
  if (hasCommand('tsc')) available.push('tsc');
  if (hasCommand('npm')) available.push('npm-audit');
  if (hasCommand('semgrep')) available.push('semgrep');
  return available;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 1: 内建 OWASP 正则规则（零依赖，始终可用）
// ═══════════════════════════════════════════════════════════════════════════════

// SecurityPattern 类型从 ./rules/schema.js 导入（见文件顶部）。

const WALK_SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

// 内建正则规则（原 SECURITY_PATTERNS）已外部化到 rules/seed.ts，
// 经 RuleLoader.getRulePack().patterns 注入；扩展名过滤改为 LoadedRulePack.patternExtSets。

function shouldSkipWalkEntry(name: string): boolean {
  return name[0] === '.' || WALK_SKIP_DIRS.has(name);
}

function walkFiles(dir: string, exts: string[], maxFiles = 500): string[] {
  const results: string[] = [];
  const extSet = new Set(exts);
  const walk = (d: string) => {
    if (results.length >= maxFiles) return;
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (results.length >= maxFiles) return;
        if (shouldSkipWalkEntry(entry.name)) continue;
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (extSet.size === 0 || extSet.has(extname(entry.name).toLowerCase())) {
          results.push(full);
        }
      }
    } catch { /* permission denied etc */ }
  };
  walk(dir);
  return results;
}

export function runBuiltinScan(targetPath: string, options?: { rulePack?: LoadedRulePack }): ScanResult {
  const pack = options?.rulePack ?? getRulePack();
  const allExts = [...pack.allPatternExts];
  const files = walkFiles(targetPath, allExts);
  const findings: ScanFinding[] = [];
  let count = 0;

  for (const file of files) {
    if (findings.length >= 200) break;
    try {
      const content = readFileSync(file, 'utf-8');
      if (content.length > 500_000) continue;
      const ext = extname(file).toLowerCase();
      const lines = content.split('\n');

      for (const pattern of pack.patterns) {
        if (!(pack.patternExtSets.get(pattern.id)?.has(ext) ?? false)) continue;
        pattern.pattern.lastIndex = 0;
        let match;
        while ((match = pattern.pattern.exec(content)) !== null) {
          count++;
          const lineNum = content.substring(0, match.index).split('\n').length;
          const codeLine = lines[lineNum - 1]?.trim().slice(0, 200) || '';
          findings.push({
            id: `${pattern.id}-${count}`,
            severity: pattern.severity,
            rule: pattern.rule,
            message: pattern.message,
            file: relative(targetPath, file),
            line: lineNum,
            code: codeLine,
            cwe: pattern.cwe,
            owasp: pattern.owasp,
            source: 'builtin',
          });
          if (findings.length >= 200) break;
        }
      }
    } catch { /* read error */ }
  }

  return {
    success: true,
    tool: 'builtin-owasp',
    findings,
    summary: `内建 OWASP 扫描完成: 扫描 ${files.length} 个文件, 发现 ${findings.length} 个安全问题 (${findings.filter(f => f.severity === 'HIGH' || f.severity === 'CRITICAL').length} 高危)`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 1b: @nodesecure/js-x-ray AST 分析
// ═══════════════════════════════════════════════════════════════════════════════

export async function runJsXrayScan(targetPath: string): Promise<ScanResult> {
  try {
    const jsXray = await import('@nodesecure/js-x-ray');
    const { AstAnalyser } = jsXray;
    const analyser = new AstAnalyser();
    const files = walkFiles(targetPath, ['.js', '.mjs', '.cjs'], 200);
    const findings: ScanFinding[] = [];
    let count = 0;

    for (const file of files) {
      if (findings.length >= 100) break;
      try {
        const content = readFileSync(file, 'utf-8');
        if (content.length > 300_000) continue;
        const result = analyser.analyse(content, { location: file });

        for (const warning of result.warnings) {
          count++;
          findings.push({
            id: `XRAY-${count}`,
            severity: mapXraySeverity(warning.kind),
            rule: `js-x-ray/${warning.kind}`,
            message: warning.value || warning.kind,
            file: relative(targetPath, file),
            line: readXrayWarningLine(warning.location),
            source: 'js-x-ray',
          });
        }
      } catch { /* parse error */ }
    }

    return {
      success: true,
      tool: 'js-x-ray',
      findings,
      summary: `js-x-ray AST 分析完成: 扫描 ${files.length} 个文件, 发现 ${findings.length} 个问题`,
    };
  } catch (err: unknown) {
    return {
      success: false,
      tool: 'js-x-ray',
      findings: [],
      summary: `js-x-ray 不可用: ${truncatedErrorMessage(err, 100)}`,
      error: errorMessage(err),
    };
  }
}

function readXrayWarningLine(location: unknown): number | undefined {
  if (isRecord(location)) {
    const start = isRecord(location.start) ? location.start : undefined;
    return readNumber(start?.line);
  }
  if (
    Array.isArray(location) &&
    Array.isArray(location[0]) &&
    typeof location[0][0] === 'number'
  ) {
    return location[0][0];
  }
  return undefined;
}

const XRAY_HIGH_WARNINGS = new Set([
  'unsafe-import',
  'unsafe-regex',
  'unsafe-stmt',
  'encoded-literal',
  'obfuscated-code',
]);

const XRAY_MEDIUM_WARNINGS = new Set([
  'short-identifiers',
  'suspicious-literal',
  'suspicious-file',
]);

function mapXraySeverity(warning: string): ScanFinding['severity'] {
  if (XRAY_HIGH_WARNINGS.has(warning)) return 'HIGH';
  if (XRAY_MEDIUM_WARNINGS.has(warning)) return 'MEDIUM';
  return 'LOW';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 2: tsc + npm audit（Node 项目通常可用）
// ═══════════════════════════════════════════════════════════════════════════════

export function runTscScan(projectPath: string): ScanResult {
  if (!hasCommand('npx') && !hasCommand('tsc')) {
    return { success: false, tool: 'tsc', findings: [], summary: 'tsc 不可用（非 TypeScript 项目或未安装）' };
  }
  if (!existsSync(join(projectPath, 'tsconfig.json'))) {
    return { success: false, tool: 'tsc', findings: [], summary: '未找到 tsconfig.json，跳过 TypeScript 检查' };
  }

  try {
    execSync('npx tsc --noEmit --pretty false', { cwd: projectPath, encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024, stdio: 'pipe' });
    return { success: true, tool: 'tsc', findings: [], summary: 'TypeScript 类型检查通过' };
  } catch (err: unknown) {
    const output = commandFailureOutput(err);
    const findings = parseTscErrors(output);
    const exitCode = commandFailureExitCode(err);
    if (findings.length > 0) {
      return { success: true, tool: 'tsc', findings, summary: `TypeScript 发现 ${findings.length} 个类型错误`, rawOutput: output.slice(0, 5000), exitCode };
    }
    const message = errorMessage(err);
    const reason = commandFailureWasKilled(err) || commandFailureSignal(err) !== undefined || /timeout|timed out/i.test(message)
      ? `tsc 执行超时或被终止: ${message}`
      : `tsc 执行失败且未解析到类型错误: ${message}`;
    return { success: false, tool: 'tsc', findings: [], summary: reason, rawOutput: output.slice(0, 5000), error: reason, exitCode };
  }
}

function parseTscErrors(output: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const regex = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
  let match;
  let count = 0;
  while ((match = regex.exec(output)) !== null && count < 100) {
    count++;
    findings.push({ id: `TSC-${count}`, severity: 'MEDIUM', rule: match[4], message: match[5].trim(), file: match[1], line: parseInt(match[2]), source: 'tsc' });
  }
  return findings;
}

export function runNpmAuditScan(projectPath: string): ScanResult {
  if (!hasCommand('npm')) {
    return { success: false, tool: 'npm-audit', findings: [], summary: 'npm 不可用' };
  }
  if (!existsSync(join(projectPath, 'package.json'))) {
    return { success: false, tool: 'npm-audit', findings: [], summary: '未找到 package.json，跳过依赖审计' };
  }

  try {
    const raw = execSync('npm audit --json', { cwd: projectPath, encoding: 'utf-8', timeout: 60_000, maxBuffer: 5 * 1024 * 1024, stdio: 'pipe' });
    const parsed: unknown = JSON.parse(raw);
    const findings = parseNpmAuditFindings(parsed);

    return { success: true, tool: 'npm-audit', findings, summary: `npm audit: ${findings.length} 个依赖漏洞 (${findings.filter(f => f.severity === 'HIGH' || f.severity === 'CRITICAL').length} 高危)` };
  } catch (err: unknown) {
    // npm audit exit code 1 = has vulnerabilities (not an error)
    try {
      const output = readOutputString(isRecord(err) ? err.stdout : undefined) ?? '';
      const parsed: unknown = JSON.parse(output);
      const findings = parseNpmAuditFindings(parsed);
      return { success: true, tool: 'npm-audit', findings, summary: `npm audit: ${findings.length} 个依赖漏洞` };
    } catch {/* expected: fallback to default */
      return { success: false, tool: 'npm-audit', findings: [], summary: `npm audit 失败: ${truncatedErrorMessage(err, 100)}` };
    }
  }
}

type NpmAuditVia = string | { title: string };

interface NpmAuditVulnerabilityDto {
  severity?: string;
  via: NpmAuditVia[];
}

function parseNpmAuditFindings(parsed: unknown): ScanFinding[] {
  const vulnerabilities = readNpmAuditVulnerabilities(parsed);
  const findings: ScanFinding[] = [];
  for (const [name, vuln] of vulnerabilities) {
    const firstVia = vuln.via[0];
    const firstViaTitle = typeof firstVia === 'object' ? firstVia.title : undefined;
    findings.push({
      id: `NPM-${findings.length + 1}`,
      severity: mapNpmSeverity(vuln.severity),
      rule: firstViaTitle || 'dependency vulnerability',
      message: `${name}: ${firstViaTitle || firstVia || 'known vulnerability'}`,
      file: `package.json → ${name}`,
      source: 'npm-audit',
    });
    if (findings.length >= 50) break;
  }
  return findings;
}

function readNpmAuditVulnerabilities(parsed: unknown): Array<[string, NpmAuditVulnerabilityDto]> {
  if (!isRecord(parsed) || !isRecord(parsed.vulnerabilities)) return [];
  const vulnerabilities: Array<[string, NpmAuditVulnerabilityDto]> = [];
  for (const [name, rawVulnerability] of Object.entries(parsed.vulnerabilities)) {
    if (!isRecord(rawVulnerability)) continue;
    vulnerabilities.push([
      name,
      {
        severity: readString(rawVulnerability.severity),
        via: readNpmAuditVia(rawVulnerability.via),
      },
    ]);
  }
  return vulnerabilities;
}

function readNpmAuditVia(rawVia: unknown): NpmAuditVia[] {
  if (!Array.isArray(rawVia)) return [];
  const via: NpmAuditVia[] = [];
  for (const entry of rawVia) {
    if (typeof entry === 'string') {
      via.push(entry);
    } else if (isRecord(entry)) {
      const title = readString(entry.title);
      if (title) via.push({ title });
    }
  }
  return via;
}

function mapNpmSeverity(sev?: string): ScanFinding['severity'] {
  switch (sev?.toLowerCase()) {
    case 'critical': return 'CRITICAL';
    case 'high': return 'HIGH';
    case 'moderate': return 'MEDIUM';
    case 'low': return 'LOW';
    default: return 'INFO';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 3: semgrep（可选增强）
// ═══════════════════════════════════════════════════════════════════════════════

export function runSemgrepScan(targetPath: string, rules?: string): ScanResult {
  if (!hasCommand('semgrep')) {
    return { success: false, tool: 'semgrep', findings: [], summary: 'semgrep 未安装（可选增强，内建扫描已覆盖基础规则）。安装: pip3 install semgrep' };
  }

  try {
    const ruleArg = rules || 'auto';
    const raw = execFileSync('semgrep', ['--config', ruleArg, '--json', '--quiet', '--max-target-bytes=1000000', targetPath], { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(raw);
    const findings = parseSemgrepFindings(parsed);

    return { success: true, tool: 'semgrep', findings, summary: `semgrep: ${findings.length} 个发现 (${findings.filter(f => f.severity === 'HIGH' || f.severity === 'CRITICAL').length} 高危)` };
  } catch (err: unknown) {
    return { success: false, tool: 'semgrep', findings: [], summary: `semgrep 失败: ${truncatedErrorMessage(err, 200)}`, error: errorMessage(err) };
  }
}

function parseSemgrepFindings(parsed: unknown): ScanFinding[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) return [];
  const findings: ScanFinding[] = [];
  for (const result of parsed.results) {
    if (!isRecord(result)) continue;
    const extra = isRecord(result.extra) ? result.extra : {};
    const start = isRecord(result.start) ? result.start : {};
    const metadata = isRecord(extra.metadata) ? extra.metadata : {};
    findings.push({
      id: `SEMGREP-${findings.length + 1}`,
      severity: mapSemgrepSeverity(readString(extra.severity)),
      rule: readString(result.check_id) || 'unknown',
      message: readString(extra.message) || '',
      file: readString(result.path) || '',
      line: readNumber(start.line),
      code: readString(extra.lines)?.slice(0, 500),
      cwe: extractMetadataText(metadata.cwe),
      owasp: extractMetadataText(metadata.owasp),
      source: 'semgrep',
    });
  }
  return findings;
}

function mapSemgrepSeverity(sev?: string): ScanFinding['severity'] {
  switch (sev?.toUpperCase()) {
    case 'ERROR': return 'HIGH';
    case 'WARNING': return 'MEDIUM';
    default: return 'LOW';
  }
}

function extractMetadataText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const text = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ');
    return text || undefined;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 综合扫描入口
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ScannerAdapter 注册表（统一接口；数组顺序 = runFullScan 输出顺序，字节级稳定）
// ═══════════════════════════════════════════════════════════════════════════════

const astGrepScanner: ScannerAdapter = {
  name: 'ast-grep',
  shouldSkip: (o) => Boolean(o.skipTreeSitter),
  async scan(target: string): Promise<ScanResult> {
    try {
      const { treeSitterEngine } = await import('./TreeSitterSecurityEngine.js');
      const astResult = await treeSitterEngine.scan(target);
      return {
        success: astResult.success,
        tool: `ast-grep (${astResult.languages.join('/')})`,
        findings: astResult.findings.map(f => ({
          id: f.id, severity: f.severity, rule: f.rule,
          message: `[${f.cwe || ''}] ${f.title}: ${f.message}`,
          file: f.file, line: f.line, code: f.code, cwe: f.cwe, owasp: f.owasp, source: f.source,
        })),
        summary: astResult.summary,
      };
    } catch (err: unknown) {
      return { success: false, tool: 'ast-grep', findings: [], summary: `ast-grep 不可用: ${truncatedErrorMessage(err, 100)}` };
    }
  },
};

const builtinScanner: ScannerAdapter = {
  name: 'builtin-owasp',
  shouldSkip: (o) => Boolean(o.skipBuiltin),
  scan: (target: string) => Promise.resolve(runBuiltinScan(target)),
};

const jsXrayScanner: ScannerAdapter = {
  name: 'js-x-ray',
  shouldSkip: (o) => Boolean(o.skipJsXray),
  scan: (target: string) => runJsXrayScan(target),
};

const tscScanner: ScannerAdapter = {
  name: 'tsc',
  shouldSkip: (o) => Boolean(o.skipTsc),
  scan: (target: string) => Promise.resolve(runTscScan(target)),
};

const npmAuditScanner: ScannerAdapter = {
  name: 'npm-audit',
  shouldSkip: (o) => Boolean(o.skipNpmAudit),
  scan: (target: string) => Promise.resolve(runNpmAuditScan(target)),
};

const semgrepScanner: ScannerAdapter = {
  name: 'semgrep',
  shouldSkip: (o) => Boolean(o.skipSemgrep),
  scan: (target: string, o: ScanOptions) => Promise.resolve(runSemgrepScan(target, o.semgrepRules)),
};

/** 注册的扫描器（顺序 = runFullScan 输出顺序；新增 tier 在此追加即可）。 */
export const SCANNER_ADAPTERS: readonly ScannerAdapter[] = [
  astGrepScanner,
  builtinScanner,
  jsXrayScanner,
  tscScanner,
  npmAuditScanner,
  semgrepScanner,
];

// ═══════════════════════════════════════════════════════════════════════════════
// 综合扫描入口
// ═══════════════════════════════════════════════════════════════════════════════

export async function runFullScan(projectPath: string, options?: ScanOptions): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const adapter of SCANNER_ADAPTERS) {
    if (options && adapter.shouldSkip(options)) continue;
    results.push(await adapter.scan(projectPath, options ?? {}));
  }
  return results;
}
