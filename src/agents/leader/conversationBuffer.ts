/**
 * Leader conversation buffer trimmer
 *
 * 策略：剥离旧图片 base64 payload 和压缩旧 tool results，不删任何消息。
 * - 旧图片按 image_history_retain_rounds 剥离 base64 payload，保留文字部分
 * - 旧 tool results 按 tool_result_retain_rounds 压缩为占位符，保留元信息
 * - 消息裁剪（含 tool 消息）统一由 compact 路径负责，此处不再做条数裁剪
 */

import type { ChatMessage } from '../../llm/types.js';
import { config as runtimeConfig } from '../../config.js';
import {
  stripOldImageParts,
  compactOldToolResults,
} from '../messageMemoryBudget.js';

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
 * 对 conversation 做旧图片剥离和 tool result 压缩，不删任何消息。
 *
 * 行为：
 * - 旧图片按配置轮数剥离 base64 payload，保留文字部分
 * - 旧 tool results 按配置轮数压缩为占位符，保留元信息
 * - 不做条数裁剪（tool 消息也不删）；消息裁剪统一由 compact 路径负责
 */
export function trimConversationBuffer(
  conversation: ChatMessage[],
  _maxMessages?: number,
  _maxBytes?: number,
): ChatMessage[] {
  const protectedCount = Math.min(2, conversation.length);

  // 1. 剥离旧图片 base64
  let trimmed = stripOldImageParts(conversation, {
    retainImageMessages: runtimeConfig.advanced.image_history_retain_rounds,
    protectedCount,
  });

  // 2. 压缩旧 tool results
  trimmed = compactOldToolResults(trimmed, {
    retainRecentTurns: runtimeConfig.advanced.tool_result_retain_rounds,
    protectedCount,
  });

  return trimmed;
}
