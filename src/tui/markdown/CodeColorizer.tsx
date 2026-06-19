/**
 * Code syntax highlighting via lowlight for Ink-based terminal UI.
 *
 * Uses lowlight (highlight.js AST) to parse code and map hljs CSS classes
 * to Ink color strings from tuiTheme.hljs.
 */

import React from 'react';
import { Text, Box } from 'ink';
import { t } from '../../i18n.js';
import { common, createLowlight } from 'lowlight';
import type {
  Root,
  Element,
  Text as HastText,
  ElementContent,
  RootContent,
} from 'hast';
import { tuiTheme } from '../theme.js';

const lowlight = createLowlight(common);

/**
 * Map an hljs CSS class name to an Ink color string.
 */
function getInkColor(className: string): string | undefined {
  const mapping: Record<string, string> = {
    'hljs-keyword': tuiTheme.hljs.keyword,
    'hljs-built_in': tuiTheme.hljs.built_in,
    'hljs-type': tuiTheme.hljs.type,
    'hljs-literal': tuiTheme.hljs.literal,
    'hljs-number': tuiTheme.hljs.number,
    'hljs-string': tuiTheme.hljs.string,
    'hljs-comment': tuiTheme.hljs.comment,
    'hljs-function': tuiTheme.hljs.function,
    'hljs-title': tuiTheme.hljs.title,
    'hljs-params': tuiTheme.hljs.params,
    'hljs-attr': tuiTheme.hljs.attr,
    'hljs-variable': tuiTheme.hljs.variable,
    'hljs-regexp': tuiTheme.hljs.regexp,
    'hljs-meta': tuiTheme.hljs.meta,
    'hljs-operator': tuiTheme.hljs.operator,
    'hljs-selector-class': tuiTheme.hljs.function,
    'hljs-selector-id': tuiTheme.hljs.function,
    'hljs-selector-tag': tuiTheme.hljs.keyword,
    'hljs-attribute': tuiTheme.hljs.attr,
    'hljs-name': tuiTheme.hljs.function,
    'hljs-tag': tuiTheme.hljs.keyword,
    'hljs-addition': tuiTheme.hljs.string,
    'hljs-deletion': tuiTheme.hljs.regexp,
    'hljs-symbol': tuiTheme.hljs.literal,
    'hljs-bullet': tuiTheme.hljs.variable,
    'hljs-link': tuiTheme.semantic.text.link,
    'hljs-subst': tuiTheme.hljs.variable,
    'hljs-template-variable': tuiTheme.hljs.variable,
    'hljs-template-tag': tuiTheme.hljs.keyword,
    'hljs-property': tuiTheme.hljs.variable,
    'hljs-section': tuiTheme.hljs.keyword,
  };
  return mapping[className];
}

function renderHastNode(
  node: Root | Element | HastText | RootContent,
  inheritedColor: string | undefined,
): React.ReactNode {
  if (node.type === 'text') {
    const color = inheritedColor || tuiTheme.hljs.default;
    return <Text color={color}>{node.value}</Text>;
  }

  if (node.type === 'element') {
    const nodeClasses: string[] =
      (node.properties?.['className'] as string[]) || [];
    let elementColor: string | undefined = undefined;

    for (let i = nodeClasses.length - 1; i >= 0; i--) {
      const color = getInkColor(nodeClasses[i]);
      if (color) {
        elementColor = color;
        break;
      }
    }

    const colorToPassDown = elementColor || inheritedColor;

    const children = node.children?.map(
      (child: ElementContent, index: number) => (
        <React.Fragment key={index}>
          {renderHastNode(child, colorToPassDown)}
        </React.Fragment>
      ),
    );

    return <React.Fragment>{children}</React.Fragment>;
  }

  if (node.type === 'root') {
    if (!node.children || node.children.length === 0) {
      return null;
    }
    return node.children?.map((child: RootContent, index: number) => (
      <React.Fragment key={index}>
        {renderHastNode(child, inheritedColor)}
      </React.Fragment>
    ));
  }

  return null;
}

function highlightAndRenderLine(
  line: string,
  language: string | null,
): React.ReactNode {
  try {
    const getHighlightedLine = () =>
      !language || !lowlight.registered(language)
        ? lowlight.highlightAuto(line)
        : lowlight.highlight(language, line);

    const renderedNode = renderHastNode(getHighlightedLine(), undefined);
    return renderedNode !== null ? renderedNode : line;
  } catch {/* expected: use default */
    return line;
  }
}

/**
 * Render syntax-highlighted code for Ink applications.
 *
 * @param code The code string to highlight.
 * @param language The language identifier.
 * @param availableHeight Optional max height for truncation.
 * @param maxWidth Optional max width for layout.
 * @param showLineNumbers Whether to show line numbers (default true).
 * @param tabWidth Number of spaces per tab (default 4).
 */
export function colorizeCode(
  code: string,
  language: string | null,
  availableHeight?: number,
  maxWidth?: number,
  showLineNumbers = true,
  tabWidth = 4,
): React.ReactNode {
  const codeToHighlight = code
    .replace(/\n$/, '')
    .replace(/\t/g, ' '.repeat(tabWidth));

  try {
    let lines = codeToHighlight.split('\n');
    const padWidth = String(lines.length).length;
    let hiddenLinesCount = 0;

    // Truncate from top if too many lines
    const MINIMUM_MAX_HEIGHT = 2;
    if (availableHeight !== undefined) {
      availableHeight = Math.max(availableHeight, MINIMUM_MAX_HEIGHT);
      if (lines.length > availableHeight) {
        const sliceIndex = lines.length - availableHeight;
        hiddenLinesCount = sliceIndex;
        lines = lines.slice(sliceIndex);
      }
    }

    return (
      <Box flexDirection="column" width={maxWidth} flexShrink={0}>
        {hiddenLinesCount > 0 && (
          <Text color={tuiTheme.semantic.text.secondary}>
            {t('tui.code.first_lines_hidden', hiddenLinesCount)}
          </Text>
        )}
        {lines.map((line, index) => {
          const contentToRender = highlightAndRenderLine(line, language);
          return (
            <Box key={index}>
              {showLineNumbers && (
                <Text color={tuiTheme.semantic.text.secondary}>
                  {`${String(index + 1 + hiddenLinesCount).padStart(padWidth, ' ')} `}
                </Text>
              )}
              <Text color={tuiTheme.hljs.default} wrap="wrap">
                {contentToRender}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  } catch {
    // Fall back to plain text
    const lines = codeToHighlight.split('\n');
    const padWidth = String(lines.length).length;
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Box key={index}>
            {showLineNumbers && (
              <Text color={tuiTheme.hljs.default}>
                {`${String(index + 1).padStart(padWidth, ' ')} `}
              </Text>
            )}
            <Text color={tuiTheme.hljs.default}>{line}</Text>
          </Box>
        ))}
      </Box>
    );
  }
}

/**
 * Highlight a single line of code.
 */
export function colorizeLine(
  line: string,
  language: string | null,
): React.ReactNode {
  return highlightAndRenderLine(line, language);
}
