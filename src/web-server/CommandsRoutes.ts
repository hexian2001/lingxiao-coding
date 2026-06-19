/**
 * CommandsRoutes — 自定义 slash 命令 REST API（全 CRUD）。
 *
 *   GET    /api/v1/commands           列出自定义命令（项目覆盖全局，按名去重）
 *   GET    /api/v1/commands/:name     读取单条（编辑回填，含完整 body）
 *   POST   /api/v1/commands           新建
 *   PUT    /api/v1/commands/:name     更新（name 变更则删旧）
 *   DELETE /api/v1/commands/:name     删除
 *
 * 读路径复用 CustomCommandLoader（collectCustomCommands / findCustomCommand，只读+5s TTL 缓存）；
 * 写路径走 CustomCommandService。写文件会更新命令目录 mtime，下次读取自动令缓存失效。
 * 镜像 RolesRoutes 的 sessionManager 工作区解析 + emitter 广播模式（'commands:changed'）。
 */

import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { AuthFn } from './types.js';
import { collectCustomCommands, findCustomCommand } from '../commands/CustomCommandLoader.js';
import { CustomCommandService } from '../commands/CustomCommandService.js';

interface CommandsRoutesDeps {
  requireServerToken: AuthFn;
  sessionManager?: SessionManager;
  emitter?: EventEmitter;
  /** Override the global commands dir (tests); defaults to ~/.lingxiao/commands. */
  globalCommandsDir?: string;
}

function resolveWorkspace(deps: CommandsRoutesDeps): string {
  try {
    const ids = deps.sessionManager?.getActiveSessionIds() ?? [];
    if (ids.length > 0) {
      const session = deps.sessionManager?.getSession(ids[0]);
      const workspace = (session as { workspace?: unknown } | undefined)?.workspace;
      if (typeof workspace === 'string' && workspace.trim()) return workspace;
    }
  } catch {
    // ignore and fall back
  }
  return process.cwd();
}

function emitChange(deps: CommandsRoutesDeps, payload: { action: string; name?: string }): void {
  try {
    deps.emitter?.emit('commands:changed', payload);
  } catch {
    // ignore — broadcast is best-effort
  }
}

function parseScope(value: unknown): 'project' | 'global' {
  return value === 'global' ? 'global' : 'project';
}

export function registerCommandsRoutes(fastify: FastifyInstance, deps: CommandsRoutesDeps): void {
  const { requireServerToken } = deps;

  // ── GET /api/v1/commands ────────────────────────────────────
  fastify.get('/api/v1/commands', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    const workspace = resolveWorkspace(deps);
    const commands = collectCustomCommands(workspace);
    return {
      data: commands.map((command) => ({
        name: command.name,
        slashName: command.slashName,
        description: command.description,
        agent: command.agent,
        source: command.source,
        path: command.path,
        editable: command.source === 'project' || command.source === 'global',
      })),
    };
  });

  // ── GET /api/v1/commands/:name ──────────────────────────────
  fastify.get<{ Params: { name: string } }>('/api/v1/commands/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    const workspace = resolveWorkspace(deps);
    const command = findCustomCommand(workspace, request.params.name);
    if (!command) {
      reply.status(404);
      return { error: 'command_not_found', message: `Command not found: ${request.params.name}` };
    }
    return {
      data: {
        name: command.name,
        slashName: command.slashName,
        description: command.description,
        agent: command.agent,
        source: command.source,
        path: command.path,
        body: command.body,
        editable: command.source === 'project' || command.source === 'global',
      },
    };
  });

  // ── POST /api/v1/commands ───────────────────────────────────
  fastify.post('/api/v1/commands', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const body = (request.body || {}) as { name?: string; description?: string; agent?: string; body?: string; scope?: string };
      const saved = new CustomCommandService({
        workspace: resolveWorkspace(deps),
        globalCommandsDir: deps.globalCommandsDir,
      }).saveCommand({
        name: body.name ?? '',
        description: body.description ?? '',
        agent: body.agent ?? '',
        body: body.body ?? '',
        scope: parseScope(body.scope),
      });
      emitChange(deps, { action: 'command_saved', name: saved.name });
      return { success: true, data: saved };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_command_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── PUT /api/v1/commands/:name ──────────────────────────────
  fastify.put<{ Params: { name: string } }>('/api/v1/commands/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const name = request.params.name;
      const body = (request.body || {}) as { name?: string; description?: string; agent?: string; body?: string; scope?: string };
      const scope = parseScope(body.scope);
      const service = new CustomCommandService({
        workspace: resolveWorkspace(deps),
        globalCommandsDir: deps.globalCommandsDir,
      });
      const saved = service.saveCommand({
        name: body.name ?? name,
        description: body.description ?? '',
        agent: body.agent ?? '',
        body: body.body ?? '',
        scope,
      });
      // Rename: if the saved name differs from the URL param, remove the old file.
      if (saved.name !== name) {
        service.deleteCommand(name, scope);
      }
      emitChange(deps, { action: 'command_saved', name: saved.name });
      return { success: true, data: saved };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_command_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── DELETE /api/v1/commands/:name ───────────────────────────
  fastify.delete<{ Params: { name: string }; Querystring: { scope?: string } }>('/api/v1/commands/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const name = request.params.name;
      const scope = parseScope((request.query as { scope?: string })?.scope);
      const removed = new CustomCommandService({
        workspace: resolveWorkspace(deps),
        globalCommandsDir: deps.globalCommandsDir,
      }).deleteCommand(name, scope);
      emitChange(deps, { action: 'command_deleted', name });
      return { success: true, name, removed, scope };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_command_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });
}
