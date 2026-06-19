/**
 * securityScanEval — bughunt 静态扫描器的准确率度量与回归门。
 *
 * 对 benchmark/fixtures 下的真值标注语料跑「确定性 tier」（ast-grep + builtin +
 * taint，跳过 tsc/npm/semgrep 等环境相关 tier），度量 case-level precision/recall：
 *   - TP case：expectedCwes 应被检测（recall）
 *   - clean case：不应有任何 finding（precision，零误报）
 *
 * 确定性、无启发式：度量完全由规则 + fixture 真值驱动。用作 npm test 回归门
 * （recall 不退化）与 npm run eval:security 仪表盘（出 precision/recall/F1 报告）。
 *
 * 度量逻辑参考 src/eval/CodingEvalHarness 的 task→run→suite 聚合骨架，但扫描器
 * 准确率度量（TP/FP/FN/precision/recall）是新写的（CodingEvalHarness 是代码任务通过率）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { runFullScan } from '../tools/implementations/BughuntScanTools.js';
import { runTaintScan } from '../tools/implementations/BughuntTaintScanner.js';
import { getRulePack } from '../tools/implementations/rules/RuleLoader.js';

const GroundTruthCaseSchema = z.object({
  file: z.string(),
  expectedCwes: z.array(z.string()),
  kind: z.enum(['TP', 'clean']),
});

const GroundTruthSchema = z.object({
  suite: z.string(),
  fixturesDir: z.string(),
  description: z.string().optional(),
  cases: z.array(GroundTruthCaseSchema),
});

export type GroundTruthCase = z.infer<typeof GroundTruthCaseSchema>;
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

export interface CaseResult {
  file: string;
  kind: 'TP' | 'clean';
  detectedCwes: string[];
  expectedCwes: string[];
  pass: boolean;
  reason: string;
}

export interface ScanAccuracy {
  suite: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  perCase: CaseResult[];
}

/** 从 JSON 文件加载真值；fixturesDir 解析为相对 projectRoot 的绝对路径。 */
export function loadGroundTruth(truthPath: string, projectRoot: string): GroundTruth {
  const raw = JSON.parse(readFileSync(truthPath, 'utf-8'));
  const truth = GroundTruthSchema.parse(raw);
  return { ...truth, fixturesDir: resolve(projectRoot, truth.fixturesDir) };
}

/** 合并 js+ts 语言配置的污点源（与 BughuntScanToolWrappers 一致）。 */
function collectJsTsSources(): string[] {
  const pack = getRulePack();
  return [...new Set([...pack.languages.javascript.sources, ...pack.languages.typescript.sources])];
}

/**
 * 跑确定性 tier，度量 case-level 准确率。
 */
export async function measureScanAccuracy(truth: GroundTruth): Promise<ScanAccuracy> {
  const results = await runFullScan(truth.fixturesDir, {
    skipTsc: true,
    skipNpmAudit: true,
    skipSemgrep: true,
  });
  const taint = runTaintScan(truth.fixturesDir, collectJsTsSources());

  // 收集每个文件命中的 CWE 集合（去重）
  const detectedByFile = new Map<string, Set<string>>();
  const record = (file: string | undefined, cwe: string | undefined): void => {
    if (!file || !cwe) return;
    const set = detectedByFile.get(file) ?? new Set<string>();
    set.add(cwe);
    detectedByFile.set(file, set);
  };
  for (const r of results) {
    for (const f of r.findings) record(f.file, f.cwe);
  }
  for (const f of taint.findings) record(f.file, f.cwe);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const perCase: CaseResult[] = [];

  for (const c of truth.cases) {
    const detected = detectedByFile.get(c.file) ?? new Set<string>();
    const detectedArr = [...detected];
    if (c.kind === 'TP') {
      const missed = c.expectedCwes.filter((cwe) => !detected.has(cwe));
      if (missed.length === 0) {
        tp += 1;
        perCase.push({ file: c.file, kind: 'TP', detectedCwes: detectedArr, expectedCwes: c.expectedCwes, pass: true, reason: 'all expected CWE detected' });
      } else {
        fn += 1;
        perCase.push({ file: c.file, kind: 'TP', detectedCwes: detectedArr, expectedCwes: c.expectedCwes, pass: false, reason: `missed CWE: ${missed.join(', ')}` });
      }
    } else {
      if (detected.size === 0) {
        tn += 1;
        perCase.push({ file: c.file, kind: 'clean', detectedCwes: [], expectedCwes: [], pass: true, reason: 'no findings (clean)' });
      } else {
        fp += 1;
        perCase.push({ file: c.file, kind: 'clean', detectedCwes: detectedArr, expectedCwes: [], pass: false, reason: `false positive CWE: ${detectedArr.join(', ')}` });
      }
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { suite: truth.suite, tp, fp, fn, tn, precision, recall, f1, perCase };
}

/** 人类可读报告（npm run eval:security 输出）。 */
export function renderAccuracyReport(acc: ScanAccuracy): string {
  const lines = [
    `# Security Scan Accuracy — ${acc.suite}`,
    '',
    `| metric    | value |`,
    `|-----------|-------|`,
    `| TP        | ${acc.tp} |`,
    `| FP        | ${acc.fp} |`,
    `| FN        | ${acc.fn} |`,
    `| TN        | ${acc.tn} |`,
    `| precision | ${acc.precision.toFixed(3)} |`,
    `| recall    | ${acc.recall.toFixed(3)} |`,
    `| F1        | ${acc.f1.toFixed(3)} |`,
    '',
    '## Per-case',
  ];
  for (const c of acc.perCase) {
    const mark = c.pass ? '✔' : '✖';
    lines.push(`- ${mark} ${c.kind} ${c.file}: ${c.reason} (expected=${c.expectedCwes.join('/') || '-'}, detected=${c.detectedCwes.join('/') || '-'})`);
  }
  return lines.join('\n');
}
