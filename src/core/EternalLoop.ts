/**
 * EternalLoop — 统一自治控制回路
 *
 * 替代 LeaderProgressInvariant 的碎片化巡逻逻辑（停滞检测 / watchdog / patrol），
 * 并提供无硬上限的持续自治能力 + 成本护栏。
 *
 * 架构位置：
 *   嵌入 LeaderAgent 主循环，替换原有的 invariant.checkProgressStagnation()
 *   和 invariant.maybeEternalIdlePatrol() 调用点。
 *
 * 回路：
 *   IDLE → (interval) → CHECK → [has work?] → SKIP
 *                              → [idle?] → PATROL → THINK → WAIT → IDLE
 *
 * 护栏：
 *   - Token 预算 (per-hour cap): 超出后暂停 patrol，等待下个窗口
 *   - 指数退避 patrol 间隔: 30s → 1m → 2m → 4m → 8m → 16m (no hard cap)
 *   - 最大连续无工具调用 patrol 数: 30 (超限后以 maxInterval 持续，不放弃)
 *   - Circuit breaker: API 连续失败 N 次后暂停 patrol，等待手动干预或指数退避恢复
 */

import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import type { TaskBoard } from './TaskBoard.js';
import type { ScoredTask } from './TaskPriorityEngine.js';
import { SESSION_KEYS } from './SessionStateKeys.js';
import { leaderLogger } from './Log.js';
import { globalTracer } from './Tracing.js';
import { alertManager, type AlertManager } from './AlertManager.js';
import type { EternalGoal } from './EternalGoal.js';
import {
  decideEternalActionFromRuntimeState,
  type EternalPatrolJudgeInput,
  type EternalPatrolVerdict,
} from '../contracts/adapters/EternalPatrolPolicy.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { EternalTokenSnapshot } from '../types/canonical.js';

// ─── types ───

export interface EternalLoopConfig {
  /** Patrol 基础间隔 ms (默认 30s) */
  basePatrolIntervalMs?: number;
  /** 最大 patrol 间隔 ms (默认 960s = 16min, 指数退避上限) */
  maxPatrolIntervalMs?: number;
  /** 每小时的 token 预算 (0 = unlimited) */
  tokenBudgetPerHour?: number;
  /** API 失败 circuit breaker 阈值 (默认 8) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker 基础退避时间 ms (默认 60s) */
  circuitBreakerBaseBackoffMs?: number;
  /** Circuit breaker 最大退避时间 ms (默认 1800s = 30min) */
  circuitBreakerMaxBackoffMs?: number;
  /** 允许在 worker 运行时并行调度新任务 (默认 true) */
  parallelDispatch?: boolean;
}

// TokenUsage for EternalLoop — camelCase runtime snapshot re-exported from canonical
export type TokenUsage = EternalTokenSnapshot;

export interface EternalLoopState {
  /** 当前 patrol 间隔 (会随 idle 退避增长) */
  currentPatrolIntervalMs: number;
  /** 连续无工具调用的 patrol 次数 */
  consecutiveIdlePatrols: number;
  /** 上次 patrol 时间 */
  lastPatrolAtMs: number;
  /** 当前小时窗口内的 token 消耗 */
  currentWindowTokens: number;
  /** 当前窗口开始时间 */
  windowStartMs: number;
  /** 连续 API 失败计数 */
  consecutiveApiFailures: number;
  /** Circuit breaker 打开时间 (0 表示关闭) */
  circuitOpenUntilMs: number;
  /** 本次运行中的总 patrol 数 */
  totalPatrols: number;
  /** 上次记录的项目指纹（task/blackboard/scratchpad/conversation/worker complete count） */
  lastFingerprint: string | null;
  /** 静默锁：true 表示同 fingerprint 不再调 LLM judge / patrol */
  silenceLockEngaged: boolean;
  /** 上一次 patrol 的产出 */
  lastPatrolOutcome: 'productive' | 'idle' | 'never';
  /** worker:complete / worker:failed 累计计数（参与 fingerprint） */
  workerCompletionCount: number;
  /** 当前是否正在执行 patrol LLM 轮次。只做运行时观测，不持久化。 */
  patrolInFlight: boolean;
}

export interface EternalPatrolCandidate {
  id: string;
  title: string;
  score: number;
  type: string;
  reason: string;
}

export type EternalRuntimeStatus =
  | 'disabled'
  | 'paused'
  | 'ready'
  | 'waiting'
  | 'patrolling'
  | 'silenced'
  | 'budget_exhausted'
  | 'circuit_open';

export interface EternalRuntimeSnapshot {
  enabled: boolean;
  status: EternalRuntimeStatus;
  goal: EternalGoal | null;
  currentPatrolIntervalMs: number;
  consecutiveIdlePatrols: number;
  lastPatrolAtMs: number;
  nextPatrolDueAtMs: number;
  currentWindowTokens: number;
  tokenBudgetPerHour: number;
  windowStartMs: number;
  consecutiveApiFailures: number;
  circuitOpenUntilMs: number;
  totalPatrols: number;
  silenceLockEngaged: boolean;
  lastPatrolOutcome: EternalLoopState['lastPatrolOutcome'];
  workerCompletionCount: number;
  patrolInFlight: boolean;
  lastFingerprintKnown: boolean;
}

export interface EternalLoopDeps {
  sessionId: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  board: TaskBoard;
  alertManager?: AlertManager;

  // Session state queries
  isEternalMode: () => boolean;
  isFinished: () => boolean;
  isWaitingForUser: () => boolean;
  isPendingReview: () => boolean;
  hasRunningAgents: () => boolean;
  getRunningAgentCount: () => number;
  getMaxConcurrent: () => number;
  getConversationLength: () => number;
  getEternalGoal?: () => EternalGoal | null;

  // Actions
  recordTokenUsage: (usage: TokenUsage) => void;

  // Patrol action (injects prompt + calls leaderThinkAndAct, returns whether tool calls happened)
  executeEternalPatrol: (
    patrolNumber: number,
    totalPatrols: number,
    candidates?: EternalPatrolCandidate[],
  ) => Promise<boolean>;

  // Parallel dispatch: notify leader of ready tasks (no longer auto-dispatches)
  dispatchReadyTasks: () => Promise<number>;

  // Ready task count for leader notification
  getReadyTaskCount?: () => number;

  // ─── Silence gate (Tier-1 fingerprint + Tier-2 LLM judge) ───
  /** 拉取黑板节点/边计数；返回 null 表示黑板未就绪。 */
  getBlackboardCounts?: () => { nodes: number; edges: number } | null;
  /** 拉取最新 scratchpad review digest；用于 fingerprint。 */
  getScratchpadDigest?: () => string | null;
  /** 拉取最近 conversation digest；提供给 judge。 */
  getRecentConversationDigest?: () => string;
  /** 取活跃任务总数等 stats。getStats 已在 board 上，但这层封装方便测试时注入。 */
  getOpenWorkPresent?: () => boolean;

  /** Judge LLM client（默认走 Leader-NextSpeaker 同款 ContentGenerator） */
  getJudgeLlm?: () => ContentGenerator | null;
  /** Judge 模型名 */
  getJudgeModel?: () => string | null;
  /** 自定义 judge 函数（测试/agents 注入用，默认 → runtime deterministic fallback） */
  judgeFn?: (input: EternalPatrolJudgeInput) => Promise<EternalPatrolVerdict>;

  /** judge 决定 yield_user 时调用，把 leader 切回等待状态 */
  yieldToUser?: (reason: string) => Promise<void>;
}

// ─── defaults ───

const DEFAULTS: Required<EternalLoopConfig> = {
  basePatrolIntervalMs: 30_000,
  maxPatrolIntervalMs: 960_000, // 16 min
  tokenBudgetPerHour: 0, // unlimited by default
  circuitBreakerThreshold: 8,
  circuitBreakerBaseBackoffMs: 60_000,
  circuitBreakerMaxBackoffMs: 1_800_000, // 30 min
  parallelDispatch: true,
};

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function parsePatrolOutcome(value: unknown): EternalLoopState['lastPatrolOutcome'] | null {
  return value === 'productive' || value === 'idle' || value === 'never'
    ? value
    : null;
}

export function createInitialEternalRuntimeSnapshot(
  enabled = false,
  config: EternalLoopConfig = {},
  now = Date.now(),
  goal: EternalGoal | null = null,
): EternalRuntimeSnapshot {
  const resolved = { ...DEFAULTS, ...config };
  return {
    enabled,
    status: !enabled ? 'disabled' : goal?.paused ? 'paused' : 'ready',
    goal,
    currentPatrolIntervalMs: resolved.basePatrolIntervalMs,
    consecutiveIdlePatrols: 0,
    lastPatrolAtMs: 0,
    nextPatrolDueAtMs: enabled ? now : 0,
    currentWindowTokens: 0,
    tokenBudgetPerHour: resolved.tokenBudgetPerHour,
    windowStartMs: now,
    consecutiveApiFailures: 0,
    circuitOpenUntilMs: 0,
    totalPatrols: 0,
    silenceLockEngaged: false,
    lastPatrolOutcome: 'never',
    workerCompletionCount: 0,
    patrolInFlight: false,
    lastFingerprintKnown: false,
  };
}

// ─── EternalLoop ───

export class EternalLoop {
  readonly state: EternalLoopState;
  private config: Required<EternalLoopConfig>;
  private deps: EternalLoopDeps;
  private alertMgr: AlertManager;

  constructor(config: EternalLoopConfig, deps: EternalLoopDeps) {
    this.config = { ...DEFAULTS, ...config };
    this.deps = deps;
    this.alertMgr = deps.alertManager ?? alertManager;
    this.state = {
      currentPatrolIntervalMs: this.config.basePatrolIntervalMs,
      consecutiveIdlePatrols: 0,
      lastPatrolAtMs: 0,
      currentWindowTokens: 0,
      windowStartMs: Date.now(),
      consecutiveApiFailures: 0,
      circuitOpenUntilMs: 0,
      totalPatrols: 0,
      lastFingerprint: null,
      silenceLockEngaged: false,
      lastPatrolOutcome: 'never',
      workerCompletionCount: 0,
      patrolInFlight: false,
    };
  }

  toRuntimeSnapshot(enabled = this.deps.isEternalMode(), now = Date.now()): EternalRuntimeSnapshot {
    const goal = this.deps.getEternalGoal?.() ?? null;
    const nextPatrolDueAtMs = this.state.lastPatrolAtMs > 0
      ? this.state.lastPatrolAtMs + this.state.currentPatrolIntervalMs
      : enabled
        ? now
        : 0;
    const status: EternalRuntimeStatus = !enabled
      ? 'disabled'
      : goal?.paused
        ? 'paused'
        : this.state.patrolInFlight
        ? 'patrolling'
        : this.state.circuitOpenUntilMs > now
          ? 'circuit_open'
          : this.config.tokenBudgetPerHour > 0 && this.state.currentWindowTokens >= this.config.tokenBudgetPerHour
            ? 'budget_exhausted'
            : this.state.silenceLockEngaged
              ? 'silenced'
              : now < nextPatrolDueAtMs
                ? 'waiting'
                : 'ready';

    return {
      enabled,
      status,
      goal,
      currentPatrolIntervalMs: this.state.currentPatrolIntervalMs,
      consecutiveIdlePatrols: this.state.consecutiveIdlePatrols,
      lastPatrolAtMs: this.state.lastPatrolAtMs,
      nextPatrolDueAtMs,
      currentWindowTokens: this.state.currentWindowTokens,
      tokenBudgetPerHour: this.config.tokenBudgetPerHour,
      windowStartMs: this.state.windowStartMs,
      consecutiveApiFailures: this.state.consecutiveApiFailures,
      circuitOpenUntilMs: this.state.circuitOpenUntilMs,
      totalPatrols: this.state.totalPatrols,
      silenceLockEngaged: this.state.silenceLockEngaged,
      lastPatrolOutcome: this.state.lastPatrolOutcome,
      workerCompletionCount: this.state.workerCompletionCount,
      patrolInFlight: this.state.patrolInFlight,
      lastFingerprintKnown: Boolean(this.state.lastFingerprint),
    };
  }

  /** 主循环入口。每轮 LeaderAgent 主循环调用一次。返回 true 表示本循环执行了 patrol。 */
  async tick(): Promise<boolean> {
    if (!this.deps.isEternalMode()) return false;
    if (this.deps.isFinished()) return false;
    const goal = this.deps.getEternalGoal?.() ?? null;
    if (goal?.paused) return false;
    const activeGoalDescription = goal?.description?.trim() || null;

    const now = Date.now();

    // 1. Token budget check
    if (this.rollTokenWindow(now)) {
      this.persistSoon('token_window_rolled');
    }
    if (this.isOverTokenBudget()) {
      return false; // Wait for next window
    }

    // 2. Circuit breaker check
    if (this.isCircuitOpen(now)) {
      return false;
    }

    // 3. Interval gate — only patrol after interval elapsed
    if (now - this.state.lastPatrolAtMs < this.state.currentPatrolIntervalMs) {
      return false;
    }

    // 4. If there are running agents, let Leader decide instead of auto-dispatching
    if (this.deps.hasRunningAgents()) {
      if (!this.config.parallelDispatch) {
        return false; // Legacy behavior: skip when agents are running
      }
      const readyCount = this.deps.getReadyTaskCount?.() ?? 0;
      if (readyCount > 0) {
        this.state.lastPatrolAtMs = now;
        this.persistSoon('running_agents_ready_tasks');
        leaderLogger.info(
          `[EternalLoop] ${readyCount} ready tasks detected, deferring to Leader for dispatch decision`,
        );
        await this.deps.executeEternalPatrol(this.state.totalPatrols + 1, this.state.totalPatrols + 1);
      }
      return false;
    }

    // 5. If waiting for user or pending review, skip
    if (this.deps.isWaitingForUser() || this.deps.isPendingReview()) {
      return false;
    }

    // 6. Silence gate (Tier-1 fingerprint + Tier-2 LLM judge)
    //    防止"项目无变化、LLM 反复回纯文本"的 token 烧空气循环。
    const fingerprint = this.computeFingerprint();
    const fingerprintChanged = fingerprint !== this.state.lastFingerprint;

    // Tier-1: same fingerprint while lock engaged → 直接 skip，连 judge 都不调
    if (!fingerprintChanged && this.state.silenceLockEngaged && !activeGoalDescription) {
      // 同时推进 idle 退避，避免 silence 期间 interval 不增长
      this.advanceSilentIdle(now);
      return false;
    }

    // Tier-2: LLM judge — patrol/skip/yield_user
    const judgeFn = this.deps.judgeFn ?? ((input: EternalPatrolJudgeInput) =>
      Promise.resolve(decideEternalActionFromRuntimeState(input)));
    const verdict = await judgeFn({
      eternalGoal: activeGoalDescription,
      fingerprintDiff: this.describeFingerprintDiff(fingerprint),
      fingerprintChanged,
      lastPatrolOutcome: this.state.lastPatrolOutcome,
      recentConversationDigest: this.deps.getRecentConversationDigest?.() ?? '(unavailable)',
      hasOpenWork: this.deps.getOpenWorkPresent?.() ?? this.hasOpenWorkFromBoard(),
      hasRunningAgents: this.deps.hasRunningAgents(),
      llm: this.deps.getJudgeLlm?.() ?? undefined,
      model: this.deps.getJudgeModel?.() ?? undefined,
      consecutiveIdlePatrols: this.state.consecutiveIdlePatrols,
    });

    if (verdict.action === 'yield_user') {
      leaderLogger.info(`[EternalLoop] Judge → yield_user: ${verdict.reason}`);
      this.state.lastFingerprint = fingerprint;
      this.state.silenceLockEngaged = true;
      // 重置 idle 退避，等下次外部事件解锁后从基础间隔重新出发
      this.state.consecutiveIdlePatrols = 0;
      this.state.currentPatrolIntervalMs = this.config.basePatrolIntervalMs;
      try {
        await this.deps.yieldToUser?.(verdict.reason);
      } catch (err) {
        leaderLogger.warn(`[EternalLoop] yieldToUser raised: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.persistSoon('judge_yield_user');
      return false;
    }

    if (verdict.action === 'skip') {
      leaderLogger.info(`[EternalLoop] Judge → skip: ${verdict.reason}`);
      this.state.lastFingerprint = fingerprint;
      this.state.silenceLockEngaged = true;
      this.advanceSilentIdle(now);
      return false;
    }

    // verdict.action === 'patrol'
    leaderLogger.info(`[EternalLoop] Judge → patrol: ${verdict.reason}`);
    this.state.lastFingerprint = fingerprint;
    this.state.silenceLockEngaged = false;

    // 7. Execute patrol
    return await this.runPatrol(now);
  }

  /** 记录 token 使用 (每次 LLM 调用后调用) */
  recordTokens(usage: TokenUsage): void {
    this.deps.recordTokenUsage(usage);
    this.state.currentWindowTokens += usage.promptTokens + usage.completionTokens;
    this.persistSoon('token_usage');
  }

  /** 记录 API 成功/失败 */
  recordApiResult(success: boolean): void {
    if (success) {
      if (this.state.consecutiveApiFailures > 0) {
        leaderLogger.info(
          `[EternalLoop] Circuit breaker reset: API recovered after ${this.state.consecutiveApiFailures} failures`,
        );
      }
      this.state.consecutiveApiFailures = 0;
      this.state.circuitOpenUntilMs = 0;
    } else {
      this.state.consecutiveApiFailures++;
      if (this.state.consecutiveApiFailures >= this.config.circuitBreakerThreshold) {
        const backoff = Math.min(
          this.config.circuitBreakerBaseBackoffMs *
            Math.pow(2, this.state.consecutiveApiFailures - this.config.circuitBreakerThreshold),
          this.config.circuitBreakerMaxBackoffMs,
        );
        this.state.circuitOpenUntilMs = Date.now() + backoff;
        const msg = `Circuit breaker open: ${this.state.consecutiveApiFailures} consecutive API failures. Pausing patrol for ${Math.round(backoff / 1000)}s.`;
        leaderLogger.error(`[EternalLoop] ${msg}`);
        this.alertMgr.emit({
          type: 'circuit_breaker_open',
          severity: 'critical',
          message: msg,
          source: 'EternalLoop',
          metadata: {
            sessionId: this.deps.sessionId,
            failures: this.state.consecutiveApiFailures,
            backoffMs: backoff,
          },
        });
      }
    }
    this.persistSoon(success ? 'api_success' : 'api_failure');
  }

  /** 从 DB 恢复 patrol 状态 */
  async hydrate(): Promise<void> {
    try {
      const read = (key: string) => this.deps.db.getSessionState(this.deps.sessionId, key);
      const interval = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_PATROL_INTERVAL));
      const idleCount = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_IDLE_PATROL_COUNT));
      const lastPatrolAt = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_LAST_PATROL_AT));
      const currentWindowTokens = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_WINDOW_TOKENS));
      const tokenBudgetPerHour = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_TOKEN_BUDGET_PER_HOUR));
      const windowStartMs = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_WINDOW_START_MS));
      const apiFailures = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_API_FAILURE_COUNT));
      const circuitOpenUntil = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_CIRCUIT_OPEN_UNTIL));
      const totalPatrols = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_TOTAL_PATROLS));
      const silenceLock = parseBoolean(await read(SESSION_KEYS.ETERNAL_SILENCE_LOCK_ENGAGED));
      const lastOutcome = parsePatrolOutcome(await read(SESSION_KEYS.ETERNAL_LAST_PATROL_OUTCOME));
      const workerCompletionCount = parseFiniteNumber(await read(SESSION_KEYS.ETERNAL_WORKER_COMPLETION_COUNT));
      const lastFingerprint = await read(SESSION_KEYS.ETERNAL_LAST_FINGERPRINT);

      if (interval !== null && interval >= 0) this.state.currentPatrolIntervalMs = interval;
      if (idleCount !== null) this.state.consecutiveIdlePatrols = Math.max(0, idleCount);
      if (lastPatrolAt !== null) this.state.lastPatrolAtMs = Math.max(0, lastPatrolAt);
      if (currentWindowTokens !== null) this.state.currentWindowTokens = Math.max(0, currentWindowTokens);
      if (tokenBudgetPerHour !== null) this.config.tokenBudgetPerHour = Math.max(0, tokenBudgetPerHour);
      if (windowStartMs !== null && windowStartMs >= 0) this.state.windowStartMs = windowStartMs;
      if (apiFailures !== null) this.state.consecutiveApiFailures = Math.max(0, apiFailures);
      if (circuitOpenUntil !== null) this.state.circuitOpenUntilMs = Math.max(0, circuitOpenUntil);
      if (totalPatrols !== null) this.state.totalPatrols = Math.max(0, totalPatrols);
      if (silenceLock !== null) this.state.silenceLockEngaged = silenceLock;
      if (lastOutcome) this.state.lastPatrolOutcome = lastOutcome;
      if (workerCompletionCount !== null) this.state.workerCompletionCount = Math.max(0, workerCompletionCount);
      this.state.lastFingerprint = typeof lastFingerprint === 'string' && lastFingerprint.length > 0
        ? lastFingerprint
        : null;
    } catch {
      // Start fresh
    }
  }

  /** 持久化 patrol 状态 */
  async persist(): Promise<void> {
    const writes: Array<[string, string]> = [
      [SESSION_KEYS.ETERNAL_PATROL_INTERVAL, String(this.state.currentPatrolIntervalMs)],
      [SESSION_KEYS.ETERNAL_IDLE_PATROL_COUNT, String(this.state.consecutiveIdlePatrols)],
      [SESSION_KEYS.ETERNAL_LAST_PATROL_AT, String(this.state.lastPatrolAtMs)],
      [SESSION_KEYS.ETERNAL_WINDOW_TOKENS, String(this.state.currentWindowTokens)],
      [SESSION_KEYS.ETERNAL_TOKEN_BUDGET_PER_HOUR, String(this.config.tokenBudgetPerHour)],
      [SESSION_KEYS.ETERNAL_WINDOW_START_MS, String(this.state.windowStartMs)],
      [SESSION_KEYS.ETERNAL_API_FAILURE_COUNT, String(this.state.consecutiveApiFailures)],
      [SESSION_KEYS.ETERNAL_CIRCUIT_OPEN_UNTIL, String(this.state.circuitOpenUntilMs)],
      [SESSION_KEYS.ETERNAL_TOTAL_PATROLS, String(this.state.totalPatrols)],
      [SESSION_KEYS.ETERNAL_SILENCE_LOCK_ENGAGED, String(this.state.silenceLockEngaged)],
      [SESSION_KEYS.ETERNAL_LAST_PATROL_OUTCOME, this.state.lastPatrolOutcome],
      [SESSION_KEYS.ETERNAL_WORKER_COMPLETION_COUNT, String(this.state.workerCompletionCount)],
      [SESSION_KEYS.ETERNAL_LAST_FINGERPRINT, this.state.lastFingerprint ?? ''],
    ];
    for (const [key, value] of writes) {
      void this.deps.db.setSessionState(this.deps.sessionId, key, value);
    }
  }

  // ─── private ───

  private async runPatrol(now: number): Promise<boolean> {
    const patrolSpan = globalTracer.startTrace('eternal_loop.patrol', {
      session_id: this.deps.sessionId,
      patrol_number: this.state.totalPatrols + 1,
      idle_streak: this.state.consecutiveIdlePatrols,
    });
    return await globalTracer.withSpan(patrolSpan, async () => {
      const result = await this.runPatrolWithinTrace(now);
      if (patrolSpan.endTs === undefined) patrolSpan.end('ok');
      return result;
    });
  }

  private async runPatrolWithinTrace(now: number): Promise<boolean> {
    this.state.lastPatrolAtMs = now;
    this.state.totalPatrols++;
    this.state.patrolInFlight = true;

    this.deps.emitter.emit('leader:status', {
      sessionId: this.deps.sessionId,
      status: `Eternal · Patrol #${this.state.totalPatrols} (interval=${Math.round(this.state.currentPatrolIntervalMs / 1000)}s)`,
    });

    leaderLogger.info(
      `[EternalLoop] Patrol #${this.state.totalPatrols}, interval=${this.state.currentPatrolIntervalMs}ms, idleStreak=${this.state.consecutiveIdlePatrols}`,
    );

    try {
      const candidates = this.buildStructuredCandidates(5);
      const hadToolCalls = await this.deps.executeEternalPatrol(
        this.state.totalPatrols,
        this.state.consecutiveIdlePatrols,
        candidates,
      );

      this.recordApiResult(true);

      if (hadToolCalls) {
        this.onPatrolProductive();
        this.state.lastPatrolOutcome = 'productive';
        // 解锁：本轮真有产出，下一次允许重新评估
        this.state.silenceLockEngaged = false;
      } else {
        this.onPatrolIdle();
        this.state.lastPatrolOutcome = 'idle';
        // 上锁：本轮 LLM 没产出工具调用，相同 fingerprint 下不再花 token
        this.state.silenceLockEngaged = true;
      }
    } catch (err) {
      // 不只 recordApiResult — 把 stack 透出去，方便排查 circuit breaker 触发原因。
      // 历史 bug：catch 吞掉错误后只能看到 "circuit OPEN" 但看不到任何 patrol 失败 stack。
      leaderLogger.error(
        `[EternalLoop] patrol #${this.state.totalPatrols} failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
      const activeSpan = globalTracer.currentSpan();
      activeSpan?.addAttribute('error', err instanceof Error ? err.message : String(err));
      activeSpan?.end('error');
      this.recordApiResult(false);
    } finally {
      this.state.patrolInFlight = false;
    }

    await this.persist();
    return true;
  }

  private onPatrolProductive(): void {
    // Reset backoff
    this.state.consecutiveIdlePatrols = 0;
    this.state.currentPatrolIntervalMs = this.config.basePatrolIntervalMs;
    leaderLogger.info('[EternalLoop] Patrol productive — resetting interval and idle counter');
  }

  private onPatrolIdle(): void {
    this.state.consecutiveIdlePatrols++;

    // Exponential backoff — no hard cap on total patrols, just increasing intervals
    const exponent = Math.min(this.state.consecutiveIdlePatrols, 10); // Cap exponent at 10
    this.state.currentPatrolIntervalMs = Math.min(
      this.config.basePatrolIntervalMs * Math.pow(2, exponent),
      this.config.maxPatrolIntervalMs,
    );

    leaderLogger.info(
      `[EternalLoop] Patrol idle — backoff to ${Math.round(this.state.currentPatrolIntervalMs / 1000)}s (${this.state.consecutiveIdlePatrols} consecutive idle)`,
    );

    // Only alert at specific thresholds — not every idle patrol
    if (this.state.consecutiveIdlePatrols === 30) {
      this.alertMgr.emit({
        type: 'eternal_extended_idle',
        severity: 'warning',
        message: `Eternal patrol has been idle for 30 consecutive rounds. Continuing at ${Math.round(this.state.currentPatrolIntervalMs / 1000)}s intervals.`,
        source: 'EternalLoop',
        metadata: {
          sessionId: this.deps.sessionId,
          totalPatrols: this.state.totalPatrols,
          currentIntervalMs: this.state.currentPatrolIntervalMs,
        },
      });
    }
  }

  private rollTokenWindow(now: number): boolean {
    const windowMs = 60 * 60 * 1000; // 1 hour
    if (now - this.state.windowStartMs >= windowMs) {
      this.state.windowStartMs = now;
      this.state.currentWindowTokens = 0;
      return true;
    }
    return false;
  }

  private isOverTokenBudget(): boolean {
    if (this.config.tokenBudgetPerHour <= 0) return false;
    if (this.state.currentWindowTokens < this.config.tokenBudgetPerHour) return false;

    leaderLogger.warn(
      `[EternalLoop] Token budget exceeded (${this.state.currentWindowTokens}/${this.config.tokenBudgetPerHour}). Pausing patrol.`,
    );
    return true;
  }

  private isCircuitOpen(now: number): boolean {
    if (this.state.circuitOpenUntilMs === 0) return false;
    if (now < this.state.circuitOpenUntilMs) {
      return true;
    }
    // Circuit expired — allow one probe
    this.state.circuitOpenUntilMs = 0;
    this.persistSoon('circuit_probe_allowed');
    leaderLogger.info('[EternalLoop] Circuit breaker cooldown expired — allowing probe');
    return false;
  }

  // ─── Silence gate helpers ───

  /**
   * 计算当前项目指纹。包含：
   * - task stats（dispatchable/running/terminal/completed/failed）
   * - blackboard 节点/边计数
   * - scratchpad digest
   * - conversation 长度
   * - worker complete 计数（外部 emitter 喂进来）
   * - Eternal 目标模式
   *
   * 任何一项变化都会让 fingerprint 改变，从而解锁 silence。
   */
  computeFingerprint(): string {
    const stats = this.deps.board.getStats();
    const taskPart = `${stats.total}:${stats.dispatchableRaw}:${stats.ready}:${stats.blocked}:${stats.running}:${stats.terminal}:${stats.completed}:${stats.failed}`;

    const bbCounts = this.deps.getBlackboardCounts?.() ?? null;
    const bbPart = bbCounts ? `${bbCounts.nodes}:${bbCounts.edges}` : '0:0';

    const scratchpad = this.deps.getScratchpadDigest?.() ?? '';
    const conv = this.deps.getConversationLength();
    const goal = this.deps.getEternalGoal?.() ?? null;
    const goalPart = goal
      ? `${goal.updatedAt}:${goal.paused ? 'paused' : 'active'}:${goal.description}`
      : 'none';

    return [
      `t=${taskPart}`,
      `b=${bbPart}`,
      `s=${scratchpad || 'none'}`,
      `c=${conv}`,
      `w=${this.state.workerCompletionCount}`,
      `g=${goalPart}`,
    ].join('|');
  }

  /**
   * 把 fingerprint 解析成"什么变了"，喂给 LLM judge。简单 diff——
   * 没必要做最优 LCS，看得懂就行。
   */
  private describeFingerprintDiff(currentFingerprint: string): string {
    const prev = this.state.lastFingerprint;
    if (!prev) return `(first patrol) ${currentFingerprint}`;
    if (prev === currentFingerprint) return `(unchanged) ${currentFingerprint}`;
    return `prev: ${prev}\ncurr: ${currentFingerprint}`;
  }

  private hasOpenWorkFromBoard(): boolean {
    const stats = this.deps.board.getStats();
    return stats.ready > 0 || stats.running > 0 || stats.total > stats.terminal;
  }

  private buildStructuredCandidates(limit: number): EternalPatrolCandidate[] {
    const boardWithScores = this.deps.board as TaskBoard & { scoredCandidates?: (k?: number) => ScoredTask[] };
    const scored = typeof boardWithScores.scoredCandidates === 'function'
      ? boardWithScores.scoredCandidates(limit)
      : [];
    return scored.map((item) => {
      const metadata = (item.task as { metadata?: Record<string, unknown> }).metadata;
      const type = typeof metadata?.type === 'string'
        ? metadata.type
        : item.task.taskType ?? 'unknown';
      const breakdown = item.scoring.breakdown;
      return {
        id: item.task.id,
        title: item.task.subject,
        score: Number(item.scoring.score.toFixed(3)),
        type,
        reason: [
          `type=${breakdown.typeWeight}`,
          `urgency=${breakdown.urgencyMultiplier}`,
          `age=${breakdown.ageFactor.toFixed(2)}`,
          `depth=${breakdown.depthBonus.toFixed(2)}`,
          `contract=${breakdown.contractReady}`,
        ].join(', '),
      };
    });
  }

  /**
   * silence 期间也要推进 idle 退避计数，避免 interval 卡在低位反复 tick。
   * 不增 totalPatrols，不进 alert 阈值。
   */
  private advanceSilentIdle(now: number): void {
    this.state.lastPatrolAtMs = now;
    this.state.consecutiveIdlePatrols++;
    const exponent = Math.min(this.state.consecutiveIdlePatrols, 10);
    this.state.currentPatrolIntervalMs = Math.min(
      this.config.basePatrolIntervalMs * Math.pow(2, exponent),
      this.config.maxPatrolIntervalMs,
    );
    this.persistSoon('silent_idle');
  }

  /**
   * 外部状态变化主动唤醒 silence lock。
   * LeaderProgressInvariant 会在 task:completed / agent:completed / worker:complete /
   * blackboard:delta / team:message_sent / 用户消息 进来时调用。
   */
  invalidateSilenceLock(reason?: string): void {
    if (this.state.silenceLockEngaged) {
      leaderLogger.info(`[EternalLoop] Silence lock released: ${reason ?? 'external_event'}`);
    }
    this.state.silenceLockEngaged = false;
    this.state.lastFingerprint = null;
    this.persistSoon('silence_lock_invalidated');
  }

  /**
   * 切到 manual 模式时调用：彻底重置 silence/idle/streak 状态，让下次切回 eternal
   * 从基础间隔重新出发，不携带旧 backoff / outcome 包袱。
   * 不动 token 窗口与 circuit breaker（这两类与 eternal 无关）。
   */
  resetForControlModeSwitch(): void {
    this.state.silenceLockEngaged = false;
    this.state.lastFingerprint = null;
    this.state.consecutiveIdlePatrols = 0;
    this.state.currentPatrolIntervalMs = this.config.basePatrolIntervalMs;
    this.state.lastPatrolOutcome = 'never';
    this.state.lastPatrolAtMs = 0;
    this.state.patrolInFlight = false;
    this.persistSoon('control_mode_reset');
  }

  /** 由 LeaderProgressInvariant 在收到 worker:complete / worker:failed 时调用 */
  noteWorkerCompletion(): void {
    this.state.workerCompletionCount++;
    this.invalidateSilenceLock('worker_completion');
  }

  private persistSoon(reason: string): void {
    void this.persist().catch((err) => {
      leaderLogger.warn(
        `[EternalLoop] failed to persist state after ${reason}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
