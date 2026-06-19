import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import type { WorkerInteractiveRuntimeSnapshot } from '../agents/runtime/WorkerInteractiveRuntime.js';
import { buildInteractiveRuntimePanelView } from './state/interactivePanel.js';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';

interface AgentRuntimePanelProps {
  snapshot?: WorkerInteractiveRuntimeSnapshot;
  maxWidth: number;
}

export const AgentRuntimePanel: FunctionComponent<AgentRuntimePanelProps> = ({
  snapshot,
  maxWidth,
}) => {
  const view = buildInteractiveRuntimePanelView(snapshot, maxWidth);
  if (!view.visible) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={tuiTheme.semantic.runtime.agent}>{'▸ '}</Text>
        <Text color={tuiTheme.semantic.panel.title} bold>{t('tui.agent.runtime_title')}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {view.lines.map((line, index) => (
          <Text key={`runtime-${index}`} color={tuiTheme.semantic.text.secondary} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    </Box>
  );
};

export default AgentRuntimePanel;
