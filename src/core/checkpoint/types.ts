/**
 * Checkpoint types and section definitions.
 *
 * A checkpoint is a structured 11-section markdown document that persists
 * conversation knowledge to disk, surviving context compactions.
 */

import type { ChatMessage } from '../../llm/types.js';

/**
 * The 11 canonical sections of a checkpoint document.
 * Order matters: this is the rendering order in checkpoint.md.
 */
export const CHECKPOINT_SECTIONS = [
  'S1 Active intent',
  'S2 Next concrete action',
  'S3 Directives (session)',
  'S4 Task tree',
  'S5 Current work',
  'S6 Files and code sections',
  'S7 Discovered knowledge',
  'S8 Errors and fixes',
  'S9 Live resources',
  'S10 Design decisions',
  'S11 Open notes',
] as const;

export type CheckpointSectionKey = typeof CHECKPOINT_SECTIONS[number];

/** Input context provided to the checkpoint writer LLM call. */
export interface CheckpointWriterInput {
  sessionId: string;
  messages: ChatMessage[];
  existingCheckpoint: string | null;
  existingNotes: string | null;
  watermarkMessageId: string;
}

/** Result from a checkpoint write operation. */
export interface CheckpointWriteResult {
  success: boolean;
  checkpointPath: string;
  watermarkMessageId: string;
  error?: string;
}

/** Options for CheckpointService. */
export interface CheckpointServiceOptions {
  /** Workspace root directory (project root). */
  workspace: string;
  /** Session ID. */
  sessionId: string;
}

/** Boundary calculation result. */
export interface CheckpointBoundaryResult {
  /** Whether the boundary condition is met. */
  shouldCheckpoint: boolean;
  /** The message ID that becomes the new watermark (last message in window). */
  watermarkMessageId: string;
  /** Number of messages with content since last watermark. */
  messageCount: number;
  /** Estimated token count of messages in the window. */
  tokenEstimate: number;
}
