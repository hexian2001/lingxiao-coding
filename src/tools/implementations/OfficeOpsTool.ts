import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { ValidateOfficeTool } from './ValidateOfficeTool.js';
import { OfficeRuntimeTool } from './OfficeRuntimeTool.js';
import { OfficeReviewTool } from './OfficeReviewTool.js';
import { OfficeAssetTool } from './OfficeAssetTool.js';
import { detectFormat, parseFile } from './FileParser.js';
import { resolveWorkspacePath } from './utils.js';
import { resolveOfficeRuntimePaths } from './office/OfficeRuntime.js';
import { cellDisplayValue, readWorkbook, workbookSheetNames } from './office/ExcelWorkbook.js';

const OfficeOpsSchema = z.object({
  action: z.enum(['validate', 'runtime', 'review', 'assets', 'excel_analysis', 'pdf_ocr_pipeline', 'render_qa']).describe('Office operation group to run.'),
  office_action: z.string().optional().describe('Sub-action for runtime, review, or assets operations. Example: runtime+list, runtime+unpack_ooxml, assets+search, review+compare.'),
  path: z.string().optional().describe('validate: Office/PDF path to validate. input_path is also accepted and normalized to path.'),
  input_path: z.string().optional().describe('Office/PDF input path for analysis and QA actions. Relative paths resolve against workspace.'),
  input_dir: z.string().optional().describe('runtime pack_ooxml: input unpacked OOXML directory.'),
  output_path: z.string().optional().describe('runtime pack_ooxml: output Office file path.'),
  output_dir: z.string().optional().describe('Optional output directory for render/OCR pipeline actions.'),
  output_prefix: z.string().optional().describe('Optional thumbnail prefix for render QA.'),
  execute: z.boolean().optional().default(false).describe('For pipeline/QA actions, run available render/conversion helpers instead of returning a plan only.'),
  timeout_seconds: z.number().int().min(1).max(600).optional().default(60),
}).passthrough().superRefine((value, ctx) => {
  const hasInput = Boolean(value.path || value.input_path);
  if (value.action === 'validate' && !hasInput) {
    ctx.addIssue({ code: 'custom', path: ['input_path'], message: 'action=validate requires path or input_path' });
  }
  if ((value.action === 'excel_analysis' || value.action === 'pdf_ocr_pipeline' || value.action === 'render_qa') && !value.input_path) {
    ctx.addIssue({ code: 'custom', path: ['input_path'], message: `action=${value.action} requires input_path` });
  }
  if ((value.action === 'runtime' || value.action === 'review' || value.action === 'assets') && !value.office_action) {
    ctx.addIssue({ code: 'custom', path: ['office_action'], message: `action=${value.action} requires office_action` });
  }
});

type OfficeOpsInput = z.infer<typeof OfficeOpsSchema>;

interface ExcelSheetAnalysis {
  name: string;
  ref: string | null;
  rows: number;
  columns: number;
  formulaCount: number;
  errorCount: number;
  errorCells: string[];
  headerRow: string[];
  tableCandidate: boolean;
}

const RENDER_QA_EXECUTABLE_FORMATS = new Set(['pptx', 'pdf']);

function hasFormula(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value));
}

function hasCellError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if ('error' in value) return true;
  if ('result' in value) return hasCellError((value as { result?: unknown }).result);
  return false;
}

export class OfficeOpsTool extends Tool {
  readonly name = 'office_ops';
  readonly description = '统一 Office 操作入口：action="validate" 做文档验收；action="runtime" 运行 OOXML/LibreOffice/PDF 辅助操作；action="review" 做版本对比、审阅清单和 Word 批注/修订；action="assets" 搜索或下载办公素材；action="excel_analysis" 做工作簿结构/公式/错误单元格分析；action="pdf_ocr_pipeline" 规划或执行 PDF 转图/OCR 前置管线；action="render_qa" 规划或执行 PPTX/PDF 高保真渲染验收。runtime/review/assets 的原子动作放在 office_action 字段，例如 {action:"runtime", office_action:"list"}。生成/编辑具体文档仍使用 generate_/edit_ 格式工具。';
  readonly parameters = OfficeOpsSchema;

  private readonly delegates = {
    validate: new ValidateOfficeTool(),
    runtime: new OfficeRuntimeTool(),
    review: new OfficeReviewTool(),
    assets: new OfficeAssetTool(),
  };

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = OfficeOpsSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }

    const { action, office_action, ...rest } = parsed.data;
    if (action === 'excel_analysis') {
      return this.excelAnalysis(parsed.data, context);
    }
    if (action === 'pdf_ocr_pipeline') {
      return this.pdfOcrPipeline(parsed.data, context);
    }
    if (action === 'render_qa') {
      return this.renderQa(parsed.data, context);
    }
    const delegate = this.delegates[action];
    const delegateArgs = {
      ...rest,
      ...(action === 'validate' && !rest.path && rest.input_path ? { path: rest.input_path } : {}),
      ...(office_action ? { action: office_action } : {}),
    };
    return delegate.execute(delegateArgs, context);
  }

  private async excelAnalysis(input: OfficeOpsInput, context?: ToolContext): Promise<ToolResult> {
    if (!input.input_path) {
      return { success: false, data: null, error: 'ERROR: input_path is required for office_ops(action="excel_analysis").' };
    }
    const path = resolveWorkspacePath(context?.workspace, input.input_path, context?.sessionId);
    try {
      const workbook = await readWorkbook(path);
      const sheets: ExcelSheetAnalysis[] = workbook.worksheets.map((sheet) => {
        const rows = sheet.rowCount;
        const columns = sheet.columnCount;
        let formulaCount = 0;
        let errorCount = 0;
        const errorCells: string[] = [];
        sheet.eachRow((row) => {
          row.eachCell((cell) => {
            if (hasFormula(cell.value)) formulaCount += 1;
            if (hasCellError(cell.value)) {
              errorCount += 1;
              if (errorCells.length < 20) errorCells.push(cell.address);
            }
          });
        });
        const firstRow = sheet.getRow(1);
        const headerRow = Array.from({ length: Math.min(columns, 12) }, (_, index) => {
          return cellDisplayValue(firstRow.getCell(index + 1));
        }).filter(Boolean);
        return {
          name: sheet.name,
          ref: sheet.dimensions ? `${sheet.dimensions.top}:${sheet.dimensions.bottom}` : null,
          rows,
          columns,
          formulaCount,
          errorCount,
          errorCells,
          headerRow,
          tableCandidate: rows > 1 && columns > 1 && headerRow.length >= Math.min(columns, 3),
        };
      });
      return {
        success: true,
        data: {
          path,
          workbook: {
            sheetCount: workbook.worksheets.length,
            sheetNames: workbookSheetNames(workbook),
            sheets,
            totalFormulas: sheets.reduce((sum, sheet) => sum + sheet.formulaCount, 0),
            totalErrors: sheets.reduce((sum, sheet) => sum + sheet.errorCount, 0),
          },
          recommendedVerification: [
            'Run office_ops(action="runtime", office_action="xlsx_recalc", input_path=...) after formula edits.',
            'Use tableCandidate/headerRow to verify data regions before chart or pivot work.',
          ],
        },
      };
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async pdfOcrPipeline(input: OfficeOpsInput, context?: ToolContext): Promise<ToolResult> {
    if (!input.input_path) {
      return { success: false, data: null, error: 'ERROR: input_path is required for office_ops(action="pdf_ocr_pipeline").' };
    }
    const path = resolveWorkspacePath(context?.workspace, input.input_path, context?.sessionId);
    const parsed = await parseFile(path, 'preview');
    const runtime = resolveOfficeRuntimePaths();
    const plan = [
      'Inspect PDF text layer and page count.',
      'When hasTextLayer=false or imageOnly=true, convert pages to PNG with office_ops(action="runtime", office_action="pdf_to_images").',
      'Run OCR on generated page images and keep OCR text plus image paths as evidence_refs.',
      'Treat missing OCR output as needs_ocr/inconclusive for text acceptance.',
    ];
    let conversion: ToolResult | null = null;
    if (input.execute) {
      conversion = await this.delegates.runtime.execute({
        action: 'pdf_to_images',
        input_path: input.input_path,
        output_dir: input.output_dir,
        timeout_seconds: input.timeout_seconds,
      }, context);
    }
    return {
      success: true,
      data: {
        path,
        format: detectFormat(path),
        runtime,
        pdf: parsed.metadata || {},
        verdict: parsed.metadata?.hasTextLayer ? 'text_layer_available' : 'needs_ocr',
        plan,
        executed: Boolean(input.execute),
        conversion,
      },
    };
  }

  private async renderQa(input: OfficeOpsInput, context?: ToolContext): Promise<ToolResult> {
    if (!input.input_path) {
      return { success: false, data: null, error: 'ERROR: input_path is required for office_ops(action="render_qa").' };
    }
    const path = resolveWorkspacePath(context?.workspace, input.input_path, context?.sessionId);
    const format = detectFormat(path);
    const preview = await parseFile(path, 'preview');
    const plan = format === 'pptx'
      ? ['Generate slide thumbnail grid.', 'Compare slide count/text/visual density against acceptance criteria.', 'Attach thumbnail path to evidence_refs.']
      : format === 'pdf'
        ? ['Convert PDF pages to images.', 'Inspect page count/text layer and OCR needs.', 'Attach rendered page image paths to evidence_refs.']
        : ['Use parse/inspect output for structure QA.', 'For high-fidelity QA, convert to PDF or screenshots before final acceptance.'];
    let render: ToolResult | null = null;
    if (input.execute && format === 'pptx') {
      render = await this.delegates.runtime.execute({
        action: 'pptx_thumbnail',
        input_path: input.input_path,
        output_prefix: input.output_prefix,
        timeout_seconds: input.timeout_seconds,
      }, context);
    } else if (input.execute && format === 'pdf') {
      render = await this.delegates.runtime.execute({
        action: 'pdf_to_images',
        input_path: input.input_path,
        output_dir: input.output_dir,
        timeout_seconds: input.timeout_seconds,
      }, context);
    }
    return {
      success: true,
      data: {
        path,
        format,
        previewMetadata: preview.metadata || {},
        plan,
        executed: Boolean(input.execute && RENDER_QA_EXECUTABLE_FORMATS.has(format)),
        render,
      },
    };
  }
}

export default OfficeOpsTool;
