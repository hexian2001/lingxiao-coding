import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { existsSync, readdirSync, statSync, lstatSync, readlinkSync } from 'fs';
import { resolve } from 'path';
import { resolveWorkspacePath } from './utils.js';

const ListDirSchema = z.object({
  path: z.string().describe('目录路径'),
  depth: z.number().optional().describe('递归深度 (默认 2)'),
  include_hidden: z.boolean().optional().describe('是否包含隐藏文件/目录（以 . 开头），默认 false'),
});

export class ListDirTool extends Tool {
  readonly name = 'list_dir';
  readonly description = '列出目录内容（树形结构，支持符号链接标记）。用于浏览目录树结构；按文件名模式查找用 glob，按内容搜索用 code_search。';
  readonly parameters = ListDirSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof ListDirSchema>;
    let p: string;

    try {
      p = resolveWorkspacePath(context?.workspace, params.path, context?.sessionId);
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 检查路径是否存在
    if (!existsSync(p)) {
      return {
        success: false,
        data: null,
        error: `ERROR: 路径不存在：${params.path}`,
      };
    }

    // 检查是否是目录
    const stat = statSync(p);
    if (!stat.isDirectory()) {
      return {
        success: false,
        data: null,
        error: `ERROR: 不是目录：${params.path}`,
      };
    }

    // 验证 depth 参数
    if (params.depth !== undefined && (params.depth < 0 || params.depth > 20)) {
      return {
        success: false,
        data: null,
        error: `ERROR: depth 必须在 0-20 之间，当前值: ${params.depth}`,
      };
    }

    const depth = params.depth !== undefined ? params.depth : 2;

    try {
      const includeHidden = params.include_hidden ?? false;
      const lines = [params.path, ...this.walk(p, '', 0, depth, includeHidden)];
      return {
        success: true,
        data: lines.join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private walk(current: string, prefix: string, currentDepth: number, maxDepth: number, includeHidden: boolean): string[] {
    if (currentDepth >= maxDepth) {
      return [];
    }

    const result: string[] = [];

    let items: string[];
    try {
      items = readdirSync(current);
    } catch (error) {
      return [`${prefix}[权限不足]`];
    }

    // 排序：目录优先，按名称排序
    items.sort((a, b) => {
      const aStat = statSync(resolve(current, a));
      const bStat = statSync(resolve(current, b));
      if (aStat.isDirectory() && !bStat.isDirectory()) return -1;
      if (!aStat.isDirectory() && bStat.isDirectory()) return 1;
      return a.localeCompare(b);
    });

    // 过滤：忽略特定目录和隐藏文件
    const ignoreDirs = new Set([
      '.git',
      'node_modules',
      '__pycache__',
      '.venv',
      'venv',
      '.idea',
      'dist',
      'build',
    ]);

    const dirs: string[] = [];
    const files: string[] = [];

    for (const item of items) {
      if (item.startsWith('.') && !includeHidden) continue;
      
      const fullPath = resolve(current, item);
      try {
        const itemStat = statSync(fullPath);
        const lstat = lstatSync(fullPath);
        const isSymlink = lstat.isSymbolicLink();
        
        if (itemStat.isDirectory()) {
          if (!ignoreDirs.has(item)) {
            dirs.push(item);
          }
        } else {
          files.push(item);
        }
        
        // 如果是符号链接，添加标记
        if (isSymlink) {
          const linkTarget = readlinkSync(fullPath);
          if (itemStat.isDirectory()) {
            const idx = dirs.indexOf(item);
            if (idx !== -1) dirs[idx] = `${item} -> ${linkTarget} (符号链接)`;
          } else {
            const idx = files.indexOf(item);
            if (idx !== -1) files[idx] = `${item} -> ${linkTarget} (符号链接)`;
          }
        }
      } catch {
        // 忽略无法访问的文件
      }
    }

    const allItems = [...dirs, ...files];

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      const isLast = i === allItems.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      result.push(`${prefix}${connector}${item}`);

      if (dirs.includes(item) && currentDepth < maxDepth - 1) {
        const fullPath = resolve(current, item);
        const extension = isLast ? '    ' : '│   ';
        result.push(...this.walk(fullPath, prefix + extension, currentDepth + 1, maxDepth, includeHidden));
      }
    }

    return result;
  }
}

export default ListDirTool;
