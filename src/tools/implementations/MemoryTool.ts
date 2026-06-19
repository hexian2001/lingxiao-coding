import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { MemoryManager, type MemoryScope, type MemorySearchOptions } from '../../memory/MemoryManager.js';

type MemoryToolScope = MemoryScope | 'all';

const MemorySchema = z.object({
  action: z.enum(['save', 'load', 'search', 'list', 'delete', 'rebuild']).describe(
    'save=保存记忆, load=读取指定记忆, search=搜索相关记忆, list=列出记忆, delete=删除记忆, rebuild=重建索引',
  ),
  name: z.string().optional().describe('记忆名称 (save/load/delete 必填)，如 "user-preferences"'),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe(
    '记忆类型 (save 必填): user=用户偏好, feedback=做事准则, project=项目知识, reference=外部资源',
  ),
  description: z.string().optional().describe('一句话描述 (save 必填)，用于索引检索'),
  content: z.string().optional().describe('记忆正文 (save 必填)，Markdown 格式'),
  query: z.string().optional().describe('搜索关键词 (search 必填)'),
  scope: z.enum(['project', 'user', 'all']).optional().describe('作用域: project=项目级(.lingxiao/memory/), user=用户级(~/.lingxiao/memory/), all=先项目后用户。默认 project'),
  maxResults: z.number().int().positive().max(50).optional().describe('search/list 最大结果数，默认 search=20'),
});

function resolveWritableScope(scope: MemoryToolScope): MemoryScope | null {
  return scope === 'all' ? null : scope;
}

function resolveSearchOptions(scope: MemoryToolScope, maxResults?: number): MemorySearchOptions {
  return {
    scopes: scope === 'all' ? ['project', 'user'] : [scope],
    maxResults,
  };
}


// P0-1c: memory_read schema — read-only actions only
const MemoryReadSchema = z.object({
  action: z.enum(['load', 'search', 'list']).describe(
    'load=读取指定记忆, search=搜索相关记忆, list=列出记忆',
  ),
  name: z.string().optional().describe('记忆名称 (load 必填)'),
  query: z.string().optional().describe('搜索关键词 (search 必填)'),
  scope: z.enum(['project', 'user', 'all']).optional().describe('作用域'),
  maxResults: z.number().int().positive().max(50).optional().describe('最大结果数'),
});

// P0-1c: memory_write schema — write actions only
const MemoryWriteSchema = z.object({
  action: z.enum(['save', 'delete', 'rebuild']).describe(
    'save=保存记忆, delete=删除记忆, rebuild=重建索引',
  ),
  name: z.string().optional().describe('记忆名称 (save/delete 必填)'),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe('记忆类型'),
  description: z.string().optional().describe('一句话描述'),
  content: z.string().optional().describe('记忆正文'),
  scope: z.enum(['project', 'user', 'all']).optional().describe('作用域'),
});

export class MemoryTool extends Tool {
  readonly name = 'memory';
  readonly description = '轻量持久记忆系统 — 保存和检索项目级/用户级长期记忆。';
  readonly parameters = MemorySchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = args as z.infer<typeof MemorySchema>;
    const workspace = context?.workspace || process.cwd();
    const manager = new MemoryManager(workspace);
    const scope: MemoryToolScope = params.scope || 'project';

    try {
      switch (params.action) {
        case 'save': {
          const writableScope = resolveWritableScope(scope);
          if (!writableScope) return { success: false, data: null, error: 'save 需要 scope 为 project 或 user，不能使用 all' };
          if (!params.name) return { success: false, data: null, error: 'save 需要 name 参数' };
          if (!params.type) return { success: false, data: null, error: 'save 需要 type 参数' };
          if (!params.description) return { success: false, data: null, error: 'save 需要 description 参数' };
          if (!params.content) return { success: false, data: null, error: 'save 需要 content 参数' };

          const result = manager.saveMemory(params.name, params.type, params.description, params.content, writableScope);
          const scopeLabel = writableScope === 'user' ? '用户级' : '项目级';
          return {
            success: true,
            data: `已保存${scopeLabel}记忆 "${result.name}" (${result.fileName})\n${result.filePath}`,
          };
        }

        case 'load': {
          if (!params.name) return { success: false, data: null, error: 'load 需要 name 参数' };

          const result = scope === 'all'
            ? manager.readMemoryAcrossScopes(params.name)
            : manager.readMemory(params.name, scope);
          if (!result) {
            return { success: false, data: null, error: `记忆 "${params.name}" 不存在` };
          }
          return {
            success: true,
            data: [
              `## ${result.name} (${result.scope}/${result.type})`,
              result.description,
              '',
              `file: ${result.filePath}`,
              '',
              result.content,
            ].join('\n'),
          };
        }

        case 'search': {
          if (!params.query) return { success: false, data: null, error: 'search 需要 query 参数' };

          const formatted = scope === 'all'
            ? manager.searchAllAndFormat(params.query, resolveSearchOptions(scope, params.maxResults))
            : manager.searchAndFormat(params.query, scope, params.maxResults);
          return { success: true, data: formatted };
        }

        case 'list': {
          const entries = scope === 'all'
            ? manager.listAllMemories()
            : manager.listMemories(scope).map((entry) => ({ ...entry, scope }));
          const limited = params.maxResults ? entries.slice(0, params.maxResults) : entries;
          if (entries.length === 0) {
            const label = scope === 'all' ? '长期' : scope === 'user' ? '用户级' : '项目级';
            return { success: true, data: `暂无${label}记忆` };
          }
          const lines = limited.map(e => `- [${e.name}](${e.fileName}) (${e.scope}) - ${e.description}`);
          return { success: true, data: lines.join('\n') };
        }

        case 'delete': {
          const writableScope = resolveWritableScope(scope);
          if (!writableScope) return { success: false, data: null, error: 'delete 需要 scope 为 project 或 user，不能使用 all' };
          if (!params.name) return { success: false, data: null, error: 'delete 需要 name 参数' };

          const ok = manager.deleteMemory(params.name, writableScope);
          if (!ok) {
            return { success: false, data: null, error: `记忆 "${params.name}" 不存在或删除失败` };
          }
          return { success: true, data: `已删除记忆 "${params.name}"` };
        }

        case 'rebuild': {
          if (scope === 'all') {
            manager.rebuildIndex('project');
            manager.rebuildIndex('user');
            return { success: true, data: '已重建项目级和用户级记忆索引' };
          }
          manager.rebuildIndex(scope);
          return { success: true, data: `已重建${scope === 'user' ? '用户级' : '项目级'}记忆索引` };
        }

        default:
          return { success: false, data: null, error: `未知 action: ${params.action}` };
      }
    } catch (err: unknown) {
      return { success: false, data: null, error: `记忆操作失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}


/**
 * P0-1c: memory_read — read-only memory tool (load/search/list).
 * Tier=read, so read-restricted roles (explore, research, review, planner) can use it.
 */
export class MemoryReadTool extends Tool {
  readonly name = 'memory_read';
  readonly description = '只读记忆检索 — 读取、搜索和列出长期记忆。不能修改记忆。';
  readonly parameters = MemoryReadSchema;

  private readonly delegate = new MemoryTool();

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    return this.delegate.execute(args, context);
  }
}

/**
 * P0-1c: memory_write — write memory tool (save/delete/rebuild).
 * Tier=write, so only full-tier roles (coding, verify, frontend, backend, fullstack, etc.) can use it.
 */
export class MemoryWriteTool extends Tool {
  readonly name = 'memory_write';
  readonly description = '写入记忆 — 保存、删除和重建长期记忆索引。';
  readonly parameters = MemoryWriteSchema;

  private readonly delegate = new MemoryTool();

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    return this.delegate.execute(args, context);
  }
}
