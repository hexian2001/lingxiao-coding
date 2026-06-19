import { z } from 'zod';
import { AstStructuralEngine, type AstDefinitionKind } from '../../core/AstStructuralEngine.js';
import { Tool, createToolError, type ToolContext, type ToolResult } from '../Tool.js';
import { getPromptCatalog } from '../../agents/prompts/i18n/catalog.js';

const DefinitionKindSchema = z.enum([
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'variable',
  'method',
  'property',
  'constructor',
  'parameter',
  'unknown',
]);

function astQueryText() {
  return getPromptCatalog().tools.astQuery;
}

function buildAstQuerySchema() {
  const text = astQueryText();
  return z.object({
    action: z.enum(['definitions', 'references', 'public_api', 'pattern', 'call_graph', 'implementors'])
      .describe(text.actionDescription),
    symbol: z.string().min(1).optional().describe(text.symbolDescription),
    file: z.string().min(1).optional().describe(text.fileDescription),
    path: z.string().min(1).optional().describe('目标文件路径（同 file 参数）'),
    name_pattern: z.string().min(1).optional().describe(text.namePatternDescription),
    kinds: z.array(DefinitionKindSchema).optional().describe(text.kindsDescription),
    max_depth: z.number().int().min(1).max(8).optional().describe(text.maxDepthDescription),
    limit: z.number().int().min(1).max(500).optional().describe(text.limitDescription),
  });
}

const AstQuerySchema = buildAstQuerySchema();

type AstQueryParams = z.infer<typeof AstQuerySchema>;

function requireSymbol(params: AstQueryParams): string | null {
  return typeof params.symbol === 'string' && params.symbol.trim() ? params.symbol.trim() : null;
}

export class AstQueryTool extends Tool {
  readonly name = 'ast_query';
  readonly description = '用 TypeScript AST 查询代码结构：definitions、references、public_api、pattern、call_graph、implementors。用于证明代码关系，不用自然语言猜测。';
  readonly parameters = AstQuerySchema;

  override getSchema(): Record<string, unknown> {
    return this.schemaFromParameters(buildAstQuerySchema());
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as AstQueryParams;
    const targetFile = params.path || params.file;
    const workspace = context?.taskWorkingDirectory || context?.workspace || process.cwd();
    const engine = new AstStructuralEngine({ projectRoot: workspace });
    const sourceFiles = engine.getSourceFiles();
    if (sourceFiles.length === 0) {
      return { success: false, data: null, error: 'ERROR: 未找到任何源文件。项目目录可能不可读或不包含 TypeScript/JavaScript 文件。' };
    }
    const limit = params.limit ?? 200;

    switch (params.action) {
      case 'definitions': {
        return {
          success: true,
          data: {
            action: params.action,
            results: engine.findDefinitions(params.symbol, { file: targetFile, limit }),
          },
        };
      }
      case 'references': {
        const symbol = requireSymbol(params);
        if (!symbol) return this.missingSymbol(params.action);
        return {
          success: true,
          data: {
            action: params.action,
            symbol,
            results: engine.findReferences(symbol, { file: targetFile, limit }),
          },
        };
      }
      case 'public_api': {
        return {
          success: true,
          data: {
            action: params.action,
            results: engine.getPublicApi({ file: targetFile, limit }),
          },
        };
      }
      case 'pattern': {
        return {
          success: true,
          data: {
            action: params.action,
            results: engine.searchPattern({
              namePattern: params.name_pattern,
              kinds: params.kinds as AstDefinitionKind[] | undefined,
              file: targetFile,
              limit,
            }),
          },
        };
      }
      case 'call_graph': {
        return {
          success: true,
          data: {
            action: params.action,
            symbol: params.symbol,
            results: engine.getCallGraph({
              symbolName: params.symbol,
              maxDepth: params.max_depth,
              limit,
            }),
          },
        };
      }
      case 'implementors': {
        const symbol = requireSymbol(params);
        if (!symbol) return this.missingSymbol(params.action);
        return {
          success: true,
          data: {
            action: params.action,
            symbol,
            results: engine.findImplementors(symbol, { limit }),
          },
        };
      }
    }
  }

  private missingSymbol(action: AstQueryParams['action']): ToolResult {
    const text = astQueryText();
    return createToolError({
      code: 'AST_QUERY_SYMBOL_REQUIRED',
      message: text.symbolRequiredMessage(action),
      retryable: true,
      fix: text.symbolRequiredFix(action),
    });
  }
}

export default AstQueryTool;
