import { z } from 'zod';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath } from './utils.js';
import {
  columnLetterToNumber,
  getWorksheetOrThrow,
  readWorkbook,
  setCellValue,
  workbookSheetNames,
  worksheetToRows,
} from './office/ExcelWorkbook.js';

const EditXlsxOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('inspect') }),
  z.object({
    op: z.literal('read_sheet'),
    sheet: z.string().optional().describe('工作表名称，默认第一个'),
    max_rows: z.number().min(1).max(5000).default(500).describe('最多读取行数'),
  }),
  z.object({
    op: z.literal('set_cell'),
    sheet: z.string().optional(),
    cell: z.string().describe('单元格引用，如 "A1"、"C5"'),
    value: z.string().describe('单元格值'),
  }),
  z.object({
    op: z.literal('set_cells'),
    sheet: z.string().optional(),
    cells: z.array(z.object({
      cell: z.string(),
      value: z.string(),
    })).min(1).max(1000).describe('批量设置单元格'),
  }),
  z.object({
    op: z.literal('append_rows'),
    sheet: z.string().optional(),
    rows: z.array(z.array(z.string())).min(1).max(5000).describe('追加的数据行'),
  }),
  z.object({
    op: z.literal('add_sheet'),
    name: z.string().min(1).max(31).describe('新工作表名称'),
  }),
  z.object({
    op: z.literal('delete_sheet'),
    name: z.string().describe('要删除的工作表名称'),
  }),
  z.object({
    op: z.literal('rename_sheet'),
    old_name: z.string().describe('原名称'),
    new_name: z.string().min(1).max(31).describe('新名称'),
  }),
  z.object({
    op: z.literal('set_column_width'),
    sheet: z.string().optional(),
    column: z.string().describe('列标识，如 "A"、"B"、"C"'),
    width: z.number().min(1).max(200).describe('列宽（字符数）'),
  }),
  z.object({
    op: z.literal('set_formula'),
    sheet: z.string().optional(),
    cell: z.string().describe('单元格引用'),
    formula: z.string().describe('公式，如 "SUM(B2:B100)"'),
  }),
]);

const EditXlsxSchema = z.object({
  path: z.string().describe('要编辑的 XLSX 文件路径'),
  output_path: z.string().optional().describe('另存为路径。省略则覆盖原文件。'),
  operations: z.array(EditXlsxOperation).min(1).max(50).describe('操作列表，按顺序执行'),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

export class EditXlsxTool extends Tool {
  readonly name = 'edit_xlsx';
  readonly description = '编辑现有 XLSX 文件。支持操作：inspect（查看结构）、read_sheet（读取数据）、set_cell/set_cells（写入单元格）、append_rows（追加行）、add_sheet/delete_sheet/rename_sheet（管理工作表）、set_column_width（列宽）、set_formula（公式）。';
  readonly parameters = EditXlsxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = EditXlsxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const input = parsed.data;

    const resolvedPath = resolveTaskWritePath(context?.workspace, input.path, context?.sessionId, context?.taskWriteScope);
    if (!existsSync(resolvedPath)) {
      return { success: false, data: null, error: `ERROR: 文件不存在: ${resolvedPath}` };
    }

    let outputPath: string;
    try {
      outputPath = input.output_path
        ? resolveTaskWritePath(context?.workspace, input.output_path, context?.sessionId, context?.taskWriteScope)
        : resolvedPath;
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }

    try {
      const wb = await readWorkbook(resolvedPath);
      const results: Array<Record<string, unknown>> = [];

      for (const op of input.operations) {
        switch (op.op) {
          case 'inspect': {
            const sheets = wb.worksheets.map((ws) => {
              return {
                name: ws.name,
                rows: ws.rowCount,
                columns: ws.columnCount,
              };
            });
            results.push({ op: 'inspect', sheets, totalSheets: wb.worksheets.length });
            break;
          }
          case 'read_sheet': {
            const ws = getWorksheetOrThrow(wb, op.sheet);
            const data = worksheetToRows(ws, op.max_rows);
            const sliced = data.slice(0, op.max_rows);
            results.push({
              op: 'read_sheet',
              sheet: ws.name,
              headers: data[0] || [],
              rows: sliced.slice(1),
              totalRows: ws.rowCount,
              returnedRows: sliced.length - 1,
            });
            break;
          }
          case 'set_cell': {
            const ws = getWorksheetOrThrow(wb, op.sheet);
            setCellValue(ws.getCell(op.cell.toUpperCase()), op.value);
            results.push({ op: 'set_cell', cell: op.cell.toUpperCase(), value: op.value });
            break;
          }
          case 'set_cells': {
            const ws = getWorksheetOrThrow(wb, op.sheet);
            let count = 0;
            for (const { cell, value } of op.cells) {
              setCellValue(ws.getCell(cell.toUpperCase()), value);
              count++;
            }
            results.push({ op: 'set_cells', count });
            break;
          }
          case 'append_rows': {
            const ws = getWorksheetOrThrow(wb, op.sheet);
            for (const row of op.rows) {
              const appended = ws.addRow([]);
              for (let ci = 0; ci < row.length; ci++) {
                const val = row[ci];
                if (val === null || val === undefined || val === '') continue;
                setCellValue(appended.getCell(ci + 1), val);
              }
            }
            results.push({ op: 'append_rows', addedRows: op.rows.length, totalRows: ws.rowCount });
            break;
          }
          case 'add_sheet': {
            if (wb.getWorksheet(op.name)) {
              throw new Error(`Sheet "${op.name}" 已存在`);
            }
            wb.addWorksheet(op.name);
            results.push({ op: 'add_sheet', name: op.name });
            break;
          }
          case 'delete_sheet': {
            const ws = wb.getWorksheet(op.name);
            if (!ws) {
              throw new Error(`Sheet "${op.name}" 不存在`);
            }
            if (wb.worksheets.length <= 1) {
              throw new Error('请至少保留一个工作表。');
            }
            wb.removeWorksheet(ws.id);
            results.push({ op: 'delete_sheet', name: op.name });
            break;
          }
          case 'rename_sheet': {
            const ws = wb.getWorksheet(op.old_name);
            if (!ws) throw new Error(`Sheet "${op.old_name}" 不存在`);
            if (wb.getWorksheet(op.new_name)) throw new Error(`Sheet "${op.new_name}" 已存在`);
            ws.name = op.new_name;
            results.push({ op: 'rename_sheet', old_name: op.old_name, new_name: op.new_name });
            break;
          }
          case 'set_column_width': {
            const ws = getWorksheetOrThrow(wb, op.sheet);
            ws.getColumn(columnLetterToNumber(op.column)).width = op.width;
            results.push({ op: 'set_column_width', column: op.column, width: op.width });
            break;
          }
          case 'set_formula': {
            const ws = getWorksheetOrThrow(wb, op.sheet);
            ws.getCell(op.cell.toUpperCase()).value = { formula: op.formula.replace(/^=/, ''), result: 0 };
            results.push({ op: 'set_formula', cell: op.cell.toUpperCase(), formula: op.formula });
            break;
          }
        }
      }

      await wb.xlsx.writeFile(outputPath);

      return {
        success: true,
        data: {
          path: resolve(outputPath),
          operations: results,
          sheetCount: wb.worksheets.length,
          sheets: workbookSheetNames(wb),
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export default EditXlsxTool;
