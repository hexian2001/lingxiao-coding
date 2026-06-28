import type { ToolCallStatus } from './Status.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  result: unknown;
  status: ToolCallStatus;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface BaseMessage {
  id: string;
  role: MessageRole;
  content: string | ContentBlock[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface ImageBlobRefContentPart {
  type: 'image_blob_ref';
  blob_id: string;
  mime: string;
  size: number;
  blob_path: string;
  source?: string;
}
/**
 * MCP Apps 交互式 UI 组件 part。
 * 当 MCP Server 在 CallToolResult content block 的 _meta.lingxiao_app 中标记交互式 HTML 时，
 * BaseAgentRuntime 提取为 mcp_app part，前端以 sandbox iframe 渲染。
 */
export interface McpAppContentPart {
  type: 'mcp_app';
  html: string;
  title?: string;
  height?: number | 'auto';
  actions?: Array<{ label: string; event: string; data?: unknown }>;
}


export type MessageContentPart = TextBlock | ImageUrlContentPart | ImageBlobRefContentPart | McpAppContentPart;
export type MessageContent = string | MessageContentPart[] | null;
export type LlmThinkingBlock = ThinkingBlock | RedactedThinkingBlock;

export function isContentPartArray(content: MessageContent | unknown): content is MessageContentPart[] {
  return Array.isArray(content);
}

export function contentToPlainText(content: MessageContent | unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? '' : JSON.stringify(content);
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || !('type' in part)) {
        return '';
      }
      if (part.type === 'text') {
        return part.text || '';
      }
      if (part.type === 'image_url') {
        return '[image]';
      }
      if (part.type === 'image_blob_ref') {
        const blobId = part.blob_id ?? 'unknown';
        return `[image: ${part.mime}, ${Math.max(1, Math.round(part.size / 1024))}KB stored as blob:${blobId.slice(0, 12)}]`;
      }
      try {
        return JSON.stringify(part);
      } catch {/* expected: fallback to default */
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

export function hasImageContent(content: MessageContent | unknown): boolean {
  return Array.isArray(content) && content.some((part) => part?.type === 'image_url' || part?.type === 'image_blob_ref');
}

/**
 * Directive prefix `@<agent> <body>` that routes a user message directly to a
 * specific agent instead of the Leader. The match runs against the leading text
 * of the message — a plain string, or the first text part of a structured
 * (multimodal) array. Non-text parts (images, file refs) are preserved verbatim
 * in `rest` so attachments route together with the directive.
 *
 * Returns null when there is no leading `@agent` directive (or no text part to
 * match against), so callers fall through to normal Leader input. Routing is
 * keyed off message *semantics*, never the wire shape (string vs array), which
 * is why a message with an image attachment still routes correctly.
 */
export interface AgentMention {
  agentName: string;
  /** Message content with the `@agent ` prefix stripped; non-text parts kept intact. */
  rest: MessageContent;
}

const AGENT_MENTION_PATTERN = /^@([A-Za-z0-9_.-]+)\s+([\s\S]+)$/;

export function extractAgentMention(content: MessageContent | unknown): AgentMention | null {
  if (typeof content === 'string') {
    const match = content.match(AGENT_MENTION_PATTERN);
    if (!match) return null;
    return { agentName: match[1], rest: match[2].trim() };
  }

  if (Array.isArray(content)) {
    const firstTextIndex = content.findIndex(
      (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text',
    );
    if (firstTextIndex === -1) return null;
    const firstText = content[firstTextIndex] as TextBlock;
    const match = (firstText.text || '').match(AGENT_MENTION_PATTERN);
    if (!match) return null;

    // Rebuild content with the directive stripped from the matched text part;
    // every other part (images, file refs) is carried through unchanged so the
    // attachment lands in the agent's inbox, not the Leader's.
    const rest: MessageContentPart[] = content.map((part, index) =>
      index === firstTextIndex ? { type: 'text' as const, text: match[2].trim() } : part,
    );
    return { agentName: match[1], rest };
  }

  return null;
}

export function isEmptyContent(content: MessageContent | unknown): boolean {
  if (content === null || content === undefined) {
    return true;
  }
  if (typeof content === 'string') {
    return !content.trim();
  }
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return true;
    }
    return content.every((part) => {
      if (!part || typeof part !== 'object') return false;
      if (part.type === 'text') {
        return !(part as { text?: string }).text?.trim();
      }
      return false;
    });
  }
  return false;
}

export function normalizeMessageContent(content: unknown): MessageContent {
  if (content === null || content === undefined) {
    return null;
  }
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }

  const normalized: MessageContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || !('type' in part)) {
      continue;
    }
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      normalized.push({ type: 'text', text: part.text });
      continue;
    }
    if (
      part.type === 'image_url' &&
      'image_url' in part &&
      part.image_url &&
      typeof part.image_url === 'object' &&
      'url' in part.image_url &&
      typeof part.image_url.url === 'string'
    ) {
      normalized.push({
        type: 'image_url',
        image_url: {
          url: part.image_url.url,
          detail:
            'detail' in part.image_url &&
            (part.image_url.detail === 'auto' || part.image_url.detail === 'low' || part.image_url.detail === 'high')
              ? part.image_url.detail
              : undefined,
        },
      });
      continue;
    }
    if (
      part.type === 'image_blob_ref' &&
      'blob_id' in part &&
      typeof part.blob_id === 'string' &&
      'mime' in part &&
      typeof part.mime === 'string' &&
      'size' in part &&
      typeof part.size === 'number' &&
      'blob_path' in part &&
      typeof part.blob_path === 'string'
    ) {
      normalized.push({
        type: 'image_blob_ref',
        blob_id: part.blob_id,
        mime: part.mime,
        size: part.size,
        blob_path: part.blob_path,
        source: 'source' in part && typeof part.source === 'string' ? part.source : undefined,
      });
    }
  }

  return normalized.length > 0 ? normalized : contentToPlainText(content);
}

export function thinkingBlocksToText(blocks?: LlmThinkingBlock[] | null): string {
  if (!blocks || blocks.length === 0) return '';
  return blocks
    .map((block) => (block.type === 'thinking' ? block.text : '[redacted]'))
    .filter(Boolean)
    .join('\n');
}

