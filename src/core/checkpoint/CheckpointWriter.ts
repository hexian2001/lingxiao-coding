/**
 * CheckpointWriter — Lightweight LLM call that produces the 11-section checkpoint.
 *
 * NOT a full sub-agent process. It:
 * 1. Reads existing checkpoint.md (if any) and notes.md
 * 2. Analyzes messages since last watermark
 * 3. Produces updated 11-section markdown via a single LLM call
 * 4. Writes to .lingxiao/memory/sessions/<sessionId>/checkpoint.md
 * 5. Clears notes.md (resets to empty template)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { contentToPlainText, type ChatMessage } from '../../llm/types.js';
import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import { config as runtimeConfig } from '../../config.js';
import { coreLogger } from '../Log.js';
import { countTokens } from '../../llm/token_counter.js';
import { CHECKPOINT_SECTIONS } from './types.js';
import type { CheckpointWriterInput, CheckpointWriteResult } from './types.js';
import { buildCheckpointSystemPrompt, buildCheckpointUserPrompt } from './CheckpointPrompt.js';

/** Max characters of conversation text to feed to the writer LLM. */
const MAX_CONVERSATION_CHARS = 80_000;

/** Max tokens for the writer LLM response. */
const WRITER_MAX_TOKENS = 4_000;

/**
 * Per-section token budgets. If a section exceeds its budget by >50%, a warning is logged.
 */
export const SECTION_BUDGETS: Record<string, number> = {
  'S1 Active intent': 500,
  'S2 Next concrete action': 1000,
  'S3 Directives (session)': 800,
  'S4 Task tree': 1000,
  'S5 Current work': 2000,
  'S6 Files and code sections': 1500,
  'S7 Discovered knowledge': 2000,
  'S8 Errors and fixes': 1500,
  'S9 Live resources': 1000,
  'S10 Design decisions': 3000,
  'S11 Open notes': 800,
};

/**
 * Validate per-section token budgets in a checkpoint document.
 * Logs warnings for sections exceeding their budget by >50%.
 * Does NOT fail the write.
 */
export function validateSectionBudgets(checkpointContent: string): void {
  for (const section of CHECKPOINT_SECTIONS) {
    const budget = SECTION_BUDGETS[section];
    if (!budget) continue;

    // Extract section content between its header and the next section header (or EOF)
    const headerPattern = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    const headerMatch = headerPattern.exec(checkpointContent);
    if (!headerMatch) continue;

    const startPos = headerMatch.index + headerMatch[0].length;
    // Find the start of the next ## S<N> header
    const nextHeaderMatch = /^## S\d+/m.exec(checkpointContent.slice(startPos));
    const endPos = nextHeaderMatch ? startPos + nextHeaderMatch.index : checkpointContent.length;

    const sectionText = checkpointContent.slice(startPos, endPos).trim();
    if (!sectionText || sectionText === '(none)') continue;

    const tokenCount = countTokens(sectionText);
    const threshold = budget * 1.5;

    if (tokenCount > threshold) {
      coreLogger.warn(
        `[CheckpointWriter] Section "${section}" exceeds budget: ${tokenCount} tokens (budget=${budget}, threshold=${Math.round(threshold)})`,
      );
    }
  }
}

/**
 * Resolve the checkpoint file path for a session.
 */
export function resolveCheckpointPath(workspace: string, sessionId: string): string {
  return join(workspace, '.lingxiao', 'memory', 'sessions', sessionId, 'checkpoint.md');
}

/**
 * Resolve the notes file path for a session.
 */
export function resolveNotesPath(workspace: string, sessionId: string): string {
  return join(workspace, '.lingxiao', 'memory', 'sessions', sessionId, 'notes.md');
}

/**
 * Convert messages to a plain text representation for the LLM.
 */
function messagesToText(messages: ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const msg of messages) {
    const text = contentToPlainText(msg.content).trim();
    if (!text) continue;

    const roleLabel = msg.role === 'assistant' ? 'A' : msg.role === 'user' ? 'U' : msg.role.charAt(0).toUpperCase();
    const line = `[${roleLabel}] ${text}`;

    if (totalChars + line.length > maxChars) {
      lines.push(`... (truncated, ${messages.length} messages total)`);
      break;
    }

    lines.push(line);
    totalChars += line.length;
  }

  return lines.join('\n\n');
}

/**
 * Read an existing file or return null.
 */
function readFileOrNull(filePath: string): string | null {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Execute the checkpoint writer.
 *
 * Makes a single LLM call to produce the checkpoint document,
 * then writes it to disk and clears notes.md.
 */
export async function writeCheckpoint(
  input: CheckpointWriterInput,
  llmClient: ContentGenerator,
  workspace: string,
): Promise<CheckpointWriteResult> {
  const checkpointPath = resolveCheckpointPath(workspace, input.sessionId);
  const notesPath = resolveNotesPath(workspace, input.sessionId);

  try {
    // 1. Read existing checkpoint and notes
    const existingCheckpoint = input.existingCheckpoint ?? readFileOrNull(checkpointPath);
    const existingNotes = input.existingNotes ?? readFileOrNull(notesPath);

    // 2. Convert messages to text
    const conversationText = messagesToText(input.messages, MAX_CONVERSATION_CHARS);

    if (!conversationText.trim()) {
      return {
        success: false,
        checkpointPath,
        watermarkMessageId: input.watermarkMessageId,
        error: 'No conversation content to checkpoint',
      };
    }

    // 3. Build prompts and call LLM
    const systemPrompt = buildCheckpointSystemPrompt();
    const userPrompt = buildCheckpointUserPrompt(existingCheckpoint, existingNotes, conversationText);

    const model = runtimeConfig.llm?.agent_model || runtimeConfig.llm?.leader_model || 'default';

    const response = await llmClient.generateContent({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      model,
      maxTokens: WRITER_MAX_TOKENS,
      sampling: { temperature: 0.2 },
    });

    const checkpointContent = contentToPlainText(response.content).trim();

    if (!checkpointContent) {
      return {
        success: false,
        checkpointPath,
        watermarkMessageId: input.watermarkMessageId,
        error: 'LLM returned empty checkpoint content',
      };
    }

    // 3.5. Validate per-section token budgets (warn only, don't fail)
    validateSectionBudgets(checkpointContent);

    // 4. 原子写 checkpoint：先写 .tmp 再 rename（同文件系统上 rename 原子），
    //    崩溃在写中途不会原地损毁 checkpoint.md、丢失压缩前恢复态。
    const dir = dirname(checkpointPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const checkpointTmp = `${checkpointPath}.tmp`;
    writeFileSync(checkpointTmp, checkpointContent, 'utf-8');
    renameSync(checkpointTmp, checkpointPath);

    // 5. 原子清空 notes.md（同样 tmp+rename）
    const notesTmp = `${notesPath}.tmp`;
    writeFileSync(notesTmp, '# Session Notes\n\n(cleared after checkpoint)\n', 'utf-8');
    renameSync(notesTmp, notesPath);

    coreLogger.info(
      `[CheckpointWriter] Wrote checkpoint for session ${input.sessionId}, watermark=${input.watermarkMessageId}`,
    );

    return {
      success: true,
      checkpointPath,
      watermarkMessageId: input.watermarkMessageId,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    coreLogger.warn(`[CheckpointWriter] Failed to write checkpoint: ${msg}`);
    return {
      success: false,
      checkpointPath,
      watermarkMessageId: input.watermarkMessageId,
      error: msg,
    };
  }
}
