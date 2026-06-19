import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { tmpdir } from 'os';
import { basename, extname, join, posix as pathPosix } from 'path';
import JSZip from 'jszip';
import { detectFormat, parseFile } from '../FileParser.js';
import { hiddenSpawnOpts, resolveCommandPath } from '../../../utils/platform.js';

export type OfficeValidationFormat = 'docx' | 'pptx' | 'pdf' | 'unknown';

export interface OfficeValidationOptions {
  path: string;
  format?: OfficeValidationFormat | 'auto';
  expectedTexts?: string[];
  expectedSlideCount?: number;
  expectedPageCount?: number;
  minPages?: number;
  expectedNativeComments?: number;
  expectedTrackedRevisions?: number;
  expectedChartCount?: number;
  requireAnimationPlan?: boolean;
  requireSlideMaster?: boolean;
  openCheck?: boolean;
  openCheckApps?: Array<'libreoffice' | 'wps' | 'powerpoint'>;
}

export interface OfficeValidationCheck {
  name: string;
  valid: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface OfficeValidationResult {
  valid: boolean;
  format: OfficeValidationFormat;
  checks: OfficeValidationCheck[];
  errors: string[];
  warnings: string[];
  summary: string;
}

interface Relationship {
  id?: string;
  type?: string;
  target?: string;
  targetMode?: string;
}

const IMAGE_RELATIONSHIP = /\/relationships\/image$/i;
const CHART_RELATIONSHIP = /\/relationships\/chart$/i;
const SLIDE_LAYOUT_RELATIONSHIP = /\/relationships\/slideLayout$/i;
const SLIDE_MASTER_RELATIONSHIP = /\/relationships\/slideMaster$/i;
const OPEN_CHECK_TIMEOUT_MS = 30000;
const OUTPUT_SUMMARY_LIMIT = 2000;

type OpenCheckApp = NonNullable<OfficeValidationOptions['openCheckApps']>[number];
type OpenCheckStatus = 'executed' | 'skipped' | 'warning';

interface CommandRun {
  executable: string;
  args: string[];
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutSummary: string;
  stderrSummary: string;
  elapsedMs: number;
  timedOut: boolean;
  error?: string;
}

export async function validateOfficeFile(options: OfficeValidationOptions): Promise<OfficeValidationResult> {
  const result = createResult('unknown');
  const filePath = options.path;
  const requestedFormat = options.format && options.format !== 'auto' ? options.format : undefined;
  result.format = requestedFormat ?? normalizeFormat(detectFormat(filePath), filePath);

  if (!existsSync(filePath)) {
    addCheck(result, 'file_exists', false, 'File does not exist.', { path: filePath });
    finish(result);
    return result;
  }

  const stats = statSync(filePath);
  addCheck(result, 'file_exists', true, 'File exists.', { path: filePath, bytes: stats.size });

  const detectedFormat = normalizeFormat(detectFormat(filePath), filePath);
  result.format = requestedFormat ?? detectedFormat;

  if (requestedFormat && detectedFormat !== 'unknown' && requestedFormat !== detectedFormat) {
    addCheck(result, 'format_matches', false, `Requested ${requestedFormat}, detected ${detectedFormat}.`, {
      requested: requestedFormat,
      detected: detectedFormat,
    });
  } else {
    addCheck(result, 'format_detected', result.format !== 'unknown', `Detected format: ${result.format}.`, {
      requested: requestedFormat ?? 'auto',
      detected: detectedFormat,
    });
  }

  if (result.format === 'docx') {
    await validateDocx(filePath, options, result);
  } else if (result.format === 'pptx') {
    await validatePptx(filePath, options, result);
  } else if (result.format === 'pdf') {
    await validatePdf(filePath, options, result);
  } else {
    addCheck(result, 'supported_format', false, 'Only DOCX, PPTX, and PDF are supported.', {
      detected: detectedFormat,
      extension: extname(filePath).toLowerCase(),
    });
  }

  if (options.openCheck) {
    validateOpenMatrix(filePath, result, options);
  }

  finish(result);
  return result;
}

async function validateDocx(filePath: string, options: OfficeValidationOptions, result: OfficeValidationResult): Promise<void> {
  const zip = await loadZip(filePath, result);
  if (!zip) return;

  validateOoxmlBasics(zip, result, 'word/document.xml');

  const documentXml = await readZipText(zip, 'word/document.xml');
  if (!documentXml) return;

  const text = extractWordText(documentXml);
  if (text.length === 0) {
    result.warnings.push('DOCX document.xml contains no extractable w:t text; structural checks still ran.');
  }
  addCheck(result, 'docx_text_extractable', true, text.length > 0 ? 'DOCX text was extracted.' : 'DOCX has no extractable document text.', {
    characters: text.length,
  });
  validateExpectedTexts(result, text, options.expectedTexts, 'expected_texts');

  const imageRelCheck = await validateImageRelationships(zip, result, 'word/document.xml', 'docx_media_relationships');
  const hasEmbeddedImageRef = /r:embed="[^"]+"/.test(documentXml) || /r:link="[^"]+"/.test(documentXml);
  if (hasEmbeddedImageRef && imageRelCheck.total === 0) {
    addCheck(result, 'docx_media_rels_present', false, 'Document contains image references but no image relationships were found.');
  } else {
    addCheck(result, 'docx_media_rels_present', true, 'DOCX media relationship presence is coherent.', {
      imageRelationships: imageRelCheck.total,
      embeddedImageReferences: hasEmbeddedImageRef,
    });
  }

  const commentsXml = await readZipText(zip, 'word/comments.xml');
  const nativeComments = commentsXml ? Array.from(commentsXml.matchAll(/<w:comment\b/g)).length : 0;
  const commentAnchors = {
    rangeStart: Array.from(documentXml.matchAll(/<w:commentRangeStart\b/g)).length,
    rangeEnd: Array.from(documentXml.matchAll(/<w:commentRangeEnd\b/g)).length,
    references: Array.from(documentXml.matchAll(/<w:commentReference\b/g)).length,
  };
  addCheck(
    result,
    'docx_native_comments',
    options.expectedNativeComments === undefined || nativeComments >= options.expectedNativeComments,
    options.expectedNativeComments === undefined
      ? `DOCX contains ${nativeComments} native comment(s).`
      : `DOCX contains ${nativeComments} native comment(s), expected at least ${options.expectedNativeComments}.`,
    { nativeComments, expectedNativeComments: options.expectedNativeComments },
  );
  addCheck(
    result,
    'docx_native_comment_anchors',
    nativeComments === 0 || (commentAnchors.rangeStart >= nativeComments && commentAnchors.rangeEnd >= nativeComments && commentAnchors.references >= nativeComments),
    nativeComments === 0
      ? 'DOCX has no native comments to anchor.'
      : `DOCX comment anchors: ${commentAnchors.rangeStart} start, ${commentAnchors.rangeEnd} end, ${commentAnchors.references} reference marker(s).`,
    { nativeComments, ...commentAnchors },
  );
  await validateDocxCommentsPackage(zip, result, nativeComments, options.expectedNativeComments);

  const insertedRevisions = Array.from(documentXml.matchAll(/<w:ins\b/g)).length;
  const deletedRevisions = Array.from(documentXml.matchAll(/<w:del\b/g)).length;
  const trackedRevisions = insertedRevisions + deletedRevisions;
  const settingsXml = await readZipText(zip, 'word/settings.xml');
  const trackRevisionsEnabled = /<w:trackRevisions\b/i.test(settingsXml || '');
  addCheck(
    result,
    'docx_tracked_revisions',
    options.expectedTrackedRevisions === undefined || trackedRevisions >= options.expectedTrackedRevisions,
    options.expectedTrackedRevisions === undefined
      ? `DOCX contains ${trackedRevisions} tracked revision marker(s).`
      : `DOCX contains ${trackedRevisions} tracked revision marker(s), expected at least ${options.expectedTrackedRevisions}.`,
    { trackedRevisions, insertedRevisions, deletedRevisions, expectedTrackedRevisions: options.expectedTrackedRevisions },
  );
  addCheck(
    result,
    'docx_track_revisions_enabled',
    trackedRevisions === 0 || trackRevisionsEnabled,
    trackRevisionsEnabled
      ? 'DOCX has w:trackRevisions enabled in settings.xml.'
      : trackedRevisions === 0
        ? 'DOCX has no tracked revisions that require w:trackRevisions.'
        : 'DOCX has tracked revision markers but w:trackRevisions is not enabled.',
    { trackedRevisions, trackRevisionsEnabled, hasSettingsXml: Boolean(settingsXml) },
  );
  addCheck(
    result,
    'docx_revision_balance',
    trackedRevisions === 0 || (insertedRevisions > 0 && deletedRevisions > 0),
    trackedRevisions === 0
      ? 'DOCX has no tracked revision markers.'
      : `DOCX revisions include ${insertedRevisions} insertion marker(s) and ${deletedRevisions} deletion marker(s).`,
    { insertedRevisions, deletedRevisions },
  );
}

async function validateDocxCommentsPackage(
  zip: JSZip,
  result: OfficeValidationResult,
  nativeComments: number,
  expectedNativeComments: number | undefined,
): Promise<void> {
  const contentTypes = await readZipText(zip, '[Content_Types].xml');
  const hasContentType = Boolean(contentTypes?.includes('PartName="/word/comments.xml"'));
  addCheck(
    result,
    'docx_comments_content_type',
    nativeComments === 0 && expectedNativeComments === undefined ? true : hasContentType,
    hasContentType
      ? 'DOCX comments content type override is present.'
      : nativeComments === 0 && expectedNativeComments === undefined
        ? 'DOCX has no native comments that require a comments content type override.'
        : 'DOCX comments.xml is missing its content type override.',
    { nativeComments, expectedNativeComments, hasContentType },
  );

  const relXml = await readZipText(zip, relationshipsPathForPart('word/document.xml'));
  const commentRels = relXml
    ? parseRelationships(relXml).filter((rel) => rel.type?.endsWith('/relationships/comments'))
    : [];
  const targets = commentRels
    .map((rel) => rel.target ? resolveRelationshipTarget('word/document.xml', rel.target) : null)
    .filter((target): target is string => Boolean(target));
  const missing = targets.filter((target) => !zip.file(target));
  addCheck(
    result,
    'docx_comments_relationship',
    nativeComments === 0 && expectedNativeComments === undefined ? true : commentRels.length > 0 && missing.length === 0,
    commentRels.length > 0 && missing.length === 0
      ? 'DOCX comments relationship target is present.'
      : nativeComments === 0 && expectedNativeComments === undefined
        ? 'DOCX has no native comments that require a comments relationship.'
        : 'DOCX comments relationship is missing or points to a missing target.',
    { nativeComments, expectedNativeComments, relationshipCount: commentRels.length, targets, missing },
  );
}

async function validatePptx(filePath: string, options: OfficeValidationOptions, result: OfficeValidationResult): Promise<void> {
  const zip = await loadZip(filePath, result);
  if (!zip) return;

  validateOoxmlBasics(zip, result, 'ppt/presentation.xml');

  const slideEntries = getSlideEntries(zip);
  const expected = options.expectedSlideCount;
  addCheck(
    result,
    'pptx_slide_count',
    slideEntries.length > 0 && (expected === undefined || slideEntries.length === expected),
    expected === undefined
      ? `PPTX contains ${slideEntries.length} slide(s).`
      : `PPTX contains ${slideEntries.length} slide(s), expected ${expected}.`,
    { slideCount: slideEntries.length, expectedSlideCount: expected },
  );

  const texts: string[] = [];
  for (const entry of slideEntries) {
    const xml = await readZipText(zip, entry);
    if (xml) texts.push(extractDrawingText(xml));
    await validateImageRelationships(zip, result, entry, `pptx_${basename(entry, '.xml')}_image_relationships`);
  }
  validateExpectedTexts(result, texts.join('\n'), options.expectedTexts, 'expected_texts');

  const chartEntries = Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/i.test(name) && !zip.files[name].dir);
  addCheck(
    result,
    'pptx_chart_count',
    options.expectedChartCount === undefined || chartEntries.length >= options.expectedChartCount,
    options.expectedChartCount === undefined
      ? `PPTX contains ${chartEntries.length} chart part(s).`
      : `PPTX contains ${chartEntries.length} chart part(s), expected at least ${options.expectedChartCount}.`,
    { chartCount: chartEntries.length, expectedChartCount: options.expectedChartCount, chartEntries },
  );

  const slideMasters = Object.keys(zip.files).filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(name) && !zip.files[name].dir);
  addCheck(
    result,
    'pptx_slide_master',
    !options.requireSlideMaster || slideMasters.length > 0,
    slideMasters.length > 0 ? `PPTX contains ${slideMasters.length} slide master part(s).` : 'PPTX contains no slide master part.',
    { slideMasterCount: slideMasters.length, required: options.requireSlideMaster === true },
  );

  await validatePptxStructureRelationships(zip, result, slideEntries);

  const nativeTiming = await findNativeTiming(zip, slideEntries);
  addCheck(
    result,
    'pptx_native_timing',
    nativeTiming.totalTargets > 0 || !options.requireAnimationPlan,
    nativeTiming.totalTargets > 0
      ? `PPTX contains native p:timing on ${nativeTiming.slides.length} slide(s).`
      : 'PPTX contains no native p:timing animation targets.',
    { ...nativeTiming, requiredWhenAnimationPlanRequired: options.requireAnimationPlan === true },
  );

  const animationPart = await findAnimationPlan(zip);
  const hasAnimation = Boolean(animationPart) || nativeTiming.totalTargets > 0;
  addCheck(
    result,
    'pptx_animation_plan',
    !options.requireAnimationPlan || hasAnimation,
    animationPart
      ? `PPTX contains LingXiao animation plan at ${animationPart}.`
      : nativeTiming.totalTargets > 0
        ? 'PPTX contains native p:timing animation data.'
        : 'PPTX contains no LingXiao animation plan or native p:timing animation data.',
    { animationPart, nativeTimingTargets: nativeTiming.totalTargets, required: options.requireAnimationPlan === true },
  );
}

async function validatePdf(filePath: string, options: OfficeValidationOptions, result: OfficeValidationResult): Promise<void> {
  const buffer = readFileSync(filePath);
  const hasHeader = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  addCheck(result, 'pdf_header', hasHeader, hasHeader ? 'PDF header is present.' : 'PDF header is missing.', {
    header: buffer.subarray(0, 8).toString('latin1'),
  });

  let parserText = '';
  let parserPages: number | undefined;
  let hasTextLayer: boolean | undefined;
  try {
    const parsed = await parseFile(filePath, 'full');
    parserText = parsed.metadata?.plainText || parsed.content || '';
    parserPages = parsed.metadata?.pages;
    hasTextLayer = parsed.metadata?.hasTextLayer;
    if (parsed.content.startsWith('PDF 解析失败')) {
      result.warnings.push(`PDF parser could not extract text/page metadata: ${parsed.content}`);
    }
  } catch (error) {
    result.warnings.push(`PDF parser failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const roughPages = parserPages || countPdfPageObjects(buffer);
  const pageValid = roughPages > 0
    && (options.expectedPageCount === undefined || roughPages === options.expectedPageCount)
    && (options.minPages === undefined || roughPages >= options.minPages);
  addCheck(result, 'pdf_page_count', pageValid, `PDF rough page count is ${roughPages}.`, {
    pages: roughPages,
    expectedPageCount: options.expectedPageCount,
    minPages: options.minPages,
    source: parserPages ? 'parser' : 'page-object-scan',
  });

  if (options.expectedTexts?.length) {
    const canVerifyText = hasTextLayer === true || (parserText.trim().length > 0 && !parserText.includes('未检测到文本层'));
    if (canVerifyText) {
      validateExpectedTexts(result, parserText, options.expectedTexts, 'expected_texts');
    } else {
      result.warnings.push('PDF expected_texts could not be verified because no reliable text layer was detected; use OCR for scanned/image-only PDFs.');
      addCheck(result, 'expected_texts', true, 'PDF text expectations were skipped with warning because text layer is unavailable.', {
        expectedTexts: options.expectedTexts,
        hasTextLayer,
      });
    }
  }
}

function validateOoxmlBasics(zip: JSZip, result: OfficeValidationResult, coreEntry: string): void {
  for (const entry of ['[Content_Types].xml', '_rels/.rels', coreEntry]) {
    addCheck(result, `ooxml_entry_${entry}`, Boolean(zip.file(entry)), `${entry} ${zip.file(entry) ? 'exists' : 'is missing'}.`, { entry });
  }
}

async function validateImageRelationships(
  zip: JSZip,
  result: OfficeValidationResult,
  sourcePart: string,
  checkName: string,
): Promise<{ total: number; missing: string[] }> {
  const relsPath = relationshipsPathForPart(sourcePart);
  const relXml = await readZipText(zip, relsPath);
  if (!relXml) {
    addCheck(result, checkName, true, `No relationship part found for ${sourcePart}; no media links to validate.`, {
      sourcePart,
      relationshipsPart: relsPath,
      imageRelationships: 0,
    });
    return { total: 0, missing: [] };
  }

  const relationships = parseRelationships(relXml).filter((rel) => rel.type && IMAGE_RELATIONSHIP.test(rel.type));
  const missing: string[] = [];
  const targets: string[] = [];
  for (const rel of relationships) {
    if (!rel.target || rel.targetMode?.toLowerCase() === 'external') continue;
    const target = resolveRelationshipTarget(sourcePart, rel.target);
    if (!target) {
      missing.push(rel.target);
      continue;
    }
    targets.push(target);
    if (!zip.file(target)) missing.push(target);
  }

  addCheck(
    result,
    checkName,
    missing.length === 0,
    missing.length === 0
      ? `All ${relationships.length} image relationship target(s) exist.`
      : `${missing.length} image relationship target(s) are missing.`,
    { sourcePart, relationshipsPart: relsPath, imageRelationships: relationships.length, targets, missing },
  );
  return { total: relationships.length, missing };
}

async function validatePptxStructureRelationships(zip: JSZip, result: OfficeValidationResult, slideEntries: string[]): Promise<void> {
  const slideLayoutRefs = await collectRelationshipTargets(zip, slideEntries, SLIDE_LAYOUT_RELATIONSHIP);
  addCheck(
    result,
    'pptx_slide_layout_relationships',
    slideLayoutRefs.missing.length === 0 && (slideLayoutRefs.total >= slideEntries.length || slideLayoutRefs.total === 0),
    slideLayoutRefs.missing.length === 0 && slideLayoutRefs.total > 0
      ? `PPTX slide layout relationships are coherent (${slideLayoutRefs.total} found).`
      : slideLayoutRefs.missing.length === 0
        ? 'No slide layout relationships were found; minimal/custom PPTX structure accepted.'
      : `${slideLayoutRefs.missing.length} slide layout relationship target(s) are missing.`,
    { slideCount: slideEntries.length, ...slideLayoutRefs },
  );

  const layoutEntries = Object.keys(zip.files).filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name) && !zip.files[name].dir);
  const slideMasterRefs = await collectRelationshipTargets(zip, layoutEntries, SLIDE_MASTER_RELATIONSHIP);
  addCheck(
    result,
    'pptx_slide_master_relationships',
    layoutEntries.length === 0 || (slideMasterRefs.missing.length === 0 && slideMasterRefs.total >= layoutEntries.length),
    slideMasterRefs.missing.length === 0
      ? `PPTX slide master relationships are coherent (${slideMasterRefs.total} found).`
      : `${slideMasterRefs.missing.length} slide master relationship target(s) are missing.`,
    { layoutCount: layoutEntries.length, ...slideMasterRefs },
  );

  const chartRefs = await collectRelationshipTargets(zip, slideEntries, CHART_RELATIONSHIP);
  addCheck(
    result,
    'pptx_chart_relationships',
    chartRefs.missing.length === 0,
    chartRefs.missing.length === 0
      ? `PPTX chart relationships are coherent (${chartRefs.total} found).`
      : `${chartRefs.missing.length} chart relationship target(s) are missing.`,
    chartRefs,
  );
}

async function collectRelationshipTargets(zip: JSZip, sourceParts: string[], typePattern: RegExp): Promise<{ total: number; sources: string[]; targets: string[]; missing: string[] }> {
  const sources: string[] = [];
  const targets: string[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const sourcePart of sourceParts) {
    const relXml = await readZipText(zip, relationshipsPathForPart(sourcePart));
    if (!relXml) continue;
    const relationships = parseRelationships(relXml).filter((rel) => rel.type && typePattern.test(rel.type));
    if (relationships.length > 0) sources.push(sourcePart);
    total += relationships.length;
    for (const rel of relationships) {
      if (!rel.target || rel.targetMode?.toLowerCase() === 'external') continue;
      const target = resolveRelationshipTarget(sourcePart, rel.target);
      if (!target) {
        missing.push(rel.target);
        continue;
      }
      targets.push(target);
      if (!zip.file(target)) missing.push(target);
    }
  }
  return { total, sources, targets, missing };
}

async function loadZip(filePath: string, result: OfficeValidationResult): Promise<JSZip | null> {
  try {
    const zip = await JSZip.loadAsync(readFileSync(filePath));
    addCheck(result, 'zip_readable', true, 'OOXML ZIP package is readable.');
    return zip;
  } catch (error) {
    addCheck(result, 'zip_readable', false, `OOXML ZIP package is not readable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readZipText(zip: JSZip, entry: string): Promise<string | null> {
  const file = zip.file(entry);
  if (!file) return null;
  return file.async('string');
}

function getSlideEntries(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) && !zip.files[name].dir)
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0));
}

function relationshipsPathForPart(partPath: string): string {
  const dir = pathPosix.dirname(partPath);
  const file = pathPosix.basename(partPath);
  return pathPosix.join(dir, '_rels', `${file}.rels`);
}

function resolveRelationshipTarget(sourcePart: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const normalized = target.startsWith('/')
    ? pathPosix.normalize(target.slice(1))
    : pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourcePart), target));
  if (normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function parseRelationships(xml: string): Relationship[] {
  return Array.from(xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)).map((match) => {
    const attrs = parseAttributes(match[1]);
    return {
      id: attrs.Id,
      type: attrs.Type,
      target: attrs.Target,
      targetMode: attrs.TargetMode,
    };
  });
}

function parseAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of value.matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXmlText(match[2]);
  }
  return attrs;
}

function extractWordText(xml: string): string {
  const parts = Array.from(xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)).map((match) => decodeXmlText(match[1]));
  return parts.join('');
}

function extractDrawingText(xml: string): string {
  return Array.from(xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g))
    .map((match) => decodeXmlText(match[1]))
    .join('\n');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function validateExpectedTexts(
  result: OfficeValidationResult,
  text: string,
  expectedTexts: string[] | undefined,
  checkName: string,
): void {
  if (!expectedTexts?.length) {
    addCheck(result, checkName, true, 'No expected texts were provided.');
    return;
  }
  const missing = expectedTexts.filter((expected) => !containsText(text, expected));
  addCheck(
    result,
    checkName,
    missing.length === 0,
    missing.length === 0 ? 'All expected texts were found.' : `${missing.length} expected text(s) were missing.`,
    { expectedTexts, missing, extractedCharacters: text.length },
  );
}

function containsText(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  return normalizeText(haystack).includes(normalizeText(needle));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function countPdfPageObjects(buffer: Buffer): number {
  const content = buffer.toString('latin1');
  return Array.from(content.matchAll(/\/Type\s*\/Page\b/g)).length;
}

async function findAnimationPlan(zip: JSZip): Promise<string | null> {
  for (const name of Object.keys(zip.files)) {
    if (!/^customXml\/item\d+\.xml$/i.test(name)) continue;
    const xml = await readZipText(zip, name);
    if (xml?.includes('lingxiao.pptx.animationPlan.v1')) return name;
  }
  return null;
}

async function findNativeTiming(zip: JSZip, slideEntries: string[]): Promise<{ slides: Array<{ slide: string; targets: string[]; effects: number }>; totalTargets: number; totalEffects: number }> {
  const slides: Array<{ slide: string; targets: string[]; effects: number }> = [];
  let totalTargets = 0;
  let totalEffects = 0;
  for (const entry of slideEntries) {
    const xml = await readZipText(zip, entry);
    const timing = xml?.match(/<p:timing\b[\s\S]*?<\/p:timing>/)?.[0];
    if (!timing) continue;
    const targets = Array.from(timing.matchAll(/<p:spTgt\b[^>]*\bspid="([^"]+)"/g)).map((match) => decodeXmlText(match[1]));
    const uniqueTargets = Array.from(new Set(targets));
    const effects = Array.from(timing.matchAll(/<p:(?:animEffect|anim|animScale|animRot|set)\b/g)).length;
    totalTargets += uniqueTargets.length;
    totalEffects += effects;
    slides.push({ slide: entry, targets: uniqueTargets, effects });
  }
  return { slides, totalTargets, totalEffects };
}

function validateOpenMatrix(filePath: string, result: OfficeValidationResult, options: OfficeValidationOptions): void {
  const apps = options.openCheckApps?.length ? options.openCheckApps : ['libreoffice', 'wps', 'powerpoint'];
  const adapterStatuses: Array<{ app: OpenCheckApp; status: OpenCheckStatus; executable?: string; reason?: string; elapsedMs?: number }> = [];
  for (const app of apps) {
    if (app === 'libreoffice') {
      const executable = findExecutable(['soffice', 'libreoffice', 'libreoffice7.6', 'libreoffice7.5']);
      if (!executable) {
        const reason = 'LibreOffice/soffice command was not found on PATH.';
        result.warnings.push(`${reason} LibreOffice PDF conversion check skipped.`);
        adapterStatuses.push({ app, status: 'skipped', reason });
        addCheck(result, 'open_matrix_libreoffice', true, 'LibreOffice PDF conversion check skipped because LibreOffice is unavailable.', {
          app,
          status: 'skipped',
          available: false,
          reason,
          commandCandidates: ['soffice', 'libreoffice', 'libreoffice7.6', 'libreoffice7.5'],
          platform: process.platform,
        });
        continue;
      }
      const outDir = mkdtempSync(join(tmpdir(), 'lingxiao-office-open-'));
      try {
        const args = ['--headless', '--convert-to', 'pdf', '--outdir', outDir, filePath];
        const run = runCommand(executable, args, OPEN_CHECK_TIMEOUT_MS);
        const expectedPdf = join(outDir, `${basename(filePath, extname(filePath))}.pdf`);
        const pdfCheck = inspectGeneratedPdf(expectedPdf);
        const ok = run.status === 0 && pdfCheck.exists && pdfCheck.bytes > 0 && pdfCheck.headerPresent && pdfCheck.pageCount > 0;
        adapterStatuses.push({ app, status: 'executed', executable, elapsedMs: run.elapsedMs, reason: ok ? undefined : 'LibreOffice conversion did not produce a valid non-empty PDF.' });
        addCheck(result, 'open_matrix_libreoffice_pdf', ok, ok ? 'LibreOffice opened the file and converted it to a valid PDF.' : 'LibreOffice failed to produce a valid PDF conversion.', {
          app,
          status: 'executed',
          available: true,
          executable,
          command: [executable, ...args],
          args,
          processStatus: run.status,
          signal: run.signal,
          timedOut: run.timedOut,
          elapsedMs: run.elapsedMs,
          stdoutSummary: run.stdoutSummary,
          stderrSummary: run.stderrSummary,
          stdout: run.stdoutSummary,
          stderr: run.stderrSummary,
          error: run.error,
          expectedPdf,
          output: pdfCheck,
        });
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } else if (app === 'wps') {
      const executable = findExecutable(['wps', 'wpp', 'et', 'wpsoffice']);
      const commandCandidates = ['wps', 'wpp', 'et', 'wpsoffice'];
      if (!executable) {
        const reason = 'WPS command-line executable was not found on PATH.';
        result.warnings.push(`${reason} WPS open check skipped.`);
        adapterStatuses.push({ app, status: 'skipped', reason });
        addCheck(result, 'open_matrix_wps', true, 'WPS open check skipped because WPS is unavailable.', {
          app,
          status: 'skipped',
          available: false,
          reason,
          commandCandidates,
          platform: process.platform,
        });
      } else {
        const reason = process.platform === 'linux'
          ? 'WPS Linux exposes desktop-oriented commands, but no stable headless open/convert adapter is configured.'
          : 'WPS executable was detected, but automated open verification is not configured for this platform.';
        result.warnings.push(`${reason} WPS open check skipped.`);
        adapterStatuses.push({ app, status: 'warning', executable, reason });
        addCheck(result, 'open_matrix_wps', true, 'WPS executable detected but automated open verification was skipped with warning.', {
          app,
          status: 'warning',
          available: true,
          executable,
          command: [executable],
          commandCandidates,
          reason,
          platform: process.platform,
        });
      }
    } else if (app === 'powerpoint') {
      const commandCandidates = process.platform === 'darwin'
        ? ['osascript']
        : ['powerpnt', 'POWERPNT.EXE'];
      const executable = process.platform === 'linux' ? null : findExecutable(commandCandidates);
      if (!executable) {
        const reason = process.platform === 'linux'
          ? 'PowerPoint desktop automation is unavailable on Linux.'
          : 'PowerPoint automation command was not found on PATH.';
        result.warnings.push(`${reason} PowerPoint open check skipped.`);
        adapterStatuses.push({ app, status: 'skipped', reason });
        addCheck(result, 'open_matrix_powerpoint', true, 'PowerPoint open check skipped because PowerPoint automation is unavailable.', {
          app,
          status: 'skipped',
          available: false,
          reason,
          commandCandidates,
          platform: process.platform,
        });
      } else {
        const reason = 'PowerPoint executable was detected, but automated open verification is not configured in this runtime.';
        result.warnings.push(`${reason} PowerPoint open check skipped.`);
        adapterStatuses.push({ app, status: 'warning', executable, reason });
        addCheck(result, 'open_matrix_powerpoint', true, 'PowerPoint executable detected but automated open verification was skipped with warning.', {
          app,
          status: 'warning',
          available: true,
          executable,
          command: [executable],
          commandCandidates,
          reason,
          platform: process.platform,
        });
      }
    }
  }
  addCheck(result, 'open_matrix_summary', true, `Open matrix completed; executed adapters: ${adapterStatuses.filter((item) => item.status === 'executed').map((item) => item.app).join(', ') || 'none'}.`, {
    requested: apps,
    adapters: adapterStatuses,
    executed: adapterStatuses.filter((item) => item.status === 'executed').map((item) => item.app),
    skipped: adapterStatuses.filter((item) => item.status === 'skipped').map((item) => item.app),
    warnings: adapterStatuses.filter((item) => item.status === 'warning').map((item) => item.app),
  });
}

function findExecutable(names: string[]): string | null {
  for (const name of names) {
    const first = resolveCommandPath(name);
    if (first) return first;
  }
  return null;
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

export function buildWindowsBatchCommand(executable: string, args: string[]): string {
  return ['call', quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(' ');
}

function runCommand(executable: string, args: string[], timeoutMs: number): CommandRun {
  const started = Date.now();
  const windowsBatch = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable);
  const proc = windowsBatch ? spawnSync('cmd.exe', ['/d', '/s', '/c', buildWindowsBatchCommand(executable, args)], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    ...hiddenSpawnOpts(),
  }) as SpawnSyncReturns<string> : spawnSync(executable, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    ...hiddenSpawnOpts(),
  }) as SpawnSyncReturns<string>;
  const elapsedMs = Date.now() - started;
  return {
    executable,
    args,
    status: proc.status,
    signal: proc.signal,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    stdoutSummary: summarizeOutput(proc.stdout ?? ''),
    stderrSummary: summarizeOutput(proc.stderr ?? ''),
    elapsedMs,
    timedOut: proc.error instanceof Error && (proc.error.name === 'TimeoutError' || 'code' in proc.error && proc.error.code === 'ETIMEDOUT'),
    error: proc.error instanceof Error ? proc.error.message : undefined,
  };
}

function inspectGeneratedPdf(filePath: string): { exists: boolean; bytes: number; headerPresent: boolean; pageCount: number } {
  if (!existsSync(filePath)) {
    return { exists: false, bytes: 0, headerPresent: false, pageCount: 0 };
  }
  const buffer = readFileSync(filePath);
  return {
    exists: true,
    bytes: buffer.length,
    headerPresent: buffer.subarray(0, 5).toString('latin1') === '%PDF-',
    pageCount: countPdfPageObjects(buffer),
  };
}

function summarizeOutput(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= OUTPUT_SUMMARY_LIMIT) return normalized;
  return `${normalized.slice(0, OUTPUT_SUMMARY_LIMIT)}...`;
}

function normalizeFormat(format: string, filePath: string): OfficeValidationFormat {
  if (format === 'docx' || format === 'pptx' || format === 'pdf') return format;
  const ext = extname(filePath).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.pdf') return 'pdf';
  return 'unknown';
}

function createResult(format: OfficeValidationFormat): OfficeValidationResult {
  return {
    valid: false,
    format,
    checks: [],
    errors: [],
    warnings: [],
    summary: '',
  };
}

function addCheck(
  result: OfficeValidationResult,
  name: string,
  valid: boolean,
  message: string,
  details?: Record<string, unknown>,
): void {
  result.checks.push({ name, valid, message, ...(details ? { details } : {}) });
  if (!valid) result.errors.push(`${name}: ${message}`);
}

function finish(result: OfficeValidationResult): void {
  result.valid = result.errors.length === 0;
  const failed = result.checks.filter((check) => !check.valid).length;
  const passed = result.checks.length - failed;
  result.summary = result.valid
    ? `${result.format.toUpperCase()} validation passed (${passed}/${result.checks.length} checks).`
    : `${result.format.toUpperCase()} validation failed (${failed}/${result.checks.length} checks failed).`;
}
