/**
 * SessionFork — fork a session from any message point, creating a new branch.
 *
 * Creates a new session that inherits all messages up to (and including) a
 * specified message, plus session metadata. The original session is unchanged.
 */

import { randomUUID } from 'crypto';
import type { DatabaseManager } from '../Database.js';
import { SESSION_KEYS } from '../SessionStateKeys.js';

export interface ForkSessionOptions {
  /** The session to fork from */
  sessionId: string;
  /** The message ID (rowid in leader_conversation) to fork at — all messages up to and including this one are copied */
  messageId: number;
}

export interface ForkSessionResult {
  newSessionId: string;
  parentSessionId: string;
  messagesCopied: number;
}

/**
 * Generate a unique session ID that doesn't collide with existing ones.
 */
function generateForkSessionId(db: DatabaseManager): string {
  let id: string;
  let attempts = 0;
  do {
    id = randomUUID().substring(0, 16);
    attempts++;
    if (attempts > 10) {
      id = randomUUID();
      break;
    }
  } while (db.getSession(id) !== null);
  return id;
}

/**
 * Fork a session from a specific message point.
 *
 * Steps:
 *  1. Validate source session and message exist
 *  2. Generate new session ID
 *  3. Copy session metadata (workspace, status, name prefix)
 *  4. Copy all messages up to and including messageId
 *  5. Store parentSessionId in session_state for traceability
 *  6. Return fork result
 */
export function forkSession(db: DatabaseManager, options: ForkSessionOptions): ForkSessionResult {
  const { sessionId, messageId } = options;

  // 1. Validate source session exists
  const sourceSession = db.getSession(sessionId);
  if (!sourceSession) {
    throw new Error(`Source session not found: ${sessionId}`);
  }

  // 2. Validate message exists and belongs to the session
  const conn = db.getDb();
  const targetMsg = conn.prepare(
    'SELECT id, timestamp FROM leader_conversation WHERE session_id = ? AND id = ?'
  ).get(sessionId, messageId) as { id: number; timestamp: number } | undefined;

  if (!targetMsg) {
    throw new Error(`Message ${messageId} not found in session ${sessionId}`);
  }

  // 3. Generate new session ID
  const newSessionId = generateForkSessionId(db);

  // 4. Copy session metadata
  const now = Date.now() / 1000;
  conn.prepare(
    'INSERT INTO sessions (id, created_at, workspace, user_request, status, name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    newSessionId,
    now,
    sourceSession.workspace,
    typeof sourceSession.user_request === 'string'
      ? sourceSession.user_request
      : JSON.stringify(sourceSession.user_request),
    'active',
    sourceSession.name ? `Fork: ${sourceSession.name}` : null,
  );

  // 5. Copy all messages up to and including messageId (by rowid order)
  const messages = conn.prepare(
    `SELECT role, content, tool_calls, tool_call_id, thinking_blocks, timestamp
     FROM leader_conversation
     WHERE session_id = ? AND id <= ?
     ORDER BY id`
  ).all(sessionId, messageId) as Array<{
    role: string;
    content: string;
    tool_calls: string | null;
    tool_call_id: string | null;
    thinking_blocks: string | null;
    timestamp: number;
  }>;

  for (const msg of messages) {
    conn.prepare(
      `INSERT INTO leader_conversation
       (session_id, role, content, tool_calls, tool_call_id, thinking_blocks, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newSessionId,
      msg.role,
      msg.content,
      msg.tool_calls,
      msg.tool_call_id,
      msg.thinking_blocks,
      msg.timestamp,
    );
  }

  // 6. Store parentSessionId for traceability
  db.setSessionState(newSessionId, SESSION_KEYS.FORK_PARENT_SESSION_ID, {
    parentSessionId: sessionId,
    forkedAtMessageId: messageId,
    forkedAt: Date.now(),
  });

  return {
    newSessionId,
    parentSessionId: sessionId,
    messagesCopied: messages.length,
  };
}
