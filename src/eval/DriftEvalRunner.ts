/**
 * DriftEvalRunner — 漂移度量 eval harness 的真实 Runner。
 *
 * 实现 CodingEvalRunner 接口:程序化驱动一个冻结任务 → 等待 Leader 完成 →
 * 读回产物(改动文件 / token / 耗时)→ 用纯函数度量层(src/eval/driftMetrics)计算漂移指标。
 *
 * 关键设计(应对 Plan agent 标注的风险 d:leader.run() 可能永不 resolve):
 *  - Leader 经 SessionManager.createSession 在进程内 detached 启动(queueMicrotask,非子进程)。
 *  - 用 emitter 的 `leader:busy isBusy:false` 信号 + DB 任务状态轮询判定完成,
 *    持续 idle 超过 grace 才视为真完成(防轮次间瞬时 idle 误判)。
 *  - 硬超时兜底:到点强制 completeSession,读取已有产物(部分完成也算一次有效样本)。
 *
 * 漂移核心指标放在 metadata,跨运行方差由 runDriftEval 的 aggregateVariance 聚合。
 * 需要 LLM key + 预算才能真跑(npm run eval:drift);度量计算本身是纯函数,有单测。
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { EventEmitter } from '../core/EventEmitter.js';
import { DatabaseManager } from '../core/Database.js';
import { SessionManager } from '../runtime/SessionManagerRuntime.js';
import type { CodingEvalRunner, CodingEvalRunContext, CodingEvalTask, CodingEvalTaskRun } from './CodingEvalHarness.js';
import {
  buildRunMetricsFromProducts,
  type DriftRunMetrics,
} from './driftMetrics.js';

export { buildRunMetricsFromProducts };

/** 漂移度量要忽略的路径(harness/凌霄自身产物,非 agent 业务改动)。 */
const IGNORED_PATH_FRAGMENTS = ['.lingxiao', '/.git/', '.git/', '.lingxiao-eval.db', 'node_modules/'];

function shouldIgnoreWorkspacePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  return IGNORED_PATH_FRAGMENTS.some((frag) => norm.includes(frag) || norm.startsWith(frag)) || norm.endsWith('.db');
}

/** 递归快照 workspace 文件 → Map<相对路径, 内容hash>。用于前后 diff 检测 agent 改动。 */
async function snapshotWorkspace(workspace: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel = path.relative(workspace, full);
      if (shouldIgnoreWorkspacePath(rel)) continue;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.isDirectory()) {
        await walk(full);
      } else {
        try {
          const buf = await readFile(full);
          result.set(rel.replace(/\\/g, '/'), createHash('sha1').update(buf).digest('hex'));
        } catch { /* tolerate */ }
      }
    }
  }
  await walk(workspace);
  return result;
}

/** diff 两个快照:返回 agent 改动过的文件(新增 + 修改)。 */
function diffSnapshots(baseline: Map<string, string>, current: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [file, hash] of current) {
    const baseHash = baseline.get(file);
    if (baseHash !== hash) changed.push(file); // 新增(baseHash=undefined)或修改
  }
  return changed;
}

/** 漂移专用任务:在 CodingEvalTask 基础上扩展 allowedScope。 */
export interface DriftEvalTask extends CodingEvalTask {
  /** 允许改动的路径前缀(相对 workspace 或绝对)。空=无 scope 约束。 */
  allowedScope?: string[];
}

export interface DriftRunnerOptions {
  /** eval 工作根目录(每个任务在其下独立子目录运行)。 */
  baseWorkspace: string;
  /** 单任务硬超时(ms),默认 30 分钟。 */
  maxRuntimeMs?: number;
  /** Leader 持续 idle 多久才算真完成(ms),默认 6 秒。 */
  idleGraceMs?: number;
  /** 轮询间隔(ms),默认 2000。 */
  pollIntervalMs?: number;
  /** 每个 run 独立 db 文件路径前缀(防 session 间污染)。 */
  dbPath?: string;
}

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_GRACE_MS = 6_000;
const DEFAULT_POLL_MS = 2_000;

export class DriftEvalRunner implements CodingEvalRunner {
  constructor(private readonly opts: DriftRunnerOptions) {}

  async run(task: DriftEvalTask, context: CodingEvalRunContext): Promise<CodingEvalTaskRun> {
    const started = Date.now();
    const maxRuntimeMs = this.opts.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
    const idleGraceMs = this.opts.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    const pollIntervalMs = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;

    const workspace = context.workspace;
    const dbPath = this.opts.dbPath || path.join(workspace, '.lingxiao-eval.db');
    const db = new DatabaseManager(dbPath);
    db.init();
    // agent 跑之前快照 workspace 文件树(基准),用于之后 diff 出 agent 真正改动的文件
    const baselineSnapshot = await snapshotWorkspace(workspace);
    const emitter = new EventEmitter();
    const sessionManager = new SessionManager(db, emitter, this.opts.baseWorkspace);

    // 完成判定:Leader 必须先真正开始工作(everBusy),再持续 idle + 无 open work 才算完成。
    // 这避免会话启动期的瞬时 idle 被误判为完成。
    let lastIdleAt = 0;
    let everBusy = false;
    const onBusy = (data: unknown): void => {
      const payload = data as { isBusy?: boolean };
      if (payload.isBusy === true) {
        everBusy = true;
        lastIdleAt = 0; // Leader 恢复工作 → 重置 idle 计时
      } else if (payload.isBusy === false) {
        lastIdleAt = Date.now();
      }
    };
    emitter.on('leader:busy', onBusy);

    const failures: string[] = [];
    let sessionId = '';
    try {
      sessionId = await sessionManager.createSession(task.prompt, workspace, { idle: false });
    } catch (error) {
      failures.push(`createSession 失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    // watchdog:轮询完成(everBusy 后持续 idle + 无 running task)或硬超时
    if (sessionId) {
      const deadline = started + maxRuntimeMs;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          if (context.signal?.aborted || Date.now() >= deadline) {
            resolve();
            return;
          }
          const idleSustained = everBusy && lastIdleAt > 0 && Date.now() - lastIdleAt >= idleGraceMs;
          const noRunningWork = this.hasNoOpenWork(db, sessionId);
          if (idleSustained && noRunningWork) {
            resolve();
            return;
          }
          setTimeout(tick, pollIntervalMs);
        };
        setTimeout(tick, pollIntervalMs);
      });
      // 强制停止 Leader(置 finished=true + abort 当前 LLM 调用),防止后台 detached run 撞已关 db
      try {
        const leader = sessionManager.getSession(sessionId)?.leader;
        leader?.stop();
      } catch { /* tolerate */ }
      // 给 in-flight 操作(setInterval/LLM 回调)一点时间落定,再读产物/关 db
      await new Promise<void>((resolve) => setTimeout(resolve, 2500));
      try { sessionManager.completeSession(sessionId); } catch { /* tolerate */ }
    }

    emitter.off('leader:busy', onBusy);

    // 读回产物:diff agent 跑前/跑后的 workspace 文件树,得到 agent 真正改动的业务文件
    const durationMs = Date.now() - started;
    let changedFiles: string[] = [];
    try {
      const currentSnapshot = await snapshotWorkspace(workspace);
      changedFiles = diffSnapshots(baselineSnapshot, currentSnapshot);
    } catch (error) {
      failures.push(`读取改动文件失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    let tokenTotal = 0;
    try {
      const rows = db.getTokenUsageBySession(sessionId) as Array<{ total?: number; total_tokens?: number }>;
      tokenTotal = rows.reduce((sum, r) => {
        const v = typeof r.total === 'number' ? r.total : (typeof r.total_tokens === 'number' ? r.total_tokens : 0);
        return sum + v;
      }, 0);
    } catch { /* tolerate */ }

    // passed 判定:无失败 + agent 真的改了预期文件(golden end-state 命中)
    const changedSet = new Set(changedFiles.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
    const expectedAllTouched = (task.expectedFiles ?? []).every((f) =>
      changedSet.has(f.replace(/\\/g, '/').replace(/^\.\//, '')),
    );
    const passed = failures.length === 0
      && changedFiles.length > 0
      && (task.expectedFiles && task.expectedFiles.length > 0 ? expectedAllTouched : true);

    // 漂移度量(纯函数)
    const drift = buildRunMetricsFromProducts({
      runIndex: 0,
      passed,
      changedFiles,
      tokenTotal,
      durationMs,
      expectedFiles: task.expectedFiles,
      allowedScope: task.allowedScope,
    });

    try { sessionManager.completeSession(sessionId); } catch { /* tolerate */ }
    // 注意:不主动 close db。后台 detached leader / SessionManager 的恢复/重启机制可能仍持有
    // 该 db,提前 close 会触发 "Database has been closed" 崩溃→leader 重启。让进程退出时统一回收。
    // CLI 末尾 process.exit 会强制终止所有后台 leader。

    return {
      taskId: task.id,
      source: task.source,
      passed: drift.passed,
      testPassed: drift.passed,
      tokenTotal,
      recoveryCount: 0,
      durationMs,
      changedFiles,
      commandsRun: task.testCommands ?? [],
      failures,
      metadata: {
        drift,
        outOfScopeFiles: drift.outOfScopeFiles,
        outOfScopeCount: drift.outOfScopeCount,
        unexpectedChangedFiles: drift.unexpectedChangedFiles,
        sessionId,
      },
    };
  }

  /** 判定会话是否还有未完成工作(running/dispatchable 任务)。无 task board(S1)时只看是否有 task 记录。 */
  private hasNoOpenWork(db: DatabaseManager, sessionId: string): boolean {
    try {
      const tasks = db.getTasksBySession(sessionId) as Array<{ status?: string }>;
      if (tasks.length === 0) return true; // S1:Leader 直接处理,无任务板
      // 终态:completed/failed/cancelled/timed_out。非终态=有 open work。
      const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'terminal']);
      return tasks.every((t) => terminal.has(String(t.status ?? '').toLowerCase()));
    } catch {
      return true;
    }
  }
}
