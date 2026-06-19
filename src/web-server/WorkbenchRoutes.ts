import path from 'path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseManager } from '../core/Database.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { AuthFn } from './types.js';
import { RealGitService } from './RealGitService.js';
import { WorktreeService } from '../core/WorktreeService.js';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';

function workspaceName(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || workspace || 'workspace';
}

function resolveWorkspace(input: {
  workspace?: string;
  sessionId?: string;
  db: DatabaseManager;
  getActiveSessionId?: () => string | undefined;
}): { workspace: string; sessionId: string | null; source: string } {
  const explicitWorkspace = input.workspace?.trim();
  if (explicitWorkspace) {
    return { workspace: explicitWorkspace, sessionId: input.sessionId || null, source: 'query' };
  }

  const candidates = [
    input.sessionId,
    input.getActiveSessionId?.(),
  ].filter(Boolean) as string[];

  for (const id of candidates) {
    const session = input.db.getSession(id);
    if (session?.workspace) {
      return { workspace: session.workspace, sessionId: id, source: id === input.sessionId ? 'session' : 'active_session' };
    }
  }

  return { workspace: process.cwd(), sessionId: null, source: 'server_cwd' };
}

function countStatus(status: Awaited<ReturnType<RealGitService['getStatus']>> | null) {
  if (!status) {
    return { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: 0 };
  }
  const staged = status.staged.length;
  const unstaged = status.unstaged.length;
  const untracked = status.untracked.length;
  const conflicted = status.conflicted.length;
  return { staged, unstaged, untracked, conflicted, total: staged + unstaged + untracked + conflicted };
}

function diffLineStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

export function registerWorkbenchRoutes(
  fastify: FastifyInstance,
  deps: {
    repos: DatabaseRepositoryAdapter;
    sessionManager: SessionManager;
    requireServerToken: AuthFn;
    getActiveSessionId?: () => string | undefined;
  },
): void {
  const { repos, sessionManager, requireServerToken, getActiveSessionId } = deps;
  const worktreeService = new WorktreeService(repos.worktrees);

  fastify.get('/api/v1/workbench/context', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;

    const query = request.query as { workspace?: string; sessionId?: string };
    const resolved = resolveWorkspace({
      workspace: query.workspace,
      sessionId: query.sessionId,
      db: repos.raw,
      getActiveSessionId,
    });

    const activeSession = resolved.sessionId ? repos.sessions.get(resolved.sessionId) : null;
    const activeIds = new Set(sessionManager.getActiveSessionIds());
    const git = new RealGitService(resolved.workspace);
    const currentWorktree = await worktreeService.findByPath(resolved.workspace).catch(() => null);

    try {
      const isRepo = await git.isGitRepo();
      if (!isRepo) {
        return {
          data: {
            workspace: {
              path: resolved.workspace,
              name: workspaceName(resolved.workspace),
              source: resolved.source,
              parent: path.dirname(resolved.workspace),
            },
            session: activeSession ? { ...activeSession, isActive: activeIds.has(activeSession.id) } : null,
            worktree: currentWorktree,
            git: { isRepo: false, status: null, counts: countStatus(null), branches: [], commits: [], platform: null, diff: { additions: 0, deletions: 0 } },
          },
        };
      }

      const [status, branches, commits, platform, unstagedDiff, stagedDiff] = await Promise.all([
        git.getStatus(),
        git.getBranches(),
        git.getLogs(undefined, 5),
        git.detectPlatformFromRemote(),
        git.getDiff(false),
        git.getDiff(true),
      ]);
      const unstagedStats = diffLineStats(unstagedDiff);
      const stagedStats = diffLineStats(stagedDiff);

      return {
        data: {
          workspace: {
            path: resolved.workspace,
            name: workspaceName(resolved.workspace),
            source: resolved.source,
            parent: path.dirname(resolved.workspace),
          },
          session: activeSession ? { ...activeSession, isActive: activeIds.has(activeSession.id) } : null,
          worktree: currentWorktree,
          git: {
            isRepo: true,
            status,
            counts: countStatus(status),
            branches,
            commits,
            platform,
            diff: {
              additions: unstagedStats.additions + stagedStats.additions,
              deletions: unstagedStats.deletions + stagedStats.deletions,
            },
          },
        },
      };
    } catch (error) {
      reply.status(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
