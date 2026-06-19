import { contentToPlainText, type ChatMessage } from '../../llm/types.js';

/**
 * 通用最近消息摘要工具，由 NextSpeakerPolicy / WorkerCompletionPolicy 等
 * Judge 类策略共享。截断长度可调，避免长文消息撑爆 LLM 二次 prompt。
 */
export function summarizeRecentMessages(
  messages: ChatMessage[] = [],
  maxMessages = 8,
  maxCharsPerMessage = 1200,
): string {
  const relevant = messages
    .filter((message) => message.role !== 'system')
    .slice(-maxMessages);

  if (relevant.length === 0) {
    return '(none)';
  }

  return relevant.map((message, index) => {
    const text = contentToPlainText(message.content).trim().slice(0, maxCharsPerMessage);
    return [
      `#${index + 1} role=${message.role}`,
      text || '(empty)',
    ].join('\n');
  }).join('\n\n');
}
