/**
 * LeaderExecutionController
 * Manages execution mode routing and active tool definitions for Leader.
 */

import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import type { TaskBoard } from '../core/TaskBoard.js';
import type { TokenTracker } from './BaseAgentRuntime.js';
import type { LeaderDirectToolsExecutor } from './LeaderDirectTools.js';
import type { ToolDefinition } from '../llm/types.js';
import { LEADER_META_TOOLS, BUGHUNT_TOOLS, OFFICE_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../contracts/constants/leaderToolDefinitions.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { parseBlueprint, isBlueprintActive } from '../core/ProjectBlueprint.js';
import { filterLeaderTools } from './leader/LeaderToolGates.js';
import { resolveModeRuntimeProjection, resolveEffectiveRoutePreference } from '../core/ModeRuntimeProjection.js';
import type { CapabilityIntentProfile } from '../contracts/types/Autonomy.js';

export type LeaderExecutionMode = 'direct' | 'hybrid' | 'delegate';

/**
 * 路由决策触发来源（确定性、结构化、可被测试断言）。
 * chooseExecutionRoute 内每个分支对应一个 trigger，不靠关键词匹配。
 */
export type RouteTrigger =
  | 'running_agents_present'
  | 'dispatchable_or_context_pressure'
  | 'default_autonomous'
  | 'user_override_direct'
  | 'user_override_delegate'
  | 'project_blueprint_active';

export interface RouteDecision {
  mode: LeaderExecutionMode;
  reason: string;
  /** 触发该决策的确定性来源（A4 可审查 trace） */
  trigger?: RouteTrigger;
  /** 决策时刻的工作快照（确定性结构化字段，可断言路由为何发生） */
  workSnapshot?: RouteWorkSnapshot;
}

/**
 * 路由决策时刻的工作状态快照（A4）。全部来自真实信号源（board 计数 / token 总量 /
 * running agent 布尔），不含 confidence / 关键词。
 */
export interface RouteWorkSnapshot {
  /** dispatchable（就绪待派发）任务数 */
  dispatchableCount: number;
  /** 运行中 worker 数 */
  runningAgentsCount: number;
  /** 当前会话累计 token（路由判定用到上下文压力阈值时记录） */
  sessionTotalTokens: number;
}

export interface LeaderExecutionControllerOptions {
  sessionId: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  directToolsExecutor: LeaderDirectToolsExecutor;
  hasRunningAgents: () => boolean;
  getBoard: () => TaskBoard;
  getTracker: () => TokenTracker;
  getExecutionMode: () => LeaderExecutionMode;
  setExecutionMode: (mode: LeaderExecutionMode) => void;
  getExecutionReason: () => string;
  setExecutionReason: (reason: string) => void;
  /** 黑板是否就绪（graph 已 init）。用于门控 Leader 的黑板写入工具暴露。 */
  getBlackboardEnabled?: () => boolean;
}

export class LeaderExecutionController {
  private sessionId: string;
  private db: DatabaseManager;
  private emitter: EventEmitter;
  private directToolsExecutor: LeaderDirectToolsExecutor;
  private hasRunningAgents: () => boolean;
  private getBoard: () => TaskBoard;
  private getTracker: () => TokenTracker;
  private getExecutionMode: () => LeaderExecutionMode;
  private setExecutionMode: (mode: LeaderExecutionMode) => void;
  private getExecutionReason: () => string;
  private setExecutionReason: (reason: string) => void;
  private getBlackboardEnabled?: () => boolean;
  private bughuntMode: boolean = false;
  private officeMode: boolean = false;
  private workflowMode: boolean = false;

  constructor(opts: LeaderExecutionControllerOptions) {
    this.sessionId = opts.sessionId;
    this.db = opts.db;
    this.emitter = opts.emitter;
    this.directToolsExecutor = opts.directToolsExecutor;
    this.hasRunningAgents = opts.hasRunningAgents;
    this.getBoard = opts.getBoard;
    this.getTracker = opts.getTracker;
    this.getExecutionMode = opts.getExecutionMode;
    this.setExecutionMode = opts.setExecutionMode;
    this.getExecutionReason = opts.getExecutionReason;
    this.setExecutionReason = opts.setExecutionReason;
    this.getBlackboardEnabled = opts.getBlackboardEnabled;
    this.bughuntMode = this.db.getSessionState(this.sessionId, SESSION_KEYS.BUGHUNT_MODE_ACTIVE) === 'true';
    this.officeMode = this.db.getSessionState(this.sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
    this.workflowMode = this.db.getSessionState(this.sessionId, SESSION_KEYS.WORKFLOW_MODE_ACTIVE) === 'true';
  }

  private shouldExposeRecordCapabilityIntentTool(): boolean {
    const currentRaw = this.db.getSessionState(this.sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID);
    const recordedRaw = this.db.getSessionState(this.sessionId, SESSION_KEYS.CAPABILITY_INTENT_TURN_ID);
    const currentTurnId = typeof currentRaw === 'number' ? currentRaw : typeof currentRaw === 'string' ? Number(currentRaw) : NaN;
    const recordedTurnId = typeof recordedRaw === 'number' ? recordedRaw : typeof recordedRaw === 'string' ? Number(recordedRaw) : NaN;
    if (!Number.isFinite(currentTurnId) || currentTurnId <= 0) return true;
    return !Number.isFinite(recordedTurnId) || Math.trunc(recordedTurnId) !== Math.trunc(currentTurnId);
  }

  getActiveToolDefinitions(): ToolDefinition[] {
    const directDefinitions = this.directToolsExecutor.getDefinitions();

    // 工具抑制检查：当用户明确禁止工具调用时，隐藏所有元工具
    // 但 record_capability_intent 豁免：它是元认知工具，用于理解用户意图，
    // 即使用户说"不要调用工具"也需要先识别意图才能理解真实需求。
    const toolUseSuppressed = this.db.getSessionState(this.sessionId, SESSION_KEYS.TOOL_USE_SUPPRESSION_TURN_ID);
    const currentTurnId = this.db.getSessionState(this.sessionId, SESSION_KEYS.CURRENT_USER_TURN_ID);
    const isToolUseSuppressed =
      typeof toolUseSuppressed === 'number' && typeof currentTurnId === 'number' &&
      toolUseSuppressed > 0 && toolUseSuppressed === currentTurnId;

    let metaTools: ToolDefinition[];
    if (isToolUseSuppressed) {
      // 工具抑制时：只保留 record_capability_intent（元认知层豁免）
      metaTools = LEADER_META_TOOLS.filter((tool) => tool.function.name === 'record_capability_intent');
    } else {
      // 正常情况：按轮次判断是否暴露 record_capability_intent
      metaTools = this.shouldExposeRecordCapabilityIntentTool()
        ? LEADER_META_TOOLS
        : LEADER_META_TOOLS.filter((tool) => tool.function.name !== 'record_capability_intent');
    }

    const modes = resolveModeRuntimeProjection({
      sessionId: this.sessionId,
      db: this.db,
      blackboardAvailable: this.getBlackboardEnabled ? this.getBlackboardEnabled() : false,
    });
    return filterLeaderTools({
      candidates: [...metaTools, ...directDefinitions],
      bughuntTools: BUGHUNT_TOOLS,
      officeToolNames: OFFICE_TOOL_NAMES,
      workflowToolNames: WORKFLOW_TOOL_NAMES,
      bughuntMode: this.bughuntMode,
      officeMode: this.officeMode,
      workflowMode: this.workflowMode,
      blackboardEnabled: this.getBlackboardEnabled ? this.getBlackboardEnabled() : true,
      modes,
    });
  }

  setBugHuntMode(active: boolean): void {
    if (this.bughuntMode === active) return;
    this.bughuntMode = active;
    this.db.setSessionState(this.sessionId, SESSION_KEYS.BUGHUNT_MODE_ACTIVE, String(active));
  }

  isBughuntMode(): boolean {
    return this.bughuntMode;
  }

  setOfficeMode(active: boolean): void {
    if (this.officeMode === active) return;
    this.officeMode = active;
    this.db.setSessionState(this.sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE, String(active));
  }

  isOfficeMode(): boolean {
    return this.officeMode;
  }

  setWorkflowMode(active: boolean): void {
    if (this.workflowMode === active) return;
    this.workflowMode = active;
    this.db.setSessionState(this.sessionId, SESSION_KEYS.WORKFLOW_MODE_ACTIVE, String(active));
  }

  isWorkflowMode(): boolean {
    return this.workflowMode;
  }

  setExecutionRoute(decision: RouteDecision): void {
    const changed =
      this.getExecutionMode() !== decision.mode ||
      this.getExecutionReason() !== decision.reason;

    this.setExecutionMode(decision.mode);
    this.setExecutionReason(decision.reason);

    this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_EXECUTION_MODE, decision.mode);
    this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_EXECUTION_REASON, decision.reason);
    if (changed) {
      const existing = this.db.getSessionState(this.sessionId, SESSION_KEYS.LEADER_ROUTE_HISTORY);
      const history = Array.isArray(existing) ? existing as Array<Record<string, unknown>> : [];
      // A4: ROUTE_HISTORY 扩为结构化对象（mode/reason/trigger/workSnapshot），
      // 全部字段来自确定性信号源，可被测试断言、可回放审计。
      history.push({
        timestamp: Date.now() / 1000,
        mode: decision.mode,
        reason: decision.reason,
        trigger: decision.trigger ?? null,
        workSnapshot: decision.workSnapshot ?? null,
      });
      this.db.setSessionState(this.sessionId, SESSION_KEYS.LEADER_ROUTE_HISTORY, history.slice(-25));
    }

    if (changed) {
      this.emitter.emit('leader:route', {
        sessionId: this.sessionId,
        mode: decision.mode,
        reason: decision.reason,
        trigger: decision.trigger ?? null,
        workSnapshot: decision.workSnapshot ?? null,
      });
    }
  }

  /**
   * Pick the execution route for the next round.
   *
   * T-11: an optional `userIntent` signal from `IntentClassifier` lets us
   * downgrade auto-routing when the user is clearly asking a read-only or
   * design-only question. Conservative policy:
   *   - `userIntent = 'diagnostic'` AND no explicit user route preference
   *     AND no blueprint AND no running agents → pick `direct` so the Leader
   *     handles the read-only request itself, instead of falling through to
   *     `hybrid` (which historically allowed the leader to escalate to
   *     worker dispatch on benign "梳理 / 看看" turns — see T-7 evidence).
   *   - `userIntent = 'diagnostic'` AND user route preference is 'delegate'
   *     → still respect the explicit user override; the user's choice wins
   *     over the intent downgrade.
   *   - any other intent → existing routing logic unchanged.
   *
   * The classifier is *advisory*: the trigger enum below does not gain a new
   * variant — we keep using the existing triggers and put the rationale in
   * `reason`. This preserves the audit shape T-7 verified.
   */
  chooseExecutionRoute(intentProfile?: CapabilityIntentProfile | null): RouteDecision {
    // 确定性工作快照（来自真实信号源：board 计数 / token 总量 / running 布尔）
    const dispatchableCount = this.getBoard().getDispatchable().length;
    const runningAgentsCount = this.hasRunningAgents() ? 1 : 0;
    const sessionTotalTokens = this.getTracker().getSessionTotal();
    const workSnapshot: RouteWorkSnapshot = { dispatchableCount, runningAgentsCount, sessionTotalTokens };

    // 硬约束：已有运行中 worker，Leader 必须委派协调在途工作——用户偏好不可覆盖此约束。
    if (this.hasRunningAgents()) {
      return {
        mode: 'delegate',
        reason: '当前已有运行中的 worker，Leader 进入委派主控模式以协调和验收在途工作。',
        trigger: 'running_agents_present',
        workSnapshot,
      };
    }

    // 用户执行路由偏好（'hybrid' 历史遗留归一化为 'auto'）。direct/delegate 让偏好生效，
    // auto/undefined 落到下方算法。归一化复用 resolveEffectiveRoutePreference 单一事实源，
    // 与 LeaderContextBuilder.buildRoutePreferenceSection 同源，避免两处漂移。
    const pref = resolveEffectiveRoutePreference(
      this.db.getSessionState(this.sessionId, SESSION_KEYS.EXECUTION_ROUTE_OVERRIDE),
    );
    if (pref === 'direct') {
      return {
        mode: 'direct',
        reason: '用户偏好：本轮由 Leader 自己执行。',
        trigger: 'user_override_direct',
        workSnapshot,
      };
    }
    if (pref === 'delegate') {
      return {
        mode: 'delegate',
        reason: '用户偏好：本轮优先委派助手。',
        trigger: 'user_override_delegate',
        workSnapshot,
      };
    }

    // 项目蓝图锁定:会话有未完成的项目蓝图(复杂项目)→ 倾向 delegate(优先委派),
    // 防止介入后 Leader 退回 default_autonomous 自己干大型实现。确定性:蓝图 active 判定。
    // 用户显式 direct 偏好已在上方优先返回;无蓝图时此分支 no-op,不影响简单任务路由。
    const blueprint = parseBlueprint(this.db.getSessionState(this.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));
    if (blueprint && isBlueprintActive(blueprint, (taskId) => {
      const task = this.getBoard().getTask(taskId);
      return task?.status === 'terminal';
    })) {
      return {
        mode: 'delegate',
        reason: '当前会话有未完成的项目蓝图(复杂项目),Leader 优先委派:用 create_task+dispatch 推进实现,而非自己干大型实现。',
        trigger: 'project_blueprint_active',
        workSnapshot,
      };
    }

    // T-11 conservative downgrade: a clearly diagnostic request (read-only /
    // "what's the current state?" / "explain") with no explicit user route
    // preference and no project blueprint should not auto-escalate. Send it
    // to the Leader as a direct answer rather than letting it fall through
    // to hybrid (which historically let "梳理 / 看看" prompts promote to
    // S2/S3 worker dispatch — T-7). Explicit user override (direct/delegate)
    // is consumed above; blueprint promotion is consumed below; this is the
    // last branch before default.
    const readOnlyProfile = intentProfile?.scope.kind === 'read_only'
      || Boolean(intentProfile && !intentProfile.grants.some((grant) => grant !== 'read'));
    if (
      readOnlyProfile &&
      dispatchableCount === 0 &&
      sessionTotalTokens <= 120_000
    ) {
      return {
        mode: 'direct',
        reason: 'capability profile 为只读/分析范围，Leader 直接给出回答，避免无依据升级到 worker 派发。',
        trigger: 'default_autonomous',
        workSnapshot,
      };
    }

    // auto / undefined：算法自主判定（不再基于请求关键词硬编码分类）。
    if (dispatchableCount > 0 || sessionTotalTokens > 120_000) {
      return {
        mode: 'hybrid',
        reason: '当前会话已有待处理任务或上下文压力，Leader 保持自主检查和决策能力，不再由请求关键词预判模式。',
        trigger: 'dispatchable_or_context_pressure',
        workSnapshot,
      };
    }

    return {
      mode: 'hybrid',
      reason: '不再基于请求关键词硬编码分类，由 Leader 自主判断是直接处理、继续检查还是派发 worker。',
      trigger: 'default_autonomous',
      workSnapshot,
    };
  }

  setDelegateMode(reason: string): void {
    this.setExecutionRoute({
      mode: 'delegate',
      reason,
    });
  }
}
