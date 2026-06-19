import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getTerminalSessionManager, type TerminalSession } from './TerminalSessionManager.js';
import {
  isTerminalSessionActiveStatus,
  isTerminalSessionTerminalStatus,
  normalizeTerminalSessionStatus,
} from '../../core/StateSemantics.js';
import { supportsProcessSuspendResume } from '../../utils/platform.js';
import { TERMINAL } from '../../config/defaults.js';
import { validateCommandForProcessKill } from '../../core/ProcessSelfProtection.js';

const TerminalControlSchema = z.object({
  terminal_id: z.string().describe('终端会话 ID'),
  action: z.enum(['kill', 'suspend', 'resume', 'write', 'resize']).describe('操作类型'),
  input: z.string().optional().describe('write 操作要发送的输入（action=write 时必填）'),
  cols: z.number().optional().describe('resize 操作的列数（action=resize 时必填）'),
  rows: z.number().optional().describe('resize 操作的行数（action=resize 时必填）'),
});

export class TerminalControlTool extends Tool {
  readonly name = 'terminal_control';
  readonly description = '管理后台终端会话：终止(kill)、发送输入(write)、调整大小(resize)；suspend/resume 仅在支持 POSIX 信号的平台可用。';
  readonly parameters = TerminalControlSchema;

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof TerminalControlSchema>;
    const manager = getTerminalSessionManager();
    const session = manager.getSession(params.terminal_id);

    if (!session) {
      return {
        success: false,
        data: null,
        error: `终端会话 ${params.terminal_id} 不存在。可能已过期或被清理。`,
      };
    }

    switch (params.action) {
      case 'kill':
        return this.handleKill(manager, params.terminal_id, session);
      case 'suspend':
        return this.handleSuspend(manager, params.terminal_id, session);
      case 'resume':
        return this.handleResume(manager, params.terminal_id, session);
      case 'write':
        return this.handleWrite(manager, params.terminal_id, session, params.input);
      case 'resize':
        return this.handleResize(manager, params.terminal_id, session, params.cols, params.rows);
      default:
        return {
          success: false,
          data: null,
          error: `不支持的操作: ${params.action}`,
        };
    }
  }

  private async handleKill(
    manager: ReturnType<typeof getTerminalSessionManager>,
    terminalId: string,
    session: TerminalSession,
  ): Promise<ToolResult> {
    if (isTerminalSessionTerminalStatus(session.status)) {
      return {
        success: true,
        data: `终端 ${terminalId.substring(0, 8)} 已处于 ${session.status} 状态，无需再次终止。命令: ${session.command}`,
      };
    }

    if (!isTerminalSessionActiveStatus(session.status)) {
      return {
        success: false,
        data: null,
        error: `终端会话 ${terminalId.substring(0, 8)} 当前状态为 ${session.status}；终止操作适用于 running/suspended 状态。请先读取终端状态或选择匹配的操作。`,
      };
    }

    const ok = await manager.killSession(terminalId);
    if (ok) {
      return {
        success: true,
        data: `终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 已终止。命令: ${session.command}`,
      };
    }
    return {
      success: false,
      data: null,
      error: `终止终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 失败。进程可能已退出。`,
    };
  }

  private handleSuspend(
    manager: ReturnType<typeof getTerminalSessionManager>,
    terminalId: string,
    session: TerminalSession,
  ): ToolResult {
    if (normalizeTerminalSessionStatus(session.status) !== 'running') {
      return {
        success: false,
        data: null,
        error: `终端会话 ${terminalId.substring(0, 8)} 当前状态为 ${session.status}；挂起操作适用于 running 状态。请先读取终端状态或选择匹配的操作。`,
      };
    }

    if (!supportsProcessSuspendResume()) {
      return {
        success: false,
        data: null,
        error: '当前平台不支持 suspend/resume：Windows 不支持 SIGTSTP/SIGCONT。请使用 kill 或 write 控制进程。',
      };
    }

    const ok = manager.suspendSession(terminalId);
    if (ok) {
      return {
        success: true,
        data: `终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 已挂起 (SIGTSTP)。命令: ${session.command}\n使用 terminal_control resume 恢复执行。`,
      };
    }
    return {
      success: false,
      data: null,
      error: `挂起终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 失败。`,
    };
  }

  private handleResume(
    manager: ReturnType<typeof getTerminalSessionManager>,
    terminalId: string,
    session: TerminalSession,
  ): ToolResult {
    if (normalizeTerminalSessionStatus(session.status) !== 'suspended') {
      return {
        success: false,
        data: null,
        error: `终端会话 ${terminalId.substring(0, 8)} 当前状态为 ${session.status}；恢复操作适用于 suspended 状态。请先读取终端状态或选择匹配的操作。`,
      };
    }

    if (!supportsProcessSuspendResume()) {
      return {
        success: false,
        data: null,
        error: '当前平台不支持 suspend/resume：Windows 不支持 SIGTSTP/SIGCONT。请使用 kill 或 write 控制进程。',
      };
    }

    const ok = manager.resumeSession(terminalId);
    if (ok) {
      return {
        success: true,
        data: `终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 已恢复 (SIGCONT)。命令: ${session.command}`,
      };
    }
    return {
      success: false,
      data: null,
      error: `恢复终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 失败。`,
    };
  }

  private handleWrite(
    manager: ReturnType<typeof getTerminalSessionManager>,
    terminalId: string,
    session: TerminalSession,
    input?: string,
  ): ToolResult {
    if (!input) {
      return {
        success: false,
        data: null,
        error: 'write 操作需要提供 input 参数。',
      };
    }

    // 进程自杀防护：检测写入内容是否包含杀进程命令
    const killError = validateCommandForProcessKill(input);
    if (killError) {
      return {
        success: false,
        data: null,
        error: killError,
      };
    }

    if (!isTerminalSessionActiveStatus(session.status)) {
      return {
        success: false,
        data: null,
        error: `终端会话 ${terminalId.substring(0, 8)} 当前状态为 ${session.status}，无法写入输入。`,
      };
    }

    const ok = manager.writeToSession(terminalId, input);
    if (ok) {
      return {
        success: true,
        data: `已向终端 ${terminalId.substring(0, 8)} (PID ${session.pid}) 发送输入: ${input.length > 50 ? input.substring(0, 50) + '...' : JSON.stringify(input)}`,
      };
    }
    return {
      success: false,
      data: null,
      error: `向终端 ${terminalId.substring(0, 8)} 发送输入失败。进程可能不支持 stdin 写入（如 bubblewrap 模式或进程已关闭 stdin）。`,
    };
  }

  private handleResize(
    manager: ReturnType<typeof getTerminalSessionManager>,
    terminalId: string,
    session: TerminalSession,
    cols?: number,
    rows?: number,
  ): ToolResult {
    if (!cols || !rows) {
      return {
        success: false,
        data: null,
        error: 'resize 操作需要提供 cols 和 rows 参数。',
      };
    }

    if (normalizeTerminalSessionStatus(session.status) !== 'running') {
      return {
        success: false,
        data: null,
        error: `终端会话 ${terminalId.substring(0, 8)} 当前状态为 ${session.status}，无法调整大小。`,
      };
    }

    const ok = manager.resizeSession(terminalId, cols, rows);
    if (ok) {
      return {
        success: true,
        data: `终端 ${terminalId.substring(0, 8)} 大小已调整为 ${cols}x${rows}。`,
      };
    }
    return {
      success: false,
      data: null,
      error: `调整终端 ${terminalId.substring(0, 8)} 大小失败。仅 PTY 模式支持 resize 操作。`,
    };
  }
}

export default TerminalControlTool;
