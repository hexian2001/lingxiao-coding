import type { Task } from './TaskBoard.js';

export type TaskType =
  | 'bug_critical'
  | 'bug'
  | 'security'
  | 'feature'
  | 'tech_debt'
  | 'test'
  | 'docs'
  | 'refactor'
  | 'unknown';

export type TypeWeightMap = Record<TaskType, number>;

export interface TaskScore {
  taskId: string;
  score: number;
  breakdown: {
    typeWeight: number;
    urgencyMultiplier: number;
    ageFactor: number;
    depthBonus: number;
    contractReady: number;
  };
}

export interface ScoredTask {
  task: Task;
  scoring: TaskScore;
}

export const DEFAULT_TYPE_WEIGHTS: TypeWeightMap = {
  bug_critical: 100,
  bug: 80,
  security: 90,
  feature: 50,
  tech_debt: 30,
  test: 25,
  docs: 10,
  refactor: 40,
  unknown: 20,
};

const TASK_TYPES = new Set<TaskType>(Object.keys(DEFAULT_TYPE_WEIGHTS) as TaskType[]);

type TaskSignals = Task & {
  metadata?: Record<string, unknown>;
  tags?: string[];
  type?: string;
  urgent?: boolean;
  createdAt?: number;
  contractReady?: boolean;
};

function asSignals(task: Task): TaskSignals {
  return task as TaskSignals;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeTimestampMs(value: unknown, now: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : now;
  if (numeric <= 0) return now;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

export class TaskPriorityEngine {
  private weights: TypeWeightMap;

  constructor(weights: Partial<TypeWeightMap> = {}) {
    this.weights = { ...DEFAULT_TYPE_WEIGHTS, ...weights };
  }

  scoreTasks(tasks: Task[], now = Date.now()): ScoredTask[] {
    const blockedByCount = new Map<string, number>();
    for (const task of tasks) {
      for (const depId of task.blocked_by ?? []) {
        blockedByCount.set(depId, (blockedByCount.get(depId) ?? 0) + 1);
      }
    }

    return tasks
      .map((task) => {
        const type = this.inferType(task);
        const typeWeight = this.weights[type] ?? this.weights.unknown;
        const dependents = blockedByCount.get(task.id) ?? 0;
        const urgencyMultiplier = this.urgencyMultiplier(task, dependents);
        const ageFactor = this.ageFactor(task, now);
        const depthBonus = dependents * 0.3;
        const contractReady = this.contractReady(task);
        const score = typeWeight * urgencyMultiplier * ageFactor * (1 + depthBonus) * contractReady;
        return {
          task,
          scoring: {
            taskId: task.id,
            score,
            breakdown: {
              typeWeight,
              urgencyMultiplier,
              ageFactor,
              depthBonus,
              contractReady,
            },
          },
        };
      })
      .sort((a, b) => {
        if (b.scoring.score !== a.scoring.score) return b.scoring.score - a.scoring.score;
        return a.task.id.localeCompare(b.task.id);
      });
  }

  topCandidates(tasks: Task[], k: number): ScoredTask[] {
    if (k <= 0) return [];
    return this.scoreTasks(tasks).slice(0, Math.floor(k));
  }

  reconfigure(weights: Partial<TypeWeightMap>): void {
    this.weights = { ...this.weights, ...weights };
  }

  private inferType(task: Task): TaskType {
    const t = asSignals(task);
    const metadataType = t.metadata?.type;
    if (typeof metadataType === 'string' && TASK_TYPES.has(metadataType as TaskType)) {
      return metadataType as TaskType;
    }
    if (typeof t.type === 'string' && TASK_TYPES.has(t.type as TaskType)) {
      return t.type as TaskType;
    }
    for (const tag of t.tags ?? []) {
      if (TASK_TYPES.has(tag as TaskType)) return tag as TaskType;
    }
    if (task.taskType === 'generic') return 'unknown';
    if (task.taskType === 'explore') return 'feature';
    return 'unknown';
  }

  private urgencyMultiplier(task: Task, dependents: number): number {
    const t = asSignals(task);
    const urgent = readBoolean(t.urgent) ?? readBoolean(t.metadata?.urgent) ?? false;
    if (urgent) return 3.0;
    if (dependents > 0) return 2.0;
    return 1.0;
  }

  private ageFactor(task: Task, now: number): number {
    const t = asSignals(task);
    const createdMs = normalizeTimestampMs(t.createdAt ?? task.created_at, now);
    const hoursOld = Math.max(0, (now - createdMs) / 3_600_000);
    return 1 + Math.log(1 + hoursOld / 24);
  }

  private contractReady(task: Task): number {
    const t = asSignals(task);
    const explicit = readBoolean(t.contractReady) ?? readBoolean(t.metadata?.contractReady);
    if (explicit !== null) return explicit ? 1.0 : 0.1;
    const binding = task.orchestration?.contractBinding;
    if (!binding || (!binding.requireAck && !binding.requireContract)) return 1.0;
    const status = task.orchestration?.acceptance?.status;
    return status === 'passed' ? 1.0 : 0.1;
  }
}
