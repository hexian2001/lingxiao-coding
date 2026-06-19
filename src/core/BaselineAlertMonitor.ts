/**
 * BaselineAlertMonitor — P2: 执行指标偏离检测与告警。
 *
 * 对比当前执行指标与基线，检测偏离并通过 EventEmitter 发送告警事件。
 * 告警条件：
 *   - 执行时间 > baseline.p90Duration * 1.5 → slow_execution
 *   - token 消耗 > baseline.avgTokens * 2 → token_bloat
 *   - 成功率连续 3 次低于 baseline.successRate * 0.5 → success_rate_drop
 */

import { EventEmitter } from 'node:events';
import type { ExecutionMetric, Baseline } from './PerformanceBaselineTracker.js';

export interface DeviationAlert {
  type: 'slow_execution' | 'token_bloat' | 'success_rate_drop';
  taskType: string;
  role: string;
  currentValue: number;
  baselineValue: number;
  message: string;
}

const SLOW_EXECUTION_FACTOR = 1.5;
const TOKEN_BLOAT_FACTOR = 2.0;
const SUCCESS_RATE_DROP_FACTOR = 0.5;
const SUCCESS_RATE_CONSECUTIVE_THRESHOLD = 3;

export class BaselineAlertMonitor extends EventEmitter {
  private readonly recentResults = new Map<string, boolean[]>();

  checkDeviation(metric: ExecutionMetric, baseline: Baseline): DeviationAlert | null {
    const key = `${metric.taskType}:${metric.role}`;

    // Check slow execution
    if (metric.durationMs > baseline.p90Duration * SLOW_EXECUTION_FACTOR) {
      return {
        type: 'slow_execution',
        taskType: metric.taskType,
        role: metric.role,
        currentValue: metric.durationMs,
        baselineValue: baseline.p90Duration,
        message: `Execution ${metric.durationMs}ms > baseline p90 ${baseline.p90Duration}ms × ${SLOW_EXECUTION_FACTOR}`,
      };
    }

    // Check token bloat
    if (metric.tokenUsage > baseline.avgTokens * TOKEN_BLOAT_FACTOR) {
      return {
        type: 'token_bloat',
        taskType: metric.taskType,
        role: metric.role,
        currentValue: metric.tokenUsage,
        baselineValue: baseline.avgTokens,
        message: `Token usage ${metric.tokenUsage} > baseline avg ${Math.round(baseline.avgTokens)} × ${TOKEN_BLOAT_FACTOR}`,
      };
    }

    // Check success rate drop (consecutive)
    const results = this.recentResults.get(key) ?? [];
    results.push(metric.success);
    if (results.length > SUCCESS_RATE_CONSECUTIVE_THRESHOLD) results.shift();
    this.recentResults.set(key, results);

    if (results.length >= SUCCESS_RATE_CONSECUTIVE_THRESHOLD) {
      const recentSuccessRate = results.filter(Boolean).length / results.length;
      if (recentSuccessRate < baseline.successRate * SUCCESS_RATE_DROP_FACTOR) {
        return {
          type: 'success_rate_drop',
          taskType: metric.taskType,
          role: metric.role,
          currentValue: recentSuccessRate,
          baselineValue: baseline.successRate,
          message: `Success rate ${recentSuccessRate.toFixed(2)} < baseline ${baseline.successRate.toFixed(2)} × ${SUCCESS_RATE_DROP_FACTOR} for ${SUCCESS_RATE_CONSECUTIVE_THRESHOLD} consecutive tasks`,
        };
      }
    }

    return null;
  }

  emitAlert(alert: DeviationAlert): void {
    this.emit('eternal:baseline_alert', alert);
  }
}
