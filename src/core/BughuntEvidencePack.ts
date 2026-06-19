import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Workspace } from './Workspace.js';
import type { BughuntEvidenceEvent } from './BughuntLedger.js';
import { DEFAULT_BUGHUNT_POLICY, type BughuntPolicy } from './BughuntPolicy.js';

export interface WriteBughuntEvidencePackInput {
  sessionId: string;
  workspace: string;
  event: Omit<BughuntEvidenceEvent, 'id' | 'created_at' | 'artifact_path'>;
  rawResult: string;
  policy?: BughuntPolicy;
}

export function writeBughuntEvidencePack(input: WriteBughuntEvidencePackInput): string {
  const paths = Workspace.getSessionArtifactPaths(input.sessionId, input.workspace);
  const findingLabel = input.event.finding_ids[0] || 'unlinked';
  const packDir = join(paths.sessionDir, 'bughunt', sanitizeSegment(findingLabel));
  mkdirSync(packDir, { recursive: true });

  const fileName = `${Date.now()}-${sanitizeSegment(input.event.task_id || 'event')}.md`;
  const artifactPath = join(packDir, fileName);
  writeFileSync(artifactPath, renderEvidencePack(input), 'utf-8');
  return artifactPath;
}

function renderEvidencePack(input: WriteBughuntEvidencePackInput): string {
  const event = input.event;
  return [
    `# Bughunt Evidence Event`,
    '',
    `- task_id: ${event.task_id || 'unknown'}`,
    `- agent_name: ${event.agent_name || 'unknown'}`,
    `- kind: ${event.kind}`,
    `- findings: ${event.finding_ids.join(', ') || 'none'}`,
    `- files: ${event.files.join(', ') || 'none'}`,
    `- commands: ${event.commands.join(' | ') || 'none'}`,
    `- exit_codes: ${event.exit_codes.join(', ') || 'none'}`,
    '',
    `## Summary`,
    '',
    event.summary,
    '',
    `## Evidence Lines`,
    '',
    ...(event.evidence.length > 0 ? event.evidence.map((line) => `- ${line}`) : ['none']),
    '',
    `## Raw Worker Result`,
    '',
    '```text',
    input.rawResult.slice(0, (input.policy || DEFAULT_BUGHUNT_POLICY).maxRawResultChars),
    '```',
    '',
  ].join('\n');
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'event';
}
