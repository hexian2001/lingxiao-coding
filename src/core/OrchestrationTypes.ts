export type OrchestrationNodeKind = 'plan' | 'contract' | 'implement' | 'evaluate' | 'repair' | 'reset' | 'generic';

export type OrchestrationVerdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';

export type OrchestrationAcceptanceStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';

export type OrchestrationSpeculativeSelectionPolicy = 'first_green' | 'fewest_changes' | 'fastest_tests';

export interface OrchestrationArtifactRef {
  path: string;
  label?: string;
  kind?: string;
}

export interface OrchestrationAcceptance {
  status: OrchestrationAcceptanceStatus;
  summary?: string;
  criteria?: string[];
  evidenceTaskIds?: string[];
  artifactRefs?: OrchestrationArtifactRef[];
  evaluatedAt?: number;
}

export interface OrchestrationContractBinding {
  /** Stable cross-worker contract surface, e.g. `POST /api/login` or `chat.message.api`. */
  surface: string;
  /** Expected contract version. When omitted, any live version for the surface satisfies the binding. */
  version?: number;
  /** Blackboard tag used to resolve the live contract node. */
  tag: string;
  /** Optional team request id expected to be acked before implementation can start. */
  requestId?: string;
  /** Whether this task must wait for a live blackboard contract before dispatch. */
  requireContract?: boolean;
  /** Whether this task must wait for the request ack loop to close before dispatch. */
  requireAck?: boolean;
}

export interface OrchestrationSpeculativeAlternative {
  id: string;
  label?: string;
  strategyPrompt?: string;
  workingDir?: string;
  writeScope?: string[];
  metadata?: Record<string, unknown>;
}

export interface OrchestrationSpeculationPolicy {
  enabled?: boolean;
  maxBranches?: number;
  timeoutMs?: number;
  selectionPolicy?: OrchestrationSpeculativeSelectionPolicy;
  alternatives?: OrchestrationSpeculativeAlternative[];
}

export type TaskReadiness = 'ready' | 'blocked' | 'running' | 'terminal';

export interface DAGNode {
  id: string;
  subject: string;
  status: string;
  exitReason?: string;
  displayState?: string;
  readiness: TaskReadiness;
  agentType: string;
  assignedAgent?: string;
  preferredAgentName?: string;
  blockedBy: string[];
  blocks: string[];
  blockedReason?: string;
  nextAction?: string;
  orchestration?: OrchestrationTaskMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface DAGEdge {
  from: string;
  to: string;
  type: 'blocks' | 'depends_on' | 'repair_of' | 'evidence_for';
}

export interface DAGSnapshot {
  sessionId: string;
  runId?: string;
  nodes: DAGNode[];
  edges: DAGEdge[];
  ready: string[];
  blocked: string[];
  running: string[];
  terminal: string[];
  criticalPath?: string[];
  updatedAt: number;
}

export interface RunExplanation {
  mode: 'manual' | 'eternal';
  state: 'working' | 'waiting_for_dependency' | 'waiting_for_user' | 'evaluating' | 'repairing' | 'blocked' | 'idle';
  reason: string;
  nextAction?: string;
  activeTaskIds?: string[];
  activeAgentNames?: string[];
  blockedTaskIds?: string[];
  since: number;
  confidence?: 'observed' | 'reported' | 'inferred';
}

export interface OrchestrationTaskMetadata {
  orchestrationRunId?: string;
  nodeKind?: OrchestrationNodeKind;
  generation?: number;
  stage?: string;
  verdict?: OrchestrationVerdict;
  contract?: unknown;
  contractBinding?: OrchestrationContractBinding;
  evaluationPolicy?: unknown;
  speculation?: OrchestrationSpeculationPolicy;
  acceptance?: OrchestrationAcceptance;
  blockedReason?: string;
  nextAction?: string;
  explainReason?: string;
  mainPathRank?: number;
  /** P2: 当前任务在 repair chain 中的修复次数 */
  repairCount?: number;
  /** P2: 是否已达到修复上限 */
  repairLimitReached?: boolean;
}
