/**
 * TeamCommunicationService — team 通信统一协调服务
 *
 * 主通道职责：
 * - 监听 TeamMailbox 的 team:message_sent 事件
 * - 通过 TeamCommunicationGuard 过滤限流 / 乒乓 / 总量预算
 * - 把消息推到 Worker 进程的 MessageBus
 * - 推送成功立即 markRead（主通道天然保证已读），让 team_inbox 退化为补漏
 *
 * AgentPool 只提供 isAgentRunning + bus.send 能力，不关心协议细节。
 */

import type { MessageBus } from './MessageBus.js';
import type { EventEmitter } from './EventEmitter.js';
import { TeamCommunicationGuard } from './TeamCommunicationGuard.js';
import { getTeamMailbox, getTeamMemberRegistry, type TeamMessage } from './TeamMailbox.js';
import { createProtocolMessage, formatProtocolMessageForContext, wrapProtocolPayload } from './TeamProtocol.js';
import { coreLogger } from './Log.js';

export interface TeamCommunicationAgentRuntime {
  /** 判断 agent 是否当前可接收推送消息 */
  isAgentRunning(agentName: string): boolean;
  /**
   * 目标 agent 已离线、但消息已落 mailbox 时，尝试复活它去读邮箱补漏。
   * 仅对「曾被派发过」的 agent 生效；从未派发的成员会被忽略。fire-and-forget。
   */
  reviveAgentForTeamMessage?(agentName: string): void;
}

export interface TeamCommunicationServiceOptions {
  sessionId: string;
  bus: MessageBus;
  emitter: EventEmitter;
  runtime: TeamCommunicationAgentRuntime;
}

interface TeamMessageSentEvent {
  sessionId?: string;
  message: TeamMessage;
  toTeam: string;
  isBroadcast: boolean;
}

/** session-scoped 单例注册：让 TeamSendMessage 等工具能拿到当前 session 的 service 实例做 preCheck */
const activeServices = new Map<string, TeamCommunicationService>();

export function getActiveTeamCommunicationService(sessionId: string): TeamCommunicationService | undefined {
  return activeServices.get(sessionId);
}

export class TeamCommunicationService {
  private readonly sessionId: string;
  private readonly bus: MessageBus;
  private readonly emitter: EventEmitter;
  private readonly runtime: TeamCommunicationAgentRuntime;
  private readonly guard: TeamCommunicationGuard;
  private unsubscribe?: () => void;
  private started = false;

  constructor(options: TeamCommunicationServiceOptions) {
    this.sessionId = options.sessionId;
    this.bus = options.bus;
    this.emitter = options.emitter;
    this.runtime = options.runtime;
    this.guard = new TeamCommunicationGuard(options.sessionId);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.emitter.subscribe('team:message_sent', (data) => {
      this.routeTeamMessage(data as TeamMessageSentEvent);
    });
    activeServices.set(this.sessionId, this);
  }

  cleanup(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.guard.reset();
    this.started = false;
    if (activeServices.get(this.sessionId) === this) {
      activeServices.delete(this.sessionId);
    }
  }

  /** 暴露给 TeamSendMessage 工具：在写 mailbox 前 preCheck，让 LLM 立即拿到 rate_limited 反馈而不是静默吞 */
  preCheckMessage(from: string, to: string | undefined, content: string, isBroadcast: boolean) {
    return this.guard.preCheck(from, to, content, isBroadcast);
  }

  /** 暴露 Guard 统计给监控/调试入口 */
  getStats() {
    return this.guard.getStats();
  }

  private routeTeamMessage(data: TeamMessageSentEvent): void {
    // 硬过滤：消息必须显式带 sessionId 且与本服务一致；缺省一律丢弃，
    // 防止多 session 进程内串台。
    if (!data.sessionId || data.sessionId !== this.sessionId) return;

    const msg = data.message;
    // fromMember 现在直接是 agent name；缺省时（系统消息）用 'system'
    const fromAgentName = msg.fromMember ?? 'system';

    if (data.isBroadcast) {
      this.routeBroadcast(data, fromAgentName);
      return;
    }

    if (!msg.toMember) return;
    this.routeDirect(msg, fromAgentName, msg.toMember);
  }

  private routeBroadcast(data: TeamMessageSentEvent, fromAgentName: string): void {
    const msg = data.message;
    const mailbox = getTeamMailbox();
    const members = getTeamMemberRegistry().getByTeam(data.toTeam, this.sessionId);
    const recipients = members
      .map((m) => m.name)
      .filter((name) => name !== fromAgentName);

    if (recipients.length === 0) {
      mailbox.updateDelivery(msg.id, data.toTeam, 'skipped', 'no_recipient');
      return;
    }

    const guardResult = this.guard.check(fromAgentName, undefined, msg.content, true);
    if (guardResult.verdict !== 'allow' && guardResult.verdict !== 'ping_pong_degraded') {
      coreLogger.debug(`[TeamCommunicationService] 广播被 Guard 拦截: ${guardResult.verdict} - ${guardResult.reason}`);
      for (const recipient of recipients) {
        mailbox.updateDelivery(msg.id, recipient, 'skipped', `guard_${guardResult.verdict}`);
      }
      return;
    }

    const effectiveUrgency = guardResult.degradedUrgency ?? msg.urgency;
    for (const recipient of recipients) {
      if (this.runtime.isAgentRunning(recipient)) {
        this.deliverToAgent(msg, fromAgentName, recipient, effectiveUrgency, true);
      } else {
        mailbox.updateDelivery(msg.id, recipient, 'queued', 'offline');
      }
    }
  }

  private routeDirect(msg: TeamMessage, fromAgentName: string, toAgentName: string): void {
    // Leader 路径：通过 mailbox.getTeam(toTeam).leader 判定，绕过 isAgentRunning 直送 leader bus
    // —— Leader 是 BaseAgent 子类、constructor 内已 subscribe ${sessionId}:leader bus，始终可投递。
    const mailbox = getTeamMailbox();
    const team = mailbox.getTeam(msg.toTeam, this.sessionId);
    const isLeaderRecipient = team?.leader === toAgentName;

    if (!isLeaderRecipient && !this.runtime.isAgentRunning(toAgentName)) {
      const reviveAvailable = typeof this.runtime.reviveAgentForTeamMessage === 'function';
      this.runtime.reviveAgentForTeamMessage?.(toAgentName);
      mailbox.updateDelivery(msg.id, toAgentName, 'queued', reviveAvailable ? 'offline_revive_requested' : 'offline');
      return;
    }

    const guardResult = this.guard.check(fromAgentName, toAgentName, msg.content, false);
    if (guardResult.verdict !== 'allow' && guardResult.verdict !== 'ping_pong_degraded') {
      coreLogger.debug(`[TeamCommunicationService] 消息被 Guard 拦截: ${guardResult.verdict} - ${guardResult.reason}`);
      mailbox.updateDelivery(msg.id, toAgentName, 'skipped', `guard_${guardResult.verdict}`);
      return;
    }

    const effectiveUrgency = guardResult.degradedUrgency ?? msg.urgency;
    this.deliverToAgent(msg, fromAgentName, toAgentName, effectiveUrgency, false, isLeaderRecipient);
  }

  private deliverToAgent(
    msg: TeamMessage,
    fromAgentName: string,
    toAgentName: string,
    urgency: 'normal' | 'urgent',
    isBroadcast: boolean,
    bypassRunningCheck: boolean = false,
  ): void {
    const mailbox = getTeamMailbox();
    // routeDirect / routeBroadcast 已在 guard 之前过滤过 isAgentRunning，
    // 这里保留二次防御：派发瞬间 worker 退出也不会 NPE。bypassRunningCheck=true 时跳过（leader 路径）。
    if (!bypassRunningCheck && !this.runtime.isAgentRunning(toAgentName)) {
      mailbox.updateDelivery(msg.id, toAgentName, 'queued', 'offline_during_delivery');
      return;
    }

    const protocolMessage = createProtocolMessage({
      id: msg.id,
      from: fromAgentName,
      to: toAgentName,
      sessionId: this.sessionId,
      rawContent: msg.content,
      urgency,
      timestamp: msg.timestamp,
      metadata: msg.metadata,
    });
    const routedProtocolMessage = {
      ...protocolMessage,
      type: isBroadcast && protocolMessage.type === 'message' ? 'broadcast' as const : protocolMessage.type,
    };
    const contextContent = formatProtocolMessageForContext(routedProtocolMessage);
    const busType = urgency === 'urgent' ? 'user_intervention' : 'message';
    let sendOk = true;
    try {
      this.bus.send(
        this.scoped(fromAgentName),
        this.scoped(toAgentName),
        busType,
        wrapProtocolPayload({ ...routedProtocolMessage, content: contextContent }),
      );
    } catch (err) {
      sendOk = false;
      coreLogger.warn(`[TeamCommunicationService] bus.send 失败 (${fromAgentName}→${toAgentName}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (sendOk) {
      mailbox.updateDelivery(msg.id, toAgentName, 'delivered');
      // 仅在 bus.send 同步路径成功时才 markRead；失败留给 inbox_check 兜底，避免静默丢消息
      try {
        mailbox.markRead([msg.id], toAgentName);
      } catch {
        // mailbox 操作失败不应阻断后续投递
      }
    } else {
      mailbox.updateDelivery(msg.id, toAgentName, 'failed', 'bus_send_failed');
    }
  }

  private scoped(agentName: string): string {
    return `${this.sessionId}:${agentName}`;
  }
}
