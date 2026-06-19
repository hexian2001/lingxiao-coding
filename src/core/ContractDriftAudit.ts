/**
 * ContractDriftAudit — 契约漂移校验(实现 vs 声明)。纯函数,零启发式。
 *
 * 输入:声明 ContractPack entries + 代码 surface 集合(由 ContractAuditGenerator.getCodeSurfaces
 * 经 LLM 从真实代码反推)。输出两类漂移:
 *  - missing:代码有实现但无契约声明(应补,建议 /contract audit generate);
 *  - extra:契约声明了但代码无对应实现(可能 obsolete,应核对/删除)。
 *
 * mismatch(实现细节 vs 契约 content 的语义对比)需语义比对,复杂度高,后置。
 * 本模块只做确定性集合差集,不臆测。
 */
import type { ContractPackEntry } from './ContractPack.js';

export interface ContractDriftExtra {
  readonly surface: string;
  readonly title: string;
}

export interface ContractDrift {
  /** 代码有实现但无契约声明。 */
  readonly missing: readonly string[];
  /** 契约声明了但代码无对应实现(obsolete)。 */
  readonly extra: readonly ContractDriftExtra[];
  readonly declaredSurfaces: readonly string[];
  readonly codeSurfaces: readonly string[];
}

export function computeContractDrift(
  declared: readonly ContractPackEntry[],
  codeSurfaces: readonly string[],
): ContractDrift {
  const declaredSet = new Set(declared.map((e) => e.surface));
  const codeSet = new Set(codeSurfaces.map((s) => s.trim()).filter(Boolean));
  const missing = [...codeSet].filter((s) => !declaredSet.has(s)).sort();
  const extra = declared
    .filter((e) => !codeSet.has(e.surface))
    .map((e) => ({ surface: e.surface, title: e.title }))
    .sort((a, b) => a.surface.localeCompare(b.surface));
  return {
    missing,
    extra,
    declaredSurfaces: [...declaredSet].sort(),
    codeSurfaces: [...codeSet].sort(),
  };
}

/** 漂移报告(文本,供命令输出;office 渲染后置)。 */
export function renderContractDriftReport(drift: ContractDrift): string {
  const lines: string[] = ['[契约漂移校验]'];
  lines.push(`声明 ${drift.declaredSurfaces.length} surface · 代码识别 ${drift.codeSurfaces.length} surface`);
  if (drift.missing.length > 0) {
    lines.push(`⚠ 缺失契约(代码有实现但无声明,建议 /contract audit generate 补): ${drift.missing.join(', ')}`);
  }
  if (drift.extra.length > 0) {
    lines.push(`⚠ 过时契约(声明了但代码无对应实现,建议核对/删除): ${drift.extra.map((e) => `${e.surface}(${e.title})`).join(', ')}`);
  }
  if (drift.missing.length === 0 && drift.extra.length === 0) {
    lines.push('✓ 契约与代码实现一致(无 missing/extra 漂移)。');
  }
  return lines.join('\n');
}
