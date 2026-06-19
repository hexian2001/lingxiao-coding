/**
 * MicroCompact — Clears tool_result content for large-output tools in preserved tail messages.
 *
 * When rebuilding context after overflow, the preserved message tail still carries
 * potentially massive tool results (file reads, bash output, web fetches). This module
 * replaces those results with a compact placeholder, drastically reducing token usage
 * while preserving the conversation structure.
 */

import { type ChatMessage } from '../../llm/types.js';

/** Tools whose results should be compacted (large-output tools). */
const COMPACTABLE_TOOLS = new Set([
  'read',
  'bash',
  'grep',
  'glob',
  'webfetch',
  'websearch',
  'edit',
  'write',
  'apply_patch',
]);

/** Placeholder text for compacted tool results. */
const COMPACT_PLACEHOLDER = '[output compacted - see checkpoint for context]';

/**
 * 微压缩的字节下限：工具结果字节数低于此值时**原样保留**，不替换为占位符。
 *
 * 动机：占位符本身 ~46 字节。对短结果（exit code、文件路径、grep 计数、小文件片段）做压缩，
 * 既丢信号又可能反而变大。只有达到此量级的结果才值得用占位符换 token。这是一个明确的
 * 字节工程参数（与 BYTE_THRESHOLD_RATIO / largeOutputBytes 同类），非分类启发式。
 */
const MICROCOMPACT_MIN_BYTES = 256;

/** 计算消息 content 的 UTF-8 字节数（覆盖 string / 数组 / 对象）。 */
function contentByteLength(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (content == null) return 0;
  return Buffer.byteLength(JSON.stringify(content), 'utf8');
}

/**
 * Determine if a tool message is from one of the compactable tools.
 *
 * Matches only on the exact tool name carried in the message's `name` field.
 * The tool→message linkage by id is handled in microCompact via the
 * compactableCallIds set (exact id equality); we deliberately avoid substring
 * scanning of tool_call_id here, which could mis-classify ids that merely
 * contain a tool name as a substring.
 */
function isCompactableTool(message: ChatMessage): boolean {
  if (message.role !== 'tool') return false;

  if (message.name && COMPACTABLE_TOOLS.has(message.name.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * Check if a tool_call references a compactable tool.
 */
function isCompactableToolCall(toolCallName: string): boolean {
  return COMPACTABLE_TOOLS.has(toolCallName.toLowerCase());
}

/**
 * Compact tool results in preserved tail messages.
 *
 * - Keeps user messages and assistant text untouched.
 * - For tool messages from compactable tools: replaces content with placeholder.
 * - For assistant messages with tool_calls: keeps the tool_call structure,
 *   only clears the result content in corresponding tool messages.
 */
export function microCompact(messages: ChatMessage[]): ChatMessage[] {
  // Build a set of tool_call IDs that reference compactable tools
  const compactableCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (isCompactableToolCall(tc.function.name)) {
          compactableCallIds.add(tc.id);
        }
      }
    }
  }

  return messages.map((msg): ChatMessage => {
    // Keep user and system messages untouched
    if (msg.role === 'user' || msg.role === 'system') {
      return msg;
    }

    // Keep assistant messages untouched (including tool_calls)
    if (msg.role === 'assistant') {
      return msg;
    }

    // For tool messages: compact if it matches a compactable tool AND exceeds the size floor.
    // 小结果（exit code / 路径 / 计数 / 小文件片段）低于 MICROCOMPACT_MIN_BYTES 时原样保留——
    // 既不丢信号，也避免占位符反而比原文更大。
    if (msg.role === 'tool') {
      const shouldCompact =
        ((msg.tool_call_id && compactableCallIds.has(msg.tool_call_id)) ||
          isCompactableTool(msg)) &&
        contentByteLength(msg.content) >= MICROCOMPACT_MIN_BYTES;

      if (shouldCompact) {
        return {
          ...msg,
          content: COMPACT_PLACEHOLDER,
        };
      }
    }

    return msg;
  });
}

export { COMPACTABLE_TOOLS, COMPACT_PLACEHOLDER, MICROCOMPACT_MIN_BYTES };
