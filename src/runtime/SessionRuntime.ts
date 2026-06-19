import { Workspace } from '../core/Workspace.js';
import { TaskBoard } from '../core/TaskBoard.js';
import { MessageBus } from '../core/MessageBus.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { AgentState, DatabaseManager } from '../core/Database.js';
import { AgentPool } from '../agents/AgentPoolRuntime.js';
import { LeaderAgent } from '../agents/LeaderAgent.js';
import type { RecoveredTaskInfo } from '../contracts/types/Agent.js';
import type { TokenTracker } from '../agents/BaseAgentRuntime.js';
import { AgentRoleRegistry } from '../agents/RoleRegistry.js';
import { createLLMClient } from '../llm/Client.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import { createToolRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { deriveSessionRuntimeState, type SessionRuntimeState } from '../core/SessionRuntimeState.js';
import { resolveModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import { TurnCoordinator, type InteractionTurnState } from '../core/TurnCoordinator.js';
import type { AgentResumeCheckpoint } from '../core/ResumeManager.js';
import { buildRecoveredTasks } from '../core/ResumeManager.js';
import type { ContextRuntimeState } from '../core/ContextRuntimeState.js';
import { listRecoveryRecords } from '../core/RecoveryRecords.js';
import { config as runtimeConfig } from '../config.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { WorkflowManager } from '../core/workflow/WorkflowManager.js';
import { WorkflowEngine } from '../core/workflow/WorkflowEngine.js';
import { ensureModeWorktree } from '../core/ModeWorktreeService.js';
import { attachTeamMailboxDatabase, getTeamMailbox } from '../core/TeamMailbox.js';
import { TeamCommunicationService } from '../core/TeamCommunicationService.js';
import type { ScheduledTaskManager } from '../core/ScheduledTaskManager.js';

export interface SessionRuntimeComponents {
  workspaceObj: Workspace;
  board: TaskBoard;
  bus: MessageBus;
  tracker: TokenTracker & {
    usageMap: Map<string, { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }>;
  };
  llm: ContentGenerator;
  toolRegistry: ToolRegistry;
  workflowManager: WorkflowManager;
  workflowEngine: WorkflowEngine;
  roleRegistry: AgentRoleRegistry;
  pool: AgentPool;
  leader: LeaderAgent;
  turnCoordinator: TurnCoordinator;
  /** TeamCommunicationService 实例 — 由 SessionManager 在 session 销毁时调 cleanup() 释放订阅 */
  teamCommunicationService: TeamCommunicationService;
  getRuntimeState(): SessionRuntimeState;
  getTurnState(): InteractionTurnState;
  getLeaderContextRuntimeState(): ContextRuntimeState;
}

export interface CreateSessionRuntimeOptions {
  sessionId: string;
  workspacePath: string;
  db: DatabaseManager;
  emitter: EventEmitter;
  roleRegistry: AgentRoleRegistry;
  leaderModel: string;
  agentModel: string;
  defaultSkillsContent: string;
  customPrompt?: string;
  llmFactory?: () => ContentGenerator;
  toolRegistryFactory?: () => ToolRegistry;
  scheduledTaskManager?: ScheduledTaskManager;
}

export function createSessionTokenTracker(
  sessionId: string,
  db: DatabaseManager,
  emitter: EventEmitter,
): TokenTracker & {
  usageMap: Map<string, { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }>;
} {
  const trackerImpl: TokenTracker & {
    usageMap: Map<string, { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }>;
  } = {
    usageMap: new Map<string, { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }>(),
    addUsage: (agentId: string, usage: { prompt: number; completion: number; total: number; cache_read?: number; cache_creation?: number }, modelName?: string) => {
      const current = trackerImpl.usageMap.get(agentId) ?? { prompt: 0, completion: 0, total: 0, cache_read: 0, cache_creation: 0 };
      const next = {
        prompt: current.prompt + usage.prompt,
        completion: current.completion + usage.completion,
        total: current.total + usage.total,
        cache_read: (current.cache_read ?? 0) + (usage.cache_read ?? 0),
        cache_creation: (current.cache_creation ?? 0) + (usage.cache_creation ?? 0),
      };
      trackerImpl.usageMap.set(agentId, next);
      db.insertTokenUsage(sessionId, agentId, agentId, usage.prompt, usage.completion, usage.total, modelName, usage.cache_read, usage.cache_creation);
      emitter.emit('token:usage', {
        sessionId,
        agentId,
        ts: Date.now(),
        usage: {
          prompt: usage.prompt,
          completion: usage.completion,
          total: usage.total,
          ...(usage.cache_read != null ? { cache_read: usage.cache_read } : {}),
          ...(usage.cache_creation != null ? { cache_creation: usage.cache_creation } : {}),
        },
      });
    },
    getTotal: () => {
      let total = 0;
      for (const usage of trackerImpl.usageMap.values()) {
        total += usage.total;
      }
      return total;
    },
    loadHistory: (sid: string) => {
      const history = db.getTokenUsageBySession(sid);
      for (const record of history) {
        trackerImpl.usageMap.set(record.agent_id, {
          prompt: record.prompt,
          completion: record.completion,
          total: record.total,
          cache_read: record.cache_read,
          cache_creation: record.cache_creation,
        });
      }
    },
    getSessionTotal: () => {
      const history = db.getTokenUsageBySession(sessionId);
      return history.reduce((sum, r) => sum + r.total, 0);
    },
  };

  return trackerImpl;
}

export function createSessionRuntime(options: CreateSessionRuntimeOptions): SessionRuntimeComponents {
  const {
    sessionId,
    workspacePath,
    db,
    emitter,
    roleRegistry,
    leaderModel,
    agentModel,
    defaultSkillsContent,
    customPrompt,
    llmFactory,
    toolRegistryFactory,
    scheduledTaskManager,
  } = options;

  const workspaceObj = new Workspace(sessionId, workspacePath);
  const board = new TaskBoard(sessionId, db, emitter, workspacePath);
  const bus = new MessageBus(1000, emitter);
  const tracker = createSessionTokenTracker(sessionId, db, emitter);
  
  // 使用 leader_model 配置创建 LLM 客户端
  const makeLlm = llmFactory || (() => {
    const modelId = leaderModel || runtimeConfig.llm.leader_model;
    if (!modelId) throw new Error('llm.leader_model 未配置，请在 settings.json 中设置');
    return createLLMClient(modelId);
  });
  const llm = makeLlm();
  // ★ 后台预热 TCP+TLS 连接，减少首次 LLM 请求的握手延迟
  if (llm.warmup) void llm.warmup().catch(() => {});
  const toolRegistry = (toolRegistryFactory || createToolRegistry)();

  // ★ Bind tool registry to database for runtime-scoped tool execution
  toolRegistry.setDatabase(db, sessionId);
  attachTeamMailboxDatabase(db);
  getTeamMailbox().attachEmitter(emitter);

  const workflowManager = new WorkflowManager(db, emitter);
  const workflowEngine = new WorkflowEngine({
    db,
    toolRegistry,
    eventEmitter: emitter,
    workflowManager,
  });
  const turnCoordinator = new TurnCoordinator();

  const pool = new AgentPool({
    sessionId,
    llm,  // ★ 共享同一个 LLM client，消除重复冷启动
    toolRegistry,
    bus,
    emitter,
    db,
    tracker,
    workspace: workspacePath,
    model: agentModel,
    roleRegistry,
    taskBoard: board,
    workflowManager,
    workflowEngine,
    scheduledTaskManager,
  });

  const teamCommunicationService = new TeamCommunicationService({
    sessionId,
    bus,
    emitter,
    runtime: pool,
  });
  teamCommunicationService.start();

  const leader = new LeaderAgent({
    sessionId,
    llm,
    toolRegistry,
    board,
    bus,
    pool,
    tracker,
    workspace: workspaceObj.path,
    db,
    emitter,
    model: leaderModel,
    customPrompt,
    defaultSkillsContent,
    workflowManager,
    workflowEngine,
    scheduledTaskManager,
  });

  workflowEngine.setAgentExecutor(async ({ node, task, context }) => {
    const nodeData = node.data;
    const config = nodeData.config || {} as Record<string, unknown>;
    const roleType = config.conditionAgentRole || config.agentRole || (nodeData.metadata?.agentId as string) || 'evaluator';
    const agentName = `workflow-${node.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const taskId = `WF-${context.executionId}-${node.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    // 执行卫生：workflow agent 节点在独立 worktree 跑，避免产物污染主工作树
    // （非安全边界；非 git 仓库或创建失败时退回 workspaceObj.path）。
    const workflowWorkingDir = ensureModeWorktree('workflow', workspaceObj.path) || workspaceObj.path;
    const workflowTask = board.createTask(
      taskId,
      nodeData.label || `Workflow node ${node.id}`,
      task,
      roleType,
      [],
      [],
      { working_directory: workflowWorkingDir },
      [
        `Workflow ID: ${context.workflowId}`,
        `Execution ID: ${context.executionId}`,
        `Node ID: ${node.id}`,
        `Node input: ${JSON.stringify(nodeData.inputs || {})}`,
      ].join('\n'),
    );
    const handle = pool.register(agentName, roleType, workflowTask.id);
    const assignedTask = board.assignTask(workflowTask.id, handle.name) ?? workflowTask;
    handle.taskRunGeneration = assignedTask.runGeneration;
    pool.prepareWorkerRuntime(handle, assignedTask);
    const taskPromise = pool.runAgentWrapper(handle, assignedTask);
    handle.asyncTask = taskPromise;
    return await taskPromise;
  });

  // Ensure Leader and pool share the same registry instance.
  leader['roleRegistry'] = roleRegistry;
  const getRuntimeState = (): SessionRuntimeState => deriveSessionRuntimeState({
    sessionId,
    workspace: workspaceObj.path,
    sessionStatus: db.getSession(sessionId)?.status || 'active',
    leader: leader.getInteractionSnapshot(),
    runningWorkers: pool.getRunning(),
    recoveringTasks: listRecoveryRecords(db, sessionId).map((record) => ({
      taskId: record.taskId,
      agentName: record.agentName,
      category: record.category,
      faultClass: record.faultClass,
      recoveryAction: record.recoveryAction,
      lastActivityAt: record.lastActivityAt,
    })),
    dispatchableTaskCount: board.getDispatchable().length,
    allTasksTerminal: board.allTerminal(),
    pendingUserInput: db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_INPUT),
    pendingUserGate: db.getSessionState(sessionId, SESSION_KEYS.PENDING_USER_GATE),
    eternal: leader.getEternalRuntimeSnapshot(),
    modes: resolveModeRuntimeProjection({
      sessionId,
      db,
      blackboardAvailable: leader.isBlackboardEnabled(),
      permissionSummary: leader.getInteractionSnapshot().permissionSummary,
    }),
  });
  const getTurnState = (): InteractionTurnState => turnCoordinator.classify(getRuntimeState());
  const getLeaderContextRuntimeState = (): ContextRuntimeState => leader.getContextRuntimeState();

  // ★ 预热已在 LLM 实例创建后（L142）触发过一次，此处不重复调用

  return {
    workspaceObj,
    board,
    bus,
    tracker,
    llm,
    toolRegistry,
    workflowManager,
    workflowEngine,
    roleRegistry,
    pool,
    leader,
    turnCoordinator,
    teamCommunicationService,
    getRuntimeState,
    getTurnState,
    getLeaderContextRuntimeState,
  };
}

export function collectRecoveredTasks(
  board: TaskBoard,
  agentStates: AgentState[],
  checkpoints: Map<string, AgentResumeCheckpoint> = new Map(),
): RecoveredTaskInfo[] {
  return buildRecoveredTasks(board, agentStates, checkpoints);
}

function resumeRuntimeWorkers(
  runtime: Pick<SessionRuntimeComponents, 'board' | 'pool' | 'bus'>,
  recoveredTasks: RecoveredTaskInfo[],
): void {
  for (const recoveredTask of recoveredTasks) {
    const task = runtime.board.getTask(recoveredTask.id);
    if (!task) continue;

    const handle = runtime.pool.register(
      recoveredTask.agent,
      recoveredTask.role || 'coding',
      task.id,
      recoveredTask.agentId,
    );
    runtime.pool.prepareWorkerRuntime(handle, task);
    const taskPromise = runtime.pool.runAgentWrapper(
      handle,
      task,
      true,
      {
        iteration: recoveredTask.iteration || 0,
        toolCallCount: recoveredTask.toolCallCount || 0,
      },
    );
    handle.asyncTask = taskPromise;
    void taskPromise.catch((error) => {
      console.error(`[SessionRuntime] Recovered agent ${recoveredTask.agent} failed:`, error);
    });
  }
}
