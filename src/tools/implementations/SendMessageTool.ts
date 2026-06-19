import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';

const SendMessageSchema = z.object({
  recipient: z.string().describe('接收者：\'leader\' 或其他 agent 名称'),
  message_type: z.enum(['report', 'help', 'finding', 'flag', 'error']).describe('消息类型'),
  content: z.string().describe('消息内容'),
  data: z.record(z.string(), z.unknown()).optional().describe('附加数据（可选）'),
});

const URGENT_TYPES = new Set(['help', 'error', 'flag']);
const FINDING_TYPES = new Set<string>(['finding', 'flag']);

export class SendMessageTool extends Tool {
  readonly name = 'send_message';
  readonly description = 'Worker 向 Leader 或其他 Agent 发送消息（方向：Worker → Leader/Agent）。参数：recipient（接收者，"leader" 或 agent 名称）。与 Leader 使用的 send_message_to_agent（参数：agent_name）和 Team 成员间的 team_message（参数：target_type+target）不同。';
  readonly parameters = SendMessageSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof SendMessageSchema>;
    let { data } = params;
    const { recipient, message_type, content } = params;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* keep as string */ }
    }

    const db = context?.db;
    const sessionId = context?.sessionId;
    const bus = context?.bus;
    const agentName = context?.agentName || 'unknown';
    const emitter = context?.emitter;

    if (!db || !sessionId) {
      return { success: false, data: null, error: '上下文缺少 db 或 sessionId' };
    }

    try {
      const message = { type: message_type, content, data: data || {} };

      await db.setSessionState(
        sessionId,
        `messages/${recipient}/${message_type}/${agentName}`,
        message,
      );

      if (bus) {
        let busContent = `[${message_type}] ${content}`;
        if (data) {
          busContent += `\n附加数据：${JSON.stringify(data).slice(0, 500)}`;
        }
        const busFrom = agentName.includes(':') ? agentName : `${sessionId}:${agentName}`;
        const isLeader = recipient === 'leader' || recipient === `${sessionId}:leader`;
        const busTo = isLeader
          ? `${sessionId}:leader`
          : (recipient.includes(':') ? recipient : `${sessionId}:${recipient}`);

        if (URGENT_TYPES.has(message_type) && isLeader) {
          await bus.send(busFrom, busTo, 'user_intervention', busContent);
          emitter?.emit('agent:intervention', {
            sessionId,
            agentId: context?.agentId || agentName,
            agentName,
            message_type,
            content,
          });
        } else {
          await bus.send(busFrom, busTo, 'message', busContent);
        }
      }

      if ((recipient === 'leader' || recipient === `${sessionId}:leader`) && FINDING_TYPES.has(message_type)) {
        const existing = await db.getSessionState(sessionId, 'findings');
        const findingsList = Array.isArray(existing) ? existing : [];
        findingsList.push({ type: message_type, content, data, from: agentName });
        await db.setSessionState(sessionId, 'findings', findingsList);
      }

      return { success: true, data: `已发送 ${message_type} 消息给 ${recipient}` };
    } catch (error: unknown) {
      const err = error as Error;
      return { success: false, data: null, error: `发送消息失败 - ${err.name}: ${err.message}` };
    }
  }
}

export default SendMessageTool;
