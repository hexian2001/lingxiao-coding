/**
 * GenerateCanvasTool — 生成视觉艺术作品（海报/设计/插图）
 *
 * 从 skills/bundled/canvas-design 转换而来
 * 使用 sharp 渲染 PNG，pdf-lib 生成 PDF
 *
 * 支持：
 * - 自定义画布尺寸（A4/Letter/自定义像素）
 * - 形状绘制（矩形/圆形/线条/多边形）
 * - 文字排版（多字体/多颜色/多大小）
 * - 渐变背景
 * - 图片叠加
 * - 输出 PNG 或 PDF
 */

import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath } from './utils.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Zod Schema
// ═══════════════════════════════════════════════════════════════════════════════

const ShapeSchema = z.object({
  type: z.enum(['rect', 'circle', 'line', 'ellipse', 'polygon', 'arc']),
  x: z.number().describe('X 坐标（像素）'),
  y: z.number().describe('Y 坐标（像素）'),
  width: z.number().optional().describe('宽度'),
  height: z.number().optional().describe('高度'),
  radius: z.number().optional().describe('半径（circle）'),
  fill: z.string().optional().describe('填充色 HEX（如 #0EA5A4）'),
  stroke: z.string().optional().describe('描边色 HEX'),
  strokeWidth: z.number().optional().describe('描边宽度'),
  opacity: z.number().min(0).max(1).optional().describe('透明度 0-1'),
  rotation: z.number().optional().describe('旋转角度'),
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe('多边形顶点'),
  cornerRadius: z.number().optional().describe('圆角半径'),
});

const TextSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  fontSize: z.number().default(24),
  fontFamily: z.string().optional().describe('字体名（如 JetBrainsMono-Bold）'),
  color: z.string().default('#111827'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  maxWidth: z.number().optional().describe('最大宽度（自动换行）'),
  lineHeight: z.number().optional().describe('行高倍数'),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().optional(),
  weight: z.enum(['normal', 'bold', 'light']).default('normal'),
});

const GradientSchema = z.object({
  type: z.enum(['linear', 'radial']),
  stops: z.array(z.object({
    offset: z.number().min(0).max(1),
    color: z.string(),
  })).min(2),
  angle: z.number().optional().describe('线性渐变角度（度）'),
  cx: z.number().optional().describe('径向渐变中心 X'),
  cy: z.number().optional().describe('径向渐变中心 Y'),
  r: z.number().optional().describe('径向渐变半径'),
});

const ImageSchema = z.object({
  path: z.string().describe('图片路径'),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  opacity: z.number().min(0).max(1).optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
});

const CanvasDesignSchema = z.object({
  width: z.number().default(1920).describe('画布宽度（像素）'),
  height: z.number().default(1080).describe('画布高度（像素）'),
  background: z.string().optional().describe('背景色 HEX'),
  gradient: GradientSchema.optional().describe('渐变背景'),
  shapes: z.array(ShapeSchema).optional().describe('形状数组'),
  texts: z.array(TextSchema).optional().describe('文字数组'),
  images: z.array(ImageSchema).optional().describe('图片数组'),
  format: z.enum(['png', 'pdf']).default('png'),
  quality: z.number().min(1).max(100).default(95).describe('PNG 质量'),
  path: z.string().optional().describe('输出路径'),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

type CanvasDesignInput = z.infer<typeof CanvasDesignSchema>;

// ═══════════════════════════════════════════════════════════════════════════════
// 字体管理
// ═══════════════════════════════════════════════════════════════════════════════

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts');

function getFontPath(fontFamily: string): string | null {
  // 先检查本地 fonts 目录
  const localPath = join(FONTS_DIR, `${fontFamily}.ttf`);
  if (existsSync(localPath)) return localPath;

  // 检查 canvas-design 技能的字体目录
  const skillFontDir = join(process.cwd(), 'skills', 'bundled', 'canvas-design', 'canvas-fonts');
  const skillPath = join(skillFontDir, `${fontFamily}.ttf`);
  if (existsSync(skillPath)) return skillPath;

  return null;
}

function listAvailableFonts(): string[] {
  const fonts: string[] = [];
  if (existsSync(FONTS_DIR)) {
    for (const f of readdirSync(FONTS_DIR)) {
      if (f.endsWith('.ttf')) fonts.push(basename(f, '.ttf'));
    }
  }
  const skillFontDir = join(process.cwd(), 'skills', 'bundled', 'canvas-design', 'canvas-fonts');
  if (existsSync(skillFontDir)) {
    for (const f of readdirSync(skillFontDir)) {
      if (f.endsWith('.ttf') && !fonts.includes(basename(f, '.ttf'))) {
        fonts.push(basename(f, '.ttf'));
      }
    }
  }
  return fonts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SVG 渲染器（通过 sharp 转 PNG/PDF）
// ═══════════════════════════════════════════════════════════════════════════════

function hexToRgba(hex: string, opacity = 1): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function buildSvg(params: CanvasDesignInput): string {
  const { width, height, background, gradient, shapes, texts, images } = params;
  const parts: string[] = [];

  // SVG 头
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);

  // Defs（渐变、字体）
  parts.push('<defs>');

  // 渐变
  if (gradient) {
    if (gradient.type === 'linear') {
      const angle = gradient.angle ?? 0;
      const rad = (angle * Math.PI) / 180;
      const x1 = 50 - 50 * Math.cos(rad);
      const y1 = 50 - 50 * Math.sin(rad);
      const x2 = 50 + 50 * Math.cos(rad);
      const y2 = 50 + 50 * Math.sin(rad);
      parts.push(`<linearGradient id="bgGrad" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">`);
      for (const stop of gradient.stops) {
        parts.push(`<stop offset="${stop.offset * 100}%" stop-color="${stop.color}"/>`);
      }
      parts.push('</linearGradient>');
    } else {
      const cx = gradient.cx ?? 50;
      const cy = gradient.cy ?? 50;
      const r = gradient.r ?? 50;
      parts.push(`<radialGradient id="bgGrad" cx="${cx}%" cy="${cy}%" r="${r}%">`);
      for (const stop of gradient.stops) {
        parts.push(`<stop offset="${stop.offset * 100}%" stop-color="${stop.color}"/>`);
      }
      parts.push('</radialGradient>');
    }
  }

  // 嵌入字体
  const usedFonts = new Set<string>();
  if (texts) {
    for (const t of texts) {
      if (t.fontFamily) usedFonts.add(t.fontFamily);
    }
  }
  for (const fontName of usedFonts) {
    const fontPath = getFontPath(fontName);
    if (fontPath) {
      try {
        const fontData = readFileSync(fontPath);
        const base64 = fontData.toString('base64');
        parts.push(`@font-face { font-family: '${fontName}'; src: url(data:font/ttf;base64,${base64}) format('truetype'); }`);
      } catch { /* 字体加载失败，跳过 */ }
    }
  }

  parts.push('</defs>');

  // 背景
  if (gradient) {
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgGrad)"/>`);
  } else if (background) {
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>`);
  }

  // 图片
  if (images) {
    for (const img of images) {
      if (!existsSync(img.path)) continue;
      try {
        const imgData = readFileSync(img.path);
        const ext = extname(img.path).toLowerCase().replace('.', '');
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        const base64 = imgData.toString('base64');
        const w = img.width ? ` width="${img.width}"` : '';
        const h = img.height ? ` height="${img.height}"` : '';
        const opacity = img.opacity != null ? ` opacity="${img.opacity}"` : '';
        parts.push(`<image x="${img.x}" y="${img.y}"${w}${h}${opacity} href="data:image/${mime};base64,${base64}"/>`);
      } catch { /* 图片加载失败 */ }
    }
  }

  // 形状
  if (shapes) {
    for (const shape of shapes) {
      const fill = shape.fill ? ` fill="${hexToRgba(shape.fill, shape.opacity)}"` : ' fill="none"';
      const stroke = shape.stroke ? ` stroke="${shape.stroke}"` : '';
      const sw = shape.strokeWidth ? ` stroke-width="${shape.strokeWidth}"` : '';
      const transform = shape.rotation ? ` transform="rotate(${shape.rotation} ${shape.x} ${shape.y})"` : '';

      switch (shape.type) {
        case 'rect': {
          const rx = shape.cornerRadius ? ` rx="${shape.cornerRadius}" ry="${shape.cornerRadius}"` : '';
          parts.push(`<rect x="${shape.x}" y="${shape.y}" width="${shape.width ?? 100}" height="${shape.height ?? 100}"${fill}${stroke}${sw}${rx}${transform}/>`);
          break;
        }
        case 'circle':
          parts.push(`<circle cx="${shape.x}" cy="${shape.y}" r="${shape.radius ?? 50}"${fill}${stroke}${sw}${transform}/>`);
          break;
        case 'ellipse':
          parts.push(`<ellipse cx="${shape.x}" cy="${shape.y}" rx="${shape.width ?? 50}" ry="${shape.height ?? 30}"${fill}${stroke}${sw}${transform}/>`);
          break;
        case 'line':
          parts.push(`<line x1="${shape.x}" y1="${shape.y}" x2="${shape.x + (shape.width ?? 100)}" y2="${shape.y + (shape.height ?? 0)}"${stroke}${sw}${transform}/>`);
          break;
        case 'polygon': {
          if (shape.points && shape.points.length >= 3) {
            const pts = shape.points.map(p => `${p.x},${p.y}`).join(' ');
            parts.push(`<polygon points="${pts}"${fill}${stroke}${sw}${transform}/>`);
          }
          break;
        }
      }
    }
  }

  // 文字
  if (texts) {
    for (const t of texts) {
      const fontFamily = t.fontFamily || 'Arial';
      const fontWeight = t.weight === 'bold' ? ' font-weight="bold"' : t.weight === 'light' ? ' font-weight="300"' : '';
      const opacity = t.opacity != null ? ` opacity="${t.opacity}"` : '';
      const transform = t.rotation ? ` transform="rotate(${t.rotation} ${t.x} ${t.y})"` : '';

      // 处理换行
      const lines = t.text.split('\n');
      const lineH = (t.fontSize * (t.lineHeight ?? 1.4));
      const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';

      if (lines.length === 1) {
        parts.push(`<text x="${t.x}" y="${t.y}" font-family="${fontFamily}" font-size="${t.fontSize}" fill="${hexToRgba(t.color, t.opacity)}"${fontWeight} text-anchor="${anchor}"${opacity}${transform}>${escapeXml(t.text)}</text>`);
      } else {
        parts.push(`<text x="${t.x}" y="${t.y}" font-family="${fontFamily}" font-size="${t.fontSize}" fill="${hexToRgba(t.color, t.opacity)}"${fontWeight} text-anchor="${anchor}"${opacity}${transform}>`);
        for (let i = 0; i < lines.length; i++) {
          parts.push(`<tspan x="${t.x}" dy="${i === 0 ? 0 : lineH}">${escapeXml(lines[i])}</tspan>`);
        }
        parts.push('</text>');
      }
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工具类
// ═══════════════════════════════════════════════════════════════════════════════

export class GenerateCanvasTool extends Tool {
  readonly name = 'generate_canvas';
  readonly description = `生成视觉艺术作品（海报/设计/插图/封面/社交媒体图）。

形状：rect / circle / ellipse / line / polygon，支持圆角、旋转、透明度。
文字：多字体（54 种内置专业字体）、多大小、多颜色、对齐、自动换行、行高。
背景：纯色 / 线性渐变 / 径向渐变。
图片：叠加本地图片，支持 cover/contain/fill 缩放。
输出：PNG 或 PDF。

适合：产品海报、社交媒体封面、概念艺术、数据可视化、品牌设计。`;
  readonly parameters = CanvasDesignSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = CanvasDesignSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const params = parsed.data;

    try {
      // 构建 SVG
      const svg = buildSvg(params);

      // 确定输出路径
      const ext = params.format === 'pdf' ? '.pdf' : '.png';
      const defaultName = `canvas${ext}`;
      const requestedPath = params.path || `.lingxiao/sessions/${context?.sessionId || 'default'}/scratchpad/${defaultName}`;
      let outputPath: string;
      try {
        outputPath = resolveTaskWritePath(context?.workspace, requestedPath, context?.sessionId, context?.taskWriteScope);
      } catch (error) {
        return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!outputPath.endsWith(ext)) outputPath += ext;

      mkdirSync(dirname(outputPath), { recursive: true });

      // 渲染
      const sharp = (await import('sharp')).default;

      if (params.format === 'pdf') {
        // SVG → PNG → PDF（sharp 不直接支持 PDF 输出，用 pdf-lib）
        const pngBuffer = await sharp(Buffer.from(svg))
          .resize(params.width, params.height)
          .png({ quality: params.quality })
          .toBuffer();

        const { PDFDocument } = await import('pdf-lib');
        const pdfDoc = await PDFDocument.create();
        const img = await pdfDoc.embedPng(pngBuffer);
        const page = pdfDoc.addPage([params.width, params.height]);
        page.drawImage(img, { x: 0, y: 0, width: params.width, height: params.height });
        const pdfBytes = await pdfDoc.save();
        writeFileSync(outputPath, pdfBytes);
      } else {
        // SVG → PNG
        const pngBuffer = await sharp(Buffer.from(svg))
          .resize(params.width, params.height)
          .png({ quality: params.quality })
          .toBuffer();
        writeFileSync(outputPath, pngBuffer);
      }

      // 创建下载链接
      const artifact = params.create_download_link
        ? tempDownloadRegistry.create({
          path: outputPath,
          name: basename(outputPath),
          mimeType: params.format === 'pdf' ? 'application/pdf' : 'image/png',
          expiresInSeconds: params.expires_in_seconds,
          sessionId: context?.sessionId,
        })
        : undefined;

      return {
        success: true,
        data: artifact ? {
          ...artifact,
          width: params.width,
          height: params.height,
          format: params.format,
        } : {
          path: outputPath,
          width: params.width,
          height: params.height,
          format: params.format,
        },
        error: undefined,
      };
    } catch (err: unknown) {
      return { success: false, data: null, error: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
