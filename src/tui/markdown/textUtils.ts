/**
 * Text utility functions for markdown rendering.
 */

import stringWidth from 'string-width';

const STRING_WIDTH_CACHE_MAX = 2_000;

// String width caching for performance. Map insertion order gives us a tiny LRU.
const stringWidthCache = new Map<string, number>();

/**
 * Cached version of stringWidth for CJK-aware width calculation.
 */
export const getCachedStringWidth = (str: string): number => {
  // ASCII printable chars have width 1
  if (/^[\x20-\x7E]*$/.test(str)) {
    return str.length;
  }

  if (stringWidthCache.has(str)) {
    const width = stringWidthCache.get(str)!;
    stringWidthCache.delete(str);
    stringWidthCache.set(str, width);
    return width;
  }

  const width = stringWidth(str);
  if (stringWidthCache.size >= STRING_WIDTH_CACHE_MAX) {
    const oldest = stringWidthCache.keys().next().value;
    if (oldest !== undefined) {
      stringWidthCache.delete(oldest);
    }
  }
  stringWidthCache.set(str, width);
  return width;
};

export const getStringWidthCacheSize = (): number => stringWidthCache.size;

export const hasCachedStringWidth = (str: string): boolean => stringWidthCache.has(str);

export const clearStringWidthCacheForTest = (): void => {
  stringWidthCache.clear();
};

/**
 * Convert a string to an array of Unicode code points.
 */
export function toCodePoints(str: string): string[] {
  // ASCII fast path
  let isAscii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) return str.split('');
  return Array.from(str);
}
