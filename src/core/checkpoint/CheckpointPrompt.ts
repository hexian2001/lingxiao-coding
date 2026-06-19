/**
 * CheckpointPrompt — LLM prompt for the checkpoint writer sub-agent.
 *
 * Instructs the LLM to extract conversation knowledge into the 11-section
 * structured checkpoint format, merging with any existing checkpoint content.
 */

import { CHECKPOINT_SECTIONS } from './types.js';

const SECTION_DESCRIPTIONS: Record<string, string> = {
  'S1 Active intent': 'The verbatim user request currently being worked on. Block-quote the exact user message.',
  'S2 Next concrete action': 'The single most concrete next step to take when resuming.',
  'S3 Directives (session)': 'Session-specific working style constraints the user has stated (e.g., "no emoji", "use Chinese comments").',
  'S4 Task tree': 'All tasks with states: open / in_progress / blocked / done / abandoned. Use indentation for subtasks.',
  'S5 Current work': 'What was actively being done when checkpoint triggered. Include file being edited, function name, etc.',
  'S6 Files and code sections': 'Files actively read or edited. Format: path + line range + brief purpose.',
  'S7 Discovered knowledge': 'Cross-task facts learned during this session. Candidates for MEMORY.md promotion.',
  'S8 Errors and fixes': 'Issues encountered and their resolutions. Include error messages and fix approach.',
  'S9 Live resources': 'Runtime state: git branch, running processes, ports, environment details.',
  'S10 Design decisions': 'Discussion outcomes that have no code artifact yet. Rationale for choices made.',
  'S11 Open notes': 'Catch-all for unresolved items, questions to revisit, loose ends.',
};

/** Per-section token budgets enforced by the writer validator. */
const SECTION_BUDGETS: Record<string, number> = {
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
 * Build the system prompt for the checkpoint writer LLM call.
 */
export function buildCheckpointSystemPrompt(): string {
  const sectionSpec = CHECKPOINT_SECTIONS.map(
    (s) => {
      const budget = SECTION_BUDGETS[s];
      const budgetNote = budget ? ` [budget: ~${budget} tokens]` : '';
      return `## ${s}${budgetNote}\n${SECTION_DESCRIPTIONS[s] || ''}`;
    },
  ).join('\n\n');

  return `You are a checkpoint writer. Your job is to extract and organize knowledge from a conversation into a structured 11-section checkpoint document.

RULES:
- Output ONLY the checkpoint markdown. No preamble, no explanation.
- Each section starts with "## S<N> <title>" exactly as specified.
- Keep each section concise: bullet points, file paths, key decisions.
- If a section has no relevant content, write "(none)" under it.
- Merge with existing checkpoint content — extend, don't overwrite. Remove stale entries that are clearly superseded.
- Total output must not exceed 3000 tokens.
- Each section has a token budget listed in brackets. Stay within budget; prioritize the most important information if space is tight.
- Use the same language as the conversation (Chinese if Chinese, English if English).

SECTION SPECIFICATION:

${sectionSpec}
`;
}

/**
 * Build the user prompt with the actual conversation content and existing checkpoint.
 */
export function buildCheckpointUserPrompt(
  existingCheckpoint: string | null,
  existingNotes: string | null,
  conversationText: string,
): string {
  const parts: string[] = [];

  if (existingCheckpoint) {
    parts.push(`<existing_checkpoint>\n${existingCheckpoint}\n</existing_checkpoint>`);
  }

  if (existingNotes) {
    parts.push(`<session_notes>\n${existingNotes}\n</session_notes>`);
  }

  parts.push(`<conversation>\n${conversationText}\n</conversation>`);

  parts.push('Write the updated checkpoint document now.');

  return parts.join('\n\n');
}
