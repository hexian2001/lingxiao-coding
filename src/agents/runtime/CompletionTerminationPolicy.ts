export type RawToolRetryOutcome =
  | { type: 'retry'; nextRetryCount: number }
  | { type: 'terminate'; nextRetryCount: number; finalMessage: string };

export function isStopFinishReason(finishReason?: string): boolean {
  return finishReason === 'stop' || finishReason === 'end_turn';
}

export function evaluateRawToolRetryOutcome(options: {
  currentRetryCount: number;
  maxRetryCount: number;
  finalMessage: (nextRetryCount: number) => string;
}): RawToolRetryOutcome {
  const nextRetryCount = options.currentRetryCount + 1;
  if (nextRetryCount > options.maxRetryCount) {
    return {
      type: 'terminate',
      nextRetryCount,
      finalMessage: options.finalMessage(nextRetryCount),
    };
  }
  return {
    type: 'retry',
    nextRetryCount,
  };
}
