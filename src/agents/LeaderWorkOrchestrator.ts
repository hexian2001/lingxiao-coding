/**
 * LeaderWorkOrchestrator
 * Manages runtime context tracking, open work recovery, session finalization,
 * and worker completion-result processing (receipt dedup + orchestration + dispatch directive).
 * Extracted from LeaderAgent.
 */

import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import type { TaskBoard } from '../core/TaskBoard.js';
import type { AgentPool } from './AgentPoolRuntime.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { ChatMessage } from '../llm/types.js';
import type { PermissionRequestPayload } from '../core/PermissionSystem.js';
import type { LeaderExecutionMode } from './LeaderExecutionController.js';
import type { LeaderBlackboard } from './LeaderBlackboard.js';
import type { OrchestrationRuntime } from './OrchestrationRuntime.js';
import type { DispatchDecisionCoordinator } from './DispatchDecisionCoordinator.js';
import type {
  WorkerArtifactTrace,
  WorkerContractComplianceProof,
  WorkerVerificationItem,
} from '../core/AgentProtocol.js';
import type { CompletionSignal } from './leader/p0Message.js';
import { RuntimeRecoveryController } from '../core/RuntimeRecoveryController.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { executeStop } from '../core/hooks/index.js';
import { leaderLogger } from '../core/Log.js';
import { normalizeTaskStatus } from '../contracts/adapters/StatusAdapter.js';
import { config as runtimeConfig } from '../config.js';
import { buildArtifactAwarenessBlock } from '../core/ArtifactAwareness.js';
import { renderContextManifest } from '../core/ContextManifest.js';
import { formatWorkerCompletion } from './leader/workerCompletionFormatter.js';
import {
  mergeAgentCompletionSignal,
  parseTaskTermination,
} from './leader/p0Message.js';

/** 回执去重集合上限（H2 幂等门的滑动窗口大小）。 */
const PROCESSED_RECEIPTS_MAX = 10_000;

/** worker 终态回执输入（processWorkerTaskResult / acceptWorkerTaskResult 共享）。 */
export interface WorkerTaskResultInput {
  taskId: string;
  taskRunGeneration?: number;
  status: 'terminal';
  exitReason: 'completed' | 'failed';
  result: string;
  agentName?: string;
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
}

export interface LeaderWorkOrchestratorDeps {
  sessionId: string;
  db: DatabaseManager;
  board: TaskBoard;
  pool: AgentPool;
  emitter: EventEmitter;
  bus: MessageBus;
  getExecutionMode: () => LeaderExecutionMode;
  /** 控制模式：自驱（运行时自驱修复）仅在 eternal 下启用，manual/默认下禁用。 */
  isEternalMode: () => boolean;
  isFinished: () => boolean;
  isWaitingForUser: () => boolean;
  setWaitingForUser: (waiting: boolean) => Promise<void>;
  isPendingReview: () => boolean;
  getPendingPermissionRequest: () => PermissionRequestPayload | null;
  getPendingUserInput: () => unknown;
  getConversation: () => ChatMessage[];
  addAndPersistMessage: (msg: ChatMessage) => Promise<void>;
  leaderThinkAndAct: () => Promise<void>;
  /** State: lastOpenWorkRecoveryFingerprint */
  getLastOpenWorkRecoveryFingerprint: () => string | null;
  setLastOpenWorkRecoveryFingerprint: (v: string | null) => void;
  /** State: openWorkRecoveryAttempts */
  getOpenWorkRecoveryAttempts: () => number;
  setOpenWorkRecoveryAttempts: (v: number) => void;
  /** State: lastOpenWorkRecoveryAtMs */
  getLastOpenWorkRecoveryAtMs: () => number;
  setLastOpenWorkRecoveryAtMs: (v: number) => void;
  /** Static open work recovery max attempts */
  openWorkRecoveryMaxAttempts: number;
  /** Worker 完成结果处理（L2）依赖回调 */
  getOrchestrationRuntime?: () => OrchestrationRuntime;
  getLeaderBlackboard?: () => LeaderBlackboard | null;
  getDispatchDecisionCoordinator?: () => DispatchDecisionCoordinator | null;
  /** 0→1: 修复策略引擎 */
  getRepairEngine?: () => import('../core/RepairStrategyEngine.js').RepairStrategyEngine | null;
  /** 0→1: 确定性验收 */
  getDeterministicAcceptance?: () => import('../core/DeterministicAcceptance.js').DeterministicAcceptance | null;
  /** 0→1: SharedLedger */
  getSharedLedger?: () => import('../core/SharedLedger.js').SharedLedger | null;
  /** 虚方法回调：persistImplementationArtifact（测试子类可覆盖，故走闭包）。 */
  persistImplementationArtifact?: (input: { taskId: string; agentName?: string; result: string }) => void;
  /** 把黑板 recentFacts 摘要 / 完成报告写入 Leader conversation（in-memory only）。 */
  addMessage?: (msg: ChatMessage) => void;
  /** bughunt 证据采集回调（best-effort）。 */
  captureBughuntWorkerEvidence?: (input: {
    taskId: string;
    status: 'terminal';
    exitReason: 'completed' | 'failed';
    result: string;
    agentName?: string;
  }) => void;
  /** Attribute task outcome to agent (AssetUsageStore，best-effort)。 */
  recordAgentOutcome?: (agentName: string | undefined, taskId: string, outcome: 'success' | 'failure') => void;
  /** pendingAgentCompletionSignals 状态访问 / 修改。 */
  getPendingAgentCompletionSignals?: () => CompletionSignal[];
  setPendingAgentCompletionSignals?: (signals: CompletionSignal[]) => void;
  /** Leader bus 名 + bus peek/remove（drain queued completion messages）。 */
  getLeaderBusName?: () => string;
  /** 软清除 waitingForUser（仅当非显式用户门时）。 */
  clearSoftWaitingForUser?: (reason: string) => Promise<boolean>;
  setDelegateMode?: (reason: string) => void;
  /** acceptWorkerTaskResult 入队（consumePending... 回灌时复用）。 */
  acceptWorkerTaskResult?: (input: WorkerTaskResultInput) => Promise<void>;
}

export class LeaderWorkOrchestrator {
  private sessionId: string;
  private db: DatabaseManager;
  private board: TaskBoard;
  private pool: AgentPool;
  private emitter: EventEmitter;
  private getExecutionMode: () => LeaderExecutionMode;
  private isEternalMode: () => boolean;
  private isFinished: () => boolean;
  private isWaitingForUser: () => boolean;
  private setWaitingForUser: (waiting: boolean) => Promise<void>;
  private isPendingReview: () => boolean;
  private getPendingPermissionRequest: () => PermissionRequestPayload | null;
  private getPendingUserInput: () => unknown;
  private getConversation: () => ChatMessage[];
  private addAndPersistMessage: (msg: ChatMessage) => Promise<void>;
  private leaderThinkAndAct: () => Promise<void>;
  private getLastOpenWorkRecoveryFingerprint: () => string | null;
  private setLastOpenWorkRecoveryFingerprint: (v: string | null) => void;
  private getOpenWorkRecoveryAttempts: () => number;
  private setOpenWorkRecoveryAttempts: (v: number) => void;
  private getLastOpenWorkRecoveryAtMs: () => number;
  private setLastOpenWorkRecoveryAtMs: (v: number) => void;
  private openWorkRecoveryMaxAttempts: number;
  private exhaustedOpenWorkRecoveryFingerprint: string | null = null;
  private recoveryController: RuntimeRecoveryController;
  private bus: MessageBus;  private deps: LeaderWorkOrchestratorDeps;


  // ─── Worker 完成结果处理（L2）状态 ───
  private getOrchestrationRuntime: () => OrchestrationRuntime;
  private getLeaderBlackboard: () => LeaderBlackboard | null;
  private getDispatchDecisionCoordinator: () => DispatchDecisionCoordinator | null;
  private persistImplementationArtifactCb: (input: { taskId: string; agentName?: string; result: string }) => void;
  private addMessageCb: (msg: ChatMessage) => void;
  private captureBughuntWorkerEvidenceCb: (input: {
    taskId: string;
    status: 'terminal';
    exitReason: 'completed' | 'failed';
    result: string;
    agentName?: string;
  }) => void;
  private recordAgentOutcomeCb: (agentName: string | undefined, taskId: string, outcome: 'success' | 'failure') => void;
  private getPendingAgentCompletionSignals: () => CompletionSignal[];
  private setPendingAgentCompletionSignals: (signals: CompletionSignal[]) => void;
  private getLeaderBusName: () => string;
  private clearSoftWaitingForUser: (reason: string) => Promise<boolean>;
  private setDelegateMode: (reason: string) => void;
  private acceptWorkerTaskResultCb: (input: WorkerTaskResultInput) => Promise<void>;

  /**
   * 已处理回执去重集合（H2 幂等门）：key = `${taskId}:${generation}:${agent}:${exitReason}`。
   * processWorkerTaskResult 在执行任何副作用（黑板投影 / orchestration / completeTask /
   * persistImplementationArtifact）之前先查此集合——同一回执已处理过则直接 return，
   * 杜绝 worker:complete 与崩溃恢复路径重复投递导致的重复落库/重复改写。
   */
  private _processedReceipts: Set<string> = new Set();
  private _processedReceiptOrder: string[] = [];

  constructor(deps: LeaderWorkOrchestratorDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this.db = deps.db;
    this.board = deps.board;
    this.pool = deps.pool;
    this.emitter = deps.emitter;
    this.getExecutionMode = deps.getExecutionMode;
    this.isEternalMode = deps.isEternalMode;
    this.isFinished = deps.isFinished;
    this.isWaitingForUser = deps.isWaitingForUser;
    this.setWaitingForUser = deps.setWaitingForUser;
    this.isPendingReview = deps.isPendingReview;
    this.getPendingPermissionRequest = deps.getPendingPermissionRequest;
    this.getPendingUserInput = deps.getPendingUserInput;
    this.getConversation = deps.getConversation;
    this.addAndPersistMessage = deps.addAndPersistMessage;
    this.leaderThinkAndAct = deps.leaderThinkAndAct;
    this.getLastOpenWorkRecoveryFingerprint = deps.getLastOpenWorkRecoveryFingerprint;
    this.setLastOpenWorkRecoveryFingerprint = deps.setLastOpenWorkRecoveryFingerprint;
    this.getOpenWorkRecoveryAttempts = deps.getOpenWorkRecoveryAttempts;
    this.setOpenWorkRecoveryAttempts = deps.setOpenWorkRecoveryAttempts;
    this.getLastOpenWorkRecoveryAtMs = deps.getLastOpenWorkRecoveryAtMs;
    this.setLastOpenWorkRecoveryAtMs = deps.setLastOpenWorkRecoveryAtMs;
    this.openWorkRecoveryMaxAttempts = deps.openWorkRecoveryMaxAttempts;
    this.recoveryController = new RuntimeRecoveryController(this.db, this.board, this.sessionId, this.emitter);
    this.bus = deps.bus;
    this.getOrchestrationRuntime = deps.getOrchestrationRuntime ?? (() => null as unknown as OrchestrationRuntime);
    this.getLeaderBlackboard = deps.getLeaderBlackboard ?? (() => null);
    this.getDispatchDecisionCoordinator = deps.getDispatchDecisionCoordinator ?? (() => null);
    this.persistImplementationArtifactCb = deps.persistImplementationArtifact ?? (() => {});
    this.addMessageCb = deps.addMessage ?? (() => {});
    this.captureBughuntWorkerEvidenceCb = deps.captureBughuntWorkerEvidence ?? (() => {});
    this.recordAgentOutcomeCb = deps.recordAgentOutcome ?? (() => {});
    this.getPendingAgentCompletionSignals = deps.getPendingAgentCompletionSignals ?? (() => []);
    this.setPendingAgentCompletionSignals = deps.setPendingAgentCompletionSignals ?? (() => {});
    this.getLeaderBusName = deps.getLeaderBusName ?? (() => '');
    this.clearSoftWaitingForUser = deps.clearSoftWaitingForUser ?? (async () => false);
    this.setDelegateMode = deps.setDelegateMode ?? (() => {});
    this.acceptWorkerTaskResultCb = deps.acceptWorkerTaskResult ?? (async () => {});
  }

  buildRuntimeStateSection(): string {
    const stats = this.board.getStats();
    const running = this.pool.getRunning();
    const dispatchable = this.board.getDispatchable();
    const recoverySnapshot = this.recoveryController.snapshot();

    const lines = [
      `tasks: dispatchableRaw=${stats.dispatchableRaw} ready=${stats.ready} blocked=${stats.blocked} running=${stats.running} terminal=${stats.terminal} (completed=${stats.completed} failed=${stats.failed}${stats.cancelled ? ` cancelled=${stats.cancelled}` : ''}${stats.timeout ? ` timeout=${stats.timeout}` : ''})`,
      `mode: ${this.getExecutionMode()}`,
      this.isWaitingForUser() ? 'waiting_for_user: true' : '',
      this.isPendingReview() ? 'pending_review: true' : '',
    ].filter(Boolean);

    if (running.length > 0) {
      lines.push(
        `running_agents: ${running.slice(0, 4).map((agent) => {
          const parts = [`@${agent.name}:${agent.taskId}`];
          const elapsed = agent.startTime ? Math.max(0, Math.floor((Date.now() - agent.startTime) / 1000)) : 0;
          if (elapsed > 0) {
            parts.push(`${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`);
          }
          if (agent.currentToolName) {
            parts.push(`[${agent.currentToolName}]`);
          }
          if (agent.lastToolResultPreview) {
            parts.push(`last="${agent.lastToolResultPreview}"`);
          }
          return parts.join(' ');
        }).join(' | ')}${running.length > 4 ? ` | +${running.length - 4} more` : ''}`,
      );
    }

    if (dispatchable.length > 0) {
      lines.push(
        `dispatchable: ${dispatchable.slice(0, 6).map((task) => `[${task.id}] ${task.subject}`).join(' | ')}${dispatchable.length > 6 ? ` | +${dispatchable.length - 6} more` : ''}`,
      );
    }

    if (recoverySnapshot.records.length > 0) {
      lines.push(
        `recovering: ${recoverySnapshot.records.slice(0, 4).map((record) => `[${record.taskId}] @${record.agentName}:${record.faultClass}->${record.recoveryAction}${record.taskStatus ? ` task=${record.taskStatus}` : ''}`).join(' | ')}${recoverySnapshot.records.length > 4 ? ` | +${recoverySnapshot.records.length - 4} more` : ''}`,
      );
    }

    return lines.join('\n');
  }

  hasNonTerminalTasks(): boolean {
    return this.board.getAllTasks().some((task) => task.status !== 'terminal');
  }

  hasExplicitUserGate(): boolean {
    return this.isPendingReview() || Boolean(this.getPendingPermissionRequest()) || this.getPendingUserInput() != null;
  }

  async maybeDriveOpenWork(): Promise<boolean> {
    // 自驱（运行时自驱修复）只属于 eternal 自治模式。manual / 默认模式下
    // Leader 不主动找活 —— 已派出的 worker 汇报、用户消息、下游派发照常，
    // 但绝不在 idle 时自行 ping LLM，杜绝关掉 eternal 后仍无限自驱。
    if (!this.isEternalMode()) {
      return false;
    }
    if (this.isFinished() || this.isPendingReview() || this.pool.getRunning().length > 0) {
      return false;
    }

    const dispatchable = this.board.getDispatchable();
    if (dispatchable.length > 0 || !this.hasNonTerminalTasks()) {
      return false;
    }

    const recoverySummary = this.getRecoveryStatusSummary();
    if (recoverySummary.blocked > 0) {
      return false;
    }

    if (this.hasExplicitUserGate()) {
      return false;
    }

    const openTasks = this.board.getAllTasks()
      .filter((task) => task.status !== 'terminal')
      .map((task) => `[${task.id}] ${task.subject} (${task.status}${task.assigned_agent ? ` @${task.assigned_agent}` : ''})`)
      .join('\n');
    const fingerprint = openTasks;

    if (fingerprint !== this.getLastOpenWorkRecoveryFingerprint()) {
      this.setLastOpenWorkRecoveryFingerprint(fingerprint);
      this.setOpenWorkRecoveryAttempts(0);
      this.exhaustedOpenWorkRecoveryFingerprint = null;
    }

    if (this.getOpenWorkRecoveryAttempts() >= this.openWorkRecoveryMaxAttempts) {
      if (this.exhaustedOpenWorkRecoveryFingerprint !== fingerprint) {
        this.exhaustedOpenWorkRecoveryFingerprint = fingerprint;
        leaderLogger.warn(`maybeDriveOpenWork 已尝试 ${this.openWorkRecoveryMaxAttempts} 次自动恢复，进入长退避巡逻，不永久停摆`);
      }
      return false;
    }

    // Backoff check BEFORE clearing waitingForUser — otherwise backoff-blocked
    // calls permanently clear the flag, causing idle LLM spam.
    const nowMs = Date.now();
    const backoffMs = Math.min(runtimeConfig.leader.idle_probe_max_wait_ms, runtimeConfig.leader.idle_probe_backoff_base_ms * Math.max(1, this.getOpenWorkRecoveryAttempts() + 1));
    if (nowMs - this.getLastOpenWorkRecoveryAtMs() < backoffMs) {
      return false;
    }

    if (this.isWaitingForUser()) {
      await this.setWaitingForUser(false);
    }

    this.emitter.emit('leader:status', {
      sessionId: this.sessionId,
      status: '自治编排中...',
    });

    this.setLastOpenWorkRecoveryAtMs(nowMs);
    this.setOpenWorkRecoveryAttempts(this.getOpenWorkRecoveryAttempts() + 1);
    const recoveryPrompt = [
      '运行时自驱修复：当前仍有未完成任务，但没有运行中的 worker，且暂时没有可调度任务。',
      '请主动检查任务板状态、依赖、失败原因或遗漏的派发动作，并选择恢复、重派、建新任务或升级决策路径继续推进。',
      '仅当确实缺少外部信息、权限批准或用户决策时，才允许 ask_user。',
      '',
      '未完成任务：',
      openTasks,
    ].join('\n');

    await this.addAndPersistMessage({ role: 'system', content: recoveryPrompt });
    await this.leaderThinkAndAct();
    return true;
  }

  reconcileRecoveringTasks(): boolean {
    return this.recoveryController.reconcile().changed;
  }

  getRecoveryStatusSummary(): {
    total: number;
    blocked: number;
    statusText?: string;
  } {
    return this.recoveryController.summary();
  }

  async maybeFinalizeCompletedSession(): Promise<boolean> {
    if (this.isFinished() || this.isPendingReview() || this.getPendingPermissionRequest() || this.getPendingUserInput() != null || this.isWaitingForUser()) {
      return false;
    }
    if (!this.board.allTerminal() || this.pool.getRunning().length > 0) {
      return false;
    }
    const tasks = this.board.getAllTasks();
    if (tasks.length === 0) {
      return false;
    }

    const completedCount = tasks.filter((task) => normalizeTaskStatus(task) === 'completed').length;
    const failedCount = tasks.filter((task) => normalizeTaskStatus(task) === 'failed').length;
    const cancelledCount = tasks.filter((task) => normalizeTaskStatus(task) === 'cancelled').length;
    const summary = `所有已建任务均为终态：共 ${tasks.length} 个任务，完成 ${completedCount} 个，失败 ${failedCount} 个，取消 ${cancelledCount} 个。等待用户下一步或 Leader 显式调用 finish_session。`;
    this.emitter.emit('leader:status', {
      sessionId: this.sessionId,
      status: summary,
    });

    if (!this.isWaitingForUser()) {
      await this.setWaitingForUser(true);
    }
    return false;
  }

  async maybeContinueFromStopHook(final: string): Promise<{
    shouldContinue: boolean;
    feedback?: string;
    signal?: { source: string; detail?: string };
  }> {
    const hookResult = await executeStop(this.sessionId, final);
    if (!hookResult.blocked && hookResult.system_messages.length === 0) {
      return { shouldContinue: false };
    }

    const feedback = hookResult.block_reason || hookResult.system_messages.join('\n').trim() || 'Stop Hook 要求继续推进当前会话。';
    return {
      shouldContinue: true,
      feedback,
      signal: { source: 'stop_hook', detail: feedback },
    };
  }

  // ─── Worker 完成结果处理（L2） ─────────────────────────────────────────

  async processWorkerTaskResult(input: WorkerTaskResultInput): Promise<void> {
    const task = this.board.getTask(input.taskId);
    if (!task) {
      return;
    }

    const currentGeneration = Number.isFinite(task.runGeneration) ? task.runGeneration : 0;
    const receiptGeneration = Number.isFinite(input.taskRunGeneration)
      ? Math.floor(input.taskRunGeneration as number)
      : currentGeneration;
    const localAgentName = input.agentName?.replace(/^[^:]+:/, '');

    if (localAgentName && task.assigned_agent && task.assigned_agent !== localAgentName) {
      // 过期归属（agent 已被重指派）：不标记 receiptKey，避免污染去重集合
      // 而误伤当前归属 agent 的真实回执。
      leaderLogger.warn(`忽略来自 @${input.agentName} 的过期任务回执 ${input.taskId}，当前归属 @${task.assigned_agent}`);
      return;
    }

    if (receiptGeneration !== currentGeneration) {
      leaderLogger.warn(
        `忽略任务 ${input.taskId} 的过期代际回执：incoming=${receiptGeneration}, current=${currentGeneration}, agent=${localAgentName || input.agentName || 'unknown'}`,
      );
      return;
    }

    // 幂等门（H2）：终态/重复回执检查前移到任何副作用之前——黑板投影
    // (handleWorkerCompletion)、orchestration、completeTask/failTask、
    // persistImplementationArtifact 都受同一门保护。
    // workerResultQueue 已串行化回执，但同一 agent 同 exitReason 的重复回执
    // （如 worker:complete 与崩溃恢复路径同时投递）若不在此短路，会重复执行
    // 上述副作用（重复落库 artifact、重复释放 Intent、重复改写黑板）。
    //
    // 判据用"本方法是否真正处理过该回执"，而非 board.status==='terminal'：
    // AgentPool 可能已先 premark 板上任务为 completed（complete-then-crash P1 修复），
    // 此时权威的 bus task_complete 作为首个真实回执仍必须被处理以覆盖结果。
    const receiptKey = `${input.taskId}:${receiptGeneration}:${localAgentName || input.agentName || ''}:${input.exitReason}`;
    if (this._processedReceipts.has(receiptKey)) {
      // 同一回执已处理：重复回执，幂等返回，不重跑任何副作用。
      return;
    }
    // 已存在冲突终态（不同 exitReason 的回执已处理过）：保留原冲突告警语义，不改写。
    const receiptPrefix = `${input.taskId}:${receiptGeneration}:${localAgentName || input.agentName || ''}:`;
    const conflicting = input.exitReason === 'completed'
      ? `${receiptPrefix}failed`
      : `${receiptPrefix}completed`;
    if (this._processedReceipts.has(conflicting)) {
      leaderLogger.warn(`忽略任务 ${input.taskId} 的冲突回执：已处理=${conflicting.split(':').at(-1)}, incoming=${input.status}/${input.exitReason}, generation=${receiptGeneration}`);
      return;
    }
    // 黑板桥接：TaskBoard 生命周期事件由 LeaderBlackboard 统一订阅 task:* 投影到 GraphBridge。
    // Worker 输出只允许写入黑板事实；不得派生新的调度决策，Leader 是唯一调度决策点。
    // 重复回执已被上方 has(receiptKey) 短路，因此此投影同样受幂等门保护。
    const leaderBlackboard = this.getLeaderBlackboard();
    const awarenessResult = input.exitReason === 'completed'
      ? buildArtifactAwarenessBlock({
          source: 'worker_completion',
          taskId: input.taskId,
          agentId: input.agentName?.replace(/^[^:]+:/, ''),
          result: input.result,
          summary: input.summary,
          artifacts: input.artifacts,
          toolTrace: input.toolTrace,
          evidenceRefs: input.evidence_refs,
          contractCompliance: input.contract_compliance,
          verification: input.verification,
          nextSteps: input.next_steps,
        })
      : input.result;

    if (input.exitReason === 'completed') {
      leaderBlackboard?.handleWorkerCompletion(input.taskId, awarenessResult);
    }

    // 通过过期归属校验后，标记本回执为已处理：保证后续同一 (taskId, exitReason)
    // 重复回执在方法入口 has(receiptKey) 处被短路，不再重跑 completeTask / persist 等副作用。
    this.markReceiptProcessed(receiptKey);

    const orchestrationVerdict = await this.getOrchestrationRuntime().handleTaskResult(
      task,
      input.exitReason,
      input.result,
      input.verdict,
    );
    const handled = orchestrationVerdict.handled;
    const accepted = orchestrationVerdict.accepted;

    if (input.exitReason === 'completed') {
      if (handled && !accepted) {
        leaderLogger.warn(`任务 ${input.taskId} 的 orchestration verdict 未通过，任务回退到可修复调度态: ${orchestrationVerdict.reason ?? 'unknown'}`);
        this.board.prepareTaskForRedispatch(input.taskId, orchestrationVerdict.reason ?? 'orchestration verdict rejected');
        leaderBlackboard?.releaseIntentForTask(input.taskId);
        return;
      }
      // P1: 当任务完成时无 orchestration 验收链路（handled=false），OrchestrationRuntime
      // 已在 handleTaskResult 中对 implement 类任务自动注入 orchestrationRunId 并触发 evaluator。
      // 此处仅记录 info 日志，不再仅 warn——auto-inject 确保了验收链路覆盖。
      if (!handled) {
        const nodeKind = task.orchestration?.nodeKind ?? 'implement';
        leaderLogger.info(
          `任务 ${input.taskId} (nodeKind=${nodeKind}) ` +
          `完成时自动注入了 orchestration 验收链路（auto-orch-${input.taskId}）。` +
          `evaluator 任务将自动创建以独立验收产出。`
        );
      }
      this.board.completeTask(input.taskId, awarenessResult);
      this.recordAgentOutcomeCb(localAgentName || input.agentName, input.taskId, 'success');
      this.persistImplementationArtifactCb({
        taskId: input.taskId,
        agentName: input.agentName,
        result: awarenessResult,
      });

    } else {
      this.board.failTask(input.taskId, input.result);
      this.recordAgentOutcomeCb(localAgentName || input.agentName, input.taskId, 'failure');
      // 0→1: RepairStrategyEngine —— 分类错误并注入修复策略建议
      try {
        const repairEngine = this.deps.getRepairEngine?.();
        if (repairEngine) {
          const classification = repairEngine.classify(input.result || '');
          const decision = repairEngine.decide(input.taskId, classification);
          if (decision.strategy !== 'escalate_to_user') {
            this.addMessageCb({
              role: 'system',
              content: [
                `[RepairStrategy] 任务 ${input.taskId} 失败分析:`,
                `  错误类型: ${classification.category} (confidence=${classification.confidence})`,
                `  修复策略: ${decision.strategy} (尝试 #${decision.priorAttempts + 1})`,
                `  指令: ${decision.instructions.split('\n')[0]}`,
                decision.isFinalAttempt ? '  ⚠ 这是最后一次尝试' : '',
              ].filter(Boolean).join('\n'),
            });
          } else {
            this.addMessageCb({
              role: 'system',
              content: `[RepairStrategy] 任务 ${input.taskId} 已耗尽修复尝试 (${decision.priorAttempts} 次)，建议上报用户。`,
            });
          }
        }
      } catch { /* repair engine is best-effort */ }
      // 黑板：任务失败时释放其持有的 Intent。
      leaderBlackboard?.releaseIntentForTask(input.taskId);
      if (handled && !accepted) {
        leaderLogger.info(`任务 ${input.taskId} 已标记失败（orchestration verdict 同样拒绝）`);
      }
    }

    // P3: 任务完成后，将黑板 recentFacts 摘要注入 Leader 上下文，辅助验收决策
    if (input.exitReason === 'completed' && leaderBlackboard?.isEnabled()) {
      try {
        const analysis = leaderBlackboard.getBlackboardAnalysis();
        if (analysis?.recentFacts && analysis.recentFacts.length > 0) {
          const factsText = analysis.recentFacts
            .map(f => `- [${f.kind}] **${f.title}**: ${f.content}`)
            .join('\n');
          this.addMessageCb({
            role: 'system',
            content: `[黑板事实摘要 · 任务 ${input.taskId} 完成后]\n${factsText}`,
          });
        }
      } catch (err) {
        leaderLogger.debug(`[Blackboard] 验收快照注入失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.captureBughuntWorkerEvidenceCb(input);
  }

  private markReceiptProcessed(receiptKey: string): void {
    if (this._processedReceipts.has(receiptKey)) return;
    this._processedReceipts.add(receiptKey);
    this._processedReceiptOrder.push(receiptKey);
    while (this._processedReceiptOrder.length > PROCESSED_RECEIPTS_MAX) {
      const evicted = this._processedReceiptOrder.shift();
      if (evicted) this._processedReceipts.delete(evicted);
    }
  }

  private completionSignalKey(signal: {
    agentName?: string;
    taskId: string;
    taskRunGeneration?: number;
    exitReason: 'completed' | 'failed';
  }): string {
    return `${signal.agentName ?? ''}\u0000${signal.taskId}\u0000${signal.taskRunGeneration ?? 'legacy'}\u0000${signal.exitReason}`;
  }

  private drainQueuedCompletionMessagesIntoSignals(): number {
    if (!this.bus) return 0;
    const queued = this.bus.peek(this.getLeaderBusName())
      .filter((message) => message.type === 'task_complete' || message.type === 'task_failed');
    const consumedIds: string[] = [];
    const signals = this.getPendingAgentCompletionSignals();
    for (const message of queued) {
      const parsed = parseTaskTermination(message);
      if (!parsed) continue;
      mergeAgentCompletionSignal(signals, message.from, parsed);
      consumedIds.push(message.id);
    }
    if (consumedIds.length > 0) {
      this.bus.removeMessages(this.getLeaderBusName(), consumedIds);
    }
    return consumedIds.length;
  }

  async buildCompletionDispatchDirective(
    justTerminatedTasks: Array<{ taskId: string; exitReason: 'completed' | 'failed' }>,
  ): Promise<string> {
    let dispatchDirective = '';

    if (justTerminatedTasks.length > 0) {
      const terminatedList = justTerminatedTasks
        .map(t => `[${t.taskId}] ${t.exitReason === 'completed' ? '已完成' : '失败'}`)
        .join('、');
      dispatchDirective += `\n\n✓ 本轮已落终态：${terminatedList}。它们已是 terminal，请据此验收、解锁后续任务或收口。`;
    }

    let readyAfterCompletion = this.board.getDispatchable();
    const coordinator = this.getDispatchDecisionCoordinator();
    if (readyAfterCompletion.length > 0 && coordinator) {
      await coordinator.notifyLeaderOfDispatchable();
      readyAfterCompletion = this.board.getDispatchable();
    }
    if (readyAfterCompletion.length > 0) {
      const list = readyAfterCompletion
        .map(t => `- [${t.id}] ${t.subject} (类型=${t.agent_type}${t.preferred_agent_name ? `, 预绑定=@${t.preferred_agent_name}` : ''})`)
        .join('\n');
      dispatchDirective += `\n\n⚠ 本次完成回执仍有 ${readyAfterCompletion.length} 个就绪任务需要 Leader 决策：\n${list}\n`
        + '强制要求：对上述每个就绪任务，要么立刻派发（建/复用 worker 调度），要么在本轮回复中逐条说明为何暂不派（依赖未真正满足 / 并发预算已满 / 需用户决策等具体可核验理由）。'
        + '就绪任务的处理口径：已解锁任务需要派发动作或具体暂缓依据；监控纪律只约束运行中的 agent。';
    } else if (this.board.allTerminal() && this.pool.getRunning().length === 0) {
      dispatchDirective += '\n\nℹ 任务板已全部终态、无运行中 agent、无新解锁就绪任务——这是收尾点：请做最终验收 / 清理 team / 给用户完整收口总结。';
    }

    return dispatchDirective;
  }

  async consumePendingAgentCompletionsIntoConversation(): Promise<boolean> {
    this.drainQueuedCompletionMessagesIntoSignals();
    const signals = this.getPendingAgentCompletionSignals();
    if (signals.length === 0) {
      return false;
    }

    const snapshot = [...signals];
    const consumedKeys = new Set<string>();
    const justTerminatedTasks: Array<{ taskId: string; exitReason: 'completed' | 'failed' }> = [];
    let combinedAgentReport = '';

    for (const signal of snapshot) {
      try {
        await this.acceptWorkerTaskResultCb({
          taskId: signal.taskId,
          taskRunGeneration: signal.taskRunGeneration,
          status: 'terminal',
          exitReason: signal.exitReason,
          result: signal.result ?? '',
          agentName: signal.agentName,
          summary: signal.summary,
          artifacts: signal.artifacts,
          verification: signal.verification,
          evidence_refs: signal.evidence_refs,
          contract_compliance: signal.contract_compliance,
          next_steps: signal.next_steps,
          blocked_by_discovery: signal.blocked_by_discovery,
          needs_leader_coordination: signal.needs_leader_coordination,
          toolTrace: signal.toolTrace,
        });
      } catch (err) {
        leaderLogger.error(`[Leader] acceptWorkerTaskResult 异常 (pending task=${signal.taskId}): ${err instanceof Error ? err.message : String(err)}`);
      }

      justTerminatedTasks.push({ taskId: signal.taskId, exitReason: signal.exitReason });
      const digest = formatWorkerCompletion(
        {
          result: signal.result ?? '',
          summary: signal.summary,
          artifacts: signal.artifacts,
          verification: signal.verification,
          evidence_refs: signal.evidence_refs,
          contract_compliance: signal.contract_compliance,
          next_steps: signal.next_steps,
          blocked_by_discovery: signal.blocked_by_discovery,
          needs_leader_coordination: signal.needs_leader_coordination,
          toolTrace: signal.toolTrace,
        },
        { agentName: signal.agentName, taskId: signal.taskId, exitReason: signal.exitReason },
      );
      combinedAgentReport += `\n${digest.block}\n`;
      consumedKeys.add(this.completionSignalKey(signal));
    }

    const remaining = this.getPendingAgentCompletionSignals().filter(
      signal => !consumedKeys.has(this.completionSignalKey(signal)),
    );
    this.setPendingAgentCompletionSignals(remaining);

    if (!combinedAgentReport.trim()) {
      return false;
    }

    await this.clearSoftWaitingForUser('pending_completion_consumption');

    let dispatchDirective = '';
    try {
      dispatchDirective = await this.buildCompletionDispatchDirective(justTerminatedTasks);
    } catch (err) {
      leaderLogger.debug(`[Leader] 计算完成后就绪任务失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.setDelegateMode('当前正在处理 worker 完成回执，Leader 进入委派验收模式。');
    const reportMsg = renderContextManifest({
      scope: 'leader',
      sessionId: this.sessionId,
      sections: [
        { title: 'Worker Completion Artifacts', content: combinedAgentReport },
        {
          title: 'Leader Verification Directive',
          content: `请评估产出并决定下一步动作。如本次任务产出了重要的架构决策、技术选型、用户偏好或关键发现，请调用 learn_soul 写入对应的项目级/用户级长期记忆。${dispatchDirective}`,
        },
      ],
    });
    this.addMessageCb({ role: 'system', content: reportMsg });
    await this.db.saveConversationMessage(this.sessionId, { role: 'system', content: reportMsg });
    this.emitter.emit('leader:status', {
      sessionId: this.sessionId,
      status: '处理 Worker 完成事件...',
    });
    return true;
  }
}
