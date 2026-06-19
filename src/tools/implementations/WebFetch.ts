/**
 * Web Fetch tool — 快路径优先（fetch + html→markdown），仅在 SPA / 内容稀疏 / full_page=true
 * 时切换到 playwright 深度页面分析。
 *
 * audit-2026-05-15：之前所有调用都走 chromium navigate，单次 100-1000ms 起步且会被
 * 共享 page 串行化。引入快路径后：
 * - 普通文章/文档/搜索结果：fetch HTTP → stripHtml → markdown，热路径降到几十毫秒
 * - SPA / JS 渲染依赖：自动检测 noscript 比例与正文长度，命中后再走 playwright
 * - full_page=true 时直接走 playwright（保留表单/表格结构提取）
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { browserManager } from './BrowserManager.js';
import {
  fetchWithSafeRedirects,
  extractTitle,
  extractMeaningfulText,
  extractMetaTags,
  extractHeadings,
  formatNetworkError,
} from './WebCommon.js';
import { buildStealthUserAgent } from '../../core/BrowserStealth.js';
import { sleep } from '../../utils/sleep.js';

const WebFetchSchema = z.object({
  url: z.string().url().describe('要抓取的网页 URL'),
  prompt: z.string().optional().describe('可选：说明你想关注的信息。注意：本工具不做关键词删段，会返回页面正文并在页首记录该目标，供 LLM 基于完整上下文提取'),
  offset: z.number().int().min(0).optional().describe('正文起始偏移，默认 0。使用 offset/limit 续读'),
  limit: z.number().int().min(200).max(50000).optional().describe('正文返回字符数，默认 15000。结果截断时使用 continuation_tool_call 继续'),
  max_chars: z.number().int().optional().describe('内部总字符安全上限，默认等于 limit + 元信息长度'),
  text_offset: z.number().int().optional().describe('内部正文起始偏移；模型侧使用 offset'),
  text_limit: z.number().int().optional().describe('内部正文长度限制；模型侧使用 limit'),
  full_page: z.boolean().optional().describe('是否提取完整页面结构（含表单、按钮等），默认 false。设置后强制走 playwright 渲染'),
  force_browser: z.boolean().optional().describe('强制使用浏览器渲染（绕过 fetch 快路径）；默认 false 时按内容自动选择'),
});

const FETCH_TIMEOUT_SECONDS = 25;
/** 临时限流(429/503)退避重试次数;base 指数退避 + 小 jitter 对抗搜索引擎频控。 */
const RATE_LIMIT_MAX_ATTEMPTS = 3;

/**
 * 快路径 fetch 包装:仅对 429/503(临时限流)做退避重试;其它状态码(含 403 持久拒绝)
 * 原样返回,交由上层 fall through 到浏览器渲染。
 */
async function fetchHtmlWithRateLimitRetry(
  url: string,
  headers: Record<string, string>,
  timeoutSeconds: number,
): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    response = await fetchWithSafeRedirects(
      url,
      { method: 'GET', headers },
      timeoutSeconds,
    );
    if (response.status !== 429 && response.status !== 503) return response;
    if (attempt < RATE_LIMIT_MAX_ATTEMPTS - 1) {
      const base = 500 * 2 ** attempt; // 500ms, 1000ms
      const jitter = Math.floor(Math.random() * 300);
      await sleep(base + jitter);
    }
  }
  return response!;
}

/**
 * 判断 fetch 拿到的 HTML 是否需要切换到浏览器渲染。
 * 命中任意条件即视为 "JS 渲染重的页面"：
 * - 有效正文长度 < 200 字符
 * - <noscript> 标签数 ≥ 2（典型 React/Vue/Angular 引导页特征）
 * - 头部含 __NEXT_DATA__ / __NUXT__ / window.__INITIAL_STATE__ 等 SPA 标志且正文短
 */
function shouldFallbackToBrowser(html: string, text: string): boolean {
  if (text.length < 200) return true;
  const noscriptCount = (html.match(/<noscript\b/gi) || []).length;
  if (noscriptCount >= 2 && text.length < 800) return true;
  const spaMarkers = [
    /__NEXT_DATA__/,
    /window\.__NUXT__/,
    /window\.__INITIAL_STATE__/,
    /id=["']app["'][^>]*>\s*<\/div>/i,
    /id=["']root["'][^>]*>\s*<\/div>/i,
  ];
  if (spaMarkers.some((rx) => rx.test(html)) && text.length < 800) return true;
  return false;
}

function buildFetchResult(args: {
  url: string;
  finalUrl: string;
  title?: string;
  html?: string;
  text: string;
  prompt?: string;
  offset: number;
  limit: number;
  maxChars: number;
  rendered?: boolean;
  fullPage?: boolean;
}): Record<string, unknown> {
  const title = args.title ?? (args.html ? extractTitle(args.html) : 'Untitled');
  const meta = args.html ? extractMetaTags(args.html) : {} as { description?: string };
  const headings = args.html ? extractHeadings(args.html, 8) : [];

  const body = args.text;
  const sliced = body.slice(args.offset, args.offset + args.limit);
  const nextOffset = args.offset + sliced.length;
  const truncated = nextOffset < body.length;

  const sections: string[] = [
    `${title || 'Untitled'}${args.rendered ? '（浏览器渲染）' : ''}`,
    `URL: ${args.finalUrl || args.url}`,
  ];
  if (meta.description) sections.push(`Description: ${meta.description}`);
  if (args.prompt?.trim()) sections.push(`Extraction goal: ${args.prompt.trim()}`);
  sections.push('');
  if (headings.length > 0) {
    sections.push('## 标题');
    for (const h of headings) sections.push(`- ${h}`);
    sections.push('');
  }
  sections.push('## 正文');
  sections.push(sliced || '(空页面)');
  if (truncated) {
    sections.push(`\n[内容已截断，总长度: ${body.length} 字符。next_offset=${nextOffset}，请使用 continuation_tool_call 继续]`);
  }

  let text = sections.join('\n');
  const outputTruncated = text.length > args.maxChars;
  if (outputTruncated) text = `${text.slice(0, args.maxChars)}\n... (本页输出超过 max_chars 已截断；如需继续请使用 continuation_tool_call 或增大 limit)`;

  return {
    url: args.finalUrl || args.url,
    title: title || 'Untitled',
    text,
    content: sliced,
    offset: args.offset,
    limit: args.limit,
    total_chars: body.length,
    truncated: truncated || outputTruncated,
    ...(truncated ? {
      next_offset: nextOffset,
      continuation_tool_call: {
        tool: 'web_fetch',
        args: {
          url: args.url,
          ...(args.prompt ? { prompt: args.prompt } : {}),
          offset: nextOffset,
          limit: args.limit,
          ...(args.fullPage ? { full_page: true } : {}),
          ...(args.rendered && !args.fullPage ? { force_browser: true } : {}),
        },
      },
    } : {}),
    source: args.rendered ? 'browser' : 'fetch',
  };
}

export class WebFetchTool extends Tool {
  readonly name = 'web_fetch';
  readonly description =
    '抓取网页内容并返回结构化文本。默认走 fetch + HTML→markdown 快路径（热路径 < 100ms）；' +
    '检测到 SPA / 内容稀疏时自动切换到浏览器渲染；full_page=true 或 force_browser=true 强制浏览器渲染（含表单/表格等深度结构）';
  readonly parameters = WebFetchSchema;
  readonly exposedParameters = WebFetchSchema.omit({ max_chars: true, text_offset: true, text_limit: true });

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof WebFetchSchema>;

    const offset = Math.max(0, params.offset ?? params.text_offset ?? 0);
    const limit = Math.max(200, Math.min(params.limit ?? params.text_limit ?? 15000, 50_000));
    const maxChars = Math.max(200, Math.min(params.max_chars || limit + 5000, 200_000));

    const forceBrowser = params.force_browser === true || params.full_page === true;

    // 快路径：fetch + stripHtml
    if (!forceBrowser) {
      try {
        const response = await fetchHtmlWithRateLimitRetry(
          params.url,
          {
            'user-agent': buildStealthUserAgent(),
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          FETCH_TIMEOUT_SECONDS,
        );
        if (response.status >= 200 && response.status < 400) {
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          // 仅对 HTML / XHTML / XML 走快路径；二进制内容直接交给浏览器渲染（PDF 等）
          if (contentType.includes('html') || contentType.includes('xml') || contentType === '') {
            const html = await response.text();
            const text = extractMeaningfulText(html);
            if (!shouldFallbackToBrowser(html, text)) {
              return {
                success: true,
                data: buildFetchResult({
                  url: params.url,
                  finalUrl: response.url || params.url,
                  html,
                  text,
                  prompt: params.prompt,
                  maxChars,
                  offset,
                  limit,
                }),
              };
            }
            // 命中切换条件：继续走浏览器路径
          }
        }
        // 非 2xx/3xx 或非 HTML：fall through 到浏览器（可能是 cloudflare 拦 fetch 但放浏览器）
      } catch (err) {
        // fetch 失败也尝试浏览器路径，并保留错误供浏览器路径失败时拼上下文
        const msg = formatNetworkError(err, FETCH_TIMEOUT_SECONDS);
        // 写日志而非中断
        if (process.env.LINGXIAO_DEBUG_WEB_FETCH) {
          console.error(`[web_fetch] fast-path fetch failed for ${params.url}: ${msg}`);
        }
      }
    }

    // 慢路径：playwright 深度渲染
    try {
      if (params.full_page) {
        const deepElements = await browserManager.extractDeepPageElements(params.url);
        if (!deepElements) {
          return { success: false, data: null, error: `页面分析失败: ${params.url}` };
        }
        const fullText = deepElements.textContent || '';
        const slicedText = fullText.slice(offset, offset + limit);
        const hasMore = (offset + limit) < fullText.length;

        const sections: string[] = [
          `🌐 页面深度分析 - ${deepElements.title}`,
          `URL: ${deepElements.url}`,
          '',
        ];
        if (deepElements.headings.length > 0) {
          sections.push('## 标题结构');
          for (const h of deepElements.headings.slice(0, 20)) {
            sections.push(`${'  '.repeat(h.level - 1)}# ${h.text}`);
          }
          sections.push('');
        }
        if (deepElements.tables.length > 0) {
          sections.push(`## 表格 (${deepElements.tables.length} 个)`);
          for (let i = 0; i < Math.min(deepElements.tables.length, 5); i++) {
            const table = deepElements.tables[i];
            sections.push(`表 ${i + 1}: ${table.headers.join(' | ')}`);
            for (const row of table.rows.slice(0, 5)) {
              sections.push(`  ${row.join(' | ')}`);
            }
          }
          sections.push('');
        }
        if (deepElements.forms.length > 0) {
          sections.push(`## 表单 (${deepElements.forms.length} 个)`);
          for (const form of deepElements.forms) {
            sections.push(`表单: ${form.name || '(未命名)'} → ${form.action} [${form.method}]`);
            for (const input of form.inputs.slice(0, 5)) {
              sections.push(`  输入: ${input.name} (${input.type})`);
            }
          }
          sections.push('');
        }
        if (deepElements.buttons.length > 0) {
          sections.push(`## 按钮 (${deepElements.buttons.length} 个): ${deepElements.buttons.slice(0, 10).map((b) => b.text).join(', ')}`);
          sections.push('');
        }
        if (deepElements.links.length > 0) {
          sections.push(`## 链接 (${deepElements.links.length} 个)`);
          for (const link of deepElements.links.slice(0, 15)) {
            sections.push(`- [${link.text}](${link.href})`);
          }
          sections.push('');
        }
        sections.push('## 页面文本内容');
        sections.push(slicedText || '(无文本内容)');
        if (hasMore) {
          sections.push(`\n[内容已截断，总长度: ${fullText.length} 字符。next_offset=${offset + limit}，请使用 continuation_tool_call 继续]`);
        }
        const text = sections.join('\n').slice(0, maxChars);
        return {
          success: true,
          data: {
            url: deepElements.url,
            title: deepElements.title,
            text,
            content: slicedText,
            offset,
            limit,
            total_chars: fullText.length,
            truncated: hasMore || sections.join('\n').length > maxChars,
            ...(hasMore ? {
              next_offset: offset + limit,
              continuation_tool_call: { tool: 'web_fetch', args: { url: params.url, ...(params.prompt ? { prompt: params.prompt } : {}), offset: offset + limit, limit, full_page: true } },
            } : {}),
            source: 'browser_full_page',
          },
        };
      }

      // SPA 渲染路径：仍走 extractDeepPageElements 拿渲染后正文，但只取 textContent
      const deepElements = await browserManager.extractDeepPageElements(params.url);
      if (!deepElements) {
        return { success: false, data: null, error: `网页抓取失败: ${params.url}` };
      }
      const content = deepElements.textContent || '';
      return {
        success: true,
        data: buildFetchResult({
          url: params.url,
          finalUrl: deepElements.url,
          title: deepElements.title,
          text: content,
          prompt: params.prompt,
          maxChars,
          offset,
          limit,
          rendered: true,
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, data: null, error: `网页抓取失败: ${msg}` };
    }
  }
}

export default WebFetchTool;
