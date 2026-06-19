/**
 * HTML → PDF / PNG 高保真导出器（headless Chromium）。
 *
 * 这是凌霄 HTML 办公底座「单一 HTML → 各原生格式」的核心枢纽：
 *   - PDF：Chromium `page.pdf()`，按打印 CSS 分页，CJK/CSS/背景色全部保真。
 *     这是世界级的 HTML→PDF 路径（与 Slidev/Marp/Reveal.js 同源）。
 *   - PNG：逐 `.lx-slide`（slides 模式）或逐打印页（document 模式）截图，
 *     供 HtmlToPptx 全幅拼装可编辑性较低的"图片幻灯片"。
 *
 * 浏览器生命周期：使用 launchManagedChromium 独立 launch 一个短命 context，
 * 用完即关，不与 BrowserManager 共享实例竞争（办公导出是批处理，独占更稳）。
 * 失败（无浏览器/超时）返回结构化错误，绝不让上层静默吞。
 */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import type { AssembledHtml } from '../assemble.js';

export interface HtmlExportOptions {
  /** 输出目录（PNG 序列）或文件路径（PDF）。 */
  outputPath: string;
  /** 单页渲染超时（毫秒），默认 30000。 */
  timeoutMs?: number;
  /** deviceScaleFactor（PNG 清晰度），默认 2。 */
  scale?: number;
}

export interface HtmlExportResult {
  success: boolean;
  /** PDF 模式：单个文件路径；PNG 模式：文件路径数组。 */
  outputPaths: string[];
  /** 字节总数（诊断用）。 */
  bytes: number;
  error?: string;
}

async function renderInChromium<T>(
  html: string,
  fn: (page: import('playwright').Page) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    // 用 data URL 加载，保证单文件 HTML 内联一切、无外部依赖。
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
      waitUntil: 'networkidle',
    });
    // 等字体/布局就绪。
    await page.evaluate(() => document.fonts && document.fonts.ready);
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** HTML → PDF：单文件，按打印 CSS 分页（slides 模式一 slide 一页）。 */
export async function exportHtmlToPdf(
  assembled: AssembledHtml,
  options: HtmlExportOptions,
): Promise<HtmlExportResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    const pdfBuffer = await renderInChromium(
      assembled.html,
      async (page) => {
        return page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
        });
      },
      timeoutMs,
    );
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, pdfBuffer);
    return {
      success: true,
      outputPaths: [options.outputPath],
      bytes: pdfBuffer.length,
    };
  } catch (error) {
    return {
      success: false,
      outputPaths: [],
      bytes: 0,
      error: `HTML→PDF failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * HTML → PNG 序列：slides 模式逐 `.lx-slide` 截图；document 模式逐打印页截图
 * （Chromium 无法直接逐打印页截，document 模式回退为整页长截图）。
 */
export async function exportHtmlToPng(
  assembled: AssembledHtml,
  options: HtmlExportOptions,
): Promise<HtmlExportResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    if (assembled.mode === 'slides') {
      const buffers = await renderInChromium(
        assembled.html,
        async (page) => {
          const count = await page.locator('.lx-slide').count();
          const out: Buffer[] = [];
          for (let i = 0; i < count; i++) {
            const handle = page.locator('.lx-slide').nth(i);
            const buf = await handle.screenshot({ type: 'png', omitBackground: false });
            out.push(buf as unknown as Buffer);
          }
          return out;
        },
        timeoutMs,
      );
      await mkdir(options.outputPath, { recursive: true });
      const paths: string[] = [];
      let bytes = 0;
      buffers.forEach((buf, i) => {
        const padded = String(i + 1).padStart(3, '0');
        const p = join(options.outputPath, `slide-${padded}.png`);
        void writeFile(p, buf);
        paths.push(p);
        bytes += buf.length;
      });
      await Promise.all(paths.map((p, i) => writeFile(p, buffers[i])));
      return { success: true, outputPaths: paths, bytes };
    }
    // document 模式：整页长截图（Chromium 无原生逐打印页截图）。
    const buffer = await renderInChromium(
      assembled.html,
      async (page) => {
        return page.screenshot({ type: 'png', fullPage: true, omitBackground: false });
      },
      timeoutMs,
    );
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, buffer as unknown as Buffer);
    return {
      success: true,
      outputPaths: [options.outputPath],
      bytes: (buffer as unknown as Buffer).length,
    };
  } catch (error) {
    return {
      success: false,
      outputPaths: [],
      bytes: 0,
      error: `HTML→PNG failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
