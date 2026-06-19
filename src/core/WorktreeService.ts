import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG_DIR } from '../config.js';
import type { WorktreeRecord, WorktreeStatus } from './Database.js';
import type { WorktreeRepository } from './DatabaseRepositories.js';
import { isWorktreeTerminalStatus, normalizeWorktreeStatus } from './StateSemantics.js';

export interface WorktreeLiveStatus {
  modified: string[];
  untracked: string[];
  staged: string[];
  conflicted: string[];
  total: number;
  clean: boolean;
  currentBranch: string;
}

export interface WorktreeView extends WorktreeRecord {
  live?: WorktreeLiveStatus;
  exists: boolean;
}

export interface GitWorktreeEntry {
  path: string;
  branch: string;
  locked: boolean;
}

export interface CreateWorktreeInput {
  repoRoot: string;
  name?: string;
  branch?: string;
  baseBranch?: string;
  sessionId?: string;
  taskId?: string;
}

const DEFAULT_WORKTREE_ROOT = join(CONFIG_DIR, 'worktrees');

function getDefaultWorktreeRoot(): string {
  return process.env.LINGXIAO_WORKTREE_ROOT || DEFAULT_WORKTREE_ROOT;
}

export class WorktreeError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'WorktreeError';
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'repo';
}

function validateName(value: string, label: string): void {
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/')) {
    throw new WorktreeError(`${label} contains invalid characters`, 400);
  }
}

function validateWorktreeName(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value) || value.includes('..')) {
    throw new WorktreeError('worktree name contains invalid characters', 400);
  }
}

function validateBranch(value: string, label: string): void {
  validateName(value, label);
  if (value.includes('//') || value.endsWith('.lock') || value.startsWith('-')) {
    throw new WorktreeError(`${label} is not a valid branch name`, 400);
  }
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error((stderr || stdout || `git ${args.join(' ')} exited ${code}`).trim()));
      }
    });
  });
}

function parseStatus(text: string, branch: string): WorktreeLiveStatus {
  const modified: string[] = [];
  const untracked: string[] = [];
  const staged: string[] = [];
  const conflicted: string[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const index = line[0] || ' ';
    const working = line[1] || ' ';
    const file = line.slice(3);
    if (line.startsWith('??')) {
      untracked.push(file);
      continue;
    }
    if (index === 'U' || working === 'U' || (index === 'A' && working === 'A') || (index === 'D' && working === 'D')) {
      conflicted.push(file);
      continue;
    }
    if (index !== ' ') staged.push(file);
    if (working !== ' ') modified.push(file);
  }
  const total = modified.length + untracked.length + staged.length + conflicted.length;
  return { modified, untracked, staged, conflicted, total, clean: total === 0, currentBranch: branch };
}

export class WorktreeService {
  constructor(
    private readonly db: WorktreeRepository,
    private readonly worktreeRoot = getDefaultWorktreeRoot(),
  ) {}

  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--git-dir'], cwd);
      return true;
    } catch {/* expected: operation may fail */
      return false;
    }
  }

  async repoRoot(cwd: string): Promise<string> {
    const result = await runGit(['rev-parse', '--show-toplevel'], cwd);
    return resolve(result.stdout);
  }

  async currentBranch(cwd: string): Promise<string> {
    try {
      return (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout || 'HEAD';
    } catch {/* expected: fallback to default */
      return 'HEAD';
    }
  }

  async status(path: string): Promise<WorktreeLiveStatus> {
    const [branch, status] = await Promise.all([
      this.currentBranch(path),
      runGit(['status', '--porcelain'], path),
    ]);
    return parseStatus(status.stdout, branch);
  }

  async listGit(repoRoot: string): Promise<GitWorktreeEntry[]> {
    const root = await this.repoRoot(repoRoot);
    const result = await runGit(['worktree', 'list', '--porcelain'], root);
    const entries: GitWorktreeEntry[] = [];
    const blocks = result.stdout.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      const lines = block.split('\n');
      const pathLine = lines.find((line) => line.startsWith('worktree '));
      if (!pathLine) continue;
      const branchLine = lines.find((line) => line.startsWith('branch '));
      entries.push({
        path: pathLine.replace('worktree ', ''),
        branch: branchLine ? branchLine.replace('branch refs/heads/', '') : 'HEAD',
        locked: lines.some((line) => line.startsWith('locked')),
      });
    }
    return entries;
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeView> {
    const root = await this.repoRoot(input.repoRoot);
    const baseBranch = input.baseBranch || await this.currentBranch(root);
    const name = input.name?.trim() || `lx-${Date.now()}`;
    validateWorktreeName(name);
    validateBranch(baseBranch, 'base branch');
    const branch = input.branch?.trim() || `worktree/${name}`;
    validateBranch(branch, 'worktree branch');

    const repoDir = slug(`${basename(root)}-${Buffer.from(root).toString('base64url').slice(0, 12)}`);
    const baseDir = join(this.worktreeRoot, repoDir);
    const worktreePath = join(baseDir, name);
    if (existsSync(worktreePath)) {
      throw new WorktreeError(`Worktree path already exists: ${worktreePath}`, 409);
    }

    await mkdir(baseDir, { recursive: true });
    const id = randomUUID();
    const now = Date.now() / 1000;
    try {
      await runGit(['worktree', 'add', '-b', branch, worktreePath, baseBranch], root);
      const record: WorktreeRecord = {
        id,
        name,
        repo_root: root,
        path: worktreePath,
        branch,
        base_branch: baseBranch,
        session_id: input.sessionId,
        task_id: input.taskId,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      this.db.upsert(record);
      return this.view(record);
    } catch (error) {
      // C12: 回滚半成品状态——git worktree add 失败后,worktree 目录/分支/git 元数据可能已部分创建。
      // 不回滚则留下孤儿目录 + 残留分支 + 失效的 git worktree 注册,跨多次失败堆积。
      // 注意 baseDir 为同一 repo 多 worktree 共享,只清 worktreePath 本身,不碰 baseDir。
      await runGit(['worktree', 'remove', '--force', worktreePath], root).catch(() => undefined);
      await runGit(['worktree', 'prune'], root).catch(() => undefined);
      if (branch !== baseBranch) {
        await runGit(['branch', '-D', branch], root).catch(() => undefined);
      }
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      const record: WorktreeRecord = {
        id,
        name,
        repo_root: root,
        path: worktreePath,
        branch,
        base_branch: baseBranch,
        session_id: input.sessionId,
        task_id: input.taskId,
        status: 'failed',
        created_at: now,
        updated_at: now,
        last_error: error instanceof Error ? error.message : String(error),
      };
      this.db.upsert(record);
      throw error;
    }
  }

  async list(filters?: { repoRoot?: string; sessionId?: string; taskId?: string; includeRemoved?: boolean }): Promise<WorktreeView[]> {
    const repoRoot = filters?.repoRoot ? await this.repoRoot(filters.repoRoot).catch(() => filters.repoRoot) : undefined;
    const records = this.db.list({ ...filters, repoRoot });
    return Promise.all(records.map((record) => this.view(record)));
  }

  async findByPath(path: string): Promise<WorktreeView | null> {
    const record = this.db.getByPath(resolve(path));
    return record ? this.view(record) : null;
  }

  async get(id: string): Promise<WorktreeView | null> {
    const record = this.db.get(id);
    return record ? this.view(record) : null;
  }

  async attachSession(id: string, sessionId: string | null): Promise<WorktreeView> {
    const record = this.requireRecord(id);
    this.db.attachSession(id, sessionId);
    return this.view({ ...record, session_id: sessionId || undefined, updated_at: Date.now() / 1000 });
  }

  async remove(id: string, options?: { keepBranch?: boolean }): Promise<{ removed: true; branchDeleted: boolean }> {
    const record = this.requireRecord(id);
    const branch = record.branch;
    const exists = existsSync(record.path);
    if (exists) {
      try {
        await runGit(['worktree', 'remove', '--force', record.path], record.repo_root);
      } catch {/* swallowed: unhandled error */
        await runGit(['worktree', 'prune'], record.repo_root).catch(() => undefined);
        await rm(record.path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    let branchDeleted = false;
    if (!options?.keepBranch && branch && branch !== 'HEAD') {
      await runGit(['branch', '-D', branch], record.repo_root).then(() => { branchDeleted = true; }).catch(() => undefined);
    }
    this.db.updateStatus(id, normalizeWorktreeStatus('removed'), null);
    return { removed: true, branchDeleted };
  }

  async merge(id: string, options?: { ffOnly?: boolean; deleteAfterMerge?: boolean }): Promise<{ merged: true; output: string; removed?: boolean }> {
    const record = this.requireRecord(id);
    const recordStatus = normalizeWorktreeStatus(record.status);
    if (recordStatus === 'removed') {
      throw new WorktreeError(`Worktree ${id} has already been removed.`, 409);
    }
    if (recordStatus === 'merged') {
      throw new WorktreeError(`Worktree ${id} has already been merged.`, 409);
    }
    if (recordStatus === 'failed') {
      throw new WorktreeError(`Worktree ${id} is failed and cannot be merged.`, 409);
    }
    if (!existsSync(record.path)) {
      this.db.updateStatus(id, normalizeWorktreeStatus('failed'), 'Worktree path is missing');
      throw new WorktreeError(`Worktree path is missing: ${record.path}`, 409);
    }
    const worktreeStatus = await this.status(record.path);
    if (worktreeStatus.currentBranch !== record.branch) {
      throw new WorktreeError(`Worktree is on "${worktreeStatus.currentBranch}". Expected branch "${record.branch}".`, 409);
    }
    if (!worktreeStatus.clean) {
      this.db.updateStatus(id, normalizeWorktreeStatus('dirty'), null);
      throw new WorktreeError('Worktree has uncommitted changes. Commit or discard them before merging.', 409);
    }
    const rootBranch = await this.currentBranch(record.repo_root);
    if (rootBranch !== record.base_branch) {
      throw new WorktreeError(`Main repo is on "${rootBranch}". Switch to base branch "${record.base_branch}" before merging.`, 409);
    }
    const rootStatus = await this.status(record.repo_root);
    if (!rootStatus.clean) {
      throw new WorktreeError('Main repo has uncommitted changes. Commit/stash them before merging a worktree.', 409);
    }
    const args = ['merge', options?.ffOnly === false ? '--no-ff' : '--ff-only', record.branch];
    const output = await runGit(args, record.repo_root);
    this.db.updateStatus(id, normalizeWorktreeStatus('merged'), null);
    let removed = false;
    if (options?.deleteAfterMerge) {
      await this.remove(id, { keepBranch: false });
      removed = true;
    }
    return { merged: true, output: [output.stdout, output.stderr].filter(Boolean).join('\n'), removed };
  }

  async prune(repoRoot: string): Promise<{ success: true }> {
    const root = await this.repoRoot(repoRoot);
    await runGit(['worktree', 'prune'], root);
    return { success: true };
  }

  private requireRecord(id: string): WorktreeRecord {
    const record = this.db.get(id);
    if (!record) throw new WorktreeError(`Worktree not found: ${id}`, 404);
    return record;
  }

  private async view(record: WorktreeRecord): Promise<WorktreeView> {
    const exists = existsSync(record.path);
    let live: WorktreeLiveStatus | undefined;
    let status: WorktreeStatus = record.status;
    const terminal = isWorktreeTerminalStatus(record.status);
    const normalizedStatus = normalizeWorktreeStatus(record.status);
    if (exists && normalizedStatus !== 'removed' && normalizedStatus !== 'failed') {
      try {
        live = await this.status(record.path);
        if (!terminal) {
          status = live.clean ? 'active' : 'dirty';
          if (status !== record.status) {
            this.db.updateStatus(record.id, normalizeWorktreeStatus(status), null);
          }
        }
      } catch (error) {
        if (!terminal) {
          this.db.updateStatus(record.id, normalizeWorktreeStatus('failed'), error instanceof Error ? error.message : String(error));
          status = 'failed';
        }
      }
    }
    return { ...record, status, exists, live };
  }
}
