import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import type { DAGSnapshot, DAGEdge, DAGNode, OrchestrationTaskMetadata, RunExplanation, TaskReadiness } from './OrchestrationTypes.js';
import { resolve } from 'path';
import { withDisplayState } from './TaskDisplayState.js';
import type { TaskRecord } from '../types/canonical.js';
import { config as runtimeConfig } from '../config.js';
import { TaskPriorityEngine, type ScoredTask, type TypeWeightMap } from './TaskPriorityEngine.js';
import {
  assertCoreTaskExitReason,
  assertCoreTaskTransition,
  isCoreTaskTerminalStatus,
  normalizeTaskStatus,
  type CoreTaskExitReason,
  type CoreTaskStatus,
} from './StateSemantics.js';
import { wouldCreateCycle, isNodeReady, getReadyNodes, type DagSchedulerDeps } from './DagScheduler.js';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// TaskBoard 只保存内核 canonical 状态，跨端 pending/blocked/completed 等展示口径由 StateSemantics 统一投影。
export type TaskStatus = CoreTaskStatus;
export type ExitReason = CoreTaskExitReason;

export interface TaskScopeConfig {
  working_directory?: string;
  write_scope?: string[];
}

// Task — extends canonical TaskRecord with runtime-narrowed status/exitReason/description types
export interface Task extends Omit<TaskRecord, 'status' | 'exitReason' | 'description' | 'working_directory' | 'write_scope'> {
  description: string;
  status: TaskStatus;
  exitReason?: ExitReason;
  working_directory: string;
  write_scope: string[];
}

export interface TaskStats {
  total: number;
  dispatchableRaw: number;
  ready: number;
  blocked: number;
  running: number;
  terminal: number;
  // 终止原因细分
  completed: number;
  failed: number;
  cancelled: number;
  timeout: number;
}

export interface TaskContractReadiness {
  ready: boolean;
  reasons?: string[];
}

export type TaskContractReadinessResolver = (task: Task) => TaskContractReadiness;

/**
 * 任务看板 - 管理任务生命周期
 */
export class TaskBoard {
  private db?: DatabaseManager;
  private emitter?: EventEmitter;
  private sessionId: string;
  private tasks: Map<string, Task> = new Map();
  private taskCounter = 0;
  private workspaceRoot: string;
  private contractReadinessResolver?: TaskContractReadinessResolver;
  /**
   * 会话级原始用户任务(防漂移:每个新建任务的 context 自动前置它，
   * 让 worker prompt 始终携带全局目标，对抗子任务执行时忘记用户原始意图)。
   */
  private sessionGoal: string | null = null;
  /**
   * 终止态任务在内存 Map 中的保留时长（30 分钟）。
   * 超出后从 Map 中卸载，DB 中仍有完整记录，需要时可从 DB 重新加载。
   */
  private static readonly TERMINAL_TASK_TTL_MS = 30 * 60 * 1000;

  constructor(sessionId: string, db?: DatabaseManager, emitter?: EventEmitter, workspaceRoot?: string) {
    this.sessionId = sessionId;
    this.db = db;
    this.emitter = emitter;
    this.workspaceRoot = resolve(workspaceRoot || process.cwd());
  }

  setContractReadinessResolver(resolver?: TaskContractReadinessResolver): void {
    this.contractReadinessResolver = resolver;
  }

  /** 设置会话级原始任务(防漂移:新建任务的 context 自动前置)。null 关闭。 */
  setSessionGoal(goal: string | null): void {
    this.sessionGoal = goal && goal.trim() ? goal.trim() : null;
  }

  private resolveTaskPath(inputPath?: string): string {
    return resolve(this.workspaceRoot, inputPath || '.');
  }

  private normalizeTaskScope(scope?: TaskScopeConfig): { working_directory: string; write_scope: string[] } {
    const workingDirectory = this.resolveTaskPath(scope?.working_directory);
    const rawWriteScope = scope?.write_scope && scope.write_scope.length > 0
      ? scope.write_scope
      : [];
    const writeScope = Array.from(new Set(rawWriteScope.map((root) => this.resolveTaskPath(root))));

    return {
      working_directory: workingDirectory,
      write_scope: writeScope,
    };
  }

  private isTerminalStatus(status: TaskStatus): boolean {
    return isCoreTaskTerminalStatus(status);
  }

  private bumpRunGeneration(task: Task): void {
    const current = Number.isFinite(task.runGeneration) ? task.runGeneration : 0;
    task.runGeneration = Math.max(0, Math.floor(current)) + 1;
  }

  private computeDerivedTaskStatus(task: Task): TaskStatus {
    if (task.status === 'running' || this.isTerminalStatus(task.status)) {
      return task.status;
    }
    return 'dispatchable';
  }

  private isDependencySatisfied(dep: Task | undefined): boolean {
    return dep?.status === 'terminal' && dep.exitReason === 'completed';
  }

  private assertDependenciesExist(taskId: string, dependencyIds: string[]): void {
    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new Error(`Task ${taskId} cannot depend on itself`);
      }
      if (!this.tasks.has(depId)) {
        throw new Error(`Task ${taskId} depends on missing task ${depId}`);
      }
    }
  }

  private wouldCreateDependencyCycle(taskId: string, dependencyIds: string[]): boolean {
    // 委托通用 DAG 引擎(DFS 沿 blocked_by 回溯,检测加这些依赖是否成环)。语义等价于原内联实现。
    return wouldCreateCycle([...this.tasks.values()], taskId, dependencyIds);
  }

  /** 任务 ready 判定的领域语义注入(委托 DagScheduler.isNodeReady/getReadyNodes)。
   *  excludeBlocked: getReadyTasks 排除有外部 blocked_reason 的任务;isTaskReady 不排除(保持各自原有语义)。 */
  private taskReadyDeps(excludeBlocked: boolean): DagSchedulerDeps<Task> {
    return {
      isDependencySatisfied: (dep) => this.isDependencySatisfied(dep),
      isCandidate: (t) => t.status === 'dispatchable' && (!excludeBlocked || !t.blocked_reason),
      evaluateExtraGate: (t) => (this.getContractReadiness(t).ready ? [] : ['contract not ready']),
    };
  }

  private getContractReadiness(_task: Task): TaskContractReadiness {
    // v1.0.4: contract gate 降级为无操作，不再阻塞派发
    return { ready: true };
  }

  private persistTask(task: Task): void {
    if (this.db) {
      this.db.updateTask(task);
    }
    this.emitter?.emit('task:updated', { task: withDisplayState(task) });
    this.emitDAGUpdated();
  }

  private emitDAGUpdated(): void {
    const snapshot = this.getDAGSnapshot();
    this.emitter?.emit('orchestration:dag_updated', {
      sessionId: this.sessionId,
      snapshot,
    });
    this.emitter?.emit('run:explanation_updated', {
      sessionId: this.sessionId,
      explanation: this.getRunExplanation(snapshot),
    });
  }

  refreshReadiness(): void {
    this.emitDAGUpdated();
  }

  private attachDependencyLinks(task: Task): void {
    for (const depId of task.blocked_by) {
      const dependency = this.tasks.get(depId);
      if (dependency && !dependency.blocks.includes(task.id)) {
        dependency.blocks.push(task.id);
        this.persistTask(dependency);
      }
    }
  }

  private reconcileTaskStatus(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const nextStatus = this.computeDerivedTaskStatus(task);
    if (nextStatus !== task.status) {
      task.status = nextStatus;
      task.updated_at = nowSeconds();
      this.persistTask(task);
    }
  }

  private propagateDependencyState(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    for (const blockedTaskId of task.blocks) {
      this.reconcileTaskStatus(blockedTaskId);
    }
  }

  private rebuildBlocks(): void {
    for (const task of this.tasks.values()) {
      task.blocks = [];
    }
    for (const task of this.tasks.values()) {
      for (const depId of task.blocked_by) {
        const dependency = this.tasks.get(depId);
        if (dependency && !dependency.blocks.includes(task.id)) {
          dependency.blocks.push(task.id);
        }
      }
    }
  }

  nextTaskId(): string {
    this.taskCounter += 1;
    let taskId = `T-${this.taskCounter}`;
    while (this.tasks.has(taskId)) {
      this.taskCounter += 1;
      taskId = `T-${this.taskCounter}`;
    }
    return taskId;
  }

  peekNextTaskIds(count = 1): string[] {
    const ids: string[] = [];
    const reserved = new Set(this.tasks.keys());
    let counter = this.taskCounter;
    const total = Math.max(0, Math.floor(count));

    for (let i = 0; i < total; i++) {
      counter += 1;
      let taskId = `T-${counter}`;
      while (reserved.has(taskId)) {
        counter += 1;
        taskId = `T-${counter}`;
      }
      ids.push(taskId);
      reserved.add(taskId);
    }

    return ids;
  }

  /**
   * 创建任务
   */
  createTask(
    id: string,
    subject: string,
    description: string,
    agentType: string,
    blockedBy: string[] = [],
    blocks: string[] = [],
    scope?: TaskScopeConfig,
    context?: string,
    options?: {
      origin?: string;
      goal?: string;
      taskType?: 'bootstrap' | 'reason' | 'explore' | 'generic';
      orchestration?: OrchestrationTaskMetadata;
      preferred_agent_name?: string;
    },
  ): Task {
    const normalizedBlockedBy = Array.from(new Set(blockedBy));
    const normalizedBlocks = Array.from(new Set(blocks));
    if (this.tasks.has(id)) {
      throw new Error(`Task ${id} already exists`);
    }
    this.assertDependenciesExist(id, normalizedBlockedBy);
    if (this.wouldCreateDependencyCycle(id, normalizedBlockedBy)) {
      throw new Error(`Task ${id} dependencies would create a cycle`);
    }

    const now = nowSeconds();
    const normalizedScope = this.normalizeTaskScope(scope);
    // 防漂移:把会话级原始任务前置进每个任务的 context，覆盖所有 createTask 调用点
    // (create_task 工具 / explore / peer review / followup)，worker prompt 统一携带全局目标。
    const effectiveContext = this.sessionGoal
      ? (context ? `[全局原始任务 · 不可偏离] ${this.sessionGoal}\n\n${context}` : `[全局原始任务 · 不可偏离] ${this.sessionGoal}`)
      : context;
    const task: Task = {
      id,
      session_id: this.sessionId,
      subject,
      description,
      context: effectiveContext || undefined,
      status: 'dispatchable',
      runGeneration: 0,
      agent_type: agentType,
      blocked_by: normalizedBlockedBy,
      blocks: normalizedBlocks,
      assigned_agent: '',
      preferred_agent_name: typeof (options as { preferred_agent_name?: unknown } | undefined)?.preferred_agent_name === 'string'
        ? (options as { preferred_agent_name: string }).preferred_agent_name
        : undefined,
      working_directory: normalizedScope.working_directory,
      write_scope: normalizedScope.write_scope,
      orchestration: options?.orchestration,
      created_at: now,
      updated_at: now,
      origin: options?.origin,
      goal: options?.goal,
      taskType: options?.taskType,
    };

    this.tasks.set(id, task);
    this.attachDependencyLinks(task);
    task.status = this.computeDerivedTaskStatus(task);

    // 同步到数据库
    if (this.db) {
      this.db.insertTask(task);
    }
    this.emitter?.emit('task:created', { task: withDisplayState(task) });

    return task;
  }

  private normalizeDbTask(row: Partial<Task> & { exit_reason?: string; run_generation?: number }): Task {
    const normalizedScope = this.normalizeTaskScope({
      working_directory: row.working_directory,
      write_scope: row.write_scope,
    });
    const runGeneration = Number((row as { runGeneration?: unknown; run_generation?: unknown }).runGeneration ?? row.run_generation ?? 0);
    return {
      ...(row as Task),
      status: (row.status ?? 'dispatchable') as TaskStatus,
      exitReason: (row.exitReason ?? row.exit_reason) as ExitReason | undefined,
      runGeneration: Number.isFinite(runGeneration) ? Math.max(0, Math.floor(runGeneration)) : 0,
      blocked_by: row.blocked_by ?? [],
      blocks: row.blocks ?? [],
      assigned_agent: row.assigned_agent ?? '',
      working_directory: normalizedScope.working_directory,
      write_scope: normalizedScope.write_scope,
    };
  }

  private buildReadSnapshot(): Task[] {
    if (!this.db) return Array.from(this.tasks.values());
    const tasks = this.db.getTasksBySession(this.sessionId).map((task) => this.normalizeDbTask(task as never));
    const byId = new Map(tasks.map(task => [task.id, task]));
    for (const task of tasks) task.blocks = [];
    for (const task of tasks) {
      for (const depId of task.blocked_by) {
        const dep = byId.get(depId);
        if (dep && !dep.blocks.includes(task.id)) dep.blocks.push(task.id);
      }
    }
    return tasks;
  }

  /**
   * 获取任务
   *
   * 内存命中优先；miss 时若 DB 已挂接，做一次单条懒回填，避免 leader 长跑
   * 后单进程内存被回收却尚未 reloadFromDB 的窗口期返回 undefined。
   */
  getTask(id: string): Task | undefined {
    if (this.db) {
      const row = this.db.getTask(id, this.sessionId);
      if (!row) {
        this.tasks.delete(id);
        return undefined;
      }
      const task = this.normalizeDbTask(row as never);
      this.tasks.set(task.id, task);
      return task;
    }
    return this.tasks.get(id);
  }

  updateTask(
    id: string,
    updates: Partial<Pick<Task, 'subject' | 'description' | 'context' | 'agent_type' | 'blocked_by' | 'preferred_agent_name' | 'orchestration'>> & {
      scope?: TaskScopeConfig;
      working_directory?: string;
      write_scope?: string[];
    },
  ): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`任务 ${id} 不存在`);
    }
    if (task.status !== 'dispatchable' || task.assigned_agent) {
      throw new Error(`任务 ${id} 已派发或已终止，不能编辑`);
    }

    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.context !== undefined) task.context = updates.context || undefined;
    if (updates.agent_type !== undefined) task.agent_type = updates.agent_type;
    if (updates.preferred_agent_name !== undefined) task.preferred_agent_name = updates.preferred_agent_name || undefined;
    if (updates.orchestration !== undefined) task.orchestration = updates.orchestration;

    if (updates.scope || updates.working_directory !== undefined || updates.write_scope !== undefined) {
      const normalizedScope = this.normalizeTaskScope(updates.scope || {
        working_directory: updates.working_directory,
        write_scope: updates.write_scope,
      });
      task.working_directory = normalizedScope.working_directory;
      task.write_scope = normalizedScope.write_scope;
    }

    if (updates.blocked_by !== undefined) {
      const nextBlockedBy = Array.from(new Set(updates.blocked_by.filter(depId => depId && depId !== id)));
      for (const depId of nextBlockedBy) {
        const dependency = this.tasks.get(depId);
        if (!dependency) {
          throw new Error(`依赖任务 ${depId} 不存在`);
        }
      }
      task.blocked_by = nextBlockedBy;
      this.rebuildBlocks();
      for (const affected of this.tasks.values()) {
        affected.updated_at = nowSeconds();
        affected.status = this.computeDerivedTaskStatus(affected);
        this.persistTask(affected);
      }
      return task;
    }

    task.updated_at = nowSeconds();
    task.status = this.computeDerivedTaskStatus(task);
    this.persistTask(task);
    return task;
  }

  deleteTask(id: string): { deletedTask: Task; affectedTasks: Task[] } {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`任务 ${id} 不存在`);
    }
    if (task.status !== 'dispatchable' || task.assigned_agent) {
      throw new Error(`任务 ${id} 已派发或已终止，不能删除`);
    }

    const deletedTask = { ...task, blocked_by: [...task.blocked_by], blocks: [...task.blocks] };
    this.tasks.delete(id);
    if (this.db && 'deleteTask' in this.db && typeof this.db.deleteTask === 'function') {
      this.db.deleteTask(id, this.sessionId);
    }
    const affectedTasks: Task[] = [];
    for (const candidate of this.tasks.values()) {
      if (!candidate.blocked_by.includes(id)) continue;
      candidate.blocked_by = candidate.blocked_by.filter(depId => depId !== id);
      candidate.updated_at = nowSeconds();
      candidate.status = this.computeDerivedTaskStatus(candidate);
      affectedTasks.push(candidate);
    }
    this.rebuildBlocks();
    for (const affected of affectedTasks) {
      this.persistTask(affected);
    }
    this.emitter?.emit('task:deleted', { taskId: id, task: withDisplayState(deletedTask) });
    return { deletedTask, affectedTasks };
  }

  /**
   * 更新任务状态
   *
   * 注意：合法 transition 和 exitReason 校验必须走 StateSemantics。
   * TaskBoard 不再维护自己的状态转换表，避免 Web/TUI/QQ/后端内核出现多套规则。
   */
  updateTaskStatus(id: string, status: TaskStatus, exitReason?: ExitReason, result?: string | object): void {
    const task = this.tasks.get(id);
    if (!task) return;

    // 幂等：同状态转换视为 no-op
    if (task.status === status && task.exitReason === exitReason) {
      if (result !== undefined) {
        task.result = result;
        task.updated_at = nowSeconds();
        this.persistTask(task);
      }
      return;
    }

    assertCoreTaskTransition(task.status, status, `任务 ${id}`);
    assertCoreTaskExitReason(status, exitReason, `任务 ${id}`);

    task.status = status;
    task.exitReason = exitReason;
    task.updated_at = nowSeconds();
    if (result !== undefined) {
      task.result = result;
    }

    this.persistTask(task);
    if (this.isTerminalStatus(status)) {
      this.propagateDependencyState(id);
    }
  }

  /**
   * 分配任务给 Agent
   *
   * dispatchable -> running 的合法性由中心状态合同校验；
   * assignTask 只负责写入执行者和持久化状态。
   */
  assignTask(id: string, agentId: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    assertCoreTaskTransition(task.status, 'running', `任务 ${id}`);

    task.assigned_agent = agentId;
    task.status = 'running';
    task.exitReason = undefined;
    this.bumpRunGeneration(task);
    task.updated_at = nowSeconds();

    this.persistTask(task);
    this.emitter?.emit('task:assigned', { task: withDisplayState(task), agentId });
    return task;
  }

  /**
   * 将任务重新放回可恢复调度状态。
   * 用于 worker 失活后的自治续跑，不把它伪装成仍有活 worker 的 running。
   */
  prepareTaskForRedispatch(id: string, reason?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.assigned_agent = '';
    task.exitReason = undefined;
    // 重派即解除外部阻塞（外部条件已满足，否则不会走到重派）：清除 blocked_reason 让它重新可派发。
    task.blocked_reason = undefined;
    this.bumpRunGeneration(task);
    task.updated_at = nowSeconds();
    if (reason !== undefined) {
      task.result = reason;
    }
    task.status = this.computeDerivedTaskStatus({
      ...task,
      status: 'dispatchable',
    } as Task);

    this.persistTask(task);
  }

  blockTask(id: string, reason?: string): void {
    const task = this.tasks.get(id);
    if (!task || this.isTerminalStatus(task.status)) return;

    task.assigned_agent = '';
    task.exitReason = undefined;
    this.bumpRunGeneration(task);
    task.status = 'dispatchable';
    // 持久化外部阻塞标记（坏 API key / 缺凭证 / ask_user / 权限 / rate_limited 等）。
    // getReadyTasks 据此排除，防止 external_blocking 故障任务被无限 重派→故障→重派 烧 token。
    task.blocked_reason = reason || task.blocked_reason || 'externally blocked';
    task.updated_at = nowSeconds();
    if (reason !== undefined) {
      task.result = reason;
    }

    this.persistTask(task);
  }

  /**
   * 完成任务
   */
  completeTask(id: string, result: string | object): void {
    this.updateTaskStatus(id, 'terminal', 'completed', result);
    const task = this.tasks.get(id);
    this.emitter?.emit('task:completed', { taskId: id, result, task: task ? withDisplayState(task) : undefined });
  }

  /**
   * 标记任务失败
   */
  failTask(id: string, error: string): void {
    this.updateTaskStatus(id, 'terminal', 'failed', error);
    const task = this.tasks.get(id);
    this.emitter?.emit('task:failed', { taskId: id, reason: error, task: task ? withDisplayState(task) : undefined });
  }

  /**
   * 重开任务：把一个已终止（非 completed）的任务复活回可调度状态。
   *
   * 用于 retry 场景——agent 被 terminate / failed / crashed 后任务被标 terminal，
   * 用户要求重试时需要让这个任务重新可派发。核心状态合同里 terminal 是死状态
   * （不可转换），所以这里绕过状态机直接重置，但只对「非 completed 终态」生效，
   * 避免把已经验收完成的任务误重开。
   *
   * @returns 是否成功重开（已是非终态 / completed 终态 / 不存在 → false）
   */
  reopenTask(id: string, reason?: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    // 已完成的任务不重开（completed 是正常终态，重开会重复执行已验收工作）
    if (task.status === 'terminal' && task.exitReason === 'completed') return false;
    // 非终态本就可派发，无需重开
    if (task.status !== 'terminal') return false;

    task.status = 'dispatchable';
    task.exitReason = undefined;
    task.assigned_agent = '';
    this.bumpRunGeneration(task);
    task.updated_at = nowSeconds();
    if (reason !== undefined) {
      task.result = reason;
    }
    // 依赖未满足时 computeDerivedTaskStatus 仍会回到 dispatchable（blocked 已并入），
    // 这里调用是为了与正常派生口径一致并保证未来扩展不漏算。
    task.status = this.computeDerivedTaskStatus(task);

    this.persistTask(task);
    // 重开后它的下游可能需要从「被失败依赖阻塞」重算（虽然仍不会解锁，
    // 但保持依赖状态传播口径一致）。
    this.propagateDependencyState(id);
    return true;
  }

  /**
   * 写回 orchestration verdict — 让 OrchestrationRuntime.handleTaskResult 的
   * reject/repair 分支真生效，并落到 DB（重启后保留 verdict 状态）。
   */
  setOrchestrationVerdict(id: string, verdict: import('./OrchestrationTypes.js').OrchestrationVerdict): boolean {
    const task = this.tasks.get(id);
    if (!task || !task.orchestration) return false;
    if (task.orchestration.verdict === verdict) return false;
    const acceptanceStatus = verdict === 'PASS'
      ? 'passed'
      : verdict === 'FAIL'
        ? 'failed'
        : verdict === 'BLOCKED'
          ? 'blocked'
          : (task.orchestration.acceptance?.status ?? 'pending');
    task.orchestration = {
      ...task.orchestration,
      verdict,
      acceptance: {
        ...(task.orchestration.acceptance ?? { status: 'pending' }),
        status: acceptanceStatus,
        evaluatedAt: nowSeconds(),
      },
      blockedReason: verdict === 'BLOCKED' ? (task.orchestration.blockedReason ?? '验收返回 BLOCKED') : task.orchestration.blockedReason,
      nextAction: verdict === 'FAIL' ? (task.orchestration.nextAction ?? '生成 repair 节点或重派修复') : task.orchestration.nextAction,
    };
    task.updated_at = nowSeconds();
    this.persistTask(task);
    return true;
  }

  /**
   * 取消任务，并将其从下游依赖中移除，避免误建任务永久阻塞后续工作。
   */
  cancelTask(id: string, reason?: string): { task: Task; releasedDependents: string[] } | null {
    const task = this.tasks.get(id);
    if (!task) return null;

    assertCoreTaskTransition(task.status, 'terminal', `任务 ${id}`);

    task.status = 'terminal';
    task.exitReason = 'cancelled';
    task.updated_at = nowSeconds();
    if (reason !== undefined) {
      task.result = reason;
    }

    const releasedDependents: string[] = [];
    const downstreamIds = [...task.blocks];
    task.blocks = [];
    this.persistTask(task);
    this.emitter?.emit('task:cancelled', { taskId: id, reason, task: withDisplayState(task) });

    for (const blockedTaskId of downstreamIds) {
      const blockedTask = this.tasks.get(blockedTaskId);
      if (!blockedTask) continue;

      const nextBlockedBy = blockedTask.blocked_by.filter((depId) => depId !== id);
      if (nextBlockedBy.length === blockedTask.blocked_by.length) continue;

      blockedTask.blocked_by = nextBlockedBy;
      blockedTask.updated_at = nowSeconds();
      blockedTask.status = this.computeDerivedTaskStatus(blockedTask);
      this.persistTask(blockedTask);
      releasedDependents.push(blockedTask.id);
    }

    return { task, releasedDependents };
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): Task[] {
    return this.buildReadSnapshot();
  }

  /**
   * 获取可调度任务（包括被阻塞的任务）
   */
  getPendingTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'dispatchable');
  }

  /**
   * 获取运行中任务
   */
  getInProgressTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'running');
  }

  /**
   * 获取已完成任务
   */
  getCompletedTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'terminal' && t.exitReason === 'completed');
  }

  /**
   * 获取阻塞中的任务（依赖未完成的 dispatchable 任务）
   */
  getBlockedTasks(): Task[] {
    const all = this.getAllTasks();
    const byId = new Map(all.map(task => [task.id, task]));
    return all.filter(t => {
      if (t.status !== 'dispatchable') return false;
      if (t.blocked_reason) return true;
      for (const depId of t.blocked_by) {
        const dep = byId.get(depId);
        if (!this.isDependencySatisfied(dep)) return true;
      }
      return !this.getContractReadiness(t).ready;
    });
  }

  getTaskReadiness(task: Task, tasksById?: Map<string, Task>): TaskReadiness {
    if (task.status === 'running') return 'running';
    if (task.status === 'terminal') return 'terminal';
    if (task.status !== 'dispatchable') return 'blocked';
    const byId = tasksById ?? new Map(this.getAllTasks().map(t => [t.id, t]));
    const ready = task.blocked_by.every(depId => {
      const dep = byId.get(depId);
      return this.isDependencySatisfied(dep);
    });
    if (!ready) return 'blocked';
    return this.getContractReadiness(task).ready ? 'ready' : 'blocked';
  }

  getBlockedReason(task: Task, tasksById?: Map<string, Task>): string | undefined {
    if (task.status !== 'dispatchable') return task.orchestration?.blockedReason;
    const byId = tasksById ?? new Map(this.getAllTasks().map(t => [t.id, t]));
    const blockers = task.blocked_by.filter((depId) => {
      const dep = byId.get(depId);
      return !dep || dep.status !== 'terminal' || dep.exitReason !== 'completed';
    });
    if (blockers.length > 0) return `等待依赖任务完成: ${blockers.join(', ')}`;
    const contractReadiness = this.getContractReadiness(task);
    if (!contractReadiness.ready) {
      return contractReadiness.reasons?.join('; ') ?? task.orchestration?.blockedReason ?? '等待契约就绪';
    }
    return task.orchestration?.blockedReason;
  }

  getDAGSnapshot(): DAGSnapshot {
    const nodes: DAGNode[] = [];
    const edges: DAGEdge[] = [];
    const ready: string[] = [];
    const blocked: string[] = [];
    const running: string[] = [];
    const terminal: string[] = [];
    const allTasks = this.getAllTasks();
    const tasksById = new Map(allTasks.map(task => [task.id, task]));

    for (const task of allTasks) {
      const readiness = this.getTaskReadiness(task, tasksById);
      if (readiness === 'ready') ready.push(task.id);
      if (readiness === 'blocked') blocked.push(task.id);
      if (readiness === 'running') running.push(task.id);
      if (readiness === 'terminal') terminal.push(task.id);

      nodes.push({
        id: task.id,
        subject: task.subject,
        status: task.status,
        exitReason: task.exitReason,
        displayState: withDisplayState(task).displayState,
        readiness,
        agentType: task.agent_type,
        assignedAgent: task.assigned_agent || undefined,
        preferredAgentName: task.preferred_agent_name,
        blockedBy: [...task.blocked_by],
        blocks: [...task.blocks],
        blockedReason: this.getBlockedReason(task, tasksById),
        nextAction: task.orchestration?.nextAction,
        orchestration: task.orchestration,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      });

      for (const depId of task.blocked_by) {
        edges.push({ from: depId, to: task.id, type: 'depends_on' });
      }
      for (const evidenceTaskId of task.orchestration?.acceptance?.evidenceTaskIds ?? []) {
        edges.push({ from: evidenceTaskId, to: task.id, type: 'evidence_for' });
      }
    }

    const ranked = nodes
      .filter((node) => typeof node.orchestration?.mainPathRank === 'number')
      .sort((a, b) => (a.orchestration!.mainPathRank ?? 0) - (b.orchestration!.mainPathRank ?? 0))
      .map((node) => node.id);

    return {
      sessionId: this.sessionId,
      runId: nodes.find((node) => node.orchestration?.orchestrationRunId)?.orchestration?.orchestrationRunId,
      nodes,
      edges,
      ready,
      blocked,
      running,
      terminal,
      criticalPath: ranked.length > 0 ? ranked : undefined,
      updatedAt: nowSeconds(),
    };
  }

  getRunExplanation(snapshot = this.getDAGSnapshot()): RunExplanation {
    if (snapshot.running.length > 0) {
      return {
        mode: 'manual',
        state: 'working',
        reason: `正在执行 ${snapshot.running.length} 个任务`,
        activeTaskIds: snapshot.running,
        since: Date.now(),
        confidence: 'observed',
      };
    }
    if (snapshot.ready.length > 0) {
      return {
        mode: 'manual',
        state: 'working',
        reason: `有 ${snapshot.ready.length} 个任务已就绪，等待派发`,
        nextAction: `派发任务 ${snapshot.ready[0]}`,
        activeTaskIds: snapshot.ready,
        since: Date.now(),
        confidence: 'observed',
      };
    }
    if (snapshot.blocked.length > 0) {
      const first = snapshot.nodes.find((node) => node.id === snapshot.blocked[0]);
      return {
        mode: 'manual',
        state: 'waiting_for_dependency',
        reason: first?.blockedReason ?? `有 ${snapshot.blocked.length} 个任务等待依赖`,
        nextAction: first?.nextAction,
        blockedTaskIds: snapshot.blocked,
        since: Date.now(),
        confidence: 'observed',
      };
    }
    return {
      mode: 'manual',
      state: snapshot.nodes.length > 0 ? 'idle' : 'idle',
      reason: snapshot.nodes.length > 0 ? '所有任务已进入终态' : '当前没有任务图',
      since: Date.now(),
      confidence: 'observed',
    };
  }

  /**
   * 获取任务统计
   *
   * 统计使用 normalizeTaskStatus，保证 DB 快照、内存 Task、Web/TUI 投影看到同一套 completed/failed/cancelled 口径。
   */
  getStats(): TaskStats {
    const all = this.getAllTasks();
    const terminal = all.filter(t => this.isTerminalStatus(t.status));
    const ready = this.getReadyTasks();
    const blocked = this.getBlockedTasks();
    return {
      total: all.length,
      dispatchableRaw: all.filter(t => t.status === 'dispatchable').length,
      ready: ready.length,
      blocked: blocked.length,
      running: all.filter(t => normalizeTaskStatus(t) === 'running').length,
      terminal: terminal.length,
      completed: terminal.filter(t => normalizeTaskStatus(t) === 'completed').length,
      failed: terminal.filter(t => normalizeTaskStatus(t) === 'failed').length,
      cancelled: terminal.filter(t => normalizeTaskStatus(t) === 'cancelled').length,
      timeout: terminal.filter(t => t.exitReason === 'timeout').length,
    };
  }

  /**
   * 检查任务是否可执行（依赖是否完成）
   */
  isTaskReady(id: string): boolean {
    const all = this.getAllTasks();
    const byId = new Map(all.map(task => [task.id, task]));
    const task = byId.get(id);
    if (!task) return false;
    // 三道门(候选态 status=dispatchable + 依赖全满足 + 契约就绪)委托通用引擎;不排除 blocked_reason,保持原有语义。
    return isNodeReady(task, byId, this.taskReadyDeps(false)).ready;
  }

  /**
   * 获取可执行的任务
   */
  getReadyTasks(): Task[] {
    const all = this.getAllTasks();
    // 候选集委托通用引擎:三道门 = status=dispatchable 且无 blocked_reason + 依赖全满足 + 契约就绪。不自动派发。
    return getReadyNodes(all, this.taskReadyDeps(true));
  }

  /**
   * 从数据库加载任务
   */
  async loadFromDB(): Promise<void> {
    if (!this.db) return;
    const tasks = this.db.getTasksBySession(this.sessionId);
    for (const task of tasks) {
      const normalizedScope = this.normalizeTaskScope({
        working_directory: task.working_directory,
        write_scope: task.write_scope,
      });
      this.tasks.set(task.id, {
        ...(task as Task),
        working_directory: normalizedScope.working_directory,
        write_scope: normalizedScope.write_scope,
      });
      try {
        const numericId = Number.parseInt(task.id.split('-', 2)[1] || '', 10);
        if (Number.isFinite(numericId) && numericId >= this.taskCounter) {
          this.taskCounter = numericId;
        }
      } catch {
        // ignore malformed task ids
      }
    }
    this.rebuildBlocks();
    for (const task of this.tasks.values()) {
      if (!this.isTerminalStatus(task.status) && task.status !== 'running') {
        task.status = this.computeDerivedTaskStatus(task);
      }
    }
  }

  /**
   * 检查是否所有任务都处于终端状态
   * 零任务视为"全部终端"（没有非终止态任务）
   */
  allTerminal(): boolean {
    const tasks = this.getAllTasks();
    if (tasks.length === 0) return true; // 零任务 = 没有非终止态任务
    return tasks.every(t => t.status === 'terminal');
  }

  /**
   * 获取可分发的任务
   */
  getDispatchable(): Task[] {
    return this.getReadyTasks();
  }

  scoredCandidates(k = 5): ScoredTask[] {
    const weights = runtimeConfig.taskPriority?.weights as Partial<TypeWeightMap> | undefined;
    const engine = new TaskPriorityEngine(weights);
    return engine.topCandidates(this.getDispatchable(), k);
  }

  addDependencies(id: string, dependencyIds: string[]): void {
    const task = this.tasks.get(id);
    if (!task) return;

    const normalizedDependencyIds = Array.from(new Set(dependencyIds));
    this.assertDependenciesExist(id, normalizedDependencyIds);
    const merged = Array.from(new Set([...task.blocked_by, ...normalizedDependencyIds]));
    if (this.wouldCreateDependencyCycle(id, merged)) {
      throw new Error(`Task ${id} dependencies would create a cycle`);
    }
    task.blocked_by = merged;
    task.updated_at = nowSeconds();
    this.attachDependencyLinks(task);
    task.status = this.computeDerivedTaskStatus(task);
    this.persistTask(task);
  }

  /**
   * 获取任务摘要文本
   */
  getSummaryText(): string {
    const stats = this.getStats();
    const completed = this.getCompletedTasks();
    const failed = this.getFailedTasks();

    let summary = `任务统计：\n`;
    summary += `- 总计：${stats.total}\n`;
    summary += `- 待派发(raw dispatchable)：${stats.dispatchableRaw}\n`;
    summary += `- 可立即派发(ready)：${stats.ready}\n`;
    summary += `- 被依赖阻塞(blocked)：${stats.blocked}\n`;
    summary += `- 运行中：${stats.running}\n`;
    summary += `- 已完成：${stats.completed}\n`;
    summary += `- 失败：${stats.failed}\n`;
    if (stats.cancelled > 0) {
      summary += `- 已取消：${stats.cancelled}\n`;
    }
    if (stats.timeout > 0) {
      summary += `- 超时：${stats.timeout}\n`;
    }
    summary += '\n';

    if (completed.length > 0) {
      summary += '已完成任务:\n';
      for (const task of completed) {
        summary += `- [✓] ${task.subject}: ${task.result || '无结果'}\n`;
      }
      summary += '\n';
    }

    if (failed.length > 0) {
      summary += '失败任务:\n';
      for (const task of failed) {
        summary += `- [✗] ${task.subject}: ${task.result || '未知错误'}\n`;
      }
      summary += '\n';
    }

    return summary;
  }

  /**
   * 构造任务看板快照的上下文消息（结构化）。
   *
   * 文本内容等同 getSummaryText(),但带 metadata.kind='task_board_snapshot' 判别字段 ——
   * 上下文压缩器按此字段路由到 task_board 类别压缩器,而非嗅探 "任务统计：" 文本前缀(禁止启发式)。
   * 需要把任务看板快照塞进会话历史的调用方应使用本方法,而不是直接构造裸文本消息。
   */
  getSummaryMessage(): import('../llm/types.js').ChatMessage {
    return {
      role: 'assistant',
      content: this.getSummaryText(),
      metadata: { kind: 'task_board_snapshot' },
    };
  }

  /**
   * 获取失败任务
   */
  getFailedTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'terminal' && t.exitReason === 'failed');
  }

  /**
   * 清空任务板
   */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * 回收内存中的超龄终止态任务。
   * 被回收的任务仍存在于 DB 中，下次 getAllTasks() 不影响持久化记录。
   * 建议由 SessionManager 清理循环或 AgentPool 定期调用。
   */
  evictStalledTerminalTasks(): void {
    const cutoff = Date.now() - TaskBoard.TERMINAL_TASK_TTL_MS;
    for (const [id, task] of this.tasks.entries()) {
      if (this.isTerminalStatus(task.status) && task.updated_at * 1000 < cutoff) {
        this.tasks.delete(id);
      }
    }
  }
}

export default TaskBoard;
