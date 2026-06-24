import type { EventEmitter, EventMap, EventName } from '../core/EventEmitter.js';
import { rmSync } from 'fs';
import { join } from 'path';
import { t } from '../i18n.js';
import { MessageBus } from '../core/MessageBus.js';
import { TaskBoard } from '../core/TaskBoard.js';
import { AgentPool } from '../agents/AgentPoolRuntime.js';
import { LeaderAgent } from '../agents/LeaderAgent.js';
import type { TokenTracker } from '../agents/BaseAgentRuntime.js';
import { AgentRoleRegistry } from '../agents/RoleRegistry.js';
import { Workspace } from '../core/Workspace.js';
import {
  contentToPlainText,
  isEmptyContent,
  type MessageContent,
  type ChatMessage,
  type ToolDefinition,
} from '../llm/types.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import { getReasoningGenerateOptions } from '../llm/reasoningSampling.js';
import { DatabaseManager } from '../core/Database.js';
import { config as runtimeConfig } from '../config.js';
import { getModelManager } from '../config/ModelManager.js';
import { collectRecoveredTasks, createSessionRuntime } from './SessionRuntime.js';
import type { SessionRuntimeState } from '../core/SessionRuntimeState.js';
import {
  deriveSessionRuntimeState,
  loadPersistedEternalRuntimeSnapshot,
  loadPersistedInteractionSnapshot,
} from '../core/SessionRuntimeState.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { listRecoveryRecords } from '../core/RecoveryRecords.js';
import { TurnCoordinator, type InteractionTurnState } from '../core/TurnCoordinator.js';
import { loadAgentResumeCheckpoints, saveAgentResumeCheckpoint } from '../core/ResumeManager.js';
import { buildBuiltinRoles, applyRoleToolsConfigMap } from '../agents/RoleCapabilityModel.js';
import { AgentDefinitionService } from '../agents/AgentDefinitionService.js';
import { loadPersistedContextRuntimeState, type ContextRuntimeState } from '../core/ContextRuntimeState.js';
import {
  buildSkillDigest,
  buildSkillInjection,
  collectAvailableSkills,
  parseExplicitSkillMentions,
  resolveDisabledSkillNames,
  resolveExplicitSkillMentions,
} from '../core/SkillCatalog.js';
import { sessionLogger } from '../core/Log.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import {
  createEternalGoal,
  readPersistedEternalGoal,
  setEternalGoalPaused,
  type EternalGoal,
} from '../core/EternalGoal.js';
import { buildIntuitionSnapshot } from '../core/IntuitionRuntime.js';
import { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import { WorkflowManager } from '../core/workflow/WorkflowManager.js';
import { createToolRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { killExternalAgentOrphans } from '../agents/external/ExternalAgentOrphans.js';
import { isAgentRuntimeActiveStatus, isAgentTerminalStatus, isRunTerminalStatus, isTaskTerminalStatus } from '../core/StateSemantics.js';
import { configureJudgmentLlmGuardFactory, runStructuredJudgment } from '../core/JudgmentService.js';
import { createLlmGuard } from '../agents/LlmGuard.js';
import { MemoryManager, type MemoryScope, type MemoryType } from '../memory/MemoryManager.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';
import type { SessionRecord } from '../types/canonical.js';
import { SessionCleanup } from '../core/session/SessionCleanup.js';
import { SessionFactory } from '../core/session/SessionFactory.js';
import {
  buildLeaderSkillDigest,
  createInitializationGate,
  ensureSessionDirectories,
  generateUniqueSessionId,
  shouldAutoExtractMemory,
} from '../core/session/SessionInitialization.js';
import { attachTeamMailboxDatabase } from '../core/TeamMailbox.js';
import { isActionableAgentBusMessage } from '../core/AgentProtocol.js';
import {
  coerceAutonomyModeAlias,
  isAutonomyMode,
  normalizeAutonomyMode,
  normalizeAutonomyLifecyclePhase,
} from '../contracts/types/Autonomy.js';

configureJudgmentLlmGuardFactory(createLlmGuard);

// Session — re-exported from canonical
export type Session = SessionRecord;

export interface SessionState {
  sessionId: string;
  workspace: string;
  userRequest: MessageContent;
  status: 'active' | 'completed' | 'failed' | 'interrupted';
  leader: LeaderAgent;
  board: TaskBoard;
  bus: MessageBus;
  pool: AgentPool;
  tracker: TokenTracker;
  workspaceObj: Workspace;
  llm: ContentGenerator;
  toolRegistry: ToolRegistry;
  workflowManager: WorkflowManager;
  workflowEngine: WorkflowEngine;
  turnCoordinator: TurnCoordinator;
  taskCounter: number;
  /** 当 Leader 正在处理某条用户消息时为 true，阻止新消息直接送入 bus */
  isLeaderBusy: boolean;
  /** 事件监听器取消订阅函数，session 清理时调用 */
  _roundCompleteUnsub?: () => void;
  _completedUnsub?: () => void;
  _leaderErrorUnsub?: () => void;
  /** TeamCommunicationService cleanup — 在 session 销毁时取消 emitter 订阅并 reset Guard */
  _disposeTeamCommunication?: () => void;
}

const PERSISTED_SESSION_STATUSES = new Set<string>(['active', 'completed', 'failed', 'interrupted']);

function isPersistedSessionStatus(status: unknown): status is SessionState['status'] {
  return typeof status === 'string' && PERSISTED_SESSION_STATUSES.has(status);
}

function isRestorableInputSessionStatus(status: unknown): boolean {
  const text = String(status || '').trim().toLowerCase();
  return text === 'active' || text === 'interrupted';
}

export interface CancelTaskResult {
  ok: boolean;
  message: string;
}

export interface SendAgentInputResult {
  ok: boolean;
  mode: 'delivered' | 'woken' | 'queued' | 'not_found';
  message: string;
}

type SessionRuntimeComponents = ReturnType<typeof createSessionRuntime>;

interface SessionFactoryInput {
  sessionId: string;
  workspace: string;
  userRequest: MessageContent | object;
  runtime: SessionRuntimeComponents;
  status?: SessionState['status'];
  isLeaderBusy?: boolean;
}

const INITIAL_SESSION_PLACEHOLDERS = new Set([
  'new session',
  '新会话',
]);

function isMessageContentLike(value: MessageContent | object): value is MessageContent {
  return typeof value === 'string' || Array.isArray(value) || value === null;
}

export function shouldProcessInitialUserRequest(userRequest: MessageContent | object, options?: { idle?: boolean }): userRequest is MessageContent {
  if (options?.idle) {
    return false;
  }
  if (!isMessageContentLike(userRequest)) {
    return false;
  }
  const plain = contentToPlainText(userRequest).trim();
  if (!plain) {
    return false;
  }
  return !INITIAL_SESSION_PLACEHOLDERS.has(plain.toLowerCase());
}

function compactMemoryLine(value: unknown, max = 160): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value != null) {
    try {
      text = JSON.stringify(value);
    } catch { /* expected: circular reference in value */
      text = String(value);
    }
  }
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

function memoryName(prefix: string, timestamp: string, index: number, content: string): string {
  const safeTime = timestamp.replace(/[:.]/g, '-');
  const slug = compactMemoryLine(content, 48);
  return `${prefix}-${safeTime}-${index + 1}${slug ? `-${slug}` : ''}`.slice(0, 120);
}

function memoryTypeForExtractedEntry(scope: MemoryScope, category: string): MemoryType {
  if (scope === 'user') return category === 'norm' ? 'feedback' : 'user';
  return category === 'norm' ? 'feedback' : 'project';
}

function userExplicitlyForbidsToolUse(content: MessageContent): boolean {
  const text = contentToPlainText(content).toLowerCase();
  if (!text.trim()) return false;
  return /(?:\b(?:do\s*not|don't|dont|without|no)\s+(?:call|use|invoke|run)?\s*tools?\b|\bno\s+tool\s*(?:use|calls?)?\b|\bwithout\s+tools?\b|不要\s*(?:调用|使用)?\s*(?:任何)?\s*工具|不用\s*(?:任何)?\s*工具|别\s*(?:调用|使用)?\s*(?:任何)?\s*工具|禁止\s*(?:调用|使用)?\s*(?:任何)?\s*工具|禁用\s*工具)/iu.test(text);
}

/**
 * 会话管理器 - 完整复刻 Python 版本
 * 
 * 功能清单：
 * - createSession: 创建会话，初始化 LeaderAgent、TaskBoard、MessageBus 等
 * - sendUserInput: 发送用户输入到 Leader，支持 Skill 注入
 * - resumeSession: 恢复会话（全现场恢复）
 * - interruptSession: 中断会话（停止 Leader + 所有 Agent）
 * - deleteSession: 删除会话
 * - _handleSkills: Skill 注入系统（三级查找：项目级 → 全局级 → 内置级）
 */
export class SessionManager {
  private db: DatabaseManager;
  private emitter: EventEmitter;
  private sessions: Map<string, SessionState> = new Map();
  private resuming: Map<string, Promise<boolean>> = new Map();
  /**
   * 会话初始化期占位 — createSession 内部异步链尚未执行到 sessions.set 时，
   * 客户端拿到 sessionId 立即调用 sendUserInput/sendAgentInput 会因 sessions.get 返回 undefined
   * 而抛 session_not_found。这里用一个 deferred Promise 让外部接口能等待初始化完成。
   * 成功后 resolve(state)，失败后 reject(error)，无论成败 finally 清理本 Map。
   */
  private initializingSessions: Map<string, Promise<SessionState>> = new Map();
  private baseWorkspace: string;
  private cleanupTask?: NodeJS.Timeout;
  private turnCoordinator = new TurnCoordinator();
  private autoExtractSoulOnComplete = true;
  private runtimeStatePublishTimers: Map<string, NodeJS.Timeout> = new Map();
  private runtimeStateUnsubscribers: Array<() => void> = [];
  private readonly sessionCleanup = new SessionCleanup();
  private readonly sessionFactory: SessionFactory<SessionState, SessionFactoryInput>;
  /** 已尝试过自动命名的 session（避免每轮 round_complete 都重复触发 LLM） */
  private autoNamedSessions: Set<string> = new Set();
  /** Max idle time before force-cleaning a non-active session (24 hours) */
  private static readonly MAX_IDLE_SESSION_MS = 24 * 60 * 60 * 1000;
  /** Session idle TTL: 30 minutes of inactivity triggers resource release */
  private static readonly SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
  /** Timeout for session initialization (60s) */
  private static readonly INIT_TIMEOUT_MS = 60_000;
  /** Timeout for session resume operations (30s) */
  private static readonly RESUME_TIMEOUT_MS = 30_000;
  /** Track last activity per session for idle TTL */
  private sessionLastActivity: Map<string, number> = new Map();
  /** Workflow 引擎 */
  private workflowEngine: WorkflowEngine;

  /** Workflow 管理器 */
  private workflowManager: WorkflowManager;
  private scheduledTaskManager?: ScheduledTaskManager;

  constructor(db: DatabaseManager, emitter: EventEmitter, baseWorkspace?: string) {
    this.db = db;
    this.emitter = emitter;
    this.db.setEmitter?.(emitter);
    attachTeamMailboxDatabase(db);
    this.baseWorkspace = baseWorkspace || process.cwd();
    this.sessionFactory = new SessionFactory<SessionState, SessionFactoryInput>({
      createRuntime: (input): SessionState => ({
        sessionId: input.sessionId,
        workspace: input.workspace,
        userRequest: input.userRequest as MessageContent,
        status: input.status ?? 'active',
        leader: input.runtime.leader,
        board: input.runtime.board,
        bus: input.runtime.bus,
        pool: input.runtime.pool,
        tracker: input.runtime.tracker,
        workspaceObj: input.runtime.workspaceObj,
        llm: input.runtime.llm,
        toolRegistry: input.runtime.toolRegistry,
        workflowManager: input.runtime.workflowManager,
        workflowEngine: input.runtime.workflowEngine,
        turnCoordinator: input.runtime.turnCoordinator,
        taskCounter: 0,
        isLeaderBusy: input.isLeaderBusy ?? true,
      }),
      persist: (session) => {
        this.sessions.set(session.sessionId, session);
        this.sessionLastActivity.set(session.sessionId, Date.now());
      },
    });
    
    // 初始化 Workflow 系统
    this.workflowManager = new WorkflowManager(db, emitter);
    this.workflowEngine = new WorkflowEngine({
      db,
      toolRegistry: createToolRegistry(),
      eventEmitter: emitter,
      workflowManager: this.workflowManager,
    });

    this.installRuntimeStateSyncBus();
    
    // 启动后台清理任务
    this.startCleanupLoop();
    this.warmColdStartCaches();
  }

  private warmColdStartCaches(): void {
    queueMicrotask(() => {
      const warm = async (label: string, run: () => Promise<void> | void) => {
        try {
          await run();
        } catch (error) {
          sessionLogger.debug(`[SessionManager] cold-start warmup skipped (${label}): ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      void Promise.allSettled([
        warm('skills', () => {
          const disabledNames = resolveDisabledSkillNames();
          collectAvailableSkills(this.baseWorkspace, { disabledNames });
        }),
        warm('http_dispatcher', async () => {
          const { getSharedFetch } = await import('../llm/http_dispatcher.js');
          getSharedFetch();
        }),
        warm('tiktoken', async () => {
          const { getCachedEncoder, getEncodingForModel } = await import('../core/TiktokenCache.js');
          const models = [runtimeConfig.llm.leader_model, runtimeConfig.llm.agent_model]
            .filter((model): model is string => typeof model === 'string' && model.length > 0);
          if (models.length === 0) {
            getCachedEncoder('cl100k_base');
            return;
          }
          for (const model of new Set(models)) {
            getCachedEncoder(getEncodingForModel(model));
          }
        }),
        warm('llm_connection', async () => {
          const model = runtimeConfig.llm.leader_model;
          if (!model) return;
          const { createLLMClient } = await import('../llm/Client.js');
          const llm = createLLMClient(model);
          await llm.warmup?.();
        }),
        warm('roles', async () => {
          await this.createRoleRegistryWithBuiltinRoles();
        }),
      ]);
    });
  }

  private installRuntimeStateSyncBus(): void {
    const asRecord = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const subscribeSession = <T extends EventName>(
      eventName: T,
      getSessionId: (data: EventMap[T]) => string | undefined,
      source = eventName,
    ) => {
      const unsubscribe = this.emitter.subscribe(eventName, (data) => {
        const sessionId = getSessionId(data);
        if (!sessionId) return;
        this.scheduleSessionRuntimeStatePublish(sessionId, { source });
      });
      this.runtimeStateUnsubscribers.push(unsubscribe);
    };

    const topLevelSessionId = (data: unknown) => {
      const record = asRecord(data);
      return typeof record.sessionId === 'string' ? record.sessionId : undefined;
    };
    const taskSessionId = (data: unknown) => {
      const record = asRecord(data);
      const task = asRecord(record.task);
      const candidates = [
        record.sessionId,
        task.session_id,
        task.sessionId,
      ];
      const sessionId = candidates.find((value) => typeof value === 'string' && value);
      return typeof sessionId === 'string' ? sessionId : undefined;
    };

    for (const eventName of [
      'session:created',
      'session:completed',
      'session:failed',
      'session:interrupted',
      'session:renamed',
      'leader:round_complete',
      'leader:capability_intent',
      'leader:autonomy_decision',
      'leader:control_mode_changed',
      'session:collaboration_mode_changed',
      'session:autonomy_mode_changed',
      'session:execution_route_changed',
      'eternal:goal_changed',
      'permission:mode_changed',
      'permission:request',
      'permission:resolved',
      'user:input_needed',
      'user:question_answered',
      'plan:submitted',
      'plan:updated',
      'plan:finalized',
      'leader:plan_approved',
      'leader:plan_rejected',
      'agent:spawned',
      'agent:started',
      'agent:completed',
      'agent:terminated',
	      'agent:failed',
	      'agent:status',
	      'agent:crashed',
	      'runtime_recovery:changed',
	      'orchestration:run_state',
      'orchestration:event_applied',
      'orchestration:event_rejected',
    ] as const satisfies readonly EventName[]) {
      subscribeSession(eventName, topLevelSessionId);
    }

    this.runtimeStateUnsubscribers.push(this.emitter.subscribe('session:deleted', (data) => {
      const timer = this.runtimeStatePublishTimers.get(data.sessionId);
      if (timer) clearTimeout(timer);
      this.runtimeStatePublishTimers.delete(data.sessionId);
    }));

    for (const eventName of [
      'task:created',
      'task:updated',
      'task:assigned',
      'task:completed',
      'task:failed',
      'task:cancelled',
      'task:deleted',
      'orchestration:node_update',
    ] as const satisfies readonly EventName[]) {
      subscribeSession(eventName, taskSessionId);
    }

    const actionableLeaderMessageUnsub = this.emitter.subscribe('message:bus:priority', (message) => {
      const sessionId = this.sessionIdFromLeaderBusAddress(message.to);
      if (!sessionId) return;
      this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'message:bus:priority' });
      this.ensureLeaderRunningForActionableMessage(sessionId, message);
    });
    this.runtimeStateUnsubscribers.push(actionableLeaderMessageUnsub);
  }

  private scheduleSessionRuntimeStatePublish(
    sessionId: string,
    metadata?: { source?: string; reason?: string },
  ): void {
    const existing = this.runtimeStatePublishTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.runtimeStatePublishTimers.delete(sessionId);
      try {
        this.publishSessionRuntimeState(sessionId, metadata);
      } catch (error) {
        sessionLogger.debug(`[SessionManager] publish runtime snapshot failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 0);
    timer.unref?.();
    this.runtimeStatePublishTimers.set(sessionId, timer);
  }

  publishSessionRuntimeState(
    sessionId: string,
    metadata?: { source?: string; reason?: string },
  ): { runtimeState: SessionRuntimeState; turn: InteractionTurnState } | null {
    const snapshot = this.getInteractionRuntimeState(sessionId);
    if (!snapshot) return null;
    this.emitter.emit('session:runtime_state', {
      sessionId,
      runtimeState: snapshot.runtimeState,
      turn: snapshot.turn,
      reason: metadata?.reason,
      source: metadata?.source,
      at: Date.now(),
    });
    return snapshot;
  }

  private sessionIdFromLeaderBusAddress(to: string): string | null {
    const suffix = ':leader';
    if (!to.endsWith(suffix)) return null;
    const sessionId = to.slice(0, -suffix.length);
    return sessionId || null;
  }

  private isSessionUserIntervention(sessionId: string, message: EventMap['message:bus:priority']): boolean {
    if (message.type !== 'user_intervention') return false;
    const sender = String(message.from || '');
    return sender === 'user' || sender === `${sessionId}:user` || sender.endsWith(':user');
  }

  private hasExplicitUserGate(sessionId: string): boolean {
    const gate = this.db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_GATE);
    if (gate && typeof gate === 'object' && !Array.isArray(gate)) {
      const kind = String((gate as { kind?: unknown }).kind || '');
      if (kind === 'ask_user' || kind === 'permission' || kind === 'plan_review') {
        return true;
      }
    }
    const pendingInput = this.db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_INPUT);
    return this.db.getSessionState(sessionId, SESSION_KEYS.PENDING_PERMISSION_REQUEST) != null ||
      pendingInput === 'permission_request' ||
      pendingInput === 'plan_review';
  }

  private ensureLeaderRunningForActionableMessage(sessionId: string, message: EventMap['message:bus:priority']): void {
    if (!isActionableAgentBusMessage(message)) return;
    // sendUserInput owns real user-message restart. This fallback is for worker/system
    // control events that otherwise sit in the leader inbox while the leader is stopped.
    if (this.isSessionUserIntervention(sessionId, message)) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.status !== 'active' && session.status !== 'interrupted') return;
    if (session.leader.isRunning) return;

    if (session.status !== 'active') {
      session.status = 'active';
      this.db.updateSessionStatus(sessionId, 'active');
    }
    session.isLeaderBusy = true;
    if (!this.hasExplicitUserGate(sessionId)) {
      void this.db.setSessionState(sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
    }
    this.sessionLastActivity.set(sessionId, Date.now());

    const agentStates = typeof this.db.getAgentStates === 'function'
      ? this.db.getAgentStates(sessionId)
      : [];
    const checkpoints = typeof this.db.listSessionStateByPrefix === 'function'
      ? loadAgentResumeCheckpoints(this.db, sessionId)
      : new Map();
    const recoveredTasks = collectRecoveredTasks(session.board, agentStates, checkpoints);
    sessionLogger.info(`[SessionManager] Actionable leader inbox message ${message.type} arrived while Leader stopped; restarting Leader for session ${sessionId}`);
    this.launchLeaderDetached(
      sessionId,
      () => session.leader.run(undefined, true, recoveredTasks.length > 0 ? recoveredTasks : undefined),
      'Leader actionable message wake',
    );
  }

  /**
   * 启动后台清理循环（定期清理内存中已完成的会话 + 超时的初始化/resume）
   * 
   * 资源降级：idle 时自动拉长扫描周期到 5 分钟，活跃时恢复 2 分钟。
   */
  private static readonly ACTIVE_CLEANUP_INTERVAL_MS = 120_000; // 2 分钟
  private static readonly IDLE_CLEANUP_INTERVAL_MS = 300_000;   // 5 分钟
  private currentCleanupIntervalMs = SessionManager.ACTIVE_CLEANUP_INTERVAL_MS;
  private cleanupLoopIdleMode = false;

  private startCleanupLoop(): void {
    this.scheduleNextCleanup();
  }

  private scheduleNextCleanup(): void {
    this.cleanupTask = setTimeout(() => {
      try {
        this.cleanupTerminalSessions();
        this.cleanupIdleSessions();
        this.cleanupStaleInitializingSessions();
        this.cleanupStaleResumingSessions();

        // 动态调整扫描频率：无活跃会话时降级到慢速扫描
        const hasActive = [...this.sessions.values()].some(
          s => s.leader.isRunning || s.pool.getRunning().length > 0
        );
        if (!hasActive && !this.cleanupLoopIdleMode) {
          this.cleanupLoopIdleMode = true;
          this.currentCleanupIntervalMs = SessionManager.IDLE_CLEANUP_INTERVAL_MS;
        } else if (hasActive && this.cleanupLoopIdleMode) {
          this.cleanupLoopIdleMode = false;
          this.currentCleanupIntervalMs = SessionManager.ACTIVE_CLEANUP_INTERVAL_MS;
        }
      } catch (error) {
        sessionLogger.warn('清理任务异常:', error);
      }
      // 继续下一轮
      this.scheduleNextCleanup();
    }, this.currentCleanupIntervalMs);

    // Don't let the cleanup timer keep the process alive
    if (this.cleanupTask.unref) this.cleanupTask.unref();
  }

  /** 清理已终态的会话（Leader 已停 + 无运行中 Agent + DB 状态为终态） */
  private cleanupTerminalSessions(): void {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      const isLeaderRunning = session.leader.isRunning;
      const runningAgents = session.pool.getRunning();

      if (!isLeaderRunning && runningAgents.length === 0) {
        const dbSession = this.db.getSession(sessionId);
        const terminalStatus = dbSession && isRunTerminalStatus(dbSession.status);

        if (terminalStatus) {
          sessionLogger.info(`清理已结束会话：${sessionId} (status=${dbSession.status})`);
          this.releaseSessionResources(sessionId, session);
        }
      } else {
        // 会话仍活跃：回收超龄终止态任务，防止内存无限增长
        session.board.evictStalledTerminalTasks();
        // 更新活跃时间戳
        this.sessionLastActivity.set(sessionId, Date.now());
      }
    }
  }

  /** 清理长期空闲的非活跃会话（idle TTL = 30 分钟不活跃释放 runtime 资源） */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      // 活跃会话（Leader 运行中或有 Agent 在跑）不清理
      if (session.leader.isRunning || session.pool.getRunning().length > 0) {
        this.sessionLastActivity.set(sessionId, now);
        continue;
      }

      const lastActivity = this.sessionLastActivity.get(sessionId) ?? now;
      const idleTime = now - lastActivity;

      if (idleTime >= SessionManager.SESSION_IDLE_TTL_MS) {
        sessionLogger.info(`会话 ${sessionId} 空闲超过 ${Math.round(idleTime / 60000)} 分钟，释放运行时资源`);
        this.releaseSessionResources(sessionId, session);
      }
    }
  }

  /** 清理卡死的 initializingSessions（超过 INIT_TIMEOUT_MS 仍未完成） */
  private cleanupStaleInitializingSessions(): void {
    // initializingSessions 中的 Promise 有可能永远 pending（LLM 不响应等）。
    // 由于 Map 中无法直接检测 Promise 状态，我们利用 sessions Map 来判断：
    // 如果 sessionId 既在 initializingSessions 中又已出现在 sessions 中，说明已完成但清理回调漏执行。
    for (const sessionId of [...this.initializingSessions.keys()]) {
      if (this.sessions.has(sessionId)) {
        // 初始化已完成但 Map 条目残留
        this.initializingSessions.delete(sessionId);
      }
    }
  }

  /** 清理挂起的 resuming Map 条目（Promise 应自动 finally 清理，这里做兜底） */
  private cleanupStaleResumingSessions(): void {
    for (const sessionId of [...this.resuming.keys()]) {
      if (this.sessions.has(sessionId)) {
        // resume 已完成但 Map 条目残留
        this.resuming.delete(sessionId);
      }
    }
  }

  /** 释放单个会话的运行时资源（LLM 连接、事件订阅、AgentPool 等） */
  private releaseSessionResources(sessionId: string, session: SessionState): void {
    // 关闭 LLM 客户端
    if ('close' in session.llm && typeof session.llm.close === 'function') {
      session.llm.close();
    }

    this.sessionCleanup.release(session);
    void killExternalAgentOrphans(sessionId).catch((error) => {
      sessionLogger.warn(`后台清理会话 ${sessionId} 外部 Agent 孤儿进程失败:`, error);
    });
    this.sessions.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
    this.autoNamedSessions.delete(sessionId);
  }

  private launchLeaderDetached(sessionId: string, operation: () => Promise<unknown>, label: string): void {
    queueMicrotask(() => {
      void operation().catch((error) => {
        sessionLogger.error(`${label} 失败:`, error);
        // 输出完整的错误堆栈
        if (error instanceof Error && error.stack) {
          sessionLogger.error('错误堆栈:', error.stack);
        }
        this.emitter.emit('leader:error', {
          sessionId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    });
  }

  /**
   * 从数据库加载会话
   */
  async loadFromDB(sessionId: string): Promise<boolean> {
    return this.resumeSession(sessionId);
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取底层数据库管理器，供 web routes 做 session-scoped runtime gate。
   */
  getDatabaseManager(): DatabaseManager {
    return this.db;
  }

  /**
   * 获取 WorkflowEngine 实例
   */
  getWorkflowEngine(): WorkflowEngine {
    return this.workflowEngine;
  }

  /**
   * 获取指定会话自己的 WorkflowEngine，避免 Web/API 入口复用 manager-level engine 串台。
   */
  getSessionWorkflowEngine(sessionId?: string): WorkflowEngine | undefined {
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId)?.workflowEngine;
  }

  /**
   * 获取指定会话自己的 ToolRegistry，和 Leader/AgentPool/WorkflowEngine 保持同一实例。
   */
  getSessionToolRegistry(sessionId?: string): ToolRegistry | undefined {
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId)?.toolRegistry;
  }

  /**
   * 获取 WorkflowManager 实例
   */
  getWorkflowManager(): WorkflowManager {
    return this.workflowManager;
  }

  setScheduledTaskManager(manager: ScheduledTaskManager): void {
    this.scheduledTaskManager = manager;
  }

  /**
   * 列出所有会话
   */
  listSessions(): Session[] {
    return this.db.listSessions();
  }

  /**
   * 广播会话重命名事件（供 SseBridge 转成 SSE，让所有 UI 实时刷新名称）
   */
  emitSessionRenamed(sessionId: string, name: string): void {
    this.emitter.emit('session:renamed', { sessionId, name });
  }

  /**
   * 获取所有当前在内存中（活跃）的 session ID
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * 检查是否有任何活跃工作（running leader 或 agent）—— 用于 ProcessIdleGuard 探针
   */
  hasActiveWork(): boolean {
    for (const session of this.sessions.values()) {
      if (session.leader.isRunning || session.pool.getRunning().length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取会话历史
   */
  getSessionHistory(sessionId: string): unknown[] {
    const messages = this.db.getConversationMessages(sessionId);
    return messages.map(m => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
    }));
  }

  /**
   * 获取当前会话可用工具列表（结合 ToolRegistry 和角色权限）
   */
  getSessionTools(sessionId: string): {
    allTools: { name: string; description: string }[];
    availableTools: Set<string>;
    permissionMode: string;
  } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const leader = session.leader;
    const toolRegistry = leader.getToolRegistry();
    const allTools = toolRegistry.getAll().map(t => ({
      name: t.name,
      description: t.description,
    }));

    // 获取 Leader 当前实际可用的工具（从 getDefinitions 推断）
    const definitions = toolRegistry.getDefinitions();
    const availableTools = new Set(definitions.map(d => d.function.name));

    // 获取权限模式
    const permCtx = leader.getPermissionContext();
    const permissionMode = permCtx.mode || 'unknown';

    return { allTools, availableTools, permissionMode };
  }

  /**
   * 完成会话
   */
  completeSession(sessionId: string, summary?: string): void {
    this.db.updateSessionStatus(sessionId, 'completed', summary);
  }

  /**
   * 创建并注册内置角色的 RoleRegistry
   */
  private async createRoleRegistryWithBuiltinRoles(workspacePath = this.baseWorkspace): Promise<AgentRoleRegistry> {
    const roleRegistry = new AgentRoleRegistry();

    const { RESEARCH_SYSTEM_PROMPT_BY_LOCALE, EXPLORE_SYSTEM_PROMPT_BY_LOCALE, CODING_SYSTEM_PROMPT_BY_LOCALE, VERIFY_SYSTEM_PROMPT_BY_LOCALE, REVIEW_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/worker/system_prompts.js');
    const { FRONTEND_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/frontend_system.js');
    const { BACKEND_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/backend_system.js');
    const { FULLSTACK_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/fullstack_system.js');
    const { QA_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/qa_system.js');
    const { UX_DESIGNER_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/ux_designer_system.js');
    const { PLANNER_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/planner_system.js');
    const { EVALUATOR_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/evaluator_system.js');
    const { ARCHITECT_SYSTEM_PROMPT_BY_LOCALE } = await import('../agents/prompts/architect_system.js');

    for (const role of applyRoleToolsConfigMap(buildBuiltinRoles({
      research: RESEARCH_SYSTEM_PROMPT_BY_LOCALE,
      explore: EXPLORE_SYSTEM_PROMPT_BY_LOCALE,
      coding: CODING_SYSTEM_PROMPT_BY_LOCALE,
      verify: VERIFY_SYSTEM_PROMPT_BY_LOCALE,
      review: REVIEW_SYSTEM_PROMPT_BY_LOCALE,
      frontend: FRONTEND_SYSTEM_PROMPT_BY_LOCALE,
      backend: BACKEND_SYSTEM_PROMPT_BY_LOCALE,
      fullstack: FULLSTACK_SYSTEM_PROMPT_BY_LOCALE,
      qa: QA_SYSTEM_PROMPT_BY_LOCALE,
      ux_designer: UX_DESIGNER_SYSTEM_PROMPT_BY_LOCALE,
      planner: PLANNER_SYSTEM_PROMPT_BY_LOCALE,
      evaluator: EVALUATOR_SYSTEM_PROMPT_BY_LOCALE,
      architect: ARCHITECT_SYSTEM_PROMPT_BY_LOCALE,
    }), {
      basicToolsEnabled: (runtimeConfig as { roles?: { basic_tools_enabled?: boolean } }).roles?.basic_tools_enabled !== false,
      overrides: (runtimeConfig as { roles?: { overrides?: Record<string, { tools_added?: string[]; tools_removed?: string[] }> } }).roles?.overrides,
    })) {
      roleRegistry.register(role);
    }

    const disabledNames = resolveDisabledSkillNames();
    const availableSkills = collectAvailableSkills(workspacePath, { disabledNames });
    const agentDefinitionService = new AgentDefinitionService({ workspace: workspacePath });
    for (const role of agentDefinitionService.listAgentRoles(availableSkills)) {
      roleRegistry.register(applyRoleToolsConfigMap([role], {
        basicToolsEnabled: (runtimeConfig as { roles?: { basic_tools_enabled?: boolean } }).roles?.basic_tools_enabled !== false,
        overrides: (runtimeConfig as { roles?: { overrides?: Record<string, { tools_added?: string[]; tools_removed?: string[] }> } }).roles?.overrides,
      })[0]);
    }

    return roleRegistry;
  }

  /**
   * 解析并注入技能内容 ($xxx) — 三级查找：项目级 → 全局级 → 内置级
   */
  private async handleSkills(message: MessageContent, workspacePath = this.baseWorkspace): Promise<MessageContent> {
    if (Array.isArray(message)) {
      return message;
    }
    const plainMessage = contentToPlainText(message);
    if (!plainMessage.includes('$')) {
      return message;
    }

    const disabledNames = resolveDisabledSkillNames();
    const availableSkills = collectAvailableSkills(workspacePath, { disabledNames });
    const skillNames = resolveExplicitSkillMentions(plainMessage, availableSkills);
    if (skillNames.length === 0) {
      return message;
    }

    const injected = buildSkillInjection(skillNames, availableSkills, {
      maxTotalChars: 16_000,
      maxPerSkillChars: 7_000,
    });
    if (!injected.content) {
      return message;
    }

    // ★ 发射 skill:invoked 事件，通知 TUI 显示 skill 调用日志
    const invokedSkills = injected.names.map((name) => {
      const skill = availableSkills.find((s) => s.name === name);
      return { name, source: skill?.source ?? 'bundled', summary: skill?.summary ?? '' };
    });
    this.emitter.emit('skill:invoked', {
      skills: invokedSkills,
    });

    return `${plainMessage}${injected.content}`;
  }

  /**
   * 创建新会话（完整初始化链）
   *
   * 关键改进：立即发射 session:created 事件，让 TUI 先拿到 session ID，
   * 所有重初始化（soul 读取、role registry、LLM 探测等）全部异步执行。
   * 返回值立即返回 sessionId，不阻塞 UI。
   */
  async createSession(userRequest: MessageContent | object, workspacePath?: string, options?: { idle?: boolean }): Promise<string> {
    const sessionId = generateUniqueSessionId(this.sessions, this.db);
    const workspace = workspacePath || this.baseWorkspace;

    ensureSessionDirectories(sessionId, workspace);

    // ★ 立即发射 session:created 事件，让 TUI 立即显示会话 ID
    this.emitter.emit('session:created', { sessionId, workspace, createdAt: Date.now() });

    // ★ 立即保存到数据库（轻量），TUI 可以通过 DB 查询到这个会话
    this.db.insertSession(sessionId, workspace, userRequest);

    // ★ 注册"初始化中"占位 Promise，避免客户端在 sessions.set 之前调用 sendUserInput
    const { promise: initPromise, resolve: initResolve, reject: initReject } = createInitializationGate<SessionState>({
      sessionId,
      timeoutMs: SessionManager.INIT_TIMEOUT_MS,
      initializingSessions: this.initializingSessions,
      logger: sessionLogger,
    });
    this.initializingSessions.set(sessionId, initPromise);

    // ★ 所有重初始化在后台异步执行，不阻塞返回
    this.launchLeaderDetached(
      sessionId,
      () => this.initializeSessionAsync(sessionId, workspace, userRequest, options, initResolve, initReject),
      'Leader 执行',
    );

    return sessionId;
  }

  /** 后台异步执行完整的会话初始化流程 */
  private async initializeSessionAsync(
    sessionId: string,
    workspace: string,
    userRequest: MessageContent | object,
    options: { idle?: boolean } | undefined,
    initResolve: (state: SessionState) => void,
    initReject: (err: unknown) => void,
  ): Promise<string> {
    let runtime: ReturnType<typeof createSessionRuntime> | undefined;
    try {
      runtime = await this.buildSessionRuntime(sessionId, workspace);
      const processedRequest = await this.processInitialRequest(sessionId, workspace, userRequest, runtime, options);

      await this.persistIntuitionSnapshot(sessionId, workspace, processedRequest);

      const newSessionState = await this.sessionFactory.create({
        sessionId,
        workspace,
        userRequest: processedRequest,
        runtime,
        status: 'active',
        isLeaderBusy: !options?.idle,
      });

      this.attachCleanupHooks(sessionId, newSessionState, runtime);
      await this.createBaselineSnapshot(sessionId);

      // 通知所有 await waitForSessionReady 的调用方：会话已就绪。
      // 基线快照先完成，避免首轮输入/工具快照与 Session Start 抢基线 git。
      initResolve(newSessionState);
      this.initializingSessions.delete(sessionId);

      this.setupEventSubscriptions(sessionId);
      await this.dispatchFirstMessage(sessionId, processedRequest, options);

      return 'Session initialized';
    } catch (error) {
      this.rollbackFailedSession(sessionId, error, initReject, runtime);
      throw error;
    }
  }

  /** 构建会话运行时：加载 skills、创建 RoleRegistry、调用 createSessionRuntime */
  private async buildSessionRuntime(sessionId: string, workspace: string) {
    const disabledNames = resolveDisabledSkillNames();
    const loadedSkills = collectAvailableSkills(workspace, { disabledNames });
    const defaultSkillsContent = buildSkillDigest(loadedSkills);

    // ★ 发射 skills:loaded 事件，通知 TUI 显示已加载 skills 日志
    this.emitter.emit('skills:loaded', {
      sessionId,
      skills: loadedSkills.map((s) => ({ name: s.name, source: s.source, summary: s.summary })),
    });

    const roleRegistry = await this.createRoleRegistryWithBuiltinRoles(workspace);
    const resolveEffectiveSessionModel = (key: string, fallback: string, label: 'Leader' | 'Agent'): string => {
      const raw = this.db.getSessionState(sessionId, key);
      const candidate = typeof raw === 'string' ? raw.trim() : '';
      if (!candidate) return fallback;
      try {
        getModelManager().getModelByIdStrict(candidate);
        return candidate;
      } catch (error) {
        this.db.deleteSessionState(sessionId, key);
        sessionLogger.warn(
          `会话 ${sessionId}：${label} session 模型 '${candidate}' 已不可用，回退到全局配置 '${fallback}' (${error instanceof Error ? error.message : String(error)})`,
        );
        return fallback;
      }
    };
    const effectiveLeaderModel = resolveEffectiveSessionModel(
      SESSION_KEYS.CURRENT_MODEL,
      runtimeConfig.llm.leader_model,
      'Leader',
    );
    const effectiveAgentModel = resolveEffectiveSessionModel(
      SESSION_KEYS.CURRENT_AGENT_MODEL,
      runtimeConfig.llm.agent_model,
      'Agent',
    );
    return createSessionRuntime({
      sessionId,
      workspacePath: workspace,
      db: this.db,
      emitter: this.emitter,
      roleRegistry,
      leaderModel: effectiveLeaderModel,
      agentModel: effectiveAgentModel,
      defaultSkillsContent,
      scheduledTaskManager: this.scheduledTaskManager,
    });
  }

  /** 处理首条用户消息：身份探测拦截 + Skill 注入 */
  private async processInitialRequest(
    sessionId: string,
    workspace: string,
    userRequest: MessageContent | object,
    runtime: ReturnType<typeof createSessionRuntime>,
    options: { idle?: boolean } | undefined,
  ): Promise<MessageContent | object> {
    if (!shouldProcessInitialUserRequest(userRequest, options)) {
      return userRequest;
    }
    this.emitter.emit('leader:phase_change', { sessionId, phase: 'preparing' });
    return this.handleSkills(userRequest as MessageContent, workspace);
  }

  /** 若 processedRequest 为 MessageContent 类型，持久化直觉快照 */
  private async persistIntuitionSnapshot(
    sessionId: string,
    workspace: string,
    processedRequest: MessageContent | object,
  ): Promise<void> {
    if (typeof processedRequest === 'string' || Array.isArray(processedRequest) || processedRequest === null) {
      const intuition = buildIntuitionSnapshot(processedRequest as MessageContent, workspace);
      await this.db.setSessionState(sessionId, SESSION_KEYS.INTUITION_SNAPSHOT, intuition);
    }
  }

  /** 挂载 TeamCommunicationService cleanup 钩子（必须在 sessions.set 之后） */
  private attachCleanupHooks(
    sessionId: string,
    state: SessionState,
    runtime: ReturnType<typeof createSessionRuntime>,
  ): void {
    state._disposeTeamCommunication = () => {
      try { runtime.teamCommunicationService.cleanup(); } catch (err) {
        sessionLogger.debug(`[SessionManager] dispose teamCommunicationService 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        void import('../core/TeamRequestTracker.js').then(m => m.disposeTeamRequestTracker(sessionId));
      } catch { /* tolerate */ }
    };
  }

  /** 创建 "Session Start" 基线快照（非关键路径，失败不影响流程） */
  private async createBaselineSnapshot(sessionId: string): Promise<void> {
    try {
      const { FileChangesApi } = await import('../web-server/FileChangesApi.js');
      const { DatabaseRepositoryAdapter } = await import('../core/DatabaseRepositories.js');
      const fca = new FileChangesApi(new DatabaseRepositoryAdapter(this.db));
      await fca.createSnapshot(sessionId, 'Session Start');
    } catch {
      // Baseline snapshot is non-critical
    }
  }

  /** 注册 round_complete / session:completed 事件监听 */
  private setupEventSubscriptions(sessionId: string): void {
    const currentSession = this.sessions.get(sessionId)!;

    const roundCompleteUnsub = this.emitter.subscribe('leader:round_complete', (data: unknown) => {
      const { sessionId: sid } = data as { sessionId: string };
      if (sid !== sessionId) return;
      this._drainPendingMessages(sid);
      // 首轮完成后尝试自动命名（fire-and-forget，不阻塞主链）
      void this._maybeAutoNameSession(sid);
    });
    currentSession._roundCompleteUnsub = roundCompleteUnsub;

    // ★ 订阅 leader:error：Leader 崩溃时重置 isLeaderBusy，避免消息永久卡在 busy 状态
    // 根因：launchLeaderDetached 的 catch 只 emit leader:error 但不重置 isLeaderBusy；
    // round_complete 永远不触发 → _drainPendingMessages 永远不执行 → 后续消息无法投递
    const leaderErrorUnsub = this.emitter.subscribe('leader:error', (data: unknown) => {
      const { sessionId: sid } = data as { sessionId: string };
      if (sid !== sessionId) return;
      const s = this.sessions.get(sid);
      if (!s) return;
      if (s.isLeaderBusy) {
        s.isLeaderBusy = false;
        sessionLogger.warn(`leader:error 重置 isLeaderBusy=false (session=${sid})`);
        this.scheduleSessionRuntimeStatePublish(sid, { source: 'leader_error', reason: 'busy_reset' });
      }
    });
    currentSession._leaderErrorUnsub = leaderErrorUnsub;

    if (shouldAutoExtractMemory(this.autoExtractSoulOnComplete, runtimeConfig.memory)) {
      const completedUnsub = this.emitter.subscribe('session:completed', async (data: { sessionId: string }) => {
        if (data.sessionId !== sessionId) return;
        await this._autoExtractSoul(sessionId);
      });
      currentSession._completedUnsub = completedUnsub;
    }
  }

  /** 首条用户消息通过 MessageBus 发送给 Leader（idle 模式跳过） */
  private async dispatchFirstMessage(
    sessionId: string,
    processedRequest: MessageContent | object,
    options: { idle?: boolean } | undefined,
  ): Promise<void> {
    if (!options?.idle) {
      const firstMsg = (processedRequest as MessageContent | undefined) ?? '';
      const firstMsgText = typeof firstMsg === 'string' ? firstMsg : contentToPlainText(firstMsg);
      if (firstMsgText) {
        await this._sendToBus(this.sessions.get(sessionId)!, firstMsg);
      }
    } else {
      const s = this.sessions.get(sessionId)!;
      s.isLeaderBusy = false;
    }
  }

  /** 初始化失败时清理半成品 session 并通知等待方 */
  private rollbackFailedSession(
    sessionId: string,
    error: unknown,
    initReject: (err: unknown) => void,
    runtime?: ReturnType<typeof createSessionRuntime>,
  ): void {
    sessionLogger.error(`会话 ${sessionId} 初始化失败:`, error);
    this.db.updateSessionStatus(sessionId, 'failed', error instanceof Error ? error.message : String(error));

    this.emitter.emit('session:failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    // #5 关键修复:显式 dispose 半成品 runtime 的 leader/pool,否则其共享 emitter 监听器(leader 的
    // task:failed/cancelled、eternal 监听等)与 teamComm 订阅永久泄漏,跨多次 init 失败累积。
    // runtime 是权威引用——无论 session 是否已 sessions.set:
    //  - 未 set(失败发生在 sessionFactory.create 之前):halfBaked undefined,只有 runtime 引用可清理。
    //  - 已 set:halfBaked.leader === runtime.leader(同一实例),dispose 一次即可(leader.dispose 幂等)。
    if (runtime) {
      try { runtime.leader?.dispose(); } catch { /* tolerate */ }
      try { runtime.pool?.destroy(); } catch { /* tolerate */ }
    }

    // 同步清理内存中的半成品 session（P1 #7：失败回滚不清 Map）
    const halfBaked = this.sessions.get(sessionId);
    if (halfBaked) {
      try { halfBaked._roundCompleteUnsub?.(); } catch { /* ignore */ }
      try { halfBaked._completedUnsub?.(); } catch { /* ignore */ }
      try { halfBaked._leaderErrorUnsub?.(); } catch { /* ignore */ }
      try { halfBaked._disposeTeamCommunication?.(); } catch { /* ignore */ }
      this.sessions.delete(sessionId);
    } else if (runtime) {
      // session 未 set:teamComm 没有 SessionState hook 可退订,直接 cleanup 服务本身。
      try { runtime.teamCommunicationService?.cleanup(); } catch { /* tolerate */ }
    }

    initReject(error);
    this.initializingSessions.delete(sessionId);
  }

  /**
   * 等待会话从"已发出 sessionId"到"sessions Map 已注册可用"的窗口期就绪。
   *
   * 调用 createSession 后立即拿到 sessionId 的客户端（TUI/Web/ACP）若马上发 sendUserInput，
   * 在 detached 异步链跑到 sessions.set 之前会撞上 session_not_found。本方法返回:
   *  - 已注册：直接返回 SessionState
   *  - 仍在初始化：等待 initializingSessions 中对应 Promise（成功或失败）
   *  - 既不在 sessions 也不在 initializing：返回 undefined（外部按 not_found 处理）
   *
   * timeoutMs 防止初始化卡死时无限等待，默认 30s（足够覆盖大模型探测/skills 加载耗时）。
   */
  private async waitForSessionReady(sessionId: string, timeoutMs = 30_000): Promise<SessionState | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const initPromise = this.initializingSessions.get(sessionId);
    if (!initPromise) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        initPromise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
    } catch (err) {
      // 初始化失败：返回 undefined 让上层抛 session_not_found，但记录真实原因 ——
      // 否则 DB/Leader 构造等真实失败被吞成无 cause 的 session_not_found，无法诊断。
      sessionLogger.warn(
        `[SessionManager] 会话 ${sessionId} 初始化失败，将上报为 session_not_found:`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Resolve a runtime session for interactive input.
   *
   * Unlike waitForSessionReady(), this also restores sessions that are still
   * persisted in DB but were released from memory by terminal/idle cleanup.
   * TUI/CLI callers go directly through SessionManager, so the auto-resume
   * behavior must live here instead of only in HTTP routes.
   */
  private async getSessionForInput(sessionId: string): Promise<SessionState | undefined> {
    const ready = this.sessions.get(sessionId) ?? await this.waitForSessionReady(sessionId);
    if (ready) return ready;

    const info = this.db.getSession(sessionId);
    if (!info || !isRestorableInputSessionStatus(info.status)) {
      return undefined;
    }

    const resumed = await this.resumeSession(sessionId);
    if (!resumed) return undefined;
    return this.sessions.get(sessionId);
  }

  /**
   * 发送用户输入到 Leader
   * 
   * 用户输入优先级高于内部自治事件。Leader 正忙时也必须立即投递到 bus，
   * 并中断当前 Leader LLM round，让主循环尽快消费用户意图。
   */
  async sendUserInput(sessionId: string, message: MessageContent, options?: { interrupt?: boolean; source?: string }): Promise<void> {
    // 优先读已就绪 session；若处于"createSession 已返回 id 但 sessions.set 还没跑"的窗口期，
    // 等待初始化完成后再继续；若运行态已被清理但 DB 仍有非终态会话，则自动恢复。
    const session = await this.getSessionForInput(sessionId);
    if (!session) {
      throw new Error(t('error.session_not_found', sessionId));
    }

    if (isEmptyContent(message)) {
      sessionLogger.debug(`sendUserInput: ignored empty input for session=${sessionId}`);
      throw new Error('message is required');
    }

    this.emitter.emit('leader:phase_change', { sessionId, phase: 'preparing' });

    let enrichedMessage: MessageContent;
    enrichedMessage = await this.handleSkills(message, session.workspace);
    const intuition = buildIntuitionSnapshot(enrichedMessage, session.workspace);
    await this.db.setSessionState(sessionId, SESSION_KEYS.INTUITION_SNAPSHOT, intuition);

    const currentGate = this.db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_GATE);
    const isAskUserAnswer = Boolean(
      currentGate && typeof currentGate === 'object' && !Array.isArray(currentGate) &&
      (currentGate as { kind?: unknown }).kind === 'ask_user'
    );

    // 设置等待用户输入状态（Leader 消费后会清除此状态）
    await this.db.setSessionState(sessionId, SESSION_KEYS.PENDING_USER_INPUT, typeof enrichedMessage === 'string' ? enrichedMessage : enrichedMessage);

    const userMsgText = contentToPlainText(enrichedMessage);
    if (userExplicitlyForbidsToolUse(enrichedMessage)) {
      await this.db.setSessionState(sessionId, SESSION_KEYS.TOOL_USE_SUPPRESSION_PENDING, 'true');
    } else {
      this.db.deleteSessionState(sessionId, SESSION_KEYS.TOOL_USE_SUPPRESSION_PENDING);
      this.db.deleteSessionState(sessionId, SESSION_KEYS.TOOL_USE_SUPPRESSION_TURN_ID);
    }

    if (isAskUserAnswer) {
      this.db.deleteSessionState(sessionId, SESSION_KEYS.PENDING_USER_GATE);
      this.emitter.emit('user:question_answered', { sessionId, answer: userMsgText });
    }

    sessionLogger.info(`sendUserInput: isLeaderBusy=${session.isLeaderBusy}, leaderRunning=${session.leader.isRunning}, msg=${String(enrichedMessage).substring(0, 50)}`);

    // 广播用户消息到所有 UI（TUI/Web），实现跨端同步
    // 消息会通过 MessageBus 到达 LeaderAgent，由 LeaderAgent.addMessage() 统一持久化到 leader_conversation
    // source 标识发送方，接收方据此跳过自己的消息
    if (userMsgText) {
      this.emitter.emit('chat:user_message', {
        sessionId,
        role: 'user',
        content: userMsgText,
        timestamp: Date.now(),
        source: options?.source,
      });
    }

    // Interrupt 判定只读 LeaderAgent.busy；runtime_state snapshot 是对外唯一 busy 来源。
    // Track activity for idle TTL
    this.sessionLastActivity.set(sessionId, Date.now());
    const leaderIsBusy = Boolean(session.leader.busy);
    if (leaderIsBusy) {
      const shouldInterrupt = options?.interrupt !== false; // 默认打断
      if (shouldInterrupt) {
        sessionLogger.debug(`Leader 正忙，立即投递用户介入并中断当前 round: ${String(enrichedMessage).substring(0, 50)}`);
        await this._sendToBus(session, enrichedMessage);
        session.leader.interruptCurrentRound?.('user_input');
        this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'send_user_input', reason: 'interrupt' });
      } else {
        sessionLogger.debug(`Leader 正忙或 busy 标志未释放，非打断式排队用户输入: ${String(enrichedMessage).substring(0, 50)}`);
        session.isLeaderBusy = true;
        this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'send_user_input', reason: 'queued_user_input' });
        await this._sendToBus(session, enrichedMessage);
      }
      return;
    }

    // Leader 空闲：直接发送到 busช并标记为忙
    session.isLeaderBusy = true;
    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'send_user_input', reason: 'direct_user_input' });
    
    sessionLogger.info(`sendUserInput: sending to bus, leaderRunning=${session.leader.isRunning}`);
    await this._sendToBus(session, enrichedMessage);
  }

  private buildIdleAgentWakeMessage(agentName: string, message: MessageContent): MessageContent {
    const prefix = `用户在 @${agentName} 空闲后发来后续消息。请读取前文/笔记，按这条消息继续处理或回复：`;
    if (Array.isArray(message)) {
      return [
        { type: 'text' as const, text: prefix },
        ...message,
      ];
    }
    return `${prefix}\n\n${contentToPlainText(message)}`;
  }

  /**
   * 向指定 Agent 发送用户输入。
   * running/starting: 直接投递到 bus；idle/completed/failed: 持久化消息并唤醒同名 continuation agent。
   */
  async sendAgentInput(sessionId: string, agentName: string, message: MessageContent): Promise<SendAgentInputResult> {
    const session = await this.getSessionForInput(sessionId);
    if (!session) {
      throw new Error(t('error.session_not_found', sessionId));
    }

    const normalizedName = AgentPool.normalizeAgentName(agentName);
    const handle = session.pool.getByName(normalizedName);
    const state = !handle
      ? this.db.getAgentStates(sessionId)
          .filter((s) => AgentPool.normalizeAgentName(s.agent_name) === normalizedName)
          .sort((a, b) => b.timestamp - a.timestamp)[0]
      : undefined;

    const agentId = handle?.agentId || state?.agent_id;
    const roleType = handle?.roleType || state?.agent_role;
    const sourceTaskId = handle?.taskId || state?.task_id;

    if (!agentId || !roleType || !sourceTaskId) {
      return {
        ok: false,
        mode: 'not_found',
        message: `未找到 Agent @${normalizedName} 的可恢复运行信息`,
      };
    }

    // 追问投递只看 AgentPool runtime active 语义；starting 也算可接收，避免刚 respawn 时误走唤醒分支。
    if (handle && isAgentRuntimeActiveStatus(handle)) {
      session.bus.send(`${sessionId}:user`, `${sessionId}:${normalizedName}`, 'message', message);
      return {
        ok: true,
        mode: 'delivered',
        message: `已发送到运行中的 Agent @${normalizedName}`,
      };
    }

    const wakeMessage = this.buildIdleAgentWakeMessage(normalizedName, message);
    await this.db.saveAgentMessage?.(sessionId, agentId, normalizedName, {
      role: 'user',
      content: wakeMessage,
    });

    const sourceTask = session.board.getTask(sourceTaskId) || this.db.getTask?.(sourceTaskId, sessionId);
    if (!sourceTask) {
      this.emitter.emit('agent:status', {
        agentId,
        agentName: normalizedName,
        status: '收到用户后续消息，但原任务不存在，已保存到 Agent 历史',
      });
      return {
        ok: true,
        mode: 'queued',
        message: `@${normalizedName} 当前未运行，消息已保存；原任务 ${sourceTaskId} 不存在，无法自动唤醒`,
      };
    }

    const continuationTaskId = session.board.nextTaskId();
    const plain = contentToPlainText(message);
    const continuationTask = session.board.createTask(
      continuationTaskId,
      `Follow-up for @${normalizedName}`,
      [
        `用户向空闲 Agent @${normalizedName} 发送了后续消息。`,
        `原任务: ${sourceTask.id} - ${sourceTask.subject}`,
        '',
        '[用户消息]',
        plain,
        '',
        '请结合该 Agent 既有对话历史和工作笔记继续处理。若只是问询，请直接回答；若需要继续修改/验证，请完成后写 work note。',
      ].join('\n'),
      roleType,
      [],
      [],
      {
        working_directory: sourceTask.working_directory,
        write_scope: sourceTask.write_scope,
      },
      [
        `Continuation for idle agent @${normalizedName}.`,
        `source_task_id=${sourceTask.id}`,
        `source_task_status=${sourceTask.status}`,
        `source_task_subject=${sourceTask.subject}`,
      ].join('\n'),
    );
    const assignedContinuationTask = session.board.assignTask(continuationTask.id, normalizedName) ?? continuationTask;

    const nextHandle = session.pool.register(normalizedName, roleType, continuationTask.id, agentId);
    nextHandle.taskRunGeneration = assignedContinuationTask.runGeneration;
    const respawnPromise = session.pool.respawnAgent(nextHandle, assignedContinuationTask, plain);
    nextHandle.asyncTask = respawnPromise;
    void respawnPromise.catch((error) => {
      sessionLogger.error(`Agent @${normalizedName} 后续全量历史续跑失败:`, error);
      this.emitter.emit('agent:status', {
        agentId,
        agentName: normalizedName,
        status: `后续全量历史续跑失败: ${error instanceof Error ? error.message : String(error)}`,
      });
    });

    this.emitter.emit('agent:status', {
      agentId,
      agentName: normalizedName,
      status: '已收到用户后续消息并唤醒继续处理',
    });

    return {
      ok: true,
      mode: 'woken',
      message: `@${normalizedName} 当前未运行，已创建 ${continuationTask.id} 并唤醒继续处理`,
    };
  }

  /**
   * 内部：将消息发送到 bus，如果 Leader 已结束则重启
   */
  private async _sendToBus(session: SessionState, message: MessageContent): Promise<void> {
    const { sessionId } = session;
    await session.bus.send(`${sessionId}:user`, `${sessionId}:leader`, 'user_intervention', message);

    if (session.leader.busy) {
      sessionLogger.debug(`[实时介入] Leader 正忙，用户消息已立即送达`);
    }

    const leaderRunning = session.leader.isRunning;
    sessionLogger.info(`sendUserInput: leaderRunning=${leaderRunning}, session=${sessionId}`);

    if (session.status !== 'active') {
      session.status = 'active';
      this.db.updateSessionStatus(sessionId, 'active');
    }
    session.isLeaderBusy = true;
    await this.db.setSessionState(sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'false');
    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'user_input', reason: 'user_input' });

    if (!leaderRunning) {
      sessionLogger.debug(`重启 Leader 进行后续对话：${sessionId}`);

      // 收集被中断的任务，传给 Leader.run() 以便恢复（避免任务卡在 in_progress 状态）
      const agentStates = this.db.getAgentStates(sessionId);
      const checkpoints = loadAgentResumeCheckpoints(this.db, sessionId);
      const recoveredTasks = collectRecoveredTasks(session.board, agentStates, checkpoints);

      this.launchLeaderDetached(
        sessionId,
        () => session.leader.run(undefined, true, recoveredTasks.length > 0 ? recoveredTasks : undefined),
        'Leader 重启',
      );
    }
  }

  /**
   * 内部： leader:round_complete 后，释放忙标志
   *
   * 实时介入机制下消息已通过 interrupt/nudge 立即送达，无需排队。
   */
  private _drainPendingMessages(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 释放忙标志（同步 leader 状态）
    session.isLeaderBusy = false;
    sessionLogger.debug('round_complete，释放 Leader 忙标志');

    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'leader_round_complete' });
  }

  /**
   * 首轮对话完成后自动为会话生成一个简短名称（fire-and-forget）。
   *
   * - 仅在会话尚无 name 时触发，且每个 session 进程内只尝试一次（autoNamedSessions 去重）。
   * - 命名素材取首条 user 消息 + 首条 assistant 文本回复，复用 session.llm 做一次轻量非流式调用。
   * - 失败不抛错、不影响主链；成功后写库并 emit 'session:renamed' 让所有 UI 实时刷新。
   */
  private async _maybeAutoNameSession(sessionId: string): Promise<void> {
    if (this.autoNamedSessions.has(sessionId)) return;
    this.autoNamedSessions.add(sessionId);

    try {
      const existing = this.db.getSession(sessionId);
      // 已有用户/此前生成的名称则跳过，不覆盖
      if (!existing || (existing.name && existing.name.trim())) return;

      const session = this.sessions.get(sessionId);
      const llm = session?.llm;
      const model = runtimeConfig.llm.leader_model;
      if (!llm || !model) return;

      // 取首条用户消息
      const userMsgs = this.db.getConversationMessages(sessionId, 'user');
      const firstUser = userMsgs.length > 0 ? contentToPlainText(userMsgs[0]!.content as MessageContent) : '';
      if (!firstUser.trim()) return;

      // 取首条 assistant 文本回复（可能为空，作为补充素材）
      const assistantMsgs = this.db.getConversationMessages(sessionId, 'assistant');
      const firstAssistant = assistantMsgs.length > 0 ? contentToPlainText(assistantMsgs[0]!.content as MessageContent) : '';

      const material = [
        `用户首条消息：${firstUser.slice(0, 1500)}`,
        firstAssistant.trim() ? `助手首轮回复：${firstAssistant.slice(0, 800)}` : '',
      ].filter(Boolean).join('\n\n');

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            '你为一段对话生成简短标题，用于会话列表展示。',
            '要求：概括对话主题，不超过 16 个字（中文）或 6 个英文单词；',
            '只输出标题本身；省略引号、结尾标点、前缀（如「标题：」）和解释。',
          ].join(''),
        },
        { role: 'user', content: material },
      ];

      const guard = createLlmGuard({
        actorLabel: 'SessionAutoName',
        maxRetries: 2,
        cbScope: 'session_auto_name',
        langfuseSessionId: sessionId,
        langfuseAgentId: 'SessionAutoName',
      });
      const response = await guard.call(
        llm,
        messages,
        model,
        undefined,
        false,
        undefined,
        undefined,
        {
          actorType: 'system',
          actorLabel: 'SessionAutoName',
          purpose: 'summary',
          sessionId,
          requestedModel: model,
        },
        { maxTokens: 64, ...getReasoningGenerateOptions() },
      );
      let title = contentToPlainText(response.content).trim();
      if (!title) return;
      // 清洗：去掉可能的引号/换行/「标题：」前缀，限制长度
      title = title.replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s*\n[\s\S]*$/, '').replace(/^(标题|title)\s*[:：]\s*/i, '').trim();
      if (!title) return;
      if (title.length > 40) title = title.slice(0, 40);

      this.db.updateSessionName(sessionId, title);
      this.emitter.emit('session:renamed', { sessionId, name: title });
      sessionLogger.info(`[AutoName] 会话 ${sessionId} 自动命名为「${title}」`);
    } catch (error) {
      sessionLogger.debug(`[AutoName] 会话 ${sessionId} 自动命名失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 会话结束时自动提取长期记忆内容
   *
   * 从会话日志中过滤噪音，提取用户偏好/决策/架构等关键信息，
   * 写入统一 MemoryManager（用户级或项目级）。
   */
  private async _autoExtractSoul(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 导入 SoulExtractor（延迟加载，避免循环依赖；命名保留作兼容）
    const { extractSoulContent, formatSoulEntry } = await import('../core/SoulExtractor.js');

    // 获取会话日志
    const logs = session.bus.getHistory();
    const entries = extractSoulContent(logs);

    if (entries.length === 0) {
      sessionLogger.info(`会话 ${sessionId} 无长期记忆可提取`);
      this.emitter.emit('session:soul_extracted', {
        sessionId,
        soulPath: undefined,
        entryCount: 0,
      });
      return;
    }

    const timestamp = new Date().toISOString();
    const manager = new MemoryManager(session.workspace);
    const savedPaths: string[] = [];

    entries.forEach((entry, index) => {
      try {
        const scope = entry.scope as MemoryScope;
        const content = [
          `source: session:auto_extract`,
          `sessionId: ${sessionId}`,
          `category: ${entry.category}`,
          '',
          formatSoulEntry(entry, timestamp).trim(),
        ].join('\n');
        const saved = manager.saveMemory(
          memoryName('session-memory', timestamp, index, entry.content),
          memoryTypeForExtractedEntry(scope, entry.category),
          compactMemoryLine(entry.content, 140),
          content,
          scope,
        );
        savedPaths.push(saved.filePath);
        sessionLogger.info(`会话记忆已保存到 ${saved.filePath}`);
      } catch (err) {
        sessionLogger.error(`会话记忆写入失败:`, err);
      }
    });

    // 通知 TUI
    this.emitter.emit('session:soul_extracted', {
      sessionId,
      soulPath: savedPaths[0],
      entryCount: savedPaths.length,
    });
  }

  /**
   * 恢复已存在的会话（全现场恢复）
   */
  async resumeSession(sessionId: string, options?: { startLeader?: boolean }): Promise<boolean> {
    const info = this.db.getSession(sessionId);
    if (!info) {
      return false;
    }

    // 如果会话已经在内存中，直接返回
    if (this.sessions.has(sessionId)) {
      return true;
    }

    const initPromise = this.initializingSessions.get(sessionId);
    if (initPromise) {
      try {
        await initPromise;
        return this.sessions.has(sessionId);
      } catch { /* expected: initialization may have been aborted */
        return false;
      }
    }

    // 防止并发 resume：如果已有恢复进行中，等待其结果
    const existingResume = this.resuming.get(sessionId);
    if (existingResume) {
      return existingResume;
    }

    // 创建恢复 Promise 并注册到锁表，带超时保护
    // resumeSession timeout race:timer 必须在 resume 落定(成功/失败)时被 clearTimeout 取消,
    // 否则 stale timer 在 30s 后仍会 fire 并 this.resuming.delete(sessionId)——若期间同一 session
    // 发起了新的 resume,旧 timer 会误删新 resume 的锁条目(并发 resume 防护被绕过)。
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelResumeTimer = (): void => {
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
    };
    const resumePromise = this._doResumeSession(sessionId, options).finally(() => {
      cancelResumeTimer();
      this.resuming.delete(sessionId);
    });

    // Fix #3: resume 超时保护 — 30s 后若仍未完成，返回 false 并清理 Map 条目
    const timedResumePromise = Promise.race([
      resumePromise,
      new Promise<boolean>((resolve) => {
        resumeTimer = setTimeout(() => {
          sessionLogger.warn(`[SessionManager] 会话 ${sessionId} resume 超时(${SessionManager.RESUME_TIMEOUT_MS}ms)，释放 resuming 锁`);
          this.resuming.delete(sessionId);
          resolve(false);
        }, SessionManager.RESUME_TIMEOUT_MS);
        if (resumeTimer.unref) resumeTimer.unref();
      }),
    ]);

    this.resuming.set(sessionId, timedResumePromise);
    return timedResumePromise;
  }

  private async _doResumeSession(sessionId: string, options?: { startLeader?: boolean }): Promise<boolean> {
    const info = this.db.getSession(sessionId);
    if (!info) {
      return false;
    }

    // 二次检查：等待锁期间可能已被其他路径创建
    if (this.sessions.has(sessionId)) {
      return true;
    }

    await killExternalAgentOrphans(sessionId).catch((error) => {
      sessionLogger.warn(`清理会话 ${sessionId} 外部 Agent 孤儿进程失败:`, error);
    });

    // 重建会话状态
    const workspacePath = info.workspace;
    const userRequest = info.user_request as MessageContent;

    const defaultSkillsContent = buildLeaderSkillDigest(workspacePath);

    // 先创建 RoleRegistry 并注册内置角色
    const roleRegistry = await this.createRoleRegistryWithBuiltinRoles(workspacePath);
    const runtime = createSessionRuntime({
      sessionId,
      workspacePath,
      db: this.db,
      emitter: this.emitter,
      roleRegistry,
      leaderModel: runtimeConfig.llm.leader_model,
      agentModel: runtimeConfig.llm.agent_model,
      defaultSkillsContent,
      scheduledTaskManager: this.scheduledTaskManager,
    });

    const persistedStatus = isPersistedSessionStatus(info.status) ? info.status : 'active';

    await this.sessionFactory.create({
      sessionId,
      workspace: workspacePath,
      userRequest,
      runtime,
      status: persistedStatus,
      isLeaderBusy: false,
    });

    // TeamCommunicationService cleanup 钩子 — resume 路径同步挂上
    const resumedSession = this.sessions.get(sessionId)!;
    resumedSession._disposeTeamCommunication = () => {
      try { runtime.teamCommunicationService.cleanup(); } catch (err) {
        sessionLogger.debug(`[SessionManager] dispose teamCommunicationService 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        void import('../core/TeamRequestTracker.js').then(m => m.disposeTeamRequestTracker(sessionId));
      } catch { /* tolerate */ }
    };

    // 监听 leader:round_complete，释放下一条待处理消息
    const roundCompleteUnsub = this.emitter.subscribe('leader:round_complete', (data: unknown) => {
      const { sessionId: sid } = data as { sessionId: string };
      if (sid !== sessionId) return;
      this._drainPendingMessages(sid);
      // resume 后若该会话仍未命名（早期会话无 name），首轮完成时补一次自动命名
      void this._maybeAutoNameSession(sid);
    });
    const currentSession = this.sessions.get(sessionId)!;
    currentSession._roundCompleteUnsub = roundCompleteUnsub;

    // ★ 订阅 leader:error：Leader 崩溃时重置 isLeaderBusy（与 setupEventSubscriptions 对称）
    const leaderErrorUnsub = this.emitter.subscribe('leader:error', (data: unknown) => {
      const { sessionId: sid } = data as { sessionId: string };
      if (sid !== sessionId) return;
      const s = this.sessions.get(sid);
      if (!s) return;
      if (s.isLeaderBusy) {
        s.isLeaderBusy = false;
        sessionLogger.warn(`leader:error 重置 isLeaderBusy=false (session=${sid}, resume path)`);
        this.scheduleSessionRuntimeStatePublish(sid, { source: 'leader_error', reason: 'busy_reset' });
      }
    });
    currentSession._leaderErrorUnsub = leaderErrorUnsub;

    // 从数据库加载历史任务状态
    await runtime.board.loadFromDB();

    // 回退 in_progress / interrupted 任务
    const agentStates = this.db.getAgentStates(sessionId);
    const checkpoints = loadAgentResumeCheckpoints(this.db, sessionId);
    const recoveredTasks = collectRecoveredTasks(runtime.board, agentStates, checkpoints);
    for (const recoveredTask of recoveredTasks) {
      const task = runtime.board.getTask(recoveredTask.id);
      if (!task) continue;
      if (task.status === 'terminal') continue;
      const agentName = (recoveredTask.agent && recoveredTask.agent !== 'unknown')
        ? recoveredTask.agent
        : task.assigned_agent;
      if (!agentName) continue;
      if (task.assigned_agent !== agentName || task.status !== 'running') {
        runtime.board.assignTask(task.id, agentName);
      }
    }
    for (const recoveredTask of recoveredTasks) {
      sessionLogger.info(`加载可恢复任务：${recoveredTask.id} (${recoveredTask.subject})${recoveredTask.detail}`);
    }

    if (options?.startLeader) {
      // 显式续跑时才启动 Leader。普通 Web/TUI 加载历史只应做被动恢复。
      this.db.updateSessionStatus(sessionId, 'active');
      this.sessions.get(sessionId)!.status = 'active';
      setTimeout(() => {
        runtime.leader.run(userRequest, true, recoveredTasks)
          .catch(error => sessionLogger.error('Leader 恢复失败:', error));
      }, 0);
    } else {
      // 进程重启后 DB 里可能残留 running/starting 状态；被动恢复不能伪造仍在运行。
      for (const recoveredTask of recoveredTasks) {
        const task = runtime.board.getTask(recoveredTask.id);
        if (!task || task.status === 'terminal') continue;
        runtime.board.prepareTaskForRedispatch(
          task.id,
          `Agent @${recoveredTask.agent} was interrupted before this session was passively resumed.`,
        );
      }
      for (const state of agentStates) {
        const terminal = isAgentTerminalStatus(state.status);
        if (state.stopped === 1 || terminal) continue;
        this.db.saveAgentState({
          ...state,
          status: 'interrupted',
          stopped: 1,
          timestamp: Date.now() / 1000,
        });
      }
    }

    return true;
  }

  /**
   * 中断会话：停止 Leader + 所有 Agent，保存状态以便后续 resume
   */
  async interruptSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // 1. 停止所有运行中的 Agent
    const runningAgents = session.pool.getRunning();
    for (const handle of runningAgents) {
      saveAgentResumeCheckpoint(this.db, sessionId, {
        agentId: handle.agentId,
        agentName: handle.name,
        agentRole: handle.roleType,
        taskId: handle.taskId,
        iteration: handle.iteration ?? 0,
        toolCallCount: handle.toolCalls ?? 0,
        timestamp: Date.now() / 1000,
      });
      // 保存 agent 状态到 DB
      await this.db.saveAgentState({
        session_id: sessionId,
        agent_id: handle.agentId,
        agent_name: handle.name,
        agent_role: handle.roleType,
        task_id: handle.taskId,
        status: 'interrupted',
        stopped: 1,
        iteration: handle.iteration || 0,
        timestamp: Date.now() / 1000,
      });
    }

    // 2. 真实停止 worker 与 Leader 的执行链
    session.pool.stopAll();
    await killExternalAgentOrphans(sessionId).catch((error) => {
      sessionLogger.warn(`中断会话 ${sessionId} 时清理外部 Agent 孤儿进程失败:`, error);
    });
    session.leader.stop();
    session.isLeaderBusy = false;

    // ESC 中断后设置 waitingForUser，确保 Leader 重启后不会盲目调 LLM
    await this.db.setSessionState(sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');

    // 3. 更新会话状态
    session.status = 'interrupted';
    this.db.updateSessionStatus(sessionId, 'interrupted');

    // 4. 发射事件
    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'session_interrupted', reason: 'interrupted' });
    this.emitter.emit('session:interrupted', {
      sessionId,
      stoppedAgents: runningAgents.length,
    });

    sessionLogger.info(
      `会话 ${sessionId} 已中断，${runningAgents.length} 个 Agent 被停止`
    );

    return true;
  }

  /**
   * Warm-restart：强制 live Leader 从（已被 /rewind 截断的）DB 重新读取会话。
   * 在 FileChangesApi.revert() 截断 leader_conversation / agent_conversation 之后调用。
   *
   * 设计要点（对比 /clear 与现有 Web revert 路径——它们都不重载 live Leader，留下陈旧内存）：
   * - 若 Leader 仍在运行直接返回 false（调用方须先 interruptSession，避免并发两份 run()）。
   * - 通过 run(undefined, true, undefined) 重跑 _runImpl_initializeSession，在 LeaderAgent 内
   *   this.conversation = db.getConversationMessages(...) 重载为截断后的对话。
   * - 显式置 LEADER_WAITING_FOR_USER='true'，确保重启后停在 waiting-for-user，不会盲目起 LLM
   *   （即便本次未走 interruptSession 的 idle 路径也安全）。
   * - worker 已被 interruptSession/pool.stopAll 释放，重派时从截断后的 DB 重新水合。
   * @returns true 表示已调度 warm-restart。
   */
  rewindConversation(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sessionLogger.warn(`rewindConversation(${sessionId}): 会话不在内存中`);
      return false;
    }
    if (session.leader.isRunning) {
      sessionLogger.warn(`rewindConversation(${sessionId}): Leader 仍在运行，调用方须先 interruptSession`);
      return false;
    }
    // 防御性置 waiting-for-user：保证回退后 Leader 不会盲目自动起 LLM。
    this.db.setSessionState(sessionId, SESSION_KEYS.LEADER_WAITING_FOR_USER, 'true');
    // 中断态复位为 active（会话重新可用，停在等待用户输入）。
    if (session.status === 'interrupted') {
      session.status = 'active';
      this.db.updateSessionStatus(sessionId, 'active');
    }
    session.isLeaderBusy = false;
    this.sessionLastActivity.set(sessionId, Date.now());
    this.launchLeaderDetached(
      sessionId,
      () => session.leader.run(undefined, true, undefined),
      'Leader rewind warm-restart',
    );
    sessionLogger.info(`rewindConversation(${sessionId}): 已调度 Leader warm-restart 以重载截断后的会话`);
    return true;
  }

  /**
   * 停止单个 Agent（不影响 Leader 与其它 Agent），保存状态以便后续 resume。
   * 用于 Web/TUI 上的「停止此 Agent」按钮：精确停止用户指定的那一个，而非全局中断。
   * @returns true 表示找到并停止了运行中的 Agent；false 表示会话不存在或该 Agent 未在运行。
   */
  async stopAgent(sessionId: string, agentName: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const normalizedName = AgentPool.normalizeAgentName(agentName);
    const handle = session.pool.getByName(normalizedName);
    if (!handle || !isAgentRuntimeActiveStatus(handle)) {
      return false;
    }

    // 1. 保存 resume 检查点 + Agent 状态到 DB（与 interruptSession 单 Agent 路径同口径）
    saveAgentResumeCheckpoint(this.db, sessionId, {
      agentId: handle.agentId,
      agentName: handle.name,
      agentRole: handle.roleType,
      taskId: handle.taskId,
      iteration: handle.iteration ?? 0,
      toolCallCount: handle.toolCalls ?? 0,
      timestamp: Date.now() / 1000,
    });
    await this.db.saveAgentState({
      session_id: sessionId,
      agent_id: handle.agentId,
      agent_name: handle.name,
      agent_role: handle.roleType,
      task_id: handle.taskId,
      status: 'interrupted',
      stopped: 1,
      iteration: handle.iteration || 0,
      timestamp: Date.now() / 1000,
    });

    // 2. 真实停止该 Agent（仅此一个，不动 Leader / 其它 Agent）
    session.pool.stopAgent(handle.name);

    // 3. 推送运行时快照，TUI/Web 据此将该 Agent 渠道状态翻为已停止
    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'agent_stopped', reason: 'stopped by user' });

    sessionLogger.info(`会话 ${sessionId}：已停止 Agent ${handle.name}（用户手动停止，Leader 与其它 Agent 不受影响）`);
    return true;
  }

  /**
   * 切换当前会话使用的模型
   */
  setModel(sessionId: string, modelId: string): { ok: boolean; message: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `会话 ${sessionId} 未激活` };
    }
    const result = session.leader.setModel(modelId);
    if (result.ok) {
      this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'leader_model_changed' });
    }
    return result;
  }

  /**
   * 将新的全局 Leader 模型即时应用到未声明 session-local override 的已加载会话。
   * 已通过聊天页模型切换写入 CURRENT_MODEL 的会话保留自己的选择，避免全局设置污染其他会话。
   * 这只影响后续 LLM round，不会打断正在进行中的请求。
   */
  setModelForActiveSessions(modelId: string): void {
    for (const sessionId of this.sessions.keys()) {
      if (this.db.getSessionState(sessionId, SESSION_KEYS.CURRENT_MODEL)) continue;
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      session.leader.setModel(modelId, { persistSessionState: false });
    }
  }

  /**
   * 切换当前会话后续新建 Agent 的默认模型。
   * 已运行中的 Worker 不会被中断；下一次 dispatch / respawn 会使用新模型。
   */
  setAgentModel(sessionId: string, modelId: string, options?: { persistSessionState?: boolean }): { ok: boolean; message: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `会话 ${sessionId} 未激活` };
    }
    if (!modelId) {
      return { ok: false, message: 'modelId 不能为空' };
    }
    const normalizedModelId = modelId.trim();
    try {
      getModelManager().getModelByIdStrict(normalizedModelId);
    } catch (error) {
      const available = getModelManager().getAllModels().map(model => model.id).join(', ') || '无';
      return {
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)} 可用模型: ${available}`,
      };
    }

    const prev = session.pool.getModel();
    session.pool.setModel(normalizedModelId);
    if (options?.persistSessionState !== false) {
      void this.db.setSessionState(sessionId, SESSION_KEYS.CURRENT_AGENT_MODEL, normalizedModelId);
    }
    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'agent_model_changed' });
    sessionLogger.info(`会话 ${sessionId}：Agent 模型已切换: ${prev} → ${normalizedModelId}`);
    return { ok: true, message: `Agent 模型已切换为 ${normalizedModelId}` };
  }

  /**
   * 将新的全局 Agent 默认模型即时应用到所有已加载会话。
   * 这只影响后续新建/调度的 Agent LLM round，不会打断正在进行中的请求。
   */
  setAgentModelForActiveSessions(modelId: string): void {
    for (const sessionId of this.sessions.keys()) {
      if (this.db.getSessionState(sessionId, SESSION_KEYS.CURRENT_AGENT_MODEL)) continue;
      this.setAgentModel(sessionId, modelId, { persistSessionState: false });
    }
  }

  /**
   * 切换当前会话权限模式
   */
  setPermissionMode(sessionId: string, mode: string): { ok: boolean; message: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `会话 ${sessionId} 未激活` };
    }
    return session.leader.setPermissionMode(mode);
  }

  /**
   * 切换当前会话控制模式（manual / eternal）
   */
  async setControlMode(sessionId: string, mode: 'manual' | 'eternal'): Promise<{ ok: boolean; message: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `会话 ${sessionId} 未激活` };
    }
    const result = await session.leader.setControlMode(mode);
    if (result.ok) {
      this.publishSessionRuntimeState(sessionId, { source: 'set_control_mode' });
    }
    return result;
  }

  setCollaborationMode(sessionId: string, mode: 'solo' | 'team'): { ok: boolean; message: string } {
    const sessionInfo = this.db.getSession(sessionId);
    if (!sessionInfo && !this.sessions.has(sessionId)) {
      return { ok: false, message: `会话 ${sessionId} 不存在` };
    }

    // team 模式是「能力开关」——翻开 mode='team' 即让 leader 进入团队协作形态。
    // 真正门控「leader 能用 team 工具 / agent 能组队互发消息」的是 projection 的 teamEnabled
    // (= mode==='team' 且有合法 active team)。合法 active team 由 leader 接着用
    // team_manage(action="create") 建立（它经 LeaderAgent.setActiveTeam 同时写 active team 与 mode），
    // 建团后 teamEnabled 自动转 true，团队能力全部通电。
    // 因此 toggle 本身只翻 flag，绝不对 active-team 做存在性校验或自动绑定——那会把「能否切换」
    // 与「是否已建团」错误耦合，导致「无法切到团队」。
    this.db.setSessionState(sessionId, SESSION_KEYS.COLLABORATION_MODE, mode);
    this.emitter.emit('session:collaboration_mode_changed', { sessionId, mode });
    this.publishSessionRuntimeState(sessionId, { source: 'set_collaboration_mode' });
    // 立即热加载运行中 Leader 的 system prompt（profile 随 solo/team 切换）+ 清理旧 hint，
    // 无需等下一条用户消息触发 think。session 未加载（不在 this.sessions）时跳过——
    // DB 已是真理，下次加载/resume 首轮 think 自然对齐。
    this.sessions.get(sessionId)?.leader.applyRuntimeModeChange?.();
    return {
      ok: true,
      message: mode === 'team'
        ? 'Collaboration mode set to team. Create a team via team_manage(action="create") to enable team tools and roster messaging.'
        : 'Collaboration mode set to solo.',
    };
  }

  setExecutionRoutePreference(sessionId: string, mode: 'auto' | 'direct' | 'hybrid' | 'delegate'): { ok: boolean; message: string } {
    const sessionInfo = this.db.getSession(sessionId);
    if (!sessionInfo && !this.sessions.has(sessionId)) {
      return { ok: false, message: `会话 ${sessionId} 不存在` };
    }
    this.db.setSessionState(sessionId, SESSION_KEYS.EXECUTION_ROUTE_OVERRIDE, mode);
    this.emitter.emit('session:execution_route_changed', { sessionId, mode });
    this.publishSessionRuntimeState(sessionId, { source: 'set_execution_route' });
    // 立即热加载：getSystemPrompt 不读 route，但 getTeamModeHint 的 route 偏好 section 会变——
    // applyRuntimeModeChange 经 pruneStaleModeHints 刷新最新 hint 内容，下次 LLM 请求即注入新 route。
    this.sessions.get(sessionId)?.leader.applyRuntimeModeChange?.();
    return {
      ok: true,
      message: `Execution route preference set to ${mode}.`,
    };
  }

  /**
   * Set autonomy mode for a session. Accepts canonical values (review_first / balanced / autonomous)
   * and the UI alias 'full_auto' (coerced to 'autonomous'). Also updates lifecycle phase,
   * increments mode generation, and emits session:autonomy_mode_changed.
   */
  setAutonomyMode(
    sessionId: string,
    mode: string,
    options?: {
      lifecyclePhase?: string;
      updatedBy?: 'web' | 'tui' | 'leader' | 'runtime_policy';
      reason?: string;
    },
  ): { ok: boolean; message: string } {
    const sessionInfo = this.db.getSession(sessionId);
    if (!sessionInfo && !this.sessions.has(sessionId)) {
      return { ok: false, message: `会话 ${sessionId} 不存在` };
    }

    // Coerce alias then normalize to canonical AutonomyMode.
    const canonical = coerceAutonomyModeAlias(mode);
    const normalized = normalizeAutonomyMode(canonical);
    if (!isAutonomyMode(canonical)) {
      // Input was neither a valid mode nor a known alias.
      return { ok: false, message: `Invalid autonomy mode: ${mode}` };
    }

    // Read previous state for event payload.
    const previousMode = normalizeAutonomyMode(
      this.db.getSessionState(sessionId, SESSION_KEYS.AUTONOMY_MODE),
    );
    const previousGeneration = (() => {
      const raw = this.db.getSessionState(sessionId, SESSION_KEYS.AUTONOMY_MODE_GENERATION);
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
    })();

    // Compute next generation.
    const nextGeneration = previousGeneration + 1;

    // Resolve lifecycle phase.
    const lifecyclePhase = options?.lifecyclePhase
      ? normalizeAutonomyLifecyclePhase(options.lifecyclePhase)
      : normalizeAutonomyLifecyclePhase(
          this.db.getSessionState(sessionId, SESSION_KEYS.AUTONOMY_LIFECYCLE_PHASE),
        );

    // Compute policy id + hash.
    const policyId = `autonomy_policy_${normalized}_${nextGeneration}`;
    const policyHash = `${normalized}:${lifecyclePhase}:${nextGeneration}`;

    const updatedBy = options?.updatedBy ?? 'leader';

    // Persist all autonomy state keys.
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_MODE, normalized);
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_LIFECYCLE_PHASE, lifecyclePhase);
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_MODE_GENERATION, nextGeneration);
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_POLICY_ID, policyId);
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_POLICY_HASH, policyHash);
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_UPDATED_BY, updatedBy);
    if (options?.reason) {
      this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_UPDATE_REASON, options.reason);
    }

    // Emit event for internal subscribers.
    this.emitter.emit('session:autonomy_mode_changed', {
      sessionId,
      previousMode,
      nextMode: normalized,
      previousGeneration,
      nextGeneration,
      lifecyclePhase,
      updatedBy,
      reason: options?.reason,
      effectivePolicyHash: policyHash,
    });

    // Publish runtime state snapshot (carries updated modes projection to Web/TUI).
    this.publishSessionRuntimeState(sessionId, { source: 'set_autonomy_mode', reason: options?.reason });

    // Hot-reload Leader system prompt so the new Policy Card takes effect on next LLM round.
    this.sessions.get(sessionId)?.leader.applyRuntimeModeChange?.();

    return {
      ok: true,
      message: `Autonomy mode set to ${normalized} (phase: ${lifecyclePhase}, generation: ${nextGeneration}).`,
    };
  }

  /**
   * Set only the lifecycle phase without changing autonomy mode.
   * Used by runtime recovery / bootstrap detection.
   */
  setAutonomyLifecyclePhase(
    sessionId: string,
    phase: string,
    reason?: string,
  ): { ok: boolean; message: string } {
    const sessionInfo = this.db.getSession(sessionId);
    if (!sessionInfo && !this.sessions.has(sessionId)) {
      return { ok: false, message: `会话 ${sessionId} 不存在` };
    }

    const normalized = normalizeAutonomyLifecyclePhase(phase);
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_LIFECYCLE_PHASE, normalized);

    // Update policy hash to reflect phase change.
    const currentMode = normalizeAutonomyMode(
      this.db.getSessionState(sessionId, SESSION_KEYS.AUTONOMY_MODE),
    );
    const currentGen = (() => {
      const raw = this.db.getSessionState(sessionId, SESSION_KEYS.AUTONOMY_MODE_GENERATION);
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
    })();
    const policyHash = `${currentMode}:${normalized}:${currentGen}`;
    this.db.setSessionState(sessionId, SESSION_KEYS.AUTONOMY_POLICY_HASH, policyHash);

    this.publishSessionRuntimeState(sessionId, { source: 'set_autonomy_lifecycle_phase', reason });
    this.sessions.get(sessionId)?.leader.applyRuntimeModeChange?.();

    return {
      ok: true,
      message: `Autonomy lifecycle phase set to ${normalized}.`,
    };
  }

  getEternalGoal(sessionId: string): EternalGoal | null {
    return readPersistedEternalGoal(this.db, sessionId);
  }

  async setEternalGoal(
    sessionId: string,
    description: string,
  ): Promise<{ ok: boolean; message: string; goal?: EternalGoal }> {
    const trimmed = description.trim();
    if (!trimmed) {
      return { ok: false, message: 'Eternal 目标不能为空' };
    }

    const previous = readPersistedEternalGoal(this.db, sessionId);
    const goal = createEternalGoal(trimmed, previous);
    await this.db.setSessionState(sessionId, SESSION_KEYS.ETERNAL_GOAL, goal);
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.leader.setControlMode('eternal');
      session.leader.invalidateEternalSilenceLock('eternal_goal_changed');
      // 唤醒 leader：设置 goal 后立即驱动 patrol，而不是等待下次超时
      session.leader.markWaitingForUser(false);
      session.bus.send(
        `${sessionId}:system`,
        `${sessionId}:leader`,
        'eternal_goal_set',
        { goal: goal.description },
      );
    } else {
      await this.db.setSessionState(sessionId, SESSION_KEYS.CONTROL_MODE, 'eternal');
    }
    this.emitter.emit('eternal:goal_changed', { sessionId, goal, action: 'set' });
    this.publishSessionRuntimeState(sessionId, { source: 'eternal_goal_changed', reason: 'set' });
    return { ok: true, message: `Eternal 目标模式已更新：${goal.description}`, goal };
  }

  async setEternalGoalPaused(
    sessionId: string,
    paused: boolean,
  ): Promise<{ ok: boolean; message: string; goal?: EternalGoal }> {
    const goal = readPersistedEternalGoal(this.db, sessionId);
    if (!goal) {
      return { ok: false, message: '当前没有 Eternal 目标。使用 /eternal <目标> 启动持续目标模式。' };
    }
    const next = setEternalGoalPaused(goal, paused);
    await this.db.setSessionState(sessionId, SESSION_KEYS.ETERNAL_GOAL, next);
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!paused) await session.leader.setControlMode('eternal');
      session.leader.invalidateEternalSilenceLock(paused ? 'eternal_goal_paused' : 'eternal_goal_resumed');
      // Resume 时唤醒 leader，与 setEternalGoal 相同逻辑
      if (!paused) {
        session.leader.markWaitingForUser(false);
        session.bus.send(
          `${sessionId}:system`,
          `${sessionId}:leader`,
          'eternal_goal_set',
          { goal: next.description },
        );
      }
    } else if (!paused) {
      await this.db.setSessionState(sessionId, SESSION_KEYS.CONTROL_MODE, 'eternal');
    }
    this.emitter.emit('eternal:goal_changed', {
      sessionId,
      goal: next,
      action: paused ? 'pause' : 'resume',
    });
    this.publishSessionRuntimeState(sessionId, {
      source: 'eternal_goal_changed',
      reason: paused ? 'pause' : 'resume',
    });
    return { ok: true, message: paused ? 'Eternal 目标模式已暂停' : 'Eternal 目标模式已恢复', goal: next };
  }

  async clearEternalGoal(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const previous = readPersistedEternalGoal(this.db, sessionId);
    if (!previous) {
      return { ok: true, message: '当前没有 Eternal 目标' };
    }
    await this.db.setSessionState(sessionId, SESSION_KEYS.ETERNAL_GOAL, {
      ...previous,
      paused: true,
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const session = this.sessions.get(sessionId);
    if (session) {
      session.leader.invalidateEternalSilenceLock('eternal_goal_cleared');
    }
    this.emitter.emit('eternal:goal_changed', { sessionId, goal: null, action: 'clear' });
    this.publishSessionRuntimeState(sessionId, { source: 'eternal_goal_changed', reason: 'clear' });
    return { ok: true, message: 'Eternal 目标模式已删除' };
  }

  /**
   * 释放 Leader 忙标志（用户按 ESC 或中断时调用）
   */
  async clearPendingMessages(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.leader.isRunning) {
      session.isLeaderBusy = false;
    }

    this.scheduleSessionRuntimeStatePublish(sessionId, { source: 'clear_pending_messages' });
  }

  async cancelTask(sessionId: string, taskId: string, reason = '用户取消任务'): Promise<CancelTaskResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: `当前会话未加载：${sessionId}` };
    }

    const task = session.board.getTask(taskId);
    if (!task) {
      return { ok: false, message: `任务 ${taskId} 不存在` };
    }

    if (task.status === 'terminal') {
      return { ok: false, message: `任务 ${taskId} 当前状态为 ${task.exitReason || 'terminal'}，无需取消` };
    }

    const assignedAgent = task.assigned_agent || undefined;
    const runningHandle = assignedAgent ? session.pool.getByName(assignedAgent) : undefined;

    if (runningHandle && isAgentRuntimeActiveStatus(runningHandle)) {
      session.bus.send(`${sessionId}:leader`, `${sessionId}:${assignedAgent!}`, 'force_terminate', {
        reason,
        taskId,
      });
      session.pool.stopAgent(assignedAgent!);
    }

    const cancelled = session.board.cancelTask(taskId, reason);
    if (!cancelled) {
      return { ok: false, message: `任务 ${taskId} 不存在` };
    }

    const releasedLabel = cancelled.releasedDependents.length > 0
      ? `，已释放依赖: ${cancelled.releasedDependents.join(', ')}`
      : '';
    const agentLabel = assignedAgent ? `，已停止 @${assignedAgent}` : '';

    return {
      ok: true,
      message: `已取消任务 ${taskId}${agentLabel}${releasedLabel}`,
    };
  }

  /**
   * 删除会话及其所有关联数据
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    sessionLogger.debug(`正在准备删除会话：${sessionId}`);

    // 1. 如果在内存中，先停止业务逻辑
    const session = this.sessions.get(sessionId);
    if (session) {
      // 停止 Leader（dispose 隐含 stop，并退订构造器级监听器，避免泄漏到共享 emitter）
      session.leader.dispose();

      // 停止所有 Agents
      session.pool.stopAll();
      await killExternalAgentOrphans(sessionId).catch((error) => {
        sessionLogger.warn(`删除会话 ${sessionId} 时清理外部 Agent 孤儿进程失败:`, error);
      });

      // 清理事件监听器
      session._roundCompleteUnsub?.();
      session._completedUnsub?.();
      session._leaderErrorUnsub?.();
      session._disposeTeamCommunication?.();

      // 从内存移除
      this.sessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);
      this.autoNamedSessions.delete(sessionId);
    }

    // 2. 从数据库物理删除
    this.db.deleteSession(sessionId);

    // 3. 回收会话产物目录(.lingxiao/sessions/<id>/ — 含 scratchpad 里的 PDF/DOCX/PPTX/XLSX 等可再生
    //    文档产物;会话已删→产物即孤儿)。与 ResourceBudgetService 的 session_artifacts report-only 策略
    //    区分:那是预算服务的自动保留(审计),这里是用户显式删会话时的确定性回收(#19)。
    try {
      rmSync(join(this.baseWorkspace, '.lingxiao', 'sessions', sessionId), { recursive: true, force: true });
    } catch (err) {
      sessionLogger.warn(`删除会话 ${sessionId} 产物目录失败:`, err);
    }

    // 4. 发射事件
    this.emitter.emit('session:deleted', { sessionId });
    
    return true;
  }

  /**
   * 派生会话交互运行时状态与当前 turn
   */
  getInteractionRuntimeState(sessionId: string): {
    runtimeState: SessionRuntimeState;
    turn: InteractionTurnState;
  } | null {
    const session = this.sessions.get(sessionId);
    const sessionInfo = session
      ? {
          id: sessionId,
          workspace: session.workspace,
          status: session.status,
        }
      : this.db.getSession(sessionId);

    if (!sessionInfo) {
      return null;
    }

    const persisted = loadPersistedInteractionSnapshot(this.db, sessionId);
    const tasks = session
      ? session.board.getAllTasks()
      : this.db.getTasksBySession(sessionId);
    const leaderSnapshot = session
      ? session.leader.getInteractionSnapshot()
      : {
          ...persisted.leader,
          // A DB-only interaction snapshot cannot prove an active in-flight Leader turn.
          busy: false,
        };
    const activeEternalSnapshot = session
      && typeof (session.leader as { getEternalRuntimeSnapshot?: unknown }).getEternalRuntimeSnapshot === 'function'
      ? session.leader.getEternalRuntimeSnapshot()
      : null;

    const runtimeState = deriveSessionRuntimeState({
      sessionId,
      workspace: sessionInfo.workspace,
      sessionStatus: sessionInfo.status,
      leader: leaderSnapshot,
      runningWorkers: session?.pool.getRunning() || [],
      recoveringTasks: listRecoveryRecords(this.db, sessionId).map((record) => ({
        taskId: record.taskId,
        agentName: record.agentName,
        category: record.category,
        faultClass: record.faultClass,
        recoveryAction: record.recoveryAction,
        lastActivityAt: record.lastActivityAt,
      })),
      dispatchableTaskCount: session
        ? session.board.getDispatchable().length
        : tasks.filter((task) => task.status === 'dispatchable').length,
      allTasksTerminal: session
        ? session.board.allTerminal()
        // DB-only snapshot 也走中心任务终态语义，不能直接写 task.status === 'terminal'。
        : tasks.every((task) => isTaskTerminalStatus(task)),
      pendingUserInput: persisted.pendingUserInput,
      pendingUserGate: persisted.pendingUserGate,
      eternal: activeEternalSnapshot || loadPersistedEternalRuntimeSnapshot(this.db, sessionId),
      modes: resolveModeRuntimeProjection({
        sessionId,
        db: this.db,
        blackboardAvailable: session?.leader.isBlackboardEnabled?.() ?? false,
        permissionSummary: leaderSnapshot.permissionSummary,
      }),
    });

    const turn = (session?.turnCoordinator || this.turnCoordinator).classify(runtimeState);

    return { runtimeState, turn };
  }

  getLeaderContextRuntimeState(sessionId: string): ContextRuntimeState | null {
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.leader.getContextRuntimeState();
    }

    const sessionInfo = this.db.getSession(sessionId);
    if (!sessionInfo) {
      return null;
    }

    return loadPersistedContextRuntimeState(this.db, sessionId, { kind: 'leader' });
  }

  /**
   * 销毁 SessionManager：清理所有资源（后台定时器、事件订阅、活跃会话）。
   * 进程退出或测试时调用，确保不会泄漏定时器和事件监听器。
   */
  destroy(): void {
    // 停止清理循环
    if (this.cleanupTask) {
      clearTimeout(this.cleanupTask);
    }

    // Fix #4: 释放全局事件订阅
    for (const unsub of this.runtimeStateUnsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.runtimeStateUnsubscribers.length = 0;

    // 清理所有 runtimeState publish timers
    for (const timer of this.runtimeStatePublishTimers.values()) {
      clearTimeout(timer);
    }
    this.runtimeStatePublishTimers.clear();

    // 释放所有活跃会话资源
    for (const [sessionId, session] of this.sessions.entries()) {
      this.releaseSessionResources(sessionId, session);
    }

    // 清理辅助 Map/Set
    this.initializingSessions.clear();
    this.resuming.clear();
    this.sessionLastActivity.clear();
    this.autoNamedSessions.clear();
  }
}

export default SessionManager;
