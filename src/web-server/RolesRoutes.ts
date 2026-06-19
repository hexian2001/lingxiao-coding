/**
 * RolesRoutes — Agent 角色与工具配置 REST API
 *
 *   GET    /api/v1/roles                列出所有角色（内置 + 自定义），含 tools / tier / 是否被 override
 *   GET    /api/v1/roles/basic-tools    返回默认基础工具集（read/write/搜索/python/shell/structured_patch）
 *   PATCH  /api/v1/roles/settings       更新 settings.roles.basic_tools_enabled
 *   PATCH  /api/v1/roles/:name          更新某角色的 tools_added / tools_removed
 *   DELETE /api/v1/roles/:name/override 清空某角色的 override
 *
 * 写入路径：runtimeConfig.roles → ConfigSchema.parse → saveSettings；
 * 同时给 emitter 抛 'roles:changed'，让 Leader/SessionManager 在下一次注册时拿到新值。
 *
 * 本路由"不"动态修改已经注册到 RoleRegistry 中的角色（避免运行时和已派活的 task 之间状态错位）；
 * 改动会在下一次 leader 启动 / session 创建时生效，前端需提示用户。
 */

import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { AuthFn } from './types.js';
import {
  config as runtimeConfig,
  saveSettings,
  ConfigSchema,
} from '../config.js';
import {
  DEFAULT_BASIC_TOOLS,
  PRESET_ROLE_PROFILES,
  createPresetAgentRole,
  applyRoleToolsConfig,
  type AgentRole,
  type AgentRoleSurfaceItem,
  type PresetRoleName,
  type RoleToolsOverride,
} from '../contracts/types/Agent.js';
import { t } from '../i18n.js';
import {
  AgentDefinitionService,
  type AgentDefinitionRecord,
  type AgentDefinitionScope,
  type AgentWorkerBackend,
  type SaveAgentDefinitionInput,
  validateAgentDefinitionName,
} from '../agents/AgentDefinitionService.js';
import { collectAvailableSkills, resolveDisabledSkillNames } from '../core/SkillCatalog.js';

type ExternalAgentAvailabilityProvider = () => ExternalAgentAvailabilityLite;

interface ExternalAgentAvailabilityLite {
  claude: { installed: boolean };
  codex: { installed: boolean };
}

interface RolesRoutesDeps {
  requireServerToken: AuthFn;
  sessionManager?: SessionManager;
  emitter?: EventEmitter;
  getExternalAgentAvailability?: ExternalAgentAvailabilityProvider;
  agentDefinitionsGlobalDir?: string;
}

function getRolesCfg(): {
  basic_tools_enabled: boolean;
  overrides: Record<string, RoleToolsOverride>;
} {
  const cfg = (runtimeConfig as { roles?: { basic_tools_enabled?: boolean; overrides?: Record<string, RoleToolsOverride> } }).roles;
  return {
    basic_tools_enabled: cfg?.basic_tools_enabled !== false,
    overrides: cfg?.overrides ? { ...cfg.overrides } : {},
  };
}

function persistRolesCfg(next: { basic_tools_enabled: boolean; overrides: Record<string, RoleToolsOverride> }): void {
  const cfg = runtimeConfig as { roles?: { basic_tools_enabled: boolean; overrides: Record<string, RoleToolsOverride> } };
  // 把空 override 清掉，避免 settings.json 越积越脏
  const cleanOverrides: Record<string, RoleToolsOverride> = {};
  for (const [name, ov] of Object.entries(next.overrides)) {
    const added = (ov.tools_added || []).filter(Boolean);
    const removed = (ov.tools_removed || []).filter(Boolean);
    if (added.length === 0 && removed.length === 0) continue;
    cleanOverrides[name] = { tools_added: added, tools_removed: removed };
  }
  cfg.roles = {
    basic_tools_enabled: next.basic_tools_enabled,
    overrides: cleanOverrides,
  };
  ConfigSchema.parse(runtimeConfig);
  saveSettings(runtimeConfig);
}

function emitChange(deps: RolesRoutesDeps, payload: { action: string; name?: string }): void {
  try {
    deps.emitter?.emit('roles:changed', payload);
  } catch {
    // ignore
  }
}

function getActiveLeaderRoles(deps: RolesRoutesDeps): AgentRole[] | null {
  if (!deps.sessionManager) return null;
  try {
    const ids = deps.sessionManager.getActiveSessionIds();
    if (ids.length === 0) return null;
    const session = deps.sessionManager.getSession(ids[0]);
    const leader = session?.leader as { getRoleRegistry?: () => { listRoles: () => AgentRole[] } } | undefined;
    if (!leader || typeof leader.getRoleRegistry !== 'function') return null;
    const registry = leader.getRoleRegistry();
    return registry?.listRoles?.() ?? null;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function resolveWorkspace(deps: RolesRoutesDeps): string {
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

function getAgentDefinitionService(deps: RolesRoutesDeps): AgentDefinitionService {
  return new AgentDefinitionService({
    workspace: resolveWorkspace(deps),
    globalAgentsDir: deps.agentDefinitionsGlobalDir,
  });
}

function resolveExternalAgentAvailability(deps: RolesRoutesDeps): ExternalAgentAvailabilityLite {
  const provider = deps.getExternalAgentAvailability;
  if (!provider) {
    return {
      claude: { installed: false },
      codex: { installed: false },
    };
  }
  try {
    const availability = provider();
    return {
      claude: { installed: availability.claude.installed === true },
      codex: { installed: availability.codex.installed === true },
    };
  } catch {
    return {
      claude: { installed: false },
      codex: { installed: false },
    };
  }
}

function buildStaticFallbackRoles(deps: RolesRoutesDeps): AgentRole[] {
  const roles = (Object.keys(PRESET_ROLE_PROFILES) as PresetRoleName[])
    .map((name) => createPresetAgentRole(name));
  const availability = resolveExternalAgentAvailability(deps);

  if (availability.claude.installed) {
    roles.push({
      name: 'claude_coding',
      description: t('external_agent.role.claude_coding.description'),
      systemPrompt: '',
      tools: [],
      createdBy: 'system',
      worker_backend: 'claude',
    });
  }

  if (availability.codex.installed) {
    roles.push({
      name: 'codex_coding',
      description: t('external_agent.role.codex_coding.description'),
      systemPrompt: '',
      tools: [],
      createdBy: 'system',
      worker_backend: 'codex',
      worker_config: { wire_api: 'chat' },
    });
  }

  try {
    const workspace = resolveWorkspace(deps);
    const disabledNames = resolveDisabledSkillNames();
    const availableSkills = collectAvailableSkills(workspace, { disabledNames });
    roles.push(...new AgentDefinitionService({
      workspace,
      globalAgentsDir: deps.agentDefinitionsGlobalDir,
    }).listAgentRoles(availableSkills) as AgentRole[]);
  } catch {
    // A malformed custom agent must not make the whole settings page unusable.
  }

  return roles;
}

function buildRoleSurface(
  role: AgentRole,
  override: RoleToolsOverride,
  basicEnabled: boolean,
  runtime = true,
  definition?: AgentDefinitionRecord,
): AgentRoleSurfaceItem {
  const baselineName = role.capabilityProfile?.baselineRole;
  const presetProfile = baselineName && baselineName in PRESET_ROLE_PROFILES
    ? PRESET_ROLE_PROFILES[baselineName as PresetRoleName]
    : undefined;
  const profileTools = presetProfile
    ? [...presetProfile.tools]
    : [...role.tools];
  const adjusted = applyRoleToolsConfig(role, {
    basicToolsEnabled: basicEnabled,
    overrides: { [role.name]: override },
  });
  return {
    name: role.name,
    description: role.description,
    source: role.createdBy === 'system' ? 'preset' : 'custom',
    baselineRole: baselineName,
    allowedTiers: role.capabilityProfile?.allowedTiers ?? [],
    tools: adjusted.tools,
    profileTools,
    override: {
      tools_added: override.tools_added ?? [],
      tools_removed: override.tools_removed ?? [],
    },
    skillNames: role.skillNames ?? [],
    workerBackend: role.worker_backend,
    model: role.model,
    systemPrompt: role.systemPrompt,
    definition: definition
      ? {
          source: definition.source,
          path: definition.path,
          editable: definition.editable,
          updatedAt: definition.updatedAt,
          tools: definition.tools,
          skillNames: definition.skillNames,
        }
      : role.createdBy === 'system'
        ? undefined
        : { source: 'runtime', editable: false },
    runtime,
    surfaceSource: runtime ? 'live' : 'static_fallback',
  };
}

function parseScope(value: unknown): AgentDefinitionScope {
  return value === 'global' ? 'global' : 'project';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : [];
}

function parseWorkerBackend(value: unknown): AgentWorkerBackend | undefined {
  return value === 'claude' || value === 'codex' || value === 'worker_process'
    ? value
    : undefined;
}

function parseCustomAgentBody(body: unknown, fallbackName?: string): SaveAgentDefinitionInput {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return {
    name: typeof raw.name === 'string' ? raw.name : fallbackName ?? '',
    description: typeof raw.description === 'string' ? raw.description : '',
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    tools: readStringArray(raw.tools),
    skillNames: readStringArray(raw.skillNames),
    baseRoleName: typeof raw.baseRoleName === 'string' ? raw.baseRoleName : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    worker_backend: parseWorkerBackend(raw.workerBackend) ?? parseWorkerBackend(raw.worker_backend),
    scope: parseScope(raw.scope),
  };
}

export function registerRolesRoutes(fastify: FastifyInstance, deps: RolesRoutesDeps): void {
  const { requireServerToken } = deps;

  // ── GET /api/v1/roles/basic-tools ────────────────────────────
  fastify.get('/api/v1/roles/basic-tools', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return {
      data: {
        tools: [...DEFAULT_BASIC_TOOLS],
      },
    };
  });

  // ── GET /api/v1/roles ────────────────────────────────────────
  fastify.get('/api/v1/roles', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const cfg = getRolesCfg();
    const liveRoles = getActiveLeaderRoles(deps);
    const items: AgentRoleSurfaceItem[] = [];
    const definitionByName = new Map(getAgentDefinitionService(deps).listDefinitions().map((definition) => [definition.name, definition]));

    if (liveRoles && liveRoles.length > 0) {
      for (const role of liveRoles) {
        const ov = cfg.overrides[role.name] ?? {};
        items.push(buildRoleSurface(role, ov, cfg.basic_tools_enabled, true, definitionByName.get(role.name)));
      }
    } else {
      // Leader not started yet: mirror the same builtin role builder used by LeaderAgent.
      for (const role of buildStaticFallbackRoles(deps)) {
        const ov = cfg.overrides[role.name] ?? {};
        items.push(buildRoleSurface(role, ov, cfg.basic_tools_enabled, false, definitionByName.get(role.name)));
      }
    }

    return {
      data: {
        basic_tools_enabled: cfg.basic_tools_enabled,
        basic_tools: [...DEFAULT_BASIC_TOOLS],
        roles: items,
        custom_agent_dirs: {
          project: getAgentDefinitionService(deps).getAgentsDir('project'),
          global: getAgentDefinitionService(deps).getAgentsDir('global'),
        },
      },
    };
  });

  // ── POST /api/v1/roles/custom ───────────────────────────────
  fastify.post('/api/v1/roles/custom', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const saved = getAgentDefinitionService(deps).saveDefinition(parseCustomAgentBody(request.body));
      emitChange(deps, { action: 'custom_agent_saved', name: saved.name });
      return { success: true, data: saved, requiresRestart: false };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_agent_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── PUT /api/v1/roles/custom/:name ──────────────────────────
  fastify.put<{ Params: { name: string } }>('/api/v1/roles/custom/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const name = validateAgentDefinitionName(request.params.name);
      const input = parseCustomAgentBody(request.body, name);
      const saved = getAgentDefinitionService(deps).saveDefinition(input);
      if (saved.name !== name) {
        getAgentDefinitionService(deps).deleteDefinition(name, input.scope ?? saved.source);
      }
      emitChange(deps, { action: 'custom_agent_saved', name: saved.name });
      return { success: true, data: saved, requiresRestart: false };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_agent_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── DELETE /api/v1/roles/custom/:name ───────────────────────
  fastify.delete<{ Params: { name: string }; Querystring: { scope?: string } }>('/api/v1/roles/custom/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const name = validateAgentDefinitionName(request.params.name);
      const removed = getAgentDefinitionService(deps).deleteDefinition(name, parseScope(request.query?.scope));
      emitChange(deps, { action: 'custom_agent_deleted', name });
      return { success: true, name, removed, requiresRestart: false };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_agent_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  // ── PATCH /api/v1/roles/settings ─────────────────────────────
  fastify.patch('/api/v1/roles/settings', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = (request.body || {}) as { basic_tools_enabled?: unknown };
    if (typeof body.basic_tools_enabled !== 'boolean') {
      reply.status(400);
      return { error: 'invalid_body', message: 'basic_tools_enabled must be boolean' };
    }
    const next = getRolesCfg();
    next.basic_tools_enabled = body.basic_tools_enabled;
    persistRolesCfg(next);
    emitChange(deps, { action: 'basic_tools_toggled' });
    // 热加载：Leader 订阅 'roles:changed' 后会立即覆写 RoleRegistry 内置角色，
    // 已派出的 worker 仍持有旧 tools 快照（接受），新 dispatch 立即生效。
    return { success: true, basic_tools_enabled: next.basic_tools_enabled, requiresRestart: false };
  });

  // ── PATCH /api/v1/roles/:name ────────────────────────────────
  fastify.patch<{ Params: { name: string } }>('/api/v1/roles/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const name = request.params.name;
    if (!name) {
      reply.status(400);
      return { error: 'invalid_role', message: 'role name required' };
    }
    const body = (request.body || {}) as { tools_added?: unknown; tools_removed?: unknown };
    const added = Array.isArray(body.tools_added) ? body.tools_added.filter((x): x is string => typeof x === 'string') : undefined;
    const removed = Array.isArray(body.tools_removed) ? body.tools_removed.filter((x): x is string => typeof x === 'string') : undefined;
    if (!added && !removed) {
      reply.status(400);
      return { error: 'invalid_body', message: 'tools_added or tools_removed required' };
    }
    const next = getRolesCfg();
    const prev = next.overrides[name] ?? { tools_added: [], tools_removed: [] };
    next.overrides[name] = {
      tools_added: added !== undefined ? added : (prev.tools_added ?? []),
      tools_removed: removed !== undefined ? removed : (prev.tools_removed ?? []),
    };
    persistRolesCfg(next);
    emitChange(deps, { action: 'override_updated', name });
    return { success: true, name, override: next.overrides[name], requiresRestart: false };
  });

  // ── DELETE /api/v1/roles/:name/override ──────────────────────
  fastify.delete<{ Params: { name: string } }>('/api/v1/roles/:name/override', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const name = request.params.name;
    const next = getRolesCfg();
    if (!next.overrides[name]) {
      return { success: true, name, removed: false };
    }
    delete next.overrides[name];
    persistRolesCfg(next);
    emitChange(deps, { action: 'override_cleared', name });
    return { success: true, name, removed: true, requiresRestart: false };
  });
}
