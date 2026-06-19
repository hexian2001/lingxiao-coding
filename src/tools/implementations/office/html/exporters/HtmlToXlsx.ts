/**
 * HTML → XLSX 可编辑导出器。
 *
 * 抽取 HTML 中的所有 <table>（含 thead/tbody），每张表 → 一个 sheet，
 * 单元格文本直写；支持 `data-formula` 属性写真实公式（如
 * `<td data-formula="=SUM(B2:B5)">合计</td>`）。产物是**可编辑**的 .xlsx
 * （Excel/WPS/Numbers 可直接打开改公式）。
 *
 * 底层用 exceljs（^4.4.0，与 generate_xlsx/edit_xlsx 同源），保证样式体系一致。
 */

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { createWorkbook } from '../../ExcelWorkbook.js';
import type { AssembledHtml } from '../assemble.js';

export interface HtmlToXlsxResult {
  success: boolean;
  outputPath?: string;
  sheetCount: number;
  bytes: number;
  error?: string;
}

interface RawCell {
  text: string;
  formula?: string;
}
interface RawTable {
  caption?: string;
  rows: RawCell[][];
}

/** 从 HTML 抽取表格（正则 + 状态机，足够覆盖本引擎产出的语义化表格）。 */
function extractTables(html: string): RawTable[] {
  const tables: RawTable[] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(html)) !== null) {
    const inner = tm[1];
    const capMatch = inner.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
    const rows: RawCell[][] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(inner)) !== null) {
      const rowInner = rm[1];
      const cells: RawCell[] = [];
      const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rowInner)) !== null) {
        const attrs = cm[2] || '';
        const rawText = stripTags(cm[3] || '').trim();
        const formulaMatch = attrs.match(/data-formula\s*=\s*"([^"]+)"/i);
        const numberParsed = rawText !== '' && !isNaN(Number(rawText)) ? Number(rawText) : null;
        cells.push({
          text: rawText,
          formula: formulaMatch ? formulaMatch[1] : undefined,
        });
        void numberParsed;
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      tables.push({ caption: capMatch ? stripTags(capMatch[1]).trim() : undefined, rows });
    }
  }
  return tables;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function colLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export async function exportHtmlToXlsx(
  assembled: AssembledHtml,
  outputPath: string,
): Promise<HtmlToXlsxResult> {
  try {
    const tables = extractTables(assembled.html);
    if (!tables.length) {
      return { success: false, sheetCount: 0, bytes: 0, error: 'HTML→XLSX failed: 未找到 <table>' };
    }
    const wb = await createWorkbook();
    tables.forEach((table, ti) => {
      const sheetName = (table.caption || `Sheet${ti + 1}`).slice(0, 31);
      const ws = wb.addWorksheet(sheetName);
      table.rows.forEach((row, ri) => {
        row.forEach((cell, ci) => {
          const addr = `${colLetter(ci)}${ri + 1}`;
          const target = ws.getCell(addr);
          if (cell.formula) {
            target.value = { formula: cell.formula.replace(/^=/, ''), result: 0 };
          } else {
            const num = cell.text !== '' && !isNaN(Number(cell.text)) ? Number(cell.text) : cell.text;
            target.value = num;
          }
          if (ri === 0) target.font = { bold: true };
        });
      });
      // 列宽自适应（粗略）
      ws.columns.forEach((col) => {
        col.width = 18;
      });
    });

    const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as Uint8Array);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
    return { success: true, outputPath, sheetCount: tables.length, bytes: buffer.length };
  } catch (error) {
    return { success: false, sheetCount: 0, bytes: 0, error: `HTML→XLSX failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
