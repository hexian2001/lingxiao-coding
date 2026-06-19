/**
 * WikiAgent — 扩展 BaseAgent 的 Wiki 文档生成 Agent
 *
 * 拥有完整的 LLM 工具调用循环（file_read, list_dir, code_search），
 * 能够自主探索代码库后编写文档，而非依赖预读源码的原始 LLM 调用。
 *
 * 特别处理：
 * - 使用独立 EventEmitter，wiki agent 事件不污染主 TUI 进度
 * - 覆盖 completion guard：非空即接受，wiki 文档内容绝不走 LLM judge
 */

import { BaseAgent, type AgentConfig } from '../agents/BaseAgentRuntime.js';
import type { WorkerCompletionDecision } from '../agents/runtime/WorkerCompletionPolicy.js';
import type { WikiStreamCallback, WikiProgressCallback } from './types.js';
import type { Task } from '../agents/BaseAgentRuntime.js';

export class WikiAgent extends BaseAgent {
  private onStreamChunk?: WikiStreamCallback;
  private onProgress?: WikiProgressCallback;
  /** 当前正在生成的文档 section 上下文，供 BaseAgent.onText 回调使用 */
  currentSectionId = '';
  currentSectionTitle = '';

  constructor(config: AgentConfig) {
    super(config);
  }

  setStreamCallback(cb: WikiStreamCallback) {
    this.onStreamChunk = cb;
  }

  setProgressCallback(cb: WikiProgressCallback) {
    this.onProgress = cb;
  }

  getStreamCallback(): WikiStreamCallback | undefined {
    return this.onStreamChunk;
  }

  getProgressCallback(): WikiProgressCallback | undefined {
    return this.onProgress;
  }

  /**
   * 覆盖 completion guard：wiki-writer 输出是 Markdown 文档。
   * 只要非空就直接接受 — 文档里可能包含任何词汇（"let me", "starting", "I will"...），
   * 绝不用正则或 LLM judge 来判断，否则必然误杀。
   */
  protected override async evaluateCompletionCandidate(
    final: string,
    _task: Task,
  ): Promise<WorkerCompletionDecision> {
    if (!final || final.trim().length === 0) {
      return {
        accepted: false,
        reason: 'empty_output',
        feedback: '输出为空，请生成完整的 Markdown 文档内容后再结束。',
      };
    }
    return { accepted: true, feedback: '' };
  }
}
