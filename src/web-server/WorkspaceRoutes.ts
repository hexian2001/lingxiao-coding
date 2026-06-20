/**
 * WorkspaceRoutes — Workspace 相关 API 路由
 *
 * 提供 workspace 列表、路径验证、目录浏览和最近 workspace 管理端点。
 */

import type { FastifyInstance } from 'fastify';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { CONFIG_DIR } from '../config.js';
import type { AuthFn } from './types.js';

// ═══════════════════════════════════════════════════════════════
// recent_workspaces.json 管理
// ═══════════════════════════════════════════════════════════════

const RECENT_WORKSPACES_FILE = join(CONFIG_DIR, 'recent_workspaces.json');
const MAX_RECENT_WORKSPACES = 20;

/**
 * 读取最近使用的 workspace 列表。
 * 文件不存在或格式错误时返回空数组。
 */
function readRecentWorkspaces(): string[] {
  try {
    if (!existsSync(RECENT_WORKSPACES_FILE)) return [];
    const raw = readFileSync(RECENT_WORKSPACES_FILE, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/**
 * 写入最近使用的 workspace 列表（去重，最多 MAX_RECENT_WORKSPACES 个）。
 * 自动创建父目录。
 */
function writeRecentWorkspaces(paths: string[]): void {
  // 去重（保留顺序，第一次出现的优先）
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of paths) {
    const normalized = p.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  const limited = deduped.slice(0, MAX_RECENT_WORKSPACES);

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(RECENT_WORKSPACES_FILE, JSON.stringify(limited, null, 2), 'utf-8');
}

/**
 * 添加一个 workspace 路径到最近列表（去重，新路径放最前）。
 */
function addRecentWorkspace(path: string): string[] {
  const current = readRecentWorkspaces();
  const filtered = current.filter((p) => p !== path);
  const updated = [path, ...filtered].slice(0, MAX_RECENT_WORKSPACES);
  writeRecentWorkspaces(updated);
  return updated;
}

// ═══════════════════════════════════════════════════════════════
// 路由注册
// ═══════════════════════════════════════════════════════════════

export function registerWorkspaceRoutes(
  fastify: FastifyInstance,
  deps: {
    requireServerToken: AuthFn;
    getBaseWorkspace?: () => string;
  },
): void {
  const { requireServerToken, getBaseWorkspace } = deps;

  // GET /api/v1/workspaces — 返回最近使用的 workspace 列表 + 当前 workspace
  fastify.get('/api/v1/workspaces', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const recent = readRecentWorkspaces();
    const current = getBaseWorkspace?.() ?? process.cwd();
    return { data: { current, recent } };
  });

  // POST /api/v1/workspace/validate — 验证路径是否有效
  fastify.post('/api/v1/workspace/validate', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { path?: string };
    const targetPath = body?.path;
    if (!targetPath || typeof targetPath !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" in body' });
      return;
    }
    try {
      if (!existsSync(targetPath)) {
        return { data: { valid: false, path: targetPath, error: 'Path does not exist' } };
      }
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        return { data: { valid: false, path: targetPath, error: 'Path is not a directory' } };
      }
      return { data: { valid: true, path: targetPath } };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: { valid: false, path: targetPath, error: message } };
    }
  });

  // GET /api/v1/workspace/browse — 浏览目录子文件夹（非递归，过滤隐藏目录）
  fastify.get('/api/v1/workspace/browse', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { path?: string };
    const targetPath = query.path;
    if (!targetPath || typeof targetPath !== 'string') {
      reply.status(400).send({ error: 'Missing "path" query parameter' });
      return;
    }
    try {
      if (!existsSync(targetPath)) {
        reply.status(404).send({ error: `Path not found: ${targetPath}` });
        return;
      }
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        reply.status(400).send({ error: `Path is not a directory: ${targetPath}` });
        return;
      }
      const entries = readdirSync(targetPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => {
          // 只保留目录
          if (!entry.isDirectory()) return false;
          // 过滤隐藏目录（以 . 开头）
          if (entry.name.startsWith('.')) return false;
          return true;
        })
        .map((entry) => ({
          name: entry.name,
          path: join(targetPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { data: { path: targetPath, directories } };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      reply.status(500).send({ error: `Failed to browse directory: ${message}` });
    }
  });

  // POST /api/v1/workspaces/recent — 添加最近使用的 workspace
  fastify.post('/api/v1/workspaces/recent', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { path?: string };
    const targetPath = body?.path;
    if (!targetPath || typeof targetPath !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" in body' });
      return;
    }
    const updated = addRecentWorkspace(targetPath);
    return { data: { recent: updated } };
  });
}
