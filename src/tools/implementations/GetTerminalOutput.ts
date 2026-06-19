import { z } from 'zod';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTerminalSessionManager } from './TerminalSessionManager.js';
import { isTerminalSessionActiveStatus } from '../../core/StateSemantics.js';
import { TERMINAL } from '../../config/defaults.js';

const GetTerminalOutputSchema = z.object({
  terminal_id: z.string().describe('终端会话 ID，使用 shell(is_background=true) 返回的 terminal_id。'),
  wait_seconds: z.number().optional().describe('等待时间 (秒，默认 2)'),
  tail_lines: z.number().optional().describe('返回最后 N 行 (默认全部)'),
});

export class GetTerminalOutputTool extends Tool {
  readonly name = 'get_terminal_output';
  readonly description = '获取后台终端会话的输出。用于查看后台命令的运行状态和输出内容。';
  readonly parameters = GetTerminalOutputSchema;

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof GetTerminalOutputSchema>;
    const manager = getTerminalSessionManager();
    const session = manager.getSession(params.terminal_id);

    if (!session) {
      const active = manager.getAllActiveSessions().slice(0, 10).map((s) => ({
        terminal_id: s.terminalId,
        command: s.command,
        status: s.status,
        pid: s.pid,
        started_at: s.startedAt,
      }));
      return createToolError({
        code: 'TERMINAL_SESSION_NOT_FOUND',
        message: `终端会话 ${params.terminal_id} 不存在。`,
        retryable: true,
        cause: 'terminal_id 可能已过期、被清理，或不是 shell 后台返回的真实 ID。',
        fix: active.length > 0 ? '改用 active_sessions 中的 terminal_id；如果没有目标会话，请重新运行 shell 并设置 is_background=true。' : '当前没有活跃后台会话；请重新运行 shell 并设置 is_background=true，再用返回的 terminal_id 查询。',
        hints: { active_sessions: active },
        example_args: active[0] ? { terminal_id: active[0].terminal_id } : { terminal_id: '<shell 返回的 terminal_id>' },
      });
    }

    const waitSeconds = params.wait_seconds ?? 2;

    // 如果会话还在运行，等待一段时间看是否有新输出
    if (isTerminalSessionActiveStatus(session.status)) {
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
    }

    // 构建输出
    let stdoutText = session.stdout || '(无输出)';
    let stderrText = session.stderr || '';

    // tail_lines 处理
    if (params.tail_lines && params.tail_lines > 0) {
      const stdoutLines = stdoutText.split('\n');
      if (stdoutLines.length > params.tail_lines) {
        stdoutText = `... (省略前 ${stdoutLines.length - params.tail_lines} 行)\n` +
          stdoutLines.slice(-params.tail_lines).join('\n');
      }
    }

    // 截断保护
    if (stdoutText.length > TERMINAL.OUTPUT_TRUNCATE_CHARS) {
      stdoutText = stdoutText.substring(stdoutText.length - TERMINAL.OUTPUT_TRUNCATE_CHARS) + '\n... (截断)';
    }
    if (stderrText.length > TERMINAL.OUTPUT_TRUNCATE_CHARS) {
      stderrText = stderrText.substring(stderrText.length - TERMINAL.OUTPUT_TRUNCATE_CHARS) + '\n... (截断)';
    }

    const statusLabel = this.getStatusLabel(session.status);
    const header = [
      `[终端 ${session.terminalId.substring(0, 8)} | PID ${session.pid ?? 'N/A'} | 状态: ${statusLabel}]`,
      `命令: ${session.command}`,
      `开始时间: ${new Date(session.startedAt).toLocaleString()}`,
    ];

    if (session.completedAt) {
      header.push(`完成时间: ${new Date(session.completedAt).toLocaleString()}`);
    }
    if (session.exitCode !== null) {
      header.push(`退出码: ${session.exitCode}`);
    }
    if (session.exitSignal) {
      header.push(`信号: ${session.exitSignal}`);
    }

    header.push(`最后输出: ${new Date(session.outputUpdatedAt).toLocaleString()}`);

    const parts = [header.join('\n'), '---', stdoutText];
    if (stderrText) {
      parts.push(`\n[stderr]\n${stderrText}`);
    }

    return {
      success: true,
      data: parts.join('\n'),
    };
  }

  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      running: '运行中',
      suspended: '已挂起',
      completed: '已完成',
      failed: '失败',
      killed: '已终止',
    };
    return labels[status] || status;
  }
}

export default GetTerminalOutputTool;
