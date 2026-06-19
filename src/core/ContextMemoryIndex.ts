import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { DatabaseManager } from './Database.js';
import type { Task } from './TaskBoard.js';
import type { WorkNote, WorkNoteManager } from './WorkNoteManager.js';
import { getContextRuntimeStateKey, type ContextCompactRecord } from './ContextRuntimeState.js';
import { buildCompressedWorkerSnapshot } from './compress/BlackboardCompressor.js';
import type { GraphSnapshot } from './blackboard/types.js';
import { countTokens } from '../llm/token_counter.js';
import { Workspace } from './Workspace.js';
import { normalizeTaskStatus } from './StateSemantics.js';
import { buildTeamMessageAwarenessBlock, buildWorkNoteAwarenessBlock, metadataHasArtifactAwareness } from './ArtifactAwareness.js';
import { getTeamMailbox, type TeamMessage } from './TeamMailbox.js';

export type ContextMemorySource =
  | 'task_result'
  | 'artifact_awareness'
  | 'work_note'
  | 'compact_archive'
  | 'blackboard'
  | 'scratchpad';

export interface ContextMemoryItem {
  id: string;
  source: ContextMemorySource;
  title: string;
  content: string;
  score: number;
  timestamp?: number;
  taskId?: string;
  agentId?: string;
  artifact?: string;
}

export interface ContextMemoryRecallInput {
  sessionId: string;
  /**
   * 语义查询串。调用方（如 TaskContextEnricher）传入任务上下文/主题用于召回；
   * 当前 recall 实现按 sessionId + 依赖链召回，预留此字段供后续 query-based 召回扩展。
   */
  query?: string;
  blockedByTaskIds?: string[];
  tokenBudget?: number;
  maxItems?: number;
  includeBlackboard?: boolean;
  blackboardSnapshot?: GraphSnapshot | string | null;
  /**
   * 工作区根路径。提供后启用 scratchpad 召回：读取上游依赖任务在
   * <workspace>/.lingxiao/sessions/<sessionId>/scratchpad/ 下的笔记文件。
   */
  workspace?: string;
}

export interface ContextMemoryRecallResult {
  items: ContextMemoryItem[];
  rendered: string;
  estimatedTokens: number;
  dropped: number;
}

const DEFAULT_TOKEN_BUDGET = 4_000;
const DEFAULT_MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 1_600;
const MAX_ARCHIVE_CHARS = 2_400;
const MAX_TASK_RESULT_CHARS = 1_200;
const MAX_ARTIFACT_AWARENESS_CHARS = 1_400;
const MAX_NOTE_CHARS = 1_200;
const MAX_SCRATCHPAD_CHARS = 2_000;
const MAX_TEAM_ARTIFACT_MESSAGES = 30;
const MIN_ITEM_CHARS = 240;
/**
 * token→char 换算系数：recall 在 token 预算（remaining）将耗尽时，反推该条记忆的 char 截断上限。
 * 取 3.2 是英文（~4 chars/token）、代码（~3-4）、中文（~1-2）的折中估计，保证剩余预算能塞下精简后的
 * 记忆而非整体丢弃。单一常量、确定性，避免散落的魔术数字。
 */
const CHARS_PER_TOKEN_RATIO = 3.2;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(truncated ${text.length - maxChars} chars)`;
}

/**
 * 取尾部内容：scratchpad 最新进展在文件末尾，截断时优先保留尾部。
 */
function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `...(truncated ${text.length - maxChars} chars)\n${text.slice(-maxChars)}`;
}

function timestampMs(value?: number): number {
  if (!value) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

/**
 * 内容派生的稳定版本号（FNV-1a 32-bit → 31-bit 正整数）。
 * 用于 blackboard 等"无天然 timestamp"的条目：同一内容 → 同一值，内容变化 → 值变化。
 *
 * 之前 recallBlackboard 用 Date.now() 作为 timestamp，而 buildMemoryItemsFingerprint
 * 把 timestamp 纳入指纹 → 每个 leader think-cycle 指纹都不同 → 重注入闸门永不短路 →
 * 每轮追加一条新的 manifest 系统消息，单调膨胀会话并击穿 prompt cache。
 * 改用内容指纹后：blackboard 内容未变 → 指纹不变 → 闸门短路，不再重注入。
 * blackboard 得分固定为 60（最高），排序不受 timestamp 数值影响，故用哈希作 timestamp 安全。
 */
function stableContentVersion(content: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}

function renderNote(note: WorkNote): string {
  return truncate(buildWorkNoteAwarenessBlock(note), MAX_NOTE_CHARS);
}

function normalizeTaskResult(result: unknown): string {
  if (result == null || result === '') return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return truncate(text, MAX_TASK_RESULT_CHARS);
}

function extractArtifactAwareness(result: unknown): string {
  if (result == null || result === '') return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  const marker = '### Cross-Agent Artifact Awareness';
  const index = text.indexOf(marker);
  if (index >= 0) {
    const remainder = text.slice(index);
    const nextSection = remainder.indexOf('\n### Worker Result');
    const block = nextSection >= 0 ? remainder.slice(0, nextSection) : remainder;
    return truncate(block, MAX_ARTIFACT_AWARENESS_CHARS);
  }
  const artifactLines = text
    .split(/\r?\n/)
    .filter(line => /files_created:|files_modified:|commands_run:|verification:|next_steps:/i.test(line))
    .slice(0, 20);
  return artifactLines.length > 0 ? truncate(artifactLines.join('\n'), MAX_ARTIFACT_AWARENESS_CHARS) : '';
}

function itemKey(item: ContextMemoryItem): string {
  return `${item.source}:${item.taskId || ''}:${item.agentId || ''}:${item.title}:${item.content.slice(0, 120)}`;
}


export class ContextMemoryIndex {
  constructor(
    private readonly db: Pick<DatabaseManager, 'getTasksBySession' | 'getSessionState'>,
    private readonly workNoteManager: Pick<WorkNoteManager, 'getAllNotes'>,
  ) {}

  async recall(input: ContextMemoryRecallInput): Promise<ContextMemoryRecallResult> {
    const blockedBy = new Set(input.blockedByTaskIds || []);
    const items: ContextMemoryItem[] = [];

    items.push(...this.recallTaskResults(input.sessionId, blockedBy));
    items.push(...this.recallTeamArtifactMessages(input.sessionId, blockedBy));
    items.push(...await this.recallWorkNotes(input.sessionId, blockedBy));
    items.push(...this.recallCompactArchives(input.sessionId));
    items.push(...this.recallScratchpads(input.sessionId, input.workspace, blockedBy));

    if (input.includeBlackboard !== false && input.blackboardSnapshot) {
      const blackboard = this.recallBlackboard(input.blackboardSnapshot);
      if (blackboard) items.push(blackboard);
    }

    const deduped = new Map<string, ContextMemoryItem>();
    for (const item of items) {
      const key = itemKey(item);
      const existing = deduped.get(key);
      if (!existing || item.score > existing.score) {
        deduped.set(key, item);
      }
    }

    const sorted = this.rankItems([...deduped.values()]);
    const selected: ContextMemoryItem[] = [];
    const budget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
    let used = 0;

    for (const item of sorted) {
      if (selected.length >= maxItems) break;
      // scratchpad 的最新进展在尾部，截断时保留尾部；其余源保留头部。
      let clipped = this.clipItemToChars(item, MAX_ITEM_CHARS);
      let cost = countTokens(`${clipped.title}\n${clipped.content}`);
      const remaining = Math.max(0, budget - used);

      if (cost > remaining) {
        const maxCharsForRemaining = Math.max(
          MIN_ITEM_CHARS,
          Math.floor(remaining * CHARS_PER_TOKEN_RATIO) - clipped.title.length,
        );
        clipped = this.clipItemToChars(item, Math.min(MAX_ITEM_CHARS, maxCharsForRemaining));
        cost = countTokens(`${clipped.title}\n${clipped.content}`);
      }

      if (cost > remaining) {
        continue;
      }
      selected.push(clipped);
      used += cost;
      if (used >= budget) break;
    }

    return {
      items: selected,
      rendered: this.render(selected),
      estimatedTokens: used,
      dropped: Math.max(0, sorted.length - selected.length),
    };
  }

  /**
   * 确定性排序：score 降序，并列时按时间戳降序（最新优先）。无 LLM、无语义重排、无置信度——
   * 旧的 opt-in 语义重排（runStructuredJudgment + buildMemoryQuery query）从未被任何调用方启用，
   * 是死代码且引入非确定性，已移除。recall 结果完全可复现。
   */
  private rankItems(items: ContextMemoryItem[]): ContextMemoryItem[] {
    return [...items].sort((a, b) =>
      b.score - a.score || timestampMs(b.timestamp) - timestampMs(a.timestamp),
    );
  }

  private recallTaskResults(sessionId: string, blockedBy: Set<string>): ContextMemoryItem[] {
    const tasks = this.db.getTasksBySession(sessionId) as Task[];
    const items: ContextMemoryItem[] = [];
    for (const task of tasks) {
      const result = normalizeTaskResult(task.result);
      const dependencyBoost = blockedBy.has(task.id) ? 30 : 0;
      const normalizedStatus = normalizeTaskStatus(task);
      const terminalBoost = normalizedStatus === 'completed' ? 8
        : normalizedStatus === 'failed' ? 5 : 0;
      const artifactAwareness = extractArtifactAwareness(task.result);
      if (artifactAwareness) {
        items.push({
          id: `artifact:${task.id}`,
          source: 'artifact_awareness',
          title: `[${task.id}] artifact awareness: ${task.subject}`,
          content: artifactAwareness,
          score: 34 + dependencyBoost + terminalBoost,
          timestamp: task.updated_at || task.created_at,
          taskId: task.id,
          agentId: task.assigned_agent,
        });
      }
      if (!result) continue;
      if (blockedBy.size > 0 && !blockedBy.has(task.id)) continue;
      items.push({
        id: `task:${task.id}`,
        source: 'task_result',
        title: `[${task.id}] ${task.subject}`,
        content: result,
        score: dependencyBoost + terminalBoost,
        timestamp: task.updated_at || task.created_at,
        taskId: task.id,
        agentId: task.assigned_agent,
      });
    }
    return items;
  }

  private clipItemToChars(item: ContextMemoryItem, maxChars: number): ContextMemoryItem {
    const safeMax = Math.max(MIN_ITEM_CHARS, maxChars);
    const content = item.source === 'scratchpad'
      ? truncateTail(item.content, safeMax)
      : truncate(item.content, safeMax);
    return { ...item, content };
  }

  private recallTeamArtifactMessages(sessionId: string, blockedBy: Set<string>): ContextMemoryItem[] {
    let messages: TeamMessage[] = [];
    try {
      const mailbox = getTeamMailbox();
      const teams = mailbox.getAllTeams(sessionId);
      const seen = new Set<string>();
      for (const team of teams) {
        for (const message of mailbox.getMessages(team.name, { sessionId })) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          messages.push(message);
        }
      }
    } catch {/* expected: data source unavailable */
      return [];
    }

    messages = messages
      .filter((message) => metadataHasArtifactAwareness(message.metadata))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_TEAM_ARTIFACT_MESSAGES);

    const items: ContextMemoryItem[] = [];
    for (const message of messages) {
      const metadata = message.metadata ?? {};
      const taskIds = [metadata.taskId, metadata.sourceTaskId, metadata.targetTaskId].filter(Boolean) as string[];
      const taskId = taskIds[0];
      const dependencyBoost = taskIds.some((id) => blockedBy.has(id)) ? 26 : 0;
      const content = buildTeamMessageAwarenessBlock(message);
      if (!content) continue;
      items.push({
        id: `team-artifact:${message.id}`,
        source: 'artifact_awareness',
        title: `[team] ${metadata.intent || 'message'} from ${message.fromMember || 'system'}`,
        content: truncate(content, MAX_ARTIFACT_AWARENESS_CHARS),
        score: 31 + dependencyBoost,
        timestamp: message.timestamp,
        taskId,
        agentId: message.fromMember,
        artifact: metadata.artifactPaths?.[0],
      });
    }
    return items;
  }

  private async recallWorkNotes(sessionId: string, blockedBy: Set<string>): Promise<ContextMemoryItem[]> {
    const notes = await this.workNoteManager.getAllNotes(sessionId);
    return notes.map((note) => {
      const noteContent = renderNote(note);
      const awareness = buildWorkNoteAwarenessBlock(note);
      const hasArtifactSignals =
        (note.artifacts?.length ?? 0) > 0 ||
        (note.keyFindings?.length ?? 0) > 0 ||
        (note.nextSteps?.length ?? 0) > 0 ||
        (note.blockers?.length ?? 0) > 0 ||
        Boolean(note.impactAnalysis?.trim());
      const content = hasArtifactSignals && awareness
        ? truncate(awareness, MAX_ARTIFACT_AWARENESS_CHARS)
        : noteContent;
      const dependencyBoost = blockedBy.has(note.taskId) ? 24 : 0;
      const phaseBoost = note.phase === 'testing' || note.phase === 'reviewing' ? 4 : 2;
      const artifactBoost = hasArtifactSignals ? 10 : 0;
      return {
        id: `note:${note.id}`,
        source: hasArtifactSignals ? 'artifact_awareness' as const : 'work_note' as const,
        title: `[${note.taskId}] ${note.phase} by ${note.agentId}`,
        content,
        score: artifactBoost + dependencyBoost + phaseBoost,
        timestamp: note.timestamp,
        taskId: note.taskId,
        agentId: note.agentId,
        artifact: note.artifacts?.[0],
      };
    }).filter((item) => item.score > 0);
  }

  private recallCompactArchives(sessionId: string): ContextMemoryItem[] {
    const states = [
      this.db.getSessionState(sessionId, getContextRuntimeStateKey({ kind: 'leader' })),
    ];
    const items: ContextMemoryItem[] = [];
    for (const state of states) {
      if (!state || typeof state !== 'object') continue;
      const compactHistory = Array.isArray((state as { compactHistory?: unknown }).compactHistory)
        ? (state as { compactHistory: ContextCompactRecord[] }).compactHistory
        : [];
      for (const record of compactHistory) {
        if (!record.archivePath) continue;
        const content = this.readArchivePreview(record.archivePath);
        if (!content) continue;
        items.push({
          id: `archive:${record.archivePath}`,
          source: 'compact_archive',
          title: `Context archive ${new Date(timestampMs(record.timestamp)).toISOString()}`,
          content,
          score: 6,
          timestamp: record.timestamp,
          artifact: record.archivePath,
        });
      }
    }
    return items;
  }

  private recallBlackboard(snapshot: GraphSnapshot | string): ContextMemoryItem | null {
    const content = typeof snapshot === 'string'
      ? snapshot
      : buildCompressedWorkerSnapshot(snapshot, 1_500);
    if (!content.trim()) return null;
    return {
      id: 'blackboard:latest',
      source: 'blackboard',
      title: 'Blackboard latest compressed snapshot (contracts/design docs included)',
      content: truncate(content, MAX_ITEM_CHARS),
      score: 60,
      // 内容派生的稳定版本号（非 wall-clock）：见 stableContentVersion 注释。
      // 保证 blackboard 内容不变时指纹稳定，避免每轮重注入击穿 prompt cache。
      timestamp: stableContentVersion(content),
    };
  }

  /**
   * 召回上游依赖任务的 scratchpad 笔记。
   *
   * 仅在提供 workspace 时启用，且仅读取 blocked_by 精确命中的任务文件
   * （命名约定见 worker prompt：`<taskId>.md` / `<taskId>_<role>.md`）。
   * 依赖关系是精确的 task-id 前缀匹配。
   * 内容取文件尾部（最新进展），并交由统一的 tokenBudget + maxItems 防爆炸。
   */
  private recallScratchpads(
    sessionId: string,
    workspace: string | undefined,
    blockedBy: Set<string>,
  ): ContextMemoryItem[] {
    if (!workspace || blockedBy.size === 0) return [];

    let dir: string;
    try {
      dir = Workspace.getScratchpadDir(sessionId, workspace);
    } catch {/* expected: data source unavailable */
      return [];
    }
    if (!existsSync(dir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {/* expected: data source unavailable */
      return [];
    }

    const items: ContextMemoryItem[] = [];
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const taskId = this.matchScratchpadTaskId(file, blockedBy);
      if (!taskId) continue;

      const fullPath = join(dir, file);
      let content: string;
      let mtimeMs: number;
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        mtimeMs = stat.mtimeMs;
        content = readFileSync(fullPath, 'utf-8');
      } catch {/* expected: skip invalid entry */
        continue;
      }
      if (!content.trim()) continue;

      const tail = truncateTail(content, MAX_SCRATCHPAD_CHARS);
      items.push({
        id: `scratchpad:${file}`,
        source: 'scratchpad',
        title: `[${taskId}] scratchpad ${file}`,
        content: tail,
        score: 22,
        timestamp: mtimeMs,
        taskId,
        artifact: fullPath,
      });
    }
    return items;
  }

  /**
   * 文件名是否对应某个上游依赖任务。
   * 命名约定：`<taskId>.md` 或 `<taskId>_<role>.md`，与 buildScratchpadSection 一致。
   */
  private matchScratchpadTaskId(file: string, blockedBy: Set<string>): string | undefined {
    const base = file.slice(0, -'.md'.length);
    for (const taskId of blockedBy) {
      if (base === taskId || base.startsWith(`${taskId}_`)) {
        return taskId;
      }
    }
    return undefined;
  }

  private readArchivePreview(archivePath: string): string {
    try {
      const raw = readFileSync(archivePath, 'utf-8');
      const metaMatch = raw.match(/<!-- lingxiao-context-archive\n([\s\S]*?)\n-->/);
      const metadata = metaMatch?.[1] ? `metadata: ${metaMatch[1].trim()}` : '';
      const summaryMatch = raw.match(/## Summary\n([\s\S]*?)(?:\n## Original Messages|\n## Algorithmic Records|$)/);
      const recordsMatch = raw.match(/## Algorithmic Records\n([\s\S]*?)(?:\n## Summary|$)/);
      const selected = [
        metadata,
        summaryMatch?.[1]?.trim(),
        recordsMatch?.[1]?.trim(),
      ].filter(Boolean).join('\n\n');
      return truncate(selected || raw, MAX_ARCHIVE_CHARS);
    } catch {/* expected: fallback to default */
      return '';
    }
  }

  private render(items: ContextMemoryItem[]): string {
    if (items.length === 0) return '';
    const lines = ['### 相关上下文记忆（系统自动召回）'];
    for (const item of items) {
      lines.push(
        '',
        `#### ${item.title}`,
        `source=${item.source}${item.taskId ? ` task=${item.taskId}` : ''}${item.agentId ? ` agent=${item.agentId}` : ''}${item.artifact ? ` artifact=${item.artifact}` : ''}`,
        item.content,
      );
    }
    return lines.join('\n');
  }
}
