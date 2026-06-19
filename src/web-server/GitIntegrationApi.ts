/**
 * GitIntegrationApi — 真实 Git 仓库操作 + 平台 MR/PR API 路由
 *
 * 路由前缀：/api/v1/git
 *
 * Workspace safety rules:
 *   - Write operations (commit/stage/push/pull/switch/delete/stash/revert):
 *     workspace is explicitly provided; missing workspace returns 400.
 *   - Read operations (status/log/diff/branches/detect):
 *     fall back to SERVER_CWD (the directory at server startup), never process.cwd().
 *
 * We capture process.cwd() once at module load time so it stays stable
 * even if the working directory is later changed programmatically.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RealGitService } from './RealGitService.js';
import { GitPlatformApi, GitPlatformUnavailableError, type GitPlatformConfig } from './GitPlatformApi.js';
import { getConfigValue } from '../config.js';
import { existsSync } from 'fs';

/** Locked at server startup — never changes after boot */
const SERVER_CWD = process.cwd();

/**
 * Resolve workspace for READ-ONLY operations.
 * Falls back to SERVER_CWD rather than the (potentially changed) process.cwd().
 */
function resolveReadWorkspace(workspace?: string): string {
  return workspace?.trim() || SERVER_CWD;
}

/**
 * Resolve workspace for WRITE operations.
 * Returns null if workspace is empty/missing — callers must reject the request.
 */
function resolveWriteWorkspace(workspace?: string): string | null {
  const w = workspace?.trim();
  return w || null;
}

export class GitIntegrationApi {
  private gitServices = new Map<string, RealGitService>();

  private getGitService(workspace: string): RealGitService {
    if (!this.gitServices.has(workspace)) {
      this.gitServices.set(workspace, new RealGitService(workspace));
    }
    return this.gitServices.get(workspace)!;
  }

  private getPlatformConfig(overrideOwner?: string, overrideRepo?: string): GitPlatformConfig {
    const platform = (getConfigValue('git.platform') as string) || 'none';
    const token = (getConfigValue('git.token') as string) || '';
    const apiUrl = (getConfigValue('git.api_url') as string) || '';
    return {
      platform: platform as GitPlatformConfig['platform'],
      token,
      apiUrl: apiUrl || undefined,
      owner: overrideOwner,
      repo: overrideRepo,
    };
  }

  /**
   * 自动检测并构建 GitPlatformApi，owner/repo 从 remote URL 推断
   */
  private async buildPlatformApi(workspace: string): Promise<GitPlatformApi> {
    const git = this.getGitService(workspace);
    const detected = await git.detectPlatformFromRemote();
    const savedCfg = this.getPlatformConfig();

    // 合并：已配置的平台覆盖检测结果，但 owner/repo 优先用检测到的
    const platform = savedCfg.platform !== 'none' ? savedCfg.platform : detected.platform;
    const apiUrl = savedCfg.apiUrl || detected.apiUrl;
    const owner = detected.owner;
    const repo = detected.repo;

    return new GitPlatformApi({ ...savedCfg, platform, apiUrl, owner, repo });
  }

  registerRoutes(
    fastify: FastifyInstance,
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => boolean,
  ): void {
    const self = this;

    // ── git status ──
    fastify.get('/api/v1/git/status', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.query as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const isRepo = await git.isGitRepo();
        if (!isRepo) return { data: null, error: 'Not a git repository' };
        const status = await git.getStatus();
        return { data: status };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── branches ──
    fastify.get('/api/v1/git/branches', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.query as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const isRepo = await git.isGitRepo();
        if (!isRepo) return { data: [], error: 'Not a git repository' };
        const branches = await git.getBranches();
        return { data: branches };
      } catch (e) {
        return { data: [], error: e instanceof Error ? e.message : String(e) };
      }
    });

    // ── log ──
    fastify.get('/api/v1/git/log', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, branch, limit } = request.query as { workspace?: string; branch?: string; limit?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const logs = await git.getLogs(branch, limit ? parseInt(limit, 10) : 30);
        return { data: logs };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── diff ──
    fastify.get('/api/v1/git/diff', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, staged, file } = request.query as { workspace?: string; staged?: string; file?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const isStagedFlag = staged === 'true';
        const diff = file
          ? await git.getFileDiff(file, isStagedFlag)
          : await git.getDiff(isStagedFlag);
        return { data: diff };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── stage ──
    fastify.post('/api/v1/git/stage', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, files } = request.body as { workspace?: string; files?: string[] };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        await git.stageFiles(files || []);
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── unstage ──
    fastify.post('/api/v1/git/unstage', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, files } = request.body as { workspace?: string; files?: string[] };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        await git.unstageFiles(files || []);
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── commit ──
    fastify.post('/api/v1/git/commit', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, message, amend, allow_empty } = request.body as {
        workspace?: string; message: string; amend?: boolean; allow_empty?: boolean;
      };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      if (!message) return reply.status(400).send({ error: 'message is required' });
      try {
        const git = self.getGitService(dir);
        const hash = await git.commit(message, { amend, allowEmpty: allow_empty });
        return { success: true, data: { hash } };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── create branch ──
    fastify.post('/api/v1/git/branch', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, name, from } = request.body as { workspace?: string; name: string; from?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      if (!name) return reply.status(400).send({ error: 'name is required' });
      try {
        const git = self.getGitService(dir);
        await git.createBranch(name, from);
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── switch branch ──
    fastify.post('/api/v1/git/switch', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, branch } = request.body as { workspace?: string; branch: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      if (!branch) return reply.status(400).send({ error: 'branch is required' });
      try {
        const git = self.getGitService(dir);
        await git.switchBranch(branch);
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── delete branch ──
    fastify.delete('/api/v1/git/branch/:name', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { name } = request.params as { name: string };
      const { workspace, force } = request.query as { workspace?: string; force?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        await git.deleteBranch(name, force === 'true');
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── push ──
    fastify.post('/api/v1/git/push', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, remote, branch, set_upstream } = request.body as {
        workspace?: string; remote?: string; branch?: string; set_upstream?: boolean;
      };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        const result = await git.push({ remote, branch, setUpstream: set_upstream });
        return { success: true, data: result };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── pull ──
    fastify.post('/api/v1/git/pull', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, remote, branch } = request.body as { workspace?: string; remote?: string; branch?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        const result = await git.pull(remote, branch);
        return { success: true, data: result };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── fetch ──
    fastify.post('/api/v1/git/fetch', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.body as { workspace?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        await git.fetch();
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── remotes ──
    fastify.get('/api/v1/git/remotes', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.query as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const remotes = await git.getRemotes();
        return { data: remotes };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── add remote ──
    fastify.post('/api/v1/git/remotes', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, name, url } = request.body as { workspace?: string; name: string; url: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      if (!name || !url) return reply.status(400).send({ error: 'name and url are required' });
      try {
        const git = self.getGitService(dir);
        await git.addRemote(name, url);
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── stash ──
    fastify.post('/api/v1/git/stash', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, message } = request.body as { workspace?: string; message?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        await git.stash(message);
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    fastify.post('/api/v1/git/stash/pop', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.body as { workspace?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required for write operations' });
      try {
        const git = self.getGitService(dir);
        await git.stashPop();
        return { success: true };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    fastify.get('/api/v1/git/stash', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.query as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const list = await git.stashList();
        return { data: list };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── detect platform ──
    fastify.get('/api/v1/git/detect', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.query as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const detected = await git.detectPlatformFromRemote();
        return { data: detected };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: list MRs ──
    fastify.get('/api/v1/git/platform/mrs', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, state } = request.query as { workspace?: string; state?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const api = await self.buildPlatformApi(dir);
        const mrs = await api.listMRs((state || 'open') as 'open' | 'closed' | 'merged' | 'all');
        return { data: mrs };
      } catch (e) {
        // 平台未配置/未授权/仓库不可见 → 优雅降级为空列表 + unavailable 标志，而非 500。
        // 这样前端可正常渲染面板并提示用户去配置，而不是一片红错。
        if (e instanceof GitPlatformUnavailableError) {
          return { data: [], unavailable: true, reason: e.reason, message: e.message };
        }
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: create MR ──
    fastify.post('/api/v1/git/platform/mrs', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace, title, description, source_branch, target_branch, draft } = request.body as {
        workspace?: string; title: string; description?: string;
        source_branch: string; target_branch: string; draft?: boolean;
      };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required' });
      if (!title || !source_branch || !target_branch) {
        return reply.status(400).send({ error: 'title, source_branch, target_branch are required' });
      }
      try {
        const api = await self.buildPlatformApi(dir);
        const mr = await api.createMR({ title, description, sourceBranch: source_branch, targetBranch: target_branch, draft });
        return { data: mr };
      } catch (e) {
        if (e instanceof GitPlatformUnavailableError) {
          return reply.status(503).send({ error: e.message, unavailable: true, reason: e.reason });
        }
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: merge MR ──
    fastify.post('/api/v1/git/platform/mrs/:id/merge', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { id } = request.params as { id: string };
      const { workspace, method } = request.body as { workspace?: string; method?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required' });
      try {
        const api = await self.buildPlatformApi(dir);
        await api.mergeMR(id, (method || 'merge') as 'merge' | 'squash' | 'rebase');
        return { success: true };
      } catch (e) {
        if (e instanceof GitPlatformUnavailableError) {
          return reply.status(503).send({ error: e.message, unavailable: true, reason: e.reason });
        }
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: close MR ──
    fastify.post('/api/v1/git/platform/mrs/:id/close', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { id } = request.params as { id: string };
      const { workspace } = request.body as { workspace?: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required' });
      try {
        const api = await self.buildPlatformApi(dir);
        await api.closeMR(id);
        return { success: true };
      } catch (e) {
        if (e instanceof GitPlatformUnavailableError) {
          return reply.status(503).send({ error: e.message, unavailable: true, reason: e.reason });
        }
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: add comment ──
    fastify.post('/api/v1/git/platform/mrs/:id/comment', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { id } = request.params as { id: string };
      const { workspace, body: commentBody } = request.body as { workspace?: string; body: string };
      const dir = resolveWriteWorkspace(workspace);
      if (!dir) return reply.status(400).send({ error: 'workspace is required' });
      try {
        const api = await self.buildPlatformApi(dir);
        await api.addComment(id, commentBody);
        return { success: true };
      } catch (e) {
        if (e instanceof GitPlatformUnavailableError) {
          return reply.status(503).send({ error: e.message, unavailable: true, reason: e.reason });
        }
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── git init ──
    fastify.post('/api/v1/git/init', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.body as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const git = self.getGitService(dir);
        const isRepo = await git.isGitRepo();
        if (isRepo) return { data: { message: 'Already a git repository' } };
        await git.init();
        return { data: { message: 'Initialized empty Git repository', path: dir } };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: repo info ──
    fastify.get('/api/v1/git/platform/info', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.query as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const api = await self.buildPlatformApi(dir);
        const info = await api.getRepoInfo();
        return { data: info };
      } catch (e) {
        reply.status(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    // ── platform: test connection ──
    fastify.post('/api/v1/git/platform/test', async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const { workspace } = request.body as { workspace?: string };
      const dir = resolveReadWorkspace(workspace);
      try {
        const api = await self.buildPlatformApi(dir);
        const result = await api.testConnection();
        return result;
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });
  }
}
