/**
 * lingxiao-memory — MCP Server (Node.js stdio)
 *
 * Native MCP Server exposing LingXiao memory and blackboard management.
 * Tools: save_memory, load_memory, delete_memory, list_memories, search_memory,
 *        search_fts, rebuild_index, get_blackboard_snapshot
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryManager } from '../memory/MemoryManager.js';
import { GraphStore } from '../core/blackboard/GraphStore.js';
import { BlackboardGraph } from '../core/blackboard/BlackboardGraph.js';
import { readDepsFromEnv, jsonResult, errorResult } from './shared.js';

const { dbPath, workspace } = readDepsFromEnv();

const memory = new MemoryManager(workspace);
const graphStore = new GraphStore(dbPath as any);
const blackboard = new BlackboardGraph(graphStore);

const server = new McpServer({
  name: 'lingxiao-memory',
  version: '1.0.0',
});

// ── Tool: save_memory ─────────────────────────────────────────────────────
server.tool(
  'save_memory',
  'Save or update a memory entry (markdown file with frontmatter)',
  {
    name: z.string().describe('Memory name (letters, numbers, dots, underscores, hyphens)'),
    type: z.enum(['user', 'feedback', 'project', 'reference']).describe('Memory type'),
    description: z.string().describe('One-line description'),
    content: z.string().describe('Memory content (markdown)'),
    scope: z.enum(['project', 'user']).optional().describe('Memory scope (default: project)'),
  },
  async ({ name, type, description, content, scope }) => {
    try {
      const entry = memory.saveMemory(name, type, description, content, scope || 'project');
      return jsonResult(entry);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: load_memory ─────────────────────────────────────────────────────
server.tool(
  'load_memory',
  'Load a memory entry by name',
  {
    name: z.string().describe('Memory name'),
    scope: z.enum(['project', 'user']).optional().describe('Memory scope (default: project)'),
  },
  async ({ name, scope }) => {
    try {
      const entry = memory.readMemory(name, scope || 'project');
      if (!entry) {
        return errorResult(`Memory not found: ${name}`);
      }
      return jsonResult(entry);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: delete_memory ───────────────────────────────────────────────────
server.tool(
  'delete_memory',
  'Delete a memory entry by name',
  {
    name: z.string().describe('Memory name'),
    scope: z.enum(['project', 'user']).optional().describe('Memory scope (default: project)'),
  },
  async ({ name, scope }) => {
    try {
      const deleted = memory.deleteMemory(name, scope || 'project');
      if (!deleted) {
        return errorResult(`Memory not found: ${name}`);
      }
      return jsonResult({ name, deleted: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: list_memories ───────────────────────────────────────────────────
server.tool(
  'list_memories',
  'List all memory entries, optionally filtered by scope',
  {
    scope: z.enum(['project', 'user']).optional().describe('Filter by scope (default: all)'),
  },
  async ({ scope }) => {
    try {
      const entries = scope ? memory.listMemories(scope) : memory.listAllMemories();
      return jsonResult(entries);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: search_memory ───────────────────────────────────────────────────
server.tool(
  'search_memory',
  'Search memory entries using FTS5+BM25 full-text search',
  {
    query: z.string().describe('Search query'),
    max_results: z.number().int().min(1).max(50).optional().describe('Max results (default: 8)'),
  },
  async ({ query, max_results }) => {
    try {
      const results = memory.searchFTS(query, max_results || 8);
      return jsonResult(results);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: search_fts ──────────────────────────────────────────────────────
server.tool(
  'search_fts',
  'Search memory entries across all scopes (project + user) with formatted output',
  {
    query: z.string().describe('Search query'),
    scope: z.enum(['project', 'user']).optional().describe('Scope (default: all)'),
    max_results: z.number().int().min(1).max(50).optional().describe('Max results (default: 8)'),
  },
  async ({ query, scope, max_results }) => {
    try {
      if (scope) {
        const formatted = memory.searchAndFormat(query, scope, max_results || 8);
        return jsonResult({ formatted, scope });
      }
      const formatted = memory.searchAllAndFormat(query, { maxResults: max_results || 8 });
      return jsonResult({ formatted, scope: 'all' });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: rebuild_index ───────────────────────────────────────────────────
server.tool(
  'rebuild_index',
  'Rebuild the memory FTS index for a scope',
  {
    scope: z.enum(['project', 'user']).describe('Memory scope to rebuild'),
  },
  async ({ scope }) => {
    try {
      memory.rebuildIndex(scope);
      return jsonResult({ scope, rebuilt: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: get_blackboard_snapshot ─────────────────────────────────────────
server.tool(
  'get_blackboard_snapshot',
  'Get a snapshot of the blackboard graph for a session (facts, intents, contracts, etc.)',
  {
    session_id: z.string().describe('Session ID'),
  },
  async ({ session_id }) => {
    try {
      const snapshot = blackboard.getSnapshot(session_id);
      return jsonResult(snapshot);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
