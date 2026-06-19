import type { TokenUsage } from '../types/canonical.js';
import type { DatabaseManager } from './Database.js';
import type { EventEmitter } from './EventEmitter.js';
import { coreLogger } from './Log.js';

/**
 * Token 使用记录 — re-exported from canonical
 */
export type { TokenUsage } from '../types/canonical.js';

/**
 * Agent Token 汇总
 */
export interface AgentTokenSummary {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * TokenTracker - Token 使用追踪器
 * 
 * 负责记录和汇总所有 Agent 的 token 使用情况
 * 参考 Python 版本的 TokenTracker 实现
 */
export class TokenTracker {
  private sessionId: string;
  private db: DatabaseManager;
  private emitter: EventEmitter;
  private usage: Map<string, AgentTokenSummary> = new Map();
  private historyLoaded = false;

  constructor(sessionId: string, db: DatabaseManager, emitter: EventEmitter) {
    this.sessionId = sessionId;
    this.db = db;
    this.emitter = emitter;
  }

  /**
   * 记录单次 token 使用
   * 
   * @param agentId Agent ID
   * @param agentName Agent 名称
   * @param usage Token 使用量
   */
  async record(agentId: string, agentName: string, usage: TokenUsage): Promise<void> {
    // 初始化 Agent 的用量记录
    if (!this.usage.has(agentId)) {
      this.usage.set(agentId, { prompt: 0, completion: 0, total: 0 });
    }

    const agentUsage = this.usage.get(agentId)!;
    agentUsage.prompt += usage.prompt_tokens || 0;
    agentUsage.completion += usage.completion_tokens || 0;
    agentUsage.total += usage.total_tokens || 0;

    let persisted = true;
    let persistError: string | undefined;
    try {
      this.db.insertTokenUsage(
        this.sessionId,
        agentId,
        agentName,
        usage.prompt_tokens || 0,
        usage.completion_tokens || 0,
        usage.total_tokens || 0
      );
    } catch (error) {
      persisted = false;
      persistError = error instanceof Error ? error.message : String(error);
      coreLogger.error(`[TokenTracker] 保存 token 使用失败: ${persistError}`);
    }

    const event = {
      sessionId: this.sessionId,
      agentId,
      ts: Date.now(),
      usage: {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
      },
      persisted,
      persistError,
    };

    this.emitter.emit('token:usage', event);
    if (!persisted) {
      this.emitter.emit('token:usage:persist_failed', { ...event, persisted: false });
    }
  }

  /**
   * 按 Agent 汇总 token 使用
   * 
   * @returns Map<AgentId, AgentTokenSummary>
   */
  getAgentSummary(): Map<string, AgentTokenSummary> {
    return new Map(this.usage);
  }

  /**
   * 获取会话总 token 使用量
   * 
   * @returns AgentTokenSummary
   */
  getSessionTotal(): AgentTokenSummary {
    const total: AgentTokenSummary = { prompt: 0, completion: 0, total: 0 };
    
    for (const usage of this.usage.values()) {
      total.prompt += usage.prompt;
      total.completion += usage.completion;
      total.total += usage.total;
    }

    return total;
  }

  /**
   * 从数据库加载历史用量
   * 
   * 恢复会话时会调用此方法，将历史用量累加到当前统计中
   */
  async loadHistory(): Promise<void> {
    if (!this.db || this.historyLoaded) {
      return;
    }

    coreLogger.debug(`[TokenTracker] 正在从数据库恢复会话 ${this.sessionId} 的 Token 历史...`);

    try {
      const logs = await this.db.getTokenSummary(this.sessionId);
      
      if (logs.length > 0) {
        coreLogger.debug(`[TokenTracker] 发现 ${logs.length} 位 Agent 的历史用量记录，正在累计...`);
      }

      for (const log of logs) {
        const agentId = log.agent_id;
        
        if (!this.usage.has(agentId)) {
          this.usage.set(agentId, { prompt: 0, completion: 0, total: 0 });
        }

        const agentUsage = this.usage.get(agentId)!;
        agentUsage.prompt += log.prompt || 0;
        agentUsage.completion += log.completion || 0;
        agentUsage.total += log.total || 0;
      }

      const sessionTotal = this.getSessionTotal();
      coreLogger.debug(
        `[TokenTracker] 恢复历史用量完成：总计 ${sessionTotal.total} tokens ` +
        `(prompt: ${sessionTotal.prompt}, completion: ${sessionTotal.completion})`
      );
      this.historyLoaded = true;
    } catch (error) {
      coreLogger.warn(`[TokenTracker] 恢复历史失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 获取特定 Agent 的 token 使用量
   * 
   * @param agentId Agent ID
   * @returns AgentTokenSummary | undefined
   */
  getAgentUsage(agentId: string): AgentTokenSummary | undefined {
    return this.usage.get(agentId);
  }

  /**
   * 清空所有记录
   */
  clear(): void {
    this.usage.clear();
    this.historyLoaded = false;
  }
}

export default TokenTracker;
