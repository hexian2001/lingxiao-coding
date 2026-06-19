/**
 * AssetUsageStore — append-only ledger of when distilled assets (skills / agents /
 * commands) are actually consulted by the running system, plus the task outcomes
 * attributed to them.
 *
 * This is the feedback signal that turns distill from open-loop accumulation
 * ("write assets, hope they help") into closed-loop evolution ("refine the assets
 * that proved useful, because we observed them being used"). Every entry is a real,
 * observable event — an injection that happened, a spawn that happened, a task exit
 * verdict. No fabricated scores, no keyword heuristics. Aggregation is plain
 * counting; the LLM (in DistillCommand) does all semantic judgement over the counts.
 *
 * Storage: <workspace>/.lingxiao/memory/asset_usage.jsonl — one JSON object per line,
 * append-only. Append-only is concurrency-safe for the many writers (every agent
 * injects skills); aggregation happens on read, which is rare (distill runs on a
 * 30-day cycle). recordUsage is best-effort and never throws — usage tracking must
 * not be able to break an injection or a spawn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { coreLogger } from '../core/Log.js';

export type AssetUsageKind = 'skill_injected' | 'agent_spawned' | 'command_invoked';
export type TaskOutcome = 'success' | 'failure' | 'partial';

export interface AssetUsageEvent {
  /** form/name, e.g. skills/deploy-flow | agents/reviewer | commands/run-tests */
  assetRef: string;
  /** consultation kind; omitted on outcome-attribution events (which carry `outcome` instead) */
  kind?: AssetUsageKind;
  sessionId?: string;
  /** task the asset was consulted for / attributed to */
  taskId?: string;
  /** only set on outcome-attribution events (primarily agents, which map 1:1 to a task) */
  outcome?: TaskOutcome;
  /** epoch milliseconds */
  timestamp: number;
}

export interface AssetUsageStats {
  assetRef: string;
  /** consultation events (injected + spawned + invoked), excluding outcome attributions */
  uses: number;
  lastUsedAt: number;
  successCount: number;
  failureCount: number;
  partialCount: number;
}

const EMPTY_STATS = (assetRef: string): AssetUsageStats => ({
  assetRef,
  uses: 0,
  lastUsedAt: 0,
  successCount: 0,
  failureCount: 0,
  partialCount: 0,
});

export class AssetUsageStore {
  constructor(private readonly lingxiaoRoot: string) {}

  /** <workspace>/.lingxiao/memory/asset_usage.jsonl — same dir as MEMORY.md. */
  private logPath(): string {
    return join(this.lingxiaoRoot, 'memory', 'asset_usage.jsonl');
  }

  /**
   * Append a usage event. Best-effort: any IO error is logged and swallowed so a
   * failed ledger write can never break the injection/spawn that triggered it.
   */
  recordUsage(event: AssetUsageEvent): void {
    try {
      const path = this.logPath();
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      coreLogger.warn(`[AssetUsageStore] Failed to record usage for ${event.assetRef}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Read the whole ledger and aggregate per assetRef. Lines that fail to parse are
   * skipped (a corrupted line must not blank out the rest of the stats). Returns a
   * Map keyed by assetRef.
   */
  getUsageStats(): Map<string, AssetUsageStats> {
    const stats = new Map<string, AssetUsageStats>();
    const path = this.logPath();
    if (!existsSync(path)) {
      return stats;
    }

    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      coreLogger.warn(`[AssetUsageStore] Failed to read usage ledger: ${err instanceof Error ? err.message : err}`);
      return stats;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: AssetUsageEvent;
      try {
        event = JSON.parse(trimmed) as AssetUsageEvent;
      } catch {
        // skip corrupted line — never let one bad line wipe the aggregate
        continue;
      }
      if (!event || typeof event.assetRef !== 'string') continue;

      const entry = stats.get(event.assetRef) ?? EMPTY_STATS(event.assetRef);
      if (event.outcome) {
        if (event.outcome === 'success') entry.successCount += 1;
        else if (event.outcome === 'failure') entry.failureCount += 1;
        else if (event.outcome === 'partial') entry.partialCount += 1;
      } else {
        entry.uses += 1;
      }
      if (typeof event.timestamp === 'number' && event.timestamp > entry.lastUsedAt) {
        entry.lastUsedAt = event.timestamp;
      }
      stats.set(event.assetRef, entry);
    }

    return stats;
  }

  getStats(assetRef: string): AssetUsageStats | undefined {
    return this.getUsageStats().get(assetRef);
  }

  /** True iff this asset has at least one recorded consultation (the C overwrite-gate). */
  hasUsage(assetRef: string): boolean {
    const stats = this.getUsageStats().get(assetRef);
    return !!stats && stats.uses > 0;
  }
}
