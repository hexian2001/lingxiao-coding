import type { ToolDiffLine } from '../../commands/types.js';
import { t } from '../../i18n.js';

/** 编辑类工具规范名 → 是否产出 diff */
const EDIT_TOOLS = new Set([
  'structured_patch',
]);

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName.toLowerCase());
}

/**
 * 单个 search/replace 对的最小行级 diff。
 *
 * 不做完整 Myers diff —— 工具入参里的 search/replace 已是「精确替换片段」，
 * 前后通常各有少量共享行。我们裁掉公共前后缀，中间用 -/+ 表示，足够在终端展示「改了什么」。
 */
export function buildSearchReplaceDiff(
  search: string,
  replace: string,
  maxLines = 40,
): ToolDiffLine[] {
  const searchLines = search.split('\n');
  const replaceLines = replace.split('\n');

  // 公共前缀
  let prefix = 0;
  while (
    prefix < searchLines.length &&
    prefix < replaceLines.length &&
    searchLines[prefix] === replaceLines[prefix]
  ) {
    prefix++;
  }

  // 公共后缀（不与前缀重叠）
  let suffix = 0;
  while (
    suffix < searchLines.length - prefix &&
    suffix < replaceLines.length - prefix &&
    searchLines[searchLines.length - 1 - suffix] === replaceLines[replaceLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = searchLines.slice(prefix, searchLines.length - suffix);
  const added = replaceLines.slice(prefix, replaceLines.length - suffix);

  const lines: ToolDiffLine[] = [];
  // 至多一行上下文（前缀最后一行）做锚点
  if (prefix > 0) {
    lines.push({ kind: 'context', text: searchLines[prefix - 1] });
  }
  for (const text of removed) lines.push({ kind: 'del', text });
  for (const text of added) lines.push({ kind: 'add', text });
  if (suffix > 0) {
    lines.push({ kind: 'context', text: searchLines[searchLines.length - suffix] });
  }

  return capDiff(lines, maxLines);
}

/** 截断过长 diff，中间插入省略标记 */
function capDiff(lines: ToolDiffLine[], maxLines: number): ToolDiffLine[] {
  if (lines.length <= maxLines) return lines;
  const head = Math.ceil(maxLines / 2);
  const tail = Math.floor(maxLines / 2);
  const hidden = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    { kind: 'hunk', text: t('tui.diff.hidden', hidden) },
    ...lines.slice(lines.length - tail),
  ];
}

/**
 * 从工具入参提取 diff。
 * - structured_patch: { hunks: [{ search, replace }] }
 * 任何解析失败都返回 undefined（调用方回退到普通摘要）。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

export function extractToolDiff(toolName: string, input: unknown): ToolDiffLine[] | undefined {
  if (!isEditTool(toolName)) return undefined;
  let parsed: unknown;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {/* expected: resource not available */
    return undefined;
  }
  const args = asRecord(parsed);
  if (!args) return undefined;

  if (Array.isArray(args.hunks)) {
    const out: ToolDiffLine[] = [];
    for (let i = 0; i < args.hunks.length; i++) {
      const hunk = asRecord(args.hunks[i]);
      if (typeof hunk?.search !== 'string' || typeof hunk.replace !== 'string') continue;
      if (i > 0) out.push({ kind: 'hunk', text: t('tui.diff.hunk', i + 1) });
      out.push(...buildSearchReplaceDiff(hunk.search, hunk.replace));
    }
    return out.length > 0 ? capDiff(out, 60) : undefined;
  }

  return undefined;
}
