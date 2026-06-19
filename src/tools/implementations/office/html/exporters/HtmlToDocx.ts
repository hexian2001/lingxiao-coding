/**
 * HTML → DOCX 可编辑导出器。
 *
 * 解析 HTML DOM（用 linkedom，零浏览器、快；若无则退回正则降级），
 * 把结构化块映射成 docx 库（^9.7.1）的原生 block：h1-3 / 段落 / 列表 /
 * 表格 / 图片。产物是**可编辑**的 .docx（Word/WPS 可直接打开改）。
 *
 * 这是凌霄 HTML 办公底座「单一 HTML → 各原生格式」的 DOCX 出口：
 * HTML 是单一底座，DOCX 是结构化降级映射（不是位图），保留可编辑性。
 */

import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType } from 'docx';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { AssembledHtml } from '../assemble.js';

export interface HtmlToDocxResult {
  success: boolean;
  outputPath?: string;
  bytes: number;
  error?: string;
}

/** 极简 DOM：只抽我们需要的那几个节点。 */
interface DomNode {
  tag: string;
  text: string;
  children: DomNode[];
  attrs: Record<string, string>;
}

/** 解析 HTML DOM（轻量正则降级，覆盖本引擎产出的语义化标签）。 */
async function parseHtml(html: string): Promise<DomNode> {
  // linkedom 若在运行时可用则优先（更鲁棒）；否则走正则降级（无新依赖）。
  try {
    // @ts-expect-error — linkedom 是可选运行时依赖，未安装时类型解析失败由 catch 兜底
    const mod = (await import('linkedom').catch(() => null)) as { parseHTML?: (src: string) => { document: DocumentLike } } | null;
    if (mod && typeof mod.parseHTML === 'function') {
      const { document } = mod.parseHTML(html);
      const root: ElementLike = document.body || document.documentElement || ({} as ElementLike);
      return fromDocument(root);
    }
  } catch {
    // 落入正则降级。
  }
  return regexParse(html);
}

interface DocumentLike {
  querySelectorAll(sel: string): ElementLike[];
  querySelector(sel: string): ElementLike | null;
  getElementsByTagName(tag: string): ElementLike[];
  body?: ElementLike;
  documentElement?: ElementLike;
}
interface ElementLike {
  tagName: string;
  textContent: string;
  getAttribute(name: string): string | null;
  childNodes?: ElementLike[];
  children?: ElementLike[];
}

function fromDocument(root: ElementLike): DomNode {
  return { tag: 'root', text: '', attrs: {}, children: collect(root) };
}

function collect(el: ElementLike): DomNode[] {
  const kids = (el.children || el.childNodes || []) as ElementLike[];
  return kids
    .filter((k) => k && k.tagName)
    .map((k) => ({
      tag: k.tagName.toLowerCase(),
      text: (k.textContent || '').trim(),
      attrs: {
        src: k.getAttribute && (k.getAttribute('src') || '') || '',
        alt: k.getAttribute && (k.getAttribute('alt') || '') || '',
      },
      children: collect(k),
    }));
}

/** linkedom 不可用时的正则降级（覆盖主要标签）。 */
function regexParse(html: string): DomNode {
  const blockTags = ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'img', 'aside', 'blockquote', 'nav'];
  const children: DomNode[] = [];
  const re = new RegExp(`<(${blockTags.join('|')})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    children.push({ tag, text: stripTags(inner).trim(), attrs: {}, children: tag === 'ul' || tag === 'ol' || tag === 'table' ? regexParse(inner).children : [] });
  }
  return { tag: 'root', text: '', attrs: {}, children };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function headingLevel(tag: string): (typeof HeadingLevel)[keyof typeof HeadingLevel] | null {
  if (tag === 'h1') return HeadingLevel.HEADING_1;
  if (tag === 'h2') return HeadingLevel.HEADING_2;
  if (tag === 'h3') return HeadingLevel.HEADING_3;
  return null;
}

export async function exportHtmlToDocx(
  assembled: AssembledHtml,
  outputPath: string,
): Promise<HtmlToDocxResult> {
  try {
    const dom = await parseHtml(assembled.html);
    const paragraphs: (Paragraph | Table)[] = [];

    for (const node of walk(dom)) {
      const hlevel = headingLevel(node.tag);
      if (hlevel) {
        paragraphs.push(new Paragraph({ heading: hlevel, children: [new TextRun({ text: node.text, bold: true })] }));
        continue;
      }
      if (node.tag === 'p') {
        paragraphs.push(new Paragraph({ children: [new TextRun(node.text)] }));
        continue;
      }
      if (node.tag === 'li') {
        paragraphs.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(node.text)] }));
        continue;
      }
      if (node.tag === 'img' && node.attrs.src) {
        const img = await tryImage(node.attrs.src);
        if (img) {
          paragraphs.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [img] }));
        }
        continue;
      }
      if (node.tag === 'table') {
        const rows = node.children.filter((c) => c.tag === 'tr' || c.tag === 'thead' || c.tag === 'tbody');
        const trNodes: DomNode[] = [];
        for (const r of rows) {
          if (r.tag === 'tr') trNodes.push(r);
          else trNodes.push(...r.children.filter((c) => c.tag === 'tr'));
        }
        if (trNodes.length) {
          const tableRows = trNodes.map((tr) => {
            const cells = tr.children.filter((c) => c.tag === 'td' || c.tag === 'th');
            return new TableRow({
              children: cells.map(
                (c) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: c.text, bold: c.tag === 'th' })] })],
                  }),
              ),
            });
          });
          paragraphs.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        }
        continue;
      }
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: paragraphs.length
            ? paragraphs
            : [new Paragraph({ children: [new TextRun(assembled.count ? '(empty)' : '')] })],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
    return { success: true, outputPath, bytes: buffer.length };
  } catch (error) {
    return { success: false, bytes: 0, error: `HTML→DOCX failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function* walk(node: DomNode): Generator<DomNode> {
  for (const child of node.children) {
    if (child.tag === 'table') {
      yield child;
      continue;
    }
    if (child.children.length && ['ul', 'ol', 'thead', 'tbody', 'figure'].includes(child.tag)) {
      yield* walk(child);
      if (['h1', 'h2', 'h3', 'p', 'img'].includes(child.tag)) yield child;
      continue;
    }
    yield child;
  }
}

async function tryImage(src: string): Promise<ImageRun | null> {
  try {
    let buf: Buffer;
    let type: 'png' | 'jpg' | 'gif' | 'bmp';
    if (src.startsWith('data:')) {
      const mimeMatch = src.match(/^data:image\/(png|jpe?g|gif|bmp)/i);
      const t = (mimeMatch ? mimeMatch[1].toLowerCase() : 'png').replace('jpeg', 'jpg') as 'png' | 'jpg' | 'gif' | 'bmp';
      type = t;
      const b64 = src.split(',')[1] ?? '';
      buf = Buffer.from(b64, 'base64');
    } else if (src.startsWith('http') || src.startsWith('/')) {
      return null; // 远程/绝对路径暂不抓
    } else {
      const ext = src.toLowerCase().endsWith('.jpg') || src.toLowerCase().endsWith('.jpeg') ? 'jpg' : 'png';
      type = ext as 'png' | 'jpg';
      buf = await readFile(src);
    }
    return new ImageRun({ type, data: buf, transformation: { width: 480, height: 320 } });
  } catch {
    return null;
  }
}
