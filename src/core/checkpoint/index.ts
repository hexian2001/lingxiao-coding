/**
 * Checkpoint module — structured knowledge persistence across context compactions.
 */

export { CheckpointService } from './CheckpointService.js';
export { writeCheckpoint, resolveCheckpointPath, resolveNotesPath, validateSectionBudgets, SECTION_BUDGETS } from './CheckpointWriter.js';
export { evaluateBoundary, computeThresholds, messageId } from './CheckpointBoundary.js';
export { buildCheckpointSystemPrompt, buildCheckpointUserPrompt } from './CheckpointPrompt.js';
export { ContextRebuilder, smartTruncate, REBUILD_SECTION_BUDGETS } from './ContextRebuild.js';
export { microCompact, COMPACTABLE_TOOLS, COMPACT_PLACEHOLDER } from './MicroCompact.js';
export {
  CHECKPOINT_SECTIONS,
  type CheckpointSectionKey,
  type CheckpointWriterInput,
  type CheckpointWriteResult,
  type CheckpointServiceOptions,
  type CheckpointBoundaryResult,
} from './types.js';
