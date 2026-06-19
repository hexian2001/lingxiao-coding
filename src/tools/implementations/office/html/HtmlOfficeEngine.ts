/**
 * HtmlOfficeEngine —— 凌霄 HTML 办公底座编排器。
 *
 * 单一入口：spec {mode, theme, slides|blocks, exports[]} → 装配 HTML →
 * 按需导出到 PDF / PNG / DOCX / XLSX / PPTX（任意子集）。
 *
 * 这是"单一 HTML 底座 → 各原生格式"的总线：HTML 是唯一渲染源，
 * PDF/PPTX 走 Chromium 高保真，DOCX/XLSX 走结构化可编辑映射。
 */

import { assembleHtml, type AssembleInput, type AssembledHtml } from './assemble.js';
import { exportHtmlToPdf, exportHtmlToPng } from './exporters/HtmlToPdf.js';
import { exportHtmlToDocx } from './exporters/HtmlToDocx.js';
import { exportHtmlToXlsx } from './exporters/HtmlToXlsx.js';
import { exportHtmlToPptx } from './exporters/HtmlToPptx.js';
import type { SlideData, DocBlockData } from './components.js';

export type HtmlExportTarget = 'html' | 'pdf' | 'png' | 'docx' | 'xlsx' | 'pptx';

export interface HtmlOfficeSpecBase {
  theme?: string;
  title: string;
}
export interface HtmlOfficeSlidesSpec extends HtmlOfficeSpecBase {
  mode: 'slides';
  footer?: string;
  slides: readonly SlideData[];
}
export interface HtmlOfficeDocumentSpec extends HtmlOfficeSpecBase {
  mode: 'document';
  author?: string;
  pageSize?: 'A4' | 'Letter';
  header?: string;
  blocks: readonly DocBlockData[];
}
export type HtmlOfficeSpec = HtmlOfficeSlidesSpec | HtmlOfficeDocumentSpec;

export interface ExportArtifact {
  target: HtmlExportTarget;
  path: string;
  bytes: number;
  /** 额外信息（sheetCount/slideCount 等）。 */
  detail?: Record<string, unknown>;
}

export interface HtmlOfficeResult {
  success: boolean;
  htmlPath?: string;
  assembled: AssembledHtml;
  artifacts: ExportArtifact[];
  errors: string[];
}

export interface HtmlOfficeOptions {
  /** HTML 主产物输出路径。 */
  htmlPath: string;
  /** 要求导出的目标集合；'html' 始终产出。 */
  targets: readonly HtmlExportTarget[];
  /** 导出超时（毫秒）。 */
  timeoutMs?: number;
}

function ext(target: HtmlExportTarget): string {
  switch (target) {
    case 'pdf': return '.pdf';
    case 'png': return '';
    case 'docx': return '.docx';
    case 'xlsx': return '.xlsx';
    case 'pptx': return '.pptx';
    default: return '.html';
  }
}

export async function runHtmlOffice(
  spec: HtmlOfficeSpec,
  options: HtmlOfficeOptions,
): Promise<HtmlOfficeResult> {
  const errors: string[] = [];
  const artifacts: ExportArtifact[] = [];

  const assembled = assembleHtml(spec as AssembleInput);

  // 始终写 HTML 主产物。
  const { writeFile, mkdir } = await import('fs/promises');
  const { dirname } = await import('path');
  await mkdir(dirname(options.htmlPath), { recursive: true });
  await writeFile(options.htmlPath, assembled.html, 'utf-8');
  const htmlBytes = Buffer.byteLength(assembled.html);
  artifacts.push({ target: 'html', path: options.htmlPath, bytes: htmlBytes });

  const base = options.htmlPath.replace(/\.[^.]+$/, '');

  for (const target of options.targets) {
    if (target === 'html') continue;
    try {
      if (target === 'pdf') {
        const r = await exportHtmlToPdf(assembled, { outputPath: `${base}${ext('pdf')}`, timeoutMs: options.timeoutMs });
        if (r.success) artifacts.push({ target: 'pdf', path: r.outputPaths[0], bytes: r.bytes });
        else errors.push(r.error || 'pdf export failed');
      } else if (target === 'png') {
        const pngPath = assembled.mode === 'slides' ? `${base}-png` : `${base}.png`;
        const r = await exportHtmlToPng(assembled, { outputPath: pngPath, timeoutMs: options.timeoutMs });
        if (r.success) artifacts.push({ target: 'png', path: r.outputPaths.join(', '), bytes: r.bytes, detail: { count: r.outputPaths.length } });
        else errors.push(r.error || 'png export failed');
      } else if (target === 'docx') {
        const r = await exportHtmlToDocx(assembled, `${base}.docx`);
        if (r.success && r.outputPath) artifacts.push({ target: 'docx', path: r.outputPath, bytes: r.bytes });
        else errors.push(r.error || 'docx export failed');
      } else if (target === 'xlsx') {
        const r = await exportHtmlToXlsx(assembled, `${base}.xlsx`);
        if (r.success && r.outputPath) artifacts.push({ target: 'xlsx', path: r.outputPath, bytes: r.bytes, detail: { sheetCount: r.sheetCount } });
        else errors.push(r.error || 'xlsx export failed');
      } else if (target === 'pptx') {
        const r = await exportHtmlToPptx(assembled, { outputPath: `${base}.pptx`, timeoutMs: options.timeoutMs });
        if (r.success && r.outputPath) artifacts.push({ target: 'pptx', path: r.outputPath, bytes: r.bytes, detail: { slideCount: r.slideCount } });
        else errors.push(r.error || 'pptx export failed');
      }
    } catch (error) {
      errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    success: errors.length === 0,
    htmlPath: options.htmlPath,
    assembled,
    artifacts,
    errors,
  };
}
