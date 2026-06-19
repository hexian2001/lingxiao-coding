/**
 * RealGitService — 操作用户项目真实 .git 仓库
 *
 * 不同于 GitService（shadow git），本类直接在项目 .git 上操作，
 * 支持分支管理、提交、推送、拉取等完整 git 工作流。
 */

import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import { getConfigValue } from '../../config.js';
import { buildSafeGitEnv } from './GitEnv.js';

/** Validate a git ref name (branch/tag). Rejects shell metacharacters. */
function validateRefName(name: string, label = 'ref'): void {
  // Git ref names: allow alphanumeric, slash, dash, underscore, dot, hash, @
  if (!/^[a-zA-Z0-9_./@#-]+$/.test(name)) {
    throw new Error(`Invalid ${label} name: "${name}"`);
  }
}

export interface FileStatus {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitStatus {
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  conflicted: string[];
  isClean: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
  lastCommit?: string;
  lastCommitMsg?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

export class RealGitService {
  private projectRoot: string;
  private git: SimpleGit;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.git = simpleGit(projectRoot).env(buildSafeGitEnv());
  }

  /**
   * 检查当前目录是否为 git 仓库
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {/* expected: operation may fail */
      return false;
    }
  }

  /**
   * 获取当前工作区状态
   */
  async getStatus(): Promise<GitStatus> {
    const status: StatusResult = await this.git.status();

    const staged: FileStatus[] = [
      ...status.created.filter(f => status.staged?.includes(f) ?? false).map(f => ({ path: f, index: 'A', working_dir: ' ' })),
      ...status.deleted.filter(f => status.staged?.includes(f) ?? false).map(f => ({ path: f, index: 'D', working_dir: ' ' })),
      ...status.modified.filter(f => status.staged?.includes(f) ?? false).map(f => ({ path: f, index: 'M', working_dir: ' ' })),
      ...status.renamed.filter(r => status.staged?.includes(r.to) ?? false).map(r => ({ path: r.to, index: 'R', working_dir: ' ' })),
    ];

    // simple-git status provides staged/unstaged via files[]
    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];

    for (const f of status.files) {
      const indexStatus = f.index;
      const wdStatus = f.working_dir;
      if (indexStatus !== ' ' && indexStatus !== '?') {
        stagedFiles.push({ path: f.path, index: indexStatus, working_dir: wdStatus });
      }
      if (wdStatus !== ' ' && wdStatus !== '') {
        unstagedFiles.push({ path: f.path, index: indexStatus, working_dir: wdStatus });
      }
    }

    return {
      branch: status.current || 'HEAD',
      tracking: status.tracking || null,
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      staged: stagedFiles,
      unstaged: unstagedFiles,
      untracked: status.not_added || [],
      conflicted: status.conflicted || [],
      isClean: status.isClean(),
    };
  }

  /**
   * 获取所有分支（本地 + 远端）
   */
  async getBranches(): Promise<GitBranch[]> {
    let summary;
    try {
      summary = await this.git.branch(['-a', '-v']);
    } catch {/* expected: data source unavailable */
      return [];
    }
    const branches: GitBranch[] = [];

    for (const [name, b] of Object.entries(summary.branches)) {
      const isRemote = name.startsWith('remotes/');
      const displayName = isRemote ? name.replace(/^remotes\//, '') : name;
      branches.push({
        name: displayName,
        current: b.current,
        remote: isRemote,
        lastCommit: b.commit,
        lastCommitMsg: b.label,
      });
    }

    return branches;
  }

  /**
   * 获取提交历史
   */
  async getLogs(branch?: string, limit = 30): Promise<GitCommit[]> {
    const options: string[] = ['--format=%H|%h|%s|%an|%aI', `-n${limit}`];
    if (branch) {
      validateRefName(branch, 'branch');
      options.push(branch);
    }

    try {
      const result = await this.git.raw(['log', ...options]);
      if (!result.trim()) return [];

      return result.trim().split('\n').map(line => {
        const parts = line.split('|');
        return {
          hash: parts[0] || '',
          shortHash: parts[1] || '',
          message: parts[2] || '',
          author: parts[3] || '',
          date: parts[4] || '',
        };
      });
    } catch {/* expected: data source unavailable */
      return [];
    }
  }

  /**
   * 暂存文件
   */
  async stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) {
      await this.git.add('.');
    } else {
      await this.git.add(files);
    }
  }

  /**
   * 取消暂存文件
   */
  async unstageFiles(files: string[]): Promise<void> {
    if (files.length === 0) {
      await this.git.raw(['restore', '--staged', '.']);
    } else {
      await this.git.raw(['restore', '--staged', ...files]);
    }
  }

  /**
   * 提交
   */
  async commit(message: string, options?: { amend?: boolean; allowEmpty?: boolean }): Promise<string> {
    let commitMessage = message;
    // 条件追加 Co-authored-by trailer
    const includeCoAuthor = getConfigValue('ui.include_co_authored_by');
    if (includeCoAuthor !== false && !message.includes('Co-authored-by:')) {
      commitMessage = `${message}\n\nCo-authored-by: Lingxiao <noreply@lingxiao.ai>`;
    }
    const args = ['commit', '-m', commitMessage];
    if (options?.amend) args.push('--amend');
    if (options?.allowEmpty) args.push('--allow-empty');
    const result = await this.git.raw(args);
    // Extract commit hash from output
    const match = result.match(/\[[\w\/]+\s+([a-f0-9]+)\]/);
    return match ? match[1] : '';
  }

  /**
   * 创建分支
   */
  async createBranch(name: string, from?: string): Promise<void> {
    validateRefName(name, 'branch');
    if (from) {
      validateRefName(from, 'base branch');
      await this.git.checkoutBranch(name, from);
    } else {
      await this.git.checkoutLocalBranch(name);
    }
  }

  /**
   * 切换分支
   */
  async switchBranch(name: string): Promise<void> {
    validateRefName(name, 'branch');
    await this.git.checkout(name);
  }

  /**
   * 删除分支
   */
  async deleteBranch(name: string, force = false): Promise<void> {
    validateRefName(name, 'branch');
    if (force) {
      await this.git.branch(['-D', name]);
    } else {
      await this.git.branch(['-d', name]);
    }
  }

  /**
   * 推送到远端
   */
  async push(options?: PushOptions): Promise<string> {
    const args: string[] = [];
    if (options?.setUpstream) args.push('-u');
    const remote = options?.remote || 'origin';
    const branch = options?.branch;

    if (branch) {
      args.push(remote, branch);
    } else {
      args.push(remote);
    }

    const result = await this.git.push(args);
    return result.remoteMessages?.all?.join('\n') || 'pushed';
  }

  /**
   * 拉取
   */
  async pull(remote?: string, branch?: string): Promise<string> {
    const result = await this.git.pull(remote, branch);
    return `${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`;
  }

  /**
   * fetch 所有远端
   */
  async fetch(): Promise<void> {
    await this.git.fetch(['--all', '--prune']);
  }

  /**
   * 获取 diff
   */
  async getDiff(staged = false): Promise<string> {
    if (staged) {
      return this.git.diff(['--staged']);
    }
    return this.git.diff();
  }

  /**
   * 获取单个文件的 diff
   */
  async getFileDiff(filePath: string, staged = false): Promise<string> {
    const args = staged ? ['--staged', '--', filePath] : ['--', filePath];
    return this.git.diff(args);
  }

  /**
   * Stash 当前工作区变更
   */
  async stash(message?: string): Promise<void> {
    const args = message ? ['push', '-m', message] : ['push'];
    await this.git.stash(args);
  }

  /**
   * 弹出最近的 stash（pop）
   */
  async stashPop(): Promise<void> {
    await this.git.stash(['pop']);
  }

  /**
   * 列出 stash 列表
   */
  async stashList(): Promise<Array<{ index: number; message: string }>> {
    const result = await this.git.stashList();
    return result.all.map((entry, i) => ({ index: i, message: entry.message }));
  }

  /**
   * 获取远端列表
   */
  async getRemotes(): Promise<GitRemote[]> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map(r => ({
      name: r.name,
      fetchUrl: r.refs?.fetch || '',
      pushUrl: r.refs?.push || '',
    }));
  }

  /**
   * 添加远端
   */
  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
  }

  /**
   * 从 remote URL 解析 platform/owner/repo
   * 支持格式：
   *   git@github.com:owner/repo.git
   *   https://github.com/owner/repo.git
   *   https://gitlab.example.com/owner/repo
   *   https://gitea.example.com/owner/repo
   */
  async detectPlatformFromRemote(): Promise<{
    platform: 'github' | 'gitlab' | 'gitea' | 'none';
    apiUrl: string;
    owner: string;
    repo: string;
  }> {
    try {
      const remotes = await this.getRemotes();
      const origin = remotes.find(r => r.name === 'origin') || remotes[0];
      if (!origin) return { platform: 'none', apiUrl: '', owner: '', repo: '' };

      const url = origin.fetchUrl || origin.pushUrl;
      return parseRemoteUrl(url);
    } catch {/* expected: fallback to default */
      return { platform: 'none', apiUrl: '', owner: '', repo: '' };
    }
  }

  /**
   * 初始化 git 仓库
   */
  async init(): Promise<void> {
    await this.git.init();
  }
}

/**
 * 解析 git remote URL，返回平台信息
 */
export function parseRemoteUrl(url: string): {
  platform: 'github' | 'gitlab' | 'gitea' | 'none';
  apiUrl: string;
  owner: string;
  repo: string;
} {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const owner = sshMatch[2];
    const repo = sshMatch[3];
    const platform = detectPlatformFromHost(host);
    const apiUrl = platform === 'github' ? 'https://api.github.com'
      : platform === 'gitlab' ? `https://${host}` : `https://${host}`;
    return { platform, apiUrl, owner, repo };
  }

  // HTTPS format: https://github.com/owner/repo.git
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (parts.length >= 2) {
      const host = parsed.hostname;
      const owner = parts[0];
      const repo = parts.slice(1).join('/');
      const platform = detectPlatformFromHost(host);
      const apiUrl = platform === 'github' ? 'https://api.github.com'
        : `${parsed.protocol}//${host}`;
      return { platform, apiUrl, owner, repo };
    }
  } catch {
    // Not a valid URL
  }

  return { platform: 'none', apiUrl: '', owner: '', repo: '' };
}

function detectPlatformFromHost(host: string): 'github' | 'gitlab' | 'gitea' | 'none' {
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';
  if (host.includes('gitea')) return 'gitea';
  // Default self-hosted to gitea (most common for generic git hosts)
  return 'none';
}
