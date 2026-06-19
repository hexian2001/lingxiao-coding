import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { CodeSearch } from './CodeSearch.js';

const CodeSearchSchema = z.object({
  pattern: z.string().describe('搜索模式 (支持正则)'),
  path: z.string().optional().describe('搜索路径 (默认工作区根目录)'),
  file_pattern: z.string().optional().describe('文件名模式如 *.py'),
  timeout: z.number().optional().describe('超时秒数 (默认 30)'),
  offset: z.number().int().min(0).optional().describe('跳过前 N 条匹配结果，默认 0'),
  limit: z.number().int().min(1).max(500).optional().describe('返回匹配行数量，默认按内部安全上限返回，最大 500。结果过多时会返回 continuation_tool_call'),
});

export class CodeSearchTool extends Tool {
  readonly name = 'code_search';
  readonly description = '在工作区中搜索代码/文本（支持正则表达式）。优先使用 ripgrep，回退到 grep + JS。使用 file_pattern 过滤文件类型（如 *.py, *.{ts,tsx}）可大幅提高搜索速度和准确性。按文件名模式查找用 glob，浏览目录树结构用 list_dir。';
  readonly parameters = CodeSearchSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof CodeSearchSchema>;

    const result = await CodeSearch.execute(
      params.pattern,
      params.path || '.',
      params.file_pattern,
      params.timeout || 30,
      context?.workspace,
      context?.sessionId,
      { offset: params.offset, limit: params.limit }
    );

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

export default CodeSearchTool;
