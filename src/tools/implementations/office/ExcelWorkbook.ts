import { statSync } from 'fs';
import { basename } from 'path';
import { FILE_PARSER } from '../../../config/defaults.js';
import type { Cell, CellValue, Workbook, Worksheet } from 'exceljs';

type ExcelJsModule = typeof import('exceljs');
type ExcelJsRuntimeModule = ExcelJsModule & { default?: ExcelJsModule };

export const EXCEL_MAX_PARSE_BYTES = FILE_PARSER.MAX_PARSE_BYTES;

export interface WorkbookLoadLimits {
  maxBytes?: number;
}

export async function loadExcelJs(): Promise<ExcelJsModule> {
  const mod = await import('exceljs') as ExcelJsRuntimeModule;
  return mod.default ?? mod;
}

export async function createWorkbook(): Promise<Workbook> {
  const ExcelJS = await loadExcelJs();
  return new ExcelJS.Workbook();
}

export async function readWorkbook(filePath: string, limits: WorkbookLoadLimits = {}): Promise<Workbook> {
  enforceWorkbookSize(filePath, limits.maxBytes ?? EXCEL_MAX_PARSE_BYTES);
  const workbook = await createWorkbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

export function enforceWorkbookSize(filePath: string, maxBytes: number): void {
  const size = statSync(filePath).size;
  if (size > maxBytes) {
    throw new Error(`XLSX 文件过大，已拒绝解析: ${basename(filePath)} (${(size / 1024 / 1024).toFixed(1)} MB，限制 ${(maxBytes / 1024 / 1024).toFixed(0)} MB)`);
  }
}

export function workbookSheetNames(workbook: Workbook): string[] {
  return workbook.worksheets.map((worksheet) => worksheet.name);
}

export function getWorksheetOrThrow(workbook: Workbook, name?: string): Worksheet {
  const worksheet = name ? workbook.getWorksheet(name) : workbook.worksheets[0];
  if (!worksheet) {
    const names = workbookSheetNames(workbook);
    throw new Error(`Sheet "${name || '(first)'}" 不存在。可用 sheets: ${names.join(', ')}`);
  }
  return worksheet;
}

export function cellValueToPrimitive(value: CellValue): string | number | boolean | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if ('formula' in value) return value.result == null ? `=${value.formula}` : cellValueToPrimitive(value.result as CellValue);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => String(part.text ?? '')).join('');
    }
    if ('text' in value) return String(value.text ?? '');
    if ('hyperlink' in value && 'text' in value) return String(value.text ?? value.hyperlink ?? '');
    if ('error' in value) return String(value.error ?? '');
  }
  return String(value);
}

export function cellDisplayValue(cell: Cell): string {
  const primitive = cellValueToPrimitive(cell.value);
  return primitive == null ? '' : String(primitive);
}

export function worksheetToRows(worksheet: Worksheet, maxRows = Number.MAX_SAFE_INTEGER): unknown[][] {
  const rows: unknown[][] = [];
  const rowLimit = Math.min(worksheet.rowCount || 0, maxRows);
  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const rowValues: unknown[] = [];
    for (let colNumber = 1; colNumber <= (worksheet.columnCount || row.cellCount || 0); colNumber++) {
      rowValues.push(cellValueToPrimitive(row.getCell(colNumber).value));
    }
    while (rowValues.length > 0 && rowValues[rowValues.length - 1] == null) rowValues.pop();
    rows.push(rowValues);
  }
  return rows;
}

export function worksheetToCsv(worksheet: Worksheet, maxRows = Number.MAX_SAFE_INTEGER): string {
  return worksheetToRows(worksheet, maxRows)
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');
}

export function csvEscape(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function columnLetterToNumber(column: string): number {
  const normalized = column.trim().toUpperCase();
  let value = 0;
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) throw new Error(`无效列标识: ${column}`);
    value = value * 26 + (code - 64);
  }
  if (value <= 0) throw new Error(`无效列标识: ${column}`);
  return value;
}

export function setCellValue(cell: Cell, value: unknown): void {
  if (typeof value === 'string' && value.startsWith('=')) {
    cell.value = { formula: value.slice(1), result: 0 };
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    cell.value = value as CellValue;
    return;
  }
  const text = String(value);
  const num = Number(text);
  cell.value = text.trim() !== '' && Number.isFinite(num) ? num : text;
}

