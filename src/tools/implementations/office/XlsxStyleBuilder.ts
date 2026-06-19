import type { Cell, Worksheet } from 'exceljs';

/**
 * XLSX Style Builder
 *
 * 为 Excel 单元格添加样式支持。
 */

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;
  bgColor?: string;
  border?: 'thin' | 'medium' | 'thick';
  borderColor?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  numberFormat?: 'currency' | 'percent' | 'date' | 'custom';
  customFormat?: string;
}

interface ExcelCellStyle {
  font?: {
    bold?: boolean;
    italic?: boolean;
    size?: number;
    color?: { argb: string };
  };
  fill?: {
    type: 'pattern';
    pattern: 'solid';
    fgColor: { argb: string };
  };
  border?: {
    top: { style: 'thin' | 'medium' | 'thick'; color?: { argb: string } };
    bottom: { style: 'thin' | 'medium' | 'thick'; color?: { argb: string } };
    left: { style: 'thin' | 'medium' | 'thick'; color?: { argb: string } };
    right: { style: 'thin' | 'medium' | 'thick'; color?: { argb: string } };
  };
  alignment?: {
    horizontal?: 'left' | 'center' | 'right';
    vertical?: 'top' | 'middle' | 'bottom';
  };
  numFmt?: string;
}

type ExcelBorderSide = NonNullable<ExcelCellStyle['border']>['top'];

function normalizeArgb(color: string): string {
  const stripped = color.replace(/^#/, '').toUpperCase();
  return stripped.length === 6 ? `FF${stripped}` : stripped;
}

function buildBorderSide(style: NonNullable<CellStyle['border']>): ExcelBorderSide {
  return { style };
}

/**
 * 构建 ExcelJS 样式对象。
 */
export function buildCellStyle(style: CellStyle): ExcelCellStyle {
  const xlsxStyle: ExcelCellStyle = {};

  // 字体样式
  if (style.bold || style.italic || style.fontSize || style.fontColor) {
    xlsxStyle.font = {};
    if (style.bold) xlsxStyle.font.bold = true;
    if (style.italic) xlsxStyle.font.italic = true;
    if (style.fontSize) xlsxStyle.font.size = style.fontSize;
    if (style.fontColor) xlsxStyle.font.color = { argb: normalizeArgb(style.fontColor) };
  }

  // 背景色
  if (style.bgColor) {
    xlsxStyle.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: normalizeArgb(style.bgColor) },
    };
  }

  // 边框
  if (style.border) {
    const border = {
      top: buildBorderSide(style.border),
      bottom: buildBorderSide(style.border),
      left: buildBorderSide(style.border),
      right: buildBorderSide(style.border),
    };
    
    if (style.borderColor) {
      const color = { argb: normalizeArgb(style.borderColor) };
      border.top.color = color;
      border.bottom.color = color;
      border.left.color = color;
      border.right.color = color;
    }
    xlsxStyle.border = border;
  }

  // 对齐
  if (style.align || style.valign) {
    xlsxStyle.alignment = {};
    if (style.align) xlsxStyle.alignment.horizontal = style.align;
    if (style.valign) xlsxStyle.alignment.vertical = style.valign;
  }

  // 数字格式
  if (style.numberFormat) {
    const formats = {
      currency: '#,##0.00',
      percent: '0.00%',
      date: 'yyyy-mm-dd',
      custom: style.customFormat || 'General',
    };
    xlsxStyle.numFmt = formats[style.numberFormat];
  }

  return xlsxStyle;
}

function applyStyleToCell(cell: Cell, style: ExcelCellStyle): void {
  if (style.font) cell.font = { ...(cell.font ?? {}), ...style.font };
  if (style.fill) cell.fill = style.fill;
  if (style.border) cell.border = style.border;
  if (style.alignment) cell.alignment = { ...(cell.alignment ?? {}), ...style.alignment };
  if (style.numFmt) cell.numFmt = style.numFmt;
}

/**
 * 应用样式到单元格或单元格范围
 */
export function applyCellStyle(
  ws: Worksheet,
  cellRef: string,
  style: CellStyle
): void {
  const xlsxStyle = buildCellStyle(style);
  
  // 处理单个单元格
  if (!cellRef.includes(':')) {
    applyStyleToCell(ws.getCell(cellRef), xlsxStyle);
    return;
  }

  // 处理单元格范围 (如 "A1:C5")
  const [start, end] = cellRef.split(':');
  const startCol = start.match(/[A-Z]+/)?.[0] || 'A';
  const startRow = parseInt(start.match(/\d+/)?.[0] || '1');
  const endCol = end.match(/[A-Z]+/)?.[0] || startCol;
  const endRow = parseInt(end.match(/\d+/)?.[0] || startRow.toString());

  for (let row = startRow; row <= endRow; row++) {
    for (let col = colToNum(startCol); col <= colToNum(endCol); col++) {
      const cell = numToCol(col) + row;
      applyStyleToCell(ws.getCell(cell), xlsxStyle);
    }
  }
}

/**
 * 列字母转数字 (A=1, B=2, ..., Z=26, AA=27)
 */
function colToNum(col: string): number {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 64);
  }
  return num;
}

/**
 * 数字转列字母 (1=A, 2=B, ..., 26=Z, 27=AA)
 */
function numToCol(num: number): string {
  let col = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    col = String.fromCharCode(65 + mod) + col;
    num = Math.floor((num - mod) / 26);
  }
  return col;
}

/**
 * 应用默认表头样式
 */
export function applyDefaultHeaderStyle(ws: Worksheet, colCount: number): void {
  const headerStyle: CellStyle = {
    bold: true,
    bgColor: 'F3F4F6',
    border: 'thin',
    borderColor: 'D1D5DB',
    align: 'center',
    valign: 'middle',
  };
  
  const headerRange = `A1:${numToCol(colCount)}1`;
  applyCellStyle(ws, headerRange, headerStyle);
}

/**
 * 应用条纹行样式
 */
export function applyStripedRows(
  ws: Worksheet,
  colCount: number,
  rowCount: number,
  startRow: number = 2
): void {
  const evenRowStyle: CellStyle = {
    bgColor: 'F9FAFB',
  };

  for (let row = startRow; row <= rowCount; row++) {
    if (row % 2 === 0) {
      const range = `A${row}:${numToCol(colCount)}${row}`;
      applyCellStyle(ws, range, evenRowStyle);
    }
  }
}
