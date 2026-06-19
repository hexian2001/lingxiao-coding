/**
 * lingxiao-session — MCP Server (Node.js stdio)
 *
 * Native MCP Server exposing LingXiao session/task/message management.
 * Tools: create_session, resume_session, list_sessions, get_session, get_tasks, get_messages, get_agent_logs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DatabaseManager } from '../core/Database.js';
import { textResult, jsonResult, errorResult, readDepsFromEnv } from './shared.js';

const { dbPath, workspace } = readDepsFromEnv();
const db = new DatabaseManager(dbPath);

const server = new McpServer({
  name: 'lingxiao-session',
  version: '1.0.0',
});

// ── Tool: create_session ──────────────────────────────────────────────────
server.tool(
  'create_session',
  'Create a new LingXiao session with a workspace path and optional user request',
  {
    workspace: z.string().describe('Workspace path for the session'),
    user_request: z.string().optional().describe('Initial user request or description'),
  },
  async ({ workspace: ws, user_request }) => {
    try {
      const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      db.insertSession(sessionId, ws, user_request || null);
      return jsonResult({ sessionId, workspace: ws, created: true });
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: resume_session ──────────────────────────────────────────────────
server.tool(
  'resume_session',
  'Get session info for resuming (returns session details)',
  {
    session_id: z.string().describe('Session ID to resume'),
  },
  async ({ session_id }) => {
    try {
      const session = db.getSession(session_id);
      if (!session) {
        return errorResult(`Session not found: ${session_id}`);
      }
      return jsonResult(session);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: list_sessions ───────────────────────────────────────────────────
server.tool(
  'list_sessions',
  'List all LingXiao sessions ordered by creation time (newest first)',
  {},
  async () => {
    try {
      const sessions = db.listSessions();
      return jsonResult(sessions);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: get_session ─────────────────────────────────────────────────────
server.tool(
  'get_session',
  'Get details of a specific session by ID',
  {
    session_id: z.string().describe('Session ID'),
  },
  async ({ session_id }) => {
    try {
      const session = db.getSession(session_id);
      if (!session) {
        return errorResult(`Session not found: ${session_id}`);
      }
      return jsonResult(session);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: get_tasks ───────────────────────────────────────────────────────
server.tool(
  'get_tasks',
  'Get all tasks for a specific session',
  {
    session_id: z.string().describe('Session ID'),
  },
  async ({ session_id }) => {
    try {
      const tasks = db.getTasksBySession(session_id);
      return jsonResult(tasks);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: get_messages ────────────────────────────────────────────────────
server.tool(
  'get_messages',
  'Get all messages for a specific session, ordered by timestamp',
  {
    session_id: z.string().describe('Session ID'),
  },
  async ({ session_id }) => {
    try {
      const messages = db.getMessages(session_id);
      return jsonResult(messages);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Tool: get_agent_logs ──────────────────────────────────────────────────
server.tool(
  'get_agent_logs',
  'Get agent logs for a session, optionally filtered by agent ID',
  {
    session_id: z.string().describe('Session ID'),
    agent_id: z.string().optional().describe('Filter by agent ID'),
  },
  async ({ session_id, agent_id }) => {
    try {
      const logs = db.getAgentLogs(session_id, agent_id);
      return jsonResult(logs);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
