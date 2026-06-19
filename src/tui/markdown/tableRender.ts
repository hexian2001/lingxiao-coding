/**
 * 表格解析与渲染（纯函数，零 JSX）。
 *
 * 从原 TableRenderer React 组件（死代码，从未接入主路径）提取渲染算法，
 * 供行级管线 buildMessageLogView 拍平成逐行 RenderedLogLine。每行带 ANSI
 * 着色串透传给 Ink <Text>（ink 6.8 sanitize-ansi 保留 SGR 序列，已验证）。
 *
 * 提供：
 * - parsePipeTable: GFM 表格判定（连续 pipe 行 + 分隔行），确定性。
 * - renderTableToLines: 把表头/行/对齐渲染成 {ansiLines, plainLines}，
 *   含列宽自适应、窄终端竖排兜底。plainLines 供选择/复制（去 ANSI + markdown 标记）。
 */

import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';
import { t } from '../../i18n.js';
import { getCachedStringWidth } from './textUtils.js';
import { replaceInlineMath } from './mathParse.js';
import { tuiTheme } from '../theme.js';

export type ColumnAlign = 'left' | 'center' | 'right';

const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;
const SAFETY_MARGIN = 4;

// ── ANSI 着色工具（与原 TableRenderer 一致）──────────────────────────
const INK_COLOR_TO_ANSI: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34,
  magenta: 35, cyan: 36, white: 37, gray: 90, grey: 90,
  blackbright: 90, redbright: 91, greenbright: 92,
  yellowbright: 93, bluebright: 94, magentabright: 95,
  cyanbright: 96, whitebright: 97,
};

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function getColorCode(color: string): string {
  if (!color) return '';
  if (color.startsWith('#')) {
    if (!HEX_COLOR_RE.test(color)) return '';
    const hex = color.length === 4
      ? color[1]! + color[1]! + color[2]! + color[2]! + color[3]! + color[3]!
      : color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  const code = INK_COLOR_TO_ANSI[color.toLowerCase()];
  if (code !== undefined) return `\x1b[${code}m`;
  return '';
}

function applyColor(text: string, color: string): string {
  const code = getColorCode(color);
  if (!code) return text;
  return `${code}${text}\x1b[39m`;
}

function recolorAfterResets(text: string, colorCode: string): string {
  const fgReset = '\x1b[39m';
  const fullReset = '\x1b[0m';
  return text
    .split(fgReset).join(fgReset + colorCode)
    .split(fullReset).join(fullReset + colorCode);
}

const ansiFmt = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
  strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
};

/**
 * 单元格内行内 markdown → ANSI 着色串（镜像主路径 RenderInline 行为）。
 */
function renderMarkdownToAnsi(text: string): string {
  const inlineRegex =
    /(\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;

  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    result += text.slice(lastIndex, match.index);
    const fullMatch = match[0]!;
    let rendered: string | null = null;

    if (fullMatch.startsWith('**') && fullMatch.endsWith('**') && fullMatch.length > 4) {
      rendered = ansiFmt.bold(fullMatch.slice(2, -2));
    } else if (
      fullMatch.length > 2 &&
      ((fullMatch.startsWith('*') && fullMatch.endsWith('*')) ||
        (fullMatch.startsWith('_') && fullMatch.endsWith('_'))) &&
      !/\w/.test(text.substring(match.index - 1, match.index)) &&
      !/\w/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 1)) &&
      !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
      !/[./\\]\S/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 2))
    ) {
      rendered = ansiFmt.italic(fullMatch.slice(1, -1));
    } else if (fullMatch.startsWith('~~') && fullMatch.endsWith('~~') && fullMatch.length > 4) {
      rendered = ansiFmt.strikethrough(fullMatch.slice(2, -2));
    } else if (fullMatch.startsWith('`') && fullMatch.endsWith('`') && fullMatch.length > 1) {
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
      if (codeMatch?.[2]) {
        rendered = applyColor(codeMatch[2], tuiTheme.semantic.text.code);
      }
    } else if (fullMatch.startsWith('[') && fullMatch.includes('](') && fullMatch.endsWith(')')) {
      const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
      if (linkMatch) {
        rendered = `${linkMatch[1]} ${applyColor(`(${linkMatch[2]})`, tuiTheme.semantic.text.link)}`;
      }
    } else if (fullMatch.startsWith('<u>') && fullMatch.endsWith('</u>') && fullMatch.length > 7) {
      rendered = ansiFmt.underline(fullMatch.slice(3, -4));
    } else if (/^https?:\/\//.test(fullMatch)) {
      rendered = applyColor(fullMatch, tuiTheme.semantic.text.link);
    }

    result += rendered ?? fullMatch;
    lastIndex = inlineRegex.lastIndex;
  }

  result += text.slice(lastIndex);
  return result;
}

function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: ColumnAlign,
): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad);
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content;
  }
  return content + ' '.repeat(padding);
}

function wrapText(text: string, width: number, options?: { hard?: boolean }): string[] {
  if (width <= 0) return [text];
  const trimmedText = text.trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  });
  const lines = wrapped.split('\n');
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines.length > 0 ? lines : [''];
}

/** 去掉行内 markdown 标记（与 MessageLog.stripInlineMarkdown 同语义），供 plainLines。 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/<u>(.*?)<\/u>/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(^|[^\w])\*([^*\n]+)\*(?=$|[^\w])/g, '$1$2')
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, '$1$2');
}

// ── GFM 表格解析（确定性）────────────────────────────────────────────
const TABLE_SEPARATOR_RE = /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;

function isPipeRow(line: string): boolean {
  return line.includes('|') && line.trim() !== '';
}

/** 把一行表格按未转义 `|` 切成单元格，还原 `\|`，并就地转换行内 `$...$` 公式。 */
function splitRowCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body
    .split(/(?<!\\)\|/)
    .map((c) => replaceInlineMath(c.trim().replaceAll('\\|', '|')));
}

function parseAligns(sepLine: string): ColumnAlign[] {
  let body = sepLine.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => {
      const s = c.startsWith(':');
      const e = c.endsWith(':');
      if (s && e) return 'center';
      if (e) return 'right';
      return 'left';
    });
}

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  aligns: ColumnAlign[];
  /** 表头(1) + 分隔(1) + 数据行数；至少 2。 */
  consumed: number;
}

/**
 * 从 rawLines[start] 开始尝试解析 GFM 表格。
 * 判定规则（确定性）：start 行含 `|`、start+1 行匹配分隔行、二者列数一致。
 * 不满足返回 null（调用方当普通文本）。表头行本身是分隔行也返回 null。
 */
export function parsePipeTable(lines: readonly string[], start: number): ParsedTable | null {
  const headerLine = lines[start];
  if (headerLine === undefined || !isPipeRow(headerLine)) return null;
  if (TABLE_SEPARATOR_RE.test(headerLine.trim())) return null;

  const sepLine = lines[start + 1];
  if (sepLine === undefined || !TABLE_SEPARATOR_RE.test(sepLine.trim())) return null;

  const headers = splitRowCells(headerLine);
  const sepColCount = splitRowCells(sepLine).length;
  if (sepColCount !== headers.length) return null;

  const aligns = parseAligns(sepLine);
  const colCount = headers.length;

  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!isPipeRow(line)) break;
    if (TABLE_SEPARATOR_RE.test(line.trim())) break;
    const cells = splitRowCells(line);
    while (cells.length < colCount) cells.push('');
    if (cells.length > colCount) cells.length = colCount;
    rows.push(cells);
    i++;
  }

  return { headers, rows, aligns, consumed: i - start };
}

// ── 渲染 ─────────────────────────────────────────────────────────────
export interface RenderedTable {
  /** 每行带 ANSI 着色串（透传 <Text>）；可见宽度 ≤ contentWidth - SAFETY_MARGIN。 */
  ansiLines: string[];
  /** 对应纯文本（去 ANSI + markdown 标记），供选择/复制。 */
  plainLines: string[];
}

interface CellMetrics {
  rendered: string;
  renderedWidth: number;
  minWordWidth: number;
}

function computeMetrics(text: string): CellMetrics {
  const rendered = renderMarkdownToAnsi(text);
  const visible = stripAnsi(rendered);
  const words = visible.split(/\s+/).filter((w) => w.length > 0);
  return {
    rendered,
    renderedWidth: getCachedStringWidth(visible),
    minWordWidth: words.length > 0
      ? Math.max(...words.map((w) => getCachedStringWidth(w)), MIN_COLUMN_WIDTH)
      : MIN_COLUMN_WIDTH,
  };
}

export function renderTableToLines(
  headers: string[],
  rows: string[][],
  aligns: ColumnAlign[],
  contentWidth: number,
): RenderedTable {
  const colCount = headers.length;
  if (colCount === 0) return { ansiLines: [], plainLines: [] };

  const headerMetrics = headers.map((h) => computeMetrics(h));
  const rowMetrics = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => computeMetrics(row[i] ?? '')),
  );

  const minColumnWidths = headers.map((_, colIndex) => {
    let maxMin = headerMetrics[colIndex]!.minWordWidth;
    for (const row of rowMetrics) maxMin = Math.max(maxMin, row[colIndex]!.minWordWidth);
    return maxMin;
  });

  const idealWidths = headers.map((_, colIndex) => {
    let maxIdeal = Math.max(headerMetrics[colIndex]!.renderedWidth, MIN_COLUMN_WIDTH);
    for (const row of rowMetrics) maxIdeal = Math.max(maxIdeal, row[colIndex]!.renderedWidth);
    return maxIdeal;
  });

  const borderOverhead = 1 + colCount * 3;
  const availableWidth = Math.max(
    contentWidth - borderOverhead - SAFETY_MARGIN,
    colCount * MIN_COLUMN_WIDTH,
  );

  const totalMin = minColumnWidths.reduce((sum, w) => sum + w, 0);
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);

  let needsHardWrap = false;
  let columnWidths: number[];

  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minColumnWidths[i]!);
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);
    columnWidths = minColumnWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      const extra = Math.floor((overflows[i]! / totalOverflow) * extraSpace);
      return min + extra;
    });
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minColumnWidths.map((w) =>
      Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH),
    );
    let excess = columnWidths.reduce((s, w) => s + w, 0) - availableWidth;
    while (excess > 0) {
      const maxW = Math.max(...columnWidths);
      if (maxW <= MIN_COLUMN_WIDTH) break;
      const idx = columnWidths.indexOf(maxW);
      const reduction = Math.min(excess, maxW - MIN_COLUMN_WIDTH);
      columnWidths[idx] = maxW - reduction;
      excess -= reduction;
    }
  }

  const getAlign = (colIndex: number): ColumnAlign => aligns[colIndex] ?? 'left';

  function calculateMaxRowLines(): number {
    let maxLines = 1;
    for (let i = 0; i < colCount; i++) {
      const wrapped = wrapText(headerMetrics[i]!.rendered, columnWidths[i]!, { hard: needsHardWrap });
      maxLines = Math.max(maxLines, wrapped.length);
    }
    for (const row of rowMetrics) {
      for (let i = 0; i < colCount; i++) {
        const wrapped = wrapText(row[i]!.rendered, columnWidths[i]!, { hard: needsHardWrap });
        maxLines = Math.max(maxLines, wrapped.length);
      }
    }
    return maxLines;
  }

  const useVerticalFormat = calculateMaxRowLines() > MAX_ROW_LINES;

  function renderBorderLine(type: 'top' | 'middle' | 'bottom'): string {
    const [left, mid, cross, right] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type] as [string, string, string, string];
    let line = left;
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return applyColor(line, tuiTheme.semantic.border.default);
  }

  function renderRowLines(renderedCells: string[], isHeader: boolean): string[] {
    const cellLines = renderedCells.map((cell, colIndex) =>
      wrapText(cell, columnWidths[colIndex]!, { hard: needsHardWrap }),
    );
    const maxLines = Math.max(...cellLines.map((l) => l.length), 1);
    const offsets = cellLines.map((l) => Math.floor((maxLines - l.length) / 2));
    const borderPipe = applyColor('│', tuiTheme.semantic.border.default);
    const result: string[] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = borderPipe;
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const lines = cellLines[colIndex]!;
        const offset = offsets[colIndex]!;
        const contentLineIdx = lineIdx - offset;
        const lineText =
          contentLineIdx >= 0 && contentLineIdx < lines.length ? lines[contentLineIdx]! : '';
        const width = columnWidths[colIndex]!;
        const displayWidth = getCachedStringWidth(stripAnsi(lineText));
        const align = aligns[colIndex] != null ? getAlign(colIndex) : isHeader ? 'center' : 'left';
        const padded = padAligned(lineText, displayWidth, width, align);
        if (isHeader) {
          const linkCode = getColorCode(tuiTheme.semantic.text.link);
          const recolored = linkCode ? recolorAfterResets(padded, linkCode) : padded;
          line += ' ' + applyColor(ansiFmt.bold(recolored), tuiTheme.semantic.text.link) + ' ' + borderPipe;
        } else {
          const primaryCode = getColorCode(tuiTheme.semantic.text.primary);
          const recolored = primaryCode ? recolorAfterResets(padded, primaryCode) : padded;
          const styledCell = primaryCode ? applyColor(recolored, tuiTheme.semantic.text.primary) : recolored;
          line += ' ' + styledCell + ' ' + borderPipe;
        }
      }
      result.push(line);
    }
    return result;
  }

  function renderVerticalFormat(): string[] {
    const lines: string[] = [];
    const separatorWidth = Math.max(Math.min(contentWidth - 1, 40), 0);
    const separator = separatorWidth > 0 ? '─'.repeat(separatorWidth) : '';
    rowMetrics.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(separator);
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const rawLabel = headers[colIndex] ?? t('tui.table.column_fallback', colIndex + 1);
        const label = renderMarkdownToAnsi(rawLabel);
        const value = row[colIndex]!.rendered.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        const linkCode = getColorCode(tuiTheme.semantic.text.link);
        const recoloredLabel = linkCode ? recolorAfterResets(`${label}:`, linkCode) : `${label}:`;
        const primaryCode = getColorCode(tuiTheme.semantic.text.primary);
        const styledValue = primaryCode
          ? applyColor(recolorAfterResets(value, primaryCode), tuiTheme.semantic.text.primary)
          : value;
        lines.push(
          `${applyColor(ansiFmt.bold(recoloredLabel), tuiTheme.semantic.text.link)} ${styledValue}`,
        );
      }
    });
    return lines;
  }

  let ansiLines: string[];
  if (useVerticalFormat) {
    ansiLines = renderVerticalFormat();
  } else {
    const headerRendered = headerMetrics.map((m) => m.rendered);
    ansiLines = [renderBorderLine('top')];
    ansiLines.push(...renderRowLines(headerRendered, true));
    ansiLines.push(renderBorderLine('middle'));
    rows.forEach((_, rowIndex) => {
      ansiLines.push(...renderRowLines(rowMetrics[rowIndex]!.map((m) => m.rendered), false));
      if (rowIndex < rows.length - 1) ansiLines.push(renderBorderLine('middle'));
    });
    ansiLines.push(renderBorderLine('bottom'));

    // 安全检查：若仍超宽，回退竖排。
    const maxLineWidth = Math.max(...ansiLines.map((line) => getCachedStringWidth(stripAnsi(line))));
    if (maxLineWidth > contentWidth - SAFETY_MARGIN) {
      ansiLines = renderVerticalFormat();
    }
  }

  const plainLines = ansiLines.map((l) => stripInlineMarkdown(stripAnsi(l)));
  return { ansiLines, plainLines };
}
