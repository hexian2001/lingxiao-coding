/**
 * MemoryReconciler — Syncs filesystem memory files with the FTS index.
 *
 * Walks all .md files under the memory root, computes fingerprints,
 * and upserts/prunes the FTS database accordingly.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { coreLogger } from '../core/Log.js';
import type { MemoryFTS } from './MemoryFTS.js';
import type { MemoryFTSScope, MemoryFTSType } from './types.js';

/** Compute fingerprint: "<size>-<mtimeMs>" */
function fingerprint(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    return `${stat.size}-${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Classify file type from its path. */
function classifyType(filePath: string): MemoryFTSType {
  const name = basename(filePath);
  const normalized = filePath.replace(/\\/g, '/');

  if (/^memory\.md$/i.test(name) || /memory-[\w.-]+\.md$/.test(name)) {
    return 'memory';
  }
  if (name === 'checkpoint.md' || /checkpoint-[\w.-]+\.md$/.test(name)) {
    return 'checkpoint';
  }
  if (/\/tasks\/[^/]+\/progress\.md$/.test(normalized)) {
    return 'progress';
  }
  if (name === 'notes.md') {
    return 'notes';
  }
  return 'free';
}

/** Derive scope and scope_id from file path relative to memory root. */
function deriveScope(relPath: string): { scope: MemoryFTSScope; scope_id: string } {
  const normalized = relPath.replace(/\\/g, '/');

  // sessions/<sessionId>/...
  const sessionMatch = normalized.match(/^sessions\/([^/]+)/);
  if (sessionMatch) {
    return { scope: 'session', scope_id: sessionMatch[1] };
  }

  // projects/<projectId>/...
  const projectMatch = normalized.match(/^projects\/([^/]+)/);
  if (projectMatch) {
    return { scope: 'project', scope_id: projectMatch[1] };
  }

  // global/...
  if (normalized.startsWith('global/')) {
    return { scope: 'global', scope_id: 'default' };
  }

  // Top-level files default to project scope
  return { scope: 'project', scope_id: 'default' };
}

/** Recursively collect all .md files under a directory. */
function walkMd(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMd(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

export interface ReconcileResult {
  scanned: number;
  upserted: number;
  pruned: number;
  errors: number;
}

export class MemoryReconciler {
  constructor(
    private readonly memoryRoot: string,
    private readonly fts: MemoryFTS,
  ) {}

  /**
   * Full reconciliation: scan filesystem, upsert changed files, prune removed ones.
   */
  reconcile(): ReconcileResult {
    const result: ReconcileResult = { scanned: 0, upserted: 0, pruned: 0, errors: 0 };

    if (!existsSync(this.memoryRoot)) {
      // Nothing to scan, prune everything
      const pruned = this.fts.prune(new Set());
      result.pruned = pruned;
      return result;
    }

    const files = walkMd(this.memoryRoot);
    result.scanned = files.length;

    const validPaths = new Set<string>();

    for (const filePath of files) {
      validPaths.add(filePath);
      try {
        const fp = fingerprint(filePath);
        if (!fp) continue;

        const relPath = relative(this.memoryRoot, filePath);
        const { scope, scope_id } = deriveScope(relPath);
        const type = classifyType(filePath);
        const body = readFileSync(filePath, 'utf-8');

        const updated = this.fts.upsert({
          path: filePath,
          scope,
          scope_id,
          type,
          body,
          fingerprint: fp,
        });

        if (updated) result.upserted++;
      } catch (err) {
        result.errors++;
        coreLogger.warn(`[MemoryReconciler] Error indexing ${filePath}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Prune entries for files that no longer exist
    result.pruned = this.fts.prune(validPaths);

    return result;
  }

  /**
   * Incremental reconciliation: only check files in a specific scope/path.
   */
  reconcilePath(dirPath: string): ReconcileResult {
    const result: ReconcileResult = { scanned: 0, upserted: 0, pruned: 0, errors: 0 };

    if (!existsSync(dirPath)) return result;

    const files = walkMd(dirPath);
    result.scanned = files.length;

    for (const filePath of files) {
      try {
        const fp = fingerprint(filePath);
        if (!fp) continue;

        const relPath = relative(this.memoryRoot, filePath);
        const { scope, scope_id } = deriveScope(relPath);
        const type = classifyType(filePath);
        const body = readFileSync(filePath, 'utf-8');

        const updated = this.fts.upsert({
          path: filePath,
          scope,
          scope_id,
          type,
          body,
          fingerprint: fp,
        });

        if (updated) result.upserted++;
      } catch (err) {
        result.errors++;
        coreLogger.warn(`[MemoryReconciler] Error indexing ${filePath}: ${err instanceof Error ? err.message : err}`);
      }
    }

    return result;
  }
}
