import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { getStatusColor, tuiTheme } from './theme.js';
import { t } from '../i18n.js';
import { normalizeLeaderStatusKind, normalizeRunStatus } from '../core/StateSemantics.js';

interface SessionStatusProps {
  status?: {
    sessionId: string;
    workspace: string;
    status?: string;
    permissionSummary?: string;
    orchestrationSummary?: string;
  };
}

export const SessionStatus: FunctionComponent<SessionStatusProps> = ({ status }) => {
  if (!status) {
    return (
      <Box>
        <Text color={tuiTheme.semantic.panel.empty}>{t('tui.main.no_session')}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={tuiTheme.semantic.runtime.leader}>{'▸ '}</Text>
        <Text bold color={tuiTheme.semantic.panel.title}>{status.sessionId}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{' · '}</Text>
        <Text color={getStatusLabelColor(status.status)}>{status.status || t('tui.session.status_active_default')}</Text>
      </Box>
      <Box>
        <Text color={tuiTheme.semantic.text.secondary}>{`${t('tui.session.workspace')}: `}</Text>
        <Text color={tuiTheme.semantic.text.primary} wrap="truncate-end">{status.workspace}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{' · '}</Text>
        <Text color={tuiTheme.semantic.text.secondary}>{`${t('tui.permissions.label')}: `}</Text>
        <Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">{status.permissionSummary || t('tui.meta.unconfigured')}</Text>
      </Box>
      {status.orchestrationSummary ? (
        <Box>
          <Text color={tuiTheme.semantic.text.secondary}>{t('tui.session.orchestration')}</Text>
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">{status.orchestrationSummary}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

function getStatusLabelColor(status?: string): string {
  if (!status) return tuiTheme.semantic.status.idle;
  const runStatus = normalizeRunStatus(status);
  if (runStatus !== 'idle') return getStatusColor(runStatus);
  const leaderKind = normalizeLeaderStatusKind(status);
  if (leaderKind === 'active') return tuiTheme.semantic.runtime.leader;
  if (leaderKind === 'waiting' || leaderKind === 'idle') return getStatusColor('idle');
  if (leaderKind === 'interrupted') return getStatusColor('interrupted');
  if (leaderKind === 'completed') return getStatusColor('completed');
  return getStatusColor(runStatus);
}

export default SessionStatus;
