/**
 * McpShareRoutes — MCP 分享与导入 REST API 端点
 *
 * 契约: contract:mcp-share v1
 *
 * 5 个端点:
 * - POST   /api/v1/mcp/share          — 生成分享链接
 * - GET    /api/v1/mcp/share/:token    — 解析分享链接（预览）
 * - POST   /api/v1/mcp/share/import    — 从分享链接导入
 * - POST   /api/v1/mcp/bundle/export   — 导出 .mcpb 文件
 * - POST   /api/v1/mcp/bundle/import   — 导入 .mcpb 文件
 */

import type { FastifyInstance } from 'fastify';
import type { AuthFn } from './types.js';
import {
  generateShareLink,
  parseShareToken,
  importFromShareToken,
  McpShareError,
  type ConflictStrategy,
} from '../core/mcp-share/McpShare.js';
import {
  createBundle,
  validateBundle,
  importFromBundle,
} from '../core/mcp-share/McpBundle.js';

export function registerMcpShareRoutes(
  fastify: FastifyInstance,
  deps: {
    requireServerToken: AuthFn;
  },
): void {
  const { requireServerToken } = deps;

  const setDynamicResponseHeaders = (reply: Parameters<AuthFn>[1]): void => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
  };

  /** 统一错误处理 */
  const handleError = (reply: Parameters<AuthFn>[1], err: unknown): void => {
    setDynamicResponseHeaders(reply);
    if (err instanceof McpShareError) {
      reply.status(400);
      reply.send({ error: err.code, message: err.message });
    } else {
      reply.status(500);
      reply.send({
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ── POST /api/v1/mcp/share — 生成分享链接 ──────────────────────────

  fastify.post('/api/v1/mcp/share', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);

    try {
      const body = request.body as {
        server_ids?: string[];
        name?: string;
        description?: string;
      };

      const result = generateShareLink(
        body?.server_ids || [],
        body?.name,
        body?.description,
      );

      reply.send({ success: true, data: result });
    } catch (err) {
      handleError(reply, err);
    }
  });

  // ── GET /api/v1/mcp/share/:token — 解析分享链接（预览） ─────────────

  fastify.get('/api/v1/mcp/share/:token', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);

    try {
      const { token } = request.params as { token: string };
      const payload = parseShareToken(token);
      reply.send({ success: true, data: payload });
    } catch (err) {
      handleError(reply, err);
    }
  });

  // ── POST /api/v1/mcp/share/import — 从分享链接导入 ──────────────────

  fastify.post('/api/v1/mcp/share/import', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);

    try {
      const body = request.body as {
        share_token?: string;
        server_id_map?: Record<string, string>;
        conflict_strategy?: ConflictStrategy;
      };

      if (!body?.share_token) {
        reply.status(400);
        reply.send({ error: 'share_token_invalid', message: 'share_token is required.' });
        return;
      }

      const result = importFromShareToken(
        body.share_token,
        body.server_id_map,
        body.conflict_strategy || 'skip',
      );

      reply.send({ success: true, data: result });
    } catch (err) {
      handleError(reply, err);
    }
  });

  // ── POST /api/v1/mcp/bundle/export — 导出 .mcpb 文件 ───────────────

  fastify.post('/api/v1/mcp/bundle/export', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);

    try {
      const body = request.body as {
        server_ids?: string[];
        name?: string;
        description?: string;
        author?: string;
      };

      const bundle = createBundle(
        body?.server_ids || [],
        body?.name,
        body?.description,
        body?.author,
      );

      // 文件名安全化
      const safeName = (bundle.name || 'mcp-bundle')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 100) || 'mcp-bundle';

      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="${safeName}.mcpb"`);
      reply.send(bundle);
    } catch (err) {
      handleError(reply, err);
    }
  });

  // ── POST /api/v1/mcp/bundle/import — 导入 .mcpb 文件 ───────────────

  fastify.post('/api/v1/mcp/bundle/import', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    setDynamicResponseHeaders(reply);

    try {
      let bundleObj: unknown;
      let serverIdMap: Record<string, string> | undefined;
      let conflictStrategy: ConflictStrategy = 'skip';

      // 支持 application/json 和 multipart/form-data
      const contentType = request.headers['content-type'] || '';

      if (contentType.includes('multipart/form-data')) {
        const body = request.body as Record<string, unknown>;
        // fastify-multipart 将文件放在 body 中
        const fileField = body?.file;
        if (fileField && typeof fileField === 'object' && 'toBuffer' in fileField) {
          const fileBuffer = await (fileField as { toBuffer: () => Promise<Buffer> }).toBuffer();
          bundleObj = JSON.parse(fileBuffer.toString('utf-8'));
        } else if (typeof body?.bundle === 'string') {
          bundleObj = JSON.parse(body.bundle as string);
        } else if (body?.bundle && typeof body.bundle === 'object') {
          bundleObj = body.bundle;
        } else {
          reply.status(400);
          reply.send({ error: 'bundle_format_invalid', message: 'No bundle file or data provided.' });
          return;
        }
        if (body?.server_id_map && typeof body.server_id_map === 'object') {
          serverIdMap = body.server_id_map as Record<string, string>;
        }
        if (typeof body?.conflict_strategy === 'string') {
          conflictStrategy = body.conflict_strategy as ConflictStrategy;
        }
      } else {
        // application/json
        const body = request.body as {
          bundle?: unknown;
          server_id_map?: Record<string, string>;
          conflict_strategy?: ConflictStrategy;
        };

        if (!body?.bundle) {
          reply.status(400);
          reply.send({ error: 'bundle_format_invalid', message: 'bundle field is required.' });
          return;
        }

        bundleObj = body.bundle;
        serverIdMap = body.server_id_map;
        conflictStrategy = body.conflict_strategy || 'skip';
      }

      // 验证 bundle
      const bundle = validateBundle(bundleObj);

      // 导入
      const result = importFromBundle(bundle, serverIdMap, conflictStrategy);

      reply.send({ success: true, data: result });
    } catch (err) {
      handleError(reply, err);
    }
  });
}
