import type { ChatMessage } from '../llm/types.js';

/**
 * Estimate retained in-memory bytes for a chat message.
 *
 * JSON.stringify is intentionally used instead of content-only length because tool calls,
 * tool result ids, timestamps and structured multimodal content also stay resident in the
 * message array and are serialized during LLM calls.
 */
export function estimateChatMessageBytes(message: ChatMessage): number {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return Buffer.byteLength(String(message.content ?? ''), 'utf8') + 512;
  }
}

export function estimateChatMessagesBytes(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateChatMessageBytes(message), 0);
}

function stripImagePartsFromMessage(message: ChatMessage): ChatMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const content = message.content.filter((part) => {
    if (!part || typeof part !== 'object') return true;
    const type = (part as { type?: unknown }).type;
    return type !== 'image_url' && type !== 'image' && type !== 'input_image' && type !== 'image_blob_ref';
  });

  return content.length === message.content.length ? message : { ...message, content };
}

function hasImagePart(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = (part as { type?: unknown }).type;
    return type === 'image_url' || type === 'image' || type === 'input_image' || type === 'image_blob_ref';
  });
}

/**
 * Remove old multimodal image payloads while preserving the surrounding text turns.
 * Large 1M-context models can carry long text histories, but base64/image refs are still
 * expensive and often stale after visual grounding has moved on. Keep only the latest N
 * messages that actually contain image parts; older image parts are stripped in-place.
 */
export function stripOldImageParts(
  messages: ChatMessage[],
  options: { retainImageMessages: number; protectedCount?: number },
): ChatMessage[] {
  const retainImageMessages = Math.max(0, Math.floor(options.retainImageMessages));
  if (retainImageMessages <= 0 || messages.length === 0) {
    return messages.map(stripImagePartsFromMessage);
  }

  const protectedCount = Math.max(0, Math.min(options.protectedCount ?? 0, messages.length));
  let remaining = retainImageMessages;
  const keepImage = new Array<boolean>(messages.length).fill(false);
  for (let i = messages.length - 1; i >= protectedCount; i -= 1) {
    if (!hasImagePart(messages[i])) continue;
    if (remaining > 0) {
      keepImage[i] = true;
      remaining -= 1;
    }
  }
  for (let i = 0; i < protectedCount; i += 1) {
    if (hasImagePart(messages[i])) keepImage[i] = true;
  }

  return messages.map((message, index) => (keepImage[index] ? message : stripImagePartsFromMessage(message)));
}

/**
 * 压缩旧 tool_result 消息，保留最近 N 轮的完整内容，旧轮次用占位符替换。
 *
 * 设计原理：
 * - Tool results（文件内容、命令输出等）是上下文膨胀主因
 * - 模型主要依赖 assistant 总结，很少反复查阅旧 tool results
 * - 占位符保留元信息（工具名、时间戳、大小），模型知道信息存在过
 *
 * 轮次定义：
 * - 一轮 = 一次 assistant 响应周期（从后往前，每个 assistant 消息算一轮）
 * - 保留最近 N 轮的 assistant 消息及其之后的所有 tool results
 *
 * @param messages - 消息历史
 * @param options.retainRecentTurns - 保留最近 N 轮 assistant 响应（默认 50）
 * @param options.protectedCount - 保护前 N 条消息不压缩（默认 0，system prompt 等）
 */
export function compactOldToolResults(
  messages: ChatMessage[],
  options: { retainRecentTurns?: number; protectedCount?: number },
): ChatMessage[] {
  const retainRecentTurns = Math.max(0, Math.floor(options.retainRecentTurns ?? 50));
  const protectedCount = Math.max(0, Math.min(options.protectedCount ?? 0, messages.length));

  if (retainRecentTurns <= 0 || messages.length === 0) {
    return messages;
  }

  // 从后往前遍历，统计 assistant 消息数量，确定压缩边界
  let assistantCount = 0;
  let compressBefore = messages.length; // 这个索引之前的 tool results 需要压缩

  for (let i = messages.length - 1; i >= protectedCount; i -= 1) {
    if (messages[i].role === 'assistant') {
      assistantCount += 1;
      if (assistantCount > retainRecentTurns) {
        // 超过保留轮数，这个 assistant 之前的 tool results 都压缩
        compressBefore = i;
        break;
      }
    }
  }

  // 保护区域始终不压缩
  if (compressBefore < protectedCount) {
    compressBefore = protectedCount;
  }

  return messages.map((message, index) => {
    // 保护区域或在保留范围内，不压缩
    if (index < protectedCount || index >= compressBefore) {
      return message;
    }

    // 检查是否是 tool_result 消息
    const isToolResult =
      message.role === 'tool' ||
      (message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => {
        if (typeof part === 'object' && part !== null) {
          const typedPart = part as { type?: string };
          return typedPart.type === 'tool_result';
        }
        return false;
      }));

    if (!isToolResult) {
      return message;
    }

    // 压缩 tool_result 消息
    if (message.role === 'tool') {
      return compactToolResultMessage(message);
    }

    if (message.role === 'user' && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => {
          if (typeof part === 'object' && part !== null) {
            const typedPart = part as { type?: string };
            if (typedPart.type === 'tool_result') {
              return compactToolResultContent(part);
            }
          }
          return part;
        }),
      };
    }

    return message;
  });
}

/**
 * 压缩单个 tool_result 消息，保留元信息
 */
function compactToolResultMessage(message: ChatMessage): ChatMessage {
  const originalContent = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  const originalBytes = Buffer.byteLength(originalContent, 'utf8');

  const toolCallId = (message as { tool_call_id?: string }).tool_call_id ?? 'unknown';
  const timestamp = message.timestamp ? new Date(message.timestamp * 1000).toISOString() : 'unknown';

  const placeholder = `[Tool result compacted - ID: ${toolCallId}, Size: ${formatBytes(originalBytes)}, Time: ${timestamp}]`;

  return {
    ...message,
    content: placeholder,
  };
}

/**
 * 压缩 tool_result 内容块（Anthropic 格式）
 */
function compactToolResultContent(part: any): any {
  const originalContent = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
  const originalBytes = Buffer.byteLength(originalContent, 'utf8');

  const toolUseId = part.tool_use_id ?? 'unknown';
  const isError = part.is_error ?? false;

  const placeholder = `[Tool result compacted - ID: ${toolUseId}, Size: ${formatBytes(originalBytes)}, Error: ${isError}]`;

  return {
    ...part,
    content: placeholder,
  };
}

/**
 * 格式化字节数为可读字符串
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}


