import { z } from 'zod';
import { basename, dirname, extname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import JSZip from 'jszip';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension } from './OfficeXmlBuilder.js';
import { replaceTextAcrossOoxmlTextNodes } from './office/OoxmlTextReplace.js';
import { lockedAtomicWriteBuffer, resolveTaskWritePath, resolveWorkspacePath } from './utils.js';

const EMU_PER_INCH = 914400;

const TextOpSchema = z.object({
  type: z.literal('add_text'),
  slide: z.number().int().min(1).describe('1-based slide index'),
  x: z.number().min(0).describe('left, inches'),
  y: z.number().min(0).describe('top, inches'),
  w: z.number().min(0.1).describe('width, inches'),
  h: z.number().min(0.1).describe('height, inches'),
  text: z.string(),
  font_size: z.number().min(6).max(96).default(18),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).default('111827'),
  bold: z.boolean().default(false),
  align: z.enum(['left', 'center', 'right']).default('left'),
});

const ShapeOpSchema = z.object({
  type: z.literal('add_shape'),
  slide: z.number().int().min(1),
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().min(0.05),
  h: z.number().min(0.05),
  shape: z.enum(['rect', 'roundRect', 'ellipse', 'line']).default('rect'),
  fill: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  line: z.string().regex(/^#?[0-9a-fA-F]{6}$/).default('CBD5E1'),
  line_width: z.number().min(0).max(8).default(1),
});

const ImageOpSchema = z.object({
  type: z.literal('add_image'),
  slide: z.number().int().min(1),
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().min(0.1),
  h: z.number().min(0.1),
  path: z.string().describe('local image path'),
});

const ReplaceTextOpSchema = z.object({
  type: z.literal('replace_text'),
  find: z.string().min(1),
  replace: z.string(),
  slide: z.number().int().min(1).optional().describe('omit to replace across all slides'),
  match_case: z.boolean().default(false),
});

const ReplaceElementTextOpSchema = z.object({
  type: z.literal('replace_element_text'),
  element_id: z.string().regex(/^(?:pptx:s\d+:e\d+|pptx-s\d+-el\d+)$/).describe('element_id from inspect_pptx, e.g. pptx-s2-el5'),
  text: z.string().describe('replacement text for the element text body'),
  font_size: z.number().min(6).max(96).optional(),
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  bold: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

const MoveElementOpSchema = z.object({
  type: z.literal('move_element'),
  element_id: z.string().regex(/^(?:pptx:s\d+:e\d+|pptx-s\d+-el\d+)$/),
  x: z.number().min(0).describe('left, inches'),
  y: z.number().min(0).describe('top, inches'),
});

const ResizeElementOpSchema = z.object({
  type: z.literal('resize_element'),
  element_id: z.string().regex(/^(?:pptx:s\d+:e\d+|pptx-s\d+-el\d+)$/),
  w: z.number().min(0).describe('width, inches'),
  h: z.number().min(0).describe('height, inches'),
});

const SetElementBboxOpSchema = z.object({
  type: z.literal('set_element_bbox'),
  element_id: z.string().regex(/^(?:pptx:s\d+:e\d+|pptx-s\d+-el\d+)$/),
  x: z.number().min(0).describe('left, inches'),
  y: z.number().min(0).describe('top, inches'),
  w: z.number().min(0).describe('width, inches'),
  h: z.number().min(0).describe('height, inches'),
});

const DeleteElementOpSchema = z.object({
  type: z.literal('delete_element'),
  element_id: z.string().regex(/^(?:pptx:s\d+:e\d+|pptx-s\d+-el\d+)$/),
});

const RawXmlReplaceOpSchema = z.object({
  type: z.literal('raw_xml_replace'),
  entry: z.string().describe('OOXML zip entry, e.g. ppt/slides/slide3.xml'),
  find: z.string().min(1),
  replace: z.string(),
});

const PptxEditOperationSchema = z.discriminatedUnion('type', [
  TextOpSchema,
  ShapeOpSchema,
  ImageOpSchema,
  ReplaceTextOpSchema,
  ReplaceElementTextOpSchema,
  MoveElementOpSchema,
  ResizeElementOpSchema,
  SetElementBboxOpSchema,
  DeleteElementOpSchema,
  RawXmlReplaceOpSchema,
]);

const EditPptxSchema = z.object({
  path: z.string().describe('source PPTX path'),
  output_path: z.string().optional().describe('output PPTX path; omit to write <name>.edited.pptx unless overwrite=true'),
  overwrite: z.boolean().default(false).describe('overwrite source path'),
  operations: z.array(PptxEditOperationSchema).min(1).max(200),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

type PptxEditOperation = z.infer<typeof PptxEditOperationSchema>;

function emu(inches: number): number {
  return Math.round(inches * EMU_PER_INCH);
}

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanHex(value?: string, fallback = '111827'): string {
  const hex = String(value || fallback).replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : fallback;
}

function maxShapeId(xml: string): number {
  let max = 1;
  for (const match of xml.matchAll(/<p:cNvPr[^>]*\sid="(\d+)"/g)) {
    max = Math.max(max, Number(match[1]) || 1);
  }
  return max;
}

function insertIntoSpTree(xml: string, fragment: string): string {
  const marker = '</p:spTree>';
  const idx = xml.lastIndexOf(marker);
  if (idx < 0) throw new Error('slide XML does not contain p:spTree');
  return `${xml.slice(0, idx)}${fragment}${xml.slice(idx)}`;
}

function textShapeXml(id: number, op: z.infer<typeof TextOpSchema>): string {
  const color = cleanHex(op.color);
  const paragraphs = op.text.split(/\r?\n/).map((line) => `
        <a:p>
          <a:pPr algn="${op.align}"/>
          <a:r><a:rPr lang="zh-CN" sz="${Math.round(op.font_size * 100)}"${op.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEscape(line)}</a:t></a:r>
        </a:p>`).join('');
  return `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="LingXiao Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${emu(op.x)}" y="${emu(op.y)}"/><a:ext cx="${emu(op.w)}" cy="${emu(op.h)}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/><a:ln><a:noFill/></a:ln>
      </p:spPr>
      <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody>
    </p:sp>`;
}

function shapeXml(id: number, op: z.infer<typeof ShapeOpSchema>): string {
  const line = cleanHex(op.line, 'CBD5E1');
  const fill = op.fill
    ? `<a:solidFill><a:srgbClr val="${cleanHex(op.fill, 'FFFFFF')}"/></a:solidFill>`
    : '<a:noFill/>';
  const geometry = op.shape === 'line' ? 'straightConnector1' : op.shape;
  return `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="LingXiao Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${emu(op.x)}" y="${emu(op.y)}"/><a:ext cx="${emu(op.w)}" cy="${emu(op.h)}"/></a:xfrm>
        <a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>
        ${fill}
        <a:ln w="${Math.round(op.line_width * 12700)}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>
      </p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>`;
}

function imageContentType(ext: string): string {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function nextRelId(relsXml: string): string {
  let max = 0;
  for (const match of relsXml.matchAll(/Id="rId(\d+)"/g)) {
    max = Math.max(max, Number(match[1]) || 0);
  }
  return `rId${max + 1}`;
}

function pictureXml(id: number, relId: string, op: z.infer<typeof ImageOpSchema>): string {
  return `
    <p:pic>
      <p:nvPicPr><p:cNvPr id="${id}" name="LingXiao Image ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="${emu(op.x)}" y="${emu(op.y)}"/><a:ext cx="${emu(op.w)}" cy="${emu(op.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>`;
}

function parseElementId(elementId: string): { slide: number; id: number; mode: 'ooxml' | 'previewIndex' } {
  const ooxmlMatch = elementId.match(/^pptx:s(\d+):e(\d+)$/);
  if (ooxmlMatch) return { slide: Number(ooxmlMatch[1]), id: Number(ooxmlMatch[2]), mode: 'ooxml' };
  const previewMatch = elementId.match(/^pptx-s(\d+)-el(\d+)$/);
  if (previewMatch) return { slide: Number(previewMatch[1]), id: Number(previewMatch[2]), mode: 'previewIndex' };
  throw new Error(`invalid pptx element_id: ${elementId}`);
}

function findElementRange(xml: string, id: number): { start: number; end: number; xml: string } | null {
  for (const tag of ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp']) {
    const re = new RegExp(`<p:${tag}\\b[\\s\\S]*?<\\/p:${tag}>`, 'g');
    for (const match of xml.matchAll(re)) {
      const block = match[0];
      if (new RegExp(`<p:cNvPr\\b[^>]*\\sid="${id}"(?:\\s|/|>)`).test(block)) {
        return { start: match.index ?? 0, end: (match.index ?? 0) + block.length, xml: block };
      }
    }
  }
  return null;
}

function findElementRangeByPreviewIndex(xml: string, elementIndex: number): { start: number; end: number; xml: string } | null {
  let current = 0;
  for (const tag of ['sp', 'pic', 'graphicFrame'] as const) {
    const re = new RegExp(`<p:${tag}\\b[\\s\\S]*?<\\/p:${tag}>`, 'g');
    for (const match of xml.matchAll(re)) {
      const block = match[0];
      if (tag === 'graphicFrame' && !/<a:tbl\b/i.test(block)) continue;
      current += 1;
      if (current === elementIndex) {
        return { start: match.index ?? 0, end: (match.index ?? 0) + block.length, xml: block };
      }
    }
  }
  return null;
}

function replaceRange(xml: string, range: { start: number; end: number }, replacement: string): string {
  return `${xml.slice(0, range.start)}${replacement}${xml.slice(range.end)}`;
}

function textBodyXml(text: string, op: z.infer<typeof ReplaceElementTextOpSchema>): string {
  const color = cleanHex(op.color, '111827');
  const fontSize = op.font_size ?? 18;
  const align = op.align ?? 'left';
  const paragraphs = text.split(/\r?\n/).map((line) => `
        <a:p>
          <a:pPr algn="${align}"/>
          <a:r><a:rPr lang="zh-CN" sz="${Math.round(fontSize * 100)}"${op.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEscape(line)}</a:t></a:r>
        </a:p>`).join('');
  return `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody>`;
}

function replaceElementTextXml(block: string, op: z.infer<typeof ReplaceElementTextOpSchema>): string {
  const body = textBodyXml(op.text, op);
  if (/<p:txBody\b[\s\S]*?<\/p:txBody>/i.test(block)) {
    return block.replace(/<p:txBody\b[\s\S]*?<\/p:txBody>/i, body);
  }
  const spPrEnd = block.indexOf('</p:spPr>');
  if (spPrEnd >= 0) return `${block.slice(0, spPrEnd + '</p:spPr>'.length)}${body}${block.slice(spPrEnd + '</p:spPr>'.length)}`;
  throw new Error(`element ${op.element_id} does not support text body replacement`);
}

function xfrmXml(x: number, y: number, w: number, h: number): string {
  return `<a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`;
}

function currentBbox(block: string): { x: number; y: number; w: number; h: number } {
  const xfrm = block.match(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/i)?.[0];
  if (!xfrm) return { x: 0, y: 0, w: 1, h: 1 };
  const off = xfrm.match(/<a:off\b[^>]*>/i)?.[0] ?? '';
  const ext = xfrm.match(/<a:ext\b[^>]*>/i)?.[0] ?? '';
  const read = (node: string, name: string, fallback: number) => {
    const value = node.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1];
    const parsed = value ? Number(value) / EMU_PER_INCH : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    x: read(off, 'x', 0),
    y: read(off, 'y', 0),
    w: read(ext, 'cx', 1),
    h: read(ext, 'cy', 1),
  };
}

function setElementBboxXml(block: string, bbox: { x: number; y: number; w: number; h: number }): string {
  const next = xfrmXml(bbox.x, bbox.y, bbox.w, bbox.h);
  if (/<a:xfrm\b[\s\S]*?<\/a:xfrm>/i.test(block)) {
    return block.replace(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/i, next);
  }
  const spPrStart = block.match(/<p:(?:spPr|blipFill|grpSpPr)\b[^>]*>/i);
  if (!spPrStart || spPrStart.index === undefined) throw new Error('element does not contain a transform host');
  const insertAt = spPrStart.index + spPrStart[0].length;
  return `${block.slice(0, insertAt)}${next}${block.slice(insertAt)}`;
}

function replaceTextXml(xml: string, op: z.infer<typeof ReplaceTextOpSchema>): { xml: string; count: number } {
  return replaceTextAcrossOoxmlTextNodes({
    xml,
    tagName: 'a:t',
    find: op.find,
    replace: op.replace,
    matchCase: op.match_case,
  });
}

async function readZipText(zip: JSZip, entry: string): Promise<string> {
  const file = zip.file(entry);
  if (!file) throw new Error(`OOXML entry not found: ${entry}`);
  return file.async('string');
}

export class EditPptxTool extends Tool {
  readonly name = 'edit_pptx';
  readonly description = '脚本化编辑原生 PPTX。支持按 slide 页码和英寸坐标精准添加文字/形状/图片、全局或单页替换文本，并提供 raw_xml_replace 作为 OOXML 级逃生口。';
  readonly parameters = EditPptxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = EditPptxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const input = parsed.data;
    const sourcePath = resolveWorkspacePath(context?.workspace, input.path, context?.sessionId);
    if (!existsSync(sourcePath)) {
      return { success: false, data: null, error: `ERROR: PPTX 不存在: ${sourcePath}` };
    }

    const outputPath = input.overwrite
      ? sourcePath
      : ensureExtension(resolveTaskWritePath(
        context?.workspace,
        input.output_path || sourcePath.replace(/\.pptx$/i, '.edited.pptx'),
        context?.sessionId,
        context?.taskWriteScope,
      ), '.pptx');

    try {
      const zip = await JSZip.loadAsync(readFileSync(sourcePath));
      const slideEntries = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] || 0) - Number(b.match(/slide(\d+)/i)?.[1] || 0));
      const summary: Array<{ type: string; slide?: number; element_id?: string; count?: number }> = [];

      for (const op of input.operations as PptxEditOperation[]) {
        if (op.type === 'raw_xml_replace') {
          const xml = await readZipText(zip, op.entry);
          const count = xml.split(op.find).length - 1;
          zip.file(op.entry, xml.split(op.find).join(op.replace));
          summary.push({ type: op.type, count });
          continue;
        }

        if (op.type === 'replace_text') {
          const targets = op.slide ? [slideEntries[op.slide - 1]] : slideEntries;
          let total = 0;
          for (const entry of targets.filter(Boolean)) {
            const xml = await readZipText(zip, entry);
            const result = replaceTextXml(xml, op);
            total += result.count;
            zip.file(entry, result.xml);
          }
          summary.push({ type: op.type, slide: op.slide, count: total });
          continue;
        }

        if (
          op.type === 'replace_element_text'
          || op.type === 'move_element'
          || op.type === 'resize_element'
          || op.type === 'set_element_bbox'
          || op.type === 'delete_element'
        ) {
          const { slide, id, mode } = parseElementId(op.element_id);
          const entry = slideEntries[slide - 1];
          if (!entry) throw new Error(`slide ${slide} not found for ${op.element_id}`);
          const xml = await readZipText(zip, entry);
          const range = mode === 'previewIndex' ? findElementRangeByPreviewIndex(xml, id) : findElementRange(xml, id);
          if (!range) throw new Error(`element not found: ${op.element_id}`);

          if (op.type === 'delete_element') {
            zip.file(entry, replaceRange(xml, range, ''));
            summary.push({ type: op.type, slide, element_id: op.element_id, count: 1 });
            continue;
          }

          let nextBlock = range.xml;
          if (op.type === 'replace_element_text') {
            nextBlock = replaceElementTextXml(nextBlock, op);
          } else {
            const bbox = currentBbox(nextBlock);
            if (op.type === 'move_element') {
              nextBlock = setElementBboxXml(nextBlock, { ...bbox, x: op.x, y: op.y });
            } else if (op.type === 'resize_element') {
              nextBlock = setElementBboxXml(nextBlock, { ...bbox, w: op.w, h: op.h });
            } else if (op.type === 'set_element_bbox') {
              nextBlock = setElementBboxXml(nextBlock, { x: op.x, y: op.y, w: op.w, h: op.h });
            }
          }

          zip.file(entry, replaceRange(xml, range, nextBlock));
          summary.push({ type: op.type, slide, element_id: op.element_id, count: 1 });
          continue;
        }

        const slideEntry = slideEntries[op.slide - 1];
        if (!slideEntry) throw new Error(`slide ${op.slide} not found`);
        const xml = await readZipText(zip, slideEntry);
        const id = maxShapeId(xml) + 1;

        if (op.type === 'add_text') {
          zip.file(slideEntry, insertIntoSpTree(xml, textShapeXml(id, op)));
          summary.push({ type: op.type, slide: op.slide, count: 1 });
        } else if (op.type === 'add_shape') {
          zip.file(slideEntry, insertIntoSpTree(xml, shapeXml(id, op)));
          summary.push({ type: op.type, slide: op.slide, count: 1 });
        } else if (op.type === 'add_image') {
          const imagePath = resolveWorkspacePath(context?.workspace, op.path, context?.sessionId);
          if (!existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
          const ext = extname(imagePath).toLowerCase() || '.png';
          const mediaName = `ppt/media/lingxiao-edit-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
          zip.file(mediaName, readFileSync(imagePath));

          const slideNumber = op.slide;
          const relEntry = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
          const rels = zip.file(relEntry)
            ? await readZipText(zip, relEntry)
            : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
          const relId = nextRelId(rels);
          const relXml = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${basename(mediaName)}"/>`;
          zip.file(relEntry, rels.replace('</Relationships>', `${relXml}</Relationships>`));

          const contentTypes = await readZipText(zip, '[Content_Types].xml');
          const mime = imageContentType(ext);
          const defaultExt = ext.replace('.', '');
          if (!contentTypes.includes(`Extension="${defaultExt}"`)) {
            zip.file('[Content_Types].xml', contentTypes.replace('</Types>', `<Default Extension="${defaultExt}" ContentType="${mime}"/></Types>`));
          }
          zip.file(slideEntry, insertIntoSpTree(xml, pictureXml(id, relId, op)));
          summary.push({ type: op.type, slide: op.slide, count: 1 });
        }
      }

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      mkdirSync(dirname(outputPath), { recursive: true });
      await lockedAtomicWriteBuffer(outputPath, buffer, { createDirs: true });

      const artifact = input.create_download_link
        ? tempDownloadRegistry.create({
          path: outputPath,
          name: basename(outputPath),
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          expiresInSeconds: input.expires_in_seconds,
          sessionId: context?.sessionId,
        })
        : undefined;

      return { success: true, data: artifact ? { ...artifact, operations: summary } : { path: resolve(outputPath), operations: summary } };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export default EditPptxTool;
