/**
 * textTable — 宽字符感知的等宽文本表格。
 *
 * 终端按「显示列宽」对齐，而中文/全角字符占 2 列、emoji 占 2 列。
 * 手工 `str.padEnd(n)` 用的是字符数,遇到中文就会错位。本模块用 string-width
 * 计算真实显示宽度来 pad,保证列对齐。用于 /stats /logs /traces 等文本报告。
 */

import stringWidth from 'string-width';

export interface TableColumn {
  /** 列标题 */
  header: string;
  /** 列最大宽度（显示列），超出截断加 … */
  width: number;
  /** 对齐方式，默认左对齐 */
  align?: 'left' | 'right';
}

/** 按显示宽度截断字符串到 maxWidth（含 … 标记） */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  // 逐字符累加直到放不下，预留 1 列给 …
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 按显示宽度 pad 到 targetWidth（不足补空格，超出截断） */
export function padToWidth(text: string, targetWidth: number, align: 'left' | 'right' = 'left'): string {
  const truncated = truncateToWidth(text, targetWidth);
  const pad = Math.max(0, targetWidth - stringWidth(truncated));
  const spaces = ' '.repeat(pad);
  return align === 'right' ? spaces + truncated : truncated + spaces;
}

/** 渲染一行（按列定义 pad + 对齐），列间以 1 空格分隔 */
export function renderRow(cells: string[], columns: TableColumn[], gap = 1): string {
  const sep = ' '.repeat(gap);
  return columns
    .map((col, i) => padToWidth(cells[i] ?? '', col.width, col.align))
    .join(sep)
    .replace(/\s+$/, ''); // 去尾随空格,终端更干净
}

/**
 * 渲染完整表格（表头 + 数据行）。
 * @param indent 每行前缀缩进（空格数）
 */
export function renderTable(columns: TableColumn[], rows: string[][], indent = 2): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  lines.push(pad + renderRow(columns.map((c) => c.header), columns));
  for (const row of rows) {
    lines.push(pad + renderRow(row, columns));
  }
  return lines;
}
