import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as DatabaseType, SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { dirname, resolve, join } from 'path';
import type { MessageContent, ThinkingBlock, ToolCall } from '../llm/types.js';
import type { CoreWorktreeStatus } from './StateSemantics.js';
import { SESSION_KEYS, SESSION_KEY_PREFIXES } from './SessionStateKeys.js';
import { coreLogger } from './Log.js';
import type { EventEmitter } from './EventEmitter.js';
import type { OrchestrationTaskMetadata } from './OrchestrationTypes.js';
import type { TokenUsageRecord, SessionRecord, TaskDbRow } from '../types/canonical.js';
import { tryRecoverDatabaseLock, robustDatabaseClose } from './DatabaseLockRecovery.js';

// 数据库配置
const DB_BUSY_TIMEOUT_MS = 30000;
/** resetIncompatibleSchema 保留的 .replaced-* 备份数上限(FIFO 删最旧)。*/
const MAX_REPLACED_BACKUPS = 3;
/** 数据库锁定时的最大重试次数 */
const MAX_LOCK_RETRIES = 3;
/** 重试间隔（毫秒） */
const LOCK_RETRY_DELAY_MS = 1000;

/**
 * 判断错误是否为 SQLite 的"忙/快照冲突"类错误。
 * WAL 下并发写可能抛 SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT；busy_timeout 只对锁等待生效，
 * 不会重试 snapshot 冲突，因此 RMW 事务需要在应用层有限重试。
 */
export function isSqliteBusyError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: string; errcode?: number; message?: string };
  if (typeof e.code === 'string' && e.code.includes('SQLITE_BUSY')) return true;
  // node:sqlite 主码 5 = SQLITE_BUSY
  if (e.errcode === 5 || e.errcode === 261 /* SQLITE_BUSY_SNAPSHOT */) return true;
  if (typeof e.message === 'string' && /SQLITE_BUSY|database is locked|busy/i.test(e.message)) return true;
  return false;
}

/**
 * 在给定连接上执行事务。DatabaseManager.transaction 与持有裸连接的 GraphStore / SqliteSpanSink
 * 共用此实现，避免裸 BEGIN/COMMIT 散落各处漏掉重试与回退。
 *
 * @param options.immediate 用 BEGIN IMMEDIATE 立即获取写锁（推荐用于 read-modify-write 与多语句写）。
 *   WAL 下默认 deferred BEGIN 会延迟到首条写语句才升级为写事务，两个并发 RMW 可能各自以读快照开始、
 *   提交时撞 SQLITE_BUSY_SNAPSHOT 而非串行化。BEGIN IMMEDIATE 在事务开始即抢写锁，把 RMW 真正串行化。
 * @param options.retries 遇到 SQLITE_BUSY* 时的有限重试次数（immediate 默认 5），重试前指数退避忙等。
 */
export function runTransaction<T>(
  db: DatabaseType,
  fn: () => T,
  options?: { immediate?: boolean; retries?: number },
): T {
  const beginStmt = options?.immediate ? 'BEGIN IMMEDIATE' : 'BEGIN';
  const maxRetries = options?.retries ?? (options?.immediate ? 5 : 0);

  let attempt = 0;
  for (;;) {
    db.exec(beginStmt);
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
      if (attempt < maxRetries && isSqliteBusyError(error)) {
        attempt += 1;
        const backoffMs = Math.min(10 * 2 ** (attempt - 1), 200);
        // 同步非忙等：Atomics.wait 在内核态休眠，不烧 CPU 时间片
        const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(sleepBuf, 0, 0, backoffMs);
        continue;
      }
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === 'string' ? raw : undefined;
}

function isTextContentPart(value: unknown): value is { type: 'text'; text?: unknown } {
  return isRecord(value) && value.type === 'text';
}

function contentPartText(value: { text?: unknown }): string {
  return value.text ? String(value.text) : '';
}

function parsedConversationText(parsed: unknown, fallback: string): string {
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    return parsed
      .filter(isTextContentPart)
      .map(contentPartText)
      .join('');
  }
  if (isRecord(parsed) && parsed.text) {
    return String(parsed.text);
  }
  return fallback;
}

// 类型定义
// Session — re-exported from canonical
export type Session = SessionRecord;

export type WorktreeStatus = CoreWorktreeStatus;

export type ScheduledTaskType = 'prompt' | 'workflow';
export type ScheduledTaskIntensity = 'gentle' | 'normal' | 'aggressive' | 'critical';
export type ScheduledTaskAudience = 'personal' | 'team' | 'ops' | 'customer';
export type ScheduledTaskSourceType = 'workflow_trigger';

export interface ScheduledTaskRecord {
  id: string;
  session_id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  enabled: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  task_type: ScheduledTaskType;
  intensity: ScheduledTaskIntensity;
  audience: ScheduledTaskAudience;
  workflow_id: string | null;
  workflow_input: Record<string, unknown> | null;
  last_execution_id: string | null;
  last_error: string | null;
  source_type: ScheduledTaskSourceType | null;
  source_id: string | null;
  source_node_id: string | null;
}

export interface WorktreeRecord {
  id: string;
  name: string;
  repo_root: string;
  path: string;
  branch: string;
  base_branch: string;
  session_id?: string;
  task_id?: string;
  status: WorktreeStatus;
  created_at: number;
  updated_at: number;
  last_error?: string;
}

// Task — re-exported from canonical (DB row shape)
export type Task = TaskDbRow;

export interface Message {
  id?: number;
  session_id: string;
  sender: string;
  recipient: string;
  content: string | object | null;
  timestamp: number;
}

export interface AgentLog {
  id?: number;
  session_id: string;
  agent_id: string;
  agent_name: string;
  agent_role: string;
  task_id: string;
  event_type: string;
  content: string;
  token_usage?: object;
  timestamp: number;
  action?: string;
  details?: string;
}

// TokenUsage — re-exported from canonical (DB row shape)
export type TokenUsage = TokenUsageRecord;

export interface LlmGatewayRequestRecord {
  trace_id: string;
  session_id?: string;
  agent_id?: string;
  agent_name?: string;
  key_id?: string;
  key_label?: string;
  profile?: string;
  requested_model?: string;
  selected_model?: string;
  final_model?: string;
  provider?: string;
  status: 'success' | 'failed' | 'rate_limited' | 'auth_failed';
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  latency_ms?: number;
  attempts_json?: string;
  error_kind?: string;
  error_message?: string;
  created_at?: number;
}

export interface ConversationMessage {
  role: string;
  content: MessageContent | object;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  thinking?: ThinkingBlock[];
  timestamp?: number;
  source?: string;
}

export interface AgentState {
  session_id: string;
  agent_id: string;
  agent_name: string;
  agent_role: string;
  task_id: string;
  status: string;
  stopped: number;
  iteration: number;
  timestamp: number;
}

export class DatabaseManager {
  private db: DatabaseType | null = null;
  private path: string;
  private closed = false;
  private initPromise: Promise<void> | null = null;
  private emitter?: EventEmitter;

  constructor(path: string) {
    this.path = resolve(path);
  }

  setEmitter(emitter: EventEmitter): void {
    this.emitter = emitter;
  }

  /** Absolute path to the SQLite file backing this manager. */
  getPath(): string {
    return this.path;
  }

  init(): void {
    // 确保目录存在
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 尝试打开数据库，如果锁定则尝试恢复
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_LOCK_RETRIES; attempt++) {
      try {
        this.db = new DatabaseSync(this.path);
        this.configureConnection(this.db);
        this.resetIncompatibleSchema();

        if (attempt > 1) {
          coreLogger.info(`[Database] Successfully opened after ${attempt} attempts`);
        }
        break; // 成功，跳出循环继续执行后续逻辑
      } catch (error) {
        lastError = error as Error;
        const isLockError = isSqliteBusyError(error);

        if (isLockError && attempt < MAX_LOCK_RETRIES) {
          coreLogger.warn(`[Database] Database locked (attempt ${attempt}/${MAX_LOCK_RETRIES}), diagnosing...`);

          // 诊断并尝试恢复数据库锁
          const recovery = tryRecoverDatabaseLock(this.path);
          for (const line of recovery.diagnostics) {
            coreLogger.info(`[Database] ${line}`);
          }

          if (recovery.aliveProcesses.length > 0) {
            coreLogger.warn(`[Database] ${recovery.aliveProcesses.length} other process(es) hold the DB — waiting ${LOCK_RETRY_DELAY_MS}ms for busy_timeout to queue us`);
          } else {
            coreLogger.info('[Database] No competing processes — WAL will auto-recover on retry');
          }

          // 等待后重试（WAL 模式下 SQLite 会自动恢复，busy_timeout 会排队等锁）
          const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sleepBuf, 0, 0, LOCK_RETRY_DELAY_MS);
          continue;
        }

        // 非锁错误或已达最大重试次数
        if (attempt >= MAX_LOCK_RETRIES) {
          coreLogger.error(`[Database] Failed to open database after ${MAX_LOCK_RETRIES} attempts`);
        }
        throw error;
      }
    }

    if (!this.db) {
      throw lastError || new Error('Failed to initialize database');
    }

    // 创建表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at REAL,
        workspace TEXT,
        user_request TEXT,
        status TEXT DEFAULT 'active',
        summary TEXT,
        name TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT,
        session_id TEXT,
        subject TEXT,
        description TEXT,
        context TEXT,
        status TEXT,
        exit_reason TEXT,
        run_generation INTEGER NOT NULL DEFAULT 0,
        agent_type TEXT,
        blocked_by TEXT,
        blocks TEXT,
        assigned_agent TEXT,
        preferred_agent_name TEXT,
        working_directory TEXT,
        write_scope TEXT,
        result TEXT,
        blocked_reason TEXT,
        orchestration TEXT,
        origin TEXT,
        goal TEXT,
        task_type TEXT,
        created_at REAL,
        updated_at REAL,
        PRIMARY KEY (id, session_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        sender TEXT,
        recipient TEXT,
        content TEXT,
        timestamp REAL
      );

      CREATE TABLE IF NOT EXISTS agent_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        agent_role TEXT,
        task_id TEXT,
        event_type TEXT,
        content TEXT,
        token_usage TEXT,
        action TEXT,
        details TEXT,
        timestamp REAL
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        model_name TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        timestamp REAL
      );

      CREATE TABLE IF NOT EXISTS llm_gateway_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        key_id TEXT,
        key_label TEXT,
        profile TEXT,
        requested_model TEXT,
        selected_model TEXT,
        final_model TEXT,
        provider TEXT,
        status TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        attempts_json TEXT,
        error_kind TEXT,
        error_message TEXT,
        created_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT NOT NULL,
        span_id TEXT PRIMARY KEY,
        parent_span_id TEXT,
        operation TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER,
        status TEXT DEFAULT 'ok',
        attributes TEXT,
        session_id TEXT,
        agent_id TEXT
      );

      CREATE TABLE IF NOT EXISTS leader_conversation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        thinking_blocks TEXT,
        timestamp REAL
      );

      CREATE TABLE IF NOT EXISTS agent_conversation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        role TEXT,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        thinking_blocks TEXT,
        timestamp REAL
      );

      CREATE TABLE IF NOT EXISTS agent_state (
        session_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        agent_role TEXT,
        task_id TEXT,
        status TEXT,
        stopped INTEGER,
        iteration INTEGER,
        timestamp REAL,
        UNIQUE(session_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT,
        key TEXT,
        value TEXT,
        timestamp REAL,
        UNIQUE(session_id, key)
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        workspace TEXT,
        nodes TEXT,
        edges TEXT,
        version TEXT DEFAULT '1.0.0',
        config TEXT,
        tags TEXT,
        created_at REAL,
        updated_at REAL,
        created_by TEXT
      );

      CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        context TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workflow_execution_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        node_id TEXT,
        message TEXT NOT NULL,
        data TEXT,
        FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at REAL NOT NULL,
        superseded_by TEXT,
        confidence TEXT,
        intent_status TEXT,
        priority INTEGER,
        evidence TEXT,
        intent_from TEXT,
        intent_to TEXT,
        contract_allowed_scope TEXT,
        PRIMARY KEY (id, session_id)
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        created_at REAL NOT NULL,
        created_by TEXT NOT NULL,
        metadata TEXT,
        PRIMARY KEY (id, session_id)
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'prompt',
        intensity TEXT NOT NULL DEFAULT 'normal',
        audience TEXT NOT NULL DEFAULT 'personal',
        workflow_id TEXT,
        workflow_input TEXT,
        last_execution_id TEXT,
        last_error TEXT,
        source_type TEXT,
        source_id TEXT,
        source_node_id TEXT,
        recurring INTEGER NOT NULL DEFAULT 1,
        durable INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at REAL,
        next_run_at REAL,
        created_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS health_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp REAL NOT NULL,
        source TEXT NOT NULL,
        has_critical INTEGER NOT NULL DEFAULT 0,
        decisions TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_trace_events (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        agent_role TEXT,
        task_type TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        files_changed TEXT NOT NULL DEFAULT '[]',
        error_signature TEXT,
        fix_pattern TEXT,
        verification TEXT,
        metadata TEXT,
        created_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_project_models (
        project_root TEXT PRIMARY KEY,
        model_json TEXT NOT NULL,
        rebuilt_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assumptions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        status TEXT NOT NULL DEFAULT 'unverified',
        verification_type TEXT NOT NULL,
        verification_target TEXT NOT NULL,
        verification_expected TEXT NOT NULL,
        verification_actual TEXT,
        dependents TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at REAL NOT NULL,
        verified_at REAL,
        falsified_at REAL,
        evidence TEXT,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_leader_conv_session ON leader_conversation(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_conv_session ON agent_conversation(session_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_state_session ON agent_state(session_id);
      CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_llm_gateway_trace ON llm_gateway_requests(trace_id);
      CREATE INDEX IF NOT EXISTS idx_llm_gateway_session ON llm_gateway_requests(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_gateway_key ON llm_gateway_requests(key_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_traces_trace ON traces(trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, start_ts);
      CREATE INDEX IF NOT EXISTS idx_agent_logs_session ON agent_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_session ON graph_nodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(session_id, kind);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_status ON graph_nodes(session_id, intent_status);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(session_id, from_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(session_id, to_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(session_id, edge_type);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_session ON scheduled_tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_workflow ON scheduled_tasks(workflow_id) WHERE workflow_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_source ON scheduled_tasks(source_type, source_id, source_node_id) WHERE source_type IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
      CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_root);
      CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
      CREATE INDEX IF NOT EXISTS idx_hr_session_ts ON health_reports(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_execution_trace_project ON execution_trace_events(project_root, created_at);
      CREATE INDEX IF NOT EXISTS idx_execution_trace_task ON execution_trace_events(session_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_execution_trace_status ON execution_trace_events(project_root, status);
      CREATE INDEX IF NOT EXISTS idx_assumptions_status ON assumptions(status, session_id);
      CREATE INDEX IF NOT EXISTS idx_assumptions_target ON assumptions(session_id, verification_target);
      CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_executions_session ON workflow_executions(session_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_logs_execution ON workflow_execution_logs(execution_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_logs_timestamp ON workflow_execution_logs(timestamp);

      CREATE TABLE IF NOT EXISTS tool_registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_type TEXT NOT NULL DEFAULT 'class',
        tool_description TEXT NOT NULL DEFAULT '',
        tool_schema TEXT NOT NULL DEFAULT '{}',
        registered_at REAL NOT NULL,
        UNIQUE(session_id, tool_name)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_registrations_session ON tool_registrations(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_registrations_name ON tool_registrations(tool_name);

      CREATE TABLE IF NOT EXISTS teams (
        name TEXT NOT NULL,
        description TEXT,
        leader_name TEXT NOT NULL,
        members_json TEXT NOT NULL DEFAULT '[]',
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, name)
      );

      CREATE TABLE IF NOT EXISTS team_members (
        name TEXT NOT NULL,
        team TEXT NOT NULL,
        role TEXT NOT NULL,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        registered_at REAL NOT NULL,
        PRIMARY KEY (session_id, name)
      );

      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY,
        from_team TEXT NOT NULL,
        from_member TEXT,
        to_team TEXT NOT NULL,
        to_member TEXT,
        content TEXT NOT NULL,
        urgency TEXT NOT NULL DEFAULT 'normal',
        kind TEXT NOT NULL DEFAULT 'normal',
        request_id TEXT,
        session_id TEXT NOT NULL,
        timestamp REAL NOT NULL,
        read_by TEXT NOT NULL DEFAULT '[]',
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_teams_session ON teams(session_id);
      CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team);
      CREATE INDEX IF NOT EXISTS idx_team_members_session ON team_members(session_id);
      CREATE INDEX IF NOT EXISTS idx_team_messages_to_team ON team_messages(to_team);
      CREATE INDEX IF NOT EXISTS idx_team_messages_to_member ON team_messages(to_member);
      CREATE INDEX IF NOT EXISTS idx_team_messages_session ON team_messages(session_id);
    `);

    // 当前没有外部旧库升级需求：初始化只写入最新 schema，并标记版本。
    this.stampLatestSchemaVersion();
  }

  private static readonly SCHEMA_VERSION = 15;

  private static readonly LATEST_SCHEMA_COLUMNS: Record<string, string[]> = {
    sessions: ['id', 'created_at', 'workspace', 'user_request', 'status', 'summary', 'name'],
    tasks: ['id', 'session_id', 'subject', 'description', 'context', 'status', 'exit_reason', 'run_generation', 'agent_type', 'blocked_by', 'blocks', 'assigned_agent', 'preferred_agent_name', 'working_directory', 'write_scope', 'result', 'blocked_reason', 'orchestration', 'origin', 'goal', 'task_type', 'created_at', 'updated_at'],
    messages: ['id', 'session_id', 'sender', 'recipient', 'content', 'timestamp'],
    agent_logs: ['id', 'session_id', 'agent_id', 'agent_name', 'agent_role', 'task_id', 'event_type', 'content', 'token_usage', 'action', 'details', 'timestamp'],
    token_usage: ['id', 'session_id', 'agent_id', 'agent_name', 'model_name', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'timestamp'],
    llm_gateway_requests: ['id', 'trace_id', 'session_id', 'agent_id', 'agent_name', 'key_id', 'key_label', 'profile', 'requested_model', 'selected_model', 'final_model', 'provider', 'status', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'latency_ms', 'attempts_json', 'error_kind', 'error_message', 'created_at'],
    traces: ['trace_id', 'span_id', 'parent_span_id', 'operation', 'start_ts', 'end_ts', 'status', 'attributes', 'session_id', 'agent_id'],
    leader_conversation: ['id', 'session_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'thinking_blocks', 'timestamp'],
    agent_conversation: ['id', 'session_id', 'agent_id', 'agent_name', 'role', 'content', 'tool_calls', 'tool_call_id', 'thinking_blocks', 'timestamp'],
    agent_state: ['session_id', 'agent_id', 'agent_name', 'agent_role', 'task_id', 'status', 'stopped', 'iteration', 'timestamp'],
    session_state: ['session_id', 'key', 'value', 'timestamp'],
    worktrees: ['id', 'name', 'repo_root', 'path', 'branch', 'base_branch', 'session_id', 'task_id', 'status', 'created_at', 'updated_at', 'last_error'],
    workflows: ['id', 'name', 'description', 'workspace', 'nodes', 'edges', 'version', 'config', 'tags', 'created_at', 'updated_at', 'created_by'],
    workflow_executions: ['id', 'workflow_id', 'session_id', 'status', 'start_time', 'end_time', 'context', 'error', 'created_at'],
    workflow_execution_logs: ['id', 'execution_id', 'timestamp', 'level', 'node_id', 'message', 'data'],
    graph_nodes: ['id', 'session_id', 'kind', 'title', 'content', 'tags', 'created_by', 'created_at', 'superseded_by', 'confidence', 'intent_status', 'priority', 'evidence', 'intent_from', 'intent_to', 'contract_allowed_scope'],
    graph_edges: ['id', 'session_id', 'from_node_id', 'to_node_id', 'edge_type', 'created_at', 'created_by', 'metadata'],
    scheduled_tasks: ['id', 'session_id', 'cron', 'prompt', 'task_type', 'intensity', 'audience', 'workflow_id', 'workflow_input', 'last_execution_id', 'last_error', 'source_type', 'source_id', 'source_node_id', 'recurring', 'durable', 'enabled', 'last_run_at', 'next_run_at', 'created_at'],
    health_reports: ['id', 'session_id', 'timestamp', 'source', 'has_critical', 'decisions'],
    execution_trace_events: ['id', 'project_root', 'session_id', 'task_id', 'agent_id', 'agent_name', 'agent_role', 'task_type', 'status', 'duration_ms', 'files_changed', 'error_signature', 'fix_pattern', 'verification', 'metadata', 'created_at'],
    execution_project_models: ['project_root', 'model_json', 'rebuilt_at'],
    assumptions: ['id', 'title', 'content', 'status', 'verification_type', 'verification_target', 'verification_expected', 'verification_actual', 'dependents', 'created_by', 'created_at', 'verified_at', 'falsified_at', 'evidence', 'session_id'],
    tool_registrations: ['id', 'session_id', 'tool_name', 'tool_type', 'tool_description', 'tool_schema', 'registered_at'],
    teams: ['name', 'description', 'leader_name', 'members_json', 'workspace', 'session_id', 'created_at', 'active'],
    team_members: ['name', 'team', 'role', 'workspace', 'session_id', 'registered_at'],
    team_messages: ['id', 'from_team', 'from_member', 'to_team', 'to_member', 'content', 'urgency', 'kind', 'request_id', 'session_id', 'timestamp', 'read_by', 'metadata'],
  };

  private static readonly LATEST_SCHEMA_PRIMARY_KEYS: Record<string, string[]> = {
    tasks: ['id', 'session_id'],
    graph_nodes: ['id', 'session_id'],
    graph_edges: ['id', 'session_id'],
    teams: ['session_id', 'name'],
    team_members: ['session_id', 'name'],
  };

  private stampLatestSchemaVersion(): void {
    if (!this.db) return;
    this.db.exec(`PRAGMA user_version = ${DatabaseManager.SCHEMA_VERSION}`);
  }

  /**
   * 替换不兼容的数据库文件。
   * 安全约束：只能在 init() 阶段（worker 尚未 spawn）调用。
   */
  private resetIncompatibleSchema(): void {
    if (!this.db) return;
    if ((globalThis as Record<string, unknown>).__lingxiao_workers_alive) {
      coreLogger.error('[Database] resetIncompatibleSchema called while workers are alive — aborting to prevent corruption');
      throw new Error('Cannot reset database schema while worker processes are running');
    }

    const existingTables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name)
    );

    const existingSchemaVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version ?? 0);
    const incompatibleByVersion = existingTables.size > 0 && existingSchemaVersion !== DatabaseManager.SCHEMA_VERSION;
    const missingLatestTables = existingTables.size === 0
      ? []
      : Object.keys(DatabaseManager.LATEST_SCHEMA_COLUMNS).filter((table) => !existingTables.has(table));
    const incompatibleByColumns = Object.entries(DatabaseManager.LATEST_SCHEMA_COLUMNS).filter(([table, expected]) => {
      if (!existingTables.has(table)) return false;
      const actual = (this.db!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
      return expected.some((column) => !actual.includes(column));
    }).map(([table]) => table);

    const incompatibleByPk = Object.entries(DatabaseManager.LATEST_SCHEMA_PRIMARY_KEYS).filter(([table, expectedPk]) => {
      if (!existingTables.has(table)) return false;
      const info = this.db!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
      const actualPk = info
        .filter((c) => (c.pk ?? 0) > 0)
        .sort((a, b) => (a.pk ?? 0) - (b.pk ?? 0))
        .map((c) => c.name);
      if (actualPk.length !== expectedPk.length) return true;
      for (let i = 0; i < expectedPk.length; i += 1) {
        if (actualPk[i] !== expectedPk[i]) return true;
      }
      return false;
    }).map(([table]) => table);

    const incompatibleTables = Array.from(new Set([...missingLatestTables, ...incompatibleByColumns, ...incompatibleByPk]));

    if (!incompatibleByVersion && incompatibleTables.length === 0) return;

    const reasons = [
      incompatibleByVersion ? `user_version=${existingSchemaVersion}` : null,
      incompatibleTables.length > 0 ? `tables=${incompatibleTables.join(', ')}` : null,
    ].filter((reason): reason is string => Boolean(reason));
    coreLogger.warn(`[Database] incompatible schema (${reasons.join('; ')}); replacing local database`);
    this.db.close();
    this.db = null;

    if (this.path !== ':memory:' && existsSync(this.path)) {
      const backupPath = `${this.path}.replaced-${Date.now()}`;
      renameSync(this.path, backupPath);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${this.path}${suffix}`;
        if (existsSync(sidecar)) {
          renameSync(sidecar, `${backupPath}${suffix}`);
        }
      }
      coreLogger.warn(`[Database] incompatible database moved to ${backupPath}`);
      // prune:保留最近 MAX_REPLACED_BACKUPS 个 .replaced-* 备份,FIFO 删最旧(防跨多次 schema 不兼容累积占盘)。
      this.pruneReplacedBackups();
    }

    this.db = new DatabaseSync(this.path);
    this.configureConnection(this.db);
  }

  /** 清理过期的 .replaced-* 备份(含 -wal/-shm sidecar),保留最近 MAX_REPLACED_BACKUPS 个。 */
  private pruneReplacedBackups(): void {
    if (this.path === ':memory:') return;
    const lastSlash = Math.max(this.path.lastIndexOf('/'), this.path.lastIndexOf('\\'));
    const dir = lastSlash >= 0 ? this.path.slice(0, lastSlash) : '.';
    const base = lastSlash >= 0 ? this.path.slice(lastSlash + 1) : this.path;
    const prefix = `${base}.replaced-`;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.startsWith(prefix));
    } catch { /* tolerate */ return; }
    if (entries.length <= MAX_REPLACED_BACKUPS) return;
    // 文件名含 Date.now() 时间戳,字典序≈时间序;删最旧的。
    entries.sort();
    const toDelete = entries.slice(0, entries.length - MAX_REPLACED_BACKUPS);
    for (const f of toDelete) {
      const full = join(dir, f);
      try { unlinkSync(full); } catch { /* tolerate */ }
      for (const suffix of ['-wal', '-shm']) {
        try { unlinkSync(`${full}${suffix}`); } catch { /* tolerate */ }
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.db) {
      // 使用增强的关闭逻辑：先 wal_checkpoint(TRUNCATE) 合并 WAL 并释放写锁，
      // 再 close()，避免异常退出时锁残留导致下一个进程 "database is locked"。
      robustDatabaseClose(this.db, this.path);
      this.db = null;
    }
  }

  /**
   * 检查数据库是否已关闭
   */
  isClosed(): boolean {
    return this.closed;
  }

  /** 获取底层 node:sqlite DatabaseSync 实例（供 GraphStore 等需要原始连接的模块使用） */
  getDb(): DatabaseType {
    return this.ensureConnection();
  }

  private configureConnection(db: DatabaseType): void {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    // 启用外键约束（SQLite 默认关闭）。必须在事务外、连接打开时设置；
    // schema 已声明 ON DELETE CASCADE，启用后 workflows→executions→logs 的级联删除才真正生效，
    // 否则 deleteWorkflow 的级联是空操作、孤儿行无限堆积。
    db.exec('PRAGMA foreign_keys = ON');

    // 优化多进程并发性能
    db.exec('PRAGMA synchronous = NORMAL'); // WAL 模式下 NORMAL 足够安全
    db.exec('PRAGMA wal_autocheckpoint = 1000'); // 每 1000 页自动 checkpoint
    db.exec('PRAGMA temp_store = MEMORY'); // 临时表使用内存
  }

  /**
   * 执行事务。委托给共享的 runTransaction（见文件顶部），保证裸连接消费者与 DatabaseManager
   * 行为一致：immediate 抢写锁串行化 RMW、SQLITE_BUSY* 有限重试。
   */
  transaction<T>(fn: () => T, options?: { immediate?: boolean; retries?: number }): T {
    return runTransaction(this.ensureConnection(), fn, options);
  }

  private ensureConnection(): DatabaseType {
    if (this.closed) {
      throw new Error('Database has been closed — cannot perform operations');
    }
    if (!this.db) {
      // 自动重连：数据库连接丢失但未显式关闭时尝试恢复
      try {
        this.db = new DatabaseSync(this.path);
        this.configureConnection(this.db);
      } catch (err) {
        throw new Error(`Database reconnection failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return this.db;
  }

  private requireSessionId(sessionId: string | null | undefined, operation: string): string {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error(`[Database] ${operation} requires sessionId`);
    }
    return sessionId;
  }

  private parseJsonValue(val: string, context: string): unknown {
    try {
      return JSON.parse(val);
    } catch (error) {
      throw new Error(`[Database] Invalid JSON in ${context}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private tryJsonLoad(val: string | null, context = 'value'): unknown {
    if (!val || typeof val !== 'string') return val;
    if (val.trim() === 'null') return null;
    if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
      return this.parseJsonValue(val, context);
    }
    return val;
  }

  private tryMessageContentLoad(val: string | null, context = 'message.content'): unknown {
    if (!val || typeof val !== 'string') return val;
    if (val.trim() === 'null') return null;
    if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
      try {
        return this.parseJsonValue(val, context);
      } catch {
        return val;
      }
    }
    return val;
  }

  private parseJsonArray(val: string, context: string): unknown[] {
    const parsed = this.parseJsonValue(val, context);
    if (!Array.isArray(parsed)) {
      throw new Error(`[Database] Expected JSON array in ${context}`);
    }
    return parsed;
  }

  private parseStringArray(val: string, context: string): string[] {
    return this.parseJsonArray(val, context).map((item, index) => {
      if (typeof item !== 'string') {
        throw new Error(`[Database] Expected string at ${context}[${index}]`);
      }
      return item;
    });
  }

  private requireColumn(row: Record<string, unknown>, table: string, column: string): unknown {
    const value = row[column];
    if (value === null || value === undefined) {
      throw new Error(`[Database] Missing canonical column ${table}.${column}`);
    }
    return value;
  }

  private requireStringColumn(row: Record<string, unknown>, table: string, column: string): string {
    return String(this.requireColumn(row, table, column));
  }

  private requireNumberColumn(row: Record<string, unknown>, table: string, column: string): number {
    const value = Number(this.requireColumn(row, table, column));
    if (!Number.isFinite(value)) {
      throw new Error(`[Database] Invalid numeric value in ${table}.${column}`);
    }
    return value;
  }

  private stringify(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  private stringifyJson(value: unknown, context: string): string {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error(`[Database] ${context} must be JSON-serializable`);
    }
    return json;
  }

  private ensureToolCallsArgumentsAsJsonString(toolCalls: unknown): ToolCall[] {
    if (!Array.isArray(toolCalls)) {
      return [];
    }

    return toolCalls.map((toolCall) => {
      const raw = (toolCall || {}) as Record<string, unknown>;
      const rawFunction = (raw.function || {}) as Record<string, unknown>;
      const rawArguments = rawFunction.arguments;

      return {
        id: typeof raw.id === 'string' ? raw.id : '',
        type: 'function',
        function: {
          name: typeof rawFunction.name === 'string' ? rawFunction.name : '',
          arguments:
            typeof rawArguments === 'string'
              ? rawArguments
              : JSON.stringify(rawArguments ?? {}, null, 0),
        },
      };
    });
  }

  // === Session ===
  insertSession(sessionId: string, workspacePath: string, userRequest: string | object | null): void {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'insertSession');
    const userReq = typeof userRequest === 'string' ? userRequest : JSON.stringify(userRequest);
    db.prepare(
      'INSERT INTO sessions (id, created_at, workspace, user_request) VALUES (?, ?, ?, ?)'
    ).run(requiredSessionId, Date.now() / 1000, workspacePath, userReq);
  }

  getSession(sessionId: string): Session | null {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'getSession');
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(requiredSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      created_at: Number(row.created_at),
      workspace: String(row.workspace),
      user_request: this.tryJsonLoad(String(row.user_request)) as MessageContent | object,
      status: String(row.status),
      summary: row.summary ? String(row.summary) : undefined,
      name: row.name ? String(row.name) : undefined,
    };
  }

  listSessions(): Session[] {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      created_at: Number(r.created_at),
      workspace: String(r.workspace),
      user_request: this.tryJsonLoad(String(r.user_request)) as MessageContent | object,
      status: String(r.status),
      summary: r.summary ? String(r.summary) : undefined,
      name: r.name ? String(r.name) : undefined,
    }));
  }

  /**
   * 获取最近一条活跃会话（daemon 启动时继承）
   */
  getLastActiveSession(): Session | null {
    const db = this.ensureConnection();
    const row = db.prepare(
      "SELECT * FROM sessions WHERE status != 'deleted' ORDER BY created_at DESC LIMIT 1"
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      created_at: Number(row.created_at),
      workspace: String(row.workspace),
      user_request: this.tryJsonLoad(String(row.user_request)) as MessageContent | object,
      status: String(row.status),
      summary: row.summary ? String(row.summary) : undefined,
      name: row.name ? String(row.name) : undefined,
    };
  }

  updateSessionStatus(sessionId: string, status: string, summary?: string): void {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'updateSessionStatus');
    if (summary) {
      db.prepare('UPDATE sessions SET status = ?, summary = ? WHERE id = ?').run(status, summary, requiredSessionId);
    } else {
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, requiredSessionId);
    }
  }

  /** 更新会话名称（自动命名或用户手动编辑） */
  updateSessionName(sessionId: string, name: string): void {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'updateSessionName');
    db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, requiredSessionId);
  }

  // === Worktrees ===
  upsertWorktree(record: WorktreeRecord): void {
    const db = this.ensureConnection();
    db.prepare(`
      INSERT INTO worktrees (
        id, name, repo_root, path, branch, base_branch, session_id, task_id,
        status, created_at, updated_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        repo_root = excluded.repo_root,
        path = excluded.path,
        branch = excluded.branch,
        base_branch = excluded.base_branch,
        session_id = excluded.session_id,
        task_id = excluded.task_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error
    `).run(
      record.id,
      record.name,
      record.repo_root,
      record.path,
      record.branch,
      record.base_branch,
      record.session_id ?? null,
      record.task_id ?? null,
      record.status,
      record.created_at,
      record.updated_at,
      record.last_error ?? null,
    );
  }

  listWorktrees(filters?: { repoRoot?: string; sessionId?: string; taskId?: string; includeRemoved?: boolean }): WorktreeRecord[] {
    const db = this.ensureConnection();
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters?.repoRoot) {
      clauses.push('repo_root = ?');
      params.push(filters.repoRoot);
    }
    if (filters?.sessionId) {
      clauses.push('session_id = ?');
      params.push(filters.sessionId);
    }
    if (filters?.taskId) {
      clauses.push('task_id = ?');
      params.push(filters.taskId);
    }
    if (!filters?.includeRemoved) {
      clauses.push("status != 'removed'");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM worktrees ${where} ORDER BY created_at DESC`).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapWorktreeRecord(row));
  }

  getWorktree(id: string): WorktreeRecord | null {
    const db = this.ensureConnection();
    const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorktreeRecord(row) : null;
  }

  getWorktreeByPath(path: string): WorktreeRecord | null {
    const db = this.ensureConnection();
    const row = db.prepare('SELECT * FROM worktrees WHERE path = ? AND status != ?').get(path, 'removed') as Record<string, unknown> | undefined;
    return row ? this.mapWorktreeRecord(row) : null;
  }

  attachWorktreeSession(id: string, sessionId: string | null): void {
    const db = this.ensureConnection();
    db.prepare('UPDATE worktrees SET session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, Date.now() / 1000, id);
  }

  updateWorktreeStatus(id: string, status: WorktreeStatus, lastError?: string | null): void {
    const db = this.ensureConnection();
    db.prepare('UPDATE worktrees SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, lastError ?? null, Date.now() / 1000, id);
  }

  private mapWorktreeRecord(row: Record<string, unknown>): WorktreeRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      repo_root: String(row.repo_root),
      path: String(row.path),
      branch: String(row.branch),
      base_branch: String(row.base_branch),
      session_id: row.session_id ? String(row.session_id) : undefined,
      task_id: row.task_id ? String(row.task_id) : undefined,
      status: String(row.status || 'active') as WorktreeStatus,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      last_error: row.last_error ? String(row.last_error) : undefined,
    };
  }

  // === Task ===
  insertTask(task: Task): void {
    const db = this.ensureConnection();
    const sessionId = this.requireSessionId(task.session_id, 'insertTask');
    const taskAliases = task as TaskDbRow & { exitReason?: string | null; runGeneration?: number | null };
    const exitReason = taskAliases.exitReason ?? task.exit_reason ?? null;
    const runGeneration = Number(taskAliases.runGeneration ?? task.run_generation ?? 0);
    db.prepare(
      `INSERT INTO tasks
       (id, session_id, subject, description, context, status, exit_reason, run_generation, agent_type, blocked_by, blocks, assigned_agent, preferred_agent_name, working_directory, write_scope, result, blocked_reason, orchestration, origin, goal, task_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      sessionId,
      task.subject,
      this.stringify(task.description),
      task.context || null,
      task.status,
      exitReason,
      Number.isFinite(runGeneration) ? Math.max(0, Math.floor(runGeneration)) : 0,
      task.agent_type,
      JSON.stringify(task.blocked_by),
      JSON.stringify(task.blocks),
      task.assigned_agent,
      task.preferred_agent_name || null,
      task.working_directory || '',
      JSON.stringify(task.write_scope || []),
      this.stringify(task.result),
      task.blocked_reason || null,
      task.orchestration ? JSON.stringify(task.orchestration) : null,
      task.origin || null,
      task.goal || null,
      task.task_type || null,
      task.created_at,
      task.updated_at
    );
  }

  updateTask(task: Task): void {
    const db = this.ensureConnection();
    const sessionId = this.requireSessionId(task.session_id, 'updateTask');
    const taskAliases = task as TaskDbRow & { exitReason?: string | null; runGeneration?: number | null };
    const exitReason = taskAliases.exitReason ?? task.exit_reason ?? null;
    const runGeneration = Number(taskAliases.runGeneration ?? task.run_generation ?? 0);
    const result = db.prepare(
      `UPDATE tasks SET subject=?, description=?, context=?, status=?, exit_reason=?, run_generation=?, agent_type=?,
       blocked_by=?, blocks=?, assigned_agent=?, preferred_agent_name=?, working_directory=?, write_scope=?, result=?, blocked_reason=?, orchestration=?,
       origin=?, goal=?, task_type=?, updated_at=?
       WHERE id=? AND session_id=?`
    ).run(
      task.subject,
      this.stringify(task.description),
      task.context || null,
      task.status,
      exitReason,
      Number.isFinite(runGeneration) ? Math.max(0, Math.floor(runGeneration)) : 0,
      task.agent_type,
      JSON.stringify(task.blocked_by),
      JSON.stringify(task.blocks),
      task.assigned_agent,
      task.preferred_agent_name || null,
      task.working_directory || '',
      JSON.stringify(task.write_scope || []),
      this.stringify(task.result),
      task.blocked_reason || null,
      task.orchestration ? JSON.stringify(task.orchestration) : null,
      task.origin || null,
      task.goal || null,
      task.task_type || null,
      task.updated_at,
      task.id,
      sessionId
    );
    if (Number(result.changes) === 0) {
      throw new Error(`[Database] Missing canonical task row tasks(${sessionId}, ${task.id})`);
    }
  }

  deleteTask(id: string, sessionId: string): void {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'deleteTask');
    const result = db.prepare('DELETE FROM tasks WHERE id = ? AND session_id = ?').run(id, requiredSessionId);
    if (Number(result.changes) === 0) {
      throw new Error(`[Database] Missing canonical task row tasks(${requiredSessionId}, ${id})`);
    }
  }

  private mapTaskRow(row: Record<string, unknown>): Task {
    const table = 'tasks';
    const orchestration = row.orchestration
      ? this.parseJsonValue(String(row.orchestration), 'tasks.orchestration') as OrchestrationTaskMetadata
      : undefined;
    if (orchestration !== undefined && (!isRecord(orchestration) || Array.isArray(orchestration))) {
      throw new Error('[Database] Expected JSON object in tasks.orchestration');
    }
    return {
      id: this.requireStringColumn(row, table, 'id'),
      session_id: this.requireStringColumn(row, table, 'session_id'),
      subject: this.requireStringColumn(row, table, 'subject'),
      description: this.tryJsonLoad(this.requireStringColumn(row, table, 'description'), 'tasks.description') as string | object,
      context: row.context ? String(row.context) : undefined,
      status: this.requireStringColumn(row, table, 'status'),
      exit_reason: row.exit_reason ? String(row.exit_reason) : undefined,
      run_generation: Number(row.run_generation ?? 0),
      agent_type: this.requireStringColumn(row, table, 'agent_type'),
      blocked_by: this.parseStringArray(this.requireStringColumn(row, table, 'blocked_by'), 'tasks.blocked_by'),
      blocks: this.parseStringArray(this.requireStringColumn(row, table, 'blocks'), 'tasks.blocks'),
      assigned_agent: this.requireStringColumn(row, table, 'assigned_agent'),
      preferred_agent_name: row.preferred_agent_name ? String(row.preferred_agent_name) : undefined,
      working_directory: this.requireStringColumn(row, table, 'working_directory'),
      write_scope: this.parseStringArray(this.requireStringColumn(row, table, 'write_scope'), 'tasks.write_scope'),
      result: row.result === null || row.result === undefined ? undefined : this.tryJsonLoad(String(row.result), 'tasks.result') as string | object | undefined,
      blocked_reason: row.blocked_reason ? String(row.blocked_reason) : undefined,
      orchestration,
      origin: row.origin ? String(row.origin) : undefined,
      goal: row.goal ? String(row.goal) : undefined,
      task_type: row.task_type ? String(row.task_type) : undefined,
      created_at: this.requireNumberColumn(row, table, 'created_at'),
      updated_at: this.requireNumberColumn(row, table, 'updated_at'),
    };
  }

  getTask(id: string, sessionId: string): Task | undefined {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'getTask');
    const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND session_id = ?').get(id, requiredSessionId) as Record<string, unknown> | undefined;
    return row ? this.mapTaskRow(row) : undefined;
  }

  getTasksBySession(sessionId: string): Task[] {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'getTasksBySession');
    const rows = db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at').all(requiredSessionId) as Record<string, unknown>[];
    return rows.map(r => this.mapTaskRow(r));
  }

  // === Message ===
  insertMessage(msg: Message): void {
    const db = this.ensureConnection();
    db.prepare(
      'INSERT INTO messages (session_id, sender, recipient, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(msg.session_id, msg.sender, msg.recipient, this.stringify(msg.content), msg.timestamp);
  }

  getMessages(sessionId: string): Array<{ sender: string; recipient: string; content: string | unknown; timestamp: number }> {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT sender, recipient, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp').all(sessionId) as Record<string, unknown>[];
    return rows.map(r => ({
      sender: String(r.sender),
      recipient: String(r.recipient),
      content: this.tryMessageContentLoad(String(r.content), 'messages.content'),
      timestamp: Number(r.timestamp),
    }));
  }

  // === Agent Log ===
  insertAgentLog(log: AgentLog): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO agent_logs 
       (session_id, agent_id, agent_name, agent_role, task_id, event_type, content, token_usage, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.session_id,
      log.agent_id,
      log.agent_name,
      log.agent_role,
      log.task_id,
      log.event_type,
      log.content,
      log.token_usage ? JSON.stringify(log.token_usage) : null,
      log.timestamp
    );
  }

  getAgentLogs(sessionId: string, agentId?: string): AgentLog[] {
    const db = this.ensureConnection();
    let rows: Record<string, unknown>[];
    if (agentId) {
      rows = db.prepare('SELECT * FROM agent_logs WHERE session_id = ? AND agent_id = ? ORDER BY timestamp').all(sessionId, agentId) as Record<string, unknown>[];
    } else {
      rows = db.prepare('SELECT * FROM agent_logs WHERE session_id = ? ORDER BY timestamp').all(sessionId) as Record<string, unknown>[];
    }
    return rows.map(r => {
      let tokenUsage: object | undefined;
      if (r.token_usage) {
        const parsed = this.parseJsonValue(String(r.token_usage), 'agent_logs.token_usage');
        if (!isRecord(parsed)) {
          throw new Error('[Database] Expected JSON object in agent_logs.token_usage');
        }
        tokenUsage = parsed;
      }
      return {
        id: Number(r.id),
        session_id: String(r.session_id),
        agent_id: String(r.agent_id),
        agent_name: String(r.agent_name),
        agent_role: String(r.agent_role),
        task_id: String(r.task_id),
        event_type: String(r.event_type),
        content: String(r.content),
        token_usage: tokenUsage,
        timestamp: Number(r.timestamp),
      };
    });
  }

  // === Token Usage ===
  insertTokenUsage(sessionId: string, agentId: string, agentName: string, prompt: number, completion: number, total: number, modelName?: string, cacheRead?: number, cacheCreation?: number): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO token_usage
       (session_id, agent_id, agent_name, model_name, prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      agentId,
      agentName,
      modelName || '',
      prompt,
      completion,
      total,
      cacheRead || 0,
      cacheCreation || 0,
      Date.now() / 1000
    );
  }

  insertLlmGatewayRequest(record: LlmGatewayRequestRecord): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO llm_gateway_requests
       (trace_id, session_id, agent_id, agent_name, key_id, key_label, profile, requested_model, selected_model, final_model, provider, status,
        prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, latency_ms, attempts_json, error_kind, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.trace_id,
      record.session_id || null,
      record.agent_id || null,
      record.agent_name || null,
      record.key_id || null,
      record.key_label || null,
      record.profile || null,
      record.requested_model || null,
      record.selected_model || null,
      record.final_model || null,
      record.provider || null,
      record.status,
      record.prompt_tokens || 0,
      record.completion_tokens || 0,
      record.total_tokens || 0,
      record.cache_read_tokens || 0,
      record.cache_creation_tokens || 0,
      record.latency_ms || 0,
      record.attempts_json || null,
      record.error_kind || null,
      record.error_message || null,
      record.created_at ?? Date.now() / 1000,
    );
  }

  getTokenSummary(sessionId: string): Array<{ agent_id: string; agent_name: string; prompt: number; completion: number; total: number; cache_read: number; cache_creation: number }> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      `SELECT agent_id, agent_name,
       SUM(prompt_tokens) as prompt, SUM(completion_tokens) as completion, SUM(total_tokens) as total,
       SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_creation
       FROM token_usage WHERE session_id = ? GROUP BY agent_id`
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => ({
      agent_id: String(r.agent_id),
      agent_name: String(r.agent_name),
      prompt: Number(r.prompt),
      completion: Number(r.completion),
      total: Number(r.total),
      cache_read: Number(r.cache_read ?? 0),
      cache_creation: Number(r.cache_creation ?? 0),
    }));
  }

  getTokenUsageBySession(sessionId: string): Array<{ agent_id: string; prompt: number; completion: number; total: number; cache_read: number; cache_creation: number }> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      `SELECT agent_id, SUM(prompt_tokens) as prompt, SUM(completion_tokens) as completion, SUM(total_tokens) as total, SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_creation
       FROM token_usage WHERE session_id = ? GROUP BY agent_id`
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => ({
      agent_id: String(r.agent_id),
      prompt: Number(r.prompt),
      completion: Number(r.completion),
      total: Number(r.total),
      cache_read: Number(r.cache_read ?? 0),
      cache_creation: Number(r.cache_creation ?? 0),
    }));
  }

  getModelStats(): Array<{ sessionId: string; name: string; callCount: number; totalPrompt: number; totalCompletion: number; totalTokens: number; cacheRead: number; cacheCreation: number }> {
    const db = this.ensureConnection();
    try {
      const rows = db.prepare(
        `SELECT
           model_name AS name,
           session_id,
           COUNT(*) as callCount,
           SUM(prompt_tokens) as totalPrompt, SUM(completion_tokens) as totalCompletion, SUM(total_tokens) as totalTokens,
           SUM(COALESCE(cache_read_tokens, 0)) as cacheRead, SUM(COALESCE(cache_creation_tokens, 0)) as cacheCreation
         FROM token_usage
         WHERE model_name IS NOT NULL AND model_name != ''
         GROUP BY model_name, session_id
         ORDER BY totalTokens DESC`
      ).all() as Record<string, unknown>[];
      return rows.map(r => ({
        sessionId: String(r.session_id || ''),
        name: String(r.name || ''),
        callCount: Number(r.callCount),
        totalPrompt: Number(r.totalPrompt),
        totalCompletion: Number(r.totalCompletion),
        totalTokens: Number(r.totalTokens),
        cacheRead: Number(r.cacheRead || 0),
        cacheCreation: Number(r.cacheCreation || 0),
      }));
    } catch { /* expected: table may not exist yet */ return []; }
  }

  /** 按模型名聚合的统计（合并所有 session） */
  getModelStatsAggregated(): Array<{ name: string; callCount: number; totalPrompt: number; totalCompletion: number; totalTokens: number; cacheRead: number; cacheCreation: number; sessionCount: number }> {
    const db = this.ensureConnection();
    try {
      const rows = db.prepare(
        `SELECT
           model_name AS name,
           COUNT(*) as callCount,
           COUNT(DISTINCT session_id) as sessionCount,
           SUM(prompt_tokens) as totalPrompt, SUM(completion_tokens) as totalCompletion, SUM(total_tokens) as totalTokens,
           SUM(COALESCE(cache_read_tokens, 0)) as cacheRead, SUM(COALESCE(cache_creation_tokens, 0)) as cacheCreation
         FROM token_usage
         WHERE model_name IS NOT NULL AND model_name != ''
         GROUP BY model_name
         ORDER BY totalTokens DESC`
      ).all() as Record<string, unknown>[];
      return rows.map(r => ({
        name: String(r.name || ''),
        callCount: Number(r.callCount),
        sessionCount: Number(r.sessionCount),
        totalPrompt: Number(r.totalPrompt),
        totalCompletion: Number(r.totalCompletion),
        totalTokens: Number(r.totalTokens),
        cacheRead: Number(r.cacheRead || 0),
        cacheCreation: Number(r.cacheCreation || 0),
      }));
    } catch { /* expected: table may not exist yet */ return []; }
  }

  getAgentStats(): Array<{ agentId: string; agentName: string; modelName: string; callCount: number; totalPrompt: number; totalCompletion: number; totalTokens: number }> {
    const db = this.ensureConnection();
    try {
      const rows = db.prepare(
        `SELECT
           agent_id,
           COALESCE(NULLIF(agent_name, ''), agent_id) AS agent_name,
           model_name,
           COUNT(*) as callCount,
           SUM(prompt_tokens) as totalPrompt, SUM(completion_tokens) as totalCompletion, SUM(total_tokens) as totalTokens
         FROM token_usage
         WHERE model_name IS NOT NULL AND model_name != ''
         GROUP BY agent_id, agent_name, model_name
         ORDER BY totalTokens DESC`
      ).all() as Record<string, unknown>[];
      return rows.map(r => ({
        agentId: String(r.agent_id || ''),
        agentName: String(r.agent_name || ''),
        modelName: String(r.model_name || ''),
        callCount: Number(r.callCount),
        totalPrompt: Number(r.totalPrompt),
        totalCompletion: Number(r.totalCompletion),
        totalTokens: Number(r.totalTokens),
      }));
    } catch { /* expected: table may not exist yet */ return []; }
  }

  getToolStats(): Array<{ name: string; callCount: number; lastUsed: number }> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      `SELECT tool_calls, timestamp FROM leader_conversation WHERE tool_calls IS NOT NULL AND tool_calls != '' ORDER BY timestamp DESC LIMIT 5000`
    ).all() as Record<string, unknown>[];
    const stats = new Map<string, { count: number; lastUsed: number }>();
    for (const row of rows) {
      const calls = this.parseJsonArray(String(row.tool_calls), 'leader_conversation.tool_calls');
      const ts = Number(row.timestamp) * 1000;
      for (const call of calls) {
        const raw = isRecord(call) ? call : {};
        const fn = isRecord(raw.function) ? raw.function : {};
        const name = typeof fn.name === 'string'
          ? fn.name
          : typeof raw.name === 'string'
            ? raw.name
            : 'unknown';
        const existing = stats.get(name) || { count: 0, lastUsed: 0 };
        existing.count++;
        if (ts > existing.lastUsed) existing.lastUsed = ts;
        stats.set(name, existing);
      }
    }
    return Array.from(stats.entries())
      .map(([name, s]) => ({ name, callCount: s.count, lastUsed: s.lastUsed }))
      .sort((a, b) => b.callCount - a.callCount);
  }

  // === Leader Conversation ===
  saveConversationMessage(sessionId: string, message: ConversationMessage): void {
    const db = this.ensureConnection();
    const timestamp = Date.now() / 1000;
    const result = db.prepare(
      `INSERT INTO leader_conversation
       (session_id, role, content, tool_calls, tool_call_id, thinking_blocks, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      message.role,
      this.stringify(message.content),
      message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      message.tool_call_id || null,
      message.thinking ? JSON.stringify(message.thinking) : null,
      timestamp
    );
    const id = Number(result.lastInsertRowid);
    try {
      this.emitter?.emit('conversation:message_saved', {
        sessionId,
        id,
        role: message.role,
        content: message.content,
        toolCalls: message.tool_calls,
        toolCallId: message.tool_call_id,
        thinking: message.thinking,
        timestamp,
        source: message.source || 'leader_conversation',
      });
    } catch (error) {
      coreLogger.warn('Failed to emit conversation message update:', error);
    }
  }

  /**
   * 原子批量写入多条 leader_conversation 消息（单事务）。
   *
   * 用于治本层：ToolResponseProcessor 的 persistAssistantMessage 先于 persistToolMessage
   * 落库，中间隔着慢工具执行窗口；进程在此窗口被 kill（心跳误杀 / SIGTERM / OOM / 崩溃）
   * 会让「assistant 已落库、tool 结果未落库」的残缺永久写进表。LeaderToolDispatch 攒齐
   * assistant + 其全部 tool results 后调本接口一次性事务写入，消除该裂缝——要么全写、
   * 要么全不写。
   *
   * timestamp 策略：以 baseTimestamp（默认 now）为基准，每条 +0.001s 严格递增，
   * 保证 ORDER BY timestamp 读回顺序与入参数组一致；调用方传 assistant 的真实发生时刻
   * 作为 baseTimestamp，使其在表中位于「其后写入的消息」之前（规避延迟落库导致的乱序）。
   *
   * emit 在事务提交后批量触发，避免持锁期间回调订阅者（SseBridge 补水合）。
   */
  saveConversationMessagesBatch(sessionId: string, messages: ConversationMessage[], baseTimestamp?: number): void {
    if (messages.length === 0) return;
    const db = this.ensureConnection();
    const insertStmt = db.prepare(
      `INSERT INTO leader_conversation
       (session_id, role, content, tool_calls, tool_call_id, thinking_blocks, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const base = typeof baseTimestamp === 'number' && Number.isFinite(baseTimestamp)
      ? baseTimestamp
      : Date.now() / 1000;
    const emitted: Array<{ id: number; message: ConversationMessage; timestamp: number }> = [];
    this.transaction(() => {
      messages.forEach((message, index) => {
        const timestamp = base + index * 0.001;
        const result = insertStmt.run(
          sessionId,
          message.role,
          this.stringify(message.content),
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id || null,
          message.thinking ? JSON.stringify(message.thinking) : null,
          timestamp,
        );
        emitted.push({ id: Number(result.lastInsertRowid), message, timestamp });
      });
    });
    for (const { id, message, timestamp } of emitted) {
      try {
        this.emitter?.emit('conversation:message_saved', {
          sessionId,
          id,
          role: message.role,
          content: message.content,
          toolCalls: message.tool_calls,
          toolCallId: message.tool_call_id,
          thinking: message.thinking,
          timestamp,
          source: message.source || 'leader_conversation',
        });
      } catch (error) {
        coreLogger.warn('Failed to emit conversation message update:', error);
      }
    }
  }

  getConversation(sessionId: string): ConversationMessage[] {
    const db = this.ensureConnection();
    const rows = db.prepare(
      'SELECT role, content, tool_calls, tool_call_id, thinking_blocks, timestamp FROM leader_conversation WHERE session_id = ? ORDER BY timestamp'
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => {
      const msg: ConversationMessage = {
        role: String(r.role),
        content: this.tryMessageContentLoad(String(r.content), 'leader_conversation.content') as MessageContent | object,
      };
      if (r.tool_calls) {
        msg.tool_calls = this.ensureToolCallsArgumentsAsJsonString(
          this.parseJsonArray(String(r.tool_calls), 'leader_conversation.tool_calls')
        );
      }
      if (r.tool_call_id) {
        msg.tool_call_id = String(r.tool_call_id);
      }
      if (r.thinking_blocks) {
        msg.thinking = this.parseJsonArray(String(r.thinking_blocks), 'leader_conversation.thinking_blocks') as ThinkingBlock[];
      }
      if (r.timestamp != null) {
        msg.timestamp = Number(r.timestamp);
      }
      return msg;
    });
  }

  getConversationMessages(sessionId: string, role?: string): ConversationMessage[] {
    const db = this.ensureConnection();
    let query = 'SELECT role, content, tool_calls, tool_call_id, thinking_blocks, timestamp FROM leader_conversation WHERE session_id = ?';
    const params: string[] = [sessionId];
    
    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }
    
    query += ' ORDER BY timestamp';
    
    const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(r => {
      const msg: ConversationMessage = {
        role: String(r.role),
        content: this.tryMessageContentLoad(String(r.content), 'leader_conversation.content') as MessageContent | object,
      };
      if (r.tool_calls) {
        msg.tool_calls = this.ensureToolCallsArgumentsAsJsonString(
          this.parseJsonArray(String(r.tool_calls), 'leader_conversation.tool_calls')
        );
      }
      if (r.tool_call_id) {
        msg.tool_call_id = String(r.tool_call_id);
      }
      if (r.thinking_blocks) {
        msg.thinking = this.parseJsonArray(String(r.thinking_blocks), 'leader_conversation.thinking_blocks') as ThinkingBlock[];
      }
      if (r.timestamp != null) {
        msg.timestamp = Number(r.timestamp);
      }
      return msg;
    });
  }

  clearConversation(sessionId: string): void {
    const db = this.ensureConnection();
    db.prepare('DELETE FROM leader_conversation WHERE session_id = ?').run(sessionId);
  }

  /**
   * 删除指定时间戳之后的对话记录（用于回退）
   * 同时清理 leader_conversation 和 agent_conversation
   */
  truncateConversationAfter(sessionId: string, timestamp: number): number {
    const db = this.ensureConnection();
    const leaderStmt = db.prepare(
      'DELETE FROM leader_conversation WHERE session_id = ? AND timestamp > ?'
    );
    // 两表 DELETE 必须同事务（immediate 抢写锁 + BUSY 重试）：否则崩溃或 SQLITE_BUSY 中途
    // 会让 leader / agent 对话表不一致，回退只生效一半。
    return this.transaction(() => {
      const leaderChanges = Number(leaderStmt.run(sessionId, timestamp).changes);
      let agentChanges = 0;
      try {
        const agentStmt = db.prepare(
          'DELETE FROM agent_conversation WHERE session_id = ? AND timestamp > ?'
        );
        agentChanges = Number(agentStmt.run(sessionId, timestamp).changes);
      } catch {
        // agent 表缺失时 best-effort：不阻断 leader 截断，但保持在同一事务内原子提交。
      }
      return leaderChanges + agentChanges;
    }, { immediate: true });
  }

  replaceConversation(sessionId: string, messages: ConversationMessage[]): void {
    const db = this.ensureConnection();
    const deleteStmt = db.prepare('DELETE FROM leader_conversation WHERE session_id = ?');
    const insertStmt = db.prepare(
      `INSERT INTO leader_conversation
       (session_id, role, content, tool_calls, tool_call_id, thinking_blocks, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const now = Date.now() / 1000;
    this.transaction(() => {
      deleteStmt.run(sessionId);
      messages.forEach((message, index) => {
        const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? message.timestamp
          : now + index * 0.001;
        insertStmt.run(
          sessionId,
          message.role,
          this.stringify(message.content),
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id || null,
          message.thinking ? JSON.stringify(message.thinking) : null,
          timestamp
        );
      });
    }, { immediate: true });
  }

  replaceAgentConversation(
    sessionId: string,
    agentId: string,
    agentName: string,
    messages: ConversationMessage[]
  ): void {
    const db = this.ensureConnection();
    const deleteStmt = db.prepare(
      'DELETE FROM agent_conversation WHERE session_id = ? AND agent_id = ?'
    );
    const insertStmt = db.prepare(
      `INSERT INTO agent_conversation
       (session_id, agent_id, agent_name, role, content, tool_calls, tool_call_id, thinking_blocks, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const now = Date.now() / 1000;
    this.transaction(() => {
      deleteStmt.run(sessionId, agentId);
      messages.forEach((message, index) => {
        insertStmt.run(
          sessionId,
          agentId,
          agentName,
          message.role,
          this.stringify(message.content),
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id || null,
          message.thinking ? JSON.stringify(message.thinking) : null,
          now + index * 0.001
        );
      });
    }, { immediate: true });
  }

  // === Agent State ===
  saveAgentState(state: AgentState): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT OR REPLACE INTO agent_state 
       (session_id, agent_id, agent_name, agent_role, task_id, status, stopped, iteration, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      state.session_id,
      state.agent_id,
      state.agent_name,
      state.agent_role,
      state.task_id,
      state.status,
      state.stopped,
      state.iteration,
      state.timestamp
    );
  }

  getAgentStates(sessionId: string): AgentState[] {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT * FROM agent_state WHERE session_id = ?').all(sessionId) as Record<string, unknown>[];
    return rows.map(r => ({
      session_id: String(r.session_id),
      agent_id: String(r.agent_id),
      agent_name: String(r.agent_name),
      agent_role: String(r.agent_role),
      task_id: String(r.task_id),
      status: String(r.status),
      stopped: Number(r.stopped),
      iteration: Number(r.iteration),
      timestamp: Number(r.timestamp),
    }));
  }

  // === Session State ===
  setSessionState(sessionId: string, key: string, value: unknown): void {
    // Dev-only: warn on unknown key namespaces to catch typos/collisions early
    if (process.env.NODE_ENV !== 'production') {
      const known = SESSION_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
      if (!known) {
        coreLogger.warn(`[Database] setSessionState: unknown key namespace "${key}" — consider adding a prefix to SESSION_KEY_PREFIXES`);
      }
    }
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'setSessionState');
    db.prepare(
      'INSERT OR REPLACE INTO session_state (session_id, key, value, timestamp) VALUES (?, ?, ?, ?)'
    ).run(requiredSessionId, key, this.stringifyJson(value, 'session_state.value'), Date.now() / 1000);
  }

  getSessionState(sessionId: string, key: string): unknown | null {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'getSessionState');
    const row = db.prepare('SELECT value FROM session_state WHERE session_id = ? AND key = ?').get(requiredSessionId, key) as { value: string } | undefined;
    if (!row) return null;
    return this.parseJsonValue(row.value, 'session_state.value');
  }

  /**
   * 原子 read-modify-write 更新 session_state。
   * 在 SQLite 事务内执行，防止并发写入丢失更新。
   */
  updateSessionState<T>(
    sessionId: string,
    key: string,
    updater: (current: T | null) => T,
  ): void {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'updateSessionState');
    this.transaction(() => {
      const row = db.prepare(
        'SELECT value FROM session_state WHERE session_id = ? AND key = ?',
      ).get(requiredSessionId, key) as { value: string } | undefined;

      const current: T | null = row ? (this.parseJsonValue(row.value, 'session_state.value') as T) : null;
      const next = updater(current);

      db.prepare(
        'INSERT OR REPLACE INTO session_state (session_id, key, value, timestamp) VALUES (?, ?, ?, ?)',
      ).run(requiredSessionId, key, this.stringifyJson(next, 'session_state.value'), Date.now() / 1000);
    }, { immediate: true });
  }

  listSessionStateByPrefix(sessionId: string, prefix = ''): Array<{ key: string; value: unknown }> {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'listSessionStateByPrefix');
    const rows = prefix
      ? db.prepare(
          'SELECT key, value FROM session_state WHERE session_id = ? AND key LIKE ? ORDER BY timestamp'
        ).all(requiredSessionId, `${prefix}%`)
      : db.prepare(
          'SELECT key, value FROM session_state WHERE session_id = ? ORDER BY timestamp'
        ).all(requiredSessionId);

    return (rows as Array<{ key: string; value: string | null }>).map((row) => ({
      key: row.key,
      value: row.value === null ? null : this.parseJsonValue(row.value, 'session_state.value'),
    }));
  }

  deleteSessionState(sessionId: string, key: string): void {
    const db = this.ensureConnection();
    const requiredSessionId = this.requireSessionId(sessionId, 'deleteSessionState');
    db.prepare('DELETE FROM session_state WHERE session_id = ? AND key = ?').run(requiredSessionId, key);
  }

  // === Workflows ===
  createWorkflow(workflow: { id: string; name: string; description?: string; workspace?: string; nodes?: unknown; edges?: unknown; version?: string; config?: unknown; tags?: unknown; created_by?: string }): void {
    const db = this.ensureConnection();
    const now = Date.now() / 1000;
    db.prepare(
      `INSERT INTO workflows (id, name, description, workspace, nodes, edges, version, config, tags, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      workflow.id,
      workflow.name,
      workflow.description || null,
      workflow.workspace || null,
      workflow.nodes ? this.stringify(workflow.nodes) : '[]',
      workflow.edges ? this.stringify(workflow.edges) : '[]',
      workflow.version || '1.0.0',
      workflow.config ? this.stringify(workflow.config) : null,
      workflow.tags ? this.stringify(workflow.tags) : null,
      workflow.created_by || null,
      now, now,
    );
  }

  getWorkflow(id: string): { id: string; name: string; description: string | null; workspace: string | null; nodes: unknown; edges: unknown; version: string | null; config: unknown; tags: unknown; created_by: string | null; createdAt: number; updatedAt: number } | null {
    const db = this.ensureConnection();
    const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      workspace: row.workspace as string | null,
      nodes: this.tryJsonLoad(row.nodes as string),
      edges: this.tryJsonLoad(row.edges as string),
      version: row.version as string | null,
      config: row.config ? this.tryJsonLoad(row.config as string) : null,
      tags: row.tags ? this.tryJsonLoad(row.tags as string) : null,
      created_by: row.created_by as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  listWorkflows(workspace?: string): Array<{ id: string; name: string; description: string | null; workspace: string | null; updatedAt: number }> {
    const db = this.ensureConnection();
    const rows = workspace
      ? db.prepare('SELECT id, name, description, workspace, updated_at FROM workflows WHERE workspace = ? ORDER BY updated_at DESC').all(workspace)
      : db.prepare('SELECT id, name, description, workspace, updated_at FROM workflows ORDER BY updated_at DESC').all();
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string | null,
      workspace: r.workspace as string | null,
      updatedAt: r.updated_at as number,
    }));
  }

  listWorkflowsFull(workspace?: string): Array<{ id: string; name: string; description: string | null; workspace: string | null; nodes: unknown; edges: unknown; version: string | null; config: unknown; tags: unknown; created_by: string | null; createdAt: number; updatedAt: number }> {
    const db = this.ensureConnection();
    const rows = workspace
      ? db.prepare('SELECT * FROM workflows WHERE workspace = ? ORDER BY updated_at DESC').all(workspace)
      : db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all();
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string | null,
      workspace: r.workspace as string | null,
      nodes: this.tryJsonLoad(r.nodes as string),
      edges: this.tryJsonLoad(r.edges as string),
      version: r.version as string | null,
      config: r.config ? this.tryJsonLoad(r.config as string) : null,
      tags: r.tags ? this.tryJsonLoad(r.tags as string) : null,
      created_by: r.created_by as string | null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }));
  }

  updateWorkflow(id: string, updates: { name?: string; description?: string; workspace?: string; nodes?: unknown; edges?: unknown; config?: unknown; tags?: unknown; version?: string }): boolean {
    const db = this.ensureConnection();
    const existing = db.prepare('SELECT id FROM workflows WHERE id = ?').get(id);
    if (!existing) return false;
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    if (updates.name !== undefined) { sets.push('name = ?'); vals.push(updates.name); }
    if (updates.description !== undefined) { sets.push('description = ?'); vals.push(updates.description); }
    if (updates.workspace !== undefined) { sets.push('workspace = ?'); vals.push(updates.workspace); }
    if (updates.nodes !== undefined) { sets.push('nodes = ?'); vals.push(this.stringify(updates.nodes)); }
    if (updates.edges !== undefined) { sets.push('edges = ?'); vals.push(this.stringify(updates.edges)); }
    if (updates.config !== undefined) { sets.push('config = ?'); vals.push(this.stringify(updates.config)); }
    if (updates.tags !== undefined) { sets.push('tags = ?'); vals.push(this.stringify(updates.tags)); }
    if (updates.version !== undefined) { sets.push('version = ?'); vals.push(updates.version); }
    if (sets.length === 0) return true;
    sets.push('updated_at = ?');
    vals.push(Date.now() / 1000);
    vals.push(id);
    db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
  }

  deleteWorkflow(id: string): boolean {
    const db = this.ensureConnection();
    const result = db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // === Workflow Executions ===
  createWorkflowExecution(execution: { id: string; workflow_id: string; session_id: string; status: string; start_time: number; end_time?: number; context?: unknown; error?: string }): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO workflow_executions (id, workflow_id, session_id, status, start_time, end_time, context, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      execution.id,
      execution.workflow_id,
      execution.session_id,
      execution.status,
      execution.start_time,
      execution.end_time || null,
      execution.context ? this.stringify(execution.context) : null,
      execution.error || null,
      Date.now() / 1000,
    );
  }

  updateWorkflowExecution(id: string, updates: { status?: string; end_time?: number; context?: unknown; error?: string }): boolean {
    const db = this.ensureConnection();
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
    if (updates.end_time !== undefined) { sets.push('end_time = ?'); vals.push(updates.end_time); }
    if (updates.context !== undefined) { sets.push('context = ?'); vals.push(this.stringify(updates.context)); }
    if (updates.error !== undefined) { sets.push('error = ?'); vals.push(updates.error); }
    if (sets.length === 0) return true;
    vals.push(id);
    db.prepare(`UPDATE workflow_executions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return true;
  }

  getWorkflowExecution(id: string): { id: string; workflow_id: string; session_id: string; status: string; start_time: number; end_time: number | null; context: unknown; error: string | null; created_at: number } | null {
    const db = this.ensureConnection();
    const row = db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      workflow_id: row.workflow_id as string,
      session_id: row.session_id as string,
      status: row.status as string,
      start_time: row.start_time as number,
      end_time: row.end_time as number | null,
      context: row.context ? this.tryJsonLoad(row.context as string) : null,
      error: row.error as string | null,
      created_at: row.created_at as number,
    };
  }

  listWorkflowExecutions(workflowId: string, limit = 20): Array<{ id: string; workflow_id: string; session_id: string; status: string; start_time: number; end_time: number | null; error: string | null }> {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT id, workflow_id, session_id, status, start_time, end_time, error FROM workflow_executions WHERE workflow_id = ? ORDER BY start_time DESC LIMIT ?').all(workflowId, limit);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      workflow_id: r.workflow_id as string,
      session_id: r.session_id as string,
      status: r.status as string,
      start_time: r.start_time as number,
      end_time: r.end_time as number | null,
      error: r.error as string | null,
    }));
  }

  createWorkflowExecutionLog(log: { execution_id: string; timestamp: number; level: string; node_id?: string; message: string; data?: unknown }): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO workflow_execution_logs (execution_id, timestamp, level, node_id, message, data)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      log.execution_id,
      log.timestamp,
      log.level,
      log.node_id || null,
      log.message,
      log.data ? this.stringify(log.data) : null,
    );
  }

  getWorkflowExecutionLogs(executionId: string): Array<{ execution_id: string; timestamp: number; level: string; node_id: string | null; message: string; data: unknown }> {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT * FROM workflow_execution_logs WHERE execution_id = ? ORDER BY timestamp ASC').all(executionId);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      execution_id: r.execution_id as string,
      timestamp: r.timestamp as number,
      level: r.level as string,
      node_id: r.node_id as string | null,
      message: r.message as string,
      data: r.data ? this.tryJsonLoad(r.data as string) : null,
    }));
  }

  // === Agent Conversation ===
  saveAgentMessage(sessionId: string, agentId: string, agentName: string, message: { role: string; content: MessageContent; tool_calls?: ToolCall[]; tool_call_id?: string; thinking?: ThinkingBlock[] }): Promise<void> {
    try {
      const db = this.ensureConnection();
      db.prepare(
        `INSERT INTO agent_conversation
         (session_id, agent_id, agent_name, role, content, tool_calls, tool_call_id, thinking_blocks, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        agentId,
        agentName,
        message.role,
        this.stringify(message.content),
        message.tool_calls ? JSON.stringify(message.tool_calls) : null,
        message.tool_call_id || null,
        message.thinking ? JSON.stringify(message.thinking) : null,
        Date.now() / 1000
      );
    } catch (err) {
      // DB 写入失败（SQLITE_BUSY / 连接关闭）不应杀死 worker 或 leader 进程。
      // 丢失单条消息持久化优于整个进程崩溃。
      coreLogger.warn(`[Database] saveAgentMessage failed (${agentName}): ${err instanceof Error ? err.message : String(err)}`);
    }
    return Promise.resolve();
  }

  getAgentConversation(sessionId: string, agentId: string): Promise<Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: MessageContent; tool_calls?: ToolCall[]; tool_call_id?: string; thinking?: ThinkingBlock[]; timestamp?: number }>> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      'SELECT role, content, tool_calls, tool_call_id, thinking_blocks, timestamp FROM agent_conversation WHERE session_id = ? AND agent_id = ? ORDER BY timestamp'
    ).all(sessionId, agentId) as Record<string, unknown>[];
    return Promise.resolve(rows.map(r => {
      const out: { role: 'system' | 'user' | 'assistant' | 'tool'; content: MessageContent; tool_calls?: ToolCall[]; tool_call_id?: string; thinking?: ThinkingBlock[]; timestamp?: number } = {
        role: String(r.role) as 'system' | 'user' | 'assistant' | 'tool',
        content: r.content ? (this.tryMessageContentLoad(String(r.content), 'agent_conversation.content') as MessageContent) : null,
        tool_calls: r.tool_calls
          ? this.ensureToolCallsArgumentsAsJsonString(this.parseJsonArray(String(r.tool_calls), 'agent_conversation.tool_calls'))
          : undefined,
        tool_call_id: r.tool_call_id ? String(r.tool_call_id) : undefined,
        timestamp: r.timestamp != null ? Number(r.timestamp) : undefined,
      };
      if (r.thinking_blocks) {
        out.thinking = this.parseJsonArray(String(r.thinking_blocks), 'agent_conversation.thinking_blocks') as ThinkingBlock[];
      }
      return out;
    }));
  }

  getSessionAgentIds(sessionId: string): Array<{ agentId: string; agentName: string }> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      `SELECT agent_id as agentId, agent_name as agentName
       FROM agent_conversation
       WHERE session_id = ?
       GROUP BY agent_id, agent_name
       ORDER BY MIN(timestamp)`
    ).all(sessionId) as Array<{ agentId: string; agentName: string }>;
    return rows;
  }

  /** 同步版本：一次获取会话所有 agent 的对话消息（用于 TUI 启动时加载历史 tab） */
  getAllAgentConversationsSync(sessionId: string): Array<{
    agentId: string;
    agentName: string;
    agentRole: string;
    messages: Array<{ role: string; content: string; timestamp: number }>;
  }> {
    const db = this.ensureConnection();
    // Build the roster from both state and conversation history. Older rows may
    // have conversation without agent_state, while stopped agents may have state
    // without any visible conversation messages.
    const rows = db.prepare(
      `WITH latest_conversation_agent AS (
         SELECT agent_id, agent_name, timestamp
         FROM (
           SELECT c.agent_id, c.agent_name, c.timestamp,
                  ROW_NUMBER() OVER (PARTITION BY c.agent_id ORDER BY c.timestamp DESC) AS rn
           FROM agent_conversation c
           WHERE c.session_id = ?
         )
         WHERE rn = 1
       ),
       agent_roster AS (
         SELECT s.agent_id, s.agent_name, s.agent_role, s.timestamp AS roster_timestamp, 0 AS source_rank
         FROM agent_state s
         WHERE s.session_id = ?
         UNION ALL
         SELECT c.agent_id, c.agent_name, NULL AS agent_role, c.timestamp AS roster_timestamp, 1 AS source_rank
         FROM latest_conversation_agent c
       ),
       ranked_roster AS (
         SELECT agent_id, agent_name, agent_role
         FROM (
           SELECT r.agent_id, r.agent_name, r.agent_role,
                  ROW_NUMBER() OVER (
                    PARTITION BY r.agent_id
                    ORDER BY r.source_rank ASC, r.roster_timestamp DESC
                  ) AS rn
           FROM agent_roster r
         )
         WHERE rn = 1
       )
       SELECT r.agent_id, r.agent_name, r.agent_role,
              c.role, c.content, c.timestamp
       FROM ranked_roster r
       LEFT JOIN agent_conversation c ON c.session_id = ? AND r.agent_id = c.agent_id
       ORDER BY r.agent_id, c.timestamp ASC`
    ).all(sessionId, sessionId, sessionId) as Array<{
      agent_id: string; agent_name: string; agent_role?: string;
      role?: string; content?: string; timestamp?: number;
    }>;

    // Group by agent in memory
    const agentMap = new Map<string, {
      agentId: string; agentName: string; agentRole: string;
      messages: Array<{ role: string; content: string; timestamp: number }>;
    }>();

    for (const row of rows) {
      if (!agentMap.has(row.agent_id)) {
        agentMap.set(row.agent_id, {
          agentId: row.agent_id,
          agentName: row.agent_name,
          agentRole: row.agent_role || 'worker',
          messages: [],
        });
      }
      if (row.role && row.content) {
        const parsed = this.tryMessageContentLoad(row.content, 'agent_conversation.content');
        const text = parsedConversationText(parsed, row.content);
        const agent = agentMap.get(row.agent_id)!;
        if (text.trim().length > 0) {
          agent.messages.push({ role: row.role, content: text, timestamp: row.timestamp || 0 });
        }
      }
    }

    return Array.from(agentMap.values());
  }

  getRecentMultimodalMessages(sessionId: string, limit: number): Promise<Array<{ role: string; content: unknown }>> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      `SELECT role, content FROM leader_conversation
       WHERE session_id = ?
       ORDER BY timestamp DESC LIMIT ?`
    ).all(sessionId, limit * 5) as Record<string, unknown>[];

    const multimodal = rows
      .map((row) => ({
        role: String(row.role),
        content: this.tryMessageContentLoad(String(row.content), 'leader_conversation.content'),
      }))
      .filter((row) =>
        Array.isArray(row.content) &&
        row.content.some(
          (part) =>
            part &&
            typeof part === 'object' &&
            'type' in part &&
            ((part as { type?: string }).type === 'image_url'
              || (part as { type?: string }).type === 'image_blob_ref'
              || (part as { type?: string }).type === 'document')
        )
      )
      .slice(0, limit);

    return Promise.resolve(multimodal);
  }


  // === Scheduled Tasks ===

  private normalizeScheduledBoolean(value: unknown): boolean {
    return value === true || value === 1 || value === '1';
  }

  private normalizeScheduledTimestamp(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  private normalizeScheduledTaskType(value: unknown): ScheduledTaskType {
    return value === 'workflow' ? 'workflow' : 'prompt';
  }

  private normalizeScheduledIntensity(value: unknown): ScheduledTaskIntensity {
    const s = String(value ?? 'normal');
    if (s === 'gentle' || s === 'normal' || s === 'aggressive' || s === 'critical') return s;
    return 'normal';
  }

  private normalizeScheduledAudience(value: unknown): ScheduledTaskAudience {
    const s = String(value ?? 'personal');
    if (s === 'personal' || s === 'team' || s === 'ops' || s === 'customer') return s;
    return 'personal';
  }

  private normalizeScheduledSourceType(value: unknown): ScheduledTaskSourceType | null {
    return value === 'workflow_trigger' ? 'workflow_trigger' : null;
  }

  private normalizeScheduledWorkflowInput(value: unknown): Record<string, unknown> | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'string' ? this.tryJsonLoad(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }

  private normalizeScheduledTaskRow(r: Record<string, unknown>): ScheduledTaskRecord {
    return {
      id: String(r.id),
      session_id: String(r.session_id),
      cron: String(r.cron),
      prompt: String(r.prompt ?? ''),
      recurring: this.normalizeScheduledBoolean(r.recurring),
      durable: this.normalizeScheduledBoolean(r.durable),
      enabled: this.normalizeScheduledBoolean(r.enabled),
      last_run_at: this.normalizeScheduledTimestamp(r.last_run_at),
      next_run_at: this.normalizeScheduledTimestamp(r.next_run_at),
      created_at: Number(r.created_at),
      task_type: this.normalizeScheduledTaskType(r.task_type),
      intensity: this.normalizeScheduledIntensity(r.intensity),
      audience: this.normalizeScheduledAudience(r.audience),
      workflow_id: r.workflow_id ? String(r.workflow_id) : null,
      workflow_input: this.normalizeScheduledWorkflowInput(r.workflow_input),
      last_execution_id: r.last_execution_id ? String(r.last_execution_id) : null,
      last_error: r.last_error ? String(r.last_error) : null,
      source_type: this.normalizeScheduledSourceType(r.source_type),
      source_id: r.source_id ? String(r.source_id) : null,
      source_node_id: r.source_node_id ? String(r.source_node_id) : null,
    };
  }

  private serializeScheduledNextRun(value: number | null | undefined): number | null {
    if (!value || !Number.isFinite(value)) return null;
    return value > 100_000_000_000 ? value / 1000 : value;
  }

  insertScheduledTask(task: {
    id: string;
    session_id: string;
    cron: string;
    prompt?: string;
    recurring: boolean;
    durable: boolean;
    enabled?: boolean;
    next_run_at: number | null;
    task_type?: ScheduledTaskType;
    intensity?: ScheduledTaskIntensity;
    audience?: ScheduledTaskAudience;
    workflow_id?: string | null;
    workflow_input?: Record<string, unknown> | null;
    source_type?: ScheduledTaskSourceType | null;
    source_id?: string | null;
    source_node_id?: string | null;
  }): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO scheduled_tasks (
         id, session_id, cron, prompt, task_type, intensity, audience, workflow_id, workflow_input,
         source_type, source_id, source_node_id, recurring, durable, enabled, next_run_at, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      task.session_id,
      task.cron,
      task.prompt ?? '',
      task.task_type ?? 'prompt',
      task.intensity ?? 'normal',
      task.audience ?? 'personal',
      task.workflow_id ?? null,
      task.workflow_input ? JSON.stringify(task.workflow_input) : null,
      task.source_type ?? null,
      task.source_id ?? null,
      task.source_node_id ?? null,
      task.recurring ? 1 : 0,
      task.durable ? 1 : 0,
      task.enabled === false ? 0 : 1,
      this.serializeScheduledNextRun(task.next_run_at),
      Date.now() / 1000,
    );
  }

  updateScheduledTaskDefinition(task: {
    id: string;
    session_id: string;
    cron: string;
    prompt?: string;
    recurring: boolean;
    durable: boolean;
    enabled?: boolean;
    next_run_at: number | null;
    task_type?: ScheduledTaskType;
    intensity?: ScheduledTaskIntensity;
    audience?: ScheduledTaskAudience;
    workflow_id?: string | null;
    workflow_input?: Record<string, unknown> | null;
    source_type?: ScheduledTaskSourceType | null;
    source_id?: string | null;
    source_node_id?: string | null;
  }): void {
    const db = this.ensureConnection();
    db.prepare(
      `UPDATE scheduled_tasks
       SET session_id = ?,
           cron = ?,
           prompt = ?,
           task_type = ?,
           intensity = ?,
           audience = ?,
           workflow_id = ?,
           workflow_input = ?,
           source_type = ?,
           source_id = ?,
           source_node_id = ?,
           recurring = ?,
           durable = ?,
           enabled = ?,
           next_run_at = ?
       WHERE id = ?`
    ).run(
      task.session_id,
      task.cron,
      task.prompt ?? '',
      task.task_type ?? 'prompt',
      task.intensity ?? 'normal',
      task.audience ?? 'personal',
      task.workflow_id ?? null,
      task.workflow_input ? JSON.stringify(task.workflow_input) : null,
      task.source_type ?? null,
      task.source_id ?? null,
      task.source_node_id ?? null,
      task.recurring ? 1 : 0,
      task.durable ? 1 : 0,
      task.enabled === false ? 0 : 1,
      this.serializeScheduledNextRun(task.next_run_at),
      task.id,
    );
  }

  getScheduledTasks(sessionId: string): ScheduledTaskRecord[] {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.normalizeScheduledTaskRow(r));
  }

  getScheduledTasksBySource(sourceType: ScheduledTaskSourceType, sourceId: string): ScheduledTaskRecord[] {
    const db = this.ensureConnection();
    const rows = db.prepare(
      'SELECT * FROM scheduled_tasks WHERE source_type = ? AND source_id = ? ORDER BY created_at DESC',
    ).all(sourceType, sourceId) as Record<string, unknown>[];
    return rows.map((r) => this.normalizeScheduledTaskRow(r));
  }

  getScheduledTaskBySourceNode(sourceType: ScheduledTaskSourceType, sourceId: string, sourceNodeId: string): ScheduledTaskRecord | null {
    const db = this.ensureConnection();
    const row = db.prepare(
      'SELECT * FROM scheduled_tasks WHERE source_type = ? AND source_id = ? AND source_node_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(sourceType, sourceId, sourceNodeId) as Record<string, unknown> | undefined;
    return row ? this.normalizeScheduledTaskRow(row) : null;
  }

  getAllDueScheduledTasks(): ScheduledTaskRecord[] {
    const db = this.ensureConnection();
    const now = Date.now() / 1000;
    const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now) as Record<string, unknown>[];
    return rows.map((r) => this.normalizeScheduledTaskRow(r));
  }

  updateScheduledTaskRun(id: string, lastRunAt: number, nextRunAt: number | null): void {
    const db = this.ensureConnection();
    if (nextRunAt) {
      db.prepare('UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(lastRunAt, this.serializeScheduledNextRun(nextRunAt), id);
    } else {
      db.prepare('UPDATE scheduled_tasks SET last_run_at = ?, enabled = 0 WHERE id = ?').run(lastRunAt, id);
    }
  }

  updateScheduledTaskExecution(id: string, executionId: string | null, error?: string | null): void {
    const db = this.ensureConnection();
    db.prepare('UPDATE scheduled_tasks SET last_execution_id = ?, last_error = ? WHERE id = ?').run(executionId, error ?? null, id);
  }

  updateScheduledTaskError(id: string, error: string | null): void {
    const db = this.ensureConnection();
    db.prepare('UPDATE scheduled_tasks SET last_error = ? WHERE id = ?').run(error, id);
  }

  deleteScheduledTask(id: string): void {
    const db = this.ensureConnection();
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  deleteScheduledTasksBySource(sourceType: ScheduledTaskSourceType, sourceId: string): void {
    const db = this.ensureConnection();
    db.prepare('DELETE FROM scheduled_tasks WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
  }

  deleteScheduledTaskBySourceNode(sourceType: ScheduledTaskSourceType, sourceId: string, sourceNodeId: string): void {
    const db = this.ensureConnection();
    db.prepare('DELETE FROM scheduled_tasks WHERE source_type = ? AND source_id = ? AND source_node_id = ?').run(sourceType, sourceId, sourceNodeId);
  }

  getAllScheduledTasks(): ScheduledTaskRecord[] {
    const db = this.ensureConnection();
    const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.normalizeScheduledTaskRow(r));
  }

  getScheduledTaskById(id: string): ScheduledTaskRecord | null {
    const db = this.ensureConnection();
    const r = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.normalizeScheduledTaskRow(r);
  }

  toggleScheduledTask(id: string, enabled: boolean): void {
    const db = this.ensureConnection();
    db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  deleteSession(sessionId: string): void {
    const db = this.ensureConnection();
    const tables = [
      'tasks',
      'messages',
      'agent_logs',
      'token_usage',
      'leader_conversation',
      'agent_conversation',
      'agent_state',
      'session_state',
      'workflows',
      'scheduled_tasks',
      'graph_nodes',
      'graph_edges',
      'sessions',
    ];

    this.transaction(() => {
      for (const table of tables) {
        try {
          const column = table === 'sessions' ? 'id' : 'session_id';
          db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(sessionId);
        } catch {
          // 删除会话不因单表异常阻断其他表清理。
        }
      }
    }, { immediate: true });
  }

  // === Tool Registration ===
  saveToolRegistration(sessionId: string, toolName: string, toolData: {
    type: string;
    description: string;
    schema?: string;
  }): void {
    const db = this.ensureConnection();
    db.prepare(
      `INSERT INTO tool_registrations (session_id, tool_name, tool_type, tool_description, tool_schema, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, tool_name) DO UPDATE SET
         tool_type = excluded.tool_type,
         tool_description = excluded.tool_description,
         tool_schema = excluded.tool_schema,
         registered_at = excluded.registered_at`
    ).run(sessionId, toolName, toolData.type, toolData.description, toolData.schema || '{}', Date.now());
  }

  loadToolRegistrations(sessionId: string): Array<{
    tool_name: string;
    tool_type: string;
    tool_description: string;
    tool_schema: string;
  }> {
    const db = this.ensureConnection();
    const rows = db.prepare(
      'SELECT tool_name, tool_type, tool_description, tool_schema FROM tool_registrations WHERE session_id = ? ORDER BY registered_at'
    ).all(sessionId) as Array<Record<string, string>>;
    return rows.map(r => ({
      tool_name: r.tool_name,
      tool_type: r.tool_type,
      tool_description: r.tool_description,
      tool_schema: r.tool_schema,
    }));
  }

  deleteToolRegistration(sessionId: string, toolName: string): void {
    const db = this.ensureConnection();
    db.prepare(
      'DELETE FROM tool_registrations WHERE session_id = ? AND tool_name = ?'
    ).run(sessionId, toolName);
  }

  clearToolRegistrations(sessionId: string): void {
    const db = this.ensureConnection();
    db.prepare('DELETE FROM tool_registrations WHERE session_id = ?').run(sessionId);
  }

  /**
   * 删除超过 maxAgeHours 小时的旧审计/日志记录,防止数据库无限增长(#2)。
   * 覆盖高写入量表:agent_logs / token_usage / messages 用 timestamp;
   * llm_gateway_requests / execution_trace_events 用 created_at。均为 epoch 秒。
   * 注:leader_conversation / agent_conversation 是会话 resume 源(replaceConversation),
   * 按时修剪会破坏旧会话恢复,故不纳入;其增长由 per-session replace 限制。
   * VACUUM 仅在实际删除了行时执行(全量重写昂贵,不应每轮清理都跑)。
   */
  pruneOldRecords(maxAgeHours: number = 48): number {
    const db = this.ensureConnection();
    const cutoff = Date.now() / 1000 - maxAgeHours * 3600;
    let totalDeleted = 0;

    // 表名/列名为静态字面量(非用户输入),无注入风险。
    const tables: Array<{ name: string; timeColumn: string }> = [
      { name: 'agent_logs', timeColumn: 'timestamp' },
      { name: 'token_usage', timeColumn: 'timestamp' },
      { name: 'messages', timeColumn: 'timestamp' },
      { name: 'llm_gateway_requests', timeColumn: 'created_at' },
      { name: 'execution_trace_events', timeColumn: 'created_at' },
    ];
    this.transaction(() => {
      for (const { name, timeColumn } of tables) {
        try {
          const result = db.prepare(`DELETE FROM ${name} WHERE ${timeColumn} < ?`).run(cutoff);
          totalDeleted += Number(result.changes);
        } catch {
          // 表/列不存在时跳过(旧库迁移、feature flag 关闭的表)
        }
      }
    }, { immediate: true });

    // 仅在实际删除了行时 VACUUM 回收空间(全量重写昂贵,不应每轮清理都跑)
    if (totalDeleted > 0) {
      try {
        db.exec('VACUUM');
      } catch {
        // VACUUM 失败不影响主流程
      }
    }

    return totalDeleted;
  }
}

export default DatabaseManager;
