import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { ProjectRetentionPolicy } from './ProjectRetentionPolicy.js';

export interface EternalRuntimeMetrics {
  projectId: string;
  projectCreated: number;
  projectPaused: number;
  projectResumed: number;
  projectBlocked: number;
  projectCompleted: number;
  repairCount: number;
  resetCount: number;
  replanCount: number;
  schedulerSwitchCount: number;
  staleResultRejected: number;
  blockedDurationMs: number;
  updatedAt: number;
}

export interface EternalAuditEntry {
  id: string;
  at: number;
  kind: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface EternalTrendSample {
  at: number;
  repairCount: number;
  resetCount: number;
  blockedDurationMs: number;
  staleResultRejected: number;
  schedulerSwitchCount: number;
}

export interface EternalTrendSummary {
  samples: number;
  latest?: EternalTrendSample;
  deltas: {
    repairs: number;
    resets: number;
    blockedDurationMs: number;
    staleRejected: number;
    schedulerSwitches: number;
  };
}

function createEmptyMetrics(projectId: string): EternalRuntimeMetrics {
  return {
    projectId,
    projectCreated: 0,
    projectPaused: 0,
    projectResumed: 0,
    projectBlocked: 0,
    projectCompleted: 0,
    repairCount: 0,
    resetCount: 0,
    replanCount: 0,
    schedulerSwitchCount: 0,
    staleResultRejected: 0,
    blockedDurationMs: 0,
    updatedAt: Date.now(),
  };
}

export class EternalRuntimeTelemetry {
  private projectsRoot: string;

  constructor(workspaceRoot: string) {
    this.projectsRoot = join(workspaceRoot, '.lingxiao', 'projects');
  }

  private metricsPath(projectId: string): string {
    return join(this.projectsRoot, projectId, 'metrics.json');
  }

  private auditPath(projectId: string): string {
    return join(this.projectsRoot, projectId, 'audit.json');
  }

  private trendsPath(projectId: string): string {
    return join(this.projectsRoot, projectId, 'trends.json');
  }

  loadMetrics(projectId: string): EternalRuntimeMetrics {
    const path = this.metricsPath(projectId);
    if (!existsSync(path)) {
      return createEmptyMetrics(projectId);
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as EternalRuntimeMetrics;
  }

  saveMetrics(metrics: EternalRuntimeMetrics): EternalRuntimeMetrics {
    const path = this.metricsPath(metrics.projectId);
    mkdirSync(dirname(path), { recursive: true });
    metrics.updatedAt = Date.now();
    writeFileSync(path, JSON.stringify(metrics, null, 2) + '\n', 'utf-8');
    return metrics;
  }

  increment(projectId: string, patch: Partial<Record<keyof EternalRuntimeMetrics, number>>): EternalRuntimeMetrics {
    const current = this.loadMetrics(projectId);
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'projectId' || key === 'updatedAt') continue;
      const typedKey = key as keyof EternalRuntimeMetrics;
      if (typeof value === 'number' && typeof current[typedKey] === 'number') {
        current[typedKey] = ((current[typedKey] as number) + value) as never;
      }
    }
    return this.saveMetrics(current);
  }

  loadAudit(projectId: string): EternalAuditEntry[] {
    const path = this.auditPath(projectId);
    if (!existsSync(path)) {
      return [];
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as EternalAuditEntry[];
  }

  recordAudit(projectId: string, entry: Omit<EternalAuditEntry, 'id' | 'at'> & Partial<Pick<EternalAuditEntry, 'id' | 'at'>>): EternalAuditEntry[] {
    const path = this.auditPath(projectId);
    mkdirSync(dirname(path), { recursive: true });
    const existing = this.loadAudit(projectId);
    const next: EternalAuditEntry = {
      id: entry.id || `${projectId}-${Date.now()}-${existing.length + 1}`,
      at: entry.at || Date.now(),
      kind: entry.kind,
      summary: entry.summary,
      details: entry.details,
    };
    const updated = [...existing, next].slice(-200);
    writeFileSync(path, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    return updated;
  }

  loadTrends(projectId: string): EternalTrendSample[] {
    const path = this.trendsPath(projectId);
    if (!existsSync(path)) {
      return [];
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as EternalTrendSample[];
  }

  recordTrendSample(projectId: string, at: number = Date.now()): EternalTrendSample[] {
    const path = this.trendsPath(projectId);
    mkdirSync(dirname(path), { recursive: true });
    const metrics = this.loadMetrics(projectId);
    const samples = this.loadTrends(projectId);
    const next: EternalTrendSample = {
      at,
      repairCount: metrics.repairCount,
      resetCount: metrics.resetCount,
      blockedDurationMs: metrics.blockedDurationMs,
      staleResultRejected: metrics.staleResultRejected,
      schedulerSwitchCount: metrics.schedulerSwitchCount,
    };
    const updated = [...samples, next].slice(-500);
    writeFileSync(path, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    return updated;
  }

  summarizeTrends(projectId: string): EternalTrendSummary {
    const samples = this.loadTrends(projectId);
    const first = samples[0];
    const latest = samples.at(-1);
    return {
      samples: samples.length,
      latest,
      deltas: {
        repairs: latest && first ? latest.repairCount - first.repairCount : 0,
        resets: latest && first ? latest.resetCount - first.resetCount : 0,
        blockedDurationMs: latest && first ? latest.blockedDurationMs - first.blockedDurationMs : 0,
        staleRejected: latest && first ? latest.staleResultRejected - first.staleResultRejected : 0,
        schedulerSwitches: latest && first ? latest.schedulerSwitchCount - first.schedulerSwitchCount : 0,
      },
    };
  }

  applyRetention(projectId: string): {
    state: string;
    compactedAuditEntries: number;
    compactedTrendSamples: number;
  } {
    const policy = new ProjectRetentionPolicy();
    const audit = this.loadAudit(projectId);
    const trends = this.loadTrends(projectId);
    const decision = policy.evaluate({
      archivedAt: Date.now(),
      transferCount: 0,
      auditCount: audit.length,
      trendSamples: trends.length,
    });

    let compactedAuditEntries = audit.length;
    let compactedTrendSamples = trends.length;
    if (decision.shouldCompactAudit) {
      const compactedAudit = audit.slice(-50);
      writeFileSync(this.auditPath(projectId), JSON.stringify(compactedAudit, null, 2) + '\n', 'utf-8');
      compactedAuditEntries = compactedAudit.length;
    }
    if (decision.shouldCompactTransfers) {
      const compactedTrends = trends.slice(-100);
      writeFileSync(this.trendsPath(projectId), JSON.stringify(compactedTrends, null, 2) + '\n', 'utf-8');
      compactedTrendSamples = compactedTrends.length;
    }
    return {
      state: decision.state,
      compactedAuditEntries,
      compactedTrendSamples,
    };
  }
}

export default EternalRuntimeTelemetry;
