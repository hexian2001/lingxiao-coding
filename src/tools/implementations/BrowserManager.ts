/**
 * Playwright-based browser manager for web search and fetch tools.
 * Inspired by soushen-hunter architecture, implemented in TypeScript.
 *
 * Provides:
 * - Shared browser instance lifecycle (lazy init, auto-close)
 * - Bing and Google search via real browser DOM interaction
 * - Deep page analysis (headings, tables, forms, buttons, links, etc.)
 * - Screenshot capture
 */

import type { Browser, ElementHandle, Page, BrowserContext, BrowserContextOptions } from 'playwright';
import { TIMEOUT } from '../../config/defaults.js';
import type { BrowserHealth, BrowserProxyConfig as ProxyConfig } from '../../core/BrowserProvider.js';
import {
  _resetChromePathCacheForTesting,
  browserProxyChanged,
  buildPlaywrightInstallCommands,
  checkBrowserHealth,
  createBrowserMissingDiagnostics,
  createBrowserSkippedError,
  isBrowserSkipped,
  launchManagedChromium,
  readBrowserDaemonFlag,
  readBrowserIdleMs,
  resolveBrowserProxy,
} from '../../core/BrowserProvider.js';
import { registerCleanup } from '../../core/CleanupRegistry.js';
import { rememberBrowserVersion, buildStealthUserAgent, buildStealthInitScript } from '../../core/BrowserStealth.js';

export type { BrowserHealth, BrowserProxyConfig as ProxyConfig } from '../../core/BrowserProvider.js';
export {
  _resetChromePathCacheForTesting,
  buildPlaywrightInstallCommands,
  createBrowserMissingDiagnostics,
  createBrowserSkippedError,
  isBrowserSkipped,
} from '../../core/BrowserProvider.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  resultType: string;
}

export interface BrowserSearchDiagnostics {
  engine: 'bing' | 'google';
  requestedQuery: string;
  finalUrl: string;
  pageTitle: string;
  queryEcho?: string;
  searchInputValue?: string;
  hasResultContainer: boolean;
  warnings: string[];
}

export interface BrowserSearchResponse {
  results: SearchResult[];
  diagnostics: BrowserSearchDiagnostics;
}

/**
 * audit-2026-05-15：BrowserManager 现在支持 proxy 与 daemon 配置。
 *
 * - Proxy 来源优先级（高 → 低）：
 *   1. 工具入参（per-call）：通过 ensureBrowser({ proxy }) 传入，会创建独立 context
 *      以避免污染共享 page；适合 BrowserActionTool / WebFetch 单次特殊代理。
 *   2. runtimeConfig：`config.browser.proxy = { server, username?, password?, bypass? }`
 *   3. 环境变量：LINGXIAO_BROWSER_PROXY > HTTPS_PROXY > HTTP_PROXY（兼容现有 *_PROXY 习惯）
 *
 * - Daemon 模式：LINGXIAO_BROWSER_DAEMON=1 或 config.browser.daemon=true 时，
 *   关闭 idle 自动 close（IDLE_TIMEOUT_MS 不再触发），让浏览器跨工具调用长期驻留。
 *   IDLE_TIMEOUT_MS 也可通过 LINGXIAO_BROWSER_IDLE_MS / config.browser.idle_ms 覆写。
 */
export interface PageElement {
  text: string;
  href?: string;
  type?: string;
}

export interface FormElement {
  action: string;
  method: string;
  name: string;
  inputs: Array<{
    name: string;
    type: string;
    placeholder: string;
    required: boolean;
    value: string;
  }>;
}

export interface DeepPageElements {
  title: string;
  url: string;
  textContent: string;
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  lists: Array<{ type: string; items: string[] }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  codeBlocks: string[];
  links: PageElement[];
  forms: FormElement[];
  buttons: Array<{ text: string; type: string; id: string; action: string }>;
  scripts: string[];
  meta: Record<string, string>;
}

export interface ScreenshotResult {
  path?: string;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

// ==================== Timeout Constants ====================
const GOTO_TIMEOUT_MS = TIMEOUT.BROWSER_GOTO_MS;
const DEEP_GOTO_TIMEOUT_MS = TIMEOUT.BROWSER_DEEP_GOTO_MS;
const SELECTOR_TIMEOUT_MS = TIMEOUT.BROWSER_SELECTOR_MS;
const NETWORK_IDLE_MS = TIMEOUT.BROWSER_NETWORK_IDLE_MS;
const SEARCH_NETWORK_IDLE_MS = TIMEOUT.BROWSER_SEARCH_NETWORK_IDLE_MS;

const debug = (msg: string) => process.env.DEBUG_BROWSER && console.error(`[Browser] ${msg}`);

function buildDefaultContextOptions(overrides?: BrowserContextOptions): BrowserContextOptions {
  return {
    userAgent: buildStealthUserAgent(),
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    ...overrides,
  };
}

function normalizeQueryEcho(value: string | undefined): string {
  return (value || '').trim().replace(/\s+/g, ' ');
}

function searchQueryFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get('q') || url.searchParams.get('p') || undefined;
  } catch {/* expected: resource not available */
    return undefined;
  }
}

function queryEchoMatches(requestedQuery: string, echo: string | undefined): boolean {
  return normalizeQueryEcho(requestedQuery) === normalizeQueryEcho(echo);
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Idle timeout 保留为读操作（每次 resetIdleTimer 时取最新 config / env），
   * 这样运行时改 settings.json 的 `browser.idle_ms` 立即对下一次 idle 倒计时生效，
   * 不再被构造期 capture 的常量锁死。
   */
  private get IDLE_TIMEOUT_MS(): number {
    return readBrowserIdleMs(5 * 60 * 1000);
  }
  /** 当前 launch 时使用的 proxy 配置（用于检测 per-call proxy 是否需要新 context） */
  private launchedWithProxy: ProxyConfig | undefined;
  /**
   * audit-2026-05-15：共享 page 互斥队列。
   *
   * Leader 把 web_search / web_fetch 标记为 PARALLEL_SAFE，LLM 一次吐 4 个 tool_call 时
   * `Promise.all` 同时跑过来，但 BrowserManager 内部只有一个共享 page。多个并发
   * `page.goto` 会互相打断 navigation，前一次的 `waitForSelector / waitForLoadState`
   * 一直 await 直到上层硬超时（30s × N），最终把 Leader round 卡 100s+。
   *
   * 解决：所有共享 page 的方法（searchBing / searchGoogle / extractDeepPageElements /
   * takeScreenshot）走同一把 mutex 串行化。需要并发时改用 createIsolatedContext。
   * mutex 默认套 45s 硬超时兜底，避免单次 search 异常时整个队列被堵死。
   */
  private pageMutex: Promise<void> = Promise.resolve();
  private static readonly DEFAULT_LOCK_TIMEOUT_MS = 45_000;

  /** 共享 page 串行化执行入口；异常或超时都会释放锁。 */
  private async withPageLock<T>(label: string, fn: () => Promise<T>, timeoutMs = BrowserManager.DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
    const previous = this.pageMutex;
    let release: () => void = () => {};
    this.pageMutex = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          setTimeout(
            () => reject(new Error(`browser ${label} timeout after ${timeoutMs}ms`)),
            timeoutMs,
          ).unref?.();
        }),
      ]);
    } finally {
      release();
    }
  }

  async checkHealth(options?: { launch?: boolean }): Promise<BrowserHealth> {
    return checkBrowserHealth(options);
  }

  async ensureBrowser(): Promise<Page> {
    // 配置热加载：如果 settings.browser.proxy 改了，关闭旧实例后下次重新 launch。
    // 已经在执行的 page 操作会拿到旧 proxy（page 引用没换），但下一次 ensureBrowser
    // 会拿到新 proxy 启动的 browser；接受这个边界，因为强行打断 in-flight navigation
    // 的代价比"下一次生效"更大。
    if (this.browser?.isConnected() && browserProxyChanged(this.launchedWithProxy, resolveBrowserProxy())) {
      debug('Proxy config changed; closing browser to re-launch with new proxy');
      await this.close().catch(() => { /* ignore */ });
    }

    if (this.page && this.browser?.isConnected()) {
      this.resetIdleTimer();
      return this.page;
    }

    await this.ensureLaunching();
    this.resetIdleTimer();
    return this.page!;
  }

  private async launch(): Promise<void> {
    debug('Launching browser...');
    const launched = await launchManagedChromium();
    this.browser = launched.browser;
    this.launchedWithProxy = launched.proxy;
    try {
      // 探测真实 Chromium 主版本号,供 UA 动态对齐(消除 Chrome/130 vs 真实版本的矛盾指纹)。
      try {
        rememberBrowserVersion(await this.browser.version());
      } catch {/* ignore: 回落 BrowserStealth fallback 版本 */}
      this.context = await this.browser.newContext(buildDefaultContextOptions());
      // 每个 frame 加载前擦除自动化指纹(navigator.webdriver 等),等价 stealth 核心补丁。
      await this.context.addInitScript(buildStealthInitScript());
      this.page = await this.context.newPage();
    } catch (err) {
      // newContext/newPage 失败会留下已连接的 Chromium 进程(孤儿,数百 MB)且 this.browser 被置位,
      // 导致后续 ensureBrowser 拿到半成品。关闭并清空,让下次 ensureBrowser 能重新 launch(#15)。
      debug(`launch newContext/newPage failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.browser.close().catch(() => { /* ignore close error during cleanup */ });
      this.browser = null;
      this.context = null;
      this.page = null;
      throw err;
    }
    debug('Browser ready');
  }

  /**
   * 返回(缓存的)launch promise;失败时清空缓存,使下次 ensureBrowser/createIsolatedContext
   * 可重试,而非永久 re-await 同一个 rejected promise(否则一次瞬时启动失败会砖化整个会话的浏览器工具,#15)。
   */
  private ensureLaunching(): Promise<void> {
    if (!this.launchPromise) {
      this.launchPromise = this.launch().catch((err) => {
        this.launchPromise = null;
        throw err;
      });
    }
    return this.launchPromise;
  }

  /**
   * 创建一次性的隔离 context（不复用全局 page），用于：
   * - per-call proxy 与全局代理不一致
   * - 需要避免污染共享 page 的特殊会话
   * 调用方使用完毕后必须调 disposeIsolatedContext(ctx) 释放。
   */
  async createIsolatedContext(options?: { proxy?: ProxyConfig }): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.browser?.isConnected()) {
      await this.ensureLaunching();
    }
    this.resetIdleTimer();
    const ctx = await this.browser!.newContext(buildDefaultContextOptions({
      ...(options?.proxy ? { proxy: options.proxy } : {}),
    }));
    // 隔离 context 同样注入 stealth init script——web_search 的 Bing/Google SERP 抓取走这条路径。
    await ctx.addInitScript(buildStealthInitScript());
    const pg = await ctx.newPage();
    return { context: ctx, page: pg };
  }

  async disposeIsolatedContext(ctx: BrowserContext): Promise<void> {
    try {
      await ctx.close();
    } catch (err) {
      debug(`disposeIsolatedContext error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 是否启用 daemon 模式 — 启用后跨工具调用浏览器长期驻留，不再 idle 自动关闭。*/
  isDaemonMode(): boolean {
    return readBrowserDaemonFlag();
  }

  /** 暴露给调用方做诊断使用（per-call proxy 是否与全局一致）。 */
  getLaunchedProxy(): ProxyConfig | undefined {
    return this.launchedWithProxy;
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser?.isConnected()) {
      await this.browser.close();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchPromise = null;
    debug('Closed');
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Daemon 模式：跨工具调用长期驻留，不再 idle 自动关闭。
    if (readBrowserDaemonFlag()) return;
    this.idleTimer = setTimeout(() => this.close(), this.IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  async searchBing(query: string, numResults: number, options?: { timeoutMs?: number }): Promise<SearchResult[]> {
    return (await this.searchBingDetailed(query, numResults, options)).results;
  }

  async searchBingDetailed(query: string, numResults: number, options?: { timeoutMs?: number }): Promise<BrowserSearchResponse> {
    const { context, page } = await this.createIsolatedContext();
    const diagnostics = this.createSearchDiagnostics('bing', query);
    try {
      const encodedQuery = encodeURIComponent(query);
      await page.goto(`https://www.bing.com/search?q=${encodedQuery}&count=${numResults}`, {
        waitUntil: 'domcontentloaded',
        timeout: options?.timeoutMs ?? GOTO_TIMEOUT_MS,
      });
      await page.waitForLoadState('networkidle', { timeout: SEARCH_NETWORK_IDLE_MS }).catch(() => {});

      Object.assign(diagnostics, await this.collectSearchDiagnostics(page, 'bing', query, {
        resultContainerSelectors: ['#b_results', 'li.b_algo', '.b_ad li', '.news-card'],
        inputSelectors: ['input[name="q"]', '#sb_form_q'],
      }));
      if (!this.searchPageMatchesQuery(diagnostics)) {
        diagnostics.warnings.push('query_echo_mismatch');
        return { results: [], diagnostics };
      }

      const results: SearchResult[] = [];
      const selectors = ['li.b_algo', '.b_ad li', '.news-card'];
      for (const selector of selectors) {
        const elements = await page.$$(selector);
        for (const elem of elements) {
          if (results.length >= numResults) break;
          try {
            const result = await this.extractSearchResult(elem, page.url());
            if (result?.url) results.push(result);
          } catch {
            // skip malformed search blocks
          }
        }
        if (results.length >= numResults) break;
      }
      return { results: results.slice(0, numResults), diagnostics };
    } catch (err) {
      diagnostics.warnings.push(`browser_search_error:${err instanceof Error ? err.message : String(err)}`);
      debug(`Bing search error: ${err}`);
      return { results: [], diagnostics };
    } finally {
      await this.disposeIsolatedContext(context);
    }
  }

  async searchGoogle(query: string, numResults: number, options?: { timeoutMs?: number }): Promise<SearchResult[]> {
    return (await this.searchGoogleDetailed(query, numResults, options)).results;
  }

  async searchGoogleDetailed(query: string, numResults: number, options?: { timeoutMs?: number }): Promise<BrowserSearchResponse> {
    const { context, page } = await this.createIsolatedContext();
    const diagnostics = this.createSearchDiagnostics('google', query);
    try {
      const encodedQuery = encodeURIComponent(query);
      await page.goto(
        `https://www.google.com/search?q=${encodedQuery}&num=${numResults}`,
        { waitUntil: 'domcontentloaded', timeout: options?.timeoutMs ?? GOTO_TIMEOUT_MS },
      );
      await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});

      Object.assign(diagnostics, await this.collectSearchDiagnostics(page, 'google', query, {
        resultContainerSelectors: ['#search', 'div.g', 'div[data-sokoban-grid-container]', 'div.MjjYud'],
        inputSelectors: ['textarea[name="q"]', 'input[name="q"]'],
      }));
      if (!this.searchPageMatchesQuery(diagnostics)) {
        diagnostics.warnings.push('query_echo_mismatch');
        return { results: [], diagnostics };
      }

      const results: SearchResult[] = [];
      const selectors = ['div.g', 'div[data-sokoban-grid-container] div.g', 'div.MjjYud'];
      for (const selector of selectors) {
        const elements = await page.$$(selector);
        for (const elem of elements) {
          if (results.length >= numResults) break;
          try {
            const titleElem = await elem.$('a h3, h3');
            if (!titleElem) continue;
            const title = (await titleElem.innerText()).trim();
            if (!title) continue;

            const linkElem = await elem.$('a[href]');
            if (!linkElem) continue;
            const href = await linkElem.getAttribute('href');
            const url = this.normalizeSearchHref(href, page.url());
            if (!url) continue;

            const snippetElem = await elem.$('[data-sncf], .VwiC3b, span');
            const snippet = snippetElem ? await snippetElem.innerText().catch(() => '') : '';
            results.push({
              title,
              url,
              snippet: snippet.trim().slice(0, 300),
              source: new URL(url).hostname,
              resultType: 'organic',
            });
          } catch {
            // skip malformed search blocks
          }
        }
        if (results.length >= numResults) break;
      }
      return { results: results.slice(0, numResults), diagnostics };
    } catch (err) {
      diagnostics.warnings.push(`browser_search_error:${err instanceof Error ? err.message : String(err)}`);
      debug(`Google search error: ${err}`);
      return { results: [], diagnostics };
    } finally {
      await this.disposeIsolatedContext(context);
    }
  }

  private createSearchDiagnostics(engine: 'bing' | 'google', requestedQuery: string): BrowserSearchDiagnostics {
    return {
      engine,
      requestedQuery,
      finalUrl: '',
      pageTitle: '',
      hasResultContainer: false,
      warnings: [],
    };
  }

  private async collectSearchDiagnostics(
    page: Page,
    engine: 'bing' | 'google',
    requestedQuery: string,
    selectors: { resultContainerSelectors: string[]; inputSelectors: string[] },
  ): Promise<BrowserSearchDiagnostics> {
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    let searchInputValue: string | undefined;
    for (const selector of selectors.inputSelectors) {
      const value = await page.$eval(selector, (el) => (el as HTMLInputElement | HTMLTextAreaElement).value || '').catch(() => '');
      if (value.trim()) {
        searchInputValue = value.trim();
        break;
      }
    }

    let hasResultContainer = false;
    for (const selector of selectors.resultContainerSelectors) {
      const found = await page.$(selector).catch(() => null);
      if (found) {
        hasResultContainer = true;
        break;
      }
    }

    const diagnostics: BrowserSearchDiagnostics = {
      engine,
      requestedQuery,
      finalUrl,
      pageTitle,
      queryEcho: searchQueryFromUrl(finalUrl),
      searchInputValue,
      hasResultContainer,
      warnings: [],
    };
    if (!hasResultContainer) diagnostics.warnings.push('search_result_container_missing');
    return diagnostics;
  }

  private searchPageMatchesQuery(diagnostics: BrowserSearchDiagnostics): boolean {
    return queryEchoMatches(diagnostics.requestedQuery, diagnostics.queryEcho)
      || queryEchoMatches(diagnostics.requestedQuery, diagnostics.searchInputValue);
  }

  private normalizeSearchHref(rawHref: string | null | undefined, baseUrl: string): string | null {
    if (!rawHref?.trim()) return null;
    try {
      const parsed = new URL(rawHref.trim(), baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;

      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (hostname === 'google.com' && parsed.pathname === '/url') {
        return this.normalizeSearchHref(parsed.searchParams.get('q') || parsed.searchParams.get('url'), baseUrl);
      }

      if (hostname === 'bing.com' && parsed.pathname.startsWith('/ck/')) {
        const direct = this.decodeBingRedirectParam(parsed.searchParams.get('u'))
          || this.normalizeSearchHref(parsed.searchParams.get('r'), baseUrl);
        return direct;
      }

      return parsed.toString();
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  private decodeBingRedirectParam(raw: string | null): string | null {
    if (!raw) return null;
    const value = raw.trim();
    if (/^https?:\/\//i.test(value)) return this.normalizeSearchHref(value, 'https://www.bing.com/');

    // Bing redirect links often store the target URL in a base64url payload with an "a1" prefix.
    const encoded = value.startsWith('a1') ? value.slice(2) : value;
    try {
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      return /^https?:\/\//i.test(decoded)
        ? this.normalizeSearchHref(decoded, 'https://www.bing.com/')
        : null;
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  private async extractSearchResult(element: ElementHandle<HTMLElement | SVGElement>, baseUrl: string): Promise<SearchResult | null> {
    try {
      let titleElem = await element.$('h2 a, .b_title a');
      if (!titleElem) {
        const allLinks = await element.$$('a[href]');
        for (const link of allLinks) {
          const text = await link.innerText().catch(() => '');
          const href = await link.getAttribute('href');
          if (text?.trim() && this.normalizeSearchHref(href, baseUrl)) {
            titleElem = link;
            break;
          }
        }
      }
      if (!titleElem) return null;

      const title = await titleElem.innerText();
      const url = this.normalizeSearchHref(await titleElem.getAttribute('href'), baseUrl);
      if (!url) return null;
      if (!title?.trim()) return null;

      const snippetElem = await element.$('.b_caption p, .b_snippet, p');
      const snippet = snippetElem ? await snippetElem.innerText().catch(() => '') : '';

      return {
        title: title.trim(),
        url,
        snippet: snippet.trim().slice(0, 300),
        source: new URL(url).hostname,
        resultType: 'organic',
      };
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  async extractDeepPageElements(url: string): Promise<DeepPageElements | null> {
    return this.withPageLock('extractDeepPageElements', async () => {
      const page = await this.ensureBrowser();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: DEEP_GOTO_TIMEOUT_MS,
        });
        await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});

        const title = await page.title();
        const currentUrl = page.url();

        const pageData = await page.evaluate(() => {
          const cleanText = (el: Element): string => {
            const clone = el.cloneNode(true) as Element;
            clone.querySelectorAll(
              'script, style, nav, header, footer, aside, .advertisement, .ads, [class*="ad-"], [class*="banner"]',
            ).forEach((e) => e.remove());
            return clone.textContent || '';
          };

          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
            level: parseInt(h.tagName[1]),
            text: (h.textContent || '').trim(),
          })).filter((h) => h.text.length > 0);

          const paragraphs = Array.from(document.querySelectorAll('p, article p, .content p, main p'))
            .map((p) => (p.textContent || '').trim())
            .filter((t) => t.length > 20);

          const lists = Array.from(document.querySelectorAll('ul, ol')).map((list) => ({
            type: list.tagName.toLowerCase(),
            items: Array.from(list.querySelectorAll('li'))
              .map((li) => (li.textContent || '').trim())
              .filter((t) => t.length > 0),
          })).filter((l) => l.items.length > 0);

          const tables = Array.from(document.querySelectorAll('table')).map((table) => {
            const headers = Array.from(table.querySelectorAll('th')).map((th) => (th.textContent || '').trim());
            const rows = Array.from(table.querySelectorAll('tr')).slice(1).map((tr) =>
              Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim()),
            ).filter((row) => row.length > 0);
            return { headers, rows };
          }).filter((t) => t.rows.length > 0);

          const codeBlocks = Array.from(document.querySelectorAll('pre, code, .code, .highlight'))
            .map((c) => (c.textContent || '').trim())
            .filter((t) => t.length > 10);

          const mainContent = document.querySelector(
            'main, article, .content, .post, #content, [role="main"]',
          );
          const bodyText = mainContent ? cleanText(mainContent) : cleanText(document.body);

          const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
            text: (a.textContent || '').trim(),
            href: a.getAttribute('href') || '',
            type: a.getAttribute('data-type') || 'link',
          })).filter((l) => l.href && !l.href.startsWith('javascript:') && l.text.length > 0);

          const forms = Array.from(document.querySelectorAll('form')).map((form) => {
            const inputs = Array.from(form.querySelectorAll('input, select, textarea')).map((i) => ({
              name: (i as HTMLInputElement).name || '',
              type: (i as HTMLInputElement).type || i.tagName.toLowerCase(),
              placeholder: (i as HTMLInputElement).placeholder || '',
              required: (i as HTMLInputElement).required,
              value: (i as HTMLInputElement).value || '',
            }));
            return {
              action: form.action || '',
              method: form.method || 'GET',
              name: form.name || form.id || '',
              inputs,
            };
          });

          const buttons = Array.from(
            document.querySelectorAll('button, input[type="submit"], input[type="button"], .btn, [role="button"]'),
          ).map((b) => ({
            text: ((b as HTMLButtonElement).textContent || (b as HTMLInputElement).value || '').trim(),
            type: (b as HTMLButtonElement).type || 'button',
            id: b.id || '',
            action: b.getAttribute('onclick') || b.getAttribute('data-action') || '',
          })).filter((b) => b.text.length > 0);

          const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) =>
            (s as HTMLScriptElement).src,
          );

          const meta: Record<string, string> = {};
          document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
            const key = m.getAttribute('name') || m.getAttribute('property');
            if (key) meta[key] = m.getAttribute('content') || '';
          });

          return {
            textContent: bodyText,
            headings,
            paragraphs,
            lists,
            tables,
            codeBlocks,
            links,
            forms,
            buttons,
            scripts,
            meta,
          };
        });

        return {
          title,
          url: currentUrl,
          textContent: pageData.textContent,
          headings: pageData.headings,
          paragraphs: pageData.paragraphs,
          lists: pageData.lists,
          tables: pageData.tables,
          codeBlocks: pageData.codeBlocks,
          links: pageData.links,
          forms: pageData.forms,
          buttons: pageData.buttons,
          scripts: pageData.scripts,
          meta: pageData.meta,
        };
      } catch (err) {
        debug(`Deep page extract error: ${err}`);
        return null;
      }
    });
  }

  async takeScreenshot(
    url: string,
    options?: { fullPage?: boolean; format?: 'png' | 'jpeg'; quality?: number },
  ): Promise<ScreenshotResult | null> {
    return this.withPageLock('takeScreenshot', async () => {
      const page = await this.ensureBrowser();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: DEEP_GOTO_TIMEOUT_MS,
        });
        await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});

        const format = options?.format || 'png';
        const buffer = await page.screenshot({
          fullPage: options?.fullPage ?? false,
          type: format,
          ...(format === 'jpeg' && options?.quality ? { quality: options.quality } : {}),
        });

        const viewport = page.viewportSize();
        return {
          base64: buffer.toString('base64'),
          mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          width: viewport?.width || 0,
          height: viewport?.height || 0,
        };
      } catch (err) {
        debug(`Screenshot error: ${err}`);
        throw err;
      }
    });
  }
}

// Singleton
export const browserManager = new BrowserManager();
registerCleanup(() => browserManager.close(), 20);
export default browserManager;
