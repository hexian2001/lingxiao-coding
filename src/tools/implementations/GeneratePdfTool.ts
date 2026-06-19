import { z } from 'zod';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath, lockedAtomicWriteBuffer } from './utils.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension, slugFileName } from './OfficeXmlBuilder.js';

const PdfSectionSchema = z.object({
  heading: z.string().optional().describe('章节标题'),
  paragraphs: z.array(z.string()).optional().describe('段落文本数组'),
  bullets: z.array(z.string()).optional().describe('无序列表项'),
  table: z.object({
    headers: z.array(z.string()).min(1).max(10),
    rows: z.array(z.array(z.string())).max(100),
  }).optional().describe('表格数据'),
  image: z.object({
    path: z.string().describe('图片文件路径'),
    width: z.number().optional().describe('图片宽度（点），默认自动适配'),
    caption: z.string().optional().describe('图片说明'),
  }).optional().describe('嵌入图片'),
  page_break: z.boolean().optional().describe('是否在此节后分页'),
});

const GeneratePdfSchema = z.object({
  output_path: z.string().describe('输出 PDF 文件路径'),
  title: z.string().optional().describe('文档标题（显示在首页）'),
  content: z.object({
    title: z.string().optional().describe('封面标题'),
    sections: z.array(PdfSectionSchema).min(1).max(100).describe('内容章节数组'),
  }).describe('PDF 内容结构'),
  options: z.object({
    page_size: z.enum(['A4', 'Letter']).default('A4').describe('页面尺寸'),
    margins: z.object({
      top: z.number().default(72),
      bottom: z.number().default(72),
      left: z.number().default(72),
      right: z.number().default(72),
    }).optional().describe('页边距（点，1英寸=72点）'),
    font: z.string().default('Helvetica').describe('字体名称'),
    font_size: z.number().default(12).describe('正文字号'),
  }).optional().describe('PDF 生成选项'),
  create_download_link: z.boolean().default(true).describe('是否创建下载链接'),
  expires_in_seconds: z.number().optional().describe('下载链接过期时间（秒）'),
});

type GeneratePdfInput = z.infer<typeof GeneratePdfSchema>;
type PdfSection = z.infer<typeof PdfSectionSchema>;
type PdfDocumentConstructor = new (options?: PDFKit.PDFDocumentOptions) => PDFKit.PDFDocument;

function resolvePdfDocumentConstructor(moduleValue: unknown): PdfDocumentConstructor | null {
  if (typeof moduleValue === 'function') return moduleValue as PdfDocumentConstructor;
  if (moduleValue && typeof moduleValue === 'object' && 'default' in moduleValue) {
    const defaultExport = (moduleValue as { default?: unknown }).default;
    if (typeof defaultExport === 'function') return defaultExport as PdfDocumentConstructor;
  }
  return null;
}

export class GeneratePdfTool extends Tool {
  name = 'generate_pdf';
  description = `生成 PDF 文档。支持文本、标题、列表、表格、图片等内容。

**功能特性**:
- 支持多级标题和段落
- 支持无序列表
- 支持表格（带边框和条纹行）
- 支持图片嵌入（自动缩放）
- 支持页眉页脚和页码
- 支持自定义页面尺寸和边距

**使用场景**:
- 生成报告文档
- 创建技术文档
- 导出数据表格
- 制作图文混排文档

**示例**:
\`\`\`json
{
  "output_path": "report.pdf",
  "title": "项目报告",
  "content": {
    "title": "2026 年度项目总结",
    "sections": [
      {
        "heading": "概述",
        "paragraphs": ["本报告总结了 2026 年的项目进展..."]
      },
      {
        "heading": "关键指标",
        "table": {
          "headers": ["指标", "目标", "实际"],
          "rows": [["用户增长", "10%", "12%"]]
        }
      }
    ]
  }
}
\`\`\``;

  parameters = GeneratePdfSchema;

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = GeneratePdfSchema.parse(input);
    const { output_path, title, content, options, create_download_link, expires_in_seconds } = parsed;

    // 动态导入 pdfkit（运行时加载，避免编译时依赖）
    let PDFDocument: PdfDocumentConstructor;
    try {
      // @ts-ignore - pdfkit 可能未安装，运行时动态加载
      const pdfkitModule = await import('pdfkit');
      const constructor = resolvePdfDocumentConstructor(pdfkitModule);
      if (!constructor) throw new Error('pdfkit module did not expose a PDFDocument constructor');
      PDFDocument = constructor;
    } catch (error) {
      return {
        success: false,
        data: null,
        error: 'pdfkit 未安装。请运行: npm install pdfkit @types/pdfkit',
      };
    }

    // 解析输出路径
    const resolvedPath = resolveTaskWritePath(context.workspace, output_path, context.sessionId, context.taskWriteScope);
    const finalPath = ensureExtension(resolvedPath, '.pdf');

    // 确保目录存在
    const dir = dirname(finalPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 创建 PDF 文档
    const pdfOptions = {
      size: options?.page_size || 'A4',
      margins: options?.margins || { top: 72, bottom: 72, left: 72, right: 72 },
      info: {
        Title: title || content.title || 'Document',
        Author: 'Lingxiao CLI',
        CreationDate: new Date(),
      },
    };

    const doc = new PDFDocument(pdfOptions);
    const chunks: Buffer[] = [];

    // 收集 PDF 数据
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const pdfPromise = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const fontSize = options?.font_size || 12;
    const font = options?.font || 'Helvetica';

    // 渲染封面标题
    if (content.title) {
      doc.fontSize(24).font(`${font}-Bold`).text(content.title, {
        align: 'center',
      });
      doc.moveDown(2);
    }

    // 渲染各章节
    for (const section of content.sections) {
      // 标题
      if (section.heading) {
        doc.fontSize(18).font(`${font}-Bold`).text(section.heading);
        doc.moveDown(0.5);
      }

      // 段落
      if (section.paragraphs) {
        doc.fontSize(fontSize).font(font);
        for (const para of section.paragraphs) {
          doc.text(para, { align: 'left' });
          doc.moveDown(0.5);
        }
      }

      // 列表
      if (section.bullets) {
        doc.fontSize(fontSize).font(font);
        for (const bullet of section.bullets) {
          doc.text(`• ${bullet}`, { indent: 20 });
        }
        doc.moveDown(0.5);
      }

      // 表格
      if (section.table) {
        await this.renderTable(doc, section.table, fontSize, font);
        doc.moveDown(1);
      }

      // 图片
      if (section.image) {
        await this.renderImage(doc, section.image);
        doc.moveDown(1);
      }

      // 分页
      if (section.page_break) {
        doc.addPage();
      }
    }

    // 添加页码
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(10).text(
        `第 ${i + 1} 页 / 共 ${pages.count} 页`,
        0,
        doc.page.height - 50,
        { align: 'center' }
      );
    }

    // 完成文档
    doc.end();

    // 等待 PDF 生成完成
    const pdfBuffer = await pdfPromise;

    // 写入文件
    await lockedAtomicWriteBuffer(finalPath, pdfBuffer, { createDirs: true });

    // 创建下载链接
    const fileName = slugFileName(title || content.title || 'document', 'document') + '.pdf';
    const artifact = create_download_link
      ? tempDownloadRegistry.create({
        path: finalPath,
        name: fileName,
        mimeType: 'application/pdf',
        expiresInSeconds: expires_in_seconds,
        sessionId: context.sessionId,
      })
      : undefined;

    return {
      success: true,
      data: artifact ? {
        ...artifact,
        file_path: finalPath,
        page_count: pages.count,
        file_size: pdfBuffer.length,
      } : {
        message: `PDF 已生成: ${finalPath}`,
        path: finalPath,
        file_path: finalPath,
        page_count: pages.count,
        file_size: pdfBuffer.length,
      },
    };
  }

  private async renderTable(
    doc: PDFKit.PDFDocument,
    table: { headers: string[]; rows: string[][] },
    fontSize: number,
    font: string
  ): Promise<void> {
    const { headers, rows } = table;
    const colCount = headers.length;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / colCount;
    const rowHeight = 25;

    let y = doc.y;

    // 绘制表头
    doc.fontSize(fontSize).font(`${font}-Bold`);
    for (let i = 0; i < headers.length; i++) {
      const x = doc.page.margins.left + i * colWidth;
      doc.rect(x, y, colWidth, rowHeight).stroke();
      doc.text(headers[i], x + 5, y + 5, {
        width: colWidth - 10,
        height: rowHeight - 10,
        ellipsis: true,
      });
    }
    y += rowHeight;

    // 绘制数据行
    doc.fontSize(fontSize).font(font);
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const isStriped = rowIdx % 2 === 0;

      for (let colIdx = 0; colIdx < row.length && colIdx < colCount; colIdx++) {
        const x = doc.page.margins.left + colIdx * colWidth;
        
        // 条纹背景
        if (isStriped) {
          doc.rect(x, y, colWidth, rowHeight).fillAndStroke('#f9f9f9', '#000000');
        } else {
          doc.rect(x, y, colWidth, rowHeight).stroke();
        }

        doc.fillColor('#000000').text(row[colIdx] || '', x + 5, y + 5, {
          width: colWidth - 10,
          height: rowHeight - 10,
          ellipsis: true,
        });
      }
      y += rowHeight;

      // 检查是否需要分页
      if (y > doc.page.height - doc.page.margins.bottom - 50) {
        doc.addPage();
        y = doc.page.margins.top;
      }
    }

    doc.y = y;
  }

  private async renderImage(
    doc: PDFKit.PDFDocument,
    image: { path: string; width?: number; caption?: string }
  ): Promise<void> {
    const { path, width, caption } = image;

    if (!existsSync(path)) {
      doc.text(`[图片不存在: ${path}]`, { align: 'center' });
      return;
    }

    try {
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const imgWidth = width || pageWidth * 0.8;

      doc.image(path, {
        fit: [imgWidth, 400],
        align: 'center',
      });

      if (caption) {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#666666').text(caption, { align: 'center' }).fillColor('#000000');
      }
    } catch (error) {
      doc.text(`[图片加载失败: ${error instanceof Error ? error.message : String(error)}]`, {
        align: 'center',
      });
    }
  }
}
