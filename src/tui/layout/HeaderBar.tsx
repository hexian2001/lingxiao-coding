import { Box, Text } from 'ink';
import { formatElapsedLabel } from '../utils.js';
import { getStatusColor, tuiTheme } from '../theme.js';
import { StreamingStatusLine } from '../components/StreamingStatusLine.js';
import { t } from '../../i18n.js';

interface HeaderBarProps {
  modelName: string;
  currentTab: string;
  currentAgentStatusDisplay?: string;
  currentTokenTotal: number;
  createdAt?: number;
  /** 流式状态条 props（对齐 CodeBuddy LoadingBox） */
  streaming?: {
    active: boolean;
    phase?: string;
    streamingToolName?: string;
    toolName?: string;
    partialJson?: string;
    outputTokens: number;
    startedAt?: number;
    compactingProgress?: {
      stage?: string;
      chunkIndex?: number;
      chunkTotal?: number;
      percent?: number;
      oldTokens?: number;
      newTokens?: number;
      threshold?: number;
      messageCount?: number;
      label?: string;
    };
  };
}

export function HeaderBar({
  modelName,
  currentTab,
  currentAgentStatusDisplay,
  currentTokenTotal,
  createdAt,
  streaming,
}: HeaderBarProps) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box marginBottom={streaming?.active ? 0 : 1} marginLeft={2} marginRight={2} justifyContent="space-between">
        <Box>
          <Text bold color={tuiTheme.semantic.panel.title} wrap="truncate-end">{modelName}</Text>
          <Text color={tuiTheme.semantic.text.secondary}>{` · `}</Text>
          <Text color={tuiTheme.semantic.text.accent}>{currentTab === 'main' ? t('tui.leader.label') : `@${currentTab}`}</Text>
          {currentAgentStatusDisplay && (
            <>
              <Text color={tuiTheme.semantic.text.secondary}>{` · `}</Text>
              <Text color={getStatusColor(currentAgentStatusDisplay)}>{currentAgentStatusDisplay}</Text>
            </>
          )}
        </Box>
        <Box>
          <Text color={tuiTheme.semantic.text.secondary}>{`${currentTokenTotal >= 1000 ? `${(currentTokenTotal / 1000).toFixed(1)}k` : currentTokenTotal} ${t('tui.header.tokens')}`}</Text>
          {createdAt && (
            <>
              <Text color={tuiTheme.semantic.text.secondary}>{` · `}</Text>
              <Text color={tuiTheme.semantic.text.secondary}>{formatElapsedLabel(Math.floor((Date.now() - createdAt) / 1000))}</Text>
            </>
          )}
        </Box>
      </Box>
      {streaming?.active && (
        <StreamingStatusLine
          active={streaming.active}
          phase={streaming.phase}
          streamingToolName={streaming.streamingToolName}
          toolName={streaming.toolName}
          partialJson={streaming.partialJson}
          outputTokens={streaming.outputTokens}
          startedAt={streaming.startedAt}
          compactingProgress={streaming.compactingProgress}
        />
      )}
    </Box>
  );
}
