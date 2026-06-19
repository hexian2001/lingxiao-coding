import { z } from 'zod';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath } from './utils.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension, slugFileName } from './OfficeXmlBuilder.js';
import type { ConditionalFormattingRule, IconSetType } from './office/ConditionalFormattingBuilder.js';
import { applyDefaultHeaderStyle, applyStripedRows } from './office/XlsxStyleBuilder.js';
import { createWorkbook, setCellValue } from './office/ExcelWorkbook.js';

const XlsxColumnSchema = z.object({
  header: z.string().describe('列标题'),
  width: z.number().min(5).max(100).optional().describe('列宽（字符数），默认 12'),
});

const XlsxFormulaSchema = z.object({
  cell: z.string().describe('单元格引用，如 "E1"、"B10"'),
  formula: z.string().describe('公式表达式，如 "SUM(B2:B100)"、"AVERAGE(C2:C50)"'),
});

const ConditionalFormattingSchema = z.object({
  range: z.string().describe('应用范围，如 "A2:A100"'),
  type: z.enum(['dataBar', 'colorScale', 'iconSet']).describe('条件格式类型'),
  // Data Bar 配置
  color: z.string().optional().describe('数据条颜色（hex），如 "FF638EC6"'),
  showValue: z.boolean().optional().describe('是否显示单元格值'),
  // Color Scale 配置
  minColor: z.string().optional().describe('最小值颜色（hex）'),
  midColor: z.string().optional().describe('中间值颜色（hex），三色阶时使用'),
  maxColor: z.string().optional().describe('最大值颜色（hex）'),
  // Icon Set 配置
  iconSet: z.enum(['3Arrows', '3ArrowsGray', '3Flags', '3TrafficLights1', '3TrafficLights2', '3Signs', '3Symbols', '3Symbols2', '4Arrows', '4ArrowsGray', '4RedToBlack', '4Rating', '4TrafficLights', '5Arrows', '5ArrowsGray', '5Rating', '5Quarters']).optional().describe('图标集类型'),
  reverse: z.boolean().optional().describe('是否反转图标顺序'),
});

const XlsxSheetSchema = z.object({
  name: z.string().min(1).max(31).describe('工作表名称'),
  columns: z.array(XlsxColumnSchema).min(1).max(50).describe('列定义，第一行自动作为表头'),
  rows: z.array(z.array(z.string())).max(10000).describe('数据行，每行长度应与 columns 一致'),
  formulas: z.array(XlsxFormulaSchema).optional().describe('公式定义，会在指定单元格写入 Excel 公式'),
  conditionalFormatting: z.array(ConditionalFormattingSchema).optional().describe('条件格式定义（当前仅记录在返回摘要中，复杂条件格式建议使用 Office runtime/模板处理）'),
  styleHeader: z.boolean().default(true).describe('是否尝试为表头应用样式（受底层库限制，效果可能不可见）'),
  stripedRows: z.boolean().default(false).describe('是否尝试应用条纹行样式（受底层库限制，效果可能不可见）'),
});

const GenerateXlsxSchema = z.object({
  path: z.string().optional().describe('输出 xlsx 路径。可省略，默认写入当前 session scratchpad。'),
  title: z.string().min(1).max(200).describe('工作簿标题（用于文件名和文档属性）'),
  sheets: z.array(XlsxSheetSchema).min(1).max(20).describe('工作表数组，至少 1 个，最多 20 个'),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

type GenerateXlsxInput = z.infer<typeof GenerateXlsxSchema>;

export class GenerateXlsxTool extends Tool {
  readonly name = 'generate_xlsx';
  readonly description = '生成 Excel XLSX 工作簿。支持多工作表、自定义列宽、公式（SUM/AVERAGE/COUNTIF 等）、最多 50 列 × 10000 行。';
  readonly parameters = GenerateXlsxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = GenerateXlsxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const input = parsed.data;

    const defaultName = `${slugFileName(input.title, 'workbook')}.xlsx`;
    const requestedPath = input.path || `.lingxiao/sessions/${context?.sessionId || 'default'}/scratchpad/${defaultName}`;
    let outputPath: string;
    try {
      outputPath = ensureExtension(resolveTaskWritePath(context?.workspace, requestedPath, context?.sessionId, context?.taskWriteScope), '.xlsx');
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }

    try {
      const wb = await createWorkbook();
      wb.title = input.title;
      wb.creator = 'LingXiao';
      wb.created = new Date();

      const sheetSummaries: Array<{ name: string; rows: number; columns: number; conditionalFormats?: number }> = [];

      for (const sheet of input.sheets) {
        const ws = wb.addWorksheet(sheet.name);
        ws.addRow(sheet.columns.map(c => c.header));
        for (const row of sheet.rows) {
          ws.addRow(row);
        }

        // 设置列宽
        ws.columns = sheet.columns.map(c => ({ header: c.header, width: c.width || 12 }));

        // 写入公式
        if (sheet.formulas?.length) {
          for (const f of sheet.formulas) {
            ws.getCell(f.cell.toUpperCase()).value = { formula: f.formula.replace(/^=/, ''), result: 0 };
          }
        }

        // Normalize generated values so leading "=" strings become formulas.
        for (let rowNumber = 2; rowNumber <= sheet.rows.length + 1; rowNumber++) {
          const source = sheet.rows[rowNumber - 2] ?? [];
          for (let columnNumber = 1; columnNumber <= source.length; columnNumber++) {
            setCellValue(ws.getCell(rowNumber, columnNumber), source[columnNumber - 1]);
          }
        }

        // 应用表头样式
        if (sheet.styleHeader !== false) {
          applyDefaultHeaderStyle(ws, sheet.columns.length);
        }

        // 应用条纹行样式
        if (sheet.stripedRows && sheet.rows.length > 0) {
          applyStripedRows(ws, sheet.columns.length, sheet.rows.length + 1, 2);
        }

        // 条件格式由 buildConditionalFormattingRules 校验/汇总；复杂 OOXML 注入交给后续 runtime。
        if (sheet.conditionalFormatting?.length) this.buildConditionalFormattingRules(sheet.conditionalFormatting);

        sheetSummaries.push({ 
          name: sheet.name, 
          rows: sheet.rows.length, 
          columns: sheet.columns.length,
          conditionalFormats: sheet.conditionalFormatting?.length || 0,
        });
      }

      mkdirSync(dirname(outputPath), { recursive: true });
      await wb.xlsx.writeFile(outputPath);

      const artifact = input.create_download_link
        ? tempDownloadRegistry.create({
          path: outputPath,
          name: defaultName,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          expiresInSeconds: input.expires_in_seconds,
          sessionId: context?.sessionId,
        })
        : undefined;

      return {
        success: true,
        data: artifact ? {
          ...artifact,
          sheetCount: input.sheets.length,
          sheets: sheetSummaries,
        } : {
          path: resolve(outputPath),
          sheetCount: input.sheets.length,
          sheets: sheetSummaries,
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private buildConditionalFormattingRules(formats: Array<z.infer<typeof ConditionalFormattingSchema>>): ConditionalFormattingRule[] {
    const rules: ConditionalFormattingRule[] = [];

    for (const fmt of formats) {
      if (fmt.type === 'dataBar') {
        rules.push({
          type: 'dataBar',
          minValue: { type: 'min' },
          maxValue: { type: 'max' },
          color: fmt.color || 'FF638EC6',
          showValue: fmt.showValue !== false,
        });
      } else if (fmt.type === 'colorScale') {
        if (fmt.midColor) {
          // 三色阶
          rules.push({
            type: 'colorScale',
            minValue: { type: 'min' },
            minColor: fmt.minColor || 'F8696B',
            midValue: { type: 'percentile', val: 50 },
            midColor: fmt.midColor,
            maxValue: { type: 'max' },
            maxColor: fmt.maxColor || '63BE7B',
          });
        } else {
          // 二色阶
          rules.push({
            type: 'colorScale',
            minValue: { type: 'min' },
            minColor: fmt.minColor || 'FFFFFF',
            maxValue: { type: 'max' },
            maxColor: fmt.maxColor || '5A8AC6',
          });
        }
      } else if (fmt.type === 'iconSet') {
        const iconSet = fmt.iconSet || '3Arrows';
        const iconCount = iconSet.startsWith('3') ? 3 : iconSet.startsWith('4') ? 4 : 5;
        
        const values = [];
        if (iconCount === 3) {
          values.push(
            { type: 'percentile' as const, val: 0 },
            { type: 'percentile' as const, val: 33 },
            { type: 'percentile' as const, val: 67 }
          );
        } else if (iconCount === 4) {
          values.push(
            { type: 'percentile' as const, val: 0 },
            { type: 'percentile' as const, val: 25 },
            { type: 'percentile' as const, val: 50 },
            { type: 'percentile' as const, val: 75 }
          );
        } else {
          values.push(
            { type: 'percentile' as const, val: 0 },
            { type: 'percentile' as const, val: 20 },
            { type: 'percentile' as const, val: 40 },
            { type: 'percentile' as const, val: 60 },
            { type: 'percentile' as const, val: 80 }
          );
        }

        rules.push({
          type: 'iconSet',
          iconSet: iconSet as IconSetType,
          values,
          reverse: fmt.reverse || false,
          showValue: fmt.showValue !== false,
        });
      }
    }

    return rules;
  }
}

export default GenerateXlsxTool;
