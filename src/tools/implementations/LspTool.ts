/**
 * LSP Tool — provides code intelligence operations via Language Server Protocol.
 *
 * Experimental: only registered when LINGXIAO_EXPERIMENTAL_LSP=1
 */
import { z } from 'zod';
import { resolve } from 'node:path';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import {
  detectLanguage,
  formatLocation,
  formatSymbol,
  getOrCreateConnection,
} from '../LspClient.js';

const LspOperationEnum = z.enum([
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
]);

const LspToolSchema = z.object({
  operation: LspOperationEnum.describe('The LSP operation to perform'),
  filePath: z.string().describe('Absolute or relative file path to operate on'),
  line: z.number().int().min(1).optional().describe('Line number (1-based). Required for goToDefinition, findReferences, hover'),
  character: z.number().int().min(1).optional().describe('Character offset (1-based). Required for goToDefinition, findReferences, hover'),
  query: z.string().optional().describe('Search query for workspaceSymbol operation'),
});

type LspToolArgs = z.infer<typeof LspToolSchema>;

export class LspTool extends Tool {
  readonly name = 'lsp';
  readonly description = 'Code intelligence via Language Server Protocol. Supports go-to-definition, find-references, hover, document symbols, and workspace symbol search.';
  readonly parameters = LspToolSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as LspToolArgs;
    const workspace = context?.workspace || process.cwd();
    const filePath = resolve(workspace, params.filePath);

    // Validate positional args for operations that need them
    const positionalOps = ['goToDefinition', 'findReferences', 'hover'];
    if (positionalOps.includes(params.operation)) {
      if (params.line == null || params.character == null) {
        return {
          success: false,
          data: null,
          error: `Operation "${params.operation}" requires both "line" and "character" parameters (1-based).`,
        };
      }
    }

    if (params.operation === 'workspaceSymbol' && !params.query) {
      return {
        success: false,
        data: null,
        error: 'Operation "workspaceSymbol" requires a "query" parameter.',
      };
    }

    const language = detectLanguage(filePath);
    if (!language) {
      return {
        success: false,
        data: null,
        error: `Could not detect language for file: ${params.filePath}. Supported extensions: ts, tsx, js, jsx, py, rs, go`,
      };
    }

    try {
      const conn = await getOrCreateConnection(language, workspace);
      switch (params.operation) {
        case 'goToDefinition': {
          const locations = await conn.goToDefinition(filePath, params.line!, params.character!);
          if (locations.length === 0) {
            return { success: true, data: 'No definition found at the specified position.' };
          }
          return { success: true, data: locations.map(formatLocation).join('\n') };
        }
        case 'findReferences': {
          const refs = await conn.findReferences(filePath, params.line!, params.character!);
          if (refs.length === 0) {
            return { success: true, data: 'No references found at the specified position.' };
          }
          return { success: true, data: refs.map(formatLocation).join('\n') };
        }
        case 'hover': {
          const hover = await conn.hover(filePath, params.line!, params.character!);
          if (!hover) {
            return { success: true, data: 'No hover information available at the specified position.' };
          }
          return { success: true, data: hover.contents };
        }
        case 'documentSymbol': {
          const symbols = await conn.documentSymbol(filePath);
          if (symbols.length === 0) {
            return { success: true, data: 'No symbols found in this document.' };
          }
          return { success: true, data: symbols.map(formatSymbol).join('\n') };
        }
        case 'workspaceSymbol': {
          const symbols = await conn.workspaceSymbol(params.query!);
          if (symbols.length === 0) {
            return { success: true, data: `No symbols matching "${params.query}" found in workspace.` };
          }
          return { success: true, data: symbols.map(formatSymbol).join('\n') };
        }
        default:
          return { success: false, data: null, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        error: `LSP operation failed: ${msg}. Ensure the language server is installed and available on PATH.`,
      };
    }
  }
}

export default LspTool;
