import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config as runtimeConfig } from '../config.js';
import type { DatabaseManager } from '../core/Database.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import { MemoryService } from './MemoryService.js';
import { AutoDreamTrigger } from './AutoDreamTrigger.js';
import { DreamCommand } from './DreamCommand.js';
import { DistillCommand } from './DistillCommand.js';
import { runWithMaintenanceEvents } from './MemoryMaintenanceEvents.js';
import type { DistillResult, DreamResult } from './types.js';

export interface MemoryAssetSummary {
  form: 'skill' | 'command' | 'agent';
  name: string;
  path: string;
  bytes: number;
  updatedAt: number;
}

export interface MaintenancePipelineSummary {
  kind: 'dream' | 'distill';
  enabled: boolean;
  autoIntervalDays: number;
  sessionLookbackDays: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  due: boolean;
}

export interface MemoryMaintenanceStatus {
  enabled: boolean;
  workspace: string;
  memoryRoot: string;
  memoryPath: string;
  memoryExists: boolean;
  memoryBytes: number;
  memoryLines: number;
  memoryUpdatedAt: number | null;
  checkpointsIndexed: number;
  assets: MemoryAssetSummary[];
  pipelines: {
    dream: MaintenancePipelineSummary;
    distill: MaintenancePipelineSummary;
  };
}

export type MemoryRunResult =
  | { success: true; kind: 'dream'; result: DreamResult; status: MemoryMaintenanceStatus }
  | { success: true; kind: 'distill'; result: DistillResult; status: MemoryMaintenanceStatus };

function readLastRun(memoryRoot: string, fileName: string): number | null {
  const filePath = join(memoryRoot, fileName);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as { lastRunAt?: unknown };
    return typeof data.lastRunAt === 'number' && Number.isFinite(data.lastRunAt) ? data.lastRunAt : null;
  } catch {
    return null;
  }
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      result.push(fullPath);
    }
  }
  return result;
}

function readAssets(workspace: string): MemoryAssetSummary[] {
  const lingxiaoRoot = join(workspace, '.lingxiao');
  const specs = [
    { form: 'skill' as const, dir: join(lingxiaoRoot, 'skills') },
    { form: 'command' as const, dir: join(lingxiaoRoot, 'commands') },
    { form: 'agent' as const, dir: join(lingxiaoRoot, 'agents') },
  ];
  const assets: MemoryAssetSummary[] = [];
  for (const spec of specs) {
    for (const filePath of listMarkdownFiles(spec.dir)) {
      const stats = statSync(filePath);
      const name = spec.form === 'skill'
        ? filePath.split('/skills/')[1]?.replace(/\/SKILL\.md$/, '') || filePath
        : filePath.split(`/${spec.form}s/`)[1]?.replace(/\.md$/, '') || filePath;
      assets.push({
        form: spec.form,
        name,
        path: filePath,
        bytes: stats.size,
        updatedAt: stats.mtimeMs,
      });
    }
  }
  return assets.sort((a, b) => b.updatedAt - a.updatedAt);
}

function pipelineSummary(
  memoryRoot: string,
  kind: 'dream' | 'distill',
): MaintenancePipelineSummary {
  const cfg = runtimeConfig.memory[kind];
  const fileName = kind === 'dream' ? 'dream_last_run.json' : 'distill_last_run.json';
  const lastRunAt = readLastRun(memoryRoot, fileName);
  const intervalMs = cfg.auto_interval_days * 24 * 60 * 60 * 1000;
  const nextRunAt = lastRunAt === null ? null : lastRunAt + intervalMs;
  const enabled = runtimeConfig.memory.enabled && cfg.enabled;
  const trigger = new AutoDreamTrigger(memoryRoot, cfg.auto_interval_days, fileName);
  return {
    kind,
    enabled,
    autoIntervalDays: cfg.auto_interval_days,
    sessionLookbackDays: cfg.session_lookback_days,
    lastRunAt,
    nextRunAt,
    due: enabled && trigger.shouldTrigger(),
  };
}

export function resolveMemoryWorkspace(db: DatabaseManager, currentSessionId: string | undefined, cwd: string): string {
  return currentSessionId ? (db.getSession(currentSessionId)?.workspace || cwd) : cwd;
}

export function buildMemoryMaintenanceStatus(workspace: string): MemoryMaintenanceStatus {
  const service = new MemoryService({
    workspace,
    reconcileOnSearch: runtimeConfig.memory.reconcile_on_search,
    searchScoreFloor: runtimeConfig.memory.search_score_floor,
  });
  try {
    const memoryRoot = service.getMemoryRoot();
    if (!existsSync(memoryRoot)) mkdirSync(memoryRoot, { recursive: true });
    const memoryPath = join(memoryRoot, 'MEMORY.md');
    const memoryExists = existsSync(memoryPath);
    const memoryText = memoryExists ? readFileSync(memoryPath, 'utf-8') : '';
    const memoryStats = memoryExists ? statSync(memoryPath) : null;
    let checkpointsIndexed = 0;
    try {
      checkpointsIndexed = service.getByScope('session').filter((entry) => entry.type === 'checkpoint').length;
    } catch {
      checkpointsIndexed = 0;
    }
    return {
      enabled: runtimeConfig.memory.enabled,
      workspace,
      memoryRoot,
      memoryPath,
      memoryExists,
      memoryBytes: memoryStats?.size ?? 0,
      memoryLines: memoryText ? memoryText.split('\n').length : 0,
      memoryUpdatedAt: memoryStats?.mtimeMs ?? null,
      checkpointsIndexed,
      assets: readAssets(workspace),
      pipelines: {
        dream: pipelineSummary(memoryRoot, 'dream'),
        distill: pipelineSummary(memoryRoot, 'distill'),
      },
    };
  } finally {
    service.close();
  }
}

export async function runMemoryMaintenancePipeline(options: {
  kind: 'dream' | 'distill';
  workspace: string;
  projectId: string;
  dbPath?: string;
  emitter?: EventEmitter;
  sessionId?: string;
  sessionLookbackDays?: number;
  allowOverwrite?: boolean;
}): Promise<MemoryRunResult> {
  const service = new MemoryService({
    workspace: options.workspace,
    reconcileOnSearch: runtimeConfig.memory.reconcile_on_search,
    searchScoreFloor: runtimeConfig.memory.search_score_floor,
  });
  try {
    if (options.kind === 'dream') {
      const cfg = runtimeConfig.memory.dream;
      const dream = new DreamCommand(service, options.dbPath);
      const result = await runWithMaintenanceEvents(
        options.emitter,
        'dream',
        options.sessionId,
        (reporter) => dream.execute({
          workspace: options.workspace,
          projectId: options.projectId,
          sessionLookbackDays: options.sessionLookbackDays ?? cfg.session_lookback_days,
          maxLines: cfg.max_lines,
          maxBytes: cfg.max_bytes,
          reporter,
        }),
        (r) => `整理 ${r.checkpointsProcessed} checkpoint -> ${r.sectionsConsolidated} 章节 / ${r.linesWritten} 行`,
      );
      new AutoDreamTrigger(service.getMemoryRoot(), cfg.auto_interval_days, 'dream_last_run.json').markExecuted();
      return { success: true, kind: 'dream', result, status: buildMemoryMaintenanceStatus(options.workspace) };
    }

    const cfg = runtimeConfig.memory.distill;
    const distill = new DistillCommand(service, options.dbPath);
    const result = await runWithMaintenanceEvents(
      options.emitter,
      'distill',
      options.sessionId,
      (reporter) => distill.execute({
        workspace: options.workspace,
        projectId: options.projectId,
        sessionLookbackDays: options.sessionLookbackDays ?? cfg.session_lookback_days,
        allowOverwrite: options.allowOverwrite,
        reporter,
      }),
      (r) => `提炼 ${r.created.length} 个资产`,
    );
    new AutoDreamTrigger(service.getMemoryRoot(), cfg.auto_interval_days, 'distill_last_run.json').markExecuted();
    return { success: true, kind: 'distill', result, status: buildMemoryMaintenanceStatus(options.workspace) };
  } finally {
    service.close();
  }
}

export function currentMemoryProjectId(sessionManager: SessionManager, sessionId?: string): string {
  return sessionId && sessionManager.getSession(sessionId) ? sessionId : (sessionId || 'default');
}
