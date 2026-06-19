import { z } from 'zod';
import { existsSync, readFileSync, statSync } from 'fs';
import { extname } from 'path';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getPromptCatalog } from '../../agents/prompts/i18n/catalog.js';
import {
  countOccurrences,
  getPythonSyntaxWarningAsync,
  lockedAtomicWrite,
  resolveTaskWritePath,
  safeLiteralReplace,
} from './utils.js';

const OccurrenceTargetSchema = z.union([
  z.number().int().min(1),
  z.enum(['first', 'last']),
]);

type OccurrenceTarget = z.infer<typeof OccurrenceTargetSchema>;

const SearchHunkSchema = z.object({
  search: z.string().min(1).describe('要替换的唯一原文片段'),
  replace: z.string().describe('替换后的内容'),
  replace_all: z.boolean().optional().default(false).describe('是否替换全部匹配，默认 false'),
  occurrence: OccurrenceTargetSchema.optional().describe('当 search 有多处匹配时，替换第 N 处匹配；支持 1-based 数字、"first" 或 "last"'),
}).strict();

const LineHunkSchema = z.object({
  start_line: z.number().int().min(1).describe('开始行号，1-based'),
  end_line: z.number().int().min(1).describe('结束行号，包含该行'),
  replace: z.string().describe('替换后的内容'),
}).strict();

const InsertAfterLineHunkSchema = z.object({
  insert_after_line: z.number().int().min(0).describe('在第几行之后插入；0 表示文件开头，使用 file_read 确认行号'),
  content: z.string().describe('要插入的内容'),
}).strict();

const InsertAfterTextHunkSchema = z.object({
  insert_after: z.string().min(1).describe('在唯一原文锚点之后插入 content'),
  content: z.string().describe('要插入的内容'),
  occurrence: OccurrenceTargetSchema.optional().describe('当 insert_after 有多处匹配时，在第 N 处之后插入；支持 1-based 数字、"first" 或 "last"'),
}).strict();

// ---------------------------------------------------------------------------
// Canonical top-level hunk fields exposed by structured_patch.
// ---------------------------------------------------------------------------

type SchemaType = 'string' | 'boolean' | 'true_literal' | 'occurrence' | 'ambiguous_strategy' | 'int_min1' | 'int_min0' | 'insert_at';

interface HunkFieldDef {
  schemaType: SchemaType;
  desc: string;
}

const HUNK_FIELD_MAP: Record<string, HunkFieldDef> = {
  search: {
    schemaType: 'string',
    desc: '要替换的唯一原文片段',
  },
  replace: {
    schemaType: 'string',
    desc: '替换后的内容；search 或行范围替换时使用',
  },
  replace_all: {
    schemaType: 'boolean',
    desc: '是否替换全部匹配，默认 false',
  },
  occurrence: {
    schemaType: 'occurrence',
    desc: '第 N 处匹配；支持 1-based 数字、"first" 或 "last"',
  },
  on_ambiguous: {
    schemaType: 'ambiguous_strategy',
    desc: 'search/insert_after 重复匹配时的显式策略；支持 "first"、"last"、"replace_all" 或 "error"',
  },
  start_line: {
    schemaType: 'int_min1',
    desc: '开始行号，1-based',
  },
  end_line: {
    schemaType: 'int_min1',
    desc: '结束行号，包含该行',
  },
  insert_after_line: {
    schemaType: 'int_min0',
    desc: '在第几行之后插入；0 表示文件开头，文件总行数表示文件末尾',
  },
  insert_after: {
    schemaType: 'string',
    desc: '在唯一原文锚点之后插入 content；多处匹配时配合 occurrence',
  },
  insert_at: {
    schemaType: 'insert_at',
    desc: '在文件开头或末尾插入 content',
  },
  content: {
    schemaType: 'string',
    desc: '要插入/追加的内容；单独提供 content 时默认追加到文件末尾',
  },
  append: {
    schemaType: 'true_literal',
    desc: 'true+content，追加到文件末尾',
  },
  prepend: {
    schemaType: 'true_literal',
    desc: 'true+content，插入文件开头',
  },
};

const HUNK_FIELD_NAMES = Object.keys(HUNK_FIELD_MAP) as unknown as readonly string[];

function zodFieldForType(schemaType: SchemaType): z.ZodTypeAny {
  switch (schemaType) {
    case 'string': return z.string().optional();
    case 'boolean': return z.boolean().optional();
    case 'true_literal': return z.literal(true).optional();
    case 'occurrence': return OccurrenceTargetSchema.optional();
    case 'ambiguous_strategy': return z.enum(['first', 'last', 'replace_all', 'error']).optional();
    case 'int_min1': return z.number().int().min(1).optional();
    case 'int_min0': return z.number().int().min(0).optional();
    case 'insert_at': return z.enum(['start', 'end']).optional();
  }
}

function buildHunkSchemaShape(descPrefix: string): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [canonical, def] of Object.entries(HUNK_FIELD_MAP)) {
    const prefix = descPrefix ? `${descPrefix}：` : '';
    shape[canonical] = zodFieldForType(def.schemaType).describe(`${prefix}${def.desc}`);
  }
  return shape;
}

const FlexibleHunkSchema = z.object(
  buildHunkSchemaShape(''),
).strict().describe('单个 patch hunk；按提供的字段组合选择 search、line、insert、append 或 prepend 模式');

const ExposedSearchHunkSchema = SearchHunkSchema.describe('替换 hunk；只能包含 search、replace、replace_all、occurrence');
const ExposedLineHunkSchema = LineHunkSchema.describe('行范围替换 hunk；只能包含 start_line、end_line、replace');
const ExposedInsertAfterLineHunkSchema = InsertAfterLineHunkSchema.describe('按行插入 hunk；只能包含 insert_after_line、content');
const ExposedInsertAfterTextHunkSchema = InsertAfterTextHunkSchema.describe('按文本锚点插入 hunk；只能包含 insert_after、content、occurrence');
const ExposedAppendHunkSchema = z.object({ content: z.string().describe('要追加到文件末尾的内容') }).strict().describe('追加 hunk；只能包含 content');
const ExposedInsertAtHunkSchema = z.object({
  insert_at: z.enum(['start', 'end']).describe('插入位置：start 为文件开头，end 为文件末尾'),
  content: z.string().describe('要插入的内容'),
}).strict().describe('文件开头/末尾插入 hunk；只能包含 insert_at、content');
const ExposedHunkSchema = z.union([
  ExposedSearchHunkSchema,
  ExposedLineHunkSchema,
  ExposedInsertAfterLineHunkSchema,
  ExposedInsertAfterTextHunkSchema,
  ExposedInsertAtHunkSchema,
  ExposedAppendHunkSchema,
]).describe('一个 hunk 必须只使用一种形态；不要混用 search、start_line、insert_after_line、insert_at、content。');

const StructuredPatchExposedSchema = z.object({
  path: z.string().describe('文件路径'),
  hunks: z.array(ExposedHunkSchema).min(1).max(50).describe('按顺序应用的 patch hunks。每个 hunk 只允许对应形态的字段；search hunk 只能有 search/replace/replace_all/occurrence。'),
  dry_run: z.boolean().optional().default(false).describe('只预览不写入'),
}).strict();

const StructuredPatchRuntimeSchema = z.object({
  path: z.string().describe('文件路径'),
  hunks: z.union([z.array(FlexibleHunkSchema).min(1).max(50), FlexibleHunkSchema]).optional().describe('按顺序应用的 patch hunk；单个 object 会自动包装为数组'),
  hunk: FlexibleHunkSchema.optional().describe('hunks 的单 hunk 便捷写法'),
  ...buildHunkSchemaShape('顶层便捷写法'),
  dry_run: z.boolean().optional().default(false).describe('只预览不写入'),
}).strict();

type StructuredPatchRuntimeArgs = z.infer<typeof StructuredPatchRuntimeSchema>;
type StructuredPatchParams = { path: string; hunks: unknown[]; dry_run: boolean };
type SearchPatchHunk = z.infer<typeof SearchHunkSchema>;
type LinePatchHunk = z.infer<typeof LineHunkSchema>;
type InsertAfterLinePatchHunk = z.infer<typeof InsertAfterLineHunkSchema>;
type InsertAfterTextPatchHunk = z.infer<typeof InsertAfterTextHunkSchema>;
type AppendPatchHunk = { append: true; content: string; inferred?: boolean };
type PrependPatchHunk = { prepend: true; content: string };
type StructuredPatchHunk = SearchPatchHunk | LinePatchHunk | InsertAfterLinePatchHunk | InsertAfterTextPatchHunk | AppendPatchHunk | PrependPatchHunk;

const STRUCTURED_PATCH_MIN_TIMEOUT_MS = 5 * 60_000;
const STRUCTURED_PATCH_MAX_TIMEOUT_MS = 10 * 60_000;

function stringPayloadChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += stringPayloadChars(item);
    return total;
  }
  if (isRecord(value)) {
    let total = 0;
    for (const item of Object.values(value)) total += stringPayloadChars(item);
    return total;
  }
  return 0;
}

function estimatedHunkCount(args: unknown): number {
  if (!isRecord(args)) return 1;
  const hunks = args.hunks;
  if (Array.isArray(hunks)) return hunks.length;
  if (hunks !== undefined || args.hunk !== undefined) return 1;
  return 1;
}

function structuredPatchTimeoutMs(args: unknown): number {
  const mb = Math.ceil(stringPayloadChars(args) / (1024 * 1024));
  const hunkCount = estimatedHunkCount(args);
  return Math.min(
    STRUCTURED_PATCH_MAX_TIMEOUT_MS,
    STRUCTURED_PATCH_MIN_TIMEOUT_MS + mb * 30_000 + Math.max(0, hunkCount - 1) * 2_000,
  );
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function snippet(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hunkListFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function firstDefined(raw: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (raw[name] !== undefined) return raw[name];
  }
  return undefined;
}

function resolveOccurrenceTarget(target: OccurrenceTarget, matchCount: number): number {
  if (target === 'first') return 1;
  if (target === 'last') return matchCount;
  return target;
}

function normalizePatchHunkInput(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };
  const ambiguousStrategy = raw.on_ambiguous;
  if (ambiguousStrategy === 'first' || ambiguousStrategy === 'last') {
    if (normalized.occurrence !== undefined && normalized.occurrence !== ambiguousStrategy) return normalized;
    normalized.occurrence = ambiguousStrategy;
    delete normalized.on_ambiguous;
  } else if (ambiguousStrategy === 'replace_all') {
    if (normalized.replace_all !== undefined && normalized.replace_all !== true) return normalized;
    normalized.replace_all = true;
    delete normalized.on_ambiguous;
  } else if (ambiguousStrategy === 'error') {
    if (normalized.occurrence !== undefined || normalized.replace_all !== undefined) return normalized;
    delete normalized.on_ambiguous;
  }
  return normalized;
}

function lineCountForInsert(text: string, newline: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(newline);
  return text.endsWith(newline) ? Math.max(0, lines.length - 1) : lines.length;
}

function offsetAfterLine(text: string, lineNumber: number, newline: string): number {
  if (lineNumber === 0) return 0;
  let offset = 0;
  for (let line = 1; line <= lineNumber; line++) {
    const nextNewline = text.indexOf(newline, offset);
    if (nextNewline === -1) return text.length;
    offset = nextNewline + newline.length;
  }
  return offset;
}

function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split(/\r?\n/).length;
  const lastLf = before.lastIndexOf('\n');
  const lastCr = before.lastIndexOf('\r');
  const lastNewline = Math.max(lastLf, lastCr);
  return { line, column: index - lastNewline };
}

function lineRangeForMatch(text: string, search: string, index: number): { start_line: number; end_line: number } {
  const start = lineColumnAt(text, index);
  const endIndex = Math.max(index, index + search.length - 1);
  const end = lineColumnAt(text, endIndex);
  return { start_line: start.line, end_line: end.line };
}

function findLiteralMatchIndices(text: string, search: string): number[] {
  const indices: number[] = [];
  if (search.length === 0) return indices;
  let index = 0;
  while ((index = text.indexOf(search, index)) !== -1) {
    indices.push(index);
    index += search.length;
  }
  return indices;
}

function replaceNthLiteral(text: string, search: string, replace: string, occurrence: number): string {
  const indices = findLiteralMatchIndices(text, search);
  const index = indices[occurrence - 1];
  if (index === undefined) return text;
  return `${text.slice(0, index)}${replace}${text.slice(index + search.length)}`;
}

function findMatchContexts(text: string, search: string, maxMatches = 8): Array<Record<string, unknown>> {
  const contexts: Array<Record<string, unknown>> = [];
  const lines = text.split(/\r?\n/);
  let index = 0;
  while ((index = text.indexOf(search, index)) !== -1) {
    const { line, column } = lineColumnAt(text, index);
    const range = lineRangeForMatch(text, search, index);
    const startLine = Math.max(1, line - 1);
    const endLine = Math.min(lines.length, line + 1);
    contexts.push({
      line,
      column,
      start_line: range.start_line,
      end_line: range.end_line,
      context: lines
        .slice(startLine - 1, endLine)
        .map((lineText, offset) => `${startLine + offset}: ${snippet(lineText, 180)}`),
    });
    if (contexts.length >= maxMatches) break;
    index += search.length;
  }
  return contexts;
}

function structuredPatchText() {
  return getPromptCatalog().tools.structuredPatch;
}

function buildLineReplacementCandidates(text: string, search: string, replace: string, maxMatches = 5): Array<Record<string, unknown>> {
  const textCatalog = structuredPatchText();
  const candidates: Array<Record<string, unknown>> = [];
  let index = 0;
  while ((index = text.indexOf(search, index)) !== -1) {
    const range = lineRangeForMatch(text, search, index);
    const hunk = replace.length <= 2000
      ? { start_line: range.start_line, end_line: range.end_line, replace }
      : { start_line: range.start_line, end_line: range.end_line, replace: textCatalog.reuseOriginalReplace };
    candidates.push({
      ...range,
      hunk,
      note: textCatalog.wholeLineRangeNote,
    });
    if (candidates.length >= maxMatches) break;
    index += search.length;
  }
  return candidates;
}

function maybeShortText(value: string, placeholder: string): string {
  return value.length <= 2000 ? value : placeholder;
}

function buildOccurrenceCandidates(search: string, replace: string, matchCount: number, maxListed = 5): Array<Record<string, unknown>> {
  const textCatalog = structuredPatchText();
  const shownCount = Math.min(matchCount, maxListed);
  const candidates: Array<Record<string, unknown>> = Array.from({ length: shownCount }, (_, i) => {
    const occurrence = i + 1;
    const hunk = { search, replace: maybeShortText(replace, textCatalog.reuseOriginalReplace), occurrence };
    return {
      occurrence,
      hunk,
      note: textCatalog.exactOccurrenceNote,
    };
  });
  if (matchCount > shownCount) {
    candidates.push({
      occurrence: 'last',
      resolved_occurrence: matchCount,
      hunk: { search, replace: maybeShortText(replace, textCatalog.reuseOriginalReplace), occurrence: 'last' },
      note: textCatalog.finalOccurrenceNote,
    });
  }
  return candidates;
}

function buildInsertAfterOccurrenceCandidates(insertAfter: string, content: string, matchCount: number, maxListed = 5): Array<Record<string, unknown>> {
  const textCatalog = structuredPatchText();
  const shownCount = Math.min(matchCount, maxListed);
  const candidates: Array<Record<string, unknown>> = Array.from({ length: shownCount }, (_, i) => {
    const occurrence = i + 1;
    const hunk = { insert_after: insertAfter, content: maybeShortText(content, textCatalog.reuseOriginalContent), occurrence };
    return {
      occurrence,
      hunk,
      note: textCatalog.insertExactOccurrenceNote,
    };
  });
  if (matchCount > shownCount) {
    candidates.push({
      occurrence: 'last',
      resolved_occurrence: matchCount,
      hunk: { insert_after: insertAfter, content: maybeShortText(content, textCatalog.reuseOriginalContent), occurrence: 'last' },
      note: textCatalog.insertFinalOccurrenceNote,
    });
  }
  return candidates;
}

function buildInsertAfterLineCandidates(text: string, insertAfter: string, content: string, maxMatches = 5): Array<Record<string, unknown>> {
  const textCatalog = structuredPatchText();
  const candidates: Array<Record<string, unknown>> = [];
  let index = 0;
  while ((index = text.indexOf(insertAfter, index)) !== -1) {
    const range = lineRangeForMatch(text, insertAfter, index);
    const hunk = content.length <= 2000
      ? { insert_after_line: range.end_line, content }
      : { insert_after_line: range.end_line, content: textCatalog.reuseOriginalContent };
    candidates.push({
      ...range,
      hunk,
      note: textCatalog.insertWholeRangeNote,
    });
    if (candidates.length >= maxMatches) break;
    index += insertAfter.length;
  }
  return candidates;
}

function buildAmbiguousSearchRetryArgs(path: string, search: string, replace: string): Record<string, unknown> {
  const textCatalog = structuredPatchText();
  const shortReplace = maybeShortText(replace, textCatalog.reuseOriginalReplace);
  const shortContent = maybeShortText(replace, textCatalog.reuseOriginalContent);
  return {
    first_occurrence: { path, hunk: { search, replace: shortReplace, occurrence: 1 } },
    last_occurrence: { path, hunk: { search, replace: shortReplace, occurrence: 'last' } },
    replace_all: { path, hunk: { search, replace: shortReplace, replace_all: true } },
    append_eof: { path, content: shortContent },
  };
}

function buildAmbiguousInsertAfterRetryArgs(path: string, insertAfter: string, content: string): Record<string, unknown> {
  const shortContent = maybeShortText(content, structuredPatchText().reuseOriginalContent);
  return {
    first_occurrence: { path, hunk: { insert_after: insertAfter, content: shortContent, occurrence: 1 } },
    last_occurrence: { path, hunk: { insert_after: insertAfter, content: shortContent, occurrence: 'last' } },
    append_eof: { path, content: shortContent },
  };
}


function normalizeStructuredPatchParams(raw: StructuredPatchRuntimeArgs): { ok: true; params: StructuredPatchParams } | { ok: false; result: ToolResult } {
  const rawRecord = raw as Record<string, unknown>;
  let hunks: unknown[] | undefined;
  const rawHunks = firstDefined(rawRecord, ['hunks']);
  if (rawHunks !== undefined) {
    hunks = hunkListFrom(rawHunks);
  } else if (raw.hunk !== undefined) {
    hunks = hunkListFrom(raw.hunk);
  } else {
    const topLevelHunk: Record<string, unknown> = {};
    for (const field of HUNK_FIELD_NAMES) {
      if (field === 'replace_all' && rawRecord.search === undefined && rawRecord.replace_all !== true) continue;
      if (rawRecord[field] !== undefined) topLevelHunk[field] = rawRecord[field];
    }
    if (Object.keys(topLevelHunk).length > 0) hunks = [topLevelHunk];
  }

  if (!hunks || hunks.length === 0) {
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_MISSING_HUNKS',
        message: '缺少 patch hunk：请提供 hunks 数组、单个 hunk，或顶层 canonical 字段。',
        retryable: true,
        cause: 'no hunks/hunk/search/start_line/insert/content fields were provided',
        fix: '追加内容用 {"hunks":[{"content":"..."}]} 或 {"content":"..."}；替换用 search+replace 或 start_line/end_line/replace。',
        hints: {
          allowed_shapes: [
            { search: '<exact original text>', replace: '<new text>' },
            { start_line: 10, end_line: 12, replace: '<new text>' },
            { insert_after_line: 42, content: '<text to insert>' },
            { content: '<text to append at EOF>' },
          ],
        },
        example_args: { path: raw.path, hunks: [{ content: '\n## New Section\n\nContent...\n' }] },
      }),
    };
  }

  return { ok: true, params: { path: raw.path, hunks, dry_run: raw.dry_run === true } };
}

function parseHunk(rawInput: unknown, index: number): { ok: true; hunk: StructuredPatchHunk } | { ok: false; result: ToolResult } {
  const textCatalog = structuredPatchText();
  const hunkNumber = index + 1;
  const fields = isRecord(rawInput) ? Object.keys(rawInput) : [];
  const baseHints = {
    failed_hunk: hunkNumber,
    received_fields: fields,
    allowed_shapes: [
      { search: '<exact original text>', replace: '<new text>', replace_all: false },
      { search: '<repeated exact text>', replace: '<new text>', occurrence: 2 },
      { start_line: 10, end_line: 12, replace: '<new text>' },
      { insert_after_line: 42, content: '<text to insert>' },
      { insert_after: '<unique anchor text>', content: '<text to insert after anchor>' },
      { content: '<text to append at EOF>' },
      { insert_at: 'end', content: '<text to append at EOF>' },
    ],
    retry_rule: textCatalog.retryRuleSingleShape,
  };

  if (!isRecord(rawInput)) {
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_HUNK',
        message: `第 ${hunkNumber} 个 hunk 结构无效：hunk 必须是 JSON object。`,
        retryable: true,
        cause: `hunks.${index} is not an object`,
        fix: '每个 hunk 只能使用 search/replace、start_line/end_line/replace、insert_after_line/content 三种形态之一。',
        hints: baseHints,
      }),
    };
  }
  const raw = normalizePatchHunkInput(rawInput);

  if ('search' in raw) {
    const parsed = SearchHunkSchema.safeParse(raw);
    if (parsed.success) return { ok: true, hunk: parsed.data };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_SEARCH_HUNK',
        message: `第 ${hunkNumber} 个 search hunk 结构无效。`,
        retryable: true,
        cause: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
        fix: 'search hunk 必须只包含 search、replace、replace_all、occurrence。删除 append/prepend/start_line/end_line/insert_after_line/insert_after/insert_at/content/on_ambiguous 等字段后重试。',
        hints: {
          ...baseHints,
          retry_args: { path: '<same path>', hunks: [{ search: '<exact original text>', replace: '<new text>' }] },
        },
      }),
    };
  }

  if ('start_line' in raw || 'end_line' in raw) {
    const parsed = LineHunkSchema.safeParse(raw);
    if (parsed.success) return { ok: true, hunk: parsed.data };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_LINE_HUNK',
        message: `第 ${hunkNumber} 个 line hunk 结构无效。`,
        retryable: true,
        cause: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
        fix: 'line hunk 必须包含 1-based 整数 start_line、end_line，以及 replace 字符串。',
        hints: baseHints,
      }),
    };
  }

  if ('insert_at' in raw) {
    if (typeof raw.content !== 'string') {
      return {
        ok: false,
        result: createToolError({
          code: 'STRUCTURED_PATCH_INVALID_INSERT_HUNK',
          message: `第 ${hunkNumber} 个 insert_at hunk 结构无效。`,
          retryable: true,
          cause: 'content must be a string when insert_at is used',
          fix: '使用 {"insert_at":"end","content":"..."} 追加，或 {"insert_at":"start","content":"..."} 插入文件开头。',
          hints: baseHints,
        }),
      };
    }
    if (raw.insert_at === 'end') return { ok: true, hunk: { append: true, content: raw.content } };
    if (raw.insert_at === 'start') return { ok: true, hunk: { prepend: true, content: raw.content } };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_INSERT_HUNK',
        message: `第 ${hunkNumber} 个 insert_at hunk 结构无效。`,
        retryable: true,
        cause: 'insert_at must be "start" or "end"',
        fix: 'insert_at 只能是 "start" 或 "end"。',
        hints: baseHints,
      }),
    };
  }

  if ('append' in raw) {
    if (raw.append === true && typeof raw.content === 'string') return { ok: true, hunk: { append: true, content: raw.content } };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_APPEND_HUNK',
        message: `第 ${hunkNumber} 个 append hunk 结构无效。`,
        retryable: true,
        cause: 'append must be true with string content',
        fix: '使用 {"append":true,"content":"..."}。',
        hints: baseHints,
      }),
    };
  }

  if ('prepend' in raw) {
    if (raw.prepend === true && typeof raw.content === 'string') return { ok: true, hunk: { prepend: true, content: raw.content } };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_PREPEND_HUNK',
        message: `第 ${hunkNumber} 个 prepend hunk 结构无效。`,
        retryable: true,
        cause: 'prepend must be true with string content',
        fix: '使用 {"prepend":true,"content":"..."}。',
        hints: baseHints,
      }),
    };
  }

  if ('insert_after' in raw) {
    const parsed = InsertAfterTextHunkSchema.safeParse(raw);
    if (parsed.success) return { ok: true, hunk: parsed.data };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_INSERT_AFTER_HUNK',
        message: `第 ${hunkNumber} 个 insert_after hunk 结构无效。`,
        retryable: true,
        cause: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
        fix: 'insert_after hunk 必须包含非空 insert_after 字符串和 content 字符串；锚点重复时用 occurrence 指定第 N 处。',
        hints: baseHints,
      }),
    };
  }

  if ('insert_after_line' in raw) {
    const parsed = InsertAfterLineHunkSchema.safeParse(raw);
    if (parsed.success) return { ok: true, hunk: parsed.data };
    return {
      ok: false,
      result: createToolError({
        code: 'STRUCTURED_PATCH_INVALID_INSERT_HUNK',
        message: `第 ${hunkNumber} 个 insert hunk 结构无效。`,
        retryable: true,
        cause: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
        fix: 'insert hunk 必须包含 insert_after_line 整数和 content 字符串；适合追加长文档段落。',
        hints: baseHints,
      }),
    };
  }

  const nonDefaultContentFields = fields.filter(field => !(field === 'replace_all' && raw.replace_all === false));
  if (nonDefaultContentFields.length === 1 && typeof raw.content === 'string') {
    return { ok: true, hunk: { append: true, content: raw.content, inferred: true } };
  }

  return {
    ok: false,
    result: createToolError({
      code: 'STRUCTURED_PATCH_INVALID_HUNK',
      message: `第 ${hunkNumber} 个 hunk 结构无效：无法判断 hunk 类型。`,
      retryable: true,
      cause: `hunks.${index} has no search/start_line/end_line/insert_after_line discriminator`,
      fix: '如果是替换，使用 search+replace 或 start_line+end_line+replace；如果是追加/插入，使用 content、insert_at+content 或 insert_after_line+content。',
      hints: baseHints,
      example_args: {
        path: 'docs/example.md',
        hunks: [{ content: '\n## New Section\n\nContent...\n' }],
      },
    }),
  };
}

function lineEndingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function buildSummary(path: string, before: string, after: string, dryRun: boolean, hunkCount: number): Record<string, unknown> {
  const beforeLines = countLines(before);
  const afterLines = countLines(after);
  return {
    path,
    dry_run: dryRun,
    hunk_count: hunkCount,
    before_chars: before.length,
    after_chars: after.length,
    char_delta: after.length - before.length,
    before_lines: beforeLines,
    after_lines: afterLines,
    line_delta: afterLines - beforeLines,
    changed: before !== after,
  };
}

export class StructuredPatchTool extends Tool {
  readonly name = 'structured_patch';
  readonly description = '对已有文件做增量修改。传 path、hunks、dry_run。每个 hunk 只用一种形态：search/replace、start_line/end_line/replace、insert_after_line/content、insert_after/content、insert_at/content 或 content。编辑前必须 file_read。新建文件用 file_create。';
  readonly parameters = StructuredPatchRuntimeSchema;
  readonly exposedParameters = StructuredPatchExposedSchema;

  getExecutionTimeoutMs(args: unknown): number {
    return structuredPatchTimeoutMs(args);
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsedArgs = StructuredPatchRuntimeSchema.safeParse(args);
    if (!parsedArgs.success) {
      return createToolError({
        code: 'STRUCTURED_PATCH_INVALID_ARGS',
        message: 'structured_patch 参数结构无效。',
        retryable: true,
        cause: parsedArgs.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
        fix: '对 LLM 只使用最小结构：path、hunks、dry_run。每个 hunk 只保留一种合法形态；search hunk 只允许 search/replace/replace_all/occurrence。不要把 append/prepend/start_line 等其它形态字段混入 search hunk。',
      });
    }
    const normalized = normalizeStructuredPatchParams(parsedArgs.data);
    if (!normalized.ok) return normalized.result;
    const params = normalized.params;
    let p: string;
    try {
      p = resolveTaskWritePath(context?.workspace, params.path, context?.sessionId, context?.taskWriteScope, context?.contractAllowedScope, 'modify');
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!existsSync(p)) {
      return { success: false, data: null, error: `ERROR: 文件不存在：${params.path}` };
    }
    const stat = statSync(p);
    if (stat.size > 10 * 1024 * 1024) {
      return { success: false, data: null, error: 'ERROR: 文件超过 10MB，请用更专门的流式编辑方案。' };
    }

    const raw = readFileSync(p, 'utf-8');
    const hasBom = raw.startsWith('\uFEFF');
    const original = hasBom ? raw.slice(1) : raw;
    const newline = lineEndingOf(original);
    let current = original;
    const hunkSummaries: Array<Record<string, unknown>> = [];

    for (let i = 0; i < params.hunks.length; i++) {
      const parsedHunk = parseHunk(params.hunks[i], i);
      if (!parsedHunk.ok) return parsedHunk.result;
      const hunk = parsedHunk.hunk;
      if ('search' in hunk) {
        const replaceEveryMatch = hunk.replace_all === true;
        const count = countOccurrences(current, hunk.search);
        if (count === 0) {
          return {
            ...createToolError({
              code: 'STRUCTURED_PATCH_SEARCH_NOT_FOUND',
              message: `第 ${i + 1} 个 hunk 未找到 search 片段。`,
              retryable: true,
              cause: 'search text has zero literal matches in the current file content',
              fix: '重新 file_read 目标区域后复制精确原文；如果是追加内容，优先使用 insert_after_line+content。',
              hints: { failed_hunk: i + 1, search_preview: snippet(hunk.search) },
            }),
          };
        }
        if (replaceEveryMatch && hunk.occurrence !== undefined) {
          return createToolError({
            code: 'STRUCTURED_PATCH_CONFLICTING_SEARCH_TARGETS',
            message: `第 ${i + 1} 个 hunk 同时设置了 replace_all 和 occurrence。`,
            retryable: true,
            cause: 'replace_all and occurrence are mutually exclusive search targets',
            fix: '二选一：替换全部匹配用 replace_all=true；只替换第 N 处匹配用 occurrence=N。',
            hints: {
              failed_hunk: i + 1,
              matches: count,
              search_preview: snippet(hunk.search),
              occurrence_candidates: buildOccurrenceCandidates(hunk.search, hunk.replace, count),
            },
          });
        }
        if (!replaceEveryMatch && hunk.occurrence !== undefined) {
          const lineReplacementCandidates = buildLineReplacementCandidates(current, hunk.search, hunk.replace);
          const resolvedOccurrence = resolveOccurrenceTarget(hunk.occurrence, count);
          if (resolvedOccurrence > count) {
            return createToolError({
              code: 'STRUCTURED_PATCH_INVALID_OCCURRENCE',
              message: `第 ${i + 1} 个 hunk occurrence 无效：${hunk.occurrence}，search 共 ${count} 处匹配。`,
              retryable: true,
              cause: 'occurrence is outside the literal match count',
              fix: `occurrence 必须在 1..${count} 范围内；也可改用 line_replacement_candidates 中的明确行号。`,
              hints: {
                failed_hunk: i + 1,
                matches: count,
                search_preview: snippet(hunk.search),
                match_contexts: findMatchContexts(current, hunk.search),
                occurrence_candidates: buildOccurrenceCandidates(hunk.search, hunk.replace, count),
                line_replacement_candidates: lineReplacementCandidates,
              },
            });
          }
          current = replaceNthLiteral(current, hunk.search, hunk.replace, resolvedOccurrence);
          hunkSummaries.push({
            hunk: i + 1,
            mode: 'search_occurrence',
            occurrence: resolvedOccurrence,
            occurrence_target: hunk.occurrence,
            matches: 1,
            total_matches: count,
            search_chars: hunk.search.length,
            replace_chars: hunk.replace.length,
            preview: snippet(hunk.search),
          });
          continue;
        }
        if (!replaceEveryMatch && count > 1) {
          const lineReplacementCandidates = buildLineReplacementCandidates(current, hunk.search, hunk.replace);
          const retryArgs = buildAmbiguousSearchRetryArgs(params.path, hunk.search, hunk.replace);
          const textCatalog = structuredPatchText();
          return createToolError({
            code: 'STRUCTURED_PATCH_AMBIGUOUS_SEARCH',
            message: `第 ${i + 1} 个 hunk 找到 ${count} 处匹配。`,
            retryable: true,
            cause: 'search text is not unique',
            fix: '优先使用 retry_args.first_occurrence 或 retry_args.last_occurrence 指定目标；确认要全部替换时才使用 retry_args.replace_all。若只是追加长文档，直接用 retry_args.append_eof。',
            hints: {
              failed_hunk: i + 1,
              matches: count,
              search_preview: snippet(hunk.search),
              match_contexts: findMatchContexts(current, hunk.search),
              occurrence_candidates: buildOccurrenceCandidates(hunk.search, hunk.replace, count),
              line_replacement_candidates: lineReplacementCandidates,
              if_appending_examples: [
                { path: params.path, content: maybeShortText(hunk.replace, textCatalog.reuseOriginalContent) },
                { path: params.path, hunk: { content: maybeShortText(hunk.replace, textCatalog.reuseOriginalContent) } },
                { path: params.path, hunk: { insert_at: 'end', content: maybeShortText(hunk.replace, textCatalog.reuseOriginalContent) } },
              ],
            },
            retry_args: retryArgs,
            example_args: {
              path: params.path,
              hunks: [{ search: hunk.search, replace: maybeShortText(hunk.replace, textCatalog.reuseOriginalReplace), occurrence: 1 }],
            },
          });
        }
        current = safeLiteralReplace(current, hunk.search, hunk.replace, replaceEveryMatch);
        hunkSummaries.push({
          hunk: i + 1,
          mode: 'search',
          matches: replaceEveryMatch ? count : 1,
          search_chars: hunk.search.length,
          replace_chars: hunk.replace.length,
          preview: snippet(hunk.search),
        });
        continue;
      }

      if ('insert_after' in hunk) {
        const matches = findLiteralMatchIndices(current, hunk.insert_after);
        const count = matches.length;
        if (count === 0) {
          return createToolError({
            code: 'STRUCTURED_PATCH_INSERT_AFTER_NOT_FOUND',
            message: `第 ${i + 1} 个 hunk 未找到 insert_after 锚点。`,
            retryable: true,
            cause: 'insert_after text has zero literal matches in the current file content',
            fix: '重新 file_read 目标区域后复制精确锚点；如果是追加到文件末尾，优先使用 content 或 insert_at="end"。',
            hints: { failed_hunk: i + 1, insert_after_preview: snippet(hunk.insert_after) },
          });
        }
        const occurrenceTarget = hunk.occurrence ?? 1;
        const occurrence = resolveOccurrenceTarget(occurrenceTarget, count);
        if (count > 1 && hunk.occurrence === undefined) {
          const insertAfterLineCandidates = buildInsertAfterLineCandidates(current, hunk.insert_after, hunk.content, Math.min(count, 5));
          const retryArgs = buildAmbiguousInsertAfterRetryArgs(params.path, hunk.insert_after, hunk.content);
          const textCatalog = structuredPatchText();
          return createToolError({
            code: 'STRUCTURED_PATCH_AMBIGUOUS_INSERT_AFTER',
            message: `第 ${i + 1} 个 hunk 的 insert_after 找到 ${count} 处匹配。`,
            retryable: true,
            cause: 'insert_after text is not unique',
            fix: '优先使用 retry_args.first_occurrence 或 retry_args.last_occurrence 指定目标；如果实际意图是文件末尾追加，直接用 retry_args.append_eof。',
            hints: {
              failed_hunk: i + 1,
              matches: count,
              insert_after_preview: snippet(hunk.insert_after),
              match_contexts: findMatchContexts(current, hunk.insert_after),
              occurrence_candidates: buildInsertAfterOccurrenceCandidates(hunk.insert_after, hunk.content, count),
              insert_after_line_candidates: insertAfterLineCandidates,
            },
            retry_args: retryArgs,
            example_args: {
              path: params.path,
              hunks: [{ insert_after: hunk.insert_after, content: maybeShortText(hunk.content, textCatalog.reuseOriginalContent), occurrence: 1 }],
            },
          });
        }
        if (occurrence > count) {
          return createToolError({
            code: 'STRUCTURED_PATCH_INVALID_INSERT_AFTER_OCCURRENCE',
            message: `第 ${i + 1} 个 hunk occurrence 无效：${occurrence}，insert_after 共 ${count} 处匹配。`,
            retryable: true,
            cause: 'occurrence is outside the literal anchor match count',
            fix: `occurrence 必须在 1..${count} 范围内；也可改用 insert_after_line 明确行号。`,
            hints: {
              failed_hunk: i + 1,
              matches: count,
              insert_after_preview: snippet(hunk.insert_after),
              match_contexts: findMatchContexts(current, hunk.insert_after),
              occurrence_candidates: buildInsertAfterOccurrenceCandidates(hunk.insert_after, hunk.content, count),
              insert_after_line_candidates: buildInsertAfterLineCandidates(current, hunk.insert_after, hunk.content, Math.min(count, 5)),
            },
          });
        }
        const matchIndex = matches[occurrence - 1]!;
        const insertOffset = matchIndex + hunk.insert_after.length;
        current = `${current.slice(0, insertOffset)}${hunk.content}${current.slice(insertOffset)}`;
        hunkSummaries.push({
          hunk: i + 1,
          mode: 'insert_after',
          occurrence,
          occurrence_target: occurrenceTarget,
          total_matches: count,
          inserted_lines: lineCountForInsert(hunk.content, newline),
          inserted_chars: hunk.content.length,
          anchor_preview: snippet(hunk.insert_after),
          preview: snippet(hunk.content),
        });
        continue;
      }

      if ('append' in hunk) {
        const totalLines = lineCountForInsert(current, newline);
        const insertOffset = offsetAfterLine(current, totalLines, newline);
        current = `${current.slice(0, insertOffset)}${hunk.content}${current.slice(insertOffset)}`;
        hunkSummaries.push({
          hunk: i + 1,
          mode: hunk.inferred ? 'append_eof_inferred' : 'append_eof',
          insert_after_line: totalLines,
          inserted_lines: lineCountForInsert(hunk.content, newline),
          inserted_chars: hunk.content.length,
          preview: snippet(hunk.content),
        });
        continue;
      }

      if ('prepend' in hunk) {
        current = `${hunk.content}${current}`;
        hunkSummaries.push({
          hunk: i + 1,
          mode: 'prepend_bof',
          insert_after_line: 0,
          inserted_lines: lineCountForInsert(hunk.content, newline),
          inserted_chars: hunk.content.length,
          preview: snippet(hunk.content),
        });
        continue;
      }

      if ('insert_after_line' in hunk) {
        const totalLines = lineCountForInsert(current, newline);
        if (hunk.insert_after_line > totalLines) {
          return createToolError({
            code: 'STRUCTURED_PATCH_INVALID_INSERT_LINE',
            message: `第 ${i + 1} 个 hunk 插入行无效：insert_after_line=${hunk.insert_after_line}，文件共 ${totalLines} 行。`,
            retryable: true,
            cause: 'insert_after_line is outside the current file line range',
            fix: '重新 file_read 确认行号；文件开头用 insert_after_line=0，文件末尾用 insert_after_line=总行数。',
            hints: { failed_hunk: i + 1, total_lines: totalLines },
          });
        }
        const insertOffset = offsetAfterLine(current, hunk.insert_after_line, newline);
        current = `${current.slice(0, insertOffset)}${hunk.content}${current.slice(insertOffset)}`;
        hunkSummaries.push({
          hunk: i + 1,
          mode: 'insert_after_line',
          insert_after_line: hunk.insert_after_line,
          inserted_lines: lineCountForInsert(hunk.content, newline),
          inserted_chars: hunk.content.length,
          preview: snippet(hunk.content),
        });
        continue;
      }

      const lines = current.split(newline);
      if (hunk.start_line > hunk.end_line || hunk.end_line > lines.length) {
        return createToolError({
          code: 'STRUCTURED_PATCH_INVALID_LINE_RANGE',
          message: `第 ${i + 1} 个 hunk 行范围无效：${hunk.start_line}-${hunk.end_line}，文件共 ${lines.length} 行。`,
          retryable: true,
          cause: 'line range is outside the current file line range or start_line > end_line',
          fix: '重新 file_read 确认当前行号；替换一段范围用 start_line/end_line，追加内容用 insert_after_line。',
          hints: { failed_hunk: i + 1, total_lines: lines.length },
        });
      }
      const replacement = hunk.replace.split(/\r?\n/);
      const beforeCount = hunk.end_line - hunk.start_line + 1;
      current = [
        ...lines.slice(0, hunk.start_line - 1),
        ...replacement,
        ...lines.slice(hunk.end_line),
      ].join(newline);
      hunkSummaries.push({
        hunk: i + 1,
        mode: 'lines',
        start_line: hunk.start_line,
        end_line: hunk.end_line,
        before_lines: beforeCount,
        after_lines: replacement.length,
      });
    }

    const nextContent = hasBom ? `\uFEFF${current}` : current;
    const finalText = hasBom ? nextContent.slice(1) : nextContent;
    const summary = {
      ...buildSummary(params.path, original, finalText, params.dry_run === true, params.hunks.length),
      hunks: hunkSummaries,
    };

    if (params.dry_run === true) {
      return { success: true, data: summary };
    }

    const warningMsg = extname(p) === '.py' ? await getPythonSyntaxWarningAsync(nextContent) : '';
    await lockedAtomicWrite(p, nextContent);

    return {
      success: true,
      data: {
        ...summary,
        message: `OK: structured_patch 已应用 ${params.hunks.length} 个 hunk${warningMsg}`,
      },
    };
  }
}

export default StructuredPatchTool;
