/**
 * BrowserActionTool — interactive browser automation for agents.
 *
 * Wraps Playwright to give agents real browser interaction:
 * navigate, click, fill forms, wait for elements, read text, run JS.
 *
 * Uses the shared BrowserManager page instance so state persists
 * across sequential tool calls within a session.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { browserManager } from './BrowserManager.js';
import type { BrowserHealth } from './BrowserManager.js';
import { config as runtimeConfig } from '../../config.js';

const BrowserActionExposedSchema = z.object({
  action: z.string().describe('操作类型：check、navigate、click、fill、select、wait_for、get_text、get_html、eval_js、scroll、current_url、get_attribute、press_key'),
  launch: z.boolean().optional().describe('check 时是否实际尝试启动浏览器，默认 false'),
  url: z.string().optional().describe('navigate 时要导航到的 URL'),
  wait_until: z.string().optional().describe('navigate 等待事件：load、domcontentloaded、networkidle，默认 domcontentloaded'),
  selector: z.string().optional().describe('CSS 选择器或 text=文本选择器；click/fill/select/wait_for/get_text/get_html/get_attribute/press_key 可用'),
  timeout: z.coerce.number().int().min(500).max(30000).optional().describe('等待超时 ms'),
  value: z.string().optional().describe('fill/select 时要填写或选择的值'),
  clear_first: z.boolean().optional().describe('fill 前是否清空，默认 true'),
  state: z.string().optional().describe('wait_for 状态：visible、hidden、attached、detached，默认 visible'),
  max_chars: z.coerce.number().int().min(100).max(50000).optional().describe('get_text/get_html 最大返回字符数'),
  script: z.string().optional().describe('eval_js 时在页面上下文执行的 JavaScript'),
  direction: z.string().optional().describe('scroll 方向：up、down、top、bottom'),
  pixels: z.coerce.number().int().min(0).optional().describe('scroll up/down 时的滚动像素数，默认 500'),
  attribute: z.string().optional().describe('get_attribute 时要读取的属性名，如 href/src/value'),
  key: z.string().optional().describe('press_key 时要按下的键名，如 Enter/Tab/Escape/ArrowDown'),
}).strict().describe('浏览器动作参数。顶层保持 object schema，具体必填字段由 action 决定，runtime 会做严格校验。');

const BrowserActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('check'),
    launch: z.boolean().optional().describe('是否实际尝试启动浏览器，默认 false（只检查安装路径）'),
  }),
  z.object({
    action: z.literal('navigate'),
    url: z.string().url().describe('要导航到的 URL'),
    wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
      .describe('等待事件，默认 domcontentloaded'),
  }),
  z.object({
    action: z.literal('click'),
    selector: z.string().describe('CSS 选择器或文本内容（text=按钮文字）'),
    timeout: z.coerce.number().int().min(500).max(30000).optional().describe('等待超时 ms，默认 5000'),
  }),
  z.object({
    action: z.literal('fill'),
    selector: z.string().describe('输入框 CSS 选择器'),
    value: z.string().describe('要填入的值'),
    clear_first: z.boolean().optional().describe('填写前清空，默认 true'),
  }),
  z.object({
    action: z.literal('select'),
    selector: z.string().describe('下拉框 CSS 选择器'),
    value: z.string().describe('要选择的 option value'),
  }),
  z.object({
    action: z.literal('wait_for'),
    selector: z.string().describe('等待出现的元素 CSS 选择器'),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional()
      .describe('等待状态，默认 visible'),
    timeout: z.coerce.number().int().min(500).max(30000).optional().describe('超时 ms，默认 8000'),
  }),
  z.object({
    action: z.literal('get_text'),
    selector: z.string().optional().describe('CSS 选择器，省略则返回整个页面文本'),
    max_chars: z.coerce.number().int().min(100).max(20000).optional().describe('最大字符数，默认 4000'),
  }),
  z.object({
    action: z.literal('get_html'),
    selector: z.string().optional().describe('CSS 选择器，省略则返回 body outerHTML'),
    max_chars: z.coerce.number().int().min(100).max(50000).optional().describe('最大字符数，默认 8000'),
  }),
  z.object({
    action: z.literal('eval_js'),
    script: z.string().describe('在页面上下文执行的 JavaScript，返回值会被序列化'),
  }),
  z.object({
    action: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'top', 'bottom']).describe('滚动方向'),
    pixels: z.coerce.number().int().min(0).optional().describe('滚动像素数（up/down 时有效，默认 500）'),
  }),
  z.object({
    action: z.literal('current_url'),
  }),
  z.object({
    action: z.literal('get_attribute'),
    selector: z.string().describe('元素 CSS 选择器'),
    attribute: z.string().describe('要读取的属性名，如 href / src / value'),
  }),
  z.object({
    action: z.literal('press_key'),
    key: z.string().describe('键名，如 Enter / Tab / Escape / ArrowDown 等'),
    selector: z.string().optional().describe('先聚焦到该元素，省略则对当前焦点元素按键'),
  }),
]);

type BrowserActionManager = {
  checkHealth(options?: { launch?: boolean }): Promise<BrowserHealth>;
  ensureBrowser(): Promise<import('playwright').Page>;
};

async function capturePageSnapshot(page: import('playwright').Page, errorSelector?: string): Promise<Record<string, unknown>> {
  const [title, visibleText, candidates] = await Promise.all([
    typeof page.title === 'function' ? page.title().catch(() => '') : Promise.resolve(''),
    typeof page.evaluate === 'function' ? page.evaluate(() => (document.body?.innerText || '').slice(0, 1200)).catch(() => '') : Promise.resolve(''),
    typeof page.evaluate === 'function' ? page.evaluate(() => {
      const describe = (el: Element) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 80),
        id: (el as HTMLElement).id || undefined,
        name: el.getAttribute('name') || undefined,
        type: el.getAttribute('type') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        aria: el.getAttribute('aria-label') || undefined,
      });
      return Array.from(document.querySelectorAll('button,a,input,textarea,select'))
        .slice(0, 30)
        .map(describe);
    }).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    url: typeof page.url === 'function' ? page.url() : '',
    title,
    visible_text_preview: visibleText,
    candidate_elements: candidates,
    ...(errorSelector ? { failed_selector: errorSelector } : {}),
  };
}

function actionResult(message: string, snapshot: Record<string, unknown>): ToolResult {
  return { success: true, data: { message, page: snapshot } };
}

export class BrowserActionTool extends Tool {
  readonly name = 'browser_action';
  readonly description =
    '在真实浏览器中执行交互操作：导航、点击、填写表单、等待元素、读取文本、执行 JS。浏览器状态在同一 session 内持续保持。Daemon 模式（LINGXIAO_BROWSER_DAEMON=1）跨工具调用长期驻留。数字类型字段接受数字字符串并归一为数字。';
  readonly parameters = BrowserActionSchema;
  readonly exposedParameters = BrowserActionExposedSchema;

  constructor(private readonly manager: BrowserActionManager = browserManager) {
    super();
  }

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    // args 已在 Registry.validateArgs 中完成 normalize（JSON 字符串解析 + 嵌套 action 展开）
    const params = BrowserActionSchema.parse(args);

    if (params.action === 'check') {
      const health = await this.manager.checkHealth({ launch: params.launch === true });
      return { success: true, data: health };
    }

    let page: import('playwright').Page;
    try {
      page = await this.manager.ensureBrowser();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `浏览器启动失败: ${msg}` };
    }

    try {
      switch (params.action) {
        case 'navigate': {
          await page.goto(params.url, {
            waitUntil: params.wait_until ?? 'domcontentloaded',
            timeout: runtimeConfig.timeouts.browser_goto_ms,
          });
          return actionResult(`已导航到: ${page.url()}`, await capturePageSnapshot(page));
        }

        case 'click': {
          await page.click(params.selector, { timeout: params.timeout ?? 5000 });
          return actionResult(`已点击: ${params.selector}`, await capturePageSnapshot(page));
        }

        case 'fill': {
          if (params.clear_first !== false) {
            await page.fill(params.selector, '');
          }
          await page.fill(params.selector, params.value);
          return actionResult(`已填写 ${params.selector}`, await capturePageSnapshot(page));
        }

        case 'select': {
          await page.selectOption(params.selector, params.value);
          return actionResult(`已选择 ${params.selector}`, await capturePageSnapshot(page));
        }

        case 'wait_for': {
          await page.waitForSelector(params.selector, {
            state: params.state ?? 'visible',
            timeout: params.timeout ?? 8000,
          });
          return actionResult(`元素已出现: ${params.selector}`, await capturePageSnapshot(page));
        }

        case 'get_text': {
          const maxChars = params.max_chars ?? runtimeConfig.timeouts.browser_text_max;
          let text: string;
          if (params.selector) {
            text = await page.locator(params.selector).first().innerText({ timeout: 5000 });
          } else {
            text = await page.evaluate(() => document.body?.innerText ?? '') as string;
          }
          if (text.length > maxChars) {
            text = text.slice(0, maxChars) + `\n...[截断，共 ${text.length} 字符]`;
          }
          return { success: true, data: text };
        }

        case 'get_html': {
          const maxChars = params.max_chars ?? runtimeConfig.timeouts.browser_html_max;
          let html: string;
          if (params.selector) {
            html = await page.locator(params.selector).first().evaluate((el) => el.outerHTML);
          } else {
            html = await page.evaluate(() => document.body?.outerHTML ?? '') as string;
          }
          if (html.length > maxChars) {
            html = html.slice(0, maxChars) + `\n...[截断，共 ${html.length} 字符]`;
          }
          return { success: true, data: html };
        }

        case 'eval_js': {
          const result = await page.evaluate(params.script) as unknown;
          const serialized = result === undefined ? 'undefined'
            : typeof result === 'string' ? result
            : JSON.stringify(result, null, 2);
          return { success: true, data: serialized };
        }

        case 'scroll': {
          const px = params.pixels ?? 500;
          if (params.direction === 'top') {
            await page.evaluate(() => window.scrollTo(0, 0));
          } else if (params.direction === 'bottom') {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          } else if (params.direction === 'down') {
            await page.evaluate((y) => window.scrollBy(0, y), px);
          } else {
            await page.evaluate((y) => window.scrollBy(0, -y), px);
          }
          return actionResult(`已滚动 ${params.direction}${params.direction === 'up' || params.direction === 'down' ? ` ${px}px` : ''}`, await capturePageSnapshot(page));
        }

        case 'current_url': {
          return { success: true, data: await capturePageSnapshot(page) };
        }

        case 'get_attribute': {
          const value = await page.locator(params.selector).first().getAttribute(params.attribute, { timeout: 5000 });
          return { success: true, data: value ?? '(属性不存在或值为 null)' };
        }

        case 'press_key': {
          if (params.selector) {
            await page.locator(params.selector).first().press(params.key, { timeout: 5000 });
          } else {
            await page.keyboard.press(params.key);
          }
          return actionResult(`已按键: ${params.key}`, await capturePageSnapshot(page));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const selector = 'selector' in params && typeof params.selector === 'string' ? params.selector : undefined;
      return {
        success: false,
        data: { llm_recovery: { code: 'BROWSER_ACTION_FAILED', retryable: true, action: params.action, selector, page: await capturePageSnapshot(page, selector) } },
        error: `browser_action(${params.action}) 失败: ${msg}`,
      };
    }
  }
}

export default BrowserActionTool;
