/**
 * LLM 客户端类型定义
 */

import {
  contentToPlainText,
  extractAgentMention,
  hasImageContent,
  isContentPartArray,
  isEmptyContent,
  normalizeMessageContent,
  thinkingBlocksToText,
} from '../contracts/types/Message.js';
import type {
  BaseMessage,
  LlmThinkingBlock,
} from '../contracts/types/Message.js';
import type {
  ImageBlobRefContentPart,
  ImageUrlContentPart,
  MessageContent,
  MessageContentPart,
  TextContentPart,
  TokenUsage as CanonicalTokenUsage,
  ModelCapabilitySpec,
} from '../types/canonical.js';
import type { ToolDefinition } from '../contracts/types/Tool.js';

/**
 * 模型支持的输入模态
 * 省略或 false 表示该模型不支持对应输入类型
 */
export type InputModalities = {
  image?: boolean;
  pdf?: boolean;
  audio?: boolean;
  video?: boolean;
};

export type { TextContentPart };
export type {
  ImageBlobRefContentPart,
  ImageUrlContentPart,
  McpAppContentPart,
  MessageContent,
  MessageContentPart,
} from '../types/canonical.js';
export {
  contentToPlainText,
  extractAgentMention,
  hasImageContent,
  isContentPartArray,
  isEmptyContent,
  normalizeMessageContent,
};

/**
 * 结构化 thinking / reasoning block
 *
 * 替代旧的 `reasoning_content: string`，能够保留 Anthropic thinking block
 * 必需的 `signature` 字段以及 `redacted_thinking` 形态。
 *
 * - `thinking`：明文推理；`signature` 来自 Anthropic（重要！服务端校验需要原样回传）
 * - `redacted_thinking`：服务端加密的推理（不可读），仅承载 `data` 用于回传
 */
export type ThinkingBlock = LlmThinkingBlock;

/**
 * 工具方法：将 ThinkingBlock 数组拼成纯文本（用于 UI 展示 / token 计数 / 日志）
 */
export { thinkingBlocksToText };

/**
 * 结构化消息种类（discriminated by metadata.kind）。
 *
 * 用于上下文压缩器等下游按结构化字段判定消息用途，而非字符串内容嗅探
 * （禁止启发式：不用 text.includes/startsWith 关键词判结构）。
 *
 * - context_summary：压缩器注入的「上下文压缩摘要」消息
 * - context_file_snapshot：压缩器注入的「上下文文件快照」消息
 * - task_board_snapshot：TaskBoard 快照注入消息
 * - agent_report：Agent 进展汇报注入消息
 */
export type ChatMessageKind =
  | 'context_summary'
  | 'context_file_snapshot'
  | 'task_board_snapshot'
  | 'agent_report';

/**
 * ChatMessage 结构化元数据。kind 为判别字段，下游按 kind 走确定性分支。
 */
export interface ChatMessageMetadata {
  kind?: ChatMessageKind;
  [key: string]: unknown;
}

// 消息类型
export interface ChatMessage extends Pick<BaseMessage, 'role'> {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * 结构化 thinking blocks（替代 reasoning_content）。
   * 仅 assistant 消息会携带；多轮调用时必须原样回传给上游 thinking-mode API。
   */
  thinking?: ThinkingBlock[];
  timestamp?: number; // Unix epoch seconds, 用于上下文压缩时间判断
  /**
   * 结构化元数据：判别字段 kind 标识消息用途（压缩摘要 / 文件快照 / 任务看板快照 / Agent 汇报）。
   * 下游（如上下文压缩器）按 kind 字段判定结构，禁止用文本内容前缀嗅探（违反禁止启发式）。
   */
  metadata?: ChatMessageMetadata;
}

// 工具调用
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type { ToolDefinition };

// Token 使用情况 — re-exported from canonical
export type TokenUsage = CanonicalTokenUsage;

/**
 * 流式工具调用入参增量。
 * Anthropic 的 input_json_delta / OpenAI 的 delta.tool_calls[].function.arguments 都会触发。
 * 用于让前端在 LLM 还没结束这一轮工具调用前就先看到"参数生成中"，避免长 JSON 期间 UI 静默。
 */
export interface ToolCallDeltaInfo {
  /** provider 内部的 tool_call index（同一轮可能有多个并行工具调用） */
  index: number;
  /** tool_call id（首次出现时携带，后续 chunk 可省略） */
  id?: string;
  /** 工具名（首次出现时携带，后续 chunk 可省略） */
  name?: string;
  /** 这一帧到达的 JSON 片段（可能为空，仅作 start marker） */
  partialJson: string;
}

export type LlmRoundEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_call_delta'; delta: ToolCallDeltaInfo }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'progress'; progress: { elapsed: number; status: string } }
  | { type: 'retry'; attempt: number; error: Error }
  | { type: 'stream_retry'; attempt: number; error: Error }
  | { type: 'first_token' }
  | { type: 'error'; error: Error };

// 聊天响应
export interface ChatResponse {
  content: MessageContent;
  thinking?: ThinkingBlock[];
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
  model?: string;
  finish_reason?: string;
  was_output_truncated?: boolean;  // 输出因 max_tokens 被截断
  gateway?: {
    traceId: string;
    profile: string;
    selectedModel: string;
    finalModel?: string;
    fallbackModels: string[];
    attempts: Array<{
      model: string;
      status: 'started' | 'success' | 'failed' | 'skipped';
      errorKind?: string;
      errorMessage?: string;
      retryable?: boolean;
      elapsedMs?: number;
    }>;
  };
}

// 流式响应回调
export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  /**
   * 流式工具入参增量回调。
   * 在 LLM 仍在生成 tool 参数 JSON 时按 chunk 触发，让上层把"参数生成中"事件
   * 推到前端，避免长 JSON 期间 UI 完全静默。
   * 触发时机：Anthropic input_json_delta / OpenAI delta.tool_calls[].arguments。
   * 触发时 onToolCall 还未触发（onToolCall 仅在该 tool_call 流式完成时一次性触发）。
   */
  onToolCallDelta?: (delta: ToolCallDeltaInfo) => void;
  onUsage?: (usage: TokenUsage) => void;
  onError?: (error: Error) => void;
  onRetry?: (attempt: number, error: Error) => void;
  /** 进度心跳回调，每 3s 触发一次，携带已耗时和状态文本 */
  onProgress?: (progress: { elapsed: number; status: string }) => void;
  /**
   * audit-2026-05-15：流式重试前通知上层丢弃已渲染的部分输出。
   * 参考 qwen-code StreamEventType.RETRY + turn.ts:286-296。
   * 上层收到此回调后应 rollback 半截 assistant turn（清空 pendingText/toolCalls）。
   */
  onStreamRetry?: (attempt: number, error: Error) => void;
  /**
   * 首个有效 token 到达回调。
   * 用于精确切换 model_requesting → streaming 阶段（对齐 CodeBuddy TTFT 感知）。
   * 仅在流式期间第一个 text/thinking/tool_call_delta 到达时触发一次。
   */
  onFirstToken?: () => void;
}

// LLM 客户端接口 — 已迁移到 ContentGenerator，此处保留类型别名供过渡期兼容
import type { ContentGenerator } from './ContentGenerator.js';
export type LLMClient = ContentGenerator;

// 模型能力配置 — re-exported from canonical
export type ModelCapability = ModelCapabilitySpec;
