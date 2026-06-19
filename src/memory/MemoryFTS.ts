/**
 * MemoryFTS — FTS5 + BM25 memory search backed by node:sqlite.
 *
 * Strategy:
 * - Try FTS5 virtual table on init. If the engine supports it, use MATCH + bm25().
 * - If FTS5 is unavailable (old node builds), fall back to LIKE-based token matching.
 */

import { DatabaseSync } from 'node:sqlite';
import { cosineSimilarity } from './MemoryEmbedding.js';
import type { DatabaseSync as DatabaseType } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { coreLogger } from '../core/Log.js';
import type {
  MemoryFTSEntry,
  MemoryFTSScope,
  MemoryFTSType,
  MemorySearchResult,
  MemoryFTSSearchOptions,
} from './types.js';

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

function tokenize(query: string): string[] {
  return Array.from(query.matchAll(TOKEN_RE), (m) => m[0].toLowerCase());
}

export class MemoryFTS {
  private db: DatabaseType;
  private fts5Available = false;
  private dbPath: string;
  /** top_score * floorRatio = the relevance floor for trimming weak hits. */
  private floorRatio: number;

  constructor(dbPath: string, floorRatio = 0.15) {
    this.dbPath = dbPath;
    this.floorRatio = floorRatio;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initSchema();
  }

  private initSchema(): void {
    // Core table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entry (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        last_indexed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory_entry(scope, scope_id);
      CREATE INDEX IF NOT EXISTS memory_type_idx ON memory_entry(type);
    `);

    // Try FTS5
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          body,
          content='memory_entry',
          content_rowid='rowid'
        );
      `);
      // Triggers to keep FTS in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_entry BEGIN
          INSERT INTO memory_fts(rowid, body) VALUES (NEW.rowid, NEW.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_entry BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_entry BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, body) VALUES('delete', OLD.rowid, OLD.body);
          INSERT INTO memory_fts(rowid, body) VALUES (NEW.rowid, NEW.body);
        END;
      `);
      this.fts5Available = true;
    } catch {
      coreLogger.warn('[MemoryFTS] FTS5 not available, falling back to LIKE-based search');
      this.fts5Available = false;
    }
  }

  /** Upsert a memory entry. Returns true if body was actually updated. */
  upsert(entry: Omit<MemoryFTSEntry, 'id' | 'last_indexed_at'> & { id?: string }): boolean {
    const now = Date.now();
    const id = entry.id || randomUUID();

    // Check existing fingerprint
    const existing = this.db.prepare(
      'SELECT id, fingerprint FROM memory_entry WHERE path = ?',
    ).get(entry.path) as { id: string; fingerprint: string } | undefined;

    if (existing && existing.fingerprint === entry.fingerprint) {
      return false; // No change
    }

    if (existing) {
      this.db.prepare(`
        UPDATE memory_entry SET body = ?, scope = ?, scope_id = ?, type = ?, fingerprint = ?, last_indexed_at = ?
        WHERE id = ?
      `).run(entry.body, entry.scope, entry.scope_id, entry.type, entry.fingerprint, now, existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO memory_entry (id, path, scope, scope_id, type, body, fingerprint, last_indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, entry.path, entry.scope, entry.scope_id, entry.type, entry.body, entry.fingerprint, now);
    }
    return true;
  }

  /** Remove entries whose paths are no longer present. */
  prune(validPaths: Set<string>): number {
    const allRows = this.db.prepare('SELECT id, path FROM memory_entry').all() as Array<{ id: string; path: string }>;
    let removed = 0;
    for (const row of allRows) {
      if (!validPaths.has(row.path)) {
        this.db.prepare('DELETE FROM memory_entry WHERE id = ?').run(row.id);
        removed++;
      }
    }
    return removed;
  }

  /** Search memory entries using BM25 (FTS5) or LIKE fallback. */
  search(query: string, options: MemoryFTSSearchOptions = {}): MemorySearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const maxResults = options.maxResults ?? 10;

    if (this.fts5Available) {
      return this.searchFTS5(tokens, options, maxResults);
    }
    return this.searchLike(tokens, options, maxResults);
  }

  // P1: Hybrid search — combine BM25 (FTS) with vector cosine similarity

  /** Store an embedding vector for a memory entry. */
  storeEmbedding(path: string, vector: number[], model: string): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(
      `INSERT OR REPLACE INTO memory_embedding (path, embedding, model, dimensions, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(path, buf, model, vector.length, Date.now());
  }

  /** Retrieve embedding vector for a path. Returns null if not stored. */
  getEmbedding(path: string): number[] | null {
    const row = this.db.prepare(
      'SELECT embedding, dimensions FROM memory_embedding WHERE path = ?'
    ).get(path) as { embedding: Uint8Array; dimensions: number } | undefined;
    if (!row) return null;
    const floatArr = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions);
    return Array.from(floatArr);
  }

  /**
   * Hybrid search: combine FTS/BM25 results with vector cosine similarity.
   * @param query Query text
   * @param queryVector Optional pre-computed query embedding
   * @param options Search options
   * @param weights Fusion weights { fts, vector }
   */
  hybridSearch(
    query: string,
    queryVector: number[] | null,
    options: MemoryFTSSearchOptions = {},
    weights: { fts: number; vector: number } = { fts: 0.7, vector: 0.3 },
  ): MemorySearchResult[] {
    // Get FTS results first
    const ftsResults = this.search(query, options);
    if (ftsResults.length === 0 || !queryVector) return ftsResults;

    // Compute vector scores for each FTS result
    const scored = ftsResults.map((r) => {
      const entryVector = this.getEmbedding(r.path);
      const vectorScore = entryVector ? cosineSimilarity(queryVector, entryVector) : 0;
      const ftsScore = r.score;
      // Normalize FTS score to 0-1 range (rough normalization)
      const normalizedFts = Math.min(1, ftsScore / 10);
      // Weighted fusion
      const fusedScore = weights.fts * normalizedFts + weights.vector * vectorScore;
      return {
        ...r,
        score: fusedScore,
        ftsScore,
        vectorScore,
      };
    });

    // Re-sort by fused score
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private searchFTS5(tokens: string[], options: MemoryFTSSearchOptions, maxResults: number): MemorySearchResult[] {
    // Build FTS5 MATCH expression: "token1" OR "token2" OR ...
    const matchExpr = tokens.map((t) => `"${t}"`).join(' OR ');

    // Build WHERE clause for scope/type filtering
    const { clause, params } = this.buildFilterClause(options);

    const sql = `
      SELECT e.path, e.body, e.scope, e.scope_id, e.type, bm25(memory_fts) AS score
      FROM memory_fts f
      JOIN memory_entry e ON e.rowid = f.rowid
      WHERE memory_fts MATCH ?
      ${clause ? 'AND ' + clause : ''}
      ORDER BY score ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(matchExpr, ...params, maxResults * 2) as Array<{
      path: string; body: string; scope: string; scope_id: string; type: string; score: number;
    }>;

    if (rows.length === 0) return [];

    // BM25 returns negative scores (lower = better). Convert to positive.
    const results = rows.map((r) => ({
      path: r.path,
      snippet: this.extractSnippet(r.body, tokens),
      score: -r.score, // Flip sign so higher = better
      scope: r.scope as MemoryFTSScope,
      scope_id: r.scope_id,
      type: r.type as MemoryFTSType,
    }));

    // Apply score floor: top_score * 0.15. The best hit (index 0) is always
    // preserved even when an explicit scoreFloor is passed above topScore —
    // otherwise a caller-supplied floor could discard the single best match and
    // return nothing. This mirrors mimo's "keep #1" guarantee.
    const topScore = results[0]?.score ?? 0;
    const floor = options.scoreFloor ?? topScore * this.floorRatio;

    return results
      .filter((r, i) => i === 0 || r.score >= floor)
      .slice(0, maxResults);
  }

  private searchLike(tokens: string[], options: MemoryFTSSearchOptions, maxResults: number): MemorySearchResult[] {
    const { clause, params } = this.buildFilterClause(options);

    // Build LIKE conditions: at least one token must match
    const likeConditions = tokens.map(() => 'LOWER(e.body) LIKE ?').join(' OR ');
    const likeParams = tokens.map((t) => `%${t}%`);

    const whereClause = [
      `(${likeConditions})`,
      clause,
    ].filter(Boolean).join(' AND ');

    const sql = `
      SELECT e.path, e.body, e.scope, e.scope_id, e.type
      FROM memory_entry e
      WHERE ${whereClause}
    `;

    const rows = this.db.prepare(sql).all(...likeParams, ...params) as Array<{
      path: string; body: string; scope: string; scope_id: string; type: string;
    }>;

    // Score by token hit count
    const scored = rows.map((r) => {
      const bodyLower = r.body.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        const idx = bodyLower.indexOf(t);
        if (idx !== -1) score += 1;
        // Bonus for multiple occurrences
        let pos = idx;
        while (pos !== -1) {
          pos = bodyLower.indexOf(t, pos + 1);
          if (pos !== -1) score += 0.3;
        }
      }
      return {
        path: r.path,
        snippet: this.extractSnippet(r.body, tokens),
        score,
        scope: r.scope as MemoryFTSScope,
        scope_id: r.scope_id,
        type: r.type as MemoryFTSType,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    // Keep the best hit even under an explicit scoreFloor (see searchFTS5).
    const topScore = scored[0]?.score ?? 0;
    const floor = options.scoreFloor ?? topScore * this.floorRatio;

    return scored
      .filter((r, i) => i === 0 || r.score >= floor)
      .slice(0, maxResults);
  }

  private buildFilterClause(options: MemoryFTSSearchOptions): { clause: string; params: Array<string | number> } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.scopes && options.scopes.length > 0) {
      conditions.push(`e.scope IN (${options.scopes.map(() => '?').join(',')})`);
      params.push(...options.scopes);
    }
    if (options.scopeIds && options.scopeIds.length > 0) {
      conditions.push(`e.scope_id IN (${options.scopeIds.map(() => '?').join(',')})`);
      params.push(...options.scopeIds);
    }
    if (options.types && options.types.length > 0) {
      conditions.push(`e.type IN (${options.types.map(() => '?').join(',')})`);
      params.push(...options.types);
    }

    return { clause: conditions.join(' AND '), params };
  }

  private extractSnippet(body: string, tokens: string[], contextChars = 120): string {
    const bodyLower = body.toLowerCase();
    let bestPos = 0;
    let bestScore = 0;

    // Find position with most token density
    for (const token of tokens) {
      const idx = bodyLower.indexOf(token);
      if (idx === -1) continue;
      let windowScore = 0;
      for (const t of tokens) {
        const window = bodyLower.slice(Math.max(0, idx - contextChars), idx + contextChars);
        if (window.includes(t)) windowScore++;
      }
      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestPos = idx;
      }
    }

    const start = Math.max(0, bestPos - contextChars / 2);
    const end = Math.min(body.length, bestPos + contextChars);
    let snippet = body.slice(start, end).replace(/\n+/g, ' ').trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < body.length) snippet = snippet + '...';
    return snippet;
  }

  /** Get all indexed paths. */
  getAllPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM memory_entry').all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /** Get entries by scope. */
  getByScope(scope: MemoryFTSScope, scopeId?: string): MemoryFTSEntry[] {
    if (scopeId) {
      return this.db.prepare(
        'SELECT * FROM memory_entry WHERE scope = ? AND scope_id = ?',
      ).all(scope, scopeId) as unknown as MemoryFTSEntry[];
    }
    return this.db.prepare(
      'SELECT * FROM memory_entry WHERE scope = ?',
    ).all(scope) as unknown as MemoryFTSEntry[];
  }

  /** Get entries by type within a time range. */
  getByTypeAfter(type: MemoryFTSType, afterTimestamp: number): MemoryFTSEntry[] {
    return this.db.prepare(
      'SELECT * FROM memory_entry WHERE type = ? AND last_indexed_at > ?',
    ).all(type, afterTimestamp) as unknown as MemoryFTSEntry[];
  }

  /** Close the database connection. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore close errors
    }
  }

  /** Check if FTS5 is available. */
  isFTS5Available(): boolean {
    return this.fts5Available;
  }
}
