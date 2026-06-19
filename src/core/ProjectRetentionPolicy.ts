export type ProjectRetentionState = 'active' | 'archived' | 'retained' | 'compacted' | 'prunable';

export interface ProjectRetentionInput {
  completedAt?: number;
  archivedAt?: number;
  now?: number;
  transferCount: number;
  auditCount: number;
  trendSamples: number;
}

export interface ProjectRetentionDecision {
  state: ProjectRetentionState;
  shouldCompactTransfers: boolean;
  shouldCompactAudit: boolean;
  shouldPrune: boolean;
  reason: string;
}

export interface ProjectRetentionPolicyConfig {
  archiveAfterMs?: number;
  compactAfterMs?: number;
  pruneAfterMs?: number;
  maxTransfersBeforeCompact?: number;
  maxAuditEntriesBeforeCompact?: number;
  maxTrendSamplesBeforeCompact?: number;
}

const DEFAULTS: Required<ProjectRetentionPolicyConfig> = {
  archiveAfterMs: 24 * 60 * 60 * 1000,
  compactAfterMs: 7 * 24 * 60 * 60 * 1000,
  pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
  maxTransfersBeforeCompact: 50,
  maxAuditEntriesBeforeCompact: 200,
  maxTrendSamplesBeforeCompact: 500,
};

export class ProjectRetentionPolicy {
  readonly config: Required<ProjectRetentionPolicyConfig>;

  constructor(config: ProjectRetentionPolicyConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  evaluate(input: ProjectRetentionInput): ProjectRetentionDecision {
    const now = input.now ?? Date.now();
    if (input.completedAt === undefined && input.archivedAt === undefined) {
      return {
        state: 'active',
        shouldCompactTransfers: false,
        shouldCompactAudit: false,
        shouldPrune: false,
        reason: 'project_active',
      };
    }
    const referenceAt = input.archivedAt ?? input.completedAt!;
    const ageMs = now - referenceAt;
    const shouldCompact = ageMs >= this.config.compactAfterMs
      || input.transferCount >= this.config.maxTransfersBeforeCompact
      || input.auditCount >= this.config.maxAuditEntriesBeforeCompact
      || input.trendSamples >= this.config.maxTrendSamplesBeforeCompact;
    if (ageMs >= this.config.pruneAfterMs) {
      return {
        state: 'prunable',
        shouldCompactTransfers: true,
        shouldCompactAudit: true,
        shouldPrune: true,
        reason: 'retention_prune_due',
      };
    }
    if (shouldCompact) {
      return {
        state: 'compacted',
        shouldCompactTransfers: true,
        shouldCompactAudit: true,
        shouldPrune: false,
        reason: 'retention_compaction_due',
      };
    }
    if (ageMs >= this.config.archiveAfterMs) {
      return {
        state: 'archived',
        shouldCompactTransfers: false,
        shouldCompactAudit: false,
        shouldPrune: false,
        reason: 'retention_archive_due',
      };
    }
    return {
      state: 'retained',
      shouldCompactTransfers: false,
      shouldCompactAudit: false,
      shouldPrune: false,
      reason: 'retention_keep',
    };
  }
}

export default ProjectRetentionPolicy;
