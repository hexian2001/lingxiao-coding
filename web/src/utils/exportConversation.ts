/**
 * Export conversation utilities
 *
 * Converts chat messages to Markdown for export/download/clipboard.
 */

import type { Message, ToolCall } from '../stores/sessionStore';

// ─── Helpers ───

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatToolCall(tc: ToolCall): string {
  const input = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2);
  const result = tc.result
    ? (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2))
    : '';
  const truncated = input.length > 500 ? input.slice(0, 500) + '...' : input;
  const resultTruncated = result.length > 500 ? result.slice(0, 500) + '...' : result;

  let md = `> **Tool: ${tc.tool}** (${tc.status})\n`;
  md += `> \`\`\`\n> ${truncated.split('\n').join('\n> ')}\n> \`\`\`\n`;
  if (resultTruncated) {
    md += `> **Result:**\n> \`\`\`\n> ${resultTruncated.split('\n').join('\n> ')}\n> \`\`\`\n`;
  }
  return md;
}

// ─── Main export function ───

/**
 * Convert messages to a Markdown string.
 */
export function messagesToMarkdown(messages: Message[], title?: string): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`> Exported: ${formatTimestamp(Date.now())}`);
  lines.push(`> Messages: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? '**You**' : msg.role === 'assistant' ? '**Assistant**' : `**${msg.role}**`;
    const time = formatTimestamp(msg.timestamp);

    lines.push(`### ${roleLabel}  _(${time})_`);
    lines.push('');

    // Thinking content
    if (msg.thinkingContent) {
      lines.push('<details>');
      lines.push('<summary>Thinking process</summary>');
      lines.push('');
      lines.push(msg.thinkingContent);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    // Main content
    if (msg.content) {
      lines.push(msg.content);
      lines.push('');
    }

    // Tool calls
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push('<details>');
      lines.push(`<summary>Tool calls (${msg.toolCalls.length})</summary>`);
      lines.push('');
      for (const tc of msg.toolCalls) {
        lines.push(formatToolCall(tc));
      }
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Download content as a file.
 */
export function downloadAsFile(content: string, filename: string, mimeType = 'text/markdown'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Copy text to clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Generate a filename for the export.
 */
export function getExportFilename(sessionId?: string, ext = 'md'): string {
  const date = new Date().toISOString().slice(0, 10);
  const id = sessionId ? sessionId.slice(0, 8) : 'chat';
  return `lingxiao-${id}-${date}.${ext}`;
}

// ─── JSON export (凌霄对话格式) ───

/**
 * 导出 JSON 中单条工具调用记录的精简结构
 */
export interface ExportedToolCall {
  id: string;
  tool: string;
  input: unknown;
  result?: unknown;
  status: string;
  startedAt?: number;
  endedAt?: number;
}

/**
 * 导出 JSON 中单条消息记录的精简结构
 */
export interface ExportedMessage {
  id: string;
  role: string;
  content: string;
  thinkingContent?: string;
  toolCalls?: ExportedToolCall[];
  timestamp: number;
}

/**
 * 凌霄对话导出 JSON 的顶层格式
 */
export interface LingxiaoConversationExport {
  /** 格式标识，固定为 'lingxiao-conversation' */
  format: 'lingxiao-conversation';
  /** 格式版本号 */
  version: 1;
  /** 导出时间戳（毫秒） */
  exportedAt: number;
  /** 会话 ID */
  sessionId?: string;
  /** 会话标题/摘要 */
  title?: string;
  /** 工作区路径 */
  workspace?: string;
  /** 消息列表 */
  messages: ExportedMessage[];
}

/**
 * 将前端 Message[] 转换为凌霄对话 JSON 导出对象。
 * 过滤掉正在流式传输的中间状态消息，保证导出数据干净。
 */
export function messagesToLingxiaoJSON(
  messages: Message[],
  meta?: { sessionId?: string; title?: string; workspace?: string },
): LingxiaoConversationExport {
  const exportedMessages: ExportedMessage[] = [];

  for (const msg of messages) {
    // 跳过纯流式占位（无实质内容且仍在流式）
    if (msg.isStreaming && !msg.content && !msg.thinkingContent && !(msg.toolCalls && msg.toolCalls.length > 0)) {
      continue;
    }

    const em: ExportedMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content || '',
      timestamp: msg.timestamp,
    };

    if (msg.thinkingContent) {
      em.thinkingContent = msg.thinkingContent;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      em.toolCalls = msg.toolCalls.map((tc): ExportedToolCall => {
        const etc: ExportedToolCall = {
          id: tc.id,
          tool: tc.tool,
          input: tc.input,
          status: tc.status,
        };
        if (tc.result !== undefined) etc.result = tc.result;
        if (tc.startedAt !== undefined) etc.startedAt = tc.startedAt;
        if (tc.endedAt !== undefined) etc.endedAt = tc.endedAt;
        return etc;
      });
    }

    exportedMessages.push(em);
  }

  return {
    format: 'lingxiao-conversation',
    version: 1,
    exportedAt: Date.now(),
    sessionId: meta?.sessionId,
    title: meta?.title,
    workspace: meta?.workspace,
    messages: exportedMessages,
  };
}

/**
 * 导出为 JSON 字符串（2 空格缩进）。
 */
export function messagesToJSON(messages: Message[], meta?: { sessionId?: string; title?: string; workspace?: string }): string {
  return JSON.stringify(messagesToLingxiaoJSON(messages, meta), null, 2);
}

/**
 * 下载 JSON 文件。
 */
export function downloadJSON(jsonStr: string, filename: string): void {
  downloadAsFile(jsonStr, filename, 'application/json');
}

// ─── JSON import ───

/**
 * 导入 JSON 解析结果
 */
export interface ImportedConversation {
  format: string;
  version: number;
  sessionId?: string;
  title?: string;
  workspace?: string;
  messages: ExportedMessage[];
}

/**
 * 校验并解析凌霄对话 JSON 字符串。
 * 兼容两种输入：
 *   1) 标准凌霄格式 { format: 'lingxiao-conversation', ... }
 *   2) 裸消息数组 [ { role, content, ... }, ... ]
 * 抛出 Error 表示格式不合法。
 */
export function parseLingxiaoJSON(jsonStr: string): ImportedConversation {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error('JSON 格式错误：无法解析，请检查文件内容是否为有效的 JSON。');
  }

  // 情况 1：裸数组（每条消息）
  if (Array.isArray(data)) {
    return normalizeMessageArray(data);
  }

  // 情况 2：标准凌霄导出对象
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // 标准 lingxiao-conversation 格式
    if (obj.format === 'lingxiao-conversation' || obj.messages !== undefined) {
      const messages = obj.messages;
      if (!Array.isArray(messages)) {
        throw new Error('格式错误：messages 字段不是数组。');
      }
      return {
        format: (obj.format as string) || 'lingxiao-conversation',
        version: (obj.version as number) || 1,
        sessionId: obj.sessionId as string | undefined,
        title: obj.title as string | undefined,
        workspace: obj.workspace as string | undefined,
        messages: messages as ExportedMessage[],
      };
    }

    // 可能是单条消息对象
    if (obj.role !== undefined && obj.content !== undefined) {
      return normalizeMessageArray([obj]);
    }
  }

  throw new Error('格式错误：无法识别的 JSON 结构。期望凌霄对话导出格式或消息数组。');
}

function normalizeMessageArray(arr: unknown[]): ImportedConversation {
  const messages: ExportedMessage[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${i + 1} 条消息不是有效对象。`);
    }
    const m = item as Record<string, unknown>;
    if (typeof m.role !== 'string') {
      throw new Error(`第 ${i + 1} 条消息缺少 role 字段。`);
    }
    messages.push({
      id: (m.id as string) || `imported-${i}`,
      role: m.role as string,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      thinkingContent: m.thinkingContent as string | undefined,
      toolCalls: m.toolCalls as ExportedToolCall[] | undefined,
      timestamp: (m.timestamp as number) || Date.now() + i,
    });
  }
  return {
    format: 'lingxiao-conversation',
    version: 1,
    messages,
  };
}

/**
 * 从浏览器 File 对象读取文本内容。
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result || ''));
    };
    reader.onerror = () => reject(new Error('文件读取失败。'));
    reader.readAsText(file);
  });
}
