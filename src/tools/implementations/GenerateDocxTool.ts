import { z } from 'zod';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import type { FileChild, IStylesOptions } from 'docx';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension, slugFileName } from './OfficeXmlBuilder.js';
import { resolveTaskWritePath, lockedAtomicWriteBuffer } from './utils.js';
import {
  isOfficeTemplatePresetId,
  officeTemplateMetadata,
  resolveOfficeTemplatePreset,
  type OfficeTemplatePreset,
} from './office/OfficeTemplateRegistry.js';

const DocxBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: z.string(),
    level: z.number().int().min(1).max(3).default(1),
  }),
  z.object({
    type: z.literal('paragraph'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('bullets'),
    items: z.array(z.string()).min(1).max(100),
  }),
  z.object({
    type: z.literal('table'),
    headers: z.array(z.string()).min(1).max(20),
    rows: z.array(z.array(z.string())).max(200),
  }),
  z.object({
    type: z.literal('page_break'),
  }),
]);

const GenerateDocxSchema = z.object({
  path: z.string().optional().describe('输出 docx 路径。可省略，默认写入当前 session scratchpad。'),
  title: z.string().min(1).max(200).describe('文档标题，也用于默认文件名'),
  subtitle: z.string().max(300).optional(),
  author: z.string().max(120).default('LingXiao'),
  template: z.string().refine(isOfficeTemplatePresetId, '未知模板 preset').optional().describe('模板 preset ID（10 套可选）：lingxiao_board（董事会）、enterprise_report（企业报告）、product_strategy（产品策略）、ink_wash（墨韵极简）、vermilion（朱砂典藏）、cyan_blade（青锋科技）、gold_leaf（金箔商务）、editorial（编辑杂志）、dark_luxury（暗色高级）、papyrus（宣纸纯净）。根据内容性质选择匹配风格，不要默认用同一套。'),
  blocks: z.array(DocxBlockSchema).min(1).max(400).describe('文档块：heading/paragraph/bullets/table/page_break'),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

type GenerateDocxInput = z.infer<typeof GenerateDocxSchema>;

export class GenerateDocxTool extends Tool {
  readonly name = 'generate_docx';
  readonly description = '生成原生可编辑 DOCX 文档。支持标题、段落、项目符号、表格和分页，适合方案书、纪要、合同草案、汇报材料等 Office 工作流。';
  readonly parameters = GenerateDocxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = GenerateDocxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const input = parsed.data;
    const defaultName = `${slugFileName(input.title, 'document')}.docx`;
    const requestedPath = input.path || `.lingxiao/sessions/${context?.sessionId || 'default'}/scratchpad/${defaultName}`;

    let outputPath: string;
    try {
      outputPath = ensureExtension(resolveTaskWritePath(context?.workspace, requestedPath, context?.sessionId, context?.taskWriteScope), '.docx');
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }

    try {
      const {
        AlignmentType,
        BorderStyle,
        Document,
        Footer,
        HeadingLevel,
        Header,
        Packer,
        PageBreak,
        PageNumber,
        Paragraph,
        Table,
        TableCell,
        TableRow,
        TextRun,
        WidthType,
      } = await import('docx');

      const template = resolveOfficeTemplatePreset(input.template);
      const palette = template.palette;
      const children: FileChild[] = [
        new Paragraph({
          children: [
            new TextRun({
              text: template.cover.kicker,
              color: palette.accent,
              bold: true,
              size: 18,
              font: template.themeFonts.body,
            }),
          ],
          spacing: { before: 120, after: 220 },
        }),
        new Paragraph({
          text: input.title,
          heading: HeadingLevel.TITLE,
          alignment: template.cover.titleAlign === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { after: 240 },
          border: {
            bottom: {
              color: palette.accent2,
              style: BorderStyle.SINGLE,
              size: 8,
            },
          },
        }),
      ];

      if (input.subtitle) {
        children.push(new Paragraph({
          children: [new TextRun({ text: input.subtitle, italics: true, color: palette.muted, font: template.themeFonts.body })],
          alignment: template.cover.titleAlign === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { after: 360 },
        }));
      }

      children.push(new Paragraph({
        children: [new TextRun({ text: `${template.title.eyebrow} | ${input.author}`, color: palette.muted, size: 18 })],
        spacing: { after: 420 },
      }));

      for (const block of input.blocks) {
        if (block.type === 'heading') {
          const heading = block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
          children.push(new Paragraph({
            text: block.text,
            heading,
            spacing: { before: 220, after: 120 },
          }));
        } else if (block.type === 'paragraph') {
          children.push(new Paragraph({
            children: [new TextRun({ text: block.text, font: template.themeFonts.body, color: palette.text })],
            spacing: { after: 160 },
          }));
        } else if (block.type === 'bullets') {
          for (const item of block.items) {
            children.push(new Paragraph({
              children: [new TextRun({ text: item, font: template.themeFonts.body, color: palette.text })],
              bullet: { level: 0 },
              spacing: { after: 80 },
            }));
          }
        } else if (block.type === 'table') {
          children.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: block.headers.map((header) => new TableCell({
                  shading: { fill: palette.line },
                  children: [new Paragraph({ children: [new TextRun({ text: header, bold: true, color: palette.text, font: template.themeFonts.body })] })],
                })),
              }),
              ...block.rows.map((row) => new TableRow({
                children: block.headers.map((_, index) => new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: row[index] ?? '', font: template.themeFonts.body, color: palette.text })],
                  })],
                })),
              })),
            ],
          }));
          children.push(new Paragraph({ text: '', spacing: { after: 160 } }));
        } else if (block.type === 'page_break') {
          children.push(new Paragraph({ children: [new PageBreak()] }));
        }
      }

      const doc = new Document({
        creator: input.author,
        title: input.title,
        description: input.subtitle,
        subject: template.name,
        keywords: template.id,
        styles: this.buildDocxStyles(template),
        sections: [{
          properties: {
            titlePage: true,
            page: {
              margin: {
                top: 1440,
                right: 1260,
                bottom: 1260,
                left: 1260,
                header: 720,
                footer: 720,
              },
            },
          },
          headers: {
            first: new Header({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: template.name, color: palette.inverseText, size: 16 })],
                  shading: { fill: palette.accent },
                  spacing: { after: 80 },
                }),
              ],
            }),
            default: new Header({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: template.pageDefaults.headerText, color: palette.muted, size: 18, font: template.themeFonts.body })],
                  border: { bottom: { color: palette.line, style: BorderStyle.SINGLE, size: 2 } },
                }),
              ],
            }),
          },
          footers: {
            first: new Footer({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: `${template.pageDefaults.footerText} | ${input.author}`, color: palette.muted, size: 16 })],
                  alignment: AlignmentType.RIGHT,
                }),
              ],
            }),
            default: new Footer({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: template.pageDefaults.footerText, color: palette.muted, size: 16 }),
                    new TextRun({ text: ' | Page ', color: palette.muted, size: 16 }),
                    new TextRun({ children: [PageNumber.CURRENT], color: palette.muted, size: 16 }),
                  ],
                  alignment: AlignmentType.RIGHT,
                  border: { top: { color: palette.line, style: BorderStyle.SINGLE, size: 2 } },
                }),
              ],
            }),
          },
          children,
        }],
      });

      const buffer = await Packer.toBuffer(doc);
      mkdirSync(dirname(outputPath), { recursive: true });
      await lockedAtomicWriteBuffer(outputPath, buffer, { createDirs: true });

      const artifact = input.create_download_link
        ? tempDownloadRegistry.create({
          path: outputPath,
          name: defaultName,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          expiresInSeconds: input.expires_in_seconds,
          sessionId: context?.sessionId,
        })
        : undefined;

      return {
        success: true,
        data: artifact
          ? { ...artifact, blockCount: input.blocks.length, ...officeTemplateMetadata(template) }
          : { path: resolve(outputPath), blockCount: input.blocks.length, ...officeTemplateMetadata(template) },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private buildDocxStyles(template: OfficeTemplatePreset): IStylesOptions {
    const { palette, themeFonts, pageDefaults } = template;
    return {
      default: {
        document: {
          run: {
            font: themeFonts.body,
            size: pageDefaults.bodySize,
            color: palette.text,
          },
          paragraph: {
            spacing: { after: 160, line: 276 },
          },
        },
      },
      paragraphStyles: [
        {
          id: 'Title',
          name: 'Title',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: themeFonts.heading,
            size: pageDefaults.titleSize,
            bold: true,
            color: palette.text,
          },
          paragraph: {
            spacing: { before: 120, after: 240 },
          },
        },
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: themeFonts.heading,
            size: pageDefaults.heading1Size,
            bold: true,
            color: palette.accent,
          },
          paragraph: {
            spacing: { before: 300, after: 120 },
          },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: themeFonts.heading,
            size: pageDefaults.heading2Size,
            bold: true,
            color: palette.text,
          },
          paragraph: {
            spacing: { before: 220, after: 100 },
          },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: themeFonts.heading,
            size: Math.max(pageDefaults.bodySize + 2, 22),
            bold: true,
            color: palette.muted,
          },
          paragraph: {
            spacing: { before: 180, after: 80 },
          },
        },
      ],
    };
  }
}

export default GenerateDocxTool;
