/**
 * Memory FTS type definitions.
 *
 * Scopes represent the isolation level of memory entries:
 * - global: cross-project user preferences
 * - project: project-specific knowledge
 * - session: per-session ephemeral data (checkpoints, notes, progress)
 */

export type MemoryFTSScope = 'global' | 'project' | 'session';

export type MemoryFTSType = 'memory' | 'checkpoint' | 'progress' | 'notes' | 'free';

export interface MemoryFTSEntry {
  id: string;
  path: string;
  scope: MemoryFTSScope;
  scope_id: string;
  type: MemoryFTSType;
  body: string;
  fingerprint: string;
  last_indexed_at: number;
  /** P1: Optional embedding vector for hybrid search */
  embedding?: number[];
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  score: number;
  scope: MemoryFTSScope;
  scope_id: string;
  type: MemoryFTSType;
  /** P1: FTS (BM25) component score, for hybrid search debugging */
  ftsScore?: number;
  /** P1: Vector cosine similarity component score, for hybrid search debugging */
  vectorScore?: number;
}

export interface MemoryFTSSearchOptions {
  scopes?: MemoryFTSScope[];
  scopeIds?: string[];
  types?: MemoryFTSType[];
  maxResults?: number;
  scoreFloor?: number;
}

/**
 * A single raw conversation turn pulled straight from the trajectory tables
 * (leader_conversation / agent_conversation). This is the source-of-truth signal
 * — user words, assistant output, tool calls — before any checkpoint compression.
 */
export interface TrajectoryTurn {
  sessionId: string;
  /** 'leader' for main-agent turns, otherwise the worker agent name. */
  agent: string;
  role: string;
  /** Plain-text rendering of message content (JSON content already flattened). */
  text: string;
  /** Compact one-line summary of each tool call (name + truncated input), if any. */
  toolCalls: string[];
  /** Unix seconds. */
  timestamp: number;
}

export interface DreamOptions {
  workspace: string;
  projectId: string;
  sessionLookbackDays?: number;
  maxLines?: number;
  maxBytes?: number;
  /** Optional progress sink for TUI/Web maintenance animation. */
  reporter?: MaintenanceReporter;
}

export interface DreamResult {
  updatedPath: string;
  sectionsConsolidated: number;
  linesWritten: number;
  checkpointsProcessed: number;
  verification?: {
    recentSessionCount: number;
    totalMessages: number;
    verified: boolean;
  };
}

// ─── Distill types ──────────────────────────────────────────────────────────

export type AssetForm = 'skill' | 'command' | 'agent' | 'skip';

export interface DistillAsset {
  form: AssetForm;
  name: string;
  path: string;
  content: string;
  status?: 'created' | 'skipped';
  reason?: string;
}

export interface DistillResult {
  created: DistillAsset[];
  skipped: string[];
  needsMoreEvidence: string[];
  considered: number;
  conflicts: string[];
  invalid: string[];
  materialStats?: {
    trajectoryTurns: number;
    checkpoints: number;
    progressEntries: number;
  };
}

export interface DistillOptions {
  workspace: string;
  projectId: string;
  sessionLookbackDays?: number;
  /**
   * When false (default), generated assets never overwrite an existing file.
   * Callers can opt in explicitly for controlled regeneration.
   */
  allowOverwrite?: boolean;
  /** Optional progress sink for TUI/Web maintenance animation. */
  reporter?: MaintenanceReporter;
}

/**
 * Progress sink for dream/distill so the command layer stays decoupled from the
 * EventEmitter. Callers (dispatcher/MemoryMaintenance) wrap emitter.emit. Each
 * pipeline stage reports a deterministic, monotonically increasing fraction
 * (0..1) — fixed per stage, never inferred — plus a human-readable detail.
 */
export interface MaintenanceReporter {
  progress(phase: string, fraction: number, detail: string): void;
}
