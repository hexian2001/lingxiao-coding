/**
 * Agent Inbox 协议纯函数：消息解析 + 内容格式化。
 *
 * 历史上 BaseAgentRuntime.ts 里散落了 4 个解析消息类型的方法（isStopMessage /
 * isPauseMessage / isInterveneMessage / parseIntervention）和一段 ~30 行的
 * "把入站消息渲染成对话内容" 的内联代码，全是无状态的纯逻辑。这里把它们抽出
 * 成独立模块，让 BaseAgent.checkInbox / checkInboxForIntervention 等只负责
 * 状态变更，解析职责单点收敛。
 *
 * 不抽 checkInbox / checkInboxForResume / checkInboxForInterventionConfirm
 * 自身：它们要 mutate this.stopped / this.paused / this.intervene / 调用
 * this.addMessage / this.logEvent / this.emitter，与 BaseAgent 的运行时状态
 * 紧耦合，强行抽出会引入回调注入大杂烩，得不偿失。
 */

import {
  contentToPlainText,
  isContentPartArray,
  type MessageContentPart,
} from '../../llm/types.js';
import { parseProtocolPayload } from '../../core/TeamProtocol.js';

export interface InboxRawMessage {
  type: string;
  payload: unknown;
  from: string;
}

export interface ParsedIntervention {
  type: 'retry_llm' | 'swap_model' | 'nudge' | 'compact_context';
  param?: string;
}

/** 是否是 Leader/外部强制停止信号 */
export function isStopMessage(msg: InboxRawMessage): boolean {
  if (msg.type === 'force_terminate') return true;
  if (msg.type !== 'message' && msg.type !== 'user_intervention') return false;

  if (typeof msg.payload === 'object' && msg.payload !== null) {
    const payload = msg.payload as { kind?: unknown; type?: unknown; command?: unknown; action?: unknown };
    if (
      payload.kind === 'stop' ||
      payload.type === 'stop' ||
      payload.command === 'stop' ||
      payload.action === 'stop'
    ) {
      return true;
    }
  }

  const content = contentToPlainText(msg.payload).trim();
  return /^(?:stop|停止|终止|取消)$/iu.test(content);
}

/** 是否是暂停命令 */
export function isPauseMessage(msg: InboxRawMessage): boolean {
  if (msg.type === 'pause') return true;
  if (typeof msg.payload === 'object' && msg.payload !== null) {
    const payload = msg.payload as { kind?: unknown; action?: unknown };
    if (payload.kind === 'pause' || payload.action === 'pause') return true;
  }
  const content = contentToPlainText(msg.payload).trim();
  return /^(?:pause|暂停)$/iu.test(content);
}

/** 是否是干预指令；返回干预正文，没有则返回 null */
export function parseInterveneMessage(msg: InboxRawMessage): string | null {
  if (msg.type === 'intervene') {
    return contentToPlainText(msg.payload).trim();
  }
  if (typeof msg.payload === 'object' && msg.payload !== null) {
    const payload = msg.payload as { kind?: unknown; instruction?: unknown };
    if (payload.kind === 'intervene' && typeof payload.instruction === 'string') {
      return payload.instruction.trim();
    }
  }
  const content = contentToPlainText(msg.payload).trim();
  // 干预消息格式: [INTERVENE: 指令内容]
  const match = content.match(/^\[INTERVENE:\s*(.+)\]$/i);
  return match ? match[1].trim() : null;
}

/** 解析 [INTERVENTION:type] 控制指令；非控制返回 null */
export function parseInterventionControl(msg: InboxRawMessage): ParsedIntervention | null {
  if (msg.type === 'control' && msg.payload && typeof msg.payload === 'object') {
    const payload = msg.payload as {
      action?: unknown;
      message?: unknown;
      reason?: unknown;
      model?: unknown;
      newModel?: unknown;
    };
    const action = String(payload.action || '');
    if (action === 'nudge' || action === 'redirect') {
      return {
        type: 'nudge',
        param: contentToPlainText(payload.message || payload.reason || '请检查当前进展并换一种策略继续。'),
      };
    }
    if (action === 'retry_llm') {
      return { type: 'retry_llm' };
    }
    if (action === 'swap_model') {
      return { type: 'swap_model', param: contentToPlainText(payload.model || payload.newModel || '') };
    }
    if (action === 'compact_context') {
      return { type: 'compact_context' };
    }
  }

  const content = contentToPlainText(msg.payload).trim();
  const match = content.match(/^\[INTERVENTION:(\w+)(?::([^\]]+))?\]\s*([\s\S]*)$/);
  if (!match) return null;
  const interventionType = match[1] as 'retry_llm' | 'swap_model' | 'nudge' | 'compact_context';
  if (!['retry_llm', 'swap_model', 'nudge', 'compact_context'].includes(interventionType)) return null;
  const bracketParam = match[2]?.trim();
  const trailingParam = match[3]?.trim();
  return { type: interventionType, param: bracketParam || trailingParam };
}

/** 是否是 [RESUME] / 继续 / 恢复 等恢复信号 */
export function isResumeMessage(msg: InboxRawMessage): boolean {
  const content = contentToPlainText(msg.payload).trim();
  return content === '[RESUME]' || content === '继续' || content === '恢复';
}

/** 是否是干预确认信号 */
export function isInterventionConfirmMessage(msg: InboxRawMessage): boolean {
  const content = contentToPlainText(msg.payload).trim();
  return content === '[CONTINUE]' || content === '继续' || content === '确认继续';
}

/**
 * 把入站消息渲染成 Agent 对话内容。
 * - team protocol 消息：`[来自X的team消息][type] content`
 * - ContentPart 数组（多模态）：在第一条 text 前缀加发送者标签
 * - 纯文本：`[来自X的消息]: content`
 */
export function formatIncomingContent(
  msg: InboxRawMessage,
): string | MessageContentPart[] {
  const teamProtocolMessage = parseProtocolPayload(msg.payload);
  const senderLabel = teamProtocolMessage?.from
    ?? (msg.from === 'user' ? '用户' : msg.from || '外部');

  if (teamProtocolMessage) {
    return `[来自${senderLabel}的team消息][${teamProtocolMessage.type}] ${teamProtocolMessage.content}`;
  }

  if (isContentPartArray(msg.payload)) {
    const next: MessageContentPart[] = msg.payload.map((part) => {
      if (part.type === 'text') return { type: 'text' as const, text: part.text };
      if (part.type === 'image_url') {
        return {
          type: 'image_url' as const,
          image_url: { ...part.image_url },
        };
      }
      return { ...part };
    });
    const firstTextIndex = next.findIndex((part) => part.type === 'text');
    if (firstTextIndex >= 0) {
      const firstText = next[firstTextIndex] as { type: 'text'; text: string };
      next[firstTextIndex] = {
        type: 'text',
        text: `[来自${msg.from}的消息]: ${firstText.text}`,
      };
    } else {
      next.unshift({ type: 'text', text: `[来自${msg.from}的消息]` });
    }
    return next;
  }

  const content = contentToPlainText(msg.payload);
  return `[来自${senderLabel}的消息]: ${content}`;
}

/** 解析消息后用于 UI/日志展示的发送方标签 */
export function resolveSenderLabel(msg: InboxRawMessage): string {
  const teamProtocolMessage = parseProtocolPayload(msg.payload);
  return teamProtocolMessage?.from
    ?? (msg.from === 'user' ? '用户' : msg.from || '外部');
}
