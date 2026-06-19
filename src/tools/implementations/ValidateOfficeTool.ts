import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveWorkspacePath } from './utils.js';
import { validateOfficeFile } from './office/OfficeValidator.js';

const ValidateOfficeSchema = z.object({
  path: z.string().describe('要验收的 PPTX/DOCX/PDF 文件路径。相对路径按当前 workspace 解析。'),
  format: z.enum(['auto', 'pptx', 'docx', 'pdf']).default('auto').describe('文件格式；默认 auto 根据 magic bytes 和扩展名判断。'),
  expected_texts: z.array(z.string()).max(100).default([]).describe('必须能在文档文本层中找到的文本片段。PDF 无可靠文本层时会返回 warning。'),
  expected_slide_count: z.number().int().min(0).optional().describe('PPTX 期望幻灯片页数。'),
  expected_page_count: z.number().int().min(0).optional().describe('PDF 期望页数。'),
  min_pages: z.number().int().min(0).optional().describe('PDF 最小页数。'),
  expected_native_comments: z.number().int().min(0).optional().describe('DOCX 期望至少包含的 Word 原生批注数量。'),
  expected_tracked_revisions: z.number().int().min(0).optional().describe('DOCX 期望至少包含的 w:ins/w:del 修订标记数量。'),
  expected_chart_count: z.number().int().min(0).optional().describe('PPTX 期望至少包含的图表 part 数量。'),
  require_animation_plan: z.boolean().default(false).describe('PPTX 是否要求包含 LingXiao 动画计划 customXml 或原生 p:timing 动画。'),
  require_slide_master: z.boolean().default(false).describe('PPTX 是否要求包含 slide master。'),
  open_check: z.boolean().default(false).describe('是否尝试用已安装 Office/WPS/LibreOffice 进行真机/本机打开验收。LibreOffice 会执行 headless 转 PDF 真检查；WPS/PowerPoint 不可用或无稳定自动化适配时返回结构化 skipped/warning。'),
  open_check_apps: z.array(z.enum(['libreoffice', 'wps', 'powerpoint'])).max(3).optional().describe('open_check 目标应用；默认尝试 libreoffice/wps/powerpoint。每个 adapter 会返回可用性、命令、stdout/stderr 摘要、耗时和 skipped/warning/executed 状态。'),
});

type ValidateOfficeInput = z.infer<typeof ValidateOfficeSchema>;

export class ValidateOfficeTool extends Tool {
  readonly name = '__office_delegate_validate';
  readonly description = '验收 PPTX/DOCX/PDF 生成或编辑结果，输出稳定 machine-readable JSON。检查 OOXML 包结构、页数/幻灯片数、图片关系目标、文本期望、PDF 基础合法性，并可用 LibreOffice/WPS/PowerPoint adapter 做本机打开矩阵验收。';
  readonly parameters = ValidateOfficeSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = ValidateOfficeSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }

    const input: ValidateOfficeInput = parsed.data;
    const filePath = resolveWorkspacePath(context?.workspace, input.path, context?.sessionId);
    const result = await validateOfficeFile({
      path: filePath,
      format: input.format,
      expectedTexts: input.expected_texts,
      expectedSlideCount: input.expected_slide_count,
      expectedPageCount: input.expected_page_count,
      minPages: input.min_pages,
      expectedNativeComments: input.expected_native_comments,
      expectedTrackedRevisions: input.expected_tracked_revisions,
      expectedChartCount: input.expected_chart_count,
      requireAnimationPlan: input.require_animation_plan,
      requireSlideMaster: input.require_slide_master,
      openCheck: input.open_check,
      openCheckApps: input.open_check_apps,
    });

    return { success: true, data: result };
  }
}

export default ValidateOfficeTool;
