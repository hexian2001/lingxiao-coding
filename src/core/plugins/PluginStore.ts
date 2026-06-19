import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { CONFIG_DIR, config as runtimeConfig, saveSettings, ConfigSchema, type McpServerConfig } from '../../config.js';
import { resetRuntimeMcpClient } from '../McpClient.js';
import {
  type LoadedPluginManifest,
  type PluginManifest,
  type PluginMcpServerManifest,
  PluginMcpServerSchema,
  loadPluginManifest,
} from './PluginManifest.js';

export type PluginScope = 'project' | 'global';
export type PluginContributionKind = 'skills' | 'mcp' | 'apps' | 'assets' | 'tools' | 'hooks' | 'scripts';

export interface PluginOrigin {
  type: 'plugin';
  pluginId: string;
  pluginVersion: string;
  pluginPath: string;
}

export interface PluginMcpOrigin {
  plugin_id: string;
  plugin_version: string;
  plugin_path: string;
}

export interface PluginSkillContribution {
  dir: string;
  pluginId: string;
  pluginVersion: string;
  pluginPath: string;
}

export interface PluginMcpContribution {
  server: McpServerConfig;
  pluginId: string;
  pluginVersion: string;
  pluginPath: string;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  path: string;
  manifestPath: string;
  scope: PluginScope;
  author?: unknown;
  homepage?: string;
  license?: string;
  keywords: string[];
  interface: PluginManifest['interface'];
  contributions: {
    skills: PluginSkillContribution[];
    mcp: PluginMcpContribution[];
    apps: string[];
    assets: string[];
    tools: unknown[];
    hooks: unknown[];
    scripts: string[];
  };
  origin: PluginOrigin;
}

const PLUGINS_DIR_NAME = 'plugins';

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function ensureTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function isWithin(parent: string, child: string): boolean {
  const resolvedParent = ensureTrailingSep(resolve(parent));
  const resolvedChild = resolve(child);
  return resolvedChild === resolve(parent) || resolvedChild.startsWith(resolvedParent);
}

function toArray(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeId(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);
  return base || 'plugin_mcp';
}

function normalizeRelativePath(pluginRoot: string, rel: string): string | null {
  const full = resolve(pluginRoot, rel);
  return isWithin(pluginRoot, full) ? full : null;
}

export function isPluginRootUnderAllowedDir(pluginRoot: string, workspace?: string): boolean {
  return getPluginSourceRoots(workspace).some((root) => isWithin(root.dir, pluginRoot));
}

function getPluginConfig(): { disabled_ids?: string[]; dirs?: string[] } {
  return (runtimeConfig as unknown as { plugins?: { disabled_ids?: string[]; dirs?: string[] } }).plugins || {};
}

function persistPluginDisabledIds(ids: string[]): void {
  (runtimeConfig as unknown as { plugins?: { disabled_ids?: string[]; dirs?: string[] } }).plugins = {
    ...getPluginConfig(),
    disabled_ids: unique(ids).sort(),
  };
  ConfigSchema.parse(runtimeConfig);
  saveSettings(runtimeConfig);
}

export function getGlobalPluginsDir(): string {
  return join(CONFIG_DIR, PLUGINS_DIR_NAME);
}

export function getPluginSourceRoots(workspace?: string): Array<{ dir: string; scope: PluginScope }> {
  const roots: Array<{ dir: string; scope: PluginScope }> = [];
  if (workspace) {
    roots.push({ dir: join(workspace, '.lingxiao', PLUGINS_DIR_NAME), scope: 'project' });
  }
  roots.push({ dir: getGlobalPluginsDir(), scope: 'global' });
  for (const dir of getPluginConfig().dirs || []) {
    if (typeof dir === 'string' && dir.trim()) {
      roots.push({ dir: resolve(dir), scope: 'global' });
    }
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const resolved = resolve(root.dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    root.dir = resolved;
    return true;
  });
}

function readDisabledPluginIds(): Set<string> {
  return new Set((getPluginConfig().disabled_ids || []).filter((id) => typeof id === 'string' && id.length > 0));
}

function manifestToMcpServer(
  loaded: LoadedPluginManifest,
  mcp: PluginMcpServerManifest,
): McpServerConfig {
  const pluginId = loaded.manifest.id || loaded.manifest.name;
  const baseId = mcp.id || sanitizeId(`${pluginId}_${mcp.name}`);
  const id = baseId.startsWith(`${sanitizeId(pluginId)}_`) ? baseId : sanitizeId(`${pluginId}_${baseId}`);
  const origin: PluginMcpOrigin = {
    plugin_id: pluginId,
    plugin_version: loaded.manifest.version,
    plugin_path: loaded.pluginRoot,
  };
  if (mcp.transport === 'streamable-http') {
    return {
      id,
      name: mcp.name,
      title: mcp.title,
      description: mcp.description,
      enabled: mcp.enabled !== false,
      transport: 'streamable-http',
      url: mcp.url,
      headers: mcp.headers || [],
      registry: {
        source_id: `plugin:${pluginId}`,
        server_name: mcp.name,
        version: loaded.manifest.version,
      },
      origin,
    } as McpServerConfig;
  }
  const cwd = mcp.cwd ? normalizeRelativePath(loaded.pluginRoot, mcp.cwd) : undefined;
  return {
    id,
    name: mcp.name,
    title: mcp.title,
    description: mcp.description,
    enabled: mcp.enabled !== false,
    transport: 'stdio',
    command: mcp.command,
    args: mcp.args || [],
    env: mcp.env || {},
    cwd,
    registry: {
      source_id: `plugin:${pluginId}`,
      server_name: mcp.name,
      version: loaded.manifest.version,
    },
    origin,
  } as McpServerConfig;
}

function readPluginMcpFile(loaded: LoadedPluginManifest): PluginMcpServerManifest[] {
  const rel = loaded.manifest.mcp;
  if (!rel) return [];
  const full = normalizeRelativePath(loaded.pluginRoot, rel);
  if (!full || !existsSync(full)) return [];
  const raw = JSON.parse(readFileSync(full, 'utf-8')) as unknown;
  const rawObj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const servers = rawObj && Array.isArray(rawObj.servers)
    ? rawObj.servers
    : rawObj && Array.isArray(rawObj.mcpServers)
      ? rawObj.mcpServers
      : Array.isArray(raw)
        ? raw
        : [];
  return (servers as unknown[]).map((item) => PluginMcpServerSchema.parse(item));
}

function descriptorFromLoaded(loaded: LoadedPluginManifest, scope: PluginScope, disabled: Set<string>): PluginDescriptor {
  const manifest = loaded.manifest;
  const pluginId = manifest.id || manifest.name;
  const enabled = !disabled.has(pluginId);
  const skills = toArray(manifest.skills)
    .map((rel) => normalizeRelativePath(loaded.pluginRoot, rel))
    .filter((dir): dir is string => Boolean(dir && existsSync(dir)))
    .map((dir) => ({ dir, pluginId, pluginVersion: manifest.version, pluginPath: loaded.pluginRoot }));
  const mcpServers = [...manifest.mcpServers, ...readPluginMcpFile(loaded)]
    .map((server) => ({
      server: manifestToMcpServer(loaded, server),
      pluginId,
      pluginVersion: manifest.version,
      pluginPath: loaded.pluginRoot,
    }));
  const apps = toArray(manifest.apps)
    .map((rel) => normalizeRelativePath(loaded.pluginRoot, rel))
    .filter((path): path is string => Boolean(path));
  const assets = toArray(manifest.assets)
    .map((rel) => normalizeRelativePath(loaded.pluginRoot, rel))
    .filter((path): path is string => Boolean(path));
  return {
    id: pluginId,
    name: manifest.interface.displayName || manifest.name,
    version: manifest.version,
    description: manifest.description || manifest.interface.shortDescription || '',
    enabled,
    path: loaded.pluginRoot,
    manifestPath: loaded.manifestPath,
    scope,
    author: manifest.author,
    homepage: manifest.homepage,
    license: manifest.license,
    keywords: manifest.keywords,
    interface: manifest.interface,
    contributions: {
      skills,
      mcp: mcpServers,
      apps,
      assets,
      tools: manifest.tools,
      hooks: manifest.hooks,
      scripts: Object.keys(manifest.scripts || {}),
    },
    origin: {
      type: 'plugin',
      pluginId,
      pluginVersion: manifest.version,
      pluginPath: loaded.pluginRoot,
    },
  };
}

export function discoverPlugins(workspace?: string): PluginDescriptor[] {
  const disabled = readDisabledPluginIds();
  const byId = new Map<string, PluginDescriptor>();
  for (const root of getPluginSourceRoots(workspace)) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir)) {
      const full = join(root.dir, entry);
      if (!statSync(full).isDirectory()) continue;
      const loaded = loadPluginManifest(full);
      if (!loaded) continue;
      const descriptor = descriptorFromLoaded(loaded, root.scope, disabled);
      if (!byId.has(descriptor.id) || descriptor.scope === 'project') {
        byId.set(descriptor.id, descriptor);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getPluginById(pluginId: string, workspace?: string): PluginDescriptor | null {
  return discoverPlugins(workspace).find((plugin) => plugin.id === pluginId) || null;
}

export function getEnabledPluginSkillContributions(workspace: string): PluginSkillContribution[] {
  return discoverPlugins(workspace).filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.contributions.skills);
}

export function getEnabledPluginMcpContributions(workspace?: string): PluginMcpContribution[] {
  return discoverPlugins(workspace).filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.contributions.mcp);
}

export function setPluginEnabled(pluginId: string, enabled: boolean): boolean {
  const current = readDisabledPluginIds();
  if (enabled) current.delete(pluginId);
  else current.add(pluginId);
  persistPluginDisabledIds(Array.from(current));
  return true;
}

function isMcpServerFromPlugin(server: McpServerConfig, pluginId?: string, pluginPath?: string): boolean {
  const origin = server.origin;
  if (!origin?.plugin_id) return false;
  if (pluginId && origin.plugin_id !== pluginId) return false;
  if (pluginPath && resolve(origin.plugin_path || '') !== resolve(pluginPath)) return false;
  return true;
}

function pluginMcpKey(server: McpServerConfig): string | null {
  const origin = server.origin;
  if (!origin?.plugin_id || !origin.plugin_version || !origin.plugin_path) return null;
  const contributionName = server.registry?.server_name || server.name || server.id;
  return `${origin.plugin_id}\0${origin.plugin_version}\0${origin.plugin_path}\0${contributionName}`;
}

function samePluginMcpOrigin(a: McpServerConfig, b: McpServerConfig): boolean {
  const aKey = pluginMcpKey(a);
  const bKey = pluginMcpKey(b);
  return Boolean(aKey && bKey && aKey === bKey);
}

function shouldReplacePluginMcp(existing: McpServerConfig, incoming: McpServerConfig): boolean {
  if (samePluginMcpOrigin(existing, incoming)) return true;
  return Boolean(
    existing.origin?.plugin_id
    && incoming.origin?.plugin_id
    && existing.origin.plugin_id === incoming.origin.plugin_id
    && existing.id === incoming.id
  );
}

function persistMcpServers(servers: McpServerConfig[]): void {
  const previousMcp = runtimeConfig.mcp;
  const nextMcp = {
    ...(runtimeConfig.mcp || { enabled: true, servers: [], tool_timeout_ms: 60_000 }),
    servers,
  };
  const validated = ConfigSchema.parse({ ...runtimeConfig, mcp: nextMcp });
  runtimeConfig.mcp = validated.mcp;
  try {
    saveSettings(runtimeConfig);
  } catch (error) {
    runtimeConfig.mcp = previousMcp;
    throw error;
  }
  void resetRuntimeMcpClient().catch(() => undefined);
}

function mcpServersEqual(a: McpServerConfig[], b: McpServerConfig[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function withMcpTimestamp(server: McpServerConfig, existing?: McpServerConfig): McpServerConfig {
  const now = Date.now();
  return {
    ...server,
    installed_at: existing?.installed_at || server.installed_at || now,
    updated_at: now,
  } as McpServerConfig;
}

export function syncPluginMcpContributions(
  workspace?: string,
  options: { preserveExistingEnabled?: boolean } = {},
): McpServerConfig[] {
  const preserveExistingEnabled = options.preserveExistingEnabled !== false;
  const discoveredPlugins = discoverPlugins(workspace);
  const contributions = discoveredPlugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.contributions.mcp);
  const activeKeys = new Set(contributions.map((contribution) => pluginMcpKey(contribution.server)).filter((key): key is string => Boolean(key)));
  const discoveredKeys = new Set(
    discoveredPlugins
      .flatMap((plugin) => plugin.contributions.mcp)
      .map((contribution) => pluginMcpKey(contribution.server))
      .filter((key): key is string => Boolean(key)),
  );
  const current = runtimeConfig.mcp?.servers || [];
  let next = current.filter((server) => {
    if (!isMcpServerFromPlugin(server)) return true;
    if (!server.origin?.plugin_path) return false;
    if (!isPluginRootUnderAllowedDir(server.origin.plugin_path, workspace)) return true;
    const key = pluginMcpKey(server);
    return Boolean(key && (activeKeys.has(key) || discoveredKeys.has(key)));
  }).map((server) => {
    if (!isMcpServerFromPlugin(server)) return server;
    if (!server.origin?.plugin_path || !isPluginRootUnderAllowedDir(server.origin.plugin_path, workspace)) return server;
    const key = pluginMcpKey(server);
    if (key && discoveredKeys.has(key) && !activeKeys.has(key) && server.enabled !== false) {
      return { ...server, enabled: false, updated_at: Date.now() } as McpServerConfig;
    }
    return server;
  });

  for (const contribution of contributions) {
    const incoming = contribution.server;
    const existingIndex = next.findIndex((server) => shouldReplacePluginMcp(server, incoming));
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      const replacement = preserveExistingEnabled
        ? withMcpTimestamp({ ...incoming, id: existing.id, enabled: existing.enabled }, existing)
        : withMcpTimestamp({ ...incoming, id: existing.id }, existing);
      next = next.map((server, index) => index === existingIndex ? replacement : server);
      continue;
    }

    const sameId = next.find((server) => server.id === incoming.id && !isMcpServerFromPlugin(server, incoming.origin?.plugin_id));
    const serverToInstall = sameId
      ? { ...incoming, id: sanitizeId(`${incoming.origin?.plugin_id || 'plugin'}_${incoming.id}`) }
      : incoming;
    next = [...next, withMcpTimestamp(serverToInstall)];
  }

  if (!mcpServersEqual(current, next)) {
    persistMcpServers(next);
  }
  return next;
}

export function disablePluginMcpContributions(pluginId: string, pluginPath?: string): McpServerConfig[] {
  const servers = runtimeConfig.mcp?.servers || [];
  const next = servers.map((server) => isMcpServerFromPlugin(server, pluginId, pluginPath)
    ? { ...server, enabled: false, updated_at: Date.now() } as McpServerConfig
    : server);
  persistMcpServers(next);
  return next;
}

export function removePluginMcpContributions(pluginId: string, pluginPath?: string): McpServerConfig[] {
  const servers = runtimeConfig.mcp?.servers || [];
  const next = servers.filter((server) => !isMcpServerFromPlugin(server, pluginId, pluginPath));
  persistMcpServers(next);
  return next;
}

export function setPluginPackageEnabled(pluginId: string, enabled: boolean, workspace?: string): PluginDescriptor | null {
  const existing = getPluginById(pluginId, workspace);
  setPluginEnabled(pluginId, enabled);
  if (enabled) {
    syncPluginMcpContributions(workspace, { preserveExistingEnabled: false });
  } else {
    disablePluginMcpContributions(pluginId, existing?.path);
  }
  return getPluginById(pluginId, workspace);
}

export function installLocalPlugin(sourcePath: string, workspace?: string): PluginDescriptor {
  const loaded = loadPluginManifest(sourcePath);
  if (!loaded) throw new Error(`Plugin manifest not found in ${sourcePath}`);
  const pluginId = loaded.manifest.id || loaded.manifest.name;
  const targetRoot = join(getGlobalPluginsDir(), pluginId);
  mkdirSync(getGlobalPluginsDir(), { recursive: true });
  if (resolve(sourcePath) !== resolve(targetRoot)) {
    rmSync(targetRoot, { recursive: true, force: true });
    cpSync(sourcePath, targetRoot, { recursive: true });
  }
  const installed = loadPluginManifest(targetRoot);
  if (!installed) throw new Error(`Installed plugin manifest not found: ${targetRoot}`);
  const descriptor = descriptorFromLoaded(installed, 'global', readDisabledPluginIds());
  syncPluginMcpContributions(workspace);
  return descriptor;
}

export function uninstallPlugin(pluginId: string): boolean {
  const targetRoot = join(getGlobalPluginsDir(), pluginId);
  if (!existsSync(targetRoot)) return false;
  rmSync(targetRoot, { recursive: true, force: true });
  const disabled = readDisabledPluginIds();
  disabled.delete(pluginId);
  persistPluginDisabledIds(Array.from(disabled));
  removePluginMcpContributions(pluginId, targetRoot);
  return true;
}

export function contributionCounts(plugin: PluginDescriptor): Record<PluginContributionKind, number> {
  return {
    skills: plugin.contributions.skills.length,
    mcp: plugin.contributions.mcp.length,
    apps: plugin.contributions.apps.length,
    assets: plugin.contributions.assets.length,
    tools: plugin.contributions.tools.length,
    hooks: plugin.contributions.hooks.length,
    scripts: plugin.contributions.scripts.length,
  };
}
