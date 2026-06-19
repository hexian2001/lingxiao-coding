/**
 * McpShare — MCP 配置分享链接生成/解析/导入核心
 *
 * 契约: contract:mcp-share v1
 *
 * 安全模型:
 * - 分享时脱敏 env values → env_keys, header values → header_names
 * - 移除 origin, installed_at, updated_at
 * - 导入后含脱敏字段 → enabled=false
 */

import type { McpServerConfig } from '../../config.js';
import { getInstalledMcpServers, upsertMcpServer } from '../MarketplaceService.js';

// ── 常量 ───────────────────────────────────────────────────────────────

const SHARE_VERSION = 1 as const;
const MAX_SHARE_SERVERS = 20;
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB base64url encoded
const SERVER_ID_REGEX = /^[a-z][a-z0-9_]{1,79}$/;

export const SHARE_URL_SCHEME = 'lingxiao://mcp/share';
export const SHARE_URL_VERSION_PARAM = 'v=1';

// ── 类型定义 ───────────────────────────────────────────────────────────

/** 脱敏后的 MCP Server 配置（可安全分享） */
export interface SharedMcpServerConfig {
  id: string;
  name: string;
  title?: string;
  description?: string;
  enabled: boolean;
  transport: 'stdio' | 'streamable-http';

  // stdio
  command?: string;
  args?: string[];
  env_keys?: string[];
  cwd?: string | null;

  // streamable-http
  url?: string;
  header_names?: string[];

  // 通用
  registry?: {
    source_id?: string;
    server_name?: string;
    version?: string;
  };
}

/** 分享链接内部 payload */
export interface McpSharePayload {
  v: 1;
  name?: string;
  description?: string;
  created_at: number;
  servers: SharedMcpServerConfig[];
}

/** 冲突策略 */
export type ConflictStrategy = 'skip' | 'overwrite' | 'rename';

/** 导入结果 */
export interface ImportResult {
  imported: McpServerConfig[];
  skipped: string[];
  overwritten: string[];
  renamed: string[];
  requires_secrets: string[];
}

/** 分享生成结果 */
export interface ShareResult {
  share_token: string;
  share_url: string;
  payload: McpSharePayload;
}

// ── 自定义错误 ─────────────────────────────────────────────────────────

export type McpShareErrorCode =
  | 'no_servers_selected'
  | 'server_not_found'
  | 'too_many_servers'
  | 'payload_too_large'
  | 'share_token_invalid'
  | 'share_version_unsupported'
  | 'bundle_format_invalid'
  | 'bundle_version_unsupported'
  | 'invalid_server_id_map'
  | 'mcp_server_save_failed';

export class McpShareError extends Error {
  constructor(
    public code: McpShareErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpShareError';
  }
}

// ── base64url 工具 ─────────────────────────────────────────────────────

function toBase64Url(str: string): string {
  const buf = Buffer.from(str, 'utf-8');
  return buf.toString('base64url');
}

function fromBase64Url(b64: string): string {
  // base64url → base64
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64').toString('utf-8');
}

// ── 脱敏逻辑 ───────────────────────────────────────────────────────────

/**
 * 将 McpServerConfig 脱敏为 SharedMcpServerConfig
 * - stdio: env 的值剥离，只保留 env_keys
 * - streamable-http: headers 的 value 剥离，只保留 header_names
 * - 移除 origin, installed_at, updated_at
 */
export function sanitizeServer(server: McpServerConfig): SharedMcpServerConfig {
  const shared: SharedMcpServerConfig = {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
  };

  if (server.title !== undefined) shared.title = server.title;
  if (server.description !== undefined) shared.description = server.description;
  if (server.registry !== undefined) shared.registry = server.registry;

  if (server.transport === 'stdio') {
    shared.command = server.command;
    shared.args = server.args;
    // 脱敏: env 只保留键名
    const envKeys = Object.keys(server.env || {});
    if (envKeys.length > 0) {
      shared.env_keys = envKeys;
    }
    if (server.cwd !== undefined) shared.cwd = server.cwd ?? null;
  } else {
    // streamable-http
    shared.url = server.url;
    // 脱敏: headers 只保留 name
    const headerNames = (server.headers || []).map((h) => h.name);
    if (headerNames.length > 0) {
      shared.header_names = headerNames;
    }
  }

  return shared;
}

// ── 还原逻辑 ───────────────────────────────────────────────────────────

/**
 * 将 SharedMcpServerConfig 还原为 McpServerConfig
 * - 含脱敏字段（env_keys 或 header_names 非空）→ enabled=false
 * - origin 设为空对象 {}, installed_at/updated_at 设为当前时间
 */
export function restoreServer(
  shared: SharedMcpServerConfig,
  idOverride?: string,
): McpServerConfig {
  const now = Date.now();
  const id = idOverride ?? shared.id;

  const hasSecrets =
    (shared.env_keys && shared.env_keys.length > 0) ||
    (shared.header_names && shared.header_names.length > 0);

  const enabled = hasSecrets ? false : shared.enabled;

  if (shared.transport === 'stdio') {
    return {
      id,
      name: shared.name,
      ...(shared.title !== undefined ? { title: shared.title } : {}),
      ...(shared.description !== undefined ? { description: shared.description } : {}),
      enabled,
      transport: 'stdio',
      command: shared.command || '',
      args: shared.args || [],
      env: {}, // 密钥需用户补全
      ...(shared.cwd ? { cwd: shared.cwd } : {}),
      ...(shared.registry ? { registry: shared.registry } : {}),
      origin: {},
      installed_at: now,
      updated_at: now,
    };
  }

  // streamable-http
  return {
    id,
    name: shared.name,
    ...(shared.title !== undefined ? { title: shared.title } : {}),
    ...(shared.description !== undefined ? { description: shared.description } : {}),
    enabled,
    transport: 'streamable-http',
    url: shared.url || '',
    headers: [], // 密钥需用户补全
    ...(shared.registry ? { registry: shared.registry } : {}),
    origin: {},
    installed_at: now,
    updated_at: now,
  };
}

// ── 分享链接生成 ───────────────────────────────────────────────────────

/**
 * 生成分享链接
 * @param serverIds 要分享的 server ID 列表
 * @param name 分享名称
 * @param description 分享描述
 * @returns share_token + share_url + payload
 */
export function generateShareLink(
  serverIds: string[],
  name?: string,
  description?: string,
): ShareResult {
  // 验证 server_ids
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    throw new McpShareError('no_servers_selected', 'At least one server_id is required.');
  }

  if (serverIds.length > MAX_SHARE_SERVERS) {
    throw new McpShareError(
      'too_many_servers',
      `Maximum ${MAX_SHARE_SERVERS} servers per share.`,
    );
  }

  // 获取已安装的 servers
  const installed = getInstalledMcpServers();
  const installedMap = new Map(installed.map((s) => [s.id, s]));

  const sharedServers: SharedMcpServerConfig[] = [];
  for (const id of serverIds) {
    const server = installedMap.get(id);
    if (!server) {
      throw new McpShareError('server_not_found', `Server not found: ${id}`);
    }
    sharedServers.push(sanitizeServer(server));
  }

  const payload: McpSharePayload = {
    v: SHARE_VERSION,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    created_at: Date.now(),
    servers: sharedServers,
  };

  const payloadJson = JSON.stringify(payload);
  const shareToken = toBase64Url(payloadJson);
  const shareUrl = `${SHARE_URL_SCHEME}?${SHARE_URL_VERSION_PARAM}&d=${shareToken}`;

  if (shareUrl.length > MAX_PAYLOAD_BYTES) {
    throw new McpShareError(
      'payload_too_large',
      `Share payload exceeds ${MAX_PAYLOAD_BYTES} bytes after encoding.`,
    );
  }

  return { share_token: shareToken, share_url: shareUrl, payload };
}

// ── 分享链接解析 ───────────────────────────────────────────────────────

/**
 * 解析分享 token，返回 McpSharePayload
 * @param shareToken base64url 编码的 McpSharePayload
 */
export function parseShareToken(shareToken: string): McpSharePayload {
  let payloadJson: string;
  try {
    payloadJson = fromBase64Url(shareToken);
  } catch {
    throw new McpShareError('share_token_invalid', 'Invalid share token format.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new McpShareError('share_token_invalid', 'Invalid share token format.');
  }

  if (!payload || typeof payload !== 'object') {
    throw new McpShareError('share_token_invalid', 'Invalid share token format.');
  }

  const obj = payload as Record<string, unknown>;
  if (obj.v !== SHARE_VERSION) {
    throw new McpShareError(
      'share_version_unsupported',
      `Unsupported share version: ${obj.v}.`,
    );
  }

  if (!Array.isArray(obj.servers)) {
    throw new McpShareError('share_token_invalid', 'Invalid share token format.');
  }

  return payload as McpSharePayload;
}

// ── 导入逻辑 ───────────────────────────────────────────────────────────

/**
 * 验证 server_id_map 中的新 ID 是否合法
 */
function validateServerIdMap(
  serverIdMap: Record<string, string> | undefined,
): void {
  if (!serverIdMap) return;
  for (const [originalId, newId] of Object.entries(serverIdMap)) {
    if (!SERVER_ID_REGEX.test(newId)) {
      throw new McpShareError(
        'invalid_server_id_map',
        `Invalid server ID in map: ${newId}.`,
      );
    }
    // originalId 不需要校验格式（它来自 payload）
    void originalId;
  }
}

/**
 * 冲突处理：根据策略决定最终 ID
 * @returns 最终 ID 或 null（表示跳过）
 */
function resolveConflict(
  desiredId: string,
  existingIds: Set<string>,
  strategy: ConflictStrategy,
): { id: string; action: 'import' | 'skip' | 'overwrite' | 'rename'; originalId: string } {
  if (!existingIds.has(desiredId)) {
    return { id: desiredId, action: 'import', originalId: desiredId };
  }

  switch (strategy) {
    case 'skip':
      return { id: desiredId, action: 'skip', originalId: desiredId };

    case 'overwrite':
      return { id: desiredId, action: 'overwrite', originalId: desiredId };

    case 'rename': {
      let suffix = 2;
      let newId = `${desiredId}_${suffix}`;
      while (existingIds.has(newId)) {
        suffix++;
        newId = `${desiredId}_${suffix}`;
      }
      return { id: newId, action: 'rename', originalId: desiredId };
    }

    default:
      return { id: desiredId, action: 'skip', originalId: desiredId };
  }
}

/**
 * 核心导入逻辑（可被 McpBundle 复用）
 * @param servers 脱敏后的 server 列表
 * @param serverIdMap ID 重命名映射
 * @param conflictStrategy 冲突策略
 */
export function validateImportInput(
  servers: SharedMcpServerConfig[],
  serverIdMap?: Record<string, string>,
  conflictStrategy: ConflictStrategy = 'skip',
): ImportResult {
  validateServerIdMap(serverIdMap);

  const installed = getInstalledMcpServers();
  const existingIds = new Set(installed.map((s) => s.id));

  const result: ImportResult = {
    imported: [],
    skipped: [],
    overwritten: [],
    renamed: [],
    requires_secrets: [],
  };

  for (const shared of servers) {
    // 应用 server_id_map
    const desiredId = serverIdMap?.[shared.id] ?? shared.id;

    // 冲突处理
    const conflict = resolveConflict(desiredId, existingIds, conflictStrategy);

    if (conflict.action === 'skip') {
      result.skipped.push(shared.id);
      continue;
    }

    // 还原为 McpServerConfig
    const serverConfig = restoreServer(shared, conflict.id);
    const hasSecrets =
      (shared.env_keys && shared.env_keys.length > 0) ||
      (shared.header_names && shared.header_names.length > 0);

    try {
      upsertMcpServer(serverConfig);
    } catch (err) {
      throw new McpShareError(
        'mcp_server_save_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    // 更新已存在 ID 集合（防止后续 server 冲突）
    existingIds.add(conflict.id);

    result.imported.push(serverConfig);

    if (conflict.action === 'overwrite') {
      result.overwritten.push(shared.id);
    } else if (conflict.action === 'rename') {
      result.renamed.push(`${shared.id}->${conflict.id}`);
    }

    if (hasSecrets) {
      result.requires_secrets.push(conflict.id);
    }
  }

  return result;
}

/**
 * 从分享 payload 导入 servers
 * @param payload 解析后的 McpSharePayload
 * @param serverIdMap ID 重命名映射
 * @param conflictStrategy 冲突策略
 */
export function importFromPayload(
  payload: McpSharePayload,
  serverIdMap?: Record<string, string>,
  conflictStrategy: ConflictStrategy = 'skip',
): ImportResult {
  return validateImportInput(payload.servers, serverIdMap, conflictStrategy);
}

/**
 * 从分享 token 导入
 * @param shareToken base64url 编码的分享 token
 * @param serverIdMap ID 重命名映射
 * @param conflictStrategy 冲突策略
 */
export function importFromShareToken(
  shareToken: string,
  serverIdMap?: Record<string, string>,
  conflictStrategy: ConflictStrategy = 'skip',
): ImportResult {
  const payload = parseShareToken(shareToken);
  return importFromPayload(payload, serverIdMap, conflictStrategy);
}
