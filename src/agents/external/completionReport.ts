import {
  isWorkerContractComplianceStatus,
  type WorkerArtifactTrace,
  type WorkerContractComplianceProof,
  type WorkerVerificationItem,
} from '../../core/AgentProtocol.js';
import {
  assertSpeculativeWinnerEvidenceVerified,
  type SpeculativeWinnerEvidence,
} from '../../core/SpeculativeExecutionController.js';

export interface ExternalCompletionReport {
  result: string;
  summary?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts?: WorkerArtifactTrace;
  verification?: WorkerVerificationItem[];
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: WorkerContractComplianceProof;
  speculativeWinner?: SpeculativeWinnerEvidence;
}

const COMPLETION_BLOCK_RE = /```lingxiao_completion\s*\n([\s\S]*?)```/gi;

function uniqueStringList(value: unknown): string[] | undefined {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function parseArtifacts(value: unknown): WorkerArtifactTrace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const filesCreated = uniqueStringList(record.files_created);
  const filesModified = uniqueStringList(record.files_modified);
  const commandsRun = uniqueStringList(record.commands_run);
  const artifacts: WorkerArtifactTrace = {
    ...(filesCreated ? { files_created: filesCreated } : {}),
    ...(filesModified ? { files_modified: filesModified } : {}),
    ...(commandsRun ? { commands_run: commandsRun } : {}),
  };
  return artifacts.files_created?.length || artifacts.files_modified?.length || artifacts.commands_run?.length
    ? artifacts
    : undefined;
}

function parseVerification(value: unknown): WorkerVerificationItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: WorkerVerificationItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
    const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
    if (!kind || !detail) continue;
    items.push({
      kind,
      detail,
      ...(typeof record.passed === 'boolean' ? { passed: record.passed } : {}),
    });
  }
  return items.length > 0 ? items : undefined;
}

function parseContractCompliance(value: unknown): WorkerContractComplianceProof | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const surface = typeof record.surface === 'string' ? record.surface.trim() : '';
  const status = typeof record.status === 'string' ? record.status.trim() : '';
  const evidence = uniqueStringList(record.evidence);
  const deviations = uniqueStringList(record.deviations);
  if (!surface || !isWorkerContractComplianceStatus(status) || !evidence?.length) {
    return undefined;
  }
  return {
    surface,
    status,
    evidence,
    ...(deviations ? { deviations } : {}),
  };
}

function parseCompletionPayload(raw: string): Omit<ExternalCompletionReport, 'result'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  const verdict = typeof record.verdict === 'string' && ['PASS', 'FAIL', 'BLOCKED'].includes(record.verdict.toUpperCase())
    ? record.verdict.toUpperCase() as 'PASS' | 'FAIL' | 'BLOCKED'
    : undefined;
  const artifacts = parseArtifacts(record.artifacts);
  const verification = parseVerification(record.verification);
  const nextSteps = uniqueStringList(record.next_steps);
  const blockedByDiscovery = uniqueStringList(record.blocked_by_discovery);
  const evidenceRefs = uniqueStringList(record.evidence_refs);
  const contractCompliance = parseContractCompliance(record.contract_compliance);
  const speculativeWinner = assertSpeculativeWinnerEvidenceVerified(record.speculativeWinner ?? record.speculative_winner);
  return {
    ...(summary ? { summary } : {}),
    ...(verdict ? { verdict } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(verification ? { verification } : {}),
    ...(nextSteps ? { next_steps: nextSteps } : {}),
    ...(blockedByDiscovery ? { blocked_by_discovery: blockedByDiscovery } : {}),
    ...(typeof record.needs_leader_coordination === 'boolean' ? { needs_leader_coordination: record.needs_leader_coordination } : {}),
    ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}),
    ...(contractCompliance ? { contract_compliance: contractCompliance } : {}),
    ...(speculativeWinner ? { speculativeWinner } : {}),
  };
}

export function parseExternalCompletionReport(rawResult: string): ExternalCompletionReport {
  let summary: string | undefined;
  let verdict: 'PASS' | 'FAIL' | 'BLOCKED' | undefined;
  let artifacts: WorkerArtifactTrace | undefined;
  let verification: WorkerVerificationItem[] | undefined;
  let nextSteps: string[] | undefined;
  let blockedByDiscovery: string[] | undefined;
  let needsLeaderCoordination: boolean | undefined;
  let evidenceRefs: string[] | undefined;
  let contractCompliance: WorkerContractComplianceProof | undefined;
  let speculativeWinner: SpeculativeWinnerEvidence | undefined;
  for (const match of rawResult.matchAll(COMPLETION_BLOCK_RE)) {
    const body = match[1];
    if (typeof body === 'string') {
      const next = parseCompletionPayload(body.trim());
      if (next) {
        summary = next.summary;
        verdict = next.verdict;
        artifacts = next.artifacts;
        verification = next.verification;
        nextSteps = next.next_steps;
        blockedByDiscovery = next.blocked_by_discovery;
        needsLeaderCoordination = next.needs_leader_coordination;
        evidenceRefs = next.evidence_refs;
        contractCompliance = next.contract_compliance;
        speculativeWinner = next.speculativeWinner;
      }
    }
  }
  const result = rawResult.replace(COMPLETION_BLOCK_RE, '').trim();
  const report: ExternalCompletionReport = {
    result: result || summary || rawResult.trim(),
  };

  if (summary) report.summary = summary;
  if (verdict) report.verdict = verdict;
  if (artifacts) report.artifacts = artifacts;
  if (verification) report.verification = verification;
  if (nextSteps) report.next_steps = nextSteps;
  if (blockedByDiscovery) report.blocked_by_discovery = blockedByDiscovery;
  if (typeof needsLeaderCoordination === 'boolean') report.needs_leader_coordination = needsLeaderCoordination;
  if (evidenceRefs) report.evidence_refs = evidenceRefs;
  if (contractCompliance) report.contract_compliance = contractCompliance;
  if (speculativeWinner) report.speculativeWinner = speculativeWinner;
  return report;
}
