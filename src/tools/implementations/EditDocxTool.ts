import { z } from 'zod';
import { basename, dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import JSZip from 'jszip';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension } from './OfficeXmlBuilder.js';
import { replaceTextAcrossOoxmlTextNodes } from './office/OoxmlTextReplace.js';
import { lockedAtomicWriteBuffer, resolveTaskWritePath, resolveWorkspacePath } from './utils.js';

const ReplaceTextOpSchema = z.object({
  type: z.literal('replace_text'),
  find: z.string().min(1),
  replace: z.string(),
  match_case: z.boolean().default(false),
});

const AppendParagraphOpSchema = z.object({
  type: z.literal('append_paragraph'),
  text: z.string(),
  bold: z.boolean().default(false),
});

const AppendHeadingOpSchema = z.object({
  type: z.literal('append_heading'),
  text: z.string(),
  level: z.number().int().min(1).max(3).default(1),
});

const AppendTableOpSchema = z.object({
  type: z.literal('append_table'),
  headers: z.array(z.string()).min(1).max(20),
  rows: z.array(z.array(z.string())).max(300),
});

const RawXmlReplaceOpSchema = z.object({
  type: z.literal('raw_xml_replace'),
  entry: z.string().default('word/document.xml'),
  find: z.string().min(1),
  replace: z.string(),
});

const ElementIdSchema = z.string()
  .regex(/^(?:docx:body:(?:p|tbl):\d+|docx-page\d+-(?:p|table)\d+)$/)
  .describe('element_id from inspect_docx, e.g. docx-page1-p3 or docx:body:p:3');

const ReplaceElementTextOpSchema = z.object({
  type: z.literal('replace_element_text'),
  element_id: ElementIdSchema,
  text: z.string(),
  bold: z.boolean().optional(),
});

const DeleteElementOpSchema = z.object({
  type: z.literal('delete_element'),
  element_id: ElementIdSchema,
});

const MoveElementOpSchema = z.object({
  type: z.literal('move_element'),
  element_id: ElementIdSchema,
  before_element_id: ElementIdSchema.optional(),
  after_element_id: ElementIdSchema.optional(),
  index: z.number().int().min(1).optional().describe('1-based destination block index when before/after is omitted'),
}).refine((value) => [value.before_element_id, value.after_element_id, value.index].filter(Boolean).length === 1, {
  message: 'provide exactly one of before_element_id, after_element_id, or index',
});

const SetElementBboxOpSchema = z.object({
  type: z.literal('set_element_bbox'),
  element_id: ElementIdSchema,
  x: z.number().min(0).optional().describe('left indent in inches for paragraph/table layout'),
  y: z.number().min(0).optional().describe('spacing before in inches'),
  w: z.number().min(0.1).optional().describe('target width in inches where OOXML supports it'),
  h: z.number().min(0).optional().describe('spacing after in inches'),
});

const DocxEditOperationSchema = z.discriminatedUnion('type', [
  ReplaceTextOpSchema,
  AppendParagraphOpSchema,
  AppendHeadingOpSchema,
  AppendTableOpSchema,
  ReplaceElementTextOpSchema,
  DeleteElementOpSchema,
  MoveElementOpSchema,
  SetElementBboxOpSchema,
  RawXmlReplaceOpSchema,
]);

const EditDocxSchema = z.object({
  path: z.string().describe('source DOCX path'),
  output_path: z.string().optional().describe('output DOCX path; omit to write <name>.edited.docx unless overwrite=true'),
  overwrite: z.boolean().default(false),
  operations: z.array(DocxEditOperationSchema).min(1).max(200),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

type DocxEditOperation = z.infer<typeof DocxEditOperationSchema>;

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraphXml(text: string, bold = false): string {
  return `<w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function headingXml(text: string, level: number): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function tableXml(headers: string[], rows: string[][]): string {
  const rowXml = (cells: string[], header = false) => `<w:tr>${headers.map((_, index) => `<w:tc><w:p><w:r>${header ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEscape(cells[index] ?? '')}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/></w:tblBorders></w:tblPr>${rowXml(headers, true)}${rows.map((row) => rowXml(row)).join('')}</w:tbl>`;
}

function appendToBody(xml: string, fragment: string): string {
  const marker = '</w:body>';
  const idx = xml.lastIndexOf(marker);
  if (idx < 0) throw new Error('word/document.xml does not contain w:body');
  return `${xml.slice(0, idx)}${fragment}${xml.slice(idx)}`;
}

interface BodyBlock {
  kind: 'p' | 'tbl' | 'sectPr';
  xml: string;
  index: number;
}

function parseElementId(elementId: string): { kind: 'p' | 'tbl'; index: number; by: 'block' | 'kindOrdinal' } {
  const match = elementId.match(/^docx:body:(p|tbl):(\d+)$/);
  if (match) return { kind: match[1] as 'p' | 'tbl', index: Number(match[2]), by: 'block' };
  const previewMatch = elementId.match(/^docx-page\d+-(p|table)(\d+)$/);
  if (previewMatch) return { kind: previewMatch[1] === 'table' ? 'tbl' : 'p', index: Number(previewMatch[2]), by: 'kindOrdinal' };
  throw new Error(`invalid docx element_id: ${elementId}`);
}

function bodyMatch(xml: string): RegExpMatchArray {
  const match = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i);
  if (!match) throw new Error('word/document.xml does not contain w:body');
  return match;
}

function parseBodyBlocks(documentXml: string): { before: string; bodyOpen: string; bodyClose: string; after: string; blocks: BodyBlock[] } {
  const match = bodyMatch(documentXml);
  const bodyOpenStart = match.index ?? 0;
  const bodyOpen = documentXml.slice(bodyOpenStart, bodyOpenStart + match[0].indexOf(match[1]));
  const bodyClose = '</w:body>';
  const before = documentXml.slice(0, bodyOpenStart);
  const after = documentXml.slice(bodyOpenStart + match[0].length);
  const blocks: BodyBlock[] = [];
  let index = 0;
  for (const blockMatch of match[1].matchAll(/<w:(p|tbl|sectPr)\b[\s\S]*?<\/w:\1>/g)) {
    const kind = blockMatch[1] as BodyBlock['kind'];
    const xml = blockMatch[0];
    if (kind === 'sectPr') blocks.push({ kind, xml, index: -1 });
    else {
      index += 1;
      blocks.push({ kind, xml, index });
    }
  }
  return { before, bodyOpen, bodyClose, after, blocks };
}

function serializeBody(parsed: ReturnType<typeof parseBodyBlocks>): string {
  return `${parsed.before}${parsed.bodyOpen}${parsed.blocks.map((block) => block.xml).join('')}${parsed.bodyClose}${parsed.after}`;
}

function findBlockIndex(blocks: BodyBlock[], elementId: string): number {
  const target = parseElementId(elementId);
  let index = -1;
  if (target.by === 'block') {
    index = blocks.findIndex((block) => block.kind === target.kind && block.index === target.index);
  } else {
    let ordinal = 0;
    index = blocks.findIndex((block) => {
      if (block.kind !== target.kind) return false;
      ordinal += 1;
      return ordinal === target.index;
    });
  }
  if (index < 0) throw new Error(`element not found: ${elementId}`);
  return index;
}

function replaceBlockText(block: string, text: string, bold?: boolean): string {
  if (block.startsWith('<w:p')) {
    const pPr = block.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/i)?.[0] ?? '';
    return `<w:p>${pPr}<w:r><w:rPr>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  }
  let first = true;
  return block.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, () => {
    const value = first ? text : '';
    first = false;
    return `<w:t xml:space="preserve">${xmlEscape(value)}</w:t>`;
  });
}

function twips(inches: number): number {
  return Math.round(inches * 1440);
}

function upsertInOpenTag(xml: string, tag: string, fragment: string): string {
  const existing = xml.match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'i'));
  if (existing) return xml.replace(existing[0], fragment);
  return fragment + xml;
}

function setBlockLayout(block: string, op: z.infer<typeof SetElementBboxOpSchema>): string {
  if (block.startsWith('<w:p')) {
    const ind = op.x !== undefined || op.w !== undefined
      ? `<w:ind${op.x !== undefined ? ` w:left="${twips(op.x)}"` : ''}${op.w !== undefined ? ` w:right="${twips(Math.max(0, 8.5 - op.w - (op.x ?? 0)))}"` : ''}/>`
      : '';
    const spacing = op.y !== undefined || op.h !== undefined
      ? `<w:spacing${op.y !== undefined ? ` w:before="${twips(op.y)}"` : ''}${op.h !== undefined ? ` w:after="${twips(op.h)}"` : ''}/>`
      : '';
    const pPr = `<w:pPr>${ind}${spacing}</w:pPr>`;
    if (/<w:pPr\b[\s\S]*?<\/w:pPr>/i.test(block)) return block.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/i, pPr);
    return block.replace(/<w:p\b[^>]*>/i, (open) => `${open}${pPr}`);
  }

  const tblInd = op.x !== undefined ? `<w:tblInd w:w="${twips(op.x)}" w:type="dxa"/>` : '';
  const tblW = op.w !== undefined ? `<w:tblW w:w="${twips(op.w)}" w:type="dxa"/>` : '';
  const tblPr = `<w:tblPr>${tblInd}${tblW}</w:tblPr>`;
  if (/<w:tblPr\b[\s\S]*?<\/w:tblPr>/i.test(block)) return block.replace(/<w:tblPr\b[\s\S]*?<\/w:tblPr>/i, tblPr);
  return block.replace(/<w:tbl\b[^>]*>/i, (open) => `${open}${tblPr}`);
}

function replaceTextXml(xml: string, op: z.infer<typeof ReplaceTextOpSchema>): { xml: string; count: number } {
  return replaceTextAcrossOoxmlTextNodes({
    xml,
    tagName: 'w:t',
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

export class EditDocxTool extends Tool {
  readonly name = 'edit_docx';
  readonly description = '脚本化编辑原生 DOCX。支持文本替换、追加标题/段落/表格，并提供 raw_xml_replace 作为 OOXML 级逃生口，用于多轮改稿。';
  readonly parameters = EditDocxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = EditDocxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const input = parsed.data;
    const sourcePath = resolveWorkspacePath(context?.workspace, input.path, context?.sessionId);
    if (!existsSync(sourcePath)) {
      return { success: false, data: null, error: `ERROR: DOCX 不存在: ${sourcePath}` };
    }

    const outputPath = input.overwrite
      ? sourcePath
      : ensureExtension(resolveTaskWritePath(
        context?.workspace,
        input.output_path || sourcePath.replace(/\.docx$/i, '.edited.docx'),
        context?.sessionId,
        context?.taskWriteScope,
      ), '.docx');

    try {
      const zip = await JSZip.loadAsync(readFileSync(sourcePath));
      let documentXml = await readZipText(zip, 'word/document.xml');
      const summary: Array<{ type: string; element_id?: string; count?: number }> = [];

      for (const op of input.operations as DocxEditOperation[]) {
        if (op.type === 'replace_text') {
          const result = replaceTextXml(documentXml, op);
          documentXml = result.xml;
          summary.push({ type: op.type, count: result.count });
        } else if (op.type === 'append_paragraph') {
          documentXml = appendToBody(documentXml, paragraphXml(op.text, op.bold));
          summary.push({ type: op.type, count: 1 });
        } else if (op.type === 'append_heading') {
          documentXml = appendToBody(documentXml, headingXml(op.text, op.level));
          summary.push({ type: op.type, count: 1 });
        } else if (op.type === 'append_table') {
          documentXml = appendToBody(documentXml, tableXml(op.headers, op.rows));
          summary.push({ type: op.type, count: 1 });
        } else if (op.type === 'replace_element_text') {
          const parsedBody = parseBodyBlocks(documentXml);
          const blockIndex = findBlockIndex(parsedBody.blocks, op.element_id);
          parsedBody.blocks[blockIndex] = {
            ...parsedBody.blocks[blockIndex],
            xml: replaceBlockText(parsedBody.blocks[blockIndex].xml, op.text, op.bold),
          };
          documentXml = serializeBody(parsedBody);
          summary.push({ type: op.type, element_id: op.element_id, count: 1 });
        } else if (op.type === 'delete_element') {
          const parsedBody = parseBodyBlocks(documentXml);
          const blockIndex = findBlockIndex(parsedBody.blocks, op.element_id);
          parsedBody.blocks.splice(blockIndex, 1);
          documentXml = serializeBody(parsedBody);
          summary.push({ type: op.type, element_id: op.element_id, count: 1 });
        } else if (op.type === 'move_element') {
          const parsedBody = parseBodyBlocks(documentXml);
          const sourceIndex = findBlockIndex(parsedBody.blocks, op.element_id);
          const [block] = parsedBody.blocks.splice(sourceIndex, 1);
          let destination = parsedBody.blocks.findIndex((candidate) => candidate.kind === 'sectPr');
          if (op.before_element_id) {
            destination = findBlockIndex(parsedBody.blocks, op.before_element_id);
          } else if (op.after_element_id) {
            destination = findBlockIndex(parsedBody.blocks, op.after_element_id) + 1;
          } else if (op.index) {
            const editableBlocks = parsedBody.blocks.filter((candidate) => candidate.kind !== 'sectPr').length;
            destination = Math.min(Math.max(op.index - 1, 0), editableBlocks);
          }
          if (destination < 0) destination = parsedBody.blocks.length;
          parsedBody.blocks.splice(destination, 0, block);
          documentXml = serializeBody(parsedBody);
          summary.push({ type: op.type, element_id: op.element_id, count: 1 });
        } else if (op.type === 'set_element_bbox') {
          const parsedBody = parseBodyBlocks(documentXml);
          const blockIndex = findBlockIndex(parsedBody.blocks, op.element_id);
          parsedBody.blocks[blockIndex] = {
            ...parsedBody.blocks[blockIndex],
            xml: setBlockLayout(parsedBody.blocks[blockIndex].xml, op),
          };
          documentXml = serializeBody(parsedBody);
          summary.push({ type: op.type, element_id: op.element_id, count: 1 });
        } else if (op.type === 'raw_xml_replace') {
          const xml = op.entry === 'word/document.xml' ? documentXml : await readZipText(zip, op.entry);
          const count = xml.split(op.find).length - 1;
          const nextXml = xml.split(op.find).join(op.replace);
          if (op.entry === 'word/document.xml') documentXml = nextXml;
          else zip.file(op.entry, nextXml);
          summary.push({ type: op.type, count });
        }
      }

      zip.file('word/document.xml', documentXml);
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      mkdirSync(dirname(outputPath), { recursive: true });
      await lockedAtomicWriteBuffer(outputPath, buffer, { createDirs: true });

      const artifact = input.create_download_link
        ? tempDownloadRegistry.create({
          path: outputPath,
          name: basename(outputPath),
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

export default EditDocxTool;
