import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { parseFile } from './FileParser.js';
import { existsSync } from 'fs';

const ParseFileSchema = z.object({
  path: z.string().describe('文件路径（必须是已上传的文件路径）'),
  mode: z.enum(['preview', 'full', 'page', 'sheet']).optional().describe('解析模式：preview=快速预览(默认), full=完整内容, page=指定页码(PDF), sheet=指定工作表(Excel)'),
  page: z.number().optional().describe('mode=page 时指定页码（1-based）'),
  sheet: z.string().optional().describe('mode=sheet 时指定工作表名称'),
});

export class ParseFileTool extends Tool {
  readonly name = 'parse_file';
  readonly description = '解析文件内容，支持 PDF/Word/Excel/CSV/PowerPoint/ZIP 等格式。可分页/分 sheet 提取。';
  readonly parameters = ParseFileSchema;

  async execute(args: unknown, _context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ParseFileSchema>;

    try {
      if (!existsSync(params.path)) {
        return {
          success: false,
          data: null,
          error: `文件不存在: ${params.path}`,
        };
      }

      const result = await parseFile(
        params.path,
        params.mode || 'preview',
        { page: params.page, sheet: params.sheet }
      );

      const lines = [
        `[格式: ${result.format}]`,
      ];
      if (result.metadata?.pages) lines.push(`[页数: ${result.metadata.pages}]`);
      if (typeof result.metadata?.hasTextLayer === 'boolean') {
        lines.push(`[PDF 文本层: ${result.metadata.hasTextLayer ? '有' : '无 / 疑似扫描件'}]`);
      }
      if (result.metadata?.sheets) lines.push(`[工作表: ${result.metadata.sheets.join(', ')}]`);
      if (result.metadata?.slides) lines.push(`[幻灯片: ${result.metadata.slides.length}]`);
      if (result.metadata?.entries) lines.push(`[条目数: ${result.metadata.entries.length}]`);
      if (result.truncated) lines.push('[⚠ 内容已截断，如需完整内容请使用 mode=full]');
      lines.push('---');
      lines.push(result.metadata?.plainText || result.content);

      return {
        success: true,
        data: lines.join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `解析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export default ParseFileTool;
