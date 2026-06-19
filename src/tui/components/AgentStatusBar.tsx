import { Box, Text } from 'ink';
import React from 'react';
import { tuiTheme } from '../theme.js';
import { truncateDisplayText } from '../utils.js';
import { t } from '../../i18n.js';
import { getAgentStatusVisual } from '../design/visuals.js';

export interface AgentStatusItem {
  name?: string;
  status?: string;
}

interface AgentStatusBarProps {
  agents: AgentStatusItem[];
  termCols: number;
}

export const AgentStatusBar = React.memo<AgentStatusBarProps>(({ agents, termCols }) => {
  if (agents.length === 0) return null;

  if (termCols < 80) {
    const summary = agents.reduce(
      (acc, agent) => {
        const bucket = getAgentStatusVisual(agent.status || 'idle').bucket;
        acc[bucket] += 1;
        return acc;
      },
      { running: 0, done: 0, failed: 0, idle: 0, paused: 0 },
    );

    const compact = [t('tui.agents.running', summary.running), t('tui.agents.done', summary.done)];
    if (summary.paused > 0) compact.push(t('tui.agents.paused', summary.paused));
    if (summary.failed > 0) compact.push(t('tui.agents.failed', summary.failed));
    return <Text color={tuiTheme.semantic.text.secondary}>{compact.join(', ')}</Text>;
  }

  return (
    <Box flexWrap="wrap">
      {agents.map((agent, index) => {
        const visual = getAgentStatusVisual(agent.status || 'idle');
        const label = truncateDisplayText(agent.name || t('tui.agents.default_name'), 16);
        return (
          <Box key={`${agent.name}-${index}`} marginRight={1}>
            <Text color={visual.color}>{`[${label} ${visual.icon}]`}</Text>
          </Box>
        );
      })}
    </Box>
  );
});

export default AgentStatusBar;
