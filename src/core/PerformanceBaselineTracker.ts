/**
 * PerformanceBaselineTracker — P1: Agent 执行性能基线追踪。
 *
 * 追踪 agent 执行性能（任务耗时、token 消耗、成功率/失败率），
 * 按 task_type/role 维度聚合。内存滑动窗口（最近 100 次执行），无持久化。
 */

export interface ExecutionMetric {
  taskType: string;
  role: string;
  durationMs: number;
  tokenUsage: number;
  success: boolean;
  timestamp: number;
}

export interface Baseline {
  p50Duration: number;
  p90Duration: number;
  avgTokens: number;
  successRate: number;
  sampleCount: number;
}

const MAX_SAMPLES = 100;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export class PerformanceBaselineTracker {
  private readonly samples = new Map<string, ExecutionMetric[]>();

  recordExecution(metric: ExecutionMetric): void {
    const key = `${metric.taskType}:${metric.role}`;
    const list = this.samples.get(key) ?? [];
    list.push(metric);
    if (list.length > MAX_SAMPLES) list.shift();
    this.samples.set(key, list);
  }

  getBaseline(taskType: string, role?: string): Baseline | null {
    const key = role ? `${taskType}:${role}` : this.findKey(taskType);
    const list = this.samples.get(key);
    if (!list || list.length < 3) return null;

    const durations = list.map((m) => m.durationMs).sort((a, b) => a - b);
    const tokens = list.map((m) => m.tokenUsage);
    const successes = list.filter((m) => m.success).length;

    return {
      p50Duration: percentile(durations, 0.5),
      p90Duration: percentile(durations, 0.9),
      avgTokens: tokens.reduce((sum, t) => sum + t, 0) / tokens.length,
      successRate: successes / list.length,
      sampleCount: list.length,
    };
  }

  private findKey(taskType: string): string {
    for (const key of this.samples.keys()) {
      if (key.startsWith(`${taskType}:`)) return key;
    }
    return taskType;
  }
}
