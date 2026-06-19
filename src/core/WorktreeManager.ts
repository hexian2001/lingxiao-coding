/**
 * WorktreeManager — CLI entry point for product worktrees.
 *
 * The product worktree implementation lives in WorktreeService so Web UI,
 * task planning, and CLI share one persistence model and one safety policy.
 */

import { basename, resolve } from 'node:path';
import { config as runtimeConfig } from '../config.js';
import { DatabaseManager } from './Database.js';
import { DatabaseRepositoryAdapter } from './DatabaseRepositories.js';
import { WorktreeService, type WorktreeLiveStatus } from './WorktreeService.js';

export interface WorktreeInfo {
  id?: string;
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  sessionId?: string;
  taskId?: string;
  status?: string;
  locked?: boolean;
  exists?: boolean;
  live?: WorktreeLiveStatus;
  createdAt: number;
}

export interface WorktreeOptions {
  /** Worktree name (used as directory name and branch suffix) */
  name?: string;
  /** Branch name to create */
  branch?: string;
  /** Base branch to create from (defaults to current branch) */
  baseBranch?: string;
}

async function withService<T>(fn: (service: WorktreeService) => Promise<T>): Promise<T> {
  const db = new DatabaseManager(process.env.LINGXIAO_WORKTREE_DB_PATH || runtimeConfig.paths.db_path);
  db.init();
  try {
    const repos = new DatabaseRepositoryAdapter(db);
    return await fn(new WorktreeService(repos.worktrees));
  } finally {
    await db.close();
  }
}

function toWorktreeInfo(record: Awaited<ReturnType<WorktreeService['get']>> & object): WorktreeInfo {
  const view = record as NonNullable<Awaited<ReturnType<WorktreeService['get']>>>;
  return {
    id: view.id,
    name: view.name,
    path: view.path,
    branch: view.branch,
    baseBranch: view.base_branch,
    sessionId: view.session_id,
    taskId: view.task_id,
    status: view.status,
    exists: view.exists,
    live: view.live,
    createdAt: Math.round(view.created_at * 1000),
  };
}

function isLikelyPath(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

export const WorktreeManager = {
  /**
   * 检查当前目录是否是 git 仓库
   */
  async isGitRepo(cwd: string): Promise<boolean> {
    return withService((service) => service.isGitRepo(cwd));
  },

  /**
   * 获取当前分支名
   */
  async getCurrentBranch(cwd: string): Promise<string> {
    return withService((service) => service.currentBranch(cwd));
  },

  /**
   * 创建新的 worktree
   */
  async create(cwd: string, options: WorktreeOptions = {}): Promise<WorktreeInfo> {
    return withService(async (service) => {
      if (!await service.isGitRepo(cwd)) {
        throw new Error('当前目录不是 git 仓库');
      }
      const view = await service.create({
        repoRoot: cwd,
        name: options.name,
        branch: options.branch,
        baseBranch: options.baseBranch,
      });
      return toWorktreeInfo(view);
    });
  },

  /**
   * 列出所有 worktree。优先显示凌霄数据库记录，同时合并 Git 原生 worktree。
   */
  async list(cwd: string): Promise<WorktreeInfo[]> {
    return withService(async (service) => {
      const repoRoot = await service.repoRoot(cwd);
      const tracked = await service.list({ repoRoot, includeRemoved: false });
      const byPath = new Map<string, WorktreeInfo>();
      for (const record of tracked) {
        byPath.set(resolve(record.path), toWorktreeInfo(record));
      }
      for (const entry of await service.listGit(repoRoot).catch(() => [])) {
        const key = resolve(entry.path);
        if (byPath.has(key)) {
          byPath.set(key, { ...byPath.get(key)!, locked: entry.locked });
          continue;
        }
        byPath.set(key, {
          name: basename(entry.path),
          path: entry.path,
          branch: entry.branch,
          baseBranch: '',
          locked: entry.locked,
          exists: true,
          createdAt: 0,
        });
      }
      return Array.from(byPath.values());
    });
  },

  /**
   * 检测 worktree 中的文件变更
   */
  async detectChanges(worktreePath: string): Promise<{ modified: string[]; untracked: string[] }> {
    return withService(async (service) => {
      const status = await service.status(worktreePath);
      return {
        modified: [...status.staged, ...status.modified, ...status.conflicted],
        untracked: status.untracked,
      };
    });
  },

  /**
   * 移除 worktree。selector 可以是 DB id、名称、目录 basename 或完整路径。
   */
  async remove(cwd: string, selector: string, deleteBranch = false): Promise<void> {
    return withService(async (service) => {
      const repoRoot = await service.repoRoot(cwd);
      const resolvedSelector = isLikelyPath(selector) ? resolve(selector) : selector;
      const tracked = await service.list({ repoRoot, includeRemoved: false });
      const match = tracked.find((record) => (
        record.id === selector ||
        record.name === selector ||
        basename(record.path) === selector ||
        resolve(record.path) === resolvedSelector
      ));
      if (match) {
        await service.remove(match.id, { keepBranch: !deleteBranch });
        return;
      }

      const gitMatch = (await service.listGit(repoRoot)).find((entry) => (
        basename(entry.path) === selector ||
        resolve(entry.path) === resolvedSelector
      ));
      if (!gitMatch) {
        throw new Error(`Worktree not found: ${selector}`);
      }

      throw new Error(`Worktree "${selector}" is not tracked by Lingxiao. Remove it with git worktree remove "${gitMatch.path}".`);
    });
  },

  /**
   * Prune stale worktree refs
   */
  async prune(cwd: string): Promise<void> {
    await withService(async (service) => {
      await service.prune(cwd);
    });
  },
};
