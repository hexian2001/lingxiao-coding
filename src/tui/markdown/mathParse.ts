/**
 * 数学公式定界符解析（纯函数，零依赖）。
 *
 * 行内公式 `$...$` 与块级公式 `$$...$$` 的提取，配合 latexToUnicode 做符号转换。
 * 全程确定性：仅依据「成对 `$` 定界符」语法判定，不做关键词/阈值猜测。
 *
 * 行内 `$...$` 的误判控制（如价格 $5、shell $HOME）：
 * - 开 `$` 前不能是 `\` / `$` / 字母数字下划线（lookbehind），闭 `$` 后不能是字母数字下划线。
 * - 单个不成对 `$`（价格）不替换；两个 `$` 夹一段含「$后接字母数字」的文本时，
 *   `(?!\w)` 会让该 `$` 不作为闭合符，从而整段不匹配 → 原样保留。
 */

import { latexToUnicode } from './latexToUnicode.js';

/**
 * 行内公式定界符正则。
 * - `(?<![\\$\w])` 开 $ 前：排除转义反斜杠、连续 $、标识符字符。
 * - `([^\$\n]+?)` 内容：非贪婪，不含 $ 和换行。
 * - `(?!\w)` 闭 $ 后：不能紧跟字母数字下划线（价格 $10 的 $ 不算闭合符）。
 */
const INLINE_MATH_RE = /(?<![\\$\w])\$([^\$\n]+?)\$(?!\w)/g;

/**
 * 把一行里的行内 `$...$` 公式就地替换为 Unicode 近似文本。
 * 不成对 / 不符合定界规则的 `$` 原样保留。
 */
export function replaceInlineMath(line: string): string {
  if (!line.includes('$')) return line;
  return line.replace(INLINE_MATH_RE, (_match, body: string) => latexToUnicode(body));
}

export interface DisplayMath {
  /** `$$` 之间的原始 LaTeX 内容（未转换，调用方自行 latexToUnicode）。 */
  block: string;
  /** 跨过的行数（含起始行）；未闭合返回 0。 */
  consumed: number;
  /** 是否找到闭合 `$$`。 */
  closed: boolean;
}

/**
 * 从 `lines[start]` 提取块级公式 `$$...$$`（支持同行闭合与跨行）。
 * `lines[start]` 必须包含 `$$`（调用方保证，通常为行首）。
 * 未闭合（找不到配对 `$$`）返回 closed:false，调用方应将其当普通文本处理。
 */
export function extractDisplayMath(lines: readonly string[], start: number): DisplayMath {
  const first = lines[start];
  if (first === undefined) return { block: '', consumed: 0, closed: false };
  const openIdx = first.indexOf('$$');
  if (openIdx < 0) return { block: '', consumed: 0, closed: false };

  const afterOpen = first.slice(openIdx + 2);

  // 同行闭合：`$$ ... $$`
  const closeSame = afterOpen.indexOf('$$');
  if (closeSame >= 0) {
    return { block: afterOpen.slice(0, closeSame).trim(), consumed: 1, closed: true };
  }

  // 跨行：收集起始行剩余 + 后续行，直到含 `$$` 的行
  const parts: string[] = [];
  if (afterOpen.trim() !== '') parts.push(afterOpen);
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j]!;
    const closeIdx = line.indexOf('$$');
    if (closeIdx >= 0) {
      const before = line.slice(0, closeIdx);
      if (before.trim() !== '') parts.push(before);
      return { block: parts.join('\n').trim(), consumed: j - start + 1, closed: true };
    }
    parts.push(line);
  }

  // 未闭合
  return { block: '', consumed: 0, closed: false };
}
