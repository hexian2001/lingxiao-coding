import type { CommandLogMessage } from '../../commands/types.js';
import { extractToolDiff } from './toolDiff.js';
import { t } from '../../i18n.js';

function isPayloadRecord(payload: unknown): payload is Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return t('tui.tool.unserializable');
  }
}

export function summarizeToolCall(toolName: string, input: unknown): {
  summary: string;
  meta: string;
  preview: string;
} {
  const raw = stringifyPayload(input);
  const args = isPayloadRecord(input) ? input : undefined;

  if (!args) {
    return { summary: t('tui.tool.summary.calling', toolName), meta: '', preview: raw };
  }

  if (toolName === 'file_read') {
    const path = stringField(args, 'path') || '';
    const startLine = numberField(args, 'start_line') || 1;
    const endLine = numberField(args, 'end_line');
    const lineInfo = endLine ? `:${startLine}-${endLine}` : (startLine > 1 ? `:${startLine}+` : '');
    return { summary: t('tui.tool.summary.reading', path, lineInfo), meta: path || toolName, preview: raw };
  }
  if (toolName === 'list_directory') {
    const path = stringField(args, 'path') || '.';
    return { summary: t('tui.tool.summary.listing', path), meta: path, preview: raw };
  }
  if (toolName === 'web_fetch') {
    const url = stringField(args, 'url') || '';
    return { summary: t('tui.tool.summary.fetching', url), meta: url || toolName, preview: raw };
  }
  if (toolName === 'web_search') {
    const query = stringField(args, 'query') || '';
    return { summary: t('tui.tool.summary.searching', query), meta: query || toolName, preview: raw };
  }
  if (toolName === 'file_write') {
    const path = stringField(args, 'path') || '';
    return { summary: t('tui.tool.summary.writing', path), meta: path || toolName, preview: raw };
  }
  if (toolName === 'shell') {
    const command = stringField(args, 'command') || '';
    const cmdPreview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
    return { summary: t('tui.tool.summary.running', cmdPreview), meta: toolName, preview: raw };
  }
  const argKeys = Object.keys(args);
  return {
    summary: argKeys.length > 0 ? t('tui.tool.summary.args', argKeys.slice(0, 3).join(', ')) : t('tui.tool.summary.calling', toolName),
    meta: '',
    preview: raw,
  };
}

export function summarizeToolResult(toolName: string, result: unknown): {
  summary: string;
  meta: string;
  preview: string;
} {
  const raw = stringifyPayload(result).trim();

  if (toolName === 'file_read') {
    const lineNumbers = raw.match(/^\s*(\d+)→/gm);
    if (lineNumbers && lineNumbers.length > 0) {
      const firstLine = parseInt(lineNumbers[0].match(/\d+/)?.[0] || '1', 10);
      const lastLine = parseInt(lineNumbers[lineNumbers.length - 1].match(/\d+/)?.[0] || '1', 10);
      const totalRead = lineNumbers.length;
      const lineRange = firstLine === lastLine ? t('tui.tool.result.line_single', firstLine) : t('tui.tool.result.line_range', firstLine, lastLine);
      return { summary: t('tui.tool.result.read_lines', lineRange, totalRead), meta: toolName, preview: raw };
    }
    const charCount = raw.length;
    return { summary: charCount > 0 ? t('tui.tool.result.read_chars', charCount) : t('tui.tool.result.no_output'), meta: '', preview: raw };
  }
  if (toolName === 'list_directory') {
    const entries = raw.split('\n').filter(Boolean);
    const fileCount = entries.filter((entry) => !entry.endsWith('/')).length;
    const dirCount = entries.filter((entry) => entry.endsWith('/')).length;
    return {
      summary: t('tui.tool.result.listed', entries.length, fileCount, dirCount),
      meta: '',
      preview: raw,
    };
  }
  if (toolName === 'web_fetch') {
    const charCount = raw.length;
    return { summary: t('tui.tool.result.fetched', charCount), meta: '', preview: raw };
  }
  if (toolName === 'web_search') {
    const resultCount = (raw.match(/"title"/g) || []).length || (raw.match(/\d+\./g) || []).length;
    return { summary: t('tui.tool.result.searched', resultCount), meta: '', preview: raw };
  }
  // Generic result: show character count for brevity
  const charCount = raw.length;
  return { summary: charCount > 0 ? t('tui.tool.result.generic', charCount) : t('tui.tool.result.no_output'), meta: '', preview: raw };
}

export function buildToolCallLogMessage(toolName: string, input: unknown): CommandLogMessage {
  const info = summarizeToolCall(toolName, input);
  const toolDiff = toolName === 'structured_patch' && isPayloadRecord(input)
    ? extractToolDiff(toolName, input)
    : undefined;
  return {
    type: 'tool',
    content: t('tui.tool.call', toolName, info.preview),
    toolName,
    toolKind: 'call',
    toolSummary: info.summary,
    toolMeta: info.meta,
    toolDiff,
    toolStartedAt: Date.now(),
  };
}

export function buildToolResultLogMessage(toolName: string, result: unknown): CommandLogMessage {
  const info = summarizeToolResult(toolName, result);
  return {
    type: 'tool',
    content: t('tui.tool.result', toolName, info.preview),
    toolName,
    toolKind: 'result',
    toolSummary: info.summary,
    toolMeta: info.meta,
  };
}
