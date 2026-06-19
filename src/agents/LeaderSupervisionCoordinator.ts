/**
 * LeaderSupervisionCoordinator
 * Manages agent supervision, health monitoring, activity subscriptions, and context reset.
 * Extracted from LeaderAgent lines ~940–1292.
 */

import type { EventEmitter } from '../core/EventEmitter.js';
import type { AgentPool } from './AgentPoolRuntime.js';
import type { AgentHandle } from './AgentPoolRuntime.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { ChatMessage } from '../llm/types.js';
import type { WorkNoteManager } from '../core/WorkNoteManager.js';
import type { TeamSynchronizer } from './TeamSynchronizer.js';
import type { AgentHealthMonitor, HealthReport } from '../core/AgentHealthMonitor.js';
import type { ContextManager } from '../core/ContextManager.js';
import type { DatabaseManager } from '../core/Database.js';
import {
  evaluateLeaderSupervision,
  recordLeaderSupervisionProgress,
  type LeaderSupervisionAgentSnapshot,
  type LeaderSupervisionConfig,
  type LeaderSupervisionEvaluation,
  type LeaderSupervisionState,
} from './LeaderSupervisionPolicy.js';
import { leaderLogger } from '../core/Log.js';
import { TRUNCATION } from '../config/defaults.js';
import type { CompletionSignal } from './leader/p0Message.js';

export interface LeaderSupervisionCoordinatorOptions {
  sessionId: string;
  pool: AgentPool;
  emitter: EventEmitter;
  bus: MessageBus;
  healthMonitor: AgentHealthMonitor;
  workNoteManager: WorkNoteManager;
  teamSynchronizer: TeamSynchronizer | null;
  supervisionConfig: LeaderSupervisionConfig;
  // mutable state via callbacks
  getSupervisionState: () => LeaderSupervisionState;
  setSupervisionState: (s: LeaderSupervisionState) => void;
  getConversation: () => ChatMessage[];
  setConversation: (msgs: ChatMessage[]) => void;
  getContextManager: () => ContextManager;
  getDb: () => DatabaseManager;
  getPendingAgentCompletionSignals: () => CompletionSignal[];
  addPendingAgentCompletionSignal: (signal: CompletionSignal) => void;
  interruptCurrentRound?: (reason: 'user_input' | 'agent_completion') => void;
  onProgressUpdate: (progressAtMs: number) => void;
  saveConversationMessage: (msg: ChatMessage) => void;
}

export class LeaderSupervisionCoordinator {
  private sessionId: string;
  private pool: AgentPool;
  private emitter: EventEmitter;
  private bus: MessageBus;
  private healthMonitor: AgentHealthMonitor;
  private workNoteManager: WorkNoteManager;
  private teamSynchronizer: TeamSynchronizer | null;
  private supervisionConfig: LeaderSupervisionConfig;
  private getSupervisionState: () => LeaderSupervisionState;
  private setSupervisionState: (s: LeaderSupervisionState) => void;
  private getConversation: () => ChatMessage[];
  private setConversation: (msgs: ChatMessage[]) => void;
  private getContextManager: () => ContextManager;
  private getDb: () => DatabaseManager;
  private addPendingAgentCompletionSignal: (signal: CompletionSignal) => void;
  private interruptCurrentRound?: (reason: 'user_input' | 'agent_completion') => void;
  private onProgressUpdate: (progressAtMs: number) => void;
  private saveConversationMessage: (msg: ChatMessage) => void;

  /** Unsubscribe functions for all subscribed events */
  private _activityEventUnsubscribers: Array<() => void> = [];

  constructor(opts: LeaderSupervisionCoordinatorOptions) {
    this.sessionId = opts.sessionId;
    this.pool = opts.pool;
    this.emitter = opts.emitter;
    this.bus = opts.bus;
    this.healthMonitor = opts.healthMonitor;
    this.workNoteManager = opts.workNoteManager;
    this.teamSynchronizer = opts.teamSynchronizer;
    this.supervisionConfig = opts.supervisionConfig;
    this.getSupervisionState = opts.getSupervisionState;
    this.setSupervisionState = opts.setSupervisionState;
    this.getConversation = opts.getConversation;
    this.setConversation = opts.setConversation;
    this.getContextManager = opts.getContextManager;
    this.getDb = opts.getDb;
    this.addPendingAgentCompletionSignal = opts.addPendingAgentCompletionSignal;
    this.interruptCurrentRound = opts.interruptCurrentRound;
    this.onProgressUpdate = opts.onProgressUpdate;
    this.saveConversationMessage = opts.saveConversationMessage;
  }

  toLeaderSupervisionAgents(handles: AgentHandle[]): LeaderSupervisionAgentSnapshot[] {
    return handles.map((handle) => ({
      agentId: handle.agentId,
      name: handle.name,
      roleType: handle.roleType,
      lastActivityAtMs: handle.lastProgress ?? handle.startTime,
      lastHeartbeatAtMs: handle.lastHeartbeat,
    }));
  }

  getLeaderSupervisionEvaluation(running: AgentHandle[]): LeaderSupervisionEvaluation {
    const evaluation = evaluateLeaderSupervision({
      agents: this.toLeaderSupervisionAgents(running),
      nowMs: Date.now(),
      config: this.supervisionConfig,
      state: this.getSupervisionState(),
    });
    this.setSupervisionState(evaluation.state);
    return evaluation;
  }

  getLeaderSupervisionWaitTimeoutMs(running: AgentHandle[]): number {
    const evaluation = evaluateLeaderSupervision({
      agents: this.toLeaderSupervisionAgents(running),
      nowMs: Date.now(),
      config: this.supervisionConfig,
      state: this.getSupervisionState(),
      consumeIdleWarnings: false,
    });
    this.setSupervisionState(evaluation.state);
    return evaluation.decision.waitTimeoutMs;
  }

  /**
   * 订阅 Agent 活动事件，用于事件驱动的进度跟踪
   * 当 Agent 发出 text_chunk, tool_call, tool_result 等事件时，
   * 自动更新监督状态，避免主动 probe
   */
  subscribeAgentActivityEvents(): void {
    const progressEvents = ['agent:text_chunk', 'agent:tool_call', 'agent:tool_result', 'agent:progress'] as const;
    for (const eventName of progressEvents) {
      const unsub = this.emitter.subscribe(eventName, () => {
        this.markLeaderSupervisionProgress();
      });
      this._activityEventUnsubscribers.push(unsub);
    }

    const completedUnsub = this.emitter.subscribe('agent:completed', async (data) => {
      this.markLeaderSupervisionProgress();
      // 写笔记 + 团队同步（UI/监控职责）
      await this._autoWriteCompletionNote(data);
      await this._checkAndSynthesizeTeamWork(data);
      // 控制流由 Bus P0 消息 (task_complete) 驱动，此处不再重复 interruptCurrentRound
      const agentName = String((data as Record<string, unknown>).agentName || 'unknown');
      leaderLogger.info(`Agent @${agentName} completed — work note written`);
    });
    this._activityEventUnsubscribers.push(completedUnsub);

    const failedUnsub = this.emitter.subscribe('agent:failed', (data) => {
      this.markLeaderSupervisionProgress();
      // 写笔记（UI/监控职责）
      this._autoWriteFailureNote(data);
      // 控制流由 Bus P0 消息 (task_failed) 驱动，此处不再重复 interruptCurrentRound
      const agentName = String((data as Record<string, unknown>).agentName || 'unknown');
      leaderLogger.info(`Agent @${agentName} failed — work note written`);
    });
    this._activityEventUnsubscribers.push(failedUnsub);
  }

  /**
   * 取消订阅所有 Agent 活动事件
   */
  /** 添加一个外部 unsubscriber 到统一的清理列表（供 LeaderAgent 注册 bus 订阅） */
  addActivityEventUnsubscriber(unsub: () => void): void {
    this._activityEventUnsubscribers.push(unsub);
  }

  unsubscribeAgentActivityEvents(): void {
    for (const unsub of this._activityEventUnsubscribers) {
      unsub();
    }
    this._activityEventUnsubscribers = [];
  }

  /**
   * 监听上下文溢出事件，执行硬重置以防止 24/7 场景下上下文失控
   */
  subscribeContextOverflow(): void {
    const unsub = this.emitter.subscribe('context:overflow', (data) => {
      if (data.sessionId !== this.sessionId) return;
      if (data.owner !== 'leader') return;
      leaderLogger.warn(
        `上下文溢出 (${data.tokens} > ${data.threshold})，执行硬重置`
      );
      this.performContextReset();
    });
    this._activityEventUnsubscribers.push(unsub);
  }

  /**
   * 执行上下文硬重置：保留 system prompt、首条 user 消息和最近 20 条消息。
   */
  performContextReset(): void {
    try {
      const conversation = this.getConversation();
      const systemMsg = conversation[0];
      const firstUserIdx = conversation.findIndex(m => m.role === 'user');
      const firstUserMsg = firstUserIdx >= 0 ? conversation[firstUserIdx] : null;
      const contextManager = this.getContextManager();
      const newConversation = contextManager.hardReset({
        messages: conversation,
        preservedMessages: [systemMsg, firstUserMsg].filter(Boolean) as ChatMessage[],
        recentCount: 20,
        reason: 'leader_context_overflow',
      });
      this.setConversation(newConversation);

      leaderLogger.info(`上下文压缩完成，保留 ${newConversation.length} 条消息（原 ${conversation.length} 条）`);
    } catch (error) {
      leaderLogger.error(`上下文压缩失败:`, error);
    }
  }

  /**
   * 自动写入 Agent 完成笔记
   */
  async _autoWriteCompletionNote(data: Record<string, unknown>): Promise<void> {
    const agentId = String(data.agentId || '');
    const taskId = String(data.taskId || '');
    if (!agentId || !taskId) return;

    try {
      const note = await this.workNoteManager.writeNoteWithSession(this.sessionId, {
        agentId,
        taskId,
        phase: 'other',
        summary: `Agent ${agentId} 完成了任务 ${taskId}`,
        details: typeof data.result === 'string' ? data.result.substring(0, TRUNCATION.TOOL_RESULT_PREVIEW) : undefined,
      });
      this.emitter.emit('work_note:written', {
        sessionId: this.sessionId,
        agentId,
        note,
      });
    } catch (error) {
      // 笔记写入不应阻塞主流程
      leaderLogger.debug(`自动失败笔记写入失败:`, error);
    }
  }

  /**
   * 自动写入 Agent 失败笔记
   */
  async _autoWriteFailureNote(data: Record<string, unknown>): Promise<void> {
    const agentId = String(data.agentId || '');
    const taskId = String(data.taskId || '');
    if (!agentId || !taskId) return;

    try {
      const note = await this.workNoteManager.writeNoteWithSession(this.sessionId, {
        agentId,
        taskId,
        phase: 'other',
        summary: `Agent ${agentId} 任务失败: ${taskId}`,
        details: typeof data.error === 'string' ? data.error.substring(0, TRUNCATION.TOOL_ERROR_PREVIEW) : undefined,
        blockers: [typeof data.error === 'string' ? data.error : 'Unknown error'],
      });
      this.emitter.emit('work_note:written', {
        sessionId: this.sessionId,
        agentId,
        note,
      });
    } catch (error) {
      // 笔记写入不应阻塞主流程
      leaderLogger.debug(`自动完成笔记写入失败:`, error);
    }
  }

  /**
   * 团队同步：当同一任务的多个 Agent 完成时，整合工作笔记并检测冲突
   */
  async _checkAndSynthesizeTeamWork(data: Record<string, unknown>): Promise<void> {
    const taskId = String(data.taskId || '');
    if (!taskId || !this.teamSynchronizer) return;

    try {
      // 收集该任务的所有工作笔记
      const notes = await this.teamSynchronizer.collectWorkNotes(taskId);

      // 如果有多个 Agent 的笔记，进行团队同步
      const uniqueAgents = new Set(notes.map((n) => n.agentId));
      if (uniqueAgents.size > 1) {
        // 生成团队摘要
        const teamSummary = this.teamSynchronizer.generateTeamSummary(taskId, notes);

        if (teamSummary.conflicts.length > 0) {
          // 先尝试成员间协商收敛（peer_negotiate 类）：直接 P2P 派发协商指令，
          // normal urgency 不打断，由对方下一轮 team_inbox 消费。
          const peerCount = await this.dispatchPeerNegotiations(teamSummary.conflicts);

          // 仍需 Leader 仲裁的冲突（leader_arbitrate 或协商派发失败）→ 通知
          const arbitrateCount = teamSummary.conflicts.filter(
            c => c.resolution !== 'peer_negotiate',
          ).length;

          if (arbitrateCount > 0) {
            this.emitter.emit('notification:new', {
              sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
              id: `team_conflict_${taskId}_${Date.now()}`,
              type: 'agent_warning',
              priority: 'important',
              title: `任务 ${taskId} 检测到团队冲突`,
              message: `检测到 ${teamSummary.conflicts.length} 个冲突（${peerCount} 个已转成员协商，${arbitrateCount} 个需 Leader 仲裁）`,
              timestamp: Date.now(),
              read: false,
              taskId,
            });
          } else if (peerCount > 0) {
            leaderLogger.info(`[TeamSync] 任务 ${taskId} 的 ${teamSummary.conflicts.length} 个冲突已全部转为成员间协商，无需 Leader 介入`);
          }
        }
      }
    } catch (error) {
      // 团队同步不应阻塞主流程
      leaderLogger.debug(`团队同步失败:`, error);
    }
  }

  /**
   * 把 peer_negotiate 类冲突派发为成员间 P2P 协商指令。
   * 返回成功派发的协商消息条数。失败容忍——不阻塞同步主流程。
   */
  protected async dispatchPeerNegotiations(
    conflicts: Parameters<NonNullable<typeof this.teamSynchronizer>['buildPeerNegotiations']>[0],
  ): Promise<number> {
    if (!this.teamSynchronizer) return 0;
    const negotiations = this.teamSynchronizer.buildPeerNegotiations(conflicts);
    if (negotiations.length === 0) return 0;

    let sent = 0;
    try {
      const { getTeamMailbox, getTeamMemberRegistry } = await import('../core/TeamMailbox.js');
      const { getTeamRequestTracker } = await import('../core/TeamRequestTracker.js');
      const registry = getTeamMemberRegistry();
      const mailbox = getTeamMailbox();
      const tracker = getTeamRequestTracker(this.sessionId);

      for (const n of negotiations) {
        const fromMember = registry.getByName(n.from, this.sessionId);
        const toMember = registry.getByName(n.to, this.sessionId);
        // 双方必须同 team 在册，否则跳过（协商无意义）
        if (!fromMember || !toMember || fromMember.team !== toMember.team) continue;

        mailbox.sendMessage({
          fromTeam: fromMember.team,
          toTeam: toMember.team,
          fromMember: n.from,
          toMember: n.to,
          content: n.content,
          urgency: 'normal',        // 不打断：进 mailbox，由下一轮 inbox_check 消费
          kind: 'request',
          requestId: n.requestId,
          metadata: {
            intent: 'conflict_notice',
            requestId: n.requestId,
            requiresAck: true,
            summary: n.content.slice(0, 160),
            artifactPaths: n.affectedFiles,
            participants: n.participants,
            conflictId: n.conflictId,
          },
          sessionId: this.sessionId,
        });
        tracker.onRequest({
          requestId: n.requestId,
          from: n.from,
          to: n.to,
          isBroadcast: false,
          content: n.content,
        });
        sent++;
      }
    } catch (err) {
      leaderLogger.debug(`[TeamSync] dispatchPeerNegotiations 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return sent;
  }

  markLeaderSupervisionProgress(progressAtMs = Date.now()): void {
    this.setSupervisionState(recordLeaderSupervisionProgress(this.getSupervisionState(), progressAtMs));
    // 同步更新 Watchdog 进度时间戳
    this.onProgressUpdate(progressAtMs);
  }

  surfaceIdleWarnings(
    idleAgents: LeaderSupervisionAgentSnapshot[],
    nowMs = Date.now(),
  ): void {
    if (idleAgents.length === 0) {
      return;
    }

    if (idleAgents.length === 1) {
      const agent = idleAgents[0];
      const idleSeconds = Math.max(1, Math.floor((nowMs - agent.lastActivityAtMs) / 1000));
      leaderLogger.warn(`Agent ${agent.name} 已 ${idleSeconds}s 无活动，可能卡住`);
      this.emitter.emit('leader:status', {
        sessionId: this.sessionId,
        status: `⚠️ ${agent.name} 无响应 (${idleSeconds}s)`,
      });
      return;
    }

    const preview = idleAgents
      .slice(0, 3)
      .map((agent) => {
        const idleSeconds = Math.max(1, Math.floor((nowMs - agent.lastActivityAtMs) / 1000));
        return `${agent.name} ${idleSeconds}s`;
      })
      .join(', ');
    leaderLogger.warn(`${idleAgents.length} 个 Agent 长时间无活动: ${preview}`);
    this.emitter.emit('leader:status', {
      sessionId: this.sessionId,
      status: `⚠️ ${idleAgents.length} 个 Agent 无响应: ${idleAgents.slice(0, 3).map((agent) => agent.name).join(', ')}`,
    });
  }

  /**
   * 处理健康巡检报告 — AgentHealthMonitor 的回调
   * 根据每个 Agent 的健康状态决定干预动作
   */
  async handleHealthReport(report: HealthReport): Promise<void> {
    const actionableDecisions = report.decisions.filter((decision) => decision.action !== 'none');
    if (actionableDecisions.length > 0) {
      const reportLines = actionableDecisions.map((decision) => {
        const stall = typeof decision.stallSeconds === 'number' ? `, stall=${decision.stallSeconds}s` : '';
        return `- @${decision.name} (${decision.agentId}) status=${decision.status}, action=${decision.action}${stall}: ${decision.reason}`;
      });
      const reportMsg: ChatMessage = {
        role: 'system',
        content: [
          '[Agent Health Monitor]',
          `source=${report.source}, timestamp=${new Date(report.timestamp).toISOString()}`,
          ...reportLines,
          '',
          '这是低频健康巡检兜底信号。stalling/warn 保持在健康提示层处理；任务已失败或 worker 被终止时，请根据任务板继续恢复、重派或向用户说明。',
        ].join('\n'),
        timestamp: Date.now() / 1000,
      };
      this.getConversation().push(reportMsg);
      this.saveConversationMessage(reportMsg);
      this.bus.send(
        `${this.sessionId}:supervisor`,
        `${this.sessionId}:leader`,
        'supervision_probe',
        {
          kind: 'agent_health_report',
          source: report.source,
          timestamp: report.timestamp,
          decisions: actionableDecisions,
        },
      );
    }

    for (const decision of actionableDecisions) {
      switch (decision.action) {
        case 'nudge': {
          // 轻度干预：通过消息总线注入策略改变提示
          leaderLogger.warn(`[HealthMonitor] Nudge ${decision.name}: ${decision.reason}`);
          this.emitter.emit('leader:status', {
            sessionId: this.sessionId,
            status: `🩺 ${decision.name}: ${decision.reason}，已注入策略提示`,
          });
          this.bus.send(`${this.sessionId}:leader`, `${this.sessionId}:${decision.name}`, 'control', {
            action: 'nudge',
            reason: decision.reason,
            message: '请检查当前进展，换一种策略继续；下一步使用新的证据、参数或工具路径。',
          });
          this.healthMonitor.recordNudge(decision.agentId);
          break;
        }
        case 'warn': {
          // 中度警告：给用户和日志明确反馈
          leaderLogger.warn(`[HealthMonitor] WARN ${decision.name}: ${decision.reason}`);
          const handle = this.pool.getById(decision.agentId) || this.pool.getByName(decision.name);
          if (handle?.taskId) {
            this.bus.send(
              `${this.sessionId}:supervisor`,
              `${this.sessionId}:leader`,
              'agent_health_critical',
              {
                kind: 'agent_health_critical',
                taskId: handle.taskId,
                agentId: decision.agentId,
                agentName: decision.name,
                status: decision.status,
                action: decision.action,
                reason: decision.reason,
                stallSeconds: decision.stallSeconds,
              },
            );
          }
          this.emitter.emit('leader:status', {
            sessionId: this.sessionId,
            status: `⚠️ ${decision.name}: ${decision.reason} (${decision.stallSeconds ?? '?'}s)`,
          });
          this.healthMonitor.recordEscalation(decision.agentId);
          break;
        }
        case 'redirect': {
          // 重度干预：向 Agent 发送强制重定向指令
          leaderLogger.warn(`[HealthMonitor] REDIRECT ${decision.name}: ${decision.reason}`);
          const handle = this.pool.getById(decision.agentId) || this.pool.getByName(decision.name);
          if (handle?.taskId) {
            this.bus.send(
              `${this.sessionId}:supervisor`,
              `${this.sessionId}:leader`,
              'agent_health_critical',
              {
                kind: 'agent_health_critical',
                taskId: handle.taskId,
                agentId: decision.agentId,
                agentName: decision.name,
                status: decision.status,
                action: decision.action,
                reason: decision.reason,
                stallSeconds: decision.stallSeconds,
              },
            );
          }
          this.emitter.emit('leader:status', {
            sessionId: this.sessionId,
            status: `🔄 ${decision.name}: ${decision.reason}，正在重定向`,
          });
          this.bus.send(`${this.sessionId}:leader`, `${this.sessionId}:${decision.name}`, 'control', {
            action: 'redirect',
            reason: decision.reason,
            message: `检测到异常: ${decision.reason}。请立即停止当前操作，重新审视任务目标，采用完全不同的方法。`,
          });
          this.healthMonitor.recordEscalation(decision.agentId);
          break;
        }
        case 'kill_restart': {
          // 终极干预：终止失控 Agent，并将任务交给 runtime recovery 重新调度。
          leaderLogger.error(`[HealthMonitor] KILL ${decision.name}: ${decision.reason}`);
          this.emitter.emit('leader:status', {
            sessionId: this.sessionId,
            status: `💀 ${decision.name}: ${decision.reason}，正在重启`,
          });
          const handle = this.pool.getById(decision.agentId) || this.pool.getByName(decision.name);
          const taskId = handle?.taskId;
          if (taskId && handle) {
            // 先 markAgentRecovering（forceStop + recovery record + auto-retry schedule），
            // 再 stopAgent 发 SIGTERM。确保 handle 在 SIGTEM 到达前已进入恢复管线，
            // 避免 worker:failed(terminalKind=terminated) 抢先到达时 markAgentTerminated
            // 把任务孤儿化（不重派 / 不通知 Leader / 永远卡 interrupted）。
            this.pool.markAgentRecoveringFromSupervisor(
              handle,
              'worker_health_runaway',
              `[HealthMonitor] ${decision.name} terminated after ${decision.reason}`,
            );
            this.pool.stopAgent(decision.name);
            this.healthMonitor.unregisterAgent(decision.agentId);
            this.bus.send(
              `${this.sessionId}:supervisor`,
              `${this.sessionId}:leader`,
              'agent_health_critical',
              {
                kind: 'agent_health_critical',
                taskId,
                agentId: decision.agentId,
                agentName: decision.name,
                status: decision.status,
                action: decision.action,
                reason: decision.reason,
                stallSeconds: decision.stallSeconds,
              },
            );
          } else {
            // handle 找不到或无 task —— 只能硬终止，无法调度恢复。
            leaderLogger.warn(`[HealthMonitor] KILL ${decision.name}: no active handle/task, cannot schedule recovery`);
            this.pool.stopAgent(decision.name);
            this.healthMonitor.unregisterAgent(decision.agentId);
          }
          break;
        }
      }
    }
  }
}
