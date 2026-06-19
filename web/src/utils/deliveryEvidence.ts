import type { AgentConversation, AgentMessage, Message } from '../stores/sessionStoreTypes';
import type { EvidenceReference } from './evidenceReferences';

export type DeliveryEvidenceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type DeliveryEvidenceSource =
  | 'task_result'
  | 'agent_completion'
  | 'tool_trace'
  | 'message_evidence'
  | 'artifact_store';

export interface DeliveryEvidenceArtifactRef {
  path?: string;
  url?: string;
  label?: string;
  kind?: string;
}

export interface DeliveryEvidenceVerification {
  kind: string;
  detail: string;
  passed: boolean;
}

export interface DeliveryEvidenceViewModel {
  id: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  agentName?: string;
  status: DeliveryEvidenceStatus;
  title: string;
  summary?: string;
  filesCreated: string[];
  filesModified: string[];
  commandsRun: string[];
  verification: DeliveryEvidenceVerification[];
  artifactRefs: DeliveryEvidenceArtifactRef[];
  evidenceRefs: string[];
  risks: string[];
  nextAction?: string;
  rawSources: DeliveryEvidenceSource[];
  updatedAt?: number;
}

interface CompletionPayload {
  summary?: string;
  artifacts?: {
    files_created?: string[];
    files_modified?: string[];
    commands_run?: string[];
  };
  toolTrace?: {
    files_created?: string[];
    files_modified?: string[];
    commands_run?: string[];
  };
  verification?: Array<{ kind?: string; detail?: string; passed?: boolean }>;
  evidence_refs?: string[];
  next_steps?: string[];
  result?: string;
  rendered?: string;
}

export interface BuildDeliveryEvidenceInput {
  sessionId?: string | null;
  messages: Message[];
  agentConversations: Record<string, AgentConversation>;
  evidenceReferences?: EvidenceReference[];
  limit?: number;
}

function uniqueStrings(...lists: Array<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    const values = Array.isArray(list) ? list : [];
    for (const item of values) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function coerceTrace(value: unknown): CompletionPayload['artifacts'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const trace = {
    files_created: uniqueStrings(record.files_created),
    files_modified: uniqueStrings(record.files_modified),
    commands_run: uniqueStrings(record.commands_run),
  };
  return trace.files_created.length || trace.files_modified.length || trace.commands_run.length ? trace : undefined;
}

function coerceVerification(value: unknown): DeliveryEvidenceVerification[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const kind = typeof record.kind === 'string' && record.kind.trim() ? record.kind.trim() : 'other';
    const detail = typeof record.detail === 'string' && record.detail.trim() ? record.detail.trim() : '';
    if (!detail) return [];
    return [{ kind, detail, passed: record.passed !== false }];
  });
}

function coerceCompletionPayload(value: unknown): CompletionPayload | null {
  let record = asRecord(value);
  if (!record) return null;

  const data = asRecord(record.data);
  if (data && ('summary' in data || 'artifacts' in data || 'verification' in data || 'evidence_refs' in data || 'toolTrace' in data)) {
    record = data;
  }

  const artifacts = coerceTrace(record.artifacts);
  const toolTrace = coerceTrace(record.toolTrace);
  const verification = coerceVerification(record.verification);
  const evidenceRefs = uniqueStrings(record.evidence_refs);
  const nextSteps = uniqueStrings(record.next_steps);
  const summary = typeof record.summary === 'string' ? record.summary.trim() : undefined;
  const result = typeof record.result === 'string' ? record.result.trim() : undefined;
  const rendered = typeof record.rendered === 'string' ? record.rendered.trim() : undefined;

  if (!summary && !artifacts && !toolTrace && verification.length === 0 && evidenceRefs.length === 0 && !result && !rendered) {
    return null;
  }

  return {
    summary,
    artifacts,
    toolTrace,
    verification,
    evidence_refs: evidenceRefs,
    next_steps: nextSteps,
    result,
    rendered,
  };
}

function mergePayloads(input: CompletionPayload | null, result: CompletionPayload | null): CompletionPayload | null {
  if (!input) return result;
  if (!result) return input;
  return {
    summary: result.summary || input.summary,
    artifacts: {
      files_created: uniqueStrings(input.artifacts?.files_created, result.artifacts?.files_created),
      files_modified: uniqueStrings(input.artifacts?.files_modified, result.artifacts?.files_modified),
      commands_run: uniqueStrings(input.artifacts?.commands_run, result.artifacts?.commands_run),
    },
    toolTrace: {
      files_created: uniqueStrings(input.toolTrace?.files_created, result.toolTrace?.files_created),
      files_modified: uniqueStrings(input.toolTrace?.files_modified, result.toolTrace?.files_modified),
      commands_run: uniqueStrings(input.toolTrace?.commands_run, result.toolTrace?.commands_run),
    },
    verification: [...(input.verification ?? []), ...(result.verification ?? [])],
    evidence_refs: uniqueStrings(input.evidence_refs, result.evidence_refs),
    next_steps: uniqueStrings(input.next_steps, result.next_steps),
    result: result.result || input.result,
    rendered: result.rendered || input.rendered,
  };
}

function statusFromAgent(status: AgentConversation['status'] | undefined): DeliveryEvidenceStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'cancelled';
  return 'unknown';
}

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop() || value;
}

function artifactRefsFrom(filesCreated: string[], filesModified: string[], evidenceRefs: string[]): DeliveryEvidenceArtifactRef[] {
  const refs: DeliveryEvidenceArtifactRef[] = [];
  for (const path of uniqueStrings(filesCreated, filesModified)) {
    refs.push({ path, label: basename(path), kind: filesCreated.includes(path) ? 'created' : 'modified' });
  }
  for (const ref of evidenceRefs) {
    if (/^https?:\/\//i.test(ref)) refs.push({ url: ref, label: ref.replace(/^https?:\/\//i, '').slice(0, 80), kind: 'url' });
    else if (/[/\\.]|^[\w.-]+\.[A-Za-z0-9]+$/.test(ref)) refs.push({ path: ref, label: basename(ref), kind: 'evidence' });
  }
  return refs;
}

function itemFromCompletion(
  payload: CompletionPayload,
  conversation: AgentConversation,
  message: AgentMessage,
  sessionId?: string | null,
): DeliveryEvidenceViewModel {
  const filesCreated = uniqueStrings(payload.artifacts?.files_created, payload.toolTrace?.files_created);
  const filesModified = uniqueStrings(payload.artifacts?.files_modified, payload.toolTrace?.files_modified);
  const commandsRun = uniqueStrings(payload.artifacts?.commands_run, payload.toolTrace?.commands_run);
  const evidenceRefs = uniqueStrings(payload.evidence_refs);
  const verification = coerceVerification(payload.verification);
  const nextSteps = uniqueStrings(payload.next_steps);
  const rawSources: DeliveryEvidenceSource[] = ['agent_completion'];
  if (payload.toolTrace) rawSources.push('tool_trace');
  if (evidenceRefs.length) rawSources.push('message_evidence');

  return {
    id: `${conversation.agentId}:${message.id}`,
    sessionId: sessionId || undefined,
    taskId: conversation.taskId,
    agentId: conversation.agentId,
    agentName: conversation.agentName,
    status: statusFromAgent(conversation.status),
    title: payload.summary || conversation.summary || conversation.agentName,
    summary: payload.summary || payload.result || payload.rendered || conversation.summary,
    filesCreated,
    filesModified,
    commandsRun,
    verification,
    artifactRefs: artifactRefsFrom(filesCreated, filesModified, evidenceRefs),
    evidenceRefs,
    risks: [],
    nextAction: nextSteps[0],
    rawSources,
    updatedAt: message.timestamp,
  };
}

function evidenceItemFromReferences(
  refs: EvidenceReference[],
  sessionId?: string | null,
): DeliveryEvidenceViewModel | null {
  if (refs.length === 0) return null;
  const evidenceRefs = refs.map((ref) => ref.path || ref.url || ref.label).filter(Boolean);
  return {
    id: 'message-evidence',
    sessionId: sessionId || undefined,
    status: 'unknown',
    title: '会话证据引用',
    summary: `发现 ${refs.length} 条文件、URL 或 artifact 引用。`,
    filesCreated: [],
    filesModified: refs.filter((ref) => ref.path && ref.kind === 'file').map((ref) => ref.path!),
    commandsRun: [],
    verification: [],
    artifactRefs: refs.map((ref) => ({ path: ref.path, url: ref.url, label: ref.label, kind: ref.kind })),
    evidenceRefs: uniqueStrings(evidenceRefs),
    risks: [],
    rawSources: ['message_evidence'],
  };
}

export function buildDeliveryEvidence(input: BuildDeliveryEvidenceInput): DeliveryEvidenceViewModel[] {
  const items: DeliveryEvidenceViewModel[] = [];
  for (const conversation of Object.values(input.agentConversations)) {
    for (let index = 0; index < conversation.messages.length; index += 1) {
      const message = conversation.messages[index];
      if (message.type !== 'tool_call' || String(message.tool || '').toLowerCase() !== 'attempt_completion') continue;
      const callPayload = coerceCompletionPayload(message.content);
      const nextResult = conversation.messages.slice(index + 1).find((candidate) =>
        candidate.type === 'tool_result' && String(candidate.tool || '').toLowerCase() === 'attempt_completion'
      );
      const resultPayload = coerceCompletionPayload(nextResult?.content);
      const payload = mergePayloads(callPayload, resultPayload);
      if (!payload) continue;
      items.push(itemFromCompletion(payload, conversation, nextResult || message, input.sessionId));
    }
  }

  if (items.length === 0) {
    const refsItem = evidenceItemFromReferences(input.evidenceReferences ?? [], input.sessionId);
    if (refsItem) items.push(refsItem);
  }

  return items
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, input.limit ?? 8);
}
