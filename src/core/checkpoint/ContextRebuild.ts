/**
 * ContextRebuilder — Assembles structured recovery context after checkpoint overflow.
 *
 * When context overflows after a checkpoint has been written, this module reads
 * persisted knowledge sources and builds a single recovery system message with
 * token-budgeted sections, preserving continuity across context resets.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { countTokens } from '../../llm/token_counter.js';
import { resolveCheckpointPath, resolveNotesPath } from './CheckpointWriter.js';
import type { DatabaseManager, AgentState } from '../Database.js';

/** Token budget per section for recovery context rebuild. */
export const REBUILD_SECTION_BUDGETS = {
  tasks_ledger: 2_000,
  session_checkpoint: 11_000,
  active_actors: 500,
  project_memory: 10_000,
  global_memory: 6_000,
  session_notes: 6_000,
  memory_keys_index: 500,
} as const;

export type SectionName = keyof typeof REBUILD_SECTION_BUDGETS;

const CONTINUITY_FRAMING =
  'This session is being continued from a checkpoint. Key context has been preserved below.';

/** Options for building recovery context. */
export interface ContextRebuildOptions {
  workspace: string;
  sessionId: string;
  db?: DatabaseManager;
}

/**
 * Smart-truncate text to a token budget.
 * Respects ## headers: won't cut mid-section; trims from the end.
 */
export function smartTruncate(text: string, tokenBudget: number): string {
  if (!text) return '';
  const currentTokens = countTokens(text);
  if (currentTokens <= tokenBudget) return text;

  // Split on ## headers to preserve section boundaries
  const sections = text.split(/(?=^## )/m);

  let result = '';
  let usedTokens = 0;

  for (const section of sections) {
    const sectionTokens = countTokens(section);
    if (usedTokens + sectionTokens > tokenBudget) {
      // If this is the first section and it alone exceeds budget, hard-truncate it
      if (!result) {
        const chars = Math.max(1, Math.floor(tokenBudget * 3.5));
        return section.slice(0, chars) + '\n... (truncated to fit token budget)';
      }
      result += '\n... (remaining sections truncated to fit token budget)';
      break;
    }
    result += section;
    usedTokens += sectionTokens;
  }

  return result;
}

/**
 * Wrap a section's content in rebuild markers.
 */
function wrapSection(name: SectionName, content: string): string {
  if (!content.trim()) return '';
  return `<!-- REBUILD: ${name} -->\n${content.trim()}\n<!-- /REBUILD: ${name} -->\n`;
}

/**
 * Read a file safely, returning empty string on failure.
 */
function readFileSafe(filePath: string): string {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch {
    // Ignore read errors
  }
  return '';
}

/**
 * ContextRebuilder — builds recovery context from persisted sources.
 */
export class ContextRebuilder {
  private workspace: string;
  private sessionId: string;
  private db?: DatabaseManager;

  constructor(options: ContextRebuildOptions) {
    this.workspace = options.workspace;
    this.sessionId = options.sessionId;
    this.db = options.db;
  }

  /**
   * Assemble structured recovery context from all available sources.
   * Each section is read and truncated to its token budget.
   */
  buildRecoveryContext(): string {
    const sections: string[] = [CONTINUITY_FRAMING, ''];

    // 1. Tasks ledger
    const tasksContent = this.readTasksLedger();
    const tasksSection = wrapSection('tasks_ledger', smartTruncate(tasksContent, REBUILD_SECTION_BUDGETS.tasks_ledger));
    if (tasksSection) sections.push(tasksSection);

    // 2. Session checkpoint
    const checkpointContent = this.readSessionCheckpoint();
    const checkpointSection = wrapSection('session_checkpoint', smartTruncate(checkpointContent, REBUILD_SECTION_BUDGETS.session_checkpoint));
    if (checkpointSection) sections.push(checkpointSection);

    // 3. Active actors
    const actorsContent = this.readActiveActors();
    const actorsSection = wrapSection('active_actors', smartTruncate(actorsContent, REBUILD_SECTION_BUDGETS.active_actors));
    if (actorsSection) sections.push(actorsSection);

    // 4. Project memory
    const projectMemContent = this.readProjectMemory();
    const projectMemSection = wrapSection('project_memory', smartTruncate(projectMemContent, REBUILD_SECTION_BUDGETS.project_memory));
    if (projectMemSection) sections.push(projectMemSection);

    // 5. Global memory
    const globalMemContent = this.readGlobalMemory();
    const globalMemSection = wrapSection('global_memory', smartTruncate(globalMemContent, REBUILD_SECTION_BUDGETS.global_memory));
    if (globalMemSection) sections.push(globalMemSection);

    // 6. Session notes
    const notesContent = this.readSessionNotes();
    const notesSection = wrapSection('session_notes', smartTruncate(notesContent, REBUILD_SECTION_BUDGETS.session_notes));
    if (notesSection) sections.push(notesSection);

    // 7. Memory keys index
    const keysContent = this.readMemoryKeysIndex();
    const keysSection = wrapSection('memory_keys_index', smartTruncate(keysContent, REBUILD_SECTION_BUDGETS.memory_keys_index));
    if (keysSection) sections.push(keysSection);

    return sections.join('\n');
  }

  // ─── Source readers ───────────────────────────────────────────────────

  private readTasksLedger(): string {
    if (!this.db) return '';
    try {
      if (typeof this.db.getAgentStates !== 'function') return '';
      const agents: AgentState[] = this.db.getAgentStates(this.sessionId);
      const running = agents.filter(a => a.status === 'running' || !a.stopped);
      if (running.length === 0) return '';

      const lines = ['## Active Tasks', ''];
      for (const agent of running) {
        lines.push(`- [${agent.status}] ${agent.agent_name}: task=${agent.task_id || '(none)'}`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private readSessionCheckpoint(): string {
    const checkpointPath = resolveCheckpointPath(this.workspace, this.sessionId);
    return readFileSafe(checkpointPath);
  }

  private readActiveActors(): string {
    if (!this.db) return '';
    try {
      if (typeof this.db.getAgentStates !== 'function') return '';
      const agents: AgentState[] = this.db.getAgentStates(this.sessionId);
      const running = agents.filter(a => !a.stopped);
      if (running.length === 0) return '';

      const lines = ['## Running Subagents', ''];
      for (const agent of running) {
        lines.push(`- ${agent.agent_name} (${agent.agent_role}) [iter=${agent.iteration}]`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private readProjectMemory(): string {
    const memoryPath = join(this.workspace, '.lingxiao', 'memory', 'MEMORY.md');
    return readFileSafe(memoryPath);
  }

  private readGlobalMemory(): string {
    const globalPath = join(homedir(), '.lingxiao', 'memory', 'MEMORY.md');
    return readFileSafe(globalPath);
  }

  private readSessionNotes(): string {
    const notesPath = resolveNotesPath(this.workspace, this.sessionId);
    return readFileSafe(notesPath);
  }

  private readMemoryKeysIndex(): string {
    const memoryDir = join(this.workspace, '.lingxiao', 'memory');
    try {
      if (!existsSync(memoryDir)) return '';
      const files = readdirSync(memoryDir).filter(
        f => f.endsWith('.md') && f !== 'MEMORY.md',
      );
      if (files.length === 0) return '';

      const lines = ['## Memory Files', ''];
      for (const file of files) {
        const name = basename(file, '.md');
        // Try to extract first line as title
        const filePath = join(memoryDir, file);
        const content = readFileSafe(filePath);
        const firstLine = content.split('\n').find(l => l.trim().startsWith('#'));
        const title = firstLine ? firstLine.replace(/^#+\s*/, '').trim() : name;
        lines.push(`- ${name}: ${title}`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}
