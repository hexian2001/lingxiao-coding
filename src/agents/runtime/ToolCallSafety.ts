import type { ToolCall } from '../../llm/types.js';
import type { ToolCallExecution } from './ToolResponseProcessor.js';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { registerCleanup } from '../../core/CleanupRegistry.js';

const TRUNCATED_OUTPUT_REJECTED_TOOLS = new Set(['structured_patch', 'file_create']);

// ─── Partial Content Rescue Config ──────────────────────────────────────────

/** 拒绝消息中内联预览的最大字符数（避免消息本身撑爆上下文） */
const PARTIAL_PREVIEW_CHARS = 2000;
/** 临时文件追踪上限（FIFO 淘汰最旧） */
const MAX_PARTIAL_TEMP_FILES = 20;

// ─── Partial Content Temp File Tracking ──────────────────────────────────────
// 与 Shell.ts 的 trackShellTempFile 同一模式：Map 保留插入序，头部即最旧，
// 超上限时 FIFO 淘汰；进程退出时 registerCleanup 清理所有残留文件。

const partialTempFiles = new Map<string, number>();

function trackPartialTempFile(filePath: string): void {
  partialTempFiles.set(filePath, Date.now());
  while (partialTempFiles.size > MAX_PARTIAL_TEMP_FILES) {
    const oldest = partialTempFiles.keys().next().value;
    if (oldest === undefined) break;
    try { rmSync(oldest, { force: true }); } catch { /* tolerate */ }
    partialTempFiles.delete(oldest);
  }
}

registerCleanup(() => {
  for (const p of partialTempFiles.keys()) {
    try { rmSync(p, { force: true }); } catch { /* tolerate */ }
  }
  partialTempFiles.clear();
}, 19);

// ─── JSON Argument Parsing ───────────────────────────────────────────────────

/**
 * 尝试解析工具调用的 arguments JSON。
 * 返回 null 表示解析失败（参数被截断或为空）。
 */
function tryParseArgs(argsStr: string): Record<string, unknown> | null {
  if (!argsStr) return null;
  try {
    const parsed = JSON.parse(argsStr);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 检测工具调用的 arguments 是否为空对象 `{}`。
 * 当 streaming 截断导致 arguments chunks 丢失时，parser 会返回空对象。
 * 对文件编辑类工具，空参数永远不合法。
 */
function hasEmptyArgs(toolCall: ToolCall): boolean {
  const argsStr = toolCall.function.arguments;
  if (!argsStr) return true;
  try {
    const parsed = JSON.parse(argsStr);
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

// ─── Partial Content Extraction ──────────────────────────────────────────────

/**
 * 反转义 JSON 字符串中的转义序列。
 * 使用单次正则扫描避免多次 replace 的顺序依赖问题。
 */
function unescapeJsonString(s: string): string {
  return s.replace(/\\(u[\dA-Fa-f]{4}|.)/g, (_match, seq: string) => {
    if (seq[0] === 'u') {
      try { return String.fromCharCode(parseInt(seq.slice(1), 16)); } catch { return seq; }
    }
    switch (seq) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return seq; // 未知转义：保留字符
    }
  });
}

/**
 * 从截断的 file_create arguments 中提取 partial content。
 *
 * 当 max_tokens 截断导致 JSON 不完整时，JSON.parse 会失败。
 * 此函数用正则从残缺 JSON 中提取 "content" 字段的已传输部分，
 * 即使字符串没有闭合引号也能提取。
 *
 * 返回 null 表示无法提取（如 content 字段尚未开始传输）。
 */
export function extractPartialFileContent(argsStr: string): string | null {
  if (!argsStr) return null;
  // 匹配 "content":"..." — 即使字符串被截断（无闭合引号）也能捕获已传输部分。
  // (?:[^"\\]|\\.)* 匹配非引号非反斜杠字符或转义序列，不要求闭合引号。
  const match = argsStr.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!match || !match[1]) return null;
  return unescapeJsonString(match[1]);
}

/**
 * 从截断的 arguments 中提取 path 字段。
 * path 通常在 content 之前传输，所以即使 content 被截断，path 往往是完整的。
 */
export function extractPathFromArgs(argsStr: string): string | null {
  if (!argsStr) return null;
  const match = argsStr.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match || !match[1]) return null;
  return unescapeJsonString(match[1]);
}

/**
 * 将 partial content 保存到临时文件，返回文件路径。
 * 模型可用 file_read 读取完整部分内容，避免在上下文中重复传输。
 */
function savePartialContent(content: string): string | null {
  try {
    const tmpFile = join(tmpdir(), `lingxiao_partial_${randomUUID()}.txt`);
    writeFileSync(tmpFile, content, 'utf-8');
    trackPartialTempFile(tmpFile);
    return tmpFile;
  } catch {
    return null;
  }
}

// ─── Rescue Message Builders ─────────────────────────────────────────────────

/**
 * 为被截断的 file_create 构建结构化拒绝消息。
 */
function buildFileCreateRescueMessage(
  targetPath: string | null,
  partialContent: string | null,
  partialFilePath: string | null,
): string {
  const parts: string[] = [
    `[截断保护] file_create 的 content 参数在传输中被截断，已拒绝执行以防止写入不完整文件。`,
  ];

  if (targetPath) {
    parts.push(`目标文件: ${targetPath}`);
  }

  if (partialContent && partialContent.length > 0) {
    parts.push(`已提取部分内容: ${partialContent.length} 字符`);
    if (partialFilePath) {
      parts.push(`完整部分内容已保存到: ${partialFilePath}（可用 file_read 读取）`);
    }
    const preview = partialContent.slice(0, PARTIAL_PREVIEW_CHARS);
    if (partialContent.length > PARTIAL_PREVIEW_CHARS) {
      parts.push(
        `部分内容预览（前 ${PARTIAL_PREVIEW_CHARS} 字符）:\n${preview}\n...（剩余 ${partialContent.length - PARTIAL_PREVIEW_CHARS} 字符已保存到临时文件）`,
      );
    } else {
      parts.push(`部分内容:\n${preview}`);
    }
  }

  parts.push('');
  parts.push('续接策略（选择一种，不要从头重新生成整个文件）:');
  parts.push('1. 拆分写入: 用 file_create 写入已提取的部分内容（到截断点为止），再用 structured_patch 的 append hunk 追加剩余内容');
  parts.push('2. 分段写入: 将完整文件按逻辑段落拆分为多次 file_create + structured_patch append，每次 content 不超过 800 行');
  parts.push('3. 如果部分内容不可用或质量不确定，从头生成但务必控制单次写入长度在 800 行以内');

  return parts.join('\n');
}

/**
 * 为被截断的 structured_patch 构建拒绝消息。
 */
function buildStructuredPatchRescueMessage(
  targetPath: string | null,
): string {
  const parts: string[] = [
    `[截断保护] structured_patch 的参数在传输中被截断，已拒绝执行以防止错误修改文件。`,
  ];

  if (targetPath) {
    parts.push(`目标文件: ${targetPath}`);
  }

  parts.push('');
  parts.push('续接策略:');
  parts.push('1. 减少 hunk 数量: 每次只传 1-2 个 hunk，确保每个 hunk 的 search/replace 内容完整');
  parts.push('2. 缩短 replace 内容: 如果单个 hunk 的 replace 内容过长，拆分为多个小 hunk 分批执行');
  parts.push('3. 先 file_read 确认文件当前内容，再分批 patch');

  return parts.join('\n');
}

/**
 * 为空参数的文件工具构建拒绝消息（参数在流式传输中完全丢失）。
 */
function buildEmptyArgsMessage(toolName: string): string {
  return [
    `[参数丢失] 工具 "${toolName}" 的参数在流式传输中丢失（收到空对象 {}）。这通常是因为模型输出被截断或 streaming 连接中断。`,
    '',
    '续接策略:',
    '1. 重新生成完整的工具调用，确保包含所有必需参数（path、content 等）',
    '2. 如果内容过长导致截断，将文件拆分为多次写入：先 file_create 写前半部分，再 structured_patch append 追加后半部分',
    '3. 每次 content 控制在 800 行以内以避免再次截断',
  ].join('\n');
}
// ─── Main Functions ──────────────────────────────────────────────────────────

/**
 * 检测 file_create 的 content 参数是否可能被截断。
 *
 * StreamingToolCallParser 的 safeJsonParse 会尝试闭合残缺 JSON（补引号+括号），
 * 修复后 JSON.parse 成功但 content 值实际是被截断的。此时 arguments 是合法 JSON，
 * 但文件内容不完整——直接执行会写入半截文件。
 *
 * 检测策略：如果 content 字段存在且非空，但 JSON 字符串以 content 值的闭合引号
 * 之前结束（即原始 arguments 字符串不以 } 闭合），视为被截断。
 */
function isFileCreateContentTruncated(argsStr: string, parsed: Record<string, unknown>): boolean {
  // 原始 JSON 字符串必须以 } 闭合才算完整
  const trimmed = argsStr.trim();
  if (trimmed.endsWith('}')) return false;
  // 不以 } 结尾 = 原始 JSON 被截断后由 safeJsonParse 修复
  // 如果 content 字段存在，说明 content 值可能不完整
  return parsed.content !== undefined && parsed.content !== null;
}

/**
 * 截断保护 + Partial Content Rescue。
 *
 * 当 wasOutputTruncated=true 时调用。改进点：
 * 1. 先尝试 JSON.parse — 如果参数完整且未被截断（JSON 以 } 闭合），正常执行。
 * 2. 如果 JSON.parse 成功但原始字符串不以 } 结尾（safeJsonParse 修复的截断 JSON），
 *    仍然拦截——content 值可能被截断，直接写入会生成不完整文件。
 * 3. 如果 JSON.parse 失败（参数严重截断），从残缺 JSON 中提取 partial content 并落盘，
 *    返回带续接策略的结构化拒绝消息。
 * 4. 对 file_create 提取 content 字段；对 structured_patch 不提取（hunk 结构复杂，
 *    半截 hunk 应用会导致错误修改），只给出续接指导。
 */
export function executeToolCallsWithTruncationGuard(
  toolCalls: ToolCall[],
  executeToolCallsBatch: (toolCalls: ToolCall[]) => Promise<ToolCallExecution[]>,
): Promise<ToolCallExecution[]> {
  const safeToolCalls: ToolCall[] = [];
  const rescueResults: ToolCallExecution[] = [];

  for (const tc of toolCalls) {
    if (!TRUNCATED_OUTPUT_REJECTED_TOOLS.has(tc.function.name)) {
      // 非文件编辑工具：不受截断保护约束，正常执行
      safeToolCalls.push(tc);
      continue;
    }

    const argsStr = tc.function.arguments || '';
    const parsed = tryParseArgs(argsStr);

    // 路径 A：JSON.parse 成功且原始字符串以 } 闭合 = 参数真正完整
    if (parsed !== null && !isFileCreateContentTruncated(argsStr, parsed)) {
      safeToolCalls.push(tc);
      continue;
    }

    // 路径 B：JSON.parse 失败 或 safeJsonParse 修复的截断 JSON → 拦截 + Rescue
    const targetPath = extractPathFromArgs(argsStr);

    if (tc.function.name === 'file_create') {
      // 优先从原始残缺字符串提取（更完整），fallback 到 parsed 中的值
      let partialContent = extractPartialFileContent(argsStr);
      if (!partialContent && parsed && typeof parsed.content === 'string') {
        // safeJsonParse 修复后的 content 值（可能被截断但仍是有效字符串）
        partialContent = parsed.content;
      }
      const partialFilePath = partialContent && partialContent.length > 0
        ? savePartialContent(partialContent)
        : null;
      rescueResults.push({
        toolCall: tc,
        result: buildFileCreateRescueMessage(targetPath, partialContent, partialFilePath),
      });
    } else if (tc.function.name === 'structured_patch') {
      rescueResults.push({
        toolCall: tc,
        result: buildStructuredPatchRescueMessage(targetPath),
      });
    } else {
      rescueResults.push({
        toolCall: tc,
        result: buildEmptyArgsMessage(tc.function.name),
      });
    }
  }

  const results = safeToolCalls.length > 0
    ? executeToolCallsBatch(safeToolCalls)
    : Promise.resolve([]);

  return results.then(r => [...r, ...rescueResults]);
}

/**
 * 空参数保护：拦截文件编辑类工具的空 `{}` 参数调用。
 *
 * 当 streaming 截断（如 max_tokens 耗尽、provider 中断）导致 tool call 的
 * arguments chunks 丢失时，StreamingToolCallParser 会返回 args={}。
 * 对文件编辑工具这永远不合法——阻止执行并给出明确提示，避免模型因误解错误信息而死循环重试。
 *
 * 此函数在 wasOutputTruncated=false 时也可独立使用。
 * 改进：拒绝消息升级为带续接策略的结构化消息，而非简单的"请重新输出"。
 */
export function rejectEmptyArgsFileTools(
  toolCalls: ToolCall[],
  executeToolCallsBatch: (toolCalls: ToolCall[]) => Promise<ToolCallExecution[]>,
): Promise<ToolCallExecution[]> {
  const emptyArgsFileTools: ToolCall[] = [];
  const normalToolCalls: ToolCall[] = [];

  for (const tc of toolCalls) {
    if (TRUNCATED_OUTPUT_REJECTED_TOOLS.has(tc.function.name) && hasEmptyArgs(tc)) {
      emptyArgsFileTools.push(tc);
    } else {
      normalToolCalls.push(tc);
    }
  }

  const results = normalToolCalls.length > 0
    ? executeToolCallsBatch(normalToolCalls)
    : Promise.resolve([]);

  const rejectedResults = emptyArgsFileTools.map(tc => ({
    toolCall: tc,
    result: buildEmptyArgsMessage(tc.function.name),
  }));

  return results.then(r => [...r, ...rejectedResults]);
}