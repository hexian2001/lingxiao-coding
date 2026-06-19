import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolve, relative } from 'path';
import { statSync } from 'fs';

const GlobSchema = z.object({
  pattern: z.string().describe('glob 模式，例如 "**/*.ts"、"src/**/*.{js,ts}"'),
  path: z.string().optional().describe('搜索根目录（默认为工作区根目录）'),
  limit: z.number().int().positive().optional().default(100).describe('最多返回条数（默认 100）'),
  offset: z.number().int().min(0).optional().default(0).describe('跳过前 N 个结果（默认 0）'),
  include_hidden: z.boolean().optional().default(false).describe('是否包含隐藏文件，默认 false。开启后不过滤 .lingxiao/sessions 目录'),
});

export class GlobTool extends Tool {
  readonly name = 'glob';
  readonly description =
    '文件模式搜索：使用 glob 模式匹配文件路径，返回按修改时间降序排列的文件列表。按内容搜索用 code_search，浏览目录树结构用 list_dir。';
  readonly parameters = GlobSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof GlobSchema>;
    const workspace = context?.workspace || process.cwd();
    const searchRoot = params.path ? resolve(workspace, params.path) : resolve(workspace);
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const includeHidden = params.include_hidden ?? false;

    try {
      // 动态导入 glob（ESM 包）
      const { glob } = await import('glob');

      const ignorePatterns = includeHidden
        ? ['**/node_modules/**', '**/.git/**']
        : ['**/node_modules/**', '**/.git/**', '**/.lingxiao/sessions/**'];

      const matches = await glob(params.pattern, {
        cwd: searchRoot,
        nodir: false,
        dot: includeHidden,
        absolute: true,
        ignore: ignorePatterns,
      });

      // 按修改时间降序排序
      const withMtime: Array<{ path: string; mtime: number }> = [];
      for (const m of matches) {
        try {
          const st = statSync(m);
          withMtime.push({ path: m, mtime: st.mtimeMs });
        } catch (err) {
          // 无法 stat（权限/IO/断链）：mtime 退 0 沉到排序底部；debug 记录路径，便于诊断为何文件不浮现。
          console.debug(`[GlobTool] stat 失败，mtime 退 0: ${m}`, err instanceof Error ? err.message : String(err));
          withMtime.push({ path: m, mtime: 0 });
        }
      }
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const total = withMtime.length;
      const paged = withMtime.slice(offset, offset + limit);
      const relPaths = paged.map(({ path: p }) => {
        try { return relative(workspace, p); } catch {/* swallowed: unhandled error */ return p; }
      });

      if (relPaths.length === 0) {
        return {
          success: true,
          data: `没有匹配 "${params.pattern}" 的文件${params.path ? `（在 ${params.path} 中）` : ''}`,
        };
      }

      const header = total > limit + offset
        ? `共 ${total} 个匹配，显示第 ${offset + 1}-${offset + relPaths.length} 个：`
        : `共 ${total} 个匹配：`;

      return {
        success: true,
        data: `${header}\n${relPaths.join('\n')}`,
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

export default GlobTool;
