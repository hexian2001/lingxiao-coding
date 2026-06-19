import type { ChatMessage, ThinkingBlock, ToolCall } from '../../llm/types.js';
import { processToolCallResponse } from './ToolResponseProcessor.js';
import type { ToolCallContext, ToolResponseProcessorOptions } from './ToolResponseProcessor.js';

export type ToolSchedulerContext<TDone extends { done: boolean; result?: string } = { done: boolean; result?: string }> = Omit<
  ToolResponseProcessorOptions<TDone>,
  'assistantContent' | 'toolCalls' | 'toolCallContext' | 'thinking' | 'wasOutputTruncated'
> & {
  checkHighPriorityIntervention?: () => Promise<TDone | null | void> | TDone | null | void;
};

export class ToolScheduler<TDone extends { done: boolean; result?: string } = { done: boolean; result?: string }> {
  private readonly context: ToolSchedulerContext<TDone>;

  constructor(context: ToolSchedulerContext<TDone>) {
    this.context = context;
  }

  run(input: {
    assistantContent: ChatMessage['content'];
    toolCalls: ToolCall[];
    thinking?: ThinkingBlock[];
    wasOutputTruncated?: boolean;
    toolCallContext?: ToolCallContext;
  }) {
    const {
      checkHighPriorityIntervention,
      beforeToolCalls,
      afterToolCalls,
      afterToolResult,
      shouldStopAfterToolResult,
      ...rest
    } = this.context;

    let interrupted: TDone | null = null;

    const checkIntervention = async () => {
      if (!checkHighPriorityIntervention || interrupted) {
        return;
      }
      const verdict = await checkHighPriorityIntervention();
      if (verdict) {
        interrupted = verdict;
      }
    };

    return processToolCallResponse<TDone>({
      ...rest,
      assistantContent: input.assistantContent,
      toolCalls: input.toolCalls,
      toolCallContext: input.toolCallContext,
      thinking: input.thinking,
      wasOutputTruncated: input.wasOutputTruncated,
      beforeToolCalls: async (toolCalls, context) => {
        await checkIntervention();
        // 仅 done=true 的硬中断才短路；done=false 的软中断仍需执行真实 beforeToolCalls
        // （设置 currentBatchSize 等），否则 persistToolMessage 的 flush 条件永远不满足。
        if (interrupted?.done) {
          return interrupted;
        }
        return beforeToolCalls?.(toolCalls, context);
      },
      afterToolResult: async (toolCall, rawResult, renderedResult) => {
        await afterToolResult?.(toolCall, rawResult, renderedResult);
        await checkIntervention();
      },
      shouldStopAfterToolResult: () => {
        if (interrupted?.done) {
          return interrupted;
        }
        const stop = shouldStopAfterToolResult?.();
        if (stop) {
          return stop;
        }
        if (interrupted) {
          return interrupted;
        }
        return null;
      },
      afterToolCalls: async (payload) => {
        // 仅 done=true 的硬中断才短路；done=false 的软中断仍需执行真实 afterToolCalls
        // （含 flushBatch 兜底），否则 tool_result 悬在内存永不落库。
        if (interrupted?.done) {
          return interrupted;
        }
        return afterToolCalls?.(payload);
      },
    });
  }
}
