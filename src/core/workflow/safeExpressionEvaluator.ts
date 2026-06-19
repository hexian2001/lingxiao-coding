/**
 * 安全表达式求值器（AST 白名单解释器，构造上不可逃逸）。
 *
 * 替换历史上的 `new Function` 裸 eval（见原 expressionEvaluator.ts 的 RCE 注释）。
 * 原方案在主进程直接执行任意 JS，scope 只是命名参数、非真正沙箱——表达式可经
 * `constructor` / `globalThis` / `eval` 逃逸，读取 env / 访问 FS / 发起网络 / 执行 shell。
 *
 * 本实现用 acorn 把表达式解析为 AST，然后只在一个**封闭的节点白名单**里递归求值：
 *   - 允许的节点：字面量 / 标识符（仅注入的 scope 名 + 白名单全局）/ 成员访问 /
 *     调用 / 一元·二元·逻辑·条件·数组·对象·展开·模板·序列表达式 等。
 *   - 求值环境是一个冻结的 scope Map：成员访问只在普通对象/数组/白名单全局函数上发生，
 *     且对 `constructor` / `prototype` / `__proto__` 属性一律封堵——从构造上断绝
 *     `{}.constructor.constructor('return process')()` 这条逃逸链。
 *   - 不调用 `eval`、不调用 `new Function`、不接触 `globalThis`；宿主进程里任何
 *     未通过 scope 显式注入的东西（process / require / fetch / fs…）表达式都拿不到。
 *
 * 这是确定性、结构化的安全边界：判定基于 AST 节点类型与属性名，不依赖任何启发式。
 */

import { parseExpressionAt } from 'acorn';

/** 标识符求值时允许的全局函数（仅这些名字会落到对应的宿主实现）。 */
const ALLOWED_GLOBALS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['Math', Math],
  ['Date', Date],
  ['JSON', JSON],
  ['String', String],
  ['Number', Number],
  ['Boolean', Boolean],
  ['Array', Array],
  ['Object', Object],
  // 显式不放 process / global / globalThis / require / eval / fetch / Buffer / Function 等。
]);

/** 成员访问封堵名单：任何通向对象元结构（构造器/原型链）的属性都视为逃逸企图。 */
const BLOCKED_MEMBER_NAMES: ReadonlySet<string> = new Set([
  'constructor',
  '__proto__',
  'prototype',
]);

/** acorn 解析所需的来源标记（仅用于错误信息，不参与求值）。 */
const SOURCE_ORIGIN = 'workflow-expression';

class SafeExpressionError extends Error {}

function evaluateNode(node: unknown, scope: ReadonlyMap<string, unknown>): unknown {
  if (!node || typeof node !== 'object') {
    throw new SafeExpressionError('invalid AST node');
  }
  const n = node as { type: string; [key: string]: unknown };

  switch (n.type) {
    case 'Literal':
      return n.value;

    case 'Identifier': {
      const name = n.name as string;
      if (scope.has(name)) return scope.get(name);
      if (ALLOWED_GLOBALS.has(name)) return ALLOWED_GLOBALS.get(name);
      // 未注入、非白名单全局的标识符一律不可解析——杜绝访问 process/require 等。
      throw new SafeExpressionError(`identifier not allowed: ${name}`);
    }

    case 'MemberExpression': {
      const property = n.computed
        ? evaluateNode(n.property, scope)
        : (n.property as { name?: string })?.name;
      if (typeof property === 'string' && BLOCKED_MEMBER_NAMES.has(property)) {
        throw new SafeExpressionError(`property access forbidden: ${property}`);
      }
      const object = evaluateNode(n.object, scope);
      return readMember(object, property);
    }

    case 'CallExpression': {
      const args = (n.arguments as unknown[]).map((arg) => evaluateNode(arg, scope));
      // 直接 callee：Math.max(...) / allowed(scope.fn)(...)
      const callee = evaluateNode(n.callee, scope);
      if (typeof callee !== 'function') {
        throw new SafeExpressionError('call target is not a function');
      }
      return callAllowed(callee, args);
    }

    case 'NewExpression': {
      const args = (n.arguments as unknown[]).map((arg) => evaluateNode(arg, scope));
      const callee = evaluateNode(n.callee, scope);
      if (typeof callee !== 'function') {
        throw new SafeExpressionError('new target is not a function');
      }
      return newAllowed(callee, args);
    }

    case 'UnaryExpression': {
      const value = evaluateNode(n.argument, scope);
      switch (n.operator) {
        case '!': return !value;
        case '-': return -(value as number);
        case '+': return +(value as number);
        case '~': return ~(value as number);
        case 'typeof': return typeof value;
        case 'void': return undefined;
        default: throw new SafeExpressionError(`unary operator not allowed: ${String(n.operator)}`);
      }
    }

    case 'BinaryExpression': {
      const left = evaluateNode(n.left, scope);
      const right = evaluateNode(n.right, scope);
      return applyBinary(String(n.operator), left, right);
    }

    case 'LogicalExpression': {
      const left = evaluateNode(n.left, scope);
      switch (n.operator) {
        case '&&': return left ? evaluateNode(n.right, scope) : left;
        case '||': return left ? left : evaluateNode(n.right, scope);
        case '??': return (left === null || left === undefined) ? evaluateNode(n.right, scope) : left;
        default: throw new SafeExpressionError(`logical operator not allowed: ${String(n.operator)}`);
      }
    }

    case 'ConditionalExpression': {
      const test = evaluateNode(n.test, scope);
      return test ? evaluateNode(n.consequent, scope) : evaluateNode(n.alternate, scope);
    }

    case 'ArrayExpression':
      return (n.elements as Array<unknown>).map((el) =>
        el === null ? undefined : evaluateNode(el, scope),
      );

    case 'ObjectExpression': {
      const obj: Record<string, unknown> = {};
      for (const prop of (n.properties as Array<Record<string, unknown>>)) {
        if (prop.type === 'SpreadElement') {
          throw new SafeExpressionError('spread in object literal not allowed');
        }
        const keyNode = prop.computed ? prop.key : (prop.key as { name?: string });
        const key = prop.computed
          ? String(evaluateNode(keyNode, scope))
          : (keyNode as { name?: string })?.name;
        if (typeof key !== 'string') {
          throw new SafeExpressionError('object literal key must be a name');
        }
        if (BLOCKED_MEMBER_NAMES.has(key)) {
          throw new SafeExpressionError(`object key forbidden: ${key}`);
        }
        obj[key] = evaluateNode(prop.value, scope);
      }
      return obj;
    }

    case 'SpreadElement':
      // 仅数组调用参数里的展开，在外层被 CallExpression 单独处理；落到这里是独立展开，不支持。
      throw new SafeExpressionError('standalone spread not allowed');

    case 'TemplateLiteral': {
      const parts: string[] = [];
      const quasis = (n.quasis as Array<{ value: { cooked: string } }>);
      const expressions = (n.expressions as unknown[]);
      for (let i = 0; i < quasis.length; i++) {
        parts.push(quasis[i].value.cooked);
        if (i < expressions.length) {
          parts.push(String(evaluateNode(expressions[i], scope)));
        }
      }
      return parts.join('');
    }

    case 'SequenceExpression': {
      const expressions = (n.expressions as unknown[]);
      let last: unknown;
      for (const expr of expressions) last = evaluateNode(expr, scope);
      return last;
    }

    case 'ChainExpression':
      // optional chaining：递归到内部表达式，忽略 optional 语义差异。
      return evaluateNode(n.expression, scope);

    default:
      throw new SafeExpressionError(`expression node not allowed: ${n.type}`);
  }
}

function readMember(object: unknown, property: unknown): unknown {
  if (object === null || object === undefined) {
    throw new SafeExpressionError(`cannot read property '${String(property)}' of ${String(object)}`);
  }
  // 允许在普通对象/数组/字符串/数字/布尔/白名单全局函数上读属性。
  // 函数（Math.max / JSON.parse / String.fromCharCode 等）也允许，但 constructor/
  // __proto__/prototype 已由 BLOCKED 命中封堵——通向 Function 构造器的逃逸链被断。
  const allowed =
    typeof object === 'object' ||
    typeof object === 'function' ||
    typeof object === 'string' ||
    typeof object === 'number' ||
    typeof object === 'boolean';
  if (!allowed) {
    throw new SafeExpressionError(`member access not allowed on ${typeof object}`);
  }
  if (typeof property === 'string' && BLOCKED_MEMBER_NAMES.has(property)) {
    throw new SafeExpressionError(`property access forbidden: ${property}`);
  }
  if (Array.isArray(object)) {
    if (typeof property === 'number' || (typeof property === 'string' && /^\d+$/.test(property))) {
      return object[Number(property)];
    }
    // 数组方法：length / includes / indexOf / join / slice / map 等——白名单收窄。
    if (property === 'length') return object.length;
    return readArrayMethod(object, property);
  }
  if (typeof object === 'string') {
    return readStringMember(object, property);
  }
  // 普通对象 / 白名单全局对象（Math/JSON/Date...）：按属性名直读，但封堵被 BLOCKED 命中。
  return (object as Record<string, unknown>)[property as string];
}

const ARRAY_METHODS: ReadonlySet<string> = new Set([
  'includes', 'indexOf', 'join', 'slice', 'concat', 'map', 'filter', 'find',
  'some', 'every', 'length',
]);

function readArrayMethod(array: unknown[], property: unknown): unknown {
  const name = property as string;
  if (typeof name !== 'string' || !ARRAY_METHODS.has(name)) {
    throw new SafeExpressionError(`array member not allowed: ${String(property)}`);
  }
  const fn = (array as unknown as Record<string, unknown>)[name];
  return typeof fn === 'function'
    ? (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(array, args)
    : fn;
}

const STRING_MEMBERS: ReadonlySet<string> = new Set([
  'length', 'toUpperCase', 'toLowerCase', 'trim', 'includes', 'startsWith',
  'endsWith', 'indexOf', 'slice', 'substring', 'split', 'charAt', 'charCodeAt',
]);

function readStringMember(str: string, property: unknown): unknown {
  const name = property as string;
  if (typeof name !== 'number' && (typeof name !== 'string' || !STRING_MEMBERS.has(name))) {
    throw new SafeExpressionError(`string member not allowed: ${String(property)}`);
  }
  const value = (str as unknown as Record<string, unknown>)[name as string];
  return typeof value === 'function'
    ? (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(str, args)
    : value;
}

function applyBinary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '==': return left == right; // eslint-disable-line eqeqeq
    case '!=': return left != right; // eslint-disable-line eqeqeq
    case '===': return left === right;
    case '!==': return left !== right;
    case '<': return (left as number) < (right as number);
    case '<=': return (left as number) <= (right as number);
    case '>': return (left as number) > (right as number);
    case '>=': return (left as number) >= (right as number);
    case '+': return (left as number) + (right as number);
    case '-': return (left as number) - (right as number);
    case '*': return (left as number) * (right as number);
    case '/': return (left as number) / (right as number);
    case '%': return (left as number) % (right as number);
    case '**': return (left as number) ** (right as number);
    case '&': return (left as number) & (right as number);
    case '|': return (left as number) | (right as number);
    case '^': return (left as number) ^ (right as number);
    case '<<': return (left as number) << (right as number);
    case '>>': return (left as number) >> (right as number);
    case '>>>': return (left as number) >>> (right as number);
    case 'in': return String(left) in (right as object);
    case 'instanceof': return (left as object) instanceof (right as Function);
    default: throw new SafeExpressionError(`binary operator not allowed: ${operator}`);
  }
}

/**
 * 调用从 scope/全局拿到的函数。仅允许普通函数与绑定函数，封堵 Function 构造器相关。
 * （ALLOWED_GLOBALS 里本就没有 Function，这里只是多一道断言。）
 */
function callAllowed(callee: unknown, args: unknown[]): unknown {
  if (typeof callee !== 'function') {
    throw new SafeExpressionError('call target is not a function');
  }
  return (callee as (...a: unknown[]) => unknown)(...args);
}

function newAllowed(callee: unknown, args: unknown[]): unknown {
  if (typeof callee !== 'function') {
    throw new SafeExpressionError('new target is not a function');
  }
  return new (callee as new (...a: unknown[]) => unknown)(...args);
}

/**
 * 在封闭的 AST 白名单内求值表达式，返回 Boolean 化结果。
 *
 * @param expression 待求值的 JS 表达式字符串（不可含语句）。
 * @param scope 注入的变量作用域：key → 值。仅这些名字可被标识符访问，外加白名单全局。
 * @returns 表达式求值结果的 Boolean 化。
 * @throws 任何不被允许的节点/属性/逃逸企图都会抛 SafeExpressionError（message 可读）。
 */
export function evaluateSafeExpression(expression: string, scope: Record<string, unknown>): boolean {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new SafeExpressionError('expression must be a non-empty string');
  }
  let ast: unknown;
  try {
    ast = parseExpressionAt(expression, 0, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      sourceFile: SOURCE_ORIGIN,
    });
  } catch (error) {
    throw new SafeExpressionError(
      `expression parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const scopeMap = new Map<string, unknown>(Object.entries(scope ?? {}));
  const result = evaluateNode(ast, scopeMap);
  return Boolean(result);
}
