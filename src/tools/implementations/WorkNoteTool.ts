import { join } from 'path';
import { z } from 'zod';
import { buildWorkNoteAwarenessBlock } from '../../core/ArtifactAwareness.js';
import { WorkNoteManager, type WorkNote, type WorkNotePhase } from '../../core/WorkNoteManager.js';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';

const WorkNotePhaseSchema = z.enum(['research', 'coding', 'testing', 'reviewing', 'other']);

const WriteWorkNoteSchema = z.object({
  agentId: z.string().optional().describe('Agent ID，默认使用当前运行上下文的 agentId；正常 Agent 运行时省略该字段。'),
  agentName: z.string().optional().describe('当前 agentName；等于当前上下文 agentName 时工具会自动映射为当前 agentId。'),
  taskId: z.string().optional().describe('任务 ID，默认使用当前 taskId；当前上下文没有 taskId 时可显式填写。'),
  phase: WorkNotePhaseSchema.default('other').describe('当前阶段'),
  summary: z.string().min(1).optional().describe('一句话摘要，必须包含实质内容（必填，与 title 二选一）'),
  title: z.string().min(1).optional().describe('内部输入字段；运行时会归一到 summary'),
  details: z.string().optional().describe('详细说明'),
  artifacts: z.array(z.string()).optional().describe('涉及的文件列表'),
  blockers: z.array(z.string()).optional().describe('阻塞项列表'),
  nextSteps: z.array(z.string()).optional().describe('下一步建议'),
  keyFindings: z.array(z.string()).optional().describe('关键发现，建议包含 文件路径:行号 - 说明'),
  impactAnalysis: z.string().optional().describe('改动影响范围分析'),
});

const ExposedWriteWorkNoteSchema = WriteWorkNoteSchema.omit({ agentId: true, agentName: true, title: true }).extend({
  summary: z.string().min(1).describe('一句话摘要，必须包含实质内容'),
});

const ReadWorkNotesSchema = z.object({
  agentId: z.string().optional().describe('可选，按 Agent ID 过滤'),
  agentName: z.string().optional().describe('可选，按 agentName 过滤；如果和当前上下文 agentName 相同会自动映射到当前 agentId'),
  taskId: z.string().optional().describe('可选，按任务 ID 过滤'),
  offset: z.number().int().min(0).default(0).optional().describe('跳过前 N 条笔记，默认 0；用于续读'),
  limit: z.number().int().positive().max(50).default(10).optional().describe('返回条数上限，默认 10'),
});

const ExposedReadWorkNotesSchema = ReadWorkNotesSchema.omit({ agentName: true }).extend({
  agentId: z.string().optional().describe('可选，按真实 Agent ID 过滤；通常省略以读取当前 session 全部工作笔记'),
});

const RequestWorkNoteSchema = z.object({
  agentId: z.string().describe('目标 Agent 名称或 ID'),
});

function getManager(context?: ToolContext): WorkNoteManager {
  const workspace = typeof context?.workspace === 'string' && context.workspace.length > 0
    ? context.workspace
    : undefined;
  return new WorkNoteManager(workspace ? join(workspace, '.lingxiao') : undefined);
}

function requireSession(context?: ToolContext): string | null {
  return typeof context?.sessionId === 'string' && context.sessionId.length > 0 ? context.sessionId : null;
}

function formatNotes(notes: WorkNote[]): string {
  if (notes.length === 0) {
    return '未找到工作笔记';
  }

  return `工作笔记 (${notes.length} 条):\n\n${notes.map((note, index) => {
    const time = new Date(note.timestamp).toLocaleString();
    const lines = [`[${index + 1}] [${note.phase}] ${note.agentId} task=${note.taskId} @ ${time}`];
    const awareness = buildWorkNoteAwarenessBlock(note);
    if (awareness) {
      lines.push(awareness);
    } else {
      lines.push(`summary: ${note.summary}`);
    }
    return lines.join('\n');
  }).join('\n\n')}`;
}

export class WriteWorkNoteTool extends Tool {
  readonly name = 'write_work_note';
  readonly description = '写入当前 Agent 的结构化工作笔记。默认自动使用当前 agentId/taskId。每次任务完成或重要阶段必须记录实质进展、产物、关键发现和影响范围。';
  readonly parameters = WriteWorkNoteSchema;
  readonly exposedParameters = ExposedWriteWorkNoteSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof WriteWorkNoteSchema>;
    const sessionId = requireSession(context);
    if (!sessionId) {
      return createToolError({
        code: 'WORK_NOTE_SESSION_REQUIRED',
        message: '缺少 sessionId，无法写入工作笔记',
        retryable: true,
        fix: '在有效 session 上下文中调用 write_work_note。',
      });
    }

    // 归一外部运行器或内部调用携带的标题字段。
    const summary = params.summary || params.title;
    if (!summary) {
      return createToolError({
        code: 'WORK_NOTE_SUMMARY_REQUIRED',
        message: '必须提供 summary（或 title）字段',
        retryable: true,
        fix: '提供包含实质内容的 summary 字段后重试。',
      });
    }

    const currentAgentId = typeof context?.agentId === 'string' ? context.agentId : '';
    const currentAgentName = typeof context?.agentName === 'string' ? context.agentName : '';
    const requestedAgentId = params.agentId || params.agentName;
    const requestedLooksLikeCurrentName = requestedAgentId && currentAgentName && requestedAgentId.trim().replace(/^@+/, '') === currentAgentName.trim().replace(/^@+/, '');
    const agentId = !requestedAgentId || requestedLooksLikeCurrentName ? currentAgentId : requestedAgentId;
    const taskId = params.taskId || (typeof context?.taskId === 'string' ? context.taskId : '');
    if (!agentId || !taskId) {
      return createToolError({
        code: 'WORK_NOTE_CONTEXT_REQUIRED',
        message: 'write_work_note 缺少 agentId 或 taskId。',
        retryable: true,
        cause: 'write_work_note 需要 agentId/taskId；正常 Agent 运行时会从上下文自动注入。',
        fix: '如果 currentAgentId/currentTaskId 存在，请省略 agentId/taskId 后重试；否则只能显式传真实 agentId 和 taskId。',
        hints: { currentAgentId: currentAgentId || null, currentTaskId: context?.taskId ?? null },
        example_args: { phase: params.phase, summary, details: params.details },
      });
    }
    if (currentAgentId && agentId !== currentAgentId) {
      return createToolError({
        code: 'WORK_NOTE_AGENT_MISMATCH',
        message: '只能写入自己的工作笔记。',
        retryable: true,
        cause: `只能写入自己的工作笔记。requested=${agentId} 不是当前 agentId=${currentAgentId}。如果 requested 是当前 agentName=${currentAgentName || '<unknown>'}，工具会自动映射；否则这是跨 agent 写笔记。`,
        fix: '省略 agentId/agentName，使用当前运行上下文自动注入的身份；跨 agent 进展通过 read_work_notes 读取后引用。',
        hints: {
          currentAgentId,
          requestedAgentId: agentId,
          currentTaskId: taskId,
          recommended_args: { phase: params.phase, summary, details: params.details, artifacts: params.artifacts, blockers: params.blockers, nextSteps: params.nextSteps, keyFindings: params.keyFindings, impactAnalysis: params.impactAnalysis },
        },
        example_args: { phase: params.phase, summary, details: params.details },
      });
    }

    const manager = getManager(context);
    const note = await manager.writeNoteWithSession(sessionId, {
      agentId,
      taskId,
      phase: params.phase as WorkNotePhase,
      summary,
      details: params.details,
      artifacts: params.artifacts,
      blockers: params.blockers,
      nextSteps: params.nextSteps,
      keyFindings: params.keyFindings,
      impactAnalysis: params.impactAnalysis,
    });

    context?.emitter?.emit('work_note:written', { sessionId, agentId, note });
    return {
      success: true,
      data: `笔记已写入: ${note.id} (agent=${agentId}, task=${taskId}, phase=${note.phase})`,
    };
  }
}

export class ReadWorkNotesTool extends Tool {
  readonly name = 'read_work_notes';
  readonly description = '读取当前 session 的工作笔记，可按真实 Agent ID 或任务过滤；通常省略 agentId 读取全部工作笔记，用于跨 Agent 了解进展和前序结论。';
  readonly parameters = ReadWorkNotesSchema;
  readonly exposedParameters = ExposedReadWorkNotesSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ReadWorkNotesSchema>;
    const sessionId = requireSession(context);
    if (!sessionId) {
      return createToolError({
        code: 'WORK_NOTE_SESSION_REQUIRED',
        message: '缺少 sessionId，无法读取工作笔记',
        retryable: true,
        fix: '在有效 session 上下文中调用 read_work_notes。',
      });
    }

    const manager = getManager(context);
    const currentAgentId = typeof context?.agentId === 'string' ? context.agentId : '';
    const currentAgentName = typeof context?.agentName === 'string' ? context.agentName : '';
    const requestedAgent = params.agentId || params.agentName;
    const normalizedRequested = requestedAgent?.trim().replace(/^@+/, '');
    const normalizedCurrentName = currentAgentName.trim().replace(/^@+/, '');
    const filterAgentId = normalizedRequested && normalizedRequested === normalizedCurrentName ? currentAgentId : params.agentId;
    let notes = filterAgentId
      ? await manager.getAgentNotes(sessionId, filterAgentId)
      : await manager.getAllNotes(sessionId);
    if (params.taskId) {
      notes = notes.filter((note) => note.taskId === params.taskId);
    }
    const total = notes.length;
    const offset = Math.max(0, params.offset || 0);
    const limit = Math.max(1, Math.min(params.limit || 10, 50));
    const page = notes.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < total;

    return {
      success: true,
      data: {
        text: formatNotes(page),
        notes: page,
        count: page.length,
        total,
        offset,
        limit,
        truncated,
        ...(truncated ? {
          next_offset: nextOffset,
          continuation_tool_call: {
            tool: 'read_work_notes',
            args: {
              ...(params.agentId ? { agentId: params.agentId } : {}),
              ...(params.agentName ? { agentName: params.agentName } : {}),
              ...(params.taskId ? { taskId: params.taskId } : {}),
              offset: nextOffset,
              limit,
            },
          },
        } : {}),
      },
    };
  }
}

export class RequestWorkNoteTool extends Tool {
  readonly name = 'request_work_note';
  readonly description = '请求另一个 Agent 更新工作笔记。目标 Agent 正在运行时会通过消息总线收到提醒。';
  readonly parameters = RequestWorkNoteSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof RequestWorkNoteSchema>;
    const sessionId = requireSession(context);
    if (!sessionId) {
      return createToolError({
        code: 'WORK_NOTE_SESSION_REQUIRED',
        message: '缺少 sessionId，无法请求工作笔记',
        retryable: true,
        fix: '在有效 session 上下文中调用 request_work_note。',
      });
    }

    const requesterAgentId = typeof context?.agentId === 'string' ? context.agentId : 'unknown';
    const requesterName = typeof context?.agentName === 'string' ? context.agentName : requesterAgentId;
    if (!context?.bus) {
      return createToolError({
        code: 'WORK_NOTE_BUS_UNAVAILABLE',
        message: '消息总线不可用，无法投递 request_work_note',
        retryable: false,
        fix: '确保在 Agent 运行上下文中调用此工具（非独立测试环境）。',
      });
    }
    context.bus.send(
      `${sessionId}:${requesterName}`,
      `${sessionId}:${params.agentId}`,
      'request_work_note',
      { sessionId, requesterAgentId },
    );
    context?.emitter?.emit('work_note:requested', {
      sessionId,
      requesterAgentId,
      targetAgentId: params.agentId,
    });

    return { success: true, data: `已请求 ${params.agentId} 更新工作笔记` };
  }
}
