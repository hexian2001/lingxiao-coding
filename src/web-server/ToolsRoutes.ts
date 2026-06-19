/**
 * ToolsRoutes — 工具管理 REST API
 *
 *   GET    /api/v1/tools                  列出所有工具（builtin + user）
 *   POST   /api/v1/tools                  创建用户自定义工具
 *   PATCH  /api/v1/tools/:name            更新用户工具或切换启用状态（builtin 仅支持 enabled 切换）
 *   DELETE /api/v1/tools/:name            删除用户工具（builtin 拒绝）
 *   POST   /api/v1/tools/:name/test       立即调用工具（不进入 LLM 循环）
 *
 * 写入路径：
 *   - 修改 runtimeConfig.tools → ConfigSchema.parse → saveSettings
 *   - 同步主进程 Registry：register/unregister/replace
 *   - 广播 'tools:changed' 事件，LeaderAgent / 前端 SSE 订阅
 *
 * 不实现：
 *   - 工具市场、版本管理、导入导出（YAGNI）
 */

import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { AuthFn } from './types.js';
import {
  config as runtimeConfig,
  saveSettings,
  ConfigSchema,
  UserToolSpecSchema,
  type UserToolSpec,
} from '../config.js';
import { buildUserTool } from '../tools/UserToolFactory.js';
import { ToolRegistry } from '../tools/Registry.js';
import { LEADER_META_TOOLS, BUGHUNT_TOOLS, OFFICE_TOOL_NAMES } from '../contracts/constants/leaderToolDefinitions.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';

interface ToolsRoutesDeps {
  requireServerToken: AuthFn;
  sessionManager?: SessionManager;
  emitter?: EventEmitter;
}

interface ToolListItem {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'leader-meta';
  kind?: 'http' | 'shell' | 'python';
  enabled: boolean;
  parameters?: unknown;
  spec?: UserToolSpec;
  requiresRestart?: boolean;
  warning?: string;
  /** Leader 元工具：read-only，前端不允许 enable/disable/edit/delete */
  readOnly?: boolean;
  /** Leader 元工具的可见范围标签 */
  scope?: 'leader-meta' | 'leader-bughunt';
  /** 延迟加载工具：列表展示不会实例化，首次真实调用才加载 */
  deferred?: boolean;
  /** 当前运行模式可能隐藏该工具 */
  runtimeGated?: boolean;
  /** 当前会话模式下是否确认可用；undefined 表示列表接口无法判定 */
  availableInCurrentMode?: boolean;
}

function getToolsCfg(): { user_defined: UserToolSpec[]; disabled_names: string[] } {
  const cfg = (runtimeConfig as { tools?: { user_defined?: UserToolSpec[]; disabled_names?: string[] } }).tools;
  return {
    user_defined: Array.isArray(cfg?.user_defined) ? [...(cfg!.user_defined as UserToolSpec[])] : [],
    disabled_names: Array.isArray(cfg?.disabled_names) ? [...(cfg!.disabled_names as string[])] : [],
  };
}

function persistToolsCfg(next: { user_defined: UserToolSpec[]; disabled_names: string[] }): void {
  const cfg = runtimeConfig as { tools?: { user_defined: UserToolSpec[]; disabled_names: string[] } };
  cfg.tools = {
    user_defined: next.user_defined,
    disabled_names: Array.from(new Set(next.disabled_names)),
  };
  ConfigSchema.parse(runtimeConfig);
  saveSettings(runtimeConfig);
}

type SessionScopedToolManager = SessionManager & {
  getSessionToolRegistry?: (sessionId?: string) => ToolRegistry | undefined;
};

function findRegistry(deps: ToolsRoutesDeps, sessionId?: string): ToolRegistry | null {
  if (!deps.sessionManager) return null;
  try {
    const manager = deps.sessionManager as SessionScopedToolManager;
    if (typeof manager.getSessionToolRegistry === 'function') {
      if (!sessionId) return null;
      return manager.getSessionToolRegistry(sessionId) ?? null;
    }
    const reg = deps.sessionManager.getWorkflowEngine().getToolRegistry();
    return reg instanceof ToolRegistry ? reg : (reg as unknown as ToolRegistry);
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

type SessionIdSource = 'query' | 'body' | 'active_session' | 'none';

type SessionIdResolution =
  | { ok: true; sessionId?: string; source: SessionIdSource }
  | { ok: false; error: 'invalid_session_id'; message: string };

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function ownSessionId(input: Record<string, unknown>): { present: boolean; value?: unknown } {
  return Object.prototype.hasOwnProperty.call(input, 'sessionId')
    ? { present: true, value: input.sessionId }
    : { present: false };
}

function parseExplicitSessionId(value: unknown, source: 'query' | 'body'): SessionIdResolution {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      error: 'invalid_session_id',
      message: `sessionId from ${source} must be a non-empty string`,
    };
  }
  return { ok: true, sessionId: value.trim(), source };
}

function resolveRequestedSessionId(deps: ToolsRoutesDeps, requestLike: { query?: unknown; body?: unknown }): SessionIdResolution {
  const query = ownSessionId(objectRecord(requestLike.query));
  if (query.present) return parseExplicitSessionId(query.value, 'query');

  const body = ownSessionId(objectRecord(requestLike.body));
  if (body.present) return parseExplicitSessionId(body.value, 'body');

  const activeSessionId = deps.sessionManager?.getActiveSessionIds()[0];
  return activeSessionId
    ? { ok: true, sessionId: activeSessionId, source: 'active_session' }
    : { ok: true, source: 'none' };
}

function sessionIdErrorPayload(error: Extract<SessionIdResolution, { ok: false }>) {
  return { error: error.error, message: error.message };
}

function toolRegistryUnavailablePayload(scope: Extract<SessionIdResolution, { ok: true }>) {
  return {
    error: 'tool_registry_unavailable',
    message: scope.source === 'none'
      ? 'No active session — tool registry not ready.'
      : `Tool registry is not ready for ${scope.source} session.`,
  };
}

function isOfficeTool(name: string): boolean {
  return (OFFICE_TOOL_NAMES as readonly string[]).includes(name);
}

function isOfficeModeEnabled(deps: ToolsRoutesDeps, sessionId?: string): boolean {
  if (!sessionId || !deps.sessionManager) return false;
  try {
    const db = deps.sessionManager.getDatabaseManager();
    return db.getSessionState(sessionId, SESSION_KEYS.OFFICE_MODE_ACTIVE) === 'true';
  } catch {/* expected: operation may fail */
    return false;
  }
}

function emitChange(
  deps: ToolsRoutesDeps,
  payload: { action: 'register' | 'unregister' | 'replace' | 'enable' | 'disable'; name: string },
): void {
  try {
    deps.emitter?.emit('tools:changed', payload);
  } catch (err) {
    // 监听器抛出会静默打断 tool 变更传播，导致 Web UI 工具列表与后端失步；debug 记录以便定位。
    console.debug('[ToolsRoutes] tools:changed 监听器抛出，已忽略:', err instanceof Error ? err.message : String(err));
  }
}

export function registerToolsRoutes(fastify: FastifyInstance, deps: ToolsRoutesDeps): void {
  const { requireServerToken } = deps;

  // ── GET /api/v1/tools ───────────────────────────────────────
  fastify.get('/api/v1/tools', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const session = resolveRequestedSessionId(deps, request);
    if (!session.ok) {
      reply.status(400);
      return sessionIdErrorPayload(session);
    }
    const registry = findRegistry(deps, session.sessionId);
    if (!registry) {
      reply.status(503);
      return toolRegistryUnavailablePayload(session);
    }
    const cfg = getToolsCfg();
    const officeMode = isOfficeModeEnabled(deps, session.sessionId);
    const userByName = new Map(cfg.user_defined.map((u) => [u.name, u] as const));
    const disabledSet = new Set(cfg.disabled_names);

    const all = registry.getLoaded().filter((t) => officeMode || !isOfficeTool(t.name));
    const items: ToolListItem[] = all.map((t) => {
      const userSpec = userByName.get(t.name);
      let parameters: unknown = undefined;
      try {
        parameters = typeof (t as { getSchema?: () => unknown }).getSchema === 'function' ? (t as { getSchema: () => unknown }).getSchema() : undefined;
      } catch {/* swallowed: unhandled error */
        parameters = undefined;
      }
      const item: ToolListItem = {
        name: t.name,
        description: t.description,
        source: userSpec ? 'user' : 'builtin',
        enabled: !disabledSet.has(t.name),
        parameters,
      };
      if (userSpec) {
        item.kind = userSpec.kind;
        item.spec = userSpec;
      }
      return item;
    });

    for (const name of registry.getDeferredNames()) {
      if (!officeMode && isOfficeTool(name)) continue;
      if (items.some((i) => i.name === name)) continue;
      const userSpec = userByName.get(name);
      items.push({
        name,
        description: userSpec?.description ?? '延迟加载工具；首次真实调用时实例化',
        source: userSpec ? 'user' : 'builtin',
        kind: userSpec?.kind,
        enabled: !disabledSet.has(name),
        spec: userSpec,
        deferred: true,
      });
    }

    // 用户工具可能因为 disabled_names 没有进入 registry，但前端依然要看到它们
    for (const u of cfg.user_defined) {
      if (items.some((i) => i.name === u.name)) continue;
      items.push({
        name: u.name,
        description: u.description,
        source: 'user',
        kind: u.kind,
        enabled: false,
        spec: u,
      });
    }

    // 内置工具禁用后会从 registry 中移除；列表仍需显示占位，方便用户重新启用。
    const userNames = new Set(cfg.user_defined.map((u) => u.name));
    for (const name of disabledSet) {
      if (!officeMode && isOfficeTool(name)) continue;
      if (userNames.has(name)) continue;
      if (items.some((i) => i.name === name)) continue;
      items.push({
        name,
        description: '内置工具已禁用；重新启用后需重启进程恢复运行时注册。',
        source: 'builtin',
        enabled: false,
        requiresRestart: true,
        warning: 'builtin_tool_reenable_requires_restart',
      });
    }

    items.sort((a, b) => {
      if (a.source !== b.source) {
        const order: Record<ToolListItem['source'], number> = { builtin: 0, 'leader-meta': 1, user: 2 };
        return order[a.source] - order[b.source];
      }
      return a.name.localeCompare(b.name);
    });

    // Leader 元工具可能已注册到 Registry；若当前列表里还没有，则补充 read-only 展示项。
    const builtinNames = new Set(items.map((i) => i.name));
    const appendLeaderMeta = (
      defs: ReadonlyArray<{ function: { name: string; description?: string; parameters?: unknown } }>,
      scope: 'leader-meta' | 'leader-bughunt',
    ) => {
      for (const def of defs) {
        const name = def.function.name;
        if (builtinNames.has(name)) continue; // 已经在普通注册表里就别重复
        items.push({
          name,
          description: def.function.description || '',
          source: 'leader-meta',
          enabled: false,
          parameters: def.function.parameters,
          readOnly: true,
          scope,
          runtimeGated: true,
          availableInCurrentMode: undefined,
          warning: 'leader_meta_runtime_gated',
        });
        builtinNames.add(name);
      }
    };
    appendLeaderMeta(LEADER_META_TOOLS, 'leader-meta');
    appendLeaderMeta(BUGHUNT_TOOLS, 'leader-bughunt');

    return { tools: items };
  });

  // ── POST /api/v1/tools ──────────────────────────────────────
  fastify.post('/api/v1/tools', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const session = resolveRequestedSessionId(deps, request);
    if (!session.ok) {
      reply.status(400);
      return sessionIdErrorPayload(session);
    }
    const registry = findRegistry(deps, session.sessionId);
    if (!registry) {
      reply.status(503);
      return toolRegistryUnavailablePayload(session);
    }

    const parsed = UserToolSpecSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'invalid_spec',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    const spec: UserToolSpec = { ...parsed.data, created_at: Date.now(), updated_at: Date.now() };

    if (registry.has(spec.name)) {
      reply.status(409);
      return { error: 'name_conflict', message: `工具 "${spec.name}" 已存在（与内置或现有用户工具同名）` };
    }

    const cfg = getToolsCfg();
    cfg.user_defined.push(spec);
    persistToolsCfg(cfg);

    if (spec.enabled !== false && !cfg.disabled_names.includes(spec.name)) {
      try {
        registry.register(buildUserTool(spec));
      } catch (err) {
        reply.status(500);
        return { error: 'register_failed', message: err instanceof Error ? err.message : String(err) };
      }
    }
    emitChange(deps, { action: 'register', name: spec.name });
    return { success: true, tool: spec };
  });

  // ── PATCH /api/v1/tools/:name ───────────────────────────────
  fastify.patch('/api/v1/tools/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const session = resolveRequestedSessionId(deps, request);
    if (!session.ok) {
      reply.status(400);
      return sessionIdErrorPayload(session);
    }
    const registry = findRegistry(deps, session.sessionId);
    if (!registry) {
      reply.status(503);
      return toolRegistryUnavailablePayload(session);
    }
    const { name } = request.params as { name: string };
    // Leader 元工具是 read-only，禁止任何修改。
    if (
      LEADER_META_TOOLS.some((t) => t.function.name === name) ||
      BUGHUNT_TOOLS.some((t) => t.function.name === name)
    ) {
      reply.status(403);
      return { error: 'leader_meta_readonly', message: 'Leader 元工具仅展示，不允许启用/禁用或编辑' };
    }
    const body = (request.body || {}) as { enabled?: boolean; spec?: unknown };
    const cfg = getToolsCfg();
    const userIdx = cfg.user_defined.findIndex((u) => u.name === name);
    const isUser = userIdx >= 0;

    // 仅支持 enabled 切换的快速路径（builtin 与 user 都适用）
    if (typeof body.enabled === 'boolean' && body.spec === undefined) {
      const wasDisabled = cfg.disabled_names.includes(name);
      if (body.enabled && wasDisabled) {
        cfg.disabled_names = cfg.disabled_names.filter((n) => n !== name);
        persistToolsCfg(cfg);
        // 重新注册
        if (isUser) {
          const spec = cfg.user_defined[userIdx];
          if (spec.enabled !== false) {
            try {
              registry.register(buildUserTool(spec));
            } catch (err) {
              reply.status(500);
              return { error: 'register_failed', message: err instanceof Error ? err.message : String(err) };
            }
          }
        }
        // builtin：禁用后已 unregister，需要重启进程才能恢复（settings 已更新，下次启动生效）
        emitChange(deps, { action: 'enable', name });
        return {
          success: true,
          enabled: true,
          ...(isUser
            ? { requiresRestart: false }
            : {
                requiresRestart: true,
                warning: 'builtin_tool_reenable_requires_restart',
                message: '内置工具已从禁用列表移除；重启进程后恢复运行时注册',
              }),
        };
      }
      if (!body.enabled && !wasDisabled) {
        cfg.disabled_names.push(name);
        persistToolsCfg(cfg);
        registry.unregister(name);
        emitChange(deps, { action: 'disable', name });
        return { success: true, enabled: false };
      }
      return { success: true, enabled: body.enabled };
    }

    // 完整 spec 更新（仅用户工具）
    if (!isUser) {
      reply.status(400);
      return { error: 'cannot_modify_builtin', message: '内置工具仅支持启用/禁用切换' };
    }
    const merged = { ...cfg.user_defined[userIdx], ...(body.spec as Record<string, unknown> | undefined) };
    const parsed = UserToolSpecSchema.safeParse(merged);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: 'invalid_spec',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    const next: UserToolSpec = { ...parsed.data, name, updated_at: Date.now() };
    cfg.user_defined[userIdx] = next;
    persistToolsCfg(cfg);

    // 同步 Registry
    registry.unregister(name);
    if (next.enabled !== false && !cfg.disabled_names.includes(name)) {
      try {
        registry.register(buildUserTool(next));
      } catch (err) {
        reply.status(500);
        return { error: 'register_failed', message: err instanceof Error ? err.message : String(err) };
      }
    }
    emitChange(deps, { action: 'replace', name });
    return { success: true, tool: next };
  });

  // ── DELETE /api/v1/tools/:name ──────────────────────────────
  fastify.delete('/api/v1/tools/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const session = resolveRequestedSessionId(deps, request);
    if (!session.ok) {
      reply.status(400);
      return sessionIdErrorPayload(session);
    }
    const registry = findRegistry(deps, session.sessionId);
    if (!registry) {
      reply.status(503);
      return toolRegistryUnavailablePayload(session);
    }
    const { name } = request.params as { name: string };
    if (
      LEADER_META_TOOLS.some((t) => t.function.name === name) ||
      BUGHUNT_TOOLS.some((t) => t.function.name === name)
    ) {
      reply.status(403);
      return { error: 'leader_meta_readonly', message: 'Leader 元工具仅展示，不允许删除' };
    }
    const cfg = getToolsCfg();
    const idx = cfg.user_defined.findIndex((u) => u.name === name);
    if (idx < 0) {
      reply.status(400);
      return { error: 'cannot_delete_builtin', message: '只能删除用户自定义工具；内置工具请使用 disable' };
    }
    cfg.user_defined.splice(idx, 1);
    cfg.disabled_names = cfg.disabled_names.filter((n) => n !== name);
    persistToolsCfg(cfg);
    registry.unregister(name);
    emitChange(deps, { action: 'unregister', name });
    return { success: true, name };
  });

  // ── POST /api/v1/tools/:name/test ───────────────────────────
  fastify.post('/api/v1/tools/:name/test', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const session = resolveRequestedSessionId(deps, request);
    if (!session.ok) {
      reply.status(400);
      return sessionIdErrorPayload(session);
    }
    const registry = findRegistry(deps, session.sessionId);
    if (!registry) {
      reply.status(503);
      return toolRegistryUnavailablePayload(session);
    }
    const { name } = request.params as { name: string };
    const body = (request.body || {}) as { args?: Record<string, unknown> };

    if (isOfficeTool(name) && !isOfficeModeEnabled(deps, session.sessionId)) {
      reply.status(403);
      return {
        error: 'office_mode_required',
        message: 'Office 工具仅在当前会话开启 Office 模式后可测试或执行。请先使用 /office on 或前端 Office 开关。',
      };
    }

    const tool = registry.get(name);
    if (!tool) {
      reply.status(404);
      return { error: 'tool_not_found', message: `工具 "${name}" 不存在或已禁用` };
    }

    try {
      const started = Date.now();
      const result = await registry.execute(name, body.args ?? {}, {
        db: deps.sessionManager?.getDatabaseManager(),
        workspace: session.sessionId ? deps.sessionManager?.getSession(session.sessionId)?.workspace || process.cwd() : process.cwd(),
        sessionId: session.sessionId,
        agentName: 'tools_test_runner',
      });
      return {
        success: result.success,
        mode: 'isolated_tool_context',
        warning: '工具测试只提供 workspace/agentName，不等同于真实 Agent 会话上下文',
        durationMs: Date.now() - started,
        data: result.data,
        error: result.error,
      };
    } catch (err) {
      reply.status(500);
      return { error: 'execute_failed', message: err instanceof Error ? err.message : String(err) };
    }
  });
}
