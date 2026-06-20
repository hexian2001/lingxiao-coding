/**
 * lingxiao-code-intelligence — MCP Server (Node.js stdio)
 *
 * Native MCP Server exposing LingXiao code intelligence capabilities.
 * Tools: ast_query, code_search, list_dir, glob, file_read
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { readDepsFromEnv, jsonResult, errorResult, textResult } from './shared.js';
import { VERSION } from '../version.js';

const { workspace } = readDepsFromEnv();

const server = new McpServer({
  name: 'lingxiao-code-intelligence',
  version: VERSION,
});

// ── Tool: ast_query ───────────────────────────────────────────────────────
server.tool(
  'ast_query',
  'Query AST for definitions, references, call graphs, etc. Uses tree-sitter.',
  {
    action: z.enum(['definitions', 'references', 'public_api', 'pattern', 'call_graph', 'implementors']).describe('Query action'),
    symbol: z.string().optional().describe('Symbol name to query'),
    file_pattern: z.string().optional().describe('File pattern (e.g. *.ts)'),
    path: z.string().optional().describe('Root path (default: workspace)'),
  },
  async ({ action, symbol, file_pattern, path }) => {
    try {
      const rootPath = path ? resolve(workspace, path) : workspace;
      // Use ripgrep for definitions/references as a lightweight AST substitute
      if (action === 'definitions' || action === 'references') {
        const rgArgs = [
          '--json',
          '--no-heading',
          '-t', 'typescript',
          '-t', 'javascript',
          '-t', 'python',
        ];
        if (file_pattern) {
          rgArgs.push('-g', file_pattern);
        }
        const pattern = action === 'definitions'
          ? `(function|const|class|interface|type|export)\\s+${symbol}`
          : symbol;
        rgArgs.push(pattern || "", rootPath);
        try {
          const output = execSync(`rg ${rgArgs.map(a => `'${a}'`).join(' ')}`, {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 10,
          });
          const results = output.split('\n').filter(Boolean).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
          return jsonResult({ action, symbol, results });
        } catch {
          return jsonResult({ action, symbol, results: [], note: 'No matches or ripgrep not available' });
        }
      }
      if (action === 'pattern') {
        const rgArgs = ['--json', '--no-heading'];
        if (file_pattern) rgArgs.push('-g', file_pattern);
        rgArgs.push(symbol || '', rootPath);
        try {
          const output = execSync(`rg ${rgArgs.map(a => `'${a}'`).join(' ')}`, {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 10,
          });
          const results = output.split('\n').filter(Boolean).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
          return jsonResult({ action, pattern: symbol, results });
        } catch {
          return jsonResult({ action, pattern: symbol, results: [] });
        }
      }
      // call_graph and implementors require deeper AST analysis
      return jsonResult({ action, symbol, note: 'This action type requires full AST analysis. Use code_search as fallback.' });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: code_search ─────────────────────────────────────────────────────
server.tool(
  'code_search',
  'Search code/text in the workspace using ripgrep (supports regex)',
  {
    pattern: z.string().describe('Search pattern (regex supported)'),
    path: z.string().optional().describe('Search path (default: workspace root)'),
    file_pattern: z.string().optional().describe('File name pattern (e.g. *.ts)'),
    limit: z.number().int().min(1).max(500).optional().describe('Max results (default: 100)'),
    offset: z.number().int().min(0).optional().describe('Skip first N results'),
  },
  async ({ pattern, path: searchPath, file_pattern, limit, offset }) => {
    try {
      const rootPath = searchPath ? resolve(workspace, searchPath) : workspace;
      const rgArgs = ['--json', '--no-heading', '-n'];
      if (file_pattern) rgArgs.push('-g', file_pattern);
      rgArgs.push(pattern || "", rootPath);
      try {
        const output = execSync(`rg ${rgArgs.map(a => `'${a}'`).join(' ')}`, {
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 10,
        });
        let results = output.split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const off = offset || 0;
        const lim = limit || 100;
        results = results.slice(off, off + lim);
        return jsonResult({ pattern, results, total: results.length, offset: off });
      } catch {
        return jsonResult({ pattern, results: [], note: 'No matches or ripgrep not available' });
      }
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: list_dir ────────────────────────────────────────────────────────
server.tool(
  'list_dir',
  'List directory contents (tree structure)',
  {
    path: z.string().describe('Directory path'),
    depth: z.number().int().min(1).max(10).optional().describe('Recursion depth (default: 2)'),
  },
  async ({ path: dirPath, depth }) => {
    try {
      const absPath = isAbsolute(dirPath) ? dirPath : resolve(workspace, dirPath);
      const maxDepth = depth || 2;
      function walk(dir: string, currentDepth: number): unknown[] {
        if (currentDepth <= 0) return [];
        const entries = readdirSync(dir, { withFileTypes: true });
        return entries.map(entry => {
          const fullPath = join(dir, entry.name);
          const rel = relative(workspace, fullPath);
          const node: Record<string, unknown> = {
            name: entry.name,
            path: rel,
            type: entry.isDirectory() ? 'directory' : 'file',
          };
          if (entry.isDirectory() && currentDepth > 1) {
            try {
              node.children = walk(fullPath, currentDepth - 1);
            } catch { /* skip */ }
          }
          return node;
        });
      }
      const tree = walk(absPath, maxDepth);
      return jsonResult({ path: dirPath, entries: tree });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: glob ────────────────────────────────────────────────────────────
server.tool(
  'glob',
  'Find files matching a glob pattern',
  {
    pattern: z.string().describe('Glob pattern (e.g. **/*.ts, src/**/*.{js,ts})'),
    path: z.string().optional().describe('Root path (default: workspace)'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max results (default: 100)'),
  },
  async ({ pattern, path: searchPath, limit }) => {
    try {
      const rootPath = searchPath ? resolve(workspace, searchPath) : workspace;
      try {
        const output = execSync(
          `find '${rootPath}' -type f -name '${pattern.replace(/\*\*/g, '*').replace(/\{([^}]+)\}/g, '$1')}' | head -n ${limit || 100}`,
          { encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024 * 10 },
        );
        const files = output.split('\n').filter(Boolean).map(f => relative(workspace, f));
        return jsonResult({ pattern, files });
      } catch {
        return jsonResult({ pattern, files: [] });
      }
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: file_read ───────────────────────────────────────────────────────
server.tool(
  'file_read',
  'Read file contents',
  {
    path: z.string().describe('File path'),
    start_line: z.number().int().min(1).optional().describe('Start line (1-based)'),
    end_line: z.number().int().min(1).optional().describe('End line (inclusive)'),
  },
  async ({ path: filePath, start_line, end_line }) => {
    try {
      const absPath = isAbsolute(filePath) ? filePath : resolve(workspace, filePath);
      const content = readFileSync(absPath, 'utf-8');
      if (start_line && end_line) {
        const lines = content.split('\n');
        const sliced = lines.slice(start_line - 1, end_line).join('\n');
        return textResult(sliced);
      }
      return textResult(content);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
