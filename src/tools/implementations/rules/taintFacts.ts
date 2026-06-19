/**
 * rules/taintFacts.ts — 污点分析的确定性事实表（propagators 透传函数 / sanitizers 净化器）。
 *
 * 这是**显式声明的事实**,不是启发式（无关键词猜测、无阈值、无 confidence）。
 * TaintFlowEngine（P3）沿这些事实做过程内/跨过程 reachability。
 *
 * P1 阶段先建立结构并导出最小种子集；P3 随结构化规则扩充。
 * 命名约定：函数名或方法名（成员访问用 `.`/`::` 连接），全字符串精确匹配，不做模糊匹配。
 */

/**
 * 已知透传函数：输入污点 → 输出/返回值污点（过程内传播）。
 * reachability 遇到这些函数调用时，把实参污点传递到调用结果。
 */
export const SEED_PROPAGATORS: readonly string[] = [
  'String',
  'toString',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'valueOf',
  'Buffer.from',
  'Buffer.concat',
  'concat',
  'substring',
  'slice',
  'replace',
  'repeat',
];

/**
 * 已知净化器：输入经此函数后不再视为污点（reachability 截断）。
 * 命中净化器即终止该污点路径，不报告。
 */
export const SEED_SANITIZERS: readonly string[] = [
  'escapeHtml',
  'escape',
  'encodeURIComponent',
  'encodeURI',
  'parameterize',
  'sanitize',
];

export interface TaintFacts {
  readonly propagators: readonly string[];
  readonly sanitizers: readonly string[];
}

/** 默认污点事实（seed 种子）。P3 用户包可覆盖。 */
export const SEED_TAINT_FACTS: TaintFacts = {
  propagators: SEED_PROPAGATORS,
  sanitizers: SEED_SANITIZERS,
};
