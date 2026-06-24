/**
 * RepairStrategyEngine — 修复策略引擎（轻量版）
 *
 * 替代已移除的 AdaptiveHarness，用更简单直接的方式处理任务失败修复。
 *
 * 核心理念：
 * - 失败不是重试的理由——是分析的起点
 * - 分类错误 → 选择策略 → 执行修复 → 记录模式
 * - 避免对同一根因反复用同一策略
 *
 * 错误分类：
 * - type_error: TypeScript 编译错误（类型不匹配/缺少属性/导入错误）
 * - build_error: 构建失败（模块解析/配置错误）
 * - runtime_error: 运行时崩溃（未处理异常/断言失败/测试失败）
 * - logic_error: 逻辑错误（功能不正确但不崩溃，由验收发现）
 * - timeout: 超时（worker 卡住或任务过大）
 * - dependency_error: 依赖错误（包缺失/版本冲突）
 *
 * 策略：
 * - retry_with_context: 附加错误上下文重试（类型错误、简单构建错误）
 * - narrow_scope: 缩小范围重做（任务过大导致的超时/逻辑错误）
 * - fix_dependencies: 先修依赖再重试（依赖错误）
 * - different_approach: 换方向（同一策略已失败2次）
 * - escalate_to_user: 上报用户（策略耗尽）
 */

import type { SharedLedger } from './SharedLedger.js';

export type ErrorCategory =
  | 'type_error'
  | 'build_error'
  | 'runtime_error'
  | 'logic_error'
  | 'timeout'
  | 'dependency_error'
  | 'unknown';

export type RepairStrategy =
  | 'retry_with_context'
  | 'narrow_scope'
  | 'fix_dependencies'
  | 'different_approach'
  | 'escalate_to_user';

export interface ErrorClassification {
  /** 错误分类 */
  category: ErrorCategory;
  /** 置信度 (0-1) */
  confidence: number;
  /** 分类依据 */
  signals: string[];
  /** 提取的关键错误信息 */
  keyError: string;
  /** 涉及的文件（如果能提取） */
  affectedFiles: string[];
}

export interface RepairDecision {
  /** 选择的策略 */
  strategy: RepairStrategy;
  /** 决策原因 */
  reason: string;
  /** 给 repair worker 的额外指令 */
  instructions: string;
  /** 是否是最终尝试 */
  isFinalAttempt: boolean;
  /** 历史失败次数 */
  priorAttempts: number;
}

export interface FailureRecord {
  taskId: string;
  category: ErrorCategory;
  strategy: RepairStrategy;
  keyError: string;
  timestamp: number;
}

/** 每种错误类型的默认策略优先级 */
const STRATEGY_MAP: Record<ErrorCategory, RepairStrategy[]> = {
  type_error: ['retry_with_context', 'different_approach', 'escalate_to_user'],
  build_error: ['retry_with_context', 'fix_dependencies', 'different_approach', 'escalate_to_user'],
  runtime_error: ['retry_with_context', 'narrow_scope', 'different_approach', 'escalate_to_user'],
  logic_error: ['different_approach', 'narrow_scope', 'escalate_to_user'],
  timeout: ['narrow_scope', 'different_approach', 'escalate_to_user'],
  dependency_error: ['fix_dependencies', 'retry_with_context', 'escalate_to_user'],
  unknown: ['retry_with_context', 'different_approach', 'escalate_to_user'],
};

/** 最大修复尝试次数 */
const MAX_REPAIR_ATTEMPTS = 3;

export class RepairStrategyEngine {
  private failureHistory = new Map<string, FailureRecord[]>();

  constructor(private readonly ledger?: SharedLedger) {}

  /**
   * 分类错误
   */
  classify(errorText: string): ErrorClassification {
    const lower = errorText.toLowerCase();
    const signals: string[] = [];
    let category: ErrorCategory = 'unknown';
    let confidence = 0.5;

    // Type errors
    if (this.matchesTypeError(lower)) {
      category = 'type_error';
      confidence = 0.9;
      signals.push('typescript_diagnostic');
    }
    // Build errors
    else if (this.matchesBuildError(lower)) {
      category = 'build_error';
      confidence = 0.85;
      signals.push('build_system');
    }
    // Dependency errors
    else if (this.matchesDependencyError(lower)) {
      category = 'dependency_error';
      confidence = 0.9;
      signals.push('package_resolution');
    }
    // Runtime errors
    else if (this.matchesRuntimeError(lower)) {
      category = 'runtime_error';
      confidence = 0.8;
      signals.push('runtime_exception');
    }
    // Timeout
    else if (this.matchesTimeout(lower)) {
      category = 'timeout';
      confidence = 0.95;
      signals.push('timeout_signal');
    }
    // Logic errors (验收失败但不崩溃)
    else if (this.matchesLogicError(lower)) {
      category = 'logic_error';
      confidence = 0.7;
      signals.push('acceptance_failure');
    }

    const keyError = this.extractKeyError(errorText);
    const affectedFiles = this.extractFiles(errorText);

    return { category, confidence, signals, keyError, affectedFiles };
  }

  /**
   * 根据错误分类和历史，决定修复策略
   */
  decide(taskId: string, classification: ErrorClassification): RepairDecision {
    const history = this.failureHistory.get(taskId) || [];
    const priorAttempts = history.length;

    // 超过最大修复次数 → 上报
    if (priorAttempts >= MAX_REPAIR_ATTEMPTS) {
      return {
        strategy: 'escalate_to_user',
        reason: `已尝试 ${priorAttempts} 次修复仍失败`,
        instructions: this.buildEscalationInstructions(history),
        isFinalAttempt: true,
        priorAttempts,
      };
    }

    // 检查是否对同一根因重复使用同一策略
    const strategies = STRATEGY_MAP[classification.category];
    const usedStrategies = new Set(
      history
        .filter(r => this.isSameRootCause(r.keyError, classification.keyError))
        .map(r => r.strategy),
    );

    // 选择第一个未用过的策略
    const strategy = strategies.find(s => !usedStrategies.has(s)) || 'escalate_to_user';

    // 记录本次决策
    this.recordFailure(taskId, {
      taskId,
      category: classification.category,
      strategy,
      keyError: classification.keyError,
      timestamp: Date.now(),
    });

    // 同步到 SharedLedger
    if (this.ledger && priorAttempts === 0) {
      this.ledger.append({
        type: 'finding',
        surface: `repair:${taskId}`,
        author: 'repair-engine',
        content: `Task ${taskId} failed: [${classification.category}] ${classification.keyError}`,
        evidence: classification.affectedFiles,
      });
    }

    return {
      strategy,
      reason: this.buildReason(classification, strategy, usedStrategies),
      instructions: this.buildInstructions(strategy, classification),
      isFinalAttempt: priorAttempts === MAX_REPAIR_ATTEMPTS - 1,
      priorAttempts,
    };
  }

  /**
   * 获取任务的修复历史
   */
  getHistory(taskId: string): FailureRecord[] {
    return this.failureHistory.get(taskId) || [];
  }

  /**
   * 清除任务的修复历史（任务成功后调用）
   */
  clearHistory(taskId: string): void {
    this.failureHistory.delete(taskId);
  }

  // ─── 错误匹配器 ───

  private matchesTypeError(text: string): boolean {
    return /ts\(\d+\)|type.*is not assignable|property.*does not exist|cannot find name|has no exported member/i.test(text);
  }

  private matchesBuildError(text: string): boolean {
    return /cannot find module|module not found|syntax error|unexpected token|failed to compile|build failed/i.test(text);
  }

  private matchesDependencyError(text: string): boolean {
    return /enoent.*package\.json|peer dep|could not resolve|no matching version|npm err|yarn error/i.test(text);
  }

  private matchesRuntimeError(text: string): boolean {
    return /uncaught|unhandled|typeerror:|referenceerror:|assertion.*failed|test.*fail|expect.*received/i.test(text);
  }

  private matchesTimeout(text: string): boolean {
    return /timeout|timed out|exceeded.*time|took too long|max.*runtime/i.test(text);
  }

  private matchesLogicError(text: string): boolean {
    return /not.*accepted|verification.*fail|does not meet|criteria.*not.*met|功能不完整|验收.*失败/i.test(text);
  }

  // ─── 辅助方法 ───

  private extractKeyError(text: string): string {
    // 取第一个有意义的错误行
    const lines = text.split('\n').filter(l => l.trim().length > 10);
    const errorLine = lines.find(l =>
      /error|fail|cannot|not found|unexpected/i.test(l),
    ) || lines[0] || text.slice(0, 200);
    return errorLine.trim().slice(0, 200);
  }

  private extractFiles(text: string): string[] {
    const files = new Set<string>();
    // 匹配常见文件路径格式
    const matches = text.matchAll(/(?:^|\s)((?:src|lib|app|pages|components)\/[\w./\-]+\.(?:ts|tsx|js|jsx|vue|svelte))/gm);
    for (const m of matches) {
      files.add(m[1]);
    }
    return [...files].slice(0, 10);
  }

  private isSameRootCause(a: string, b: string): boolean {
    // 简单相似度：共享 50%+ 的词
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 && intersection / union > 0.5;
  }

  private recordFailure(taskId: string, record: FailureRecord): void {
    const history = this.failureHistory.get(taskId) || [];
    history.push(record);
    this.failureHistory.set(taskId, history);
  }

  private buildReason(
    classification: ErrorClassification,
    strategy: RepairStrategy,
    usedStrategies: Set<RepairStrategy>,
  ): string {
    const parts = [`error=${classification.category}`];
    if (usedStrategies.size > 0) {
      parts.push(`tried=[${[...usedStrategies].join(',')}]`);
    }
    parts.push(`next=${strategy}`);
    return parts.join(', ');
  }

  private buildInstructions(strategy: RepairStrategy, classification: ErrorClassification): string {
    switch (strategy) {
      case 'retry_with_context':
        return [
          '修复策略：带上下文重试',
          `错误类型: ${classification.category}`,
          `关键错误: ${classification.keyError}`,
          classification.affectedFiles.length > 0
            ? `涉及文件: ${classification.affectedFiles.join(', ')}`
            : '',
          '请先读取相关文件理解错误原因，再做针对性修复。',
        ].filter(Boolean).join('\n');

      case 'narrow_scope':
        return [
          '修复策略：缩小范围',
          '原任务范围过大导致失败，请：',
          '1. 识别可独立完成的最小子集',
          '2. 先完成核心功能，跳过边缘情况',
          '3. 把剩余部分标记为 TODO 或后续任务',
        ].join('\n');

      case 'fix_dependencies':
        return [
          '修复策略：先修依赖',
          `关键错误: ${classification.keyError}`,
          '请先确保所有依赖正确安装和配置：',
          '1. 检查 package.json / 配置文件',
          '2. 运行 npm install / 安装缺失依赖',
          '3. 确认版本兼容性',
          '4. 然后再继续原任务',
        ].join('\n');

      case 'different_approach':
        return [
          '修复策略：换方向',
          '之前的方法已经失败多次，需要从根本上换一种实现方式：',
          `失败原因: ${classification.keyError}`,
          '请：',
          '1. 分析为什么之前的方法行不通',
          '2. 选择一种完全不同的技术路径',
          '3. 如果原需求不可行，说明原因并提出替代方案',
        ].join('\n');

      case 'escalate_to_user':
        return '修复策略：上报用户。已多次尝试修复仍失败，请将问题详情报告给用户决策。';

      default:
        return '';
    }
  }

  private buildEscalationInstructions(history: FailureRecord[]): string {
    const lines = [
      '## 修复尝试已耗尽',
      '',
      `共尝试 ${history.length} 次修复：`,
    ];
    for (const [i, record] of history.entries()) {
      lines.push(`${i + 1}. [${record.category}] ${record.strategy} — ${record.keyError.slice(0, 80)}`);
    }
    lines.push('', '请报告给用户，由用户决定下一步。');
    return lines.join('\n');
  }
}
