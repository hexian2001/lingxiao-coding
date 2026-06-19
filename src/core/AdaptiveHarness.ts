import { isAbsolute, relative, resolve } from 'node:path';
import type { ProjectExecutionModel, ProjectHotspot } from './ExecutionTraceMemory.js';
import type { OrchestrationTaskMetadata } from './OrchestrationTypes.js';
import type { Task } from './TaskBoard.js';

export type ExecutionStrategy = 'fast_path' | 'standard' | 'careful' | 'speculative' | 'deep' | 'adaptive';

export interface TaskDifficultySignals {
  writeScope: number;
  impactRatio: number;
  hotspotOverlap: number;
  crossModuleDeps: number;
  priorFailures: number;
  hasAmbiguousPath: boolean;
  dependencyCount: number;
  runGeneration: number;
  /** P1: Total project files for impact ratio context */
  totalProjectFiles?: number;
}

export interface StrategyParams {
  maxRounds: number;
  timeoutMs: number;
  workerCount: number;
  verificationLevel: 'minimal' | 'standard' | 'adversarial';
  assumptionTracking: boolean;
  speculationEnabled: boolean;
}

export interface AdaptiveStrategyRule {
  id: string;
  priority: number;
  strategy: ExecutionStrategy;
  matches: (signals: TaskDifficultySignals) => boolean;
}

export interface AdaptiveStrategyDecision {
  strategy: ExecutionStrategy;
  ruleId: string;
  priority: number;
  /** P3: Suggested context token budget for this strategy */
  suggestedContextBudget?: number;
}

export interface AdaptiveStrategyPlan {
  taskId: string;
  strategy: ExecutionStrategy;
  ruleId: string;
  signals: TaskDifficultySignals;
  params: StrategyParams;
}

export type EscalationTrigger =
  | { type: 'build_errors_exceeded'; count: number }
  | { type: 'repair_attempts_exceeded'; count: number }
  | { type: 'timeout_approaching'; remainingMs: number }
  | { type: 'speculation_all_failed' };

export interface AdaptiveHarnessConfig {
  totalProjectFiles?: number;
  params?: Partial<Record<ExecutionStrategy, Partial<StrategyParams>>>;
  rules?: AdaptiveStrategyRule[];
}

export interface AdaptiveHarnessTask {
  id: string;
  subject?: string;
  description?: string;
  context?: string;
  working_directory?: string;
  write_scope?: string[];
  blocked_by?: string[];
  blocks?: string[];
  runGeneration?: number;
  taskType?: string;
  agent_type?: string;
  orchestration?: OrchestrationTaskMetadata;
}

export const DEFAULT_PARAMS: Record<ExecutionStrategy, StrategyParams> = {
  fast_path: {
    maxRounds: 20,
    timeoutMs: 15 * 60 * 1000,
    workerCount: 1,
    verificationLevel: 'minimal',
    assumptionTracking: false,
    speculationEnabled: false,
  },
  standard: {
    maxRounds: 15,
    timeoutMs: 15 * 60 * 1000,
    workerCount: 1,
    verificationLevel: 'standard',
    assumptionTracking: false,
    speculationEnabled: false,
  },
  careful: {
    maxRounds: 25,
    timeoutMs: 30 * 60 * 1000,
    workerCount: 1,
    verificationLevel: 'adversarial',
    assumptionTracking: true,
    speculationEnabled: false,
  },
  speculative: {
    maxRounds: 15,
    timeoutMs: 30 * 60 * 1000,
    workerCount: 3,
    verificationLevel: 'standard',
    assumptionTracking: true,
    speculationEnabled: true,
  },
  deep: {
    maxRounds: 40,
    timeoutMs: 60 * 60 * 1000,
    workerCount: 1,
    verificationLevel: 'adversarial',
    assumptionTracking: true,
    speculationEnabled: false,
  },
  adaptive: {
    maxRounds: 30,
    timeoutMs: 45 * 60 * 1000,
    workerCount: 2,
    verificationLevel: 'standard',
    assumptionTracking: true,
    speculationEnabled: false,
  },
};

export const DEFAULT_RULES: AdaptiveStrategyRule[] = [
  {
    id: 'deep_large_scope_or_impact_or_dependencies',
    priority: 100,
    strategy: 'deep',
    matches: (signals) => signals.writeScope > 10 || signals.impactRatio > 0.3 || signals.crossModuleDeps > 5,
  },
  {
    id: 'speculative_explicit_ambiguity_or_repeated_failures',
    priority: 90,
    strategy: 'speculative',
    matches: (signals) => signals.hasAmbiguousPath || (signals.priorFailures >= 2 && signals.writeScope <= 10),
  },
  {
    id: 'careful_hotspot_or_prior_failure',
    priority: 80,
    strategy: 'careful',
    matches: (signals) => signals.hotspotOverlap > 0 || signals.priorFailures > 0,
  },
  {
    id: 'fast_path_small_scope_clean_history',
    priority: 70,
    strategy: 'fast_path',
    matches: (signals) => signals.writeScope <= 2 && signals.impactRatio <= 0.05 && signals.priorFailures === 0,
  },
  {
    id: 'standard_bounded_scope_and_impact',
    priority: 60,
    strategy: 'standard',
    matches: (signals) => signals.writeScope <= 5 && signals.impactRatio <= 0.15,
  },
  {
    id: 'adaptive_cross_deps_with_prior_failures',
    priority: 85,
    strategy: 'adaptive',
    matches: (signals) => signals.crossModuleDeps > 2 && signals.priorFailures >= 1,
  },
  {
    id: 'fallback_always_matches',
    priority: 10,
    strategy: 'standard',
    matches: () => true,
  },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : undefined;
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.floor(raw));
}

function normalizeRatio(value: unknown): number | undefined {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : undefined;
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return Math.max(0, raw);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

function uniqueStrings(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeProjectFile(projectRoot: string, file: string): string {
  const trimmed = file.trim();
  if (!trimmed) return '';
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed);
  const rel = relative(projectRoot, absolute).replace(/\\/g, '/');
  return rel.startsWith('..') ? trimmed.replace(/\\/g, '/') : rel;
}

function matchesScope(file: string, scopes: string[]): boolean {
  if (scopes.length === 0) return false;
  for (const scope of scopes) {
    const normalizedScope = scope.replace(/\/+$/, '');
    if (file === normalizedScope || file.startsWith(`${normalizedScope}/`)) return true;
  }
  return false;
}

function extractAdaptivePolicy(orchestration?: OrchestrationTaskMetadata): Record<string, unknown> {
  const orchestrationRecord = asRecord(orchestration);
  const evaluationPolicy = asRecord(orchestration?.evaluationPolicy);
  const evaluationAdaptive = asRecord(evaluationPolicy?.adaptive);
  const orchestrationAdaptive = asRecord(orchestrationRecord?.adaptive);
  const difficultySignals = asRecord(evaluationAdaptive?.difficultySignals ?? evaluationAdaptive?.difficulty_signals)
    ?? asRecord(orchestrationAdaptive?.difficultySignals ?? orchestrationAdaptive?.difficulty_signals);
  return {
    ...(evaluationAdaptive ?? {}),
    ...(orchestrationAdaptive ?? {}),
    ...(difficultySignals ?? {}),
  };
}

function readNumber(policy: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = normalizeRatio(policy[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readInteger(policy: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = normalizeNonNegativeInteger(policy[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readBoolean(policy: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = normalizeBoolean(policy[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function countStructuredAlternatives(orchestration?: OrchestrationTaskMetadata): number {
  const evaluationPolicy = asRecord(orchestration?.evaluationPolicy);
  const evaluationSpeculation = asRecord(evaluationPolicy?.speculation);
  const orchestrationSpeculation = asRecord(orchestration?.speculation);
  const alternatives =
    evaluationSpeculation?.alternatives
    ?? evaluationPolicy?.alternatives
    ?? orchestrationSpeculation?.alternatives;
  return Array.isArray(alternatives) ? alternatives.length : 0;
}

function getTaskType(task: AdaptiveHarnessTask): string {
  return task.taskType || task.agent_type || 'unknown';
}

export class AdaptiveHarness {
  private readonly rules: AdaptiveStrategyRule[];
  private readonly params: Record<ExecutionStrategy, StrategyParams>;

  constructor(private readonly config: AdaptiveHarnessConfig = {}) {
    this.rules = [...(config.rules ?? DEFAULT_RULES)].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    this.params = {
      fast_path: { ...DEFAULT_PARAMS.fast_path, ...(config.params?.fast_path ?? {}) },
      standard: { ...DEFAULT_PARAMS.standard, ...(config.params?.standard ?? {}) },
      careful: { ...DEFAULT_PARAMS.careful, ...(config.params?.careful ?? {}) },
      speculative: { ...DEFAULT_PARAMS.speculative, ...(config.params?.speculative ?? {}) },
      deep: { ...DEFAULT_PARAMS.deep, ...(config.params?.deep ?? {}) },
      adaptive: { ...DEFAULT_PARAMS.adaptive, ...(config.params?.adaptive ?? {}) },
    };
  }

  assessDifficulty(input: {
    task: AdaptiveHarnessTask | Task;
    projectModel?: ProjectExecutionModel;
    totalProjectFiles?: number;
  }): TaskDifficultySignals {
    const task = input.task;
    const projectRoot = input.projectModel?.projectRoot || task.working_directory || process.cwd();
    const writeScopeFiles = uniqueStrings(task.write_scope).map((file) => normalizeProjectFile(projectRoot, file));
    const policy = extractAdaptivePolicy(task.orchestration);
    const dependencyCount = uniqueStrings([...(task.blocked_by ?? []), ...(task.blocks ?? [])]).length;
    const runGeneration = Math.max(
      normalizeNonNegativeInteger(task.runGeneration) ?? 0,
      normalizeNonNegativeInteger(task.orchestration?.generation) ?? 0,
    );
    const scopedHotspots = this.scopedHotspots(input.projectModel, writeScopeFiles);
    const recordedFailures = scopedHotspots.reduce((sum, hotspot) => sum + hotspot.failures, 0);
    const taskTypeFailures = input.projectModel?.taskTypeSuccessRates
      .filter((rate) => rate.taskType === getTaskType(task))
      .reduce((sum, rate) => sum + rate.failures, 0) ?? 0;
    const explicitPriorFailures = readInteger(policy, 'priorFailures', 'prior_failures');
    const totalProjectFiles = input.totalProjectFiles ?? this.config.totalProjectFiles;
    const explicitImpactRatio = readNumber(policy, 'impactRatio', 'impact_ratio');
    const computedImpactRatio = totalProjectFiles && totalProjectFiles > 0
      ? writeScopeFiles.length / totalProjectFiles
      : 0;
    const explicitAmbiguity = readBoolean(policy, 'hasAmbiguousPath', 'has_ambiguous_path', 'ambiguous');

    return {
      writeScope: writeScopeFiles.length,
      impactRatio: explicitImpactRatio ?? computedImpactRatio,
      hotspotOverlap: Math.max(
        readInteger(policy, 'hotspotOverlap', 'hotspot_overlap') ?? 0,
        scopedHotspots.length,
      ),
      crossModuleDeps: readInteger(policy, 'crossModuleDeps', 'cross_module_deps') ?? dependencyCount,
      priorFailures: Math.max(
        explicitPriorFailures ?? 0,
        recordedFailures,
        taskTypeFailures,
      ),
      hasAmbiguousPath: explicitAmbiguity ?? countStructuredAlternatives(task.orchestration) > 1,
      dependencyCount,
      runGeneration,
      totalProjectFiles,
    };
  }

  selectStrategy(signals: TaskDifficultySignals): ExecutionStrategy {
    return this.selectStrategyDecision(signals).strategy;
  }

  selectStrategyDecision(signals: TaskDifficultySignals): AdaptiveStrategyDecision {
    for (const rule of this.rules) {
      if (rule.matches(signals)) {
        const suggestedContextBudget = rule.strategy === 'deep'
          ? 300_000
          : rule.strategy === 'adaptive'
            ? 250_000
            : undefined;
        return {
          strategy: rule.strategy,
          ruleId: rule.id,
          priority: rule.priority,
          suggestedContextBudget,
        };
      }
    }
    // P2: fallback rule (priority=10, matches=()=>true) ensures this is unreachable,
    // but keep as defensive default.
    return {
      strategy: 'standard',
      ruleId: 'standard_default',
      priority: 0,
    };
  }

  getStrategyParams(strategy: ExecutionStrategy): StrategyParams {
    return { ...this.params[strategy] };
  }

  buildPlan(input: {
    task: AdaptiveHarnessTask | Task;
    projectModel?: ProjectExecutionModel;
    totalProjectFiles?: number;
  }): AdaptiveStrategyPlan {
    const signals = this.assessDifficulty(input);
    const decision = this.selectStrategyDecision(signals);
    return {
      taskId: input.task.id,
      strategy: decision.strategy,
      ruleId: decision.ruleId,
      signals,
      params: this.getStrategyParams(decision.strategy),
    };
  }

  escalate(current: ExecutionStrategy, trigger: EscalationTrigger): ExecutionStrategy | null {
    if (current === 'deep') return null;
    if (trigger.type === 'build_errors_exceeded') {
      if (current === 'fast_path' && trigger.count >= 1) return 'standard';
      if (current === 'standard' && trigger.count > 3) return 'careful';
      return null;
    }
    if (trigger.type === 'repair_attempts_exceeded') {
      if (current === 'standard' && trigger.count >= 1) return 'careful';
      if (current === 'careful' && trigger.count >= 2) return 'speculative';
      return null;
    }
    if (trigger.type === 'speculation_all_failed') {
      return current === 'speculative' ? 'deep' : null;
    }
    return null;
  }

  private scopedHotspots(model: ProjectExecutionModel | undefined, scopes: string[]): ProjectHotspot[] {
    if (!model || scopes.length === 0) return [];
    return model.hotspots.filter((hotspot) => {
      if (hotspot.failures <= 0 && hotspot.failureRate <= 0) return false;
      return matchesScope(hotspot.file, scopes);
    });
  }
}

export function renderAdaptiveStrategyPlan(plan: AdaptiveStrategyPlan | undefined): string {
  if (!plan) return '';
  return [
    '### Adaptive Execution Strategy (deterministic)',
    JSON.stringify(plan, null, 2),
  ].join('\n');
}
