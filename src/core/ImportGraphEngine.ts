/**
 * ImportGraphEngine — 确定性的 TypeScript/ESM 导入图构建器
 *
 * 面向巨型项目 (400K+ LOC) 设计：
 * - 从 tsconfig.json / package.json 读取真实编译选项和路径别名
 * - 增量构建：只重新解析变更文件 (基于 mtime/hash)
 * - 生成确定性的有向依赖图：A imports B → edge A→B
 *
 * 用途：
 * - 变更影响范围计算：修改了 X → 谁 import 了 X → 影响范围
 * - 精确测试范围：影响范围 ∩ test 文件 = 需要跑的测试
 * - Leader 任务分解：按模块图边界拆分子任务
 *
 * 不使用启发式。依赖解析完全基于 TS 编译器 API 或正则匹配 import/require 语句
 * (正则此处是语法解析，不是语义猜测)。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative, extname, dirname } from 'node:path';

/** 一条导入边 */
export interface ImportEdge {
  /** 导入方 (相对路径) */
  from: string;
  /** 被导入方 (相对路径, 解析后) */
  to: string;
  /** 原始 import specifier */
  specifier: string;
}

/** 导入图快照 */
export interface ImportGraph {
  /** 所有已解析的源文件 (相对路径) */
  files: string[];
  /** 所有导入边 */
  edges: ImportEdge[];
  /** 每个文件的直接依赖 */
  dependencies: Map<string, Set<string>>;
  /** 每个文件的反向依赖 (谁 import 了我) */
  dependents: Map<string, Set<string>>;
}

export interface ImportGraphOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 源码目录 (相对 rootDir), 默认 ['src'] */
  sourceDirs?: string[];
  /** 要扫描的文件扩展名 */
  extensions?: string[];
  /** tsconfig.json 路径 (用于解析 paths 别名), 可选 */
  tsconfigPath?: string;
  /** 排除的目录名 */
  excludeDirs?: string[];
}

/** 从 import/export 语句提取 specifier 的正则 (语法层面，非启发式) */
const IMPORT_RE = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
const DEFAULT_EXCLUDE = ['node_modules', 'dist', '.git', 'coverage', '__pycache__'];

// PLACEHOLDER_CLASS

export class ImportGraphEngine {
  private readonly rootDir: string;
  private readonly sourceDirs: string[];
  private readonly extensions: Set<string>;
  private readonly excludeDirs: Set<string>;
  private readonly pathAliases: Map<string, string>;

  /** 增量缓存: 文件 → mtime → 解析结果 */
  private cache = new Map<string, { mtime: number; imports: string[] }>();

  constructor(options: ImportGraphOptions) {
    this.rootDir = resolve(options.rootDir);
    this.sourceDirs = options.sourceDirs ?? ['src'];
    this.extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
    this.excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDE);
    this.pathAliases = this.loadPathAliases(options.tsconfigPath);
  }

  /** 构建完整导入图（增量: 只重新解析 mtime 变了的文件） */
  build(): ImportGraph {
    const files = this.collectSourceFiles();
    const edges: ImportEdge[] = [];
    const dependencies = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();

    for (const file of files) {
      dependencies.set(file, new Set());
      if (!dependents.has(file)) dependents.set(file, new Set());
    }

    const fileSet = new Set(files);

    for (const file of files) {
      const imports = this.parseImports(file);
      const deps = dependencies.get(file)!;

      for (const specifier of imports) {
        const resolved = this.resolveSpecifier(specifier, file);
        if (!resolved || !fileSet.has(resolved)) continue;

        deps.add(resolved);
        edges.push({ from: file, to: resolved, specifier });

        if (!dependents.has(resolved)) dependents.set(resolved, new Set());
        dependents.get(resolved)!.add(file);
      }
    }

    return { files, edges, dependencies, dependents };
  }

  /**
   * 计算变更影响范围：给定修改的文件列表，返回所有传递性依赖方。
   * 这是精确计算，不是启发式——沿 dependents 图 BFS 到达的所有节点。
   */
  computeImpactSet(graph: ImportGraph, changedFiles: string[]): Set<string> {
    const impact = new Set<string>();
    const queue = [...changedFiles];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (impact.has(file)) continue;
      impact.add(file);

      const deps = graph.dependents.get(file);
      if (deps) {
        for (const dep of deps) {
          if (!impact.has(dep)) queue.push(dep);
        }
      }
    }

    return impact;
  }

  /**
   * 从影响集中过滤出测试文件。
   * 判定规则是确定性的：文件路径包含 .test. 或 .spec. 或在 test/ / __tests__ 目录下。
   */
  filterTestFiles(impactSet: Set<string>): string[] {
    return [...impactSet].filter(f =>
      f.includes('.test.') || f.includes('.spec.') ||
      f.includes('/test/') || f.includes('/__tests__/')
    );
  }

  // ─── 内部方法 ───

  private collectSourceFiles(): string[] {
    const files: string[] = [];
    for (const dir of this.sourceDirs) {
      const absDir = join(this.rootDir, dir);
      if (!existsSync(absDir)) continue;
      this.walkDir(absDir, files);
    }
    return files.map(f => relative(this.rootDir, f));
  }

  private walkDir(dir: string, result: string[]): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch {/* expected: non-critical failure */ return; }

    for (const entry of entries) {
      if (this.excludeDirs.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch {/* expected: non-critical failure */ continue; }

      if (stat.isDirectory()) {
        this.walkDir(full, result);
      } else if (this.extensions.has(extname(entry))) {
        result.push(full);
      }
    }
  }

  /** 解析文件中的 import/require specifiers (增量缓存) */
  private parseImports(relPath: string): string[] {
    const absPath = join(this.rootDir, relPath);
    let mtime: number;
    try { mtime = statSync(absPath).mtimeMs; } catch {/* expected: non-critical failure */ return []; }

    const cached = this.cache.get(relPath);
    if (cached && cached.mtime === mtime) return cached.imports;

    let content: string;
    try { content = readFileSync(absPath, 'utf8'); } catch {/* expected: non-critical failure */ return []; }

    const imports: string[] = [];

    // 提取 import/export ... from '...' 和 require('...')
    for (const re of [IMPORT_RE, REQUIRE_RE]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const spec = match[1];
        // 只关注相对路径和别名, 跳过 node_modules 包
        if (spec.startsWith('.') || this.pathAliases.has(spec.split('/')[0])) {
          imports.push(spec);
        }
      }
    }

    this.cache.set(relPath, { mtime, imports });
    return imports;
  }

  /** 将 import specifier 解析为相对项目根的实际文件路径 */
  private resolveSpecifier(specifier: string, fromFile: string): string | null {
    let resolved: string;

    // 处理 path alias
    const firstSegment = specifier.split('/')[0];
    if (this.pathAliases.has(firstSegment)) {
      const aliasTarget = this.pathAliases.get(firstSegment)!;
      resolved = specifier.replace(firstSegment, aliasTarget);
    } else {
      // 相对路径解析
      const fromDir = dirname(join(this.rootDir, fromFile));
      resolved = relative(this.rootDir, resolve(fromDir, specifier));
    }

    // 尝试补全扩展名
    return this.resolveWithExtensions(resolved);
  }

  private resolveWithExtensions(basePath: string): string | null {
    // 已有扩展名且文件直接存在 → 用它
    const ext = extname(basePath);
    if (ext && existsSync(join(this.rootDir, basePath))) {
      return basePath;
    }
    // ESM 约定: import 写 .js 但实际文件可能是 .ts/.tsx
    // 去掉 .js/.mjs 后缀尝试所有已知扩展名
    const withoutJsExt = basePath.replace(/\.(js|mjs|jsx)$/, '');
    for (const tryExt of this.extensions) {
      const candidate = withoutJsExt + tryExt;
      if (existsSync(join(this.rootDir, candidate))) return candidate;
    }
    // 无扩展名的 specifier: 直接尝试所有扩展名
    if (!ext) {
      for (const tryExt of this.extensions) {
        const candidate = basePath + tryExt;
        if (existsSync(join(this.rootDir, candidate))) return candidate;
      }
    }
    // index 文件
    for (const tryExt of this.extensions) {
      const candidate = join(basePath, `index${tryExt}`);
      if (existsSync(join(this.rootDir, candidate))) return candidate;
    }
    return null;
  }

  /** 从 tsconfig.json 加载 paths 别名 */
  private loadPathAliases(tsconfigPath?: string): Map<string, string> {
    const aliases = new Map<string, string>();
    const configPath = tsconfigPath ?? join(this.rootDir, 'tsconfig.json');
    if (!existsSync(configPath)) return aliases;

    try {
      const raw = readFileSync(configPath, 'utf8');
      // 去除注释后解析 (tsconfig 允许注释)
      const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(cleaned) as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
      const baseUrl = config.compilerOptions?.baseUrl ?? '.';
      const paths = config.compilerOptions?.paths ?? {};

      for (const [alias, targets] of Object.entries(paths)) {
        if (targets.length === 0) continue;
        // '@/*' → 'src/*' 格式
        const cleanAlias = alias.replace(/\/\*$/, '');
        const cleanTarget = targets[0].replace(/\/\*$/, '');
        aliases.set(cleanAlias, join(baseUrl, cleanTarget));
      }
    } catch { /* 解析失败不阻塞 */ }

    return aliases;
  }

  /** 当前缓存文件数 */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 清空增量缓存（测试/完整重建时用） */
  clearCache(): void {
    this.cache.clear();
  }
}

