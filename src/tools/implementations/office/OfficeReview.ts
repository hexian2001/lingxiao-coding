import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import JSZip from 'jszip';
import { detectFormat, parseFile } from '../FileParser.js';
import { extractDocxPreviewModel, extractPptxPreviewModel } from './OfficePreviewExtractor.js';
import type { OfficePreviewModel } from './OfficePreviewModel.js';

export interface OfficeTextUnit {
  element_id: string;
  page: number;
  kind: string;
  text: string;
}

export interface OfficeTextChange {
  kind: 'added' | 'removed' | 'changed';
  before?: OfficeTextUnit;
  after?: OfficeTextUnit;
}

export interface OfficeCompareResult {
  schema: 'lingxiao.office.review.compare.v1';
  before_path: string;
  after_path: string;
  before_format: string;
  after_format: string;
  changes: OfficeTextChange[];
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  warnings: string[];
}

export interface OfficeReviewCommentInput {
  author: string;
  severity?: 'info' | 'minor' | 'major' | 'critical';
  status?: 'open' | 'resolved';
  comment: string;
  anchor?: {
    element_id?: string;
    page?: number;
    slide?: number;
    text?: string;
  };
}

export interface OfficeReviewManifest {
  schema: 'lingxiao.office.review.manifest.v1';
  target_path: string;
  created_at: string;
  comments: Array<OfficeReviewCommentInput & {
    id: string;
    severity: 'info' | 'minor' | 'major' | 'critical';
    status: 'open' | 'resolved';
  }>;
}

export interface DocxNativeCommentInput extends OfficeReviewCommentInput {
  anchor: NonNullable<OfficeReviewCommentInput['anchor']>;
  initials?: string;
}

export interface DocxTrackedRevisionInput {
  element_id: string;
  replacement_text: string;
  author: string;
  initials?: string;
  target_text?: string;
}

export interface DocxNativeReviewResult {
  schema: 'lingxiao.office.review.docx_native.v1';
  target_path: string;
  output_path: string;
  comments?: Array<{ id: number; author: string; element_id?: string; text?: string }>;
  revisions?: Array<{
    id: number;
    author: string;
    element_id: string;
    target_text?: string;
    deleted_text: string;
    inserted_text: string;
    scope: 'element' | 'text';
  }>;
  warnings: string[];
}

export async function compareOfficeFiles(beforePath: string, afterPath: string): Promise<OfficeCompareResult> {
  const beforeFormat = detectFormat(beforePath);
  const afterFormat = detectFormat(afterPath);
  const warnings: string[] = [];
  const beforeUnits = await extractTextUnits(beforePath, beforeFormat, warnings);
  const afterUnits = await extractTextUnits(afterPath, afterFormat, warnings);
  const beforeByText = multimap(beforeUnits);
  const afterByText = multimap(afterUnits);
  const changes: OfficeTextChange[] = [];
  let unchanged = 0;

  for (const unit of beforeUnits) {
    const afterMatch = shift(afterByText.get(unit.text));
    if (afterMatch) {
      unchanged += 1;
      continue;
    }
    changes.push({ kind: 'removed', before: unit });
  }

  for (const unit of afterUnits) {
    const beforeMatch = shift(beforeByText.get(unit.text));
    if (beforeMatch) continue;
    changes.push({ kind: 'added', after: unit });
  }

  const changed = pairLikelyChanges(changes);
  return {
    schema: 'lingxiao.office.review.compare.v1',
    before_path: beforePath,
    after_path: afterPath,
    before_format: beforeFormat,
    after_format: afterFormat,
    changes: changed,
    summary: {
      added: changed.filter((change) => change.kind === 'added').length,
      removed: changed.filter((change) => change.kind === 'removed').length,
      changed: changed.filter((change) => change.kind === 'changed').length,
      unchanged,
    },
    warnings,
  };
}

export async function applyDocxNativeComments(options: {
  targetPath: string;
  outputPath: string;
  comments: DocxNativeCommentInput[];
}): Promise<DocxNativeReviewResult> {
  const zip = await JSZip.loadAsync(readFileSync(options.targetPath));
  const warnings: string[] = [];
  const documentXml = await readRequiredZipText(zip, 'word/document.xml');
  let commentsXml = await readZipText(zip, 'word/comments.xml') || createCommentsXml();
  const nextIds = nextWordIds(documentXml, commentsXml);
  const applied: Array<{ id: number; author: string; element_id?: string; text?: string }> = [];
  let nextDocumentXml = documentXml;

  for (const comment of options.comments) {
    const id = nextIds.nextCommentId++;
    const insertion = insertCommentAnchor(nextDocumentXml, id, comment.anchor);
    nextDocumentXml = insertion.xml;
    warnings.push(...insertion.warnings);
    if (!insertion.applied) continue;
    commentsXml = appendCommentXml(commentsXml, id, comment);
    applied.push({ id, author: comment.author, element_id: comment.anchor.element_id, text: comment.anchor.text });
  }

  zip.file('word/document.xml', nextDocumentXml);
  zip.file('word/comments.xml', commentsXml);
  await ensureWordCommentsPart(zip);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, buffer);
  return {
    schema: 'lingxiao.office.review.docx_native.v1',
    target_path: options.targetPath,
    output_path: options.outputPath,
    comments: applied,
    warnings,
  };
}

export async function applyDocxTrackedRevisions(options: {
  targetPath: string;
  outputPath: string;
  revisions: DocxTrackedRevisionInput[];
}): Promise<DocxNativeReviewResult> {
  const zip = await JSZip.loadAsync(readFileSync(options.targetPath));
  const warnings: string[] = [];
  let documentXml = await readRequiredZipText(zip, 'word/document.xml');
  const applied: NonNullable<DocxNativeReviewResult['revisions']> = [];
  let revisionId = nextWordIds(documentXml, '').nextRevisionId;

  for (const revision of options.revisions) {
    const id = revisionId;
    revisionId += 2;
    const result = replaceBlockWithTrackedRevision(documentXml, id, id + 1, revision);
    documentXml = result.xml;
    warnings.push(...result.warnings);
    if (!result.applied) continue;
    applied.push({
      id,
      author: revision.author,
      element_id: revision.element_id,
      target_text: revision.target_text,
      deleted_text: result.deletedText,
      inserted_text: revision.replacement_text,
      scope: result.scope,
    });
  }

  zip.file('word/document.xml', documentXml);
  await ensureTrackRevisions(zip);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, buffer);
  return {
    schema: 'lingxiao.office.review.docx_native.v1',
    target_path: options.targetPath,
    output_path: options.outputPath,
    revisions: applied,
    warnings,
  };
}

export function createOfficeReviewManifest(targetPath: string, comments: OfficeReviewCommentInput[]): OfficeReviewManifest {
  return {
    schema: 'lingxiao.office.review.manifest.v1',
    target_path: targetPath,
    created_at: new Date().toISOString(),
    comments: comments.map((comment, index) => ({
      ...comment,
      id: `ocr-${String(index + 1).padStart(4, '0')}`,
      severity: comment.severity ?? 'info',
      status: comment.status ?? 'open',
    })),
  };
}

export function writeReviewArtifact(path: string, value: unknown): string {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  return outputPath;
}

async function extractTextUnits(path: string, format: string, warnings: string[]): Promise<OfficeTextUnit[]> {
  if (format === 'pptx') return textUnitsFromModel(await extractPptxPreviewModel(path));
  if (format === 'docx') return textUnitsFromModel(await extractDocxPreviewModel(path));

  const parsed = await parseFile(path, 'full');
  if (!['pdf', 'html', 'markdown', 'text'].includes(format)) {
    warnings.push(`format ${format} compared through generic parser`);
  }
  return splitGenericText(parsed.metadata?.plainText || parsed.content).map((text, index) => ({
    element_id: `${format}:text:${index + 1}`,
    page: 1,
    kind: 'text',
    text,
  }));
}

function textUnitsFromModel(model: OfficePreviewModel): OfficeTextUnit[] {
  const units: OfficeTextUnit[] = [];
  for (const page of model.pages) {
    for (const [index, element] of page.elements.entries()) {
      const text = element.text?.trim();
      if (!text) continue;
      units.push({
        element_id: model.kind === 'pptx'
          ? `pptx:s${page.index}:e${element.sourceId || index + 1}`
          : `docx:body:${element.kind === 'table' ? 'tbl' : 'p'}:${units.length + 1}`,
        page: page.index,
        kind: element.kind,
        text,
      });
    }
  }
  return units;
}

function splitGenericText(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function multimap(units: OfficeTextUnit[]): Map<string, OfficeTextUnit[]> {
  const map = new Map<string, OfficeTextUnit[]>();
  for (const unit of units) {
    const bucket = map.get(unit.text) || [];
    bucket.push(unit);
    map.set(unit.text, bucket);
  }
  return map;
}

function shift<T>(items: T[] | undefined): T | undefined {
  return items && items.length > 0 ? items.shift() : undefined;
}

function pairLikelyChanges(changes: OfficeTextChange[]): OfficeTextChange[] {
  const removed = changes.filter((change) => change.kind === 'removed');
  const added = changes.filter((change) => change.kind === 'added');
  const usedAdded = new Set<number>();
  const paired: OfficeTextChange[] = [];

  for (const remove of removed) {
    const best = added
      .map((candidate, index) => ({ candidate, index, score: similarity(remove.before?.text || '', candidate.after?.text || '') }))
      .filter((item) => !usedAdded.has(item.index))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.45) {
      usedAdded.add(best.index);
      paired.push({ kind: 'changed', before: remove.before, after: best.candidate.after });
    } else {
      paired.push(remove);
    }
  }

  for (const [index, add] of added.entries()) {
    if (!usedAdded.has(index)) paired.push(add);
  }
  return paired;
}

function similarity(a: string, b: string): number {
  const aTokens = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

async function readZipText(zip: JSZip, entry: string): Promise<string | null> {
  const file = zip.file(entry);
  return file ? file.async('string') : null;
}

async function readRequiredZipText(zip: JSZip, entry: string): Promise<string> {
  const text = await readZipText(zip, entry);
  if (!text) throw new Error(`OOXML entry not found: ${entry}`);
  return text;
}

function createCommentsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:comments>`;
}

function nextWordIds(documentXml: string, commentsXml: string): { nextCommentId: number; nextRevisionId: number } {
  const commentIds = Array.from(commentsXml.matchAll(/\bw:id="(\d+)"/g), (match) => Number(match[1])).filter(Number.isFinite);
  const revisionIds = Array.from(documentXml.matchAll(/<(?:w:ins|w:del)\b[^>]*\bw:id="(\d+)"/g), (match) => Number(match[1])).filter(Number.isFinite);
  return {
    nextCommentId: commentIds.length ? Math.max(...commentIds) + 1 : 0,
    nextRevisionId: revisionIds.length ? Math.max(...revisionIds) + 1 : 1,
  };
}

function appendCommentXml(commentsXml: string, id: number, comment: DocxNativeCommentInput): string {
  const initials = xmlEscape(comment.initials || initialsFor(comment.author));
  const fragment = `<w:comment w:id="${id}" w:author="${xmlEscape(comment.author)}" w:initials="${initials}" w:date="${new Date().toISOString()}"><w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(comment.comment)}</w:t></w:r></w:p></w:comment>`;
  if (commentsXml.includes('</w:comments>')) return commentsXml.replace('</w:comments>', `${fragment}</w:comments>`);
  return `${createCommentsXml().replace('</w:comments>', '')}${fragment}</w:comments>`;
}

function initialsFor(author: string): string {
  const letters = author.split(/\s+/).map((part) => part[0]).filter(Boolean).join('');
  return (letters || author.slice(0, 2) || 'LX').slice(0, 4).toUpperCase();
}

async function ensureWordCommentsPart(zip: JSZip): Promise<void> {
  await ensureContentTypeOverride(zip, '/word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml');
  await ensureDocumentRelationship(zip, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', 'comments.xml');
}

function insertCommentAnchor(documentXml: string, commentId: number, anchor: NonNullable<OfficeReviewCommentInput['anchor']>): {
  xml: string;
  warnings: string[];
  applied: boolean;
} {
  const parsed = parseBodyBlocks(documentXml);
  const blockIndex = anchor.element_id
    ? findBlockIndex(parsed.blocks, anchor.element_id)
    : findBlockIndexByText(parsed.blocks, anchor.text || '');
  if (blockIndex < 0) {
    return { xml: documentXml, warnings: [`comment anchor not found: ${anchor.element_id || anchor.text || '(empty)'}`], applied: false };
  }
  const anchored = addCommentMarkersToBlock(parsed.blocks[blockIndex].xml, commentId, anchor.text);
  parsed.blocks[blockIndex] = {
    ...parsed.blocks[blockIndex],
    xml: anchored.xml,
  };
  return { xml: serializeBody(parsed), warnings: anchored.warnings, applied: true };
}

function addCommentMarkersToBlock(blockXml: string, commentId: number, targetText?: string): { xml: string; warnings: string[] } {
  const precise = targetText ? addCommentMarkersToTextRun(blockXml, commentId, targetText) : null;
  if (precise?.applied) return { xml: precise.xml, warnings: [] };

  const warnings = precise ? [`comment target text not found inside block; anchored whole block: ${targetText}`] : [];
  const reference = `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`;
  const markParagraph = (paragraphXml: string): string => {
    const start = `<w:commentRangeStart w:id="${commentId}"/>`;
    const withStart = /<w:pPr\b[\s\S]*?<\/w:pPr>/i.test(paragraphXml)
      ? paragraphXml.replace(/(<w:pPr\b[\s\S]*?<\/w:pPr>)/i, `$1${start}`)
      : paragraphXml.replace(/(<w:p\b[^>]*>)/i, `$1${start}`);
    return withStart.replace('</w:p>', `${reference}</w:p>`);
  };
  if (blockXml.startsWith('<w:p')) {
    return { xml: markParagraph(blockXml), warnings };
  }
  const withTableParagraph = blockXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/i, (paragraph) => markParagraph(paragraph));
  if (withTableParagraph !== blockXml) {
    return { xml: withTableParagraph, warnings };
  }
  return { xml: `${blockXml}<w:p><w:commentRangeStart w:id="${commentId}"/>${reference}</w:p>`, warnings };
}

async function ensureTrackRevisions(zip: JSZip): Promise<void> {
  const settingsPath = 'word/settings.xml';
  let settingsXml = await readZipText(zip, settingsPath);
  if (!settingsXml) {
    settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/></w:settings>`;
  } else if (!/<w:trackRevisions\b/i.test(settingsXml)) {
    settingsXml = settingsXml.replace('</w:settings>', '<w:trackRevisions/></w:settings>');
  }
  zip.file(settingsPath, settingsXml);
  await ensureContentTypeOverride(zip, '/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
  await ensureDocumentRelationship(zip, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml');
}

async function ensureContentTypeOverride(zip: JSZip, partName: string, contentType: string): Promise<void> {
  const contentTypes = await readRequiredZipText(zip, '[Content_Types].xml');
  if (contentTypes.includes(`PartName="${partName}"`)) return;
  zip.file('[Content_Types].xml', contentTypes.replace(
    '</Types>',
    `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`,
  ));
}

function hasRelationshipType(relsXml: string, relType: string): boolean {
  return relsXml.includes(relType);
}

async function ensureDocumentRelationship(zip: JSZip, type: string, target: string): Promise<void> {
  const relPath = 'word/_rels/document.xml.rels';
  let rels = await readZipText(zip, relPath);
  if (!rels) {
    rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  }
  if (!hasRelationshipType(rels, type)) {
    const rel = `<Relationship Id="${nextRelId(rels)}" Type="${type}" Target="${target}"/>`;
    rels = rels.replace('</Relationships>', `${rel}</Relationships>`);
  }
  zip.file(relPath, rels);
}

function nextRelId(relsXml: string): string {
  let max = 0;
  for (const match of relsXml.matchAll(/\bId="rId(\d+)"/g)) {
    max = Math.max(max, Number(match[1]) || 0);
  }
  return `rId${max + 1}`;
}

function replaceBlockWithTrackedRevision(documentXml: string, deleteRevisionId: number, insertRevisionId: number, revision: DocxTrackedRevisionInput): {
  xml: string;
  deletedText: string;
  scope: 'element' | 'text';
  warnings: string[];
  applied: boolean;
} {
  const parsed = parseBodyBlocks(documentXml);
  const blockIndex = findBlockIndex(parsed.blocks, revision.element_id);
  if (blockIndex < 0) {
    return { xml: documentXml, deletedText: '', scope: 'element', warnings: [`revision anchor not found: ${revision.element_id}`], applied: false };
  }
  const block = parsed.blocks[blockIndex];
  const deletedText = extractWordText(block.xml);
  const targetText = revision.target_text;
  if (targetText) {
    const precise = replaceTextWithTrackedRevision(block.xml, deleteRevisionId, insertRevisionId, targetText, revision);
    if (!precise.applied) {
      return {
        xml: documentXml,
        deletedText: '',
        scope: 'text',
        warnings: [`tracked revision target text not found in ${revision.element_id}: ${targetText}`],
        applied: false,
      };
    }
    parsed.blocks[blockIndex] = { ...block, xml: precise.xml };
    return { xml: serializeBody(parsed), deletedText: targetText, scope: 'text', warnings: [], applied: true };
  }
  if (!block.xml.startsWith('<w:p')) {
    return { xml: documentXml, deletedText, scope: 'element', warnings: [`tracked revision without target_text currently supports paragraph blocks only: ${revision.element_id}`], applied: false };
  }
  const pOpen = block.xml.match(/^<w:p\b[^>]*>/i)?.[0] ?? '<w:p>';
  const pPr = block.xml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/i)?.[0] ?? '';
  const date = new Date().toISOString();
  const author = xmlEscape(revision.author);
  const nextXml = `${pOpen}${pPr}${trackedDeletionXml(deleteRevisionId, author, date, deletedText)}${trackedInsertionXml(insertRevisionId, author, date, revision.replacement_text)}</w:p>`;
  parsed.blocks[blockIndex] = { ...block, xml: nextXml };
  return { xml: serializeBody(parsed), deletedText, scope: 'element', warnings: [], applied: true };
}

function addCommentMarkersToTextRun(xml: string, commentId: number, targetText: string): { xml: string; applied: boolean } {
  const replacement = splitFirstTextRun(xml, targetText, (parts) => [
    wordTextRunXml(parts.prefix, parts.rPr),
    `<w:commentRangeStart w:id="${commentId}"/>`,
    wordTextRunXml(parts.target, parts.rPr),
    `<w:commentRangeEnd w:id="${commentId}"/>`,
    '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="' + commentId + '"/></w:r>',
    wordTextRunXml(parts.suffix, parts.rPr),
  ].join(''));
  return replacement;
}

function replaceTextWithTrackedRevision(
  xml: string,
  deleteRevisionId: number,
  insertRevisionId: number,
  targetText: string,
  revision: DocxTrackedRevisionInput,
): { xml: string; applied: boolean } {
  const date = new Date().toISOString();
  const author = xmlEscape(revision.author);
  return splitFirstTextRun(xml, targetText, (parts) => [
    wordTextRunXml(parts.prefix, parts.rPr),
    trackedDeletionXml(deleteRevisionId, author, date, parts.target, parts.rPr),
    trackedInsertionXml(insertRevisionId, author, date, revision.replacement_text, parts.rPr),
    wordTextRunXml(parts.suffix, parts.rPr),
  ].join(''));
}

function splitFirstTextRun(
  xml: string,
  targetText: string,
  render: (parts: { prefix: string; target: string; suffix: string; rPr: string }) => string,
): { xml: string; applied: boolean } {
  const needle = targetText.trim();
  if (!needle) return { xml, applied: false };
  const runRe = /<w:r\b[^>]*>[\s\S]*?<w:t\b[^>]*>[\s\S]*?<\/w:t>[\s\S]*?<\/w:r>/gi;
  for (const match of xml.matchAll(runRe)) {
    const runXml = match[0];
    const textMatch = runXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/i);
    if (!textMatch) continue;
    const runText = decodeXmlText(textMatch[1]);
    const targetIndex = runText.indexOf(needle);
    if (targetIndex < 0) continue;
    const rPr = runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/i)?.[0] ?? '';
    const prefix = runText.slice(0, targetIndex);
    const target = runText.slice(targetIndex, targetIndex + needle.length);
    const suffix = runText.slice(targetIndex + needle.length);
    const start = match.index ?? 0;
    return {
      xml: `${xml.slice(0, start)}${render({ prefix, target, suffix, rPr })}${xml.slice(start + runXml.length)}`,
      applied: true,
    };
  }
  return { xml, applied: false };
}

function wordTextRunXml(text: string, rPr = ''): string {
  if (!text) return '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function trackedDeletionXml(id: number, author: string, date: string, text: string, rPr = ''): string {
  return `<w:del w:id="${id}" w:author="${author}" w:date="${date}"><w:r>${rPr}<w:delText xml:space="preserve">${xmlEscape(text)}</w:delText></w:r></w:del>`;
}

function trackedInsertionXml(id: number, author: string, date: string, text: string, rPr = ''): string {
  return `<w:ins w:id="${id}" w:author="${author}" w:date="${date}"><w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:ins>`;
}

interface BodyBlock {
  kind: 'p' | 'tbl' | 'sectPr';
  xml: string;
  index: number;
}

function parseBodyBlocks(documentXml: string): { before: string; bodyOpen: string; bodyClose: string; after: string; blocks: BodyBlock[] } {
  const match = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i);
  if (!match) throw new Error('word/document.xml does not contain w:body');
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
    else blocks.push({ kind, xml, index: ++index });
  }
  return { before, bodyOpen, bodyClose, after, blocks };
}

function serializeBody(parsed: ReturnType<typeof parseBodyBlocks>): string {
  return `${parsed.before}${parsed.bodyOpen}${parsed.blocks.map((block) => block.xml).join('')}${parsed.bodyClose}${parsed.after}`;
}

function findBlockIndex(blocks: BodyBlock[], elementId: string): number {
  const body = elementId.match(/^docx:body:(p|tbl):(\d+)$/);
  if (body) return blocks.findIndex((block) => block.kind === body[1] && block.index === Number(body[2]));
  const preview = elementId.match(/^docx-page\d+-(p|table)(\d+)$/);
  if (!preview) return -1;
  const kind = preview[1] === 'table' ? 'tbl' : 'p';
  let ordinal = 0;
  return blocks.findIndex((block) => {
    if (block.kind !== kind) return false;
    ordinal += 1;
    return ordinal === Number(preview[2]);
  });
}

function findBlockIndexByText(blocks: BodyBlock[], text: string): number {
  const needle = text.trim();
  if (!needle) return -1;
  return blocks.findIndex((block) => extractWordText(block.xml).includes(needle));
}

function extractWordText(xml: string): string {
  return Array.from(xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g), (match) => decodeXmlText(match[1])).join('');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
