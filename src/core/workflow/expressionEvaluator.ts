/**
 * expressionEvaluator - 共享的表达式求值函数
 *
 * 求值委托给 {@link ./safeExpressionEvaluator.ts} 的 AST 白名单解释器：
 * 表达式先经 acorn 解析为 AST，再在封闭节点白名单内递归求值。
 *
 * 安全模型（确定性、结构化）：
 *   - 仅允许的字面量 / 标识符 / 成员访问 / 调用 / 运算 / 条件等节点。
 *   - 标识符只能解析注入的 scope 名 + 白名单全局（Math/Date/JSON/Array...）；
 *     未注入的标识符（process / require / globalThis / fetch ...）一律不可解析。
 *   - 成员访问封堵 `constructor` / `__proto__` / `prototype`，从构造上断绝
 *     `{}.constructor.constructor('return process')()` 这条逃逸链。
 *   - 全程不调用 `eval` / `new Function`，不接触 `globalThis`。
 *
 * 这是 workflow 表达式的硬安全边界，由 workflow sandbox gate 统一收口。
 * 调用方仍应在可信 workflow 来源下使用——白名单封堵逃逸，但不限制合法表达式的能力。
 */

import { evaluateSafeExpression } from './safeExpressionEvaluator.js';

/**
 * 在 AST 白名单沙箱内求值表达式，返回 Boolean 化结果。
 *
 * @param expression - 待求值的 JS 表达式字符串
 * @param scope - 注入的变量作用域（key → 值；仅这些名字可被标识符访问，外加白名单全局）
 * @returns 表达式求值结果（Boolean 化）
 * @throws 表达式含不允许的节点/属性/逃逸企图时抛错
 */
export function evaluateExpression(expression: string, scope: Record<string, unknown>): boolean {
  try {
    return evaluateSafeExpression(expression, scope);
  } catch (error) {
    throw new Error(
      `Expression evaluation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

