/**
 * Local OCR tool using tesseract.js.
 * Inspired by cursor2api's vision interceptor — zero external API dependency.
 *
 * Features:
 * - Pure local CPU OCR using tesseract.js
 * - Supports Chinese (simplified) + English recognition
 * - Accepts image URLs, file paths, or base64 data URIs
 * - SVG format protection (tesseract crashes on SVG)
 *
 * Safety:
 * - tesseract worker errors from corrupted/invalid images escape try-catch via
 *   the worker MessagePort. We use RuntimeGuard suppression to prevent process crash.
 * - Image buffer is validated (magic bytes) before passing to tesseract.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { createWorker } from 'tesseract.js';
import { fetchWithSafeRedirects } from './WebCommon.js';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../../i18n.js';
import { fileURLToPath } from 'url';
import {
  suppressNextUncaughtException,
  clearUncaughtSuppression,
  popSuppressedError,
} from '../../core/RuntimeGuards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_TESSDATA_DIR = path.resolve(__dirname, '../../../tessdata');

/** OCR 操作超时（ms） */
const OCR_TIMEOUT_MS = 60_000;
/** Worker 创建超时（ms） */
const WORKER_INIT_TIMEOUT_MS = 15_000;

const OCRSchema = z.object({
  image: z.string().describe('图片来源：本地文件路径、URL 或 base64 data URI'),
  languages: z.array(z.string()).optional().describe('识别语言列表，默认 ["eng", "chi_sim"]'),
  from: z.enum(['file', 'url', 'base64']).optional().describe('图片来源类型，自动检测'),
});

function isSvgMimeType(mediaType: string): boolean {
  return mediaType?.toLowerCase().includes('svg') || false;
}

/**
 * Validate image buffer by checking magic bytes.
 * Returns error message if invalid, null if OK.
 */
function validateImageBuffer(buf: Buffer): string | null {
  if (buf.length < 4) return '图片数据太短，无法识别格式';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return null;
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return null;
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return null;
  // WEBP: RIFF....WEBP
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return null;
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)) return null;
  // PDF: 25 50 44 46 (not an image but sometimes passed)
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '该文件是 PDF，不是图片格式，无法进行 OCR 识别';
  // SVG text check (starts with <svg or <?xml)
  const prefix = buf.slice(0, 50).toString('utf8').trimStart().toLowerCase();
  if (prefix.startsWith('<svg') || prefix.startsWith('<?xml')) return 'SVG 矢量图格式不支持 OCR 识别';
  return '无法识别图片格式（不是有效的 PNG/JPEG/GIF/BMP/WEBP/TIFF 图片）';
}

async function loadImageAsBuffer(imageSource: string, imageFrom?: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const inferred = imageFrom || inferSource(imageSource);

  if (inferred === 'file') {
    const resolved = path.resolve(imageSource);
    if (!fs.existsSync(resolved)) {
      throw new Error(t('error.ocr_file_not_found', resolved));
    }
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
    };
    const mimeType = mimeMap[ext] || 'image/png';
    if (isSvgMimeType(mimeType)) {
      throw new Error(t('error.ocr_svg_unsupported'));
    }
    return { buffer: fs.readFileSync(resolved), mimeType };
  }

  if (inferred === 'base64') {
    // data:image/png;base64,xxxx or raw base64
    let base64Data = imageSource;
    let mimeType = 'image/png';
    if (imageSource.startsWith('data:')) {
      const match = imageSource.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error(t('error.ocr_invalid_data_uri'));
      mimeType = match[1];
      base64Data = match[2];
    }
    if (isSvgMimeType(mimeType)) {
      throw new Error(t('error.ocr_svg_unsupported'));
    }
    return { buffer: Buffer.from(base64Data, 'base64'), mimeType };
  }

  // URL
  if (inferred === 'url') {
    const response = await fetchWithSafeRedirects(imageSource, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, 30);
    const contentType = response.headers.get('content-type') || 'image/png';
    if (isSvgMimeType(contentType)) {
      throw new Error(t('error.ocr_svg_unsupported'));
    }
    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType: contentType };
  }

  throw new Error(t('error.ocr_unknown_source'));
}

function inferSource(input: string): 'file' | 'url' | 'base64' {
  if (input.startsWith('data:')) return 'base64';
  if (/^https?:\/\//i.test(input)) return 'url';
  if (/^[A-Za-z0-9+/=]+$/.test(input) && input.length > 50) return 'base64';
  return 'file';
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    ),
  ]);
}

export class OCRTool extends Tool {
  readonly name = 'ocr';
  readonly description =
    '使用本地 OCR 引擎（tesseract.js）从图片中提取文字。' +
    '支持中文简体 + 英文识别，无需外部 API Key，完全本地运行。' +
    '输入支持：本地文件路径、HTTP(S) URL、base64 data URI。' +
    '适合提取截图中的文字、识别验证码、读取图片中的代码或报错信息等场景。';
  readonly parameters = OCRSchema;

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof OCRSchema>;

    if (!params.image?.trim()) {
      return { success: false, data: null, error: '请提供图片来源（文件路径、URL 或 base64）' };
    }

    const languages = params.languages || ['eng', 'chi_sim'];
    const langStr = languages.join('+');

    try {
      const { buffer, mimeType } = await loadImageAsBuffer(params.image, params.from);

      // Check SVG
      if (isSvgMimeType(mimeType)) {
        return {
          success: false,
          data: null,
          error: 'SVG 矢量图格式不支持 OCR 识别。请转换为 PNG、JPEG 等位图格式。',
        };
      }

      // Validate image buffer magic bytes before passing to tesseract.
      // tesseract crashes the whole process with an uncaught exception on invalid images.
      const validationError = validateImageBuffer(buffer);
      if (validationError) {
        return { success: false, data: null, error: validationError };
      }

      // tesseract worker errors on bad images escape try-catch via the worker's MessagePort.
      // Tell RuntimeGuard to suppress (not exit) the next uncaughtException if it fires.
      suppressNextUncaughtException();

      try {
        const worker = await withTimeout(
          createWorker(langStr, 1, {
            langPath: LOCAL_TESSDATA_DIR,
            gzip: true,
            cacheMethod: 'none',
            logger: () => {}, // Suppress progress logging
          }),
          WORKER_INIT_TIMEOUT_MS,
          'OCR worker 初始化',
        );

        let result: ToolResult;
        let recognizeErr: unknown = null;
        try {
          const { data: { text, confidence } } = await withTimeout(
            worker.recognize(buffer),
            OCR_TIMEOUT_MS,
            'OCR 识别',
          );

          const extracted = text.trim();
          if (!extracted) {
            result = {
              success: true,
              data: `🔍 OCR 识别完成\n图片来源: ${params.image}\n格式: ${mimeType}\n\n(图片中未检测到文字)`,
            };
          } else {
            result = {
              success: true,
              data: [
                `🔍 OCR 识别完成`,
                `图片来源: ${params.image}`,
                `格式: ${mimeType}`,
                `置信度: ${confidence.toFixed(1)}%`,
                '',
                '--- 提取文字 ---',
                extracted,
              ].join('\n'),
            };
          }
        } catch (e) {
          recognizeErr = e;
        } finally {
          await worker.terminate().catch(() => {});
        }

        // Wait two event-loop ticks for MessagePort-based uncaughtException to fire
        // before clearing the suppression. This prevents the race condition where
        // clearUncaughtSuppression() runs before the worker's async error reaches the handler.
        await new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)));

        // Check if tesseract threw an uncaught error via MessagePort
        const suppressedErr = popSuppressedError();
        clearUncaughtSuppression();

        if (suppressedErr) throw suppressedErr;
        if (recognizeErr) throw recognizeErr;
        return result!;
      } catch (err) {
        clearUncaughtSuppression();
        throw err;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        error: `OCR 识别失败: ${msg}`,
      };
    }
  }
}

export default OCRTool;
