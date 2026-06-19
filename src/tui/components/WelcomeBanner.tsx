/**
 * WelcomeBanner — 凌霄启动欢迎界面
 * 简洁面板式欢迎横幅
 */
import React from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from '../theme.js';
import { t } from '../../i18n.js';
import { VERSION } from '../../version.js';

interface WelcomeBannerProps {
  version?: string;
  webUrl?: string;
  workspace?: string;
  width?: number;
}

export const WelcomeBanner: React.FC<WelcomeBannerProps> = ({
  version = VERSION,
  webUrl,
  workspace,
  width = 80,
}) => {
  const innerWidth = Math.max(44, Math.min(72, width - 8));
  const bannerTitle = `${t('tui.welcome.tagline')} v${version}`;
  const ws = workspace
    ? (workspace.length > innerWidth - 4 ? '...' + workspace.slice(-(innerWidth - 7)) : workspace)
    : '';
  const line = (content: React.ReactNode) => (
    <Box width={innerWidth + 2}>
      <Text color={tuiTheme.semantic.panel.borderMuted}>{'│ '}</Text>
      <Box width={innerWidth}>{content}</Box>
      <Text color={tuiTheme.semantic.panel.borderMuted}>{' │'}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={tuiTheme.semantic.panel.border}>{'╭─'}</Text>
        <Text color={tuiTheme.semantic.panel.title} bold>{` ${bannerTitle} `}</Text>
        <Text color={tuiTheme.semantic.panel.divider}>{'─'.repeat(Math.max(0, innerWidth - bannerTitle.length - 2))}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'╮'}</Text>
      </Box>

      {line(
        <Text wrap="truncate-end">
          <Text color={tuiTheme.semantic.runtime.leader} bold>{t('tui.welcome.tagline')}</Text>
          <Text color={tuiTheme.semantic.panel.divider}>{' │ '}</Text>
          <Text color={tuiTheme.semantic.runtime.agent}>{t('tui.welcome.motto')}</Text>
        </Text>,
      )}
      {line(<Text color={tuiTheme.semantic.panel.divider}>{'─'.repeat(Math.max(8, innerWidth))}</Text>)}
      {line(
        <Text wrap="truncate-end">
          <Text color={tuiTheme.semantic.text.secondary}>{t('tui.welcome.shortcuts')} </Text>
          <Text color={tuiTheme.semantic.panel.help}>
            {`${t('tui.welcome.shortcut.cmd')} · ${t('tui.welcome.shortcut.interrupt')} · ${t('tui.welcome.shortcut.dag')} · ${t('tui.welcome.shortcut.tab')}`}
          </Text>
        </Text>,
      )}
      {webUrl && line(
        <Text wrap="truncate-end">
          <Text color={tuiTheme.semantic.runtime.stream}>Web</Text>
          <Text color={tuiTheme.semantic.text.secondary}>{': '}</Text>
          <Text color={tuiTheme.semantic.text.link}>{webUrl}</Text>
        </Text>,
      )}
      {ws && line(<Text color={tuiTheme.semantic.panel.help} wrap="truncate-end">{ws}</Text>)}

      <Box>
        <Text color={tuiTheme.semantic.panel.border}>{'╰'}</Text>
        <Text color={tuiTheme.semantic.panel.divider}>{'─'.repeat(innerWidth + 2)}</Text>
        <Text color={tuiTheme.semantic.panel.border}>{'╯'}</Text>
      </Box>
    </Box>
  );
};
