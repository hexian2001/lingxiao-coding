/**
 * NotificationCenter - Unified notification system
 * Displays notifications with priority levels (Critical/Important/Normal)
 * Supports read/unread state, quick actions, and notification aggregation
 */
import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';
import { truncateDisplayText } from './utils.js';
import { EmptyState, PanelFrame } from './components/PanelFrame.js';
import { getPriorityVisual } from './design/visuals.js';

export type NotificationPriority = 'critical' | 'important' | 'normal';
export type NotificationType = 'plan_approved' | 'user_input_needed' | 'agent_warning' | 'task_completed' | 'error' | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  duplicateCount?: number;
  actions?: Array<{ label: string; action: string }>;
  agentId?: string;
  taskId?: string;
}

interface NotificationCenterProps {
  notifications: Notification[];
  maxDisplay?: number;
  width?: number;
}

// 通知类型符（方寸词汇，宽1）：与 getPriorityVisual 的钻石族同语言。
const TYPE_ICONS: Record<NotificationType, string> = {
  plan_approved: '◈',
  user_input_needed: '◔',
  agent_warning: '◇',
  task_completed: '◉',
  error: '✕',
  info: '○',
};

function formatTimestamp(ts: number): string {
  const elapsed = Date.now() - ts;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * Notification Banner - Shows critical notifications at the top
 */
export const NotificationBanner: FunctionComponent<{
  notifications: Notification[];
  width?: number;
}> = ({ notifications, width = process.stdout.columns || 100 }) => {
  const unreadCritical = notifications.filter((n) => n.priority === 'critical' && !n.read);
  const unreadImportant = notifications.filter((n) => n.priority === 'important' && !n.read);

  if (unreadCritical.length === 0 && unreadImportant.length === 0) {
    return null;
  }

  const show = unreadCritical.length > 0 ? unreadCritical[0] : unreadImportant[0];
  const visual = getPriorityVisual(show.priority);
  const typeIcon = TYPE_ICONS[show.type] || '';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={visual.color}>
        {`[${visual.icon}/${typeIcon}] [${visual.label}] ${truncateDisplayText(show.title, width - 20)}`}
      </Text>
      <Text color={tuiTheme.semantic.text.primary}>
        {truncateDisplayText(show.message, width - 4)}
      </Text>
    </Box>
  );
};

/**
 * NotificationCenter - Full notification list view
 */
export const NotificationCenter: FunctionComponent<NotificationCenterProps> = ({
  notifications,
  maxDisplay = 20,
  width = (process.stdout.columns || 100) - 8,
}) => {
  if (notifications.length === 0) {
    return (
      <PanelFrame title={t('tui.notification.title')}>
        <EmptyState text={t('tui.notification.empty')} />
      </PanelFrame>
    );
  }

  const displayNotifications = notifications
    .sort((a, b) => {
      // Sort by priority first (critical > important > normal)
      const priorityOrder = { critical: 0, important: 1, normal: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      // Then by timestamp (newest first)
      return b.timestamp - a.timestamp;
    })
    .slice(0, maxDisplay);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const contentWidth = Math.max(40, width);

  return (
    <PanelFrame
      title={t('tui.notification.title')}
      meta={`${unreadCount}/${notifications.length} ${t('tui.notification.unread')}`}
    >
      <Box flexDirection="column">
        {displayNotifications.map((notification) => {
          const priorityVisual = getPriorityVisual(notification.priority);
          const typeIcon = TYPE_ICONS[notification.type];
          const timeAgo = formatTimestamp(notification.timestamp);
          const agentInfo = notification.agentId ? ` @${notification.agentId}` : '';
          const taskInfo = notification.taskId ? ` [${notification.taskId}]` : '';
          const duplicateBadge = notification.duplicateCount && notification.duplicateCount > 1
            ? ` (×${notification.duplicateCount})`
            : '';

          return (
            <Box key={notification.id} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={priorityVisual.color}>
                  {`[${priorityVisual.icon}/${typeIcon}] [${priorityVisual.label}]`}
                </Text>
                <Text color={notification.read ? tuiTheme.semantic.text.secondary : tuiTheme.semantic.text.primary}>
                  {' '}{truncateDisplayText(notification.title, contentWidth - 30)}
                </Text>
                <Text color={tuiTheme.semantic.text.secondary}>
                  {' '}{timeAgo}{agentInfo}{taskInfo}{duplicateBadge}
                </Text>
                {!notification.read && <Text color={priorityVisual.color}> *</Text>}
              </Text>
              <Text color={tuiTheme.semantic.text.secondary}>
                {'  '}{truncateDisplayText(notification.message, contentWidth - 4)}
              </Text>
              {notification.actions && notification.actions.length > 0 && (
                <Text color={tuiTheme.semantic.runtime.approval}>
                  {'  '}[{notification.actions.map((a) => a.label).join(' | ')}]
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </PanelFrame>
  );
};

export default NotificationCenter;
