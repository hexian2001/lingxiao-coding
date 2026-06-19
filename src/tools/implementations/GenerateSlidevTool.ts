import { z } from 'zod';
import { basename } from 'path';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { slidevServerManager } from '../../core/SlidevServerManager.js';
import { buildSlidevProject } from '../slidev/SlidevProjectBuilder.js';
import { exportSlidevDeck, slidevExportName } from '../slidev/SlidevExporter.js';

const GenerateSlidevSchema = z.object({
  output_dir: z.string().optional().describe('Slidev 项目输出目录。省略时写入当前 session scratchpad。'),
  title: z.string().optional().describe('演示标题，用于项目名和 frontmatter 默认标题。'),
  markdown: z.string().min(1).describe('完整 Slidev slides.md 内容。应包含 frontmatter、--- 分页、布局指令、代码块或 Mermaid 图表。'),
  theme: z.string().default('default').describe('Slidev 主题名。内置支持 default、seriph、apple-basic；自定义主题需由项目依赖提供。'),
  style_css: z.string().optional().describe('可选全局 CSS，写入 style.css。'),
  start_preview: z.boolean().default(true).describe('是否启动内置 Slidev dev server 并返回 previewUrl。'),
  export_formats: z.array(z.enum(['pdf', 'pptx', 'png'])).default([]).describe('需要导出的格式。PPTX 为图片拼装，文字不可编辑。'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).optional().describe('预览端口。省略或 0 时自动分配。'),
  create_project_zip: z.boolean().default(true),
  create_download_links: z.boolean().default(true),
  timeout_ms: z.number().int().min(10_000).max(600_000).default(120_000),
});

type ExportArtifact = ReturnType<typeof tempDownloadRegistry.create> & {
  format: 'pdf' | 'pptx' | 'png';
  warning?: string;
};

export class GenerateSlidevTool extends Tool {
  readonly name = 'generate_slidev';
  readonly description = '生成 Slidev Markdown 演示项目，支持内置运行时预览和 PDF/PPTX/PNG 导出。适用于代码高亮、Mermaid、Markdown-first 的技术分享和商务演示。内置主题：default、seriph、apple-basic。';
  readonly parameters = GenerateSlidevSchema;

  async execute(input: unknown, context: ToolContext = {}): Promise<ToolResult> {
    const params = GenerateSlidevSchema.parse(input);
    const warnings: string[] = [];

    try {
      const project = await buildSlidevProject({
        workspace: context.workspace,
        sessionId: context.sessionId,
        taskWriteScope: context.taskWriteScope,
        outputDir: params.output_dir,
        title: params.title,
        markdown: params.markdown,
        theme: params.theme,
        styleCss: params.style_css,
      });
      warnings.push(...project.warnings);

      let projectArtifact: ReturnType<typeof tempDownloadRegistry.create> | undefined;
      if (params.create_project_zip && params.create_download_links) {
        projectArtifact = tempDownloadRegistry.create({
          path: project.zipPath,
          name: basename(project.zipPath),
          mimeType: 'application/zip',
          expiresInSeconds: undefined,
          sessionId: context.sessionId,
        });
      }

      let preview: Awaited<ReturnType<typeof slidevServerManager.start>> | undefined;
      if (params.start_preview) {
        preview = await slidevServerManager.start({
          projectDir: project.projectDir,
          slidesPath: project.slidesPath,
          host: params.host,
          port: params.port,
        });
      }

      const exported = await exportSlidevDeck({
        projectDir: project.projectDir,
        slidesPath: project.slidesPath,
        formats: params.export_formats,
        outputBaseName: project.slug,
        timeoutMs: params.timeout_ms,
      });

      const exportArtifacts: ExportArtifact[] = params.create_download_links
        ? exported.map(item => ({
          ...tempDownloadRegistry.create({
            path: item.path,
            name: slidevExportName(item.path),
            mimeType: item.mimeType,
            expiresInSeconds: undefined,
            sessionId: context.sessionId,
          }),
          format: item.format,
          warning: item.warning,
        }))
        : exported.map(item => ({
          type: 'download_artifact' as const,
          token: '',
          url: '',
          name: slidevExportName(item.path),
          path: item.path,
          size: 0,
          mimeType: item.mimeType,
          expiresAt: '',
          format: item.format,
          warning: item.warning,
        }));
      warnings.push(...exported.map(item => item.warning).filter((item): item is string => Boolean(item)));

      const previewUrl = preview?.id ? `/api/v1/slidev/preview/${preview.id}/` : undefined;
      const data = projectArtifact ? {
        ...projectArtifact,
        kind: 'slidev',
        previewUrl,
        rawPreviewUrl: preview?.url,
        previewId: preview?.id,
        projectDir: project.projectDir,
        slidesPath: project.slidesPath,
        exports: exportArtifacts,
        warnings,
        mode: 'slidev',
      } : {
        message: `Slidev 项目已生成: ${project.projectDir}`,
        kind: 'slidev',
        previewUrl,
        rawPreviewUrl: preview?.url,
        previewId: preview?.id,
        projectDir: project.projectDir,
        slidesPath: project.slidesPath,
        zipPath: project.zipPath,
        exports: exportArtifacts,
        warnings,
        mode: 'slidev',
      };

      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        data: { warnings },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
