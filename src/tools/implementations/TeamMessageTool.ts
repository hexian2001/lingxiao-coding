import { z } from 'zod';
import { Tool, createToolError, type ToolContext, type ToolResult } from '../Tool.js';
import { TeamSendMessageTool } from './TeamSendMessage.js';

const TeamMessageObjectSchema = z.object({
  intent: z.enum([
    'message',
    'transfer_request',
    'transfer_accept',
    'review_request',
    'review_result',
    'clarification_request',
    'pairing_request',
    'conflict_notice',
    'coordination_result',
    'decision_record',
  ]).default('message').describe('结构化协作意图：transfer/review/clarification/conflict/coordination/decision。'),
  target_type: z.enum(['member', 'team']).describe('目标类型：member 表示 P2P，team 表示广播。唯一目标字段是 target_type + target；不要传 to/to_member/to_team/from。发送方由系统从当前 agent 推断。'),
  target: z.string().min(1).describe('目标成员名或 team 名；必须和 target_type 成对出现。'),
  content: z.string().min(1).max(10_000).describe('消息正文。'),
  urgency: z.enum(['normal', 'urgent']).optional().describe('紧急程度，默认 normal。'),
  type: z.enum(['normal', 'ack', 'request']).optional().describe('消息类型；normal=通知，request=要求对方回 ack，ack=回执已有 request。显式使用 request/ack 时必须提供非空 request_id。'),
  request_id: z.string().min(1).max(200).optional().describe('request/ack 关联 ID。normal 可省略；ack 必须填收到的同一个 request_id；契约闭环建议用 `<surface>@v<N>`。不知道时省略，不要传空字符串。'),
  requires_ack: z.boolean().optional().describe('是否需要对方 ack；true 会发送 request 且必须配 request_id。false 强制普通消息，优先级高于 intent 默认。'),
  task_id: z.string().optional(),
  source_task_id: z.string().optional(),
  target_task_id: z.string().optional(),
  artifact_paths: z.array(z.string()).optional(),
  evidence_refs: z.array(z.string()).optional(),
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']).optional(),
  next_action: z.string().optional(),
}).strict();

const TeamMessageSchema = TeamMessageObjectSchema;

function defaultTypeForIntent(input: { intent: string; type?: 'normal' | 'ack' | 'request'; requires_ack?: boolean }): 'normal' | 'ack' | 'request' {
  if (input.type) return input.type;
  if (input.requires_ack === false) return 'normal';
  if (input.requires_ack === true) return 'request';
  if (input.intent === 'transfer_accept') return 'ack';
  if (input.intent === 'coordination_result') return 'ack';
  if (input.intent === 'decision_record') return 'normal';
  return input.intent === 'message' ? 'normal' : 'request';
}

export class TeamMessageTool extends Tool {
  readonly name = 'team_message';
  readonly description = 'Team 消息统一入口（Team 模式专用）：发送 P2P 或广播消息。参数：target_type（member/team）+ target（目标名）。与 send_message（Worker → Leader/Agent，参数：recipient）和 send_message_to_agent（Leader → Agent，参数：agent_name）不同。支持普通消息、任务转派确认、review 请求/结果、澄清请求、冲突通知、协作结果和决策记录。显式 type="request"/"ack" 或 requires_ack=true 必须提供非空 request_id；normal 消息不知道 request_id 时直接省略。';
  readonly parameters = TeamMessageSchema;
  readonly exposedParameters = TeamMessageObjectSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = TeamMessageSchema.parse(args);
    const sender = new TeamSendMessageTool();
    const type = defaultTypeForIntent(params);
    const requestId = typeof params.request_id === 'string' && params.request_id.trim()
      ? params.request_id.trim()
      : undefined;
    const explicitProtocolType = params.type === 'request' || params.type === 'ack' || params.requires_ack === true;
    if ((type === 'ack' || explicitProtocolType) && !requestId) {
      return createToolError({
        code: 'TEAM_REQUEST_ID_REQUIRED',
        message: `team_message type=${type} 必须提供非空 request_id。`,
        retryable: true,
        cause: 'request/ack 协作帧需要稳定 request_id 才能闭环；空字符串无效。',
        fix: '如果只是同步结论/进度，直接使用 retry_args（type="normal" 且不带 request_id）；只有收到 request 后回执才用 type="ack" 并复制同一个 request_id；要发起 request 时使用稳定 ID，例如 <surface>@v<N>。',
        example_args: {
          target_type: 'member',
          target: '<member-name>',
          content: '同步结论如下...',
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
    return sender.execute({
      ...params,
      type,
      request_id: requestId ?? (type === 'normal' ? undefined : `${params.intent}:${Date.now()}`),
    }, context);
  }
}
