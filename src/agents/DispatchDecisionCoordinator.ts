/**
 * DispatchDecisionCoordinator — event-driven Leader wakeup for dispatchable work.
 *
 * This module never starts workers. It only observes task/team events, keeps
 * collaboration side effects in one place, and asks the Leader to make an
 * explicit dispatch decision for every ready task.
 */

import type { TaskBoard, Task } from '../core/TaskBoard.js';
import type { DatabaseManager } from '../core/Database.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { AgentPool, AgentHandle } from './AgentPoolRuntime.js';
import type { AgentRoleRegistry } from './RoleRegistry.js';
import type { DispatchOptions as SchedDispatchOptions } from './UnifiedScheduler.js';
import { getTeamMemberRegistry, type TeamMessage } from '../core/TeamMailbox.js';
import { getRecoveryRecord } from '../core/RecoveryRecords.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { coreLogger, leaderLogger } from '../core/Log.js';
import { isGracefulShuttingDown } from '../core/RuntimeGuards.js';
import { parseBlueprint, computeBlueprintCoverage, type ProjectBlueprint } from '../core/ProjectBlueprint.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';

export interface DispatchFingerprintContext {
  collaborationMode?: string;
  routePreference?: string;
  activeTeamName?: string | null;
}

export interface DispatchDecisionCoordinatorDeps {
  sessionId: string;
  board: TaskBoard;
  emitter: EventEmitter;
  /**
   * 把「需 Leader 显式决策」的任务交回 Leader。
   * 由 LeaderAgent 注入 system 提示并触发 leaderThinkAndAct（沿用解锁提示路径）。
   */
  requestLeaderDecision: (tasks: Task[]) => void;
  getDispatchFingerprintContext?: () => DispatchFingerprintContext;
}

/**
 * dispatchScheduledTask 的依赖注入接口（搬离自 LeaderAgent.runScheduledDispatch）。
 * 把该方法体涉及的全部 LeaderAgent 状态显式收口，coordinator 不直接 import LeaderAgent。
 */
export interface ScheduledDispatchDeps {
  sessionId: string;
  db: DatabaseManager;
  roleRegistry: AgentRoleRegistry;
  pool: AgentPool;
  board: TaskBoard;
  bus: MessageBus;
  /** 当前权限摘要（用于 resolveModeRuntimeProjection） */
  permissionSummary: () => string;
  /** 黑板是否启用（影响 mode projection 的 blackboardAvailable） */
  isBlackboardEnabled: () => boolean;
  /** 当前 active team 名 */
  getActiveTeam: () => string | null;
  /** 构造 bus name 前缀 */
  sessionPrefix: (name: string) => string;
  /** 注册 agent 健康监控 */
  registerAgentHealth: (agentId: string, name: string, roleType: string) => void;
  /** worker 异常路径的 handle 终态转移（注入避免循环依赖 LeaderAgent） */
  transitionHandleToStopped: (handle: AgentHandle) => void;
}

export interface DispatchDecisionResult {
  /** 本次通知 Leader 决策的任务数 */
  needsLeader: number;
}

export class DispatchDecisionCoordinator {
  private readonly deps: DispatchDecisionCoordinatorDeps;
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;
  /** debounce：合并同一 microtask/tick 内的多次触发 */
  private scheduled = false;
  /** 防重入：notifyLeaderOfDispatchable 正在跑时，新触发只置脏标记 */
  private running = false;
  private dirty = false;
  private freshRequested = false;
  private readonly notifiedFingerprintsByTaskId = new Map<string, string>();

  constructor(deps: DispatchDecisionCoordinatorDeps) {
    this.deps = deps;
    this.subscribe();
  }

  private subscribe(): void {
    const e = this.deps.emitter;
    const trigger = (): void => this.scheduleTick();
    const clearAndTrigger = (data?: { sessionId?: string }): void => {
      if (data?.sessionId && data.sessionId !== this.deps.sessionId) return;
      this.notifiedFingerprintsByTaskId.clear();
      trigger();
    };
    this.unsubscribers.push(
      e.subscribe('task:created', trigger),
      e.subscribe('task:updated', trigger),
      e.subscribe('task:assigned', trigger),
      e.subscribe('task:completed', trigger),
      e.subscribe('task:failed', trigger),
      e.subscribe('task:cancelled', trigger),
      e.subscribe('session:collaboration_mode_changed', clearAndTrigger),
      e.subscribe('session:execution_route_changed', clearAndTrigger),
      e.subscribe('team:message_sent', (data) => {
        this.handleCollaborationMessage(data.message as TeamMessage | undefined);
        trigger();
      }),
    );
  }

  private handleCollaborationMessage(message?: TeamMessage): void {
    if (!message || message.sessionId !== this.deps.sessionId) return;
    const metadata = message.metadata;
    const intent = metadata?.intent;
    if (!intent) return;

    if (intent === 'review_request') {
      const taskId = metadata.taskId ?? metadata.sourceTaskId;
      if (!taskId || !message.toMember) return;
      const source = this.deps.board.getTask(taskId);
      if (!source) return;
      const existing = this.deps.board.getAllTasks().find((task) =>
        task.orchestration?.nodeKind === 'evaluate' &&
        task.blocked_by.includes(source.id) &&
        task.preferred_agent_name === message.toMember
      );
      if (existing) return;
      const id = this.deps.board.nextTaskId();
      this.deps.board.createTask(
        id,
        `Peer review ${source.id}: ${source.subject}`,
        message.content,
        'review',
        [source.id],
        [],
        undefined,
        JSON.stringify({ request: metadata, sourceTask: source.id }, null, 2),
        {
          preferred_agent_name: message.toMember,
          orchestration: {
            orchestrationRunId: source.orchestration?.orchestrationRunId ?? `run-${this.deps.sessionId}`,
            nodeKind: 'evaluate',
            generation: source.orchestration?.generation ?? 0,
            verdict: 'UNKNOWN',
            contract: source.orchestration?.contract,
            evaluationPolicy: source.orchestration?.evaluationPolicy ?? { peerReview: true },
            acceptance: { status: 'pending', evidenceTaskIds: [source.id] },
          },
        },
      );
      return;
    }

    if (intent === 'transfer_accept') {
      const taskId = metadata.targetTaskId ?? metadata.taskId ?? metadata.sourceTaskId;
      if (!taskId || !message.fromMember) return;
      const task = this.deps.board.getTask(taskId);
      if (!task || task.status !== 'dispatchable') return;
      try {
        this.deps.board.updateTask(task.id, { preferred_agent_name: message.fromMember });
      } catch { /* task may already be running/terminal */ }
      return;
    }

    if (intent === 'decision_record') {
      this.deps.emitter.emit('collaboration:decision_recorded', {
        sessionId: this.deps.sessionId,
        message,
      });
      return;
    }

    if (intent === 'review_result') {
      this.deps.emitter.emit('collaboration:review_recorded', {
        sessionId: this.deps.sessionId,
        message,
      });
    }

    if (intent === 'coordination_result') {
      this.deps.emitter.emit('collaboration:coordination_recorded', {
        sessionId: this.deps.sessionId,
        message,
      });
      if (metadata.verdict === 'BLOCKED') {
        this.deps.requestLeaderDecision(this.deps.board.getDispatchable());
      }
      return;
    }

    if (intent === 'review_result' && metadata.verdict && metadata.verdict !== 'PASS') {
      const taskId = metadata.taskId ?? metadata.sourceTaskId;
      if (!taskId) return;
      const source = this.deps.board.getTask(taskId);
      if (!source) return;
      const existing = this.deps.board.getAllTasks().find((task) =>
        task.orchestration?.nodeKind === 'repair' && task.blocked_by.includes(source.id)
      );
      if (existing) return;
      const id = this.deps.board.nextTaskId();
      this.deps.board.createTask(
        id,
        `Repair after peer review ${source.id}: ${source.subject}`,
        metadata.nextAction ?? message.content,
        source.agent_type || 'coding',
        [],
        [],
        undefined,
        JSON.stringify({ review: metadata, sourceTask: source.id }, null, 2),
        {
          orchestration: {
            orchestrationRunId: source.orchestration?.orchestrationRunId ?? `run-${this.deps.sessionId}`,
            nodeKind: 'repair',
            generation: (source.orchestration?.generation ?? 0) + 1,
            verdict: 'UNKNOWN',
            contract: source.orchestration?.contract,
            evaluationPolicy: source.orchestration?.evaluationPolicy,
            acceptance: { status: 'pending', evidenceTaskIds: [source.id] },
            nextAction: metadata.nextAction,
          },
        },
      );
    }
  }

  /** debounce 到下一个 microtask，合并 burst 事件 */
  private scheduleTick(): void {
    if (this.disposed) return;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.notifyLeaderOfDispatchable();
    });
  }

  /**
   * 扫描可调度任务，并交给 Leader 显式决策。
   * 对外暴露（也被 worker 终态路径 / Leader 主循环显式调用）。
   * 返回最后一轮扫描的提示摘要。
   */
  async notifyLeaderOfDispatchable(options: { fresh?: boolean } = {}): Promise<DispatchDecisionResult> {
    if (this.disposed) return { needsLeader: 0 };
    if (options.fresh) {
      this.freshRequested = true;
    }
    if (this.running) {
      this.dirty = true;
      return { needsLeader: 0 };
    }
    this.running = true;
    let last: DispatchDecisionResult = { needsLeader: 0 };
    try {
      do {
        this.dirty = false;
        last = await this.runOnce();
      } while (this.dirty && !this.disposed);
    } finally {
      this.running = false;
    }
    return last;
  }

  private async runOnce(): Promise<DispatchDecisionResult> {
    const ready = this.deps.board.getDispatchable();
    if (ready.length === 0) {
      this.notifiedFingerprintsByTaskId.clear();
      this.freshRequested = false;
      return { needsLeader: 0 };
    }

    const readyIds = new Set(ready.map((task) => task.id));
    for (const taskId of this.notifiedFingerprintsByTaskId.keys()) {
      if (!readyIds.has(taskId)) {
        this.notifiedFingerprintsByTaskId.delete(taskId);
      }
    }

    const context = this.deps.getDispatchFingerprintContext?.() ?? {};
    const forceFresh = this.freshRequested;
    this.freshRequested = false;
    const needsLeader = ready.filter((task) => {
      if (task.status !== 'dispatchable') return false;
      const fingerprint = this.buildDispatchFingerprint(task, context);
      if (!forceFresh && this.notifiedFingerprintsByTaskId.get(task.id) === fingerprint) {
        return false;
      }
      this.notifiedFingerprintsByTaskId.set(task.id, fingerprint);
      return true;
    });

    if (needsLeader.length > 0) {
      try {
        this.deps.requestLeaderDecision(needsLeader);
      } catch (err) {
        coreLogger.warn(`[DispatchDecision] requestLeaderDecision 异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { needsLeader: needsLeader.length };
  }

  private buildDispatchFingerprint(task: Task, context: DispatchFingerprintContext): string {
    return JSON.stringify({
      id: task.id,
      updatedAt: task.updated_at ?? 0,
      runGeneration: task.runGeneration ?? 0,
      subject: task.subject,
      description: task.description,
      agentType: task.agent_type,
      blockedBy: [...(task.blocked_by ?? [])].sort(),
      preferredAgentName: task.preferred_agent_name ?? '',
      orchestrationGeneration: task.orchestration?.generation ?? null,
      collaborationMode: context.collaborationMode ?? 'solo',
      routePreference: context.routePreference ?? 'auto',
      activeTeamName: context.activeTeamName ?? '',
    });
  }

  /**
   * 调度器派发 hook — 把 TaskBoard task 物化为运行中的 worker（搬离自 LeaderAgent.runScheduledDispatch）。
   *
   * 行为契约（与原实现完全一致，仅搬位置不改逻辑）：
   * - scheduler 已在 budget / 单调度入口语义上做完检查；这里只负责把 task 转成 worker。
   * - role 不存在 / 团队模式下非成员 / 任意异常 → 返回 false（scheduler 会回滚 budget）。
   * - 复用同名 worker 时继承上下文（resolvePriorAgentId）。
   * - worker 异常路径：recovery 记录覆盖则跳过终态覆写，否则 transitionToStopped + 板上 terminal/failed。
   */
  async dispatchScheduledTask(
    task: Task,
    opts: SchedDispatchOptions | undefined,
    deps: ScheduledDispatchDeps,
  ): Promise<boolean> {
    try {
      if (!deps.roleRegistry.exists(task.agent_type)) {
        leaderLogger.warn(`[Scheduler] role ${task.agent_type} not found for ${task.id}`);
        return false;
      }
      // 蓝图覆盖 gate:有未覆盖 implement 子系统时,拒绝 dispatch。
      // 把 prompt 里"缺口拦截派发"的承诺变成机器 gate(不破坏 Leader dispatch 决策权:
      // 这不是替 Leader 决定派哪个,而是强制"缺口未补齐不许开工")。
      const blueprintReject = checkBlueprintCoverageGate(task, deps);
      if (blueprintReject) {
        leaderLogger.warn(`[Scheduler] dispatch ${task.id} rejected: ${blueprintReject}`);
        return false;
      }
      const agentName = opts?.agentName || task.preferred_agent_name || `worker-${task.id.toLowerCase()}`;
      const modes = resolveModeRuntimeProjection({
        sessionId: deps.sessionId,
        db: deps.db,
        blackboardAvailable: deps.isBlackboardEnabled(),
        permissionSummary: deps.permissionSummary(),
      });
      if (modes.collaboration.mode === 'team') {
        const activeTeam = modes.collaboration.activeTeamName || deps.getActiveTeam();
        if (!activeTeam) {
          leaderLogger.warn(`[Scheduler] dispatch ${task.id} rejected: no active team for @${agentName}`);
          return false;
        }
        const rosterMember = getTeamMemberRegistry().getByName(agentName, deps.sessionId);
        if (!rosterMember || rosterMember.team !== activeTeam || rosterMember.role !== 'member') {
          leaderLogger.warn(`[Scheduler] dispatch ${task.id} rejected: @${agentName} is not a member of active team "${activeTeam}"`);
          return false;
        }
      }
      // 复用同名 worker 时继承上下文：按名字找回它上一次运行的 agentId，
      // 让对话历史（agent_conversation 按 agentId 存取）与新任务接上。
      // 全新 worker（从未派发过该名字）→ undefined，register 照常铸造新 agentId。
      const priorAgentId = deps.pool.resolvePriorAgentId(agentName);
      const handle = deps.pool.register(agentName, task.agent_type, task.id, priorAgentId);
      if (opts?.displayRole) handle.displayRole = opts.displayRole;
      if (opts?.capabilityDetails) handle.capabilityDetails = opts.capabilityDetails as AgentHandle['capabilityDetails'];
      const identity = opts?.runtimeIdentity ?? (modes.collaboration.mode === 'team'
        ? {
            visibility: 'team' as const,
            owner: 'team' as const,
            interactive: true,
            persistAcrossTurns: true,
            teamMember: agentName,
          }
        : {
            visibility: 'ephemeral' as const,
            owner: 'leader' as const,
            interactive: false,
            persistAcrossTurns: false,
            teamMember: null,
          });
      handle.visibility = identity.visibility;
      handle.owner = identity.owner;
      handle.interactive = identity.interactive;
      handle.persistAcrossTurns = identity.persistAcrossTurns;
      handle.teamMember = identity.teamMember;
      const assignedTask = deps.board.assignTask(task.id, handle.name) ?? task;
      handle.taskRunGeneration = assignedTask.runGeneration;
      deps.bus.register(deps.sessionPrefix(handle.name));
      deps.pool.prepareWorkerRuntime(handle, assignedTask);
      const taskPromise = deps.pool.runAgentWrapper(handle, assignedTask);
      handle.asyncTask = taskPromise;
      void taskPromise.catch((error) => {
        // settle guard:catch 体本身可能抛(transitionHandleToStopped/updateTaskStatus 抛 DB 错等)
        // → 产生无 handler 的二次 reject。整段包 try,保证 failure handler 永不抛漏。
        try {
          // 关停期间的在途 reject 是拆解副产物(DB 已 close 后仍在写),不是真实任务失败。
          // 用权威关停 latch 确定性判定:进程正在 graceful shutdown 时,绝不让这类 reject
          // 把任务误标 terminal/failed —— 会污染 UI("session.agent.failed: ...")并误触发重派。
          // worker 子进程的关停副产物已由 WorkerProcessEntry 投 terminalKind:'terminated' 拦在更上游;
          // 此处兜底父进程自身的关停竞态(完成回执写库等)。
          if (isGracefulShuttingDown()) {
            leaderLogger.warn(`[Scheduler] worker ${handle.name} rejected during graceful shutdown (task ${task.id}); ignoring teardown artifact: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          const failureMsg = error instanceof Error ? error.message : String(error);
          // recovery 记录覆盖 = supervisor 有意终止(health kill_restart 等)/自愈重派在先,或关停副产物。
          // 这不是硬失败:先查 recovery,命中则降级 warn 并 return,绝不以 error 级别打印
          // "worker shutdown: database closed" 这类良性串(刷屏 + 误导排查以为 DB/任务真坏)。
          // 只有「无 recovery 覆盖的真·意外失败」才走 error + terminal/failed 覆写。
          const recovery = getRecoveryRecord(deps.db, deps.sessionId, task.id);
          if (recovery && recovery.status !== 'resolved') {
            leaderLogger.warn(`[Scheduler] worker ${handle.name} rejected (task ${task.id}); covered by recovery record (supervised termination/teardown, not a hard failure): ${failureMsg}`);
            return;
          }
          leaderLogger.error(`[Scheduler] worker ${handle.name} failed: ${failureMsg}`);
          if (handle.status !== 'stopped') {
            deps.transitionHandleToStopped(handle);
            handle.exitReason = 'failed';
            handle.error = error instanceof Error ? error : new Error(failureMsg);
          }
          const t = deps.board.getTask(task.id);
          if (t && t.status !== 'terminal') {
            deps.board.updateTaskStatus(task.id, 'terminal', 'failed', `Agent ${handle.name} 异常: ${failureMsg}`);
          }
        } catch (innerErr) {
          leaderLogger.error(`[Scheduler] worker ${handle.name} failure-handler threw (task ${task.id}): ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
        }
      });
      deps.registerAgentHealth(handle.agentId, handle.name, handle.roleType);
      return true;
    } catch (err) {
      leaderLogger.error(`[Scheduler] dispatch ${task.id} threw: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) {
      try { off(); } catch { /* tolerate */ }
    }
    this.unsubscribers.length = 0;
  }
}

/**
 * 蓝图覆盖 gate:会话有未完成蓝图且存在 uncovered implement 子系统时,
 * 拒绝 dispatch 任何任务(返回拒绝原因字符串);无蓝图或覆盖完整时返回 null 放行。
 *
 * 确定性:纯集合运算(computeBlueprintCoverage),无启发式。
 * 不破坏 Leader dispatch 决策权:只强制"缺口未补齐不许开工",不替 Leader 决定派哪个。
 */
function checkBlueprintCoverageGate(task: Task, deps: ScheduledDispatchDeps): string | null {
  const raw = deps.db.getSessionState(deps.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT);
  const blueprint: ProjectBlueprint | null = parseBlueprint(raw);
  if (!blueprint) return null;
  const coverage = computeBlueprintCoverage(blueprint);
  if (coverage.readyToDispatch) return null;
  // contract 节点(架构师产契约)豁免覆盖检查:契约是实现的前置,应能在所有 implement 子系统
  // 都建好实现任务之前先派发。与 LeaderTools.ts:536 的豁免保持一致,避免双重 gate 不一致。
  if (task.orchestration?.nodeKind === 'contract') return null;
  // 有 uncovered 子系统:拒绝所有 dispatch,返回缺口清单
  const gapList = coverage.uncovered.map((s) => `${s.id}(${s.name})`).join(', ');
  return `蓝图覆盖未完整,以下 implement 子系统尚无任务: ${gapList}。请先 create_task(subsystem=<id>) 补齐,或在 define_project_blueprint 改 status=defer/not_applicable 并附 rationale。`;
}

export default DispatchDecisionCoordinator;
