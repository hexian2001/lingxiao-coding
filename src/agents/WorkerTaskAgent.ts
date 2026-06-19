/**
 * WorkerTaskAgent - 子 Agent 实现
 * 由 Leader 派发执行具体任务的 Agent
 */

import {
  contentToPlainText,
  type ToolCall,
} from '../llm/types.js';
import type { ToolResultContent } from './runtime/ToolResponseProcessor.js';
import type { Task } from './BaseAgentRuntime.js';
import { BaseAgent, type AgentConfig } from './BaseAgentRuntime.js';
import type { AgentExecutionResult } from './AgentExecutionResult.js';

/**
 * WorkerTaskAgent 配置
 */
export interface WorkerTaskAgentConfig extends AgentConfig {
  taskId: string;
  skillNames?: string[];
}

/**
 * WorkerTaskAgent - 子 Agent
 * 继承 BaseAgent，增加任务执行和进度报告功能
 */
export class WorkerTaskAgent extends BaseAgent {
  protected taskId: string;
  protected progressCallback?: (progress: string) => void;

  constructor(config: WorkerTaskAgentConfig) {
    super(config);
    this.taskId = config.taskId;
    if (config.skillNames) {
      this.skillNames = config.skillNames;
    }
  }

  /**
   * 设置进度回调
   */
  setProgressCallback(callback: (progress: string) => void): void {
    this.progressCallback = callback;
  }

  /**
   * 报告进度
   */
  protected reportProgress(message: string): void {
    if (this.progressCallback) {
      this.progressCallback(message);
    }
    this.emitter.emit('agent:progress', {
      agentId: this.agentId,
      name: this.name,
      taskId: this.taskId,
      message,
    });
  }

  private isExecutionResult(value: unknown): value is AgentExecutionResult {
    return Boolean(
      value &&
      typeof value === 'object' &&
      'status' in (value as Record<string, unknown>) &&
      'summary' in (value as Record<string, unknown>)
    );
  }

  /**
   * 执行工具调用（扩展基类方法）
   */
  protected override async executeToolCall(toolCall: ToolCall): Promise<ToolResultContent> {
    this.reportProgress(`执行工具: ${toolCall.function.name}`);

    // 记录工具调用日志
    if (this.db) {
      this.db.insertAgentLog({
        session_id: this.sessionId,
        agent_id: this.agentId,
        agent_name: this.name,
        agent_role: this.role,
        task_id: this.taskId,
        event_type: 'tool_call_start',
        content: JSON.stringify({
          tool_name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }),
        timestamp: Date.now() / 1000,
      });
    }

    const result = await super.executeToolCall(toolCall);
    const resultPreview = typeof result === 'string'
      ? result.slice(0, 500)
      : contentToPlainText(result).slice(0, 500);

    // 记录工具结果日志
    if (this.db) {
      this.db.insertAgentLog({
        session_id: this.sessionId,
        agent_id: this.agentId,
        agent_name: this.name,
        agent_role: this.role,
        task_id: this.taskId,
        event_type: 'tool_result',
        content: JSON.stringify({
          tool_name: toolCall.function.name,
          result_preview: resultPreview,
        }),
        timestamp: Date.now() / 1000,
      });
    }

    return result;
  }

  /**
   * Agent 主循环（扩展基类方法）
   */
  override async run(
    task: Task,
    isResume = false,
    recoveredState?: { iteration?: number; toolCallCount?: number },
  ): Promise<string | import('./AgentExecutionResult.js').AgentExecutionResult> {
    this.reportProgress(`开始任务: ${task.subject}`);

    const result = await super.run(task, isResume, recoveredState);

    if (this.isExecutionResult(result)) {
      if (result.status === 'completed') {
        this.reportProgress(`任务完成: ${task.subject}`);
      } else if (result.status === 'blocked') {
        this.reportProgress(`任务阻塞: ${task.subject} - ${result.summary}`);
      } else {
        this.reportProgress(`任务失败: ${task.subject} - ${result.summary}`);
      }
    } else {
      this.reportProgress(`任务完成: ${task.subject}`);
    }
    return result;
  }
}

export default WorkerTaskAgent;
