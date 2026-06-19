/**
 * AutoDreamTrigger — automatic trigger for /dream consolidation.
 *
 * Tracks when the last dream was executed and determines if enough time
 * has passed to trigger a new consolidation run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { coreLogger } from '../core/Log.js';

const DEFAULT_INTERVAL_DAYS = 7;

interface DreamLastRunData {
  lastRunAt: number;
}

export class AutoDreamTrigger {
  private filePath: string;
  private intervalMs: number;

  /**
   * @param memoryRoot  Path to the .lingxiao/memory directory
   * @param intervalDays  Number of days between automatic runs (default: 7)
   * @param fileName  Timestamp file name. Defaults to `dream_last_run.json`.
   *   Pass a distinct name (e.g. `distill_last_run.json`) to gate a separate
   *   pipeline on its own independent clock — mimo runs dream (7d) and distill
   *   (30d) on separate intervals, so each needs its own last-run marker.
   */
  constructor(memoryRoot: string, intervalDays?: number, fileName = 'dream_last_run.json') {
    this.filePath = join(memoryRoot, fileName);
    this.intervalMs = (intervalDays ?? DEFAULT_INTERVAL_DAYS) * 24 * 60 * 60 * 1000;
  }

  /**
   * Returns true if enough time has elapsed since the last dream execution
   * to warrant a new run.
   */
  shouldTrigger(): boolean {
    const lastRun = this.getLastRunTimestamp();
    if (lastRun === null) {
      // First run — never executed before
      return true;
    }
    return Date.now() - lastRun >= this.intervalMs;
  }

  /**
   * Mark the current time as the last execution timestamp.
   */
  markExecuted(): void {
    const data: DreamLastRunData = { lastRunAt: Date.now() };
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    coreLogger.info(`[AutoDreamTrigger] Marked dream execution at ${new Date().toISOString()}`);
  }

  /**
   * Read the last run timestamp from disk. Returns null if file is missing or invalid.
   */
  private getLastRunTimestamp(): number | null {
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as DreamLastRunData;
      if (typeof data.lastRunAt === 'number' && Number.isFinite(data.lastRunAt)) {
        return data.lastRunAt;
      }
      return null;
    } catch (err) {
      coreLogger.warn(`[AutoDreamTrigger] Failed to read ${this.filePath}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Expose the configured interval for testing/introspection. */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  /** Expose the file path for testing/introspection. */
  getFilePath(): string {
    return this.filePath;
  }
}
