import { mkdir } from 'fs/promises';
import { basename, dirname, extname, parse, resolve } from 'path';
import sharp from 'sharp';
import { glob } from 'glob';
import { z } from 'zod';
import { supportsVisionFromProvider } from '../../llm/model_capabilities.js';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath, resolveWorkspacePath } from './utils.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const ImageInputSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    label: z.string().min(1).optional(),
  }),
]);

const VisualContactSheetSchema = z.object({
  images: z.array(ImageInputSchema).min(1).max(80).optional().describe('要拼接的图片路径列表。每项可为路径字符串，或 { path, label }。'),
  directory: z.string().min(1).optional().describe('从目录读取图片；未传 images 时使用。'),
  pattern: z.string().min(1).optional().default('*.{png,jpg,jpeg,webp,gif}').describe('directory 模式下的 glob pattern，默认读取常见图片格式。'),
  recursive: z.boolean().optional().default(false).describe('directory 模式下是否递归读取子目录。'),
  output_path: z.string().min(1).optional().describe('输出 PNG 路径，默认写入 .lingxiao/artifacts。'),
  columns: z.number().int().min(1).max(8).optional().describe('列数，默认按数量自动选择，最多 4 列。'),
  thumbnail: z.object({
    width: z.number().int().min(120).max(960).optional(),
    height: z.number().int().min(90).max(720).optional(),
  }).optional().describe('每张缩略图的最大尺寸，默认 360x250，适合 PC 页面总览。'),
  gap: z.number().int().min(0).max(80).optional().default(16).describe('缩略图之间的间距，默认 16。'),
  padding: z.number().int().min(0).max(120).optional().default(24).describe('整张拼图外边距，默认 24。'),
  labels: z.boolean().optional().default(true).describe('是否在每张图下方显示标签，默认 true。'),
  theme: z.enum(['light', 'dark']).optional().default('light').describe('拼图背景和标签颜色，默认 light。'),
  return_image: z.boolean().optional().default(true).describe('vision 模型下是否同时返回拼图图片内容，默认 true。'),
}).refine((value) => Boolean(value.images?.length || value.directory), {
  message: 'images 或 directory 至少提供一个',
  path: ['images'],
});

type VisualContactSheetParams = z.infer<typeof VisualContactSheetSchema>;

interface ContactSheetItem {
  path: string;
  label: string;
}

interface PreparedTile extends ContactSheetItem {
  width: number;
  height: number;
  buffer: Buffer;
}

function defaultOutputPath(context?: ToolContext): string {
  const workspace = context?.workspace || process.cwd();
  return resolve(workspace, '.lingxiao', 'artifacts', `visual-contact-sheet-${Date.now()}.png`);
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function labelFromPath(filePath: string): string {
  return parse(basename(filePath)).name;
}

function truncateLabel(label: string, max = 42): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function collectDirectoryImages(params: VisualContactSheetParams, context?: ToolContext): Promise<ContactSheetItem[]> {
  if (!params.directory) return [];
  const directory = resolveWorkspacePath(context?.workspace, params.directory, context?.sessionId);
  const pattern = params.recursive
    ? `**/${params.pattern ?? '*.{png,jpg,jpeg,webp,gif}'}`
    : params.pattern ?? '*.{png,jpg,jpeg,webp,gif}';
  const matches = await glob(pattern, {
    cwd: directory,
    nodir: true,
    absolute: true,
    nocase: true,
  });

  return matches
    .filter(isImagePath)
    .sort(naturalCompare)
    .slice(0, 80)
    .map((path) => ({ path, label: labelFromPath(path) }));
}

function resolveImageInputs(params: VisualContactSheetParams, context?: ToolContext): ContactSheetItem[] {
  return (params.images ?? []).map((item) => {
    const rawPath = typeof item === 'string' ? item : item.path;
    const path = resolveWorkspacePath(context?.workspace, rawPath, context?.sessionId);
    const label = typeof item === 'string' ? labelFromPath(path) : item.label ?? labelFromPath(path);
    return { path, label };
  });
}

async function prepareTile(item: ContactSheetItem, thumbnailWidth: number, thumbnailHeight: number): Promise<PreparedTile> {
  const buffer = await sharp(item.path)
    .rotate()
    .resize({
      width: thumbnailWidth,
      height: thumbnailHeight,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const metadata = await sharp(buffer).metadata();
  return {
    ...item,
    buffer,
    width: metadata.width ?? thumbnailWidth,
    height: metadata.height ?? thumbnailHeight,
  };
}

function labelSvg(label: string, width: number, height: number, color: string): Buffer {
  const safe = escapeXml(truncateLabel(label));
  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; font-weight: 500; }
  </style>
  <text x="${width / 2}" y="${Math.floor(height / 2) + 5}" fill="${color}" text-anchor="middle">${safe}</text>
</svg>`;
  return Buffer.from(svg);
}

export class VisualContactSheetTool extends Tool {
  readonly name = 'visual_contact_sheet';
  readonly description = '把一组 PC 截图或图片拼成带标签的总览拼图（contact sheet），用于快速比较页面、主题、状态和视觉层级。输出 PNG 文件，可在 vision 模型下返回图像内容。';
  readonly parameters = VisualContactSheetSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as VisualContactSheetParams;
    try {
      const explicitItems = resolveImageInputs(params, context);
      const directoryItems = explicitItems.length > 0 ? [] : await collectDirectoryImages(params, context);
      const items = explicitItems.length > 0 ? explicitItems : directoryItems;

      if (items.length === 0) {
        return {
          success: false,
          data: null,
          error: '没有找到可拼接的图片。请传 images，或检查 directory/pattern 是否匹配 PNG/JPEG/WebP/GIF 文件。',
        };
      }

      const thumbnailWidth = params.thumbnail?.width ?? 360;
      const thumbnailHeight = params.thumbnail?.height ?? 250;
      const labelHeight = params.labels === false ? 0 : 28;
      const gap = params.gap ?? 16;
      const padding = params.padding ?? 24;
      const columns = params.columns ?? Math.min(4, Math.ceil(Math.sqrt(items.length)));
      const rows = Math.ceil(items.length / columns);
      const tileWidth = thumbnailWidth;
      const tileHeight = thumbnailHeight + labelHeight;
      const width = padding * 2 + columns * tileWidth + (columns - 1) * gap;
      const height = padding * 2 + rows * tileHeight + (rows - 1) * gap;
      const dark = params.theme === 'dark';
      const background = dark ? '#101315' : '#f8faf7';
      const textColor = dark ? '#eff2f1' : '#172025';
      const borderColor = dark ? 'rgba(210, 219, 222, 0.34)' : 'rgba(91, 104, 111, 0.24)';

      const prepared = await Promise.all(items.map((item) => prepareTile(item, thumbnailWidth, thumbnailHeight)));
      const composites: sharp.OverlayOptions[] = [];

      for (let index = 0; index < prepared.length; index += 1) {
        const tile = prepared[index];
        const row = Math.floor(index / columns);
        const col = index % columns;
        const left = padding + col * (tileWidth + gap);
        const top = padding + row * (tileHeight + gap);
        const imageLeft = left + Math.floor((thumbnailWidth - tile.width) / 2);
        const imageTop = top + Math.floor((thumbnailHeight - tile.height) / 2);

        const borderSvg = `
<svg width="${tileWidth}" height="${thumbnailHeight}" viewBox="0 0 ${tileWidth} ${thumbnailHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="${tileWidth - 1}" height="${thumbnailHeight - 1}" fill="transparent" stroke="${borderColor}" />
</svg>`;
        composites.push({ input: Buffer.from(borderSvg), left, top });
        composites.push({ input: tile.buffer, left: imageLeft, top: imageTop });
        if (params.labels !== false) {
          composites.push({
            input: labelSvg(tile.label, tileWidth, labelHeight, textColor),
            left,
            top: top + thumbnailHeight,
          });
        }
      }

      const outputPath = params.output_path
        ? resolveTaskWritePath(context?.workspace, params.output_path, context?.sessionId, context?.taskWriteScope)
        : defaultOutputPath(context);
      await mkdir(dirname(outputPath), { recursive: true });
      await sharp({
        create: {
          width,
          height,
          channels: 4,
          background,
        },
      })
        .composite(composites)
        .png()
        .toFile(outputPath);

      const data = {
        output_path: outputPath,
        image_count: prepared.length,
        skipped_count: Math.max(0, items.length - prepared.length),
        layout: {
          columns,
          rows,
          width,
          height,
          thumbnail: { width: thumbnailWidth, height: thumbnailHeight },
          labels: params.labels !== false,
          theme: params.theme ?? 'light',
        },
        images: prepared.map((item) => ({ path: item.path, label: item.label, width: item.width, height: item.height })),
      };

      const model = typeof context?.model === 'string' ? context.model : '';
      if (params.return_image !== false && model && supportsVisionFromProvider(model)) {
        const base64 = await sharp(outputPath).png().toBuffer().then((buffer) => buffer.toString('base64'));
        return {
          success: true,
          data: [
            { type: 'text', text: `视觉总览拼图已生成: ${outputPath}\n尺寸: ${width}x${height}\n图片数: ${prepared.length}` },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64}`,
                detail: 'auto',
              },
            },
          ],
        };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `生成视觉总览拼图失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export default VisualContactSheetTool;
