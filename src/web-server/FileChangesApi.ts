/**
 * FileChangesApi — 文件变更与检查点 API
 *
 * 对接 GitService，提供 checkpoints / diff / revert 接口
 */

import { GitService, type Checkpoint, type FileDiff } from './GitService.js';
import type { DatabaseRepositoryAdapter, AgentLog } from '../core/DatabaseRepositories.js';

/** Parse [turn:N] [tool] / [turn:N] Turn labels to extract metadata */
function parseCheckpointLabel(message: string): Pick<Checkpoint, 'turnNumber' | 'toolName' | 'type' | 'actorType' | 'agentName' | 'taskId'> {
  // Strip [session:xxx] prefix
  const stripped = message.replace(/^\[session:[^\]]+\]\s*/, '');

  const agentToolMatch = stripped.match(/^\[agent:([^\]]+)\]\s*(?:\[task:([^\]]+)\]\s*)?\[tool\]\s*Auto:\s*(.+)$/);
  if (agentToolMatch) {
    return {
      type: 'tool',
      toolName: agentToolMatch[3].trim(),
      actorType: 'agent',
      agentName: agentToolMatch[1].trim(),
      taskId: agentToolMatch[2]?.trim(),
    };
  }

  const toolMatch = stripped.match(/^\[turn:(\d+)\]\s*\[tool\]\s*Auto:\s*(.+)$/);
  if (toolMatch) {
    return {
      turnNumber: parseInt(toolMatch[1], 10),
      toolName: toolMatch[2].trim(),
      type: 'tool',
      actorType: 'leader',
    };
  }

  const turnMatch = stripped.match(/^\[turn:(\d+)\]\s*Turn\s+\d+:/);
  if (turnMatch) {
    return { turnNumber: parseInt(turnMatch[1], 10), type: 'turn', actorType: 'leader' };
  }

  if (stripped.includes('Session Start')) {
    return { type: 'session_start', actorType: 'leader' };
  }

  return { type: 'manual' };
}

type CheckpointLogContent = {
  label?: string;
  gitHash?: string | null;
  turnNumber?: number;
  toolName?: string;
  type?: string;
  actorType?: 'leader' | 'agent';
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  taskId?: string;
};

function parseCheckpointLogContent(content: string): CheckpointLogContent {
  try {
    return JSON.parse(content || '{}') as CheckpointLogContent;
  } catch { /* expected: malformed JSON in checkpoint log */
    return {};
  }
}

function stripSessionPrefix(label: string): string {
  return label.replace(/^\[session:[^\]]+\]\s*/, '');
}

function actorMetaFromLog(log: AgentLog, data: CheckpointLogContent): Pick<Checkpoint, 'actorType' | 'agentId' | 'agentName' | 'agentRole' | 'taskId'> {
  const agentId = data.agentId || log.agent_id;
  const actorType = data.actorType || (agentId && agentId !== 'leader' ? 'agent' : 'leader');
  return {
    actorType,
    agentId,
    agentName: data.agentName || log.agent_name || (actorType === 'leader' ? 'Leader' : agentId),
    agentRole: data.agentRole || log.agent_role || (actorType === 'leader' ? 'leader' : undefined),
    taskId: data.taskId || log.task_id || undefined,
  };
}

function checkpointFromLog(log: AgentLog, data: CheckpointLogContent): Checkpoint {
  const label = stripSessionPrefix(data.label || '');
  const parsed = parseCheckpointLabel(label);
  const actor = actorMetaFromLog(log, data);
  return {
    id: data.gitHash || `db-${log.id}`,
    label,
    createdAt: new Date(log.timestamp * 1000).toISOString(),
    timestamp: log.timestamp,
    files: [],
    additions: 0,
    deletions: 0,
    type: (data.type as Checkpoint['type']) || parsed.type || 'tool',
    turnNumber: data.turnNumber ?? parsed.turnNumber,
    toolName: data.toolName || parsed.toolName,
    ...actor,
  };
}

function mergeLogMetaIntoGitCheckpoints(gitCheckpoints: Checkpoint[], logs: AgentLog[]): { checkpoints: Checkpoint[]; extraCheckpoints: Checkpoint[] } {
  const byHash = new Map(gitCheckpoints.map(cp => [cp.id, cp]));
  const byLabel = new Map(gitCheckpoints.map(cp => [cp.label, cp]));
  const extraCheckpoints: Checkpoint[] = [];

  for (const log of logs) {
    try {
      const data = JSON.parse(log.content || '{}') as CheckpointLogContent;
      const label = stripSessionPrefix(data.label || '');
      const target = (data.gitHash ? byHash.get(data.gitHash) : undefined) || (label ? byLabel.get(label) : undefined);
      const parsed = label ? parseCheckpointLabel(label) : undefined;
      const actor = actorMetaFromLog(log, data);

      if (target) {
        Object.assign(target, {
          actorType: actor.actorType || target.actorType,
          agentId: actor.agentId || target.agentId,
          agentName: actor.agentName || target.agentName,
          agentRole: actor.agentRole || target.agentRole,
          taskId: actor.taskId || target.taskId,
          turnNumber: data.turnNumber ?? target.turnNumber ?? parsed?.turnNumber,
          toolName: data.toolName || target.toolName || parsed?.toolName,
          type: (data.type as Checkpoint['type']) || target.type || parsed?.type,
        });
        continue;
      }

      extraCheckpoints.push(checkpointFromLog(log, data));
    } catch {
      // Skip malformed records
    }
  }

  return { checkpoints: gitCheckpoints, extraCheckpoints };
}

export interface TurnCheckpointGroup {
  turnNumber: number;
  /** The turn-start checkpoint (type === 'turn'), if any */
  turnStart: Checkpoint | null;
  /** Tool-level checkpoints within this turn */
  toolCheckpoints: Checkpoint[];
}

export interface SessionCheckpointGroup {
  sessionId: string;
  summary: string | null;
  createdAt: number;
  isActive: boolean;
  checkpoints: Checkpoint[];
  turns: TurnCheckpointGroup[];
}

/** Group session checkpoints into turn-based structure */
function buildTurns(checkpoints: Checkpoint[]): TurnCheckpointGroup[] {
  const turnMap = new Map<number, TurnCheckpointGroup>();
  const unassigned: Checkpoint[] = [];

  for (const cp of checkpoints) {
    if (cp.type === 'turn' && cp.turnNumber !== undefined) {
      if (!turnMap.has(cp.turnNumber)) {
        turnMap.set(cp.turnNumber, { turnNumber: cp.turnNumber, turnStart: null, toolCheckpoints: [] });
      }
      turnMap.get(cp.turnNumber)!.turnStart = cp;
    } else if (cp.type === 'tool' && cp.turnNumber !== undefined) {
      if (!turnMap.has(cp.turnNumber)) {
        turnMap.set(cp.turnNumber, { turnNumber: cp.turnNumber, turnStart: null, toolCheckpoints: [] });
      }
      turnMap.get(cp.turnNumber)!.toolCheckpoints.push(cp);
    } else {
      unassigned.push(cp);
    }
  }

  const turns = [...turnMap.values()].sort((a, b) => b.turnNumber - a.turnNumber);

  if (unassigned.length > 0) {
    turns.push({
      turnNumber: 0,
      turnStart: unassigned.find(cp => cp.type === 'session_start') ?? null,
      toolCheckpoints: unassigned.filter(cp => cp.type !== 'session_start'),
    });
  }

  return turns;
}

export class FileChangesApi {
  private gitServices = new Map<string, GitService>();
  private db: DatabaseRepositoryAdapter;

  constructor(db: DatabaseRepositoryAdapter) {
    this.db = db;
  }

  /**
   * 获取或创建项目的 GitService
   */
  private async getGitService(sessionId: string): Promise<GitService | null> {
    if (this.gitServices.has(sessionId)) {
      return this.gitServices.get(sessionId)!;
    }

    // 从 session 获取 workspace 路径
    const session = this.db.sessions.get(sessionId);
    if (!session) return null;

    const workspace = session.workspace;
    if (!workspace) {
      console.error(`[FileChangesApi] Session ${sessionId} has no workspace — refusing to fall back to process.cwd()`);
      return null;
    }
    const gitService = new GitService(workspace);

    try {
      await gitService.initialize();
    } catch (err) {
      console.error(`[FileChangesApi] Failed to init GitService for session ${sessionId}:`, err);
      return null;
    }

    this.gitServices.set(sessionId, gitService);
    return gitService;
  }

  /**
   * 获取 checkpoint 列表
   * 合并 git 快照 + DB 中的 tool_checkpoint 事件（无 git 变更的操作记录）
   */
  async getCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    const git = await this.getGitService(sessionId);
    const gitCheckpoints = git ? await git.getCheckpoints(sessionId) : [];

    // Read tool_checkpoint events from agent_logs
    const dbEvents = this.db.agentLogs.listBySession(sessionId).filter(log => log.event_type === 'tool_checkpoint');
    const merged = mergeLogMetaIntoGitCheckpoints(gitCheckpoints, dbEvents);

    // Merge: git checkpoints first, then DB-only events, sorted by timestamp descending
    const all = [...merged.checkpoints, ...merged.extraCheckpoints];
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all;
  }

  /**
   * 获取文件 diff
   */
  async getFileDiff(sessionId: string, filePath: string, commitHash?: string): Promise<FileDiff | null> {
    const git = await this.getGitService(sessionId);
    if (!git) return null;

    if (commitHash) {
      return git.getFileDiff(filePath, commitHash);
    }

    // 先尝试 working tree diff（未提交变更）
    const diff = await git.getFileDiff(filePath, undefined);
    if (diff) return diff;

    // Changes 列表展示的是 session-scoped 累积变更。文件可能已经被 checkpoint
    // 提交进 shadow repo，当前 working tree 没有单独 diff；此时要用同一套
    // session baseline 逻辑取单文件 diff，避免误报 "File not tracked"。
    const session = this.db.sessions.get(sessionId);
    if (session?.created_at) {
      const sessionChanges = await git.getSessionChanges(session.created_at, sessionId);
      const sessionDiff = sessionChanges.find(change => change.path === filePath);
      if (sessionDiff) return sessionDiff;
    }

    // Fallback：显示最近一次提交的变更（HEAD vs HEAD^）
    return git.getFileDiff(filePath, 'HEAD');
  }

  /**
   * 获取工作区变更文件列表（按会话过滤）
   */
  async getWorkingChanges(sessionId: string): Promise<FileDiff[]> {
    const git = await this.getGitService(sessionId);
    if (!git) return [];

    // Get session's created_at timestamp for session-scoped changes
    const session = this.db.sessions.get(sessionId);
    if (session && session.created_at) {
      return git.getSessionChanges(session.created_at, sessionId);
    }
    // Fallback to all working changes
    return git.getWorkingChanges();
  }

  /**
   * 获取变更文件列表
   */
  async getChangedFiles(sessionId: string): Promise<string[]> {
    const git = await this.getGitService(sessionId);
    if (!git) return [];
    return git.getChangedFiles();
  }

  /**
   * 回滚到指定 checkpoint
   * @param scope 回退范围：'code'=仅文件, 'conversation'=仅对话, 'all'=两者都回退
   */
  async revert(
    sessionId: string,
    commitHash: string,
    scope: 'code' | 'conversation' | 'all' = 'all',
  ): Promise<{ success: boolean; error?: string; conversationTruncated?: number }> {
    const revertCode = scope === 'code' || scope === 'all';
    const revertConversation = scope === 'conversation' || scope === 'all';
    const isDbOnlyCheckpoint = commitHash.startsWith('db-');

    if (revertCode && isDbOnlyCheckpoint) {
      return { success: false, error: 'No git snapshot is available for code rollback' };
    }

    const git = revertCode || !isDbOnlyCheckpoint
      ? await this.getGitService(sessionId)
      : null;
    if (revertCode && !git) return { success: false, error: 'GitService not available' };

    try {
      let label: string | undefined;
      let targetTimestamp: number | undefined;
      if (git) try {
        const allCheckpoints = await git.getCheckpoints();
        const target = allCheckpoints.find((cp) => cp.id === commitHash);
        if (target) {
          label = target.label;
          targetTimestamp = target.timestamp;
        }
      } catch {
        // Non-critical: label lookup failure just means generic label
      }

      if (targetTimestamp === undefined || label === undefined) {
        const dbTarget = this.findCheckpointLog(sessionId, commitHash);
        if (dbTarget) {
          label = label ?? stripSessionPrefix(parseCheckpointLogContent(dbTarget.content).label || '');
          targetTimestamp = targetTimestamp ?? dbTarget.timestamp;
        }
      }

      if (revertCode && git) {
        await git.restoreProjectFromSnapshot(commitHash, sessionId, label);
      }

      let conversationTruncated = 0;
      if (revertConversation && targetTimestamp) {
        conversationTruncated = this.db.messages.truncateAfter(sessionId, targetTimestamp);
      }

      return { success: true, conversationTruncated };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Revert failed',
      };
    }
  }

  private findCheckpointLog(sessionId: string, checkpointId: string): AgentLog | null {
    const logs = this.db.agentLogs.listBySession(sessionId).filter(log => log.event_type === 'tool_checkpoint');
    if (checkpointId.startsWith('db-')) {
      const rawId = Number(checkpointId.slice(3));
      if (Number.isFinite(rawId)) {
        return logs.find(log => log.id === rawId) || null;
      }
    }
    for (const log of logs) {
      const data = parseCheckpointLogContent(log.content);
      if (data.gitHash === checkpointId) return log;
    }
    return null;
  }

  /**
   * 回退单个文件到 HEAD 状态
   */
  async revertFiles(
    sessionId: string,
    filePaths: string[],
  ): Promise<{ success: boolean; revertedFiles: string[]; error?: string }> {
    const git = await this.getGitService(sessionId);
    if (!git) return { success: false, revertedFiles: [], error: 'GitService not available' };

    try {
      await git.revertFiles(filePaths);
      return { success: true, revertedFiles: filePaths };
    } catch (err) {
      return {
        success: false,
        revertedFiles: [],
        error: err instanceof Error ? err.message : 'Revert files failed',
      };
    }
  }

  /**
   * 回退所有工作区变更
   */
  async revertAll(
    sessionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const git = await this.getGitService(sessionId);
    if (!git) return { success: false, error: 'GitService not available' };

    try {
      await git.revertAll();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Revert all failed',
      };
    }
  }

  /**
   * 创建快照
   * 无论 git 工作区是否有变更，都会在 agent_logs 中记录工具操作事件。
   * 这样即使工具操作的文件不在项目目录（如 /tmp），也能在 Changes 页面看到操作记录。
   */
  async createSnapshot(
    sessionId: string,
    message: string,
    actor?: { agentId: string; agentName: string; agentRole: string; taskId?: string },
  ): Promise<{ hash: string } | { error: string } | null> {
    const git = await this.getGitService(sessionId);

    let hash: string | null = null;
    if (git) {
      try {
        hash = await git.createFileSnapshot(message, sessionId);
      } catch (err) {
        // Git snapshot failure — still record the tool event below
        console.warn(`[FileChangesApi] git snapshot failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Always record the tool event in agent_logs, regardless of git changes.
    // This ensures every file-modifying tool call appears in the Changes timeline.
    try {
      const meta = parseCheckpointLabel(message);
      this.db.agentLogs.insert({
        session_id: sessionId,
        agent_id: actor?.agentId || 'leader',
        agent_name: actor?.agentName || 'Leader',
        agent_role: actor?.agentRole || 'leader',
        task_id: actor?.taskId || '',
        event_type: 'tool_checkpoint',
        content: JSON.stringify({
          label: message,
          gitHash: hash,
          turnNumber: meta.turnNumber,
          toolName: meta.toolName,
          type: meta.type,
          actorType: actor ? 'agent' : 'leader',
          agentId: actor?.agentId || 'leader',
          agentName: actor?.agentName || 'Leader',
          agentRole: actor?.agentRole || 'leader',
          taskId: actor?.taskId || '',
        }),
        timestamp: Date.now() / 1000,
      });
    } catch {
      // Non-critical
    }

    if (!hash) return null;
    return { hash };
  }

  /**
   * 获取所有检查点，按会话分组（用于 Rollback tab 全局视图）
   */
  async getAllCheckpointsGrouped(currentSessionId?: string): Promise<SessionCheckpointGroup[]> {
    // Need a GitService — use current session or any known session to get the workspace
    let git: GitService | null = null;

    if (currentSessionId) {
      git = await this.getGitService(currentSessionId);
    }

    if (!git) {
      const sessions = this.db.sessions.list();
      for (const s of sessions) {
        const workspace = s.workspace || process.cwd();
        const g = new GitService(workspace);
        try {
          await g.initialize();
          git = g;
          break;
        } catch {
          // try next
        }
      }
    }

    const sessions = this.db.sessions.list();
    const sessionMap = new Map(sessions.map(s => [s.id, s]));

    // Collect all sessionIds that have any events (git or DB)
    const sessionIdsWithEvents = new Set<string>();

    // Git grouped data
    const gitGrouped: Map<string, Checkpoint[]> = git
      ? await git.getAllCheckpointsGrouped()
      : new Map();

    for (const sid of gitGrouped.keys()) sessionIdsWithEvents.add(sid);

    // DB tool_checkpoint events grouped by session
    const dbGrouped = new Map<string, Checkpoint[]>();
    for (const s of sessions) {
      const logs = this.db.agentLogs.listBySession(s.id).filter(log => log.event_type === 'tool_checkpoint');
      if (logs.length > 0) {
        sessionIdsWithEvents.add(s.id);
        const gitCpsForSession = gitGrouped.get(s.id) || [];
        const merged = mergeLogMetaIntoGitCheckpoints(gitCpsForSession, logs);
        gitGrouped.set(s.id, merged.checkpoints);
        if (merged.extraCheckpoints.length > 0) dbGrouped.set(s.id, merged.extraCheckpoints);
      }
    }

    const result: SessionCheckpointGroup[] = [];

    for (const sessionId of sessionIdsWithEvents) {
      const gitCps = gitGrouped.get(sessionId) || [];
      const dbCps = dbGrouped.get(sessionId) || [];
      const checkpoints = [...gitCps, ...dbCps].sort((a, b) => b.timestamp - a.timestamp);

      if (checkpoints.length === 0) continue;

      const hasRealChanges = checkpoints.some(cp => cp.files.length > 0 || cp.label !== 'Session Start' || cp.id.startsWith('db-'));

      const dbSession = sessionId !== '__untagged__' ? sessionMap.get(sessionId) : null;
      const createdAt = dbSession?.created_at ?? (checkpoints[checkpoints.length - 1]?.timestamp ?? 0);

      result.push({
        sessionId,
        summary: dbSession?.summary ?? null,
        createdAt,
        isActive: sessionId === currentSessionId,
        checkpoints,
        turns: buildTurns(checkpoints),
      });
    }

    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  /**
   * 检查其他会话是否在目标检查点之后有变更
   * 用于回滚时向 UI 发出警告
   */
  async getOtherSessionChanges(sessionId: string, commitHash: string): Promise<{ hasOtherSessionChanges: boolean; otherSessionIds: string[] }> {
    const git = await this.getGitService(sessionId);
    if (!git) return { hasOtherSessionChanges: false, otherSessionIds: [] };

    try {
      // Get all checkpoints (unfiltered) — labels contain raw commit messages
      const allCheckpoints = await git.getCheckpoints();
      const targetIndex = allCheckpoints.findIndex(cp => cp.id === commitHash);

      if (targetIndex === -1) return { hasOtherSessionChanges: false, otherSessionIds: [] };

      // Check commits newer than the target (checkpoints are newest-first)
      const otherSessionIds = new Set<string>();
      for (let i = 0; i < targetIndex; i++) {
        const cp = allCheckpoints[i];
        // When no sessionId filter is applied, labels are raw commit messages with [session:xxx] prefix
        const match = cp.label.match(/^\[session:([^\]]+)\]/);
        if (match && match[1] !== sessionId) {
          otherSessionIds.add(match[1]);
        }
      }

      return {
        hasOtherSessionChanges: otherSessionIds.size > 0,
        otherSessionIds: [...otherSessionIds],
      };
    } catch { /* expected: git checkout/diff may fail */
      return { hasOtherSessionChanges: false, otherSessionIds: [] };
    }
  }
}
