import type { BusMessage } from './MessageBus.js';
import type { PermissionRequestPayload } from './PermissionSystem.js';
import type { RecoveryFaultClass, RuntimeRecoveryRecord } from './RecoveryRecords.js';
import type { LLMErrorKind } from '../llm/errors.js';
import type { SpeculativeWinnerEvidence } from './SpeculativeExecutionController.js';

export interface WorkerArtifactTrace {
  files_created?: string[];
  files_modified?: string[];
  commands_run?: string[];
}

export interface WorkerFailureDiagnostics {
  pid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  timeoutReason?: string;
  error?: string;
  stderrTail?: string[];
  stdoutTail?: string[];
}

export interface WorkerVerificationItem {
  kind: string;
  detail: string;
  passed?: boolean;
}

export const WORKER_CONTRACT_COMPLIANCE_STATUSES = [
  'complied',
  'upgraded',
  'blocked',
  'not_applicable',
] as const;

export type WorkerContractComplianceStatus = typeof WORKER_CONTRACT_COMPLIANCE_STATUSES[number];

const WORKER_CONTRACT_COMPLIANCE_STATUS_SET = new Set<string>(WORKER_CONTRACT_COMPLIANCE_STATUSES);

export function isWorkerContractComplianceStatus(value: string): value is WorkerContractComplianceStatus {
  return WORKER_CONTRACT_COMPLIANCE_STATUS_SET.has(value);
}

export interface WorkerContractComplianceProof {
  surface: string;
  status: WorkerContractComplianceStatus;
  evidence: string[];
  deviations?: string[];
}

export interface TaskCompletePayload {
  kind: 'task_complete';
  taskId: string;
  /** TaskBoard 执行代际；Leader 用它丢弃重开/重派前的 late receipt。 */
  taskRunGeneration?: number;
  result: string;
  /** evaluator/review 任务的验收结论（可选）。OrchestrationRuntime 优先从此字段提取 verdict。 */
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  /** worker attempt_completion 声明的一句话摘要（可选） */
  summary?: string;
  /** worker 声明的产物清单（可选） */
  artifacts?: WorkerArtifactTrace;
  /** worker 声明的验证证据（可选） */
  verification?: WorkerVerificationItem[];
  /** worker 给 Leader 的后续建议（可选） */
  next_steps?: string[];
  /** worker 发现的新阻塞依赖（Leader 用于更新依赖或创建后续任务，不触发自动派发） */
  blocked_by_discovery?: string[];
  /** worker 明确请求 Leader 做协调/依赖处理 */
  needs_leader_coordination?: boolean;
  /** worker 声明的证据/资源引用（可选），例如 MCP resource URI、URL、截图或报告路径 */
  evidence_refs?: string[];
  /** worker 声明的契约遵守证明（每个任务都应提供） */
  contract_compliance?: WorkerContractComplianceProof;
  /** 框架自动采集的工具产物轨迹（可选） */
  toolTrace?: WorkerArtifactTrace;
  /** 投机分支 winner 验证证据（可选）。声明 winner 时必须来自 Goal-7 通过结果。 */
  speculativeWinner?: SpeculativeWinnerEvidence;
}

export interface TaskFailedPayload {
  kind: 'task_failed';
  taskId: string;
  /** TaskBoard 执行代际；Leader 用它丢弃重开/重派前的 late receipt。 */
  taskRunGeneration?: number;
  error: string;
  diagnostics?: WorkerFailureDiagnostics;
}

export interface PermissionRequestControlPayload extends PermissionRequestPayload {
  kind: 'permission_request';
}

export interface PermissionResponsePayload {
  kind: 'permission_response';
  requestId: string;
  decision: 'approved' | 'rejected';
}

export interface AgentHealthCriticalPayload {
  kind: 'agent_health_critical';
  taskId: string;
  agentId: string;
  agentName: string;
  status: string;
  action: string;
  reason: string;
  stallSeconds?: number;
}

export interface WorkerRecoveryPayload {
  kind: 'worker_recovery';
  taskId: string;
  taskRunGeneration?: number;
  agentId: string;
  agentName: string;
  roleType?: string;
  category: RuntimeRecoveryRecord['category'];
  faultClass: RecoveryFaultClass;
  /**
   * 触发恢复的 LLM 错误细分（request_timeout / network_error / connect_timeout /
   * stream_timeout 等）。仅 LLM 重试耗尽导致的恢复才填充。让被唤醒的 Leader 结构化
   * 判断「这是瞬时 provider 超时（系统已自愈/重派）」而非凭文本猜测。
   */
  llmErrorKind?: LLMErrorKind;
  status: RuntimeRecoveryRecord['status'];
  recoveryAction: RuntimeRecoveryRecord['recoveryAction'];
  reason: string;
  attempt: number;
  lineId: string;
  lastActivityAt?: number;
  /**
   * 系统是否已为本次恢复自主排定 worker 重启/重派
   * （maybeAutoRetryRecoveringWorker 返回 true）。透传给 Leader，使其 directive
   * 区分「系统已自动重派 → 验证，勿重复 dispatch」与「需 Leader 接管」。
   */
  autoRetryScheduled?: boolean;
  diagnostics?: WorkerFailureDiagnostics;
}

export type AgentControlPayload =
  | TaskCompletePayload
  | TaskFailedPayload
  | PermissionRequestControlPayload
  | PermissionResponsePayload
  | AgentHealthCriticalPayload
  | WorkerRecoveryPayload;

export function createTaskCompletePayload(
  taskId: string,
  result: string,
  structured?: {
    summary?: string;
    verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
    artifacts?: WorkerArtifactTrace;
    verification?: WorkerVerificationItem[];
    next_steps?: string[];
    blocked_by_discovery?: string[];
    needs_leader_coordination?: boolean;
    evidence_refs?: string[];
    contract_compliance?: WorkerContractComplianceProof;
    toolTrace?: WorkerArtifactTrace;
    taskRunGeneration?: number;
    speculativeWinner?: SpeculativeWinnerEvidence;
  },
): TaskCompletePayload {
  return {
    kind: 'task_complete',
    taskId,
    ...(typeof structured?.taskRunGeneration === 'number' ? { taskRunGeneration: structured.taskRunGeneration } : {}),
    result,
    ...(structured?.summary ? { summary: structured.summary } : {}),
    ...(structured?.verdict ? { verdict: structured.verdict } : {}),
    ...(structured?.artifacts ? { artifacts: structured.artifacts } : {}),
    ...(structured?.verification ? { verification: structured.verification } : {}),
    ...(structured?.next_steps ? { next_steps: structured.next_steps } : {}),
    ...(structured?.blocked_by_discovery ? { blocked_by_discovery: structured.blocked_by_discovery } : {}),
    ...(structured?.needs_leader_coordination ? { needs_leader_coordination: structured.needs_leader_coordination } : {}),
    ...(structured?.evidence_refs ? { evidence_refs: structured.evidence_refs } : {}),
    ...(structured?.contract_compliance ? { contract_compliance: structured.contract_compliance } : {}),
    ...(structured?.toolTrace ? { toolTrace: structured.toolTrace } : {}),
    ...(structured?.speculativeWinner ? { speculativeWinner: structured.speculativeWinner } : {}),
  };
}

export function createTaskFailedPayload(
  taskId: string,
  error: string,
  structured?: { taskRunGeneration?: number; diagnostics?: WorkerFailureDiagnostics },
): TaskFailedPayload {
  return {
    kind: 'task_failed',
    taskId,
    ...(typeof structured?.taskRunGeneration === 'number' ? { taskRunGeneration: structured.taskRunGeneration } : {}),
    error,
    ...(structured?.diagnostics ? { diagnostics: structured.diagnostics } : {}),
  };
}

export function createPermissionRequestPayload(
  payload: PermissionRequestPayload,
): PermissionRequestControlPayload {
  return {
    kind: 'permission_request',
    ...payload,
  };
}

export function createPermissionResponsePayload(
  requestId: string,
  decision: 'approved' | 'rejected',
): PermissionResponsePayload {
  return {
    kind: 'permission_response',
    requestId,
    decision,
  };
}

export function createWorkerRecoveryPayload(
  input: WorkerRecoveryPayload,
): WorkerRecoveryPayload {
  return {
    kind: 'worker_recovery',
    taskId: input.taskId,
    ...(typeof input.taskRunGeneration === 'number' ? { taskRunGeneration: input.taskRunGeneration } : {}),
    agentId: input.agentId,
    agentName: input.agentName,
    ...(input.roleType ? { roleType: input.roleType } : {}),
    category: input.category,
    faultClass: input.faultClass,
    ...(input.llmErrorKind ? { llmErrorKind: input.llmErrorKind } : {}),
    status: input.status,
    recoveryAction: input.recoveryAction,
    reason: input.reason,
    attempt: input.attempt,
    lineId: input.lineId,
    ...(typeof input.lastActivityAt === 'number' ? { lastActivityAt: input.lastActivityAt } : {}),
    ...(typeof input.autoRetryScheduled === 'boolean' ? { autoRetryScheduled: input.autoRetryScheduled } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  };
}

function isTaskCompletePayload(value: unknown): value is TaskCompletePayload {
  return !!value &&
    typeof value === 'object' &&
    (value as TaskCompletePayload).kind === 'task_complete' &&
    typeof (value as TaskCompletePayload).taskId === 'string' &&
    typeof (value as TaskCompletePayload).result === 'string';
}

function isTaskFailedPayload(value: unknown): value is TaskFailedPayload {
  return !!value &&
    typeof value === 'object' &&
    (value as TaskFailedPayload).kind === 'task_failed' &&
    typeof (value as TaskFailedPayload).taskId === 'string' &&
    typeof (value as TaskFailedPayload).error === 'string';
}

function isPermissionRequestControlPayload(value: unknown): value is PermissionRequestControlPayload {
  return !!value &&
    typeof value === 'object' &&
    (value as PermissionRequestControlPayload).kind === 'permission_request' &&
    typeof (value as PermissionRequestControlPayload).requestId === 'string' &&
    typeof (value as PermissionRequestControlPayload).toolName === 'string' &&
    typeof (value as PermissionRequestControlPayload).reason === 'string';
}

function isPermissionResponsePayload(value: unknown): value is PermissionResponsePayload {
  return !!value &&
    typeof value === 'object' &&
    (value as PermissionResponsePayload).kind === 'permission_response' &&
    typeof (value as PermissionResponsePayload).requestId === 'string' &&
    (((value as PermissionResponsePayload).decision) === 'approved' ||
      ((value as PermissionResponsePayload).decision) === 'rejected');
}

function isAgentHealthCriticalPayload(value: unknown): value is AgentHealthCriticalPayload {
  return !!value &&
    typeof value === 'object' &&
    (value as AgentHealthCriticalPayload).kind === 'agent_health_critical' &&
    typeof (value as AgentHealthCriticalPayload).taskId === 'string' &&
    typeof (value as AgentHealthCriticalPayload).agentId === 'string' &&
    typeof (value as AgentHealthCriticalPayload).agentName === 'string' &&
    typeof (value as AgentHealthCriticalPayload).status === 'string' &&
    typeof (value as AgentHealthCriticalPayload).action === 'string' &&
    typeof (value as AgentHealthCriticalPayload).reason === 'string';
}

function isWorkerRecoveryPayload(value: unknown): value is WorkerRecoveryPayload {
  return !!value &&
    typeof value === 'object' &&
    (value as WorkerRecoveryPayload).kind === 'worker_recovery' &&
    typeof (value as WorkerRecoveryPayload).taskId === 'string' &&
    typeof (value as WorkerRecoveryPayload).agentId === 'string' &&
    typeof (value as WorkerRecoveryPayload).agentName === 'string' &&
    typeof (value as WorkerRecoveryPayload).category === 'string' &&
    typeof (value as WorkerRecoveryPayload).faultClass === 'string' &&
    typeof (value as WorkerRecoveryPayload).status === 'string' &&
    typeof (value as WorkerRecoveryPayload).recoveryAction === 'string' &&
    typeof (value as WorkerRecoveryPayload).reason === 'string' &&
    typeof (value as WorkerRecoveryPayload).attempt === 'number' &&
    typeof (value as WorkerRecoveryPayload).lineId === 'string';
}

/**
 * 解析 Agent 控制消息（结构化 payload）。
 * 仅支持结构化格式，不再支持 legacy pipe-delimited 字符串。
 */
export function readAgentControlMessage(
  message: Pick<BusMessage, 'type' | 'payload'>,
): AgentControlPayload | null {
  if (message.type === 'task_complete' && isTaskCompletePayload(message.payload)) {
    return message.payload;
  }
  if (message.type === 'task_failed' && isTaskFailedPayload(message.payload)) {
    return message.payload;
  }
  if (message.type === 'permission_request' && isPermissionRequestControlPayload(message.payload)) {
    return message.payload;
  }
  if (message.type === 'permission_response' && isPermissionResponsePayload(message.payload)) {
    return message.payload;
  }
  if (message.type === 'agent_health_critical' && isAgentHealthCriticalPayload(message.payload)) {
    return message.payload;
  }
  if (message.type === 'worker_recovery' && isWorkerRecoveryPayload(message.payload)) {
    return message.payload;
  }

  return null;
}

export function isTaskTerminalControlMessage(
  message: Pick<BusMessage, 'type' | 'payload'>,
): boolean {
  const parsed = readAgentControlMessage(message);
  return parsed?.kind === 'task_complete' || parsed?.kind === 'task_failed';
}

/**
 * 该 worker→leader 总线消息是否 "actionable"（值得 Leader 起一轮 leaderThinkAndAct）。
 *
 * actionable：任务终态（task_complete/task_failed）、权限请求、健康严重事件、
 *   Eternal goal 更新系统事件（eternal_goal_set），以及 worker 求助
 *   （help/error/flag — 经 send_message 走 type='user_intervention'）。
 * 非 actionable：纯进展汇报（report/finding — 走 type='message'）。这类只应并入
 *   Leader 上下文，不为每条 worker 汇报单独 ping LLM，否则 Leader 即便决定"持续监控、
 *   不介入"也会被每条进展刷起一轮 think。
 *
 * 注意：调用方需自行先排除"来自真实用户的 user_intervention"（那是用户输入，单独处理）。
 * 这里的 type='user_intervention' 专指 worker 自己经 send_message 升级的求助。
 */
export function isActionableAgentBusMessage(
  message: Pick<BusMessage, 'type' | 'payload'>,
): boolean {
  const controlMessage = readAgentControlMessage(message);
  if (controlMessage?.kind === 'permission_response') {
    return false;
  }
  if (controlMessage !== null) {
    // task_complete / task_failed / permission_request / agent_health_critical / worker_recovery
    return true;
  }
  // Eternal goal 是系统驱动的目标模式事件：必须唤醒 Leader 立即进入 Goal Patrol，
  // 不能像普通 report/finding 那样只并入上下文，否则保存/修改 goal 后不会请求 LLM。
  if (message.type === 'eternal_goal_set') {
    return true;
  }
  // worker 求助（help/error/flag）经 SendMessageTool 升级为 user_intervention
  return message.type === 'user_intervention';
}
