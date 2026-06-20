/**
 * lingxiao-browser — MCP Server (Node.js stdio)
 *
 * Native MCP Server exposing LingXiao browser automation capabilities.
 * Tools: browser_action, visual_verify, screenshot, navigate, click, fill,
 *        get_text, scroll, press_key
 *
 * Uses BrowserManager.ensureBrowser() to get a Playwright Page instance,
 * then calls Playwright Page API directly for DOM interactions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readDepsFromEnv, jsonResult, errorResult, textResult } from './shared.js';
import { VERSION } from '../version.js';

const { workspace } = readDepsFromEnv();

const server = new McpServer({
  name: 'lingxiao-browser',
  version: VERSION,
});

// Lazy-load BrowserManager to avoid playwright import overhead at startup
let browserManagerInstance: any = null;
async function getBrowserManager() {
  if (!browserManagerInstance) {
    const { BrowserManager } = await import('../tools/implementations/BrowserManager.js');
    browserManagerInstance = new BrowserManager();
  }
  return browserManagerInstance;
}

// Helper: parse viewport string "1024x768" → { width, height }
function parseViewport(vp?: string): { width: number; height: number } {
  if (!vp) return { width: 1280, height: 720 };
  const m = vp.match(/^(\d+)x(\d+)$/);
  return m ? { width: parseInt(m[1]), height: parseInt(m[2]) } : { width: 1280, height: 720 };
}

// Helper: get page from BrowserManager
async function getPage() {
  const bm = await getBrowserManager();
  return await bm.ensureBrowser();
}

// ── Tool: browser_action ──────────────────────────────────────────────────
server.tool(
  'browser_action',
  'Perform a browser action (navigate, click, fill, scroll, screenshot, etc.)',
  {
    action: z.enum(['navigate', 'click', 'fill', 'select', 'wait_for', 'get_text', 'get_html', 'eval_js', 'scroll', 'current_url', 'get_attribute', 'press_key']).describe('Action type'),
    url: z.string().optional().describe('URL to navigate to (for navigate action)'),
    selector: z.string().optional().describe('CSS selector for click/fill/get_text etc.'),
    value: z.string().optional().describe('Value to fill or key to press'),
    timeout: z.number().int().min(1000).max(60000).optional().describe('Timeout in ms (default: 10000)'),
    viewport: z.string().optional().describe('Viewport size, e.g. "1280x720"'),
    screenshot_path: z.string().optional().describe('Path to save screenshot'),
  },
  async (params) => {
    try {
      const page = await getPage();
      const action = params.action;
      const timeout = params.timeout || 10000;

      if (action === 'navigate') {
        await page.goto(params.url!, { waitUntil: 'domcontentloaded', timeout });
        return jsonResult({ action: 'navigate', url: params.url, success: true });
      }
      if (action === 'click') {
        await page.click(params.selector!, { timeout });
        return jsonResult({ action: 'click', selector: params.selector, success: true });
      }
      if (action === 'fill') {
        await page.fill(params.selector!, params.value!, { timeout });
        return jsonResult({ action: 'fill', selector: params.selector, value: params.value, success: true });
      }
      if (action === 'select') {
        await page.selectOption(params.selector!, params.value!, { timeout });
        return jsonResult({ action: 'select', selector: params.selector, value: params.value, success: true });
      }
      if (action === 'wait_for') {
        await page.waitForSelector(params.selector!, { timeout });
        return jsonResult({ action: 'wait_for', selector: params.selector, success: true });
      }
      if (action === 'get_text') {
        const text = await page.textContent(params.selector!, { timeout });
        return textResult(text || '');
      }
      if (action === 'get_html') {
        const html = await page.innerHTML(params.selector!, { timeout });
        return textResult(html);
      }
      if (action === 'eval_js') {
        const result = await page.evaluate(params.value!);
        return jsonResult({ action: 'eval_js', result });
      }
      if (action === 'scroll') {
        const dir = params.value || 'down';
        if (dir === 'down') await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        else if (dir === 'up') await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
        else if (dir === 'right') await page.evaluate(() => window.scrollBy(window.innerWidth, 0));
        else if (dir === 'left') await page.evaluate(() => window.scrollBy(-window.innerWidth, 0));
        return jsonResult({ action: 'scroll', direction: dir, success: true });
      }
      if (action === 'current_url') {
        return textResult(page.url());
      }
      if (action === 'get_attribute') {
        const attr = await page.getAttribute(params.selector!, params.value!, { timeout });
        return jsonResult({ action: 'get_attribute', selector: params.selector, attribute: params.value, value: attr });
      }
      if (action === 'press_key') {
        await page.keyboard.press(params.value!);
        return jsonResult({ action: 'press_key', key: params.value, success: true });
      }
      return errorResult(`Unknown action: ${action}`);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: visual_verify ───────────────────────────────────────────────────
server.tool(
  'visual_verify',
  'Visually verify a page against assertions and optionally save a screenshot',
  {
    url: z.string().describe('URL to verify'),
    viewport: z.string().optional().describe('Viewport size, e.g. "1280x720"'),
    assertions: z.array(z.string()).optional().describe('Visual assertions (text expected on page)'),
    screenshot_path: z.string().optional().describe('Path to save screenshot'),
  },
  async ({ url, viewport, assertions, screenshot_path }) => {
    try {
      const page = await getPage();
      const vp = parseViewport(viewport);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

      const results: Array<{ assertion: string; passed: boolean; detail?: string }> = [];
      if (assertions && assertions.length > 0) {
        const bodyText = await page.textContent('body') || '';
        for (const assertion of assertions) {
          const passed = bodyText.includes(assertion);
          results.push({ assertion, passed, detail: passed ? undefined : `Text not found: "${assertion}"` });
        }
      }

      let screenshotSaved: string | undefined;
      if (screenshot_path) {
        const absPath = screenshot_path.startsWith('/') ? screenshot_path : `${workspace}/${screenshot_path}`;
        await page.screenshot({ path: absPath, fullPage: false });
        screenshotSaved = absPath;
      }

      const allPassed = results.length === 0 || results.every(r => r.passed);
      return jsonResult({ url, viewport: vp, assertions: results, allPassed, screenshotPath: screenshotSaved });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: screenshot ──────────────────────────────────────────────────────
server.tool(
  'screenshot',
  'Take a screenshot of a URL',
  {
    url: z.string().describe('URL to screenshot'),
    viewport: z.string().optional().describe('Viewport size, e.g. "1280x720"'),
    screenshot_path: z.string().describe('Path to save screenshot'),
  },
  async ({ url, viewport, screenshot_path }) => {
    try {
      const page = await getPage();
      const vp = parseViewport(viewport);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const absPath = screenshot_path.startsWith('/') ? screenshot_path : `${workspace}/${screenshot_path}`;
      await page.screenshot({ path: absPath, fullPage: false });
      return jsonResult({ url, viewport: vp, screenshotPath: absPath, success: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: navigate ────────────────────────────────────────────────────────
server.tool(
  'navigate',
  'Navigate to a URL and return page status',
  {
    url: z.string().describe('URL to navigate to'),
    viewport: z.string().optional().describe('Viewport size, e.g. "1280x720"'),
  },
  async ({ url, viewport }) => {
    try {
      const page = await getPage();
      const vp = parseViewport(viewport);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return jsonResult({ url, finalUrl: page.url(), viewport: vp, success: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: click ───────────────────────────────────────────────────────────
server.tool(
  'click',
  'Click an element by CSS selector',
  {
    selector: z.string().describe('CSS selector'),
    timeout: z.number().int().min(1000).max(60000).optional().describe('Timeout in ms (default: 10000)'),
  },
  async ({ selector, timeout }) => {
    try {
      const page = await getPage();
      await page.click(selector, { timeout: timeout || 10000 });
      return jsonResult({ action: 'click', selector, success: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: fill ────────────────────────────────────────────────────────────
server.tool(
  'fill',
  'Fill an input field by CSS selector',
  {
    selector: z.string().describe('CSS selector'),
    value: z.string().describe('Value to fill'),
    timeout: z.number().int().min(1000).max(60000).optional().describe('Timeout in ms (default: 10000)'),
  },
  async ({ selector, value, timeout }) => {
    try {
      const page = await getPage();
      await page.fill(selector, value, { timeout: timeout || 10000 });
      return jsonResult({ action: 'fill', selector, value, success: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: get_text ────────────────────────────────────────────────────────
server.tool(
  'get_text',
  'Get text content of an element by CSS selector',
  {
    selector: z.string().describe('CSS selector'),
    timeout: z.number().int().min(1000).max(60000).optional().describe('Timeout in ms (default: 10000)'),
  },
  async ({ selector, timeout }) => {
    try {
      const page = await getPage();
      const text = await page.textContent(selector, { timeout: timeout || 10000 });
      return textResult(text || '');
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: scroll ──────────────────────────────────────────────────────────
server.tool(
  'scroll',
  'Scroll the page in a direction',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
  },
  async ({ direction }) => {
    try {
      const page = await getPage();
      if (direction === 'down') await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      else if (direction === 'up') await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
      else if (direction === 'right') await page.evaluate(() => window.scrollBy(window.innerWidth, 0));
      else if (direction === 'left') await page.evaluate(() => window.scrollBy(-window.innerWidth, 0));
      return jsonResult({ action: 'scroll', direction, success: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: press_key ───────────────────────────────────────────────────────
server.tool(
  'press_key',
  'Press a keyboard key',
  {
    key: z.string().describe('Key to press (e.g. "Enter", "Escape", "Tab")'),
  },
  async ({ key }) => {
    try {
      const page = await getPage();
      await page.keyboard.press(key);
      return jsonResult({ action: 'press_key', key, success: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
