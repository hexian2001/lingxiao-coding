/**
 * MemoryMaintenance — fire-and-forget mount for the dream/distill pipelines.
 *
 * Mirrors mimo's main-session step-1 auto-trigger: at session start we check
 * each pipeline's independent time gate (dream 7-day, distill 30-day) and, when
 * due, run it in the background without blocking the interactive loop. Both gates
 * are deterministic — a last-run timestamp compared against a fixed interval, no
 * heuristics. Errors are swallowed so maintenance never disrupts a session.
 */

import { coreLogger } from '../core/Log.js';
import { config as runtimeConfig } from '../config.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import { MemoryService } from './MemoryService.js';
import { AutoDreamTrigger } from './AutoDreamTrigger.js';
import { DreamCommand } from './DreamCommand.js';
import { DistillCommand } from './DistillCommand.js';
import { runMemoryGC } from './MemoryGC.js';
import { runWithMaintenanceEvents } from './MemoryMaintenanceEvents.js';

export interface MemoryMaintenanceOptions {
  workspace: string;
  projectId: string;
  /** Absolute path to the session database (DreamCommand verification source). */
  dbPath?: string;
  /**
   * Event bus for TUI/Web maintenance animation. When present, auto-runs emit
   * the same memory:maintenance_* lifecycle as manual /dream|/distill, so the
   * background pipelines surface in both UIs. sessionId scopes the events.
   */
  emitter?: EventEmitter;
  sessionId?: string;
}

/**
 * Run dream/distill if their independent gates are due. Fire-and-forget: returns
 * immediately, each pipeline runs in the background. Safe to call once per
 * main-session start. Intervals, lookback windows, and enable flags all come
 * from `config.memory.{dream,distill}` — no hardcoded cadence.
 */
export function runDueMemoryMaintenance(options: MemoryMaintenanceOptions): void {
  const { workspace, projectId, dbPath, emitter, sessionId } = options;
  const memCfg = runtimeConfig.memory;
  if (!memCfg.enabled) return;

  let service: MemoryService;
  let memoryRoot: string;
  try {
    service = new MemoryService({
      workspace,
      reconcileOnSearch: memCfg.reconcile_on_search,
      searchScoreFloor: memCfg.search_score_floor,
    });
    memoryRoot = service.getMemoryRoot();
  } catch (err) {
    coreLogger.warn(`[MemoryMaintenance] init failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (memCfg.dream.enabled) {
    const dreamTrigger = new AutoDreamTrigger(memoryRoot, memCfg.dream.auto_interval_days, 'dream_last_run.json');
    if (dreamTrigger.shouldTrigger()) {
      void (async () => {
        try {
          const dream = new DreamCommand(service, dbPath);
          const result = await runWithMaintenanceEvents(
            emitter, 'dream', sessionId,
            (reporter) => dream.execute({
              workspace,
              projectId,
              sessionLookbackDays: memCfg.dream.session_lookback_days,
              maxLines: memCfg.dream.max_lines,
              maxBytes: memCfg.dream.max_bytes,
              reporter,
            }),
            (r) => `整理 ${r.checkpointsProcessed} checkpoint → ${r.linesWritten} 行`,
          );
          dreamTrigger.markExecuted();
          coreLogger.info(`[MemoryMaintenance] dream done: ${result.checkpointsProcessed} checkpoints → ${result.linesWritten} lines`);
        } catch (err) {
          coreLogger.warn(`[MemoryMaintenance] dream failed: ${err instanceof Error ? err.message : err}`);
        }
      })();
    }
  }

  if (memCfg.distill.enabled) {
    const distillTrigger = new AutoDreamTrigger(memoryRoot, memCfg.distill.auto_interval_days, 'distill_last_run.json');
    if (distillTrigger.shouldTrigger()) {
      void (async () => {
        try {
          const distill = new DistillCommand(service, dbPath);
          const result = await runWithMaintenanceEvents(
            emitter, 'distill', sessionId,
            (reporter) => distill.execute({
              workspace,
              projectId,
              sessionLookbackDays: memCfg.distill.session_lookback_days,
              reporter,
            }),
            (r) => `提炼 ${r.created.length} 个资产`,
          );
          distillTrigger.markExecuted();
          coreLogger.info(`[MemoryMaintenance] distill done: ${result.created.length} assets created`);
        } catch (err) {
          coreLogger.warn(`[MemoryMaintenance] distill failed: ${err instanceof Error ? err.message : err}`);
        }
      })();
    }
  }

  // P2: GC pipeline — clean up expired memory entries
  if (memCfg.gc?.enabled) {
    const gcTrigger = new AutoDreamTrigger(memoryRoot, memCfg.gc.interval_days ?? 1, 'gc_last_run.json');
    if (gcTrigger.shouldTrigger()) {
      void (async () => {
        try {
          const gcResult = runMemoryGC({
            memoryRoot,
            dryRun: memCfg.gc.dry_run ?? false,
            maxDeletions: memCfg.gc.max_deletions ?? 50,
            protectedTypes: memCfg.gc.protected_types ?? ['user'],
          });
          gcTrigger.markExecuted();
          coreLogger.info(
            `[MemoryMaintenance] GC done: scanned=${gcResult.scanned}, expired=${gcResult.expired}, deleted=${gcResult.deleted}${gcResult.dryRun ? ' (dry run)' : ''}`,
          );
        } catch (err) {
          coreLogger.warn(`[MemoryMaintenance] GC failed: ${err instanceof Error ? err.message : err}`);
        }
      })();
    }
  }
}
