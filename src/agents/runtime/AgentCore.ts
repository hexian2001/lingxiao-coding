import {
  runBoundedReasoningLoop,
  type ReasoningLoopStep,
  type ReasoningLoopTerminationReason,
} from './ReasoningLoopDriver.js';

export interface AgentCoreRunOptions<T> {
  maxRounds: number;
  maxRuntimeMinutes: number;
  shouldStop?: () => boolean;
  onStopped?: () => T | Promise<T>;
  onBoundReached: (
    reason: ReasoningLoopTerminationReason,
  ) => ReasoningLoopStep<T> | Promise<ReasoningLoopStep<T>>;
  runRound: (roundNumber: number) => ReasoningLoopStep<T> | Promise<ReasoningLoopStep<T>>;
}

export class AgentCore<T = string> {
  async run(options: AgentCoreRunOptions<T>): Promise<T | undefined> {
    const result = await runBoundedReasoningLoop<T>({
      maxRounds: options.maxRounds,
      maxRuntimeMinutes: options.maxRuntimeMinutes,
      onBoundReached: async (reason) => options.onBoundReached(reason),
      runRound: async (roundNumber) => {
        if (options.shouldStop?.()) {
          const stoppedResult = options.onStopped ? await options.onStopped() : undefined;
          return { type: 'break', result: stoppedResult };
        }
        return options.runRound(roundNumber);
      },
    });

    return result.result;
  }
}
