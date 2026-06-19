export type ReasoningLoopStep<T> =
  | { type: 'continue' }
  | { type: 'repeat' }
  | { type: 'reset_budget' }
  | { type: 'break'; result?: T };

export type ReasoningLoopTerminationReason = 'max_rounds' | 'max_runtime';

export interface ReasoningLoopBoundContext {
  roundsCompleted: number;
  startedAtMs: number;
}

export interface RunBoundedReasoningLoopOptions<T> {
  maxRounds: number;
  maxRuntimeMinutes: number;
  /** 最大 reset_budget 次数，默认 3 */
  maxResets?: number;
  /** 最大连续 repeat 次数，默认 maxRounds */
  maxConsecutiveRepeats?: number;
  runRound: (roundNumber: number) => Promise<ReasoningLoopStep<T> | void> | ReasoningLoopStep<T> | void;
  onBoundReached?: (
    reason: ReasoningLoopTerminationReason,
    context: ReasoningLoopBoundContext,
  ) => Promise<ReasoningLoopStep<T> | void> | ReasoningLoopStep<T> | void;
}

export interface ReasoningLoopResult<T> {
  result?: T;
  roundsCompleted: number;
  terminationReason?: ReasoningLoopTerminationReason;
}

export async function runBoundedReasoningLoop<T>(
  options: RunBoundedReasoningLoopOptions<T>,
): Promise<ReasoningLoopResult<T>> {
  const {
    maxRounds,
    maxRuntimeMinutes,
    maxResets = 3,
    maxConsecutiveRepeats = maxRounds,
    runRound,
    onBoundReached,
  } = options;

  let roundsCompleted = 0;
  let startedAtMs = Date.now();
  let resetCount = 0;
  let consecutiveRepeats = 0;

  type BoundHandleResult = { action: 'return'; value: ReasoningLoopResult<T> } | { action: 'reset' } | null;

  async function handleBoundReached(reason: ReasoningLoopTerminationReason): Promise<BoundHandleResult> {
    const boundStep: ReasoningLoopStep<T> =
      (await onBoundReached?.(reason, { roundsCompleted, startedAtMs })) ?? { type: 'continue' };
    if (boundStep.type === 'break') {
      return { action: 'return', value: { result: boundStep.result, roundsCompleted, terminationReason: reason } };
    }
    if (boundStep.type === 'reset_budget') {
      resetCount++;
      if (resetCount > maxResets) {
        return { action: 'return', value: { roundsCompleted, terminationReason: reason } };
      }
      return { action: 'reset' };
    }
    return { action: 'return', value: { roundsCompleted, terminationReason: reason } };
  }

  while (true) {
    if (roundsCompleted >= maxRounds) {
      const outcome = await handleBoundReached('max_rounds');
      if (outcome?.action === 'reset') { roundsCompleted = 0; startedAtMs = Date.now(); continue; }
      if (outcome?.action === 'return') return outcome.value;
    }

    if ((Date.now() - startedAtMs) / (1000 * 60) >= maxRuntimeMinutes) {
      const outcome = await handleBoundReached('max_runtime');
      if (outcome?.action === 'reset') { roundsCompleted = 0; startedAtMs = Date.now(); continue; }
      if (outcome?.action === 'return') return outcome.value;
    }

    roundsCompleted += 1;
    const step: ReasoningLoopStep<T> = (await runRound(roundsCompleted)) ?? { type: 'continue' };

    if (step.type === 'break') {
      return { result: step.result, roundsCompleted };
    }

    if (step.type === 'repeat') {
      consecutiveRepeats++;
      if (consecutiveRepeats > maxConsecutiveRepeats) {
        return { roundsCompleted, terminationReason: 'max_rounds' };
      }
      roundsCompleted -= 1;
      continue;
    }

    consecutiveRepeats = 0;
  }
}
