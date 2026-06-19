/**
 * canonical.ts — Core type definitions (Single Source of Truth)
 *
 * All modules MUST import these canonical types rather than redefining locally.
 * Use Pick/Omit/Extend for module-specific subsets.
 */

import type { MessageContent } from '../contracts/types/Message.js';
import type { TaskStatus } from '../contracts/types/Status.js';
import type { OrchestrationTaskMetadata } from '../core/OrchestrationTypes.js';

// ═══════════════════════════════════════════════════════════════
// MessageContent — canonical re-exports from contracts/types/Message
// ═══════════════════════════════════════════════════════════════

export type {
  ImageBlobRefContentPart,
  ImageUrlContentPart,
  McpAppContentPart,
  MessageContent,
  MessageContentPart,
  TextBlock as TextContentPart,
} from '../contracts/types/Message.js';

// ═══════════════════════════════════════════════════════════════
// TokenUsage
// ═══════════════════════════════════════════════════════════════

export type {
  EternalTokenSnapshot,
  TokenUsage,
  TokenUsageRecord,
  TokenUsageView,
} from '../contracts/types/TokenUsage.js';
export {
  EMPTY_TOKEN_USAGE,
} from '../contracts/types/TokenUsage.js';

// ═══════════════════════════════════════════════════════════════
// Task
// ═══════════════════════════════════════════════════════════════

/**
 * Canonical Task record — the full runtime representation used by TaskBoard.
 * DB persistence layer and agent-facing subset derive from this via Pick/Omit.
 */
export interface TaskRecord {
  id: string;
  session_id: string;
  subject: string;
  description: string | object;
  context?: string;
  status: TaskStatus;
  exitReason?: string;
  /** 任务执行代际；每次派发/重派/重开递增 */
  runGeneration: number;
  agent_type: string;
  blocked_by: string[];
  blocks: string[];
  assigned_agent: string;
  /** 预绑定 agent name */
  preferred_agent_name?: string;
  working_directory: string;
  write_scope: string[];
  result?: string | object;
  /** 外部阻塞原因（坏 API key / 缺凭证 / ask_user / 权限等）。置位时 getReadyTasks 排除该任务，
   *  防止 external_blocking 故障的任务被无限重派烧 token；prepareTaskForRedispatch 清除。 */
  blocked_reason?: string;
  orchestration?: OrchestrationTaskMetadata;
  /** task 起源标签 */
  origin?: string;
  /** task 高层目标 */
  goal?: string;
  /** task 类型 */
  taskType?: 'bootstrap' | 'reason' | 'explore' | 'generic';
  created_at: number;
  updated_at: number;
}

/**
 * Lightweight agent-facing task — subset of TaskRecord for worker dispatch.
 * Matches the existing BaseAgent.Task interface.
 * Note: description is string (not string|object) at the agent level.
 */
export interface AgentTask {
  id: string;
  subject: string;
  description: string;
  context?: string;
  working_directory?: string;
  write_scope?: string[];
  agent_type?: string;
  session_id?: string;
  origin?: string;
  goal?: string;
  taskType?: 'bootstrap' | 'reason' | 'explore' | 'generic';
}

/**
 * DB-level Task row — snake_case fields for SQLite storage.
 * Uses string for status/exit_reason (no enum dependency in DB layer).
 */
export interface TaskDbRow {
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
  /** 外部阻塞原因（与 TaskRecord.blocked_reason 同义，DB 列）。置位时 getReadyTasks 排除。 */
  blocked_reason?: string;
  orchestration?: OrchestrationTaskMetadata;
  origin?: string;
  goal?: string;
  task_type?: string;
  created_at: number;
  updated_at: number;
}

// ═══════════════════════════════════════════════════════════════
// Session
// ═══════════════════════════════════════════════════════════════

/**
 * Canonical Session record — shared between Database and SessionManager.
 */
export interface SessionRecord {
  id: string;
  created_at: number;
  workspace: string;
  user_request: MessageContent | object;
  status: string;
  summary?: string;
  /** 会话名称（自动生成或用户手动编辑）；与 summary（结束总结）语义分离 */
  name?: string;
}

// ═══════════════════════════════════════════════════════════════
// ModelCapability
// ═══════════════════════════════════════════════════════════════

/**
 * ThinkingMode — how to activate thinking for a given provider.
 */
export type ThinkingMode =
  | 'reasoning_effort'   // OpenAI: body.reasoning_effort = "high"
  | 'thinking_block'     // Anthropic: body.thinking = { type: "enabled", budget_tokens: N }
  | 'extra_body';        // Kimi/DeepSeek: body.extra_body.*

/**
 * Canonical model capability spec — describes how to invoke thinking for a model.
 * Unifies config.ts ModelCapability, llm/types.ts ModelCapability, and
 * model_capability_config.ts ModelCapabilityConfig.
 */
export interface ModelCapabilitySpec {
  thinking_mode?: ThinkingMode | null;
  param_name?: string;
  param_value?: unknown;
}
