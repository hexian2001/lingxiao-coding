import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
// 懒加载 typescript：顶层静态 import 会把整个 TS 编译器 (+70MB/~360ms) 拉进每一次
// CLI 启动图（含仅打印 --version 的路径）。类型仍走 `import type`（编译期擦除，零运行时成本）；
// 运行时值经 TS() 首次访问时同步 require —— 仅当真正执行 AST 分析（ast_query 等）时才加载。
// 用 createRequire 而非 await import，保持所有引擎方法同步，避免向 ChangeImpactResolver /
// AssumptionTracker / AstQueryTool 等同步调用点扩散 async 改动。
import type * as ts from 'typescript';

const _require = createRequire(import.meta.url);
let _ts: typeof ts | null = null;
function TS(): typeof ts {
  return (_ts ??= _require('typescript') as typeof ts);
}

export type AstDefinitionKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'property'
  | 'constructor'
  | 'parameter'
  | 'unknown';

export interface AstLocation {
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

export interface AstSymbolSummary {
  name: string;
  kind: AstDefinitionKind;
  exported: boolean;
  location: AstLocation;
  container?: string;
}

export interface AstReference {
  name: string;
  kind: AstDefinitionKind;
  location: AstLocation;
  isDefinition: boolean;
  container?: string;
}

export interface AstCallGraphEdge {
  caller: AstSymbolSummary;
  callee: AstSymbolSummary;
  depth: number;
  location: AstLocation;
}

export interface AstStructuralEngineOptions {
  projectRoot: string;
  sourceDirs?: string[];
  extensions?: string[];
  excludeDirs?: string[];
}

export interface AstPatternQuery {
  namePattern?: string;
  kinds?: AstDefinitionKind[];
  file?: string;
  limit?: number;
}

interface ProjectAst {
  program: ts.Program;
  checker: ts.TypeChecker;
  files: string[];
}

interface DefinitionRecord {
  node: ts.Node;
  nameNode: ts.Identifier;
  summary: AstSymbolSummary;
  symbolKey?: string;
}

const DEFAULT_SOURCE_DIRS = ['src'];
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', '.git', 'coverage', '__pycache__'];

function unixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function uniqueByLocation<T extends { location: AstLocation }>(values: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = `${value.location.file}:${value.location.start}:${value.location.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const t = TS();
  return Boolean(t.canHaveModifiers(node) && t.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function declarationKind(node: ts.Node): AstDefinitionKind | null {
  const t = TS();
  if (t.isFunctionDeclaration(node)) return 'function';
  if (t.isClassDeclaration(node)) return 'class';
  if (t.isInterfaceDeclaration(node)) return 'interface';
  if (t.isTypeAliasDeclaration(node)) return 'type';
  if (t.isEnumDeclaration(node)) return 'enum';
  if (t.isVariableDeclaration(node)) return 'variable';
  if (t.isMethodDeclaration(node) || t.isMethodSignature(node)) return 'method';
  if (t.isPropertyDeclaration(node) || t.isPropertySignature(node)) return 'property';
  if (t.isConstructorDeclaration(node)) return 'constructor';
  if (t.isParameter(node)) return 'parameter';
  return null;
}

function getDeclarationNameNode(node: ts.Node): ts.Identifier | null {
  const t = TS();
  if (t.isConstructorDeclaration(node)) {
    const parent = node.parent;
    return t.isClassDeclaration(parent) && parent.name ? parent.name : null;
  }
  if (!('name' in node)) return null;
  const name = (node as { name?: ts.Node }).name;
  return name && t.isIdentifier(name) ? name : null;
}

function getContainerName(node: ts.Node): string | undefined {
  let current = node.parent;
  while (current) {
    const name = getDeclarationNameNode(current);
    const kind = declarationKind(current);
    if (name && kind && kind !== 'parameter') return name.text;
    current = current.parent;
  }
  return undefined;
}

function isDefinitionIdentifier(node: ts.Identifier): boolean {
  return getDeclarationNameNode(node.parent) === node;
}

function compilerOptions(): ts.CompilerOptions {
  const t = TS();
  return {
    allowJs: true,
    checkJs: false,
    jsx: t.JsxEmit.ReactJSX,
    target: t.ScriptTarget.ES2022,
    module: t.ModuleKind.ESNext,
    moduleResolution: t.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
  };
}

export class AstStructuralEngine {
  private readonly projectRoot: string;
  private readonly sourceDirs: string[];
  private readonly extensions: Set<string>;
  private readonly excludeDirs: Set<string>;
  private cachedProject: ProjectAst | null = null;
  private cachedDefinitions: DefinitionRecord[] | null = null;
  private cachedSourceFiles: string[] | null = null;

  constructor(options: AstStructuralEngineOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.sourceDirs = options.sourceDirs ?? DEFAULT_SOURCE_DIRS;
    this.extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
    this.excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
  }

  getSourceFiles(): string[] {
    return this.collectSourceFiles();
  }

  findDefinitions(symbolName?: string, options: { file?: string; exportedOnly?: boolean; limit?: number } = {}): AstSymbolSummary[] {
    const ast = this.buildProject();
    const definitions = this.collectDefinitions(ast);
    return definitions
      .map((definition) => definition.summary)
      .filter((definition) => !symbolName || definition.name === symbolName)
      .filter((definition) => !options.file || definition.location.file === this.normalizeInputFile(options.file))
      .filter((definition) => !options.exportedOnly || definition.exported)
      .slice(0, options.limit ?? 200);
  }

  findReferences(symbolName: string, options: { file?: string; limit?: number } = {}): AstReference[] {
    const ast = this.buildProject();
    const definitions = this.collectDefinitions(ast).filter((definition) => definition.summary.name === symbolName);
    const targetKeys = new Set(definitions.map((definition) => definition.symbolKey).filter((key): key is string => Boolean(key)));
    if (targetKeys.size === 0) return [];

    const t = TS();
    const references: AstReference[] = [];
    for (const sourceFile of this.projectSourceFiles(ast.program)) {
      if (options.file && this.relativeFile(sourceFile.fileName) !== this.normalizeInputFile(options.file)) continue;
      const visit = (node: ts.Node): void => {
        if (t.isIdentifier(node)) {
          const key = this.symbolKeyAt(ast.checker, node);
          if (key && targetKeys.has(key)) {
            references.push({
              name: node.text,
              kind: declarationKind(node.parent) ?? 'unknown',
              location: this.location(sourceFile, node),
              isDefinition: isDefinitionIdentifier(node),
              container: getContainerName(node),
            });
          }
        }
        t.forEachChild(node, visit);
      };
      t.forEachChild(sourceFile, visit);
    }

    return uniqueByLocation(references).slice(0, options.limit ?? 500);
  }

  getPublicApi(options: { file?: string; limit?: number } = {}): AstSymbolSummary[] {
    return this.findDefinitions(undefined, {
      file: options.file,
      exportedOnly: true,
      limit: options.limit ?? 300,
    });
  }

  searchPattern(query: AstPatternQuery): AstSymbolSummary[] {
    const pattern = query.namePattern ? new RegExp(query.namePattern) : null;
    const kindSet = query.kinds ? new Set(query.kinds) : null;
    return this.findDefinitions(undefined, { file: query.file, limit: Number.MAX_SAFE_INTEGER })
      .filter((definition) => !pattern || pattern.test(definition.name))
      .filter((definition) => !kindSet || kindSet.has(definition.kind))
      .slice(0, query.limit ?? 200);
  }

  findImplementors(symbolName: string, options: { limit?: number } = {}): AstSymbolSummary[] {
    const ast = this.buildProject();
    const definitions = this.collectDefinitions(ast);
    const targetKeys = new Set(
      definitions
        .filter((definition) => definition.summary.name === symbolName && ['class', 'interface'].includes(definition.summary.kind))
        .map((definition) => definition.symbolKey)
        .filter((key): key is string => Boolean(key)),
    );
    if (targetKeys.size === 0) return [];

    const t = TS();
    const implementors: AstSymbolSummary[] = [];
    for (const definition of definitions) {
      if (!t.isClassDeclaration(definition.node) && !t.isInterfaceDeclaration(definition.node)) continue;
      const clauses = definition.node.heritageClauses ?? [];
      for (const clause of clauses) {
        for (const typeNode of clause.types) {
          const key = this.symbolKeyAt(ast.checker, typeNode.expression);
          if (key && targetKeys.has(key)) {
            implementors.push(definition.summary);
          }
        }
      }
    }

    return uniqueByLocation(implementors).slice(0, options.limit ?? 100);
  }

  getCallGraph(options: { symbolName?: string; maxDepth?: number; limit?: number } = {}): AstCallGraphEdge[] {
    const ast = this.buildProject();
    const definitions = this.collectDefinitions(ast);
    const definitionsByKey = new Map<string, DefinitionRecord>();
    const keyBySummary = new Map<AstSymbolSummary, string>();
    for (const definition of definitions) {
      if (definition.symbolKey) {
        definitionsByKey.set(definition.symbolKey, definition);
        keyBySummary.set(definition.summary, definition.symbolKey);
      }
    }

    const directEdges = this.collectDirectCallEdges(ast, definitionsByKey);
    const limit = options.limit ?? 300;
    if (!options.symbolName) return directEdges.slice(0, limit);

    const startKeys = new Set(
      definitions
        .filter((definition) => definition.summary.name === options.symbolName)
        .map((definition) => definition.symbolKey)
        .filter((key): key is string => Boolean(key)),
    );
    if (startKeys.size === 0) return [];

    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 2, 8));
    const adjacency = new Map<string, Array<{ calleeKey: string; edge: AstCallGraphEdge }>>();
    for (const edge of directEdges) {
      const callerKey = keyBySummary.get(edge.caller);
      const calleeKey = keyBySummary.get(edge.callee);
      if (!callerKey || !calleeKey) continue;
      const list = adjacency.get(callerKey) ?? [];
      list.push({ calleeKey, edge });
      adjacency.set(callerKey, list);
    }

    const out: AstCallGraphEdge[] = [];
    const queue = [...startKeys].map((key) => ({ key, depth: 0 }));
    const visited = new Set<string>();
    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const next = adjacency.get(current.key) ?? [];
      for (const item of next) {
        const depth = current.depth + 1;
        const edgeKey = `${current.key}->${item.calleeKey}:${item.edge.location.start}`;
        if (visited.has(edgeKey)) continue;
        visited.add(edgeKey);
        out.push({ ...item.edge, depth });
        queue.push({ key: item.calleeKey, depth });
      }
    }
    return out;
  }

  private collectDirectCallEdges(ast: ProjectAst, definitionsByKey: Map<string, DefinitionRecord>): AstCallGraphEdge[] {
    const t = TS();
    const out: AstCallGraphEdge[] = [];
    for (const sourceFile of this.projectSourceFiles(ast.program)) {
      const visit = (node: ts.Node): void => {
        if (t.isCallExpression(node)) {
          const caller = this.enclosingCallableDefinition(ast.checker, node, definitionsByKey);
          const calleeKey = this.symbolKeyAt(ast.checker, node.expression);
          const callee = calleeKey ? definitionsByKey.get(calleeKey) : undefined;
          if (caller && callee) {
            out.push({
              caller: caller.summary,
              callee: callee.summary,
              depth: 1,
              location: this.location(sourceFile, node.expression),
            });
          }
        }
        t.forEachChild(node, visit);
      };
      t.forEachChild(sourceFile, visit);
    }
    return out;
  }

  private enclosingCallableDefinition(
    checker: ts.TypeChecker,
    node: ts.Node,
    definitionsByKey: Map<string, DefinitionRecord>,
  ): DefinitionRecord | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      const nameNode = getDeclarationNameNode(current);
      if (nameNode) {
        const kind = declarationKind(current);
        if (kind && ['function', 'method', 'constructor', 'variable'].includes(kind)) {
          const key = this.symbolKeyAt(checker, nameNode);
          if (key && definitionsByKey.has(key)) return definitionsByKey.get(key)!;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private collectDefinitions(ast: ProjectAst): DefinitionRecord[] {
    if (this.cachedDefinitions) return this.cachedDefinitions;
    const out: DefinitionRecord[] = [];
    const exportNamesByFile = new Map<string, Set<string>>();

    const t = TS();
    for (const sourceFile of this.projectSourceFiles(ast.program)) {
      exportNamesByFile.set(this.relativeFile(sourceFile.fileName), this.exportNames(ast.checker, sourceFile));
      const visit = (node: ts.Node): void => {
        const kind = declarationKind(node);
        const nameNode = kind ? getDeclarationNameNode(node) : null;
        if (kind && nameNode && this.shouldIncludeDefinition(node, kind)) {
          const summary = this.summaryForNode(ast.checker, sourceFile, node, nameNode, kind, exportNamesByFile.get(this.relativeFile(sourceFile.fileName)) ?? new Set());
          out.push({
            node,
            nameNode,
            summary,
            symbolKey: this.symbolKeyAt(ast.checker, nameNode),
          });
        }
        t.forEachChild(node, visit);
      };
      t.forEachChild(sourceFile, visit);
    }

    this.cachedDefinitions = out;
    return out;
  }

  private shouldIncludeDefinition(node: ts.Node, kind: AstDefinitionKind): boolean {
    const t = TS();
    if (kind === 'parameter') return false;
    if (kind === 'property' && t.isPropertySignature(node)) return true;
    if (kind === 'method' && t.isMethodSignature(node)) return true;
    if (t.isVariableDeclaration(node)) {
      return t.isIdentifier(node.name);
    }
    return true;
  }

  private summaryForNode(
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    nameNode: ts.Identifier,
    kind: AstDefinitionKind,
    exportNames: Set<string>,
  ): AstSymbolSummary {
    const symbolName = nameNode.text;
    return {
      name: kind === 'constructor' ? 'constructor' : symbolName,
      kind,
      exported: this.isExported(checker, node, nameNode, exportNames),
      location: this.location(sourceFile, nameNode),
      container: getContainerName(node),
    };
  }

  private isExported(checker: ts.TypeChecker, node: ts.Node, nameNode: ts.Identifier, exportNames: Set<string>): boolean {
    const t = TS();
    if (hasModifier(node, t.SyntaxKind.ExportKeyword)) return true;
    if (t.isVariableDeclaration(node) && t.isVariableDeclarationList(node.parent)) {
      const statement = node.parent.parent;
      if (statement && hasModifier(statement, t.SyntaxKind.ExportKeyword)) return true;
    }
    const symbol = checker.getSymbolAtLocation(nameNode);
    const rawName = symbol?.getName() ?? nameNode.text;
    return exportNames.has(rawName) || exportNames.has(nameNode.text);
  }

  private exportNames(checker: ts.TypeChecker, sourceFile: ts.SourceFile): Set<string> {
    const symbol = checker.getSymbolAtLocation(sourceFile);
    if (!symbol) return new Set();
    return new Set(checker.getExportsOfModule(symbol).map((item) => item.getName()));
  }

  private buildProject(): ProjectAst {
    if (this.cachedProject) return this.cachedProject;
    const files = this.collectSourceFiles();
    const program = TS().createProgram(files.map((file) => join(this.projectRoot, file)), compilerOptions());
    this.cachedProject = { program, checker: program.getTypeChecker(), files };
    return this.cachedProject;
  }

  private collectSourceFiles(): string[] {
    if (this.cachedSourceFiles) return this.cachedSourceFiles;
    const out: string[] = [];
    for (const dir of this.sourceDirs) {
      const abs = join(this.projectRoot, dir);
      if (existsSync(abs)) this.walk(abs, out);
    }
    this.cachedSourceFiles = out.map((file) => unixPath(relative(this.projectRoot, file))).sort();
    return this.cachedSourceFiles;
  }

  private walk(dir: string, out: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {/* expected: non-critical failure */
      return;
    }
    for (const entry of entries) {
      if (this.excludeDirs.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {/* expected: skip invalid entry */
        continue;
      }
      if (stat.isDirectory()) {
        this.walk(full, out);
      } else if (this.extensions.has(extname(entry))) {
        out.push(full);
      }
    }
  }

  private projectSourceFiles(program: ts.Program): ts.SourceFile[] {
    return program.getSourceFiles()
      .filter((file) => !file.isDeclarationFile)
      .filter((file) => this.isProjectFile(file.fileName));
  }

  private isProjectFile(file: string): boolean {
    const rel = unixPath(relative(this.projectRoot, file));
    return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
  }

  private normalizeInputFile(file: string): string {
    return unixPath(isAbsolute(file) ? relative(this.projectRoot, file) : file);
  }

  private relativeFile(file: string): string {
    return unixPath(relative(this.projectRoot, file));
  }

  private location(sourceFile: ts.SourceFile, node: ts.Node): AstLocation {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const pos = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      file: this.relativeFile(sourceFile.fileName),
      line: pos.line + 1,
      column: pos.character + 1,
      start,
      end,
    };
  }

  private symbolKeyAt(checker: ts.TypeChecker, node: ts.Node): string | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & TS().SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const declarations = symbol.getDeclarations() ?? [];
    const declaration = declarations.find((item) => this.isProjectFile(item.getSourceFile().fileName)) ?? declarations[0];
    if (!declaration) return `${checker.getFullyQualifiedName(symbol)}:${symbol.getName()}`;
    const sourceFile = declaration.getSourceFile();
    return `${this.relativeFile(sourceFile.fileName)}:${declaration.getStart(sourceFile)}:${symbol.getName()}`;
  }
}

export function readAstSourcePreview(projectRoot: string, location: AstLocation, maxChars = 240): string {
  const file = join(projectRoot, location.file);
  try {
    const content = readFileSync(file, 'utf8');
    return content.slice(location.start, Math.min(location.end, location.start + maxChars));
  } catch {/* expected: fallback to default */
    return '';
  }
}
