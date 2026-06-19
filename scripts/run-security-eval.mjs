#!/usr/bin/env node
/**
 * run-security-eval.mjs — bughunt 静态扫描器准确率仪表盘（npm run eval:security）。
 *
 * 跑 benchmark/fixtures 真值语料，输出 precision/recall/F1 报告。
 * recall < 1.0（有 TP 漏检）时以非零退出码告警，便于 CI 卡。
 *
 * 依赖 dist/ 已构建（npm run build）。度量逻辑见 src/eval/securityScanEval.ts。
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { measureScanAccuracy, loadGroundTruth, renderAccuracyReport } from '../dist/eval/securityScanEval.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const truthPath = join(projectRoot, 'benchmark', 'expected', 'bughunt-baseline.json');

const truth = loadGroundTruth(truthPath, projectRoot);
const acc = await measureScanAccuracy(truth);
console.log(renderAccuracyReport(acc));

if (acc.recall < 1.0) {
  console.error(`\n⚠ recall=${acc.recall.toFixed(3)} < 1.0（存在 TP 漏检，规则召回退化）`);
  process.exit(1);
}
console.log(`\n✓ recall=${acc.recall.toFixed(3)} precision=${acc.precision.toFixed(3)} f1=${acc.f1.toFixed(3)}`);
