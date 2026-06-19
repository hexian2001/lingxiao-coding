import { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from '../theme.js';
import { tuiColors } from '../design/tokens.js';
import { t } from '../../i18n.js';
import type { AgentStatusItem } from '../components/AgentStatusBar.js';
import { AgentStatusBar } from '../components/AgentStatusBar.js';
import { renderCloudPattern } from './cloudPattern.js';
import { buildComposerInputLines, type ComposerInputLine } from './composerInputWrap.js';

const INPUT_HORIZONTAL_CHROME_WIDTH = 10;
const MIN_INPUT_TEXT_WIDTH = 8;

export const BlinkingCursor = memo(() => {
  return <Text bold color={tuiTheme.cursor}>▋</Text>;
});
BlinkingCursor.displayName = 'BlinkingCursor';

function renderInputTextParts(text: string, startIndex: number, commandTokenLength: number): ReactNode {
  if (!text) return null;
  const commandPartLength = Math.max(0, Math.min(text.length, commandTokenLength - startIndex));
  if (commandPartLength <= 0) {
    return <Text color={tuiColors.inputText}>{text}</Text>;
  }
  if (commandPartLength >= text.length) {
    return <Text color={tuiTheme.semantic.text.accent} bold>{text}</Text>;
  }
  return [
    <Text key={`${startIndex}:command`} color={tuiTheme.semantic.text.accent} bold>{text.slice(0, commandPartLength)}</Text>,
    <Text key={`${startIndex}:tail`} color={tuiColors.inputText}>{text.slice(commandPartLength)}</Text>,
  ];
}

function renderInputLineContent(line: ComposerInputLine, commandTokenLength: number): ReactNode {
  if (line.cursorOffset === undefined) {
    return renderInputTextParts(line.text, line.start, commandTokenLength);
  }
  const before = line.text.slice(0, line.cursorOffset);
  const after = line.text.slice(line.cursorOffset);
  return (
    <>
      {renderInputTextParts(before, line.start, commandTokenLength)}
      <BlinkingCursor />
      {renderInputTextParts(after, line.start + line.cursorOffset, commandTokenLength)}
    </>
  );
}

interface ComposerProps {
  showLeaderProcessingIndicator: boolean;
  agentStatusItems: AgentStatusItem[];
  termCols: number;
  suggestionPanel?: ReactNode;
  submitting: boolean;
  inputBuffer: string;
  inputCursor: number;
  sessionStatus: { status?: string };
  inputTarget: { placeholder: string };
  modeActionText?: string;
  modeActionActive?: boolean;
  modeActionTone?: 'success' | 'error';
  shortcutHintText: string;
  currentTab: string;
  /** 输入框下方的维护进度条插槽 */
  maintenanceSlot?: ReactNode;
}

export function Composer({
  showLeaderProcessingIndicator,
  agentStatusItems,
  termCols,
  suggestionPanel,
  submitting,
  inputBuffer,
  inputCursor,
  sessionStatus,
  inputTarget,
  modeActionText,
  modeActionActive = false,
  modeActionTone = 'success',
  shortcutHintText,
  currentTab,
  maintenanceSlot,
}: ComposerProps) {
  const cloudWidth = Math.max(0, Math.min(96, termCols - 10));
  const inputBorder = submitting ? tuiTheme.semantic.panel.border : tuiTheme.semantic.border.focused;
  const inputTextWidth = Math.max(MIN_INPUT_TEXT_WIDTH, termCols - INPUT_HORIZONTAL_CHROME_WIDTH);
  const inputLines = inputBuffer.length > 0
    ? buildComposerInputLines(inputBuffer, inputCursor, inputTextWidth)
    : [];
  const commandTokenLength = inputBuffer.startsWith('/') ? (inputBuffer.match(/^\/\S*/)?.[0].length ?? 0) : 0;

  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1} marginLeft={2} marginRight={2}>
      {showLeaderProcessingIndicator && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.text.accent}>◜</Text>
          <Text color={tuiTheme.semantic.text.secondary}>{` ${t('tui.input.processing')}`}</Text>
          <Text color={tuiTheme.semantic.panel.help}>{` · ${t('tui.input.cancel_hint')}`}</Text>
        </Box>
      )}
      {agentStatusItems.length > 0 && (
        <Box marginBottom={1}>
          <AgentStatusBar agents={agentStatusItems} termCols={termCols} />
        </Box>
      )}
      {suggestionPanel}
      {modeActionText && (
        <Box marginBottom={1}>
          <Text
            color={modeActionActive
              ? modeActionTone === 'error' ? tuiTheme.semantic.status.error : tuiTheme.semantic.status.success
              : tuiTheme.semantic.text.secondary}
            bold={modeActionActive}
            wrap="truncate-end"
          >
            {modeActionText}
          </Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={inputBorder}
        paddingX={1}
      >
        <Text color={submitting ? tuiTheme.semantic.panel.borderMuted : tuiTheme.semantic.panel.divider} wrap="truncate-end">
          {renderCloudPattern(cloudWidth, 2)}
        </Text>
        {inputLines.length > 0 ? (
          <Box flexDirection="column">
            {inputLines.map((line, index) => (
              <Box key={`${line.start}:${line.end}:${index}`} flexDirection="row">
                <Text color={index === 0 ? tuiTheme.semantic.text.accent : tuiTheme.semantic.panel.help} bold={index === 0}>{index === 0 ? '❯' : ' '}</Text>
                <Text>{' '}</Text>
                <Text wrap="truncate-end">
                  {renderInputLineContent(line, commandTokenLength)}
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color={tuiTheme.semantic.text.accent} bold>{'❯'}</Text>
            <Text>{' '}</Text>
            {submitting ? <Text color={tuiTheme.semantic.text.secondary}>{t('tui.input.processing')}</Text>
              : sessionStatus.status === 'interrupted' ? <><BlinkingCursor /><Text color={tuiTheme.semantic.text.accent}>{t('tui.input.continue')}</Text></>
              : <><BlinkingCursor /><Text color={tuiTheme.semantic.panel.help}>{inputTarget.placeholder}</Text></>}
          </Box>
        )}
      </Box>
      {maintenanceSlot && (
        <Box marginTop={0}>
          {maintenanceSlot}
        </Box>
      )}
      <Box justifyContent="space-between" marginTop={0}>
        <Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">{shortcutHintText}</Text>
        {currentTab !== 'main' && (
          <Text color={tuiTheme.semantic.text.secondary}>{`@${currentTab}`}</Text>
        )}
      </Box>
    </Box>
  );
}
