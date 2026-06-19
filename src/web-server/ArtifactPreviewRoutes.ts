/**
 * ArtifactPreviewRoutes — chat artifact preview, inline rendering, and safe text edits.
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { AuthFn } from './types.js';
import { detectFormat, parseFile, type ParseMode } from '../tools/implementations/FileParser.js';
import { Workspace } from '../core/Workspace.js';
import { existsSync, statSync, readdirSync } from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { getAllowedFsRoots, isPathInside } from './FileSystemRoutes.js';
import { shouldEnforceArtifactRoot, isHardenedMode } from '../core/HardeningPolicy.js';

const RAW_PREVIEW_MAX_BYTES = 80 * 1024 * 1024;
const TEXT_EDIT_MAX_BYTES = 10 * 1024 * 1024;

type PreviewStatus = 'ok' | 'partial' | 'parse_error';
type PreviewTrustLevel = 'raw' | 'rich_text' | 'structure' | 'table' | 'text' | 'untrusted';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.pdf': 'application/pdf',
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
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const EDITABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
  '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
  '.sh', '.bash', '.zsh', '.sql', '.env', '.gitignore',
]);

function getSessionId(deps: {
  getActiveSessionId?: () => string | undefined;
}, requested?: string): string | undefined {
  return requested || deps.getActiveSessionId?.();
}

// scratchpad 文件名约定 <taskId>_<role>.md，从文件名解析展示用元数据。
function parseScratchpadName(fileName: string): { taskId?: string; role?: string } {
  const stem = fileName.replace(/\.md$/i, '');
  const underscore = stem.indexOf('_');
  if (underscore <= 0) {
    return { role: stem || undefined };
  }
  return {
    taskId: stem.slice(0, underscore),
    role: stem.slice(underscore + 1) || undefined,
  };
}

function validateArtifactPath(filePath: string, allowedRoots?: string[]): string | null {
  const resolved = path.resolve(filePath);
  // 加固模式 root 校验：resolved 必须落在允许根集合内（复用 FileSystemRoutes 的
  // getAllowedFsRoots() + isPathInside()，与 fs 端点统一范式）。越界返回 null → 路由 403。
  // 默认关闭时保持现状：仅校验存在且是文件，无 root 包含校验（主机主人本可读自己的文件）。
  if (shouldEnforceArtifactRoot()) {
    const roots = allowedRoots ?? [];
    if (!roots.some((root) => isPathInside(root, resolved))) return null;
  }
  if (!existsSync(resolved)) return null;
  const stat = statSync(resolved);
  if (!stat.isFile()) return null;
  return resolved;
}

function resolveArtifactRequestPath(input: {
  filePath: string;
  sessionId?: string;
  repos?: DatabaseRepositoryAdapter;
}): string {
  const filePath = input.filePath.trim();
  if (!filePath) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  const sessionId = input.sessionId;
  const workspace = sessionId ? input.repos?.sessions.get(sessionId)?.workspace : undefined;
  return workspace ? path.resolve(workspace, filePath) : path.resolve(filePath);
}

/**
 * 加固模式下需要强制下载（而非内联渲染）的格式——可被浏览器当作活动内容执行（XSS 面）。
 * raw 端点对这些类型在加固时强制 Content-Disposition: attachment + CSP sandbox。
 */
const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);

function isActiveContent(filePath: string): boolean {
  return ACTIVE_CONTENT_EXTS.has(path.extname(filePath).toLowerCase());
}

function isEditableArtifact(filePath: string, format: string, size: number): boolean {
  if (size > TEXT_EDIT_MAX_BYTES) return false;
  if (format === 'ppt' || format === 'pptx') return false;
  if (['doc', 'docx', 'xls', 'xlsx', 'pdf', 'zip', 'tar', 'gzip', 'binary', 'audio', 'video'].includes(format)) return false;
  return EDITABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || format === 'text' || format === 'csv';
}

function isRawPreviewable(format: string): boolean {
  return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'audio', 'video'].includes(format);
}

function contentTypeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function inferPreviewTrust(format: string, renderer?: string): PreviewTrustLevel {
  if (renderer === 'html') return 'rich_text';
  if (renderer === 'pptx-structure') return 'structure';
  if (renderer === 'xlsx-table' || ['xlsx', 'xls', 'csv'].includes(format)) return 'table';
  if (['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'audio', 'video'].includes(format)) return 'raw';
  return 'text';
}

function inferPreviewDiagnostics(parsed: Awaited<ReturnType<typeof parseFile>>, fallbackFormat: string): {
  status: PreviewStatus;
  trustLevel: PreviewTrustLevel;
  warnings: string[];
} {
  const format = parsed.format || fallbackFormat;
  const metadataWarnings = Array.isArray(parsed.metadata?.warnings)
    ? parsed.metadata.warnings.filter((warning): warning is string => typeof warning === 'string' && warning.length > 0)
    : [];
  const content = parsed.content || '';
  const hardFailure = /^(?:PDF|DOCX|PPTX|XLSX|CSV|ZIP)\s*解析失败:|^XLSX 文件过大，已拒绝解析:|^文本读取失败:|^文件不存在:|^Sheet\s+".+"\s+不存在/.test(content);
  const softFailure = /^文件过大，已拒绝解析:/.test(content) || metadataWarnings.length > 0 || parsed.truncated;
  const trustLevel = hardFailure ? 'untrusted' : inferPreviewTrust(format, parsed.metadata?.renderer);
  const warnings = [...metadataWarnings];
  if (hardFailure) warnings.unshift(content.split('\n')[0]);
  if (!hardFailure && parsed.truncated) warnings.push('preview-truncated');
  if (trustLevel === 'structure') warnings.push('pptx-structure-preview-not-layout-faithful');
  if (trustLevel === 'table') warnings.push('table-preview-omits-formulas-styles');
  return {
    status: hardFailure ? 'parse_error' : softFailure || trustLevel === 'structure' || trustLevel === 'table' ? 'partial' : 'ok',
    trustLevel,
    warnings: Array.from(new Set(warnings)),
  };
}

export function registerArtifactPreviewRoutes(
  fastify: FastifyInstance,
  deps: {
    repos?: DatabaseRepositoryAdapter;
    requireServerToken: AuthFn;
    getActiveSessionId?: () => string | undefined;
  },
): void {
  const { requireServerToken, repos } = deps;

  // 加固模式 root 校验用的允许根集合（复用 fs 端点同一范式）。非加固时不调用。
  function allowedArtifactRoots(requestedSessionId?: string): string[] {
    const sessionId = getSessionId(deps, requestedSessionId);
    return getAllowedFsRoots(repos, sessionId);
  }

  function resolveScratchpadDir(sessionId: string): string | null {
    const workspace = repos?.sessions.get(sessionId)?.workspace;
    const scratchpadDir = Workspace.getScratchpadDir(sessionId, workspace);
    return existsSync(scratchpadDir) ? scratchpadDir : null;
  }

  fastify.get('/api/v1/artifacts/preview', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { path?: string; sessionId?: string; mode?: ParseMode; page?: string; sheet?: string };
    if (!query.path) {
      reply.status(400);
      return { error: 'path is required' };
    }

    const requestPath = resolveArtifactRequestPath({ filePath: query.path, sessionId: query.sessionId, repos });
    const resolved = validateArtifactPath(requestPath, allowedArtifactRoots(query.sessionId));
    if (!resolved) {
      reply.status(403);
      return { error: 'artifact path is not readable' };
    }

    const stat = statSync(resolved);
    const format = detectFormat(resolved);
    const mode = query.mode === 'full' || query.mode === 'page' || query.mode === 'sheet' ? query.mode : 'preview';
    const parsed = await parseFile(resolved, mode, {
      page: query.page ? Number(query.page) : undefined,
      sheet: query.sheet,
    });
    const diagnostics = inferPreviewDiagnostics(parsed, format);

    return {
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      mimeType: contentTypeFor(resolved),
      format: parsed.format || format,
      status: diagnostics.status,
      trustLevel: diagnostics.trustLevel,
      warnings: diagnostics.warnings,
      content: parsed.content,
      metadata: parsed.metadata,
      truncated: parsed.truncated,
      editable: isEditableArtifact(resolved, parsed.format || format, stat.size),
      rawPreviewable: isRawPreviewable(parsed.format || format),
    };
  });

  fastify.get('/api/v1/artifacts/raw', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { path?: string; sessionId?: string };
    if (!query.path) {
      reply.status(400);
      return { error: 'path is required' };
    }

    const requestPath = resolveArtifactRequestPath({ filePath: query.path, sessionId: query.sessionId, repos });
    const resolved = validateArtifactPath(requestPath, allowedArtifactRoots(query.sessionId));
    if (!resolved) {
      reply.status(403);
      return { error: 'artifact path is not readable' };
    }

    const stat = statSync(resolved);
    if (stat.size > RAW_PREVIEW_MAX_BYTES) {
      reply.status(413);
      return { error: 'artifact is too large for inline preview' };
    }

    const buffer = await fsp.readFile(resolved);
    reply.header('Content-Type', contentTypeFor(resolved));
    // 加固模式：html/svg/xml 等活动内容强制下载 + CSP sandbox，防 raw 端点被当作 XSS 载体内联执行。
    // 默认关闭时保持现状：一律 inline 渲染（server.ts 的 onSend 已对 raw 移除 XFO，非加固沿用）。
    if (isHardenedMode() && isActiveContent(resolved)) {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(resolved))}"`);
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    } else {
      reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(resolved))}"`);
    }
    reply.header('Content-Length', buffer.length);
    return reply.send(buffer);
  });

  fastify.put('/api/v1/artifacts/save', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const body = request.body as { path?: string; sessionId?: string; content?: string };
    if (!body?.path) {
      reply.status(400);
      return { error: 'path is required' };
    }
    if (typeof body.content !== 'string') {
      reply.status(400);
      return { error: 'content must be a string' };
    }

    const requestPath = resolveArtifactRequestPath({ filePath: body.path, sessionId: body.sessionId, repos });
    const resolved = validateArtifactPath(requestPath, allowedArtifactRoots(body.sessionId));
    if (!resolved) {
      reply.status(403);
      return { error: 'artifact path is not writable' };
    }

    const stat = statSync(resolved);
    const format = detectFormat(resolved);
    if (!isEditableArtifact(resolved, format, stat.size)) {
      reply.status(400);
      return { error: 'only text-like artifacts can be edited directly; PPT/PPTX is never edited inline' };
    }
    if (Buffer.byteLength(body.content, 'utf-8') > TEXT_EDIT_MAX_BYTES) {
      reply.status(413);
      return { error: 'edited content is too large' };
    }

    await fsp.writeFile(resolved, body.content, 'utf-8');
    const nextStat = statSync(resolved);
    return {
      success: true,
      path: resolved,
      size: nextStat.size,
      updatedAt: Date.now(),
    };
  });

  // ─── Scratchpad: 列出当前 session 的 scratchpad 文件 ───
  fastify.get('/api/v1/scratchpad/:sessionId', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const params = request.params as { sessionId?: string };
    const sessionId = getSessionId(deps, params.sessionId);
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }

    const scratchpadDir = resolveScratchpadDir(sessionId);
    if (!scratchpadDir) {
      return { files: [] };
    }

    const files = readdirSync(scratchpadDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const stat = statSync(path.join(scratchpadDir, name));
        const { taskId, role } = parseScratchpadName(name);
        return {
          name,
          taskId,
          role,
          size: stat.size,
          updatedAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return { files };
  });

  // ─── Scratchpad: 读取单个 scratchpad 文件内容 ───
  fastify.get('/api/v1/scratchpad/:sessionId/:file', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const params = request.params as { sessionId?: string; file?: string };
    const sessionId = getSessionId(deps, params.sessionId);
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    if (!params.file) {
      reply.status(400);
      return { error: 'file is required' };
    }

    const scratchpadDir = resolveScratchpadDir(sessionId);
    if (!scratchpadDir) {
      reply.status(404);
      return { error: 'scratchpad not found' };
    }

    // 防路径穿越：只允许 scratchpadDir 下的直接子文件
    const resolved = path.resolve(scratchpadDir, params.file);
    const rel = path.relative(scratchpadDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      reply.status(403);
      return { error: 'invalid scratchpad file path' };
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      reply.status(404);
      return { error: 'scratchpad file not found' };
    }

    const content = await fsp.readFile(resolved, 'utf-8');
    const { taskId, role } = parseScratchpadName(params.file);
    return {
      name: params.file,
      taskId,
      role,
      content,
    };
  });
}
