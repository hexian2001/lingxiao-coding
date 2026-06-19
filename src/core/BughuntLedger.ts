import { SESSION_KEYS } from './SessionStateKeys.js';
import { DEFAULT_BUGHUNT_POLICY, type BughuntPolicy } from './BughuntPolicy.js';
import { auditModeEvent } from './ModeAudit.js';
import { topologicalOrder, getReadyDagNodes } from './BughuntDagScheduler.js';

export type BughuntPhase = 'surface_map' | 'finding_triage' | 'repro_instrument' | 'blackbox_verify' | 'fix' | 'review_close';
export type BughuntFindingStatus = 'hypothesis' | 'likely' | 'confirmed' | 'fixed' | 'verified' | 'closed' | 'false_positive' | 'blocked';
export type BughuntSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type BughuntExploitability = 'proven' | 'probable' | 'possible' | 'unknown' | 'not_exploitable';
export type BughuntEvidenceKind = 'worker_result' | 'scan_result' | 'instrumentation' | 'compile' | 'blackbox_probe' | 'command' | 'finding_note' | 'status_change';

const CLOSED_BUGHUNT_FINDING_STATUSES = new Set<string>(['closed', 'false_positive']);

/**
 * 节点级证据门（结构化声明式 ADT，P5 升级）。
 * 调度器（BughuntDagScheduler.isDagNodeReady）求值：object gate 按 kind 校验；
 * 向后兼容：string/undefined gate 视为「无结构门」（通过），保持旧数据可用。
 * 确定性求值，查 ledger.findings/events，无启发式。
 */
export type BughuntEvidenceGate =
  | { kind: 'all'; gates: BughuntEvidenceGate[] }
  | { kind: 'finding_status'; findingId: string; status: BughuntFindingStatus }
  | { kind: 'event_present'; eventKind: BughuntEvidenceKind }
  | { kind: 'artifact_present'; field: 'repro_artifact' | 'whitebox_artifacts' | 'compile_artifacts' | 'blackbox_artifacts' };

export interface BughuntDagNode {
  id: string;
  phase: BughuntPhase;
  role: string;
  objective: string;
  read_scope: string[];
  write_scope: string[];
  blocked_by: string[];
  evidence_gate?: BughuntEvidenceGate | string;
  expected_artifact?: string;
  task_id?: string;
  status: 'planned' | 'dispatched' | 'completed' | 'blocked';
}

export interface BughuntFinding {
  id: string;
  title: string;
  severity: BughuntSeverity;
  status: BughuntFindingStatus;
  files: string[];
  cwe?: string;
  owasp?: string;
  cvss?: string;
  attack_vector?: string;
  trust_boundary?: string;
  source?: string;
  sink?: string;
  taint_path: string[];
  preconditions: string[];
  payloads: string[];
  trigger?: string;
  impact?: string;
  exploitability?: BughuntExploitability;
  blast_radius?: string;
  evidence: string[];
  evidence_gap?: string[];
  repro_artifact?: string;
  whitebox_artifacts: string[];
  instrumentation_artifacts: string[];
  compile_commands: string[];
  compile_artifacts: string[];
  blackbox_artifacts: string[];
  fix_files: string[];
  blackbox_commands: string[];
  close_reason?: string;
  residual_risk?: string;
  false_positive_reason?: string;
  linked_tasks: string[];
  updated_at: number;
}

export interface BughuntEvidenceEvent {
  id: string;
  kind: BughuntEvidenceKind;
  summary: string;
  finding_ids: string[];
  task_id?: string;
  agent_name?: string;
  files: string[];
  commands: string[];
  exit_codes: string[];
  evidence: string[];
  artifact_path?: string;
  created_at: number;
}

export interface BughuntLedger {
  version: 1;
  session_id: string;
  target: string;
  mode: 'autonomous';
  active: boolean;
  dag: BughuntDagNode[];
  findings: BughuntFinding[];
  events: BughuntEvidenceEvent[];
  created_at: number;
  updated_at: number;
}

export interface BughuntDb {
  getSessionState(sessionId: string, key: string): unknown | null;
  setSessionState(sessionId: string, key: string, value: unknown): void;
}

const PHASES = new Set<BughuntPhase>(['surface_map', 'finding_triage', 'repro_instrument', 'blackbox_verify', 'fix', 'review_close']);
const STATUSES = new Set<BughuntFindingStatus>(['hypothesis', 'likely', 'confirmed', 'fixed', 'verified', 'closed', 'false_positive', 'blocked']);
const SEVERITIES = new Set<BughuntSeverity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
const NODE_STATUSES = new Set<BughuntDagNode['status']>(['planned', 'dispatched', 'completed', 'blocked']);
const EXPLOITABILITIES = new Set<BughuntExploitability>(['proven', 'probable', 'possible', 'unknown', 'not_exploitable']);

function now(): number {
  return Date.now();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function hasOwn(item: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(item, key);
}

function optionalString(item: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  if (!hasOwn(item, key)) return fallback;
  const value = item[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(item: Record<string, unknown>, key: string, fallback?: string[]): string[] {
  if (!hasOwn(item, key)) return fallback || [];
  return asStringArray(item[key]);
}

function optionalMaybeStringArray(item: Record<string, unknown>, key: string, fallback?: string[]): string[] | undefined {
  if (!hasOwn(item, key)) return fallback;
  const values = asStringArray(item[key]);
  return values.length > 0 ? values : undefined;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

export function createBughuntLedger(sessionId: string, target: string): BughuntLedger {
  const timestamp = now();
  return {
    version: 1,
    session_id: sessionId,
    target: target.trim() || '当前工作区',
    mode: 'autonomous',
    active: true,
    dag: [],
    findings: [],
    events: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function readBughuntLedger(db: BughuntDb, sessionId: string): BughuntLedger | null {
  const raw = db.getSessionState(sessionId, SESSION_KEYS.BUGHUNT_LEDGER);
  if (!raw || typeof raw !== 'object') return null;
  const ledger = raw as Partial<BughuntLedger>;
  if (ledger.version !== 1 || ledger.session_id !== sessionId) return null;
  return { ...ledger, events: Array.isArray(ledger.events) ? ledger.events : [] } as BughuntLedger;
}

export function writeBughuntLedger(db: BughuntDb, ledger: BughuntLedger): BughuntLedger {
  const next = { ...ledger, updated_at: now() };
  db.setSessionState(ledger.session_id, SESSION_KEYS.BUGHUNT_LEDGER, next);
  return next;
}

function ensureBughuntLedger(db: BughuntDb, sessionId: string, target = '当前工作区'): BughuntLedger {
  return readBughuntLedger(db, sessionId) || writeBughuntLedger(db, createBughuntLedger(sessionId, target));
}

export function startOrResumeBughuntLedger(db: BughuntDb, sessionId: string, target: string): BughuntLedger {
  const existing = readBughuntLedger(db, sessionId);
  if (!existing) {
    return writeBughuntLedger(db, createBughuntLedger(sessionId, target));
  }
  return writeBughuntLedger(db, {
    ...existing,
    target: target.trim() || existing.target,
    active: true,
  });
}

function normalizeDagEvidenceGate(value: unknown): BughuntEvidenceGate | string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string') {
    const kind = (value as { kind: string }).kind;
    if (kind === 'all' || kind === 'finding_status' || kind === 'event_present' || kind === 'artifact_present') {
      return value as BughuntEvidenceGate;
    }
  }
  return undefined;
}

function normalizeBughuntDagNode(raw: unknown): BughuntDagNode {
  if (!raw || typeof raw !== 'object') throw new Error('dag node must be an object');
  const item = raw as Record<string, unknown>;
  const phase = assertNonEmptyString(item.phase, 'phase') as BughuntPhase;
  if (!PHASES.has(phase)) throw new Error(`invalid phase: ${phase}`);
  const status = (typeof item.status === 'string' ? item.status : 'planned') as BughuntDagNode['status'];
  if (!NODE_STATUSES.has(status)) throw new Error(`invalid node status: ${status}`);

  return {
    id: assertNonEmptyString(item.id, 'id'),
    phase,
    role: assertNonEmptyString(item.role, 'role'),
    objective: assertNonEmptyString(item.objective, 'objective'),
    read_scope: asStringArray(item.read_scope),
    write_scope: asStringArray(item.write_scope),
    blocked_by: asStringArray(item.blocked_by),
    evidence_gate: normalizeDagEvidenceGate(item.evidence_gate),
    expected_artifact: typeof item.expected_artifact === 'string' && item.expected_artifact.trim() ? item.expected_artifact.trim() : undefined,
    task_id: typeof item.task_id === 'string' && item.task_id.trim() ? item.task_id.trim() : undefined,
    status,
  };
}

function normalizeBughuntFinding(raw: unknown, existing?: BughuntFinding): BughuntFinding {
  if (!raw || typeof raw !== 'object') throw new Error('finding must be an object');
  const item = raw as Record<string, unknown>;
  const severity = assertNonEmptyString(item.severity ?? existing?.severity, 'severity').toUpperCase() as BughuntSeverity;
  if (!SEVERITIES.has(severity)) throw new Error(`invalid severity: ${severity}`);
  const status = assertNonEmptyString(item.status ?? existing?.status, 'status') as BughuntFindingStatus;
  if (!STATUSES.has(status)) throw new Error(`invalid finding status: ${status}`);
  const exploitability = optionalString(item, 'exploitability', existing?.exploitability) as BughuntExploitability | undefined;
  if (exploitability && !EXPLOITABILITIES.has(exploitability)) throw new Error(`invalid exploitability: ${exploitability}`);

  const finding: BughuntFinding = {
    id: assertNonEmptyString(item.id ?? existing?.id, 'id'),
    title: assertNonEmptyString(item.title ?? existing?.title, 'title'),
    severity,
    status,
    files: optionalStringArray(item, 'files', existing?.files),
    cwe: optionalString(item, 'cwe', existing?.cwe),
    owasp: optionalString(item, 'owasp', existing?.owasp),
    cvss: optionalString(item, 'cvss', existing?.cvss),
    attack_vector: optionalString(item, 'attack_vector', existing?.attack_vector),
    trust_boundary: optionalString(item, 'trust_boundary', existing?.trust_boundary),
    source: optionalString(item, 'source', existing?.source),
    sink: optionalString(item, 'sink', existing?.sink),
    taint_path: optionalStringArray(item, 'taint_path', existing?.taint_path),
    preconditions: optionalStringArray(item, 'preconditions', existing?.preconditions),
    payloads: optionalStringArray(item, 'payloads', existing?.payloads),
    trigger: optionalString(item, 'trigger', existing?.trigger),
    impact: optionalString(item, 'impact', existing?.impact),
    exploitability,
    blast_radius: optionalString(item, 'blast_radius', existing?.blast_radius),
    evidence: optionalStringArray(item, 'evidence', existing?.evidence),
    evidence_gap: optionalMaybeStringArray(item, 'evidence_gap', existing?.evidence_gap),
    repro_artifact: optionalString(item, 'repro_artifact', existing?.repro_artifact),
    whitebox_artifacts: optionalStringArray(item, 'whitebox_artifacts', existing?.whitebox_artifacts),
    instrumentation_artifacts: optionalStringArray(item, 'instrumentation_artifacts', existing?.instrumentation_artifacts),
    compile_commands: optionalStringArray(item, 'compile_commands', existing?.compile_commands),
    compile_artifacts: optionalStringArray(item, 'compile_artifacts', existing?.compile_artifacts),
    blackbox_artifacts: optionalStringArray(item, 'blackbox_artifacts', existing?.blackbox_artifacts),
    fix_files: optionalStringArray(item, 'fix_files', existing?.fix_files),
    blackbox_commands: optionalStringArray(item, 'blackbox_commands', existing?.blackbox_commands),
    close_reason: optionalString(item, 'close_reason', existing?.close_reason),
    residual_risk: optionalString(item, 'residual_risk', existing?.residual_risk),
    false_positive_reason: optionalString(item, 'false_positive_reason', existing?.false_positive_reason),
    linked_tasks: optionalStringArray(item, 'linked_tasks', existing?.linked_tasks),
    updated_at: now(),
  };

  validateBughuntFindingTransition(finding, existing);
  return finding;
}

function validateBughuntFindingTransition(finding: BughuntFinding, existing?: BughuntFinding): void {
  const missing = getBughuntFindingGateGaps(finding);
  if (missing.length > 0) {
    throw new Error(`finding ${finding.id} cannot be ${finding.status}: ${missing.join('; ')}`);
  }
}

export function getBughuntFindingGateGaps(finding: BughuntFinding): string[] {
  const missing: string[] = [];
  const evidence = finding.evidence || [];
  const evidenceGap = finding.evidence_gap || [];
  const files = finding.files || [];
  const hasWhiteboxChain = Boolean(
    (finding.source && finding.sink) ||
    (finding.taint_path || []).length > 0 ||
    (finding.whitebox_artifacts || []).length > 0 ||
    finding.repro_artifact,
  );
  const hasCompileSignal = Boolean(
    (finding.compile_commands || []).length > 0 ||
    (finding.compile_artifacts || []).length > 0 ||
    evidence.some((line) => /\b(?:compile|build|test|tsc|pytest|cargo test|go test|passed)\b|编译|构建|测试|通过/i.test(line)),
  );
  const hasBlackboxSignal = Boolean(
    (finding.blackbox_commands || []).length > 0 &&
    ((finding.blackbox_artifacts || []).length > 0 ||
      evidence.some((line) => /\b(?:blackbox|curl|http|request|response|status|exit code|returned|verified)\b|黑盒|请求|响应|退出码|验证/i.test(line))),
  );

  if (finding.status === 'likely' && evidence.length === 0 && evidenceGap.length === 0) {
    missing.push('likely requires evidence or evidence_gap');
  }

  if (finding.status === 'confirmed' || finding.status === 'fixed' || finding.status === 'verified') {
    if (files.length === 0) missing.push(`${finding.status} requires affected files`);
    if (evidence.length === 0) missing.push(`${finding.status} requires source evidence`);
    if (!hasWhiteboxChain) missing.push(`${finding.status} requires source+sink, taint_path, whitebox_artifacts, or repro_artifact`);
  }

  if (finding.status === 'fixed' && (finding.fix_files || []).length === 0) {
    missing.push('fixed requires fix_files');
  }

  if (finding.status === 'verified') {
    if (!hasCompileSignal) missing.push('verified requires compile/test signal');
    if ((finding.blackbox_commands || []).length === 0) missing.push('verified requires blackbox_commands');
    if (!hasBlackboxSignal) missing.push('verified requires blackbox output evidence or blackbox_artifacts');
  }

  if (finding.status === 'closed') {
    if (!finding.close_reason) missing.push('closed requires close_reason');
    if (!finding.residual_risk && !finding.false_positive_reason && !hasCompileSignal && !hasBlackboxSignal) {
      missing.push('closed requires residual_risk, false_positive_reason, or verification signal');
    }
  }

  if (finding.status === 'false_positive' && !finding.false_positive_reason && !finding.close_reason) {
    missing.push('false_positive requires false_positive_reason or close_reason');
  }

  return missing;
}

export function setBughuntDag(db: BughuntDb, sessionId: string, target: string | undefined, rawNodes: unknown): BughuntLedger {
  if (!Array.isArray(rawNodes)) {
    throw new Error('nodes must be an array');
  }
  const nodes = rawNodes.map(normalizeBughuntDagNode);
  // 拓扑校验在写盘前：环 → fail-closed（确定性，不残留半成品 ledger，避免调度死锁）
  const topo = topologicalOrder(nodes);
  if ('cycle' in topo) {
    throw new Error(`DAG contains a cycle: ${topo.cycle.join(' -> ')}`);
  }
  const ledger = ensureBughuntLedger(db, sessionId, target);
  return writeBughuntLedger(db, {
    ...ledger,
    target: target?.trim() || ledger.target,
    active: true,
    dag: nodes,
  });
}

/**
 * 更新单个 DAG 节点（status 回写、task_id 绑定等）。
 * P5：worker 完成后由 LeaderAgent.captureBughuntWorkerEvidence 回写 status='completed'，
 * 解锁后继节点的 blocked_by。返回 null 表示该 session 无 ledger。
 */
export function updateBughuntDagNode(
  db: BughuntDb,
  sessionId: string,
  nodeId: string,
  patch: Partial<BughuntDagNode>,
): BughuntLedger | null {
  const ledger = readBughuntLedger(db, sessionId);
  if (!ledger) return null;
  let touched = false;
  const dag = ledger.dag.map((node) => {
    if (node.id !== nodeId) return node;
    touched = true;
    return normalizeBughuntDagNode({ ...node, ...patch, id: node.id });
  });
  if (!touched) return ledger;
  return writeBughuntLedger(db, { ...ledger, dag });
}

export function upsertBughuntFinding(db: BughuntDb, sessionId: string, rawFinding: unknown): BughuntLedger {
  const ledger = ensureBughuntLedger(db, sessionId);
  const findingId = rawFinding && typeof rawFinding === 'object' ? (rawFinding as Record<string, unknown>).id : undefined;
  const existing = typeof findingId === 'string' ? ledger.findings.find((item) => item.id === findingId) : undefined;
  const finding = normalizeBughuntFinding(rawFinding, existing);
  const findings = ledger.findings.filter((item) => item.id !== finding.id);
  findings.push(finding);
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return writeBughuntLedger(db, { ...ledger, findings, active: true });
}

export function appendBughuntEvent(
  db: BughuntDb,
  sessionId: string,
  rawEvent: Omit<BughuntEvidenceEvent, 'id' | 'created_at'>,
  policy: BughuntPolicy = DEFAULT_BUGHUNT_POLICY,
): BughuntLedger | null {
  const ledger = readBughuntLedger(db, sessionId);
  if (!ledger) return null;
  const event: BughuntEvidenceEvent = {
    ...rawEvent,
    summary: rawEvent.summary.trim().slice(0, policy.maxEventSummaryChars),
    finding_ids: rawEvent.finding_ids.slice(0, policy.maxEventItems),
    files: rawEvent.files.slice(0, policy.maxEventItems * 2),
    commands: rawEvent.commands.slice(0, policy.maxEventItems),
    exit_codes: rawEvent.exit_codes.slice(0, policy.maxEventItems),
    evidence: rawEvent.evidence.slice(0, policy.maxEventItems).map((item) => item.slice(0, policy.maxEvidenceLineChars)),
    artifact_path: rawEvent.artifact_path,
    id: `E-${ledger.events.length + 1}`,
    created_at: now(),
  };
  const events = [...ledger.events, event].slice(-policy.maxEvents);
  const next = writeBughuntLedger(db, { ...ledger, events });
  // 统一 per-mode 可观测出口：ledger 事件桥接到 ModeAudit metrics。
  auditModeEvent('bughunt', {
    kind: 'bughunt_ledger_event',
    bughuntKind: event.kind,
    findingIds: event.finding_ids,
  });
  return next;
}

export function summarizeBughuntLedger(ledger: BughuntLedger): string {
  const byStatus = new Map<string, number>();
  for (const finding of ledger.findings) {
    byStatus.set(finding.status, (byStatus.get(finding.status) || 0) + 1);
  }
  const statusSummary = [...byStatus.entries()].map(([status, count]) => `${status}=${count}`).join(', ') || 'none';
  const openHigh = ledger.findings.filter((finding) =>
    (finding.severity === 'CRITICAL' || finding.severity === 'HIGH') &&
    !CLOSED_BUGHUNT_FINDING_STATUSES.has(finding.status)
  );
  const gateGaps = ledger.findings.reduce((count, finding) => count + getBughuntFindingGateGaps(finding).length, 0);
  return `Bughunt target=${ledger.target}; dag_nodes=${ledger.dag.length}; findings=${ledger.findings.length}; statuses=${statusSummary}; open_high=${openHigh.length}; gate_gaps=${gateGaps}`;
}

export function getOpenBughuntFindings(
  ledger: BughuntLedger,
  severity?: BughuntSeverity,
): BughuntFinding[] {
  const closed = new Set<BughuntFindingStatus>(['closed', 'false_positive']);
  return ledger.findings
    .filter((finding) => !closed.has(finding.status))
    .filter((finding) => !severity || finding.severity === severity)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id));
}

export function getBughuntFinding(ledger: BughuntLedger, findingId: string): BughuntFinding | undefined {
  return ledger.findings.find((finding) => finding.id === findingId);
}

export function buildBughuntBrief(ledger: BughuntLedger): string {
  const open = getOpenBughuntFindings(ledger);
  const openHigh = open.filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH');
  const frontier = openHigh.slice(0, 3).map((finding) => {
    const gateGap = getBughuntFindingGateGaps(finding)[0];
    const gap = gateGap || finding.evidence_gap?.[0];
    const taxonomy = [finding.cwe, finding.owasp].filter(Boolean).join('/');
    return `- ${finding.id} ${finding.severity}/${finding.status}${taxonomy ? ` ${taxonomy}` : ''}: ${finding.title}${gap ? `; next_gate=${gap}` : ''}`;
  });
  const lastEvent = ledger.events[ledger.events.length - 1];
  const gateGapCount = open.reduce((count, finding) => count + getBughuntFindingGateGaps(finding).length, 0);
  // P5: 调度核心——brief 直接附就绪候选，Leader 据此经 dispatch_agent 推进（不自动派发）。
  const ready = getReadyDagNodes(ledger);
  const readyLine = ready.length > 0
    ? `; ready_dag_nodes=${ready.map((r) => `${r.node.id}:${r.node.phase}`).join(',')}`
    : '; ready_dag_nodes=none';
  return [
    `Bughunt active: target=${ledger.target}`,
    `DAG nodes=${ledger.dag.length}; findings=${ledger.findings.length}; open_high=${openHigh.length}; open_gate_gaps=${gateGapCount}${readyLine}`,
    ...(frontier.length > 0 ? ['Open high frontier:', ...frontier] : ['Open high frontier: none']),
    ...(lastEvent ? [`Recent event: ${lastEvent.summary}`, ...(lastEvent.artifact_path ? [`Evidence pack: ${lastEvent.artifact_path}`] : [])] : []),
    'Use focused finding/ledger tools only when details are needed.',
  ].join('\n');
}

export function generateBughuntReport(ledger: BughuntLedger): string {
  const findings = [...ledger.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.id.localeCompare(b.id));
  const openHigh = getOpenBughuntFindings(ledger).filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH');
  return [
    '# Bughunt Report',
    '',
    `- target: ${ledger.target}`,
    `- dag_nodes: ${ledger.dag.length}`,
    `- findings: ${ledger.findings.length}`,
    `- open_high_or_critical: ${openHigh.length}`,
    `- evidence_events: ${ledger.events.length}`,
    '',
    '## Findings',
    '',
    ...(findings.length > 0 ? findings.flatMap(renderFindingForReport) : ['No findings recorded.']),
    '',
    '## Recent Evidence Events',
    '',
    ...(ledger.events.slice(-10).length > 0 ? ledger.events.slice(-10).flatMap(renderEventForReport) : ['No evidence events recorded.']),
    '',
    '## Residual Risk',
    '',
    ...(openHigh.length > 0
      ? openHigh.map((finding) => `- ${finding.id} ${finding.severity}/${finding.status}: ${finding.title}`)
      : ['No open HIGH/CRITICAL findings recorded.']),
    '',
  ].join('\n');
}

function renderFindingForReport(finding: BughuntFinding): string[] {
  const gateGaps = getBughuntFindingGateGaps(finding);
  return [
    `### ${finding.id}: ${finding.title}`,
    '',
    `- severity: ${finding.severity}`,
    `- status: ${finding.status}`,
    `- taxonomy: ${[finding.cwe, finding.owasp, finding.cvss].filter(Boolean).join(' | ') || 'none'}`,
    `- files: ${finding.files.join(', ') || 'none'}`,
    `- attack_vector: ${finding.attack_vector || 'not recorded'}`,
    `- trust_boundary: ${finding.trust_boundary || 'not recorded'}`,
    `- source: ${finding.source || 'not recorded'}`,
    `- sink: ${finding.sink || 'not recorded'}`,
    `- taint_path: ${finding.taint_path.join(' -> ') || 'none'}`,
    `- preconditions: ${finding.preconditions.join(' | ') || 'none'}`,
    `- payloads: ${finding.payloads.join(' | ') || 'none'}`,
    `- trigger: ${finding.trigger || 'not recorded'}`,
    `- impact: ${finding.impact || 'not recorded'}`,
    `- exploitability: ${finding.exploitability || 'unknown'}`,
    `- blast_radius: ${finding.blast_radius || 'not recorded'}`,
    `- evidence: ${finding.evidence.join(' | ') || 'none'}`,
    `- evidence_gap: ${finding.evidence_gap?.join(' | ') || 'none'}`,
    `- gate_gaps: ${gateGaps.join(' | ') || 'none'}`,
    `- repro_artifact: ${finding.repro_artifact || 'none'}`,
    `- whitebox_artifacts: ${finding.whitebox_artifacts.join(' | ') || 'none'}`,
    `- instrumentation_artifacts: ${finding.instrumentation_artifacts.join(' | ') || 'none'}`,
    `- compile_commands: ${finding.compile_commands.join(' | ') || 'none'}`,
    `- compile_artifacts: ${finding.compile_artifacts.join(' | ') || 'none'}`,
    `- fix_files: ${finding.fix_files.join(', ') || 'none'}`,
    `- blackbox_commands: ${finding.blackbox_commands.join(' | ') || 'none'}`,
    `- blackbox_artifacts: ${finding.blackbox_artifacts.join(' | ') || 'none'}`,
    `- close_reason: ${finding.close_reason || 'none'}`,
    `- false_positive_reason: ${finding.false_positive_reason || 'none'}`,
    `- residual_risk: ${finding.residual_risk || 'none'}`,
    '',
  ];
}

function renderEventForReport(event: BughuntEvidenceEvent): string[] {
  return [
    `- ${event.id} [${event.kind}]: ${event.summary}`,
    `  - findings: ${event.finding_ids.join(', ') || 'none'}`,
    `  - commands: ${event.commands.join(' | ') || 'none'}`,
    `  - evidence: ${event.evidence.join(' | ') || 'none'}`,
    `  - artifact: ${event.artifact_path || 'none'}`,
  ];
}

function severityRank(severity: BughuntSeverity): number {
  switch (severity) {
    case 'CRITICAL': return 0;
    case 'HIGH': return 1;
    case 'MEDIUM': return 2;
    case 'LOW': return 3;
    case 'INFO': return 4;
  }
}
