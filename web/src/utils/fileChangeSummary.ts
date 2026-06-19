type ChangeKind = 'create' | 'edit';

type PlainObject = Record<string, unknown>;

const ADD_KEYS = new Set([
  'additions',
  'addition',
  'addedLines',
  'linesAdded',
  'insertions',
  'insertedLines',
  'createdLines',
]);

const DEL_KEYS = new Set([
  'deletions',
  'deletion',
  'deletedLines',
  'linesDeleted',
  'removals',
  'removedLines',
]);

const CONTENT_KEYS = ['content', 'text', 'body', 'data'];
const DIFF_KEYS = ['diff', 'patch', 'unifiedDiff', 'unified_diff'];
const SEARCH_KEY = 'search';
const REPLACE_KEY = 'replace';

function parseMaybeObject(value: unknown): PlainObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as PlainObject;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PlainObject : null;
  } catch {
    return null;
  }
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').length;
  return normalized.endsWith('\n') ? Math.max(0, lines - 1) : lines;
}

function findStringField(obj: PlainObject | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return null;
}

function findStructuredCounts(value: unknown): { additions?: number; deletions?: number } {
  const obj = parseMaybeObject(value);
  if (!obj) return {};
  const out: { additions?: number; deletions?: number } = {};
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, raw] of Object.entries(node as PlainObject)) {
      const numeric = asNumber(raw);
      if (numeric !== null) {
        if (ADD_KEYS.has(key) && out.additions === undefined) out.additions = numeric;
        if (DEL_KEYS.has(key) && out.deletions === undefined) out.deletions = numeric;
      }
      if (out.additions !== undefined && out.deletions !== undefined) return;
      if (raw && typeof raw === 'object') visit(raw);
    }
  };
  visit(obj);
  return out;
}

function countUnifiedDiff(diff: string): { additions: number; deletions: number } | null {
  if (!diff || !/(^|\n)(@@ |diff --git |--- |\+\+\+ |\*\*\* (Begin Patch|Update File|Add File|Delete File))/m.test(diff)) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const line of diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : null;
}

function findDiffCounts(...values: unknown[]): { additions: number; deletions: number } | null {
  for (const value of values) {
    const obj = parseMaybeObject(value);
    if (obj) {
      for (const key of DIFF_KEYS) {
        const raw = obj[key];
        if (typeof raw === 'string') {
          const counted = countUnifiedDiff(raw);
          if (counted) return counted;
        }
      }
    }
    const counted = countUnifiedDiff(stringify(value));
    if (counted) return counted;
  }
  return null;
}

function findReplacementCounts(value: unknown): { additions: number; deletions: number } | null {
  const obj = parseMaybeObject(value);
  if (!obj) return null;

  const hunksInput = obj.hunks ?? obj.hunk;
  const hunks = Array.isArray(hunksInput)
    ? hunksInput
    : hunksInput === undefined
      ? [obj]
      : [hunksInput];

  let additions = 0;
  let deletions = 0;
  let found = false;
  for (const rawHunk of hunks) {
    const hunk = parseMaybeObject(rawHunk);
    if (!hunk) continue;

    const startLine = asNumber(hunk.start_line);
    const endLine = asNumber(hunk.end_line);
    if (startLine !== null && endLine !== null && typeof hunk[REPLACE_KEY] === 'string') {
      found = true;
      additions += countLines(hunk[REPLACE_KEY]);
      deletions += Math.max(0, endLine - startLine + 1);
      continue;
    }

    const search = hunk[SEARCH_KEY];
    const replace = hunk[REPLACE_KEY];
    if (typeof search === 'string' || typeof replace === 'string') {
      found = true;
      additions += countLines(typeof replace === 'string' ? replace : '');
      deletions += countLines(typeof search === 'string' ? search : '');
      continue;
    }

    const content = hunk.content;
    if (typeof content === 'string' && (
      'insert_after_line' in hunk
      || 'insert_after' in hunk
      || 'insert_at' in hunk
      || hunk.append === true
      || hunk.prepend === true
    )) {
      found = true;
      additions += countLines(content);
      continue;
    }
  }
  return found ? { additions, deletions } : null;
}

function findCreatedLineCount(value: unknown): number | null {
  const obj = parseMaybeObject(value);
  const content = findStringField(obj, CONTENT_KEYS);
  return content === null ? null : countLines(content);
}

export function formatFileChangeSummary(input: unknown, result: unknown, kind: ChangeKind): string | null {
  const resultCounts = findStructuredCounts(result);
  const inputCounts = findStructuredCounts(input);
  let additions = resultCounts.additions ?? inputCounts.additions;
  let deletions = resultCounts.deletions ?? inputCounts.deletions;

  if (additions === undefined || deletions === undefined) {
    const diffCounts = findDiffCounts(input, result);
    if (diffCounts) {
      additions = additions ?? diffCounts.additions;
      deletions = deletions ?? diffCounts.deletions;
    }
  }

  if (kind === 'edit' && (additions === undefined || deletions === undefined)) {
    const replacementCounts = findReplacementCounts(input);
    if (replacementCounts) {
      additions = additions ?? replacementCounts.additions;
      deletions = deletions ?? replacementCounts.deletions;
    }
  }

  if (kind === 'create' && additions === undefined) {
    const createdLines = findCreatedLineCount(input);
    if (createdLines !== null) {
      additions = createdLines;
      deletions = deletions ?? 0;
    }
  }

  if (additions === undefined && deletions === undefined) return null;
  const add = additions ?? 0;
  const del = deletions ?? 0;
  if (add === 0 && del === 0) return null;
  return del > 0 ? `+${add} -${del}` : `+${add}`;
}
