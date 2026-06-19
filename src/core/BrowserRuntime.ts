import type { Browser, BrowserContext, Page } from 'playwright';
import { checkBrowserHealth, launchManagedChromium, type BrowserHealth } from './BrowserProvider.js';

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface BrowserSessionSummary {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  viewport: BrowserViewport;
}

export interface BrowserElementSelection {
  browserSessionId: string;
  url: string;
  title: string;
  selector: string;
  xpath: string;
  role?: string;
  ariaLabel?: string;
  tag: string;
  text?: string;
  htmlSnippet: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: BrowserViewport;
  screenshotUrl?: string;
}

interface BrowserSession extends BrowserSessionSummary {
  context: BrowserContext;
  page: Page;
}

interface CreateBrowserSessionOptions {
  url?: string;
  viewport?: Partial<BrowserViewport>;
}

const DEFAULT_VIEWPORT: BrowserViewport = {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
};

const MAX_SESSIONS = 3;
const IDLE_TTL_MS = 25 * 60_000;

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'about:blank';
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'about:') {
    throw new Error('Only http/https URLs are supported by the browser workbench');
  }
  return url.toString();
}

function toViewport(input?: Partial<BrowserViewport>): BrowserViewport {
  const width = Math.min(1920, Math.max(360, Math.round(input?.width ?? DEFAULT_VIEWPORT.width)));
  const height = Math.min(1400, Math.max(320, Math.round(input?.height ?? DEFAULT_VIEWPORT.height)));
  const deviceScaleFactor = Math.min(2, Math.max(1, Number(input?.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor)));
  return { width, height, deviceScaleFactor };
}

function buildElementCommentPrompt(input: {
  selection: BrowserElementSelection;
  comment: string;
  intent?: string;
}): string {
  const { selection, comment } = input;
  const intent = input.intent || 'fix';
  return [
    '用户在浏览器工作台选中了一个页面元素并留下评论，请结合代码实现处理。',
    '',
    `意图: ${intent}`,
    `URL: ${selection.url}`,
    `Title: ${selection.title || 'unknown'}`,
    `Selector: ${selection.selector}`,
    `XPath: ${selection.xpath}`,
    `Tag: ${selection.tag}`,
    selection.role ? `Role: ${selection.role}` : '',
    selection.ariaLabel ? `ARIA Label: ${selection.ariaLabel}` : '',
    selection.text ? `Text: ${selection.text}` : '',
    `Rect: x=${Math.round(selection.rect.x)}, y=${Math.round(selection.rect.y)}, width=${Math.round(selection.rect.width)}, height=${Math.round(selection.rect.height)}`,
    '',
    'HTML Snippet:',
    selection.htmlSnippet,
    '',
    '用户评论:',
    comment.trim(),
  ].filter(Boolean).join('\n');
}

export class BrowserRuntime {
  private browser: Browser | null = null;
  private sessions = new Map<string, BrowserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => void this.cleanupIdle(), 5 * 60_000);
    this.cleanupTimer.unref?.();
  }

  async createSession(options: CreateBrowserSessionOptions = {}): Promise<BrowserSessionSummary> {
    await this.enforceSessionLimit();
    const browser = await this.getBrowser();
    const viewport = toViewport(options.viewport);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const session: BrowserSession = {
      id,
      context,
      page,
      url: 'about:blank',
      title: '',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      viewport,
    };
    this.sessions.set(id, session);
    if (options.url) {
      await this.navigate(id, options.url);
    }
    return this.summary(session);
  }

  async checkHealth(options?: { launch?: boolean }): Promise<BrowserHealth> {
    return checkBrowserHealth(options);
  }

  listSessions(): BrowserSessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => this.summary(session));
  }

  async navigate(id: string, url: string): Promise<BrowserSessionSummary> {
    const session = this.getSession(id);
    const normalized = normalizeUrl(url);
    session.lastUsedAt = Date.now();
    if (normalized !== 'about:blank') {
      await session.page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await session.page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    }
    session.url = session.page.url();
    session.title = await session.page.title().catch(() => '');
    return this.summary(session);
  }

  async screenshot(id: string): Promise<Buffer> {
    const session = this.getSession(id);
    session.lastUsedAt = Date.now();
    return session.page.screenshot({
      type: 'png',
      fullPage: false,
      animations: 'disabled',
    });
  }

  async inspect(id: string, point: { x: number; y: number }): Promise<BrowserElementSelection> {
    const session = this.getSession(id);
    session.lastUsedAt = Date.now();
    const x = Math.max(0, Math.min(session.viewport.width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(session.viewport.height - 1, Math.round(point.y)));
    const result = await session.page.evaluate(({ x: pageX, y: pageY }) => {
      const target = document.elementFromPoint(pageX, pageY);
      if (!target || !(target instanceof Element)) return null;

      const esc = (value: string) => {
        const css = (window as unknown as { CSS?: { escape?: (text: string) => string } }).CSS;
        if (css?.escape) return css.escape(value);
        return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
      };

      const stableAttr = (el: Element): string | null => {
        const attrs = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'title'];
        for (const attr of attrs) {
          const value = el.getAttribute(attr);
          if (value && value.trim()) return `[${attr}="${value.replace(/"/g, '\\"')}"]`;
        }
        return null;
      };

      const selectorFor = (el: Element): string => {
        if (el.id) return `#${esc(el.id)}`;
        const attr = stableAttr(el);
        if (attr) return `${el.tagName.toLowerCase()}${attr}`;
        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
          const tag = current.tagName.toLowerCase();
          if (current.id) {
            parts.unshift(`#${esc(current.id)}`);
            break;
          }
          const currentAttr = stableAttr(current);
          if (currentAttr) {
            parts.unshift(`${tag}${currentAttr}`);
            break;
          }
          let sameTagIndex = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) sameTagIndex++;
            sibling = sibling.previousElementSibling;
          }
          const className = typeof current.getAttribute('class') === 'string'
            ? current.getAttribute('class')!.split(/\s+/).filter(Boolean).slice(0, 2).map(esc).join('.')
            : '';
          parts.unshift(`${tag}${className ? `.${className}` : ''}:nth-of-type(${sameTagIndex})`);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };

      const xpathFor = (el: Element): string => {
        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          let index = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) index++;
            sibling = sibling.previousElementSibling;
          }
          parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
          current = current.parentElement;
        }
        return `/${parts.join('/')}`;
      };

      const rect = target.getBoundingClientRect();
      const role = target.getAttribute('role') || undefined;
      const ariaLabel = target.getAttribute('aria-label') || undefined;
      const text = (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500) || undefined;
      const htmlSnippet = target.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 1800);
      return {
        selector: selectorFor(target),
        xpath: xpathFor(target),
        role,
        ariaLabel,
        tag: target.tagName.toLowerCase(),
        text,
        htmlSnippet,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio || 1,
        },
        url: window.location.href,
        title: document.title,
      };
    }, { x, y });

    if (!result) {
      throw new Error('No element found at that point');
    }

    const selection: BrowserElementSelection = {
      browserSessionId: id,
      url: result.url,
      title: result.title,
      selector: result.selector,
      xpath: result.xpath,
      role: result.role,
      ariaLabel: result.ariaLabel,
      tag: result.tag,
      text: result.text,
      htmlSnippet: result.htmlSnippet,
      rect: result.rect,
      viewport: result.viewport,
    };
    session.url = result.url;
    session.title = result.title;
    session.viewport = result.viewport;
    return selection;
  }

  buildComment(input: { selection: BrowserElementSelection; comment: string; intent?: string }) {
    return {
      type: 'browser_element_comment',
      prompt: buildElementCommentPrompt(input),
      context: {
        type: 'browser_element_comment',
        intent: input.intent || 'fix',
        comment: input.comment.trim(),
        selection: input.selection,
      },
    };
  }

  async closeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.context.close().catch(() => {});
    return true;
  }

  async destroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const sessions = Array.from(this.sessions.keys());
    await Promise.all(sessions.map((id) => this.closeSession(id)));
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    const launched = await launchManagedChromium();
    this.browser = launched.browser;
    return this.browser;
  }

  private getSession(id: string): BrowserSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Browser session not found: ${id}`);
    return session;
  }

  private summary(session: BrowserSession): BrowserSessionSummary {
    return {
      id: session.id,
      url: session.url,
      title: session.title,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      viewport: session.viewport,
    };
  }

  private async enforceSessionLimit(): Promise<void> {
    if (this.sessions.size < MAX_SESSIONS) return;
    const oldest = Array.from(this.sessions.values()).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (oldest) await this.closeSession(oldest.id);
  }

  private async cleanupIdle(): Promise<void> {
    const now = Date.now();
    const stale = Array.from(this.sessions.values())
      .filter((session) => now - session.lastUsedAt > IDLE_TTL_MS)
      .map((session) => session.id);
    await Promise.all(stale.map((id) => this.closeSession(id)));
  }
}
