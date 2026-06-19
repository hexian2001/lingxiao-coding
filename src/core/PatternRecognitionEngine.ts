/**
 * PatternRecognitionEngine — P3: 失败模式识别引擎。
 *
 * 识别重复失败模式（同文件反复失败、角色频繁超时、循环依赖），
 * 并提供行动建议。纯确定性，无 LLM 调用。
 */

export type PatternType = 'repeated_same_file' | 'role_timeout' | 'circular_dependency';

export interface RecognizedPattern {
  type: PatternType;
  description: string;
  severity: 'warning' | 'critical';
  suggestedAction: string;
  context: Record<string, unknown>;
}

export interface FailureRecord {
  taskId: string;
  errorType: string;
  files?: string[];
  role?: string;
  durationMs?: number;
  timestamp: number;
}

const SAME_FILE_THRESHOLD = 3;
const ROLE_TIMEOUT_THRESHOLD = 2;
const CIRCULAR_DEPENDENCY_THRESHOLD = 2;

export class PatternRecognitionEngine {
  private readonly failures: FailureRecord[] = [];
  private readonly fileFailureCounts = new Map<string, number>();
  private readonly roleTimeoutCounts = new Map<string, number>();
  private readonly taskDependencyCycles = new Map<string, number>();

  recordFailure(record: FailureRecord): void {
    this.failures.push(record);

    // Track file failures
    if (record.files) {
      for (const file of record.files) {
        this.fileFailureCounts.set(file, (this.fileFailureCounts.get(file) ?? 0) + 1);
      }
    }

    // Track role timeouts
    if (record.role && record.errorType === 'timeout') {
      this.roleTimeoutCounts.set(record.role, (this.roleTimeoutCounts.get(record.role) ?? 0) + 1);
    }

    // Track circular dependencies
    if (record.errorType === 'circular_dependency') {
      this.taskDependencyCycles.set(record.taskId, (this.taskDependencyCycles.get(record.taskId) ?? 0) + 1);
    }
  }

  getPatterns(): RecognizedPattern[] {
    const patterns: RecognizedPattern[] = [];

    // Check repeated same file failures
    for (const [file, count] of this.fileFailureCounts) {
      if (count >= SAME_FILE_THRESHOLD) {
        patterns.push({
          type: 'repeated_same_file',
          description: `File "${file}" has caused ${count} failures`,
          severity: count >= SAME_FILE_THRESHOLD * 2 ? 'critical' : 'warning',
          suggestedAction: `Review "${file}" manually — it may have structural issues causing repeated failures`,
          context: { file, failureCount: count },
        });
      }
    }

    // Check role timeouts
    for (const [role, count] of this.roleTimeoutCounts) {
      if (count >= ROLE_TIMEOUT_THRESHOLD) {
        patterns.push({
          type: 'role_timeout',
          description: `Role "${role}" has timed out ${count} times`,
          severity: count >= ROLE_TIMEOUT_THRESHOLD * 2 ? 'critical' : 'warning',
          suggestedAction: `Increase contextBudget for role "${role}" or reduce task scope`,
          context: { role, timeoutCount: count },
        });
      }
    }

    // Check circular dependencies
    for (const [taskId, count] of this.taskDependencyCycles) {
      if (count >= CIRCULAR_DEPENDENCY_THRESHOLD) {
        patterns.push({
          type: 'circular_dependency',
          description: `Task "${taskId}" has hit circular dependency ${count} times`,
          severity: 'critical',
          suggestedAction: `Re-split task "${taskId}" to break the dependency cycle`,
          context: { taskId, cycleCount: count },
        });
      }
    }

    return patterns;
  }

  suggestAction(pattern: RecognizedPattern): string {
    return pattern.suggestedAction;
  }

  clear(): void {
    this.failures.length = 0;
    this.fileFailureCounts.clear();
    this.roleTimeoutCounts.clear();
    this.taskDependencyCycles.clear();
  }
}
