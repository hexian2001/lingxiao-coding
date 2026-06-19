/**
 * gitPanelLoader — 在 TUI 进程内直接调用 RealGitService 组装 GitPanelData。
 *
 * TUI 与后端同进程，无需经过 HTTP；直接 new RealGitService(workspace) 读取真实 .git。
 * 所有失败都收敛到 GitPanelData.error，调用方据此渲染错误态。
 */

import type { GitPanelData } from '../GitPanel.js';

export async function loadGitPanelData(workspace: string): Promise<GitPanelData> {
  const empty: GitPanelData = {
    isRepo: false,
    branch: 'HEAD',
    tracking: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    isClean: true,
    commits: [],
    diff: '',
    loadedAt: Date.now(),
  };

  try {
    const { RealGitService } = await import('../../web-server/RealGitService.js');
    const git = new RealGitService(workspace);

    if (!(await git.isGitRepo())) {
      return { ...empty, isRepo: false };
    }

    const [status, commits, unstagedDiff, stagedDiff] = await Promise.all([
      git.getStatus(),
      git.getLogs(undefined, 8).catch(() => []),
      git.getDiff(false).catch(() => ''),
      git.getDiff(true).catch(() => ''),
    ]);

    // 优先展示未暂存改动；若工作区干净则回退到已暂存 diff
    const diff = unstagedDiff.trim() ? unstagedDiff : stagedDiff;

    return {
      isRepo: true,
      branch: status.branch,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      conflicted: status.conflicted,
      isClean: status.isClean,
      commits: commits.map((c) => ({
        shortHash: c.shortHash,
        message: c.message,
        author: c.author,
        date: c.date,
      })),
      diff,
      loadedAt: Date.now(),
    };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
