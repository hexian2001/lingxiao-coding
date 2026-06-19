/**
 * LeaderProgressInvariant — V3
 *
 * Manages progress stagnation detection, watchdog timer, and delegates
 * eternal idle patrol to EternalLoop (unified autonomous control loop).
 *
 * Key changes from V2:
 *   - Eternal patrol no longer has a hard 10-round cap.
 *     It uses EternalLoop's exponential backoff (30s → 1m → 2m → ... → 16m max).
 *   - Blocked state escalation flows through AlertManager (no longer just displayed).
 *   - Token budget enforcement via EternalLoop.
 *   - Circuit breaker on API failures.
 *
 * Public API unchanged — LeaderAgent main loop calls checkProgressStagnation()
 * and maybeEternalIdlePatrol() as before.
 */

import type { EventEmitter } from '../core/EventEmitter.js';
import type { DatabaseManager } from '../core/Database.js';
import type { TaskBoard } from '../core/TaskBoard.js';
import type { AgentPool } from './AgentPoolRuntime.js';
import type { ChatMessage } from '../llm/types.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { leaderLogger } from '../core/Log.js';
import { readPersistedEternalGoal } from '../core/EternalGoal.js';
import {
  EternalLoop,
  createInitialEternalRuntimeSnapshot,
  type EternalLoopConfig,
  type EternalRuntimeSnapshot,
  type TokenUsage,
  type EternalLoopDeps,
  type EternalPatrolCandidate,
} from '../core/EternalLoop.js';
import { judgeEternalAction } from './runtime/EternalPatrolJudge.js';
import { getPromptCatalog } from './prompts/i18n/catalog.js';

export interface LeaderProgressInvariantDeps {
  sessionId: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  board: TaskBoard;
  pool: AgentPool;
  /** Returns true if the leader session is finished */
  isFinished: () => boolean;
  /** Returns current waitingForUser state */
  isWaitingForUser: () => boolean;
  /** Returns current pendingReview state */
  isPendingReview: () => boolean;
  /** Returns current eternalMode state */
  isEternalMode: () => boolean;
  /** Returns true if Leader is currently running (in the main loop, not idle) */
  isLeaderRunning: () => boolean;
  /** Get a snapshot of the current conversation array */
  getConversation: () => ChatMessage[];
  /** Get conversation length (cheaper than full array) */
  getConversationLength: () => number;
  /** Add and persist a message */
  addAndPersistMessage: (msg: ChatMessage) => Promise<void>;
  /** Call leaderThinkAndAct */
  leaderThinkAndAct: () => Promise<void>;
  /** Set waitingForUser */
  setWaitingForUser: (waiting: boolean) => Promise<void>;
  /** Record token usage for budget tracking */
  recordTokenUsage: (usage: TokenUsage) => void;
  /**
   * @deprecated ProjectHealthPolicy 已删除（buildHealthInput 始终返回 null，evaluate 不再被调用）。
   * 入参保留 optional 仅为兼容历史调用点，新代码请勿继续注入。
   */
  buildHealthInput?: () => unknown;
  /**
   * @deprecated 同上 — 健康驱动的 recovery 已下线，注入函数永不被调用。
   */
  executeRecoveryAction?: (action: unknown) => Promise<void>;
  /**
   * @deprecated 同上 — blocked 升级路径已下线，注入函数永不被调用。
   */
  escalateBlocked?: (decision: unknown) => Promise<void>;
  /** Dispatch ready tasks in parallel (called by EternalLoop when agents are running) */
  dispatchReadyTasks?: () => Promise<number>;
  /** Get count of ready-to-dispatch tasks (used by EternalLoop to notify Leader) */
  getReadyTaskCount?: () => number;
  /** 黑板节点/边计数；返回 null 表示黑板未就绪。喂给 EternalLoop fingerprint。 */
  getBlackboardCounts?: () => { nodes: number; edges: number } | null;
  /** scratchpad review digest，喂给 EternalLoop fingerprint。 */
  getScratchpadDigest?: () => string | null;
  /** 最近 conversation 摘要，喂给 EternalPatrolJudge */
  getRecentConversationDigest?: () => string;
  /** Judge LLM client 工厂；EternalPatrolJudge 用 */
  getEternalJudgeLlm?: () => import('../llm/ContentGenerator.js').ContentGenerator | null;
  /** Judge model name */
  getEternalJudgeModel?: () => string | null;
  /** judge 决定 yield_user 时调用，让 leader 切回等待状态 */
  yieldEternalToUser?: (reason: string) => Promise<void>;
}

export class LeaderProgressInvariant {
  /** Progress stagnation state */
  private lastProgressHash = '';
  private stagnantRoundCount = 0;
  private static readonly STAGNANT_ROUNDS_THRESHOLD = 5;

  /** Watchdog state */
  lastProgressAtMs = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly WATCHDOG_POLL_MS = 60 * 1000;         // 1 minute

  /** Eternal loop (v3 — unified autonomous control) */
  private eternalLoop: EternalLoop | null = null;

  private sessionId: string;
  private db: DatabaseManager;
  private emitter: EventEmitter;
  private board: TaskBoard;
  private pool: AgentPool;
  private isFinished: () => boolean;
  private isWaitingForUser: () => boolean;
  private isPendingReview: () => boolean;
  private isEternalMode: () => boolean;
  private isLeaderRunning: () => boolean;
  private getConversation: () => ChatMessage[];
  private getConversationLength: () => number;
  private addAndPersistMessage: (msg: ChatMessage) => Promise<void>;
  private leaderThinkAndAct: () => Promise<void>;
  private setWaitingForUser: (waiting: boolean) => Promise<void>;
  private recordTokenUsage: (usage: TokenUsage) => void;
  private dispatchReadyTasks?: () => Promise<number>;
  private getReadyTaskCount?: () => number;
  private getBlackboardCounts?: () => { nodes: number; edges: number } | null;
  private getScratchpadDigest?: () => string | null;
  private getRecentConversationDigest?: () => string;
  private getEternalJudgeLlm?: () => import('../llm/ContentGenerator.js').ContentGenerator | null;
  private getEternalJudgeModel?: () => string | null;
  private yieldEternalToUser?: (reason: string) => Promise<void>;

  /** EventEmitter unsubscribe 句柄；dispose 时逐个调用 */
  private eternalEventBindings: Array<() => void> = [];

  constructor(deps: LeaderProgressInvariantDeps) {
    this.sessionId = deps.sessionId;
    this.db = deps.db;
    this.emitter = deps.emitter;
    this.board = deps.board;
    this.pool = deps.pool;
    this.isFinished = deps.isFinished;
    this.isWaitingForUser = deps.isWaitingForUser;
    this.isPendingReview = deps.isPendingReview;
    this.isEternalMode = deps.isEternalMode;
    this.isLeaderRunning = deps.isLeaderRunning ?? (() => true);
    this.getConversation = deps.getConversation;
    this.getConversationLength = deps.getConversationLength;
    this.addAndPersistMessage = deps.addAndPersistMessage;
    this.leaderThinkAndAct = deps.leaderThinkAndAct;
    this.setWaitingForUser = deps.setWaitingForUser;
    this.recordTokenUsage = deps.recordTokenUsage;
    this.dispatchReadyTasks = deps.dispatchReadyTasks;
    this.getReadyTaskCount = deps.getReadyTaskCount;
    this.getBlackboardCounts = deps.getBlackboardCounts;
    this.getScratchpadDigest = deps.getScratchpadDigest;
    this.getRecentConversationDigest = deps.getRecentConversationDigest;
    this.getEternalJudgeLlm = deps.getEternalJudgeLlm;
    this.getEternalJudgeModel = deps.getEternalJudgeModel;
    this.yieldEternalToUser = deps.yieldEternalToUser;
    // 注：buildHealthInput / executeRecoveryAction / escalateBlocked 入参已 deprecated，
    //    ProjectHealthPolicy 整体下线后这三处不再注入；签名保留 optional 仅为兼容旧调用点。
  }

  // ─────────────────────────────────────────────────────────────────────
  // Progress Invariant (unchanged from V2)
  // ─────────────────────────────────────────────────────────────────────

  private computeProgressHash(): string {
    const tasks = this.board.getAllTasks();
    const running = this.pool.getRunning().map(a => a.name).sort().join(',');
    const stateStr = tasks.map(t => `${t.id}:${t.status}`).join('|') + '|running:' + running;
    let hash = 5381;
    for (let i = 0; i < stateStr.length; i++) {
      hash = ((hash << 5) + hash) ^ stateStr.charCodeAt(i);
      hash = hash >>> 0;
    }
    return hash.toString(16);
  }

  checkProgressStagnation(): void {
    // Leader 自身正在运行（如 LLM 调用、工具执行），不算停滞
    if (this.isLeaderRunning()) {
      this.stagnantRoundCount = 0;
      this.lastProgressAtMs = Date.now();
      return;
    }
    if (this.pool.getRunning().length > 0) {
      this.stagnantRoundCount = 0;
      return;
    }
    if (this.isWaitingForUser() || this.isPendingReview()) {
      this.stagnantRoundCount = 0;
      return;
    }

    const hash = this.computeProgressHash();
    if (hash === this.lastProgressHash) {
      this.stagnantRoundCount++;
      if (this.stagnantRoundCount >= LeaderProgressInvariant.STAGNANT_ROUNDS_THRESHOLD) {
        leaderLogger.warn(
          `[ProgressInvariant] 检测到进度停滞: 连续 ${this.stagnantRoundCount} 轮哈希不变 (${hash})`
        );
        this.emitter.emit('leader:progress_stagnant', {
          sessionId: this.sessionId,
          consecutiveStagnantRounds: this.stagnantRoundCount,
          progressHash: hash,
        });
        this.injectStagnationBreaker(this.stagnantRoundCount);
        this.stagnantRoundCount = 0;
      }
    } else {
      this.lastProgressHash = hash;
      this.stagnantRoundCount = 0;
    }
  }

  private injectStagnationBreaker(rounds: number): void {
    const breakerMsg = [
      `⚠️ [系统检测] 你已连续 ${rounds} 轮没有推进任何任务。`,
      '请立即执行以下自检：',
      '1. 检查当前 task board 状态，是否有被阻塞的任务',
      '2. 如果所有任务已完成，请调用 finish_session 结束会话',
      '3. 如果存在未解决的依赖，请打破依赖链或将问题升级为新任务',
      '4. 如果你不确定下一步，请用 ask_user 向用户确认',
      '请立即采取行动，并使用新的证据、参数或工具路径。',
    ].join('\n');

    void this.addAndPersistMessage({ role: 'system', content: breakerMsg }).catch((err) => {
      leaderLogger.warn(`[ProgressInvariant] 注入 breaker 失败: ${err instanceof Error ? err.message : String(err)}`);
    });
    leaderLogger.info('[ProgressInvariant] 已注入破局提示，重置停滞计数');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Watchdog (unchanged from V2)
  // ─────────────────────────────────────────────────────────────────────

  markProgress(): void {
    this.lastProgressAtMs = Date.now();
  }

  startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.lastProgressAtMs = Date.now();
    this.watchdogTimer = setInterval(() => {
      this.runWatchdogCheck();
    }, LeaderProgressInvariant.WATCHDOG_POLL_MS);
    this.watchdogTimer.unref?.();
    leaderLogger.debug('[Watchdog] 看门狗已启动');
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      leaderLogger.debug('[Watchdog] 看门狗已停止');
    }
  }

  runWatchdogCheck(): void {
    if (this.isFinished() || this.isWaitingForUser() || this.isPendingReview()) return;
    // Leader 自身正在运行（LLM 调用/工具执行），重置时间戳
    if (this.isLeaderRunning()) {
      this.lastProgressAtMs = Date.now();
      return;
    }

    // 智能 Agent watchdog：检查运行中的 Agent 是否有停滞
    const runningAgents = this.pool.getRunning();
    if (runningAgents.length > 0) {
      const stagnant = this.pool.getStagnantAgents();
      if (stagnant.length > 0) {
        // 有 Agent 停滞，注入诊断消息给 Leader
        const diagnostics = stagnant.map(s =>
          `  - @${s.handle.name} (task:${s.handle.taskId}): ${s.reason} (${Math.round(s.elapsedMs / 1000)}s)${s.handle.currentToolName ? ` [tool: ${s.handle.currentToolName}]` : ''}`
        ).join('\n');
        const msg = [
          `⚠️ [Agent Watchdog] 检测到 ${stagnant.length} 个 Agent 可能停滞：`,
          diagnostics,
          '建议操作：',
          '- tool_stalled: 先使用 check_agent_progress 确认当前工具/日志，再优先 nudge_agent 或 retry_agent_llm',
          '- idle_no_progress: 使用 check_agent_progress 确认状态；不能只看任务板或时间判断',
          '- heartbeat_lost: 先使用 check_agent_progress 确认心跳/最近进展；只有确认崩溃或不可恢复后才考虑 terminate_agent 并重新派发',
        ].join('\n');
        void this.addAndPersistMessage({ role: 'system', content: msg });
        this.emitter.emit('leader:watchdog_alert', {
          sessionId: this.sessionId,
          elapsedMs: stagnant[0].elapsedMs,
          thresholdMs: LeaderProgressInvariant.WATCHDOG_TIMEOUT_MS,
          intervention: `Agent stagnation: ${stagnant.map(s => `${s.handle.name}:${s.reason}`).join(', ')}`,
        });
      }
      // Agents are running (even if some stagnant), reset leader progress
      this.lastProgressAtMs = Date.now();
      return;
    }

    const elapsedMs = Date.now() - this.lastProgressAtMs;
    if (elapsedMs < LeaderProgressInvariant.WATCHDOG_TIMEOUT_MS) return;

    const intervention = `[Watchdog] Leader 已 ${Math.round(elapsedMs / 60000)} 分钟无进度推进，自动触发自检`;
    leaderLogger.warn(intervention);

    this.emitter.emit('leader:watchdog_alert', {
      sessionId: this.sessionId,
      elapsedMs,
      thresholdMs: LeaderProgressInvariant.WATCHDOG_TIMEOUT_MS,
      intervention,
    });

    const watchdogMsg = [
      `⚠️ [Watchdog] 系统检测到你已超过 ${Math.round(elapsedMs / 60000)} 分钟没有推进任何工作。`,
      '请立即：',
      '1. 检查 task board 状态（任务板状态摘要每轮已自动注入）',
      '2. 检查是否有 Agent 需要你回复',
      '3. 如果工作已完成，调用 finish_session 结束会话',
      '4. 如果遇到阻塞，向用户寻求帮助',
    ].join('\n');

    void this.addAndPersistMessage({ role: 'system', content: watchdogMsg });
    this.lastProgressAtMs = Date.now();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Eternal Patrol (V3 — delegates to EternalLoop, no hard cap)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Initialize the EternalLoop on first call.
   * Separate from constructor because it depends on being in eternal mode.
   */
  private ensureEternalLoop(): EternalLoop {
    if (!this.eternalLoop) {
      const deps: EternalLoopDeps = {
        sessionId: this.sessionId,
        db: this.db,
        emitter: this.emitter,
        board: this.board,
        isEternalMode: this.isEternalMode,
        isFinished: this.isFinished,
        isWaitingForUser: this.isWaitingForUser,
        isPendingReview: this.isPendingReview,
        hasRunningAgents: () => this.pool.getRunning().length > 0,
        getRunningAgentCount: () => this.pool.getRunning().length,
        getMaxConcurrent: () => {
          const status = this.pool.getStatus();
          return Math.max(status.total, 5);
        },
        getConversationLength: this.getConversationLength,
        getEternalGoal: () => readPersistedEternalGoal(this.db, this.sessionId),
        recordTokenUsage: this.recordTokenUsage,
        executeEternalPatrol: async (patrolNumber, totalPatrols, candidates) => {
          return await this.doEternalPatrol(patrolNumber, totalPatrols, candidates);
        },
        dispatchReadyTasks: this.dispatchReadyTasks ?? (async () => 0),
        getReadyTaskCount: this.getReadyTaskCount,
        getBlackboardCounts: this.getBlackboardCounts,
        getScratchpadDigest: this.getScratchpadDigest,
        getRecentConversationDigest: this.getRecentConversationDigest,
        getJudgeLlm: this.getEternalJudgeLlm,
        getJudgeModel: this.getEternalJudgeModel,
        judgeFn: judgeEternalAction,
        yieldToUser: this.yieldEternalToUser,
      };

      this.eternalLoop = new EternalLoop({}, deps);
      this.bindEternalListeners(this.eternalLoop);
    }
    return this.eternalLoop;
  }

  /**
   * 把外部状态变化事件转发到 EternalLoop.invalidateSilenceLock，
   * 让 silence 期间真有进展时立刻解锁。
   */
  private bindEternalListeners(loop: EternalLoop): void {
    const invalidate = (reason: string) => () => loop.invalidateSilenceLock(reason);
    const noteWorker = () => loop.noteWorkerCompletion();

    this.eternalEventBindings = [
      this.emitter.subscribe('task:completed', invalidate('task:completed')),
      this.emitter.subscribe('agent:completed', invalidate('agent:completed')),
      this.emitter.subscribe('agent:crashed', invalidate('agent:crashed')),
      this.emitter.subscribe('worker:complete', noteWorker),
      this.emitter.subscribe('worker:failed', noteWorker),
      this.emitter.subscribe('blackboard:delta', invalidate('blackboard:delta')),
      this.emitter.subscribe('team:message_sent', invalidate('team:message_sent')),
    ];
  }

  /**
   * Session 切换 / Leader 终止 / 切回 manual 模式时调用。
   * 解绑 7 类事件监听 + 重置 silence lock，避免下次切回 eternal 时复活旧 fingerprint state。
   */
  disposeEternalListeners(): void {
    for (const off of this.eternalEventBindings) {
      try { off(); } catch { /* ignore */ }
    }
    this.eternalEventBindings = [];
    // 彻底重置 EternalLoop 跨控制模式的状态：silence lock + idle streak + interval + outcome。
    // 不能只 invalidateSilenceLock，否则旧 idle backoff 会在下次切回 eternal 后继续生效。
    this.eternalLoop?.resetForControlModeSwitch();
  }

  /**
   * 切到 eternal 时调用：若 EternalLoop 已存在但 listener 因之前切回 manual 已被解绑，
   * 这里补上重新绑定；若 loop 还没建则等 maybeEternalIdlePatrol 懒创建。
   */
  rebindEternalListenersIfActive(): void {
    if (!this.eternalLoop) return; // 还没创建过 → 下一次 tick 时 ensureEternalLoop 会顺带绑定
    if (this.eternalEventBindings.length > 0) return; // 已绑过
    this.bindEternalListeners(this.eternalLoop);
  }

  /**
   * 由 LeaderAgent 主循环 / 用户消息处理点调用，主动唤醒 silence lock。
   */
  invalidateEternalSilenceLock(reason?: string): void {
    this.eternalLoop?.invalidateSilenceLock(reason);
  }

  /**
   * 主循环入口 — 替代旧 maybeEternalIdlePatrol()。
   * 委托 EternalLoop.tick() 执行统一控制回路。
   * 无硬上限：EternalLoop 的指数退避保证不会 spin。
   */
  async maybeEternalIdlePatrol(): Promise<boolean> {
    if (!this.isEternalMode()) return false;
    const loop = this.ensureEternalLoop();
    return await loop.tick();
  }

  /**
   * 执行一次 patrol（执行 prompt 注入 + LLM 调用）。
   * 返回 true 表示 LLM 执行了工具调用。
   */
  private async doEternalPatrol(
    patrolNumber: number,
    consecutiveIdle: number,
    candidates: EternalPatrolCandidate[] = [],
  ): Promise<boolean> {
    const convLenBefore = this.getConversationLength();
    const goal = readPersistedEternalGoal(this.db, this.sessionId);
    const hasGoal = Boolean(goal?.description?.trim());
    const goalLines = goal
      ? [
          '**Eternal 目标（最高优先级，不是背景偏好）**：',
          goal.description,
          '',
          '你当前处于 `/eternal <目标>` 的目标模式：职责是持续拆解、执行、验证并交付这个目标，直到目标明确完成、暂停或删除。',
          '不要把“当前没有现成任务”理解成目标结束；没有任务就创建下一步可闭环任务，或在安全边界内直接推进。',
          '所有自主研发、修 bug、补测试、写文档和派发 Agent 都必须优先服务这个目标。发现偏离时，先把方向拉回目标。',
          '',
        ]
      : [];

    const isEarlyPatrol = consecutiveIdle < 3;
    const candidatePrompt = candidates.length > 0
      ? [
          '**结构化候选任务（按 deterministic priority score 排序）**：',
          hasGoal
            ? '从以下候选任务中选择最能推进 Eternal 目标的一项执行。返回 JSON: {"chosen_task_id":"...","reason":"..."}，随后立即 dispatch 或直接执行。'
            : '从以下候选任务中选择一个执行。返回 JSON: {"chosen_task_id":"...","reason":"..."}，随后立即 dispatch 或直接执行。',
          `候选: ${JSON.stringify(candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            score: candidate.score,
            type: candidate.type,
            reason: candidate.reason,
          })))}`,
          '',
        ]
      : [];
    const patrolPrompt = isEarlyPatrol
      ? [
          hasGoal ? '[Eternal Mode — 目标完成轮次]' : '[Eternal Mode — 自主研发轮次]',
          hasGoal
            ? '用户通过 /eternal 给出了要一直完成的目标。你的职责是像目标模式一样保持承诺：围绕目标找出下一步、执行、验证、收尾。'
            : '所有已知任务已完成，系统进入自主研发状态。你的职责是持续推进项目，做真正有价值的工作。',
          '',
          ...goalLines,
          hasGoal ? '**目标推进决策框架（按优先级）**：' : '**自主研发决策框架（按优先级）**：',
          hasGoal
            ? '1. **目标差距优先**：先判断目标还缺什么证据、实现、测试或文档；缺口就是下一步任务'
            : '1. **Bug 修复优先**：扫描最近 git log、error 日志、测试失败，发现 bug 立即创建修复任务',
          hasGoal
            ? '2. **可交付闭环**：把目标拆成能创建、派发、验收的小任务；每个任务都写清验收标准'
            : '2. **功能完善**：对比已有功能与最佳实践，识别明显缺失的功能并实现',
          hasGoal
            ? '3. **验证优先**：目标相关改动必须用测试、构建、日志或代码证据证明完成'
            : '3. **技术债清理**：TODO/FIXME/HACK、类型不安全、重复代码、性能瓶颈',
          hasGoal
            ? '4. **阻塞处理**：如果目标被风险或缺口卡住，先做可验证侦察、最小修复或提出 grounded 决策'
            : '4. **测试补全**：核心逻辑覆盖不足时补充测试',
          hasGoal
            ? getPromptCatalog().leader.eternalGoal.patrolDeliveryStep
            : '5. **文档更新**：API 变更后文档未同步、缺失使用示例',
          '',
          '**决策原则**：',
          hasGoal
            ? '- 优先选择最能推进 Eternal 目标的工作，而不是泛化项目美化'
            : '- 优先选择影响面大、用户价值高的工作，而非简单的格式修复',
          hasGoal
            ? '- 每轮至少产出一个推进目标的实质动作；除非目标已有完成证据'
            : '- 每轮至少产出一个有实质内容的任务（除非项目已无改进空间）',
          '- 创建任务后立即 dispatch，以行动闭环替代纯分析',
          hasGoal
            ? '- 不重复上一轮无产出的尝试；换一个更接近目标完成的切入点'
            : '- 不重复上一轮刚完成的工作类型',
          '',
          ...candidatePrompt,
          hasGoal
            ? '发现能推进目标的工作就立即 create_task + dispatch_agent。'
            : '发现工作就立即 create_task + dispatch_agent。',
          '你也可以直接动手改代码、跑测试、修 bug，不必每次都创建任务。',
          hasGoal
            ? getPromptCatalog().leader.eternalGoal.patrolCompletionGuidanceEarly
            : '如果深度分析后确实没有高价值工作，简要说明即可。',
          '',
          `（Patrol #${patrolNumber}，已连续空闲 ${consecutiveIdle} 轮）`,
        ].join('\n')
      : [
          hasGoal ? '[Eternal Mode — 目标完成轮次]' : '[Eternal Mode — 自主研发轮次]',
          hasGoal
            ? `持续完成 Eternal 目标（Patrol #${patrolNumber}，已连续空闲 ${consecutiveIdle} 轮）。`
            : `持续推进项目（Patrol #${patrolNumber}，已连续空闲 ${consecutiveIdle} 轮）。`,
          ...goalLines,
          ...candidatePrompt,
          hasGoal
            ? '按目标推进框架寻找下一步，发现即 create_task + dispatch_agent，也可以直接动手。'
            : '按之前定义的决策框架寻找新工作，发现即 create_task + dispatch_agent，也可以直接动手。',
          hasGoal
            ? getPromptCatalog().leader.eternalGoal.patrolCompletionGuidanceLate
            : '确无高价值工作时无需执行工具，简要说明即可。',
        ].join('\n');

    await this.addAndPersistMessage({ role: 'system', content: patrolPrompt });
    await this.leaderThinkAndAct();

    // Detect tool calls from new messages
    const newMessages = this.getConversation()
      .slice(-(this.getConversationLength() - convLenBefore));
    const hadToolCalls = newMessages.some(
      (msg) => msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    );

    return hadToolCalls;
  }

  /**
   * 从 DB 恢复 EternalLoop 状态（跨 session 重启）
   */
  async hydrateEternalState(): Promise<void> {
    if (this.eternalLoop) {
      await this.eternalLoop.hydrate();
    }
  }

  /**
   * 记录 token 使用（每次 LLM 调用后）
   */
  recordTokens(usage: TokenUsage): void {
    this.recordTokenUsage(usage);
    this.eternalLoop?.recordTokens(usage);
  }

  /**
   * 记录 API 成功/失败（供 circuit breaker）
   */
  recordApiResult(success: boolean): void {
    this.eternalLoop?.recordApiResult(success);
  }

  /**
   * 获取 EternalLoop 状态（供 /doctor 诊断）
   */
  getEternalLoopState() {
    return this.eternalLoop?.state ?? null;
  }

  /**
   * 获取 EternalMode 运行时快照。不会为了观测而创建 EternalLoop，
   * 避免 runtime_state 查询产生 listener 绑定等副作用。
   */
  getEternalRuntimeSnapshot(): EternalRuntimeSnapshot {
    const goal = readPersistedEternalGoal(this.db, this.sessionId);
    return this.eternalLoop?.toRuntimeSnapshot(this.isEternalMode())
      ?? createInitialEternalRuntimeSnapshot(this.isEternalMode(), {}, Date.now(), goal);
  }
}
