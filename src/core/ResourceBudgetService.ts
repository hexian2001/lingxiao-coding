/**
 * 资源预算服务 — 24×7 模式磁盘/数据生命周期管理
 *
 * 定期扫描工作区下的各类产物目录。默认不删除会话产物和 Agent 日志，避免破坏
 * Leader/Agent 原始历史与审计记录；仅对终端记录、scratchpad 等可再生临时数据执行预算清理。
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { coreLogger } from './Log.js';
import { RESOURCE_BUDGET } from '../config/defaults.js';

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

/** 预算类别标识 */
export type BudgetCategory =
  | 'session_artifacts'
  | 'agent_logs'
  | 'terminal_transcripts'
  | 'sqlite_wal'
  | 'scratchpad_files';

/** 单类别磁盘用量报告 */
export interface CategoryReport {
  category: BudgetCategory;
  currentBytes: number;
  maxBytes: number;
  fileCount: number;
  overBudget: boolean;
}

/** 一次性清理报告 */
export interface CleanupReport {
  categories: CategoryReport[];
  deletedCount: number;
  freedBytes: number;
  walCheckpointTriggered: boolean;
}

/** 服务依赖 — 便于测试时注入 mock */
export interface ResourceBudgetDeps {
  /** 返回活跃会话 ID 列表，这些会话的产物不会被清理 */
  getActiveSessionIds?: () => string[];
  /** 触发 WAL checkpoint；省略则跳过 */
  walCheckpoint?: () => void;
  /** 实际 SQLite DB 文件路径（用于 WAL 大小监控）。省略时 fallback 到 workspace/.lingxiao/lingxiao.db-wal（兼容旧行为）。 */
  dbPath?: string;
  /** 修剪高写入量 DB 审计/日志表的老记录(返回删除行数);省略则跳过。#2 */
  pruneDatabaseRecords?: (maxAgeHours: number) => number;
  /** 覆盖默认时钟 */
  now?: () => number;
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/** 递归计算目录/文件大小（字节） */
export function dirSizeBytes(targetPath: string): number {
  if (!existsSync(targetPath)) return 0;
  const st = statSync(targetPath);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const full = join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try { total += statSync(full).size; } catch { /* 文件可能已删除 */ }
    }
  }
  return total;
}

/** 按 mtime 升序列出目录下所有文件（递归） */
interface FileEntry { path: string; mtimeMs: number; size: number }

function listFilesSorted(targetPath: string): FileEntry[] {
  if (!existsSync(targetPath)) return [];
  const results: FileEntry[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(full);
        results.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* 忽略 */ }
    }
  };
  walk(targetPath);
  results.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧在前
  return results;
}

const MB = 1024 * 1024;

// ═══════════════════════════════════════════════════════════════
// 服务实现
// ═══════════════════════════════════════════════════════════════

export class ResourceBudgetService {
  private readonly workspace: string;
  private readonly deps: ResourceBudgetDeps;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(workspace: string, deps: ResourceBudgetDeps = {}) {
    this.workspace = workspace;
    this.deps = deps;
  }

  /** 计算实际 WAL 文件路径：优先从 deps.dbPath 推导，fallback 到旧的 workspace/.lingxiao/lingxiao.db-wal。 */
  private getWalPath(): string {
    if (this.deps.dbPath) {
      return this.deps.dbPath + '-wal';
    }
    return join(this.workspace, '.lingxiao', 'lingxiao.db-wal');
  }

  /** 启动后台清理循环 */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      try { this.enforceNow(); } catch (err) {
        coreLogger.error('[ResourceBudget] 清理循环异常：%s', String(err));
      }
    }, RESOURCE_BUDGET.CLEANUP_INTERVAL_MS);
    // 不阻塞退出
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /** 停止后台清理循环 */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 立即执行一轮清理 */
  enforceNow(): CleanupReport {
    const categories: CategoryReport[] = [];
    let deletedCount = 0;
    let freedBytes = 0;
    let walCheckpointTriggered = false;

    // ── 会话产物：只统计，不默认删除，保证原始会话/Agent 续跑材料可追溯 ──
    const sessDir = join(this.workspace, '.lingxiao', 'sessions');
    const sessReport = this.getCategoryReport(
      sessDir,
      'session_artifacts',
      RESOURCE_BUDGET.SESSION_ARTIFACTS_MAX_MB * MB,
    );
    categories.push(sessReport);

    // ── Agent 日志：只统计，不默认删除，保证运行审计记录完整 ──
    const logDir = join(this.workspace, '.lingxiao', 'logs');
    const logReport = this.getCategoryReport(
      logDir,
      'agent_logs',
      RESOURCE_BUDGET.AGENT_LOGS_MAX_MB * MB,
    );
    categories.push(logReport);

    // ── 终端记录 ──
    const termDir = join(this.workspace, '.lingxiao', 'terminal');
    const termReport = this.enforceCategory(
      termDir,
      'terminal_transcripts',
      RESOURCE_BUDGET.TERMINAL_TRANSCRIPTS_MAX_MB * MB,
    );
    categories.push(termReport);

    // ── 草稿文件 ──
    const scratchDir = join(this.workspace, '.lingxiao', 'scratchpad');
    const scratchReport = this.enforceCategory(
      scratchDir,
      'scratchpad_files',
      RESOURCE_BUDGET.SCRATCHPAD_MAX_MB * MB,
    );
    categories.push(scratchReport);

    // ── SQLite WAL ──
    const walPath = this.getWalPath();
    const walReport: CategoryReport = {
      category: 'sqlite_wal',
      currentBytes: 0,
      maxBytes: RESOURCE_BUDGET.SQLITE_WAL_CHECKPOINT_MB * MB,
      fileCount: 0,
      overBudget: false,
    };
    if (existsSync(walPath)) {
      try {
        const walSize = statSync(walPath).size;
        walReport.currentBytes = walSize;
        walReport.fileCount = 1;
        if (walSize > walReport.maxBytes) {
          walReport.overBudget = true;
          try {
            this.deps.walCheckpoint?.();
            walCheckpointTriggered = true;
            coreLogger.info('[ResourceBudget] WAL checkpoint 触发（%.1f MB > %d MB）',
              walSize / MB, RESOURCE_BUDGET.SQLITE_WAL_CHECKPOINT_MB);
          } catch (err) {
            coreLogger.warn('[ResourceBudget] WAL checkpoint 失败：%s', String(err));
          }
        }
      } catch { /* 文件可能已删除 */ }
    }
    categories.push(walReport);

    // ── DB 高写入量审计/日志表老记录修剪(#2) ──
    if (this.deps.pruneDatabaseRecords) {
      try {
        deletedCount += this.deps.pruneDatabaseRecords(RESOURCE_BUDGET.DB_PRUNE_MAX_AGE_HOURS);
      } catch (err) {
        coreLogger.warn('[ResourceBudget] DB 修剪失败：%s', String(err));
      }
    }

    // 汇总删除数
    for (const r of categories) {
      if (r.category === 'sqlite_wal') continue;
      // deletedCount/freedBytes 已在 enforceCategory 中累计
    }

    return { categories, deletedCount, freedBytes, walCheckpointTriggered };
  }

  /** 返回当前磁盘用量快照 */
  getReport(): CategoryReport[] {
    const sessDir = join(this.workspace, '.lingxiao', 'sessions');
    const logDir = join(this.workspace, '.lingxiao', 'logs');
    const termDir = join(this.workspace, '.lingxiao', 'terminal');
    const scratchDir = join(this.workspace, '.lingxiao', 'scratchpad');
    const walPath = this.getWalPath();

    const sessSize = dirSizeBytes(sessDir);
    const logSize = dirSizeBytes(logDir);
    const termSize = dirSizeBytes(termDir);
    const scratchSize = dirSizeBytes(scratchDir);
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;

    return [
      { category: 'session_artifacts', currentBytes: sessSize, maxBytes: RESOURCE_BUDGET.SESSION_ARTIFACTS_MAX_MB * MB, fileCount: countFiles(sessDir), overBudget: sessSize > RESOURCE_BUDGET.SESSION_ARTIFACTS_MAX_MB * MB },
      { category: 'agent_logs', currentBytes: logSize, maxBytes: RESOURCE_BUDGET.AGENT_LOGS_MAX_MB * MB, fileCount: countFiles(logDir), overBudget: logSize > RESOURCE_BUDGET.AGENT_LOGS_MAX_MB * MB },
      { category: 'terminal_transcripts', currentBytes: termSize, maxBytes: RESOURCE_BUDGET.TERMINAL_TRANSCRIPTS_MAX_MB * MB, fileCount: countFiles(termDir), overBudget: termSize > RESOURCE_BUDGET.TERMINAL_TRANSCRIPTS_MAX_MB * MB },
      { category: 'scratchpad_files', currentBytes: scratchSize, maxBytes: RESOURCE_BUDGET.SCRATCHPAD_MAX_MB * MB, fileCount: countFiles(scratchDir), overBudget: scratchSize > RESOURCE_BUDGET.SCRATCHPAD_MAX_MB * MB },
      { category: 'sqlite_wal', currentBytes: walSize, maxBytes: RESOURCE_BUDGET.SQLITE_WAL_CHECKPOINT_MB * MB, fileCount: existsSync(walPath) ? 1 : 0, overBudget: walSize > RESOURCE_BUDGET.SQLITE_WAL_CHECKPOINT_MB * MB },
    ];
  }

  // ── 内部 ──

  private getCategoryReport(
    dir: string,
    category: BudgetCategory,
    maxBytes: number,
  ): CategoryReport {
    const files = listFilesSorted(dir);
    const currentBytes = files.reduce((sum, f) => sum + f.size, 0);
    return {
      category,
      currentBytes,
      maxBytes,
      fileCount: files.length,
      overBudget: currentBytes > maxBytes,
    };
  }

  /**
   * 对单个目录执行预算强制：扫描 → 超限则从最旧文件开始删除。
   * @param skipFilter 可选过滤器，返回 true 表示该条目应保留（不删除）
   */
  private enforceCategory(
    dir: string,
    category: BudgetCategory,
    maxBytes: number,
    skipFilter?: (entry: FileEntry) => boolean,
  ): CategoryReport {
    const files = listFilesSorted(dir);
    const currentBytes = files.reduce((sum, f) => sum + f.size, 0);
    const report: CategoryReport = {
      category,
      currentBytes,
      maxBytes,
      fileCount: files.length,
      overBudget: currentBytes > maxBytes,
    };

    if (!report.overBudget) return report;

    let remaining = currentBytes;
    for (const file of files) {
      if (remaining <= maxBytes) break;
      if (skipFilter?.(file)) continue;
      try {
        unlinkSync(file.path);
        remaining -= file.size;
        coreLogger.info('[ResourceBudget] 清理 %s: %s（%.1f KB）', category, file.path, file.size / 1024);
      } catch (err) {
        coreLogger.warn('[ResourceBudget] 删除失败 %s：%s', file.path, String(err));
      }
    }

    // 更新报告
    report.currentBytes = remaining;
    report.fileCount = countFiles(dir);
    report.overBudget = remaining > maxBytes;
    return report;
  }
}

/** 递归计算目录内文件数 */
function countFiles(targetPath: string): number {
  if (!existsSync(targetPath)) return 0;
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(targetPath);
  return count;
}
