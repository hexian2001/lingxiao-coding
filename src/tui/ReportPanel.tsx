/**
 * ReportPanel — 可滚动纯文本报告面板。
 *
 * 用于 /stats /logs /traces /changes /cost 等命令的结构化文本报告，
 * 取代「一次性塞进消息流」的旧形态。按 modalCursor 行滚动，支持简单着色：
 *   - +行 绿 / -行 红（diff）
 *   - ▍/▸ 开头的小节标题高亮
 *
 * 快捷键: ↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc/Ctrl+X 关闭
 */

import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { EmptyState, HelpLine, PanelFrame } from './components/PanelFrame.js';
import { t } from '../i18n.js';

export interface ReportPanelData {
  title: string;
  /** 多行文本 */
  report: string;
}

interface ReportPanelProps {
  data?: ReportPanelData | null;
  width?: number;
  cursor?: number;
  visibleRows?: number;
}

function lineColor(line: string): { color: string; bold?: boolean } {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('+') && !trimmed.startsWith('++')) return { color: tuiTheme.semantic.diff.add };
  if (trimmed.startsWith('-') && !trimmed.startsWith('--')) return { color: tuiTheme.semantic.diff.del };
  if (trimmed.startsWith('▍') || trimmed.startsWith('▸')) return { color: tuiTheme.semantic.panel.title, bold: true };
  if (trimmed.startsWith('@@') || trimmed.startsWith('──')) return { color: tuiTheme.semantic.diff.hunk };
  return { color: tuiTheme.semantic.text.primary };
}

export const ReportPanel: FunctionComponent<ReportPanelProps> = ({ data, width = 80, cursor = 0, visibleRows = 16 }) => {
  const maxWidth = Math.max(24, width - 4);

  if (!data) {
    return (
      <PanelFrame title={t('tui.report.title')}>
        <EmptyState text={t('tui.panel.loading')} width={maxWidth} />
      </PanelFrame>
    );
  }

  const allLines = data.report.split('\n');
  const maxScroll = Math.max(0, allLines.length - visibleRows);
  const scroll = Math.min(Math.max(0, cursor), maxScroll);
  const windowLines = allLines.slice(scroll, scroll + visibleRows);
  const showScrollHint = allLines.length > visibleRows;

  return (
    <PanelFrame
      title={data.title}
      meta={showScrollHint ? `${scroll + 1}-${Math.min(scroll + visibleRows, allLines.length)}/${allLines.length}` : undefined}
    >
      <Box flexDirection="column" marginTop={1}>
        {windowLines.map((line, i) => {
          const { color, bold } = lineColor(line);
          return (
            <Text key={`rl-${scroll + i}`} color={color} bold={bold} wrap="truncate-end">
              {truncateDisplayText(line || ' ', maxWidth)}
            </Text>
          );
        })}
      </Box>
      <HelpLine text={t('tui.report.help')} width={maxWidth} />
    </PanelFrame>
  );
};

export default ReportPanel;
