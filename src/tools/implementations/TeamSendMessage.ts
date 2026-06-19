/**
 * TeamSendMessageTool — peer-to-peer or broadcast inside a team.
 *
 * Resolves the sender from ctx.agentName + ctx.sessionId, then routes either
 * to a specific member (P2P) or to a whole team (broadcast). Bypasses the
 * Leader hub-spoke channel.
 */

import { z } from 'zod';
import { Tool, createToolError, type ToolContext, type ToolResult } from '../Tool.js';
import { getTeamMailbox, getTeamMemberRegistry } from '../../core/TeamMailbox.js';
import { getActiveTeamCommunicationService } from '../../core/TeamCommunicationService.js';
import { getTeamRequestTracker } from '../../core/TeamRequestTracker.js';
import { normalizeAgentName, resolveTeamView } from '../../core/TeamView.js';

type NormalizedTarget = { targetType: 'member' | 'team'; target: string };

function normalizeTargetValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTarget(params: { target_type?: 'member' | 'team'; target?: string; content?: string; type?: string }): ToolResult | NormalizedTarget {
  const structuredTarget = normalizeTargetValue(params.target);

  if (structuredTarget && params.target_type) {
    return { targetType: params.target_type, target: structuredTarget };
  }

  if (structuredTarget || params.target_type) {
    return createToolError({
      code: 'TEAM_TARGET_STRUCTURED_INCOMPLETE',
      message: 'target_type 和 target 必须成对出现。',
      retryable: true,
      cause: '结构化目标缺少 target_type 或 target。',
      fix: 'P2P 填 target_type="member" + target="成员名"；广播填 target_type="team" + target="team名"。',
      example_args: { target_type: 'team', target: '<team-name>', content: params.content || '<message>' },
    });
  }

  return createToolError({
    code: 'TEAM_TARGET_REQUIRED',
    message: '缺少发送目标。',
    retryable: true,
    cause: 'team_message 需要明确 P2P 或广播目标。',
    fix: 'P2P 用 {target_type:"member", target:"成员名"}；广播用 {target_type:"team", target:"team名"}。',
    example_args: { target_type: 'team', target: '<team-name>', content: params.content || '<message>', type: params.type || 'normal' },
  });
}

export class TeamSendMessageTool extends Tool {
  readonly name = '__team_message_router';
  readonly description = 'Team 消息内部路由：向同 team 成员 P2P 或向 team 广播。公开入口是 team_message。';
  readonly parameters = z.object({
    target_type: z.enum(['member', 'team']).describe('目标类型：member 表示 P2P，team 表示广播。'),
    target: z.string().min(1).describe('目标值：target_type=member 时填成员 agent name；target_type=team 时填 team name。'),
    content: z.string().min(1).max(10_000).describe('消息正文'),
    urgency: z.enum(['normal', 'urgent']).optional().describe('紧急程度，默认 normal'),
    type: z.enum(['normal', 'ack', 'request']).optional().describe('消息类型：normal 通知 / ack 契约或请求回执 / request 期望对方回 ack。默认 normal'),
    request_id: z.string().min(1).max(200).optional().describe('ack 或 request 的关联 id，推荐用 `<surface>@v<N>` 形式（如 user.profile.api@v2）。不知道时省略，不要传空字符串。'),
    intent: z.enum(['message', 'transfer_request', 'transfer_accept', 'review_request', 'review_result', 'clarification_request', 'pairing_request', 'conflict_notice', 'coordination_result', 'decision_record']).optional().describe('结构化协作意图，默认 message'),
    task_id: z.string().optional().describe('关联任务 ID'),
    source_task_id: z.string().optional().describe('来源任务 ID'),
    target_task_id: z.string().optional().describe('目标/后续任务 ID'),
    artifact_paths: z.array(z.string()).optional().describe('关联产物路径'),
    evidence_refs: z.array(z.string()).optional().describe('证据引用'),
    verdict: z.enum(['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']).optional().describe('review/verdict 类消息结论'),
    next_action: z.string().optional().describe('建议下一步'),
  });

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as {
      target_type: 'member' | 'team';
      target?: string;
      content: string;
      urgency?: 'normal' | 'urgent';
      type?: 'normal' | 'ack' | 'request';
      request_id?: string;
      intent?: 'message' | 'transfer_request' | 'transfer_accept' | 'review_request' | 'review_result' | 'clarification_request' | 'pairing_request' | 'conflict_notice' | 'coordination_result' | 'decision_record';
      task_id?: string;
      source_task_id?: string;
      target_task_id?: string;
      artifact_paths?: string[];
      evidence_refs?: string[];
      verdict?: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';
      next_action?: string;
    };

    const normalizedTarget = normalizeTarget(params);
    if ('success' in normalizedTarget) return normalizedTarget;
    const targetMemberName = normalizedTarget.targetType === 'member' ? normalizedTarget.target : undefined;
    const targetTeamName = normalizedTarget.targetType === 'team' ? normalizedTarget.target : undefined;

    // ack/request 必须带 request_id，否则就只是普通消息冒充协议帧，没有意义
    if ((params.type === 'ack' || params.type === 'request') && !params.request_id) {
      return createToolError({
        code: 'TEAM_REQUEST_ID_REQUIRED',
        message: `type=${params.type} 必须配合 request_id。`,
        retryable: true,
        cause: 'ack/request 协议帧没有 request_id 就无法登记或闭环。',
        fix: '如果只是同步结论/进度，直接使用 retry_args（type="normal" 且不带 request_id）；协议帧请传稳定非空 request_id，ack 必须复制收到的同一个 request_id。',
        example_args: {
          target_type: 'member',
          target: '<member-name>',
          content: params.content || '<message>',
          type: 'normal',
        },
        retry_args: {
          target_type: params.target_type,
          target: params.target,
          content: params.content,
          type: 'normal',
        },
      });
    }

    const senderName = context?.agentName;
    if (!senderName) {
      return { success: false, data: null, error: '当前调用没有 agentName，无法定位发送方成员。' };
    }
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return { success: false, data: null, error: 'team_message 必须在明确 sessionId 的上下文中调用。' };
    }

    const registry = getTeamMemberRegistry();
    const mailbox = getTeamMailbox();
    const sender = registry.getByName(senderName, sessionId);
    if (!sender) {
      return { success: false, data: null, error: `发送方 "${senderName}" 不在当前 session 的 TeamMemberRegistry roster 中。请先 team_manage(action="create"|"edit") 显式登记成员。` };
    }

    let toTeam: string;
    let toMemberName: string | undefined;

    if (targetMemberName) {
      const target = registry.getByName(targetMemberName, sessionId);
      if (!target) {
        return { success: false, data: null, error: `找不到成员 "${targetMemberName}"（同 session 内未注册到 TeamMemberRegistry）。请先 team_manage(action="create"|"edit") 显式登记成员。` };
      } else {
        if (target.team !== sender.team) {
          return { success: false, data: null, error: `成员 "${targetMemberName}" 不在你的 team (${sender.team})；如需全队可见，请改为 team 广播。` };
        }
        toTeam = target.team;
        toMemberName = target.name;
      }
    } else {
      toTeam = targetTeamName!;
      if (!mailbox.teamExists(toTeam, sessionId)) {
        return { success: false, data: null, error: `Team "${toTeam}" 不存在。` };
      }
      // 越权拦截：跨 team 广播与 P2P 跨 team 校验对称。
      if (sender.team !== toTeam) {
        return { success: false, data: null, error: `你属于 team "${sender.team}"；广播目标请使用所属 team。目标 team="${toTeam}"。` };
      }
    }

    // 未派发/不可交互成员拦截（仅 P2P）：统一从 TeamView 判断 roster + agent_state。
    if (toMemberName && context?.db && context?.sessionId) {
      const resolvedView = resolveTeamView(context, toTeam);
      if (resolvedView.ok) {
        const targetView = resolvedView.view.membersByName.get(normalizeAgentName(toMemberName));
        if (targetView && !targetView.interactive) {
          return {
            success: false,
            data: {
              target: toMemberName,
              team: toTeam,
              rostered: true,
              dispatched: targetView.dispatched,
              interactive: targetView.interactive,
              status: targetView.status,
              recommended_next_steps: [
                { tool: 'team_message', args: { target_type: 'team', target: toTeam, content: params.content, type: 'normal' }, reason: '团队基线/报告适合广播给全队。' },
                { tool: 'send_message', args: { recipient: 'leader', content: `请先 dispatch @${toMemberName}，然后再让其处理 team 消息。` }, reason: '如果必须点名该成员处理，请让 Leader 先派发它。' },
                { tool: 'team_manage', args: { action: 'list_members', team_name: toTeam }, reason: '发送 P2P 前确认目标成员 interactive=true。' },
              ],
            },
            error: JSON.stringify({
              code: 'TEAM_MEMBER_NOT_INTERACTIVE',
              retryable: true,
              cause: `成员 "${toMemberName}" 当前 interactive=false（status=${targetView.status}），没有可直达的运行实体接收 P2P。`,
              fix: '给全队留信息时使用 target_type="team" 广播；点名该成员前先让 Leader dispatch。',
              target: { name: toMemberName, team: toTeam, rostered: true, dispatched: targetView.dispatched, interactive: false, status: targetView.status },
              recommended_next_steps: [
                { tool: 'team_message', args: { target_type: 'team', target: toTeam, content: params.content, type: 'normal' } },
                { tool: 'send_message', args: { recipient: 'leader', content: `请先 dispatch @${toMemberName}。` } },
                { tool: 'team_manage', args: { action: 'list_members', team_name: toTeam } },
              ],
            }),
          };
        }
      }
    }

    // Guard 前置校验：rate_limited / deduplicated / ping_pong_blocked / budget_exhausted
    // 直接返回错误给 LLM，让发送方获得可执行修复建议。
    {
      const service = getActiveTeamCommunicationService(sessionId);
      if (service) {
        const verdict = service.preCheckMessage(
          sender.name,
          toMemberName,
          params.content,
          !toMemberName,
        );
        if (verdict.verdict === 'rate_limited' || verdict.verdict === 'deduplicated' || verdict.verdict === 'ping_pong_blocked' || verdict.verdict === 'budget_exhausted') {
          return {
            success: false,
            data: null,
            error: `team 消息被通讯护栏拦截 (${verdict.verdict}): ${verdict.reason ?? '无详细原因'}`,
          };
        }
      }
    }

    const metadata = {
      intent: params.intent ?? 'message',
      taskId: params.task_id,
      sourceTaskId: params.source_task_id,
      targetTaskId: params.target_task_id,
      artifactPaths: params.artifact_paths,
      evidenceRefs: params.evidence_refs,
      requiresAck: params.type === 'request',
      requestId: params.request_id,
      verdict: params.verdict,
      summary: params.content.slice(0, 160),
      nextAction: params.next_action,
      participants: [sender.name, toMemberName ?? `team:${toTeam}`],
    };

    const msg = mailbox.sendMessage({
      fromTeam: sender.team,
      toTeam,
      fromMember: sender.name,
      toMember: toMemberName,
      content: params.content,
      urgency: params.urgency ?? 'normal',
      kind: params.type ?? 'normal',
      requestId: params.request_id,
      metadata,
      sessionId,
    });

    let deliverySideEffectNote = '';
    // urgent 路径补 emit agent:intervention 事件 — 与 send_message 对齐，
    // 让 leader / SseBridge / TUI banner 等订阅方都能感知到 urgent 流转
    if (msg.urgency === 'urgent' && context?.emitter) {
      try {
        const target = toMemberName ?? `team:${toTeam}`;
        context.emitter.emit('agent:intervention', {
          sessionId,
          agentId: context.agentId || sender.name,
          agentName: sender.name,
          message_type: 'team_urgent',
          content: `→ ${target}: ${params.content.slice(0, 500)}`,
        });
      } catch (error) {
        deliverySideEffectNote = `；urgent intervention emit failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // ack/request 闭环：登记 request、配对 ack（TeamRequestTracker）
    let ackNote = '';
    if (msg.requestId && (msg.kind === 'request' || msg.kind === 'ack')) {
      try {
        const tracker = getTeamRequestTracker(sessionId);
        if (msg.kind === 'request') {
          const expectedAckBy = toMemberName
            ? [toMemberName]
            : (() => {
                const teamDef = mailbox.getTeam(toTeam, sessionId);
                const senderKey = sender.name.trim().toLowerCase();
                return teamDef
                  ? [teamDef.leader, ...teamDef.members].filter(name => name.trim().toLowerCase() !== senderKey)
                  : [];
              })();
          tracker.onRequest({
            requestId: msg.requestId,
            from: sender.name,
            to: toMemberName ?? toTeam,
            isBroadcast: !toMemberName,
            content: params.content,
            sentAt: msg.timestamp,
            expectedAckBy,
          });
          ackNote = expectedAckBy.length > 0
            ? `；已登记 request ${msg.requestId}，等待 ${expectedAckBy.join(', ')} 回 ack`
            : `；已登记 request ${msg.requestId}，当前没有需要回 ack 的接收者`;
        } else {
          const outcome = tracker.onAck(msg.requestId, sender.name);
          ackNote = outcome.matched
            ? outcome.completed
              ? `；已闭环 request ${msg.requestId}（原请求来自 @${outcome.request?.from}）`
              : outcome.ignoredReason === 'unexpected_sender'
                ? `；ack ${msg.requestId} 已收到，但 @${sender.name} 不是该 request 的预期回执成员；仍缺 ${outcome.missingAckBy?.join(', ') || '未知成员'}`
                : `；ack ${msg.requestId} 已记录，仍缺 ${outcome.missingAckBy?.join(', ') || '未知成员'}`
            : `；ack ${msg.requestId} 未找到对应的 pending request（可能已闭环或对方未登记）`;
        }
      } catch (error) {
        ackNote = `；ack/request tracker update failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const target = toMemberName ? toMemberName : `team:${toTeam}`;
    const tags: string[] = [];
    if (msg.urgency === 'urgent') tags.push('urgent');
    if (msg.kind && msg.kind !== 'normal') tags.push(`${msg.kind}${msg.requestId ? `:${msg.requestId}` : ''}`);
    const tagStr = tags.length > 0 ? ` [${tags.join(' | ')}]` : '';
    const delivery = mailbox.getDeliverySummary(msg.id);
    const deliveryNote = `；delivery: delivered=${delivery.delivered}, read=${delivery.read}, queued=${delivery.queued}, skipped=${delivery.skipped}, failed=${delivery.failed}`;
    return {
      success: true,
      data: {
        message: `已发送 (${msg.id}) → ${target}${tagStr}${ackNote}${deliverySideEffectNote}${deliveryNote}`,
        message_id: msg.id,
        target,
        delivery,
      },
    };
  }
}
