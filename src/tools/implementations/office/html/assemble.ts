/**
 * 凌霄 HTML 办公装配引擎。
 *
 * 把主题 + 组件 + 数据装配成一个 standalone HTML 单文件：
 *   - 内联 CSS（主题 token + 布局样式 + 打印分页规则）；
 *   - CJK 优先字体栈（靠系统/浏览器字体，不内嵌字体文件以保证文件轻盈；
 *     若需离线自包含，可后续经 fonts.ts 注入 base64 @font-face）。
 *
 * 两种渲染模式：
 *   - slides：16:9 视口，每个 .lx-slide 占满一页；打印时 page=size A4 横向 /
 *     一 slide 一页。这是 HTML→PDF/PPTX 高保真导出的基础。
 *   - document：A4/Letter 竖向，自然分页（CSS 打印断页 + .lx-page-break 强制断页）。
 *
 * 产物是单文件 .html，浏览器打开即所见；经 HtmlToPdf/Png/Pptx 导出原生格式。
 */

import { resolveHtmlOfficeTheme, renderThemeCssVars, type HtmlOfficeThemeId, type HtmlOfficeTheme } from './themes.js';
import { renderSlide, renderDocBlock, type SlideData, type DocBlockData } from './components.js';

export type HtmlOfficeMode = 'slides' | 'document';

export interface AssembleSlidesInput {
  mode: 'slides';
  theme?: HtmlOfficeThemeId;
  title: string;
  /** 幻灯片数据；每项一个 .lx-slide。 */
  slides: readonly SlideData[];
  /** 全局页脚（出现在每页右下）。 */
  footer?: string;
}
export interface AssembleDocumentInput {
  mode: 'document';
  theme?: HtmlOfficeThemeId;
  title: string;
  /** 文档元信息（封面/页眉用）。 */
  author?: string;
  /** A4 | Letter。 */
  pageSize?: 'A4' | 'Letter';
  blocks: readonly DocBlockData[];
  /** 页眉文本。 */
  header?: string;
}
export type AssembleInput = AssembleSlidesInput | AssembleDocumentInput;

export interface AssembledHtml {
  html: string;
  theme: HtmlOfficeTheme;
  mode: HtmlOfficeMode;
  /** 幻灯片张数 / 文档块数（用于导出器分页）。 */
  count: number;
}

/** 全局基础 + 布局 CSS（与主题无关的结构样式；颜色/字体走 var）。 */
function structuralCss(mode: HtmlOfficeMode, pageSize: 'A4' | 'Letter', footer?: string, header?: string): string {
  const slideCss = `
  html,body{margin:0;padding:0;background:var(--lx-bg);}
  body{font-family:var(--lx-font-body);color:var(--lx-ink);}
  .lx-deck{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px;}
  .lx-slide{
    position:relative;box-sizing:border-box;
    width:1280px;height:720px;overflow:hidden;
    background:var(--lx-surface);color:var(--lx-ink);
    padding:64px 80px;display:flex;flex-direction:column;justify-content:center;
    box-shadow:0 2px 18px rgba(0,0,0,.08);
  }
  .lx-slide h1,.lx-slide h2,.lx-slide h3{font-family:var(--lx-font-title);color:var(--lx-ink);margin:0 0 .5em;line-height:1.2;}
  .lx-slide h1{font-size:3.2rem;}.lx-slide h2{font-size:2.2rem;}.lx-slide h3{font-size:1.4rem;color:var(--lx-accent);}
  .lx-kicker{font-size:.95rem;letter-spacing:.18em;text-transform:uppercase;color:var(--lx-accent);margin-bottom:.6rem;}
  .lx-slide-title{margin-bottom:1rem;}
  .lx-bullets{font-size:1.5rem;line-height:1.9;list-style:none;padding:0;margin:0;}
  .lx-bullets li{position:relative;padding-left:1.6em;}
  .lx-bullets li::before{content:"";position:absolute;left:.3em;top:.62em;width:.5em;height:.5em;background:var(--lx-accent);transform:rotate(45deg);}
  .lx-two-col{display:grid;grid-template-columns:1fr 1fr;gap:48px;}
  .lx-two-col h3{margin-bottom:.5rem;}
  .lx-two-col ul{font-size:1.25rem;line-height:1.7;list-style:none;padding:0;}
  .lx-two-col ul li{padding:.2em 0;border-bottom:1px solid var(--lx-rule);}
  .lx-quote{display:flex;flex-direction:column;justify-content:center;height:100%;}
  .lx-quote blockquote{font-family:var(--lx-font-title);font-size:2.6rem;line-height:1.5;margin:0;border-left:6px solid var(--lx-seal);padding-left:1.2em;color:var(--lx-ink);}
  .lx-attribution{margin-top:1.5rem;font-size:1.3rem;color:var(--lx-ink-muted);}
  .lx-bignumber{display:flex;flex-direction:column;justify-content:center;height:100%;align-items:flex-start;}
  .lx-bignumber-value{font-family:var(--lx-font-title);font-size:7rem;line-height:1;color:var(--lx-accent);}
  .lx-bignumber-label{font-size:1.8rem;margin-top:.6rem;}
  .lx-bignumber-caption{color:var(--lx-ink-muted);margin-top:1rem;font-size:1.1rem;}
  .lx-matrix{width:100%;border-collapse:collapse;font-size:1.15rem;}
  .lx-matrix th,.lx-matrix td{border:1px solid var(--lx-rule);padding:.7em .9em;text-align:left;}
  .lx-matrix thead th{background:var(--lx-accent);color:var(--lx-bg);}
  .lx-matrix .lx-row-label{background:var(--lx-surface);font-family:var(--lx-font-title);}
  .lx-timeline{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:1rem;}
  .lx-timeline li{display:grid;grid-template-columns:160px 1fr;gap:24px;align-items:baseline;border-left:3px solid var(--lx-accent);padding-left:1rem;}
  .lx-tl-time{font-family:var(--lx-font-mono);color:var(--lx-accent);font-size:1.1rem;}
  .lx-tl-body strong{font-size:1.4rem;display:block;}
  .lx-tl-body span{color:var(--lx-ink-muted);}
  .lx-evidence{border-left:8px solid var(--lx-accent);padding-left:1.5rem;}
  .lx-evidence-tag{display:inline-block;font-family:var(--lx-font-mono);font-size:.9rem;padding:.2em .8em;border:1px solid var(--lx-accent);color:var(--lx-accent);margin-bottom:1rem;}
  .lx-sev-high,.lx-sev-critical{border-left-color:var(--lx-seal);}
  .lx-sev-high .lx-evidence-tag,.lx-sev-critical .lx-evidence-tag{border-color:var(--lx-seal);color:var(--lx-seal);}
  .lx-evidence-finding{font-size:1.5rem;line-height:1.6;}
  .lx-cover{display:flex;flex-direction:column;justify-content:center;height:100%;}
  .lx-cover-title{font-size:4rem !important;}
  .lx-cover-sub{font-size:1.6rem;color:var(--lx-ink-muted);margin-top:.6rem;}
  .lx-cover-meta{margin-top:2rem;color:var(--lx-ink-muted);font-family:var(--lx-font-mono);}
  .lx-seal-stamp{width:72px;height:72px;display:flex;align-items:center;justify-content:center;background:var(--lx-seal);color:#fff;font-family:var(--lx-font-title);font-size:2rem;margin-bottom:2rem;}
  .lx-section{display:flex;flex-direction:column;justify-content:center;height:100%;}
  .lx-section-index{font-family:var(--lx-font-mono);font-size:1.4rem;color:var(--lx-accent);margin-bottom:1rem;}
  .lx-section-title{font-size:3.4rem !important;}
  .lx-section-sub{font-size:1.4rem;color:var(--lx-ink-muted);}
  .lx-closing{display:flex;flex-direction:column;justify-content:center;height:100%;}
  .lx-closing h2{font-size:3rem;}
  .lx-contact{margin-top:2rem;font-family:var(--lx-font-mono);color:var(--lx-ink-muted);}
  .lx-notes{display:none;}
  .lx-slide-footer{position:absolute;right:48px;bottom:28px;font-family:var(--lx-font-mono);font-size:.85rem;color:var(--lx-ink-muted);}
`;

  const docCss = `
  html,body{margin:0;padding:0;background:var(--lx-bg);}
  body{font-family:var(--lx-font-body);color:var(--lx-ink);font-size:11pt;line-height:1.75;}
  .lx-doc{max-width:760px;margin:0 auto;padding:72px 64px;background:var(--lx-bg);}
  .lx-doc h1,.lx-doc h2,.lx-doc h3{font-family:var(--lx-font-title);color:var(--lx-ink);line-height:1.3;}
  .lx-doc h1{font-size:1.9rem;border-bottom:2px solid var(--lx-accent);padding-bottom:.3em;margin-top:2em;}
  .lx-doc h2{font-size:1.5rem;color:var(--lx-accent);margin-top:1.6em;}
  .lx-doc h3{font-size:1.2rem;margin-top:1.3em;}
  .lx-doc p{margin:.6em 0;}
  .lx-doc ul,.lx-doc ol{padding-left:1.6em;}
  .lx-callout{border-left:4px solid var(--lx-accent);background:var(--lx-surface);padding:.8em 1.1em;margin:1em 0;border-radius:0 4px 4px 0;}
  .lx-callout-title{font-family:var(--lx-font-title);color:var(--lx-accent);margin:0 0 .3em;font-weight:600;}
  .lx-callout-warn{border-left-color:var(--lx-seal);} .lx-callout-warn .lx-callout-title{color:var(--lx-seal);}
  .lx-callout-seal{border-left-color:var(--lx-gold);} .lx-callout-seal .lx-callout-title{color:var(--lx-gold);}
  .lx-doc-table{width:100%;border-collapse:collapse;margin:1em 0;font-size:10pt;}
  .lx-doc-table th,.lx-doc-table td{border:1px solid var(--lx-rule);padding:.5em .7em;text-align:left;}
  .lx-doc-table thead th{background:var(--lx-surface);font-family:var(--lx-font-title);}
  .lx-figure{margin:1.2em 0;text-align:center;}
  .lx-figure img{max-width:100%;height:auto;}
  .lx-figure figcaption{font-size:.9rem;color:var(--lx-ink-muted);margin-top:.4em;}
  .lx-page-break{break-after:page;page-break-after:always;height:0;}
  .lx-toc{background:var(--lx-surface);padding:1em 1.4em;border-radius:6px;margin:1em 0;}
  .lx-toc-title{font-family:var(--lx-font-title);color:var(--lx-accent);margin:0 0 .5em;}
`;

  const printCss = mode === 'slides'
    ? `
  @media print{
    @page{size:1280px 720px;margin:0;}
    .lx-deck{padding:0;gap:0;}
    .lx-slide{box-shadow:none;page-break-after:always;break-after:page;page-break-inside:avoid;break-inside:avoid;}
    .lx-slide-footer{${footer ? '' : 'display:none;'}}
    .lx-notes{display:none !important;}
  }`
    : `
  @media print{
    @page{size:${pageSize};margin:18mm 16mm;}
    body{background:#fff;}
    .lx-doc{max-width:none;padding:0;}
    h1,h2,h3{page-break-after:avoid;break-after:avoid;}
    table,figure,.lx-callout{page-break-inside:avoid;break-inside:avoid;}
    .lx-page-break{break-after:page;page-break-after:always;}
  }`;

  const screenOnly = `
  @media screen{
    .lx-slide-footer{${footer ? '' : 'display:none;'}}
  }`;

  return mode === 'slides' ? slideCss + printCss : docCss + printCss + screenOnly;
}

export function assembleHtml(input: AssembleInput): AssembledHtml {
  const theme = resolveHtmlOfficeTheme(input.theme);
  const themeVars = renderThemeCssVars(theme);
  const pageSize = input.mode === 'document' ? (input.pageSize || 'A4') : 'A4';
  const structural = structuralCss(
    input.mode,
    pageSize,
    input.mode === 'slides' ? input.footer : undefined,
    input.mode === 'document' ? input.header : undefined,
  );

  const body =
    input.mode === 'slides'
      ? renderSlidesBody(input)
      : renderDocumentBody(input);

  const html = [
    '<!DOCTYPE html>',
    `<html lang="zh-CN"><head><meta charset="utf-8"/>`,
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>`,
    `<title>${escTitle(input.title)}</title>`,
    `<meta name="generator" content="Lingxiao HtmlOffice"/>`,
    `<style>`,
    `:root{${themeVars}}`,
    structural,
    `</style>`,
    `</head><body>`,
    body,
    `</body></html>`,
  ].join('\n');

  return {
    html,
    theme,
    mode: input.mode,
    count: input.mode === 'slides' ? input.slides.length : input.blocks.length,
  };
}

function renderSlidesBody(input: AssembleSlidesInput): string {
  const slides = input.slides.map((s) => renderSlide(s)).join('\n');
  const footerLine = input.footer
    ? `<div class="lx-slide-footer">${escTitle(input.footer)}</div>`
    : '';
  // 页脚在每页底部：用 running element 近似——简单起见注入一个固定脚注（打印时每页重复靠 @page running，此处用 CSS position fixed 近似）。
  return `<main class="lx-deck">\n${slides}\n</main>${footerLine}`;
}

function renderDocumentBody(input: AssembleDocumentInput): string {
  const header = input.header ? `<p class="lx-doc-header">${escTitle(input.header)}</p>` : '';
  const blocks = input.blocks.map((b) => renderDocBlock(b)).join('\n');
  return `<main class="lx-doc">\n<h1 class="lx-doc-title">${escTitle(input.title)}</h1>\n${input.author ? `<p class="lx-doc-author">${escTitle(input.author)}</p>` : ''}\n${header}\n${blocks}\n</main>`;
}

function escTitle(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
