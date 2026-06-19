/**
 * Tiktoken 离线缓存工具
 *
 * 预先下载常用编码器，避免运行时联网
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { getEncoding } from 'js-tiktoken';
import { coreLogger } from './Log.js';

/**
 * 缓存目录
 */
const CACHE_DIR = path.join(os.homedir(), '.lingxiao', 'cache', 'tiktoken');

/**
 * 常用编码器及其下载 URL
 */
const ENCODER_URLS = {
  cl100k_base: 'https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken',
  o200k_base: 'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken',
} as const;

export type SupportedEncoding = keyof typeof ENCODER_URLS;

const EXACT_ENCODING_NAMES: Record<string, SupportedEncoding> = {
  cl100k_base: 'cl100k_base',
  o200k_base: 'o200k_base',
};

/**
 * 编码器名称映射（中文模型通常使用这些）。
 * 只匹配显式白名单 family 边界，避免 arbitrary substring 漂移。
 */
const MODEL_ENCODING_RULES: ReadonlyArray<{ pattern: RegExp; encoding: SupportedEncoding }> = [
  { pattern: /(^|[^a-z0-9])kimi([^a-z0-9]|$)/i, encoding: 'cl100k_base' },
  { pattern: /(^|[^a-z0-9])qwen([^a-z0-9]|$)/i, encoding: 'cl100k_base' },
  { pattern: /(^|[^a-z0-9])deepseek([^a-z0-9]|$)/i, encoding: 'cl100k_base' },
  { pattern: /(^|[^a-z0-9])glm([^a-z0-9]|$)/i, encoding: 'cl100k_base' },
  { pattern: /(^|[^a-z0-9])yi([^a-z0-9]|$)/i, encoding: 'cl100k_base' },
  { pattern: /(^|[^a-z0-9])baichuan([^a-z0-9]|$)/i, encoding: 'cl100k_base' },
];

/**
 * 获取缓存目录
 */
function getCacheDir(): string {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

/**
 * 下载文件到目标路径
 */
function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    coreLogger.debug(`下载: ${url}`);
    const file = fs.createWriteStream(dest);

    // 监听文件流错误
    file.on('error', (err) => {
      console.error(`[TiktokenCache] 文件写入失败: ${err.message}`);
      file.close();
      try {
        fs.unlinkSync(dest);
      } catch { /* 临时文件清理失败可忽略 */ }
      resolve(false);
    });

    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // 跟随重定向
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(redirectUrl, dest).then(resolve).catch(() => resolve(false));
          return;
        }
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        coreLogger.debug(`保存到: ${dest}`);
        resolve(true);
      });
    }).on('error', (err) => {
      console.error(`[TiktokenCache] 下载失败: ${err.message}`);
      file.close();
      try {
        fs.unlinkSync(dest);
      } catch { /* 临时文件清理失败可忽略 */ }
      resolve(false);
    });
  });
}

/**
 * 确保指定编码器已缓存
 */
export async function ensureCached(encodingName: SupportedEncoding = 'cl100k_base'): Promise<boolean> {
  const cacheDir = getCacheDir();
  const cacheFile = path.join(cacheDir, `${encodingName}.tiktoken`);

  // 检查是否已缓存
  if (fs.existsSync(cacheFile)) {
    coreLogger.debug(`已缓存: ${cacheFile}`);
    return true;
  }

  // 尝试在线下载
  if (encodingName in ENCODER_URLS) {
    const url = ENCODER_URLS[encodingName];
    if (await downloadFile(url, cacheFile)) {
      return true;
    }
  }

  // 回退到 js-tiktoken 内置缓存机制
  try {
    getEncoding(encodingName as SupportedEncoding);
    coreLogger.debug(`使用 js-tiktoken 内置缓存: ${encodingName}`);
    return true;
  } catch (e) {
    console.error(`[TiktokenCache] 无法获取编码器 ${encodingName}:`, e);
    return false;
  }
}

/**
 * 获取缓存的编码器实例（模块级单例，避免重复构建 BPE rank 表）
 */
const _encoderCache = new Map<string, ReturnType<typeof getEncoding>>();

export function getCachedEncoder(encodingName: SupportedEncoding = 'cl100k_base') {
  const cached = _encoderCache.get(encodingName);
  if (cached) return cached;

  try {
    const encoder = getEncoding(encodingName as SupportedEncoding);
    _encoderCache.set(encodingName, encoder);
    return encoder;
  } catch (e) {
    console.error(`[TiktokenCache] 获取编码器失败:`, e);
    return null;
  }
}

/**
 * 缓存所有常用编码器
 */
export async function cacheAllCommon(): Promise<void> {
  coreLogger.debug('开始预缓存常用编码器...');
  let success = 0;
  for (const name of Object.keys(ENCODER_URLS) as SupportedEncoding[]) {
    if (await ensureCached(name)) {
      success++;
    }
  }
  coreLogger.debug(`完成: ${success}/${Object.keys(ENCODER_URLS).length} 个编码器已缓存`);
}

/**
 * 根据模型名称获取对应的编码器
 */
export function getEncodingForModel(modelName: string): SupportedEncoding {
  const normalizedModel = modelName.trim().toLowerCase();
  const exactEncoding = EXACT_ENCODING_NAMES[normalizedModel];
  if (exactEncoding) {
    return exactEncoding;
  }

  for (const rule of MODEL_ENCODING_RULES) {
    if (rule.pattern.test(normalizedModel)) {
      return rule.encoding;
    }
  }

  // 默认使用 cl100k_base
  return 'cl100k_base';
}

/**
 * 检查缓存是否存在
 */
function isCached(encodingName: SupportedEncoding): boolean {
  const cacheDir = getCacheDir();
  const cacheFile = path.join(cacheDir, `${encodingName}.tiktoken`);
  return fs.existsSync(cacheFile);
}

/**
 * 清除缓存
 */
export function clearCache(): void {
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
    }
  }
  coreLogger.debug('缓存已清除');
}
