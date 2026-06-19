import { normalizeAgentStatus, normalizeTaskDisplayState } from '../../core/StateSemantics.js';
import { tuiTheme } from '../theme.js';
import {
  STATUS_ICON,
  roleHanzi,
  phaseHanzi,
  PRIORITY_ICON,
  GRAPH_NODE_HANZI,
  PROGRESS_FILLED,
  PROGRESS_EMPTY,
} from './iconography.js';

export interface TuiVisual {
  icon: string;
  color: string;
  label: string;
}

export interface TuiRoleVisual extends TuiVisual {
  abbr: string;
}

// 角色字（研/码/审…）取自 iconography 单一事实源；abbr 保留供窄终端回退。
const roleVisuals: Record<string, TuiRoleVisual> = {
  research: { icon: roleHanzi('research'), color: tuiTheme.semantic.role.research, label: 'research', abbr: 'RSC' },
  coding: { icon: roleHanzi('coding'), color: tuiTheme.semantic.role.coding, label: 'coding', abbr: 'DEV' },
  review: { icon: roleHanzi('review'), color: tuiTheme.semantic.role.review, label: 'review', abbr: 'REV' },
  verify: { icon: roleHanzi('verify'), color: tuiTheme.semantic.role.verify, label: 'verify', abbr: 'VFY' },
  frontend: { icon: roleHanzi('frontend'), color: tuiTheme.semantic.role.frontend, label: 'frontend', abbr: 'FE ' },
  backend: { icon: roleHanzi('backend'), color: tuiTheme.semantic.role.backend, label: 'backend', abbr: 'BE ' },
  qa: { icon: roleHanzi('qa'), color: tuiTheme.semantic.role.qa, label: 'qa', abbr: 'QA ' },
  ux_designer: { icon: roleHanzi('ux_designer'), color: tuiTheme.semantic.role.uxDesigner, label: 'ux_designer', abbr: 'UX ' },
  planning: { icon: roleHanzi('planning'), color: tuiTheme.semantic.role.planning, label: 'planning', abbr: 'PLN' },
  testing: { icon: roleHanzi('testing'), color: tuiTheme.semantic.role.testing, label: 'testing', abbr: 'TST' },
  architect: { icon: roleHanzi('architect'), color: tuiTheme.semantic.role.architect, label: 'architect', abbr: 'ARC' },
};

export function getRoleVisual(role?: string): TuiRoleVisual {
  if (role && roleVisuals[role]) return roleVisuals[role];
  return { icon: roleHanzi(), color: tuiTheme.semantic.role.default, label: role || 'agent', abbr: 'AGT' };
}

export function getPhaseVisual(phase?: string): TuiVisual {
  switch (phase) {
    case 'research':
      return { icon: phaseHanzi('research'), color: tuiTheme.semantic.phase.research, label: 'research' };
    case 'coding':
      return { icon: phaseHanzi('coding'), color: tuiTheme.semantic.phase.coding, label: 'coding' };
    case 'testing':
      return { icon: phaseHanzi('testing'), color: tuiTheme.semantic.phase.testing, label: 'testing' };
    case 'reviewing':
      return { icon: phaseHanzi('reviewing'), color: tuiTheme.semantic.phase.reviewing, label: 'reviewing' };
    case 'planning':
      return { icon: phaseHanzi('planning'), color: tuiTheme.semantic.phase.planning, label: 'planning' };
    default:
      return { icon: phaseHanzi(), color: tuiTheme.semantic.phase.other, label: phase || 'other' };
  }
}

export function getPriorityVisual(priority?: 'critical' | 'important' | 'normal'): TuiVisual {
  switch (priority) {
    case 'critical':
      return { icon: PRIORITY_ICON.critical, color: tuiTheme.semantic.priority.critical, label: 'CRITICAL' };
    case 'important':
      return { icon: PRIORITY_ICON.important, color: tuiTheme.semantic.priority.important, label: 'IMPORTANT' };
    default:
      return { icon: PRIORITY_ICON.normal, color: tuiTheme.semantic.priority.normal, label: 'INFO' };
  }
}

export function getAgentStatusVisual(status: string): TuiVisual & {
  bucket: 'running' | 'done' | 'failed' | 'idle' | 'paused';
} {
  const normalized = normalizeAgentStatus(status);
  if (normalized === 'failed') {
    return { icon: STATUS_ICON.failed, color: tuiTheme.semantic.status.failed, label: 'failed', bucket: 'failed' };
  }
  if (normalized === 'interrupted') {
    return { icon: STATUS_ICON.interrupted, color: tuiTheme.semantic.status.interrupted, label: 'paused', bucket: 'paused' };
  }
  if (normalized === 'completed') {
    return { icon: STATUS_ICON.completed, color: tuiTheme.semantic.status.completed, label: 'done', bucket: 'done' };
  }
  if (normalized === 'running') {
    return { icon: STATUS_ICON.running, color: tuiTheme.semantic.status.running, label: 'running', bucket: 'running' };
  }
  return { icon: STATUS_ICON.idle, color: tuiTheme.semantic.status.idle, label: 'idle', bucket: 'idle' };
}

export type TaskVisualStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export function getTaskVisualStatus(task: {
  status: string;
  displayState?: string;
  display_state?: string;
  exitReason?: string;
  exit_reason?: string;
}): TaskVisualStatus {
  const normalized = normalizeTaskDisplayState(task);
  if (normalized === 'running') return 'in_progress';
  if (normalized === 'dispatchable') return 'pending';
  return normalized;
}

export function getTaskStatusVisual(status: TaskVisualStatus): TuiVisual & { barChar: string } {
  switch (status) {
    case 'completed':
      return { icon: STATUS_ICON.completed, color: tuiTheme.semantic.status.completed, label: 'completed', barChar: PROGRESS_FILLED };
    case 'in_progress':
      return { icon: STATUS_ICON.in_progress, color: tuiTheme.semantic.status.info, label: 'running', barChar: PROGRESS_FILLED };
    case 'blocked':
      return { icon: STATUS_ICON.blocked, color: tuiTheme.semantic.status.blocked, label: 'blocked', barChar: '~' };
    case 'failed':
      return { icon: STATUS_ICON.failed, color: tuiTheme.semantic.status.failed, label: 'failed', barChar: PROGRESS_EMPTY };
    case 'cancelled':
      return { icon: STATUS_ICON.cancelled, color: tuiTheme.semantic.status.cancelled, label: 'cancelled', barChar: PROGRESS_EMPTY };
    default:
      return { icon: STATUS_ICON.pending, color: tuiTheme.semantic.status.pending, label: 'pending', barChar: PROGRESS_EMPTY };
  }
}

export type GraphNodeVisualKind = 'origin' | 'goal' | 'fact' | 'intent' | 'hint';

export function getGraphNodeVisual(kind: GraphNodeVisualKind): TuiVisual {
  switch (kind) {
    case 'origin':
      return { icon: GRAPH_NODE_HANZI.origin, color: tuiTheme.semantic.runtime.leader, label: 'Origin' };
    case 'goal':
      return { icon: GRAPH_NODE_HANZI.goal, color: tuiTheme.semantic.status.completed, label: 'Goal' };
    case 'fact':
      return { icon: GRAPH_NODE_HANZI.fact, color: tuiTheme.semantic.status.info, label: 'Facts' };
    case 'intent':
      return { icon: GRAPH_NODE_HANZI.intent, color: tuiTheme.semantic.status.blocked, label: 'Intents' };
    case 'hint':
      return { icon: GRAPH_NODE_HANZI.hint, color: tuiTheme.semantic.runtime.agent, label: 'Hints' };
  }
}
