import { URL } from 'url';
import { t } from '../../i18n.js';
import { effectiveBlockPrivateNetwork } from '../../core/HardeningPolicy.js';
import { getScopedProxyFetch } from '../../core/ProxyConfig.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PRIVATE_IP_RANGES = [
  /^127\./,                          // loopback
  /^10\./,                           // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC 1918
  /^192\.168\./,                     // RFC 1918
  /^169\.254\./,                     // link-local / cloud metadata
  /^0\./,                            // current network
  /^::1$/,                           // IPv6 loopback
  /^fe80:/i,                         // IPv6 link-local
  /^fc00:/i,                         // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,               // IPv6 unique local
];

export function isPrivateIP(ip: string): boolean {
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(ip));
}

export async function checkUrlNotPrivate(url: string): Promise<[boolean, string?]> {
  // 加固模式（§3.7）：读 effectiveBlockPrivateNetwork()（与独立开关 block_private_network
  // 取 OR），加固开启时默认启用 SSRF/私网防护。关闭时（默认且独立开关未开）保持现状放行。
  if (!effectiveBlockPrivateNetwork()) {
    return [true];
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (isPrivateIP(hostname)) {
      return [false, `私有网络地址被阻止: ${hostname}`];
    }
    const { lookup } = await import('dns/promises');
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIP(address)) {
        return [false, `域名解析到私有地址被阻止: ${hostname} → ${address}`];
      }
    } catch {
      // DNS 解析失败不阻止（可能是网络问题）
    }
    return [true];
  } catch {/* expected: fallback to default */
    return [true];
  }
}

export function isWebUrlSafe(url: string): [boolean, string?] {
  if (!url) {
    return [false, 'URL 为空'];
  }

  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase().replace(':', '');
    if (!['http', 'https'].includes(protocol)) {
      return [false, `不支持的协议：${protocol}`];
    }

    return [true];
  } catch (error) {
    return [false, `URL 解析错误：${error instanceof Error ? error.message : String(error)}`];
  }
}

async function fetchWithSignal(url: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
  const scopedFetch = getScopedProxyFetch('tools') || fetch;
  return await scopedFetch(url, {
    ...options,
    signal,
  });
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutSeconds: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    return await fetchWithSignal(url, options, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchWithSafeRedirects(
  url: string,
  options: RequestInit,
  timeoutSeconds: number,
  _allowPrivateHosts = false,
  maxRedirects = 5,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    let currentUrl = url;
    let redirectCount = 0;

    while (true) {
      const [safe, reason] = isWebUrlSafe(currentUrl);
      if (!safe) {
        throw new Error(t('error.redirect_unsafe', reason));
      }

      const response = await fetchWithSignal(currentUrl, { ...options, redirect: 'manual' }, controller.signal);
      const location = response.headers.get('location');
      const isRedirect = REDIRECT_STATUSES.has(response.status) && !!location;

      if (!isRedirect) {
        return response;
      }

      if (redirectCount >= maxRedirects) {
        throw new Error(t('error.redirect_limit', maxRedirects));
      }

      currentUrl = new URL(location!, currentUrl).toString();
      redirectCount += 1;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    });
}

function normalizeExtractedText(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripHtml(html: string): string {
  return normalizeExtractedText(
    html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  );
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function extractTagContents(html: string, tagName: string, limit: number): string[] {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null && results.length < limit) {
    const text = stripHtml(match[1]);
    if (text) {
      results.push(text);
    }
  }
  return results;
}

function extractAttributeValues(html: string, attribute: string, limit: number): string[] {
  const regex = new RegExp(`\\b${attribute}=(["'])([\\s\\S]*?)\\1`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null && results.length < limit) {
    const value = normalizeExtractedText(match[2]);
    if (value) {
      results.push(value);
    }
  }
  return results;
}

export function extractMetaTags(html: string): Record<string, string> {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const wantedKeys = new Set([
    'description',
    'keywords',
    'og:title',
    'og:description',
    'twitter:title',
    'twitter:description',
  ]);
  const meta: Record<string, string> = {};

  for (const tag of tags) {
    const keyMatch = tag.match(/\b(?:name|property)=["']([^"']+)["']/i);
    const contentMatch = tag.match(/\bcontent=(["'])([\s\S]*?)\1/i);
    const key = keyMatch?.[1]?.trim().toLowerCase();
    const value = contentMatch ? normalizeExtractedText(contentMatch[2]) : '';
    if (!key || !value || !wantedKeys.has(key) || meta[key]) {
      continue;
    }
    meta[key] = value;
  }

  return meta;
}

export function extractHeadings(html: string, limit = 8): string[] {
  const headings = [
    ...extractTagContents(html, 'h1', limit),
    ...extractTagContents(html, 'h2', limit),
    ...extractTagContents(html, 'h3', limit),
  ];
  return Array.from(new Set(headings)).slice(0, limit);
}

function extractBodyHtml(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match?.[1] || html;
}

export function extractMeaningfulText(html: string): string {
  const bodyText = stripHtml(extractBodyHtml(html));
  if (bodyText) {
    return bodyText;
  }

  const meta = extractMetaTags(html);
  const fallbacks = [
    extractTitle(html),
    ...Object.values(meta),
    ...extractTagContents(html, 'noscript', 8),
    ...extractAttributeValues(html, 'placeholder', 8),
    ...extractAttributeValues(html, 'aria-label', 8),
    ...extractAttributeValues(html, 'alt', 8),
    ...extractAttributeValues(html, 'title', 8),
    ...extractAttributeValues(html, 'value', 8),
  ].filter(Boolean);

  const unique = Array.from(new Set(fallbacks));
  if (unique.length > 0) {
    return unique.join('\n');
  }

  return html.trim()
    ? '(页面已返回 HTML，但未提取到可见正文，可能为动态渲染、脚本渲染或反爬页面)'
    : '';
}

function collectErrorChain(error: unknown): Array<Error & {
  cause?: unknown;
  code?: string;
  errno?: number | string;
  hostname?: string;
}> {
  const chain: Array<Error & {
    cause?: unknown;
    code?: string;
    errno?: number | string;
    hostname?: string;
  }> = [];

  let current = error;
  while (current instanceof Error) {
    chain.push(current as Error & {
      cause?: unknown;
      code?: string;
      errno?: number | string;
      hostname?: string;
    });
    current = (current as Error & { cause?: unknown }).cause;
  }

  return chain;
}

export function formatNetworkError(error: unknown, timeoutSeconds?: number): string {
  const chain = collectErrorChain(error);
  const messages = chain.map((item) => item.message || '').join(' | ');
  const codes = new Set(chain.map((item) => item.code).filter(Boolean));
  const host = chain.map((item) => item.hostname).find(Boolean);

  // 精确匹配超时错误，避免误判包含 "timeout" 单词但不是超时的错误
  const isTimeoutError =
    chain.some((item) => item.name === 'AbortError' || item.name === 'TimeoutError') ||
    /\b(request\s+timed\s+out|timed\s+out|timeout\s+error|connection\s+timeout|socket\s+timeout|fetch\s+timeout)\b/i.test(messages);

  if (isTimeoutError) {
    return `请求超时${timeoutSeconds ? ` (${timeoutSeconds}秒)` : ''}`;
  }

  if (codes.has('EAI_AGAIN') || codes.has('ENOTFOUND')) {
    return `DNS 解析失败${host ? ` (${host})` : ''} - ${messages || 'fetch failed'}`;
  }

  if (codes.has('ECONNREFUSED')) {
    return `连接被拒绝${host ? ` (${host})` : ''} - ${messages || 'fetch failed'}`;
  }

  if (codes.has('ECONNRESET')) {
    return `连接被重置${host ? ` (${host})` : ''} - ${messages || 'fetch failed'}`;
  }

  if (codes.has('ETIMEDOUT') || messages.includes('UND_ERR_CONNECT_TIMEOUT')) {
    return `连接超时${host ? ` (${host})` : ''} - ${messages || 'fetch failed'}`;
  }

  if (/certificate|tls|ssl/i.test(messages)) {
    return `TLS/SSL 连接失败 - ${messages || 'fetch failed'}`;
  }

  // 构建详细错误信息
  const errorDetails = chain
    .map((item, index) => {
      const parts = [
        index === 0 ? '原始错误' : `原因 ${index}`,
        item.name ? `名称: ${item.name}` : null,
        item.message ? `消息: ${item.message}` : null,
        item.code ? `代码: ${item.code}` : null,
        item.hostname ? `主机: ${item.hostname}` : null,
      ].filter(Boolean);
      return parts.join(' | ');
    })
    .join('\n');

  if (messages) {
    return `${messages}\n详细错误:\n${errorDetails}`;
  }

  const fallbackMsg = error instanceof Error ? error.message : String(error);
  return `${fallbackMsg}\n详细错误:\n${errorDetails}`;
}
