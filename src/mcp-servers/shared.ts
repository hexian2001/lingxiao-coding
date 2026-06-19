/**
 * Shared types and utilities for LingXiao native MCP Servers.
 */

export interface ServerDeps {
  dbPath: string;
  workspace: string;
}

/**
 * Read common dependencies from environment variables.
 * Each MCP Server process receives these via env when spawned by LingXiao.
 */
export function readDepsFromEnv(): ServerDeps {
  const dbPath = process.env.LINGXIAO_DB_PATH;
  if (!dbPath) {
    throw new Error('LINGXIAO_DB_PATH environment variable is required');
  }
  const workspace = process.env.LINGXIAO_WORKSPACE || process.cwd();
  return { dbPath, workspace };
}

/**
 * Wrap a handler result into MCP content response.
 */
export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Wrap a JSON object into MCP content response.
 */
export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * Wrap an error into MCP content response.
 */
export function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}
