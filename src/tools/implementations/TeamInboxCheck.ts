/**
 * TeamInboxCheckTool — 补漏 + 历史回看接口。
 *
 * 主通道为 TeamCommunicationService 直推到 Worker 进程；推送成功后会立即
 * markRead，因此 inbox 默认只剩"推送失败/agent 离线/启动前堆积"的补漏。
 *
 * 默认 unread_only=true、mark_read=true：拿到补漏即标记已读。
 * 想看历史可显式 unread_only=false。
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox, getTeamMemberRegistry, type TeamMessage } from '../../core/TeamMailbox.js';
import { getTeamRequestTracker } from '../../core/TeamRequestTracker.js';
import { buildTeamMessageAwarenessBlock } from '../../core/ArtifactAwareness.js';

interface InboxItem {
  id: string;
  from_team: string;
  from_member?: string;
  to_member?: string;
  urgency: 'normal' | 'urgent';
  /** 消息类型：normal / ack / request；旧消息缺省按 normal */
  kind: 'normal' | 'ack' | 'request';
  /** ack 或 request 的关联 id（推荐 `<surface>@v<N>`） */
  request_id?: string;
  content: string;
  metadata?: TeamMessage['metadata'];
  artifact_awareness?: string;
  timestamp: number;
  read_by_me: boolean;
  delivery_to_me?: unknown;
}

function project(msg: TeamMessage, memberName: string): InboxItem {
  const artifactAwareness = buildTeamMessageAwarenessBlock(msg);
  return {
    id: msg.id,
    from_team: msg.fromTeam,
    from_member: msg.fromMember,
    to_member: msg.toMember,
    urgency: msg.urgency,
    kind: (msg.kind ?? 'normal'),
    request_id: msg.requestId,
    content: msg.content,
    metadata: msg.metadata,
    artifact_awareness: artifactAwareness || undefined,
    timestamp: msg.timestamp,
    read_by_me: msg.readBy.has(memberName),
    delivery_to_me: msg.metadata?.delivery?.recipients?.[memberName],
  };
}

export class TeamInboxCheckTool extends Tool {
  readonly name = '__team_inbox_reader';
  readonly description = 'team_inbox 的内部读取实现：补漏、历史回看、ack/request 闭环摘要，并返回统一 artifact awareness。';
  readonly parameters = z.object({
    unread_only: z.boolean().optional().describe('默认 true：只返回未读消息；false 时回看所有历史'),
    mark_read: z.boolean().optional().describe('默认 true：返回后自动标记为已读'),
    limit: z.number().int().min(1).max(50).optional().describe('返回条数上限，默认 20'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as {
      unread_only?: boolean;
      mark_read?: boolean;
      limit?: number;
    };

    const senderName = context?.agentName;
    if (!senderName) {
      return { success: false, data: null, error: '当前调用没有 agentName，无法定位收件人。' };
    }
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return { success: false, data: null, error: 'team_inbox 必须在明确 sessionId 的上下文中调用。' };
    }

    const registry = getTeamMemberRegistry();
    const mailbox = getTeamMailbox();
    const member = registry.getByName(senderName, sessionId);
    if (!member) {
      return { success: false, data: null, error: `成员 "${senderName}" 不在当前 session 的 TeamMemberRegistry roster 中。请先 team_manage(action="create"|"edit") 显式登记成员。` };
    }

    const unreadOnly = params.unread_only !== false;
    const markRead = params.mark_read !== false;
    const limit = params.limit ?? 20;

    const inbox = mailbox.getInboxForMember(member.name, {
      teamName: member.team,
      sessionId,
      unreadOnly,
      limit,
    });

    if (markRead && inbox.length > 0) {
      mailbox.markRead(inbox.map(m => m.id), member.name);
    }

    // ack/request 闭环摘要：我发出还没等到 ack 的 request + 别人请求我、我还没 ack 的
    const ackSummary = (() => {
      try {
        const tracker = getTeamRequestTracker(sessionId);
        const outstanding = tracker.getOutstandingFrom(member.name);
        const owed = tracker.getAwaitingAckBy(member.name);
        if (outstanding.length === 0 && owed.length === 0) return undefined;
        return {
          // 我发出的 request 还在等对方 ack（含是否已超时）
          waiting_for_ack: outstanding.map(r => ({
            request_id: r.requestId,
            to: r.to,
            timed_out: r.timedOut,
            acked_by: Object.keys(r.ackedBy),
            missing_ack_by: tracker.getMissingAckBy(r),
          })),
          // 别人请求我、我还没回 ack（提醒该回执了）
          you_owe_ack: owed.map(r => ({
            request_id: r.requestId,
            from: r.from,
            timed_out: r.timedOut,
            missing_ack_by: tracker.getMissingAckBy(r),
          })),
        };
      } catch {/* expected: resource not available */
        return undefined;
      }
    })();

    return {
      success: true,
      data: {
        team: member.team,
        member: { name: member.name },
        count: inbox.length,
        messages: inbox.map(m => project(m, member.name)),
        ...(ackSummary ? { ack_status: ackSummary } : {}),
      },
    };
  }
}
