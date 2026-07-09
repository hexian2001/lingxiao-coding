/**
 * CanvasRoutes — 剑阁可交互 Canvas 的后端 REST 端点。
 *
 * 支撑 both_layered 双向映射的全部读写：
 *   - GET  /api/v1/canvas/state      读一份产物的完整 Canvas 状态（sourcemap+versions+comments）
 *   - GET  /api/v1/canvas/sourcemap  读 sourcemap（nodeId ↔ 锚点）
 *   - GET  /api/v1/canvas/versions   读版本栈
 *   - POST /api/v1/canvas/version/activate  切换/回退到指定版本
 *   - GET  /api/v1/canvas/comments   读结构化批注
 *   - POST /api/v1/canvas/comment    新增批注
 *   - POST /api/v1/canvas/comment/status  更新批注状态（pending/applied/dismissed）
 *   - POST /api/v1/canvas/intent     提交 SelectionIntent → 转交 Leader 改源码（回写闭环入口）
 *
 * 选区意图提交后注入 Leader prompt；Leader 应调用：
 *   canvas_get_state → 改源码/重生成 → canvas_save_sourcemap（可选）→ canvas_push_version
 * canvas_push_version 会 emit canvas:version_pushed，SseBridge 推到前端。
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import type { AuthFn } from './types.js';
import { Workspace } from '../core/Workspace.js';
import { CanvasStore } from '../core/canvas/CanvasStore.js';
import type { CanvasComment, SelectionIntent } from '../contracts/types/Canvas.js';

export interface CanvasRoutesDeps {
  repos?: DatabaseRepositoryAdapter;
  requireServerToken: AuthFn;
  getActiveSessionId?: () => string | undefined;
  /** 把选区意图转交给 Leader（注入 prompt）。返回是否成功投递。 */
  submitIntentToLeader?: (sessionId: string, intent: SelectionIntent) => Promise<boolean> | boolean;
}

function resolveSessionId(deps: CanvasRoutesDeps, requested?: string): string | undefined {
  return requested || deps.getActiveSessionId?.();
}

function storeFor(deps: CanvasRoutesDeps, sessionId: string): CanvasStore | null {
  const workspace = deps.repos?.sessions.get(sessionId)?.workspace;
  const sessionDir = Workspace.getSessionDir(sessionId, workspace);
  if (!sessionDir) return null;
  return new CanvasStore({ sessionDir, workspace });
}

export function registerCanvasRoutes(fastify: FastifyInstance, deps: CanvasRoutesDeps): void {
  const { requireServerToken } = deps;

  // ── 读取完整 Canvas 状态 ──────────────────────────────────────
  fastify.get('/api/v1/canvas/state', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { artifactId?: string; sessionId?: string };
    if (!query.artifactId) { reply.status(400); return { error: 'artifactId is required' }; }
    const sessionId = resolveSessionId(deps, query.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    const state = store.getArtifactState(query.artifactId);
    if (!state) { reply.status(404); return { error: 'canvas state not found for artifact' }; }
    return state;
  });

  // ── 读 sourcemap ──────────────────────────────────────────────
  fastify.get('/api/v1/canvas/sourcemap', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { artifactId?: string; sessionId?: string };
    if (!query.artifactId) { reply.status(400); return { error: 'artifactId is required' }; }
    const sessionId = resolveSessionId(deps, query.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    const sm = store.getSourceMap(query.artifactId);
    if (!sm) { reply.status(404); return { error: 'sourcemap not found' }; }
    return sm;
  });

  // ── 读版本栈 ──────────────────────────────────────────────────
  fastify.get('/api/v1/canvas/versions', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { artifactId?: string; sessionId?: string };
    if (!query.artifactId) { reply.status(400); return { error: 'artifactId is required' }; }
    const sessionId = resolveSessionId(deps, query.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    return { versions: store.listVersions(query.artifactId), activeVersion: store.getActiveVersion(query.artifactId) };
  });

  // ── 切换/回退版本 ─────────────────────────────────────────────
  fastify.post('/api/v1/canvas/version/activate', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { artifactId?: string; version?: number; sessionId?: string };
    if (!body.artifactId || typeof body.version !== 'number') {
      reply.status(400); return { error: 'artifactId and version are required' };
    }
    const sessionId = resolveSessionId(deps, body.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    const ok = store.switchVersion(body.artifactId, body.version);
    if (!ok) { reply.status(404); return { error: 'version not found' }; }
    return { ok: true, activeVersion: body.version };
  });

  // ── 读批注 ────────────────────────────────────────────────────
  fastify.get('/api/v1/canvas/comments', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const query = request.query as { artifactId?: string; sessionId?: string };
    if (!query.artifactId) { reply.status(400); return { error: 'artifactId is required' }; }
    const sessionId = resolveSessionId(deps, query.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    return { comments: store.listComments(query.artifactId) };
  });

  // ── 新增批注 ──────────────────────────────────────────────────
  fastify.post('/api/v1/canvas/comment', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as Partial<CanvasComment> & { sessionId?: string };
    if (!body.artifactId || !body.body) {
      reply.status(400); return { error: 'artifactId and body are required' };
    }
    const sessionId = resolveSessionId(deps, body.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    const now = Date.now();
    const comment: CanvasComment = {
      id: `c-${now}-${Math.random().toString(36).slice(2, 8)}`,
      artifactId: body.artifactId,
      nodeId: body.nodeId,
      version: body.version ?? store.getActiveVersion(body.artifactId),
      body: body.body,
      selectionBox: body.selectionBox,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    store.addComment(comment);
    return comment;
  });

  // ── 更新批注状态 ──────────────────────────────────────────────
  fastify.post('/api/v1/canvas/comment/status', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as { artifactId?: string; commentId?: string; status?: CanvasComment['status']; sessionId?: string };
    if (!body.artifactId || !body.commentId || !body.status) {
      reply.status(400); return { error: 'artifactId, commentId and status are required' };
    }
    const sessionId = resolveSessionId(deps, body.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const store = storeFor(deps, sessionId);
    if (!store) { reply.status(404); return { error: 'session workspace not found' }; }
    const ok = store.updateCommentStatus(body.artifactId, body.commentId, body.status);
    if (!ok) { reply.status(404); return { error: 'comment not found' }; }
    return { ok: true };
  });

  // ── 提交选区意图（回写闭环入口）────────────────────────────────
  fastify.post('/api/v1/canvas/intent', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as Partial<SelectionIntent> & { sessionId?: string };
    if (!body.artifactId || !body.userIntent || !body.anchor || !body.nodeId) {
      reply.status(400); return { error: 'artifactId, nodeId, anchor and userIntent are required' };
    }
    const sessionId = resolveSessionId(deps, body.sessionId);
    if (!sessionId) { reply.status(400); return { error: 'no active session' }; }
    const intent: SelectionIntent = {
      nodeId: body.nodeId,
      anchor: body.anchor,
      currentContent: body.currentContent,
      userIntent: body.userIntent,
      artifactId: body.artifactId,
      selectionBox: body.selectionBox,
      createdAt: Date.now(),
    };
    if (!deps.submitIntentToLeader) {
      reply.status(503);
      return { error: 'intent submission not wired to leader' };
    }
    const delivered = await deps.submitIntentToLeader(sessionId, intent);
    if (!delivered) { reply.status(502); return { error: 'failed to deliver intent to leader' }; }
    return { ok: true, intent };
  });
}
