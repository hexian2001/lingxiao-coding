/**
 * 非多模态模型的图片 OCR 回退
 *
 * 当模型不支持 vision/image 输入时，尝试将消息中的图片
 * 通过 tesseract.js (WASM) 转换为 OCR 文本。
 *
 * 安全措施：
 * - 使用本地预缓存的 tessdata，不从 CDN 下载语言包
 * - 全流程加超时保护，防止卡死
 * - OCR 失败或超时时回退到文本占位符
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  isContentPartArray,
  type ChatMessage,
  type MessageContentPart,
} from './types.js';
import { supportsVisionFromProvider } from './model_capabilities.js';
import {
  suppressNextUncaughtException,
  clearUncaughtSuppression,
  popSuppressedError,
} from '../core/RuntimeGuards.js';

// ==================== 常量 ====================

/** OCR 操作总超时（ms） */
const OCR_TIMEOUT_MS = 30_000;
/** Worker 创建超时（ms） */
const WORKER_INIT_TIMEOUT_MS = 10_000;

/** 本地 tessdata 目录：优先项目根目录 tessdata/，其次相对 dist/ 的 ../../tessdata/ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_TESSDATA_DIR = fs.existsSync(path.resolve(__dirname, '../../tessdata'))
  ? path.resolve(__dirname, '../../tessdata')
  : path.resolve(__dirname, '../../../tessdata');

// ==================== OCR 缓存 ====================

const OCR_CACHE = new Map<string, string>();
const MAX_CACHE_SIZE = 200;

function getCached(key: string): string | undefined {
  return OCR_CACHE.get(key);
}

function setCache(key: string, value: string): void {
  if (OCR_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = OCR_CACHE.keys().next().value;
    if (firstKey !== undefined) OCR_CACHE.delete(firstKey);
  }
  OCR_CACHE.set(key, value);
}

// ==================== 图片加载 ====================

function isSvgMimeType(mediaType: string): boolean {
  return mediaType?.toLowerCase().includes('svg') || false;
}

function parseDataUrl(url: string): { buffer: Buffer; mimeType: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function looksLikeSupportedRasterImage(buffer: Buffer, mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  if (mime.includes('png')) {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime.includes('jpeg') || mime.includes('jpg')) {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime.includes('gif')) {
    const header = buffer.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mime.includes('bmp')) {
    return buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM';
  }
  if (mime.includes('webp')) {
    return buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mime.includes('tiff') || mime.includes('tif')) {
    return buffer.length >= 4 &&
      (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
        buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])));
  }
  return buffer.length > 0;
}

async function loadImageBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    if (url.startsWith('data:')) {
      const parsed = parseDataUrl(url);
      if (!parsed || isSvgMimeType(parsed.mimeType)) return null;
      if (!looksLikeSupportedRasterImage(parsed.buffer, parsed.mimeType)) return null;
      return parsed;
    }

    // 本地文件路径
    const resolved = path.resolve(url);
    if (!fs.existsSync(resolved)) return null;
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
      '.tiff': 'image/tiff', '.tif': 'image/tiff',
    };
    const mimeType = mimeMap[ext] || 'image/png';
    if (isSvgMimeType(mimeType)) return null;
    const buffer = fs.readFileSync(resolved);
    if (!looksLikeSupportedRasterImage(buffer, mimeType)) return null;
    return { buffer, mimeType };
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

// ==================== 超时工具 ====================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ==================== OCR 执行 ====================

let tesseractAvailable: boolean | null = null;

/**
 * 检测本地 tessdata 是否可用
 */
function isTessdataAvailable(): boolean {
  if (tesseractAvailable !== null) return tesseractAvailable;
  const hasDir = fs.existsSync(LOCAL_TESSDATA_DIR);
  const hasEng = fs.existsSync(path.join(LOCAL_TESSDATA_DIR, 'eng.traineddata.gz'));
  tesseractAvailable = hasDir && hasEng;
  return tesseractAvailable;
}

/**
 * 对单张图片执行 OCR，返回提取的文本。
 * 超时或失败时返回 null，让调用方回退到占位符。
 */
export async function ocrImage(url: string, index: number): Promise<string | null> {
  const cacheKey = createHash('sha256').update(url).digest('hex');
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  // 快速检查 tessdata 是否可用
  if (!isTessdataAvailable()) {
    console.warn('[OCR] tessdata not available at', LOCAL_TESSDATA_DIR);
    return null;
  }

  // 加载图片
  const loaded = await loadImageBuffer(url);
  if (!loaded) {
    return null;
  }

  // tesseract.js OCR（带超时保护 + uncaughtException 保护）
  try {
    const { createWorker } = await import('tesseract.js');

    // tesseract worker 在某些错误（如损坏图片）时通过 process.nextTick 抛异常，
    // 无法被 try-catch 捕获。使用 RuntimeGuard 抑制机制防止进程崩溃。
    suppressNextUncaughtException();

    try {
      const worker = await withTimeout(
        createWorker('eng+chi_sim', 1, {
          langPath: LOCAL_TESSDATA_DIR,
          gzip: true,
          cacheMethod: 'none',
          logger: () => {}, // 静默
        }),
        WORKER_INIT_TIMEOUT_MS,
        'OCR worker init',
      );

      let ocrText: string | null = null;
      let recognizeErr: unknown = null;
      try {
        const { data: { text } } = await withTimeout(
          worker.recognize(loaded.buffer),
          OCR_TIMEOUT_MS,
          'OCR recognize',
        );
        ocrText = text.trim();
      } catch (e) {
        recognizeErr = e;
      } finally {
        await worker.terminate().catch(() => {});
      }

      // Wait two event-loop ticks for any MessagePort-based uncaughtException to fire
      // before clearing the suppression (race condition fix).
      await new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)));

      const suppressedErr = popSuppressedError();
      clearUncaughtSuppression();

      if (suppressedErr) throw suppressedErr;
      if (recognizeErr) throw recognizeErr;

      const msg = ocrText
        ? `--- Image ${index} OCR Text ---\n${ocrText}`
        : `[Image ${index}: OCR 未检测到文字]`;
      setCache(cacheKey, msg);
      return msg;
    } catch (err) {
      clearUncaughtSuppression();
      throw err;
    }
  } catch (err) {
    // OCR 失败，不缓存，返回 null 让调用方用占位符
    console.warn('[OCR] Failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ==================== 占位符 ====================

function unsupportedModalityPlaceholder(displayName: string): string {
  return `[Unsupported image file: "${displayName}". 当前模型不支持 image 输入，图片无法被处理。如需处理该文件，请切换到支持 vision 的模型或使用相关 skill。]`;
}

function extractDisplayName(url: string, index: number): string {
  if (url.startsWith('data:')) {
    const mimeMatch = url.match(/^data:(image\/[^;]+)/);
    return mimeMatch ? `image (${mimeMatch[1]})` : `Image ${index}`;
  }
  return url.split('/').pop() || `Image ${index}`;
}

// ==================== 进度回调类型 ====================

/** OCR 进度回调，与 StreamCallbacks.onProgress 兼容 */
export type OcrProgressCallback = (progress: { elapsed: number; status: string }) => void;

// ==================== 消息转换 ====================

/**
 * 将包含图片的 content parts 转换为纯文本 + OCR 结果（或占位符）
 */
async function convertPartsToText(
  parts: MessageContentPart[],
  model: string,
): Promise<string> {
  const textParts = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .filter(Boolean);

  const imageParts = parts.filter((p) => p.type === 'image_url');

  if (imageParts.length === 0) {
    return textParts.join('\n');
  }

  // 尝试 OCR 所有图片
  const ocrResults = await Promise.all(
    imageParts.map(async (part, i) => {
      const ocr = await ocrImage(part.image_url.url, i + 1);
      if (ocr !== null) return ocr;
      // OCR 不可用或失败，回退到占位符
      return unsupportedModalityPlaceholder(extractDisplayName(part.image_url.url, i + 1));
    }),
  );

  const hasOcrSuccess = ocrResults.some(r => r.startsWith('--- Image'));
  const systemMsg = hasOcrSuccess
    ? `[System: 当前模型 ${model} 不支持图片输入，已自动启用本地 OCR fallback 提取文字。非文字视觉信息可能丢失。]`
    : `[System: 当前模型 ${model} 不支持图片输入，已尝试本地 OCR fallback；OCR 不可用或失败，图片已被替换为占位符。]`;

  return [
    ...textParts,
    systemMsg,
    ocrResults.join('\n'),
  ].filter(Boolean).join('\n\n');
}

// ==================== 公共 API ====================

/**
 * 对非多模态模型的消息应用 OCR 或占位符回退。
 *
 * 判断优先级：
 * 1. modelProviders 配置中的 capabilities.modalities（最高优先）
 * 2. ModelsDevRegistry 模型能力数据
 *
 * 如果模型不支持 image：
 * - 尝试本地 OCR（tesseract.js + 预缓存 tessdata）
 * - OCR 不可用或失败时回退到文本占位符
 *
 * @param onProgress 可选进度回调，OCR 期间会发送进度事件
 */
export async function applyLocalVisionFallback(
  messages: ChatMessage[],
  model: string,
  onProgress?: OcrProgressCallback,
): Promise<ChatMessage[]> {
  // 廉价短路：消息里没有任何图片时直接返回，避免每轮 LLM 都做 supportsVisionFromProvider 查表
  let containsImage = false;
  for (const m of messages) {
    if (!isContentPartArray(m.content)) continue;
    if (m.content.some((p) => p.type === 'image_url')) {
      containsImage = true;
      break;
    }
  }
  if (!containsImage) {
    return messages;
  }

  if (supportsVisionFromProvider(model)) {
    return messages;
  }

  console.log(`[VisionFallback] Model ${model} does not support vision, applying OCR fallback...`);
  onProgress?.({ elapsed: 0, status: '正在对图片执行本地 OCR 识别...' });

  const startTime = Date.now();
  const transformed: ChatMessage[] = [];
  for (const message of messages) {
    if (!isContentPartArray(message.content)) {
      transformed.push(message);
      continue;
    }

    const hasImages = message.content.some((part) => part.type === 'image_url');
    if (!hasImages) {
      transformed.push(message);
      continue;
    }

    transformed.push({
      ...message,
      content: await convertPartsToText(message.content, model),
    });
    onProgress?.({ elapsed: Date.now() - startTime, status: `OCR 处理中...` });
  }

  onProgress?.({ elapsed: Date.now() - startTime, status: 'OCR 完成' });
  return transformed;
}
