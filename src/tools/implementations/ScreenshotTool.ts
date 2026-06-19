/**
 * Screenshot tool using Playwright browser automation.
 *
 * Captures screenshots of web pages. 根据当前模型能力决定输出形态：
 *  - vision 模型：返回结构化 image_url content part（由 provider 适配层转为对应格式）
 *  - 非 vision 模型：本地 OCR 提取文字，避免把巨大的 base64 灌进对话
 *  两种模式都把图片保存到磁盘并返回路径
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { browserManager } from './BrowserManager.js';
import { supportsVisionFromProvider } from '../../llm/model_capabilities.js';
import { ocrImage } from '../../llm/local_vision_fallback.js';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { resolveTaskWritePath } from './utils.js';

const ScreenshotSchema = z.object({
  url: z.string().url().describe('要截图的网页 URL'),
  full_page: z.boolean().optional().describe('是否截取完整页面（包括滚动区域），默认 false（仅视口）'),
  format: z.enum(['png', 'jpeg']).optional().describe('图片格式，默认 png'),
  quality: z.number().int().min(1).max(100).optional().describe('jpeg 质量 (1-100)，仅对 jpeg 格式有效'),
  screenshot_path: z.string().optional().describe('截图保存路径，默认写入 .lingxiao/artifacts'),
});

function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {/* expected: operation may fail */
    return false;
  }
}

function defaultScreenshotPath(context?: ToolContext, format?: string): string {
  const workspace = context?.workspace || process.cwd();
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  return resolve(workspace, '.lingxiao', 'artifacts', `screenshot-${Date.now()}.${ext}`);
}

export class ScreenshotTool extends Tool {
  readonly name = 'screenshot';
  readonly description =
    '对网页截图。vision 模型直接以图像形式返回；非 vision 模型自动 OCR 为文字。图片始终保存到磁盘并返回路径';
  readonly parameters = ScreenshotSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ScreenshotSchema>;

    if (!isUrlSafe(params.url)) {
      return { success: false, data: null, error: '仅支持 http:// 和 https:// 协议的 URL' };
    }

    const format = params.format || 'png';

    // 解析截图保存路径（与 browser_visual_verify 一致的写入隔离逻辑）
    let screenshotFilePath: string;
    try {
      screenshotFilePath = params.screenshot_path
        ? resolveTaskWritePath(context?.workspace, params.screenshot_path, context?.sessionId, context?.taskWriteScope)
        : defaultScreenshotPath(context, format);
    } catch {
      screenshotFilePath = defaultScreenshotPath(context, format);
    }

    try {
      const result = await browserManager.takeScreenshot(params.url, {
        fullPage: params.full_page,
        format,
        ...(format === 'jpeg' ? { quality: params.quality || 80 } : {}),
      });

      if (!result) {
        return {
          success: false,
          data: null,
          error: `截图失败: ${params.url}`,
        };
      }

      // 保存图片到磁盘（无论 vision 与否都落盘）
      const imgBuffer = Buffer.from(result.base64, 'base64');
      await mkdir(dirname(screenshotFilePath), { recursive: true });
      await writeFile(screenshotFilePath, imgBuffer);

      const dataUri = `data:${result.mimeType};base64,${result.base64}`;
      const header = [
        `📸 网页截图 - ${params.url}`,
        `尺寸: ${result.width}x${result.height}`,
        `格式: ${format}${params.full_page ? ' (全页面)' : ' (视口)'}`,
        `保存路径: ${screenshotFilePath}`,
      ];

      const model = typeof context?.model === 'string' ? context.model : '';
      const visionCapable = model ? supportsVisionFromProvider(model) : false;

      if (visionCapable) {
        return {
          success: true,
          data: [
            { type: 'text', text: header.join('\n') },
            {
              type: 'image_url',
              image_url: {
                url: dataUri,
                detail: 'auto',
              },
            },
          ],
        };
      }

      const ocrText = await ocrImage(dataUri, 1);
      const ocrSection = ocrText && ocrText.trim()
        ? ocrText
        : `[OCR 未提取到文字。当前模型 ${model || 'unknown'} 不支持 vision，图片已保存至 ${screenshotFilePath}。]`;

      return {
        success: true,
        data: [
          ...header,
          `[System: 当前模型不支持图片输入，已用本地 OCR 替代图像内容。图片已保存: ${screenshotFilePath}]`,
          '',
          ocrSection,
        ].join('\n'),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        error: `截图失败: ${msg}`,
      };
    }
  }
}

export default ScreenshotTool;
