/**
 * PluginRoutes — 插件 + 渠道路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { AuthFn } from './types.js';
import { config as runtimeConfig, saveSettings, ConfigSchema, type MarketplaceSourceConfig, type McpServerConfig } from '../config.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import {
  collectAvailableSkills,
  getSkillDescriptorRef,
  resolveDisabledSkillNames,
  resolveDisabledSkillRefs,
} from '../core/SkillCatalog.js';
import { SkillDefinitionService } from '../core/SkillDefinitionService.js';
import {
  type MarketplaceKind,
  type MarketplaceSearchField,
  getInstalledMcpServers,
  getAllMarketplaceSources,
  getMarketplaceSources,
  installMarketplaceEntry,
  listMarketplaceEntries,
  patchMarketplaceSource,
  removeMarketplaceSource,
  removeMcpServer,
  updateMcpServerEnabled,
  upsertMarketplaceSource,
  upsertMcpServer,
} from '../core/MarketplaceService.js';
import {
  contributionCounts,
  discoverPlugins,
  getPluginById,
  setPluginPackageEnabled,
  syncPluginMcpContributions,
  uninstallPlugin,
  type PluginDescriptor,
} from '../core/plugins/PluginStore.js';

export function registerPluginRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    requireServerToken: AuthFn;
    emitter?: EventEmitter;
  },
): void {
  const { repos, requireServerToken } = deps;

  const emitSkillsChanged = (payload: { action: string; name?: string }): void => {
    try {
      deps.emitter?.emit('skills:changed', payload);
    } catch {
      // ignore — broadcast is best-effort
    }
  };

  const resolveWorkspace = (sessionId?: string): string => {
    if (sessionId) {
      const session = repos.sessions.get(sessionId);
      if (session?.workspace) return session.workspace;
    }
    return process.cwd();
  };

  const getDisabledSkills = (): string[] => {
    return resolveDisabledSkillNames();
  };

  const persistDisabledSkills = (disabled: string[]): void => {
    const unique = Array.from(new Set(disabled));
    runtimeConfig.skills = {
      ...(runtimeConfig.skills || { disabled_names: [], disabled_refs: [] }),
      disabled_names: unique,
    };
    ConfigSchema.parse(runtimeConfig);
    saveSettings(runtimeConfig);
  };

  const persistDisabledSkillRefs = (refs: string[]): void => {
    runtimeConfig.skills = {
      ...(runtimeConfig.skills || { disabled_names: [], disabled_refs: [] }),
      disabled_refs: Array.from(new Set(refs)).sort(),
    };
    ConfigSchema.parse(runtimeConfig);
    saveSettings(runtimeConfig);
  };

  const setDynamicResponseHeaders = (reply: Parameters<AuthFn>[1]): void => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
  };

  const parseMarketplaceKind = (value: unknown): MarketplaceKind | undefined => {
    return value === 'mcp' || value === 'skill' || value === 'plugin' ? value : undefined;
  };

  const parseMarketplaceFields = (value: unknown): MarketplaceSearchField[] | undefined => {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    const allowed = new Set(['id', 'name', 'title', 'description', 'version', 'source', 'transport', 'repository', 'remote']);
    const fields = values
      .flatMap((item) => String(item).split(','))
      .map((item) => item.trim())
      .filter((item): item is MarketplaceSearchField => allowed.has(item));
    return fields.length > 0 ? Array.from(new Set(fields)) : undefined;
  };

  const parseBooleanQuery = (value: unknown): boolean | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
  };

  const marketplaceErrorStatus = (error: unknown): number => {
    const raw = error && typeof error === 'object'
      ? ((error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode)
      : undefined;
    const status = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isInteger(status) && status >= 400 && status < 600 ? status : 502;
  };

  const serializePlugin = (plugin: PluginDescriptor) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    enabled: plugin.enabled,
    path: plugin.path,
    manifestPath: plugin.manifestPath,
    scope: plugin.scope,
    author: plugin.author,
    homepage: plugin.homepage,
    license: plugin.license,
    keywords: plugin.keywords,
    interface: plugin.interface,
    counts: contributionCounts(plugin),
    contributions: {
      skills: plugin.contributions.skills.map((skill) => ({
        pluginId: skill.pluginId,
        pluginVersion: skill.pluginVersion,
        path: skill.dir,
      })),
      mcp: plugin.contributions.mcp.map((mcp) => ({
        pluginId: mcp.pluginId,
        pluginVersion: mcp.pluginVersion,
        serverId: mcp.server.id,
        name: mcp.server.name,
        transport: mcp.server.transport,
        enabled: mcp.server.enabled !== false,
        origin: mcp.server.origin,
      })),
      apps: plugin.contributions.apps,
      assets: plugin.contributions.assets,
      tools: plugin.contributions.tools,
      hooks: plugin.contributions.hooks,
      scripts: plugin.contributions.scripts,
    },
    origin: plugin.origin,
  });

  // --- Plugin packages ---
  fastify.get('/api/v1/plugins', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const sessionId = typeof (request.query as Record<string, unknown>)?.sessionId === 'string' ? (request.query as Record<string, unknown>).sessionId as string : undefined;
      const workspace = resolveWorkspace(sessionId);
      syncPluginMcpContributions(workspace);
      return { data: discoverPlugins(workspace).map(serializePlugin) };
    } catch (error) {
      reply.status(500);
      return { error: 'plugin_discovery_failed', message: error instanceof Error ? error.message : String(error), data: [] };
    }
  });

  fastify.get('/api/v1/skills', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const query = request.query as { sessionId?: string; includeDisabled?: string };
    const workspace = resolveWorkspace(typeof query.sessionId === 'string' ? query.sessionId : undefined);
    const disabledNames = getDisabledSkills();
    const disabledNameSet = new Set(disabledNames);
    const disabledRefs = resolveDisabledSkillRefs();
    const disabledRefSet = new Set(disabledRefs);
    const includeDisabled = query.includeDisabled === 'true';
    const skills = collectAvailableSkills(workspace, {
      disabledNames: includeDisabled ? [] : disabledNames,
      disabledRefs: includeDisabled ? [] : undefined,
      maxActive: 9999,
    });
    return {
      data: skills.map((skill) => {
        const ref = getSkillDescriptorRef(skill);
        return {
          id: ref,
          ref,
          name: skill.name,
          description: skill.summary,
          source: skill.source,
          sourceLabel: skill.source,
          path: skill.path,
          plugin: skill.plugin,
          enabled: !disabledNameSet.has(skill.name) && !disabledRefSet.has(ref),
        };
      }),
    };
  });

  fastify.get('/api/v1/plugins/marketplaces', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const query = request.query as {
        sessionId?: string;
        sourceId?: string;
        kind?: string;
        q?: string;
        query?: string;
        fields?: string | string[];
        installed?: string;
        installable?: string;
        transport?: string;
        limit?: string;
        cursor?: string;
      };
      if (Object.prototype.hasOwnProperty.call(query, 'q')) {
        reply.status(400);
        return { error: 'unsupported_query_parameter', message: 'q is not accepted; use query' };
      }
      const workspace = resolveWorkspace(typeof query.sessionId === 'string' ? query.sessionId : undefined);
      return await listMarketplaceEntries({
        workspace,
        sourceId: typeof query.sourceId === 'string' ? query.sourceId : undefined,
        kind: parseMarketplaceKind(query.kind),
        query: typeof query.query === 'string' ? query.query : undefined,
        fields: parseMarketplaceFields(query.fields),
        installed: parseBooleanQuery(query.installed),
        installable: parseBooleanQuery(query.installable),
        transport: typeof query.transport === 'string' ? query.transport : undefined,
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
      });
    } catch (error) {
      reply.status(marketplaceErrorStatus(error));
      return {
        error: 'plugin_marketplace_fetch_failed',
        message: error instanceof Error ? error.message : String(error),
        sources: getMarketplaceSources(),
        entries: [],
      };
    }
  });

  fastify.post('/api/v1/plugins/marketplaces/install', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const body = request.body as { id?: string; sourceId?: string; sessionId?: string };
    if (!body?.id) {
      reply.status(400);
      return { error: 'missing_marketplace_entry_id', message: 'id is required.' };
    }
    try {
      const installed = await installMarketplaceEntry({
        id: body.id,
        sourceId: body.sourceId,
        workspace: resolveWorkspace(body.sessionId),
      });
      return { success: true, ...installed };
    } catch (error) {
      reply.status(400);
      return { error: 'marketplace_install_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.get('/api/v1/plugins/marketplaces/sources', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    return { data: getAllMarketplaceSources(), fetchedAt: Date.now() };
  });

  fastify.post('/api/v1/plugins/marketplaces/sources', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const source = upsertMarketplaceSource(request.body as MarketplaceSourceConfig);
      return { success: true, data: source };
    } catch (error) {
      reply.status(400);
      return { error: 'marketplace_source_save_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.patch('/api/v1/plugins/marketplaces/sources/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { id } = request.params as { id: string };
    try {
      const source = patchMarketplaceSource(id, request.body as Partial<MarketplaceSourceConfig>);
      if (!source) {
        reply.status(404);
        return { error: 'marketplace_source_not_found', message: `Marketplace source not found: ${id}` };
      }
      return { success: true, data: source };
    } catch (error) {
      reply.status(400);
      return { error: 'marketplace_source_update_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.delete('/api/v1/plugins/marketplaces/sources/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { id } = request.params as { id: string };
    const source = removeMarketplaceSource(id);
    if (!source) {
      reply.status(404);
      return { error: 'marketplace_source_not_found', message: `Marketplace source not found: ${id}` };
    }
    return { success: true, data: source };
  });

  fastify.get('/api/v1/mcp/servers', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const sessionId = typeof (request.query as Record<string, unknown>)?.sessionId === 'string' ? (request.query as Record<string, unknown>).sessionId as string : undefined;
    syncPluginMcpContributions(resolveWorkspace(sessionId));
    return { data: getInstalledMcpServers() };
  });

  fastify.post('/api/v1/mcp/servers', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const server = upsertMcpServer(request.body as McpServerConfig);
      return { success: true, data: server };
    } catch (error) {
      reply.status(400);
      return { error: 'mcp_server_save_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.patch('/api/v1/mcp/servers/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'missing_enabled', message: 'enabled boolean is required.' };
    }
    const updated = updateMcpServerEnabled(id, body.enabled);
    if (!updated) {
      reply.status(404);
      return { error: 'mcp_server_not_found', message: `MCP server not found: ${id}` };
    }
    return { success: true, data: updated };
  });

  fastify.delete('/api/v1/mcp/servers/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { id } = request.params as { id: string };
    const removed = removeMcpServer(id);
    if (!removed) {
      reply.status(404);
      return { error: 'mcp_server_not_found', message: `MCP server not found: ${id}` };
    }
    return { success: true, id };
  });

  fastify.patch('/api/v1/plugins/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean; sessionId?: string };
    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'missing_enabled', message: 'enabled boolean is required.' };
    }
    const workspace = resolveWorkspace(body.sessionId);
    const plugin = getPluginById(id, workspace);
    if (!plugin) {
      reply.status(404);
      return { error: 'plugin_not_found', message: `Plugin package not found: ${id}` };
    }
    const updated = setPluginPackageEnabled(id, body.enabled, workspace);
    return { success: true, data: updated ? serializePlugin(updated) : serializePlugin({ ...plugin, enabled: body.enabled } as PluginDescriptor) };
  });

  fastify.patch('/api/v1/skills/:ref', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { ref } = request.params as { ref: string };
    const { enabled } = request.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      reply.status(400);
      return { error: 'missing_enabled', message: 'enabled boolean is required.' };
    }
    const decodedRef = decodeURIComponent(ref);
    if (decodedRef.startsWith('plugin:') || decodedRef.includes(':')) {
      const refs = resolveDisabledSkillRefs();
      const next = enabled
        ? refs.filter((item) => item !== decodedRef)
        : refs.includes(decodedRef) ? refs : [...refs, decodedRef];
      persistDisabledSkillRefs(next);
      return { success: true, ref: decodedRef, enabled };
    }
    const current = getDisabledSkills();
    if (!enabled) {
      if (!current.includes(decodedRef)) current.push(decodedRef);
    } else {
      const idx = current.indexOf(decodedRef);
      if (idx >= 0) current.splice(idx, 1);
    }
    persistDisabledSkills(current);
    return { success: true, ref: decodedRef, enabled };
  });

  // ── Skill authoring (read-one / create / update / delete) ──────────────
  // These write markdown files under .lingxiao/skills/ (or the global skills
  // dir). The read-only GET list + PATCH toggle live above; these four
  // complete full CRUD. Writing a file bumps the skills dir mtime, which
  // invalidates SkillCatalog's 5s TTL cache on the next read.

  fastify.get<{ Params: { name: string } }>('/api/v1/skills/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { name } = request.params;
    const query = request.query as { scope?: string; sessionId?: string };
    const workspace = resolveWorkspace(typeof query.sessionId === 'string' ? query.sessionId : undefined);
    const scope = query.scope === 'global' ? 'global' : 'project';
    const record = new SkillDefinitionService({ workspace }).getDefinitionInScope(name, scope);
    if (!record) {
      reply.status(404);
      return { error: 'skill_not_found', message: `Skill not found: ${name}` };
    }
    return { data: record };
  });

  fastify.post('/api/v1/skills', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const body = (request.body || {}) as { name?: string; description?: string; body?: string; scope?: string; sessionId?: string };
      const workspace = resolveWorkspace(typeof body.sessionId === 'string' ? body.sessionId : undefined);
      const saved = new SkillDefinitionService({ workspace }).saveDefinition({
        name: body.name ?? '',
        description: body.description ?? '',
        body: body.body ?? '',
        scope: body.scope === 'global' ? 'global' : 'project',
      });
      emitSkillsChanged({ action: 'skill_saved', name: saved.name });
      return { success: true, data: saved };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_skill_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.put<{ Params: { name: string } }>('/api/v1/skills/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const name = request.params.name;
      const body = (request.body || {}) as { name?: string; description?: string; body?: string; scope?: string; sessionId?: string };
      const workspace = resolveWorkspace(typeof body.sessionId === 'string' ? body.sessionId : undefined);
      const scope = body.scope === 'global' ? 'global' : 'project';
      const service = new SkillDefinitionService({ workspace });
      const saved = service.saveDefinition({
        name: body.name ?? name,
        description: body.description ?? '',
        body: body.body ?? '',
        scope,
      });
      // Rename: if the saved name differs from the URL param, remove the old file.
      if (saved.name !== name) {
        service.deleteDefinition(name, scope);
      }
      emitSkillsChanged({ action: 'skill_saved', name: saved.name });
      return { success: true, data: saved };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_skill_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.delete<{ Params: { name: string }; Querystring: { scope?: string; sessionId?: string } }>('/api/v1/skills/:name', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    try {
      const name = request.params.name;
      const query = request.query as { scope?: string; sessionId?: string };
      const workspace = resolveWorkspace(typeof query.sessionId === 'string' ? query.sessionId : undefined);
      const scope = query.scope === 'global' ? 'global' : 'project';
      const removed = new SkillDefinitionService({ workspace }).deleteDefinition(name, scope);
      emitSkillsChanged({ action: 'skill_deleted', name });
      return { success: true, name, removed, scope };
    } catch (error) {
      reply.status(400);
      return { error: 'invalid_skill_definition', message: error instanceof Error ? error.message : String(error) };
    }
  });

  fastify.delete('/api/v1/plugins/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);
    const { id } = request.params as { id: string };
    const removed = uninstallPlugin(id);
    if (!removed) {
      reply.status(404);
      return { error: 'plugin_not_found', message: `Installed global plugin package not found: ${id}` };
    }
    return { success: true, id };
  });

  // --- Channels ---
  fastify.get('/api/v1/channels', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const channels = (repos.sessionState.get('__global__', SESSION_KEYS.GLOBAL_CHANNELS) as Array<{ id: string }>) || [];
    return { clients: channels };
  });

  fastify.delete('/api/v1/channels/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const channels = (repos.sessionState.get('__global__', SESSION_KEYS.GLOBAL_CHANNELS) as Array<{ id: string }>) || [];
    const filtered = channels.filter((c) => c.id !== id);
    repos.sessionState.set('__global__', SESSION_KEYS.GLOBAL_CHANNELS, filtered);
    return { success: true };
  });

  fastify.post('/api/v1/channels/wecom', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    // 真实化：本项目当前仅实现 QQ 官方机器人 (src/bot/QQBot.ts)，
    // 未实现 WeCom (企业微信) 机器人的真实连接/Gateway/HTTP 发送逻辑。
    // 拒绝"写入一条 disconnected 记录"的假成功，返回 501。
    reply.status(501);
    return {
      error: 'wecom_channel_not_implemented',
      message: 'WeCom channels are not implemented. Only QQ official bot is supported via /api/v1/qqbot/*.',
    };
  });
}
