/**
 * 漂移度量核心 — 纯函数、确定性、可单测(无 LLM 依赖)。
 *
 * 这是漂移 eval harness 的度量层。把"漂移"从主观感觉变成可计算的数字:
 *  - outOfScopeFiles: 改了任务范围外的文件(scope creep 的直接量化)
 *  - unexpectedChangedFiles: 改了 golden 预期之外的文件
 *  - changedFileSetInstability: 同一任务多次运行,改动文件集合的 Jaccard 距离
 *    (0=每次改一模一样的文件=零漂移; 1=每次改完全不同的文件=最大漂移)
 *  - 跨运行方差: changedFileCount / tokenTotal / durationMs 的 mean/std
 *
 * 全部基于真实信号源(实际改动文件、golden 快照),无启发式/无关键词匹配,
 * 遵循 no-heuristics-deterministic-only 原则。
 */

/** 单次运行的漂移度量快照(从 GitService + Database 真实读回)。 */
export interface DriftRunMetrics {
  runIndex: number;
  passed: boolean;
  changedFiles: string[];
  changedFileCount: number;
  outOfScopeFiles: string[];
  outOfScopeCount: number;
  /** 改了但不在 golden expectedFiles 内的文件(相对 golden 的偏离)。 */
  unexpectedChangedFiles: string[];
  tokenTotal: number;
  durationMs: number;
}

/** 单个数值度量的跨运行分布。 */
export interface MetricVariance {
  mean: number;
  std: number;
  min: number;
  max: number;
}

/** 一个冻结任务的跨运行漂移报告。 */
export interface DriftVarianceReport {
  taskId: string;
  runCount: number;
  passRate: number;
  changedFileCount: MetricVariance;
  outOfScopeCount: MetricVariance;
  tokenTotal: MetricVariance;
  durationMs: MetricVariance;
  /**
   * 改动文件集合的跨运行不稳定度(Jaccard 距离)。
   * 0 = 所有运行改的文件完全一致(零漂移);1 = 各运行改的文件互不相交(最大漂移)。
   * 这是"漂移"最直接的单一数字:同样的任务,agent 每次改的东西越一致越稳定。
   */
  changedFileSetInstability: number;
}

/**
 * 计算路径是否落在允许 scope 内(确定性前缀判定,带分隔符边界)。
 * allowedScope 为空时视为"无 scope 约束"→ 全部视为 in-scope(返回空 outOfScope)。
 */
export function computeOutOfScope(changedFiles: string[], allowedScope: string[]): string[] {
  if (!allowedScope || allowedScope.length === 0) return [];
  const normalizedScopes = allowedScope
    .map((s) => s.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
  if (normalizedScopes.length === 0) return [];
  return changedFiles.filter((file) => {
    const f = file.trim().replace(/\\/g, '/');
    // 必须落在某个 scope 前缀下,且边界是分隔符(防 /foo 命中 /foobar)
    return !normalizedScopes.some((scope) => f === scope || f.startsWith(scope + '/'));
  });
}

/**
 * 计算改了但不在 golden 预期文件集内的文件(相对 golden end-state 的偏离)。
 * expectedFiles 为空时返回空(无 golden 约束)。
 */
export function computeUnexpectedChangedFiles(changedFiles: string[], expectedFiles: string[]): string[] {
  if (!expectedFiles || expectedFiles.length === 0) return [];
  const expected = new Set(expectedFiles.map((f) => f.trim().replace(/\\/g, '/')));
  return changedFiles.filter((f) => !expected.has(f.trim().replace(/\\/g, '/')));
}

function varianceOf(values: number[]): MetricVariance {
  if (values.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * 多个文件集合的 Jaccard 距离:1 - |交集| / |并集|。
 * 用于衡量跨运行"改动范围"的一致性。空集参与时:全空→0(一致),部分空→1(不一致)。
 */
export function jaccardDistance(sets: string[][]): number {
  const nonEmpty = sets.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return 0; // 全空=一致
  if (nonEmpty.length === 1) return 0; // 单运行无比较基准
  const union = new Set<string>();
  let intersection = new Set<string>(nonEmpty[0].map((f) => f.replace(/\\/g, '/')));
  for (const s of nonEmpty) {
    const current = new Set(s.map((f) => f.replace(/\\/g, '/')));
    for (const f of current) union.add(f);
    intersection = new Set([...intersection].filter((f) => current.has(f)));
  }
  if (union.size === 0) return 0;
  return 1 - intersection.size / union.size;
}

/**
 * 把同任务的多次运行度量聚合为漂移方差报告。
 * runCount 越大方差/不稳定度越可信;建议 ≥5。
 */
export function aggregateVariance(taskId: string, runs: DriftRunMetrics[]): DriftVarianceReport {
  const runCount = runs.length;
  const passRate = runCount === 0 ? 0 : runs.filter((r) => r.passed).length / runCount;
  return {
    taskId,
    runCount,
    passRate,
    changedFileCount: varianceOf(runs.map((r) => r.changedFileCount)),
    outOfScopeCount: varianceOf(runs.map((r) => r.outOfScopeCount)),
    tokenTotal: varianceOf(runs.map((r) => r.tokenTotal)),
    durationMs: varianceOf(runs.map((r) => r.durationMs)),
    changedFileSetInstability: jaccardDistance(runs.map((r) => r.changedFiles)),
  };
}

/**
 * 纯函数:从一次运行的产物(改动文件/token/耗时)计算漂移度量快照。
 * DriftEvalRunner 复用它;此处定义保证可单测、无 LLM/Session 依赖。
 * expectedFiles/allowedScope 为空时对应维度返回空(无约束)。
 */
export function buildRunMetricsFromProducts(input: {
  runIndex: number;
  passed: boolean;
  changedFiles: string[];
  tokenTotal: number;
  durationMs: number;
  expectedFiles?: string[];
  allowedScope?: string[];
}): DriftRunMetrics {
  const outOfScopeFiles = computeOutOfScope(input.changedFiles, input.allowedScope ?? []);
  const unexpectedChangedFiles = computeUnexpectedChangedFiles(input.changedFiles, input.expectedFiles ?? []);
  return {
    runIndex: input.runIndex,
    passed: input.passed,
    changedFiles: input.changedFiles,
    changedFileCount: input.changedFiles.length,
    outOfScopeFiles,
    outOfScopeCount: outOfScopeFiles.length,
    unexpectedChangedFiles,
    tokenTotal: input.tokenTotal,
    durationMs: input.durationMs,
  };
}
