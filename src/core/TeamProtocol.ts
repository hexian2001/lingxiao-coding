/**
 * TeamProtocol — message / broadcast 通信骨架
 *
 * 历史上这里曾承载 shutdown_request / plan_approval_request / ack 等"协议"
 * 头，但配套的 router、pending request 跟踪、TeamSendMessage 入口字段从未
 * 全部接通；2026-05-27 静态审计确认这些路径完全是空头支票（只有声明、
 * 没有发送方与消费方），因此本文件只保留实际活着的两类：
 *   - message    — 同 team 内 P2P
 *   - broadcast  — 同 team 内全员
 *
 * 链路：TeamSendMessage → TeamMailbox → TeamCommunicationService → MessageBus
 *      → BaseAgent.parseProtocolPayload。
 */

import { buildCollaborationAwarenessBlock } from './ArtifactAwareness.js';

export type TeamProtocolType = 'message' | 'broadcast';

export type CollaborationIntent =
  | 'message'
  | 'transfer_request'
  | 'transfer_accept'
  | 'review_request'
  | 'review_result'
  | 'clarification_request'
  | 'pairing_request'
  | 'conflict_notice'
  | 'coordination_result'
  | 'decision_record';

export interface CollaborationMetadata {
  intent: CollaborationIntent;
  taskId?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  artifactPaths?: string[];
  evidenceRefs?: string[];
  requiresAck?: boolean;
  requestId?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';
  summary?: string;
  nextAction?: string;
  participants?: string[];
}

export interface TeamProtocolMessage {
  id: string;
  type: TeamProtocolType;
  from: string;           // agent name
  to: string;             // agent name 或 '*' (broadcast)
  content: string;
  summary: string;        // 5-10 字摘要，UI 预览用
  urgency: 'normal' | 'urgent';
  timestamp: number;
  sessionId: string;
  metadata?: Partial<CollaborationMetadata> & Record<string, unknown>;
}

/**
 * 把 TeamProtocolMessage 序列化为注入 LLM 上下文的文本格式。
 */
export function formatProtocolMessageForContext(msg: TeamProtocolMessage): string {
  const intent = msg.metadata?.intent && msg.metadata.intent !== 'message' ? `:${msg.metadata.intent}` : '';
  const prefix = msg.type === 'broadcast' ? `[team broadcast${intent}]` : `[team message${intent}]`;
  const fromLabel = `@${msg.from}`;
  const metaParts = [
    msg.metadata?.taskId ? `task=${msg.metadata.taskId}` : '',
    msg.metadata?.sourceTaskId ? `source=${msg.metadata.sourceTaskId}` : '',
    msg.metadata?.targetTaskId ? `target=${msg.metadata.targetTaskId}` : '',
    msg.metadata?.verdict ? `verdict=${msg.metadata.verdict}` : '',
    msg.metadata?.requestId ? `request=${msg.metadata.requestId}` : '',
  ].filter(Boolean);
  const meta = metaParts.length > 0
    ? ` (${metaParts.join(' · ')})`
    : '';
  const awareness = buildCollaborationAwarenessBlock({
    from: msg.from,
    to: msg.to,
    content: msg.content,
    metadata: msg.metadata,
  });
  return `${prefix} ${fromLabel}${meta}: ${msg.content}${awareness ? `\n${awareness}` : ''}`;
}

/**
 * 从 TeamMailbox 记录构造结构化协议消息。
 */
export function createProtocolMessage(input: {
  id: string;
  from: string;
  to: string;
  sessionId: string;
  rawContent: string;
  urgency: 'normal' | 'urgent';
  timestamp: number;
  metadata?: Partial<CollaborationMetadata> & Record<string, unknown>;
}): TeamProtocolMessage {
  return {
    id: input.id,
    type: 'message',
    from: input.from,
    to: input.to,
    content: input.rawContent,
    summary: input.rawContent.slice(0, 50),
    urgency: input.urgency,
    timestamp: input.timestamp,
    sessionId: input.sessionId,
    metadata: input.metadata,
  };
}

/**
 * 尝试从 bus 消息 payload 中解析协议消息
 */
export function parseProtocolPayload(payload: unknown): TeamProtocolMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj._protocol === 'team' && obj.message && typeof obj.message === 'object') {
    return obj.message as TeamProtocolMessage;
  }
  return null;
}

/**
 * 包装协议消息为 bus payload
 */
export function wrapProtocolPayload(msg: TeamProtocolMessage): { _protocol: 'team'; message: TeamProtocolMessage } {
  return { _protocol: 'team', message: msg };
}
