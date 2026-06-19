/**
 * ConstrainedBox — Per-message height constraining
 *
 * 当消息渲染行数超过 maxHeight 时，截断内容并显示提示。
 * 配合 Ctrl+S 切换 constrainHeight，让用户查看完整内容。
 * 不再使用应用级滚动偏移，改用终端原生 scrollback。
 *
 * 支持两种截断模式：
 * 1. children 为纯字符串 → 直接截断文本
 * 2. children 为复杂组件 + rawText → 用 rawText 估算行数，
 *    截断后通过 rawTextRenderer 渲染截断内容
 */
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { t } from '../../i18n.js';
import { tuiTheme } from '../theme.js';

export interface ConstrainedBoxProps {
  children: React.ReactNode;
  maxHeight: number | undefined;
  maxWidth: number;
  overflowDirection?: 'top' | 'bottom';
  /** 当 children 不是字符串时，提供原始文本用于估算行数和截断 */
  rawText?: string;
  /** 当使用 rawText 截断时，用此函数渲染截断后的文本 */
  rawTextRenderer?: (truncatedText: string) => React.ReactNode;
}

/** 全局 constrainHeight 状态，Ctrl+S 切换 */
let globalConstrainHeight = true;
const listeners = new Set<() => void>();

export function isConstrainHeight(): boolean {
  return globalConstrainHeight;
}

export function toggleConstrainHeight(): boolean {
  globalConstrainHeight = !globalConstrainHeight;
  listeners.forEach(fn => fn());
  return globalConstrainHeight;
}

export function useConstrainHeight(): boolean {
  const [constrained, setConstrained] = useState(globalConstrainHeight);
  React.useEffect(() => {
    const fn = () => setConstrained(globalConstrainHeight);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return constrained;
}

/**
 * 估算文本渲染行数
 */
function estimateRenderedLines(text: string, maxWidth: number): number {
  if (!text) return 0;
  const lines = text.split('\n');
  let count = 0;
  for (const line of lines) {
    const w = stringWidth(line);
    count += Math.max(1, Math.ceil(w / maxWidth));
  }
  return count;
}

/**
 * 将文本截断到指定行数，返回截断后的原始文本段落和隐藏行数
 *
 * 与纯文本截断不同，这里按原始行（\n 分隔）为单位截断，
 * 保留原始换行结构，这样行级渲染管线能正确渲染截断后的文本。
 */
function truncateRawTextToLines(
  text: string,
  maxWidth: number,
  maxVisualLines: number,
  direction: 'top' | 'bottom',
): { text: string; hiddenLines: number } {
  if (!text) return { text: '', hiddenLines: 0 };

  const rawLines = text.split('\n');
  // 计算每个原始行占多少视觉行
  const visualLineCounts = rawLines.map(line => {
    const w = stringWidth(line);
    return Math.max(1, Math.ceil(w / maxWidth));
  });

  const totalVisualLines = visualLineCounts.reduce((a, b) => a + b, 0);
  if (totalVisualLines <= maxVisualLines) {
    return { text, hiddenLines: 0 };
  }

  const hiddenVisualLines = totalVisualLines - maxVisualLines;

  if (direction === 'top') {
    // 从顶部跳过足够的原始行
    let skippedVisual = 0;
    let skipRawCount = 0;
    for (let i = 0; i < rawLines.length; i++) {
      if (skippedVisual + visualLineCounts[i] > hiddenVisualLines) {
        // 这一行被部分截断 — 我们保留它但无法部分渲染
        // 实际上跳过整行，增加 hiddenLines
        skippedVisual += visualLineCounts[i];
        skipRawCount = i + 1;
      } else {
        skippedVisual += visualLineCounts[i];
        skipRawCount = i + 1;
      }
      if (skippedVisual >= hiddenVisualLines) break;
    }
    return {
      text: rawLines.slice(skipRawCount).join('\n'),
      hiddenLines: skippedVisual,
    };
  } else {
    // 从底部跳过
    let skippedVisual = 0;
    let keepCount = rawLines.length;
    for (let i = rawLines.length - 1; i >= 0; i--) {
      skippedVisual += visualLineCounts[i];
      keepCount = i;
      if (skippedVisual >= hiddenVisualLines) break;
    }
    return {
      text: rawLines.slice(0, keepCount).join('\n'),
      hiddenLines: skippedVisual,
    };
  }
}

/**
 * 将文本截断到指定行数（纯文本模式）
 */
function truncateToLines(text: string, maxWidth: number, maxLines: number, direction: 'top' | 'bottom'): { text: string; hiddenLines: number } {
  const allLines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const w = stringWidth(paragraph);
    const lineCount = Math.max(1, Math.ceil(w / maxWidth));
    if (lineCount <= 1) {
      allLines.push(paragraph);
    } else {
      // 长行按 maxWidth 拆分
      let remaining = paragraph;
      while (remaining.length > 0) {
        let sliceEnd = 0;
        let currentWidth = 0;
        for (const ch of remaining) {
          const cw = stringWidth(ch);
          if (currentWidth + cw > maxWidth) break;
          currentWidth += cw;
          sliceEnd += ch.length; // This works for BMP
        }
        if (sliceEnd === 0) { sliceEnd = 1; }
        allLines.push(remaining.slice(0, sliceEnd));
        remaining = remaining.slice(sliceEnd);
      }
    }
  }

  if (allLines.length <= maxLines) {
    return { text, hiddenLines: 0 };
  }

  const hiddenLines = allLines.length - maxLines;
  if (direction === 'top') {
    // 保留底部（最新内容）
    return { text: allLines.slice(hiddenLines).join('\n'), hiddenLines };
  } else {
    // 保留顶部
    return { text: allLines.slice(0, maxLines).join('\n'), hiddenLines };
  }
}

/**
 * ConstrainedBox — 限制子元素渲染高度
 *
 * 当 constrainHeight 启用且内容超过 maxHeight 时截断显示，
 * 显示 "... N lines hidden ..." 提示。
 * 当 constrainHeight 关闭时，显示完整内容。
 *
 * 支持两种模式：
 * - children 为字符串：直接截断文本渲染
 * - children 为复杂组件 + rawText + rawTextRenderer：
 *   用 rawText 估算行数，截断后通过 rawTextRenderer 重新渲染
 */
export const ConstrainedBox: React.FC<ConstrainedBoxProps> = ({
  children,
  maxHeight,
  maxWidth,
  overflowDirection = 'top',
  rawText,
  rawTextRenderer,
}) => {
  const constrained = useConstrainHeight();

  // 当未约束或 maxHeight 未定义时，直接渲染
  if (!constrained || maxHeight === undefined) {
    return <>{children}</>;
  }

  const effectiveMaxHeight = Math.max(2, Math.round(maxHeight));

  // 提取文本内容估算行数
  let estimatedLines = 0;
  let childText = '';
  let isPlainText = false;

  if (typeof children === 'string') {
    childText = children;
    estimatedLines = estimateRenderedLines(childText, maxWidth);
    isPlainText = true;
  } else if (rawText) {
    // 复杂组件，但有 rawText 可用于估算
    childText = rawText;
    estimatedLines = estimateRenderedLines(childText, maxWidth);
    isPlainText = false;
  } else {
    // 对复杂子元素且无 rawText，不做截断（保持原样渲染）
    return <>{children}</>;
  }

  if (estimatedLines <= effectiveMaxHeight) {
    return <>{children}</>;
  }

  // 需要截断
  const visibleLines = effectiveMaxHeight - 1; // 留1行给提示

  if (isPlainText) {
    // 纯文本截断
    const { text: truncatedText, hiddenLines } = truncateToLines(
      childText, maxWidth, visibleLines, overflowDirection,
    );

    return (
      <Box flexDirection="column">
        {overflowDirection === 'top' && hiddenLines > 0 && (
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate">
            {t('tui.message.hidden_top', hiddenLines)}
          </Text>
        )}
        <Text>{truncatedText}</Text>
        {overflowDirection === 'bottom' && hiddenLines > 0 && (
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate">
            {t('tui.message.hidden_bottom', hiddenLines)}
          </Text>
        )}
      </Box>
    );
  }

  // 复杂组件截断：使用 rawText + rawTextRenderer
  if (rawText && rawTextRenderer) {
    const { text: truncatedRawText, hiddenLines } = truncateRawTextToLines(
      rawText, maxWidth, visibleLines, overflowDirection,
    );

    return (
      <Box flexDirection="column">
        {overflowDirection === 'top' && hiddenLines > 0 && (
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate">
            {t('tui.message.hidden_top', hiddenLines)}
          </Text>
        )}
        {rawTextRenderer(truncatedRawText)}
        {overflowDirection === 'bottom' && hiddenLines > 0 && (
          <Text color={tuiTheme.semantic.panel.help} wrap="truncate">
            {t('tui.message.hidden_bottom', hiddenLines)}
          </Text>
        )}
      </Box>
    );
  }

  // 无法截断，原样渲染
  return <>{children}</>;
};

export default ConstrainedBox;
