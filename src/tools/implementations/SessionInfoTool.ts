import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { getSessionScopeDescription, getSessionScopePaths } from './utils.js';

const SessionInfoSchema = z.object({});

export class SessionInfoTool extends Tool {
  readonly name = 'session_info';
  readonly description = '返回当前会话空间信息，包括 session 目录和 scratchpad 目录';
  readonly parameters = SessionInfoSchema;

  async execute(_args: unknown, context?: ToolContext): Promise<ToolResult> {
    try {
      const scope = getSessionScopePaths(context?.workspace, context?.sessionId);
      return {
        success: true,
        data: [
          '## 当前会话空间',
          getSessionScopeDescription(context?.workspace, context?.sessionId),
          '',
          '## 使用约定',
          '- 查找当前任务报告时，可优先读取当前 Scratchpad',
          '- 可使用 session_artifacts 列出并读取当前 session 的 scratchpad/context 文件',
          '- shell 命令可直接使用环境变量：$LINGXIAO_SESSION_ID / $LINGXIAO_SESSION_DIR / $LINGXIAO_SCRATCHPAD_DIR',
          '- 当前任务 scratchpad 命名规则：T-<任务号>_<角色>.md',
          '- 路径以本工具返回值和环境变量为准',
          '',
          '## 机器可读路径',
          `session_dir=${scope.sessionDir || '(unavailable)'}`,
          `scratchpad_dir=${scope.scratchpadDir || '(unavailable)'}`,
          `context_dir=${scope.contextDir || '(unavailable)'}`,
        ].join('\n'),
      };
    } catch (err: unknown) {
      return { success: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export default SessionInfoTool;
