import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from '../theme.js';
import { truncateDisplayText } from '../utils.js';

interface PanelFrameProps {
  title?: string;
  meta?: string;
  children?: ReactNode;
  width?: number;
  help?: string;
  border?: boolean;
  borderColor?: string;
  focused?: boolean;
  paddingX?: number;
  paddingY?: number;
}

export function PanelFrame({
  title,
  meta,
  children,
  width,
  help,
  border = false,
  borderColor,
  focused = false,
  paddingX = 1,
  paddingY = 0,
}: PanelFrameProps) {
  const maxWidth = Math.max(24, width || process.stdout.columns || 80);
  const resolvedBorderColor = borderColor ?? (focused ? tuiTheme.semantic.panel.borderFocused : tuiTheme.semantic.panel.border);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={border ? 'round' : undefined}
      borderColor={border ? resolvedBorderColor : undefined}
      paddingX={paddingX}
      paddingY={paddingY}
    >
      {(title || meta) && (
        <PanelHeader title={title || ''} meta={meta} width={maxWidth - 2} />
      )}
      {children}
      {help && <HelpLine text={help} width={maxWidth - 2} />}
    </Box>
  );
}

interface PanelHeaderProps {
  title: string;
  meta?: string;
  width?: number;
}

export function PanelHeader({ title, meta, width = 80 }: PanelHeaderProps) {
  const titleWidth = meta ? Math.max(8, width - meta.length - 4) : width;
  return (
    <Box>
      <Text color={tuiTheme.semantic.runtime.leader}>{'▍ '}</Text>
      <Text bold color={tuiTheme.semantic.panel.title}>
        {truncateDisplayText(title, Math.max(4, titleWidth - 2))}
      </Text>
      {meta && (
        <>
          <Text color={tuiTheme.semantic.text.secondary}>{' · '}</Text>
          <Text color={tuiTheme.semantic.panel.help}>{truncateDisplayText(meta, Math.max(8, width - titleWidth - 3))}</Text>
        </>
      )}
    </Box>
  );
}

export function EmptyState({ text, width = 80 }: { text: string; width?: number }) {
  return <Text color={tuiTheme.semantic.panel.empty}>{truncateDisplayText(text, Math.max(16, width))}</Text>;
}

export function HelpLine({ text, width = 80 }: { text: string; width?: number }) {
  return (
    <Box marginTop={1}>
      <Text color={tuiTheme.semantic.panel.help}>{truncateDisplayText(text, Math.max(16, width))}</Text>
    </Box>
  );
}

export function Divider({ width = 60 }: { width?: number }) {
  return <Text color={tuiTheme.semantic.panel.divider}>{'─'.repeat(Math.max(8, width))}</Text>;
}

export function StatusPill({ label, color }: { label: string; color: string }) {
  return <Text color={color}>{` ${label} `}</Text>;
}

export function SelectedLine({
  selected,
  text,
  width = 80,
  color = tuiTheme.semantic.text.primary,
  prefix = true,
}: {
  selected: boolean;
  text: string;
  width?: number;
  color?: string;
  prefix?: boolean;
}) {
  const marker = prefix ? (selected ? '> ' : '  ') : '';
  return (
    <Text
      color={selected ? tuiTheme.semantic.selection.text : color}
      backgroundColor={selected ? tuiTheme.semantic.selection.background : undefined}
    >
      {truncateDisplayText(`${marker}${text}`, Math.max(8, width))}
    </Text>
  );
}
