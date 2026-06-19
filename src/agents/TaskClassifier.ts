import type { BlackboardGraph } from '../core/blackboard/BlackboardGraph.js';
import { runStructuredJudgment } from '../core/JudgmentService.js';
import { agentLogger } from '../core/Log.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ChatMessage, ToolDefinition } from '../llm/types.js';
import type { GraphSnapshot } from '../core/blackboard/types.js';
import { createLlmGuard } from './LlmGuard.js';
import { getPromptCatalog, type PromptLocale } from './prompts/i18n/catalog.js';

export type TaskType = 'bootstrap' | 'reason' | 'explore' | 'generic';

export interface TaskClassification {
  type: TaskType;
  reason: string;
  confidence: number;
}

// 简化的 Task 接口，只包含分类所需的字段
export interface ClassifiableTask {
  id: string;
  session_id: string;
  taskType?: TaskType;
  origin?: string;
  goal?: string;
  subject?: string;
  description?: string;
  context?: string;
  agent_type?: string;
}

export interface TaskClassificationOptions {
  blackboardGraph?: BlackboardGraph;
  llm?: ContentGenerator;
  model?: string;
  locale?: PromptLocale;
}

export function buildTaskClassificationTool(locale?: PromptLocale): ToolDefinition {
  const catalog = getPromptCatalog(locale).judges.taskClassification;
  return {
    type: 'function',
    function: {
      name: 'submit_task_classification',
      description: catalog.toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: {
            type: 'string',
            enum: ['bootstrap', 'reason', 'explore', 'generic'],
          },
          reason: {
            type: 'string',
          },
          confidence: {
            type: 'number',
          },
        },
        required: ['type', 'reason', 'confidence'],
      },
    },
  };
}

function buildGraphDigest(snapshot?: GraphSnapshot): string {
  if (!snapshot) return '(none)';
  const nodes = snapshot.nodes
    .slice(-20)
    .map((node) => [
      node.id,
      node.kind,
      node.intentStatus ? `status=${node.intentStatus}` : '',
      node.priority != null ? `priority=${node.priority}` : '',
      `title=${node.title}`,
      `content=${node.content.slice(0, 500)}`,
      node.tags.length > 0 ? `tags=${node.tags.join(',')}` : '',
    ].filter(Boolean).join(' | '));
  return [
    `origin=${snapshot.originNode?.title || '(none)'}`,
    `goal=${snapshot.goalNode?.title || '(none)'}`,
    `nodes=${snapshot.nodes.length}`,
    `edges=${snapshot.edges.length}`,
    ...nodes,
  ].join('\n');
}

export function buildClassificationMessages(task: ClassifiableTask, snapshot?: GraphSnapshot, locale?: PromptLocale): ChatMessage[] {
  return [
    {
      role: 'system',
      content: getPromptCatalog(locale).judges.taskClassification.system,
    },
    {
      role: 'user',
      content: [
        `task_id: ${task.id}`,
        `agent_type: ${task.agent_type || '(none)'}`,
        `subject: ${task.subject || '(none)'}`,
        `description: ${task.description || '(none)'}`,
        `context: ${task.context || '(none)'}`,
        `origin: ${task.origin || '(none)'}`,
        `goal: ${task.goal || '(none)'}`,
        '',
        '[blackboard_digest]',
        buildGraphDigest(snapshot),
        '[/blackboard_digest]',
      ].join('\n'),
    },
  ];
}

function validateClassification(payload: unknown): TaskClassification | null {
  if (!payload || typeof payload !== 'object') return null;
  const type = 'type' in payload ? payload.type : undefined;
  const reason = 'reason' in payload ? payload.reason : undefined;
  const confidence = 'confidence' in payload ? payload.confidence : undefined;
  if (type !== 'bootstrap' && type !== 'reason' && type !== 'explore' && type !== 'generic') {
    return null;
  }
  if (typeof reason !== 'string' || typeof confidence !== 'number') {
    return null;
  }
  return {
    type,
    reason,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

export class TaskClassifier {
  static async classify(task: ClassifiableTask, options: TaskClassificationOptions = {}): Promise<TaskClassification> {
    if (task.taskType) {
      return {
        type: task.taskType,
        reason: 'explicit_task_type',
        confidence: 1.0,
      };
    }

    const snapshot = options.blackboardGraph?.getSnapshot(task.session_id);
    const result = await runStructuredJudgment({
      kind: 'task_classification',
      llm: options.llm,
      model: options.model,
      messages: buildClassificationMessages(task, snapshot, options.locale),
      tool: buildTaskClassificationTool(options.locale),
      validate: validateClassification,
      llmGuardFactory: createLlmGuard,
      logger: agentLogger,
      gatewayContext: {
        actorType: 'agent',
        actorLabel: 'TaskClassifier',
        purpose: 'verify',
        sessionId: task.session_id,
        taskId: task.id,
        role: task.agent_type,
        requestedModel: options.model,
      },
    });

    return result.verdict ?? {
      type: 'generic',
      reason: result.status === 'unavailable' ? 'judge_unavailable' : 'judge_invalid',
      confidence: 0,
    };
  }
}
