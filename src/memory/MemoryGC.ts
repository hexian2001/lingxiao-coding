/**
 * MemoryGC — Garbage collection for expired memory entries.
 *
 * Scans memory entries for TTL/expiresAt fields in frontmatter and removes
 * entries that have expired. Integrated into MemoryMaintenance time gate.
 *
 * Configuration via config.memory.gc:
 * - enabled: boolean (default false)
 * - dry_run: boolean (default false) — log expired entries without deleting
 * - max_deletions: number (default 50) — cap per GC run
 * - interval_days: number (default 1) — minimum days between GC runs
 * - protected_types: MemoryType[] (default ['user']) — never GC these types
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { coreLogger } from '../core/Log.js';

export interface MemoryGCOptions {
  /** Memory root directory to scan. */
  memoryRoot: string;
  /** Dry run mode: log but don't delete. Default false. */
  dryRun?: boolean;
  /** Maximum deletions per GC run. Default 50. */
  maxDeletions?: number;
  /** Memory types that should never be GC'd. Default ['user']. */
  protectedTypes?: string[];
  /** Optional progress reporter. */
  reporter?: (msg: string) => void;
}

export interface MemoryGCResult {
  scanned: number;
  expired: number;
  deleted: number;
  errors: number;
  dryRun: boolean;
}

/** Parse ISO 8601 duration string to milliseconds. Returns null if invalid. */
function parseIsoDuration(duration: string): number | null {
  const match = duration.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return null;
  const [, years, months, days, hours, minutes, seconds] = match;
  const ms =
    (parseInt(years || '0') * 365.25 * 24 * 60 * 60 * 1000) +
    (parseInt(months || '0') * 30.44 * 24 * 60 * 60 * 1000) +
    (parseInt(days || '0') * 24 * 60 * 60 * 1000) +
    (parseInt(hours || '0') * 60 * 60 * 1000) +
    (parseInt(minutes || '0') * 60 * 1000) +
    (parseFloat(seconds || '0') * 1000);
  return ms > 0 ? ms : null;
}

/** Parse frontmatter to extract ttl, expiresAt, createdAt, and type fields. */
function parseFrontmatterForExpiry(raw: string): {
  ttl?: string;
  expiresAt?: string;
  createdAt?: string;
  type?: string;
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return {};
  const fm = fmMatch[1];
  const result: { ttl?: string; expiresAt?: string; createdAt?: string; type?: string } = {};

  const ttlMatch = fm.match(/^ttl:\s*(.+)$/m);
  if (ttlMatch) result.ttl = ttlMatch[1].trim().replace(/^["']|["']$/g, '');

  const expiresMatch = fm.match(/^expiresAt:\s*(.+)$/m);
  if (expiresMatch) result.expiresAt = expiresMatch[1].trim().replace(/^["']|["']$/g, '');

  const createdMatch = fm.match(/^createdAt:\s*(.+)$/m);
  if (createdMatch) result.createdAt = createdMatch[1].trim().replace(/^["']|["']$/g, '');

  const typeMatch = fm.match(/^type:\s*(.+)$/m);
  if (typeMatch) result.type = typeMatch[1].trim().replace(/^["']|["']$/g, '');

  return result;
}

/** Check if a memory entry has expired based on its frontmatter. */
function isExpired(raw: string, now: Date): boolean {
  const meta = parseFrontmatterForExpiry(raw);

  // Check explicit expiresAt
  if (meta.expiresAt) {
    const expiresAt = new Date(meta.expiresAt);
    if (!isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
      return true;
    }
  }

  // Check TTL relative to createdAt
  if (meta.ttl && meta.createdAt) {
    const ttlMs = parseIsoDuration(meta.ttl);
    const createdAt = new Date(meta.createdAt);
    if (ttlMs !== null && !isNaN(createdAt.getTime())) {
      const expiresAt = createdAt.getTime() + ttlMs;
      if (expiresAt <= now.getTime()) {
        return true;
      }
    }
  }

  return false;
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

/**
 * Run garbage collection on expired memory entries.
 *
 * @param options GC options.
 * @returns GC result with scan/delete statistics.
 */
export function runMemoryGC(options: MemoryGCOptions): MemoryGCResult {
  const {
    memoryRoot,
    dryRun = false,
    maxDeletions = 50,
    protectedTypes = ['user'],
    reporter,
  } = options;

  const now = new Date();
  const files = walkMd(memoryRoot);
  let expired = 0;
  let deleted = 0;
  let errors = 0;

  reporter?.(`Scanning ${files.length} memory files for expired entries`);

  for (const filePath of files) {
    try {
      const raw = readFileSync(filePath, 'utf-8');

      // Skip if not expired
      if (!isExpired(raw, now)) continue;

      // Check protected type
      const meta = parseFrontmatterForExpiry(raw);
      if (meta.type && protectedTypes.includes(meta.type)) {
        coreLogger.info(`[MemoryGC] Skipping protected type "${meta.type}": ${filePath}`);
        continue;
      }

      expired++;

      if (expired > maxDeletions) {
        coreLogger.info(`[MemoryGC] Max deletions (${maxDeletions}) reached, stopping`);
        break;
      }

      if (dryRun) {
        coreLogger.info(`[MemoryGC] DRY RUN: would delete expired entry: ${filePath}`);
      } else {
        rmSync(filePath, { force: true });
        deleted++;
        coreLogger.info(`[MemoryGC] Deleted expired entry: ${filePath}`);
      }
    } catch (err) {
      errors++;
      coreLogger.warn(`[MemoryGC] Error processing ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  reporter?.(`GC complete: ${expired} expired, ${deleted} deleted${dryRun ? ' (dry run)' : ''}`);

  return {
    scanned: files.length,
    expired,
    deleted,
    errors,
    dryRun,
  };
}
