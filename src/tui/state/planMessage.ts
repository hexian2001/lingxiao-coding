import { t } from '../../i18n.js';
import { roleHanzi } from '../design/iconography.js';

interface SubmittedPlanTask {
  id: string;
  type?: string;
  subject?: string;
  status?: string;
  blocked_by?: string[];
  working_directory?: string;
  write_scope?: string[];
}

interface SubmittedPlan {
  goal?: string;
  analysis?: string;
  approach?: string;
  risks?: string;
  tasks?: SubmittedPlanTask[];
  groups?: string[][];
  verification?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function displayString(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === 'string');
  return values.length > 0 ? values : undefined;
}

function normalizeTask(value: unknown): SubmittedPlanTask | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    id: displayString(record.id) || '',
    type: displayString(record.type),
    subject: displayString(record.subject),
    status: displayString(record.status),
    blocked_by: stringArray(record.blocked_by),
    working_directory: displayString(record.working_directory),
    write_scope: stringArray(record.write_scope),
  };
}

function normalizePlan(value: unknown): SubmittedPlan {
  const record = asRecord(value);
  if (!record) return {};
  return {
    goal: displayString(record.goal),
    analysis: displayString(record.analysis),
    approach: displayString(record.approach),
    risks: displayString(record.risks),
    tasks: Array.isArray(record.tasks)
      ? record.tasks.map(normalizeTask).filter((task): task is SubmittedPlanTask => task !== undefined)
      : undefined,
    groups: Array.isArray(record.groups)
      ? record.groups.map(stringArray).filter((group): group is string[] => group !== undefined)
      : undefined,
    verification: displayString(record.verification),
  };
}

export function buildSubmittedPlanContent(input: unknown): string {
  const plan = normalizePlan(input);
  const taskIcons: Record<string, string> = { research: roleHanzi('research'), coding: roleHanzi('coding'), verify: roleHanzi('verify'), review: roleHanzi('review') };
  const taskLines = plan.tasks?.map((task, index) => {
    const icon = taskIcons[task.type || ''] || roleHanzi();
    const deps = task.blocked_by?.length ? t('tui.plan.dependency', task.blocked_by.join(', ')) : '';
    const status = task.status ? t('tui.plan.status', task.status) : '';
    const scope = task.working_directory ? `\n> wd: ${task.working_directory}` : '';
    const writeScope = task.write_scope?.length ? `\n> write: ${task.write_scope.join(', ')}` : '';
    const desc = task.subject ? `**${task.subject}**${deps}${status}` : '';
    return `### ${index + 1}. ${icon} [${task.id}] ${desc}${scope}${writeScope}`;
  }).join('\n\n') || '';
  const groupLines = plan.groups?.map((group: string[], index: number) => t('tui.plan.batch', index + 1, group.join(', '))).join('\n\n') || '';

  return [
    `${t('tui.plan.title')}\n\n**${t('tui.plan.goal')}**: ${plan.goal || ''}`,
    plan.analysis ? `## ${t('tui.plan.analysis')}\n${plan.analysis}` : '',
    plan.approach ? `## ${t('tui.plan.approach')}\n${plan.approach}` : '',
    plan.risks ? `> ◆ **${t('tui.plan.risks')}**\n> ${plan.risks}` : '',
    taskLines ? `## ${t('tui.plan.tasks')}\n\n${taskLines}` : '',
    groupLines ? `## ${t('tui.plan.strategy')}\n\n${groupLines}` : '',
    plan.verification ? `## ${t('tui.plan.verification')}\n${plan.verification}` : '',
    `---\n\n${t('tui.plan.approve_hint')}`,
  ].filter(Boolean).join('\n\n');
}
