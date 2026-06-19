/**
 * MessageByteTruncator — 单条巨型消息的「中段截断 + 全文归档」
 *
 * 动机：HTTP 413 "Payload Too Large" 是网关对**请求体字节**的限制。现有压缩链路
 * （CompressionPipeline / performContextReset）只能按整条 pop 消息，对「单条就有
 * 几十万 token 的巨型消息」（一次粘贴的长文 / 巨大工具结果 / 长 assistant 回复）
 * 无能为力——这条消息若落在 pinned（首 user）或 recent 窗口里就被原样保留，
 * token 与字节都降不下来，导致反复 413 死循环。
 *
 * 本模块对超过阈值的单条消息做中段截断：保留头部 + 尾部，中段替换为占位符，
 * 并把**完整原文**写入归档盘（无损可追溯）。tool_call_id / role / tool_calls
 * 等字段原样保留，维持 tool_use ↔ tool_result 配对完整性，避免下游 sanitizer 报错。
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  contentToPlainText,
  type ChatMessage,
  type MessageContentPart,
} from '../../llm/types.js';
import { calculateMessageBytes } from './ContextTokenCalculator.js';
import type { ContextOwner } from './CompressionTypes.js';

const DEFAULT_HEAD_RATIO = 0.4;
const DEFAULT_TAIL_RATIO = 0.2;

export interface OversizedArchiveInfo {
  /** 消息在原数组中的下标 */
  index: number;
  role: ChatMessage['role'];
  /** 截断前的字节数 */
  bytes: number;
  /** 完整原文（纯文本视图，供归档） */
  fullText: string;
}

/** 归档写入器：写入完整原文，返回归档路径（失败返回 undefined）。 */
export type OversizedArchiveWriter = (info: OversizedArchiveInfo) => string | undefined;

export interface TruncateOversizedOptions {
  /** 单条消息字节上限，超过即截断 */
  maxSingleMessageBytes: number;
  /** 归档写入器（可选）；提供则把完整原文写盘并在占位符里附路径 */
  archiveWriter?: OversizedArchiveWriter;
  /** 头部保留比例（相对 maxSingleMessageBytes），默认 0.4 */
  headRatio?: number;
  /** 尾部保留比例（相对 maxSingleMessageBytes），默认 0.2 */
  tailRatio?: number;
}

export interface TruncateOversizedResult {
  /** 处理后的消息列表（未超限的条目为原对象引用） */
  messages: ChatMessage[];
  /** 被截断的条数 */
  truncatedCount: number;
  /** 节省的字节数 */
  bytesSaved: number;
}

/**
 * 对超过单条字节上限的消息做中段截断。未超限的消息原样返回（保持引用）。
 */
export function truncateOversizedMessages(
  messages: ChatMessage[],
  opts: TruncateOversizedOptions,
): TruncateOversizedResult {
  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO;
  const tailRatio = opts.tailRatio ?? DEFAULT_TAIL_RATIO;
  const headBudget = Math.max(1, Math.floor(opts.maxSingleMessageBytes * headRatio));
  const tailBudget = Math.max(1, Math.floor(opts.maxSingleMessageBytes * tailRatio));

  let truncatedCount = 0;
  let bytesSaved = 0;

  const out = messages.map((msg, index) => {
    const bytes = calculateMessageBytes(msg);
    if (bytes <= opts.maxSingleMessageBytes) {
      return msg;
    }
    const truncated = truncateMessage(msg, index, bytes, headBudget, tailBudget, opts.archiveWriter);
    if (!truncated) {
      return msg;
    }
    truncatedCount += 1;
    bytesSaved += bytes - calculateMessageBytes(truncated);
    return truncated;
  });

  return { messages: out, truncatedCount, bytesSaved };
}

function truncateMessage(
  msg: ChatMessage,
  index: number,
  bytes: number,
  headBudget: number,
  tailBudget: number,
  archiveWriter?: OversizedArchiveWriter,
): ChatMessage | null {
  const fullText = contentToPlainText(msg.content);
  const archivePath = archiveWriter?.({ index, role: msg.role, bytes, fullText });
  const placeholder = buildPlaceholder(bytes, archivePath);

  // 字符串内容：直接头尾保留 + 中段占位。
  if (typeof msg.content === 'string') {
    const newText = truncateStringToBytes(msg.content, headBudget, tailBudget, placeholder);
    return { ...msg, content: newText };
  }

  // 数组内容：截断超大文本块；超大 image_url（巨型 base64）替换为占位文本块；
  // 其余小块原样保留，维持结构与 tool 配对。
  if (Array.isArray(msg.content)) {
    const newParts: MessageContentPart[] = msg.content.map((part) => {
      if (!part || typeof part !== 'object' || !('type' in part)) {
        return part;
      }
      if (part.type === 'text') {
        const partBytes = Buffer.byteLength(part.text || '', 'utf8');
        if (partBytes > headBudget + tailBudget) {
          return { type: 'text', text: truncateStringToBytes(part.text || '', headBudget, tailBudget, placeholder) };
        }
        return part;
      }
      if (part.type === 'image_url') {
        const urlBytes = Buffer.byteLength(part.image_url?.url || '', 'utf8');
        if (urlBytes > headBudget + tailBudget) {
          return { type: 'text', text: `[超大内联图片已移除以规避请求体上限${archivePath ? `，原文见归档: ${archivePath}` : ''}]` };
        }
        return part;
      }
      return part;
    });
    return { ...msg, content: newParts };
  }

  return null;
}

function buildPlaceholder(originalBytes: number, archivePath?: string): string {
  const kb = Math.round(originalBytes / 1024);
  const archiveNote = archivePath ? `完整原文见归档: ${archivePath}` : '完整原文未归档';
  return `\n\n[... 中段已截断（原 ${kb}KB 超单条字节上限），${archiveNote} ...]\n\n`;
}

/**
 * 按 UTF-8 字节保留头部 headBytes + 尾部 tailBytes，中间插入占位符。
 * code-point 安全（不切断 surrogate pair）。
 */
export function truncateStringToBytes(
  text: string,
  headBytes: number,
  tailBytes: number,
  placeholder: string,
): string {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= headBytes + tailBytes) {
    return text;
  }
  const head = sliceByBytesFromStart(text, headBytes);
  const tail = sliceByBytesFromEnd(text, tailBytes);
  return head + placeholder + tail;
}

function sliceByBytesFromStart(text: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const charLen = cp !== undefined && cp > 0xffff ? 2 : 1;
    const ch = text.substr(i, charLen);
    const cb = Buffer.byteLength(ch, 'utf8');
    if (bytes + cb > maxBytes) break;
    bytes += cb;
    i += charLen;
  }
  return text.slice(0, i);
}

function sliceByBytesFromEnd(text: string, maxBytes: number): string {
  let bytes = 0;
  let i = text.length;
  while (i > 0) {
    let start = i - 1;
    if (start > 0) {
      const prev = text.charCodeAt(start - 1);
      const cur = text.charCodeAt(start);
      // 前一个是高代理、当前是低代理 → 合成一个 code point
      if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) {
        start -= 1;
      }
    }
    const ch = text.slice(start, i);
    const cb = Buffer.byteLength(ch, 'utf8');
    if (bytes + cb > maxBytes) break;
    bytes += cb;
    i = start;
  }
  return text.slice(i);
}

/**
 * 构造一个把超大原文写入会话归档盘的同步归档写入器。
 * 路径约定与 CompressionPipeline 的压缩归档一致：
 *   leader → workspace/.lingxiao/sessions/<sessionId>/context/leader
 *   agent  → workspace/.lingxiao/sessions/<sessionId>/context/agents/<agentId>
 * 缺少 workspace/sessionId 时返回 undefined（不归档，仍会截断）。
 */
export function createOversizedArchiveWriter(params: {
  owner: ContextOwner;
  sessionId?: string;
}): OversizedArchiveWriter | undefined {
  const { owner, sessionId } = params;
  if (!owner.workspace || !sessionId) {
    return undefined;
  }
  return (info: OversizedArchiveInfo): string | undefined => {
    try {
      const scopeDir = owner.kind === 'agent'
        ? join(owner.workspace!, '.lingxiao', 'sessions', sessionId, 'context', 'agents', owner.agentId || 'unknown')
        : join(owner.workspace!, '.lingxiao', 'sessions', sessionId, 'context', 'leader');
      mkdirSync(scopeDir, { recursive: true });
      const safeOwner = (owner.agentName || owner.agentId || owner.kind).replace(/[^a-zA-Z0-9_-]+/g, '_');
      const filePath = join(scopeDir, `oversized-${Date.now()}-m${info.index}-${safeOwner}.md`);
      const content = [
        '# Oversized Message Archive',
        '',
        `- session_id: ${sessionId}`,
        `- owner: ${owner.kind}${owner.agentName ? `/${owner.agentName}` : ''}`,
        `- message_index: ${info.index}`,
        `- role: ${info.role}`,
        `- original_bytes: ${info.bytes}`,
        `- created_at: ${new Date().toISOString()}`,
        '',
        '## Full Original Content',
        info.fullText,
        '',
      ].join('\n');
      writeFileSync(filePath, content, 'utf-8');
      return filePath;
    } catch {/* expected: resource not available */
      return undefined;
    }
  };
}
