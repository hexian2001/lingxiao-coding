import { resolve } from 'node:path';
import type { ProjectHotspot, FixPatternSummary, TimingBaseline, TaskTypeSuccessRate } from './ExecutionTraceMemory.js';
import type { OrchestrationTaskMetadata } from './OrchestrationTypes.js';
import type { SpeculativeBranchPlan, SpeculativeSelectionPolicy } from './SpeculativeExecutionController.js';

export type SpeculativeTriggerReason =
  | 'explicit_policy'
  | 'retry_generation'
  | 'orchestration_generation'
  | 'trace_hotspot'
  | 'structured_alternatives';

export interface SpeculativePlanningTask {
  id: string;
  working_directory?: string;
  write_scope?: string[];
  runGeneration?: number;
  orchestration?: OrchestrationTaskMetadata;
}

export interface SpeculativeProjectEvidence {
  hotspots: ProjectHotspot[];
  fixPatterns: FixPatternSummary[];
  timingBaselines: TimingBaseline[];
  taskTypeSuccessRates: TaskTypeSuccessRate[];
}

export interface SpeculativeOrchestrationPlan {
  taskId: string;
  reasons: SpeculativeTriggerReason[];
  selectionPolicy: SpeculativeSelectionPolicy;
  timeoutMs?: number;
  maxBranches: number;
  executable: boolean;
  blockedReasons: string[];
  branches: SpeculativeBranchPlan[];
  evidence: {
    hotspotFiles: string[];
    fixPatterns: Array<{ errorSignature: string; fixPattern: string }>;
  };
}

const DEFAULT_MAX_BRANCHES = 3;
const MAX_BRANCHES_LIMIT = 6;
const VALID_SELECTION_POLICIES = new Set<SpeculativeSelectionPolicy>([
  'first_green',
  'fewest_changes',
  'fastest_tests',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : undefined;
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  const normalized = Math.floor(raw);
  return normalized > 0 ? normalized : undefined;
}

function normalizeSelectionPolicy(value: unknown): SpeculativeSelectionPolicy | undefined {
  const normalized = normalizeString(value);
  return normalized && VALID_SELECTION_POLICIES.has(normalized as SpeculativeSelectionPolicy)
    ? normalized as SpeculativeSelectionPolicy
    : undefined;
}

function getSpeculationPolicy(task: SpeculativePlanningTask): Record<string, unknown> | undefined {
  const orchestrationSpeculation = asRecord((task.orchestration as { speculation?: unknown } | undefined)?.speculation);
  const evaluationPolicy = asRecord(task.orchestration?.evaluationPolicy);
  const evaluationSpeculation = asRecord(evaluationPolicy?.speculation);
  if (!orchestrationSpeculation && !evaluationSpeculation && !evaluationPolicy?.alternatives) {
    return undefined;
  }
  return {
    ...(evaluationSpeculation ?? {}),
    ...(evaluationPolicy?.alternatives !== undefined ? { alternatives: evaluationPolicy.alternatives } : {}),
    ...(orchestrationSpeculation ?? {}),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeBranchAlternatives(input: {
  task: SpeculativePlanningTask;
  policy: Record<string, unknown> | undefined;
  maxBranches: number;
}): { branches: SpeculativeBranchPlan[]; blockedReasons: string[]; hasStructuredAlternatives: boolean } {
  const rawAlternatives = input.policy?.alternatives;
  if (rawAlternatives === undefined) {
    return { branches: [], blockedReasons: [], hasStructuredAlternatives: false };
  }
  if (!Array.isArray(rawAlternatives)) {
    return {
      branches: [],
      blockedReasons: ['speculation alternatives must be an array'],
      hasStructuredAlternatives: false,
    };
  }

  const branches: SpeculativeBranchPlan[] = [];
  const blockedReasons: string[] = [];
  rawAlternatives.slice(0, input.maxBranches).forEach((value, index) => {
    const alternative = asRecord(value);
    if (!alternative) {
      blockedReasons.push(`alternative[${index}] must be an object`);
      return;
    }
    const id = normalizeString(alternative.id ?? alternative.name);
    if (!id) {
      blockedReasons.push(`alternative[${index}] requires stable id`);
      return;
    }
    const workingDir = normalizeString(alternative.workingDir ?? alternative.working_directory)
      ?? input.task.working_directory
      ?? process.cwd();
    const writeScope = normalizeStringArray(alternative.writeScope ?? alternative.write_scope);
    const strategyPrompt = normalizeString(alternative.strategyPrompt ?? alternative.strategy_prompt ?? alternative.prompt);
    const label = normalizeString(alternative.label ?? alternative.title);
    branches.push({
      id,
      label,
      workingDir: resolve(workingDir),
      changedFiles: writeScope.length > 0 ? writeScope : input.task.write_scope ?? [],
      metadata: {
        source: 'structured_alternative',
        alternativeIndex: index,
        ...(label ? { label } : {}),
        ...(strategyPrompt ? { strategyPrompt } : {}),
        explicitWorkingDir: Boolean(normalizeString(alternative.workingDir ?? alternative.working_directory)),
      },
    });
  });

  return { branches, blockedReasons, hasStructuredAlternatives: branches.length > 0 };
}

function hasDuplicateWorkingDir(branches: SpeculativeBranchPlan[]): boolean {
  const seen = new Set<string>();
  for (const branch of branches) {
    const key = resolve(branch.workingDir);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function allBranchesHaveExplicitWorkingDir(branches: SpeculativeBranchPlan[]): boolean {
  return branches.every((branch) => Boolean((branch.metadata as { explicitWorkingDir?: unknown } | undefined)?.explicitWorkingDir));
}

export function buildSpeculativeOrchestrationPlan(input: {
  task: SpeculativePlanningTask;
  projectEvidence?: SpeculativeProjectEvidence;
}): SpeculativeOrchestrationPlan | undefined {
  const policy = getSpeculationPolicy(input.task);
  if (policy?.enabled === false) return undefined;

  const reasons: SpeculativeTriggerReason[] = [];
  if (policy?.enabled === true) reasons.push('explicit_policy');
  if ((input.task.runGeneration ?? 0) > 0) reasons.push('retry_generation');
  if ((input.task.orchestration?.generation ?? 0) > 0) reasons.push('orchestration_generation');
  if ((input.projectEvidence?.hotspots.length ?? 0) > 0) reasons.push('trace_hotspot');

  const maxBranches = Math.min(
    MAX_BRANCHES_LIMIT,
    normalizePositiveInteger(policy?.maxBranches ?? policy?.max_branches) ?? DEFAULT_MAX_BRANCHES,
  );
  const alternativeResult = normalizeBranchAlternatives({
    task: input.task,
    policy,
    maxBranches,
  });
  if (alternativeResult.hasStructuredAlternatives) reasons.push('structured_alternatives');

  const uniqueReasons = Array.from(new Set(reasons));
  if (uniqueReasons.length === 0 && alternativeResult.blockedReasons.length === 0) {
    return undefined;
  }

  const blockedReasons = [...alternativeResult.blockedReasons];
  if (uniqueReasons.length > 0 && alternativeResult.branches.length === 0) {
    blockedReasons.push('speculation trigger present but no structured alternatives were provided');
  }
  if (alternativeResult.branches.length > 1 && hasDuplicateWorkingDir(alternativeResult.branches)) {
    blockedReasons.push('speculative alternatives must use unique workingDir values');
  }
  if (alternativeResult.branches.length > 1 && !allBranchesHaveExplicitWorkingDir(alternativeResult.branches)) {
    blockedReasons.push('multi-branch speculation requires explicit isolated workingDir for every branch');
  }

  const executable = alternativeResult.branches.length > 1 && blockedReasons.length === 0;
  return {
    taskId: input.task.id,
    reasons: uniqueReasons,
    selectionPolicy: normalizeSelectionPolicy(policy?.selectionPolicy ?? policy?.selection_policy) ?? 'first_green',
    timeoutMs: normalizePositiveInteger(policy?.timeoutMs ?? policy?.timeout_ms),
    maxBranches,
    executable,
    blockedReasons,
    branches: alternativeResult.branches,
    evidence: {
      hotspotFiles: (input.projectEvidence?.hotspots ?? []).map((hotspot) => hotspot.file),
      fixPatterns: (input.projectEvidence?.fixPatterns ?? []).map((pattern) => ({
        errorSignature: pattern.errorSignature,
        fixPattern: pattern.fixPattern,
      })),
    },
  };
}

export function renderSpeculativeOrchestrationPlan(plan: SpeculativeOrchestrationPlan | undefined): string {
  if (!plan) return '';
  return [
    '### Speculative Execution Plan (deterministic)',
    JSON.stringify(plan, null, 2),
  ].join('\n');
}
