/**
 * MemoryService — Unified entry point for FTS-backed memory search.
 *
 * Manages lifecycle of MemoryFTS + MemoryReconciler, provides
 * high-level search and reconciliation APIs.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MemoryFTS } from './MemoryFTS.js';
import { MemoryReconciler, type ReconcileResult } from './MemoryReconciler.js';
import type { MemorySearchResult, MemoryFTSSearchOptions, MemoryFTSEntry } from './types.js';
import { coreLogger } from '../core/Log.js';

export interface MemoryServiceOptions {
  /** Workspace root (project directory). */
  workspace?: string;
  /**
   * Directly override the memory root that gets indexed. Takes precedence over
   * `workspace`. Use this for roots that are not `<workspace>/.lingxiao/memory`
   * (e.g. the user-level `~/.lingxiao/memory` directory, which IS the root).
   */
  memoryRoot?: string;
  /** Override for user-level memory directory. */
  userMemoryDir?: string;
  /** Override for the FTS database path. */
  dbPath?: string;
  /**
   * Whether search() reconciles the filesystem→index first. Default true,
   * matching mimo's reconcile-on-search. Reconciliation is fingerprint
   * (size+mtime) incremental, so unchanged files are skipped cheaply — there is
   * no time-based throttle, which would otherwise serve stale results inside its
   * window. Set false only when an external caller drives reconciliation.
   */
  reconcileOnSearch?: boolean;
  /**
   * Relevance floor ratio for BM25 search: hits scoring below
   * `topScore * searchScoreFloor` are trimmed (the #1 hit is always kept).
   * Defaults to 0.15, matching mimo. Wired from `config.memory.search_score_floor`.
   */
  searchScoreFloor?: number;
}

export class MemoryService {
  private fts: MemoryFTS | null = null;
  private reconciler: MemoryReconciler | null = null;
  private memoryRoot: string;
  private dbPath: string;
  private readonly reconcileOnSearch: boolean;
  private readonly searchScoreFloor: number;

  constructor(options: MemoryServiceOptions = {}) {
    const workspace = options.workspace || process.cwd();
    this.memoryRoot = options.memoryRoot || join(workspace, '.lingxiao', 'memory');
    // DB sits alongside the root it indexes so distinct roots get distinct indexes.
    this.dbPath = options.dbPath
      || (options.memoryRoot
        ? join(options.memoryRoot, 'memory_fts.sqlite')
        : join(workspace, '.lingxiao', 'memory_fts.sqlite'));
    this.reconcileOnSearch = options.reconcileOnSearch ?? true;
    this.searchScoreFloor = options.searchScoreFloor ?? 0.15;
  }

  /** Ensure FTS engine is initialized. */
  private ensureFTS(): MemoryFTS {
    if (!this.fts) {
      this.fts = new MemoryFTS(this.dbPath, this.searchScoreFloor);
      this.reconciler = new MemoryReconciler(this.memoryRoot, this.fts);
    }
    return this.fts;
  }

  /** Ensure reconciler is initialized. */
  private ensureReconciler(): MemoryReconciler {
    this.ensureFTS();
    return this.reconciler!;
  }

  /**
   * Search memory with FTS5/BM25.
   * Automatically reconciles if stale (cooldown-based).
   */
  search(query: string, options: MemoryFTSSearchOptions = {}): MemorySearchResult[] {
    this.ensureFTS();
    this.maybeReconcile();
    return this.fts!.search(query, options);
  }

  /**
   * Force a full reconciliation of the filesystem with the FTS index.
   */
  reconcile(): ReconcileResult {
    const reconciler = this.ensureReconciler();
    const result = reconciler.reconcile();
    coreLogger.info(`[MemoryService] Reconciled: scanned=${result.scanned} upserted=${result.upserted} pruned=${result.pruned}`);
    return result;
  }

  /**
   * Reconcile only a specific subdirectory.
   */
  reconcilePath(dirPath: string): ReconcileResult {
    const reconciler = this.ensureReconciler();
    return reconciler.reconcilePath(dirPath);
  }

  /**
   * Get entries by scope (for /dream to find session checkpoints).
   */
  getByScope(scope: 'global' | 'project' | 'session', scopeId?: string): MemoryFTSEntry[] {
    this.ensureFTS();
    this.maybeReconcile();
    return this.fts!.getByScope(scope, scopeId);
  }

  /**
   * Get checkpoint entries indexed after a given timestamp.
   */
  getRecentCheckpoints(afterTimestamp: number): MemoryFTSEntry[] {
    this.ensureFTS();
    this.maybeReconcile();
    return this.fts!.getByTypeAfter('checkpoint', afterTimestamp);
  }

  /**
   * Check FTS5 engine availability.
   */
  isFTS5Available(): boolean {
    return this.ensureFTS().isFTS5Available();
  }

  /**
   * Close the FTS database.
   */
  close(): void {
    if (this.fts) {
      this.fts.close();
      this.fts = null;
      this.reconciler = null;
    }
  }

  /** Memory root path getter. */
  getMemoryRoot(): string {
    return this.memoryRoot;
  }

  private maybeReconcile(): void {
    if (!this.reconcileOnSearch) return;
    try {
      this.ensureReconciler().reconcile();
    } catch (err) {
      coreLogger.warn(`[MemoryService] Auto-reconcile failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
