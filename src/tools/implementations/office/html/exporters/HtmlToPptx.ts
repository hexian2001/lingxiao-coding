/**
 * HTML → PPTX 导出器。
 *
 * 诚实的设计：任意 HTML/CSS 无法无损转成"可编辑 PPTX 原生形状"——这在全球都是
 * 难题（Slidev/Marp 的 PPTX 导出也是图片拼装）。本导出器走 **per-slide PNG 全幅**
 * 路径：每张 .lx-slide 经 Chromium 渲染成 16:9 高清 PNG，再以全幅背景图贴进 pptxgenjs
 * 的 slide，同时把 .lx-notes（演讲者备注）写成原生 notes。
 *
 * 产物：PowerPoint/WPS/Keynote 可打开、视觉 1:1 保真、含演讲者备注的 .pptx。
 * 文字不可在 PPT 内直接编辑（图片形态）——这是 HTML→PPTX 的世界级诚实上限；
 * 若需可编辑 PPTX，请走 generate_pptx（pptxgenjs 原生形状路径）。
 *
 * 与 HtmlToPng 协作：先逐 slide 截图，再拼装。
 */

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { chromium } from 'playwright';
import type { AssembledHtml } from '../assemble.js';

export interface HtmlToPptxResult {
  success: boolean;
  outputPath?: string;
  slideCount: number;
  bytes: number;
  error?: string;
}

export interface HtmlToPptxOptions {
  outputPath: string;
  timeoutMs?: number;
}

/** 逐 slide 渲染成 PNG buffer（16:9, 2x）。 */
async function renderSlidePngs(html: string, timeoutMs: number): Promise<{ png: Buffer; notes: string }[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const count = await page.locator('.lx-slide').count();
    const out: { png: Buffer; notes: string }[] = [];
    for (let i = 0; i < count; i++) {
      const handle = page.locator('.lx-slide').nth(i);
      const png = (await handle.screenshot({ type: 'png' })) as unknown as Buffer;
      let notes = '';
      try {
        notes = await handle.locator('[data-notes]').first().innerText({ timeout: 500 });
      } catch {
        notes = '';
      }
      out.push({ png, notes: notes.trim() });
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function exportHtmlToPptx(
  assembled: AssembledHtml,
  options: HtmlToPptxOptions,
): Promise<HtmlToPptxResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    if (assembled.mode !== 'slides') {
      return { success: false, slideCount: 0, bytes: 0, error: 'HTML→PPTX 仅支持 slides 模式' };
    }
    const slides = await renderSlidePngs(assembled.html, timeoutMs);
    if (!slides.length) {
      return { success: false, slideCount: 0, bytes: 0, error: 'HTML→PPTX failed: 未找到 .lx-slide' };
    }

    const PptxGenJS = (await import('pptxgenjs')).default;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'LX_16x9', width: 13.333, height: 7.5 });
    pptx.layout = 'LX_16x9';

    for (const slide of slides) {
      const s = pptx.addSlide();
      s.addImage({ data: `image/png;base64,${slide.png.toString('base64')}`, x: 0, y: 0, w: 13.333, h: 7.5 });
      if (slide.notes) s.addNotes(slide.notes);
    }

    const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, buffer);
    return { success: true, outputPath: options.outputPath, slideCount: slides.length, bytes: buffer.length };
  } catch (error) {
    return { success: false, slideCount: 0, bytes: 0, error: `HTML→PPTX failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
