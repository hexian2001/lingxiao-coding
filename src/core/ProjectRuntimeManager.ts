import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  constants as fsConstants,
} from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import { hostname } from 'os';
import { join } from 'path';
import {
  PROJECT_RUNTIME_SCHEMA_VERSION,
  createDefaultProjectRuntimeState,
  createEmptyDecisionLog,
  createEmptyDependencyLedger,
  type DecisionLog,
  type DependencyLedger,
  type ProjectDecisionEntry,
  type ProjectDependencyEntry,
  type ProjectDependencyStatus,
  type ProjectRuntimeMode,
  type ProjectRuntimeRecord,
  type ProjectSpecReference,
} from './ProjectRuntimeState.js';
import { normalizeProjectDependencyStatus } from './StateSemantics.js';

export interface ProjectRuntimePaths {
  projectDir: string;
  runtimePath: string;
  dependencyLedgerPath: string;
  decisionLogPath: string;
}

export interface CreateProjectRuntimeInput {
  projectId: string;
  projectName: string;
  description?: string;
  specReference?: ProjectSpecReference;
  backlog?: ProjectRuntimeRecord['backlog'];
  milestones?: ProjectRuntimeRecord['milestones'];
  unresolvedRisks?: ProjectRuntimeRecord['unresolvedRisks'];
  initialMode?: ProjectRuntimeMode;
  metadata?: Record<string, unknown>;
}

export interface RecordProjectDecisionInput {
  id?: string;
  at?: number;
  actor: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  modeAfter?: ProjectRuntimeMode;
  relatedDependencyId?: string;
  relatedSprintId?: string;
}

export interface UpsertDependencyInput extends Omit<ProjectDependencyEntry, 'requestedAt' | 'blockingTasks'> {
  requestedAt?: number;
  blockingTasks?: string[];
}

export interface UpdateDependencyStatusInput {
  status: ProjectDependencyStatus;
  at?: number;
  actor?: string;
  summary?: string;
  lastPingedAt?: number;
  details?: Record<string, string | number | boolean | null>;
}

interface StoredProjectRuntimeState extends Omit<ProjectRuntimeRecord, 'dependencyLedger' | 'decisionLog'> {}
interface StoredProjectRuntimeSnapshot extends StoredProjectRuntimeState {
  dependencyLedger?: DependencyLedger;
  decisionLog?: DecisionLog;
}

export interface ProjectStateStore {
  load(projectId: string): ProjectRuntimeRecord | null;
  save(record: ProjectRuntimeRecord): ProjectRuntimeRecord;
  listProjectIds(): string[];
  getPaths(projectId: string): ProjectRuntimePaths;
  /**
   * 可选：返回 per-projectId 的 RMW 串行化锁文件路径。
   * DiskProjectStateStore 提供文件锁；内存/测试 store 可不实现（退回进程内锁）。
   */
  lockPathFor?(projectId: string): string;
}

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}

function normalizeDependencyLedger(
  ledger: DependencyLedger | undefined,
  updatedAt: number,
): DependencyLedger {
  const entries = [...(ledger?.entries || [])].sort((left, right) =>
    left.dependencyId.localeCompare(right.dependencyId),
  );
  return {
    updatedAt: ledger?.updatedAt || updatedAt,
    entries,
  };
}

function normalizeDecisionLog(log: DecisionLog | undefined, updatedAt: number): DecisionLog {
  const entries = [...(log?.entries || [])].sort((left, right) => left.sequence - right.sequence);
  const nextSequence = entries.length === 0 ? 1 : entries[entries.length - 1]!.sequence + 1;
  return {
    updatedAt: log?.updatedAt || updatedAt,
    nextSequence: log?.nextSequence && log.nextSequence > nextSequence ? log.nextSequence : nextSequence,
    entries,
  };
}

function normalizeRecord(record: ProjectRuntimeRecord): ProjectRuntimeRecord {
  const now = record.updatedAt || record.createdAt || Date.now() / 1000;
  const state = record.state || createDefaultProjectRuntimeState(now);
  const health = {
    lastActionAt: state.health?.lastActionAt || state.lastActionAt || now,
    lastSuccessfulActionAt: state.health?.lastSuccessfulActionAt,
    consecutiveFailures: state.health?.consecutiveFailures || 0,
    recoveryAttempts: state.health?.recoveryAttempts || 0,
    evaluatorFailures: state.health?.evaluatorFailures || 0,
    inactivitySince: state.health?.inactivitySince,
    scoreTrend: state.health?.scoreTrend,
    note: state.health?.note,
  };
  return {
    schemaVersion: PROJECT_RUNTIME_SCHEMA_VERSION,
    projectId: record.projectId,
    projectName: record.projectName,
    description: record.description,
    createdAt: record.createdAt || now,
    updatedAt: now,
    state: {
      ...state,
      lastActionAt: state.lastActionAt || now,
      health,
    },
    specReference: record.specReference,
    backlog: record.backlog || [],
    milestones: record.milestones || [],
    unresolvedRisks: record.unresolvedRisks || [],
    dependencyLedger: normalizeDependencyLedger(record.dependencyLedger, now),
    decisionLog: normalizeDecisionLog(record.decisionLog, now),
    metadata: record.metadata,
  };
}

/**
 * 原子写：先写到同目录下的唯一临时文件，再 rename 覆盖目标。
 * rename 在同一文件系统上是原子的，崩溃时要么是旧内容、要么是新内容，
 * 不会留下被截断的半成品文件（旧实现的 writeFileSync 直接写目标，
 * 三个文件中途崩溃会产生彼此不一致的脏状态）。
 */
function atomicWriteFileSync(targetPath: string, data: string): void {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o644);
    writeSync(fd, data);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpPath); } catch { /* 临时文件可能未创建 */ }
    throw err;
  }
}

/**
 * 进程内 + 跨进程的 per-projectId 串行化锁。
 *
 * updateProject / updateDependencyStatus 是 load-modify-save（RMW），两个并发调用
 * 各自 load 到同一份旧状态、各自改写、后写覆盖先写 → lost update。
 * 这里用同一把锁文件把同一 projectId 的 RMW 串行化：同进程靠忙等抢锁文件，
 * 跨进程靠 O_EXCL 独占创建 + stale 兜底。锁文件内容带 pid+host+token，
 * release 时校验所有权后才删除，避免删掉别人的锁。
 */
function withProjectLockSync<T>(
  lockPath: string,
  fn: () => T,
  timeoutMs = 5000,
  staleMs = 60_000,
): T {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  const start = Date.now();
  const token = randomBytes(16).toString('hex');
  const lockBody = JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() });
  let fd: number | null = null;
  let owned = false;

  while (true) {
    try {
      fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o644);
      try { writeSync(fd, lockBody); } catch { /* 写身份失败仍占有锁 */ }
      owned = true;
      break;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
      // stale 兜底：持锁进程异常退出，锁文件 mtime 超过 staleMs 视为残留
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { unlinkSync(lockPath); } catch { /* 已被别人删了 */ }
          continue;
        }
      } catch { /* 文件已不存在，重试 */ }
      if (Date.now() - start > timeoutMs) {
        // 超时：宁可失败也不无锁执行 RMW，避免 lost update 静默破坏依赖账本。
        throw new Error(`withProjectLockSync timeout acquiring ${lockPath}`);
      }
      const deadline = Date.now() + 15;
      while (Date.now() < deadline) { /* 短忙等 */ }
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    // 仅在锁文件内容仍是自己写入的 token 时才删除，避免删掉别人重新获取的锁
    if (owned) {
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token?: string };
        if (current.token === token) {
          unlinkSync(lockPath);
        }
      } catch { /* 内容损坏/已删除：不强删，交给 stale 兜底 */ }
    }
  }
}

export class DiskProjectStateStore implements ProjectStateStore {
  private readonly projectsRoot: string;

  constructor(workspaceRoot: string) {
    this.projectsRoot = join(workspaceRoot, '.lingxiao', 'projects');
  }

  getPaths(projectId: string): ProjectRuntimePaths {
    const projectDir = join(this.projectsRoot, projectId);
    return {
      projectDir,
      runtimePath: join(projectDir, 'runtime.json'),
      dependencyLedgerPath: join(projectDir, 'dependency-ledger.json'),
      decisionLogPath: join(projectDir, 'decision-log.json'),
    };
  }

  /** 同一 projectId 的 RMW 串行化锁路径。 */
  lockPathFor(projectId: string): string {
    return join(this.getPaths(projectId).projectDir, '.runtime.lock');
  }

  load(projectId: string): ProjectRuntimeRecord | null {
    const paths = this.getPaths(projectId);
    if (!existsSync(paths.runtimePath)) {
      return null;
    }

    let runtime: StoredProjectRuntimeSnapshot;
    try {
      runtime = JSON.parse(readFileSync(paths.runtimePath, 'utf-8')) as StoredProjectRuntimeSnapshot;
    } catch { /* expected: file missing or malformed JSON */
      return null;
    }

    let dependencyLedger: DependencyLedger;
    try {
      dependencyLedger = existsSync(paths.dependencyLedgerPath)
        ? (JSON.parse(readFileSync(paths.dependencyLedgerPath, 'utf-8')) as DependencyLedger)
        : runtime.dependencyLedger || createEmptyDependencyLedger(runtime.updatedAt || Date.now() / 1000);
    } catch { /* expected: sidecar file corrupt — fallback to embedded copy */
      // 侧车文件损坏：退回内嵌副本或空账本，不让整条记录失败
      dependencyLedger = runtime.dependencyLedger || createEmptyDependencyLedger(runtime.updatedAt || Date.now() / 1000);
    }

    let decisionLog: DecisionLog;
    try {
      decisionLog = existsSync(paths.decisionLogPath)
        ? (JSON.parse(readFileSync(paths.decisionLogPath, 'utf-8')) as DecisionLog)
        : runtime.decisionLog || createEmptyDecisionLog(runtime.updatedAt || Date.now() / 1000);
    } catch { /* expected: sidecar file corrupt — fallback to embedded copy */
      decisionLog = runtime.decisionLog || createEmptyDecisionLog(runtime.updatedAt || Date.now() / 1000);
    }

    return normalizeRecord({
      ...(runtime as unknown as ProjectRuntimeRecord),
      dependencyLedger,
      decisionLog,
    });
  }

  save(record: ProjectRuntimeRecord): ProjectRuntimeRecord {
    const normalized = normalizeRecord(record);
    const paths = this.getPaths(normalized.projectId);
    mkdirSync(paths.projectDir, { recursive: true });

    const runtimeState: StoredProjectRuntimeState = {
      schemaVersion: normalized.schemaVersion,
      projectId: normalized.projectId,
      projectName: normalized.projectName,
      description: normalized.description,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      state: normalized.state,
      specReference: normalized.specReference,
      backlog: normalized.backlog,
      milestones: normalized.milestones,
      unresolvedRisks: normalized.unresolvedRisks,
      metadata: normalized.metadata,
    };

    // 三个文件均原子写（temp+rename），避免中途崩溃留下彼此不一致的脏状态。
    atomicWriteFileSync(paths.runtimePath, JSON.stringify(runtimeState, null, 2) + '\n');
    atomicWriteFileSync(paths.dependencyLedgerPath, JSON.stringify(normalized.dependencyLedger, null, 2) + '\n');
    atomicWriteFileSync(paths.decisionLogPath, JSON.stringify(normalized.decisionLog, null, 2) + '\n');
    return normalized;
  }

  listProjectIds(): string[] {
    if (!existsSync(this.projectsRoot)) {
      return [];
    }
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(this.getPaths(entry.name).runtimePath))
      .map((entry) => entry.name)
      .sort();
  }
}

export class ProjectRuntimeManager {
  private readonly store: ProjectStateStore;
  private readonly now: () => number;
  /** 同进程内同 projectId 的重入计数，配合文件锁防止 RMW 嵌套自死锁。 */
  private readonly heldLocks = new Set<string>();

  constructor(workspaceRoot: string, options?: { store?: ProjectStateStore; now?: () => number }) {
    this.store = options?.store || new DiskProjectStateStore(workspaceRoot);
    this.now = options?.now || (() => Date.now() / 1000);
  }

  /**
   * 串行化同一 projectId 的 read-modify-write，防止 lost update。
   * 若 store 提供 lockPathFor 则用跨进程文件锁；同进程已持有该锁时直接执行（重入），
   * 避免 recordDecision 嵌套调用 updateProject 时自死锁。
   */
  private withProjectLock<T>(projectId: string, fn: () => T): T {
    const lockPathFor = this.store.lockPathFor?.bind(this.store);
    if (!lockPathFor || this.heldLocks.has(projectId)) {
      return fn();
    }
    const lockPath = lockPathFor(projectId);
    this.heldLocks.add(projectId);
    try {
      return withProjectLockSync(lockPath, fn);
    } finally {
      this.heldLocks.delete(projectId);
    }
  }

  getPaths(projectId: string): ProjectRuntimePaths {
    return this.store.getPaths(projectId);
  }

  listProjectIds(): string[] {
    return this.store.listProjectIds();
  }

  loadProject(projectId: string): ProjectRuntimeRecord | null {
    return this.store.load(projectId);
  }

  saveProject(record: ProjectRuntimeRecord): ProjectRuntimeRecord {
    const now = this.now();
    return this.store.save({
      ...deepClone(record),
      updatedAt: now,
      state: {
        ...record.state,
        lastActionAt: record.state.lastActionAt || now,
        health: {
          ...record.state.health,
          lastActionAt: record.state.health.lastActionAt || record.state.lastActionAt || now,
        },
      },
    });
  }

  createProject(input: CreateProjectRuntimeInput): ProjectRuntimeRecord {
    const existing = this.store.load(input.projectId);
    if (existing) {
      throw new Error(`Project runtime already exists: ${input.projectId}`);
    }

    const now = this.now();
    const record: ProjectRuntimeRecord = {
      schemaVersion: PROJECT_RUNTIME_SCHEMA_VERSION,
      projectId: input.projectId,
      projectName: input.projectName,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      state: createDefaultProjectRuntimeState(now, input.initialMode || 'draft'),
      specReference: input.specReference,
      backlog: deepClone(input.backlog || []),
      milestones: deepClone(input.milestones || []),
      unresolvedRisks: deepClone(input.unresolvedRisks || []),
      dependencyLedger: createEmptyDependencyLedger(now),
      decisionLog: createEmptyDecisionLog(now),
      metadata: deepClone(input.metadata),
    };
    return this.store.save(record);
  }

  ensureProject(input: CreateProjectRuntimeInput): ProjectRuntimeRecord {
    return this.store.load(input.projectId) || this.createProject(input);
  }

  updateProject(
    projectId: string,
    updater: (record: ProjectRuntimeRecord) => ProjectRuntimeRecord,
  ): ProjectRuntimeRecord {
    // 整个 load-modify-save 在锁内串行，避免并发调用各自读到旧状态后互相覆盖（lost update）。
    return this.withProjectLock(projectId, () => {
      const current = this.store.load(projectId);
      if (!current) {
        throw new Error(`Project runtime not found: ${projectId}`);
      }
      const next = updater(deepClone(current));
      return this.saveProject(next);
    });
  }

  setProjectMode(
    projectId: string,
    mode: ProjectRuntimeMode,
    input?: Omit<RecordProjectDecisionInput, 'modeAfter'>,
  ): ProjectRuntimeRecord {
    return this.recordDecision(projectId, {
      actor: input?.actor || 'system',
      type: input?.type || 'mode_transition',
      summary: input?.summary || `Project entered ${mode}`,
      details: input?.details,
      at: input?.at,
      relatedDependencyId: input?.relatedDependencyId,
      relatedSprintId: input?.relatedSprintId,
      modeAfter: mode,
    });
  }

  recordDecision(projectId: string, input: RecordProjectDecisionInput): ProjectRuntimeRecord {
    const at = input.at || this.now();
    return this.updateProject(projectId, (record) => {
      const modeBefore = record.state.mode;
      const decision: ProjectDecisionEntry = {
        id: input.id || randomUUID(),
        sequence: record.decisionLog.nextSequence,
        at,
        actor: input.actor,
        type: input.type,
        summary: input.summary,
        details: input.details,
        modeBefore,
        modeAfter: input.modeAfter,
        relatedDependencyId: input.relatedDependencyId,
        relatedSprintId: input.relatedSprintId,
      };

      record.decisionLog.entries.push(decision);
      record.decisionLog.nextSequence = decision.sequence + 1;
      record.decisionLog.updatedAt = at;
      record.updatedAt = at;
      record.state.lastAction = input.summary;
      record.state.lastActionAt = at;
      record.state.health.lastActionAt = at;

      if (input.modeAfter) {
        record.state.mode = input.modeAfter;
      }

      return record;
    });
  }

  upsertDependency(projectId: string, input: UpsertDependencyInput): ProjectRuntimeRecord {
    const at = input.requestedAt || this.now();
    return this.updateProject(projectId, (record) => {
      const existing = record.dependencyLedger.entries.find(
        (entry) => entry.dependencyId === input.dependencyId,
      );
      if (existing) {
        existing.type = input.type;
        existing.status = input.status;
        existing.summary = input.summary;
        existing.owner = input.owner;
        existing.lastPingedAt = input.lastPingedAt;
        existing.fulfilledAt = input.fulfilledAt;
        existing.failedAt = input.failedAt;
        existing.blockingTasks = [...(input.blockingTasks || existing.blockingTasks || [])];
        existing.details = input.details;
      } else {
        record.dependencyLedger.entries.push({
          dependencyId: input.dependencyId,
          type: input.type,
          status: input.status,
          summary: input.summary,
          owner: input.owner,
          requestedAt: at,
          lastPingedAt: input.lastPingedAt,
          fulfilledAt: input.fulfilledAt,
          failedAt: input.failedAt,
          blockingTasks: [...(input.blockingTasks || [])],
          details: input.details,
        });
      }

      record.dependencyLedger.updatedAt = at;
      record.updatedAt = at;
      record.state.lastActionAt = at;
      record.state.health.lastActionAt = at;
      return record;
    });
  }

  updateDependencyStatus(
    projectId: string,
    dependencyId: string,
    input: UpdateDependencyStatusInput,
  ): ProjectRuntimeRecord {
    const at = input.at || this.now();
    const updated = this.updateProject(projectId, (record) => {
      const dependency = record.dependencyLedger.entries.find((entry) => entry.dependencyId === dependencyId);
      if (!dependency) {
        throw new Error(`Dependency not found: ${dependencyId}`);
      }

      dependency.status = normalizeProjectDependencyStatus(input.status);
      dependency.lastPingedAt = input.lastPingedAt ?? dependency.lastPingedAt;
      dependency.details = input.details ?? dependency.details;
      if (dependency.status === 'fulfilled') {
        dependency.fulfilledAt = at;
      }
      if (dependency.status === 'failed') {
        dependency.failedAt = at;
      }

      record.dependencyLedger.updatedAt = at;
      record.updatedAt = at;
      record.state.lastActionAt = at;
      record.state.health.lastActionAt = at;
      return record;
    });

    if (!input.actor || !input.summary) {
      return updated;
    }

    return this.recordDecision(projectId, {
      actor: input.actor,
      type: 'dependency_status_update',
      summary: input.summary,
      relatedDependencyId: dependencyId,
      at,
    });
  }
}

export default ProjectRuntimeManager;
