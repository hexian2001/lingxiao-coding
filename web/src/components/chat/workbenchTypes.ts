import type { GitBranch, GitCommit, GitStatus } from '../../stores/gitStore';
import type { WorktreeInfo } from '../../stores/worktreeStore';

export interface WorkbenchContext {
  workspace: {
    path: string;
    name: string;
    source: string;
    parent: string;
  };
  session: {
    id: string;
    name?: string;
    summary?: string;
    status?: string;
    workspace?: string;
    isActive?: boolean;
  } | null;
  worktree?: WorktreeInfo | null;
  git: {
    isRepo: boolean;
    status: GitStatus | null;
    counts: {
      staged: number;
      unstaged: number;
      untracked: number;
      conflicted: number;
      total: number;
    };
    branches: GitBranch[];
    commits: GitCommit[];
    platform: {
      platform: 'github' | 'gitlab' | 'gitea' | 'none';
      apiUrl: string;
      owner: string;
      repo: string;
    } | null;
    diff: {
      additions: number;
      deletions: number;
    };
  };
}
