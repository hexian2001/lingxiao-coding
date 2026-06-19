/**
 * AgentHealthMonitor — Leader 级 Agent 健康巡检系统
 *
 * 设计原则：
 * 1. Leader 定时轮询（默认 2 分钟）主动巡检所有 Agent
 * 2. Agent 关键事件（异常退出）即时触发评估
 * 3. 通过 evaluating 锁防止轮询和事件触发撞车
 * 4. 分级干预：healthy → stalling → stuck → runaway
 */

import type { EventEmitter } from './EventEmitter.js';
import type { DatabaseManager } from './Database.js';

// ─── 类型定义 ────────────────────────────────────────

export type HealthStatus = 'healthy' | 'stalling' | 'stuck' | 'runaway';

export type InterventionAction =
  | 'none'           // 正常，无需干预
  | 'nudge'          // 注入策略改变提示（轻度）
  | 'warn'           // 发出警告，给用户可见反馈
  | 'redirect'       // 发送新指令，重定向 Agent 行为
  | 'kill_restart';  // 终止并用修改后的 prompt 重启

export interface HealthDecision {
  agentId: string;
  name: string;
  status: HealthStatus;
  reason: string;
  action: InterventionAction;
  /** 停滞时长（秒），用于 stalling/stuck 状态 */
  stallSeconds?: number;
}

export interface HealthReport {
  timestamp: number;
  source: 'poll' | 'event';
  decisions: HealthDecision[];
  /** 是否有需要立即干预的 Agent */
  hasCritical: boolean;
}

export interface AgentHealthRecord {
  agentId: string;
  name: string;
  roleType?: string;
  startedAtMs: number;
  /** Last meaningful task progress. Heartbeats must not refresh this. */
  lastActivityAtMs: number;
  /** Last worker heartbeat / process liveness signal. */
  lastHeartbeatAtMs: number;
  lastToolCallAtMs: number;
  iterationCount: number;
  toolCallCount: number;
  /** 最近一次 nudge 的时间 */
  lastNudgeAtMs: number;
  /** 累计 nudge 次数 */
  nudgeCount: number;
  /** 最近一次 warn/redirect 升级干预的时间。用于给升级动作加冷却，避免刷屏。 */
  lastEscalationAtMs: number;
  /** Agent 是否已被标记为终止 */
  terminated: boolean;
}

export interface AgentHealthMonitorConfig {
  /** 轮询间隔（ms），默认 120_000（2 分钟） */
  pollIntervalMs: number;
  /** 从最后活动到判定 stalling 的阈值（ms），默认 300_000（5 分钟） */
  stallThresholdMs: number;
  /** 从最后活动到判定 stuck 的阈值（ms），默认 600_000（10 分钟） */
  stuckThresholdMs: number;
  /** 从最后活动到判定 runaway 的阈值（ms），默认 1_800_000（30 分钟）*/
  runawayThresholdMs: number;
  /**
   * runaway 判定时「进程是否仍存活」的心跳失活阈值（ms），默认 90_000（3× worker 30s 心跳）。
   *
   * 确定性二分门：lastActivity 老化到 runaway 级别时，用 lastHeartbeatAtMs 判定进程死活——
   *   - 心跳仍新（now - lastHeartbeatAtMs <= liveness）：进程活着、IPC 通，只是业务零进展。
   *     这是「外部阻塞」（LLM 网关超时 / 慢调用 / 权限等待），杀进程无用且有害（杀了重启，
   *     网关还挂着，新 worker 又卡同一循环）。降级为 warn，待外部恢复自愈。
   *   - 心跳也老化（> liveness）：进程真死 / IPC 断 / JS 死循环连 setInterval 都卡 → 真·死锁，
   *     走 kill_restart（与 WorkerProcessRunner 心跳超时同口径的进程级兜底）。
   *
   * 不与现有「progress not heartbeat」语义冲突：lastHeartbeatAtMs 仍不刷新 lastActivityAtMs
   * （stall/stuck 检测照常工作），它只在 runaway 级别作为独立的「进程死活」二分维度。
   */
  heartbeatLivenessMs: number;
  /** 两次 nudge 之间最少间隔（ms），默认 180_000（3 分钟）避免频繁打扰 */
  nudgeCooldownMs: number;
  /** 最大 nudge 次数，超过后升级为 warn/redirect，默认 3 */
  maxNudgeBeforeEscalation: number;
  /** 事件触发评估的去抖时间（ms），默认 5_000（5 秒） */
  eventDebounceMs: number;
}

export const DEFAULT_HEALTH_MONITOR_CONFIG: AgentHealthMonitorConfig = {
  pollIntervalMs: 60_000,
  stallThresholdMs: 180_000,
  stuckThresholdMs: 420_000,
  runawayThresholdMs: 1_800_000,
  heartbeatLivenessMs: 90_000,    // 3× worker 30s 心跳
  nudgeCooldownMs: 120_000,
  maxNudgeBeforeEscalation: 2,
  eventDebounceMs: 5_000,        // 5s
};

// ─── 核心健康评估（纯函数，可单测） ────────────────────

export function assessAgentHealth(
  record: AgentHealthRecord,
  nowMs: number,
  config: AgentHealthMonitorConfig,
): HealthDecision {
  const inactiveMs = nowMs - record.lastActivityAtMs;
  const inactiveSeconds = Math.round(inactiveMs / 1000);

  // 1. 检查 runaway（长时间无进展）
  if (inactiveMs >= config.runawayThresholdMs) {
    // 确定性二分门：用 lastHeartbeatAtMs 区分「进程还活着但被外部阻塞」与「真死锁」。
    // 心跳是 worker 30s IPC ping（真实信号源，非启发式）：心跳新 = 进程活着、IPC 通。
    const heartbeatStaleMs = nowMs - record.lastHeartbeatAtMs;
    const heartbeatAlive = heartbeatStaleMs <= config.heartbeatLivenessMs;
    if (heartbeatAlive) {
      // 进程存活但业务长期零进展 = 外部阻塞（LLM 网关超时 / 慢调用 / 权限等待）。
      // 杀进程在这里反效果：杀了重启，阻塞源（网关）还在，新 worker 又卡同一循环 →
      // 产生大量「worker shutdown: database closed」误报且任务无进展。降级为 warn：
      // 给 Leader 信号（可降级模型 / 告警用户 / 重派到健康 worker），但不 SIGTERM。
      // 待外部恢复后 lastActivity 自然刷新，状态自愈。warn 受 escalation 冷却节流防刷屏。
      const escalationReady = nowMs - record.lastEscalationAtMs >= config.nudgeCooldownMs;
      const heartbeatStaleSeconds = Math.round(heartbeatStaleMs / 1000);
      return {
        agentId: record.agentId,
        name: record.name,
        status: 'runaway',
        reason: `${inactiveSeconds}s 无进展，进程存活（心跳 ${heartbeatStaleSeconds}s 前仍新），判定外部阻塞，降级告警不终止`,
        action: escalationReady ? 'warn' : 'none',
        stallSeconds: inactiveSeconds,
      };
    }
    // 心跳也老化：进程真死 / IPC 断 / JS 死循环连 setInterval 都卡 → 真·死锁，终止重派。
    const heartbeatStaleSeconds = Math.round(heartbeatStaleMs / 1000);
    return {
      agentId: record.agentId,
      name: record.name,
      status: 'runaway',
      reason: `${inactiveSeconds}s 无任何活动且心跳失活 ${heartbeatStaleSeconds}s，判定进程死亡/死锁`,
      action: 'kill_restart',
      stallSeconds: inactiveSeconds,
    };
  }

  // 2. 检查 stuck（较长时间无进展）
  if (inactiveMs >= config.stuckThresholdMs) {
    // 升级干预（warn/redirect）也要节流：否则每次 poll(60s)+每次事件去抖(5s) 评估都会
    // 对同一卡住 agent 重新产出 redirect/warn，刷屏"正在重定向"。冷却内降级为 none。
    const escalationReady = nowMs - record.lastEscalationAtMs >= config.nudgeCooldownMs;
    const escalationAction: InterventionAction =
      record.nudgeCount >= config.maxNudgeBeforeEscalation ? 'redirect' : 'warn';
    return {
      agentId: record.agentId,
      name: record.name,
      status: 'stuck',
      reason: `${inactiveSeconds}s 无进展`,
      action: escalationReady ? escalationAction : 'none',
      stallSeconds: inactiveSeconds,
    };
  }

  // 3. 检查 stalling（短时间无进展）
  if (inactiveMs >= config.stallThresholdMs) {
    const canNudge =
      nowMs - record.lastNudgeAtMs >= config.nudgeCooldownMs &&
      record.nudgeCount < config.maxNudgeBeforeEscalation;
    return {
      agentId: record.agentId,
      name: record.name,
      status: 'stalling',
      reason: `${inactiveSeconds}s 无新活动`,
      action: canNudge ? 'nudge' : 'none',
      stallSeconds: inactiveSeconds,
    };
  }

  // 4. 健康
  return {
    agentId: record.agentId,
    name: record.name,
    status: 'healthy',
    reason: 'ok',
    action: 'none',
  };
}

// ─── Monitor 类 ──────────────────────────────────────

export type HealthReportCallback = (report: HealthReport) => void | Promise<void>;

export class AgentHealthMonitor {
  private config: AgentHealthMonitorConfig;
  private emitter: EventEmitter;
  private records: Map<string, AgentHealthRecord> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private eventDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private evaluating = false;
  private onReport: HealthReportCallback;
  private unsubscribers: Array<() => void> = [];
  private db?: DatabaseManager;
  private sessionId?: string;
  /**
   * 已 terminated agent 的延迟 delete 定时器，按 agentId 跟踪。
   *
   * P1 修复：旧实现 setTimeout(records.delete, 5min) 不可取消；
   * 同一 agentId 复用（idle agent 续跑）时，旧 timer 仍会触发并把新记录删掉，
   * 导致 stuck/runaway 检测失效。这里 re-register 时主动 clearTimeout(prev)。
   */
  private terminatedTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    emitter: EventEmitter,
    onReport: HealthReportCallback,
    config?: Partial<AgentHealthMonitorConfig>,
    db?: DatabaseManager,
    sessionId?: string,
  ) {
    this.emitter = emitter;
    this.onReport = onReport;
    this.config = { ...DEFAULT_HEALTH_MONITOR_CONFIG, ...config };
    this.db = db;
    this.sessionId = sessionId;
  }

  // ─── 生命周期 ──────────────────────────────────────

  start(): void {
    // P1 修复：start() 必须幂等；重复调用会重复订阅 12 个 listener、覆盖 pollTimer 引用
    // 导致旧 interval 永跑且无法清理。
    if (this.pollTimer) return;
    this.subscribeEvents();
    this.pollTimer = setInterval(() => {
      this.triggerEvaluation('poll');
    }, this.config.pollIntervalMs);
    // unref:不阻塞事件循环自然退出(Leader 停止时 stop() 会 clearInterval,#40)
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
      this.eventDebounceTimer = null;
    }
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.records.clear();
    // 清掉所有未到期的 terminated delete timer，避免 stop() 后还误删后接的 records
    for (const timer of this.terminatedTimers.values()) {
      clearTimeout(timer);
    }
    this.terminatedTimers.clear();
  }

  // ─── Agent 注册/注销 ──────────────────────────────

  registerAgent(agentId: string, name: string, roleType?: string): void {
    const now = Date.now();
    // 同 agentId re-register（continuation/respawn）必须取消上一次的延迟 delete timer，
    // 否则 5 分钟后旧 timer 触发会把 fresh record 删掉，监控失效。
    const pendingDelete = this.terminatedTimers.get(agentId);
    if (pendingDelete) {
      clearTimeout(pendingDelete);
      this.terminatedTimers.delete(agentId);
    }
    this.records.set(agentId, {
      agentId,
      name,
      roleType,
      startedAtMs: now,
      lastActivityAtMs: now,
      lastHeartbeatAtMs: now,
      lastToolCallAtMs: now,
      iterationCount: 0,
      toolCallCount: 0,
      lastNudgeAtMs: 0,
      nudgeCount: 0,
      lastEscalationAtMs: 0,
      terminated: false,
    });
  }

  unregisterAgent(agentId: string): void {
    this.records.delete(agentId);
    const pendingDelete = this.terminatedTimers.get(agentId);
    if (pendingDelete) {
      clearTimeout(pendingDelete);
      this.terminatedTimers.delete(agentId);
    }
  }

  // ─── 记录 nudge 已发送 ─────────────────────────────

  recordNudge(agentId: string): void {
    const record = this.records.get(agentId);
    if (record) {
      record.lastNudgeAtMs = Date.now();
      record.nudgeCount++;
    }
  }

  /**
   * 记录一次 warn/redirect 升级干预已发出。
   * assessAgentHealth 用 lastEscalationAtMs + nudgeCooldownMs 节流，
   * 避免对同一卡住 agent 每个评估周期都刷"正在重定向"。
   */
  recordEscalation(agentId: string): void {
    const record = this.records.get(agentId);
    if (record) {
      record.lastEscalationAtMs = Date.now();
    }
  }

  // ─── 事件订阅 ──────────────────────────────────────

  private subscribeEvents(): void {
    // 正常活动事件 → 更新 lastActivityAtMs
    const onActivity = (data: Record<string, unknown>) => {
      const agentId = String(data.agentId || '');
      const record = this.records.get(agentId);
      if (record && !record.terminated) {
        record.lastActivityAtMs = Date.now();
        this.scheduleEventEvaluation();
      }
    };

    // 工具调用 → 更新计数
    const onToolCall = (data: Record<string, unknown>) => {
      const agentId = String(data.agentId || '');
      const record = this.records.get(agentId);
      if (record && !record.terminated) {
        record.lastActivityAtMs = Date.now();
        record.lastToolCallAtMs = Date.now();
        record.toolCallCount++;
        this.scheduleEventEvaluation();
      }
    };

    // LLM 思考轮次 → 更新迭代数
    const onIteration = (data: Record<string, unknown>) => {
      const agentId = String(data.agentId || '');
      const record = this.records.get(agentId);
      if (record && !record.terminated) {
        record.lastActivityAtMs = Date.now();
        record.iterationCount++;
        this.scheduleEventEvaluation();
      }
    };

    // Agent 完成/失败 → 注销并延迟清理记录
    const onTerminated = (data: Record<string, unknown>) => {
      const agentId = String(data.agentId || '');
      const record = this.records.get(agentId);
      if (record) {
        record.terminated = true;
      }
      // 延迟清理：保留记录5分钟供诊断查询，然后移除防止内存泄漏。
      // P1 修复：把 timer 存进 Map 以便 re-register 时取消，避免误删活记录。
      const prev = this.terminatedTimers.get(agentId);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        this.terminatedTimers.delete(agentId);
        // 二次校验：仅当 record 仍处于 terminated 才删除，避免和 re-register 撞车
        const curr = this.records.get(agentId);
        if (curr && curr.terminated) {
          this.records.delete(agentId);
        }
      }, 5 * 60 * 1000);
      if (timer.unref) timer.unref();
      this.terminatedTimers.set(agentId, timer);
    };

    this.emitter.on('agent:text_chunk', onActivity);
    this.emitter.on('agent:tool_call', onToolCall);
    this.emitter.on('agent:tool_result', onActivity);
    this.emitter.on('agent:progress', onActivity);
    this.emitter.on('agent:thinking', onIteration);
    const onHeartbeat = (data: Record<string, unknown>) => {
      const agentId = String(data.agentId || '');
      const record = this.records.get(agentId);
      if (record && !record.terminated) {
        record.lastHeartbeatAtMs = Date.now();
      }
    };

    this.emitter.on('agent:heartbeat', onHeartbeat);       // worker 30s 心跳，只证明进程存活，不算业务进展
    // agent:status / agent:llm_retry 是"存活但无进展"信号（重试中、等待权限、provider 暂不可用），
    // 不能算业务进展 —— 否则 worker 卡在 LLM 超时重试循环里每次重试都刷新 lastActivity，
    // stall/stuck 永远触发不了、健康监控对"反复重试但零产出"彻底失明（本次 bug 现象）。
    // 与 heartbeat 同等对待：仅更新 lastHeartbeat 证明存活，不动 lastActivity。
    this.emitter.on('agent:status', onHeartbeat);
    this.emitter.on('agent:llm_retry', onHeartbeat);
    this.emitter.on('agent:tool_output', onActivity);      // shell 输出流
    this.emitter.on('agent:shell_state', onActivity);      // shell 状态变更
    this.emitter.on('token:usage', onActivity);             // LLM 调用完成（防止长 LLM 调用误报）
    this.emitter.on('agent:completed', onTerminated);
    this.emitter.on('agent:failed', onTerminated);

    // 保存取消订阅函数
    this.unsubscribers.push(
      () => this.emitter.off('agent:text_chunk', onActivity),
      () => this.emitter.off('agent:tool_call', onToolCall),
      () => this.emitter.off('agent:tool_result', onActivity),
      () => this.emitter.off('agent:progress', onActivity),
      () => this.emitter.off('agent:thinking', onIteration),
      () => this.emitter.off('agent:heartbeat', onHeartbeat),
      () => this.emitter.off('agent:status', onHeartbeat),
      () => this.emitter.off('agent:llm_retry', onHeartbeat),
      () => this.emitter.off('agent:tool_output', onActivity),
      () => this.emitter.off('agent:shell_state', onActivity),
      () => this.emitter.off('token:usage', onActivity),
      () => this.emitter.off('agent:completed', onTerminated),
      () => this.emitter.off('agent:failed', onTerminated),
    );
  }

  // ─── 评估调度（防撞车） ────────────────────────────

  /**
   * 事件触发的评估：去抖 + 防撞车
   * 多个事件在短时间内到达只触发一次评估
   */
  private scheduleEventEvaluation(): void {
    if (this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
    }
    this.eventDebounceTimer = setTimeout(() => {
      this.eventDebounceTimer = null;
      this.triggerEvaluation('event');
    }, this.config.eventDebounceMs);
  }

  /**
   * 执行评估（轮询 or 事件触发均走这里）
   * evaluating 锁保证同一时间只有一个评估在跑
   *
   * P2 修复：onReport 走 LeaderAgent 介入路径，可能 await LLM/审批；万一 hang
   * （网络挂死、上层 bug）则 finally 永不执行，evaluating=true 永久卡住，
   * 后续所有 poll/event 触发的评估都被前置 if 短路 → 健康监控彻底失效。
   * 这里给 onReport 加 30s race，超时也释放锁。
   */
  private async triggerEvaluation(source: 'poll' | 'event'): Promise<void> {
    if (this.evaluating) {
      return; // 跳过，不排队——下一个轮询周期或下一个事件会再触发
    }

    this.evaluating = true;
    try {
      const report = this.evaluate(source);
      if (report.decisions.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reportPromise = Promise.resolve(this.onReport(report));
        const timeoutPromise = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 30_000);
          if (timer && timer.unref) timer.unref();
        });
        try {
          await Promise.race([reportPromise, timeoutPromise]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        this.persistReport(report);
      }
    } finally {
      this.evaluating = false;
    }
  }

  private persistReport(report: HealthReport): void {
    if (!this.db || !this.sessionId) return;
    const hasNonHealthy = report.decisions.some(d => d.status !== 'healthy');
    if (!hasNonHealthy) return;
    try {
      const sqlite = this.db.getDb();
      sqlite.prepare(
        `INSERT INTO health_reports (session_id, timestamp, source, has_critical, decisions) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        this.sessionId,
        report.timestamp,
        report.source,
        report.hasCritical ? 1 : 0,
        JSON.stringify(report.decisions),
      );
      sqlite.prepare(
        `DELETE FROM health_reports WHERE session_id = ? AND id NOT IN (SELECT id FROM health_reports WHERE session_id = ? ORDER BY timestamp DESC LIMIT 500)`,
      ).run(this.sessionId, this.sessionId);
    } catch {
      // Best-effort persistence
    }
  }

  // ─── 核心评估 ──────────────────────────────────────

  private evaluate(source: 'poll' | 'event'): HealthReport {
    const now = Date.now();
    const decisions: HealthDecision[] = [];

    for (const record of this.records.values()) {
      if (record.terminated) continue;

      const decision = assessAgentHealth(record, now, this.config);
      // 只收集需要关注的（非 healthy）或轮询时全部收集
      if (source === 'poll' || decision.status !== 'healthy') {
        decisions.push(decision);
      }
    }

    return {
      timestamp: now,
      source,
      decisions,
      hasCritical: decisions.some(
        (d) => d.status === 'stuck' || d.status === 'runaway',
      ),
    };
  }

  // ─── 诊断快照 ──────────────────────────────────────

  getSnapshot(): AgentHealthRecord[] {
    return Array.from(this.records.values()).filter((r) => !r.terminated);
  }

  getRecord(agentId: string): AgentHealthRecord | undefined {
    return this.records.get(agentId);
  }
}
