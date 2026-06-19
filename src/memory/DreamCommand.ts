/**
 * DreamCommand — /dream consolidation command.
 *
 * Reads recent session checkpoints and the current project MEMORY.md,
 * uses a small LLM to consolidate durable knowledge into 4 structured sections,
 * then writes the updated MEMORY.md (capped at 200 lines / 10KB).
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { coreLogger } from '../core/Log.js';
import { contentToPlainText } from '../contracts/types/Message.js';
import { MemoryService } from './MemoryService.js';
import { createLLMClient } from '../llm/Client.js';
import { deduplicateMemory } from './MemoryDeduplicator.js';
import { readRecentTrajectory, renderTrajectory } from './TrajectoryReader.js';
import type { DreamOptions, DreamResult, TrajectoryTurn } from './types.js';

const MAX_LINES = 200;
const MAX_BYTES = 10 * 1024;

const DREAM_SYSTEM_PROMPT = `You are a memory consolidation assistant. Your job is to merge session checkpoint knowledge into a structured project MEMORY.md file.

Output markdown sections (## headers). Include a section only when it has content — never emit an empty section:

## Project Context
Key facts about the project: tech stack, architecture, conventions.

## Rules
Hard rules the user has explicitly stated (never do X, always do Y).

## Architecture Decisions
Important design decisions, each with its rationale and an absolute date (YYYY-MM-DD).

## Discovered Durable Knowledge
Cross-session durable facts learned from the trajectory.

## Patterns
Repeated problems and the solution that worked, when the same situation recurs across sessions.

## Gotchas
Easy-to-miss traps and non-obvious failure modes worth flagging for future sessions.

Guidelines:
- Merge new checkpoint information into existing sections (do not duplicate or append near-identical entries).
- Remove stale or contradicted information when newer checkpoints prove it obsolete.
- Keep each entry to 1-3 lines. Information density matters more than completeness.
- Convert relative dates ("yesterday", "last week") to absolute YYYY-MM-DD form.
- Preserve the source session id at the end of an entry when the checkpoint provides one, e.g. \`[ses_xxx]\`.
- Promote a fact only when supported by an explicit user statement, a clear decision, or repeated evidence across sessions. One-off details that mattered to a single session should be dropped.
- Write in the same language as the source material.
- Total output must stay under 200 lines and 10KB. Prefer fewer, denser entries.
- Do NOT add introductory text before the first section.`;

/** Regex to detect non-SELECT SQL statements. */
const UNSAFE_SQL_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH)\b/i;

export interface SessionVerification {
  recentSessionCount: number;
  totalMessages: number;
  verified: boolean;
}

export class DreamCommand {
  private service: MemoryService;
  private dbPath: string | undefined;

  constructor(service: MemoryService, dbPath?: string) {
    this.service = service;
    this.dbPath = dbPath;
  }

  /**
   * Resolve the session database path.
   * Priority: constructor-supplied > env > default (~/.lingxiao/data.db)
   */
  private resolveDbPath(): string {
    if (this.dbPath) return this.dbPath;
    if (process.env.LINGXIAO_DB_PATH) return process.env.LINGXIAO_DB_PATH;
    return join(homedir(), '.lingxiao', 'data.db');
  }

  /**
   * Execute a read-only SQL query against the session database.
   * Only SELECT queries are allowed; any mutation keywords are rejected.
   */
  querySessionDB(query: string): unknown[] {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error('[DreamCommand] Empty SQL query');
    }
    if (UNSAFE_SQL_PATTERN.test(trimmed)) {
      throw new Error('[DreamCommand] Only SELECT queries are allowed');
    }
    if (!trimmed.toUpperCase().startsWith('SELECT')) {
      throw new Error('[DreamCommand] Only SELECT queries are allowed');
    }

    const dbPath = this.resolveDbPath();
    if (!existsSync(dbPath)) {
      coreLogger.warn(`[DreamCommand] Session database not found at ${dbPath}`);
      return [];
    }

    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA query_only = ON');
      const rows = db.prepare(trimmed).all();
      return rows as unknown[];
    } finally {
      db.close();
    }
  }

  /**
   * Cross-check extracted knowledge against session DB.
   * Queries recent sessions and message counts to validate that knowledge
   * comes from real, active conversations.
   */
  verifyAgainstSessionDB(): SessionVerification {
    try {
      const sessions = this.querySessionDB(
        "SELECT * FROM sessions WHERE created_at > (strftime('%s','now') - 7*86400)"
      ) as Array<Record<string, unknown>>;

      const messageCounts = this.querySessionDB(
        `SELECT session_id, COUNT(*) as msg_count FROM messages
         WHERE session_id IN (
           SELECT id FROM sessions WHERE created_at > (strftime('%s','now') - 7*86400)
         )
         GROUP BY session_id`
      ) as Array<Record<string, unknown>>;

      const totalMessages = messageCounts.reduce(
        (sum, row) => sum + Number(row.msg_count || 0), 0
      );

      return {
        recentSessionCount: sessions.length,
        totalMessages,
        verified: sessions.length > 0 && totalMessages > 0,
      };
    } catch (err) {
      coreLogger.warn(`[DreamCommand] Session DB verification failed: ${err instanceof Error ? err.message : err}`);
      return { recentSessionCount: 0, totalMessages: 0, verified: false };
    }
  }

  /**
   * Pull the raw conversation trajectory from the source-of-truth tables
   * (leader_conversation + agent_conversation) within the lookback window.
   *
   * Delegates to the shared TrajectoryReader; kept as a thin instance method so
   * the resolved db path (constructor > env > default) is applied consistently
   * with verifyAgainstSessionDB.
   *
   * @param afterTimestampMs lower bound in epoch milliseconds.
   * @param maxTurns hard cap on returned turns, newest-first.
   */
  getRecentTrajectory(afterTimestampMs: number, maxTurns = 400): TrajectoryTurn[] {
    return readRecentTrajectory(this.resolveDbPath(), afterTimestampMs, maxTurns);
  }

  /**
   * Execute the /dream consolidation.
   */
  async execute(options: DreamOptions): Promise<DreamResult> {
    const lookbackMs = (options.sessionLookbackDays ?? 7) * 24 * 60 * 60 * 1000;
    const maxLines = options.maxLines ?? MAX_LINES;
    const maxBytes = options.maxBytes ?? MAX_BYTES;
    const report = options.reporter;

    // 1. Read current project MEMORY.md.
    // memoryRoot is already workspace-scoped (<workspace>/.lingxiao/memory), so the
    // top-level MEMORY.md *is* this project's memory — and it is the exact file
    // ContextRebuild reads back into agent context (ContextRebuild.readProjectMemory).
    // Writing into a projects/<id>/ subdir would strand the consolidation where no
    // consumer reads it. options.projectId/workspace are retained on the type for
    // FTS scope tagging and caller symmetry, but the consolidation target is fixed.
    const memoryRoot = this.service.getMemoryRoot();
    const memoryPath = join(memoryRoot, 'MEMORY.md');
    let currentMemory = '';
    if (existsSync(memoryPath)) {
      currentMemory = readFileSync(memoryPath, 'utf-8');
    }

    // 2. Force reconciliation to ensure fresh index
    this.service.reconcile();

    // 3. Get recent checkpoints (last 7 days)
    const cutoff = Date.now() - lookbackMs;
    const checkpoints = this.service.getRecentCheckpoints(cutoff);

    // 3a. Pull the raw trajectory (source of truth) for the same window. Bounded,
    // newest-first; the LLM uses this to verify and enrich beyond the lossy
    // checkpoint summaries. Oldest-first ordering reads more naturally as a log.
    report?.progress('reading', 0.15, '读取 checkpoint 与原始轨迹');
    const trajectory = this.getRecentTrajectory(cutoff).reverse();

    if (checkpoints.length === 0 && trajectory.length === 0 && !currentMemory) {
      coreLogger.info('[DreamCommand] No checkpoints, no trajectory, and no existing memory. Nothing to consolidate.');
      return {
        updatedPath: memoryPath,
        sectionsConsolidated: 0,
        linesWritten: 0,
        checkpointsProcessed: 0,
      };
    }

    // 3b. Verification phase: cross-check against session DB
    report?.progress('analyzing', 0.35, `校对 ${checkpoints.length} 个 checkpoint · ${trajectory.length} 轮轨迹`);
    const verification = this.verifyAgainstSessionDB();
    if (verification.verified) {
      coreLogger.info(`[DreamCommand] Verification passed: ${verification.recentSessionCount} sessions, ${verification.totalMessages} messages in last 7 days`);
    } else {
      coreLogger.info('[DreamCommand] Verification: no recent session data found in DB (proceeding with checkpoint data only)');
    }

    // 4. Build LLM input
    const checkpointBodies = checkpoints
      .map((cp) => `--- checkpoint: ${cp.scope_id} ---\n${cp.body}`)
      .join('\n\n');

    const userMessage = this.buildUserMessage(currentMemory, checkpointBodies, checkpoints.length, trajectory);

    // 5. Call LLM
    report?.progress('generating', 0.55, '调用模型整合记忆');
    let consolidated: string;
    try {
      const llm = createLLMClient();
      const response = await llm.generateContent({
        messages: [
          { role: 'system', content: DREAM_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        model: '',
        maxTokens: 2000,
        sampling: { temperature: 0.3 },
      });

      consolidated = contentToPlainText(response.content);
    } catch (err) {
      coreLogger.warn(`[DreamCommand] LLM call failed: ${err instanceof Error ? err.message : err}`);
      // Fall back: keep existing memory unchanged
      return {
        updatedPath: memoryPath,
        sectionsConsolidated: 0,
        linesWritten: currentMemory.split('\n').length,
        checkpointsProcessed: checkpoints.length,
      };
    }

    // 6. Enforce size limits
    consolidated = this.enforceLimit(consolidated, maxLines, maxBytes);

    // P3: Post-merge algorithmic deduplication
    const dedupResult = deduplicateMemory(consolidated, {
      similarityThreshold: 0.65,
      minSectionLength: 20,
    });
    if (dedupResult.duplicatesRemoved > 0) {
      coreLogger.info(
        `[DreamCommand] Post-merge dedup: removed ${dedupResult.duplicatesRemoved} duplicate sections (${dedupResult.sectionsBefore} → ${dedupResult.sectionsAfter})`,
      );
      consolidated = dedupResult.content;
    }

    // 7. Write updated MEMORY.md
    report?.progress('writing', 0.9, '写入 MEMORY.md');
    const dir = dirname(memoryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(memoryPath, consolidated, 'utf-8');

    const lines = consolidated.split('\n').length;
    const sections = (consolidated.match(/^## /gm) || []).length;

    coreLogger.info(`[DreamCommand] Consolidated ${checkpoints.length} checkpoints into ${lines} lines (${sections} sections)`);

    return {
      updatedPath: memoryPath,
      sectionsConsolidated: sections,
      linesWritten: lines,
      checkpointsProcessed: checkpoints.length,
      verification,
    };
  }

  private buildUserMessage(currentMemory: string, checkpointBodies: string, count: number, trajectory: TrajectoryTurn[] = []): string {
    const parts: string[] = [];

    if (currentMemory) {
      parts.push('=== CURRENT MEMORY.md ===');
      parts.push(currentMemory);
      parts.push('');
    }

    if (trajectory.length > 0) {
      parts.push(`=== RAW TRAJECTORY — SOURCE OF TRUTH (${trajectory.length} turns, oldest first) ===`);
      parts.push(renderTrajectory(trajectory));
      parts.push('');
    }

    if (checkpointBodies) {
      parts.push(`=== RECENT CHECKPOINTS — STRUCTURED INDEX (${count}) ===`);
      parts.push(checkpointBodies);
      parts.push('');
    }

    parts.push(
      'Consolidate the above into the MEMORY.md sections. The raw trajectory is authoritative — use it to verify, correct, and enrich the checkpoint summaries (which are lossy). Promote only durable, repeated, or explicitly-stated facts. Preserve all durable knowledge, remove duplicates, drop stale info.'
    );
    return parts.join('\n');
  }

  private enforceLimit(text: string, maxLines: number, maxBytes: number): string {
    let lines = text.split('\n');

    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    // Enforce line limit
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
    }

    // Enforce byte limit
    let result = lines.join('\n');
    if (Buffer.byteLength(result, 'utf-8') > maxBytes) {
      while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf-8') > maxBytes) {
        lines.pop();
      }
      result = lines.join('\n');
    }

    return result + '\n';
  }
}
