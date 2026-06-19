import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import { WorktreeError, WorktreeService } from '../core/WorktreeService.js';
import type { AuthFn } from './types.js';

function sendWorktreeError(reply: { status: (code: number) => unknown }, error: unknown): { error: string } {
  const message = error instanceof Error ? error.message : String(error);
  reply.status(error instanceof WorktreeError ? error.statusCode : 500);
  return { error: message };
}

export function registerWorktreeRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    requireServerToken: AuthFn;
  },
): void {
  const { repos, requireServerToken } = deps;
  const service = new WorktreeService(repos.worktrees);

  fastify.get('/api/v1/worktrees', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { repoRoot?: string; sessionId?: string; includeRemoved?: string };
    try {
      const data = await service.list({
        repoRoot: query.repoRoot,
        sessionId: query.sessionId,
        includeRemoved: query.includeRemoved === 'true',
      });
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.post('/api/v1/worktrees', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as {
      repoRoot?: string;
      name?: string;
      branch?: string;
      baseBranch?: string;
      sessionId?: string;
      taskId?: string;
    };
    if (!body.repoRoot?.trim()) {
      reply.status(400);
      return { error: 'repoRoot is required' };
    }
    try {
      const data = await service.create({
        repoRoot: body.repoRoot,
        name: body.name,
        branch: body.branch,
        baseBranch: body.baseBranch,
        sessionId: body.sessionId,
        taskId: body.taskId,
      });
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.get('/api/v1/worktrees/by-path', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { path?: string };
    if (!query.path?.trim()) {
      reply.status(400);
      return { error: 'path is required' };
    }
    try {
      const data = await service.findByPath(query.path);
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.get('/api/v1/worktrees/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      const data = await service.get(id);
      if (!data) {
        reply.status(404);
        return { error: 'Worktree not found' };
      }
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.get('/api/v1/worktrees/:id/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      const data = await service.get(id);
      if (!data) {
        reply.status(404);
        return { error: 'Worktree not found' };
      }
      return { data: data.live || null, worktree: data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.post('/api/v1/worktrees/:id/attach-session', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { sessionId?: string | null };
    try {
      const data = await service.attachSession(id, body.sessionId || null);
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.post('/api/v1/worktrees/:id/merge', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { ffOnly?: boolean; deleteAfterMerge?: boolean };
    try {
      const data = await service.merge(id, {
        ffOnly: body.ffOnly !== false,
        deleteAfterMerge: body.deleteAfterMerge === true,
      });
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.delete('/api/v1/worktrees/:id', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const { id } = request.params as { id: string };
    const query = request.query as { keepBranch?: string };
    try {
      const data = await service.remove(id, { keepBranch: query.keepBranch === 'true' });
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });

  fastify.post('/api/v1/worktrees/prune', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { repoRoot?: string };
    if (!body.repoRoot?.trim()) {
      reply.status(400);
      return { error: 'repoRoot is required' };
    }
    try {
      const data = await service.prune(body.repoRoot);
      return { data };
    } catch (error) {
      return sendWorktreeError(reply, error);
    }
  });
}
