/**
 * FileChangesRoutes — 文件变更/检查点路由
 *
 * 从 server.ts 提取，保持行为完全一致。
 */

import type { FastifyInstance } from 'fastify';
import type { FileChangesApi } from './FileChangesApi.js';
import type { AuthFn } from './types.js';

export function registerFileChangesRoutes(
  fastify: FastifyInstance,
  deps: {
    fileChangesApi: FileChangesApi;
    requireServerToken: AuthFn;
  },
): void {
  const { fileChangesApi, requireServerToken } = deps;

  fastify.get('/api/v1/file-changes/all-checkpoints', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId } = request.query as { sessionId?: string };
    const groups = await fileChangesApi.getAllCheckpointsGrouped(sessionId);
    return { groups };
  });

  fastify.get('/api/v1/file-changes/checkpoints', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    const checkpoints = await fileChangesApi.getCheckpoints(sessionId);
    return { checkpoints };
  });

  fastify.get('/api/v1/file-changes/diff', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { path: filePath, sessionId, commit } = request.query as { path?: string; sessionId?: string; commit?: string };
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    if (!filePath) {
      const changes = await fileChangesApi.getWorkingChanges(sessionId);
      return { changes };
    }
    const diff = await fileChangesApi.getFileDiff(sessionId, filePath, commit);
    if (!diff) {
      return { error: 'File not tracked in checkpoint' };
    }
    return diff;
  });

  fastify.post('/api/v1/file-changes/revert', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { sessionId?: string; commitHash?: string; scope?: string };
    if (!body.sessionId || !body.commitHash) {
      reply.status(400);
      return { error: 'sessionId and commitHash are required' };
    }
    const scope = body.scope === 'code' || body.scope === 'conversation' || body.scope === 'all'
      ? body.scope : 'all';
    const result = await fileChangesApi.revert(body.sessionId, body.commitHash, scope);
    return result;
  });

  fastify.post('/api/v1/file-changes/revert-files', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { sessionId?: string; paths?: string[] };
    if (!body.sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    if (!body.paths || body.paths.length === 0) {
      reply.status(400);
      return { error: 'paths array is required' };
    }
    return fileChangesApi.revertFiles(body.sessionId, body.paths);
  });

  fastify.post('/api/v1/file-changes/revert-all', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { sessionId?: string };
    if (!body.sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    return fileChangesApi.revertAll(body.sessionId);
  });

  fastify.post('/api/v1/file-changes/snapshot', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { sessionId?: string; message?: string };
    if (!body.sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    const result = await fileChangesApi.createSnapshot(body.sessionId, body.message || 'Manual snapshot');
    return result;
  });

  fastify.get('/api/v1/file-changes/other-session-changes', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId, commitHash } = request.query as { sessionId?: string; commitHash?: string };
    if (!sessionId || !commitHash) {
      reply.status(400);
      return { error: 'sessionId and commitHash are required' };
    }
    return fileChangesApi.getOtherSessionChanges(sessionId, commitHash);
  });
  // ── Checkpoint 磁盘清理端点 ──

  fastify.get('/api/v1/file-changes/disk-usage', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    return fileChangesApi.getCheckpointDiskUsage(sessionId);
  });

  fastify.post('/api/v1/file-changes/gc', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { sessionId?: string };
    if (!body.sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    return fileChangesApi.runCheckpointGc(body.sessionId);
  });

  fastify.post('/api/v1/file-changes/purge', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { sessionId?: string };
    if (!body.sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }
    return fileChangesApi.purgeCheckpointHistory(body.sessionId);
  });
}
