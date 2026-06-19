import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { extname, basename } from 'path';
import { FILE_PARSER } from '../../config/defaults.js';
import type { OfficePreviewModel } from './office/OfficePreviewModel.js';
import { extractDocxPreviewModel, extractPptxPreviewModel } from './office/OfficePreviewExtractor.js';
import { readWorkbook, workbookSheetNames, worksheetToCsv } from './office/ExcelWorkbook.js';

export type ParseMode = 'preview' | 'full' | 'page' | 'sheet';

export interface ParseResult {
  format: string;
  content: string;
  metadata?: {
    pages?: number;
    hasTextLayer?: boolean;
    imageOnly?: boolean;
    sheets?: string[];
    entries?: string[];
    slides?: Array<{
      index: number;
      title?: string;
      text: string;
      bullets: string[];
      notes?: string;
    }>;
    renderer?: 'text' | 'html' | 'pptx-structure' | 'xlsx-table' | 'raw';
    editableKind?: 'text' | 'markdown' | 'html' | 'office-native' | 'read-only';
    warnings?: string[];
    officePreview?: OfficePreviewModel;
    plainText?: string;
    wordCount?: number;
    totalChars?: number;
  };
  truncated: boolean;
}

type MagicFormat =
  | 'pdf'
  | 'zip'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'png'
  | 'jpg'
  | 'webp'
  | 'gif'
  | 'gzip'
  | 'tar.gz'
  | 'bzip2'
  | 'tar';

interface PdfTextResult {
  text?: string;
  total?: number;
}

interface PdfTextParser {
  getText: () => Promise<PdfTextResult>;
  destroy?: () => void;
}

interface PdfParseModule {
  PDFParse: new (opts: { data: Buffer }) => PdfTextParser;
}

interface ZipEntryLike {
  path?: unknown;
  autodrain?: () => void;
}

const PREVIEW_MAX_CHARS = FILE_PARSER.PREVIEW_MAX_CHARS;
const FULL_MAX_CHARS = FILE_PARSER.FULL_MAX_CHARS;
const MAX_PARSE_BYTES = FILE_PARSER.MAX_PARSE_BYTES;
const ZIP_FORMAT: MagicFormat = 'zip';
const OOXML_ZIP_MARKERS: Array<{ marker: string; format: 'docx' | 'xlsx' | 'pptx' }> = [
  { marker: 'word/', format: 'docx' },
  { marker: 'xl/', format: 'xlsx' },
  { marker: 'ppt/', format: 'pptx' },
];
const PPTX_TEXT_ELEMENT_KINDS = new Set(['text', 'table']);
const PPTX_PREVIEW_SLIDE_LIMIT_WARNING = 'pptx-preview-slide-limit';

// ========== 文件头检测（magic bytes）==========
const MAGIC_BYTES: Array<{ magic: number[]; offset?: number; formats: MagicFormat[] }> = [
  { magic: [0x25, 0x50, 0x44, 0x46], formats: ['pdf'] },                    // %PDF
  { magic: [0x50, 0x4B, 0x03, 0x04], formats: ['zip', 'docx', 'xlsx', 'pptx'] }, // ZIP
  { magic: [0x50, 0x4B, 0x05, 0x06], formats: ['zip', 'docx', 'xlsx', 'pptx'] }, // ZIP empty
  { magic: [0x50, 0x4B, 0x07, 0x08], formats: ['zip', 'docx', 'xlsx', 'pptx'] }, // ZIP spanned
  { magic: [0x89, 0x50, 0x4E, 0x47], formats: ['png'] },                    // PNG
  { magic: [0xFF, 0xD8, 0xFF], formats: ['jpg'] },                          // JPEG
  { magic: [0x52, 0x49, 0x46, 0x46], offset: 0, formats: ['webp'] },         // RIFF (WebP)
  { magic: [0x47, 0x49, 0x46, 0x38], formats: ['gif'] },                    // GIF
  { magic: [0x1F, 0x8B], formats: ['gzip', 'tar.gz'] },                     // GZIP
  { magic: [0x42, 0x5A, 0x68], formats: ['bzip2'] },                        // BZIP2
  { magic: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257, formats: ['tar'] }, // TAR ustar
];

/**
 * 读取文件前 N 字节，返回 Uint8Array
 */
function readMagicBytes(filePath: string, maxLen: number = FILE_PARSER.MAGIC_READ_BYTES): Uint8Array {
  let fd: number | null = null;
  try {
    const len = Math.max(0, maxLen);
    const buf = Buffer.alloc(len);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buf, 0, len, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } catch {/* expected: fallback to default */
    return new Uint8Array(0);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {/* expected: fallback to default */
    return 0;
  }
}

function rejectOversized(format: string, filePath: string): ParseResult | null {
  const size = getFileSize(filePath);
  if (size <= MAX_PARSE_BYTES) {
    return null;
  }
  return {
    format,
    content: `文件过大，已拒绝解析: ${basename(filePath)} (${(size / 1024 / 1024).toFixed(1)} MB，限制 ${(MAX_PARSE_BYTES / 1024 / 1024).toFixed(0)} MB)`,
    metadata: { totalChars: size },
    truncated: true,
  };
}

function readTextPreview(filePath: string, maxChars: number): { content: string; truncated: boolean; totalBytes: number } {
  const totalBytes = getFileSize(filePath);
  const byteLimit = Math.min(totalBytes, Math.max(maxChars * 4, maxChars));
  let fd: number | null = null;
  try {
    const buffer = Buffer.alloc(byteLimit);
    fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buffer, 0, byteLimit, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf-8');
    const { text, truncated } = truncate(content, maxChars);
    return { content: text, truncated: truncated || totalBytes > bytesRead, totalBytes };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * 通过文件头和扩展名双重检测格式
 */
export function detectFormat(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const bytes = readMagicBytes(filePath);

  // 先检查 magic bytes
  for (const { magic, offset = 0, formats } of MAGIC_BYTES) {
    if (offset + magic.length > bytes.length) continue;
    let match = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[offset + i] !== magic[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // ZIP 格式需要进一步区分 docx/xlsx/pptx
      if (formats[0] === ZIP_FORMAT) {
        return refineZipFormat(filePath, bytes);
      }
      return formats[0];
    }
  }

  // 无 magic bytes 匹配时回退到扩展名
  const extMap: Record<string, string> = {
    '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc',
    '.xlsx': 'xlsx', '.xls': 'xls', '.csv': 'csv',
    '.pptx': 'pptx', '.ppt': 'ppt',
    '.txt': 'text', '.md': 'markdown', '.markdown': 'markdown', '.json': 'text',
    '.xml': 'text', '.yaml': 'text', '.yml': 'text',
    '.html': 'html', '.htm': 'html',
    '.zip': 'zip', '.tar': 'tar', '.gz': 'gzip',
    '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg',
    '.webp': 'webp', '.gif': 'gif', '.svg': 'svg', '.bmp': 'bmp',
    '.mp3': 'audio', '.wav': 'audio',
    '.mp4': 'video', '.mov': 'video', '.avi': 'video',
  };

  return extMap[ext] || 'binary';
}

/**
 * ZIP 文件进一步区分 docx/xlsx/pptx
 */
function refineZipFormat(filePath: string, _bytes: Uint8Array): string {
  try {
    const buf = Buffer.from(readMagicBytes(filePath, FILE_PARSER.ZIP_SNIFF_BYTES));
    const content = buf.toString('utf-8', 0, Math.min(buf.length, 4096));
    const officeFormat = sniffOoxmlZipFormat(content);
    if (officeFormat) return officeFormat;
  } catch { /* ignore */ }
  return 'zip';
}

function sniffOoxmlZipFormat(content: string): 'docx' | 'xlsx' | 'pptx' | null {
  for (const { marker, format } of OOXML_ZIP_MARKERS) {
    if (content.indexOf(marker) >= 0) return format;
  }
  return null;
}

// ========== 截断工具 ==========
function truncate(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  const cutAt = content.lastIndexOf('\n', maxChars);
  const safeCut = cutAt > maxChars * 0.8 ? cutAt : maxChars;
  return { text: content.slice(0, safeCut) + '\n...(已截断)', truncated: true };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function warningMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mammothMessageToString(message: unknown): string {
  if (message && typeof message === 'object' && 'message' in message) {
    return String((message as { message?: unknown }).message ?? message);
  }
  return String(message);
}

function isZipEntryLike(value: unknown): value is ZipEntryLike {
  return value !== null && typeof value === 'object';
}

// ========== 各格式解析器 ==========

async function parsePDF(filePath: string, mode: ParseMode, page?: number): Promise<ParseResult> {
  const oversized = rejectOversized('pdf', filePath);
  if (oversized) return oversized;

  let parser: PdfTextParser | null = null;
  try {
    // pdf-parse v2.x 使用 class PDFParse，需传入 { data: buffer }
    const { PDFParse } = await import('pdf-parse') as unknown as PdfParseModule;
    const buffer = readFileSync(filePath);
    parser = new PDFParse({ data: buffer });
    const data = await parser.getText();

    const text = data.text || '';
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const hasTextLayer = wordCount > 0;
    const imageOnly = (data.total || 0) > 0 && !hasTextLayer;

    if (mode === 'page' && page) {
      const numPages = data.total || 1;
      const idx = Math.min(page - 1, numPages - 1);
      // pdf-parse v2 不直接支持单页提取，按换页符分隔估算
      const pages = text.split(/\f|\n\n(?=\d+\n)/).filter((p: string) => p.trim());
      return {
        format: 'pdf',
        content: pages[idx] || text || '[PDF 未检测到文本层，可能是纯图片/扫描件。建议使用 OCR 工具。]',
        metadata: {
          pages: numPages,
          wordCount,
          hasTextLayer,
          imageOnly,
          renderer: 'raw',
          editableKind: 'read-only',
        },
        truncated: false,
      };
    }

    const maxChars = mode === 'preview' ? PREVIEW_MAX_CHARS : FULL_MAX_CHARS;
    const truncatedText = truncate(text || '[PDF 未检测到文本层，可能是纯图片/扫描件。建议使用 OCR 工具。]', maxChars);
    return {
      format: 'pdf',
      content: truncatedText.text,
      metadata: {
        pages: data.total,
        wordCount,
        hasTextLayer,
        imageOnly,
        renderer: 'raw',
        editableKind: 'read-only',
      },
      truncated: truncatedText.truncated,
    };
  } catch (e) {
    return { format: 'pdf', content: `PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  } finally {
    parser?.destroy?.();
  }
}

function parseUnsupportedOfficeFile(filePath: string, format: 'doc' | 'docx' | 'ppt' | 'pptx'): ParseResult {
  const stats = existsSync(filePath) ? getFileSize(filePath) : 0;
  return {
    format,
    content: `[Office 二进制文件: ${basename(filePath)}]\n格式: ${format.toUpperCase()}\n大小: ${(stats / 1024).toFixed(1)} KB\n处理路径: 转换为 HTML、PDF、Markdown 或纯文本后继续读取与分析。`,
    metadata: {
      totalChars: stats,
      renderer: 'text',
      editableKind: 'read-only',
      warnings: ['office-binary-readonly'],
    },
    truncated: false,
  };
}

async function parseDOCX(filePath: string, mode: ParseMode): Promise<ParseResult> {
  const oversized = rejectOversized('docx', filePath);
  if (oversized) return oversized;

  try {
    const mammoth = await import('mammoth');
    const [htmlResult, textResult] = await Promise.all([
      mammoth.convertToHtml({ path: filePath }),
      mammoth.extractRawText({ path: filePath }),
    ]);
    const html = htmlResult.value || '';
    const plainText = textResult.value || stripHtml(html);
    const maxChars = mode === 'preview' ? PREVIEW_MAX_CHARS : FULL_MAX_CHARS;
    const rendered = truncate(html, maxChars * 2);
    const warnings = htmlResult.messages?.map(mammothMessageToString) ?? [];
    let officePreview: OfficePreviewModel | undefined;
    try {
      officePreview = await extractDocxPreviewModel(filePath);
    } catch (previewError) {
      warnings.push(`docx-office-preview-failed: ${warningMessage(previewError)}`);
    }
    return {
      format: 'docx',
      content: rendered.text,
      metadata: {
        renderer: 'html',
        editableKind: 'office-native',
        pages: officePreview?.stats.pageCount,
        officePreview,
        plainText: truncate(plainText, FULL_MAX_CHARS).text,
        wordCount: plainText.trim() ? plainText.trim().split(/\s+/).length : 0,
        totalChars: plainText.length,
        warnings,
      },
      truncated: rendered.truncated,
    };
  } catch (e) {
    return { format: 'docx', content: `DOCX 解析失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}

async function parsePPTX(filePath: string, mode: ParseMode): Promise<ParseResult> {
  const oversized = rejectOversized('pptx', filePath);
  if (oversized) return oversized;

  try {
    const officePreview = await extractPptxPreviewModel(filePath, { slideLimit: mode === 'preview' ? 12 : undefined });
    const slides: NonNullable<ParseResult['metadata']>['slides'] = [];
    const textLines: string[] = [];

    for (const page of officePreview.pages) {
      const textRuns = page.elements
        .filter((element) => PPTX_TEXT_ELEMENT_KINDS.has(element.kind) && element.text)
        .flatMap((element) => (element.text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean));
      const title = textRuns[0] || page.name || `Slide ${page.index}`;
      const bullets = textRuns.slice(1);
      const text = textRuns.join('\n');
      slides.push({ index: page.index, title, text, bullets });
      textLines.push(`# ${page.index}. ${title}`, ...bullets.map((line) => `- ${line}`), '');
    }

    const truncated = officePreview.warnings.includes(PPTX_PREVIEW_SLIDE_LIMIT_WARNING);
    return {
      format: 'pptx',
      content: textLines.join('\n').trim() || '[PPTX 未提取到可读文本，可能主要由图片或复杂嵌入对象构成。]',
      metadata: {
        pages: officePreview.stats.pageCount,
        slides,
        renderer: 'pptx-structure',
        editableKind: 'office-native',
        wordCount: textLines.join(' ').trim().split(/\s+/).filter(Boolean).length,
        officePreview,
        warnings: officePreview.warnings,
      },
      truncated,
    };
  } catch (e) {
    return { format: 'pptx', content: `PPTX 解析失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}

async function parseXLSX(filePath: string, mode: ParseMode, sheetName?: string): Promise<ParseResult> {
  try {
    const workbook = await readWorkbook(filePath);
    const sheets = workbookSheetNames(workbook);

    if (mode === 'sheet' && sheetName) {
      const ws = workbook.getWorksheet(sheetName);
      if (!ws) {
        return {
          format: 'xlsx',
          content: `Sheet "${sheetName}" 不存在。可用 sheets: ${sheets.join(', ')}`,
          metadata: {
            sheets,
            renderer: 'xlsx-table',
            editableKind: 'office-native',
            warnings: [`xlsx-sheet-not-found:${sheetName}`],
          },
          truncated: false,
        };
      }
      const csv = worksheetToCsv(ws);
      const { text, truncated } = truncate(csv, FULL_MAX_CHARS);
      return {
        format: 'xlsx',
        content: text,
        metadata: { sheets, renderer: 'xlsx-table', editableKind: 'office-native' },
        truncated,
      };
    }

    // preview：取第一个 sheet 前 N 行
    const ws = workbook.worksheets[0];
    const csv = ws ? worksheetToCsv(ws, mode === 'preview' ? 500 : Number.MAX_SAFE_INTEGER) : '';
    const { text, truncated } = truncate(csv, mode === 'preview' ? PREVIEW_MAX_CHARS : FULL_MAX_CHARS);
    return {
      format: 'xlsx',
      content: text,
      metadata: { sheets, renderer: 'xlsx-table', editableKind: 'office-native' },
      truncated,
    };
  } catch (e) {
    return { format: 'xlsx', content: `XLSX 解析失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}

async function parseCSV(filePath: string, mode: ParseMode): Promise<ParseResult> {
  try {
    if (mode === 'preview') {
      const preview = readTextPreview(filePath, PREVIEW_MAX_CHARS);
      return { format: 'csv', content: preview.content, metadata: { totalChars: preview.totalBytes }, truncated: preview.truncated };
    }
    const oversized = rejectOversized('csv', filePath);
    if (oversized) return oversized;
    const content = readFileSync(filePath, 'utf-8');
    const { text, truncated } = truncate(content, FULL_MAX_CHARS);
    return { format: 'csv', content: text, metadata: { totalChars: content.length }, truncated };
  } catch (e) {
    return { format: 'csv', content: `CSV 解析失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}

async function parseZIP(filePath: string): Promise<ParseResult> {
  const oversized = rejectOversized('zip', filePath);
  if (oversized) return oversized;

  try {
    const unzipper = await import('unzipper');
    const { createReadStream } = await import('fs');
    const entries: string[] = [];

    // 用 node:stream/promises pipeline:任一端出错都会销毁两端,避免 malformed ZIP 下源 createReadStream 的 fd 泄漏(#36)。
    const { pipeline } = await import('node:stream/promises');
    const parser = unzipper.Parse();
    parser.on('entry', (entry: unknown) => {
      if (isZipEntryLike(entry)) {
        if (typeof entry.path === 'string') entries.push(entry.path);
        entry.autodrain?.();
      }
    });
    await pipeline(createReadStream(filePath), parser);

    return {
      format: 'zip',
      content: `ZIP 文件包含 ${entries.length} 个条目:\n${entries.slice(0, 50).join('\n')}${entries.length > 50 ? '\n...(还有 ' + (entries.length - 50) + ' 个条目)' : ''}`,
      metadata: { entries },
      truncated: entries.length > 50,
    };
  } catch (e) {
    return { format: 'zip', content: `ZIP 解析失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}

async function parseText(filePath: string, mode: ParseMode, format = 'text'): Promise<ParseResult> {
  try {
    if (mode === 'preview') {
      const preview = readTextPreview(filePath, PREVIEW_MAX_CHARS);
      return { format, content: preview.content, metadata: { totalChars: preview.totalBytes }, truncated: preview.truncated };
    }

    const oversized = rejectOversized('text', filePath);
    if (oversized) return oversized;

    const content = readFileSync(filePath, 'utf-8');
    const { text, truncated } = truncate(content, FULL_MAX_CHARS);
    return { format, content: text, metadata: { totalChars: content.length }, truncated };
  } catch (e) {
    return { format, content: `文本读取失败: ${e instanceof Error ? e.message : String(e)}`, truncated: false };
  }
}

function parseImage(filePath: string): ParseResult {
  const format = detectFormat(filePath);
  const stats = existsSync(filePath) ? getFileSize(filePath) : 0;
  return {
    format,
    content: `[图片文件: ${basename(filePath)}]\n格式: ${format.toUpperCase()}\n大小: ${(stats / 1024).toFixed(1)} KB\n说明: 图片文件已作为附件上传，如需 OCR 文本识别请使用 screenshot 或 ocr 工具。`,
    truncated: false,
  };
}

function parseMedia(filePath: string, format: string): ParseResult {
  const stats = existsSync(filePath) ? getFileSize(filePath) : 0;
  return {
    format,
    content: `[媒体文件: ${basename(filePath)}]\n格式: ${format.toUpperCase()}\n大小: ${(stats / 1024).toFixed(1)} KB\n说明: 媒体文件已作为附件上传，暂不支持内容提取。`,
    truncated: false,
  };
}

// ========== 主入口 ==========

export async function parseFile(filePath: string, mode: ParseMode = 'preview', options?: { page?: number; sheet?: string }): Promise<ParseResult> {
  if (!existsSync(filePath)) {
    return { format: 'unknown', content: `文件不存在: ${filePath}`, truncated: false };
  }

  const format = detectFormat(filePath);

  switch (format) {
    case 'pdf':
      return parsePDF(filePath, mode, options?.page);
    case 'doc':
    case 'ppt':
      return parseUnsupportedOfficeFile(filePath, format);
    case 'docx':
      return parseDOCX(filePath, mode);
    case 'pptx':
      return parsePPTX(filePath, mode);
    case 'xlsx':
      return parseXLSX(filePath, mode, options?.sheet);
    case 'csv':
      return parseCSV(filePath, mode);
    case 'zip':
      return parseZIP(filePath);
    case 'png':
    case 'jpg':
    case 'webp':
    case 'gif':
    case 'bmp':
      return parseImage(filePath);
    case 'svg':
      // SVG 是文本格式，返回原始 XML 内容供前端内联渲染
      return parseText(filePath, mode, 'svg');
    case 'html':
      return parseText(filePath, mode, 'html');
    case 'markdown':
      return parseText(filePath, mode, 'markdown');
    case 'audio':
    case 'video':
      return parseMedia(filePath, format);
    default:
      return parseText(filePath, mode);
  }
}

export function parsePreview(filePath: string): Promise<ParseResult> {
  return parseFile(filePath, 'preview');
}

export function parseFull(filePath: string): Promise<ParseResult> {
  return parseFile(filePath, 'full');
}

export function parsePage(filePath: string, page: number): Promise<ParseResult> {
  return parseFile(filePath, 'page', { page });
}

export function parseSheet(filePath: string, sheetName: string): Promise<ParseResult> {
  return parseFile(filePath, 'sheet', { sheet: sheetName });
}
