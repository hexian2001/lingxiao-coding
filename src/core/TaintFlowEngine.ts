/**
 * TaintFlowEngine — JS/TS 过程内污点传播引擎（确定性，无启发式）。
 *
 * 用 TypeScript Compiler API 做真正的过程内 value-flow backward analysis：
 * 从 sink 调用实参出发，沿局部 def-use（变量声明/赋值）、表达式子节点、
 * 已知透传函数反向追踪，命中声明的 source（如 req.body）即报告，经声明的
 * sanitizer 截断。自动产出 taint_path（路径节点摘要），灌进 BughuntFinding.taint_path
 * （此前 taint_path 全靠 LLM 手填）。
 *
 * 设计原则（对齐项目）：
 *   - 确定性：source/sink/sanitizer/propagator 全部显式声明（来自规则 + taintFacts），
 *     无关键词猜测、无 confidence 分数、无阈值。
 *   - 过程内：分析范围限定在单个函数体；跨过程（call graph 传播）作为后续增强。
 *   - 无外部依赖：只用已装的 typescript 编译器 API（与 AstStructuralEngine 一致），
 *     跨平台零二进制。
 */
import ts from 'typescript';
import type { Severity } from '../tools/implementations/rules/schema.js';
import { SEED_TAINT_FACTS } from '../tools/implementations/rules/taintFacts.js';

export interface TaintFinding {
  rule: string;
  cwe?: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  /** 命中的 source（如 req.query） */
  source: string;
  /** 命中的 sink（函数名，如 exec） */
  sink: string;
  /** 数据流路径节点摘要：sink → ... → source */
  taint_path: string[];
  language: string;
}

export interface TaintAnalysisOptions {
  /** 声明的污点源（如 req.body / req.query）。 */
  sources: string[];
  /** 声明的汇聚点函数名（如 exec / eval）。 */
  sinks: string[];
  /** 净化器函数名（命中即截断该路径）。缺省用 taintFacts 默认表。 */
  sanitizers?: string[];
  /** 透传函数名（输入污点 → 输出污点）。缺省用 taintFacts 默认表。 */
  propagators?: string[];
  ruleId: string;
  cwe?: string;
  severity: Severity;
  language: string;
  maxPathDepth?: number;
}

const DEFAULT_MAX_PATH_DEPTH = 60;

/**
 * 分析单个 JS/TS 源文件的过程内污点。
 * @returns TaintFinding[]（每个 sink↔source 可达路径一条；确定性）。
 */
export function analyzeTaintInSource(fileName: string, sourceText: string, options: TaintAnalysisOptions): TaintFinding[] {
  if (!isJsTs(options.language)) return [];
  const sourceFile = ts.createSourceFile(
    fileName, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind(fileName),
  );
  const sanitizers = options.sanitizers ?? [...SEED_TAINT_FACTS.sanitizers];
  const propagators = options.propagators ?? [...SEED_TAINT_FACTS.propagators];
  const sinkSet = new Set(options.sinks);
  const findings: TaintFinding[] = [];

  visitFunctions(sourceFile, (fn) => {
    for (const call of collectSinkCalls(fn, sinkSet)) {
      const sinkName = calleeName(call);
      for (const arg of call.arguments) {
        const result = backwardReach(arg, fn, options.sources, sanitizers, propagators, options.maxPathDepth ?? DEFAULT_MAX_PATH_DEPTH);
        if (result) {
          findings.push({
            rule: options.ruleId,
            cwe: options.cwe,
            severity: options.severity,
            file: fileName,
            line: lineOf(sourceFile, call),
            column: columnOf(sourceFile, call),
            source: result.source,
            sink: sinkName,
            taint_path: [summarize(call), ...result.path],
            language: options.language,
          });
        }
      }
    }
  });

  return findings;
}

function isJsTs(lang: string): boolean {
  return lang === 'javascript' || lang === 'typescript';
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function visitFunctions(node: ts.Node, cb: (fn: ts.Node) => void): void {
  if (isFunctionLike(node)) cb(node);
  ts.forEachChild(node, (child) => visitFunctions(child, cb));
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** 收集函数体内所有 callee 名在 sinkSet 中的调用。 */
function collectSinkCalls(fn: ts.Node, sinkSet: Set<string>): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && sinkSet.has(calleeName(n))) calls.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return calls;
}

function calleeName(call: ts.CallExpression): string {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return expr.getText();
}

interface ReachResult {
  source: string;
  /** 从起始节点（不含）到命中 source 节点（含）的路径摘要。 */
  path: string[];
}

/**
 * 过程内反向 reachability：从 start 节点出发，沿 def-use / 表达式子节点 / 透传函数
 * 反向追，命中 source 返回路径；sanitizer 截断；visited 防环。
 */
function backwardReach(
  start: ts.Node,
  scope: ts.Node,
  sources: string[],
  sanitizers: string[],
  propagators: string[],
  maxDepth: number,
): ReachResult | null {
  interface Item {
    node: ts.Node;
    path: string[];
  }
  const worklist: Item[] = [{ node: start, path: [] }];
  const visited = new Set<ts.Node>();
  const sanitizerSet = new Set(sanitizers);
  const propagatorSet = new Set(propagators);

  while (worklist.length > 0) {
    const { node, path } = worklist.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (path.length > maxDepth) continue;

    // sanitizer 截断：node 是净化器调用 → 该路径终止（不追其内部）
    if (ts.isCallExpression(node) && sanitizerSet.has(calleeName(node))) continue;

    // source 命中：节点文本匹配某声明的 source（精确或成员链前缀）
    const matched = matchSource(node, sources);
    if (matched) {
      return { source: matched, path: [...path, summarize(node)] };
    }

    const newPath = [...path, summarize(node)];

    if (ts.isIdentifier(node)) {
      // 反向追局部定义：name 的初始化 / 赋值 RHS
      for (const defValue of findDefinitions(node.text, scope)) {
        worklist.push({ node: defValue, path: newPath });
      }
      continue;
    }

    if (ts.isBinaryExpression(node)) {
      // a + b → 两边都可能带污点
      worklist.push({ node: node.left, path: newPath });
      worklist.push({ node: node.right, path: newPath });
      continue;
    }

    if (ts.isTemplateExpression(node)) {
      // `${a}${b}` → 追各插值表达式（head 是字面量，跳过）
      for (const span of node.templateSpans) {
        worklist.push({ node: span.expression, path: newPath });
      }
      continue;
    }

    if (ts.isCallExpression(node)) {
      // 透传函数：结果污点 ← 实参污点
      if (propagatorSet.has(calleeName(node))) {
        for (const arg of node.arguments) worklist.push({ node: arg, path: newPath });
      }
      // 非 propagator 的调用结果：过程内不知返回值来源 → 保守不追
      continue;
    }

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      worklist.push({ node: node.expression, path: newPath });
      continue;
    }
    // 其他节点（字面量、属性访问等）：属性访问已在 matchSource 判过；字面量不追
  }
  return null;
}

function matchSource(node: ts.Node, sources: string[]): string | null {
  const text = node.getText();
  for (const src of sources) {
    // 精确匹配，或成员链前缀（req.query.rev 匹配 req.query；obj[key] 匹配 obj）
    if (text === src || text.startsWith(src + '.') || text.startsWith(src + '[')) {
      return src;
    }
  }
  return null;
}

/** 在 scope（函数体）内找 name 的所有定义的值（变量初始化 / 赋值 RHS）。 */
function findDefinitions(name: string, scope: ts.Node): ts.Node[] {
  const defs: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      defs.push(n.initializer);
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      defs.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  return defs;
}

function summarize(node: ts.Node): string {
  return node.getText().replace(/\s+/g, ' ').slice(0, 80);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function columnOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).character + 1;
}
