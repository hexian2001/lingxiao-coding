/**
 * ChangeImpactResolver — 确定性变更影响范围解析器
 *
 * 给定一组修改文件 → 输出：
 * 1. 传递性影响范围（谁 import 了这些文件、递归）
 * 2. 需要运行的精确测试文件集
 * 3. 结构化 build 诊断（修改后是否引入编译错误）
 *
 * 全部基于确定性图计算 + 真实 build 工具输出，零启发式。
 *
 * 集成方式：
 * - Worker 完成代码变更后：resolve(changedFiles) → 得到 impact + tests + diagnostics
 * - Leader 据此决定：是否通过、需要修复什么、重试范围多大
 * - 本模块是 self-verification 的基础设施，取代之前基于文件名猜测的方案
 */

import { ImportGraphEngine, type ImportGraph } from './ImportGraphEngine.js';
import { BuildDiagnosticsCollector, type BuildResult, type Diagnostic } from './BuildDiagnosticsCollector.js';
import { AstStructuralEngine, type AstCallGraphEdge, type AstSymbolSummary } from './AstStructuralEngine.js';

/** 变更影响分析结果 */
export interface ChangeImpact {
  /** 直接修改的文件 */
  changedFiles: string[];
  /** 传递性影响范围 (包含 changedFiles 自身) */
  impactSet: string[];
  /** 影响范围中的测试文件 */
  affectedTests: string[];
  /** 构建诊断 (空 = 构建通过) */
  diagnostics: Diagnostic[];
  /** 构建是否通过 */
  buildPassed: boolean;
  /** 构建结果详情 */
  buildResults: BuildResult[];
  /** 影响范围大小 vs 项目总文件数 (便于 Leader 评估任务拆分) */
  impactRatio: number;
  /** AST-backed structural facts for changed and impacted code. */
  structuralImpact: {
    changedDefinitions: AstSymbolSummary[];
    impactedPublicApis: AstSymbolSummary[];
    callGraphEdges: AstCallGraphEdge[];
    diagnostics: string[];
  };
}

export interface ChangeImpactResolverOptions {
  projectRoot: string;
  sourceDirs?: string[];
  tsconfigPath?: string;
  /** 是否跑 build 诊断 (false 则只计算影响图) */
  runBuildCheck?: boolean;
  /** build 超时 ms */
  buildTimeoutMs?: number;
}

export class ChangeImpactResolver {
  private readonly graphEngine: ImportGraphEngine;
  private readonly buildCollector: BuildDiagnosticsCollector;
  private readonly opts: ChangeImpactResolverOptions;
  private cachedGraph: ImportGraph | null = null;

  constructor(options: ChangeImpactResolverOptions) {
    this.opts = options;
    this.graphEngine = new ImportGraphEngine({
      rootDir: options.projectRoot,
      sourceDirs: options.sourceDirs,
      tsconfigPath: options.tsconfigPath,
    });
    this.buildCollector = new BuildDiagnosticsCollector();
  }

  /**
   * 解析变更影响范围。
   * @param changedFiles 相对项目根的修改文件路径列表
   */
  async resolve(changedFiles: string[]): Promise<ChangeImpact> {
    // 1. 构建/更新导入图 (增量)
    const graph = this.graphEngine.build();
    this.cachedGraph = graph;

    // 2. 计算传递性影响范围
    const impactSet = this.graphEngine.computeImpactSet(graph, changedFiles);

    // 3. 从影响范围中过滤测试文件
    const affectedTests = this.graphEngine.filterTestFiles(impactSet);

    // 4. AST-backed structural impact facts for worker navigation and verification.
    const structuralImpact = this.resolveStructuralImpact(changedFiles, impactSet);

    // 5. 可选: 运行 build 诊断
    let diagnostics: Diagnostic[] = [];
    let buildPassed = true;
    let buildResults: BuildResult[] = [];

    if (this.opts.runBuildCheck !== false) {
      buildResults = await this.buildCollector.collectAll(
        this.opts.projectRoot,
        this.opts.buildTimeoutMs,
      );
      diagnostics = buildResults.flatMap(r => r.diagnostics);
      buildPassed = diagnostics.filter(d => d.severity === 'error').length === 0;
    }

    // 6. 计算影响比例
    const impactRatio = graph.files.length > 0
      ? impactSet.size / graph.files.length
      : 0;

    return {
      changedFiles,
      impactSet: [...impactSet],
      affectedTests,
      diagnostics,
      buildPassed,
      buildResults,
      impactRatio,
      structuralImpact,
    };
  }

  private resolveStructuralImpact(changedFiles: string[], impactSet: Set<string>): ChangeImpact['structuralImpact'] {
    const engine = new AstStructuralEngine({
      projectRoot: this.opts.projectRoot,
      sourceDirs: this.opts.sourceDirs,
    });
    const diagnostics: string[] = [];
    try {
      const changedDefinitions = this.uniqueSymbols(
        changedFiles.flatMap((file) => engine.findDefinitions(undefined, { file, limit: 200 })),
      );
      const impactedPublicApis = this.uniqueSymbols(
        [...impactSet].flatMap((file) => engine.getPublicApi({ file, limit: 200 })),
      );
      const callGraphEdges = this.uniqueEdges(
        changedDefinitions
          .filter((definition) => ['function', 'method', 'variable'].includes(definition.kind))
          .flatMap((definition) => engine.getCallGraph({ symbolName: definition.name, maxDepth: 2, limit: 200 })),
      );
      return { changedDefinitions, impactedPublicApis, callGraphEdges, diagnostics };
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      return { changedDefinitions: [], impactedPublicApis: [], callGraphEdges: [], diagnostics };
    }
  }

  private uniqueSymbols(symbols: AstSymbolSummary[]): AstSymbolSummary[] {
    const seen = new Set<string>();
    const out: AstSymbolSummary[] = [];
    for (const symbol of symbols) {
      const key = `${symbol.location.file}:${symbol.location.start}:${symbol.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(symbol);
    }
    return out;
  }

  private uniqueEdges(edges: AstCallGraphEdge[]): AstCallGraphEdge[] {
    const seen = new Set<string>();
    const out: AstCallGraphEdge[] = [];
    for (const edge of edges) {
      const key = [
        edge.caller.location.file,
        edge.caller.location.start,
        edge.callee.location.file,
        edge.callee.location.start,
        edge.location.start,
      ].join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(edge);
    }
    return out;
  }

  /** 获取缓存的导入图 (用于 Leader 任务分解时查看模块边界) */
  getGraph(): ImportGraph | null {
    return this.cachedGraph;
  }

  /** 强制重建图 (文件系统大变动后) */
  invalidateCache(): void {
    this.graphEngine.clearCache();
    this.cachedGraph = null;
  }
}
