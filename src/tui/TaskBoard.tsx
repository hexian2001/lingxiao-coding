/**
 * TaskBoard - Enhanced three-column task visualization
 * Layout: Pending/Blocked | In Progress | Completed/Failed
 * Supports responsive mode (single column on narrow terminals)
 */
import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { sortTasksForDisplay, truncateDisplayText } from './utils.js';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';
import { normalizeTaskDisplayState } from '../core/StateSemantics.js';
import { getTaskStatusVisual } from './design/visuals.js';

import type { TaskDisplayState } from '../core/TaskDisplayState.js';

type InternalTaskStatus = 'dispatchable' | 'running' | 'terminal';
type TaskDisplayStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
type DisplayStatus = TaskDisplayStatus;

interface Task {
  id: string;
  subject: string;
  status: InternalTaskStatus | TaskDisplayStatus;
  displayState?: TaskDisplayState;
  exitReason?: string;
  exit_reason?: string;
  agent_type?: string;
  assigned_agent?: string;
  blocked_by?: string[];
}

interface TaskBoardProps {
  tasks: Task[];
  width?: number;
}

const TASK_STATUS_ICONS: Record<DisplayStatus, string> = {
  pending: getTaskStatusVisual('pending').icon,
  blocked: getTaskStatusVisual('blocked').icon,
  in_progress: getTaskStatusVisual('in_progress').icon,
  completed: getTaskStatusVisual('completed').icon,
  failed: getTaskStatusVisual('failed').icon,
  cancelled: getTaskStatusVisual('cancelled').icon,
};

const MIN_WIDTH_FOR_COLUMNS = 80;

function getTaskDisplayStatus(task: Task): DisplayStatus {
  const normalized = normalizeTaskDisplayState(task);
  return normalized === 'running' ? 'in_progress' : normalized === 'dispatchable' ? 'pending' : normalized;
}

function getTaskColor(status: DisplayStatus, defaultColor: string): string {
  if (status === 'in_progress') return tuiTheme.semantic.status.info;
  if (status === 'pending') return defaultColor;
  return getTaskStatusVisual(status === 'completed' || status === 'blocked' || status === 'failed' || status === 'cancelled' ? status : 'pending').color;
}

/**
 * Renders a single task column with header and scrollable content
 */
const TaskColumn: FunctionComponent<{
  title: string;
  tasks: Task[];
  icon: string;
  color?: string;
  maxWidth: number;
  showAgent?: boolean;
}> = ({ title, tasks, icon, color = tuiTheme.semantic.text.primary, maxWidth, showAgent = true }) => {
  // Reserve space for padding and borders
  const columnWidth = Math.max(24, Math.floor(maxWidth / 3) - 4);
  // Subject truncation: reserve space for icon, ID, brackets, and optional agent info
  const maxSubjectWidth = columnWidth - 10; // "[T-XX] " + emoji + agent info buffer

  return (
    <Box flexDirection="column" width={columnWidth}>
      <Text bold color={color}>
        {icon} {title} ({tasks.length})
      </Text>
      {tasks.length === 0 ? (
        <Text color={tuiTheme.semantic.panel.empty}>{t('tui.task.empty_dash')}</Text>
      ) : (
        <Box flexDirection="column">
          {tasks.map((task) => {
            const displayStatus = getTaskDisplayStatus(task);
            const agentInfo = showAgent && task.assigned_agent ? ` @${task.assigned_agent}` : '';
            const blockedInfo = displayStatus === 'blocked' && task.blocked_by?.length
              ? `\n    └─ ${t('tui.task.depends_on')} ${task.blocked_by.join(', ')}`
              : '';
            const taskText = `${TASK_STATUS_ICONS[displayStatus]} [${task.id}] ${truncateDisplayText(task.subject, maxSubjectWidth)}${agentInfo}${blockedInfo}`;
            const taskColor = getTaskColor(displayStatus, color);
            return (
              <Text key={task.id} color={taskColor} wrap="wrap">
                {taskText}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
};

export const TaskBoard: FunctionComponent<TaskBoardProps> = ({ tasks, width = (process.stdout.columns || 100) - 8 }) => {
  if (tasks.length === 0) {
    return <Text color={tuiTheme.semantic.panel.empty}>{t('tui.task.no_tasks')}</Text>;
  }

  const sortedTasks = sortTasksForDisplay(tasks);
  const isNarrowMode = width < MIN_WIDTH_FOR_COLUMNS;

  // Group tasks by display state
  const pendingTasks = sortedTasks.filter((t) => getTaskDisplayStatus(t) === 'pending');
  const blockedTasks = sortedTasks.filter((t) => getTaskDisplayStatus(t) === 'blocked');
  const inProgressTasks = sortedTasks.filter((t) => getTaskDisplayStatus(t) === 'in_progress');
  const completedTasks = sortedTasks.filter((t) => getTaskDisplayStatus(t) === 'completed');
  const failedTasks = sortedTasks.filter((t) => {
    const displayStatus = getTaskDisplayStatus(t);
    return displayStatus === 'failed' || displayStatus === 'cancelled';
  });

  // Overall summary
  const summary = [
    `${TASK_STATUS_ICONS.pending} ${pendingTasks.length}`,
    `${TASK_STATUS_ICONS.blocked} ${blockedTasks.length}`,
    `${TASK_STATUS_ICONS.in_progress} ${inProgressTasks.length}`,
    `${TASK_STATUS_ICONS.completed} ${completedTasks.length}`,
    `${TASK_STATUS_ICONS.failed} ${failedTasks.length}`,
  ].join(' · ');

  // Narrow mode: single column with all tasks
  if (isNarrowMode) {
    const allTasks = [...inProgressTasks, ...blockedTasks, ...pendingTasks, ...completedTasks, ...failedTasks].slice(0, 8);
    // Reserve space for padding, icon, ID, and metadata
    const maxSubjectWidth = Math.max(10, width - 20);
    return (
      <Box flexDirection="column">
        <Text color={tuiTheme.semantic.panel.title} bold>
          {summary} · {tasks.length} {t('tui.task.total')}
        </Text>
        {allTasks.map((task) => {
          const displayStatus = getTaskDisplayStatus(task);
          const agentInfo = task.assigned_agent ? ` @${task.assigned_agent}` : '';
          const blockedInfo = displayStatus === 'blocked' && task.blocked_by?.length
            ? ` · ${t('tui.task.depends_on')} ${task.blocked_by.join(', ')}`
            : '';
          const detail = `${TASK_STATUS_ICONS[displayStatus]} [${task.id}] ${truncateDisplayText(task.subject, maxSubjectWidth)}${agentInfo}${blockedInfo}`;
          const taskColor = getTaskColor(displayStatus, tuiTheme.semantic.text.primary);
          return (
            <Text key={task.id} color={taskColor}>
              {truncateDisplayText(detail, width - 4)}
            </Text>
          );
        })}
        <Text color={tuiTheme.semantic.panel.help}>{t('tui.task.switch_hint')}</Text>
      </Box>
    );
  }

  // Wide mode: three-column layout
  const contentWidth = Math.max(60, width);
  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color={tuiTheme.semantic.panel.title} bold>
        {summary} · {tasks.length} {t('tui.task.total')}
      </Text>
      <Box flexDirection="row" width={contentWidth}>
        <TaskColumn
          title={t('tui.task.pending')}
          tasks={[...pendingTasks, ...blockedTasks].slice(0, 5)}
          icon={TASK_STATUS_ICONS.pending}
          color={tuiTheme.semantic.status.pending}
          maxWidth={contentWidth}
        />
        <TaskColumn
          title={t('tui.task.in_progress')}
          tasks={inProgressTasks.slice(0, 5)}
          icon={TASK_STATUS_ICONS.in_progress}
          color={tuiTheme.semantic.status.info}
          maxWidth={contentWidth}
        />
        <TaskColumn
          title={t('tui.task.completed')}
          tasks={[...completedTasks, ...failedTasks].slice(0, 5)}
          icon={TASK_STATUS_ICONS.completed}
          color={tuiTheme.semantic.status.completed}
          maxWidth={contentWidth}
        />
      </Box>
      <Text color={tuiTheme.semantic.panel.help}>{t('tui.task.switch_hint')}</Text>
    </Box>
  );
};

export default TaskBoard;
