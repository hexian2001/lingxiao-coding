/**
 * CheckpointService — Trigger + dispatch + single-flight guard.
 *
 * Coordinates checkpoint writing:
 * - Evaluates boundary conditions (enough messages/tokens since last checkpoint)
 * - Maintains single-flight guard (only one writer per session at a time)
 * - Tracks watermark to avoid re-checkpointing same content
 * - Tracks which thresholds have fired (dedup)
 * - Stops after 3 consecutive failures
 * - On completion, updates watermark for next evaluation
 */

import type { ChatMessage } from '../../llm/types.js';
import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import { coreLogger } from '../Log.js';
import { evaluateBoundary, computeThresholds } from './CheckpointBoundary.js';
import { writeCheckpoint, resolveCheckpointPath, resolveNotesPath } from './CheckpointWriter.js';
import type { CheckpointServiceOptions, CheckpointWriteResult } from './types.js';

/** Maximum consecutive failures before disabling checkpoint writes. */
const MAX_CONSECUTIVE_FAILURES = 3;

export class CheckpointService {
  private workspace: string;
  private sessionId: string;
  private lastWatermarkId: string | null = null;
  private writing: Promise<CheckpointWriteResult> | null = null;
  private thresholdsCrossed: Set<number> = new Set();
  private consecutiveFailures: number = 0;

  constructor(options: CheckpointServiceOptions) {
    this.workspace = options.workspace;
    this.sessionId = options.sessionId;
  }

  /**
   * Attempt to start a checkpoint write.
   *
   * Returns immediately if:
   * - A write is already in progress (single-flight)
   * - Boundary conditions are not met
   * - Too many consecutive failures
   *
   * Otherwise spawns the writer and awaits the result.
   */
  async tryStart(
    messages: ChatMessage[],
    llmClient: ContentGenerator,
    contextWindowSize?: number,
  ): Promise<CheckpointWriteResult | null> {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      coreLogger.info(
        `[CheckpointService] Disabled: ${MAX_CONSECUTIVE_FAILURES} consecutive failures for session ${this.sessionId}`,
      );
      return null;
    }

    if (this.writing) {
      coreLogger.info(
        `[CheckpointService] Skipping: write already in progress for session ${this.sessionId}`,
      );
      return null;
    }

    const windowSize = contextWindowSize ?? 128_000;
    const boundary = evaluateBoundary(messages, this.lastWatermarkId, windowSize, this.thresholdsCrossed);

    if (!boundary.shouldCheckpoint) {
      return null;
    }

    // Mark newly crossed thresholds
    const thresholds = computeThresholds(windowSize);
    for (const threshold of thresholds) {
      if (boundary.tokenEstimate >= threshold) {
        this.thresholdsCrossed.add(threshold);
      }
    }

    coreLogger.info(
      `[CheckpointService] Boundary met for session ${this.sessionId}: ` +
      `${boundary.messageCount} messages, ~${boundary.tokenEstimate} tokens, ` +
      `${this.thresholdsCrossed.size}/${thresholds.length} thresholds crossed`,
    );

    this.writing = this.executeWrite(messages, llmClient, boundary.watermarkMessageId);

    try {
      const result = await this.writing;
      if (result.success) {
        this.lastWatermarkId = result.watermarkMessageId;
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        coreLogger.warn(
          `[CheckpointService] Write failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${result.error}`,
        );
      }
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      coreLogger.warn(
        `[CheckpointService] Write threw (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    } finally {
      this.writing = null;
    }
  }

  /**
   * Fire-and-forget variant: starts the checkpoint but doesn't block the caller.
   * Errors are logged but not propagated.
   */
  tryStartAsync(messages: ChatMessage[], llmClient: ContentGenerator, contextWindowSize?: number): void {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    if (this.writing) return;

    const windowSize = contextWindowSize ?? 128_000;
    const boundary = evaluateBoundary(messages, this.lastWatermarkId, windowSize, this.thresholdsCrossed);
    if (!boundary.shouldCheckpoint) return;

    // Mark newly crossed thresholds
    const thresholds = computeThresholds(windowSize);
    for (const threshold of thresholds) {
      if (boundary.tokenEstimate >= threshold) {
        this.thresholdsCrossed.add(threshold);
      }
    }

    coreLogger.info(
      `[CheckpointService] Async checkpoint triggered for session ${this.sessionId}`,
    );

    this.writing = this.executeWrite(messages, llmClient, boundary.watermarkMessageId);
    this.writing
      .then((result) => {
        if (result.success) {
          this.lastWatermarkId = result.watermarkMessageId;
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
        }
      })
      .catch((err) => {
        this.consecutiveFailures++;
        coreLogger.warn(
          `[CheckpointService] Async checkpoint failed: ${err instanceof Error ? err.message : err}`,
        );
      })
      .finally(() => {
        this.writing = null;
      });
  }

  /** Check if a write is currently in progress. */
  isWriting(): boolean {
    return this.writing !== null;
  }

  /** Get the last watermark message ID. */
  getLastWatermarkId(): string | null {
    return this.lastWatermarkId;
  }

  /** Get the set of thresholds that have already fired. */
  getThresholdsCrossed(): ReadonlySet<number> {
    return this.thresholdsCrossed;
  }

  /** Get the consecutive failure count. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Reset the watermark (e.g., after a hard context reset). */
  resetWatermark(): void {
    this.lastWatermarkId = null;
    this.thresholdsCrossed.clear();
    this.consecutiveFailures = 0;
  }

  /** Get the checkpoint file path for this session. */
  getCheckpointPath(): string {
    return resolveCheckpointPath(this.workspace, this.sessionId);
  }

  /** Get the notes file path for this session. */
  getNotesPath(): string {
    return resolveNotesPath(this.workspace, this.sessionId);
  }

  private async executeWrite(
    messages: ChatMessage[],
    llmClient: ContentGenerator,
    watermarkMessageId: string,
  ): Promise<CheckpointWriteResult> {
    // 关键：同步快照调用时刻的消息。writeCheckpoint 内部会在 LLM 生成期间异步遍历 messages，
    // 而调用方（ContextManager.manage）在 tryStart 返回后可能立即 addMessage / trim，
    // 写期间对活数组的并发修改会让 checkpoint 内容与 watermark 不一致。快照切断该竞态。
    const snapshot = messages.slice();
    return writeCheckpoint(
      {
        sessionId: this.sessionId,
        messages: snapshot,
        existingCheckpoint: null,
        existingNotes: null,
        watermarkMessageId,
      },
      llmClient,
      this.workspace,
    );
  }
}
