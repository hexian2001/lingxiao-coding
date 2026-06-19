import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * 工作阶段枚举
 */
export type WorkNotePhase = 'research' | 'coding' | 'testing' | 'reviewing' | 'other';

/**
 * 结构化工作笔记
 */
export interface WorkNote {
  id: string;
  agentId: string;
  taskId: string;
  timestamp: number;
  phase: WorkNotePhase;
  summary: string;           // 一行摘要（max 200 chars）
  details?: string;          // 详细描述（max 2000 chars）
  artifacts?: string[];      // 涉及的文件路径（coding/research 任务强烈建议填写）
  blockers?: string[];       // 阻塞因素
  nextSteps?: string[];      // 下一步计划
  keyFindings?: string[];    // 关键发现，格式：「文件路径:行号 — 说明」（用于后续任务继承上下文）
  impactAnalysis?: string;   // 改动影响范围说明（如：影响 3 个文件、修改了公共接口等）
}

const SUMMARY_MAX_LENGTH = 200;
const DETAILS_MAX_LENGTH = 2000;
/** 单 agent 内存索引上限，超出后驱逐最旧笔记 */
const MAX_NOTES_PER_AGENT = 200;
/** 单 session 内存索引上限（所有 agent 合计） */
const MAX_NOTES_PER_SESSION = 2000;

/**
 * 生成唯一笔记 ID
 */
function generateNoteId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 截断字符串并在超限时添加标记
 */
function truncateWithMarker(value: string, maxLength: number, marker = '…'): string {
  if (value.length <= maxLength) return value;
  return value.substring(0, maxLength - marker.length) + marker;
}

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 工作笔记管理器
 * 负责笔记的创建、读取、更新和持久化
 */
export class WorkNoteManager {
  /** 内存索引：sessionId → agentId → notes[] */
  private index: Map<string, Map<string, WorkNote[]>> = new Map();
  /** 基础目录 */
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(homedir(), '.lingxiao');
  }

  /**
   * 获取笔记文件路径
   */
  private getNotesFilePath(sessionId: string, agentId: string): string {
    return path.join(this.baseDir, 'sessions', sessionId, 'agents', agentId, 'notes.jsonl');
  }

  /**
   * 获取 agents 目录路径
   */
  private getAgentsDir(sessionId: string): string {
    return path.join(this.baseDir, 'sessions', sessionId, 'agents');
  }

  /**
   * 确保 agent 笔记目录存在
   */
  private async ensureDirExists(sessionId: string, agentId: string): Promise<void> {
    const dir = path.dirname(this.getNotesFilePath(sessionId, agentId));
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * 确保 agents 目录存在
   */
  private async ensureAgentsDirExists(sessionId: string): Promise<void> {
    const dir = this.getAgentsDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * 从文件加载笔记到内存索引
   * 文件不存在时视为空，不报错
   *
   * @param forceReload 强制重新读盘，忽略内存缓存。
   *   Why：notes.jsonl 是跨进程追加写的（worker 子进程各自写自己的，Leader/TeamSynchronizer
   *   持有常驻单例读）。若读路径命中"写一次永久缓存"，常驻读者第一次加载后就再也看不到其他进程
   *   后续追加的笔记 —— 表现为"明明写了却读不到"。所以所有读路径必须 forceReload，以磁盘为准。
   *   写路径也 reload，确保 append 前内存数组与磁盘一致（避免并发写丢笔记 / 驱逐基于陈旧计数）。
   */
  private async loadIntoIndex(sessionId: string, agentId: string, forceReload = false): Promise<WorkNote[]> {
    const sessionMap = this.index.get(sessionId);
    if (!forceReload && sessionMap?.has(agentId)) {
      return sessionMap.get(agentId)!;
    }

    const notes: WorkNote[] = [];
    const filePath = this.getNotesFilePath(sessionId, agentId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim().length > 0);
      for (const line of lines) {
        try {
          const note = JSON.parse(line) as WorkNote;
          notes.push(note);
        } catch {
          // 跳过解析失败的行
        }
      }
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        // 文件不存在是正常情况（首次写入前），不需要警告
      } else {
        console.warn('[WorkNoteManager] Failed to read notes file:', error);
      }
    }

    if (!this.index.has(sessionId)) {
      this.index.set(sessionId, new Map());
    }
    this.index.get(sessionId)!.set(agentId, notes);
    return notes;
  }

  /**
   * 写入工作笔记
   * 自动截断超长字段，追加写入 JSONL 文件，更新内存索引
   */
  async writeNote(
    sessionId: string,
    input: Omit<WorkNote, 'id' | 'timestamp'>
  ): Promise<WorkNote> {
    return this.writeNoteWithSession(sessionId, input);
  }

  /**
   * 写入笔记并指定 sessionId（推荐使用此方法）
   */
  async writeNoteWithSession(
    sessionId: string,
    input: Omit<WorkNote, 'id' | 'timestamp'>
  ): Promise<WorkNote> {
    const note: WorkNote = {
      ...input,
      id: generateNoteId(),
      timestamp: Date.now(),
      summary: truncateWithMarker(input.summary, SUMMARY_MAX_LENGTH),
      details: input.details ? truncateWithMarker(input.details, DETAILS_MAX_LENGTH) : undefined,
    };

    // 先确保目录存在，再以磁盘为准重载（跨进程追加，内存可能落后）
    await this.ensureDirExists(sessionId, note.agentId);
    await this.loadIntoIndex(sessionId, note.agentId, true);

    const sessionMap = this.index.get(sessionId)!;
    const agentNotes = sessionMap.get(note.agentId) || [];
    agentNotes.push(note);

    // 驱逐：单 agent 超限则移除最旧笔记
    let evicted = false;
    if (agentNotes.length > MAX_NOTES_PER_AGENT) {
      agentNotes.splice(0, agentNotes.length - MAX_NOTES_PER_AGENT);
      evicted = true;
    }
    sessionMap.set(note.agentId, agentNotes);

    // 持久化：未驱逐走追加（快）；驱逐则整文件重写以反映裁剪。
    // Why：读路径现在始终以磁盘为准（防跨进程 stale），若只 append 不重写，
    // 文件会无限增长且读出来超过上限，驱逐形同虚设。单 agent 文件只有该 worker
    // 自己写，重写不会与其他进程竞争。
    if (evicted) {
      await this.rewriteNotesFile(sessionId, note.agentId, agentNotes);
    } else {
      const filePath = this.getNotesFilePath(sessionId, note.agentId);
      const line = JSON.stringify(note) + '\n';
      await fs.appendFile(filePath, line, 'utf-8');
    }

    // 驱逐：session 总量超限则从最老 agent 开始裁剪（仅内存层面缓解压力，
    // 不删文件——读路径每次重新发现磁盘，下次读会重新载入，不会丢数据）
    let totalNotes = 0;
    for (const notes of sessionMap.values()) totalNotes += notes.length;
    if (totalNotes > MAX_NOTES_PER_SESSION) {
      const sorted = [...sessionMap.entries()].sort((a, b) => {
        const aOldest = a[1][0]?.timestamp ?? Infinity;
        const bOldest = b[1][0]?.timestamp ?? Infinity;
        return aOldest - bOldest;
      });
      for (const [agentId, notes] of sorted) {
        if (totalNotes <= MAX_NOTES_PER_SESSION) break;
        const remove = Math.min(notes.length, totalNotes - MAX_NOTES_PER_SESSION);
        notes.splice(0, remove);
        totalNotes -= remove;
        if (notes.length === 0) sessionMap.delete(agentId);
      }
    }

    return note;
  }

  /**
   * 从文件系统发现会话中的所有 Agent
   * 目录不存在时视为空，不报错
   */
  private async discoverAgents(sessionId: string): Promise<void> {
    // 先确保 agents 目录存在，避免首次调用时 ENOENT
    await this.ensureAgentsDirExists(sessionId);

    const agentsDir = this.getAgentsDir(sessionId);
    try {
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // 强制重载：发现新 agent 目录的同时，刷新已知 agent 的磁盘内容
          await this.loadIntoIndex(sessionId, entry.name, true);
        }
      }
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        console.warn('[WorkNoteManager] Failed to discover agents directory:', error);
      }
    }
  }

  /**
   * 重写笔记文件（用于更新操作）
   */
  private async rewriteNotesFile(sessionId: string, agentId: string, notes: WorkNote[]): Promise<void> {
    // 确保目录存在（updateNote 路径可能未经过 writeNote）
    await this.ensureDirExists(sessionId, agentId);
    const filePath = this.getNotesFilePath(sessionId, agentId);
    const content = notes.map(note => JSON.stringify(note)).join('\n') + '\n';
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * 获取指定 Agent 的所有笔记
   */
  async getAgentNotes(sessionId: string, agentId: string): Promise<WorkNote[]> {
    // 强制以磁盘为准：跨进程写入后，常驻读者不能命中陈旧内存缓存
    await this.loadIntoIndex(sessionId, agentId, true);
    const notes = this.index.get(sessionId)?.get(agentId) || [];
    return [...notes].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 获取指定会话所有 Agent 的笔记
   */
  async getAllNotes(sessionId: string): Promise<WorkNote[]> {
    // 每次都重新发现+重载：worker 子进程可能新建了 agent 目录或向已有文件追加，
    // 只在 index 未建立时 discover 会漏掉这些跨进程写入。
    await this.discoverAgents(sessionId);
    const allNotes: WorkNote[] = [];
    const resolvedMap = this.index.get(sessionId);
    if (resolvedMap) {
      for (const notes of resolvedMap.values()) {
        allNotes.push(...notes);
      }
    }
    return allNotes.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 更新笔记 — 仅允许笔记所有者更新
   */
  async updateNote(
    sessionId: string,
    agentId: string,
    callerAgentId: string,
    noteId: string,
    updates: Partial<Pick<WorkNote, 'details' | 'artifacts' | 'blockers' | 'nextSteps'>>
  ): Promise<WorkNote> {
    if (callerAgentId !== agentId) {
      throw new Error(
        `Permission denied: agent '${callerAgentId}' cannot modify notes belonging to '${agentId}'`
      );
    }

    // 以磁盘为准重载，避免基于陈旧内存数组重写文件而丢失其他写入
    await this.loadIntoIndex(sessionId, agentId, true);
    const notes = this.index.get(sessionId)?.get(agentId) || [];
    const noteIndex = notes.findIndex(n => n.id === noteId);

    if (noteIndex === -1) {
      throw new Error(`Note not found: ${noteId}`);
    }

    const existing = notes[noteIndex];
    const updated: WorkNote = {
      ...existing,
      ...updates,
      id: existing.id,
      agentId: existing.agentId,
      taskId: existing.taskId,
      timestamp: Date.now(),
      summary: existing.summary,
    };

    notes[noteIndex] = updated;
    await this.rewriteNotesFile(sessionId, agentId, notes);
    return updated;
  }

  /**
   * 获取 Agent 的最新笔记
   */
  async getLatestNote(sessionId: string, agentId: string): Promise<WorkNote | null> {
    const notes = await this.getAgentNotes(sessionId, agentId);
    return notes.length > 0 ? notes[0] : null;
  }
}
