/**
 * fuzzyCommand — Claude Code 风格的命令模糊搜索。
 *
 * 输入 `/` 后的 query 同时匹配命令名与描述：
 *   - 子序列匹配（fzf 风格）：query 字符按序出现即命中，连续/词首加分
 *   - 名称匹配权重高于描述匹配
 *   - 支持中文描述命中（如输入「变更」匹配 /changes）
 *
 * 返回带高亮区间的结果，供 SuggestionsList 渲染下划线。
 */

export interface FuzzyCandidate {
  name: string;
  desc: string;
}

export interface FuzzyResult extends FuzzyCandidate {
  score: number;
  /** 命中区间（针对 name），[start,end) 半开，用于高亮 */
  nameMatches: Array<[number, number]>;
}

/**
 * 子序列打分：query 的每个字符按序在 text 中出现。
 * 返回 { score, matches } 或 null（未命中）。
 * 评分启发：连续命中 +、词首/分隔符后命中 +、越靠前 +。
 */
function subsequenceScore(text: string, query: string): { score: number; matches: number[] } | null {
  if (!query) return { score: 0, matches: [] };
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: number[] = [];
  let ti = 0;
  let score = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const qc = lowerQuery[qi];
    let found = -1;
    while (ti < lowerText.length) {
      if (lowerText[ti] === qc) { found = ti; break; }
      ti++;
    }
    if (found === -1) return null; // query 字符耗尽 text 仍未命中
    matches.push(found);
    // 评分
    let charScore = 1;
    if (found === prevMatch + 1) charScore += 3;       // 连续命中
    const prevChar = found > 0 ? lowerText[found - 1] : '';
    if (found === 0 || prevChar === ' ' || prevChar === '/' || prevChar === '-' || prevChar === '_') charScore += 2; // 词首
    charScore += Math.max(0, 2 - found * 0.05);        // 越靠前略加
    score += charScore;
    prevMatch = found;
    ti = found + 1;
  }
  return { score, matches };
}

/** 把命中下标列表压缩成连续区间 [start,end) */
function toRanges(indices: number[]): Array<[number, number]> {
  if (indices.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  let start = indices[0];
  let prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === prev + 1) {
      prev = indices[i];
    } else {
      ranges.push([start, prev + 1]);
      start = indices[i];
      prev = indices[i];
    }
  }
  ranges.push([start, prev + 1]);
  return ranges;
}

/**
 * 模糊搜索命令。query 不含前导 '/'（调用方剥离）。
 * 名称命中权重 ×2，描述命中权重 ×1；二者取较优并合并评分。
 */
export function fuzzySearchCommands(
  candidates: FuzzyCandidate[],
  query: string,
  limit = 8,
): FuzzyResult[] {
  const q = query.replace(/^\//, '').trim();

  // 空 query：返回原序前 limit 个（保留注册表顺序，已按类别排布）
  if (!q) {
    return candidates.slice(0, limit).map((c) => ({ ...c, score: 0, nameMatches: [] }));
  }

  const results: FuzzyResult[] = [];
  for (const cand of candidates) {
    // name 去掉前导 / 再匹配，使 query "git" 命中 "/git"
    const bareName = cand.name.replace(/^\//, '');
    const nameHit = subsequenceScore(bareName, q);
    const descHit = subsequenceScore(cand.desc, q);

    if (!nameHit && !descHit) continue;

    const nameScore = nameHit ? nameHit.score * 2 + (bareName.toLowerCase() === q.toLowerCase() ? 100 : 0) + (bareName.toLowerCase().startsWith(q.toLowerCase()) ? 20 : 0) : 0;
    const descScore = descHit ? descHit.score : 0;
    const score = nameScore + descScore;

    // name 命中区间（下标基于 bareName，+1 还原到含 '/' 的 name）
    const nameMatches = nameHit ? toRanges(nameHit.matches.map((i) => i + 1)) : [];

    results.push({ ...cand, score, nameMatches });
  }

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results.slice(0, limit);
}
