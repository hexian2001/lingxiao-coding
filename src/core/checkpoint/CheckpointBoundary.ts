/**
 * CheckpointBoundary — threshold calculation for checkpoint triggering.
 *
 * Determines whether a new checkpoint should be written based on:
 * - Minimum 5 messages with content since last watermark
 * - Dynamic token thresholds based on context window size (percentage-based)
 * - Looks backward through messages to find a 20,000 token window for the watermark
 */

import { contentToPlainText, type ChatMessage } from '../../llm/types.js';
import { countTokens } from '../../llm/token_counter.js';
import type { CheckpointBoundaryResult } from './types.js';

const MIN_MESSAGES = 5;
const WATERMARK_TOKEN_WINDOW = 20_000;

/** Reserved tokens for system prompt, tool definitions, etc. */
const RESERVED_TOKENS = 13_000;

/**
 * Compute dynamic checkpoint thresholds based on context window size.
 *
 * Returns an array of token counts at which checkpoints should fire.
 * The density of thresholds scales with window size:
 * - < 25K: disabled (empty array)
 * - 25K-200K: 20%, 40%, 60%, 80% of usable space
 * - 200K-500K: 10%, 20%, ..., 90% of usable space
 * - > 500K: 5%, 10%, ..., 90% of usable space
 */
export function computeThresholds(contextWindowSize: number): number[] {
  if (contextWindowSize < 25_000) {
    return [];
  }

  const usable = contextWindowSize - RESERVED_TOKENS;
  if (usable <= 0) return [];

  let percentages: number[];

  if (contextWindowSize <= 200_000) {
    // 25K-200K: 20%, 40%, 60%, 80%
    percentages = [0.2, 0.4, 0.6, 0.8];
  } else if (contextWindowSize <= 500_000) {
    // 200K-500K: 10%, 20%, ..., 90%
    percentages = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  } else {
    // > 500K: 5%, 10%, ..., 90%
    percentages = [];
    for (let p = 0.05; p <= 0.9; p += 0.05) {
      percentages.push(Math.round(p * 100) / 100);
    }
  }

  return percentages.map((p) => Math.round(usable * p));
}

/**
 * Assign a stable ID to a message for watermark tracking.
 * Uses index-based ID since ChatMessage doesn't have a native id field.
 */
export function messageId(index: number, msg: ChatMessage): string {
  const ts = msg.timestamp ? Math.floor(msg.timestamp) : 0;
  return `msg-${index}-${ts}`;
}

/**
 * Evaluate whether a checkpoint should be written.
 *
 * @param messages - Full message array from ContextManager
 * @param lastWatermarkId - The message ID from the previous checkpoint (null if first)
 * @param contextWindowSize - The model's context window size (used for dynamic thresholds)
 * @param thresholdsCrossed - Set of thresholds already fired (for dedup)
 */
export function evaluateBoundary(
  messages: ChatMessage[],
  lastWatermarkId: string | null,
  contextWindowSize?: number,
  thresholdsCrossed?: Set<number>,
): CheckpointBoundaryResult {
  const noCheckpoint: CheckpointBoundaryResult = {
    shouldCheckpoint: false,
    watermarkMessageId: lastWatermarkId || '',
    messageCount: 0,
    tokenEstimate: 0,
  };

  if (messages.length === 0) return noCheckpoint;

  // Find the start index: first message after the last watermark
  let startIndex = 0;
  if (lastWatermarkId) {
    for (let i = 0; i < messages.length; i++) {
      if (messageId(i, messages[i]) === lastWatermarkId) {
        startIndex = i + 1;
        break;
      }
    }
  }

  // Count messages with substantive content since the watermark
  let contentMessageCount = 0;
  let accumulatedTokens = 0;
  const contentIndices: number[] = [];

  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    const text = contentToPlainText(msg.content).trim();
    if (text.length > 0) {
      contentMessageCount++;
      accumulatedTokens += countTokens(text);
      contentIndices.push(i);
    }
  }

  // Message count gate
  if (contentMessageCount < MIN_MESSAGES) {
    return noCheckpoint;
  }

  // Dynamic threshold check
  const windowSize = contextWindowSize ?? 128_000; // Default fallback
  const thresholds = computeThresholds(windowSize);

  if (thresholds.length === 0) {
    // Context window too small, checkpointing disabled
    return noCheckpoint;
  }

  // Find which thresholds are newly crossed
  let newThresholdCrossed = false;
  for (const threshold of thresholds) {
    if (accumulatedTokens >= threshold) {
      if (!thresholdsCrossed || !thresholdsCrossed.has(threshold)) {
        newThresholdCrossed = true;
        break;
      }
    }
  }

  if (!newThresholdCrossed) {
    return noCheckpoint;
  }

  // Walk backward from the end to find the watermark position:
  // the point where the remaining window is ~20,000 tokens
  let watermarkIndex = messages.length - 1;
  let windowTokens = 0;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const text = contentToPlainText(messages[i].content).trim();
    const tokens = text.length > 0 ? countTokens(text) : 0;
    if (windowTokens + tokens > WATERMARK_TOKEN_WINDOW) {
      watermarkIndex = i;
      break;
    }
    windowTokens += tokens;
    watermarkIndex = i;
  }

  // The watermark is set at the end of the window we're checkpointing
  // (i.e., last message before the retained window)
  const effectiveWatermarkIndex = Math.max(startIndex, watermarkIndex - 1);
  const newWatermarkId = messageId(
    effectiveWatermarkIndex,
    messages[effectiveWatermarkIndex],
  );

  return {
    shouldCheckpoint: true,
    watermarkMessageId: newWatermarkId,
    messageCount: contentMessageCount,
    tokenEstimate: accumulatedTokens,
  };
}
