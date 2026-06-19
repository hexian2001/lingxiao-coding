import { Box, Text } from 'ink';
import type { FunctionComponent } from 'react';
import { getStatusColor, tuiTheme } from './theme.js';
import { t, getSessionLanguage } from '../i18n.js';
import { normalizeLeaderStatusKind } from '../core/StateSemantics.js';
import { STATUS_ICON } from './design/iconography.js';

interface LeaderStatusProps {
  status: string;
  currentNext?: string;
  mode?: 'direct' | 'hybrid' | 'delegate';
  reason?: string;
  /** 控制模式：manual（用户主导）/ eternal（Leader 自治）。缺省回退 manual。 */
  control?: 'manual' | 'eternal';
}

export const LeaderStatus: FunctionComponent<LeaderStatusProps> = ({ status, currentNext, mode, reason, control }) => {
  const statusIcon = getStatusIcon(status);
  const displayNext = currentNext || reason || t('tui.leader.awaiting_input');

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={tuiTheme.semantic.runtime.leader}>{'▸ '}</Text>
        <Text bold color={tuiTheme.semantic.runtime.leader}>{t('tui.leader.label')}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{' · '}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{statusIcon + ' '}</Text>
        <Text color={getStatusColor(status)}>{status}</Text>
      </Box>
      <Box>
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.leader.mode_label')}</Text>
        <Text color={tuiTheme.semantic.panel.help}>{mode || '-'}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{' · '}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.leader.control_label')}</Text>
        <Text color={tuiTheme.semantic.panel.help}>{control || t('tui.leader.control_manual')}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{' · '}</Text>
        <Text color={tuiTheme.semantic.panel.help}>{displayNext}</Text>
      </Box>
    </Box>
  );
};

function getStatusIcon(status: string): string {
  switch (normalizeLeaderStatusKind(status)) {
    case 'idle':
      return STATUS_ICON.idle;
    case 'waiting':
      return STATUS_ICON.waiting;
    case 'active':
      return STATUS_ICON.running;
    case 'completed':
      return STATUS_ICON.completed;
    case 'interrupted':
      return STATUS_ICON.interrupted;
    default:
      return STATUS_ICON.idle;
  }
}

export default LeaderStatus;
