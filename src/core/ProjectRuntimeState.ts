export const PROJECT_RUNTIME_SCHEMA_VERSION = 1;

export type ProjectRuntimeMode =
  | 'draft'
  | 'planning'
  | 'sprint_in_flight'
  | 'evaluating'
  | 'repairing'
  | 'waiting_for_dependency'
  | 'blocked_external'
  | 'recovering'
  | 'replanning'
  | 'idle'
  | 'completed'
  | 'archived';

export type ProjectBacklogItemStatus =
  | 'planned'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export type ProjectMilestoneStatus = 'pending' | 'at_risk' | 'completed' | 'missed';

export type ProjectRiskSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ProjectRiskStatus = 'open' | 'mitigated' | 'accepted' | 'closed';

export type ProjectDependencyType =
  | 'credential'
  | 'approval'
  | 'resource'
  | 'clarification'
  | 'integration'
  | 'other';

export type ProjectDependencyStatus = 'requested' | 'awaiting_input' | 'fulfilled' | 'failed';

export type ProjectScoreTrend = 'improving' | 'stable' | 'declining';

export interface ProjectSpecReference {
  specId: string;
  source: 'planner' | 'operator' | 'imported' | 'external' | 'unknown';
  path?: string;
  sessionId?: string;
  version?: string;
  summary?: string;
  updatedAt: number;
}

export interface ProjectBacklogItem {
  id: string;
  title: string;
  status: ProjectBacklogItemStatus;
  description?: string;
  sprintId?: string;
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  updatedAt: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ProjectMilestone {
  id: string;
  title: string;
  status: ProjectMilestoneStatus;
  targetAt?: number;
  completedAt?: number;
  notes?: string;
}

export interface ProjectRisk {
  id: string;
  summary: string;
  severity: ProjectRiskSeverity;
  status: ProjectRiskStatus;
  owner?: string;
  notes?: string;
  updatedAt: number;
}

export interface ProjectHealthMarkers {
  lastActionAt: number;
  lastSuccessfulActionAt?: number;
  consecutiveFailures: number;
  recoveryAttempts: number;
  evaluatorFailures: number;
  inactivitySince?: number;
  scoreTrend?: ProjectScoreTrend;
  note?: string;
}

export interface ProjectRuntimeState {
  mode: ProjectRuntimeMode;
  currentSprintId?: string;
  currentSprintIndex?: number;
  currentContractId?: string;
  blockedReason?: string;
  recoveryReason?: string;
  lastAction?: string;
  lastActionAt: number;
  health: ProjectHealthMarkers;
}

export interface ProjectDependencyEntry {
  dependencyId: string;
  type: ProjectDependencyType;
  status: ProjectDependencyStatus;
  summary: string;
  owner?: string;
  requestedAt: number;
  lastPingedAt?: number;
  fulfilledAt?: number;
  failedAt?: number;
  blockingTasks: string[];
  details?: Record<string, string | number | boolean | null>;
}

export interface DependencyLedger {
  updatedAt: number;
  entries: ProjectDependencyEntry[];
}

export interface ProjectDecisionEntry {
  id: string;
  sequence: number;
  at: number;
  actor: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  modeBefore?: ProjectRuntimeMode;
  modeAfter?: ProjectRuntimeMode;
  relatedDependencyId?: string;
  relatedSprintId?: string;
}

export interface DecisionLog {
  updatedAt: number;
  nextSequence: number;
  entries: ProjectDecisionEntry[];
}

export interface ProjectRuntimeRecord {
  schemaVersion: number;
  projectId: string;
  projectName: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  state: ProjectRuntimeState;
  specReference?: ProjectSpecReference;
  backlog: ProjectBacklogItem[];
  milestones: ProjectMilestone[];
  unresolvedRisks: ProjectRisk[];
  dependencyLedger: DependencyLedger;
  decisionLog: DecisionLog;
  metadata?: Record<string, unknown>;
}

export function createEmptyDependencyLedger(updatedAt: number): DependencyLedger {
  return {
    updatedAt,
    entries: [],
  };
}

export function createEmptyDecisionLog(updatedAt: number): DecisionLog {
  return {
    updatedAt,
    nextSequence: 1,
    entries: [],
  };
}

export function createDefaultProjectRuntimeState(
  updatedAt: number,
  mode: ProjectRuntimeMode = 'draft',
): ProjectRuntimeState {
  return {
    mode,
    lastActionAt: updatedAt,
    health: {
      lastActionAt: updatedAt,
      consecutiveFailures: 0,
      recoveryAttempts: 0,
      evaluatorFailures: 0,
    },
  };
}
