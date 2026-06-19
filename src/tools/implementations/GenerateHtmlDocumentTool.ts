/**
 * generate_html_document —— 凌霄 HTML 办公底座的统一入口工具。
 *
 * 与 generate_html_presentation（纯透传、LLM 自写完整 HTML）互补：本工具是
 * **结构化**入口——LLM 给 {mode, theme, slides|blocks, exports}，引擎装配
 * 凌霄中式主题 HTML，并按需导出到 PDF / PNG / DOCX / XLSX / PPTX。
 *
 * 这是"单一 HTML 底座代替 PPT/DOC/XLS/PDF"的产品落点：HTML 是唯一渲染源，
 * 用户要什么格式就导什么——PDF/PPTX 走 Chromium 高保真，DOCX/XLSX 走可编辑映射。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath, lockedAtomicWriteBuffer } from './utils.js';
import { ensureExtension } from './OfficeXmlBuilder.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { runHtmlOffice, type HtmlExportTarget } from './office/html/HtmlOfficeEngine.js';

const SlideSchema = z.union([
  z.object({ kind: z.literal('cover'), title: z.string(), subtitle: z.string().optional(), presenter: z.string().optional(), date: z.string().optional() }),
  z.object({ kind: z.literal('section'), index: z.string().optional(), title: z.string(), subtitle: z.string().optional() }),
  z.object({ kind: z.literal('bullets'), kicker: z.string().optional(), title: z.string(), items: z.array(z.string()) }),
  z.object({ kind: z.literal('two_column'), title: z.string(), leftTitle: z.string().optional(), leftItems: z.array(z.string()), rightTitle: z.string().optional(), rightItems: z.array(z.string()) }),
  z.object({ kind: z.literal('quote'), quote: z.string(), attribution: z.string().optional() }),
  z.object({ kind: z.literal('big_number'), value: z.string(), label: z.string(), caption: z.string().optional() }),
  z.object({ kind: z.literal('matrix'), title: z.string(), columns: z.array(z.string()), rows: z.array(z.object({ label: z.string(), cells: z.array(z.string()) })) }),
  z.object({ kind: z.literal('timeline'), title: z.string(), steps: z.array(z.object({ time: z.string(), title: z.string(), detail: z.string().optional() })) }),
  z.object({ kind: z.literal('evidence'), title: z.string(), finding: z.string(), details: z.array(z.string()).default([]), severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional() }),
  z.object({ kind: z.literal('closing'), title: z.string(), message: z.string().optional(), contact: z.string().optional() }),
]);

const DocBlockSchema = z.union([
  z.object({ kind: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string(), id: z.string().optional() }),
  z.object({ kind: z.literal('paragraph'), text: z.string() }),
  z.object({ kind: z.literal('callout'), variant: z.enum(['note', 'warn', 'tip', 'seal']), title: z.string().optional(), text: z.string() }),
  z.object({ kind: z.literal('table'), columns: z.array(z.string()), rows: z.array(z.array(z.string())), caption: z.string().optional() }),
  z.object({ kind: z.literal('figure'), src: z.string(), caption: z.string().optional() }),
  z.object({ kind: z.literal('list'), ordered: z.boolean().optional(), items: z.array(z.string()) }),
  z.object({ kind: z.literal('page_break') }),
  z.object({ kind: z.literal('toc'), title: z.string().optional() }),
]);

const GenerateHtmlDocumentSchema = z.object({
  output_path: z.string().describe('输出 HTML 主文件路径（相对 workspace）。导出的 PDF/DOCX/XLSX/PPTX 会用同名前缀。'),
  title: z.string().describe('文档/演示标题（用于封面与 <title>）。'),
  theme: z.enum(['ink-wash', 'vermilion', 'cyan-blade', 'gold-leaf', 'papyrus', 'editorial', 'dark-luxury']).default('ink-wash').describe('凌霄办公主题（8 套可选）：ink-wash（墨韵极简）、vermilion（朱砂典藏）、cyan-blade（青锋科技）、gold-leaf（金箔商务）、papyrus（宣纸纯净）、editorial（编辑杂志）、dark-luxury（暗色高级）。根据内容性质选择匹配风格。'),
  mode: z.enum(['slides', 'document']).describe('slides=16:9 演示；document=A4 长文档。'),
  slides: z.array(SlideSchema).optional().describe('mode=slides 时必填：幻灯片数组。'),
  blocks: z.array(DocBlockSchema).optional().describe('mode=document 时必填：文档块数组。'),
  footer: z.string().optional().describe('slides 模式页脚（每页右下）。'),
  author: z.string().optional().describe('document 模式作者。'),
  exports: z.array(z.enum(['pdf', 'png', 'docx', 'xlsx', 'pptx'])).default([]).describe('除 HTML 外要同时导出的原生格式。slides 模式可导 pdf/png/pptx；document 可导 pdf/docx/xlsx。'),
}).superRefine((val, ctx) => {
  if (val.mode === 'slides' && (!val.slides || val.slides.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mode=slides 时 slides 不能为空' });
  }
  if (val.mode === 'document' && (!val.blocks || val.blocks.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mode=document 时 blocks 不能为空' });
  }
});

export class GenerateHtmlDocumentTool extends Tool {
  name = 'generate_html_document';
  description = `凌霄 HTML 办公底座（世界级）：用结构化数据生成带中式审美的 HTML 演示/文档，并可一键导出 PDF/PNG/DOCX/XLSX/PPTX。HTML 是唯一渲染源——要 PPT 走 pptx、要 Word 走 docx、要表格走 xlsx、要分发走 pdf，全部从同一份 HTML 导出。

何时用本工具（而非 generate_html_presentation）：
- 需要凌霄办公主题（墨韵/朱砂/青锋/金箔/宣纸/编辑/暗夜）的演示或文档。
- 需要从同一内容同时产出 PDF + DOCX/PPTX/XLSX。
- 内容是结构化的（幻灯片布局、文档章节、表格）。

主题说明：ink-wash=水墨极简(默认)、vermilion=朱砂典藏、cyan-blade=青锋科技、gold-leaf=金箔商务、papyrus=宣纸纯净(打印/学术)。

导出说明：pdf=Chromium 高保真矢量(首选分发)；pptx=逐 slide 图片拼装(视觉1:1，含演讲者备注，文字不可编辑)；docx=可编辑Word；xlsx=可编辑Excel(支持 data-formula)；png=逐页高清图。`;

  parameters = GenerateHtmlDocumentSchema;

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = GenerateHtmlDocumentSchema.parse(input);
    const resolvedPath = resolveTaskWritePath(context.workspace, parsed.output_path, context.sessionId, context.taskWriteScope);
    const htmlPath = ensureExtension(resolvedPath, '.html');

    const targets = parsed.exports as readonly HtmlExportTarget[];
    const spec = parsed.mode === 'slides'
      ? { mode: 'slides' as const, theme: parsed.theme, title: parsed.title, footer: parsed.footer, slides: parsed.slides! }
      : { mode: 'document' as const, theme: parsed.theme, title: parsed.title, author: parsed.author, blocks: parsed.blocks! };
    const result = await runHtmlOffice(spec, { htmlPath, targets });

    // 重新落盘 HTML 主产物（runHtmlOffice 已写，这里确保 download artifact 指向它）
    await lockedAtomicWriteBuffer(htmlPath, Buffer.from(result.assembled.html, 'utf-8'), { createDirs: true });

    const summary = {
      mode: result.assembled.mode,
      theme: result.assembled.theme.id,
      theme_label: result.assembled.theme.label,
      count: result.assembled.count,
      artifacts: result.artifacts.map((a: { target: string; path: string; bytes: number; detail?: Record<string, unknown> }) => ({ target: a.target, path: a.path, bytes: a.bytes, ...a.detail })),
      errors: result.errors,
    };

    let previewUrl: string | undefined;
    try {
      const artifact = tempDownloadRegistry.create({
        path: htmlPath,
        mimeType: 'text/html',
        name: htmlPath.split('/').pop() || 'document.html',
        sessionId: context.sessionId,
      });
      previewUrl = artifact.url;
      (summary as { preview_url?: string }).preview_url = previewUrl;
    } catch {
      // 下载链接创建失败不影响主返回。
    }

    if (result.errors.length && result.artifacts.length <= 1) {
      return { success: false, data: summary, error: `部分导出失败: ${result.errors.join('; ')}` };
    }
    return { success: true, data: summary };
  }
}
