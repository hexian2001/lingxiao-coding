import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { DatabaseManager } from './Database.js';

export type ExecutionTraceStatus = 'success' | 'failed' | 'blocked' | 'cancelled';

export interface ExecutionTraceRecord {
  id?: string;
  projectRoot: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  taskType?: string;
  status: ExecutionTraceStatus;
  durationMs?: number;
  filesChanged?: string[];
  errorSignature?: string;
  fixPattern?: string;
  verification?: unknown;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export interface ExecutionTraceEvent extends Required<Pick<ExecutionTraceRecord, 'projectRoot' | 'status'>> {
  id: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  taskType: string;
  durationMs: number;
  filesChanged: string[];
  errorSignature?: string;
  fixPattern?: string;
  verification?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface ProjectHotspot {
  file: string;
  attempts: number;
  failures: number;
  successes: number;
  failureRate: number;
  lastStatus: ExecutionTraceStatus;
  lastSeenAt: number;
}

export interface FixPatternSummary {
  errorSignature: string;
  fixPattern: string;
  count: number;
  files: string[];
  lastSeenAt: number;
}

export interface TimingBaseline {
  taskType: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
}

export interface TaskTypeSuccessRate {
  taskType: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
}

export interface ProjectExecutionModel {
  projectRoot: string;
  rebuiltAt: number;
  traceCount: number;
  hotspots: ProjectHotspot[];
  fixPatterns: FixPatternSummary[];
  timingBaselines: TimingBaseline[];
  taskTypeSuccessRates: TaskTypeSuccessRate[];
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {/* expected: fallback to default */
    return fallback;
  }
}

function normalizeProjectRoot(projectRoot: string): string {
  return resolve(projectRoot);
}

function uniqueStrings(values?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeFilePath(projectRoot: string, file: string): string {
  const trimmed = file.trim();
  if (!trimmed) return '';
  const normalized = isAbsolute(trimmed) ? relative(projectRoot, trimmed) : trimmed;
  return normalized.replace(/\\/g, '/');
}

function normalizeFilesChanged(projectRoot: string, files?: string[]): string[] {
  return uniqueStrings((files ?? []).map((file) => normalizeFilePath(projectRoot, file)));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function stableTaskType(value?: string): string {
  return value?.trim() || 'unknown';
}

function stableErrorSignature(value?: string): string | undefined {
  const firstLine = value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || undefined;
}

function mapEventRow(row: Record<string, unknown>): ExecutionTraceEvent {
  return {
    id: String(row.id),
    projectRoot: String(row.project_root),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    agentId: row.agent_id ? String(row.agent_id) : undefined,
    agentName: row.agent_name ? String(row.agent_name) : undefined,
    agentRole: row.agent_role ? String(row.agent_role) : undefined,
    taskType: stableTaskType(row.task_type ? String(row.task_type) : undefined),
    status: String(row.status) as ExecutionTraceStatus,
    durationMs: Number(row.duration_ms || 0),
    filesChanged: jsonParse<string[]>(row.files_changed, []),
    errorSignature: row.error_signature ? String(row.error_signature) : undefined,
    fixPattern: row.fix_pattern ? String(row.fix_pattern) : undefined,
    verification: jsonParse<unknown>(row.verification, undefined),
    metadata: jsonParse<Record<string, unknown> | undefined>(row.metadata, undefined),
    createdAt: Number(row.created_at || 0),
  };
}

export class ExecutionTraceMemory {
  constructor(private readonly db: DatabaseManager) {}

  recordTrace(input: ExecutionTraceRecord): ExecutionTraceEvent {
    const projectRoot = normalizeProjectRoot(input.projectRoot);
    const event: ExecutionTraceEvent = {
      id: input.id ?? randomUUID(),
      projectRoot,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentId: input.agentId,
      agentName: input.agentName,
      agentRole: input.agentRole,
      taskType: stableTaskType(input.taskType),
      status: input.status,
      durationMs: Math.max(0, Math.floor(input.durationMs ?? 0)),
      filesChanged: normalizeFilesChanged(projectRoot, input.filesChanged),
      errorSignature: stableErrorSignature(input.errorSignature),
      fixPattern: input.fixPattern?.trim() || undefined,
      verification: input.verification,
      metadata: input.metadata,
      createdAt: input.createdAt ?? Date.now() / 1000,
    };

    this.db.getDb().prepare(
      `INSERT INTO execution_trace_events (
        id, project_root, session_id, task_id, agent_id, agent_name, agent_role,
        task_type, status, duration_ms, files_changed, error_signature, fix_pattern,
        verification, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.projectRoot,
      event.sessionId ?? null,
      event.taskId ?? null,
      event.agentId ?? null,
      event.agentName ?? null,
      event.agentRole ?? null,
      event.taskType,
      event.status,
      event.durationMs,
      JSON.stringify(event.filesChanged),
      event.errorSignature ?? null,
      event.fixPattern ?? null,
      event.verification === undefined ? null : JSON.stringify(event.verification),
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
      event.createdAt,
    );
    return event;
  }

  listTraces(projectRoot: string, options: { limit?: number } = {}): ExecutionTraceEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    const rows = this.db.getDb().prepare(
      'SELECT * FROM execution_trace_events WHERE project_root = ? ORDER BY created_at ASC LIMIT ?',
    ).all(normalizeProjectRoot(projectRoot), limit) as Record<string, unknown>[];
    return rows.map(mapEventRow);
  }

  rebuildProjectModel(projectRoot: string): ProjectExecutionModel {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const events = this.listTraces(normalizedRoot, { limit: 10_000 });
    const rebuiltAt = Date.now() / 1000;
    const model: ProjectExecutionModel = {
      projectRoot: normalizedRoot,
      rebuiltAt,
      traceCount: events.length,
      hotspots: this.buildHotspots(events),
      fixPatterns: this.buildFixPatterns(events),
      timingBaselines: this.buildTimingBaselines(events),
      taskTypeSuccessRates: this.buildTaskTypeSuccessRates(events),
    };
    this.db.getDb().prepare(
      `INSERT INTO execution_project_models (project_root, model_json, rebuilt_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_root) DO UPDATE SET
         model_json = excluded.model_json,
         rebuilt_at = excluded.rebuilt_at`,
    ).run(normalizedRoot, JSON.stringify(model), rebuiltAt);
    return model;
  }

  getProjectModel(projectRoot: string): ProjectExecutionModel {
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const row = this.db.getDb().prepare(
      'SELECT model_json FROM execution_project_models WHERE project_root = ?',
    ).get(normalizedRoot) as { model_json?: string } | undefined;
    if (!row?.model_json) return this.rebuildProjectModel(normalizedRoot);
    const parsed = jsonParse<ProjectExecutionModel | null>(row.model_json, null);
    return parsed ?? this.rebuildProjectModel(normalizedRoot);
  }

  private buildHotspots(events: ExecutionTraceEvent[]): ProjectHotspot[] {
    const byFile = new Map<string, ProjectHotspot>();
    for (const event of events) {
      for (const file of event.filesChanged) {
        const current = byFile.get(file) ?? {
          file,
          attempts: 0,
          failures: 0,
          successes: 0,
          failureRate: 0,
          lastStatus: event.status,
          lastSeenAt: event.createdAt,
        };
        current.attempts += 1;
        if (event.status === 'success') current.successes += 1;
        if (event.status === 'failed') current.failures += 1;
        current.lastStatus = event.status;
        current.lastSeenAt = Math.max(current.lastSeenAt, event.createdAt);
        current.failureRate = roundRate(current.failures / current.attempts);
        byFile.set(file, current);
      }
    }
    return [...byFile.values()].sort((a, b) => b.failures - a.failures || b.attempts - a.attempts || a.file.localeCompare(b.file));
  }

  private buildFixPatterns(events: ExecutionTraceEvent[]): FixPatternSummary[] {
    const byPattern = new Map<string, FixPatternSummary>();
    for (const event of events) {
      if (!event.errorSignature || !event.fixPattern) continue;
      const key = `${event.errorSignature}\n${event.fixPattern}`;
      const current = byPattern.get(key) ?? {
        errorSignature: event.errorSignature,
        fixPattern: event.fixPattern,
        count: 0,
        files: [],
        lastSeenAt: event.createdAt,
      };
      current.count += 1;
      current.files = uniqueStrings([...current.files, ...event.filesChanged]);
      current.lastSeenAt = Math.max(current.lastSeenAt, event.createdAt);
      byPattern.set(key, current);
    }
    return [...byPattern.values()].sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt);
  }

  private buildTimingBaselines(events: ExecutionTraceEvent[]): TimingBaseline[] {
    const byType = new Map<string, number[]>();
    for (const event of events) {
      const list = byType.get(event.taskType) ?? [];
      list.push(event.durationMs);
      byType.set(event.taskType, list);
    }
    return [...byType.entries()].map(([taskType, durations]) => ({
      taskType,
      count: durations.length,
      avgMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p50Ms: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
    })).sort((a, b) => b.count - a.count || a.taskType.localeCompare(b.taskType));
  }

  private buildTaskTypeSuccessRates(events: ExecutionTraceEvent[]): TaskTypeSuccessRate[] {
    const byType = new Map<string, TaskTypeSuccessRate>();
    for (const event of events) {
      const current = byType.get(event.taskType) ?? {
        taskType: event.taskType,
        total: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
      };
      current.total += 1;
      if (event.status === 'success') current.successes += 1;
      if (event.status === 'failed') current.failures += 1;
      current.successRate = roundRate(current.successes / current.total);
      byType.set(event.taskType, current);
    }
    return [...byType.values()].sort((a, b) => b.total - a.total || a.taskType.localeCompare(b.taskType));
  }
}

export function extractProjectModelEvidence(model: ProjectExecutionModel, files: string[]): {
  hotspots: ProjectHotspot[];
  fixPatterns: FixPatternSummary[];
  timingBaselines: TimingBaseline[];
  taskTypeSuccessRates: TaskTypeSuccessRate[];
} {
  const fileSet = new Set(normalizeFilesChanged(model.projectRoot, files));
  const matchesScope = (file: string): boolean => {
    if (fileSet.size === 0) return true;
    for (const scope of fileSet) {
      const prefix = scope.replace(/\/+$/, '');
      if (file === prefix || file.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };
  const hotspots = model.hotspots.filter((hotspot) => matchesScope(hotspot.file)).slice(0, 8);
  const fixPatterns = model.fixPatterns.filter((pattern) => pattern.files.some((file) => matchesScope(file))).slice(0, 8);
  return {
    hotspots,
    fixPatterns,
    timingBaselines: model.timingBaselines.slice(0, 8),
    taskTypeSuccessRates: model.taskTypeSuccessRates.slice(0, 8),
  };
}
