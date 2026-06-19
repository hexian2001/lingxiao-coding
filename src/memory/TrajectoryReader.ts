/**
 * TrajectoryReader — read-only access to the raw conversation trajectory.
 *
 * The trajectory tables (leader_conversation + agent_conversation) are the
 * source of truth for what actually happened in a project: verbatim user words,
 * assistant output, tool-call inputs, and reasoning. Checkpoints are a lossy
 * second compression layered on top. /dream and /distill both consolidate from
 * this upstream signal — mimo's design treats raw trajectory as authoritative
 * and memory files as a cache, and this module gives the deterministic command
 * classes that same authoritative input.
 *
 * Everything here is read-only SQL with no heuristic scoring: a time-bounded,
 * newest-first window over both tables, flattened to plain text.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { coreLogger } from '../core/Log.js';
import type { TrajectoryTurn } from './types.js';

/**
 * Resolve the session database path.
 * Priority: explicit > env (LINGXIAO_DB_PATH) > default (~/.lingxiao/data.db).
 */
export function resolveSessionDbPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.LINGXIAO_DB_PATH) return process.env.LINGXIAO_DB_PATH;
  return join(homedir(), '.lingxiao', 'data.db');
}

/**
 * Pull the raw conversation trajectory within a lookback window.
 *
 * timestamp columns store `Date.now()/1000` (unix seconds); `afterTimestampMs`
 * is supplied in epoch milliseconds (the same units callers compute for the
 * checkpoint cutoff) and converted here.
 *
 * @param dbPath resolved session DB path.
 * @param afterTimestampMs lower bound in epoch milliseconds.
 * @param maxTurns hard cap, newest-first, to bound LLM input.
 */
export function readRecentTrajectory(dbPath: string, afterTimestampMs: number, maxTurns = 400): TrajectoryTurn[] {
  const afterSec = afterTimestampMs / 1000;
  if (!existsSync(dbPath)) {
    coreLogger.warn(`[TrajectoryReader] Session database not found at ${dbPath}`);
    return [];
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA query_only = ON');
    // UNION the two trajectory tables into one time-ordered stream. Both share
    // role/content/tool_calls/timestamp; leader has no agent column.
    const rows = db.prepare(
      `SELECT * FROM (
         SELECT session_id, 'leader' AS agent, role, content, tool_calls, timestamp
           FROM leader_conversation WHERE timestamp > ?
         UNION ALL
         SELECT session_id, COALESCE(NULLIF(agent_name, ''), agent_id, 'worker') AS agent,
                role, content, tool_calls, timestamp
           FROM agent_conversation WHERE timestamp > ?
       )
       ORDER BY timestamp DESC
       LIMIT ?`
    ).all(afterSec, afterSec, maxTurns) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      sessionId: String(r.session_id ?? ''),
      agent: String(r.agent ?? 'leader'),
      role: String(r.role ?? ''),
      text: flattenContent(r.content),
      toolCalls: summarizeToolCalls(r.tool_calls),
      timestamp: Number(r.timestamp ?? 0),
    }));
  } catch (err) {
    coreLogger.warn(`[TrajectoryReader] Trajectory read failed: ${err instanceof Error ? err.message : err}`);
    return [];
  } finally {
    db.close();
  }
}

/** Flatten a stored content column (plain string or JSON content blocks) to text. */
export function flattenContent(raw: unknown): string {
  if (raw == null) return '';
  const str = String(raw);
  const trimmed = str.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return str;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      return parsed
        .map((block) => {
          if (typeof block === 'string') return block;
          if (block && typeof block === 'object' && 'text' in block) return String((block as { text: unknown }).text ?? '');
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (parsed && typeof parsed === 'object' && 'text' in parsed) {
      return String((parsed as { text: unknown }).text ?? '');
    }
    return str;
  } catch {
    return str;
  }
}

/** Render stored tool_calls JSON into compact "name(input…)" lines. */
export function summarizeToolCalls(raw: unknown): string[] {
  if (raw == null) return [];
  try {
    const calls = JSON.parse(String(raw));
    if (!Array.isArray(calls)) return [];
    return calls.map((c) => {
      const fn = (c && typeof c === 'object' && 'function' in c)
        ? (c as { function?: { name?: string; arguments?: string } }).function
        : undefined;
      const name = fn?.name ?? (c && typeof c === 'object' && 'name' in c ? String((c as { name: unknown }).name) : 'tool');
      const args = fn?.arguments ?? '';
      const argPreview = typeof args === 'string' ? args.slice(0, 160) : '';
      return argPreview ? `${name}(${argPreview})` : String(name);
    });
  } catch {
    return [];
  }
}

/** Render trajectory turns into a compact, token-bounded transcript for an LLM. */
export function renderTrajectory(turns: TrajectoryTurn[], maxTextPerTurn = 600): string {
  return turns
    .map((t) => {
      const who = t.agent === 'leader' ? t.role : `${t.role}@${t.agent}`;
      const text = t.text.length > maxTextPerTurn ? t.text.slice(0, maxTextPerTurn) + '…' : t.text;
      const lines = [`[${who}] ${text}`.trim()];
      for (const call of t.toolCalls) {
        lines.push(`  → ${call}`);
      }
      return lines.join('\n');
    })
    .filter((block) => block.trim().length > 0)
    .join('\n');
}
