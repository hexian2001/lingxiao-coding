/**
 * GitService — Shadow Git 仓库管理，支持文件快照（checkpoint）与回滚
 *
 * 原理：在 ~/.lingxiao/history/<project_hash>/ 下创建隐藏 git 仓库，
 * 通过 GIT_DIR + GIT_WORK_TREE 环境变量对项目目录做快照，
 * 不干扰用户自己的 .git 仓库。
 *
 * 参考：qwen-code GitService，适配凌霄架构
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { CONFIG_DIR } from '../config.js';
import { simpleGit, type SimpleGit, type DefaultLogFields, type DiffResultBinaryFile, type DiffResultNameStatusFile, type DiffResultTextFile } from 'simple-git';
import { buildSafeGitEnv } from './GitEnv.js';

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHADOW_GITIGNORE_DEFAULTS = `

# Lingxiao shadow checkpoint noise
.git/
node_modules/
.venv/
venv/
env/
__pycache__/
*.py[cod]
*.pyo
.pytest_cache/
.mypy_cache/
.ruff_cache/
.next/
dist/
build/
.lingxiao/artifacts/
.lingxiao/logs/
.lingxiao/terminal/
.lingxiao/data.db*
.lingxiao/lingxiao.db*
`;

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  timestamp: number;
  files: string[];
  additions: number;
  deletions: number;
  type: 'session_start' | 'turn' | 'tool' | 'revert' | 'manual';
  turnNumber?: number;
  toolName?: string;
  actorType?: 'leader' | 'agent';
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  taskId?: string;
}

/** Parse type and turnNumber from a checkpoint commit message label (post-session-prefix) */
function parseCheckpointMeta(label: string): Pick<Checkpoint, 'type' | 'turnNumber' | 'toolName' | 'actorType' | 'agentName' | 'taskId'> {
  // e.g. "[turn:3] [tool] Auto: structured_patch"
  // e.g. "[turn:2] Turn 2: <user message>"
  // e.g. "[agent:Nova] [task:T-1] [tool] Auto: structured_patch"
  const agentToolMatch = label.match(/^\[agent:([^\]]+)\]\s*(?:\[task:([^\]]+)\]\s*)?\[tool\]\s*Auto:\s*(.+)$/);
  if (agentToolMatch) {
    return {
      type: 'tool',
      toolName: agentToolMatch[3].trim(),
      actorType: 'agent',
      agentName: agentToolMatch[1].trim(),
      taskId: agentToolMatch[2]?.trim(),
    };
  }

  const toolMatch = label.match(/^\[turn:(\d+)\]\s*\[tool\]\s*Auto:\s*(.+)$/);
  if (toolMatch) {
    return {
      type: 'tool',
      turnNumber: parseInt(toolMatch[1], 10),
      toolName: toolMatch[2].trim(),
      actorType: 'leader',
    };
  }
  const turnMatch = label.match(/^\[turn:(\d+)\]\s*Turn/);
  if (turnMatch) return { type: 'turn', turnNumber: parseInt(turnMatch[1], 10), actorType: 'leader' };
  if (label.startsWith('Revert to:') || label.startsWith('[session:')) return { type: 'revert' };
  if (label.startsWith('Session Start')) return { type: 'session_start', actorType: 'leader' };
  return { type: 'manual' };
}

type DiffSummaryFile = DiffResultTextFile | DiffResultBinaryFile | DiffResultNameStatusFile;
type UntrackedDiffFile = {
  file: string;
  insertions: number;
  deletions: number;
  binary: false;
  untracked: true;
};
type MergedDiffFile = DiffSummaryFile | UntrackedDiffFile;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function hasNumberProp<K extends string>(value: unknown, key: K): value is Record<K, number> {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Record<K, unknown>)[key] === 'number';
}

function hasBooleanProp<K extends string>(value: unknown, key: K): value is Record<K, boolean> {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Record<K, unknown>)[key] === 'boolean';
}

function isUntrackedDiffFile(file: MergedDiffFile): file is UntrackedDiffFile {
  return hasBooleanProp(file, 'untracked') && file.untracked;
}

function diffInsertions(file: unknown): number {
  return hasNumberProp(file, 'insertions') ? file.insertions : 0;
}

function diffDeletions(file: unknown): number {
  return hasNumberProp(file, 'deletions') ? file.deletions : 0;
}

function stripSessionPrefix(label: string): string {
  return label.replace(/^\[session:[^\]]+\]\s*/, '');
}

function isSessionStartLabel(label: string): boolean {
  return stripSessionPrefix(label).startsWith('Session Start');
}

function shouldIncludeChangePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] || normalized;

  if (
    normalized === '.git' || normalized.startsWith('.git/')
    || normalized === '.lingxiao' || normalized.startsWith('.lingxiao/')
    || normalized === 'node_modules' || normalized.includes('/node_modules/')
    || normalized === '.venv' || normalized.startsWith('.venv/') || normalized.includes('/.venv/')
    || normalized === 'venv' || normalized.startsWith('venv/') || normalized.includes('/venv/')
    || normalized === 'env' || normalized.startsWith('env/') || normalized.includes('/env/')
    || normalized === 'dist' || normalized.startsWith('dist/') || normalized.includes('/dist/')
    || normalized === 'build' || normalized.startsWith('build/') || normalized.includes('/build/')
    || segments.includes('__pycache__')
    || segments.includes('.pytest_cache')
    || segments.includes('.mypy_cache')
    || segments.includes('.ruff_cache')
    || segments.includes('.next')
  ) {
    return false;
  }

  return !/\.(?:pyc|pyo|pyd)$/i.test(basename);
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

export interface FileDiff {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff: string;
  binary: boolean;
}

export class GitService {
  private static projectLocks = new Map<string, Promise<void>>();

  private projectRoot: string;
  private historyDir: string;
  private initialized = false;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    // 每个项目独立的历史目录
    // Note: ~/.lingxiao/history may be a legacy file, so use ~/.lingxiao/checkpoints/ instead
    const projectHash = crypto.createHash('sha256')
      .update(this.projectRoot)
      .digest('hex')
      .slice(0, 12);
    this.historyDir = path.join(CONFIG_DIR, 'checkpoints', projectHash);
  }

  /**
   * 初始化 shadow git 仓库
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.withProjectGitLock(() => this.initializeUnlocked());
  }

  private async initializeUnlocked(): Promise<void> {
    if (this.initialized) return;
    try {
      // 检查 git 是否可用
      const git = simpleGit();
      const version = await git.version();
      if (!version?.installed) {
        throw new Error('Git is not installed');
      }
    } catch { /* expected: git not installed — rethrow with user-friendly message */
      throw new Error(
        'Checkpointing requires Git. Please install Git or disable checkpointing.',
      );
    }

    await this.setupShadowGitRepository();
    this.initialized = true;
  }

  private async withProjectGitLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.historyDir;
    const previous = GitService.projectLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const next = previous.catch(() => undefined).then(() => gate);
    GitService.projectLocks.set(key, next);

    await previous.catch((err) => {
      // 前序 git 操作失败不应阻断链上后续操作，但也不能彻底无声 ——
      // 连续静默失败（如仓库损坏）会让文件状态悄悄错下去。debug 记录便于定位。
      console.debug('[GitService] 前序 git 操作失败，继续执行后续链操作:', err instanceof Error ? err.message : String(err));
      return undefined;
    });
    try {
      return await operation();
    } finally {
      release();
      if (GitService.projectLocks.get(key) === next) {
        GitService.projectLocks.delete(key);
      }
    }
  }

  private async setupShadowGitRepository(): Promise<void> {
    const gitConfigPath = path.join(this.historyDir, '.gitconfig');

    // Ensure parent dirs exist; handle ENOTDIR (parent is a file)
    try {
      mkdirSync(this.historyDir, { recursive: true });
    } catch (err) {
      if (errorCode(err) === 'ENOTDIR') {
        throw new Error(`Cannot create checkpoint dir: parent path is a file. Please remove the conflicting file.`);
      }
      throw err;
    }

    // 独立的 gitconfig，不继承用户全局配置
    const gitConfigContent =
      '[user]\n  name = Lingxiao\n  email = lingxiao@local\n[commit]\n  gpgsign = false\n';
    await fs.writeFile(gitConfigPath, gitConfigContent);

    // 判断是否已是完整的 git 仓库
    // 必须同时满足：HEAD 文件存在 + refs 目录存在，才是完整的
    // 不完整的 .git 目录（只有 hooks/ 没有 HEAD）必须清理后重建
    const gitDir = path.join(this.historyDir, '.git');
    const headPath = path.join(gitDir, 'HEAD');
    const refsPath = path.join(gitDir, 'refs');
    const isCompleteRepo = existsSync(headPath) && existsSync(refsPath);

    if (!isCompleteRepo || !(await this.isShadowRepositoryHealthy(gitDir))) {
      await this.reinitializeShadowRepository(gitDir);
    }

    // Apply user and Lingxiao ignore rules to the shadow repo. The shadow
    // repository has a separate GIT_DIR, so worktree .gitignore files are not
    // reliable here; info/exclude belongs to the actual shadow repository.
    const userGitIgnorePath = path.join(this.projectRoot, '.gitignore');
    const shadowGitExcludePath = path.join(gitDir, 'info', 'exclude');

    let userGitIgnoreContent = '';
    try {
      userGitIgnoreContent = await fs.readFile(userGitIgnorePath, 'utf-8');
    } catch {
      // .gitignore may not exist
    }

    const shadowGitIgnoreContent = `${userGitIgnoreContent.trimEnd()}${SHADOW_GITIGNORE_DEFAULTS}`;
    await fs.mkdir(path.dirname(shadowGitExcludePath), { recursive: true });
    await fs.writeFile(shadowGitExcludePath, shadowGitIgnoreContent);
  }

  private async isShadowRepositoryHealthy(gitDir: string): Promise<boolean> {
    if (!existsSync(gitDir)) return false;
    try {
      await this.shadowGit.raw(['fsck', '--no-progress', '--connectivity-only']);
      return true;
    } catch { /* expected: fsck fails on corrupt repo */
      return false;
    }
  }

  private async reinitializeShadowRepository(gitDir: string): Promise<void> {
    if (existsSync(gitDir)) {
      await fs.rm(gitDir, { recursive: true, force: true });
    }
    const repo = simpleGit(this.historyDir);
    await repo.init(false, { '--initial-branch': 'main' });
    // Do NOT create an empty initial commit — the first real snapshot becomes the baseline.
  }

  /**
   * Shadow git 实例 — 使用 GIT_DIR + GIT_WORK_TREE 环境变量
   */
  private get shadowGit(): SimpleGit {
    return simpleGit(this.projectRoot).env(buildSafeGitEnv(process.env, {
      GIT_DIR: path.join(this.historyDir, '.git'),
      GIT_WORK_TREE: this.projectRoot,
      HOME: this.historyDir,
      XDG_CONFIG_HOME: this.historyDir,
    }));
  }

  /**
   * 创建文件快照
   * 只在有实际变更时才提交，避免产生无意义的空快照
   */
  async createFileSnapshot(message: string, sessionId?: string): Promise<string | null> {
    return this.withProjectGitLock(async () => {
      if (!this.initialized) await this.initializeUnlocked();

      const repo = this.shadowGit;
      await this.stageWorkspaceChanges(repo, sessionId);

      // Check if there are actual changes to commit
      const status = await repo.status();
      const hasChanges = status.created.length > 0 || status.modified.length > 0
        || status.deleted.length > 0 || status.staged.length > 0;
      if (!hasChanges) {
        return null; // No changes, skip snapshot
      }

      const commitMessage = sessionId ? `[session:${sessionId}] ${message}` : message;
      const commitResult = await repo.commit(commitMessage);
      return commitResult.commit;
    });
  }

  private async stageWorkspaceChanges(repo: SimpleGit, sessionId?: string): Promise<void> {
    await repo.add('.');

    // Project .gitignore often excludes .lingxiao/, but session scratchpad files are
    // user-visible artifacts and must remain rollback-capable in the shadow repo.
    if (!sessionId) return;
    const scratchpadRel = ['.lingxiao', 'sessions', sessionId, 'scratchpad'].join('/');
    const scratchpadAbs = path.join(this.projectRoot, '.lingxiao', 'sessions', sessionId, 'scratchpad');
    if (!existsSync(scratchpadAbs)) return;
    try {
      await repo.raw(['add', '-f', '-A', '--', scratchpadRel]);
    } catch {
      // Best effort: regular workspace files are already staged above.
    }
  }

  /**
   * 恢复指定文件到 HEAD 状态（丢弃工作区变更）
   */
  async revertFiles(filePaths: string[]): Promise<void> {
    await this.withProjectGitLock(async () => {
      if (!this.initialized) await this.initializeUnlocked();
      const repo = this.shadowGit;
      for (const filePath of filePaths) {
        try {
          await repo.raw(['restore', filePath]);
        } catch {
          // File may not exist in HEAD (new file) — try removing it
          try {
            await repo.raw(['rm', '--cached', filePath]);
            const fullPath = path.join(this.projectRoot, filePath);
            await fs.unlink(fullPath).catch(() => {});
          } catch {
            // Skip files we can't revert
          }
        }
      }
    });
  }

  /**
   * 恢复所有文件到 HEAD 状态
   */
  async revertAll(): Promise<void> {
    await this.withProjectGitLock(async () => {
      if (!this.initialized) await this.initializeUnlocked();
      const repo = this.shadowGit;
      await repo.raw(['restore', '.']);
      await repo.clean('f', ['-d']);
    });
  }

  /**
   * 获取当前 HEAD commit hash
   */
  async getCurrentCommitHash(): Promise<string> {
    if (!this.initialized) await this.initialize();
    const hash = await this.shadowGit.raw('rev-parse', 'HEAD');
    return hash.trim();
  }

  /**
   * 从快照恢复项目文件，并在 shadow git 中留下一个 revert commit 推进 HEAD
   *
   * 必须推进 HEAD，否则下次 createFileSnapshot 的 parent 还是旧 HEAD，历史乱掉。
   * 只在有实际变更时才创建 commit，避免产生空 revert commit 噪音。
   */
  async restoreProjectFromSnapshot(
    commitHash: string,
    sessionId?: string,
    label?: string,
  ): Promise<void> {
    await this.withProjectGitLock(async () => {
      if (!this.initialized) await this.initializeUnlocked();
      const repo = this.shadowGit;
      // 1. 还原文件到目标 commit 的状态
      await repo.raw(['restore', '--source', commitHash, '.']);
      // 2. 删除目标 commit 没有但现在存在的文件
      await repo.clean('f', ['-d']);
      // 3. 检查是否有实际变更，有则创建 revert commit
      if (sessionId) {
        await repo.add('.');
        const status = await repo.status();
        const hasChanges = status.created.length > 0 || status.modified.length > 0
          || status.deleted.length > 0 || status.staged.length > 0;
        if (hasChanges) {
          const revertMsg = `[session:${sessionId}] Revert to: ${label || commitHash.slice(0, 8)}`;
          await repo.commit(revertMsg);
        }
      }
    });
  }

  /**
   * 获取 checkpoint 列表（git log）
   */
  async getCheckpoints(sessionId?: string): Promise<Checkpoint[]> {
    if (!this.initialized) await this.initialize();

    try {
      const repo = this.shadowGit;
      const log = await repo.log();

      // 跳过初始空提交（如果存在）
      const allCommits = log.all.filter(c => c.message !== 'Initial commit');
      const allCommitsIndex = new Map<string, number>();
      for (let i = 0; i < allCommits.length; i++) {
        allCommitsIndex.set(allCommits[i].hash, i);
      }
      let commits = allCommits;

      // Filter by sessionId if provided
      if (sessionId) {
        const sessionPrefix = `[session:${sessionId}]`;
        commits = commits.filter(c => c.message.startsWith(sessionPrefix));
      }

      const checkpoints: Checkpoint[] = [];

      for (let i = 0; i < commits.length; i++) {
        const commit = commits[i];
        const label = sessionId ? commit.message.replace(`[session:${sessionId}] `, '') : commit.message;
        let files: string[] = [];
        let additions = 0;
        let deletions = 0;

        try {
          const linearIdx = allCommitsIndex.get(commit.hash);
          const parentHash = linearIdx !== undefined && linearIdx < allCommits.length - 1
            ? allCommits[linearIdx + 1].hash
            : null;
          const stats = await this.getCommitStats(repo, commit.hash, parentHash, label);
          files = stats.files;
          additions = stats.additions;
          deletions = stats.deletions;
        } catch {
          // Skip if we can't get diff
        }

        const meta = parseCheckpointMeta(label);
        checkpoints.push({
          id: commit.hash,
          label,
          createdAt: commit.date,
          timestamp: new Date(commit.date).getTime() / 1000,
          files,
          additions,
          deletions,
          type: meta.type,
          turnNumber: meta.turnNumber,
          toolName: meta.toolName,
          actorType: meta.actorType,
          agentName: meta.agentName,
          taskId: meta.taskId,
        });
      }

      return checkpoints;
    } catch { /* expected: shadow repo may not have commits yet */
      return [];
    }
  }

  /**
   * 获取指定路径的 diff
   */
  async getFileDiff(filePath: string, commitHash?: string): Promise<FileDiff | null> {
    if (!this.initialized) await this.initialize();

    try {
      const repo = this.shadowGit;

      if (commitHash) {
        const diffBase = await this.getCommitDiffBase(repo, commitHash);
        const diffResult = await repo.diff([diffBase, commitHash, '--', filePath]);
        const diffSummary = await repo.diffSummary([diffBase, commitHash, '--', filePath]);

        if (diffSummary.files.length === 0) return null;

        const f = diffSummary.files[0];
        return {
          path: filePath,
          changeType: this.detectChangeType(f),
          additions: diffInsertions(f),
          deletions: diffDeletions(f),
          diff: diffResult,
          binary: f.binary ?? false,
        };
      } else {
        // Diff between HEAD and working tree
        const diffResult = await repo.diff(['--', filePath]);
        const diffSummary = await repo.diffSummary(['--', filePath]);

        if (diffSummary.files.length === 0) {
          return this.getUntrackedFileDiff(repo, filePath);
        }

        const f = diffSummary.files[0];
        return {
          path: filePath,
          changeType: this.detectChangeType(f),
          additions: diffInsertions(f),
          deletions: diffDeletions(f),
          diff: diffResult,
          binary: f.binary ?? false,
        };
      }
    } catch { /* expected: file may not exist in shadow repo */
      return null;
    }
  }

  /**
   * 获取当前工作区与 HEAD 之间的所有变更
   */
  async getWorkingChanges(): Promise<FileDiff[]> {
    if (!this.initialized) await this.initialize();

    try {
      const repo = this.shadowGit;
      const diffSummary = await repo.diffSummary();
      const diffs: FileDiff[] = [];
      const seen = new Set<string>();

      for (const f of diffSummary.files) {
        if (!shouldIncludeChangePath(f.file)) continue;
        const diffResult = await repo.diff(['--', f.file]);
        seen.add(f.file);
        diffs.push({
          path: f.file,
          changeType: this.detectChangeType(f),
          additions: diffInsertions(f),
          deletions: diffDeletions(f),
          diff: diffResult,
          binary: f.binary ?? false,
        });
      }

      const status = await repo.status(['--untracked-files=all']);
      for (const filePath of status.created) {
        if (!shouldIncludeChangePath(filePath)) continue;
        if (seen.has(filePath)) continue;
        const staged = await this.getStagedAddedFileDiff(repo, filePath);
        if (staged) {
          seen.add(filePath);
          diffs.push(staged);
        }
      }
      for (const filePath of status.not_added) {
        if (!shouldIncludeChangePath(filePath)) continue;
        if (seen.has(filePath)) continue;
        const untracked = await this.getUntrackedFileDiff(repo, filePath);
        if (untracked) {
          seen.add(filePath);
          diffs.push(untracked);
        }
      }

      return diffs;
    } catch { /* expected: shadow repo not ready or empty */
      return [];
    }
  }

  /**
   * 获取指定时间戳之后的所有变更（按会话过滤）
   * 计算该时间点之后的检查点 commit 的累积 diff
   */
  async getSessionChanges(sinceTimestamp: number, sessionId?: string): Promise<FileDiff[]> {
    if (!this.initialized) await this.initialize();

    try {
      const repo = this.shadowGit;
      const log = await repo.log();
      const commits = log.all.filter(c => c.message !== 'Initial commit');

      const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;
      const ONE_DAY_SECONDS = 24 * 3600;

      // Strategy 1: If sessionId provided, find the parent of the oldest commit in this session.
      // This is the most reliable baseline — immune to clock-skew between session.created_at and
      // the actual "Session Start" commit timestamp.
      let baselineHash: string | null = null;
      if (sessionId) {
        const sessionPrefix = `[session:${sessionId}]`;
        const sessionCommits = commits.filter(c => c.message.startsWith(sessionPrefix));
        if (sessionCommits.length > 0) {
          // sessionCommits is newest→oldest; oldest is last
          const oldestSessionCommit = sessionCommits[sessionCommits.length - 1];
          if (isSessionStartLabel(oldestSessionCommit.message)) {
            // Session Start is the workspace baseline for this session. Diffing against
            // its parent includes unrelated pre-session files and can trigger the
            // large-diff fallback, hiding the real session changes.
            baselineHash = oldestSessionCommit.hash;
          } else {
            const oldestIdx = commits.findIndex(c => c.hash === oldestSessionCommit.hash);
            if (oldestIdx >= 0 && oldestIdx < commits.length - 1) {
              // Parent is the commit just before (higher index = older in log.all)
              baselineHash = commits[oldestIdx + 1].hash;
            }
          }
          // If oldestIdx === commits.length - 1, this session's first commit is the very first
          // commit in the repo — no parent, so baseline stays null and we'll use --root below
        }
      }

      // Strategy 2: Fallback to timestamp-based search (when sessionId not provided)
      if (!sessionId && baselineHash === null) {
        for (let i = commits.length - 1; i >= 0; i--) {
          const commitTime = new Date(commits[i].date).getTime() / 1000;
          if (commitTime <= sinceTimestamp) {
            if (sinceTimestamp - commitTime > SEVEN_DAYS_SECONDS) {
              baselineHash = null;
              break;
            }
            baselineHash = commits[i].hash;
            break;
          }
        }
      }

      // Additional safety: if no commit within 24 hours before sinceTimestamp, skip commit diff
      if (!sessionId && !baselineHash) {
        const hasRecentCommit = commits.some(c => {
          const t = new Date(c.date).getTime() / 1000;
          return t <= sinceTimestamp && sinceTimestamp - t <= ONE_DAY_SECONDS;
        });
        if (!hasRecentCommit) {
          return this.getWorkingChanges();
        }
      }

      // If no baseline, all commits are from this session
      // Get diff from baseline to HEAD (or full diff if no baseline)
      let diffArgs: string[];
      if (baselineHash) {
        diffArgs = [baselineHash, 'HEAD'];
      } else if (commits.length > 0) {
        // All commits are within session — diff first commit vs HEAD
        const firstHash = commits[commits.length - 1].hash;
        // We need to include the first commit itself, so diff against its parent
        // But if it has no parent, use --root
        try {
          await repo.raw(['rev-parse', `${firstHash}^`]);
          diffArgs = [`${firstHash}^`, 'HEAD'];
        } catch { /* expected: first commit has no parent */
          diffArgs = [EMPTY_TREE_HASH, 'HEAD'];
        }
      } else {
        // No commits — just show working changes
        return this.getWorkingChanges();
      }

      // Also include uncommitted changes
      const diffSummary = await repo.diffSummary(diffArgs);
      const visibleDiffFiles = diffSummary.files.filter(f => shouldIncludeChangePath(f.file));

      // Safety check: if the baseline is wrong, the diff will be enormous (+100k/-100k)
      // Fall back to working changes if the diff looks unreasonably large
      const totalAdditions = visibleDiffFiles.reduce((sum, f) => sum + diffInsertions(f), 0);
      const totalDeletions = visibleDiffFiles.reduce((sum, f) => sum + diffDeletions(f), 0);
      if (totalAdditions + totalDeletions > 50000) {
        return this.getWorkingChanges();
      }

      const workingDiffSummary = await repo.diffSummary();
      // Merge: session changes + uncommitted working changes
      const allFiles = new Map<string, MergedDiffFile>();
      for (const f of visibleDiffFiles) {
        allFiles.set(f.file, f);
      }
      for (const f of workingDiffSummary.files) {
        if (!shouldIncludeChangePath(f.file)) continue;
        // Working changes may include additional unstaged files
        if (!allFiles.has(f.file)) {
          allFiles.set(f.file, f);
        }
      }
      const status = await repo.status(['--untracked-files=all']);
      for (const filePath of status.not_added) {
        if (!shouldIncludeChangePath(filePath)) continue;
        if (!allFiles.has(filePath)) {
          allFiles.set(filePath, {
            file: filePath,
            insertions: 0,
            deletions: 0,
            binary: false,
            untracked: true,
          });
        }
      }

      const diffs: FileDiff[] = [];
      for (const [filePath, f] of allFiles) {
        try {
          // Get combined diff for this file
          let diffResult: string;
          try {
            diffResult = await repo.diff([...diffArgs, '--', filePath]);
          } catch { /* expected: range diff may fail for new files — fallback to working diff */
            diffResult = await repo.diff(['--', filePath]);
          }
          if (!diffResult) {
            diffResult = await repo.diff(['--', filePath]);
          }
          if (!diffResult && isUntrackedDiffFile(f)) {
            const untracked = await this.getUntrackedFileDiff(repo, filePath);
            if (untracked) {
              diffs.push(untracked);
              continue;
            }
          }
          diffs.push({
            path: filePath,
            changeType: this.detectChangeType(f),
            additions: diffInsertions(f),
            deletions: diffDeletions(f),
            diff: diffResult || '',
            binary: f.binary ?? false,
          });
        } catch {
          // Skip files we can't diff
        }
      }

      return diffs;
    } catch {
      // Fallback to working changes
      return this.getWorkingChanges();
    }
  }

  /**
   * 获取所有变更文件列表（working tree + staged）
   */
  async getChangedFiles(): Promise<string[]> {
    if (!this.initialized) await this.initialize();

    try {
      const repo = this.shadowGit;
      const status = await repo.status();
      return [
        ...status.created,
        ...status.deleted,
        ...status.modified,
        ...status.not_added,
        ...status.renamed.map(r => r.to),
      ].filter(shouldIncludeChangePath);
    } catch { /* expected: shadow repo not initialized */
      return [];
    }
  }

  /**
   * 获取所有 checkpoint 并按 session 分组
   * 返回 Map<sessionId, Checkpoint[]>，sessionId='__untagged__' 表示无 session 标记的 commit
   */
  async getAllCheckpointsGrouped(): Promise<Map<string, Checkpoint[]>> {
    if (!this.initialized) await this.initialize();

    try {
      const repo = this.shadowGit;
      const log = await repo.log();
      const allCommits = log.all.filter(c => c.message !== 'Initial commit');

      // Group commits by sessionId
      const groups = new Map<string, typeof allCommits>();
      for (const commit of allCommits) {
        const match = commit.message.match(/^\[session:([^\]]+)\]/);
        const sid = match ? match[1] : '__untagged__';
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid)!.push(commit);
      }

      // 先把所有 commit 按线性顺序建立 index，用于快速查找直接 parent
      // allCommits 是 newest→oldest，所以 allCommits[i+1] 是 allCommits[i] 的 parent
      const allCommitsIndex = new Map<string, number>();
      for (let i = 0; i < allCommits.length; i++) {
        allCommitsIndex.set(allCommits[i].hash, i);
      }

      // Build Checkpoint[] for each group
      // 关键：每个 commit 的 diff 永远对比它在线性历史中的直接 parent（不是同组内的邻居）
      // 这样才能保证 diff 只反映这一次工具调用改动的文件，不会夹带其他 session 的变更
      const result = new Map<string, Checkpoint[]>();
      for (const [sid, commits] of groups) {
        const checkpoints: Checkpoint[] = [];
        for (let i = 0; i < commits.length; i++) {
          const commit = commits[i];
          let files: string[] = [];
          let additions = 0;
          let deletions = 0;
          const label = sid !== '__untagged__'
            ? commit.message.replace(`[session:${sid}] `, '')
            : commit.message;

          try {
            const linearIdx = allCommitsIndex.get(commit.hash);
            const parentHash = linearIdx !== undefined && linearIdx < allCommits.length - 1
              ? allCommits[linearIdx + 1].hash
              : null;
            const stats = await this.getCommitStats(repo, commit.hash, parentHash, label);
            files = stats.files;
            additions = stats.additions;
            deletions = stats.deletions;
          } catch {
            // Skip if diff fails
          }

          const meta = parseCheckpointMeta(label);
          checkpoints.push({
            id: commit.hash,
            label,
            createdAt: commit.date,
            timestamp: new Date(commit.date).getTime() / 1000,
            files,
            additions,
            deletions,
            type: meta.type,
            turnNumber: meta.turnNumber,
            toolName: meta.toolName,
            actorType: meta.actorType,
            agentName: meta.agentName,
            taskId: meta.taskId,
          });
        }
        result.set(sid, checkpoints);
      }

      return result;
    } catch { /* expected: git log may fail on empty repo */
      return new Map();
    }
  }

  private detectChangeType(file: MergedDiffFile): FileDiff['changeType'] {
    if ('from' in file && file.from && file.from !== file.file) return 'renamed';
    const insertions = diffInsertions(file);
    const deletions = diffDeletions(file);
    if (insertions > 0 && deletions === 0) return 'added';
    if (insertions === 0 && deletions > 0) return 'deleted';
    return 'modified';
  }

  private async getCommitStats(
    repo: SimpleGit,
    commitHash: string,
    parentHash: string | null,
    label: string,
  ): Promise<{ files: string[]; additions: number; deletions: number }> {
    if (isSessionStartLabel(label)) {
      return { files: [], additions: 0, deletions: 0 };
    }
    const diffBase = parentHash || EMPTY_TREE_HASH;
    const diffSummary = await repo.diffSummary([diffBase, commitHash]);
    const files = diffSummary.files.filter(f => shouldIncludeChangePath(f.file));
    return {
      files: files.map(f => f.file),
      additions: files.reduce((sum, f) => sum + diffInsertions(f), 0),
      deletions: files.reduce((sum, f) => sum + diffDeletions(f), 0),
    };
  }

  private async getCommitDiffBase(repo: SimpleGit, commitHash: string): Promise<string> {
    try {
      const line = (await repo.raw(['rev-list', '--parents', '-n', '1', commitHash])).trim();
      const [, parent] = line.split(/\s+/);
      return parent || EMPTY_TREE_HASH;
    } catch { /* expected: orphan commit has no parent */
      return EMPTY_TREE_HASH;
    }
  }

  private async getUntrackedFileDiff(repo: SimpleGit, filePath: string): Promise<FileDiff | null> {
    if (!shouldIncludeChangePath(filePath)) return null;
    try {
      const diff = await repo.diff(['--no-index', '--', '/dev/null', filePath]);
      const stats = diffLineStats(diff);
      return {
        path: filePath,
        changeType: 'added',
        additions: stats.additions,
        deletions: stats.deletions,
        diff,
        binary: false,
      };
    } catch { /* expected: untracked file may be deleted between check and read */
      return null;
    }
  }

  private async getStagedAddedFileDiff(repo: SimpleGit, filePath: string): Promise<FileDiff | null> {
    if (!shouldIncludeChangePath(filePath)) return null;
    try {
      const diff = await repo.diff(['--cached', '--', filePath]);
      if (!diff) return null;
      const stats = diffLineStats(diff);
      return {
        path: filePath,
        changeType: 'added',
        additions: stats.additions,
        deletions: stats.deletions,
        diff,
        binary: false,
      };
    } catch { /* expected: staged file diff may fail if index is stale */
      return null;
    }
  }
}
