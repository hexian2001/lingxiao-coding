/**
 * LeaderBlackboard — 黑板架构集成模块
 *
 * 从 LeaderAgent.ts 提取，负责：
 * - 黑板图初始化（GraphStore + BlackboardGraph + DispatcherEngine + GraphBridge）
 * - AgentPool 回调连接（Worker 读写黑板图）
 * - 图分析获取（供 LeaderThinkingEngine 注入上下文）
 */

import type { DatabaseManager } from '../core/Database.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { TaskBoard, Task } from '../core/TaskBoard.js';
import type { AgentPool } from './AgentPoolRuntime.js';
import { config as globalConfig } from '../config.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import type { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import type { TeamSynchronizer } from './TeamSynchronizer.js';
import { GraphStore } from '../core/blackboard/GraphStore.js';
import { BlackboardGraph } from '../core/blackboard/BlackboardGraph.js';
import { DispatcherEngine } from '../core/blackboard/DispatcherEngine.js';
import { GraphBridge } from '../core/blackboard/GraphBridge.js';
import type { BlackboardEvent, BlackboardDelta, GraphNode, GraphAnalysis } from '../core/blackboard/types.js';
import { buildCompressedWorkerSnapshot } from '../core/compress/BlackboardCompressor.js';
import { parseWorkerOutput } from '../core/blackboard/WorkerOutputParser.js';
import { parseAndValidateGraphBlocks } from '../core/blackboard/ContractFormatParser.js';
import {
  buildContractPackFromSnapshot,
  persistContractPack,
  contractPackFingerprint,
  renderContractPackSystemMessage,
  type ContractPack,
} from '../core/ContractPack.js';
import { loadProjectContractEntries } from '../core/ProjectContracts.js';
import { ImportGraphEngine, type ImportGraph } from '../core/ImportGraphEngine.js';
import { leaderLogger } from '../core/Log.js';
import { DEFAULT_RULES, DEFAULT_PARAMS, type ExecutionStrategy, type AdaptiveStrategyRule, type StrategyParams } from '../core/AdaptiveHarness.js';
import type { WorkerContractComplianceProof } from '../core/AgentProtocol.js';

export class LeaderBlackboard {
  /** 黑板图实例，仅在 blackboard.enabled 时初始化 */
  blackboardGraph: BlackboardGraph | null = null;
  /** 图桥接器，将 TaskBoard 操作同步到黑板图 */
  graphBridge: GraphBridge | null = null;
  /** 图感知调度引擎 */
  dispatcherEngine: DispatcherEngine | null = null;
  private blackboardEventUnsubscribe: (() => void) | null = null;
  private taskLifecycleUnsubscribers: Array<() => void> = [];
  /**
   * 由 LeaderAgent 注入的 active team provider — 让 AgentPool.buildWorkerPayload 在
   * 装配 worker payload 时获取当前 active team 名（不直接 import LeaderAgent，避免循环依赖）。
   */
  private activeTeamProvider?: () => string | null;
  setActiveTeamProvider(fn: () => string | null): void {
    this.activeTeamProvider = fn;
  }
  /** trailing-coalesce 窗口大小（毫秒） */
  private static COALESCE_WINDOW_MS = 1000;
  /** 待合并的事件队列 — 窗口结束时统一构造一份聚合 delta */
  private pendingEvents: BlackboardEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private contractPack: ContractPack | null = null;
  /**
   * 图变更序号 —— 每次 handleBlackboardEvent 自增。
   * contractPack 缓存在 contractBuiltAtSeq 记录其构建时的序号；
   * spawn 装配路径据此判断"图自上次构建以来没动过"，直接复用缓存，
   * 跳过 getSnapshot 全图扫描与 persist 落盘。
   */
  private graphMutationSeq = 0;
  private contractBuiltAtSeq = -1;
  /** 上次落盘过的契约指纹 —— 内容未变则跳过 persist。 */
  private lastPersistedFingerprint: string | null = null;
  /** 上次广播给 Worker 的契约指纹 —— 内容未变则跳过 broadcastSystemContext，避免全量重发。 */
  private lastBroadcastFingerprint: string | null = null;
  /** 导入图引擎 —— 增量构建项目依赖图，为 worker 提供变更影响分析 */
  private importGraphEngine: ImportGraphEngine | null = null;
  private cachedImportGraph: ImportGraph | null = null;

  constructor(
    private readonly db: DatabaseManager,
    private readonly emitter: EventEmitter,
    private readonly sessionId: string,
    private readonly pool: AgentPool,
    private readonly workspace: string,
  ) {}

  /**
   * 初始化黑板架构（在 LeaderAgent 构造函数中调用）
   * @returns true 如果初始化成功
   */
  init(): boolean {
    try {
      const graphStore = new GraphStore(this.db.getDb());
      this.blackboardGraph = new BlackboardGraph(graphStore, this.emitter);
      this.graphBridge = new GraphBridge(this.blackboardGraph);
      this.dispatcherEngine = new DispatcherEngine();

      // 从 session 读取用户请求作为 Origin
      const session = this.db.getSession(this.sessionId);
      const userReq = session?.user_request;
      const originContent = typeof userReq === 'string' ? userReq : JSON.stringify(userReq ?? '(no request)');
      this.blackboardGraph.setOrigin(this.sessionId, originContent);
      this.blackboardGraph.setGoal(this.sessionId, '(auto-derived from user request)');

      // 项目级契约跨会话复用:从 .lingxiao/contracts/ 加载已有契约灌入黑板(provenance:declared)。
      this.seedProjectContracts();
      // harness 自身策略契约注册:把 adaptive-enhance 和 eternal-smart 写入黑板。
      this.seedHarnessContracts();

      // 连接 AgentPool — 让 Worker 能读写黑板图
      const graph = this.blackboardGraph;
      const sid = this.sessionId;
      const SNAPSHOT_TOKEN_BUDGET = 3_000; // Worker 快照的 token 预算
      this.pool.setBlackboardCallbacks(
        // getSnapshot: 返回压缩后的图快照 markdown
        (): string => {
          try {
            const snap = graph.getSnapshot(sid);
            return buildCompressedWorkerSnapshot(snap, SNAPSHOT_TOKEN_BUDGET);
          } catch {/* swallowed: unhandled error */ return ''; }
        },
        // applyOutput: 解析 Worker 输出中的图结构化代码块（统一入口，含 3 层 fallback）
        (taskId: string, output: unknown) => {
          const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? '');
          const parsed = parseAndValidateGraphBlocks(outputStr, sid, {
            taskId,
            workspace: this.workspace,
            db: this.db,
            getActiveContract: (sessionId, surface) => this.blackboardGraph?.getActiveContract(sessionId, surface) ?? null,
          });

          if (parsed.errors.length > 0) {
            leaderLogger.warn(`[Blackboard] Worker ${taskId} 输出解析警告: ${parsed.errors.join('; ')}`);
          }

          const { output: graphOutput, contractFallbackSource } = parsed;
          // Fallback 来源日志
          if (contractFallbackSource === 'session-files') {
            leaderLogger.info(`[Blackboard] Worker ${taskId} completion 无 contract 块,从 session 文件 fallback 解析到 ${graphOutput.newContracts?.length ?? 0} 个 contract`);
          } else if (contractFallbackSource === 'task-metadata') {
            const taskContract = graphOutput.newContracts?.[0];
            const surface = taskContract?.tags.find(t => t.startsWith('contract:'))?.slice('contract:'.length) ?? '?';
            leaderLogger.info(`[Blackboard] Worker ${taskId} completion 无 contract 块,从任务 orchestration.contract 元数据 fallback 构造 contract 节点 (surface=${surface})`);
          }
          if (graphOutput.newFacts.length > 0 || graphOutput.newIntents.length > 0 || (graphOutput.newContracts?.length ?? 0) > 0 || (graphOutput.newDesignDocs?.length ?? 0) > 0 || graphOutput.newEdges.length > 0) {
            graph.applyWorkerOutputAndPrune(sid, taskId, graphOutput);
            leaderLogger.info(`[Blackboard] Worker ${taskId} 写入 ${graphOutput.newFacts.length} Fact, ${graphOutput.newIntents.length} Intent, ${graphOutput.newContracts?.length ?? 0} Contract, ${graphOutput.newDesignDocs?.length ?? 0} DesignDoc, ${graphOutput.newEdges.length} Edge`);
          }
        },
        // getGraph: 让 buildWorkerPayload 拼装 group context 时按 tag 过滤 fact
        () => graph,
        // getActiveTeam: AgentPool 不再 import LeaderAgent，通过 callback 拿当前 active team
        () => this.activeTeamProvider?.() ?? null,
        // getContractPack: Worker system prompt / Context Manifest 的契约单一事实源
        () => this.refreshContractPack(),
      );

      this.blackboardEventUnsubscribe?.();
      this.blackboardEventUnsubscribe = this.emitter.subscribe('blackboard:event', (event) => {
        this.handleBlackboardEvent(event);
      });

      // ─── TaskBoard 生命周期事件投影 — 单一订阅出口，禁止 caller 散落手工 graphBridge.onTask*
      this.subscribeTaskLifecycle();

      // ─── 导入图引擎初始化 + 注册为 AgentPool 的变更影响提供者
      this.initImportGraph();

      leaderLogger.info('[Blackboard] 初始化完成 — Origin + Goal 已设置，AgentPool 已连接');
      this.emitter.emit('blackboard:initialized', { sessionId: this.sessionId, enabled: true });
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      leaderLogger.warn(`[Blackboard] 初始化失败，图谱能力已关闭: ${reason}`);
      this.blackboardGraph = null;
      this.graphBridge = null;
      this.dispatcherEngine = null;
      this.emitter.emit('blackboard:initialized', { sessionId: this.sessionId, enabled: false, reason });
      return false;
    }
  }

  /**
   * 订阅 TaskBoard 生命周期事件并投影到 GraphBridge — 收敛唯一投影点。
   * 旧实现：caller 散落 `graphBridge?.onTaskCreated/Completed/Failed(...)`，容易漏。
   * 新实现：TaskBoard 在每次状态变更时 emit `task:*`，这里统一调用 GraphBridge 写图。
   */
  private subscribeTaskLifecycle(): void {
    // 清理旧订阅（init 可能多次调用，例如 reload）
    for (const off of this.taskLifecycleUnsubscribers) {
      try { off(); } catch { /* tolerate */ }
    }
    this.taskLifecycleUnsubscribers.length = 0;

    if (!this.graphBridge) return;

    const onCreated = (payload: { task: Task }): void => {
      try { this.graphBridge?.onTaskCreated(payload.task); } catch (err) {
        leaderLogger.debug(`[Blackboard] onTaskCreated bridge 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const onUpdated = (payload: { task: Task }): void => {
      try { this.graphBridge?.onTaskUpdated(payload.task); } catch (err) {
        leaderLogger.debug(`[Blackboard] onTaskUpdated bridge 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const onCompleted = (payload: { taskId: string; task?: Task }): void => {
      try {
        const task = this.resolveTerminalTask(payload, 'task:completed');
        if (!task) return;
        this.graphBridge?.onTaskCompleted(task);
      } catch (err) {
        leaderLogger.debug(`[Blackboard] onTaskCompleted bridge 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const onFailed = (payload: { taskId: string; task?: Task }): void => {
      try {
        const task = this.resolveTerminalTask(payload, 'task:failed');
        if (!task) return;
        this.graphBridge?.onTaskFailed(task);
      } catch (err) {
        leaderLogger.debug(`[Blackboard] onTaskFailed bridge 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    this.emitter.on('task:created', onCreated);
    this.emitter.on('task:updated', onUpdated);
    this.emitter.on('task:completed', onCompleted);
    this.emitter.on('task:failed', onFailed);

    this.taskLifecycleUnsubscribers.push(
      () => this.emitter.off('task:created', onCreated),
      () => this.emitter.off('task:updated', onUpdated),
      () => this.emitter.off('task:completed', onCompleted),
      () => this.emitter.off('task:failed', onFailed),
    );
  }

  private resolveTerminalTask(payload: { taskId: string; task?: Task }, eventName: 'task:completed' | 'task:failed'): Task | null {
    const payloadTask = this.coerceGraphBridgeTask(payload.task);
    if (payloadTask) return payloadTask;

    if (payload.task) {
      leaderLogger.debug(`[Blackboard] ${eventName} payload task 不完整，尝试从 DB 解析: ${payload.taskId}`);
    }

    let dbTask: unknown;
    try {
      dbTask = this.db.getTask(payload.taskId, this.sessionId);
    } catch (err) {
      leaderLogger.debug(`[Blackboard] ${eventName} DB task 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    const resolvedTask = this.coerceGraphBridgeTask(dbTask);
    if (resolvedTask) return resolvedTask;

    leaderLogger.debug(`[Blackboard] ${eventName} 缺少完整 task，跳过 GraphBridge 投影: ${payload.taskId}`);
    return null;
  }

  private coerceGraphBridgeTask(value: unknown): Task | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.id !== 'string' ||
      typeof raw.session_id !== 'string' ||
      typeof raw.subject !== 'string' ||
      typeof raw.status !== 'string' ||
      typeof raw.agent_type !== 'string' ||
      typeof raw.assigned_agent !== 'string'
    ) {
      return null;
    }

    const createdAt = typeof raw.created_at === 'number' ? raw.created_at : null;
    const updatedAt = typeof raw.updated_at === 'number' ? raw.updated_at : null;
    if (createdAt === null || updatedAt === null) return null;

    const description = typeof raw.description === 'string'
      ? raw.description
      : JSON.stringify(raw.description ?? raw.subject);
    const runGenerationRaw = raw.runGeneration ?? raw.run_generation;
    const runGeneration = typeof runGenerationRaw === 'number' && Number.isFinite(runGenerationRaw)
      ? Math.max(0, Math.floor(runGenerationRaw))
      : 0;
    const exitReason = typeof raw.exitReason === 'string'
      ? raw.exitReason
      : typeof raw.exit_reason === 'string'
        ? raw.exit_reason
        : undefined;

    return {
      ...(raw as unknown as Task),
      id: raw.id,
      session_id: raw.session_id,
      subject: raw.subject,
      description,
      status: raw.status as Task['status'],
      exitReason: exitReason as Task['exitReason'],
      runGeneration,
      agent_type: raw.agent_type,
      blocked_by: Array.isArray(raw.blocked_by) ? raw.blocked_by.filter((item): item is string => typeof item === 'string') : [],
      blocks: Array.isArray(raw.blocks) ? raw.blocks.filter((item): item is string => typeof item === 'string') : [],
      assigned_agent: raw.assigned_agent,
      working_directory: typeof raw.working_directory === 'string' ? raw.working_directory : this.workspace,
      write_scope: Array.isArray(raw.write_scope) ? raw.write_scope.filter((item): item is string => typeof item === 'string') : [],
      created_at: createdAt,
      updated_at: updatedAt,
    };
  }

  dispose(): void {
    for (const off of this.taskLifecycleUnsubscribers) {
      try { off(); } catch { /* tolerate */ }
    }
    this.taskLifecycleUnsubscribers.length = 0;
    this.blackboardEventUnsubscribe?.();
    this.blackboardEventUnsubscribe = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 按 feature flag + mode policy 决定是否初始化完整黑板架构（搬离自 LeaderAgent.ensureFullBlackboardInitialized）。
   *
   * 行为契约（与原实现完全一致，仅搬位置不改逻辑）：
   * - globalConfig.blackboard.enabled 关闭 / db.getDb 不可用 / modes.blackboard.mode !== 'full' → 返回 null
   * - 构造 LeaderBlackboard 并 init()，注入 activeTeam provider，连接 workflowEngine / teamSynchronizer
   * - 注册 collaboration:review_recorded / collaboration:decision_recorded / blackboard:event 三个订阅，
   *   把退订函数推入 deps.unsubscribersSink（由 caller 与其它实例级订阅统一 dispose）
   * - 任意步骤抛错 → 图谱能力关闭，返回 null
   *
   * @returns 初始化成功后的 LeaderBlackboard 实例；未启用则 null
   */
  static initializeIfApplicable(deps: {
    db: DatabaseManager;
    emitter: EventEmitter;
    sessionId: string;
    pool: AgentPool;
    workspace: string;
    activeTeamProvider: () => string | null;
    permissionSummary: string;
    workflowEngine?: WorkflowEngine;
    teamSynchronizer?: TeamSynchronizer | null;
    refreshContractBoundTasks: (event: BlackboardEvent) => void;
    unsubscribersSink: Array<() => void>;
  }): LeaderBlackboard | null {
    if (!globalConfig.blackboard.enabled) return null;
    if (typeof (deps.db as { getDb?: unknown }).getDb !== 'function') return null;
    const modes = resolveModeRuntimeProjection({
      sessionId: deps.sessionId,
      db: deps.db,
      blackboardAvailable: true,
      permissionSummary: deps.permissionSummary,
    });
    if (modes.blackboard.mode !== 'full') return null;

    try {
      const blackboard = new LeaderBlackboard(deps.db, deps.emitter, deps.sessionId, deps.pool, deps.workspace);
      blackboard.setActiveTeamProvider(deps.activeTeamProvider);
      blackboard.init();
      deps.workflowEngine?.setBlackboardGraphProvider?.(() => blackboard.blackboardGraph ?? null);
      const graph = blackboard.blackboardGraph;
      if (graph) {
        const sid = deps.sessionId;
        const offReview = deps.emitter.subscribe('collaboration:review_recorded', (data) => {
          const msg = (data?.message ?? null) as Record<string, unknown> | null;
          if (!msg || msg.sessionId !== sid) return;
          const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
          graph.addReview({
            sessionId: sid,
            title: `Review: ${metadata.taskId || metadata.sourceTaskId || msg.id}`,
            content: msg.content as string,
            tags: ['review', metadata.taskId ? `task:${metadata.taskId}` : 'task:unknown', msg.fromMember ? `agent:${msg.fromMember}` : 'agent:unknown'],
            createdBy: (msg.fromMember as string) || 'team',
            confidence: 'confirmed',
            evidence: Array.isArray(metadata.evidenceRefs)
              ? metadata.evidenceRefs.map((ref: string) => ({ type: 'blackboard_node' as const, ref }))
              : undefined,
          });
          if (metadata.verdict) {
            graph.addVerdict({
              sessionId: sid,
              title: `Verdict ${metadata.verdict}: ${metadata.taskId || metadata.sourceTaskId || msg.id}`,
              content: (metadata.summary as string) || (msg.content as string),
              tags: ['verdict', `verdict:${String(metadata.verdict).toLowerCase()}`, metadata.taskId ? `task:${metadata.taskId}` : 'task:unknown'],
              createdBy: (msg.fromMember as string) || 'team',
              confidence: 'confirmed',
            });
          }
        });
        deps.unsubscribersSink.push(offReview);
        const offDecision = deps.emitter.subscribe('collaboration:decision_recorded', (data) => {
          const msg = (data?.message ?? null) as Record<string, unknown> | null;
          if (!msg || msg.sessionId !== sid) return;
          const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
          graph.addDecisionLog({
            sessionId: sid,
            title: `Decision: ${metadata.taskId || metadata.requestId || msg.id}`,
            content: msg.content as string,
            tags: ['decision', metadata.taskId ? `task:${metadata.taskId}` : 'task:unknown', msg.fromMember ? `agent:${msg.fromMember}` : 'agent:unknown'],
            createdBy: (msg.fromMember as string) || 'team',
            confidence: 'confirmed',
            evidence: Array.isArray(metadata.evidenceRefs)
              ? metadata.evidenceRefs.map((ref: string) => ({ type: 'blackboard_node' as const, ref }))
              : undefined,
          });
        });
        deps.unsubscribersSink.push(offDecision);
      }
      if (graph && deps.teamSynchronizer) {
        deps.teamSynchronizer.setGraph({
          getSnapshot: (sessionSid: string) => graph.getSnapshot(sessionSid),
        });
      }
      const offBlackboardEvent = deps.emitter.subscribe('blackboard:event', (event) => deps.refreshContractBoundTasks(event));
      deps.unsubscribersSink.push(offBlackboardEvent);
      return blackboard;
    } catch (error) {
      leaderLogger.warn(`[Blackboard] 初始化失败，图谱能力已关闭: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 处理黑板事件 — 采用 trailing-coalesce 窗口避免事件丢失。
   *
   * 旧实现：1 秒内首个事件直接广播，后续 N 个事件 return 丢弃，导致连续节点写入只能看到第一个。
   * 新实现：所有事件累积到 pendingEvents；首事件立即触发 flushTimer；窗口结束统一聚合一次。
   * 这样既限制广播频率（最多 1 次/秒），又保证 0 事件丢失。
   */
  private handleBlackboardEvent(event: BlackboardEvent): void {
    if (!this.blackboardGraph || event.sessionId !== this.sessionId) {
      return;
    }
    // 图发生了实质变更 —— 让 spawn 装配路径的契约缓存失效。
    this.graphMutationSeq++;
    this.pendingEvents.push(event);
    if (this.flushTimer !== null) return;

    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    const delay = Math.max(0, LeaderBlackboard.COALESCE_WINDOW_MS - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingEvents();
    }, delay);
  }

  /**
   * 构建（必要时落盘）契约 Pack，作为 Worker system prompt / Context Manifest 的单一事实源。
   *
   * 两条调用路径：
   * - spawn 装配（无 snapshot 入参）：热路径，每次 buildWorkerPayload 都会调。借助 graphMutationSeq
   *   缓存闸，图自上次构建以来未变时直接复用缓存，跳过 getSnapshot 全图扫描与磁盘 IO。
   * - flush 广播（传入已取得的 snapshot）：图刚变更，必须重建；但仍按指纹决定是否落盘。
   *
   * 指纹未变则跳过 persistContractPack —— 避免每次 spawn / 等价事件把所有契约文件重复全量重写。
   */
  getContractPack(): ContractPack | null {
    return this.refreshContractPack();
  }

  private refreshContractPack(snapshot?: ReturnType<BlackboardGraph['getSnapshot']>): ContractPack | null {
    if (!this.blackboardGraph) return this.contractPack;
    if (!snapshot && this.contractPack && this.contractBuiltAtSeq === this.graphMutationSeq) {
      return this.contractPack;
    }
    try {
      const currentSnapshot = snapshot ?? this.blackboardGraph.getSnapshot(this.sessionId);
      const nextPack = buildContractPackFromSnapshot(currentSnapshot, {
        sessionId: this.sessionId,
        workspace: this.workspace,
      });
      this.contractPack = nextPack;
      this.contractBuiltAtSeq = this.graphMutationSeq;
      const fingerprint = contractPackFingerprint(nextPack);
      if (fingerprint !== this.lastPersistedFingerprint) {
        persistContractPack(nextPack, this.workspace);
        this.lastPersistedFingerprint = fingerprint;
      }
      return nextPack;
    } catch (error) {
      leaderLogger.warn(`[Blackboard] Contract Pack 刷新失败: ${error instanceof Error ? error.message : String(error)}`);
      return this.contractPack;
    }
  }

  /**
   * 项目级契约跨会话复用:从 `.lingxiao/contracts/contract-pack.json` 加载已有契约,
   * 灌入黑板 contract 节点(`provenance:declared`)。幂等——已存在 active contract 的 surface
   * 跳过(不 supersede 已有声明/audit 契约)。失败只 warn,退化为"从零建"(契约缺失时不阻断启动)。
   */
  private seedProjectContracts(): void {
    if (!this.blackboardGraph) return;
    try {
      const entries = loadProjectContractEntries(this.workspace);
      if (entries.length === 0) return;
      let seeded = 0;
      for (const entry of entries) {
        if (this.blackboardGraph.getActiveContract(this.sessionId, entry.surface)) continue;
        const tags = Array.from(new Set([
          `contract:${entry.surface}`,
          ...(entry.version !== undefined ? [`v${entry.version}`] : []),
          'provenance:declared',
          ...entry.tags,
        ]));
        this.blackboardGraph.addContract({
          sessionId: this.sessionId,
          title: entry.title,
          content: entry.content,
          tags,
          createdBy: entry.createdBy ?? 'project-contract-loader',
          ...(entry.allowedScope ? { contractAllowedScope: entry.allowedScope } : {}),
        });
        seeded += 1;
      }
      if (seeded > 0) {
        leaderLogger.info(`[Blackboard] 从项目级契约加载 ${seeded}/${entries.length} 条(provenance:declared,跨会话复用)`);
      }
    } catch (err) {
      leaderLogger.warn(`[Blackboard] 项目级契约加载失败(退化为从零建): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * harness 自身策略契约注册:把 adaptive-enhance 和 eternal-smart 写入黑板 contract 节点。
   * 从 AdaptiveHarness 的 DEFAULT_RULES / DEFAULT_PARAMS 和 EternalPatrolPolicy 的巡逻策略提取配置生成契约内容。
   * 幂等——已存在 active contract 的 surface 跳过。
   */
  private seedHarnessContracts(): void {
    if (!this.blackboardGraph) return;
    try {
      let seeded = 0;

      // ── contract:adaptive-enhance ──
      if (!this.blackboardGraph.getActiveContract(this.sessionId, 'adaptive-enhance')) {
        const rulesBlock = DEFAULT_RULES.map((rule: AdaptiveStrategyRule) =>
          `  - id: ${rule.id} | priority: ${rule.priority} | strategy: ${rule.strategy}`,
        ).join('\n');

        const paramsBlock = (Object.keys(DEFAULT_PARAMS) as ExecutionStrategy[]).map((strategy: ExecutionStrategy) => {
          const p: StrategyParams = DEFAULT_PARAMS[strategy];
          return `  ${strategy}: maxRounds=${p.maxRounds}, timeoutMs=${p.timeoutMs}, workerCount=${p.workerCount}, verificationLevel=${p.verificationLevel}, assumptionTracking=${p.assumptionTracking}, speculationEnabled=${p.speculationEnabled}`;
        }).join('\n');

        const escalateBlock = [
          '  - build_errors_exceeded: fast_path→standard(count≥1), standard→careful(count>3)',
          '  - repair_attempts_exceeded: standard→careful(count≥1), careful→speculative(count≥2)',
          '  - speculation_all_failed: speculative→deep',
          '  - timeout_approaching: (no auto-escalation, signal only)',
        ].join('\n');

        const content = [
          '## AdaptiveHarness Strategy Contract',
          '',
          '### Strategy Rules (by priority)',
          rulesBlock,
          '',
          '### Strategy Parameters',
          paramsBlock,
          '',
          '### Escalation Triggers',
          escalateBlock,
        ].join('\n');

        this.blackboardGraph.addContract({
          sessionId: this.sessionId,
          title: 'AdaptiveHarness Strategy Contract',
          content,
          tags: ['contract:adaptive-enhance', 'harness', 'provenance:system'],
          createdBy: 'harness-contract-seeder',
        });
        seeded += 1;
      }

      // ── contract:eternal-smart ──
      if (!this.blackboardGraph.getActiveContract(this.sessionId, 'eternal-smart')) {
        const patrolStrategies = [
          '  - patrol: Active eternal goal with changed fingerprint or continued stewardship needed',
          '  - skip: No meaningful project delta (fingerprint unchanged, no open work/agents)',
          '  - yield_user: No project delta, no open work, no running agents, idle patrol already attempted',
        ].join('\n');

        const configBlock = [
          '  - EternalLoopIntelligence: integrates PerformanceBaselineTracker + BaselineAlertMonitor + PatternRecognitionEngine',
          '  - recordAndCheck(metric): records execution and checks deviation against baseline',
          '  - recordFailureAndAnalyze(record): records failure and returns recognized patterns',
          '  - onAlert(handler): subscribes to eternal:baseline_alert events for SSE propagation',
        ].join('\n');

        const content = [
          '## EternalPatrolPolicy Contract',
          '',
          '### Patrol Decision Strategies',
          patrolStrategies,
          '',
          '### Intelligence Modules',
          configBlock,
        ].join('\n');

        this.blackboardGraph.addContract({
          sessionId: this.sessionId,
          title: 'EternalPatrolPolicy Contract',
          content,
          tags: ['contract:eternal-smart', 'harness', 'provenance:system'],
          createdBy: 'harness-contract-seeder',
        });
        seeded += 1;
      }

      if (seeded > 0) {
        leaderLogger.info(`[Blackboard] harness 策略契约注册 ${seeded} 条(adaptive-enhance, eternal-smart)`);
      }
    } catch (err) {
      leaderLogger.warn(`[Blackboard] harness 契约注册失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 聚合并广播待合并的黑板事件 */
  private flushPendingEvents(): void {
    if (!this.blackboardGraph || this.pendingEvents.length === 0) return;
    const events = this.pendingEvents.splice(0, this.pendingEvents.length);
    this.lastFlushAt = Date.now();

    try {
      const snapshot = this.blackboardGraph.getSnapshot(this.sessionId);
      const nodeMap = new Map(snapshot.nodes.map(n => [n.id, n]));
      const edgeMap = new Map(snapshot.edges.map(e => [e.id, e]));

      const changedNodesMap = new Map<string, GraphNode>();
      const changedEdgesMap = new Map<string, typeof snapshot.edges[number]>();
      const tagSet = new Set<string>();
      // 按事件类型聚合后选择"代表性事件类型"用作 delta.eventType；
      // 优先级：contradiction_detected > intent_resolved > node_superseded > edge_added > node_added
      const priority: Record<BlackboardEvent['type'], number> = {
        node_added: 1,
        edge_added: 2,
        node_superseded: 3,
        intent_resolved: 4,
        contradiction_detected: 5,
      };
      let topType: BlackboardEvent['type'] = events[0].type;

      for (const event of events) {
        if (event.nodeId) {
          const node = nodeMap.get(event.nodeId);
          if (node) {
            changedNodesMap.set(node.id, node);
            for (const tag of node.tags ?? []) tagSet.add(tag);
          }
        }
        if (event.edgeId) {
          const edge = edgeMap.get(event.edgeId);
          if (edge) changedEdgesMap.set(edge.id, edge);
        }
        if (priority[event.type] > priority[topType]) topType = event.type;
      }

      const changedNodes = [...changedNodesMap.values()];
      const changedEdges = [...changedEdgesMap.values()];
      // 构建合并摘要：按事件类型分组计数
      const groupCounts = new Map<BlackboardEvent['type'], number>();
      for (const event of events) groupCounts.set(event.type, (groupCounts.get(event.type) ?? 0) + 1);
      const summaryParts: string[] = [];
      for (const [type, count] of groupCounts) {
        const sample = changedNodes.find(n => events.some(e => e.type === type && e.nodeId === n.id));
        const label = this.buildHumanSummary(
          { type, sessionId: this.sessionId, timestamp: Date.now() },
          sample ? [sample] : [],
        );
        summaryParts.push(count > 1 ? `${label} (×${count})` : label);
      }
      const humanSummary = summaryParts.join('；') || `黑板事件 ×${events.length}`;
      const relatedTags = [...tagSet];

      const delta: BlackboardDelta = {
        eventType: topType,
        changedNodes,
        changedEdges,
        humanSummary,
        relatedTags,
      };

      const contractChanged = changedNodes.some(node => node.kind === 'contract');
      let packDelivered = 0;
      if (contractChanged) {
        const pack = this.refreshContractPack(snapshot);
        // 仅当契约内容真的相对上次广播发生变化时才全量重发，避免等价事件（如同一契约被
        // 重复写入、或非内容性 supersede）触发 N×Worker 的全量包广播。
        const fingerprint = contractPackFingerprint(pack);
        if (fingerprint && fingerprint !== this.lastBroadcastFingerprint) {
          const systemContext = renderContractPackSystemMessage(pack);
          if (systemContext) {
            packDelivered = this.pool.broadcastSystemContext(systemContext);
            this.lastBroadcastFingerprint = fingerprint;
          }
        }
      }

      // 1. 广播 delta 文本快照给 Worker（既有路径）
      const deltaDelivered = this.pool.broadcastBlackboardDelta(delta);
      const delivered = Math.max(deltaDelivered, packDelivered);
      // 2. emit 一份聚合事件给 SseBridge / TUI 共享 — 避免订阅方各自重新查图重算
      this.emitter.emit('blackboard:delta', { sessionId: this.sessionId, ...delta });
      // 3. 同步 Leader 状态文案
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: delivered > 0
          ? `黑板已同步到 ${delivered} 个运行中 Agent`
          : '黑板已更新',
      });
    } catch (err) {
      leaderLogger.warn(`[Blackboard] 广播增量失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 构建黑板事件的人类可读摘要 */
  private buildHumanSummary(event: BlackboardEvent, changedNodes: GraphNode[]): string {
    const nodeDesc = changedNodes.length > 0
      ? changedNodes.map(n => `[${n.kind}] "${n.title}"`).join(', ')
      : event.nodeId ?? '(unknown)';
    switch (event.type) {
      case 'node_added':        return `新增节点：${nodeDesc}`;
      case 'node_superseded':   return `节点已更新：${nodeDesc}`;
      case 'edge_added':        return `新增关系边 ${event.edgeId ?? ''}`;
      case 'intent_resolved':   return `意图已完成：${nodeDesc}`;
      case 'contradiction_detected': return `发现矛盾：${nodeDesc}`;
      default:                  return `黑板事件：${event.type}`;
    }
  }

  /**
   * 获取黑板图分析结果（供 LeaderThinkingEngine 注入上下文）
   * 黑板模式未启用时返回 null
   */
  getBlackboardAnalysis(): GraphAnalysis | null {
    if (!this.blackboardGraph || !this.dispatcherEngine) return null;
    try {
      const snapshot = this.blackboardGraph.getSnapshot(this.sessionId);
      return this.dispatcherEngine.analyze(snapshot);
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  /** 黑板模式是否启用 */
  isEnabled(): boolean {
    return this.blackboardGraph !== null;
  }

  /**
   * 检查目标是否达成
   */
  checkGoalCompletion(): { achieved: boolean; summary: string } {
    if (!this.blackboardGraph || !this.dispatcherEngine) {
      return { achieved: false, summary: '' };
    }
    try {
      const snapshot = this.blackboardGraph.getSnapshot(this.sessionId);
      const result = this.dispatcherEngine.evaluateGoalCompletion(snapshot);
      return { achieved: result.achieved, summary: result.summary };
    } catch {/* expected: fallback to default */
      return { achieved: false, summary: '' };
    }
  }

  /**
   * 响应 Worker 完成 — 解析输出并写入图。
   * 不生成/缓存新的调度决策，避免 blackboard 越过 Leader 自动派生任务。
   *
   * contract_compliance 写入黑板 contract 节点：优先使用传入的 contractCompliance 参数；
   * 若未传入，则从 output 文本中的 awareness block 字段（contract_surface/contract_status/
   * contract_evidence/contract_deviations）解析提取。使得下游任务可通过黑板查询到上游任务的契约遵守状态。
   */
  handleWorkerCompletion(taskId: string, output: string, contractCompliance?: WorkerContractComplianceProof): void {
    if (!this.blackboardGraph) return;
    const parsed = parseWorkerOutput(output, this.sessionId);
    const { output: graphOutput } = parsed;
    const hasGraphOutput = graphOutput.newFacts.length > 0 || graphOutput.newIntents.length > 0 || (graphOutput.newContracts?.length ?? 0) > 0 || (graphOutput.newDesignDocs?.length ?? 0) > 0 || graphOutput.newEdges.length > 0;

    // contract_compliance 写入黑板 contract 节点
    const compliance = contractCompliance ?? this.extractContractComplianceFromText(output);
    if (compliance && compliance.surface && compliance.status) {
      try {
        const surface = compliance.surface;
        const evidenceText = compliance.evidence.length > 0
          ? compliance.evidence.join(' | ')
          : '(no evidence provided)';
        const deviationsText = compliance.deviations?.length
          ? `\nDeviations: ${compliance.deviations.join(' | ')}`
          : '';
        const content = [
          `Task ${taskId} contract compliance report`,
          `Surface: ${surface}`,
          `Status: ${compliance.status}`,
          `Evidence: ${evidenceText}`,
          deviationsText,
        ].filter(Boolean).join('\n');

        this.blackboardGraph.addContract({
          sessionId: this.sessionId,
          title: `Contract Compliance: ${surface} (${taskId})`,
          content,
          tags: [
            `contract:${surface}`,
            `task:${taskId}`,
            `compliance:${compliance.status}`,
            'provenance:worker',
          ],
          createdBy: `worker-completion:${taskId}`,
        });
        leaderLogger.info(`[Blackboard] Worker ${taskId} contract_compliance 写入黑板 (surface=${surface}, status=${compliance.status})`);
      } catch (err) {
        leaderLogger.warn(`[Blackboard] contract_compliance 写入失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!hasGraphOutput) return;
    try {
      this.blackboardGraph.applyWorkerOutputAndPrune(this.sessionId, taskId, graphOutput);
    } catch (err) {
      leaderLogger.warn(`[Blackboard] 响应完成失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 从 awareness block 文本中解析 contract_compliance 字段。
   * buildArtifactAwarenessBlock 将 contract_surface/contract_status/contract_evidence/contract_deviations
   * 渲染为文本行，此方法逆向提取为结构化对象。
   */
  private extractContractComplianceFromText(text: string): WorkerContractComplianceProof | null {
    const surfaceMatch = text.match(/^contract_surface:\s*(.+)$/m);
    const statusMatch = text.match(/^contract_status:\s*(.+)$/m);
    if (!surfaceMatch || !statusMatch) return null;
    const surface = surfaceMatch[1].trim();
    const status = statusMatch[1].trim() as WorkerContractComplianceProof['status'];
    if (!surface || !status) return null;

    const evidenceMatch = text.match(/^contract_evidence:\s*(.+)$/m);
    const evidence = evidenceMatch
      ? evidenceMatch[1].split(' | ').map(s => s.trim()).filter(Boolean)
      : [];

    const deviationsMatch = text.match(/^contract_deviations:\s*(.+)$/m);
    let deviations: string[] | undefined;
    if (deviationsMatch) {
      const raw = deviationsMatch[1].trim();
      if (raw && raw !== '无') {
        deviations = raw.split(' | ').map(s => s.trim()).filter(Boolean);
      }
    }

    return { surface, status, evidence, ...(deviations ? { deviations } : {}) };
  }

  /** 任务 → Intent 的反向索引，用于任务失败时释放 Intent */
  private intentByTaskId = new Map<string, string>();

  /**
   * 任务失败时释放其持有的 Intent，让后续决策可以重新认领
   */
  releaseIntentForTask(taskId: string): void {
    const intentId = this.intentByTaskId.get(taskId);
    if (!intentId || !this.blackboardGraph) return;
    this.intentByTaskId.delete(taskId);
    this.blackboardGraph.releaseIntent(intentId, this.sessionId, taskId);
    leaderLogger.debug(`[Blackboard] 任务 ${taskId} 失败，已释放 Intent ${intentId}`);
  }

  // ─── 导入图引擎 (面向巨型项目的确定性影响分析) ───

  private initImportGraph(): void {
    try {
      this.importGraphEngine = new ImportGraphEngine({
        rootDir: this.workspace,
        sourceDirs: ['src', 'web/src', 'lib', 'app'],
      });
      // 注册为 AgentPool 的变更影响提供者
      this.pool.setChangeImpactProvider((_taskId, workingDir) => {
        return this.buildImpactSummary(workingDir);
      });
      leaderLogger.debug('[Blackboard] ImportGraphEngine 已初始化并注册到 AgentPool');
    } catch (err) {
      leaderLogger.debug(`[Blackboard] ImportGraphEngine 初始化跳过: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 构建影响摘要字符串 (注入 worker task context) */
  private buildImpactSummary(_workingDir: string): string {
    if (!this.importGraphEngine) return '';
    try {
      // 延迟构建图 (首次调用时) + 后续增量更新
      if (!this.cachedImportGraph) {
        this.cachedImportGraph = this.importGraphEngine.build();
      }
      const graph = this.cachedImportGraph;
      // 提供模块结构概览 (文件数 + 边数)，worker 可据此判断变更影响
      if (graph.files.length === 0) return '';
      return [
        `项目依赖图: ${graph.files.length} 源文件, ${graph.edges.length} 导入关系`,
        '修改文件后请注意传递性影响范围，确保相关测试通过。',
      ].join('\n');
    } catch {/* expected: fallback to default */
      return '';
    }
  }

  /** 获取导入图引擎 (供外部 ChangeImpactResolver 使用) */
  getImportGraphEngine(): ImportGraphEngine | null {
    return this.importGraphEngine;
  }
}
