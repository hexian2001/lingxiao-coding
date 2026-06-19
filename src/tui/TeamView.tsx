/**
 * TeamView - Visual display of active agents in the multi-agent team
 * Shows agent name, role, task, status, activity metrics
 */
import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';
import { truncateDisplayText } from './utils.js';
import { EmptyState, PanelFrame } from './components/PanelFrame.js';
import { getAgentStatusVisual, getRoleVisual } from './design/visuals.js';
import type { WorkerBackend } from '../contracts/types/Agent.js';

interface TeamAgentInfo {
  id: string;
  name: string;
  role: string;
  taskId?: string;
  status: 'idle' | 'working' | 'waiting' | 'completed' | 'failed';
  lastActivity?: number;
  toolCallCount?: number;
  dependencies?: string[];
  backend?: WorkerBackend;
  externalSessionId?: string;
  pid?: number;
  recoveryAction?: string;
  stderrTail?: string[];
}

interface TeamViewProps {
  agents: TeamAgentInfo[];
  width?: number;
  /** 当前光标选中的 Agent 下标（来自 modalCursor，team 模态下可 ↑/↓ 导航）。 */
  cursorIndex?: number;
}

function formatLastActivity(timestamp?: number): string {
  if (!timestamp) return t('tui.team.never');
  const elapsed = Date.now() - timestamp;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return t('tui.team.seconds_ago', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('tui.team.minutes_ago', minutes);
  const hours = Math.floor(minutes / 60);
  return t('tui.team.hours_ago', hours);
}

export const TeamView: FunctionComponent<TeamViewProps> = ({
  agents,
  width = (process.stdout.columns || 100) - 8,
  cursorIndex,
}) => {
  if (agents.length === 0) {
    return (
      <PanelFrame title={t('tui.team.title')}>
        <EmptyState text={t('tui.team.no_agents')} />
      </PanelFrame>
    );
  }

  const contentWidth = Math.max(40, width);

  return (
    <PanelFrame title={t('tui.team.title')} meta={String(agents.length)}>
      <Box flexDirection="column">
        {agents.map((agent, index) => {
          const isSelected = cursorIndex === index;
          const roleVisual = getRoleVisual(agent.role);
          const statusVisual = getAgentStatusVisual(agent.status === 'working' ? 'running' : agent.status);
          const taskInfo = agent.taskId ? `[${truncateDisplayText(agent.taskId, 12)}]` : t('tui.team.no_task');
          const activityInfo = agent.toolCallCount != null
            ? t('tui.team.tools_count', agent.toolCallCount)
            : '';
          const lastActivityText = formatLastActivity(agent.lastActivity);

          return (
            <Box key={agent.id} flexDirection="column" marginBottom={1}>
              <Box>
                {isSelected
                  ? <Text color={tuiTheme.semantic.text.accent}>{'▍ '}</Text>
                  : <Text>{'  '}</Text>}
                <Text color={statusVisual.color}>{`[${statusVisual.icon}] `}</Text>
                <Text bold={isSelected} color={isSelected ? tuiTheme.semantic.text.primary : roleVisual.color}>{truncateDisplayText(agent.name, 12)}</Text>
                <Text>{' '}</Text>
                <Text color={roleVisual.color}>{`[${roleVisual.abbr.trim()}]`}</Text>
                <Text color={roleVisual.color}>{` ${agent.role}`}</Text>
                <Text color={tuiTheme.semantic.text.secondary}>{` ${taskInfo}`}</Text>
                {agent.backend && agent.backend !== 'worker_process' && <Text color={agent.backend === 'claude' ? tuiTheme.semantic.runtime.agent : tuiTheme.semantic.runtime.leader}>{` ${agent.backend}`}</Text>}
                {agent.pid && <Text color={tuiTheme.semantic.text.secondary}>{` ${t('tui.team.pid')}=${agent.pid}`}</Text>}
                {activityInfo && <Text color={tuiTheme.semantic.runtime.tool}>{` ${activityInfo}`}</Text>}
                <Text color={tuiTheme.semantic.text.secondary}>{` ${lastActivityText}`}</Text>
              </Box>
              {(agent.externalSessionId || agent.recoveryAction || agent.stderrTail?.length) && (
                <Text color={agent.recoveryAction ? tuiTheme.semantic.status.warning : tuiTheme.semantic.text.secondary}>
                  {truncateDisplayText(`    └─ ${[
                    agent.externalSessionId ? `${t('tui.team.session')}=${agent.externalSessionId}` : '',
                    agent.recoveryAction ? `${t('tui.team.recovery')}=${agent.recoveryAction}` : '',
                    agent.stderrTail?.length ? `${t('tui.team.stderr')}=${agent.stderrTail[agent.stderrTail.length - 1]}` : '',
                  ].filter(Boolean).join(' · ')}`, Math.max(20, contentWidth - 4))}
                </Text>
              )}
              {agent.dependencies && agent.dependencies.length > 0 && (
                <Text color={tuiTheme.semantic.text.secondary}>
                  {`    └─ ${t('tui.team.depends')}: ${agent.dependencies.join(', ')}`}
                </Text>
              )}
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={tuiTheme.semantic.text.secondary}>{t('tui.team.stop_hint')}</Text>
        </Box>
      </Box>
    </PanelFrame>
  );
};

export default TeamView;
