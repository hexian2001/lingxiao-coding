/**
 * Leader P0 message parsing helpers
 *
 * 抽出 handleLeaderP0Message 内部的纯解析逻辑：
 * - 判定是否为应直接忽略的 user_intervention
 * - 解析 task_complete / task_failed 消息为结构化字段
 * - 在已存在的 pending signal 中追加 result（去重）
 *
 * 同时提供 LeaderP0Handler — 把 LeaderAgent 内联的 P0 消息处理函数
 * （权限直送 / completion 入队 / 紧急中断）整体搬入，原 LeaderAgent
 * 方法改为薄委托。行为/优先级/时序保持不变。
 */

import {
  isWorkerContractComplianceStatus,
  readAgentControlMessage,
  type WorkerContractComplianceProof,
} from '../../core/AgentProtocol.js';
import type { EventMap, EventEmitter } from '../../core/EventEmitter.js';
import type { LeaderPermissionManager } from '../LeaderPermissionManager.js';
import { leaderLogger } from '../../core/Log.js';

export interface P0MessageLite {
  priority?: number;
  to?: string;
  from?: unknown;
  type?: string;
  payload?: unknown;
}

/**
 * 该 P0 消息是否应该被 leader handler 处理：
 * - priority 必须为 0
 * - to 必须等于 leaderBusName
 */
export function shouldHandleP0Message(
  data: P0MessageLite,
  leaderBusName: string,
): boolean {
  return data.priority === 0 && data.to === leaderBusName;
}

/**
 * 是否是来自用户的 user_intervention（按既有行为：直接忽略，由其他通道处理）
 */
export function isUserInterventionMessage(data: P0MessageLite): boolean {
  if (data.type !== 'user_intervention') return false;
  const sender = String(data.from || '');
  return sender === 'user' || sender.endsWith(':user');
}

export interface WorkerArtifactTraceLite {
  files_created?: string[];
  files_modified?: string[];
  commands_run?: string[];
}

export interface WorkerVerificationLite {
  kind: string;
  detail: string;
  passed?: boolean;
}

export interface ParsedTaskTermination {
  taskId: string;
  taskRunGeneration?: number;
  exitReason: 'completed' | 'failed';
  result: string;
  summary?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts?: WorkerArtifactTraceLite;
  verification?: WorkerVerificationLite[];
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: WorkerContractComplianceProof;
  toolTrace?: WorkerArtifactTraceLite;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isArtifactTrace(value: unknown): value is WorkerArtifactTraceLite {
  if (!value || typeof value !== 'object') return false;
  const trace = value as WorkerArtifactTraceLite;
  return (trace.files_created === undefined || isStringList(trace.files_created)) &&
    (trace.files_modified === undefined || isStringList(trace.files_modified)) &&
    (trace.commands_run === undefined || isStringList(trace.commands_run));
}

function isVerificationList(value: unknown): value is WorkerVerificationLite[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const verification = item as WorkerVerificationLite;
    return typeof verification.kind === 'string' &&
      typeof verification.detail === 'string' &&
      (verification.passed === undefined || typeof verification.passed === 'boolean');
  });
}

function isContractComplianceProof(value: unknown): value is WorkerContractComplianceProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as WorkerContractComplianceProof;
  return typeof proof.surface === 'string' &&
    typeof proof.status === 'string' &&
    isWorkerContractComplianceStatus(proof.status) &&
    isStringList(proof.evidence) &&
    (proof.deviations === undefined || isStringList(proof.deviations));
}

/**
 * 解析 task_complete / task_failed 的 payload，返回结构化字段。
 * - taskId 缺失则返回 null
 * - completed → 取 payload.result；failed → 取 payload.error
 */
export function parseTaskTermination(data: P0MessageLite): ParsedTaskTermination | null {
  if (data.type !== 'task_complete' && data.type !== 'task_failed') {
    return null;
  }
  const payload = data.payload as unknown;
  const taskId =
    payload && typeof payload === 'object' && 'taskId' in payload
      ? String((payload as { taskId?: unknown }).taskId)
      : '';
  if (!taskId) return null;
  const exitReason: 'completed' | 'failed' = data.type === 'task_complete' ? 'completed' : 'failed';
  const payloadObject = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  const result = payloadObject
    ? String(exitReason === 'completed' ? payloadObject.result ?? '' : payloadObject.error ?? '')
    : '';
  if (exitReason === 'failed') {
    const taskRunGeneration = typeof payloadObject?.taskRunGeneration === 'number'
      ? payloadObject.taskRunGeneration
      : undefined;
    return { taskId, ...(taskRunGeneration !== undefined ? { taskRunGeneration } : {}), exitReason, result };
  }
  const taskRunGeneration = typeof payloadObject?.taskRunGeneration === 'number'
    ? payloadObject.taskRunGeneration
    : undefined;
  return {
    taskId,
    ...(taskRunGeneration !== undefined ? { taskRunGeneration } : {}),
    exitReason,
    result,
    ...(typeof payloadObject?.summary === 'string' ? { summary: payloadObject.summary } : {}),
    ...(typeof payloadObject?.verdict === 'string' && ['PASS', 'FAIL', 'BLOCKED'].includes(payloadObject.verdict.toUpperCase())
      ? { verdict: payloadObject.verdict.toUpperCase() as 'PASS' | 'FAIL' | 'BLOCKED' }
      : {}),
    ...(isArtifactTrace(payloadObject?.artifacts) ? { artifacts: payloadObject.artifacts } : {}),
    ...(isVerificationList(payloadObject?.verification) ? { verification: payloadObject.verification } : {}),
    ...(isStringList(payloadObject?.next_steps) ? { next_steps: payloadObject.next_steps } : {}),
    ...(isStringList(payloadObject?.blocked_by_discovery) ? { blocked_by_discovery: payloadObject.blocked_by_discovery } : {}),
    ...(typeof payloadObject?.needs_leader_coordination === 'boolean' ? { needs_leader_coordination: payloadObject.needs_leader_coordination } : {}),
    ...(isStringList(payloadObject?.evidence_refs) ? { evidence_refs: payloadObject.evidence_refs } : {}),
    ...(isContractComplianceProof(payloadObject?.contract_compliance) ? { contract_compliance: payloadObject.contract_compliance } : {}),
    ...(isArtifactTrace(payloadObject?.toolTrace) ? { toolTrace: payloadObject.toolTrace } : {}),
  };
}

export interface CompletionSignal {
  agentName: string;
  taskId: string;
  taskRunGeneration?: number;
  status: 'terminal';
  exitReason: 'completed' | 'failed';
  result?: string;
  summary?: string;
  verdict?: 'PASS' | 'FAIL' | 'BLOCKED';
  artifacts?: WorkerArtifactTraceLite;
  verification?: WorkerVerificationLite[];
  next_steps?: string[];
  blocked_by_discovery?: string[];
  needs_leader_coordination?: boolean;
  evidence_refs?: string[];
  contract_compliance?: WorkerContractComplianceProof;
  toolTrace?: WorkerArtifactTraceLite;
}

function mergeCompletionFields(target: CompletionSignal, source: ParsedTaskTermination): void {
  if (source.result && !target.result) target.result = source.result;
  if (source.summary && !target.summary) target.summary = source.summary;
  if (source.verdict && !target.verdict) target.verdict = source.verdict;
  if (source.artifacts && !target.artifacts) target.artifacts = source.artifacts;
  if (source.verification && !target.verification) target.verification = source.verification;
  if (source.next_steps && !target.next_steps) target.next_steps = source.next_steps;
  if (source.blocked_by_discovery && !target.blocked_by_discovery) target.blocked_by_discovery = source.blocked_by_discovery;
  if (typeof source.needs_leader_coordination === 'boolean' && typeof target.needs_leader_coordination !== 'boolean') {
    target.needs_leader_coordination = source.needs_leader_coordination;
  }
  if (source.evidence_refs && !target.evidence_refs) target.evidence_refs = source.evidence_refs;
  if (source.contract_compliance && !target.contract_compliance) target.contract_compliance = source.contract_compliance;
  if (source.toolTrace && !target.toolTrace) target.toolTrace = source.toolTrace;
}

/**
 * 把新的 termination 合并到 pending signal 列表（去重 + 补全结构化 completion 字段）。
 * 直接修改传入数组（与 LeaderAgent 既有语义一致）。
 */
export function mergeAgentCompletionSignal(
  pending: CompletionSignal[],
  agentName: string,
  parsed: ParsedTaskTermination,
): void {
  const existing = pending.find(
    (s) =>
      s.agentName === agentName &&
      s.taskId === parsed.taskId &&
      s.taskRunGeneration === parsed.taskRunGeneration &&
      s.exitReason === parsed.exitReason,
  );
  if (existing) {
    mergeCompletionFields(existing, parsed);
    return;
  }
  const signal: CompletionSignal = {
    agentName,
    taskId: parsed.taskId,
    status: 'terminal',
    exitReason: parsed.exitReason,
    result: parsed.result,
  };
  mergeCompletionFields(signal, parsed);
  if (parsed.taskRunGeneration !== undefined) signal.taskRunGeneration = parsed.taskRunGeneration;
  pending.push(signal);
}

/**
 * P0 消息分派决策（纯函数，不持状态）。
 *
 * 关键设计：**只有用户主动消息才硬中断当前 LLM 调用**。
 *
 * 历史问题：旧逻辑在 task_complete / task_failed 路径上一律调
 * interruptCurrentRound('agent_completion')，把模型正在生成的长 tool_input
 * 整轮 abort。表现为"工具参数没生成完，没触发 max_tokens，却莫名其妙重新思考"。
 *
 * 新策略：
 * - task_complete / task_failed → 'queue_completion'：仅入队 pending signal，
 *   等当前 LLM 轮自然结束。LeaderThinkingEngine 在每轮结束后已检查
 *   pendingSignals.length>0 并 break。
 * - 其他非 user_intervention 的 P0 → 'interrupt'：保留旧行为。
 * - 不应处理 / 已被消费的消息 → 'ignore'。
 */
export type LeaderP0Action =
  | { kind: 'ignore' }
  | { kind: 'queue_completion'; sender: string; parsed: ParsedTaskTermination }
  | { kind: 'interrupt'; sender: string };

export function decideLeaderP0Action(
  data: P0MessageLite,
  leaderBusName: string,
): LeaderP0Action {
  if (!shouldHandleP0Message(data, leaderBusName)) return { kind: 'ignore' };
  if (isUserInterventionMessage(data)) return { kind: 'ignore' };
  const sender = String(data.from || '');
  const parsed = parseTaskTermination(data);
  if (parsed) {
    return { kind: 'queue_completion', sender, parsed };
  }
  return { kind: 'interrupt', sender };
}

/**
 * LeaderP0Handler — LeaderAgent 内联 P0 消息处理的搬迁载体。
 *
 * 行为契约（与原 handleLeaderP0Message 完全一致，仅搬位置不改逻辑）：
 * - permission_request 直送用户审批（fast-path），不进 completion/interrupt 分支
 * - task_complete / task_failed → queue_completion：仅入队，不 abort 当前 LLM
 *   （关键：旧逻辑 abort 会丢弃模型正在生成的 partial tool_input，已废弃）
 * - 其他非 user_intervention 的 P0 → interrupt：保留旧行为
 */
export interface LeaderP0HandlerDeps {
  sessionId: string;
  leaderBusName: string;
  emitter: EventEmitter;
  permManager: LeaderPermissionManager;
  /** pending completion 信号队列（handler 直接修改，与原 LA 语义一致）。
   *  注意：主循环会用 `.filter(...)` 重新赋值该数组，所以必须走 getter 取活引用。 */
  pendingAgentCompletionSignals: () => CompletionSignal[];
  /** 是否处于 eternal 模式（影响权限请求处理） */
  isEternalMode: () => boolean;
  /** 是否正忙于一轮 LLM（决定是否中断） */
  isBusy: () => boolean;
  /** Leader 是否在等待用户（permission/completion 路径都需据此刷新状态文案） */
  waitingForUser: () => boolean;
  /** 设置委派模式文案（permission fast-path 用） */
  setDelegateMode: (reason: string) => void;
  /** 软性清掉 waitingForUser（completion 路径用） */
  clearSoftWaitingForUser: (reason: string) => Promise<boolean>;
  /** 中断当前 LLM round（紧急消息路径用） */
  interruptCurrentRound: (reason: 'user_input') => void;
  /** 设置 userInterruptPending 标志（completion 入队后清零） */
  setUserInterruptPending: (value: boolean) => void;
  /** 从 busName 还原 worker 名（permission fast-path 富化用） */
  stripSessionPrefix: (sessionId: string, agentName: string) => string;
}

export class LeaderP0Handler {
  constructor(private readonly deps: LeaderP0HandlerDeps) {}

  handle(data: EventMap['message:bus:priority']): void {
    const { deps } = this;
    const controlMessage = readAgentControlMessage(data);
    if (controlMessage?.kind === 'permission_request' && data.to === deps.leaderBusName) {
      const enriched = {
        ...controlMessage,
        workerName: controlMessage.workerName || deps.stripSessionPrefix(deps.sessionId, String(data.from || '')),
      };
      const directOutcome = deps.permManager.receiveWorkerPermissionRequest(enriched, deps.isEternalMode());
      deps.setDelegateMode(`收到来自 @${data.from} 的权限请求，已直送用户审批。`);
      leaderLogger.info(`[Permission] worker request ${controlMessage.requestId} fast-path handled: ${directOutcome.split('\n')[0]}`);
      if (deps.waitingForUser()) {
        deps.emitter.emit('leader:status', {
          sessionId: deps.sessionId,
          status: '等待权限审批...',
        });
      }
      return;
    }

    const action = decideLeaderP0Action(data, deps.leaderBusName);
    if (action.kind === 'ignore') return;

    if (action.kind === 'queue_completion') {
      mergeAgentCompletionSignal(deps.pendingAgentCompletionSignals(), action.sender, action.parsed);

      deps.setUserInterruptPending(false);
      if (deps.waitingForUser()) {
        leaderLogger.info(`[AgentCompletion] @${action.sender} 完成 ${action.parsed.taskId}，立即打断 waitingForUser 状态`);
        void deps.clearSoftWaitingForUser('priority_completion');
        deps.emitter.emit('leader:status', {
          sessionId: deps.sessionId,
          status: '处理 Worker 完成事件...',
        });
      }
      // 关键：task_complete / task_failed 不再 abort 当前 LLM。
      //   旧逻辑 interruptCurrentRound('agent_completion') 会把模型生成中的长 tool_input
      //   整轮作废 → 重发 prompt → 模型重新思考；worker 频繁完成会反复触发，表现为
      //   "工具参数没生成完，没触发 max_tokens，却莫名其妙重新思考"。
      //   LeaderThinkingLoop 在每轮 LLM 自然结束后已经检查 pendingSignals.length>0
      //   并 break，仅入队即可。
      if (deps.isBusy()) {
        leaderLogger.debug(`[AgentCompletion] @${action.sender} ${data.type}(${action.parsed.taskId}) 已排队，本轮 LLM 自然结束后处理`);
      }
      return;
    }

    // action.kind === 'interrupt'：保留旧行为（其他紧急消息）
    if (deps.isBusy()) {
      leaderLogger.info(`[Intervention] 收到来自 @${action.sender} 的紧急消息(${data.type})，中断当前 LLM round`);
      deps.interruptCurrentRound('user_input');
    }
  }
}
