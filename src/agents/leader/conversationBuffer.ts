/**
 * Leader conversation buffer trimmer
 *
 * 把 LeaderAgent.addMessage 的环形缓冲修剪逻辑抽出为纯函数：
 * - 永远保留前 2 条消息（system + 首条 user）
 * - 超出 maxMessages 时从尾部保留窗口
 * - 窗口起点不能落在 'tool' 消息（这会破坏 OpenAI 的 tool_calls/tool 配对）
 */

import type { ChatMessage } from '../../llm/types.js';

/**
 * 给消息打默认 timestamp（秒，浮点）：仅在缺失时填充
 */
export function ensureMessageTimestamp(msg: ChatMessage, nowMs = Date.now()): ChatMessage {
  if (!msg.timestamp) {
    msg.timestamp = nowMs / 1000;
  }
  return msg;
}

/**
 * 在保留前缀前提下，对 conversation 做尾部窗口修剪
 *
 * 行为与 LeaderAgent 原实现保持一致：
 * - 长度 ≤ maxMessages 直接返回原数组
 * - 否则保留 prefix(0..2) + tail(末尾 maxMessages - 2 条以内)
 * - tail 起点若为 'tool' 角色则继续往后丢，直到非 tool
 */
export function trimConversationBuffer(
  conversation: ChatMessage[],
  maxMessages: number,
): ChatMessage[] {
  if (conversation.length <= maxMessages) {
    return conversation;
  }

  const prefix = conversation.slice(0, 2);
  let tail = conversation.slice(
    Math.max(2, conversation.length - (maxMessages - 2)),
  );

  // 起点不能是 tool（必须有先行的 assistant tool_calls）
  while (tail.length > 0 && tail[0]?.role === 'tool') {
    tail = tail.slice(1);
  }

  while (prefix.length + tail.length > maxMessages) {
    tail = tail.slice(1);
    while (tail.length > 0 && tail[0]?.role === 'tool') {
      tail = tail.slice(1);
    }
  }

  return [...prefix, ...tail];
}
