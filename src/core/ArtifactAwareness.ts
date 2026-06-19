import type { WorkerArtifactTrace, WorkerContractComplianceProof, WorkerVerificationItem } from './AgentProtocol.js';
import type { GraphNode } from './blackboard/types.js';
import type { TeamMessage } from './TeamMailbox.js';
import type { CollaborationMetadata } from './TeamProtocol.js';
import type { WorkNote } from './WorkNoteManager.js';

export interface ArtifactAwarenessInput {
  source?: string;
  taskId?: string;
  agentId?: string;
  summary?: string;
  result?: string;
  resultLabel?: string;
  artifacts?: WorkerArtifactTrace;
  toolTrace?: WorkerArtifactTrace;
  artifactPaths?: string[];
  evidenceRefs?: string[];
  contractCompliance?: WorkerContractComplianceProof;
  verification?: WorkerVerificationItem[];
  nextSteps?: string[];
  findings?: string[];
  blockers?: string[];
  impact?: string;
  verdict?: string;
  requestId?: string;
}

function uniqueStrings(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const item of group ?? []) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function mergeArtifactTrace(
  artifacts?: WorkerArtifactTrace,
  toolTrace?: WorkerArtifactTrace,
): Required<WorkerArtifactTrace> {
  const filesCreated = uniqueStrings(artifacts?.files_created, toolTrace?.files_created);
  const createdSet = new Set(filesCreated);
  const filesModified = uniqueStrings(artifacts?.files_modified, toolTrace?.files_modified)
    .filter((file) => !createdSet.has(file));
  return {
    files_created: filesCreated,
    files_modified: filesModified,
    commands_run: uniqueStrings(artifacts?.commands_run, toolTrace?.commands_run),
  };
}

function hasArtifactAwareness(input: ArtifactAwarenessInput): boolean {
  const merged = mergeArtifactTrace(input.artifacts, input.toolTrace);
  return merged.files_created.length > 0 ||
    merged.files_modified.length > 0 ||
    merged.commands_run.length > 0 ||
    (input.artifactPaths?.length ?? 0) > 0 ||
    (input.evidenceRefs?.length ?? 0) > 0 ||
    !!input.contractCompliance ||
    (input.verification?.length ?? 0) > 0 ||
    (input.nextSteps?.length ?? 0) > 0 ||
    (input.findings?.length ?? 0) > 0 ||
    (input.blockers?.length ?? 0) > 0 ||
    !!input.impact?.trim() ||
    !!input.verdict?.trim() ||
    !!input.requestId?.trim() ||
    !!input.source?.trim() ||
    !!input.taskId?.trim() ||
    !!input.agentId?.trim() ||
    !!input.summary?.trim();
}

export function buildArtifactAwarenessBlock(input: ArtifactAwarenessInput): string {
  if (!hasArtifactAwareness(input)) return input.result ?? '';

  const merged = mergeArtifactTrace(input.artifacts, input.toolTrace);
  const lines: string[] = ['### Cross-Agent Artifact Awareness'];
  if (input.source?.trim()) {
    lines.push(`source: ${input.source.trim()}`);
  }
  if (input.taskId?.trim()) {
    lines.push(`task: ${input.taskId.trim()}`);
  }
  if (input.agentId?.trim()) {
    lines.push(`agent: ${input.agentId.trim()}`);
  }
  if (input.summary?.trim()) {
    lines.push(`summary: ${input.summary.trim()}`);
  }
  if (input.verdict?.trim()) {
    lines.push(`verdict: ${input.verdict.trim()}`);
  }
  if (input.requestId?.trim()) {
    lines.push(`request_id: ${input.requestId.trim()}`);
  }
  if (input.impact?.trim()) {
    lines.push(`impact: ${input.impact.trim()}`);
  }
  if (input.artifactPaths?.length) {
    lines.push(`artifacts: ${uniqueStrings(input.artifactPaths).join(', ')}`);
  }
  if (input.evidenceRefs?.length) {
    lines.push(`evidence_refs: ${uniqueStrings(input.evidenceRefs).join(', ')}`);
  }
  if (input.contractCompliance) {
    lines.push(`contract_surface: ${input.contractCompliance.surface}`);
    lines.push(`contract_status: ${input.contractCompliance.status}`);
    if (input.contractCompliance.evidence.length > 0) {
      lines.push(`contract_evidence: ${input.contractCompliance.evidence.join(' | ')}`);
    }
    if (input.contractCompliance.deviations?.length) {
      lines.push(`contract_deviations: ${input.contractCompliance.deviations.join(' | ')}`);
    }
  }
  if (merged.files_created.length > 0) {
    lines.push(`files_created: ${merged.files_created.join(', ')}`);
  }
  if (merged.files_modified.length > 0) {
    lines.push(`files_modified: ${merged.files_modified.join(', ')}`);
  }
  if (merged.commands_run.length > 0) {
    lines.push(`commands_run: ${merged.commands_run.join(' | ')}`);
  }
  if (input.verification?.length) {
    lines.push('verification:');
    for (const item of input.verification) {
      const status = item.passed === false ? 'failed' : item.passed === true ? 'passed' : 'unknown';
      lines.push(`- [${status}] ${item.kind}: ${item.detail}`);
    }
  }
  if (input.nextSteps?.length) {
    lines.push(`next_steps: ${input.nextSteps.join(' | ')}`);
  }
  if (input.findings?.length) {
    lines.push(`findings: ${input.findings.join(' | ')}`);
  }
  if (input.blockers?.length) {
    lines.push(`blockers: ${input.blockers.join(' | ')}`);
  }

  const result = input.result?.trim();
  if (result) {
    lines.push('', `### ${input.resultLabel?.trim() || 'Worker Result'}`, result);
  }

  return lines.join('\n');
}

function artifactTraceFromPaths(paths?: string[]): WorkerArtifactTrace | undefined {
  const files = uniqueStrings(paths);
  return files.length > 0 ? { files_modified: files } : undefined;
}

export function buildWorkNoteAwarenessBlock(note: WorkNote, sourceAgentId = note.agentId): string {
  return buildArtifactAwarenessBlock({
    source: 'work_note',
    taskId: note.taskId,
    agentId: sourceAgentId,
    summary: note.summary,
    result: note.details,
    artifactPaths: note.artifacts,
    findings: note.keyFindings,
    blockers: note.blockers,
    nextSteps: note.nextSteps,
    impact: note.impactAnalysis,
    resultLabel: 'Work Note Details',
  });
}

export function metadataHasArtifactAwareness(metadata?: Partial<CollaborationMetadata> | null): boolean {
  if (!metadata) return false;
  return Boolean(
    metadata.intent && metadata.intent !== 'message' ||
    metadata.taskId ||
    metadata.sourceTaskId ||
    metadata.targetTaskId ||
    metadata.artifactPaths?.length ||
    metadata.evidenceRefs?.length ||
    metadata.verdict ||
    metadata.requestId ||
    metadata.nextAction,
  );
}

export function buildCollaborationAwarenessBlock(input: {
  from?: string;
  to?: string;
  content: string;
  metadata?: Partial<CollaborationMetadata> | null;
}): string {
  const metadata = input.metadata ?? {};
  if (!metadataHasArtifactAwareness(metadata)) {
    return '';
  }
  return buildArtifactAwarenessBlock({
    source: metadata.intent ? `team_message:${metadata.intent}` : 'team_message',
    taskId: metadata.taskId || metadata.sourceTaskId || metadata.targetTaskId,
    agentId: input.from,
    summary: metadata.summary || input.content,
    result: input.content,
    artifactPaths: metadata.artifactPaths,
    evidenceRefs: metadata.evidenceRefs,
    nextSteps: metadata.nextAction ? [metadata.nextAction] : undefined,
    verdict: metadata.verdict,
    requestId: metadata.requestId,
    resultLabel: 'Team Message',
  });
}

export function buildTeamMessageAwarenessBlock(message: TeamMessage): string {
  return buildCollaborationAwarenessBlock({
    from: message.fromMember,
    to: message.toMember ?? `team:${message.toTeam}`,
    content: message.content,
    metadata: message.metadata,
  });
}

export function buildBlackboardNodeAwarenessBlock(node: GraphNode): string {
  const artifactRefs = node.evidence
    ?.filter((item) => item.type === 'artifact' || item.type === 'file' || item.type === 'task_result' || item.type === 'tool_result')
    .map((item) => item.location ? `${item.ref}:${item.location}` : item.ref);
  const hasCrossAgentSignal =
    node.kind === 'contract' ||
    node.kind === 'design_doc' ||
    node.kind === 'goal' ||
    node.kind === 'review' ||
    node.kind === 'verdict' ||
    node.kind === 'decision_log' ||
    node.tags.some((tag) =>
      tag === 'task_result' ||
      tag === 'contract' ||
      tag === 'design_doc' ||
      tag === 'review' ||
      tag === 'decision' ||
      tag === 'verdict' ||
      tag.startsWith('task:') ||
      tag.startsWith('contract:'),
    ) ||
    (artifactRefs?.length ?? 0) > 0 ||
    (node.evidence?.length ?? 0) > 0;
  if (!hasCrossAgentSignal) {
    return '';
  }
  return buildArtifactAwarenessBlock({
    source: `blackboard:${node.kind}`,
    taskId: node.tags.find((tag) => tag.startsWith('task:'))?.slice('task:'.length),
    agentId: node.createdBy,
    summary: node.title,
    result: node.content,
    artifactPaths: artifactRefs,
    evidenceRefs: node.evidence?.map((item) => `${item.type}:${item.ref}`),
    resultLabel: 'Blackboard Node Content',
  });
}
