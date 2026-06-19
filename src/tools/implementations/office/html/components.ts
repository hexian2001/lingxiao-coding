/**
 * 凌霄 HTML 办公组件库 —— 幻灯片布局 + 文档块。
 *
 * 每个组件是 (data) => html 的纯函数，只消费主题 token（var(--lx-*)），
 * 不硬编码颜色/字体。组件组合即成完整幻灯片/文档。
 *
 * 设计：幻灯片布局面向 16:9 演示（cover/section/bullets/two-column/quote/
 * big-number/matrix/timeline/evidence/closing）；文档块面向 A4 长文档
 * （heading/paragraph/callout/table/figure/page-break/toc）。
 *
 * 安全：所有外部文本经 xmlEscape 转义，杜绝注入。
 */

function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(value: unknown): string {
  return esc(value);
}

function bulletsHtml(items: readonly unknown[]): string {
  return items
    .map((item) => `<li>${esc(item)}</li>`)
    .join('');
}

// ─── 幻灯片布局（16:9）──────────────────────────────────────────────

export interface SlideCoverData {
  kind: 'cover';
  title: string;
  subtitle?: string;
  presenter?: string;
  date?: string;
}
export interface SlideSectionData {
  kind: 'section';
  index?: string;
  title: string;
  subtitle?: string;
}
export interface SlideBulletsData {
  kind: 'bullets';
  title: string;
  items: readonly string[];
  /** 副标题/章节锚。 */
  kicker?: string;
}
export interface SlideTwoColumnData {
  kind: 'two_column';
  title: string;
  leftTitle?: string;
  leftItems: readonly string[];
  rightTitle?: string;
  rightItems: readonly string[];
}
export interface SlideQuoteData {
  kind: 'quote';
  quote: string;
  attribution?: string;
}
export interface SlideBigNumberData {
  kind: 'big_number';
  value: string;
  label: string;
  caption?: string;
}
export interface SlideMatrixData {
  kind: 'matrix';
  title: string;
  columns: readonly string[];
  rows: readonly { label: string; cells: readonly string[] }[];
}
export interface SlideTimelineData {
  kind: 'timeline';
  title: string;
  steps: readonly { time: string; title: string; detail?: string }[];
}
export interface SlideEvidenceData {
  kind: 'evidence';
  title: string;
  finding: string;
  details: readonly string[];
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
}
export interface SlideClosingData {
  kind: 'closing';
  title: string;
  message?: string;
  contact?: string;
}

export type SlideData =
  | SlideCoverData
  | SlideSectionData
  | SlideBulletsData
  | SlideTwoColumnData
  | SlideQuoteData
  | SlideBigNumberData
  | SlideMatrixData
  | SlideTimelineData
  | SlideEvidenceData
  | SlideClosingData;

/** 把单个幻灯片数据渲染成 `.slide` 容器的 inner HTML（不含外层 .slide div）。 */
export function renderSlideInner(slide: SlideData): string {
  switch (slide.kind) {
    case 'cover':
      return [
        '<div class="lx-cover">',
        `  <div class="lx-seal-stamp">${esc(slide.subtitle ? '凌' : '凌霄')}</div>`,
        `  <h1 class="lx-cover-title">${esc(slide.title)}</h1>`,
        slide.subtitle ? `  <p class="lx-cover-sub">${esc(slide.subtitle)}</p>` : '',
        slide.presenter || slide.date
          ? `  <p class="lx-cover-meta">${esc(slide.presenter)}${slide.presenter && slide.date ? ' · ' : ''}${esc(slide.date)}</p>`
          : '',
        '</div>',
      ].join('\n');

    case 'section':
      return [
        '<div class="lx-section">',
        slide.index ? `  <div class="lx-section-index">${esc(slide.index)}</div>` : '',
        `  <h2 class="lx-section-title">${esc(slide.title)}</h2>`,
        slide.subtitle ? `  <p class="lx-section-sub">${esc(slide.subtitle)}</p>` : '',
        '</div>',
      ].join('\n');

    case 'bullets':
      return [
        '<div class="lx-content">',
        slide.kicker ? `  <div class="lx-kicker">${esc(slide.kicker)}</div>` : '',
        `  <h2 class="lx-slide-title">${esc(slide.title)}</h2>`,
        `  <ul class="lx-bullets">${bulletsHtml(slide.items)}</ul>`,
        '</div>',
      ].join('\n');

    case 'two_column':
      return [
        '<div class="lx-content">',
        `  <h2 class="lx-slide-title">${esc(slide.title)}</h2>`,
        '  <div class="lx-two-col">',
        `    <div class="lx-col"><h3>${esc(slide.leftTitle || '')}</h3><ul>${bulletsHtml(slide.leftItems)}</ul></div>`,
        `    <div class="lx-col"><h3>${esc(slide.rightTitle || '')}</h3><ul>${bulletsHtml(slide.rightItems)}</ul></div>`,
        '  </div>',
        '</div>',
      ].join('\n');

    case 'quote':
      return [
        '<div class="lx-quote">',
        `  <blockquote>${esc(slide.quote)}</blockquote>`,
        slide.attribution ? `  <p class="lx-attribution">— ${esc(slide.attribution)}</p>` : '',
        '</div>',
      ].join('\n');

    case 'big_number':
      return [
        '<div class="lx-bignumber">',
        `  <div class="lx-bignumber-value">${esc(slide.value)}</div>`,
        `  <div class="lx-bignumber-label">${esc(slide.label)}</div>`,
        slide.caption ? `  <p class="lx-bignumber-caption">${esc(slide.caption)}</p>` : '',
        '</div>',
      ].join('\n');

    case 'matrix': {
      const head = slide.columns.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = slide.rows
        .map(
          (row) =>
            `<tr><th class="lx-row-label">${esc(row.label)}</th>${row.cells
              .map((c) => `<td>${esc(c)}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      return [
        '<div class="lx-content">',
        `  <h2 class="lx-slide-title">${esc(slide.title)}</h2>`,
        `  <table class="lx-matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`,
        '</div>',
      ].join('\n');
    }

    case 'timeline':
      return [
        '<div class="lx-content">',
        `  <h2 class="lx-slide-title">${esc(slide.title)}</h2>`,
        '  <ol class="lx-timeline">',
        slide.steps
          .map(
            (s) =>
              `<li><span class="lx-tl-time">${esc(s.time)}</span><div class="lx-tl-body"><strong>${esc(s.title)}</strong>${s.detail ? `<span>${esc(s.detail)}</span>` : ''}</div></li>`,
          )
          .join(''),
        '  </ol>',
        '</div>',
      ].join('\n');

    case 'evidence': {
      const sev = slide.severity || 'info';
      return [
        `<div class="lx-evidence lx-sev-${escAttr(sev)}">`,
        `  <div class="lx-evidence-tag">${esc(sev.toUpperCase())}</div>`,
        `  <h2 class="lx-slide-title">${esc(slide.title)}</h2>`,
        `  <p class="lx-evidence-finding">${esc(slide.finding)}</p>`,
        slide.details.length ? `  <ul class="lx-bullets">${bulletsHtml(slide.details)}</ul>` : '',
        '</div>',
      ].join('\n');
    }

    case 'closing':
      return [
        '<div class="lx-closing">',
        `  <h2>${esc(slide.title)}</h2>`,
        slide.message ? `  <p>${esc(slide.message)}</p>` : '',
        slide.contact ? `  <p class="lx-contact">${esc(slide.contact)}</p>` : '',
        '</div>',
      ].join('\n');

    default:
      return '';
  }
}

/** 把幻灯片数据包进 `.slide` 容器（含可选 notes 与 layout class）。 */
export function renderSlide(slide: SlideData, notes?: string): string {
  const inner = renderSlideInner(slide);
  const notesHtml = notes
    ? `<aside class="lx-notes" data-notes>${esc(notes)}</aside>`
    : '';
  return `<section class="lx-slide lx-layout-${escAttr(slide.kind)}" data-layout="${escAttr(slide.kind)}">\n${inner}\n${notesHtml}\n</section>`;
}

// ─── 文档块（A4 长文档）─────────────────────────────────────────────

export interface DocHeadingData {
  kind: 'heading';
  level: 1 | 2 | 3;
  text: string;
  /** 可选锚点 id（供 TOC 跳转）。 */
  id?: string;
}
export interface DocParagraphData {
  kind: 'paragraph';
  text: string;
}
export interface DocCalloutData {
  kind: 'callout';
  variant: 'note' | 'warn' | 'tip' | 'seal';
  title?: string;
  text: string;
}
export interface DocTableData {
  kind: 'table';
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  /** 表格标题。 */
  caption?: string;
}
export interface DocFigureData {
  kind: 'figure';
  /** 图片路径或 data URI。 */
  src: string;
  caption?: string;
}
export interface DocListData {
  kind: 'list';
  ordered?: boolean;
  items: readonly string[];
}
export interface DocPageBreakData {
  kind: 'page_break';
}
export interface DocTocData {
  kind: 'toc';
  title?: string;
}

export type DocBlockData =
  | DocHeadingData
  | DocParagraphData
  | DocCalloutData
  | DocTableData
  | DocFigureData
  | DocListData
  | DocPageBreakData
  | DocTocData;

export function renderDocBlock(block: DocBlockData): string {
  switch (block.kind) {
    case 'heading': {
      const tag = `h${block.level}`;
      const idAttr = block.id ? ` id="${escAttr(block.id)}"` : '';
      return `<${tag}${idAttr}>${esc(block.text)}</${tag}>`;
    }
    case 'paragraph':
      return `<p>${esc(block.text)}</p>`;
    case 'callout':
      return [
        `<aside class="lx-callout lx-callout-${escAttr(block.variant)}">`,
        block.title ? `  <p class="lx-callout-title">${esc(block.title)}</p>` : '',
        `  <p>${esc(block.text)}</p>`,
        '</aside>',
      ].join('\n');
    case 'table': {
      const head = block.columns.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = block.rows
        .map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('');
      const cap = block.caption ? `<caption>${esc(block.caption)}</caption>` : '';
      return `<table class="lx-doc-table">${cap}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case 'figure': {
      const cap = block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : '';
      return `<figure class="lx-figure"><img src="${escAttr(block.src)}" alt="${escAttr(block.caption || '')}"/>${cap}</figure>`;
    }
    case 'list':
      return block.ordered
        ? `<ol>${bulletsHtml(block.items)}</ol>`
        : `<ul>${bulletsHtml(block.items)}</ul>`;
    case 'page_break':
      return '<div class="lx-page-break" aria-hidden="true"></div>';
    case 'toc':
      return `<nav class="lx-toc"><p class="lx-toc-title">${esc(block.title || '目录')}</p><ol></ol></nav>`;
    default:
      return '';
  }
}
