/**
 * MemoryMaintenanceEvents — bridges dream/distill progress to the EventEmitter.
 *
 * Keeps the command layer (DreamCommand/DistillCommand) decoupled from the
 * event bus: commands only see a MaintenanceReporter (a `progress(...)` sink).
 * This module wraps a run with started/completed/failed lifecycle events and
 * builds the reporter that forwards progress as `memory:maintenance_progress`.
 *
 * Both the TUI status line and the Web overlay subscribe to these events; this
 * is the single emit point so the two surfaces stay in lockstep. Progress
 * fractions are fixed per pipeline stage (set in the commands) — no heuristics.
 */

import type { EventEmitter } from '../core/EventEmitter.js';
import type { MaintenanceReporter } from './types.js';

export type MaintenanceKind = 'dream' | 'distill';

/**
 * Run a dream/distill pipeline with lifecycle events. Emits started before
 * `fn`, completed (with a summary) on success, failed (with the error message)
 * on throw. `fn` receives a reporter that emits per-stage progress. Re-throws
 * so callers keep their existing error handling; the failed event is purely
 * for UI. sessionId scopes the events (manual: active session; auto: daemon).
 */
export async function runWithMaintenanceEvents<T>(
  emitter: EventEmitter | undefined,
  kind: MaintenanceKind,
  sessionId: string | undefined,
  fn: (reporter: MaintenanceReporter) => Promise<T>,
  summarize: (result: T) => string,
): Promise<T> {
  const reporter: MaintenanceReporter = {
    progress(phase, fraction, detail) {
      emitter?.emit('memory:maintenance_progress', {
        sessionId,
        kind,
        phase,
        progress: Math.max(0, Math.min(1, fraction)),
        detail,
      });
    },
  };

  emitter?.emit('memory:maintenance_started', { sessionId, kind });
  try {
    const result = await fn(reporter);
    emitter?.emit('memory:maintenance_completed', { sessionId, kind, summary: summarize(result) });
    return result;
  } catch (err) {
    emitter?.emit('memory:maintenance_failed', {
      sessionId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
