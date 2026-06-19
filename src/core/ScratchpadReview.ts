import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ChatMessage, ToolDefinition } from '../llm/types.js';
import { runStructuredJudgment, type JudgmentLlmGuardFactory } from './JudgmentService.js';
import { Workspace } from './Workspace.js';
import { getPromptCatalog, type PromptLocale } from '../agents/prompts/i18n/catalog.js';

export interface ScratchpadFollowUpFile {
  file: string;
  pendingItems: string[];
}

export interface ScratchpadFollowUpSummary {
  digest: string;
  report: string;
  files: ScratchpadFollowUpFile[];
}

export interface ScratchpadReviewInput {
  workspace: string;
  sessionId: string;
  llm?: ContentGenerator;
  model?: string;
  llmGuardFactory?: JudgmentLlmGuardFactory;
  locale?: PromptLocale;
}

interface ScratchpadDocument {
  file: string;
  content: string;
}

interface ScratchpadReviewVerdict {
  summary: ScratchpadFollowUpSummary | null;
}

function buildScratchpadReviewTool(locale?: PromptLocale): ToolDefinition {
  const catalog = getPromptCatalog(locale).judges.scratchpadReview;
  return {
    type: 'function',
    function: {
      name: 'submit_scratchpad_followup_review',
      description: catalog.toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          has_follow_ups: {
            type: 'boolean',
          },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                pendingItems: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['file', 'pendingItems'],
            },
          },
          report: {
            type: 'string',
          },
        },
        required: ['has_follow_ups', 'files', 'report'],
      },
    },
  };
}

function readScratchpadDocuments(workspace: string, sessionId: string): ScratchpadDocument[] {
  const scratchpadDir = Workspace.getScratchpadDir(sessionId, workspace);
  if (!existsSync(scratchpadDir)) {
    return [];
  }

  return readdirSync(scratchpadDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((file) => ({
      file,
      content: readFileSync(join(scratchpadDir, file), 'utf-8'),
    }));
}

function buildScratchpadSummary(files: ScratchpadFollowUpFile[], report?: string): ScratchpadFollowUpSummary | null {
  const normalized = files
    .map((entry) => ({
      file: entry.file,
      pendingItems: Array.from(new Set(entry.pendingItems.map((item) => item.trim()).filter(Boolean))),
    }))
    .filter((entry) => entry.pendingItems.length > 0)
    .sort((left, right) => left.file.localeCompare(right.file));

  if (normalized.length === 0) {
    return null;
  }

  const canonical = normalized
    .map((entry) => `${entry.file}:${entry.pendingItems.join(' | ')}`)
    .join('\n');
  const digest = createHash('sha1').update(canonical).digest('hex');
  const renderedReport = report?.trim() || [
    '检测到当前 session 的 scratchpad 中仍有未处理收尾项：',
    ...normalized.flatMap((entry) => [
      `- ${entry.file}`,
      ...entry.pendingItems.map((item) => `  - ${item}`),
    ]),
  ].join('\n');

  return {
    digest,
    report: renderedReport,
    files: normalized,
  };
}

function buildScratchpadReviewMessages(input: ScratchpadReviewInput, documents: ScratchpadDocument[]): ChatMessage[] {
  const catalog = getPromptCatalog(input.locale).judges.scratchpadReview;
  return [
    {
      role: 'system',
      content: catalog.system,
    },
    {
      role: 'user',
      content: [
        `session_id: ${input.sessionId}`,
        '',
        '[scratchpad_files]',
        ...documents.map((document) => [
          `## ${document.file}`,
          document.content.slice(0, 4000),
        ].join('\n')),
        '[/scratchpad_files]',
      ].join('\n\n'),
    },
  ];
}

function validateScratchpadReviewVerdict(parsed: unknown): ScratchpadReviewVerdict | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const hasFollowUps = 'has_follow_ups' in parsed ? parsed.has_follow_ups : undefined;
  const files = 'files' in parsed ? parsed.files : undefined;
  const report = 'report' in parsed ? parsed.report : undefined;
  if (typeof hasFollowUps !== 'boolean' || !Array.isArray(files) || typeof report !== 'string') {
    return null;
  }
  if (!hasFollowUps) {
    return { summary: null };
  }

  const normalizedFiles: ScratchpadFollowUpFile[] = files.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const file = 'file' in entry ? entry.file : undefined;
    const pendingItems = 'pendingItems' in entry ? entry.pendingItems : undefined;
    if (typeof file !== 'string' || !Array.isArray(pendingItems)) {
      return [];
    }
    const items = pendingItems.filter((item): item is string => typeof item === 'string');
    return [{ file, pendingItems: items }];
  });

  return { summary: buildScratchpadSummary(normalizedFiles, report) };
}

export async function collectScratchpadFollowUps(
  input: ScratchpadReviewInput,
): Promise<ScratchpadFollowUpSummary | null> {
  const documents = readScratchpadDocuments(input.workspace, input.sessionId);
  if (documents.length === 0) {
    return null;
  }

  const result = await runStructuredJudgment({
    kind: 'scratchpad_followup_review',
    llm: input.llm,
    model: input.model,
    messages: buildScratchpadReviewMessages(input, documents),
    tool: buildScratchpadReviewTool(input.locale),
    validate: validateScratchpadReviewVerdict,
    llmGuardFactory: input.llmGuardFactory,
    logger: console,
    gatewayContext: {
      actorType: 'leader',
      actorLabel: 'Leader-ScratchpadReview',
      purpose: 'review',
      sessionId: input.sessionId,
      requestedModel: input.model,
    },
  });

  if (result.status === 'ok') {
    return result.verdict?.summary ?? null;
  }
  return null;
}
