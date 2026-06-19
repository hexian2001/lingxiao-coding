/**
 * FileSystemRoutes — 文件系统操作 + 文件上传/下载/解析路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import path from 'path';
import os from 'os';
import { FILE_PARSER } from '../config/defaults.js';
import { Workspace } from '../core/Workspace.js';
import type { AuthFn } from './types.js';

export function isPathInside(parent: string, target: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function getAllowedFsRoots(repos?: DatabaseRepositoryAdapter, sessionId?: string): string[] {
  const roots = [process.cwd()];
  roots.push(path.join(os.tmpdir(), 'lingxiao-upload'));
  if (sessionId && repos) {
    const session = repos.sessions.get(sessionId);
    if (session?.workspace) {
      roots.push(path.resolve(session.workspace));
    }
  }
  return roots;
}

function validateFsPath(targetPath: string, roots: string[]): boolean {
  return roots.some(root => isPathInside(root, path.resolve(targetPath)));
}

export function registerFileSystemRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    requireServerToken: AuthFn;
    getActiveSessionId?: () => string | undefined;
  },
): void {
  const { repos, requireServerToken, getActiveSessionId } = deps;

  // --- Filesystem ---
  fastify.post('/api/v1/fs/list', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    try {
      const { readdirSync, statSync, existsSync } = await import('fs');
      const { join, resolve } = await import('path');
      const body = request.body as { path?: string; sessionId?: string } | undefined;
      const dirPath = body?.path || process.cwd();

      const resolvedPath = resolve(dirPath);
      const roots = getAllowedFsRoots(repos, body?.sessionId);
      if (!validateFsPath(dirPath, roots)) {
        reply.status(403);
        return { error: 'Path is outside allowed roots' };
      }
      if (!existsSync(resolvedPath)) {
        return { entries: [] };
      }
      const items = readdirSync(resolvedPath, { withFileTypes: true });
      const entries = items
        .filter(item => !item.name.startsWith('.') || item.name === '.lingxiao')
        .map(item => ({
          name: item.name,
          path: join(resolvedPath, item.name),
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? statSync(join(resolvedPath, item.name)).size : 0,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { entries };
    } catch (err) {
      console.error('[fs/list] error:', err);
      return { entries: [], error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  fastify.post('/api/v1/fs/mkdir', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { path: dirPath, recursive, sessionId } = request.body as { path?: string; recursive?: boolean; sessionId?: string };
    if (!dirPath) { reply.status(400).send({ error: 'path is required' }); return; }
    const roots = getAllowedFsRoots(repos, sessionId);
    if (!validateFsPath(dirPath, roots)) {
      reply.status(403).send({ error: 'Path is outside allowed roots' }); return;
    }
    const fsp = await import('fs/promises');
    const { resolve } = await import('path');
    const resolved = resolve(dirPath);
    try {
      await fsp.mkdir(resolved, { recursive: !!recursive });
      return { success: true, path: resolved };
    } catch {
      reply.status(500).send({ error: 'mkdir failed' });
    }
  });

  fastify.post('/api/v1/fs/move', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { source, destination, sessionId } = request.body as { source?: string; destination?: string; sessionId?: string };
    if (!source || !destination) { reply.status(400).send({ error: 'source and destination are required' }); return; }
    const roots = getAllowedFsRoots(repos, sessionId);
    if (!validateFsPath(source, roots) || !validateFsPath(destination, roots)) {
      reply.status(403).send({ error: 'Path is outside allowed roots' }); return;
    }
    const { rename } = await import('fs/promises');
    const { resolve } = await import('path');
    try {
      await rename(resolve(source), resolve(destination));
      return { success: true };
    } catch {
      reply.status(500).send({ error: 'move failed' });
    }
  });

  fastify.post('/api/v1/fs/write', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { path: filePath, content, sessionId } = request.body as { path?: string; content?: string; sessionId?: string };
    if (!filePath) { reply.status(400).send({ error: 'path is required' }); return; }
    const roots = getAllowedFsRoots(repos, sessionId);
    if (!validateFsPath(filePath, roots)) {
      reply.status(403).send({ error: 'Path is outside allowed roots' }); return;
    }
    const fsp = await import('fs/promises');
    const { resolve, dirname } = await import('path');
    const resolved = resolve(filePath);
    try {
      await fsp.mkdir(dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, content ?? '', 'utf-8');
      return { success: true, path: resolved };
    } catch {
      reply.status(500).send({ error: 'write failed' });
    }
  });

  fastify.post('/api/v1/fs/remove', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { path: targetPath, recursive, sessionId } = request.body as { path?: string; recursive?: boolean; sessionId?: string };
    if (!targetPath) { reply.status(400).send({ error: 'path is required' }); return; }
    const roots = getAllowedFsRoots(repos, sessionId);
    if (!validateFsPath(targetPath, roots)) {
      reply.status(403).send({ error: 'Path is outside allowed roots' }); return;
    }
    const { rm, rmdir } = await import('fs/promises');
    const { resolve } = await import('path');
    const resolved = resolve(targetPath);
    try {
      if (recursive) {
        await rm(resolved, { recursive: true, force: true });
      } else {
        await rmdir(resolved);
      }
      return { success: true };
    } catch {
      reply.status(500).send({ error: 'remove failed' });
    }
  });

  fastify.get('/api/v1/fs/search', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { query, path: searchPath, maxDepth, sessionId } = request.query as {
      query?: string; path?: string; maxDepth?: string; sessionId?: string;
    };
    if (!query) { reply.status(400); return { error: 'query is required' }; }
    const roots = getAllowedFsRoots(repos, sessionId);
    const root = path.resolve(searchPath || process.cwd());
    if (!validateFsPath(searchPath || process.cwd(), roots)) {
      reply.status(403); return { error: 'Path is outside allowed roots' };
    }
    const fsp = await import('fs/promises');
    const depth = parseInt(maxDepth || '5', 10);
    const items: Array<{ name: string; path: string; type: string }> = [];
    const q = query.toLowerCase();

    async function walk(dir: string, d: number): Promise<void> {
      if (d > depth || items.length >= 100) return;
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.name.toLowerCase().includes(q)) {
            items.push({ name: entry.name, path: full, type: entry.isDirectory() ? 'directory' : 'file' });
            if (items.length >= 100) return;
          }
          if (entry.isDirectory()) await walk(full, d + 1);
        }
      } catch {/* expected: best-effort cleanup */}
    }

    await walk(root, 0);
    return { items };
  });

  // --- Files ---
  fastify.get('/api/v1/files/download', async (request, reply) => {
    const query = request.query as { path?: string; sessionId?: string; raw?: string; token?: string };
    const filePath = query.path;

    if (!requireServerToken(request, reply)) return;

    const { statSync, existsSync } = await import('fs');
    const { resolve, extname, join } = await import('path');
    const { tmpdir } = await import('os');

    if (!filePath) {
      reply.status(400);
      return { error: 'path is required' };
    }

    const resolvedPath = resolve(filePath);
    if (!existsSync(resolvedPath)) {
      reply.status(404);
      return { error: 'File not found' };
    }

    const sessionId = query.sessionId || getActiveSessionId?.();
    const sessionInfo = sessionId ? repos.sessions.get(sessionId) : null;
    const allowedRoots = [join(tmpdir(), 'lingxiao-upload')];
    if (sessionInfo?.workspace) {
      allowedRoots.push(resolve(sessionInfo.workspace));
      if (sessionId) allowedRoots.push(Workspace.getSessionArtifactPaths(sessionId, sessionInfo.workspace).sessionDir);
    }
    if (!allowedRoots.some((root) => isPathInside(root, resolvedPath))) {
      reply.status(403);
      return { error: 'path is outside allowed download roots' };
    }

    try {
      const stat = statSync(resolvedPath);
      if (stat.isDirectory()) {
        reply.status(400);
        return { error: 'Path is a directory' };
      }

      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);
      const ext = extname(resolvedPath).toLowerCase();
      const isImage = imageExts.has(ext);

      if (isImage || query.raw === '1') {
        if (stat.size > 50 * 1024 * 1024) {
          reply.status(413);
          return { error: 'File too large (max 50MB)' };
        }
        const { promises: fsp } = await import('fs');
        const buffer = await fsp.readFile(resolvedPath);

        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp',
          '.ico': 'image/x-icon', '.bmp': 'image/bmp',
        };
        const contentType = mimeMap[ext] || 'application/octet-stream';
        reply.header('Content-Type', contentType);
        if (ext === '.svg') {
          reply.header('Content-Disposition', 'attachment');
        }
        reply.header('Content-Length', buffer.length);
        return reply.send(buffer);
      }

      if (stat.size > 5 * 1024 * 1024) {
        reply.status(413);
        return { error: 'File too large (max 5MB)' };
      }

      const { promises: fsp } = await import('fs');
      const content = await fsp.readFile(resolvedPath, 'utf-8');
      return { content, path: filePath, size: stat.size };
    } catch {/* swallowed: unhandled error */
      reply.status(500);
      return { error: 'Failed to read file' };
    }
  });

  fastify.post('/api/v1/files/upload', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    type UploadItem = { name?: string; content?: string; data?: string; mimeType?: string; size?: number };
    const body = request.body as UploadItem & { files?: UploadItem[] };
    const uploadItems = Array.isArray(body.files) ? body.files : [body];

    if (uploadItems.length === 0 || uploadItems.length > FILE_PARSER.MAX_UPLOAD_FILES) {
      reply.status(400);
      return { error: `files must contain 1-${FILE_PARSER.MAX_UPLOAD_FILES} items` };
    }

    try {
      const { promises: fsp } = await import('fs');
      const { join, basename, extname } = await import('path');
      const { tmpdir } = await import('os');
      const { randomUUID } = await import('crypto');
      const { parsePreview } = await import('../tools/implementations/FileParser.js');

      const uploadDir = join(tmpdir(), 'lingxiao-upload');
      await fsp.mkdir(uploadDir, { recursive: true });
      let totalBytes = 0;

      const sanitizeName = (name?: string): string => {
        const base = basename(name || `upload-${Date.now()}.bin`).replace(/[\x00-\x1f\x7f]/g, '').trim();
        return base || `upload-${Date.now()}.bin`;
      };

      const results = [];
      for (const item of uploadItems) {
        const originalName = sanitizeName(item.name);
        const ext = extname(originalName).slice(0, 20);
        const stem = basename(originalName, ext).slice(0, 80) || 'upload';
        const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${stem}${ext}`;
        const resolvedPath = join(uploadDir, fileName);

        let buffer: Buffer;
        if (item.data) {
          buffer = Buffer.from(item.data, 'base64');
        } else if (item.content !== undefined) {
          buffer = Buffer.from(item.content, 'utf-8');
        } else {
          results.push({ success: false, name: originalName, error: 'content or data is required' });
          continue;
        }

        totalBytes += buffer.length;
        if (buffer.length > FILE_PARSER.MAX_UPLOAD_BYTES) {
          results.push({ success: false, name: originalName, error: `file too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB` });
          continue;
        }
        if (totalBytes > FILE_PARSER.MAX_UPLOAD_TOTAL_BYTES) {
          results.push({ success: false, name: originalName, error: 'total upload size exceeded' });
          continue;
        }

        await fsp.writeFile(resolvedPath, buffer, { flag: 'wx' });
        const preview = await parsePreview(resolvedPath);
        results.push({ success: true, name: originalName, path: resolvedPath, size: buffer.length, mimeType: item.mimeType, preview });
      }

      const successful = results.filter((item) => item.success);
      if (successful.length === 0) {
        reply.status(400);
      }

      const first = results[0] as { success: boolean; path?: string; preview?: unknown; error?: string } | undefined;
      return {
        success: successful.length > 0,
        files: results,
        path: first?.success ? first.path : undefined,
        preview: first?.success ? first.preview : undefined,
        error: successful.length === 0 ? first?.error || 'Upload failed' : undefined,
      };
    } catch (err) {
      request.log.error({ err }, 'file upload error');
      reply.status(500);
      return { error: err instanceof Error ? err.message : 'Write failed' };
    }
  });

  fastify.post('/api/v1/files/parse', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { path?: string; mode?: string; page?: number; sheet?: string };
    const filePath = body.path;

    if (!filePath) {
      reply.status(400);
      return { error: 'path is required' };
    }

    const uploadDir = path.join(os.tmpdir(), 'lingxiao-upload') + path.sep;
    if (!filePath.startsWith(uploadDir)) {
      reply.status(403);
      return { error: 'invalid path' };
    }

    try {
      const { parseFile } = await import('../tools/implementations/FileParser.js');
      type ParseMode = import('../tools/implementations/FileParser.js').ParseMode;
      const mode = (body.mode as ParseMode) || 'preview';
      const result = await parseFile(filePath, mode, { page: body.page, sheet: body.sheet });
      return result;
    } catch (err) {
      request.log.error({ err }, 'file parse error');
      reply.status(500);
      return { error: err instanceof Error ? err.message : 'Parse failed' };
    }
  });
}
