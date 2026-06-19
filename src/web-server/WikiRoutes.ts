/**
 * WikiRoutes — Wiki 文档路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { WikiApi } from './WikiApi.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { AuthFn } from './types.js';

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

interface WikiGenerationBody {
  projectPath?: string;
  lang?: string;
  sessionId?: string;
}

function parseWikiGenerationBody(body: unknown): WikiGenerationBody {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  return {
    projectPath: typeof record.projectPath === 'string' ? record.projectPath : undefined,
    lang: typeof record.lang === 'string' ? record.lang : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
  };
}

export function registerWikiRoutes(
  fastify: FastifyInstance,
  deps: {
    wikiApi: WikiApi;
    emitter: EventEmitter;
    requireServerToken: AuthFn;
  },
): void {
  const { wikiApi, emitter, requireServerToken } = deps;

  fastify.get('/api/v1/wiki/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath, lang } = request.query as { projectPath?: string; lang?: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    return wikiApi.getStatus(projectPath, lang || 'zh');
  });

  fastify.post('/api/v1/wiki/generate', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = parseWikiGenerationBody(request.body);
    if (!body.projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    try {
      return await wikiApi.generateWiki(body.projectPath, body.lang || 'zh', emitter, { sessionId: body.sessionId });
    } catch (err) {
      request.log.error({ err }, 'wiki/generate error');
      reply.status(500);
      return { error: errorMessage(err) };
    }
  });

  fastify.post('/api/v1/wiki/refresh', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = parseWikiGenerationBody(request.body);
    if (!body.projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    return wikiApi.updateWiki(body.projectPath, body.lang || 'zh', emitter, { sessionId: body.sessionId });
  });

  fastify.delete('/api/v1/wiki', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath, lang } = request.query as { projectPath?: string; lang?: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    await wikiApi.deleteWiki(projectPath, lang);
    return { success: true };
  });

  fastify.get('/api/v1/wiki/documents', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath, lang } = request.query as { projectPath?: string; lang?: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    const documents = await wikiApi.listDocuments(projectPath, lang || 'zh');
    return { documents };
  });

  fastify.get('/api/v1/wiki/document', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath, lang, path: docPath } = request.query as { projectPath?: string; lang?: string; path?: string };
    if (!projectPath || !docPath) {
      reply.status(400);
      return { error: 'projectPath and path are required' };
    }
    const content = await wikiApi.readDocument(projectPath, lang || 'zh', docPath);
    if (content === null) {
      reply.status(404);
      return { error: 'Document not found' };
    }
    return { content, path: docPath };
  });

  fastify.get('/api/v1/wiki/check-updates', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath, lang } = request.query as { projectPath?: string; lang?: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    return wikiApi.checkForUpdates(projectPath, lang || 'zh');
  });

  fastify.get('/api/v1/wiki/checkpoint', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { projectPath, lang } = request.query as { projectPath?: string; lang?: string };
    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }
    return wikiApi.getCheckpoint(projectPath, lang || 'zh');
  });
}
