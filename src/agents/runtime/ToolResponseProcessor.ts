import type { ChatMessage, MessageContent, MessageContentPart, ThinkingBlock, ToolCall } from '../../llm/types.js';
import { externalizeImageDataInContent } from '../../llm/image_blob_store.js';

export type ToolCallContext = {
  source?: 'native' | 'raw_xml' | string;
};

/** 工具执行结果：支持纯文本或结构化 content parts（如含图片的截图结果） */
export type ToolResultContent = string | MessageContentPart[];

export interface ToolCallExecution {
  toolCall: ToolCall;
  result: ToolResultContent;
}

export interface ToolResponseProcessorOptions<TDone extends { done: boolean; result?: string } = { done: boolean; result?: string }> {
  assistantContent: ChatMessage['content'];
  toolCalls: ToolCall[];
  /**
   * 上游响应的结构化 thinking blocks。要原样写入 assistant 消息以便
   * 下一轮调用上游 thinking-mode API 时可以原样回传（包括 signature）。
   */
  thinking?: ThinkingBlock[];
  wasOutputTruncated?: boolean;
  toolCallContext?: ToolCallContext;
  beforeToolCalls?: (toolCalls: ToolCall[], context?: ToolCallContext) => Promise<TDone | null | void> | TDone | null | void;
  persistAssistantMessage: (message: ChatMessage) => Promise<void> | void;
  executeToolCallsBatch: (toolCalls: ToolCall[]) => Promise<ToolCallExecution[]>;
  emitToolCall: (toolCall: ToolCall) => void;
  transformToolResult: (toolCall: ToolCall, rawResult: ToolResultContent) => ToolResultContent;
  persistToolMessage: (
    message: ChatMessage,
    toolCall: ToolCall,
    rawResult: ToolResultContent,
    renderedResult: ToolResultContent,
  ) => Promise<void> | void;
  emitToolResult: (toolCall: ToolCall, renderedResult: ToolResultContent) => void;
  afterToolResult?: (
    toolCall: ToolCall,
    rawResult: ToolResultContent,
    renderedResult: ToolResultContent,
  ) => Promise<void> | void;
  afterToolCalls?: (input: {
    assistantContent: ChatMessage['content'];
    toolCalls: ToolCall[];
    toolCallContext?: ToolCallContext;
  }) => Promise<TDone | null | void> | TDone | null | void;
  shouldStopAfterToolResult?: () => TDone | null;
  /**
   * earlyStop 清理回调：earlyStop（agent completion / 高优中断 / session finished）
   * 会跳过 afterToolCalls，onEarlyStop 在 return earlyStop 之前执行，
   * 确保残留的 assistant + tool_results 被原子持久化到 DB。
   */
  onEarlyStop?: () => Promise<void> | void;
}

export async function processToolCallResponse<TDone extends { done: boolean; result?: string } = { done: boolean; result?: string }>(
  options: ToolResponseProcessorOptions<TDone>,
): Promise<TDone | { done: false }> {
  const {
    assistantContent,
    toolCalls,
    thinking,
    toolCallContext,
    beforeToolCalls,
    persistAssistantMessage,
    executeToolCallsBatch,
    emitToolCall,
    transformToolResult,
    persistToolMessage,
    emitToolResult,
    afterToolResult,
    afterToolCalls,
    shouldStopAfterToolResult,
    onEarlyStop,
  } = options;

  // ── 异常安全：任何路径退出前必须 flush 残留的 assistant + tool_results ──
  // 此前无 try/catch：executeToolCallsBatch / persistToolMessage / afterToolResult
  // 抛异常时 pendingAssistant + partial pendingToolResults 悬在内存，
  // onEarlyStop 和 afterToolCalls 都不被调用 → tool_result 丢失。
  try {
    const preflight = await beforeToolCalls?.(toolCalls, toolCallContext);
    if (preflight?.done) {
      // beforeToolCalls 早返回（高优中断 / 用户中断）也需 flush 残留数据，
      // 否则上一轮的 pendingAssistant + partial results 悬在内存 → 进程重启后丢失。
      await onEarlyStop?.();
      return preflight;
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistantContent,
      tool_calls: toolCalls,
      ...(thinking && thinking.length > 0 ? { thinking } : {}),
    };
    await persistAssistantMessage(assistantMessage);

    for (const toolCall of toolCalls) {
      emitToolCall(toolCall);
    }

    const executed = await executeToolCallsBatch(toolCalls);
    let earlyStop: TDone | null = null;
    for (const { toolCall, result } of executed) {
      const renderedResult = transformToolResult(toolCall, result);

      // content 支持 string 或 MessageContentPart[]（如截图的 image_url）。
      // 进入历史前先把 data:image base64 外置为 blob 引用，避免撑爆上下文。
      const toolMessageContent = (await externalizeImageDataInContent(
        renderedResult,
        toolCall.function.name,
      )) || '';
      const toolMessage: ChatMessage = {
        role: 'tool',
        content: toolMessageContent,
        tool_call_id: toolCall.id,
      };

      await persistToolMessage(toolMessage, toolCall, result, renderedResult);
      emitToolResult(toolCall, toolMessageContent);
      await afterToolResult?.(toolCall, result, renderedResult);

      const stop = shouldStopAfterToolResult?.();
      if (stop) {
        earlyStop ??= stop;
      }
    }

    // earlyStop 存在时（无论 done true/false）都执行清理回调，
    // 确保残留的 assistant + tool_results 被原子持久化到 DB。
    // - done=true（agent completion / session finished / 高优中断）：flush 后直接返回
    // - done=false（isWaitingForUser / isPendingReview / 软中断）：flush 后继续走 afterToolCalls
    if (earlyStop) {
      await onEarlyStop?.();
      if (earlyStop?.done) {
        return earlyStop;
      }
    }

    const postflight = await afterToolCalls?.({
      assistantContent,
      toolCalls,
      toolCallContext,
    });
    if (postflight != null) {
      return postflight;
    }
    if (earlyStop) {
      return earlyStop;
    }
    return { done: false };
  } catch (err) {
    // 异常路径：确保 pending 数据被 flush 后再抛出，
    // 避免 session 恢复时 conversation 残缺 → tool_result 丢失。
    await onEarlyStop?.();
    throw err;
  }
}
