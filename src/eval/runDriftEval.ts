/**
 * 漂移 eval CLI — 把"漂移"变成数字。
 *
 * 用法(tsx 直跑 src,绕过 stale-dist 坑):
 *   npx tsx src/eval/runDriftEval.ts --runs 5 --workspace /tmp/lingxiao-drift-eval
 *   npx tsx src/eval/runDriftEval.ts --runs 5 --task add-util-addfn --timeout 600000
 *
 * 对每个冻结任务跑 N 次(每次独立隔离 workspace),聚合跨运行方差:
 *   - changedFileSetInstability:改动文件集合的 Jaccard 距离(0=每次改一样=零漂移)
 *   - outOfScopeCount 方差:scope creep 的稳定性
 *   - tokenTotal / durationMs 方差
 *
 * 这是 T1(温度锁)+T2(goal 置顶)防漂移修复的"裁判":跑 baseline → 应用修复 → 再跑 →
 * 比较 instability/variance 是否下降。需要真实 LLM key + 预算。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import { FROZEN_DRIFT_TASKS } from './tasks/frozenTasks.js';
import { DriftEvalRunner } from './DriftEvalRunner.js';
import { aggregateVariance, type DriftRunMetrics } from './driftMetrics.js';

interface CliArgs {
  runs: number;
  taskId?: string;
  workspace: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { runs: 5, workspace: '/tmp/lingxiao-drift-eval', timeoutMs: 30 * 60 * 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--runs' && next) { args.runs = Math.max(1, parseInt(next, 10) || 5); i++; }
    else if (a === '--task' && next) { args.taskId = next; i++; }
    else if (a === '--workspace' && next) { args.workspace = next; i++; }
    else if (a === '--timeout' && next) { args.timeoutMs = parseInt(next, 10) || args.timeoutMs; i++; }
  }
  return args;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = args.taskId ? FROZEN_DRIFT_TASKS.filter((t) => t.id === args.taskId) : FROZEN_DRIFT_TASKS;
  if (tasks.length === 0) {
    console.error(`未找到任务: ${args.taskId}`);
    process.exit(1);
  }

  console.log('═══ 凌霄漂移度量 eval ═══');
  console.log(`任务数: ${tasks.length} · 每任务运行: ${args.runs} 次 · workspace 根: ${args.workspace}`);
  console.log(`(防漂移修复后跑此 harness,看 instability/variance 是否低于修复前 baseline)\n`);

  const runner = new DriftEvalRunner({
    baseWorkspace: args.workspace,
    maxRuntimeMs: args.timeoutMs,
  });

  for (const task of tasks) {
    console.log(`▶ 任务 ${task.id}: ${task.title}`);
    const perRun: DriftRunMetrics[] = [];
    for (let i = 0; i < args.runs; i++) {
      const runWorkspace = path.join(args.workspace, `${task.id}`, `run-${i}`);
      await rm(runWorkspace, { recursive: true, force: true });
      await mkdir(runWorkspace, { recursive: true });
      process.stdout.write(`  run ${i + 1}/${args.runs} ... `);
      const started = Date.now();
      try {
        const result = await runner.run(task, { suiteId: 'drift', workspace: runWorkspace });
        const drift = (result.metadata?.drift as DriftRunMetrics | undefined) ?? {
          runIndex: i,
          passed: result.passed,
          changedFiles: result.changedFiles,
          changedFileCount: result.changedFiles.length,
          outOfScopeFiles: (result.metadata?.outOfScopeFiles as string[]) ?? [],
          outOfScopeCount: (result.metadata?.outOfScopeCount as number) ?? 0,
          unexpectedChangedFiles: (result.metadata?.unexpectedChangedFiles as string[]) ?? [],
          tokenTotal: result.tokenTotal,
          durationMs: result.durationMs,
        };
        perRun.push({ ...drift, runIndex: i });
        console.log(`done ${((Date.now() - started) / 1000).toFixed(0)}s · changed=${drift.changedFileCount} oos=${drift.outOfScopeCount} ${result.passed ? '✓' : '✗'}`);
      } catch (error) {
        console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (perRun.length === 0) {
      console.log('  (无有效运行,跳过聚合)\n');
      continue;
    }
    const report = aggregateVariance(task.id, perRun);
    console.log(`  ─ 漂移报告 ─`);
    console.log(`    passRate:                ${fmt(report.passRate * 100)}% (${perRun.filter((r) => r.passed).length}/${report.runCount})`);
    console.log(`    changedFileSetInstability: ${fmt(report.changedFileSetInstability)}  (0=零漂移, 1=最大漂移) ← 核心指标`);
    console.log(`    changedFileCount:         mean=${fmt(report.changedFileCount.mean)} std=${fmt(report.changedFileCount.std)} [${report.changedFileCount.min}-${report.changedFileCount.max}]`);
    console.log(`    outOfScopeCount:          mean=${fmt(report.outOfScopeCount.mean)} std=${fmt(report.outOfScopeCount.std)}`);
    console.log(`    tokenTotal:               mean=${fmt(report.tokenTotal.mean)} std=${fmt(report.tokenTotal.std)}`);
    console.log(`    durationMs:               mean=${fmt(report.durationMs.mean)} std=${fmt(report.durationMs.std)}\n`);
  }

  console.log('═══ 完成 ═══');
  console.log('对比方式: 在 T1(温度锁)+T2(goal 置顶)前后各跑一次,看 changedFileSetInstability 与各 std 是否下降。');
  // 强制退出:终止后台 detached leader / SessionManager 定时器,避免它们在 db/资源上空转或干扰下一次。
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error('漂移 eval 失败:', error);
    process.exit(1);
  });
}

export { main as runDriftEval };
