export type EternalAction = 'patrol' | 'skip' | 'yield_user';

export interface EternalPatrolJudgeInput {
  eternalGoal?: string | null;
  fingerprintDiff: string;
  fingerprintChanged: boolean;
  lastPatrolOutcome: 'productive' | 'idle' | 'never';
  recentConversationDigest: string;
  hasOpenWork: boolean;
  hasRunningAgents: boolean;
  llm?: unknown;
  model?: string;
  consecutiveIdlePatrols: number;
}

export interface EternalPatrolVerdict {
  action: EternalAction;
  reason: string;
}

export function decideEternalActionFromRuntimeState(input: EternalPatrolJudgeInput): EternalPatrolVerdict {
  if (input.eternalGoal && input.eternalGoal.trim()) {
    return {
      action: 'patrol',
      reason: input.fingerprintChanged
        ? 'runtime: active eternal goal with changed fingerprint'
        : 'runtime: active eternal goal needs continued stewardship',
    };
  }
  if (!input.fingerprintChanged) {
    if (
      !input.hasOpenWork &&
      !input.hasRunningAgents &&
      input.lastPatrolOutcome !== 'productive' &&
      input.consecutiveIdlePatrols >= 1
    ) {
      return {
        action: 'yield_user',
        reason: 'runtime: no project delta, no open work, idle patrol already attempted',
      };
    }
    return {
      action: 'skip',
      reason: 'runtime: no meaningful project delta',
    };
  }
  return {
    action: 'patrol',
    reason: 'runtime: fingerprint changed',
  };
}

// P1-P3: Eternal Loop 智能化集成模块
import { PerformanceBaselineTracker, type ExecutionMetric } from '../../core/PerformanceBaselineTracker.js';
import { BaselineAlertMonitor, type DeviationAlert } from '../../core/BaselineAlertMonitor.js';
import { PatternRecognitionEngine, type RecognizedPattern, type FailureRecord } from '../../core/PatternRecognitionEngine.js';

/**
 * EternalLoopIntelligence — 组合 P1/P2/P3 三个模块，
 * 提供 Eternal Loop 巡逻时的性能追踪、偏离告警和失败模式识别。
 */
export class EternalLoopIntelligence {
  readonly baselineTracker = new PerformanceBaselineTracker();
  readonly alertMonitor = new BaselineAlertMonitor();
  readonly patternEngine = new PatternRecognitionEngine();

  /**
   * 记录一次执行并检查偏离。
   * 在 Eternal Loop 每轮巡逻时调用。
   */
  recordAndCheck(metric: ExecutionMetric): DeviationAlert | null {
    this.baselineTracker.recordExecution(metric);

    const baseline = this.baselineTracker.getBaseline(metric.taskType, metric.role);
    if (!baseline) return null;

    const alert = this.alertMonitor.checkDeviation(metric, baseline);
    if (alert) {
      this.alertMonitor.emitAlert(alert);
    }
    return alert;
  }

  /**
   * 记录失败并获取模式。
   * 在任务失败时调用。
   */
  recordFailureAndAnalyze(record: FailureRecord): RecognizedPattern[] {
    this.patternEngine.recordFailure(record);
    return this.patternEngine.getPatterns();
  }

  /**
   * 获取当前所有已识别的模式和建议。
   */
  getActivePatterns(): RecognizedPattern[] {
    return this.patternEngine.getPatterns();
  }

  /**
   * 获取告警事件流（供 SSE watchdogAlert 传播）。
   */
  onAlert(handler: (alert: DeviationAlert) => void): void {
    this.alertMonitor.on('eternal:baseline_alert', handler);
  }
}
