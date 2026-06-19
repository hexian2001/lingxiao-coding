/**
 * McpBundle — .mcpb 打包/解包核心
 *
 * 契约: contract:mcp-share v1 §4.4 §4.5 §5.2
 *
 * .mcpb 文件本质为 JSON（McpBundleFile 结构），包含:
 * - format: 'mcpb'
 * - format_version: 1
 * - name / description / author / created_at
 * - servers: SharedMcpServerConfig[] (脱敏后的 server 列表)
 */

import type { McpServerConfig } from '../../config.js';
import { getInstalledMcpServers } from '../MarketplaceService.js';
import {
  sanitizeServer,
  restoreServer,
  validateImportInput,
  type SharedMcpServerConfig,
  type ConflictStrategy,
  type ImportResult,
  type McpShareErrorCode,
  McpShareError,
} from './McpShare.js';

// ── 常量 ───────────────────────────────────────────────────────────────

const BUNDLE_FORMAT = 'mcpb' as const;
const BUNDLE_FORMAT_VERSION = 1 as const;
const MAX_BUNDLE_SERVERS = 50;

// ── 类型定义 ───────────────────────────────────────────────────────────

/** .mcpb 文件格式 */
export interface McpBundleFile {
  format: 'mcpb';
  format_version: 1;
  name: string;
  description?: string;
  author?: string;
  created_at: number;
  servers: SharedMcpServerConfig[];
}

// ── 打包（导出） ───────────────────────────────────────────────────────

/**
 * 打包 .mcpb 文件
 * @param serverIds 要打包的 server ID 列表
 * @param name Bundle 名称
 * @param description Bundle 描述
 * @param author 作者
 * @returns McpBundleFile JSON
 */
export function createBundle(
  serverIds: string[],
  name?: string,
  description?: string,
  author?: string,
): McpBundleFile {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    throw new McpShareError('no_servers_selected', 'At least one server_id is required.');
  }

  if (serverIds.length > MAX_BUNDLE_SERVERS) {
    throw new McpShareError(
      'too_many_servers',
      `Maximum ${MAX_BUNDLE_SERVERS} servers per bundle.`,
    );
  }

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

  const bundle: McpBundleFile = {
    format: BUNDLE_FORMAT,
    format_version: BUNDLE_FORMAT_VERSION,
    name: name || 'MCP Bundle',
    ...(description !== undefined ? { description } : {}),
    ...(author !== undefined ? { author } : {}),
    created_at: Date.now(),
    servers: sharedServers,
  };

  return bundle;
}

// ── 解包（验证） ───────────────────────────────────────────────────────

/**
 * 验证 bundle JSON 是否符合 McpBundleFile schema
 */
export function validateBundle(bundle: unknown): McpBundleFile {
  if (!bundle || typeof bundle !== 'object') {
    throw new McpShareError('bundle_format_invalid', 'Invalid .mcpb format.');
  }

  const obj = bundle as Record<string, unknown>;

  if (obj.format !== BUNDLE_FORMAT) {
    throw new McpShareError('bundle_format_invalid', 'Invalid .mcpb format.');
  }

  if (obj.format_version !== BUNDLE_FORMAT_VERSION) {
    throw new McpShareError(
      'bundle_version_unsupported',
      `Unsupported bundle version: ${obj.format_version}.`,
    );
  }

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new McpShareError('bundle_format_invalid', 'Invalid .mcpb format.');
  }

  if (!Array.isArray(obj.servers)) {
    throw new McpShareError('bundle_format_invalid', 'Invalid .mcpb format.');
  }

  // 验证每个 server 的基本结构
  for (const server of obj.servers) {
    if (!server || typeof server !== 'object') {
      throw new McpShareError('bundle_format_invalid', 'Invalid .mcpb format.');
    }
    const s = server as Record<string, unknown>;
    if (
      typeof s.id !== 'string' ||
      typeof s.name !== 'string' ||
      (s.transport !== 'stdio' && s.transport !== 'streamable-http')
    ) {
      throw new McpShareError('bundle_format_invalid', 'Invalid .mcpb format.');
    }
  }

  return bundle as McpBundleFile;
}

// ── 解包（导入） ───────────────────────────────────────────────────────

/**
 * 从 bundle 导入 servers
 * @param bundle McpBundleFile JSON 对象
 * @param serverIdMap ID 重命名映射
 * @param conflictStrategy 冲突策略
 */
export function importFromBundle(
  bundle: McpBundleFile,
  serverIdMap?: Record<string, string>,
  conflictStrategy: ConflictStrategy = 'skip',
): ImportResult {
  return validateImportInput(bundle.servers, serverIdMap, conflictStrategy);
}
