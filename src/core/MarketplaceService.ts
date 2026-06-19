import { cpSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  config as runtimeConfig,
  saveSettings,
  ConfigSchema,
  normalizeMarketplaceSources,
  type MarketplaceSourceConfig,
  type McpServerConfig,
} from '../config.js';
import { collectAvailableSkills, type SkillDescriptor } from './SkillCatalog.js';
import { getGlobalSkillsDir } from './BundledSkillRegistry.js';
import { getScopedProxyFetch } from './ProxyConfig.js';
import { discoverPlugins, installLocalPlugin, isPluginRootUnderAllowedDir } from './plugins/PluginStore.js';
import { resetRuntimeMcpClient } from './McpClient.js';

export type MarketplaceKind = 'skill' | 'mcp' | 'plugin';
export type MarketplaceSearchField = 'id' | 'name' | 'title' | 'description' | 'version' | 'source' | 'transport' | 'repository' | 'remote';

export interface MarketplaceEntry {
  id: string;
  kind: MarketplaceKind;
  sourceId: string;
  name: string;
  title?: string;
  description: string;
  version?: string;
  installed: boolean;
  installable: boolean;
  transport?: string;
  remoteUrl?: string;
  repositoryUrl?: string;
  path?: string;
  raw?: unknown;
}

export interface MarketplaceListOptions {
  sourceId?: string;
  kind?: MarketplaceKind;
  query?: string;
  fields?: MarketplaceSearchField[];
  installed?: boolean;
  installable?: boolean;
  transport?: string;
  limit?: number;
  cursor?: string;
  workspace?: string;
}

export interface MarketplaceListResult {
  sources: MarketplaceSourceConfig[];
  entries: MarketplaceEntry[];
  nextCursor?: string;
  fetchedAt: number;
}

export interface InstallMarketplaceEntryOptions {
  id: string;
  sourceId?: string;
  workspace?: string;
}

interface McpRegistryServerResponse {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    repository?: { url?: string };
    remotes?: Array<{ type?: string; url?: string; headers?: Array<{ name?: string; value?: string }> }>;
    packages?: unknown[];
  };
  _meta?: Record<string, unknown>;
}

interface McpOfficialMeta {
  status?: unknown;
  isLatest?: unknown;
  publishedAt?: unknown;
  updatedAt?: unknown;
}

interface SkillIndexEntry {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  summary?: string;
  version?: string;
  url?: string;
  repositoryUrl?: string;
  content?: string;
  path?: string;
  directoryPath?: string;
  files?: SkillIndexFile[];
}

interface SkillIndexFile {
  path?: string;
  targetPath?: string;
  url?: string;
}

interface GitHubTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
  url?: string;
}

interface PluginIndexEntry {
  id?: string;
  name?: string;
  title?: string;
  displayName?: string;
  description?: string;
  summary?: string;
  version?: string;
  url?: string;
  path?: string;
  homepage?: string;
  repositoryUrl?: string;
  keywords?: string[];
}

interface MarketplaceFetchError extends Error {
  status?: number;
  statusCode?: number;
  url?: string;
  body?: string;
}

const OFFICIAL_MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
const OPENAI_SKILLS_RAW_BASE_URL = 'https://raw.githubusercontent.com/openai/skills/main';
const OPENAI_SKILLS_REPOSITORY_URL = 'https://github.com/openai/skills';
const OPENAI_SKILLS_TREE_URL = 'https://api.github.com/repos/openai/skills/git/trees/main?recursive=1';
const MCP_REGISTRY_API_VERSION = 'v0.1';
const MARKETPLACE_SOURCE_ID_RE = /^[a-z][a-z0-9_-]{1,79}$/;
const MAX_MARKETPLACE_PAGE_SIZE = 200;
const MARKETPLACE_CURSOR_PREFIX = 'lxmp1:';
const MARKETPLACE_SOURCE_TYPE_BY_KIND: Record<MarketplaceKind, MarketplaceSourceConfig['type']> = {
  mcp: 'mcp_registry',
  skill: 'skill_index',
  plugin: 'plugin_index',
};
const MARKETPLACE_SEARCH_FIELDS = new Set<MarketplaceSearchField>([
  'id',
  'name',
  'title',
  'description',
  'version',
  'source',
  'transport',
  'repository',
  'remote',
]);

interface ParsedMarketplaceSearch {
  terms: string[];
  fields: MarketplaceSearchField[];
  fieldTerms: Array<{ field: MarketplaceSearchField; value: string }>;
  installed?: boolean;
  installable?: boolean;
  transport?: string;
}

function now(): number {
  return Date.now();
}

function sanitizeToolId(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);
  return base || `mcp_${Math.random().toString(36).slice(2, 8)}`;
}

function configuredSources(): MarketplaceSourceConfig[] {
  return normalizeMarketplaceSources(runtimeConfig.marketplaces?.sources).filter((source) => source.enabled !== false);
}

function fetchForTools(): typeof fetch {
  return getScopedProxyFetch('tools') || fetch;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summarizeMarketplaceResponseBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  const parsedMessage = (() => {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = parsed.message || parsed.error || parsed.detail;
      return typeof value === 'string' ? value : '';
    } catch {/* expected: fallback to default */
      return '';
    }
  })();
  const normalized = (parsedMessage || trimmed).replace(/\s+/g, ' ').trim();
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function marketplaceLimit(limit: number | undefined, fallback = 50): number {
  const value = Number.isFinite(limit) ? Math.trunc(Number(limit)) : fallback;
  return Math.max(1, Math.min(value, MAX_MARKETPLACE_PAGE_SIZE));
}

function parseOffsetCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function parseSearchBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'installed', 'installable', 'available'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'uninstalled', 'missing', 'unavailable'].includes(normalized)) return false;
  return undefined;
}

function tokenizeSearchQuery(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function normalizeSearchFields(fields?: MarketplaceSearchField[]): MarketplaceSearchField[] {
  if (!fields?.length) return [];
  return Array.from(new Set(fields.filter((field): field is MarketplaceSearchField => MARKETPLACE_SEARCH_FIELDS.has(field))));
}

function parseMarketplaceSearch(options: MarketplaceListOptions): ParsedMarketplaceSearch {
  const parsed: ParsedMarketplaceSearch = {
    terms: [],
    fields: normalizeSearchFields(options.fields),
    fieldTerms: [],
    installed: options.installed,
    installable: options.installable,
    transport: options.transport?.trim() || undefined,
  };

  for (const token of tokenizeSearchQuery(options.query || '')) {
    const separator = token.indexOf(':');
    if (separator > 0) {
      const key = token.slice(0, separator).trim().toLowerCase();
      const value = token.slice(separator + 1).trim();
      if (!value) continue;

      if (key === 'is') {
        const normalized = value.toLowerCase();
        if (normalized === 'installed') {
          parsed.installed = true;
          continue;
        }
        if (normalized === 'uninstalled') {
          parsed.installed = false;
          continue;
        }
        if (normalized === 'installable' || normalized === 'available') {
          parsed.installable = true;
          continue;
        }
        if (normalized === 'unavailable') {
          parsed.installable = false;
          continue;
        }
      }

      if (key === 'installed') {
        const flag = parseSearchBoolean(value);
        if (typeof flag === 'boolean') {
          parsed.installed = flag;
          continue;
        }
      }

      if (key === 'installable') {
        const flag = parseSearchBoolean(value);
        if (typeof flag === 'boolean') {
          parsed.installable = flag;
          continue;
        }
      }

      if (key === 'transport') {
        parsed.transport = value;
        continue;
      }

      if (MARKETPLACE_SEARCH_FIELDS.has(key as MarketplaceSearchField)) {
        parsed.fieldTerms.push({ field: key as MarketplaceSearchField, value });
        continue;
      }
    }

    parsed.terms.push(token);
  }

  return parsed;
}

function marketplaceEntryFieldValue(entry: MarketplaceEntry, field: MarketplaceSearchField): string {
  switch (field) {
    case 'id':
      return entry.id;
    case 'name':
      return entry.name;
    case 'title':
      return entry.title || '';
    case 'description':
      return entry.description || '';
    case 'version':
      return entry.version || '';
    case 'source':
      return entry.sourceId;
    case 'transport':
      return entry.transport || '';
    case 'repository':
      return entry.repositoryUrl || '';
    case 'remote':
      return entry.remoteUrl || '';
    default:
      return '';
  }
}

function marketplaceEntryHaystack(entry: MarketplaceEntry, fields: MarketplaceSearchField[]): string {
  const selectedFields = fields.length > 0
    ? fields
    : ['id', 'name', 'title', 'description', 'version', 'source', 'transport', 'repository', 'remote'] as MarketplaceSearchField[];
  return selectedFields.map((field) => marketplaceEntryFieldValue(entry, field)).join(' ').toLowerCase();
}

function marketplaceEntryMatchesSearch(entry: MarketplaceEntry, search: ParsedMarketplaceSearch): boolean {
  if (typeof search.installed === 'boolean' && entry.installed !== search.installed) return false;
  if (typeof search.installable === 'boolean' && entry.installable !== search.installable) return false;
  if (search.transport && !(entry.transport || '').toLowerCase().includes(search.transport.toLowerCase())) return false;

  for (const term of search.fieldTerms) {
    if (!marketplaceEntryFieldValue(entry, term.field).toLowerCase().includes(term.value.toLowerCase())) {
      return false;
    }
  }

  if (search.terms.length === 0) return true;
  const haystack = marketplaceEntryHaystack(entry, search.fields);
  return search.terms.every((term) => haystack.includes(term.toLowerCase()));
}

function paginateMarketplaceEntries<T>(
  entries: T[],
  options: Pick<MarketplaceListOptions, 'limit' | 'cursor'>,
  fallbackLimit = 50,
): { entries: T[]; nextCursor?: string } {
  const limit = marketplaceLimit(options.limit, fallbackLimit);
  const offset = parseOffsetCursor(options.cursor);
  const nextOffset = offset + limit;
  return {
    entries: entries.slice(offset, nextOffset),
    nextCursor: nextOffset < entries.length ? String(nextOffset) : undefined,
  };
}

function sourceMatchesKind(source: MarketplaceSourceConfig, kind?: MarketplaceKind): boolean {
  return !kind || source.type === MARKETPLACE_SOURCE_TYPE_BY_KIND[kind];
}

function encodeSourceCursors(cursors: Record<string, string>): string | undefined {
  const active = Object.fromEntries(Object.entries(cursors).filter(([, cursor]) => cursor));
  if (Object.keys(active).length === 0) return undefined;
  return `${MARKETPLACE_CURSOR_PREFIX}${Buffer.from(JSON.stringify(active), 'utf-8').toString('base64url')}`;
}

function decodeSourceCursors(cursor?: string): Record<string, string> {
  if (!cursor?.startsWith(MARKETPLACE_CURSOR_PREFIX)) return {};
  try {
    const raw = Buffer.from(cursor.slice(MARKETPLACE_CURSOR_PREFIX.length), 'base64url').toString('utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .map(([sourceId, value]) => [sourceId, value as string]),
    );
  } catch {/* expected: data unavailable */
    return {};
  }
}

async function fetchJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchForTools()(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        accept: 'application/vnd.github+json,application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {/* swallowed: unhandled error */
        body = '';
      }
      const bodySummary = summarizeMarketplaceResponseBody(body);
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      const error = new Error(
        bodySummary ? `HTTP ${response.status}${statusText}: ${bodySummary}` : `HTTP ${response.status}${statusText}`,
      ) as MarketplaceFetchError;
      error.status = response.status;
      error.statusCode = response.status;
      error.url = url;
      error.body = bodySummary;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function encodeUrlPath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function githubTreeSourceInfo(sourceUrl: string): { rawBaseUrl: string; repositoryBaseUrl: string } | null {
  if (sourceUrl === OPENAI_SKILLS_TREE_URL) {
    return {
      rawBaseUrl: OPENAI_SKILLS_RAW_BASE_URL,
      repositoryBaseUrl: `${OPENAI_SKILLS_REPOSITORY_URL}/tree/main`,
    };
  }

  try {
    const parsed = new URL(sourceUrl);
    if (parsed.hostname !== 'api.github.com') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 6 || segments[0] !== 'repos' || segments[3] !== 'git' || segments[4] !== 'trees') {
      return null;
    }
    const owner = segments[1];
    const repo = segments[2];
    const ref = decodeURIComponent(segments.slice(5).join('/')) || 'main';
    return {
      rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${encodeUrlPath(ref)}`,
      repositoryBaseUrl: `https://github.com/${owner}/${repo}/tree/${encodeUrlPath(ref)}`,
    };
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

function treeRawUrl(sourceUrl: string, path: string): string {
  const github = githubTreeSourceInfo(sourceUrl);
  if (github) return `${github.rawBaseUrl}/${encodeUrlPath(path)}`;
  return new URL(`/${path.replace(/^\/+/, '')}`, sourceUrl).toString();
}

function treeRepositoryUrl(sourceUrl: string, directoryPath: string): string | undefined {
  const github = githubTreeSourceInfo(sourceUrl);
  if (!github) return undefined;
  return `${github.repositoryBaseUrl}/${encodeUrlPath(directoryPath)}`;
}

function openAiSkillTreePath(path?: string): { name: string; directoryPath: string } | null {
  const match = typeof path === 'string'
    ? path.match(/^skills\/\.curated\/([^/]+)\/SKILL\.md$/)
    : null;
  if (!match?.[1]) return null;
  return { name: match[1], directoryPath: `skills/.curated/${match[1]}` };
}

function extractSkillIndexEntries(source: MarketplaceSourceConfig, payload: unknown): SkillIndexEntry[] {
  const root = asRecord(payload);
  if (Array.isArray(root.skills)) return root.skills as SkillIndexEntry[];
  if (Array.isArray(root.entries)) return root.entries as SkillIndexEntry[];
  if (Array.isArray(payload)) return payload as SkillIndexEntry[];

  const tree = Array.isArray(root.tree) ? root.tree as GitHubTreeEntry[] : [];
  if (tree.length === 0 || !source.url) return [];

  const skillDirs = new Map<string, string>();
  for (const entry of tree) {
    const match = openAiSkillTreePath(entry.path);
    if (match) skillDirs.set(match.name, match.directoryPath);
  }

  return Array.from(skillDirs.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, directoryPath]) => {
      const files = tree
        .filter((entry) => {
          if (!entry.path || (entry.type && entry.type !== 'blob')) return false;
          return entry.path === `${directoryPath}/SKILL.md` || entry.path.startsWith(`${directoryPath}/`);
        })
        .map((entry) => ({
          path: entry.path,
          targetPath: entry.path!.slice(directoryPath.length + 1),
          url: treeRawUrl(source.url!, entry.path!),
        }));

      return {
        id: name,
        name,
        title: name,
        description: source.official ? `OpenAI curated skill: ${name}` : `Curated skill: ${name}`,
        url: treeRawUrl(source.url!, `${directoryPath}/SKILL.md`),
        repositoryUrl: treeRepositoryUrl(source.url!, directoryPath),
        directoryPath,
        files,
      };
    });
}

function sanitizeSkillInstallName(input: string): string {
  const base = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return base || sanitizeToolId(input).replace(/^mcp_/, '') || 'skill';
}

function isSafeSkillRelativePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

function mcpInstalledServerNames(): Set<string> {
  return new Set((runtimeConfig.mcp?.servers || []).map((server) => server.name));
}

function mcpEntryId(sourceId: string, serverName: string, version?: string): string {
  return `mcp:${sourceId}:${serverName}${version ? `:${version}` : ''}`;
}

function parseMcpEntryId(id: string): { sourceId: string; serverName: string; version?: string } | null {
  if (!id.startsWith('mcp:')) return null;
  const rest = id.slice(4);
  const first = rest.indexOf(':');
  if (first <= 0) return null;
  const sourceId = rest.slice(0, first);
  const remainder = rest.slice(first + 1);
  const second = remainder.lastIndexOf(':');
  if (second <= 0) return { sourceId, serverName: remainder };
  const serverName = remainder.slice(0, second);
  const version = remainder.slice(second + 1);
  return { sourceId, serverName, version };
}

function toMcpMarketplaceEntry(sourceId: string, response: McpRegistryServerResponse): MarketplaceEntry | null {
  const server = response.server;
  if (!server?.name) return null;
  const remote = (server.remotes || []).find((item) =>
    item.type === 'streamable-http' && typeof item.url === 'string' && item.url.length > 0
  );
  return {
    id: mcpEntryId(sourceId, server.name, server.version),
    kind: 'mcp',
    sourceId,
    name: server.name,
    title: server.title,
    description: server.description || '',
    version: server.version,
    installed: mcpInstalledServerNames().has(server.name),
    installable: Boolean(remote),
    transport: remote?.type,
    remoteUrl: remote?.url,
    repositoryUrl: server.repository?.url || server.websiteUrl,
    raw: response,
  };
}

async function listMcpRegistry(source: MarketplaceSourceConfig, options: MarketplaceListOptions): Promise<MarketplaceListResult> {
  const baseUrl = (source.url || OFFICIAL_MCP_REGISTRY_URL).replace(/\/+$/, '');
  const search = parseMarketplaceSearch(options);
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(marketplaceLimit(options.limit, 50), 100)));
  if (options.cursor) params.set('cursor', options.cursor);
  const registrySearch = [
    ...search.terms,
    ...search.fieldTerms
      .filter((term) => ['name', 'title', 'description'].includes(term.field))
      .map((term) => term.value),
  ].join(' ').trim();
  if (registrySearch) params.set('search', registrySearch);
  const payload = await fetchJson(`${baseUrl}/${MCP_REGISTRY_API_VERSION}/servers?${params.toString()}`);
  const root = asRecord(payload);
  const servers = Array.isArray(root.servers) ? root.servers : [];
  const metadata = asRecord(root.metadata);
  const latestServers = latestMcpRegistryVersions(servers as McpRegistryServerResponse[]);
  return {
    sources: configuredSources(),
    entries: latestServers
      .map((item: McpRegistryServerResponse) => toMcpMarketplaceEntry(source.id, item))
      .filter((item: MarketplaceEntry | null): item is MarketplaceEntry => Boolean(item))
      .filter((entry) => marketplaceEntryMatchesSearch(entry, search)),
    nextCursor: typeof metadata.nextCursor === 'string' ? metadata.nextCursor : undefined,
    fetchedAt: now(),
  };
}

async function getMcpRegistryEntry(source: MarketplaceSourceConfig, serverName: string, version?: string): Promise<McpRegistryServerResponse | null> {
  const baseUrl = (source.url || OFFICIAL_MCP_REGISTRY_URL).replace(/\/+$/, '');
  const encodedName = encodeURIComponent(serverName);
  const url = version
    ? `${baseUrl}/${MCP_REGISTRY_API_VERSION}/servers/${encodedName}/versions/${encodeURIComponent(version)}`
    : `${baseUrl}/${MCP_REGISTRY_API_VERSION}/servers/${encodedName}/versions`;
  const payload = await fetchJson(url);
  if (version) return payload as McpRegistryServerResponse;
  const root = asRecord(payload);
  const servers = Array.isArray(root.servers) ? root.servers : [];
  return latestMcpRegistryVersions(servers as McpRegistryServerResponse[]).find((item) => item.server?.name === serverName)
    || servers.find((item: McpRegistryServerResponse) => item.server?.name === serverName && isLatestMcpVersion(item))
    || servers[0]
    || null;
}

function isLatestMcpVersion(item: McpRegistryServerResponse): boolean {
  const official = item._meta?.['io.modelcontextprotocol.registry/official'] as McpOfficialMeta | undefined;
  return official?.isLatest === true;
}

function isActiveMcpVersion(item: McpRegistryServerResponse): boolean {
  const official = item._meta?.['io.modelcontextprotocol.registry/official'] as McpOfficialMeta | undefined;
  const status = typeof official?.status === 'string' ? official.status : 'active';
  return status !== 'deleted' && status !== 'deprecated';
}

function mcpVersionSortKey(item: McpRegistryServerResponse): string {
  const official = item._meta?.['io.modelcontextprotocol.registry/official'] as McpOfficialMeta | undefined;
  return String(official?.updatedAt || official?.publishedAt || item.server?.version || '');
}

function latestMcpRegistryVersions(items: McpRegistryServerResponse[]): McpRegistryServerResponse[] {
  const byName = new Map<string, McpRegistryServerResponse>();
  for (const item of items) {
    const name = item.server?.name;
    if (!name || !isActiveMcpVersion(item)) continue;
    const current = byName.get(name);
    if (!current) {
      byName.set(name, item);
      continue;
    }
    if (isLatestMcpVersion(item) && !isLatestMcpVersion(current)) {
      byName.set(name, item);
      continue;
    }
    if (isLatestMcpVersion(item) === isLatestMcpVersion(current) && mcpVersionSortKey(item) > mcpVersionSortKey(current)) {
      byName.set(name, item);
    }
  }
  return Array.from(byName.values());
}

function localSkillEntries(workspace: string, sourceId: string, options: MarketplaceListOptions): { entries: MarketplaceEntry[]; nextCursor?: string } {
  const search = parseMarketplaceSearch(options);
  const entries = collectAvailableSkills(workspace, { disabledNames: [], maxActive: 9999 })
    .filter((skill) => skill.source !== 'plugin')
    .map((skill: SkillDescriptor) => ({
      id: `skill:${sourceId}:${skill.name}`,
      kind: 'skill' as const,
      sourceId,
      name: skill.name,
      title: skill.name,
      description: skill.summary,
      installed: skill.source === 'global' || skill.source === 'project',
      installable: existsSync(skill.path),
      path: skill.path,
      raw: skill,
    }))
    .filter((entry) => marketplaceEntryMatchesSearch(entry, search));
  return paginateMarketplaceEntries(entries, options);
}

function pluginEntryId(sourceId: string, pluginId: string): string {
  return `plugin:${sourceId}:${pluginId}`;
}

function parsePluginEntryId(id: string): { sourceId: string; pluginId: string } | null {
  if (!id.startsWith('plugin:')) return null;
  const rest = id.slice(7);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { sourceId: rest.slice(0, sep), pluginId: rest.slice(sep + 1) };
}

function localPluginEntries(workspace: string, sourceId: string, options: MarketplaceListOptions): { entries: MarketplaceEntry[]; nextCursor?: string } {
  const search = parseMarketplaceSearch(options);
  const entries = discoverPlugins(workspace)
    .map((plugin) => ({
      id: pluginEntryId(sourceId, plugin.id),
      kind: 'plugin' as const,
      sourceId,
      name: plugin.id,
      title: plugin.name,
      description: plugin.description,
      version: plugin.version,
      installed: plugin.scope === 'global',
      installable: existsSync(plugin.path),
      path: plugin.path,
      raw: plugin,
    }))
    .filter((entry) => marketplaceEntryMatchesSearch(entry, search));
  return paginateMarketplaceEntries(entries, options);
}

function parseSkillEntryId(id: string): { sourceId: string; skillId: string } | null {
  if (!id.startsWith('skill:')) return null;
  const rest = id.slice(6);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { sourceId: rest.slice(0, sep), skillId: rest.slice(sep + 1) };
}

async function listSkillIndex(source: MarketplaceSourceConfig, options: MarketplaceListOptions): Promise<MarketplaceListResult> {
  if (!source.url) {
    const result = localSkillEntries(options.workspace || process.cwd(), source.id, options);
    return {
      sources: configuredSources(),
      entries: result.entries,
      nextCursor: result.nextCursor,
      fetchedAt: now(),
    };
  }
  const payload = await fetchJson(source.url);
  const rawEntries = extractSkillIndexEntries(source, payload);
  const installed = new Set(collectAvailableSkills(options.workspace || process.cwd(), { disabledNames: [], maxActive: 9999 })
    .filter((skill) => skill.source !== 'plugin')
    .map((skill) => skill.name));
  const search = parseMarketplaceSearch(options);
  const filteredEntries = (rawEntries as SkillIndexEntry[])
    .filter((entry) => entry && (entry.name || entry.id))
    .map((entry) => {
      const name = entry.name || entry.id || 'skill';
      return {
        id: `skill:${source.id}:${entry.id || name}`,
        kind: 'skill' as const,
        sourceId: source.id,
        name,
        title: entry.title || name,
        description: entry.description || entry.summary || '',
        version: entry.version,
        installed: installed.has(name),
        installable: Boolean(entry.content || entry.url || entry.path || entry.files?.length),
        remoteUrl: entry.url,
        repositoryUrl: entry.repositoryUrl,
        path: entry.path,
        raw: entry,
      };
    })
    .filter((entry) => marketplaceEntryMatchesSearch(entry, search));
  const page = paginateMarketplaceEntries(filteredEntries, options);
  return { sources: configuredSources(), entries: page.entries, nextCursor: page.nextCursor, fetchedAt: now() };
}

async function listPluginIndex(source: MarketplaceSourceConfig, options: MarketplaceListOptions): Promise<MarketplaceListResult> {
  if (!source.url) {
    const result = localPluginEntries(options.workspace || process.cwd(), source.id, options);
    return {
      sources: configuredSources(),
      entries: result.entries,
      nextCursor: result.nextCursor,
      fetchedAt: now(),
    };
  }
  const payload = await fetchJson(source.url);
  const root = asRecord(payload);
  const rawEntries = Array.isArray(root.plugins)
    ? root.plugins
    : Array.isArray(root.entries)
      ? root.entries
      : Array.isArray(payload)
        ? payload
        : [];
  const installed = new Set(discoverPlugins(options.workspace || process.cwd()).map((plugin) => plugin.id));
  const search = parseMarketplaceSearch(options);
  const filteredEntries = (rawEntries as PluginIndexEntry[])
    .filter((entry) => entry && (entry.name || entry.id))
    .map((entry) => {
      const name = entry.name || entry.id || 'plugin';
      return {
        id: pluginEntryId(source.id, entry.id || name),
        kind: 'plugin' as const,
        sourceId: source.id,
        name,
        title: entry.title || entry.displayName || name,
        description: entry.description || entry.summary || '',
        version: entry.version,
        installed: installed.has(entry.id || name),
        installable: Boolean(entry.path || entry.url),
        remoteUrl: entry.url,
        repositoryUrl: entry.repositoryUrl || entry.homepage,
        path: entry.path,
        raw: entry,
      };
    })
    .filter((entry) => marketplaceEntryMatchesSearch(entry, search));
  const page = paginateMarketplaceEntries(filteredEntries, options);
  return { sources: configuredSources(), entries: page.entries, nextCursor: page.nextCursor, fetchedAt: now() };
}

function persistConfig(): void {
  ConfigSchema.parse(runtimeConfig);
  saveSettings(runtimeConfig);
}

function persistMcpConfig(nextMcp: NonNullable<typeof runtimeConfig.mcp>): McpServerConfig[] {
  const previousMcp = runtimeConfig.mcp;
  const validated = ConfigSchema.parse({ ...runtimeConfig, mcp: nextMcp });
  runtimeConfig.mcp = validated.mcp;
  try {
    saveSettings(runtimeConfig);
  } catch (error) {
    runtimeConfig.mcp = previousMcp;
    throw error;
  }
  void resetRuntimeMcpClient().catch(() => undefined);
  return runtimeConfig.mcp.servers;
}

function persistMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  return persistMcpConfig({
    ...(runtimeConfig.mcp || { enabled: true, servers: [], tool_timeout_ms: 60_000 }),
    servers,
  });
}

function installMcpServerFromEntry(source: MarketplaceSourceConfig, entry: McpRegistryServerResponse): McpServerConfig {
  const server = entry.server;
  if (!server?.name) throw new Error('MCP registry entry missing server.name');
  const remote = (server.remotes || []).find((item) =>
    item.type === 'streamable-http' && typeof item.url === 'string' && item.url.length > 0
  );
  if (!remote?.url || remote.type !== 'streamable-http') {
    throw new Error('MCP registry entry has no installable streamable-http remote');
  }
  const id = sanitizeToolId(server.name);
  const installedAt = now();
  const next: McpServerConfig = {
    id,
    name: server.name,
    title: server.title,
    description: server.description,
    enabled: true,
    transport: remote.type,
    url: remote.url,
    headers: (remote.headers || [])
      .filter((header) => typeof header.name === 'string' && typeof header.value === 'string')
      .map((header) => ({ name: header.name!, value: header.value! })),
    registry: {
      source_id: source.id,
      server_name: server.name,
      version: server.version,
    },
    installed_at: installedAt,
    updated_at: installedAt,
  };
  const servers = runtimeConfig.mcp?.servers || [];
  const existingIndex = servers.findIndex((item) => item.name === next.name || item.id === next.id);
  const persisted = persistMcpServers(
    existingIndex >= 0
      ? servers.map((item, index) => index === existingIndex ? { ...next, id: item.id, installed_at: item.installed_at || installedAt } : item)
      : [...servers, next]
  );
  return persisted.find((item) => item.id === next.id || item.name === next.name) || next;
}

async function installSkillFromIndex(source: MarketplaceSourceConfig, entryId: string, workspace: string): Promise<{ name: string; path: string }> {
  const parsed = parseSkillEntryId(entryId);
  if (!parsed) throw new Error('Invalid skill marketplace entry id');

  if (!source.url) {
    const existing = collectAvailableSkills(workspace, { disabledNames: [], maxActive: 9999 })
      .filter((skill) => skill.source !== 'plugin')
      .find((skill) => skill.name === parsed.skillId);
    if (!existing) throw new Error(`Skill not found: ${parsed.skillId}`);
    const targetDir = getGlobalSkillsDir();
    mkdirSync(targetDir, { recursive: true });
    const target = existing.path.endsWith('.md') ? join(targetDir, `${existing.name}.md`) : join(targetDir, existing.name);
    cpSync(existing.path, target, { recursive: true, force: true });
    return { name: existing.name, path: target };
  }

  const listed = await listSkillIndex(source, { workspace, limit: 200 });
  const entry = listed.entries.find((item) => item.id === entryId || item.name === parsed.skillId);
  if (!entry) throw new Error(`Skill entry not found: ${entryId}`);
  const raw = entry.raw as SkillIndexEntry;
  const targetDir = getGlobalSkillsDir();
  mkdirSync(targetDir, { recursive: true });
  const safeName = sanitizeSkillInstallName(entry.name) || basename(entry.name);

  if (raw.files?.length) {
    const target = join(targetDir, safeName);
    mkdirSync(target, { recursive: true });
    let wroteSkillFile = false;
    for (const file of raw.files) {
      const relativePath = file.targetPath
        || (raw.directoryPath && file.path?.startsWith(`${raw.directoryPath}/`)
          ? file.path.slice(raw.directoryPath.length + 1)
          : file.path);
      if (!relativePath || !isSafeSkillRelativePath(relativePath)) {
        throw new Error(`Unsafe skill file path: ${relativePath || '(empty)'}`);
      }
      const url = file.url || (source.url && file.path ? treeRawUrl(source.url, file.path) : undefined);
      if (!url) throw new Error(`Skill file has no downloadable url: ${relativePath}`);
      const response = await fetchForTools()(url, {
        cache: 'no-store',
        headers: {
          accept: '*/*',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
      });
      if (!response.ok) throw new Error(`Failed to download skill file ${relativePath}: HTTP ${response.status}`);
      const destination = join(target, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      wroteSkillFile ||= relativePath === 'SKILL.md';
    }
    if (!wroteSkillFile) throw new Error('Skill directory entry did not include SKILL.md');
    return { name: safeName, path: target };
  }

  const target = join(targetDir, `${safeName}.md`);
  let content = raw.content;
  if (!content && raw.url) {
    const response = await fetchForTools()(raw.url, {
      cache: 'no-store',
      headers: {
        accept: 'text/markdown,text/plain,*/*',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    if (!response.ok) throw new Error(`Failed to download skill: HTTP ${response.status}`);
    content = await response.text();
  }
  if (!content) throw new Error('Skill entry has no content or downloadable url');
  writeFileSync(target, content, 'utf-8');
  return { name: safeName, path: target };
}

async function installPluginFromIndex(source: MarketplaceSourceConfig, entryId: string, workspace: string): Promise<unknown> {
  const parsed = parsePluginEntryId(entryId);
  if (!parsed) throw new Error('Invalid plugin marketplace entry id');

  const listed = await listPluginIndex(source, { workspace, limit: 200 });
  const entry = listed.entries.find((item) => item.id === entryId || item.name === parsed.pluginId);
  if (!entry) throw new Error(`Plugin entry not found: ${entryId}`);
  const raw = entry.raw as PluginIndexEntry | undefined;
  const sourcePath = entry.path || raw?.path;
  if (sourcePath) {
    if (!isPluginRootUnderAllowedDir(sourcePath, workspace)) {
      throw new Error('Local plugin path must be inside a configured plugin directory.');
    }
    return installLocalPlugin(sourcePath, workspace);
  }
  if (entry.remoteUrl || raw?.url) {
    return { success: false, reason: 'remote_plugin_download_not_supported' };
  }
  throw new Error('Plugin entry has no local path.');
}

export function getMarketplaceSources(): MarketplaceSourceConfig[] {
  return configuredSources();
}

export function getAllMarketplaceSources(): MarketplaceSourceConfig[] {
  return normalizeMarketplaceSources(runtimeConfig.marketplaces?.sources);
}

export function upsertMarketplaceSource(source: MarketplaceSourceConfig): MarketplaceSourceConfig {
  if (!MARKETPLACE_SOURCE_ID_RE.test(source.id || '')) {
    throw new Error('Marketplace source id must start with a lowercase letter and contain only a-z, 0-9, _ or -.');
  }
  if (source.type === 'mcp_registry' && !source.url) {
    throw new Error('MCP registry marketplace source requires url.');
  }
  const current = getAllMarketplaceSources();
  const existing = current.find((item) => item.id === source.id);
  const next: MarketplaceSourceConfig = {
    ...source,
    enabled: source.enabled !== false,
    official: existing?.official === true || source.official === true,
  };
  const existingIndex = current.findIndex((item) => item.id === next.id);
  runtimeConfig.marketplaces = {
    ...(runtimeConfig.marketplaces || { sources: [] }),
    sources: existingIndex >= 0
      ? current.map((item, index) => index === existingIndex ? { ...item, ...next } : item)
      : [...current, next],
  };
  persistConfig();
  return next;
}

export function patchMarketplaceSource(id: string, patch: Partial<MarketplaceSourceConfig>): MarketplaceSourceConfig | null {
  const current = getAllMarketplaceSources();
  const existing = current.find((item) => item.id === id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    id: existing.id,
    type: patch.type || existing.type,
    official: existing.official === true,
  } as MarketplaceSourceConfig;
  return upsertMarketplaceSource(next);
}

export function removeMarketplaceSource(id: string): MarketplaceSourceConfig | null {
  const current = getAllMarketplaceSources();
  const existing = current.find((item) => item.id === id);
  if (!existing) return null;
  if (existing.official) {
    return patchMarketplaceSource(id, { enabled: false });
  }
  runtimeConfig.marketplaces = {
    ...(runtimeConfig.marketplaces || { sources: [] }),
    sources: current.filter((item) => item.id !== id),
  };
  persistConfig();
  return existing;
}

export function getInstalledMcpServers(): McpServerConfig[] {
  return runtimeConfig.mcp?.servers || [];
}

export async function listMarketplaceEntries(options: MarketplaceListOptions = {}): Promise<MarketplaceListResult> {
  const sources = configuredSources();
  const selected = (options.sourceId ? sources.filter((source) => source.id === options.sourceId) : sources)
    .filter((source) => sourceMatchesKind(source, options.kind));
  const requestedSourceCursors = decodeSourceCursors(options.cursor);
  const hasAggregateCursor = Boolean(options.cursor?.startsWith(MARKETPLACE_CURSOR_PREFIX));
  const nextSourceCursors: Record<string, string> = {};
  const entries: MarketplaceEntry[] = [];
  let nextCursor: string | undefined;
  let fetchedAt = now();
  for (const source of selected) {
    if (hasAggregateCursor && !requestedSourceCursors[source.id]) {
      continue;
    }
    const sourceOptions = {
      ...options,
      cursor: requestedSourceCursors[source.id] || (hasAggregateCursor ? undefined : options.cursor),
    };
    if (source.type === 'mcp_registry') {
      const result = await listMcpRegistry(source, sourceOptions);
      entries.push(...result.entries);
      if (result.nextCursor) nextSourceCursors[source.id] = result.nextCursor;
      fetchedAt = Math.max(fetchedAt, result.fetchedAt);
    } else if (source.type === 'skill_index') {
      const result = await listSkillIndex(source, sourceOptions);
      entries.push(...result.entries);
      if (result.nextCursor) nextSourceCursors[source.id] = result.nextCursor;
      fetchedAt = Math.max(fetchedAt, result.fetchedAt);
    } else {
      const result = await listPluginIndex(source, sourceOptions);
      entries.push(...result.entries);
      if (result.nextCursor) nextSourceCursors[source.id] = result.nextCursor;
      fetchedAt = Math.max(fetchedAt, result.fetchedAt);
    }
  }
  nextCursor = selected.length === 1 ? nextSourceCursors[selected[0].id] : encodeSourceCursors(nextSourceCursors);
  return { sources, entries, nextCursor, fetchedAt };
}

export async function installMarketplaceEntry(options: InstallMarketplaceEntryOptions): Promise<{ kind: MarketplaceKind; installed: unknown }> {
  const mcp = parseMcpEntryId(options.id);
  if (mcp) {
    const source = configuredSources().find((item) => item.id === (options.sourceId || mcp.sourceId));
    if (!source || source.type !== 'mcp_registry') throw new Error(`MCP marketplace source not found: ${options.sourceId || mcp.sourceId}`);
    const entry = await getMcpRegistryEntry(source, mcp.serverName, mcp.version);
    if (!entry) throw new Error(`MCP server not found: ${mcp.serverName}`);
    return { kind: 'mcp', installed: installMcpServerFromEntry(source, entry) };
  }

  const skill = parseSkillEntryId(options.id);
  if (skill) {
    const source = configuredSources().find((item) => item.id === (options.sourceId || skill.sourceId));
    if (!source || source.type !== 'skill_index') throw new Error(`Skill marketplace source not found: ${options.sourceId || skill.sourceId}`);
    return { kind: 'skill', installed: await installSkillFromIndex(source, options.id, options.workspace || process.cwd()) };
  }

  const plugin = parsePluginEntryId(options.id);
  if (plugin) {
    const source = configuredSources().find((item) => item.id === (options.sourceId || plugin.sourceId));
    if (!source || source.type !== 'plugin_index') throw new Error(`Plugin marketplace source not found: ${options.sourceId || plugin.sourceId}`);
    return { kind: 'plugin', installed: await installPluginFromIndex(source, options.id, options.workspace || process.cwd()) };
  }

  throw new Error(`Unknown marketplace entry id: ${options.id}`);
}

export function upsertMcpServer(server: McpServerConfig): McpServerConfig {
  const servers = runtimeConfig.mcp?.servers || [];
  const timestamp = now();
  const normalized = {
    ...server,
    installed_at: server.installed_at || timestamp,
    updated_at: timestamp,
  } as McpServerConfig;
  const existingIndex = servers.findIndex((item) => item.id === normalized.id);
  const persisted = persistMcpServers(
    existingIndex >= 0
      ? servers.map((item, index) => index === existingIndex ? normalized : item)
      : [...servers, normalized]
  );
  return persisted.find((item) => item.id === normalized.id) || normalized;
}

export function updateMcpServerEnabled(id: string, enabled: boolean): McpServerConfig | null {
  const servers = runtimeConfig.mcp?.servers || [];
  const updated = servers.find((server) => server.id === id);
  if (!updated) return null;
  const next = servers.map((server) =>
    server.id === id ? { ...server, enabled, updated_at: now() } as McpServerConfig : server
  );
  const persisted = persistMcpServers(next);
  return persisted.find((server) => server.id === id) || null;
}

export function removeMcpServer(id: string): boolean {
  const servers = runtimeConfig.mcp?.servers || [];
  const next = servers.filter((server) => server.id !== id);
  if (next.length === servers.length) return false;
  persistMcpServers(next);
  return true;
}
