import { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { TuiTheme } from '../theme.js';
import type { SuggestionItem } from '../utils.js';
import { t } from '../../i18n.js';

const MAX_SUGGESTIONS_VISIBLE = 8;

interface SuggestionsListProps {
  items: SuggestionItem[];
  selectedIndex: number;
  theme: TuiTheme;
  userInput?: string;
  termWidth?: number;
}

export const SuggestionsList = memo(({
  items,
  selectedIndex,
  theme,
  userInput,
  termWidth,
}: SuggestionsListProps) => {
  if (items.length === 0) return null;

  const availableWidth = termWidth || 80;
  const maxNameLen = Math.max(...items.map((suggestion) => suggestion.name.length));
  const commandColWidth = Math.min(maxNameLen + 2, Math.floor(availableWidth * 0.5));

  const maxVisible = MAX_SUGGESTIONS_VISIBLE;
  let scrollStart = 0;
  if (items.length > maxVisible) {
    if (selectedIndex < scrollStart) scrollStart = selectedIndex;
    if (selectedIndex >= scrollStart + maxVisible) scrollStart = selectedIndex - maxVisible + 1;
    scrollStart = Math.max(0, Math.min(scrollStart, items.length - maxVisible));
  }
  const scrollEnd = Math.min(scrollStart + maxVisible, items.length);
  const visibleItems = items.slice(scrollStart, scrollEnd);

  const query = (userInput || '').replace(/^\//, '').toLowerCase();

  return (
    <Box flexDirection="column" marginBottom={1}>
      {scrollStart > 0 && <Text color={theme.semantic.panel.help}>▲</Text>}
      {visibleItems.map((suggestion, index) => {
        const realIndex = scrollStart + index;
        const { name, desc } = suggestion;
        const selected = realIndex === selectedIndex;
        const textColor = selected ? theme.semantic.text.accent : theme.semantic.text.secondary;
        const descColor = selected ? theme.semantic.text.primary : theme.semantic.panel.help;

        let nameElement: ReactNode;
        const matches = suggestion.nameMatches;
        if (matches && matches.length > 0) {
          // 多段模糊命中高亮（下划线）
          const segments: ReactNode[] = [];
          let pos = 0;
          matches.forEach(([start, end], mi) => {
            if (start > pos) segments.push(<Text key={`p-${mi}`}>{name.slice(pos, start)}</Text>);
            segments.push(<Text key={`m-${mi}`} underline>{name.slice(start, end)}</Text>);
            pos = end;
          });
          if (pos < name.length) segments.push(<Text key="tail">{name.slice(pos)}</Text>);
          nameElement = <Text bold color={textColor}>{segments}</Text>;
        } else if (query && name.toLowerCase().includes(query)) {
          const matchIndex = name.toLowerCase().indexOf(query);
          const before = name.slice(0, matchIndex);
          const matched = name.slice(matchIndex, matchIndex + query.length);
          const after = name.slice(matchIndex + query.length);
          nameElement = (
            <Text bold color={textColor}>
              {before}<Text underline>{matched}</Text>{after}
            </Text>
          );
        } else {
          nameElement = <Text bold color={textColor}>{name}</Text>;
        }

        return (
          <Box key={realIndex} flexDirection="row">
            <Box width={commandColWidth} flexShrink={0}>
              {nameElement}
            </Box>
            {desc && (
              <Text color={descColor} wrap="truncate-end">{desc}</Text>
            )}
          </Box>
        );
      })}
      {scrollEnd < items.length && <Text color={theme.semantic.panel.help}>▼</Text>}
      {items.length > maxVisible && (
        <Text color={theme.semantic.panel.help}>{`  (${selectedIndex + 1}/${items.length})`}</Text>
      )}
      <Text color={theme.semantic.panel.help}>{t('tui.suggestions.help')}</Text>
    </Box>
  );
});

SuggestionsList.displayName = 'SuggestionsList';
