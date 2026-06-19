/**
 * DatabaseRepositories.ts — repository-facing access to DatabaseManager.
 *
 * The adapter exposes focused SessionRepository, TaskRepository, and
 * MessageRepository interfaces while DatabaseManager remains the single
 * owner of the sqlite schema.
 */

import type { MessageContent } from '../contracts/types/Message.js';
import type { OrchestrationTaskMetadata } from './OrchestrationTypes.js';
import type {
  AgentLog,
  WorktreeRecord,
  ScheduledTaskRecord,
  LlmGatewayRequestRecord,
} from './Database.js';

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  created_at: number;
  workspace: string;
  user_request: MessageContent | object;
  status: string;
  summary?: string;
  name?: string;
}

export interface TaskRecord {
  id: string;
  session_id: string;
  subject: string;
  description: string | object;
  context?: string;
  status: string;
  exit_reason?: string;
  run_generation?: number;
  agent_type: string;
  blocked_by: string[];
  blocks: string[];
  assigned_agent: string;
  preferred_agent_name?: string;
  working_directory?: string;
  write_scope?: string[];
  result?: string | object;
  orchestration?: OrchestrationTaskMetadata;
  origin?: string;
  goal?: string;
  taskType?: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRecord {
  id?: number;
  session_id: string;
  sender: string;
  recipient: string;
  content: string | object | null;
  timestamp: number;
}
export interface ConversationMessageRecord {
  role: string;
  content: MessageContent | object;
  tool_calls?: unknown[];
  tool_call_id?: string;
  thinking?: unknown[];
  timestamp?: number;
  source?: string;
}

export interface SessionRepository {
  insert(id: string, workspace: string, userRequest: string | object | null): void;
  get(id: string): SessionRecord | null;
  list(): SessionRecord[];
  getLastActive(): SessionRecord | null;
  updateStatus(id: string, status: string, summary?: string): void;
  updateName(id: string, name: string): void;
  delete(id: string): void;
}

export interface TaskRepository {
  insert(task: TaskRecord): void;
  update(task: TaskRecord): void;
  delete(id: string, sessionId: string): void;
  get(id: string, sessionId: string): TaskRecord | undefined;
  listBySession(sessionId: string): TaskRecord[];
}

export interface ToolStatRow {
  name: string;
  callCount: number;
  lastUsed: number;
}

export interface MessageRepository {
  insert(msg: MessageRecord): void;
  listBySession(sessionId: string): Array<{
    sender: string;
    recipient: string;
    content: string | unknown;
    timestamp: number;
  }>;
  saveConversation(sessionId: string, message: ConversationMessageRecord): void;
  getConversation(sessionId: string): ConversationMessageRecord[];
  getConversationMessages(sessionId: string, role?: string): ConversationMessageRecord[];
  clearConversation(sessionId: string): void;
  truncateAfter(sessionId: string, timestamp: number): number;
  replaceConversation(sessionId: string, messages: ConversationMessageRecord[]): void;
  getToolStats(): ToolStatRow[];
}

// ---------------------------------------------------------------------------
// Concrete implementations delegating to DatabaseManager
// ---------------------------------------------------------------------------
/**
 * SessionRepositoryAdapter — delegates SessionRepository to DatabaseManager methods.
 */
class SessionRepositoryAdapter implements SessionRepository {
  constructor(private db: any) {}

  insert(id: string, workspace: string, userRequest: string | object | null): void {
    this.db.insertSession(id, workspace, userRequest);
  }

  get(id: string): SessionRecord | null {
    return this.db.getSession(id) as SessionRecord | null;
  }

  list(): SessionRecord[] {
    return this.db.listSessions() as SessionRecord[];
  }

  getLastActive(): SessionRecord | null {
    return this.db.getLastActiveSession() as SessionRecord | null;
  }

  updateStatus(id: string, status: string, summary?: string): void {
    this.db.updateSessionStatus(id, status, summary);
  }

  updateName(id: string, name: string): void {
    this.db.updateSessionName(id, name);
  }

  delete(id: string): void {
    this.db.deleteSession(id);
  }
}

/**
 * TaskRepositoryAdapter — delegates TaskRepository to DatabaseManager methods.
 */
class TaskRepositoryAdapter implements TaskRepository {
  constructor(private db: any) {}

  insert(task: TaskRecord): void {
    this.db.insertTask(task);
  }

  update(task: TaskRecord): void {
    this.db.updateTask(task);
  }

  delete(id: string, sessionId: string): void {
    this.db.deleteTask(id, sessionId);
  }

  get(id: string, sessionId: string): TaskRecord | undefined {
    return this.db.getTask(id, sessionId) as TaskRecord | undefined;
  }
  listBySession(sessionId: string): TaskRecord[] {
    return this.db.getTasksBySession(sessionId) as TaskRecord[];
  }
}

/**
 * MessageRepositoryAdapter — delegates MessageRepository to DatabaseManager methods.
 * Maps inter-agent messages (messages table) and leader conversation
 * (leader_conversation table) through the same interface.
 */
class MessageRepositoryAdapter implements MessageRepository {
  constructor(private db: any) {}

  insert(msg: MessageRecord): void {
    this.db.insertMessage(msg);
  }

  listBySession(sessionId: string): Array<{
    sender: string;
    recipient: string;
    content: string | unknown;
    timestamp: number;
  }> {
    return this.db.getMessages(sessionId);
  }

  saveConversation(sessionId: string, message: ConversationMessageRecord): void {
    this.db.saveConversationMessage(sessionId, message);
  }

  getConversation(sessionId: string): ConversationMessageRecord[] {
    return this.db.getConversation(sessionId) as ConversationMessageRecord[];
  }

  getConversationMessages(sessionId: string, role?: string): ConversationMessageRecord[] {
    return this.db.getConversationMessages(sessionId, role) as ConversationMessageRecord[];
  }

  clearConversation(sessionId: string): void {
    this.db.clearConversation(sessionId);
  }

  truncateAfter(sessionId: string, timestamp: number): number {
    return this.db.truncateConversationAfter(sessionId, timestamp);
  }

  replaceConversation(sessionId: string, messages: ConversationMessageRecord[]): void {
    this.db.replaceConversation(sessionId, messages);
  }

  getToolStats(): ToolStatRow[] {
    return this.db.getToolStats();
  }
}

export interface SessionStateRepository {
  set(sessionId: string, key: string, value: unknown): void;
  get(sessionId: string, key: string): unknown | null;
  update<T>(sessionId: string, key: string, updater: (current: T | null) => T): void;
  listByPrefix(sessionId: string, prefix?: string): Array<{ key: string; value: unknown }>;
  delete(sessionId: string, key: string): void;
}

class SessionStateRepositoryAdapter implements SessionStateRepository {
  constructor(private db: any) {}

  set(sessionId: string, key: string, value: unknown): void {
    this.db.setSessionState(sessionId, key, value);
  }

  get(sessionId: string, key: string): unknown | null {
    return this.db.getSessionState(sessionId, key);
  }

  update<T>(sessionId: string, key: string, updater: (current: T | null) => T): void {
    this.db.updateSessionState(sessionId, key, updater);
  }

  listByPrefix(sessionId: string, prefix?: string): Array<{ key: string; value: unknown }> {
    return this.db.listSessionStateByPrefix(sessionId, prefix);
  }

  delete(sessionId: string, key: string): void {
    this.db.deleteSessionState(sessionId, key);
  }
}

// ---------------------------------------------------------------------------
// AgentStateRepository
// ---------------------------------------------------------------------------

export interface AgentStateRecord {
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

export interface AgentStateRepository {
  save(state: AgentStateRecord): void;
  listBySession(sessionId: string): AgentStateRecord[];
}

class AgentStateRepositoryAdapter implements AgentStateRepository {
  constructor(private db: any) {}

  save(state: AgentStateRecord): void {
    this.db.saveAgentState(state);
  }

  listBySession(sessionId: string): AgentStateRecord[] {
    return this.db.getAgentStates(sessionId);
  }
}

// ---------------------------------------------------------------------------
// TokenUsageRepository
// ---------------------------------------------------------------------------

export interface TokenSummaryRow {
  agent_id: string;
  agent_name: string;
  prompt: number;
  completion: number;
  total: number;
  cache_read: number;
  cache_creation: number;
}

export interface AgentStatRow {
  agentId: string;
  agentName: string;
  modelName: string;
  callCount: number;
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
}

export interface TokenUsageRepository {
  insert(sessionId: string, agentId: string, agentName: string, prompt: number, completion: number, total: number, modelName?: string, cacheRead?: number, cacheCreation?: number): void;
  insertGatewayRequest(record: LlmGatewayRequestRecord): void;
  getSummary(sessionId: string): TokenSummaryRow[];
  getBySession(sessionId: string): Array<{ agent_id: string; prompt: number; completion: number; total: number; cache_read: number; cache_creation: number }>;
  getModelStats(): Array<{ sessionId: string; name: string; callCount: number; totalPrompt: number; totalCompletion: number; totalTokens: number; cacheRead: number; cacheCreation: number }>;
  getModelStatsAggregated(): Array<{ name: string; callCount: number; sessionCount: number; totalPrompt: number; totalCompletion: number; totalTokens: number; cacheRead: number; cacheCreation: number }>;
  getAgentStats(): AgentStatRow[];
}

class TokenUsageRepositoryAdapter implements TokenUsageRepository {
  constructor(private db: any) {}

  insert(sessionId: string, agentId: string, agentName: string, prompt: number, completion: number, total: number, modelName?: string, cacheRead?: number, cacheCreation?: number): void {
    this.db.insertTokenUsage(sessionId, agentId, agentName, prompt, completion, total, modelName, cacheRead, cacheCreation);
  }

  insertGatewayRequest(record: LlmGatewayRequestRecord): void {
    this.db.insertLlmGatewayRequest(record);
  }

  getSummary(sessionId: string): TokenSummaryRow[] {
    return this.db.getTokenSummary(sessionId);
  }

  getBySession(sessionId: string): Array<{ agent_id: string; prompt: number; completion: number; total: number; cache_read: number; cache_creation: number }> {
    return this.db.getTokenUsageBySession(sessionId);
  }

  getModelStats() {
    return this.db.getModelStats();
  }

  getModelStatsAggregated() {
    return this.db.getModelStatsAggregated();
  }

  getAgentStats(): AgentStatRow[] {
    return this.db.getAgentStats();
  }
}

// ---------------------------------------------------------------------------
// WorktreeRepository
// ---------------------------------------------------------------------------

export interface WorktreeRepository {
  upsert(record: WorktreeRecord): void;
  get(id: string): WorktreeRecord | null;
  getByPath(path: string): WorktreeRecord | null;
  list(filters?: { repoRoot?: string; sessionId?: string; taskId?: string; includeRemoved?: boolean }): WorktreeRecord[];
  attachSession(id: string, sessionId: string | null): void;
  updateStatus(id: string, status: string, lastError?: string | null): void;
}

class WorktreeRepositoryAdapter implements WorktreeRepository {
  constructor(private db: any) {}

  upsert(record: WorktreeRecord): void {
    this.db.upsertWorktree(record);
  }

  get(id: string): WorktreeRecord | null {
    return this.db.getWorktree(id);
  }

  getByPath(path: string): WorktreeRecord | null {
    return this.db.getWorktreeByPath(path);
  }

  list(filters?: { repoRoot?: string; sessionId?: string; taskId?: string; includeRemoved?: boolean }): WorktreeRecord[] {
    return this.db.listWorktrees(filters);
  }

  attachSession(id: string, sessionId: string | null): void {
    this.db.attachWorktreeSession(id, sessionId);
  }

  updateStatus(id: string, status: string, lastError?: string | null): void {
    this.db.updateWorktreeStatus(id, status, lastError);
  }
}

// ---------------------------------------------------------------------------
// ScheduledTaskRepository
// ---------------------------------------------------------------------------

export interface ScheduledTaskInsertParams {
  id: string;
  session_id: string;
  cron: string;
  prompt?: string;
  recurring: boolean;
  durable: boolean;
  enabled?: boolean;
  next_run_at: number | null;
  task_type?: string;
  intensity?: string;
  audience?: string;
  workflow_id?: string | null;
  workflow_input?: Record<string, unknown> | null;
  source_type?: string | null;
  source_id?: string | null;
  source_node_id?: string | null;
}

export interface ScheduledTaskRepository {
  insert(task: ScheduledTaskInsertParams): void;
  updateDefinition(task: ScheduledTaskInsertParams): void;
  getBySession(sessionId: string): ScheduledTaskRecord[];
  getById(id: string): ScheduledTaskRecord | null;
  getAll(): ScheduledTaskRecord[];
  getAllDue(): ScheduledTaskRecord[];
  getBySource(sourceType: string, sourceId: string): ScheduledTaskRecord[];
  getBySourceNode(sourceType: string, sourceId: string, sourceNodeId: string): ScheduledTaskRecord | null;
  updateRun(id: string, lastRunAt: number, nextRunAt: number | null): void;
  updateExecution(id: string, executionId: string | null, error?: string | null): void;
  updateError(id: string, error: string | null): void;
  toggle(id: string, enabled: boolean): void;
  delete(id: string): void;
  deleteBySource(sourceType: string, sourceId: string): void;
  deleteBySourceNode(sourceType: string, sourceId: string, sourceNodeId: string): void;
}

class ScheduledTaskRepositoryAdapter implements ScheduledTaskRepository {
  constructor(private db: any) {}

  insert(task: any): void { this.db.insertScheduledTask(task); }
  updateDefinition(task: any): void { this.db.updateScheduledTaskDefinition(task); }
  getBySession(sessionId: string): ScheduledTaskRecord[] { return this.db.getScheduledTasks(sessionId); }
  getById(id: string): ScheduledTaskRecord | null { return this.db.getScheduledTaskById(id); }
  getAll(): ScheduledTaskRecord[] { return this.db.getAllScheduledTasks(); }
  getAllDue(): ScheduledTaskRecord[] { return this.db.getAllDueScheduledTasks(); }
  getBySource(sourceType: string, sourceId: string): ScheduledTaskRecord[] { return this.db.getScheduledTasksBySource(sourceType, sourceId); }
  getBySourceNode(sourceType: string, sourceId: string, sourceNodeId: string): ScheduledTaskRecord | null { return this.db.getScheduledTaskBySourceNode(sourceType, sourceId, sourceNodeId); }
  updateRun(id: string, lastRunAt: number, nextRunAt: number | null): void { this.db.updateScheduledTaskRun(id, lastRunAt, nextRunAt); }
  updateExecution(id: string, executionId: string | null, error?: string | null): void { this.db.updateScheduledTaskExecution(id, executionId, error); }
  updateError(id: string, error: string | null): void { this.db.updateScheduledTaskError(id, error); }
  toggle(id: string, enabled: boolean): void { this.db.toggleScheduledTask(id, enabled); }
  delete(id: string): void { this.db.deleteScheduledTask(id); }
  deleteBySource(sourceType: string, sourceId: string): void { this.db.deleteScheduledTasksBySource(sourceType, sourceId); }
  deleteBySourceNode(sourceType: string, sourceId: string, sourceNodeId: string): void { this.db.deleteScheduledTaskBySourceNode(sourceType, sourceId, sourceNodeId); }
}

// ---------------------------------------------------------------------------
// AgentLogRepository
// ---------------------------------------------------------------------------

export interface AgentLogRepository {
  insert(log: AgentLog): void;
  listBySession(sessionId: string, agentId?: string): AgentLog[];
}

class AgentLogRepositoryAdapter implements AgentLogRepository {
  constructor(private db: any) {}

  insert(log: AgentLog): void {
    this.db.insertAgentLog(log);
  }

  listBySession(sessionId: string, agentId?: string): AgentLog[] {
    return this.db.getAgentLogs(sessionId, agentId);
  }
}

// ---------------------------------------------------------------------------
// AgentConversationRepository
// ---------------------------------------------------------------------------

export interface AgentConversationRepository {
  save(sessionId: string, agentId: string, agentName: string, message: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string; thinking?: unknown[] }): void;
  get(sessionId: string, agentId: string): Promise<Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string; thinking?: unknown[]; timestamp?: number }>>;
  replace(sessionId: string, agentId: string, agentName: string, messages: ConversationMessageRecord[]): void;
  getSessionAgentIds(sessionId: string): Array<{ agentId: string; agentName: string }>;
  getAllSync(sessionId: string): Array<{ agentId: string; agentName: string; agentRole: string; messages: Array<{ role: string; content: string; timestamp: number }> }>;
}

class AgentConversationRepositoryAdapter implements AgentConversationRepository {
  constructor(private db: any) {}

  save(sessionId: string, agentId: string, agentName: string, message: any): void {
    this.db.saveAgentMessage(sessionId, agentId, agentName, message);
  }

  get(sessionId: string, agentId: string) {
    return this.db.getAgentConversation(sessionId, agentId);
  }

  replace(sessionId: string, agentId: string, agentName: string, messages: ConversationMessageRecord[]): void {
    this.db.replaceAgentConversation(sessionId, agentId, agentName, messages);
  }

  getSessionAgentIds(sessionId: string): Array<{ agentId: string; agentName: string }> {
    return this.db.getSessionAgentIds(sessionId);
  }

  getAllSync(sessionId: string) {
    return this.db.getAllAgentConversationsSync(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Main adapter — single entry point
// ---------------------------------------------------------------------------

// Re-export types consumers may need
export type { AgentLog, WorktreeRecord, ScheduledTaskRecord, LlmGatewayRequestRecord } from './Database.js';

/**
 * DatabaseRepositoryAdapter wraps the DatabaseManager instance and exposes
 * repository interfaces used by runtime and web modules.
 */
export class DatabaseRepositoryAdapter {
  private _sessions: SessionRepository;
  private _tasks: TaskRepository;
  private _messages: MessageRepository;
  private _sessionState: SessionStateRepository;
  private _agentState: AgentStateRepository;
  private _tokenUsage: TokenUsageRepository;
  private _worktrees: WorktreeRepository;
  private _scheduledTasks: ScheduledTaskRepository;
  private _agentLogs: AgentLogRepository;
  private _agentConversation: AgentConversationRepository;

  constructor(private db: any) {
    this._sessions = new SessionRepositoryAdapter(db);
    this._tasks = new TaskRepositoryAdapter(db);
    this._messages = new MessageRepositoryAdapter(db);
    this._sessionState = new SessionStateRepositoryAdapter(db);
    this._agentState = new AgentStateRepositoryAdapter(db);
    this._tokenUsage = new TokenUsageRepositoryAdapter(db);
    this._worktrees = new WorktreeRepositoryAdapter(db);
    this._scheduledTasks = new ScheduledTaskRepositoryAdapter(db);
    this._agentLogs = new AgentLogRepositoryAdapter(db);
    this._agentConversation = new AgentConversationRepositoryAdapter(db);
  }

  get sessions(): SessionRepository { return this._sessions; }
  get tasks(): TaskRepository { return this._tasks; }
  get messages(): MessageRepository { return this._messages; }
  get sessionState(): SessionStateRepository { return this._sessionState; }
  get agentState(): AgentStateRepository { return this._agentState; }
  get tokenUsage(): TokenUsageRepository { return this._tokenUsage; }
  get worktrees(): WorktreeRepository { return this._worktrees; }
  get scheduledTasks(): ScheduledTaskRepository { return this._scheduledTasks; }
  get agentLogs(): AgentLogRepository { return this._agentLogs; }
  get agentConversation(): AgentConversationRepository { return this._agentConversation; }

  /**
   * Direct DatabaseManager access for modules that need explicit sqlite
   * transactions or specialized queries.
   */
  get raw(): any {
    return this.db;
  }

  /** Transaction wrapper — delegates to DatabaseManager.transaction() */
  transaction<T>(fn: () => T, options?: { immediate?: boolean; retries?: number }): T {
    return this.db.transaction(fn, options);
  }
}
