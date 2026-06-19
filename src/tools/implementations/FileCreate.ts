import { existsSync } from 'fs';
import { z } from 'zod';
import { createToolError, Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { extname } from 'path';
import { getPythonSyntaxWarningAsync, resolveTaskWritePath, lockedAtomicWrite } from './utils.js';

const FileCreateSchema = z.object({
  path: z.string().describe('文件路径'),
  content: z.string().describe('文件内容'),
  overwrite: z.boolean().optional().describe('覆盖已有文件时必须显式设为 true；创建新文件可省略'),
});

const WRITE_TOOL_MIN_TIMEOUT_MS = 5 * 60_000;
const WRITE_TOOL_MAX_TIMEOUT_MS = 10 * 60_000;

function writeTimeoutForChars(chars: number): number {
  const mb = Math.ceil(Math.max(0, chars) / (1024 * 1024));
  return Math.min(WRITE_TOOL_MAX_TIMEOUT_MS, WRITE_TOOL_MIN_TIMEOUT_MS + mb * 30_000);
}

export class FileCreateTool extends Tool {
  readonly name = 'file_create';
  readonly description = '创建或覆盖文件（自动创建父目录，原子写入）。用途：新建文件或全量覆盖已有文件（overwrite=true）。增量修改已有文件请用 structured_patch。';
  readonly parameters = FileCreateSchema;

  getExecutionTimeoutMs(args: unknown): number {
    const params = args as Partial<z.infer<typeof FileCreateSchema>>;
    return writeTimeoutForChars(typeof params?.content === 'string' ? params.content.length : 0);
  }

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof FileCreateSchema>;
    let p: string;

    try {
      p = resolveTaskWritePath(
        context?.workspace,
        params.path,
        context?.sessionId,
        context?.taskWriteScope,
        context?.contractAllowedScope,
        'create',
      );
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      if (existsSync(p) && params.overwrite !== true) {
        return createToolError({
          code: 'FILE_CREATE_OVERWRITE_REQUIRED',
          message: `文件已存在，覆盖 ${params.path} 必须显式设置 overwrite=true。`,
          retryable: true,
          cause: '避免 LLM 误用 file_create 覆盖用户已有文件。',
          fix: '如果确认要覆盖，先读取文件确认内容，再重试并设置 overwrite=true；如果只是修改局部，改用 structured_patch。',
          next_tool: { name: 'file_read', args: { path: params.path } },
          example_args: { path: params.path, content: params.content.slice(0, 200), overwrite: true },
        });
      }

      const warningMsg = extname(p) === '.py' ? await getPythonSyntaxWarningAsync(params.content) : '';

      // Locked atomic write (creates parent dirs, serialized via file lock)
      await lockedAtomicWrite(p, params.content, { createDirs: true });

      return {
        success: true,
        data: `OK: 已创建文件 ${params.path} (${params.content.length} 字符)${warningMsg}`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export default FileCreateTool;
