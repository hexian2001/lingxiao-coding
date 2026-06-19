import type { FunctionComponent } from 'react';
import { Box, Text } from 'ink';
import { getPickerWindow } from './picker.js';
import { truncateDisplayText, type ModalTableItem, type ModalTableView } from './utils.js';
import { tuiTheme } from './theme.js';
import { t } from '../i18n.js';
import { EmptyState, PanelFrame, SelectedLine } from './components/PanelFrame.js';

interface PickerPanelProps {
  title: string;
  borderColor: string;
  items: ModalTableItem[];
  tableView?: ModalTableView;
  cursor: number;
  visibleRows: number;
  emptyText?: string;
  helpText?: string;
  summaryText?: string;
  maxWidth?: number;
  /** Terminal columns — passed down so we re-render on resize */
  termCols?: number;
}

export const PickerPanel: FunctionComponent<PickerPanelProps> = ({
  title,
  borderColor,
  items,
  tableView,
  cursor,
  visibleRows,
  emptyText,
  helpText,
  summaryText,
  maxWidth,
  termCols,
}) => {
  const window = getPickerWindow(items, cursor, visibleRows);
  const contentWidth = Math.max(24, (maxWidth ?? termCols ?? process.stdout.columns ?? 100) - 12);
  const secondaryWidth = Math.max(20, contentWidth - 2);

  return (
    <Box marginBottom={1}>
      <PanelFrame
        title={title}
        width={contentWidth + 4}
        border
        borderColor={borderColor}
        paddingX={1}
        paddingY={1}
        help={helpText}
      >
      {summaryText && <Text color={tuiTheme.semantic.text.primary}>{truncateDisplayText(summaryText, contentWidth)}</Text>}
      {tableView?.header && (
        <Text color={tuiTheme.semantic.text.primary}>{truncateDisplayText(tableView.header, contentWidth)}</Text>
      )}
      {items.length > 0 && (
        <Text color={tuiTheme.semantic.text.secondary}>{t('tui.picker.showing', window.start + 1, window.end, items.length)}</Text>
      )}
      {window.hiddenAbove > 0 && <Text color={tuiTheme.semantic.panel.help}>{t('tui.picker.above', window.hiddenAbove)}</Text>}
      {items.length === 0 ? (
        <EmptyState text={emptyText ?? t('tui.picker.empty')} width={contentWidth} />
      ) : (
        window.visibleItems.map((item, visibleIndex) => {
          const index = window.start + visibleIndex;
          return (
            <Box key={`${title}-${index}`} flexDirection="column">
              <SelectedLine
                selected={index === cursor}
                text={tableView?.rows[index]?.primary || item.title}
                width={contentWidth}
              />
              {(tableView?.rows[index]?.secondary || item.detail) && (
                <Text color={tuiTheme.semantic.text.secondary}>{`  ${truncateDisplayText(tableView?.rows[index]?.secondary || item.detail, secondaryWidth)}`}</Text>
              )}
            </Box>
          );
        })
      )}
      {window.hiddenBelow > 0 && <Text color={tuiTheme.semantic.panel.help}>{t('tui.picker.below', window.hiddenBelow)}</Text>}
      </PanelFrame>
    </Box>
  );
};

export default PickerPanel;
