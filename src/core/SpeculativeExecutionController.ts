import type { VerificationResult } from './VerificationPipeline.js';

export type SpeculativeSelectionPolicy = 'first_green' | 'fewest_changes' | 'fastest_tests';
export type SpeculativeBranchStatus = 'passed' | 'failed' | 'timeout' | 'cancelled';

export interface SpeculativeBranchPlan {
  id: string;
  label?: string;
  workingDir: string;
  changedFiles?: string[];
  metadata?: Record<string, unknown>;
}

export interface SpeculativeBranchRunResult<T = unknown> {
  branchId: string;
  value: T;
  changedFiles?: string[];
  metrics?: {
    filesChanged?: number;
    testsDurationMs?: number;
  };
}

export interface SpeculativeBranchOutcome<T = unknown> {
  branch: SpeculativeBranchPlan;
  status: SpeculativeBranchStatus;
  durationMs: number;
  result?: SpeculativeBranchRunResult<T>;
  verification?: VerificationResult;
  error?: string;
}

export interface SpeculativeExecutionResult<T = unknown> {
  accepted: boolean;
  winner?: SpeculativeBranchOutcome<T>;
  bestPartial?: SpeculativeBranchOutcome<T>;
  outcomes: SpeculativeBranchOutcome<T>[];
  cancelledBranchIds: string[];
}

export interface SpeculativeWinnerEvidence {
  branchId: string;
  selectionPolicy?: SpeculativeSelectionPolicy;
  verification: VerificationResult;
  acceptedAt?: number;
}

export interface SpeculativeExecutionOptions<T = unknown> {
  branches: SpeculativeBranchPlan[];
  runBranch: (branch: SpeculativeBranchPlan, signal: AbortSignal) => Promise<SpeculativeBranchRunResult<T>>;
  verifyBranch: (
    branch: SpeculativeBranchPlan,
    result: SpeculativeBranchRunResult<T>,
    signal: AbortSignal,
  ) => Promise<VerificationResult>;
  cleanupBranch?: (outcome: SpeculativeBranchOutcome<T>) => Promise<void> | void;
  timeoutMs?: number;
  selectionPolicy?: SpeculativeSelectionPolicy;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function assertSpeculativeWinnerEvidenceVerified(value: unknown): SpeculativeWinnerEvidence | undefined {
  if (value === undefined || value === null) return undefined;
  const evidence = asRecord(value);
  if (!evidence) {
    throw new Error('speculative winner evidence must be an object');
  }
  const branchId = typeof evidence.branchId === 'string' && evidence.branchId.trim()
    ? evidence.branchId.trim()
    : typeof evidence.branch_id === 'string' && evidence.branch_id.trim()
      ? evidence.branch_id.trim()
      : undefined;
  if (!branchId) {
    throw new Error('speculative winner evidence requires branchId');
  }
  const verification = asRecord(evidence.verification) as VerificationResult | undefined;
  if (!verification || verification.allPassed !== true || !Array.isArray(verification.gates)) {
    throw new Error(`speculative winner ${branchId} cannot be accepted without Goal-7 verification allPassed=true`);
  }
  const failedGate = verification.gates.find((gate) => !gate.passed);
  if (failedGate) {
    throw new Error(`speculative winner ${branchId} cannot bypass failed Goal-7 gate: ${failedGate.gate}`);
  }
  return {
    branchId,
    selectionPolicy: typeof evidence.selectionPolicy === 'string'
      ? evidence.selectionPolicy as SpeculativeSelectionPolicy
      : typeof evidence.selection_policy === 'string'
        ? evidence.selection_policy as SpeculativeSelectionPolicy
        : undefined,
    verification,
    acceptedAt: typeof evidence.acceptedAt === 'number'
      ? evidence.acceptedAt
      : typeof evidence.accepted_at === 'number'
        ? evidence.accepted_at
        : undefined,
  };
}

export class SpeculativeExecutionController {
  async execute<T = unknown>(options: SpeculativeExecutionOptions<T>): Promise<SpeculativeExecutionResult<T>> {
    const branches = this.normalizeBranches(options.branches);
    this.assertIsolatedBranches(branches);
    const selectionPolicy = options.selectionPolicy ?? 'first_green';
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const controllers = new Map<string, AbortController>();
    const cancelledBranchIds = new Set<string>();
    const outcomes: SpeculativeBranchOutcome<T>[] = [];
    let winner: SpeculativeBranchOutcome<T> | undefined;

    const cancelBranch = (branchId: string, reason: string) => {
      const controller = controllers.get(branchId);
      if (controller && !controller.signal.aborted) {
        cancelledBranchIds.add(branchId);
        controller.abort(reason);
      }
    };
    const cancelOthers = (winnerId: string) => {
      for (const branch of branches) {
        if (branch.id !== winnerId) cancelBranch(branch.id, `speculative winner selected: ${winnerId}`);
      }
    };

    const runOne = async (branch: SpeculativeBranchPlan): Promise<SpeculativeBranchOutcome<T>> => {
      const controller = new AbortController();
      controllers.set(branch.id, controller);
      const abortFromParent = () => controller.abort(options.signal?.reason ?? 'speculative execution aborted');
      if (options.signal) {
        if (options.signal.aborted) abortFromParent();
        else options.signal.addEventListener('abort', abortFromParent, { once: true });
      }
      let timeoutReject: ((error: Error) => void) | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutReject = reject;
      });
      const timeout = setTimeout(() => {
        cancelledBranchIds.add(branch.id);
        controller.abort(`speculative branch timeout after ${timeoutMs}ms`);
        timeoutReject?.(new Error(`speculative branch timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const startedAt = Date.now();

      try {
        const result = await Promise.race([
          options.runBranch(branch, controller.signal),
          timeoutPromise,
        ]);
        if (controller.signal.aborted) {
          return {
            branch,
            status: cancelledBranchIds.has(branch.id) ? 'cancelled' : 'timeout',
            durationMs: Date.now() - startedAt,
            result,
            error: String(controller.signal.reason ?? 'aborted'),
          };
        }
        const verification = await Promise.race([
          options.verifyBranch(branch, result, controller.signal),
          timeoutPromise,
        ]);
        const outcome: SpeculativeBranchOutcome<T> = {
          branch,
          status: verification.allPassed ? 'passed' : 'failed',
          durationMs: Date.now() - startedAt,
          result,
          verification,
          error: verification.allPassed ? undefined : this.formatVerificationFailure(verification),
        };
        return outcome;
      } catch (error) {
        const aborted = controller.signal.aborted;
        return {
          branch,
          status: aborted ? (cancelledBranchIds.has(branch.id) ? 'cancelled' : 'timeout') : 'failed',
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timeout);
        if (options.signal) {
          options.signal.removeEventListener('abort', abortFromParent);
        }
      }
    };

    if (selectionPolicy === 'first_green') {
      await Promise.all(branches.map(async (branch) => {
        const outcome = await runOne(branch);
        outcomes.push(outcome);
        if (!winner && outcome.status === 'passed') {
          winner = outcome;
          cancelOthers(branch.id);
        }
        await options.cleanupBranch?.(outcome);
      }));
    } else {
      await Promise.all(branches.map(async (branch) => {
        const outcome = await runOne(branch);
        outcomes.push(outcome);
        await options.cleanupBranch?.(outcome);
      }));
      winner = this.selectWinner(outcomes, selectionPolicy);
    }

    const orderedOutcomes = this.sortOutcomes(outcomes, branches);
    const resolvedWinner = winner ? orderedOutcomes.find((outcome) => outcome.branch.id === winner?.branch.id) : undefined;
    return {
      accepted: Boolean(resolvedWinner),
      winner: resolvedWinner,
      bestPartial: resolvedWinner ? undefined : this.selectBestPartial(orderedOutcomes),
      outcomes: orderedOutcomes,
      cancelledBranchIds: [...cancelledBranchIds].sort(),
    };
  }

  private normalizeBranches(branches: SpeculativeBranchPlan[]): SpeculativeBranchPlan[] {
    const seen = new Set<string>();
    const out: SpeculativeBranchPlan[] = [];
    for (const branch of branches) {
      const id = branch.id.trim();
      const workingDir = branch.workingDir.trim();
      if (!id || !workingDir || seen.has(id)) continue;
      seen.add(id);
      out.push({
        ...branch,
        id,
        workingDir,
        changedFiles: [...(branch.changedFiles ?? [])],
      });
    }
    if (out.length === 0) {
      throw new Error('speculative execution requires at least one branch');
    }
    return out;
  }

  private assertIsolatedBranches(branches: SpeculativeBranchPlan[]): void {
    if (branches.length <= 1) return;
    const seen = new Map<string, string>();
    for (const branch of branches) {
      const existing = seen.get(branch.workingDir);
      if (existing) {
        throw new Error(`speculative branches must use isolated workingDir values: ${existing} and ${branch.id} share ${branch.workingDir}`);
      }
      seen.set(branch.workingDir, branch.id);
    }
  }

  private selectWinner<T>(
    outcomes: SpeculativeBranchOutcome<T>[],
    policy: SpeculativeSelectionPolicy,
  ): SpeculativeBranchOutcome<T> | undefined {
    const passed = outcomes.filter((outcome) => outcome.status === 'passed' && outcome.verification?.allPassed);
    if (passed.length === 0) return undefined;
    const sorted = [...passed].sort((a, b) => {
      if (policy === 'fewest_changes') {
        const filesA = this.changedFileCount(a);
        const filesB = this.changedFileCount(b);
        if (filesA !== filesB) return filesA - filesB;
      }
      if (policy === 'fastest_tests') {
        const testsA = this.testDuration(a);
        const testsB = this.testDuration(b);
        if (testsA !== testsB) return testsA - testsB;
      }
      if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
      return a.branch.id.localeCompare(b.branch.id);
    });
    return sorted[0];
  }

  private selectBestPartial<T>(outcomes: SpeculativeBranchOutcome<T>[]): SpeculativeBranchOutcome<T> | undefined {
    if (outcomes.length === 0) return undefined;
    return [...outcomes].sort((a, b) => {
      const gatesA = this.passedGateCount(a);
      const gatesB = this.passedGateCount(b);
      if (gatesA !== gatesB) return gatesB - gatesA;
      if (a.status !== b.status) {
        if (a.status === 'failed') return -1;
        if (b.status === 'failed') return 1;
      }
      if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
      return a.branch.id.localeCompare(b.branch.id);
    })[0];
  }

  private sortOutcomes<T>(
    outcomes: SpeculativeBranchOutcome<T>[],
    branches: SpeculativeBranchPlan[],
  ): SpeculativeBranchOutcome<T>[] {
    const order = new Map(branches.map((branch, index) => [branch.id, index]));
    return [...outcomes].sort((a, b) => (order.get(a.branch.id) ?? 0) - (order.get(b.branch.id) ?? 0));
  }

  private changedFileCount(outcome: SpeculativeBranchOutcome): number {
    return outcome.result?.metrics?.filesChanged
      ?? outcome.result?.changedFiles?.length
      ?? outcome.branch.changedFiles?.length
      ?? Number.MAX_SAFE_INTEGER;
  }

  private testDuration(outcome: SpeculativeBranchOutcome): number {
    return outcome.result?.metrics?.testsDurationMs
      ?? outcome.verification?.totalDurationMs
      ?? outcome.durationMs;
  }

  private passedGateCount(outcome: SpeculativeBranchOutcome): number {
    return outcome.verification?.gates.filter((gate) => gate.passed).length ?? 0;
  }

  private formatVerificationFailure(verification: VerificationResult): string {
    const failed = verification.gates.find((gate) => !gate.passed);
    if (!failed) return 'verification failed without failed gate';
    const diagnostics = failed.diagnostics.slice(0, 3).join('; ');
    return `${failed.gate} failed${diagnostics ? `: ${diagnostics}` : ''}`;
  }
}

export default SpeculativeExecutionController;
