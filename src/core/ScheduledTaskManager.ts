/**
 * ScheduledTaskManager — 定时任务调度引擎
 *
 * 功能：
 * 1. 解析 cron 表达式，计算下次触发时间
 * 2. 定期检查到期任务，注入 prompt 到 Leader
 * 3. 支持一次性 / 循环任务
 * 4. 持久化到 DB，进程重启后自动恢复
 * 5. 内置系统任务类型（替代原 eternal mode 巡逻能力）
 *
 * 内置系统任务（prompt 前缀）：
 * - [SYSTEM:patrol]         → 巡逻：检查卡死 Agent、自动批准方案、发现新工作
 * - [SYSTEM:dead_end_check] → 死胡同检测：连续失败 3 次的任务自动放弃
 * - [SYSTEM:rebalance]      → 优先级重平衡：基于任务年龄和依赖深度调整
 * - [SYSTEM:idle_scan]      → 空闲扫描：重试失败任务、解除已满足依赖的阻塞
 * - 普通 prompt             → 直接注入 Leader（现有行为）
 */

import type {
  DatabaseManager,
  ScheduledTaskAudience,
  ScheduledTaskIntensity,
  ScheduledTaskRecord,
  ScheduledTaskSourceType,
  ScheduledTaskType,
} from './Database.js';
import type { MessageBus } from './MessageBus.js';
import type { EventEmitter } from './EventEmitter.js';
import type { SessionManager } from './SessionManager.js';
import { coreLogger } from './Log.js';
import { randomUUID } from 'crypto';
import { listRecoveryRecords } from './RecoveryRecords.js';
import { buildRecoverySnapshot } from './RuntimeRecoveryController.js';

/** 系统任务类型 */
const SYSTEM_TASK_PREFIXES = [
  '[SYSTEM:patrol]',
  '[SYSTEM:dead_end_check]',
  '[SYSTEM:rebalance]',
  '[SYSTEM:idle_scan]',
] as const;

type SystemTaskType = typeof SYSTEM_TASK_PREFIXES[number];

function parseSystemTaskType(prompt: string): SystemTaskType | null {
  for (const prefix of SYSTEM_TASK_PREFIXES) {
    if (prompt.startsWith(prefix)) return prefix;
  }
  return null;
}

// ─── Cron 解析（轻量实现，支持 */n 和固定值） ────────────

interface CronField {
  type: 'any' | 'fixed' | 'interval';
  value?: number;
  interval?: number;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCronField(field: string): CronField {
  if (field === '*') return { type: 'any' };
  if (field.startsWith('*/')) {
    const interval = parseInt(field.slice(2), 10);
    return { type: 'interval', interval: isNaN(interval) ? 1 : interval };
  }
  const value = parseInt(field, 10);
  return { type: 'fixed', value: isNaN(value) ? 0 : value };
}

function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parseCronField(parts[0]),
    hour: parseCronField(parts[1]),
    dayOfMonth: parseCronField(parts[2]),
    month: parseCronField(parts[3]),
    dayOfWeek: parseCronField(parts[4]),
  };
}

function matchesField(field: CronField, value: number): boolean {
  if (field.type === 'any') return true;
  if (field.type === 'fixed') return field.value === value;
  if (field.type === 'interval') return value % (field.interval ?? 1) === 0;
  return false;
}

/** 计算 cron 表达式的下次触发时间（基于给定时间往后找，最多找 60 天） */
export function getNextCronTime(cronExpr: string, fromMs: number): number | null {
  const parsed = parseCron(cronExpr);
  if (!parsed) return null;

  const from = new Date(fromMs + 60_000); // 至少从下一分钟开始
  const maxDate = new Date(fromMs + 60 * 24 * 3600 * 1000); // 最多找 60 天

  const d = new Date(from);
  d.setSeconds(0);
  d.setMilliseconds(0);

  for (let i = 0; i < 60 * 24 * 60; i++) { // 最多遍历 60 天的分钟数
    if (d > maxDate) return null;

    if (
      matchesField(parsed.minute, d.getMinutes()) &&
      matchesField(parsed.hour, d.getHours()) &&
      matchesField(parsed.dayOfMonth, d.getDate()) &&
      matchesField(parsed.month, d.getMonth() + 1) &&
      matchesField(parsed.dayOfWeek, d.getDay())
    ) {
      return d.getTime();
    }

    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ─── ScheduledTaskManager ────────────────────────────────

export interface ScheduledTaskCreateParams {
  id?: string;
  cron: string;
  prompt?: string;
  recurring: boolean;
  durable: boolean;
  sessionId: string;
  taskType?: ScheduledTaskType;
  intensity?: ScheduledTaskIntensity;
  audience?: ScheduledTaskAudience;
  workflowId?: string;
  workflowInput?: Record<string, unknown>;
  sourceType?: ScheduledTaskSourceType;
  sourceId?: string;
  sourceNodeId?: string;
  enabled?: boolean;
}

export interface ScheduledTaskCreateResult {
  id: string;
  next_run_at: number | null;
  task_type: ScheduledTaskType;
  intensity: ScheduledTaskIntensity;
  audience: ScheduledTaskAudience;
  workflow_id: string | null;
  source_type?: ScheduledTaskSourceType | null;
  source_id?: string | null;
  source_node_id?: string | null;
}

const INTENSITY_GUIDANCE: Record<ScheduledTaskIntensity, string> = {
  gentle: '低打扰、先观察和汇报；除非风险明确，不主动扩大变更范围。',
  normal: '按常规自动化执行；需要判断时保持简洁确认和可回滚动作。',
  aggressive: '更主动推进、重试和分派；可扩大检查范围，但仍需遵守权限和安全边界。',
  critical: '高优先级处理；优先止损、恢复、告警和结构化汇报，避免无关改动。',
};

const AUDIENCE_GUIDANCE: Record<ScheduledTaskAudience, string> = {
  personal: '面向单个用户的个人助理自动化，输出简洁、保留上下文。',
  team: '面向多 Agent/团队协作，明确负责人、状态、阻塞和交接。',
  ops: '面向运维/巡检/事故处理，强调可观测性、风险、证据和恢复步骤。',
  customer: '面向外部客户或交付结果，措辞稳健，避免暴露内部噪声。',
};

function normalizeTaskType(value: ScheduledTaskType | undefined, workflowId?: string): ScheduledTaskType {
  if (value === 'workflow' || workflowId) return 'workflow';
  return 'prompt';
}

function normalizeIntensity(value: ScheduledTaskIntensity | undefined): ScheduledTaskIntensity {
  if (value === 'gentle' || value === 'normal' || value === 'aggressive' || value === 'critical') return value;
  return 'normal';
}

function normalizeAudience(value: ScheduledTaskAudience | undefined): ScheduledTaskAudience {
  if (value === 'personal' || value === 'team' || value === 'ops' || value === 'customer') return value;
  return 'personal';
}

export class ScheduledTaskManager {
  private db: DatabaseManager;
  private bus: MessageBus;
  private emitter: EventEmitter;
  private sessionManager?: SessionManager;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL_MS = 30_000; // 30 秒检查一次
  /**
   * P1 修复：fireTask 同时被 tick（自动）与 fireTaskManually（用户手动）调用，
   * 二者并发触发同一 taskId 时，updateScheduledTaskRun 之前的窗口期会让两条路径都
   * 走到 bus.send，下游 Leader 收到双份 user_intervention 重复执行（[SYSTEM:patrol]
   * 之类的系统任务影响尤其大）。
   *
   * 这里加 in-flight 去重 Set；同 taskId 第二次进入直接 noop。
   */
  private firingTasks: Set<string> = new Set();

  constructor(db: DatabaseManager, bus: MessageBus, emitter: EventEmitter, sessionManager?: SessionManager) {
    this.db = db;
    this.bus = bus;
    this.emitter = emitter;
    this.sessionManager = sessionManager;
  }

  private resolveWorkflowEngineForTask(task: ScheduledTaskRecord): ReturnType<SessionManager['getWorkflowEngine']> {
    if (!this.sessionManager) {
      throw new Error('workflow task requires SessionManager');
    }

    const scopedResolver = this.sessionManager.getSessionWorkflowEngine;
    if (typeof scopedResolver === 'function') {
      const scoped = scopedResolver.call(this.sessionManager, task.session_id);
      if (scoped) return scoped;
      throw new Error(`workflow task session runtime is not active: ${task.session_id}`);
    }

    return this.sessionManager.getWorkflowEngine();
  }

  /** 启动调度器 */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => {
        coreLogger.error(`[ScheduledTaskManager] tick 未捕获错误: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.POLL_INTERVAL_MS);
    coreLogger.info('[ScheduledTaskManager] 调度器已启动，每 30s 检查到期任务');
  }

  /** 停止调度器 */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      coreLogger.info('[ScheduledTaskManager] 调度器已停止');
    }
  }

  /** 创建定时任务 */
  createTask(params: ScheduledTaskCreateParams): ScheduledTaskCreateResult {
    const id = params.id || `st-${randomUUID().slice(0, 8)}`;
    const nextRunAt = getNextCronTime(params.cron, Date.now());
    const taskType = normalizeTaskType(params.taskType, params.workflowId);
    const intensity = normalizeIntensity(params.intensity);
    const audience = normalizeAudience(params.audience);

    if (taskType === 'workflow' && !params.workflowId) {
      throw new Error('workflow task requires workflowId');
    }
    if (taskType === 'prompt' && !params.prompt?.trim()) {
      throw new Error('prompt task requires prompt');
    }

    this.db.insertScheduledTask({
      id,
      session_id: params.sessionId,
      cron: params.cron,
      prompt: params.prompt ?? '',
      task_type: taskType,
      intensity,
      audience,
      workflow_id: params.workflowId ?? null,
      workflow_input: params.workflowInput ?? null,
      source_type: params.sourceType ?? null,
      source_id: params.sourceId ?? null,
      source_node_id: params.sourceNodeId ?? null,
      recurring: params.recurring,
      durable: params.durable,
      enabled: params.enabled,
      next_run_at: nextRunAt,
    });

    coreLogger.info(`[ScheduledTaskManager] 创建定时任务 ${id}: type=${taskType}, cron="${params.cron}", recurring=${params.recurring}, nextRun=${nextRunAt ? new Date(nextRunAt).toISOString() : 'never'}`);

    return {
      id,
      next_run_at: nextRunAt,
      task_type: taskType,
      intensity,
      audience,
      workflow_id: params.workflowId ?? null,
      source_type: params.sourceType ?? null,
      source_id: params.sourceId ?? null,
      source_node_id: params.sourceNodeId ?? null,
    };
  }

  /** 根据 source_type/source_id/source_node_id 稳定创建或更新定时任务。 */
  upsertTaskBySource(params: ScheduledTaskCreateParams & {
    sourceType: ScheduledTaskSourceType;
    sourceId: string;
    sourceNodeId: string;
  }): ScheduledTaskCreateResult {
    const taskType = normalizeTaskType(params.taskType, params.workflowId);
    const intensity = normalizeIntensity(params.intensity);
    const audience = normalizeAudience(params.audience);
    const nextRunAt = getNextCronTime(params.cron, Date.now());

    if (taskType === 'workflow' && !params.workflowId) {
      throw new Error('workflow task requires workflowId');
    }
    if (taskType === 'prompt' && !params.prompt?.trim()) {
      throw new Error('prompt task requires prompt');
    }

    const existing = this.db.getScheduledTaskBySourceNode(
      params.sourceType,
      params.sourceId,
      params.sourceNodeId,
    );
    const id = existing?.id ?? params.id ?? `st-${randomUUID().slice(0, 8)}`;
    const definition = {
      id,
      session_id: params.sessionId,
      cron: params.cron,
      prompt: params.prompt ?? '',
      task_type: taskType,
      intensity,
      audience,
      workflow_id: params.workflowId ?? null,
      workflow_input: params.workflowInput ?? null,
      source_type: params.sourceType,
      source_id: params.sourceId,
      source_node_id: params.sourceNodeId,
      recurring: params.recurring,
      durable: params.durable,
      enabled: params.enabled,
      next_run_at: nextRunAt,
    };

    if (existing) {
      this.db.updateScheduledTaskDefinition(definition);
      coreLogger.info(`[ScheduledTaskManager] 更新来源定时任务 ${id}: source=${params.sourceType}:${params.sourceId}:${params.sourceNodeId}, cron="${params.cron}"`);
    } else {
      this.db.insertScheduledTask(definition);
      coreLogger.info(`[ScheduledTaskManager] 创建来源定时任务 ${id}: source=${params.sourceType}:${params.sourceId}:${params.sourceNodeId}, cron="${params.cron}"`);
    }

    return {
      id,
      next_run_at: nextRunAt,
      task_type: taskType,
      intensity,
      audience,
      workflow_id: params.workflowId ?? null,
      source_type: params.sourceType,
      source_id: params.sourceId,
      source_node_id: params.sourceNodeId,
    };
  }

  /** 获取指定 session 的所有定时任务 */
  getTasks(sessionId: string) {
    return this.db.getScheduledTasks(sessionId);
  }

  /** 获取所有定时任务（跨 session） */
  getAllTasks() {
    return this.db.getAllScheduledTasks();
  }

  /** 删除定时任务 */
  deleteTask(id: string): void {
    this.db.deleteScheduledTask(id);
    coreLogger.info(`[ScheduledTaskManager] 删除定时任务 ${id}`);
  }

  getTasksBySource(sourceType: ScheduledTaskSourceType, sourceId: string): ScheduledTaskRecord[] {
    return this.db.getScheduledTasksBySource(sourceType, sourceId);
  }

  deleteTasksBySource(sourceType: ScheduledTaskSourceType, sourceId: string): void {
    this.db.deleteScheduledTasksBySource(sourceType, sourceId);
    coreLogger.info(`[ScheduledTaskManager] 删除来源定时任务 source=${sourceType}:${sourceId}`);
  }

  deleteTaskBySourceNode(sourceType: ScheduledTaskSourceType, sourceId: string, sourceNodeId: string): void {
    this.db.deleteScheduledTaskBySourceNode(sourceType, sourceId, sourceNodeId);
    coreLogger.info(`[ScheduledTaskManager] 删除来源定时任务 source=${sourceType}:${sourceId}:${sourceNodeId}`);
  }

  /** 手动触发任务（不修改调度时间） */
  async fireTaskManually(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.db.getScheduledTaskById(taskId);
    if (!task) return { ok: false, error: 'Task not found' };
    try {
      await this.fireTask(task);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 切换任务启用/禁用 */
  toggleTask(taskId: string, enabled: boolean): void {
    this.db.toggleScheduledTask(taskId, enabled);
    coreLogger.info(`[ScheduledTaskManager] 任务 ${taskId} ${enabled ? '启用' : '禁用'}`);
  }

  /** 核心调度循环 */
  private async tick(): Promise<void> {
    try {
      const dueTasks = this.db.getAllDueScheduledTasks();
      if (dueTasks.length === 0) return;

      for (const task of dueTasks) {
        try {
          await this.fireTask(task);
        } catch (err) {
          coreLogger.error(`[ScheduledTaskManager] 任务 ${task.id} 触发失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      coreLogger.error(`[ScheduledTaskManager] tick 错误: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 触发单个定时任务 */
  private async fireTask(task: ScheduledTaskRecord): Promise<void> {
    // P1 修复：tick 与 fireTaskManually 并发去重。第二次进入直接放弃，下次 tick 再来。
    if (this.firingTasks.has(task.id)) {
      coreLogger.warn(`[ScheduledTaskManager] 任务 ${task.id} 正在触发中，跳过重复入口`);
      return;
    }
    this.firingTasks.add(task.id);
    try {
      const now = Date.now();
      const label = task.task_type === 'workflow'
        ? `workflow:${task.workflow_id ?? 'missing'}`
        : `"${task.prompt.slice(0, 80)}..."`;
      coreLogger.info(`[ScheduledTaskManager] 触发任务 ${task.id}: ${label} → session ${task.session_id}`);

      // 计算下次运行时间
      let nextRunAt: number | null = null;
      if (task.recurring) {
        nextRunAt = getNextCronTime(task.cron, now);
      }

      // 更新 DB
      this.db.updateScheduledTaskRun(task.id, now / 1000, nextRunAt ? nextRunAt / 1000 : null);

      if (task.task_type === 'workflow') {
        await this.fireWorkflowTask(task, now);
      } else {
        await this.firePromptTask(task, now);
      }

      coreLogger.info(`[ScheduledTaskManager] 任务 ${task.id} 已触发，下次运行: ${nextRunAt ? new Date(nextRunAt).toISOString() : '不再运行'}`);
    } finally {
      this.firingTasks.delete(task.id);
    }
  }

  private buildScheduleContext(task: ScheduledTaskRecord, firedAtMs: number): Record<string, unknown> {
    return {
      taskId: task.id,
      taskType: task.task_type,
      cron: task.cron,
      recurring: task.recurring,
      durable: task.durable,
      sessionId: task.session_id,
      firedAt: new Date(firedAtMs).toISOString(),
      intensity: task.intensity,
      audience: task.audience,
      intensityGuidance: INTENSITY_GUIDANCE[task.intensity],
      audienceGuidance: AUDIENCE_GUIDANCE[task.audience],
      workflowId: task.workflow_id,
    };
  }

  private buildPromptMessage(task: ScheduledTaskRecord, prompt: string, firedAtMs: number): string {
    return [
      '[定时任务触发]',
      `任务ID: ${task.id}`,
      `强度: ${task.intensity} - ${INTENSITY_GUIDANCE[task.intensity]}`,
      `用户群体: ${task.audience} - ${AUDIENCE_GUIDANCE[task.audience]}`,
      '',
      prompt,
    ].join('\n');
  }

  private async firePromptTask(task: ScheduledTaskRecord, now: number): Promise<void> {
    const systemType = parseSystemTaskType(task.prompt);
    if (systemType) {
      await this.fireSystemTask(task, systemType, now);
      this.db.updateScheduledTaskError(task.id, null);
      return;
    }

    // 普通任务：默认注入 Leader；若 prompt 以 @agent 开头，则直接注入指定子 Agent
    const directAgent = task.prompt.match(/^@([A-Za-z0-9_.-]+)\s+([\s\S]+)$/);
    if (directAgent && this.sessionManager) {
      const [, agentName, agentPrompt] = directAgent;
      const result = await this.sessionManager.sendAgentInput(
        task.session_id,
        agentName,
        this.buildPromptMessage(task, agentPrompt.trim(), now),
      );
      if (!result.ok) {
        this.db.updateScheduledTaskError(task.id, result.message);
        coreLogger.warn(`[ScheduledTaskManager] 注入 Agent @${agentName} 失败: ${result.message}`);
        throw new Error(result.message);
      }
      this.db.updateScheduledTaskError(task.id, null);
      return;
    }

    const leaderBusName = `${task.session_id}:leader`;
    const scheduledBusName = `${task.session_id}:scheduled_task`;
    await this.bus.send(
      scheduledBusName,
      leaderBusName,
      'user_intervention',
      this.buildPromptMessage(task, task.prompt, now),
    );
    this.db.updateScheduledTaskError(task.id, null);
  }

  private async fireWorkflowTask(task: ScheduledTaskRecord, now: number): Promise<void> {
    if (!this.sessionManager) {
      const message = 'workflow task requires SessionManager';
      this.db.updateScheduledTaskExecution(task.id, null, message);
      throw new Error(message);
    }
    if (!task.workflow_id) {
      const message = 'workflow task requires workflow_id';
      this.db.updateScheduledTaskExecution(task.id, null, message);
      throw new Error(message);
    }

    const schedule = this.buildScheduleContext(task, now);
    const workflowInput = {
      ...(task.workflow_input ?? {}),
      __schedule: schedule,
    };
    try {
      const workflowEngine = this.resolveWorkflowEngineForTask(task);
      const executionId = await workflowEngine.execute(
        task.workflow_id,
        workflowInput,
        {
          sessionId: task.session_id,
          variables: {
            schedule,
            scheduleTaskId: task.id,
            scheduleIntensity: task.intensity,
            scheduleAudience: task.audience,
          },
        },
      );
      this.db.updateScheduledTaskExecution(task.id, executionId, null);
      this.emitter.emit('scheduled_task:workflow_started' as import('./EventEmitter.js').EventName, {
        taskId: task.id,
        workflowId: task.workflow_id,
        executionId,
        sessionId: task.session_id,
        intensity: task.intensity,
        audience: task.audience,
      } as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateScheduledTaskExecution(task.id, null, message);
      throw error;
    }
  }

  /** 处理系统内置任务 */
  private async fireSystemTask(
    task: Pick<ScheduledTaskRecord, 'id' | 'session_id' | 'prompt'>,
    systemType: SystemTaskType,
    _now: number,
  ): Promise<void> {
    const leaderBusName = `${task.session_id}:leader`;
    const scheduledBusName = `${task.session_id}:scheduled_task`;

    switch (systemType) {
      case '[SYSTEM:patrol]': {
        // 巡逻任务：注入 Leader 执行全面检查
        const recoverySnapshot = buildRecoverySnapshot(
          task.session_id,
          listRecoveryRecords(this.db, task.session_id),
        );
        const recoveryContext = recoverySnapshot.total > 0
          ? [
              '',
              '[runtime_recovery_snapshot]',
              JSON.stringify(recoverySnapshot),
            ]
          : [
              '',
              '[runtime_recovery_snapshot]',
              '{"total":0,"note":"no active runtime recovery records"}',
            ];
        const patrolPrompt = [
          '[定时巡逻] 请执行以下自治检查：',
          '0. 先读取当前任务板、Agent 健康快照和 runtime recovery records；若存在 recovering 任务，优先接管恢复链路',
          '1. 检查是否有正在运行但长时间无进度的任务，考虑是否需要干预',
          '2. 检查是否有待审方案需要自动批准',
          '3. 检查是否有新的工作可以发现和调度',
          '4. 检查是否有被阻塞但依赖已满足的任务需要解除',
          '5. 检查是否有失败任务可以重试',
          '6. 若所有任务已经终态，等待用户下一步或显式 finish_session，并按终态事实汇报',
          '汇报结构化检查结果并采取行动；需要等待时说明检查到的 task/agent/recovery 状态。',
          ...recoveryContext,
        ].join('\n');
        await this.bus.send(scheduledBusName, leaderBusName, 'user_intervention', patrolPrompt);
        break;
      }

      case '[SYSTEM:dead_end_check]': {
        // 死胡同检测：让 Leader 检查连续失败的任务
        const deadEndPrompt = [
          '[死胡同检测] 请检查任务板中状态为 failed 的任务：',
          '- 如果同一任务已连续失败 3 次以上，请取消它并说明原因',
          '- 如果失败任务仍有重试价值，请重新调度',
          '- 汇报处理结果',
        ].join('\n');
        await this.bus.send(scheduledBusName, leaderBusName, 'user_intervention', deadEndPrompt);
        break;
      }

      case '[SYSTEM:rebalance]': {
        // 优先级重平衡
        const rebalancePrompt = [
          '[优先级重平衡] 请检查任务板中的 pending/blocked 任务：',
          '- 年龄超过 10 分钟的 pending 任务应提升优先级',
          '- 依赖链过深的任务应降低优先级，避免长链阻塞',
          '- 汇报调整结果',
        ].join('\n');
        await this.bus.send(scheduledBusName, leaderBusName, 'user_intervention', rebalancePrompt);
        break;
      }

      case '[SYSTEM:idle_scan]': {
        // 空闲代码扫描
        const scanPrompt = [
          '[空闲扫描] 当前无活跃任务，请主动扫描代码库寻找改进机会：',
          '1. 检查是否有 TODO/FIXME/HACK 注释可以处理',
          '2. 检查是否有明显的代码质量问题（重复代码、过长函数等）',
          '3. 检查是否有缺失的测试覆盖',
          '4. 如果发现改进机会，创建任务并开始执行',
          '如果没有发现改进机会，简要汇报即可。',
        ].join('\n');
        await this.bus.send(scheduledBusName, leaderBusName, 'user_intervention', scanPrompt);
        break;
      }
    }

    coreLogger.info(`[ScheduledTaskManager] 系统任务 ${systemType} 已注入 session ${task.session_id}`);
  }
}

export default ScheduledTaskManager;
