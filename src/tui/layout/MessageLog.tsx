import { memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { t } from '../../i18n.js';
import { tuiGlyphs } from '../design/tokens.js';
import { sliceByWidth } from '../format/display.js';
import { RenderInline } from '../markdown/index.js';
import { colorizeLine } from '../markdown/CodeColorizer.js';
import { registerCodeBlock } from '../state/codeBlockRegistry.js';
import type { TuiTheme } from '../theme.js';
import type { RenderedLogLine } from '../utils.js';

export interface MessageSelectionPoint {
  lineIndex: number;
  column: number;
}

export interface MessageSelectionRange {
  anchor: MessageSelectionPoint;
  focus: MessageSelectionPoint;
}

interface MessageLogProps {
  lines: RenderedLogLine[];
  hiddenAbove: number;
  hiddenBelow: number;
  /** 被渲染窗口裁剪掉的更早消息条数(>0 时顶部 indicator 附「已省略 N 条较早消息」) */
  truncatedMessages?: number;
  theme: TuiTheme;
  width: number;
  selection?: MessageSelectionRange | null;
}

function lineColor(line: RenderedLogLine, theme: TuiTheme): string {
  if (line.type === 'user') return theme.semantic.text.accent;
  if (line.type === 'leader') return theme.semantic.text.primary;
  if (line.type === 'agent') return theme.semantic.text.primary;
  if (line.type === 'thinking') return theme.semantic.text.secondary;
  if (line.type === 'code') return theme.semantic.text.code;
  if (line.type === 'table') return theme.semantic.text.secondary;
  if (line.type === 'error') return theme.semantic.status.failed;
  if (line.type === 'success') return theme.semantic.status.completed;
  return theme.semantic.text.secondary;
}

/**
 * Prefix rendering — determines the left-column glyph and color per line.
 * user lines: solid accent bar `▎` for the full group.
 * leader/agent lines: glyph on first line, faint vertical pipe on continuation.
 * Other types: standard glyphs.
 */
function linePrefix(line: RenderedLogLine, theme: TuiTheme): { glyph: string; color: string } {
  if (line.type === 'user') {
    return { glyph: '▎', color: theme.semantic.text.accent };
  }
  if (line.type === 'leader' || line.type === 'agent') {
    if (!line.isContinuation) {
      const g = line.type === 'leader' ? tuiGlyphs.leader : tuiGlyphs.agent;
      return { glyph: g, color: theme.semantic.text.primary };
    }
    return { glyph: '│', color: theme.semantic.panel.border };
  }
  if (line.isContinuation) return { glyph: '', color: theme.semantic.text.secondary };
  if (line.type === 'thinking' || line.type === 'system') return { glyph: tuiGlyphs.thinking, color: theme.semantic.text.secondary };
  if (line.type === 'error') return { glyph: tuiGlyphs.error, color: theme.semantic.status.failed };
  if (line.type === 'success') return { glyph: tuiGlyphs.success, color: theme.semantic.status.completed };
  return { glyph: '', color: theme.semantic.text.secondary };
}

function bodyText(line: RenderedLogLine): string {
  if (line.type === 'spacer') return '';
  // 表格行/块级公式行:返回干净纯文本(tablePlainLine),供选择/复制(已去 ANSI + markdown 标记)
  if (line.type === 'table') return line.tablePlainLine ?? '';
  // 列表项:返回与渲染一致的可见文本(marker + 正文 / 续行空格对齐 + 正文),保证选择/复制不漂移
  if (line.listMarker != null) {
    const indent = ' '.repeat(line.listIndent ?? 0);
    if (line.listContinuation) {
      return `${indent}${' '.repeat(stringWidth(line.listMarker) + 1)}${line.text}`;
    }
    return `${indent}${line.listMarker} ${line.text}`;
  }
  if (line.type === 'code') return line.text;
  return line.text.startsWith('  ') ? line.text.slice(2) : line.text;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/<u>(.*?)<\/u>/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(^|[^\w])\*([^*\n]+)\*(?=$|[^\w])/g, '$1$2')
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, '$1$2');
}

function normalizeBlockMarkdown(text: string): string {
  const trimmed = text.trimStart();
  const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
  if (heading) return heading[1] || '';
  const blockquote = trimmed.match(/^>\s?(.*)$/);
  if (blockquote) return `| ${blockquote[1] || ''}`;
  const hr = trimmed.match(/^([-*_]\s*){3,}$/);
  if (hr) return '─'.repeat(Math.max(12, Math.min(48, stringWidth(text))));
  return text;
}

export function getMessageLogSelectableText(line: RenderedLogLine): string {
  // table/math 行:tablePlainLine 已是干净纯文本,跳过 strip/normalize
  // (否则 normalizeBlockMarkdown 会误判边框 ┌│└ 字符)。
  if (line.type === 'table') return bodyText(line);
  return stripInlineMarkdown(normalizeBlockMarkdown(bodyText(line)));
}

export function normalizeMessageSelectionRange(range: MessageSelectionRange): {
  start: MessageSelectionPoint;
  end: MessageSelectionPoint;
} {
  const anchorBeforeFocus =
    range.anchor.lineIndex < range.focus.lineIndex ||
    (range.anchor.lineIndex === range.focus.lineIndex && range.anchor.column <= range.focus.column);
  return anchorBeforeFocus
    ? { start: range.anchor, end: range.focus }
    : { start: range.focus, end: range.anchor };
}

function sliceDisplayColumns(text: string, startColumn: number, endColumn: number): string {
  const safeStart = Math.max(0, startColumn);
  const safeEnd = Math.max(safeStart, endColumn);
  const before = sliceByWidth(text, safeStart).sliced;
  const beforeWidth = stringWidth(before);
  const remaining = text.slice(before.length);
  return sliceByWidth(remaining, safeEnd - beforeWidth).sliced;
}

export function getSelectedMessageText(lines: RenderedLogLine[], range: MessageSelectionRange): string {
  const { start, end } = normalizeMessageSelectionRange(range);
  const selected: string[] = [];
  for (let lineIndex = start.lineIndex; lineIndex <= end.lineIndex; lineIndex++) {
    const line = lines[lineIndex];
    if (!line) continue;
    const text = getMessageLogSelectableText(line);
    const lineWidth = stringWidth(text);
    const startColumn = lineIndex === start.lineIndex ? start.column : 0;
    const endColumn = lineIndex === end.lineIndex ? end.column : lineWidth;
    selected.push(sliceDisplayColumns(text, startColumn, endColumn));
  }
  return selected.join('\n').trimEnd();
}

function getLineSelectionColumns(
  lineIndex: number,
  text: string,
  selection?: MessageSelectionRange | null,
): { start: number; end: number } | null {
  if (!selection) return null;
  const { start, end } = normalizeMessageSelectionRange(selection);
  if (lineIndex < start.lineIndex || lineIndex > end.lineIndex) return null;
  const lineWidth = stringWidth(text);
  const startColumn = lineIndex === start.lineIndex ? start.column : 0;
  const endColumn = lineIndex === end.lineIndex ? end.column : lineWidth;
  const normalizedStart = Math.max(0, Math.min(startColumn, lineWidth));
  const normalizedEnd = Math.max(0, Math.min(endColumn, lineWidth));
  if (normalizedEnd <= normalizedStart) return null;
  return { start: normalizedStart, end: normalizedEnd };
}

function renderSelectedPlainText(
  text: string,
  lineIndex: number,
  color: string,
  theme: TuiTheme,
  selection?: MessageSelectionRange | null,
) {
  const selectedColumns = getLineSelectionColumns(lineIndex, text, selection);
  if (!selectedColumns) return <Text color={color}>{text}</Text>;

  const before = sliceDisplayColumns(text, 0, selectedColumns.start);
  const selected = sliceDisplayColumns(text, selectedColumns.start, selectedColumns.end);
  const after = sliceDisplayColumns(text, selectedColumns.end, stringWidth(text));
  return (
    <>
      {before && <Text color={color}>{before}</Text>}
      {selected && (
        <Text
          color={theme.semantic.selection.text}
          backgroundColor={theme.semantic.selection.background}
        >
          {selected}
        </Text>
      )}
      {after && <Text color={color}>{after}</Text>}
    </>
  );
}

function renderMarkdownLine(
  text: string,
  lineIndex: number,
  color: string,
  theme: TuiTheme,
  selection?: MessageSelectionRange | null,
) {
  const visiblePlainText = stripInlineMarkdown(normalizeBlockMarkdown(text));
  const selectedText = getLineSelectionColumns(lineIndex, visiblePlainText, selection);
  if (selectedText) {
    return renderSelectedPlainText(visiblePlainText, lineIndex, color, theme, selection);
  }

  const trimmed = text.trimStart();
  const leading = text.slice(0, text.length - trimmed.length);
  const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    return (
      <>
        {leading && <Text color={color}>{leading}</Text>}
        <Text bold color={theme.semantic.panel.title}>
          <RenderInline text={heading[2] || ''} textColor={theme.semantic.panel.title} />
        </Text>
      </>
    );
  }
  const blockquote = trimmed.match(/^>\s?(.*)$/);
  if (blockquote) {
    return (
      <>
        {leading && <Text color={color}>{leading}</Text>}
        <Text color={theme.semantic.border.default}>| </Text>
        <Text color={theme.semantic.text.secondary}>
          <RenderInline text={blockquote[1] || ''} textColor={theme.semantic.text.secondary} />
        </Text>
      </>
    );
  }
  if (/^([-*_]\s*){3,}$/.test(trimmed)) {
    return <Text color={theme.semantic.border.default}>{'─'.repeat(Math.max(12, Math.min(48, stringWidth(text))))}</Text>;
  }
  return <RenderInline text={text} textColor={color} />;
}

// ── Code Block Frame Helpers ──

/** Is this the opening fence line of a code block? e.g. ```ts */
function isCodeFenceOpen(line: RenderedLogLine): boolean {
  return line.type === 'code' && !line.isContinuation && line.text.startsWith('```');
}

/** Is this the closing fence line of a code block? */
function isCodeFenceClose(line: RenderedLogLine): boolean {
  return line.type === 'code' && line.isContinuation === true && line.text === '```';
}

function renderCodeHeader(lang: string | undefined, bodyWidth: number, theme: TuiTheme) {
  const label = lang || t('tui.message.code_default');
  // ┌─ ts ─────────────────────────────────┐
  const inner = bodyWidth - 2; // subtract corners
  const labelPart = `─ ${label} `;
  const fillLen = Math.max(0, inner - stringWidth(labelPart));
  const fill = '─'.repeat(fillLen);
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.semantic.panel.border}>{'┌'}</Text>
      <Text color={theme.codeHeader}>{labelPart}</Text>
      <Text color={theme.semantic.panel.border}>{fill}{'┐'}</Text>
    </Box>
  );
}

function renderCodeFooter(bodyWidth: number, theme: TuiTheme) {
  // └─────────────────────────────────────┘
  const inner = Math.max(0, bodyWidth - 2);
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.semantic.panel.border}>{'└'}{'─'.repeat(inner)}{'┘'}</Text>
    </Box>
  );
}

// 流式未闭合代码块的虚线底框(┄┄ 生成中 ┄┄),传达"还在写",区别于闭合块的实线底框。
function renderCodeFooterStreaming(bodyWidth: number, theme: TuiTheme) {
  const inner = Math.max(0, bodyWidth - 2);
  const label = ` ${t('tui.code.generating_more')} `;
  const fillLen = Math.max(0, inner - stringWidth(label));
  const leftLen = Math.ceil(fillLen / 2);
  const left = '┄'.repeat(leftLen);
  const right = '┄'.repeat(fillLen - leftLen);
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.semantic.panel.border}>
        {'┄'}{left}<Text color={theme.semantic.text.secondary}>{label}</Text>{right}{'┄'}
      </Text>
    </Box>
  );
}

// ── Turn Divider ──

function renderTurnDivider(bodyWidth: number, theme: TuiTheme) {
  const side = Math.max(2, Math.floor((bodyWidth - 3) / 2));
  const left = '─'.repeat(side);
  const right = '─'.repeat(bodyWidth - side - 3);
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.semantic.panel.divider}>{left}{' · '}{right}</Text>
    </Box>
  );
}

// ── Tool Log Line ──

const ToolLogLine = ({ line, theme }: { line: RenderedLogLine; theme: TuiTheme }) => {
  const isResult = line.toolKind === 'result';
  const icon = isResult ? tuiGlyphs.success : tuiGlyphs.tool;
  const iconColor = isResult ? theme.semantic.status.completed : theme.semantic.runtime.tool;
  const status = line.toolStatus || (isResult ? t('tui.message.tool_done') : t('tui.message.tool_running'));
  const detail = [line.toolSummary, line.toolMeta].filter(Boolean).join(' · ');
  const hasDiff = (line.toolAdded ?? 0) > 0 || (line.toolRemoved ?? 0) > 0;
  // cardCollapsed === false ⇒ 已展开 → 显示 ▾;否则(折叠或缺省)▸
  const marker = line.cardCollapsed === false ? ' ▾' : ' ▸';

  // 实时计时器：工具执行中时每秒更新经过的秒数
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (isResult || !line.toolStartedAt) {
      setElapsed(0);
      return;
    }
    // 立即更新一次，避免首秒空白
    setElapsed(Math.floor((Date.now() - line.toolStartedAt) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - line.toolStartedAt!) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isResult, line.toolStartedAt]);

  // 计时显示：执行中显示实时秒数；完成时显示总耗时（若有）
  const timerLabel = isResult
    ? line.toolDuration && line.toolDuration > 0
      ? `${Math.round(line.toolDuration / 1000)}s`
      : ''
    : elapsed > 0
      ? `${elapsed}s`
      : '';

  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={iconColor}>{icon}</Text>
        <Text bold>{` ${line.toolName || t('tui.message.tool_default')}`}</Text>
        <Text color={theme.semantic.text.secondary}>{` -> ${status}${timerLabel ? ` ${timerLabel}` : ''}`}</Text>
        {detail && <Text color={theme.semantic.text.secondary}>{` · ${detail}`}</Text>}
        {hasDiff && (
          <>
            <Text color={theme.semantic.diff.add}>{` +${line.toolAdded}`}</Text>
            <Text color={theme.semantic.diff.del}>{` -${line.toolRemoved}`}</Text>
          </>
        )}
        <Text color={theme.semantic.text.secondary}>{marker}</Text>
      </Text>
    </Box>
  );
};

// ── Scroll Indicators ──

function renderScrollIndicator(direction: 'up' | 'down', count: number, bodyWidth: number, theme: TuiTheme, note?: string) {
  const arrow = direction === 'up' ? '▲' : '▼';
  const label = note ? ` +${count} · ${note} ` : ` +${count} `;
  const fillLen = Math.max(0, bodyWidth - stringWidth(arrow) - stringWidth(label));
  const fill = '─'.repeat(fillLen);
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.semantic.text.accent}>{arrow}</Text>
      <Text color={theme.semantic.text.secondary}>{label}</Text>
      <Text color={theme.semantic.panel.divider}>{fill}</Text>
    </Box>
  );
}

export const MessageLog = memo(({ lines, hiddenAbove, hiddenBelow, truncatedMessages, theme, width, selection }: MessageLogProps) => {
  const bodyWidth = Math.max(1, width - 3);

  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      {hiddenAbove > 0 && renderScrollIndicator('up', hiddenAbove, bodyWidth, theme, truncatedMessages ? t('tui.channel.trimmed', truncatedMessages) : undefined)}
      {lines.map((line, index) => {
        // Thinking 卡头行(可点击折叠/展开):▸/▾ + 字数摘要
        if (line.type === 'thinking' && line.cardKey) {
          const marker = line.cardCollapsed === false ? '▾' : '▸';
          return (
            <Box key={`tch-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0}>
                <Text bold color={theme.semantic.text.accent}>{marker}</Text>
              </Box>
              <Box width={bodyWidth} overflow="hidden">
                <Text wrap="truncate-end" color={theme.semantic.text.secondary}>{line.text}</Text>
              </Box>
            </Box>
          );
        }

        if (line.type === 'tool') {
          // 展开态:diff 行(+/- 着色)
          if (line.toolDiffKind) {
            const kind = line.toolDiffKind;
            const diffColor = kind === 'add' ? theme.semantic.diff.add
              : kind === 'del' ? theme.semantic.diff.del
                : kind === 'hunk' ? theme.semantic.diff.hunk
                  : theme.semantic.diff.context;
            const diffPrefix = kind === 'add' ? '+ ' : kind === 'del' ? '- ' : kind === 'hunk' ? '' : '  ';
            return (
              <Box key={`tdiff-${index}`} flexDirection="row" height={1} overflow="hidden">
                <Box width={3} flexShrink={0} />
                <Box width={bodyWidth} overflow="hidden">
                  <Text wrap="truncate-end" color={diffColor}>{diffPrefix}{line.text}</Text>
                </Box>
              </Box>
            );
          }
          // 头行(可点击折叠/展开)
          if (line.cardKey) {
            return <ToolLogLine key={`tool-${index}`} line={line} theme={theme} />;
          }
          // 展开态:摘要子行
          return (
            <Box key={`tsum-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                <Text wrap="truncate-end" color={theme.semantic.text.secondary}>{line.text}</Text>
              </Box>
            </Box>
          );
        }

        // 轻量呼吸间距:纯空行(content ↔ meta / content ↔ alert 边界)。
        if (line.type === 'spacer') {
          return <Box key={`sp-${index}`} height={1} />;
        }

        // Turn divider — empty system line between content messages
        if (line.type === 'system' && line.text.trim() === '') {
          return (
            <Box key={`div-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                {renderTurnDivider(bodyWidth, theme)}
              </Box>
            </Box>
          );
        }

        // Code block: opening fence → styled header
        if (isCodeFenceOpen(line)) {
          if (line.codeContent) registerCodeBlock(line.codeContent, line.codeLang || null);
          return (
            <Box key={`cfh-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                {renderCodeHeader(line.codeLang, bodyWidth, theme)}
              </Box>
            </Box>
          );
        }

        // 流式未闭合代码块:虚线底框(代替闭合 ``` 的实线底框)
        if (line.type === 'code' && line.codeOpenEnded && line.isContinuation && line.text === '```') {
          return (
            <Box key={`cfe-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                {renderCodeFooterStreaming(bodyWidth, theme)}
              </Box>
            </Box>
          );
        }

        // Code block: closing fence → styled footer
        if (isCodeFenceClose(line)) {
          return (
            <Box key={`cff-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                {renderCodeFooter(bodyWidth, theme)}
              </Box>
            </Box>
          );
        }

        // Code block: content lines → vertical pipe border + highlighted code
        if (line.type === 'code') {
          const text = bodyText(line);
          const selectableText = getMessageLogSelectableText(line);
          const selectedColumns = getLineSelectionColumns(index, selectableText, selection);
          const codeWidth = Math.max(1, bodyWidth - 2); // 2 for "│ " prefix
          return (
            <Box key={`code-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Text color={theme.semantic.panel.border}>{'│ '}</Text>
              <Box width={codeWidth} overflow="hidden">
                <Text wrap="truncate-end">
                  {selectedColumns
                    ? renderSelectedPlainText(selectableText, index, theme.semantic.text.code, theme, selection)
                    : colorizeLine(text, line.codeLang || null)}
                </Text>
              </Box>
            </Box>
          );
        }

        // 表格行 / 块级公式行:表格 ANSI 透传(颜色在串内),公式 secondary 色;
        // 无 glyph 前缀列(独立块,自带左边距)。选择态降级为 plainLine + secondary 色
        // (ANSI 串无法被 renderSelectedPlainText 正确切片,会切断转义码)。
        if (line.type === 'table') {
          const selectableText = getMessageLogSelectableText(line);
          const selectedColumns = getLineSelectionColumns(index, selectableText, selection);
          return (
            <Box key={`tbl-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                {selectedColumns
                  ? renderSelectedPlainText(selectableText, index, theme.semantic.text.secondary, theme, selection)
                  : line.mathLine
                    ? <Text wrap="truncate-end" color={theme.semantic.text.secondary}>{selectableText}</Text>
                    : <Text>{line.text}</Text>}
              </Box>
            </Box>
          );
        }

        // 列表项(ul/ol):marker + 缩进 + 正文;续行用空格占位 marker 对齐
        if (line.listMarker != null) {
          const indent = ' '.repeat(line.listIndent ?? 0);
          const lineTextColor = lineColor(line, theme);
          if (line.listContinuation) {
            const pad = stringWidth(line.listMarker) + 1;
            return (
              <Box key={`list-${index}`} flexDirection="row" height={1} overflow="hidden">
                <Box width={3} flexShrink={0} />
                <Box width={bodyWidth} overflow="hidden">
                  <Text wrap="truncate-end" color={lineTextColor}>
                    {`${indent}${' '.repeat(pad)}`}
                    <RenderInline text={line.text} textColor={lineTextColor} />
                  </Text>
                </Box>
              </Box>
            );
          }
          return (
            <Box key={`list-${index}`} flexDirection="row" height={1} overflow="hidden">
              <Box width={3} flexShrink={0} />
              <Box width={bodyWidth} overflow="hidden">
                <Text wrap="truncate-end">
                  <Text color={theme.semantic.text.accent}>{`${indent}${line.listMarker} `}</Text>
                  <RenderInline text={line.text} textColor={lineTextColor} />
                </Text>
              </Box>
            </Box>
          );
        }

        // Regular lines (user, leader, agent, thinking, system, error, success)
        const prefix = linePrefix(line, theme);
        const color = lineColor(line, theme);
        const text = bodyText(line);

        return (
          <Box key={`line-${index}`} flexDirection="row" height={1} overflow="hidden">
            <Box width={3} flexShrink={0}>
              <Text color={prefix.color}>{prefix.glyph}</Text>
            </Box>
            <Box width={bodyWidth} overflow="hidden">
              <Text wrap="truncate-end">
                {renderMarkdownLine(text, index, color, theme, selection)}
              </Text>
            </Box>
          </Box>
        );
      })}
      {hiddenBelow > 0 && renderScrollIndicator('down', hiddenBelow, bodyWidth, theme)}
    </Box>
  );
});

MessageLog.displayName = 'MessageLog';

