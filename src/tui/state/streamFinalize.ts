import type { MutableRefObject } from 'react';
import type { CommandLogMessage } from '../../commands/types.js';
import { extractThinkBlock } from '../utils.js';
import type { ChannelState } from './types.js';

/**
 * 把流式 chunk 落成永久消息 + 清空临时流。
 *
 * Leader 和 Agent 走的是同一套终态结构（最终事件 = content + reasoningContent），
 * 此前 useTuiLeaderHandlers / useTuiAgentHandlers 各写一遍 finalize 逻辑：
 *  - Leader 端有错误的 `!currentThinkingStream` 判定（流尚未清空，分支永远不触发）
 *  - Agent 端根本没把 thinking stream 落消息
 *  - showThinking 开关只在 Leader 处理
 *
 * 这里抽出统一实现，让两端都按同一规则交付：
 *
 *  1. flushStreamBuffer 把 React 流式缓冲应用到 channel state（保证读到最新）
 *  2. 解析 event.content 中的 <think>…</think> 块
 *  3. 选定最终 thinking 文本：event.reasoningContent → <think> 解析 → 已累积的流
 *  4. 选定最终正文文本：去除 <think> 后的 cleaned content
 *  5. 写 thinking 消息（若 showThinking 且非空）
 *  6. 写正文消息（若非空）
 *  7. 清空两条流
 */
export interface FinalizeStreamMessageInput {
  channel: string;
  /** 最终事件原始 content（string 或 {text} 包装） */
  eventContent: unknown;
  /** 最终事件携带的结构化 thinking 文本 */
  eventReasoning?: string;
  /** 写入时正文消息的 type，leader 用 'leader'、worker 用 'agent' */
  finalRole: 'leader' | 'agent';
  /** 用户配置的 show_thinking_content；true 显示，false 隐藏 */
  showThinking: boolean;
}

export interface FinalizeStreamMessageDeps {
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  flushStreamBuffer: (onlyChannel?: string) => void;
  channelsRef: MutableRefObject<Record<string, ChannelState>>;
  /** 清空指定 channel 的两条流（实现需同步把 React state currentStream/currentThinkingStream 置空） */
  clearStreams: (channel: string) => void;
}

export function finalizeStreamMessages(
  input: FinalizeStreamMessageInput,
  deps: FinalizeStreamMessageDeps,
): void {
  const { channel, eventContent, eventReasoning, finalRole, showThinking } = input;
  const { appendMessage, flushStreamBuffer, channelsRef, clearStreams } = deps;

  // 1. 先 flush 流缓冲，保证 channelsRef 中的 currentThinkingStream 是 chunk 流的最终值。
  flushStreamBuffer(channel);

  // 2. 解析 <think> 块，区分 cleaned 正文与 inline reasoning。
  const rawText = typeof eventContent === 'string'
    ? eventContent
    : (eventContent && typeof eventContent === 'object' && 'text' in eventContent
        ? String((eventContent as { text?: unknown }).text ?? '')
        : '');
  const parsed = extractThinkBlock(rawText);
  const text = parsed.cleaned.trim();

  // 3. 优先级：结构化 reasoning > inline <think> > 流式累积 thinking。
  //    用流式累积兜底是为了应对 provider 只发了 thinking_chunk、最终事件 reasoning 字段为空的情况。
  const streamedThinking = (channelsRef.current?.[channel]?.currentThinkingStream || '').trim();
  const thinking = (eventReasoning || parsed.reasoning || streamedThinking || '').trim();

  // 4. 落消息。thinking 在前，正文在后，与流式渲染顺序一致。
  if (showThinking !== false && thinking) {
    appendMessage(channel, { type: 'thinking', content: thinking });
  }
  if (text) {
    appendMessage(channel, { type: finalRole, content: text });
  }

  // 5. 清空临时流，避免「永久消息 + 还残留的流式镜像」叠加渲染。
  clearStreams(channel);
}
