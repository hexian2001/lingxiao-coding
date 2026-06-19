/**
 * ModeWorktreeService — 模式级 git worktree 执行卫生。
 *
 * 不是安全边界（契约 docs/contracts/modes.md:186 明确「模式不是安全边界」；
 * 安全仍由 PermissionSystem + Sandbox 正交保证）。这是**工程卫生**：
 *   - bughunt 扫描（tsc/npm audit/semgrep）与 workflow 执行默认在独立 git worktree
 *     里跑，产生的临时产物 / node_modules 变更 / 编译缓存不会污染主工作树；
 *   - 模式关闭时通过 CleanupRegistry 确定性回收（git worktree remove），不留残骸。
 *
 * 机制（确定性，复用 git CLI，不引入新依赖）：
 *   - worktree 根：workspace 下 .lingxiao/mode-worktrees/<mode>/
 *   - 新建：`git worktree add --detach <path> HEAD`（不创建分支，HEAD 快照，避免动到主分支）
 *   - 复用：若该路径已是合法 worktree，直接返回（幂等）
 *   - 回收：`git worktree remove --force <path>`（模式关闭 / 进程退出时）
 *
 * 仅在 git 仓库内启用；非 git 仓库（裸目录）直接退回 workspace 原路径，绝不抛错。
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { coreLogger } from './Log.js';
import { registerCleanup } from './CleanupRegistry.js';
import type { ModeId } from '../contracts/modes.js';

/** worktree 注册表：mode → 已分配路径。用于回收与幂等复用。 */
const assignedWorktrees = new Map<string, string>();
/** 已注册的全局退出回收 token（只注册一次）。 */
let globalCleanupRegistered = false;

/** git 子进程封装：失败返回 null（绝不抛错中断业务），调用方按需 fallback。 */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** workspace 是否在一个 git 仓库内。 */
function isGitRepo(workspace: string): boolean {
  return git(['rev-parse', '--git-dir'], workspace) !== null;
}

/**
 * 为某模式在该 session 的 workspace 下确保一个独立 worktree。
 *
 * @returns 该模式应使用的执行目录（worktree 路径）；若不可用（非 git / 创建失败）
 *          返回 null，调用方回退到原 workspace。
 */
export function ensureModeWorktree(mode: ModeId, workspace: string): string | null {
  if (!workspace) return null;
  if (!isGitRepo(workspace)) return null;

  const worktreePath = resolve(workspace, '.lingxiao', 'mode-worktrees', mode);

  // 幂等：已分配且仍存在 → 直接复用。
  if (assignedWorktrees.has(mode)) {
    const existing = assignedWorktrees.get(mode)!;
    if (existsSync(existing)) return existing;
    assignedWorktrees.delete(mode);
  }

  // 幂等：路径已存在但未登记（上次进程残留）——若已是 worktree 则登记复用，否则跳过。
  if (existsSync(worktreePath)) {
    const list = git(['worktree', 'list', '--porcelain'], workspace) ?? '';
    if (list.includes(`worktree ${worktreePath}`)) {
      assignedWorktrees.set(mode, worktreePath);
      registerGlobalCleanupOnce();
      return worktreePath;
    }
    // 路径被占用但不是 worktree——不强行删，退回原 workspace（确定性：不动用户已有文件）。
    return null;
  }

  // 新建：--detach 挂在 HEAD 快照，不创建/不切分支，避免污染主分支状态。
  const ok = git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], workspace);
  if (ok === null) {
    coreLogger.warn(`[ModeWorktree] 未能为模式 ${mode} 创建 worktree，回退到主工作树`);
    return null;
  }
  assignedWorktrees.set(mode, worktreePath);
  registerGlobalCleanupOnce();
  coreLogger.info(`[ModeWorktree] 已为模式 ${mode} 启用执行 worktree: ${worktreePath}`);
  return worktreePath;
}

/**
 * 显式回收某模式的 worktree（模式关闭时调用）。
 * 失败静默——回收失败不阻塞模式关闭。
 */
export function releaseModeWorktree(mode: ModeId, workspace: string): void {
  const worktreePath = assignedWorktrees.get(mode);
  if (!worktreePath) return;
  git(['worktree', 'remove', '--force', worktreePath], workspace);
  assignedWorktrees.delete(mode);
}

/** 注册一次「进程退出时回收所有已登记 worktree」的全局清理。 */
function registerGlobalCleanupOnce(): void {
  if (globalCleanupRegistered) return;
  globalCleanupRegistered = true;
  registerCleanup(() => {
    for (const [mode, path] of assignedWorktrees) {
      try {
        // 退出时无 workspace 上下文，用 worktree 自身边界做 prune（git 支持）。
        git(['worktree', 'remove', '--force', path], path);
      } catch {
        // 退出路径静默。
      }
    }
    assignedWorktrees.clear();
  }, 120); // 晚于业务资源清理，早于最终退出。
}
