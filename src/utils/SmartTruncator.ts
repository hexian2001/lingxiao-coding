/**
 * 确定性输出截断（禁止启发式）。
 *
 * 设计原则：
 * - 不再用关键词正则（ERROR/failed/...）判定是否保留尾部——改为**始终 head+tail 截断**：
 *   既保留开头上下文，也保留结尾结果/错误，对成功与失败输出都是最优覆盖，且完全可预测。
 * - JSON 单文档走**边界感知**截断：在元素/键边界切断并标注省略量，避免 byte/line 切在
 *   token 中间产生无效 JSON（`{"error":null}`、`"failed":0` 等正常字段不会再触发误判模式）。
 */

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

/** 判断文本是否以 JSON 文档开头（首个非空白字符为 { 或 [）。 */
function looksLikeJsonDocument(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return ch === '{' || ch === '[';
  }
  return false;
}

/**
 * 确定性截断：超限时，JSON 走边界感知；其余走 head+tail。
 *
 * @param output    - Raw output string
 * @param maxBytes  - Maximum byte budget (default 51200 = 50 KiB)
 * @param maxLines  - Maximum line budget (default 2000)
 */
export function smartTruncate(
  output: string,
  maxBytes: number = 51200,
  maxLines: number = 2000,
): TruncationResult {
  const byteLength = Buffer.byteLength(output, 'utf-8');
  const lines = output.split('\n');

  if (byteLength <= maxBytes && lines.length <= maxLines) {
    return { text: output, truncated: false };
  }

  if (looksLikeJsonDocument(output)) {
    return jsonAwareTruncate(output, maxBytes);
  }

  return headTailTruncate(lines, maxLines, maxBytes);
}

/**
 * JSON 边界感知截断：在 maxBytes 内回退到最后一个元素/行边界，避免切在 token 中间。
 */
function jsonAwareTruncate(output: string, maxBytes: number): TruncationResult {
  const buf = Buffer.from(output, 'utf-8');
  if (buf.length <= maxBytes) return { text: output, truncated: false };

  const head = buf.subarray(0, maxBytes).toString('utf-8');
  // 候选边界：对象/数组元素结束、逗号、换行——取 maxBytes 后半段内最后一个。
  let boundary = -1;
  for (const sep of ['},', '],', ',', '\n']) {
    const idx = head.lastIndexOf(sep);
    if (idx > boundary && idx > maxBytes * 0.5) {
      boundary = idx + sep.length;
    }
  }
  const cut = boundary > 0 ? boundary : maxBytes;
  const kept = head.slice(0, cut);
  const omitted = buf.length - Buffer.byteLength(kept, 'utf-8');
  return {
    text: `${kept}\n... (JSON output truncated, ~${omitted} bytes omitted) ...`,
    truncated: true,
  };
}

/**
 * head+tail 模式：70% head，30% tail，中间插省略标记。始终使用（不再按关键词切换）。
 */
function headTailTruncate(
  lines: string[],
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  const effectiveLineLimit = Math.min(maxLines, lines.length);
  const headLineCount = Math.max(Math.floor(effectiveLineLimit * 0.7), 1);
  const tailLineCount = Math.max(effectiveLineLimit - headLineCount, 1);

  let headLines = lines.slice(0, headLineCount);
  let tailLines = lines.slice(Math.max(lines.length - tailLineCount, headLineCount));

  const buildResult = (): string => {
    const omittedCount = lines.length - headLines.length - tailLines.length;
    const marker = `\n... (${omittedCount} lines omitted) ...\n`;
    return headLines.join('\n') + marker + tailLines.join('\n');
  };

  let result = buildResult();

  // 字节预算：先削 head，再削 tail。
  while (Buffer.byteLength(result, 'utf-8') > maxBytes && headLines.length > 1) {
    headLines = headLines.slice(0, headLines.length - 1);
    result = buildResult();
  }
  while (Buffer.byteLength(result, 'utf-8') > maxBytes && tailLines.length > 1) {
    tailLines = tailLines.slice(1);
    result = buildResult();
  }

  return { text: result, truncated: true };
}
