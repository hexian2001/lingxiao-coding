/**
 * Web Search tool.
 *
 * Features:
 * - Official Bing / Google JSON APIs when configured
 * - Isolated browser SERP fallback when API credentials are unavailable
 * - Structured search results with titles, URLs, snippets
 * - Domain filtering (allowlist/blocklist)
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { browserManager, type BrowserSearchDiagnostics } from './BrowserManager.js';
import { fetchWithTimeout, formatNetworkError } from './WebCommon.js';

const WebSearchSchema = z.object({
  query: z.string().describe('搜索关键词或问题描述。支持搜索引擎高级语法并原样透传：site:docs.example.com、"精确短语"、-排除词、filetype:pdf、OR、括号等。'),
  max_results: z.number().int().min(1).max(20).optional().describe('最大返回结果数，默认 8'),
  allowed_domains: z.array(z.string()).optional().describe('仅允许这些域名的搜索结果；可与 blocked_domains 同时使用'),
  blocked_domains: z.array(z.string()).optional().describe('屏蔽这些域名的搜索结果；可与 allowed_domains/site_domains 同时使用'),
  site_domains: z.array(z.string()).optional().describe('结构化 site: 限定域名；工具会自动拼入 query，并用结果过滤兜底。也可以直接在 query 写 site:xxx'),
  query_keyword_groups: z.array(z.string()).max(5).optional().describe('多路查询关键词组，工具会按顺序搜索并去重合并结果；每组同样支持 site:/引号/filetype:/-词等高级语法'),
  topic: z.enum(['general', 'programming', 'documentation', 'news', 'academic', 'finance', 'technology', 'legal', 'medical']).optional().describe('搜索主题，用于提示 query planning；默认 general'),
  engine: z.enum(['auto', 'bing', 'google']).optional().describe('搜索引擎，默认 auto：优先官方 API，必要时浏览器兜底'),
  timeout_ms: z.number().int().min(1_000).max(300_000).optional().describe('本次搜索的硬超时，单位毫秒，范围 1s-300s'),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  resultType: string;
}

type SearchEngine = 'bing' | 'google';

interface SearchAttempt {
  engine: SearchEngine;
  backend: 'api' | 'browser';
  ok: boolean;
  resultCount: number;
  message?: string;
  diagnostics?: BrowserSearchDiagnostics;
}

interface SearchBatchResult {
  results: SearchResult[];
  attempts: SearchAttempt[];
}

interface BingWebPage {
  name?: unknown;
  url?: unknown;
  snippet?: unknown;
  displayUrl?: unknown;
}

interface BingSearchResponse {
  webPages?: {
    value?: BingWebPage[];
  };
}

interface GoogleSearchItem {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  displayLink?: unknown;
}

interface GoogleSearchResponse {
  items?: GoogleSearchItem[];
}

export function normalizeQueryWithSites(query: string, siteDomains?: string[]): string {
  const sites = (siteDomains || []).map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  if (sites.length === 0) return query;
  const hasSite = /\bsite:[^\s]+/i.test(query);
  const siteExpr = sites.map((d) => `site:${d}`).join(' OR ');
  return hasSite ? query : `(${siteExpr}) ${query}`;
}

function uniqueResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    const key = result.url || `${result.title}:${result.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function filterByDomains(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): SearchResult[] {
  const normalizeDomain = (d: string) => d.toLowerCase().replace(/^www\./, '');
  const allowed = (allowedDomains || []).map(normalizeDomain).filter(Boolean);
  const blocked = (blockedDomains || []).map(normalizeDomain).filter(Boolean);

  return results.filter((r) => {
    try {
      const hostname = normalizeDomain(new URL(r.url).hostname);
      if (blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`))) return false;
      if (allowed.length > 0 && !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))) return false;
    } catch {/* expected: operation may fail */
      return false;
    }
    return true;
  });
}

export function extractSiteDomainsFromQuery(query: string): string[] {
  const domains = new Set<string>();
  for (const match of query.matchAll(/\bsite:([^\s)]+)/gi)) {
    const domain = match[1]
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .replace(/^['"]|['"]$/g, '');
    if (domain) domains.add(domain);
  }
  return [...domains];
}

function formatQueryDiagnostics(plannedQueries: string[], filters: { allowedDomains: string[]; blockedDomains?: string[] }): string {
  const lines = [`搜索计划: ${plannedQueries.map((q) => `\`${q}\``).join(' | ')}`];
  if (filters.allowedDomains.length > 0) lines.push(`允许域名过滤: ${filters.allowedDomains.join(', ')}`);
  if (filters.blockedDomains?.length) lines.push(`屏蔽域名过滤: ${filters.blockedDomains.join(', ')}`);
  return lines.join('\n');
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function timeoutSeconds(timeoutMs: number | undefined): number {
  return Math.max(1, Math.min(Math.ceil((timeoutMs ?? 20_000) / 1000), 300));
}

function apiErrorMessage(error: unknown, timeoutMs: number | undefined): string {
  return formatNetworkError(error, timeoutSeconds(timeoutMs));
}

function searchSource(result: { source?: string; url: string }): string {
  if (result.source?.trim()) return result.source.trim();
  try {
    return new URL(result.url).hostname;
  } catch {/* expected: fallback to default */
    return '';
  }
}

function resolveBingApiConfig(): { key: string; endpoint: string } | null {
  const key = firstEnv('LINGXIAO_BING_SEARCH_API_KEY', 'BING_SEARCH_API_KEY', 'BING_WEB_SEARCH_API_KEY', 'AZURE_BING_SEARCH_API_KEY');
  if (!key) return null;
  const endpoint = firstEnv('LINGXIAO_BING_SEARCH_ENDPOINT', 'BING_SEARCH_ENDPOINT') || 'https://api.bing.microsoft.com/v7.0/search';
  return { key, endpoint };
}

function resolveGoogleApiConfig(): { key: string; cx: string } | null {
  const key = firstEnv('LINGXIAO_GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_API_KEY', 'GOOGLE_API_KEY');
  const cx = firstEnv('LINGXIAO_GOOGLE_SEARCH_CX', 'GOOGLE_SEARCH_CX', 'GOOGLE_CSE_ID', 'GOOGLE_CUSTOM_SEARCH_ENGINE_ID');
  return key && cx ? { key, cx } : null;
}

async function searchBingApi(query: string, maxResults: number, timeoutMs: number | undefined): Promise<SearchResult[] | null> {
  const cfg = resolveBingApiConfig();
  if (!cfg) return null;
  const url = new URL(cfg.endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 50)));
  url.searchParams.set('mkt', 'zh-CN');
  url.searchParams.set('responseFilter', 'Webpages');

  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      accept: 'application/json',
    },
  }, timeoutSeconds(timeoutMs));

  if (!response.ok) {
    throw new Error(`Bing Web Search API HTTP ${response.status}`);
  }
  const json = await response.json() as BingSearchResponse;
  return (json.webPages?.value || [])
    .map((item): SearchResult | null => {
      const title = typeof item.name === 'string' ? item.name.trim() : '';
      const urlValue = typeof item.url === 'string' ? item.url.trim() : '';
      if (!title || !urlValue) return null;
      return {
        title,
        url: urlValue,
        snippet: typeof item.snippet === 'string' ? item.snippet.trim().slice(0, 300) : '',
        source: typeof item.displayUrl === 'string' ? item.displayUrl.trim() : searchSource({ url: urlValue }),
        resultType: 'organic',
      };
    })
    .filter((item): item is SearchResult => item !== null);
}

async function searchGoogleApi(query: string, maxResults: number, timeoutMs: number | undefined): Promise<SearchResult[] | null> {
  const cfg = resolveGoogleApiConfig();
  if (!cfg) return null;
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', cfg.key);
  url.searchParams.set('cx', cfg.cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(maxResults, 10)));
  url.searchParams.set('hl', 'zh-CN');

  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
  }, timeoutSeconds(timeoutMs));

  if (!response.ok) {
    throw new Error(`Google Custom Search API HTTP ${response.status}`);
  }
  const json = await response.json() as GoogleSearchResponse;
  return (json.items || [])
    .map((item): SearchResult | null => {
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const urlValue = typeof item.link === 'string' ? item.link.trim() : '';
      if (!title || !urlValue) return null;
      return {
        title,
        url: urlValue,
        snippet: typeof item.snippet === 'string' ? item.snippet.trim().slice(0, 300) : '',
        source: typeof item.displayLink === 'string' ? item.displayLink.trim() : searchSource({ url: urlValue }),
        resultType: 'organic',
      };
    })
    .filter((item): item is SearchResult => item !== null);
}

function plannedEngines(engine: 'auto' | SearchEngine): SearchEngine[] {
  if (engine !== 'auto') return [engine];
  const engines: SearchEngine[] = [];
  if (resolveBingApiConfig()) engines.push('bing');
  if (resolveGoogleApiConfig()) engines.push('google');
  return engines.length > 0 ? engines : ['bing'];
}

async function searchApi(engine: SearchEngine, query: string, maxResults: number, timeoutMs: number | undefined): Promise<SearchResult[] | null> {
  return engine === 'google'
    ? searchGoogleApi(query, maxResults, timeoutMs)
    : searchBingApi(query, maxResults, timeoutMs);
}

async function searchBrowser(engine: SearchEngine, query: string, maxResults: number, timeoutMs: number | undefined) {
  return engine === 'google'
    ? browserManager.searchGoogleDetailed(query, maxResults, { timeoutMs })
    : browserManager.searchBingDetailed(query, maxResults, { timeoutMs });
}

async function runSearchBatch(
  engine: 'auto' | SearchEngine,
  plannedQueries: string[],
  maxResults: number,
  timeoutMs: number | undefined,
): Promise<SearchBatchResult> {
  const attempts: SearchAttempt[] = [];
  const rawResults: SearchResult[] = [];
  const engines = plannedEngines(engine);

  for (const searchEngine of engines) {
    for (const plannedQuery of plannedQueries) {
      try {
        const apiResults = await searchApi(searchEngine, plannedQuery, maxResults * 2, timeoutMs);
        if (apiResults) {
          attempts.push({ engine: searchEngine, backend: 'api', ok: true, resultCount: apiResults.length });
          rawResults.push(...apiResults);
          if (rawResults.length >= maxResults * 2) return { results: rawResults, attempts };
          continue;
        }
        attempts.push({
          engine: searchEngine,
          backend: 'api',
          ok: false,
          resultCount: 0,
          message: '未配置官方搜索 API key，跳过 API 主路径',
        });
      } catch (error) {
        attempts.push({
          engine: searchEngine,
          backend: 'api',
          ok: false,
          resultCount: 0,
          message: apiErrorMessage(error, timeoutMs),
        });
      }

      const browserResponse = await searchBrowser(searchEngine, plannedQuery, maxResults * 2, timeoutMs);
      attempts.push({
        engine: searchEngine,
        backend: 'browser',
        ok: browserResponse.diagnostics.warnings.length === 0,
        resultCount: browserResponse.results.length,
        diagnostics: browserResponse.diagnostics,
        message: browserResponse.diagnostics.warnings.join(', ') || undefined,
      });
      rawResults.push(...browserResponse.results);
      if (rawResults.length >= maxResults * 2) return { results: rawResults, attempts };
    }
  }

  return { results: rawResults, attempts };
}

function formatAttemptDiagnostics(attempts: SearchAttempt[]): string {
  const lines = attempts.map((attempt) => {
    const status = attempt.ok ? 'ok' : 'skip/fail';
    const base = `${attempt.engine}/${attempt.backend}: ${status}, results=${attempt.resultCount}`;
    return attempt.message ? `${base}, ${attempt.message}` : base;
  });
  return lines.length > 0 ? `搜索后端: ${lines.join(' | ')}` : '搜索后端: none';
}

export class WebSearchTool extends Tool {
  readonly name = 'web_search';
  readonly description =
    '优先使用官方 Bing / Google 搜索 JSON API，未配置 API key 时才用隔离浏览器会话兜底，返回结构化搜索结果。' +
    'query 支持并原样透传搜索引擎高级语法：site:、"精确短语"、-排除词、filetype:、OR、括号；site_domains 会额外做结果过滤兜底。' +
    '适合需要最新网页信息的搜索场景。';
  readonly parameters = WebSearchSchema;

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof WebSearchSchema>;

    if (!params.query?.trim()) {
      return { success: false, data: null, error: '请提供非空 query 搜索词。' };
    }

    const maxResults = Math.max(1, Math.min(params.max_results || 8, 20));
    const engine = params.engine || 'auto';
    const timeoutMs = params.timeout_ms;
    const queryGroups = params.query_keyword_groups?.length
      ? params.query_keyword_groups
      : [params.query];
    const inlineSiteDomains = queryGroups.flatMap(extractSiteDomainsFromQuery);
    const allowedDomains = [...new Set([...(params.allowed_domains || []), ...(params.site_domains || []), ...inlineSiteDomains])];
    const plannedQueries = queryGroups.map((rawQuery) => normalizeQueryWithSites(rawQuery.trim(), params.site_domains));

    try {
      const rawResults: SearchResult[] = [];
      const batch = await runSearchBatch(engine, plannedQueries, maxResults, timeoutMs);
      rawResults.push(...batch.results);

      const results = filterByDomains(uniqueResults(rawResults), allowedDomains, params.blocked_domains)
        .slice(0, maxResults);
      const diagnostics = [
        formatQueryDiagnostics(plannedQueries, { allowedDomains, blockedDomains: params.blocked_domains }),
        formatAttemptDiagnostics(batch.attempts),
      ].join('\n');

      if (results.length === 0) {
        return {
          success: true,
          data: `未找到关于 "${params.query}" 的搜索结果。\n${diagnostics}\n提示：如果高级语法过窄，可放宽 site:/filetype:/引号或增加 query_keyword_groups。`,
        };
      }

      const formatted = [
        `网页搜索结果 (${engine}${params.topic ? `/${params.topic}` : ''}) - "${params.query}" (${results.length}/${maxResults}):`,
        diagnostics,
        '',
        ...results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet || '(无摘要)'}`
        ),
      ].join('\n');

      return { success: true, data: formatted };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: null,
        error: `网页搜索失败: ${msg}`,
      };
    }
  }
}

export default WebSearchTool;
