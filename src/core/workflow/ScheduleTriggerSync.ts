import type {
  ScheduledTaskAudience,
  ScheduledTaskIntensity,
  ScheduledTaskRecord,
} from '../Database.js';
import type { ScheduledTaskManager } from '../ScheduledTaskManager.js';
import { getNextCronTime } from '../ScheduledTaskManager.js';
import type { NodeDefinition, WorkflowDefinition } from './types.js';

const SOURCE_TYPE = 'workflow_trigger' as const;

export interface WorkflowScheduleTriggerSyncResult {
  workflowId: string;
  synced: Array<{
    nodeId: string;
    taskId: string;
    cron: string;
    status: 'created' | 'updated';
    next_run_at: number | null;
  }>;
  deleted: Array<{
    nodeId: string;
    taskId?: string;
    reason: 'removed' | 'invalid';
  }>;
  warnings: string[];
  errors: string[];
}

type TriggerConfig = {
  cron: string;
  sessionId: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  enabled: boolean;
  intensity: ScheduledTaskIntensity;
  audience: ScheduledTaskAudience;
  workflowInput: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key];
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeIntensity(value: unknown): ScheduledTaskIntensity {
  return value === 'gentle' || value === 'normal' || value === 'aggressive' || value === 'critical'
    ? value
    : 'normal';
}

function normalizeAudience(value: unknown): ScheduledTaskAudience {
  return value === 'personal' || value === 'team' || value === 'ops' || value === 'customer'
    ? value
    : 'personal';
}

function extractTriggerConfig(workflow: WorkflowDefinition, node: NodeDefinition): { config?: TriggerConfig; warning?: string } {
  const rawConfig = isRecord(node.data?.config) ? node.data.config : {};
  const cron = readString(rawConfig, 'scheduleCron');
  if (!cron) {
    return { warning: `schedule_trigger node ${node.id} is missing scheduleCron` };
  }
  if (getNextCronTime(cron, Date.now()) === null) {
    return { warning: `schedule_trigger node ${node.id} has invalid cron: ${cron}` };
  }

  const workflowInput = isRecord(rawConfig.scheduleWorkflowInput) ? rawConfig.scheduleWorkflowInput : {};
  const sessionId = readString(rawConfig, 'scheduleSessionId') ?? normalizeSessionId(workflow.config.sessionId);
  if (!sessionId) {
    return { warning: `schedule_trigger node ${node.id} is missing sessionId; set scheduleSessionId or workflow.config.sessionId` };
  }

  return {
    config: {
      cron,
      sessionId,
      prompt: readString(rawConfig, 'schedulePrompt') || node.data?.label || `Workflow trigger ${node.id}`,
      recurring: readBoolean(rawConfig, 'scheduleRecurring', true),
      durable: readBoolean(rawConfig, 'scheduleDurable', true),
      enabled: readBoolean(rawConfig, 'scheduleEnabled', true),
      intensity: normalizeIntensity(rawConfig.scheduleIntensity),
      audience: normalizeAudience(rawConfig.scheduleAudience),
      workflowInput: workflowInput as Record<string, unknown>,
    },
  };
}

function currentTriggerNodeIds(workflow: WorkflowDefinition): Set<string> {
  return new Set(workflow.nodes.filter(node => node.data?.type === 'schedule_trigger').map(node => node.id));
}

export function syncWorkflowScheduleTriggers(
  workflow: WorkflowDefinition,
  scheduledTaskManager: ScheduledTaskManager,
): WorkflowScheduleTriggerSyncResult {
  const result: WorkflowScheduleTriggerSyncResult = {
    workflowId: workflow.id,
    synced: [],
    deleted: [],
    warnings: [],
    errors: [],
  };
  const triggerNodeIds = currentTriggerNodeIds(workflow);
  const existingTasks = scheduledTaskManager.getTasksBySource(SOURCE_TYPE, workflow.id);
  const existingByNode = new Map(existingTasks.map(task => [task.source_node_id, task] as const));

  for (const task of existingTasks) {
    if (!task.source_node_id || !triggerNodeIds.has(task.source_node_id)) {
      scheduledTaskManager.deleteTask(task.id);
      result.deleted.push({ nodeId: task.source_node_id || '<unknown>', taskId: task.id, reason: 'removed' });
    }
  }

  for (const node of workflow.nodes) {
    if (node.data?.type !== 'schedule_trigger') continue;
    const extracted = extractTriggerConfig(workflow, node);
    if (!extracted.config) {
      if (extracted.warning) result.warnings.push(extracted.warning);
      const existing = existingByNode.get(node.id);
      if (existing) {
        scheduledTaskManager.deleteTask(existing.id);
        result.deleted.push({ nodeId: node.id, taskId: existing.id, reason: 'invalid' });
      }
      continue;
    }

    const existed = existingByNode.has(node.id);
    try {
      const upserted = scheduledTaskManager.upsertTaskBySource({
        sourceType: SOURCE_TYPE,
        sourceId: workflow.id,
        sourceNodeId: node.id,
        cron: extracted.config.cron,
        prompt: extracted.config.prompt,
        recurring: extracted.config.recurring,
        durable: extracted.config.durable,
        enabled: extracted.config.enabled,
        sessionId: extracted.config.sessionId,
        taskType: 'workflow',
        workflowId: workflow.id,
        workflowInput: extracted.config.workflowInput,
        intensity: extracted.config.intensity,
        audience: extracted.config.audience,
      });
      result.synced.push({
        nodeId: node.id,
        taskId: upserted.id,
        cron: extracted.config.cron,
        status: existed ? 'updated' : 'created',
        next_run_at: upserted.next_run_at,
      });
    } catch (error) {
      result.errors.push(`schedule_trigger node ${node.id} sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

export function deleteWorkflowScheduleTriggers(
  workflowId: string,
  scheduledTaskManager: ScheduledTaskManager,
): WorkflowScheduleTriggerSyncResult {
  const existingTasks = scheduledTaskManager.getTasksBySource(SOURCE_TYPE, workflowId);
  scheduledTaskManager.deleteTasksBySource(SOURCE_TYPE, workflowId);
  return {
    workflowId,
    synced: [],
    deleted: existingTasks.map((task: ScheduledTaskRecord) => ({
      nodeId: task.source_node_id || '<unknown>',
      taskId: task.id,
      reason: 'removed',
    })),
    warnings: [],
    errors: [],
  };
}
