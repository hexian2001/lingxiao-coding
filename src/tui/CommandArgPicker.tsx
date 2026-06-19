/**
 * CommandArgPicker — 命令参数选择器
 *
 * 当用户输入不带参数的命令（如 /mode、/language）时，
 * 弹出此交互式选择框让用户用 ↑↓ 选择参数，而不是手动填写。
 *
 * 支持实时过滤：输入字符后列表缩小为匹配项。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { tuiTheme } from './theme.js';
import { truncateDisplayText } from './utils.js';
import { t } from '../i18n.js';
import { EmptyState, PanelFrame, SelectedLine } from './components/PanelFrame.js';

export interface CommandArgItem {
  name: string;
  desc: string;
}

interface CommandArgPickerProps {
  commandName: string;
  items: CommandArgItem[];
  onSelect: (item: CommandArgItem) => void;
  onCancel: () => void;
  cursor?: number;
  filter?: string;
  width?: number;
}

const MAX_VISIBLE = 10;

export const CommandArgPicker: React.FC<CommandArgPickerProps> = ({
  commandName,
  items,
  cursor = 0,
  filter = '',
  width = 60,
}) => {
  const filtered = filterCommandArgItems(items, filter);
  const clampedCursor = clampCommandArgCursor(cursor, filtered.length);

  // Compute visible window
  const visibleStart = Math.max(0, clampedCursor - Math.floor(MAX_VISIBLE / 2));
  const visibleEnd = Math.min(filtered.length, visibleStart + MAX_VISIBLE);
  const visibleItems = filtered.slice(visibleStart, visibleEnd);

  const contentWidth = Math.max(24, width - 6);
  const nameColWidth = Math.min(24, Math.max(8, ...items.map((i) => i.name.length)) + 2);

  return (
    <PanelFrame
      title={commandName}
      meta={t('tui.picker.showing', filtered.length === 0 ? 0 : visibleStart + 1, Math.min(visibleEnd, filtered.length), filtered.length)}
      width={Math.max(32, width)}
      border
      focused
      paddingX={1}
      paddingY={1}
      help={t('tui.cmdpicker.help')}
    >
      {filter !== '' && (
        <Box marginBottom={1}>
          <Text color={tuiTheme.semantic.text.secondary}>{t('tui.cmdpicker.filter')} </Text>
          <Text color={tuiTheme.semantic.text.primary}>{filter}</Text>
          <Text color={tuiTheme.semantic.text.secondary}>{' ·'}</Text>
          <Text color={tuiTheme.semantic.panel.help}> {t('tui.cmdpicker.filter_hint')}</Text>
        </Box>
      )}

      {filtered.length === 0 ? (
        <EmptyState text={t('tui.picker.empty')} width={contentWidth} />
      ) : (
        visibleItems.map((item, vi) => {
          const realIndex = visibleStart + vi;
          const isSelected = realIndex === clampedCursor;
          const desc = item.desc
            ? ` ${truncateDisplayText(item.desc, contentWidth - nameColWidth - 4)}`
            : '';
          return (
            <SelectedLine
              key={item.name}
              selected={isSelected}
              text={`${item.name.padEnd(nameColWidth)}${desc}`}
              width={contentWidth}
              color={tuiTheme.semantic.text.secondary}
            />
          );
        })
      )}
    </PanelFrame>
  );
};

CommandArgPicker.displayName = 'CommandArgPicker';

export function filterCommandArgItems(items: CommandArgItem[], filter: string): CommandArgItem[] {
  const query = filter.trim().toLowerCase();
  if (!query) return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      item.desc.toLowerCase().includes(query),
  );
}

export function clampCommandArgCursor(cursor: number, itemCount: number): number {
  return Math.min(Math.max(0, cursor), Math.max(0, itemCount - 1));
}

/**
 * Process a keypress while CommandArgPicker is active.
 * Returns the action to take: 'handled' | { select: item } | { cancel: true }
 */
export function handleCommandArgPickerKey(
  key: {
    name: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
  },
  state: {
    cursor: number;
    filter: string;
    items: CommandArgItem[];
  },
  dispatch: {
    setCursor: (v: number | ((p: number) => number)) => void;
    setFilter: (v: string | ((p: string) => string)) => void;
    onSelect: (item: CommandArgItem) => void;
    onCancel: () => void;
  },
): boolean {
  const { cursor, filter, items } = state;
  const { setCursor, setFilter, onSelect, onCancel } = dispatch;
  const filteredItems = filterCommandArgItems(items, filter);
  const clampedCursor = clampCommandArgCursor(cursor, filteredItems.length);

  if (key.name === 'escape') {
    onCancel();
    return true;
  }
  if (key.name === 'return') {
    const item = filteredItems[clampedCursor];
    if (item) onSelect(item);
    else onCancel();
    return true;
  }
  if (key.name === 'up') {
    setCursor((p) => Math.max(0, p - 1));
    return true;
  }
  if (key.name === 'down') {
    setCursor((p) => clampCommandArgCursor(p + 1, filteredItems.length));
    return true;
  }
  if (key.name === 'backspace' || key.sequence === '\x7f') {
    setFilter((f) => f.slice(0, -1));
    setCursor(0);
    return true;
  }
  // Number shortcut: 1-9 jumps to item
  if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) {
    const num = parseInt(key.sequence, 10);
    if (!isNaN(num) && num >= 1 && num <= 9) {
      const idx = num - 1;
      if (idx < filteredItems.length) {
        onSelect(filteredItems[idx]!);
        return true;
      }
    }
    // Regular character → filter
    if (/^[a-zA-Z0-9_\-./]$/.test(key.sequence)) {
      setFilter((f) => f + key.sequence);
      setCursor(0);
      return true;
    }
  }
  return false;
}
