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
export function getExportFilename(sessionId?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const id = sessionId ? sessionId.slice(0, 8) : 'chat';
  return `lingxiao-${id}-${date}.md`;
}
