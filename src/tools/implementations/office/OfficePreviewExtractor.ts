import { readFileSync } from 'fs';
import { posix } from 'path';
import JSZip from 'jszip';
import type {
  OfficePreviewAsset,
  OfficePreviewBBox,
  OfficePreviewElement,
  OfficePreviewModel,
  OfficePreviewPage,
  OfficePreviewSize,
  OfficePreviewStyle,
  OfficePreviewTableRow,
  OfficePreviewTheme,
} from './OfficePreviewModel.js';

const EMU_PER_INCH = 914400;
const TWIPS_PER_INCH = 1440;
const DEFAULT_PPTX_SIZE: OfficePreviewSize = { width: 13.333, height: 7.5, unit: 'in' };
const DEFAULT_DOCX_SIZE: OfficePreviewSize = { width: 8.5, height: 11, unit: 'in' };

interface Relationship {
  id: string;
  type?: string;
  target: string;
  targetMode?: string;
}

interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function emuToInch(value: string | undefined): number {
  const parsed = Number(value || 0);
  return round(parsed / EMU_PER_INCH);
}

function twipsToInch(value: string | undefined): number {
  const parsed = Number(value || 0);
  return round(parsed / TWIPS_PER_INCH);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeXmlText(value: string): string {
  return decodeXml(value).replace(/\s+/g, ' ').trim();
}

function attr(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`\\s${escaped}="([^"]*)"`, 'i'));
  return match ? decodeXml(match[1]) : undefined;
}

function prefixedAttr(source: string, localName: string): string | undefined {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`\\s(?:[A-Za-z0-9]+:)?${escaped}="([^"]*)"`, 'i'));
  return match ? decodeXml(match[1]) : undefined;
}

function cNvPrAttrs(xml: string): string {
  return xml.match(/<p:cNvPr\b([^>]*?)(?:\/>|>)/i)?.[1] || '';
}

function tagBlocks(xml: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(xml.matchAll(new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}>`, 'gi')), (match) => match[0]);
}

function firstTag(xml: string, tagName: string): string | undefined {
  return tagBlocks(xml, tagName)[0];
}

function stripXmlTags(value: string): string {
  return normalizeXmlText(value.replace(/<[^>]+>/g, ' '));
}

function textRuns(xml: string, tagName: 'a:t' | 'w:t' = 'a:t'): string[] {
  const escaped = tagName.replace(':', '\\:');
  return Array.from(xml.matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi')), (match) => normalizeXmlText(match[1]))
    .filter(Boolean);
}

function readRels(xml: string): Relationship[] {
  return Array.from(xml.matchAll(/<Relationship\b([^>]*?)\/>/gi), (match) => {
    const raw = match[1];
    return {
      id: attr(raw, 'Id') || '',
      type: attr(raw, 'Type'),
      target: attr(raw, 'Target') || '',
      targetMode: attr(raw, 'TargetMode'),
    };
  }).filter((relationship) => relationship.id && relationship.target);
}

function relMap(relationships: Relationship[]): Map<string, Relationship> {
  return new Map(relationships.map((relationship) => [relationship.id, relationship]));
}

async function zipText(zip: JSZip, entry: string): Promise<string | undefined> {
  const file = zip.file(entry);
  return file ? file.async('string') : undefined;
}

function resolveZipTarget(sourceDir: string, target: string): string {
  if (/^[a-z]+:/i.test(target) || target.startsWith('/')) {
    return target.replace(/^\//, '');
  }
  return posix.normalize(posix.join(sourceDir, target));
}

async function readContentTypes(zip: JSZip): Promise<ContentTypes> {
  const xml = await zipText(zip, '[Content_Types].xml');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (!xml) return { defaults, overrides };

  for (const match of xml.matchAll(/<Default\b([^>]*?)\/>/gi)) {
    const extension = attr(match[1], 'Extension')?.toLowerCase();
    const contentType = attr(match[1], 'ContentType');
    if (extension && contentType) defaults.set(extension, contentType);
  }
  for (const match of xml.matchAll(/<Override\b([^>]*?)\/>/gi)) {
    const partName = attr(match[1], 'PartName')?.replace(/^\//, '');
    const contentType = attr(match[1], 'ContentType');
    if (partName && contentType) overrides.set(partName, contentType);
  }
  return { defaults, overrides };
}

function contentTypeFor(path: string, contentTypes: ContentTypes): string | undefined {
  const normalized = path.replace(/^\//, '');
  const override = contentTypes.overrides.get(normalized);
  if (override) return override;
  const extension = normalized.split('.').pop()?.toLowerCase();
  return extension ? contentTypes.defaults.get(extension) : undefined;
}

function assetKind(type: string | undefined, target: string): OfficePreviewAsset['kind'] {
  if (type?.includes('/image') || /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(target)) return 'image';
  if (type?.includes('/media') || /\.(mp4|mov|mp3|wav)$/i.test(target)) return 'media';
  if (type?.includes('/oleObject')) return 'ole';
  if (/^https?:\/\//i.test(target)) return 'external';
  return 'unknown';
}

function bboxFromXml(xml: string): OfficePreviewBBox | undefined {
  const off = xml.match(/<a:off\b([^>]*?)\/>/i)?.[1];
  const ext = xml.match(/<a:ext\b([^>]*?)\/>/i)?.[1];
  if (!off || !ext) return undefined;
  return {
    x: emuToInch(attr(off, 'x')),
    y: emuToInch(attr(off, 'y')),
    w: emuToInch(attr(ext, 'cx')),
    h: emuToInch(attr(ext, 'cy')),
    unit: 'in',
  };
}

function pptxShapeStyle(xml: string): OfficePreviewStyle {
  const rPr = xml.match(/<a:rPr\b([^>]*)/i)?.[1] || '';
  const latin = xml.match(/<a:latin\b([^>]*?)\/>/i)?.[1] || '';
  const srgb = xml.match(/<a:srgbClr\b([^>]*?)\/>/i)?.[1] || '';
  const solidFill = firstTag(xml, 'a:solidFill') || '';
  const prstGeom = xml.match(/<a:prstGeom\b([^>]*?)>/i)?.[1] || '';
  const fontSize = attr(rPr, 'sz');
  return {
    fontFace: attr(latin, 'typeface'),
    fontSizePt: fontSize ? Number(fontSize) / 100 : undefined,
    bold: attr(rPr, 'b') === '1',
    italic: attr(rPr, 'i') === '1',
    color: attr(srgb, 'val'),
    fillColor: attr(solidFill, 'val') || attr(solidFill.match(/<a:srgbClr\b([^>]*?)\/>/i)?.[1] || '', 'val'),
    lineColor: attr(xml.match(/<a:ln\b[\s\S]*?<a:srgbClr\b([^>]*?)\/>/i)?.[1] || '', 'val'),
    paragraphStyle: attr(prstGeom, 'prst'),
  };
}

function pptxShapeElement(xml: string, slideIndex: number, shapeIndex: number): OfficePreviewElement {
  const cNvPr = cNvPrAttrs(xml);
  const sourceId = attr(cNvPr, 'id') || `${shapeIndex}`;
  const text = textRuns(xml, 'a:t').join('\n');
  const placeholder = xml.match(/<p:ph\b([^>]*?)\/>/i)?.[1] || '';
  return {
    id: `pptx-s${slideIndex}-el${shapeIndex}`,
    sourceId,
    kind: text ? 'text' : 'shape',
    name: attr(cNvPr, 'name'),
    text,
    bbox: bboxFromXml(xml),
    style: pptxShapeStyle(xml),
    metadata: {
      placeholderType: attr(placeholder, 'type'),
      rawKind: 'p:sp',
    },
  };
}

function pptxPictureElement(xml: string, slideIndex: number, elementIndex: number, relationships: Map<string, Relationship>, contentTypes: ContentTypes): {
  element: OfficePreviewElement;
  asset?: OfficePreviewAsset;
} {
  const cNvPr = cNvPrAttrs(xml);
  const blip = xml.match(/<a:blip\b([^>]*?)\/?>/i)?.[1] || '';
  const relationshipId = attr(blip, 'r:embed') || attr(blip, 'r:link');
  const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
  const resolved = relationship ? resolveZipTarget('ppt/slides', relationship.target) : undefined;
  const contentType = resolved ? contentTypeFor(resolved, contentTypes) : undefined;
  const asset = relationshipId && resolved ? {
    id: `pptx-s${slideIndex}-asset-${relationshipId}`,
    relationshipId,
    kind: assetKind(relationship?.type, resolved),
    path: resolved,
    target: relationship?.target,
    contentType,
    extension: resolved.split('.').pop()?.toLowerCase(),
  } satisfies OfficePreviewAsset : undefined;

  return {
    asset,
    element: {
      id: `pptx-s${slideIndex}-el${elementIndex}`,
      sourceId: attr(cNvPr, 'id') || `${elementIndex}`,
      kind: 'image',
      name: attr(cNvPr, 'name'),
      bbox: bboxFromXml(xml),
      relationshipId,
      assetId: asset?.id,
      metadata: { rawKind: 'p:pic' },
    },
  };
}

function pptxTableRows(xml: string): OfficePreviewTableRow[] {
  return tagBlocks(xml, 'a:tr').map((rowXml, rowIndex) => ({
    id: `row-${rowIndex + 1}`,
    cells: tagBlocks(rowXml, 'a:tc').map((cellXml, cellIndex) => ({
      id: `cell-${rowIndex + 1}-${cellIndex + 1}`,
      text: textRuns(cellXml, 'a:t').join('\n'),
      rowSpan: Number(attr(cellXml.match(/<a:tc\b([^>]*)/i)?.[1] || '', 'rowSpan') || 1),
      colSpan: Number(attr(cellXml.match(/<a:tc\b([^>]*)/i)?.[1] || '', 'gridSpan') || 1),
    })),
  }));
}

function pptxTableElement(xml: string, slideIndex: number, elementIndex: number): OfficePreviewElement {
  const cNvPr = cNvPrAttrs(xml);
  return {
    id: `pptx-s${slideIndex}-el${elementIndex}`,
    sourceId: attr(cNvPr, 'id') || `${elementIndex}`,
    kind: 'table',
    name: attr(cNvPr, 'name'),
    text: textRuns(xml, 'a:t').join('\n'),
    bbox: bboxFromXml(xml),
    rows: pptxTableRows(xml),
    metadata: { rawKind: 'p:graphicFrame' },
  };
}

async function extractPptxTheme(zip: JSZip): Promise<OfficePreviewTheme> {
  const themeEntry = Object.keys(zip.files).find((name) => /^ppt\/theme\/theme\d+\.xml$/i.test(name));
  const xml = themeEntry ? await zipText(zip, themeEntry) : undefined;
  if (!xml) return {};
  const themeAttrs = xml.match(/<a:theme\b([^>]*)/i)?.[1] || '';
  const major = firstTag(xml, 'a:majorFont') || '';
  const minor = firstTag(xml, 'a:minorFont') || '';
  return {
    name: attr(themeAttrs, 'name'),
    majorFontFace: attr(major.match(/<a:latin\b([^>]*?)\/>/i)?.[1] || '', 'typeface'),
    minorFontFace: attr(minor.match(/<a:latin\b([^>]*?)\/>/i)?.[1] || '', 'typeface'),
  };
}

async function pptxSlidePaths(zip: JSZip): Promise<string[]> {
  const presentationXml = await zipText(zip, 'ppt/presentation.xml');
  const presentationRelsXml = await zipText(zip, 'ppt/_rels/presentation.xml.rels');
  if (presentationXml && presentationRelsXml) {
    const relationships = relMap(readRels(presentationRelsXml));
    const ordered = Array.from(presentationXml.matchAll(/<p:sldId\b([^>]*?)\/>/gi))
      .map((match) => attr(match[1], 'r:id'))
      .map((id) => id ? relationships.get(id) : undefined)
      .map((relationship) => relationship ? resolveZipTarget('ppt', relationship.target) : undefined)
      .filter((path): path is string => Boolean(path && zip.file(path)));
    if (ordered.length) return ordered;
  }
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0));
}

async function pptxPageSize(zip: JSZip): Promise<OfficePreviewSize> {
  const xml = await zipText(zip, 'ppt/presentation.xml');
  const sldSz = xml?.match(/<p:sldSz\b([^>]*?)\/>/i)?.[1];
  if (!sldSz) return DEFAULT_PPTX_SIZE;
  const width = emuToInch(attr(sldSz, 'cx'));
  const height = emuToInch(attr(sldSz, 'cy'));
  return width > 0 && height > 0 ? { width, height, unit: 'in' } : DEFAULT_PPTX_SIZE;
}

export async function extractPptxPreviewModel(filePath: string, options: { slideLimit?: number } = {}): Promise<OfficePreviewModel> {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const contentTypes = await readContentTypes(zip);
  const pageSize = await pptxPageSize(zip);
  const theme = await extractPptxTheme(zip);
  const slidePaths = await pptxSlidePaths(zip);
  const pages: OfficePreviewPage[] = [];
  const assets: OfficePreviewAsset[] = [];
  const warnings: string[] = [];
  const slideLimit = options.slideLimit && options.slideLimit > 0 ? Math.min(options.slideLimit, slidePaths.length) : slidePaths.length;
  if (slideLimit < slidePaths.length) warnings.push('pptx-preview-slide-limit');

  for (const [slideOffset, slidePath] of slidePaths.slice(0, slideLimit).entries()) {
    const slideIndex = slideOffset + 1;
    const slideXml = await zipText(zip, slidePath);
    if (!slideXml) continue;

    const relPath = `ppt/slides/_rels/${posix.basename(slidePath)}.rels`;
    const relationships = relMap(readRels(await zipText(zip, relPath) || ''));
    const elements: OfficePreviewElement[] = [];
    let elementIndex = 1;

    for (const shapeXml of tagBlocks(slideXml, 'p:sp')) {
      elements.push(pptxShapeElement(shapeXml, slideIndex, elementIndex++));
    }
    for (const picXml of tagBlocks(slideXml, 'p:pic')) {
      const { element, asset } = pptxPictureElement(picXml, slideIndex, elementIndex++, relationships, contentTypes);
      elements.push(element);
      if (asset) assets.push(asset);
    }
    for (const frameXml of tagBlocks(slideXml, 'p:graphicFrame')) {
      if (/<a:tbl\b/i.test(frameXml)) {
        elements.push(pptxTableElement(frameXml, slideIndex, elementIndex++));
      }
    }

    const title = elements.find((element) => element.kind === 'text' && element.text)?.text?.split('\n')[0];
    pages.push({
      id: `pptx-slide-${slideIndex}`,
      index: slideIndex,
      name: title || `Slide ${slideIndex}`,
      entryPath: slidePath,
      size: pageSize,
      elements,
    });
  }

  return buildModel('pptx', pageSize, theme, pages, assets, warnings, slidePaths.length);
}

function docxPageSizeFromXml(documentXml: string): OfficePreviewSize {
  const pgSz = documentXml.match(/<w:pgSz\b([^>]*?)\/>/i)?.[1];
  if (!pgSz) return DEFAULT_DOCX_SIZE;
  const width = twipsToInch(attr(pgSz, 'w:w') || prefixedAttr(pgSz, 'w'));
  const height = twipsToInch(attr(pgSz, 'w:h') || prefixedAttr(pgSz, 'h'));
  return width > 0 && height > 0 ? { width, height, unit: 'in' } : DEFAULT_DOCX_SIZE;
}

async function extractDocxTheme(zip: JSZip): Promise<OfficePreviewTheme> {
  const themeEntry = Object.keys(zip.files).find((name) => /^word\/theme\/theme\d+\.xml$/i.test(name));
  const themeXml = themeEntry ? await zipText(zip, themeEntry) : undefined;
  const stylesXml = await zipText(zip, 'word/styles.xml');
  const theme: OfficePreviewTheme = {};
  if (themeXml) {
    const major = firstTag(themeXml, 'a:majorFont') || '';
    const minor = firstTag(themeXml, 'a:minorFont') || '';
    theme.majorFontFace = attr(major.match(/<a:latin\b([^>]*?)\/>/i)?.[1] || '', 'typeface');
    theme.minorFontFace = attr(minor.match(/<a:latin\b([^>]*?)\/>/i)?.[1] || '', 'typeface');
    theme.name = attr(themeXml.match(/<a:theme\b([^>]*)/i)?.[1] || '', 'name');
  }
  const rFonts = stylesXml?.match(/<w:rFonts\b([^>]*?)\/>/i)?.[1];
  if (rFonts) {
    theme.defaultFontFace = attr(rFonts, 'w:ascii') || attr(rFonts, 'w:eastAsia') || prefixedAttr(rFonts, 'ascii');
  }
  return theme;
}

function docxParagraphStyle(xml: string): OfficePreviewStyle {
  const pPr = firstTag(xml, 'w:pPr') || '';
  const rPr = firstTag(xml, 'w:rPr') || '';
  const pStyle = pPr.match(/<w:pStyle\b([^>]*?)\/>/i)?.[1] || '';
  const jc = pPr.match(/<w:jc\b([^>]*?)\/>/i)?.[1] || '';
  const sz = rPr.match(/<w:sz\b([^>]*?)\/>/i)?.[1] || '';
  const color = rPr.match(/<w:color\b([^>]*?)\/>/i)?.[1] || '';
  const rFonts = rPr.match(/<w:rFonts\b([^>]*?)\/>/i)?.[1] || '';
  const fontSize = attr(sz, 'w:val') || prefixedAttr(sz, 'val');
  return {
    paragraphStyle: attr(pStyle, 'w:val') || prefixedAttr(pStyle, 'val'),
    align: attr(jc, 'w:val') || prefixedAttr(jc, 'val'),
    fontFace: attr(rFonts, 'w:ascii') || attr(rFonts, 'w:eastAsia') || prefixedAttr(rFonts, 'ascii'),
    fontSizePt: fontSize ? Number(fontSize) / 2 : undefined,
    bold: /<w:b\b/i.test(rPr),
    italic: /<w:i\b/i.test(rPr),
    color: attr(color, 'w:val') || prefixedAttr(color, 'val'),
  };
}

function docxImageElements(xml: string, pageIndex: number, paragraphIndex: number, relationships: Map<string, Relationship>, contentTypes: ContentTypes): {
  elements: OfficePreviewElement[];
  assets: OfficePreviewAsset[];
} {
  const elements: OfficePreviewElement[] = [];
  const assets: OfficePreviewAsset[] = [];
  let drawingIndex = 1;
  for (const drawingXml of tagBlocks(xml, 'w:drawing')) {
    const blip = drawingXml.match(/<a:blip\b([^>]*?)\/?>/i)?.[1] || '';
    const extent = drawingXml.match(/<wp:extent\b([^>]*?)\/>/i)?.[1] || '';
    const docPr = drawingXml.match(/<wp:docPr\b([^>]*?)\/>/i)?.[1] || '';
    const relationshipId = attr(blip, 'r:embed') || attr(blip, 'r:link');
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    const resolved = relationship ? resolveZipTarget('word', relationship.target) : undefined;
    const contentType = resolved ? contentTypeFor(resolved, contentTypes) : undefined;
    const asset = relationshipId && resolved ? {
      id: `docx-p${pageIndex}-asset-${relationshipId}`,
      relationshipId,
      kind: assetKind(relationship?.type, resolved),
      path: resolved,
      target: relationship?.target,
      contentType,
      extension: resolved.split('.').pop()?.toLowerCase(),
    } satisfies OfficePreviewAsset : undefined;
    if (asset) assets.push(asset);
    elements.push({
      id: `docx-page${pageIndex}-p${paragraphIndex}-drawing${drawingIndex}`,
      sourceId: attr(docPr, 'id') || `${drawingIndex}`,
      kind: 'drawing',
      name: attr(docPr, 'name'),
      relationshipId,
      assetId: asset?.id,
      bbox: extent ? { x: 0, y: 0, w: emuToInch(attr(extent, 'cx')), h: emuToInch(attr(extent, 'cy')), unit: 'in' } : undefined,
      metadata: { layout: 'inline' },
    });
    drawingIndex++;
  }
  return { elements, assets };
}

function docxParagraphElement(xml: string, pageIndex: number, paragraphIndex: number, relationships: Map<string, Relationship>, contentTypes: ContentTypes): {
  element: OfficePreviewElement;
  assets: OfficePreviewAsset[];
} {
  const drawingResult = docxImageElements(xml, pageIndex, paragraphIndex, relationships, contentTypes);
  const text = textRuns(xml, 'w:t').join('');
  return {
    assets: drawingResult.assets,
    element: {
      id: `docx-page${pageIndex}-p${paragraphIndex}`,
      kind: text ? 'paragraph' : drawingResult.elements.length ? 'drawing' : 'paragraph',
      text,
      style: docxParagraphStyle(xml),
      children: drawingResult.elements.length ? drawingResult.elements : undefined,
      metadata: {
        layout: 'flow',
        hasPageBreakAfter: /<w:br\b[^>]*w:type="page"/i.test(xml) || /<w:lastRenderedPageBreak\b/i.test(xml),
      },
    },
  };
}

function docxTableElement(xml: string, pageIndex: number, tableIndex: number): OfficePreviewElement {
  const rows: OfficePreviewTableRow[] = tagBlocks(xml, 'w:tr').map((rowXml, rowIndex) => ({
    id: `row-${rowIndex + 1}`,
    cells: tagBlocks(rowXml, 'w:tc').map((cellXml, cellIndex) => {
      const tcPr = firstTag(cellXml, 'w:tcPr') || '';
      const gridSpan = tcPr.match(/<w:gridSpan\b([^>]*?)\/>/i)?.[1] || '';
      const vMerge = tcPr.match(/<w:vMerge\b([^>]*?)\/>/i)?.[1] || '';
      return {
        id: `cell-${rowIndex + 1}-${cellIndex + 1}`,
        text: textRuns(cellXml, 'w:t').join(' '),
        colSpan: Number(attr(gridSpan, 'w:val') || prefixedAttr(gridSpan, 'val') || 1),
        rowSpan: vMerge ? 0 : 1,
      };
    }),
  }));
  return {
    id: `docx-page${pageIndex}-table${tableIndex}`,
    kind: 'table',
    text: rows.flatMap((row) => row.cells.map((cell) => cell.text)).filter(Boolean).join('\n'),
    rows,
    metadata: { layout: 'flow' },
  };
}

function bodyBlocks(documentXml: string): Array<{ kind: 'p' | 'tbl'; xml: string }> {
  const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i)?.[1] || documentXml;
  return Array.from(body.matchAll(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/gi), (match) => ({
    kind: match[1] as 'p' | 'tbl',
    xml: match[0],
  }));
}

export async function extractDocxPreviewModel(filePath: string): Promise<OfficePreviewModel> {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const documentXml = await zipText(zip, 'word/document.xml');
  if (!documentXml) {
    throw new Error('DOCX missing word/document.xml');
  }
  const contentTypes = await readContentTypes(zip);
  const relationships = relMap(readRels(await zipText(zip, 'word/_rels/document.xml.rels') || ''));
  const pageSize = docxPageSizeFromXml(documentXml);
  const theme = await extractDocxTheme(zip);
  const pages: OfficePreviewPage[] = [{ id: 'docx-page-1', index: 1, size: pageSize, elements: [], metadata: { layout: 'flow' } }];
  const assets: OfficePreviewAsset[] = [];
  let pageIndex = 1;
  let paragraphIndex = 1;
  let tableIndex = 1;

  for (const block of bodyBlocks(documentXml)) {
    const currentPage = pages[pages.length - 1];
    if (block.kind === 'tbl') {
      currentPage.elements.push(docxTableElement(block.xml, pageIndex, tableIndex++));
      continue;
    }

    const { element, assets: paragraphAssets } = docxParagraphElement(block.xml, pageIndex, paragraphIndex++, relationships, contentTypes);
    currentPage.elements.push(element);
    assets.push(...paragraphAssets);
    if (element.metadata?.hasPageBreakAfter) {
      pageIndex++;
      pages.push({ id: `docx-page-${pageIndex}`, index: pageIndex, size: pageSize, elements: [], metadata: { layout: 'flow' } });
    }
  }

  return buildModel('docx', pageSize, theme, pages, assets, []);
}

function buildModel(
  kind: 'pptx' | 'docx',
  pageSize: OfficePreviewSize,
  theme: OfficePreviewTheme,
  pages: OfficePreviewPage[],
  assets: OfficePreviewAsset[],
  warnings: string[],
  pageCount = pages.length,
): OfficePreviewModel {
  const elements = pages.flatMap((page) => page.elements);
  return {
    schema: 'lingxiao.office.preview.v1',
    kind,
    renderer: 'office-preview-structure',
    pageSize,
    theme,
    pages,
    assets,
    warnings,
    stats: {
      pageCount,
      elementCount: elements.length,
      textElementCount: elements.filter((element) => ['text', 'paragraph'].includes(element.kind) && element.text).length,
      imageCount: assets.filter((asset) => asset.kind === 'image').length,
      tableCount: elements.filter((element) => element.kind === 'table').length,
    },
  };
}
