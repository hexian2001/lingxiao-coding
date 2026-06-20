import type { OrchestrationTaskMetadata } from '../core/OrchestrationTypes.js';
import type { TaskDisplayState } from '../core/TaskDisplayState.js';
import type { EternalRuntimeSnapshot } from '../core/EternalLoop.js';
import type { BaseMessage } from '../contracts/types/Message.js';
import type { ModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import type { Checkpoint } from '../web-server/GitService.js';

export type CommandMessageType = 'system' | 'leader' | 'user' | 'agent' | 'thinking' | 'tool' | 'code' | 'table' | 'error' | 'success';

export interface CommandSessionStatusData {
  sessionId: string;
  workspace: string;
  status?: string;
  createdAt?: number;
  permissionSummary?: string;
  permissionMode?: 'strict' | 'dev' | 'networked' | 'yolo';
  orchestrationSummary?: string;
  controlMode?: 'manual' | 'eternal';
  modes?: ModeRuntimeProjection;
  eternal?: EternalRuntimeSnapshot;
}

export interface CommandTaskData {
  id: string;
  subject: string;
  status: 'dispatchable' | 'running' | 'terminal' | 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  displayState?: TaskDisplayState;
  exitReason?: 'completed' | 'failed' | 'cancelled' | 'timeout';
  agent_type?: string;
  assigned_agent?: string;
  blocked_by?: string[];
  blocks?: string[];
  working_directory?: string;
  write_scope?: string[];
  orchestration?: OrchestrationTaskMetadata;
}

export interface CommandLogMessage extends Partial<BaseMessage> {
  type: CommandMessageType;
  content: string;
  timestamp?: number;
  key?: string;
  toolName?: string;
  toolKind?: 'call' | 'result';
  toolSummary?: string;
  toolMeta?: string;
  /** 文件编辑类工具的内联 diff 行（+/- 着色），由 search/replace 参数推导 */
  toolDiff?: ToolDiffLine[];
  /** 工具调用开始时间戳（用于实时计时） */
  toolStartedAt?: number;
  /** 工具调用参数（展开视图展示，多行 key: value 格式） */
  toolInput?: string;
  /** 工具结果预览（展开视图展示，截断的原始输出） */
  toolOutput?: string;
}

/** 内联 diff 单行：kind 决定着色，text 为去掉前缀的内容 */
export interface ToolDiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
}

export interface CommandInitialChannelSeed {
  agentId?: string;
  name: string;
  role?: string;
  taskId?: string;
  status: string;
  messages: CommandLogMessage[];
}

export interface CommandListItem {
  id: string;
  status?: string;
  preview: string;
  detail?: string;
  createdAt?: number;
}

export interface CommandResumeSession {
  id: string;
  status: string;
  preview: string;
}

export type CommandModalAction =
  | 'resume_modal'
  | 'history_modal'
  | 'skills_modal'
  | 'doctor_modal'
  | 'permissions_modal'
  | 'projects_modal'
  | 'report_modal'
  | 'rewind_modal';

export type CommandAction = CommandModalAction | 'hydrate';

export interface CommandBaseResult {
  type?: CommandMessageType;
  content: string;
}

export interface CommandMessageResult extends CommandBaseResult {
  action?: undefined;
}

export interface CommandResumeModalResult extends CommandBaseResult {
  action: 'resume_modal';
  sessions: CommandResumeSession[];
}

/** 可滚动文本报告模态（/stats /logs /traces /changes /cost 等） */
export interface CommandReportModalResult extends CommandBaseResult {
  action: 'report_modal';
  /** 面板标题 */
  title: string;
  /** 报告正文（多行文本，按行滚动） */
  report: string;
}

export interface CommandItemsModalResult extends CommandBaseResult {
  action: Exclude<CommandModalAction, 'resume_modal' | 'report_modal' | 'rewind_modal'>;
  items: CommandListItem[];
}

/** 回退范围：仅代码 / 仅对话 / 全部 */
export type RewindScope = 'code' | 'conversation' | 'all';

/** 检查点摘要（供 RewindDialog pick 阶段展示） */
export interface RewindCheckpointSummary {
  id: string;
  label: string;
  timestamp: number;
  type: Checkpoint['type'];
  /** id 以 `db-` 开头：仅 DB 记录无 git 快照，code/all 回退不可用 */
  isDbOnly: boolean;
  turnNumber?: number;
  toolName?: string;
  actorType?: 'leader' | 'agent';
  agentName?: string;
  fileCount: number;
  additions: number;
  deletions: number;
}

/** 工作区未提交变更摘要（pick 阶段的 `working` 伪条目） */
export interface RewindWorkingChangesSummary {
  fileCount: number;
  additions: number;
  deletions: number;
}

/** scope/confirm 阶段的影响预览 */
export interface RewindPreview {
  /** code/all 回退将影响的文件（前 N 个，含 +/- 统计） */
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** 回退点之后将被删除的对话消息数 */
  messagesAfter: number;
}

/**
 * `/rewind` 三阶段自包含对话框结果。
 * 阶段流转由 re-dispatch 驱动：选检查点 → /rewind <id>；
 * 选范围 → /rewind <id> <scope>；确认 → /rewind <id> <scope> confirm。
 */
export interface CommandRewindModalResult extends CommandBaseResult {
  action: 'rewind_modal';
  stage: 'pick' | 'scope' | 'confirm';
  /** 选中的检查点 id；pick 阶段未定 */
  checkpointId?: string;
  /** 选中的范围；confirm 阶段已定 */
  scope?: RewindScope;
  /** pick 阶段的检查点列表 */
  checkpoints?: RewindCheckpointSummary[];
  /** pick 阶段的工作区未提交摘要（null 表示工作区干净） */
  workingChangesSummary?: RewindWorkingChangesSummary | null;
  /** db-only 检查点：scope 仅允许 conversation */
  isDbOnly?: boolean;
  /** scope/confirm 阶段的差异 + 影响预览 */
  preview?: RewindPreview;
  /** scope/confirm 阶段的跨会话冲突警告 */
  crossSession?: { hasOtherSessionChanges: boolean; otherSessionIds: string[] };
  /** live Leader 当前是否在运行（回退对话时需先中断） */
  leaderBusy?: boolean;
}

export interface CommandHydrateResult extends CommandBaseResult {
  action: 'hydrate';
  sessionStatus: CommandSessionStatusData;
  tasks: CommandTaskData[];
  messages: CommandLogMessage[];
  channels: CommandInitialChannelSeed[];
  tokenUsage?: number;
  agentTokens?: Record<string, number>;
  leaderStatus: string;
  leaderMode?: 'direct' | 'hybrid' | 'delegate';
  leaderReason?: string;
}

export type CommandResult =
  | CommandMessageResult
  | CommandResumeModalResult
  | CommandItemsModalResult
  | CommandReportModalResult
  | CommandRewindModalResult
  | CommandHydrateResult;
