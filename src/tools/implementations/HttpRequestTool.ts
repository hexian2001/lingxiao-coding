import { URL } from 'url';
import { z } from 'zod';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { checkUrlNotPrivate } from './WebCommon.js';
import { getScopedProxyFetch } from '../../core/ProxyConfig.js';
import { buildLingxiaoComponentUserAgent } from '../../version.js';
import https from 'https';

const HTTP_REQUEST_USER_AGENT = buildLingxiaoComponentUserAgent('http_request tool');

const HttpRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']).optional().describe('HTTP 方法，默认 GET'),
  url: z.string().describe('请求 URL'),
  headers: z.record(z.string(), z.string()).optional().describe('请求头'),
  cookies: z.record(z.string(), z.string()).optional().describe('Cookies 字典'),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe('请求体（POST/PUT 时使用）；传 object 时自动按 JSON 发送'),
  follow_redirects: z.boolean().optional().describe('是否跟随重定向，默认 true'),
  timeout: z.number().int().optional().describe('超时秒数，默认 10'),
  max_response_size: z.number().int().optional().describe('响应体最大字节数，默认 30000'),
  verify_ssl: z.boolean().optional().describe('是否验证 SSL 证书，默认 false'),
  max_redirects: z.number().int().optional().describe('最大重定向次数，默认 5'),
});

export class HttpRequestTool extends Tool {
  readonly name = 'http_request';
  readonly description = '发送 HTTP 请求并返回结构化响应；请求体统一使用 body，JSON 请求直接传 object。';
  readonly parameters = HttpRequestSchema;

  getExecutionTimeoutMs(args: unknown): number {
    const params = args as Partial<z.infer<typeof HttpRequestSchema>>;
    const timeoutSeconds = typeof params?.timeout === 'number' && Number.isFinite(params.timeout) && params.timeout > 0
      ? Math.min(params.timeout, 60)
      : 10;
    const maxRedirects = typeof params?.max_redirects === 'number' && Number.isFinite(params.max_redirects)
      ? Math.max(0, Math.min(params.max_redirects, 10))
      : 5;
    return Math.ceil(timeoutSeconds * 1000 * (maxRedirects + 1)) + 5_000;
  }

  private static async fetchWithTimeout(url: string, options: RequestInit, timeoutSeconds: number, verifySsl?: boolean): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const scopedFetch = getScopedProxyFetch('tools') || fetch;
      const fetchOptions: RequestInit = { ...options, signal: controller.signal };

      // Consume verify_ssl parameter: when explicitly false, create an HTTPS agent
      // that disables certificate verification. When true or undefined, leave default
      // behavior (Node.js verifies SSL by default).
      if (verifySsl === false) {
        const insecureAgent = new https.Agent({ rejectUnauthorized: false });
        // For node-fetch (proxy path), attach via init.agent;
        // for global fetch (undici), attach via init.dispatcher.
        const opts = fetchOptions as Record<string, unknown>;
        if (scopedFetch !== fetch) {
          opts.agent = insecureAgent;
        } else {
          opts.dispatcher = insecureAgent;
        }
      }

      return await scopedFetch(url, fetchOptions);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static collectSetCookies(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === 'function') {
      return headers.getSetCookie().slice(0, 20).map((c) => c.split(';')[0]);
    }
    const raw = response.headers.get('set-cookie');
    if (!raw) return [];
    return raw.split(/\n|,(?=\s*[^;,=\s]+=[^;,]+)/).slice(0, 20).map((c) => c.trim().split(';')[0]).filter(Boolean);
  }

  private static validateUrl(url: string): [boolean, string?] {
    if (!url) return [false, 'URL 为空'];
    try {
      const parsed = new URL(url);
      if (!parsed.protocol || !parsed.hostname) return [false, 'URL 格式无效'];
      const protocol = parsed.protocol.toLowerCase().replace(':', '');
      if (!['http', 'https'].includes(protocol)) return [false, `不支持的协议：${protocol}`];
      return [true];
    } catch (error: unknown) {
      return [false, `URL 解析错误：${(error as Error).message}`];
    }
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof HttpRequestSchema>;
    let { headers, cookies } = params;
    const {
      method = 'GET', url, body,
      follow_redirects = true, timeout = 10, max_response_size = 30000,
      max_redirects = 5, verify_ssl,
    } = params;
    if (typeof headers === 'string') { try { headers = JSON.parse(headers); } catch { /* keep */ } }
    if (typeof cookies === 'string') { try { cookies = JSON.parse(cookies); } catch { /* keep */ } }

    const [isSafe, reason] = HttpRequestTool.validateUrl(url);
    if (!isSafe) return { success: false, data: null, error: `URL 验证失败 - ${reason}` };

    const [notPrivate, privateReason] = await checkUrlNotPrivate(url);
    if (!notPrivate) return { success: false, data: null, error: `SSRF 防护 - ${privateReason}` };

    let httpMethod = method.toUpperCase();
    const safeTimeout = Math.max(1, Math.min(timeout, 60));
    const safeMaxResponseSize = Math.max(100, Math.min(max_response_size, 200000));
    const safeMaxRedirects = Math.max(0, Math.min(max_redirects, 10));

    const requestHeaders: Record<string, string> = { 'User-Agent': HTTP_REQUEST_USER_AGENT, ...(headers || {}) };
    let requestBody: string | undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        requestBody = body;
      } else {
        requestBody = JSON.stringify(body);
        requestHeaders['Content-Type'] = 'application/json';
      }
    }
    if (cookies) {
      requestHeaders['Cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const fetchOptions: RequestInit = { method: httpMethod, headers: requestHeaders, body: requestBody, redirect: 'manual' };
    const collectedSetCookies: string[] = [];

    try {
      let currentUrl = url;
      let redirectCount = 0;
      let response: Response | null = null;

      while (true) {
        response = await HttpRequestTool.fetchWithTimeout(currentUrl, { ...fetchOptions, method: httpMethod, body: requestBody }, safeTimeout, verify_ssl);
        collectedSetCookies.push(...HttpRequestTool.collectSetCookies(response));

        const location = response.headers.get('location');
        const isRedirect = response.status >= 300 && response.status < 400 && !!location;
        if (!follow_redirects || !isRedirect) break;

        if (redirectCount >= safeMaxRedirects) {
          return { success: false, data: null, error: `重定向次数超过限制 (${safeMaxRedirects})` };
        }
        redirectCount += 1;
        currentUrl = new URL(location!, currentUrl).toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && httpMethod === 'POST')) {
          httpMethod = 'GET';
          requestBody = undefined;
          delete requestHeaders['Content-Type'];
        }
      }

      if (!response) return { success: false, data: null, error: '未获取到响应' };

      const responseBuffer = await response.arrayBuffer();
      let responseText = Buffer.from(responseBuffer).toString('utf-8');
      if (responseBuffer.byteLength > safeMaxResponseSize * 2) {
        responseText = responseText.slice(0, safeMaxResponseSize) + `\n... (响应体过大已截断，实际大小：${responseBuffer.byteLength}字节)`;
      }
      if (responseText.length > safeMaxResponseSize) {
        responseText = responseText.slice(0, safeMaxResponseSize) + `\n... (截断，总长度${responseText.length})`;
      }

      const respHeaders: Record<string, string> = {};
      let headerCount = 0;
      for (const [key, value] of response.headers.entries()) {
        if (headerCount >= 50) { respHeaders['...'] = '(头过多已截断)'; break; }
        respHeaders[key] = value;
        headerCount += 1;
      }

      const resultParts = [
        `[status] ${response.status} ${response.statusText}`,
        `[url] ${response.url}`,
        `[headers] ${JSON.stringify(respHeaders)}`,
      ];
      if (collectedSetCookies.length > 0) {
        const limited = collectedSetCookies.slice(0, 20);
        if (collectedSetCookies.length > 20) limited.push('...(更多)');
        resultParts.push(`[set-cookies] ${JSON.stringify(limited)}`);
      }
      resultParts.push(`[body]\n${responseText}`);

      return { success: true, data: resultParts.join('\n') };
    } catch (error: unknown) {
      const err = error as Error & { name?: string };
      const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError' ||
        /\b(timeout|timed\s+out)\b/i.test(String(err?.message || ''));
      if (isTimeout) return { success: false, data: null, error: `HTTP 请求超时 (${safeTimeout}秒)` };
      return { success: false, data: null, error: `HTTP 请求失败: ${err.name}: ${err.message}` };
    }
  }
}

export default HttpRequestTool;
