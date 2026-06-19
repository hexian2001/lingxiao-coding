import type { DatabaseManager } from '../core/Database.js';
import type { ChatMessage } from '../llm/types.js';

export interface SystemPromptContext {
  basePrompt: string;
  dynamicContext?: string | null;
  taskPrompt?: string | null;
}

export interface AgentMessageHistoryDeps {
  db?: DatabaseManager;
  agentId: string;
  agentName?: string;
  sessionId: string;
}

export class AgentMessageHistory {
  private readonly db?: DatabaseManager;
  private readonly agentId: string;
  private readonly agentName: string;
  private readonly sessionId: string;

  constructor(deps: AgentMessageHistoryDeps) {
    this.db = deps.db;
    this.agentId = deps.agentId;
    this.agentName = deps.agentName ?? deps.agentId;
    this.sessionId = deps.sessionId;
  }

  buildSystemPrompt(context: SystemPromptContext): ChatMessage {
    const parts = [context.basePrompt, context.dynamicContext, context.taskPrompt].filter((part): part is string => Boolean(part && part.trim()));
    return {
      role: 'system',
      content: parts.join('\n\n'),
      timestamp: Date.now() / 1000,
    };
  }

  loadHistory(): ChatMessage[] {
    const reader = (this.db as unknown as {
      getAgentMessages?: (sessionId: string, agentId: string) => ChatMessage[];
      getAgentConversation?: (sessionId: string, agentId: string) => ChatMessage[];
    } | undefined);
    return reader?.getAgentMessages?.(this.sessionId, this.agentId)
      ?? reader?.getAgentConversation?.(this.sessionId, this.agentId)
      ?? [];
  }

  async saveHistory(messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      await this.db?.saveAgentMessage?.(this.sessionId, this.agentId, this.agentName, message);
    }
  }

  serialize(messages: ChatMessage[]): string {
    return JSON.stringify(messages);
  }

  deserialize(raw: string): ChatMessage[] {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('agent message history payload must be an array');
    }
    return parsed.filter((msg): msg is ChatMessage => Boolean(msg && typeof msg === 'object' && 'role' in msg && 'content' in msg));
  }
}

export default AgentMessageHistory;
