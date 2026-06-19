/**
 * 凌霄剑域 - 动态智能编排系统 (Node.js 版本)
 * 主入口文件
 */

// 导出配置
export * from './config.js';

// 导出核心模块
export {
  DatabaseManager,
  type Session as DBSession,
  type Task as DBTask,
  type Message,
  type AgentLog,
  type TokenUsage as DBTokenUsage,
  type ConversationMessage,
  type AgentState,
} from './core/Database.js';
export * from './core/EventEmitter.js';
export * from './core/CleanupRegistry.js';
export * from './core/MessageBus.js';
export * from './core/TaskBoard.js';
export { SessionManager, type SessionState } from './core/SessionManager.js';

// 导出 LLM 模块
export { LLMClientManager, createLLMClient } from './llm/Client.js';
export type { ContentGenerator, ContentGeneratorConfig, GenerateContentParams, StreamEvent, CountTokensParams, CountTokensResult } from './llm/ContentGenerator.js';
export type { ChatMessage, ChatResponse, LLMClient, StreamCallbacks, ToolDefinition, ToolCall, TokenUsage as LLMTokenUsage, ModelCapability } from './llm/types.js';

// 导出工具模块
export {
  Tool,
  ToolRegistry,
  createToolRegistry,
  FileReadTool,
  FileCreateTool,
  ListDirTool,
  ShellTool,
} from './tools/index.js';
export type { ToolContext, ToolResult } from './tools/index.js';

// 导出 Agent 模块
export type { Task, TokenTracker, AgentConfig } from './agents/BaseAgentRuntime.js';
export { BaseAgent } from './agents/BaseAgentRuntime.js';

// 导出服务器
export { createServer, createServerWithDeps, startServer } from './server.js';

export * from './version.js';
export type {
  AgentRunStatus,
  BaseMessage,
  ContentBlock,
  EventEnvelope,
  EventType,
  JsonSchema,
  MessageRole,
  SessionPhase,
  ToolCallStatus,
  ToolContract,
  ToolScope,
  WorkflowState,
} from './contracts/index.js';
export {
  EMPTY_TOKEN_USAGE,
  isActiveSessionPhase,
  isEventType,
  isTerminalAgentStatus,
  isTerminalTaskStatus,
  isTerminalToolCallStatus,
  isToolCallEvent,
  isToolResultEvent,
  fromView,
  merge,
  parseEventEnvelope,
  toView,
} from './contracts/index.js';

// 导出 canonical types (统一类型源)
export type {
  TokenUsage,
  TokenUsageRecord,
  EternalTokenSnapshot,
  TaskRecord,
  AgentTask,
  TaskDbRow,
  SessionRecord,
  ThinkingMode,
  ModelCapabilitySpec,
} from './types/canonical.js';
