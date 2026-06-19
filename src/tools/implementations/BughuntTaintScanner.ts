/**
 * BughuntTaintScanner — 目录级污点扫描编排。
 *
 * walk JS/TS 文件 → 逐文件调 TaintFlowEngine.analyzeTaintInSource（过程内
 * value-flow backward analysis）→ 汇总 TaintFinding[]（带自动 taint_path）。
 *
 * 当前内置命令注入 profile（CWE-78）；source 来自语言配置，sink 为声明的
 * 命令执行函数。确定性、无启发式；跨平台零二进制（仅 typescript 编译器 API）。
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';
import { analyzeTaintInSource, type TaintFinding, type TaintAnalysisOptions } from '../../core/TaintFlowEngine.js';

const JSTS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.lingxiao']);

/** 命令注入汇聚点函数名（CWE-78 profile；声明式，可扩展更多 profile）。 */
const COMMAND_INJECTION_SINKS: readonly string[] = [
  'exec', 'execSync', 'execFile', 'execFileSync',
  'spawn', 'spawnSync', 'fork',
  'system', 'popen',
];

export interface TaintScanResult {
  findings: TaintFinding[];
  filesScanned: number;
}

/**
 * 对 target 目录下 JS/TS 文件做污点扫描。
 * @param sources 声明的污点源（来自语言配置 js+ts sources 合并）。
 */
export function runTaintScan(target: string, sources: readonly string[]): TaintScanResult {
  const baseOptions: Omit<TaintAnalysisOptions, 'language'> = {
    sources: [...sources],
    sinks: [...COMMAND_INJECTION_SINKS],
    ruleId: 'TAINT-CWE-78',
    cwe: 'CWE-78',
    severity: 'CRITICAL',
  };
  const findings: TaintFinding[] = [];
  const files = walkJsTs(target);
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      if (content.length > 500_000) continue;
      const relFile = relative(target, file) || file;
      const lang = isTsExt(file) ? 'typescript' : 'javascript';
      const fileFindings = analyzeTaintInSource(relFile, content, { ...baseOptions, language: lang });
      findings.push(...fileFindings);
    } catch {/* expected: best-effort skip */}
  }
  return { findings, filesScanned: files.length };
}

function isTsExt(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
}

function walkJsTs(dir: string, maxFiles = 500): string[] {
  const out: string[] = [];
  const walk = (d: string, depth = 0): void => {
    if (out.length >= maxFiles || depth > 8) return;
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (out.length >= maxFiles) return;
        if (entry.name[0] === '.' || SKIP_DIRS.has(entry.name)) continue;
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (JSTS_EXTS.has(extname(entry.name).toLowerCase())) {
          try {
            if (statSync(full).size < 500_000) out.push(full);
          } catch {/* expected: best-effort skip */}
        }
      }
    } catch {/* expected: permission etc */}
  };
  walk(dir);
  return out;
}
