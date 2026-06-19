import { WorkNoteManager } from '../core/WorkNoteManager.js';
import type { ChatMessage } from '../llm/types.js';
import type { AgentTask } from '../types/canonical.js';
import {
  detectAgentPhase,
  extractAgentArtifactsFromMessages,
} from './AgentRuntimeUtilities.js';

type LoggerLike = {
  debug?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
};

export interface AgentCompletionNoteInput {
  workspace?: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  role: string;
  task: AgentTask;
  result: string;
  messages: ChatMessage[];
  logger?: LoggerLike;
}

export async function autoWriteAgentCompletionNote(input: AgentCompletionNoteInput): Promise<void> {
  try {
    const manager = new WorkNoteManager(input.workspace ? `${input.workspace}/.lingxiao` : undefined);
    const existingNotes = await manager.getAgentNotes(input.sessionId, input.agentId);
    const hasRecentNote = existingNotes.some((note) =>
      note.taskId === input.task.id && (Date.now() / 1000 - note.timestamp) < 300
    );

    if (hasRecentNote) {
      return;
    }

    const resultPreview = input.result.length > 1000 ? `${input.result.slice(0, 1000)}...` : input.result;
    await manager.writeNoteWithSession(input.sessionId, {
      agentId: input.agentId,
      taskId: input.task.id,
      phase: detectAgentPhase(input.task, input.role),
      summary: `任务 ${input.task.id} 完成: ${input.task.subject}`,
      details: resultPreview,
      artifacts: extractAgentArtifactsFromMessages(input.messages),
    });

    input.logger?.debug?.(`[${input.agentName}] 自动写入完成笔记 (task=${input.task.id})`);
  } catch (error) {
    input.logger?.warn?.(`[${input.agentName}] 自动写笔记失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
