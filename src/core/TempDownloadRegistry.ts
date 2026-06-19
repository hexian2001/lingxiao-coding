import { createReadStream, existsSync, statSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { randomBytes } from 'crypto';
import type { FastifyReply } from 'fastify';

export interface TempDownloadArtifact {
  type: 'download_artifact';
  token: string;
  url: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  expiresAt: string;
}

interface TempDownloadEntry {
  token: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  expiresAtMs: number;
  sessionId?: string;
}

function sanitizeDownloadName(name: string): string {
  const cleaned = basename(name).replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned || `download-${Date.now()}.bin`;
}

function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

function makeContentDisposition(filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

class TempDownloadRegistry {
  private entries = new Map<string, TempDownloadEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  private static readonly BLOCKED_PATH_PREFIXES = [
    '/etc/shadow', '/etc/gshadow', '/etc/sudoers',
    '/root/.ssh', '/root/.gnupg', '/root/.aws', '/root/.config/gcloud',
    '/home/', // block other users' home dirs (workspace is allowed via caller checks)
    '/proc/self/environ', '/proc/self/maps', '/proc/self/mem',
    '/sys/firmware',
  ];

  private isPathBlocked(filePath: string): boolean {
    const normalized = filePath.toLowerCase();
    return TempDownloadRegistry.BLOCKED_PATH_PREFIXES.some(prefix =>
      normalized.startsWith(prefix.toLowerCase())
    );
  }

  create(input: {
    path: string;
    name?: string;
    mimeType?: string;
    expiresInSeconds?: number;
    sessionId?: string;
  }): TempDownloadArtifact {
    const resolvedPath = resolve(input.path);
    if (this.isPathBlocked(resolvedPath)) {
      throw new Error(`安全策略禁止发布该文件: ${resolvedPath}`);
    }
    if (!existsSync(resolvedPath)) {
      throw new Error(`文件不存在: ${resolvedPath}`);
    }
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`只能发布文件，不能发布目录: ${resolvedPath}`);
    }

    const ttlSeconds = Math.max(60, Math.min(Number(input.expiresInSeconds || 3600), 24 * 60 * 60));
    const token = randomBytes(24).toString('base64url');
    const name = sanitizeDownloadName(input.name || basename(resolvedPath));
    const mimeType = input.mimeType || guessMimeType(resolvedPath);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const entry: TempDownloadEntry = {
      token,
      path: resolvedPath,
      name,
      mimeType,
      size: stat.size,
      expiresAtMs,
      sessionId: input.sessionId,
    };
    this.entries.set(token, entry);
    this.ensureCleanupTimer();
    return {
      type: 'download_artifact',
      token,
      url: `/api/v1/downloads/temp/${token}`,
      name,
      path: resolvedPath,
      size: stat.size,
      mimeType,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  get(token: string): TempDownloadEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAtMs) {
      this.entries.delete(token);
      return undefined;
    }
    if (!existsSync(entry.path)) {
      this.entries.delete(token);
      return undefined;
    }
    return entry;
  }

  send(token: string, reply: FastifyReply): boolean {
    const entry = this.get(token);
    if (!entry) {
      reply.status(404).send({ error: 'Download link expired or not found' });
      return false;
    }
    const stat = statSync(entry.path);
    reply.header('Content-Type', entry.mimeType);
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', makeContentDisposition(entry.name));
    reply.send(createReadStream(entry.path));
    return true;
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAtMs) {
        this.entries.delete(token);
      }
    }
    if (this.entries.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 清理所有临时文件（用于进程退出时）
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.entries.clear();
  }
}

export const tempDownloadRegistry = new TempDownloadRegistry();
