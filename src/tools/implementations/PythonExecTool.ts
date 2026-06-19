import { z } from 'zod';
import { Tool, emitToolOutput, type ToolContext, type ToolResult } from '../Tool.js';
import { PythonExec, type PythonExecParams, type PythonOutputSink } from './PythonExec.js';
import { getToolPermissionContextFromToolContext } from '../../core/PermissionSystem.js';

const PythonExecSchema = z.object({
  code: z.string().describe('Python 代码'),
  timeout: z.number().int().optional().describe('超时秒数 (默认 30)'),
  max_output: z.number().int().optional().describe('最大输出字符数 (默认 20000)'),
});

export class PythonExecTool extends Tool {
  readonly name = 'python_exec';
  readonly description = '执行 Python 代码片段，返回 stdout';
  readonly parameters = PythonExecSchema;

  getExecutionTimeoutMs(args: unknown): number {
    const params = args as Partial<z.infer<typeof PythonExecSchema>>;
    const timeoutSeconds = typeof params?.timeout === 'number' && Number.isFinite(params.timeout) && params.timeout > 0
      ? params.timeout
      : 30;
    return Math.ceil(timeoutSeconds * 1000) + 5_000;
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof PythonExecSchema>;
    const permissionContext = getToolPermissionContextFromToolContext(context);
    // 流式输出闭包：把 Python 子进程逐 chunk stdout/stderr 推到 agent/leader 工具卡片（治本流式）
    const onOutput: PythonOutputSink | undefined = context?.emitter
      ? (chunk, stream) => emitToolOutput(context, this.name, { chunk, stream })
      : undefined;

    const result = await PythonExec.execute({
      ...params,
      permissionContext,
      workspace: typeof context?.workspace === 'string' ? context.workspace : undefined,
      sessionId: typeof context?.sessionId === 'string' ? context.sessionId : undefined,
      taskId: typeof context?.taskId === 'string' ? context.taskId : undefined,
      taskWorkingDirectory: typeof context?.taskWorkingDirectory === 'string' ? context.taskWorkingDirectory : undefined,
      taskWriteScope: Array.isArray(context?.taskWriteScope) ? context.taskWriteScope : undefined,
      onOutput,
    } as PythonExecParams);

    if (result.success) {
      return {
        success: true,
        data: result.data,
      };
    } else {
      return {
        success: false,
        data: null,
        error: result.error,
      };
    }
  }
}

export default PythonExecTool;
