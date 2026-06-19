/**
 * CompressionTypes — 压缩流水线共享类型
 */

import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import type { ChatMessage } from '../../llm/types.js';
import type { DatabaseManager } from '../Database.js';
import type { EventEmitter } from '../EventEmitter.js';
import type { JudgmentLlmGuardFactory } from '../JudgmentService.js';

/** 上下文所有者：Leader 或 Agent */
export interface ContextOwner {
  kind: 'leader' | 'agent';
  workspace?: string;
  agentId?: string;
  agentName?: string;
}

/** 最近访问文件记录（由 ContextManager 维护） */
export interface FileRecord {
  content: string;
  timestamp: number;
}

/** 压缩中间记录 — 用于算法层抽取 */
export interface CompressionRecord {
  id: string;
  role: ChatMessage['role'];
  category: 'message' | 'tool' | 'task_board' | 'agent_report' | 'tool_call';
  text: string;
  tokenEstimate: number;
}

/** 压缩流水线运行结果 */
export interface CompressionResult {
  /** 压缩后的消息列表 */
  messages: ChatMessage[];
  /** 压缩前 token 数 */
  oldTokens: number;
  /** 压缩后 token 数 */
  newTokens: number;
  /** 压缩前请求体字节数（UTF-8 近似） */
  oldBytes?: number;
  /** 压缩后请求体字节数（UTF-8 近似） */
  newBytes?: number;
  /** 是否真正执行了重压缩（false = 只做 micro/不达阈值） */
  compacted: boolean;
  /** 已有同一上下文压缩正在执行，本次请求未启动第二个压缩任务 */
  inProgress?: boolean;
  /** 实际执行的压缩类型；用于 runtime history / UI 事件区分 micro、manual、hierarchical 等 */
  compactType?: string;
  /** 压缩归档路径 */
  archivePath?: string;
  /** 摘要文本（用于持久化给 worker） */
  summary?: string;
  /** LLM 摘要是否失败（用于推进熔断器） */
  llmFailed?: boolean;
  /** 压缩后仍超阈值并触发硬截断 */
  truncated?: boolean;
  /** 二次截断后仍超阈值，主控应该 emit context:overflow */
  overflow?: boolean;
}

/** 压缩流水线构造参数 */
export interface CompressionPipelineOptions {
  /** 模型最大上下文 token 数（不含输出预留） */
  maxTokens: number;
  /** 触发重压缩的阈值（已扣除 buffer） */
  threshold: number;
  /** 模型 ID */
  model: string;
  /** 会话 ID（用于归档目录、Hook 注入） */
  sessionId?: string;
  /** 数据库（用于 leader_route_history / leader_selected_skills_history） */
  db?: DatabaseManager;
  /** LLM 客户端（缺省时退化为算法摘要） */
  llmClient?: ContentGenerator;
  /** LLM guard factory injected by higher layers; absent means deterministic summary fallback. */
  llmGuardFactory?: JudgmentLlmGuardFactory;
  /** 事件总线（用于 context:compressed 事件） */
  emitter?: EventEmitter;
  /** 上下文所有者 */
  owner: ContextOwner;
  /**
   * 单次 LLM 请求体的最大字节数（UTF-8）。用于字节级压缩触发与二次截断，
   * 规避 HTTP 413（网关 body 字节上限，与 token 窗口无关）。
   */
  maxRequestBytes?: number;
  /** 单条消息字节上限，超过即「中段截断 + 全文归档」 */
  maxSingleMessageBytes?: number;
}

/** 单次 run() 的运行时上下文 */
export interface CompressionRunContext {
  /** 最近访问文件，用于压缩后注入文件快照 */
  recentFiles?: Map<string, FileRecord>;
  /** 压缩类型标签（'auto' | 'manual'） */
  compactType?: string;
}
