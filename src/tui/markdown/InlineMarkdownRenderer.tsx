/**
 * Inline markdown renderer for Ink-based terminal UI.
 *
 * Renders inline markdown elements: bold, italic, strikethrough, inline code,
 * links, underline, and bare URLs.
 */

import React from 'react';
import { Text } from 'ink';
import { tuiTheme } from '../theme.js';
import stringWidth from 'string-width';

const BOLD_MARKER_LENGTH = 2;
const ITALIC_MARKER_LENGTH = 1;
const STRIKETHROUGH_MARKER_LENGTH = 2;
const INLINE_CODE_MARKER_LENGTH = 1;
const UNDERLINE_TAG_START_LENGTH = 3;
const UNDERLINE_TAG_END_LENGTH = 4;

interface RenderInlineProps {
  text: string;
  textColor?: string;
}

const RenderInlineInternal: React.FC<RenderInlineProps> = ({
  text,
  textColor = tuiTheme.semantic.text.primary,
}) => {
  // Early return for plain text without markdown chars
  if (!/[*_~`<[https?:]/.test(text)) {
    return <Text color={textColor}>{text}</Text>;
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  const inlineRegex =
    /(\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <Text key={`t-${lastIndex}`}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }

    const fullMatch = match[0];
    let renderedNode: React.ReactNode = null;
    const key = `m-${match.index}`;

    try {
      if (
        fullMatch.startsWith('**') &&
        fullMatch.endsWith('**') &&
        fullMatch.length > BOLD_MARKER_LENGTH * 2
      ) {
        renderedNode = (
          <Text key={key} bold>
            {fullMatch.slice(BOLD_MARKER_LENGTH, -BOLD_MARKER_LENGTH)}
          </Text>
        );
      } else if (
        fullMatch.length > ITALIC_MARKER_LENGTH * 2 &&
        ((fullMatch.startsWith('*') && fullMatch.endsWith('*')) ||
          (fullMatch.startsWith('_') && fullMatch.endsWith('_'))) &&
        !/\w/.test(text.substring(match.index - 1, match.index)) &&
        !/\w/.test(
          text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 1),
        ) &&
        !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
        !/[./\\]\S/.test(
          text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 2),
        )
      ) {
        renderedNode = (
          <Text key={key} italic>
            {fullMatch.slice(ITALIC_MARKER_LENGTH, -ITALIC_MARKER_LENGTH)}
          </Text>
        );
      } else if (
        fullMatch.startsWith('~~') &&
        fullMatch.endsWith('~~') &&
        fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2
      ) {
        renderedNode = (
          <Text key={key} strikethrough>
            {fullMatch.slice(
              STRIKETHROUGH_MARKER_LENGTH,
              -STRIKETHROUGH_MARKER_LENGTH,
            )}
          </Text>
        );
      } else if (
        fullMatch.startsWith('`') &&
        fullMatch.endsWith('`') &&
        fullMatch.length > INLINE_CODE_MARKER_LENGTH
      ) {
        const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
        if (codeMatch && codeMatch[2]) {
          renderedNode = (
            <Text key={key} color={tuiTheme.semantic.text.code}>
              {codeMatch[2]}
            </Text>
          );
        }
      } else if (
        fullMatch.startsWith('[') &&
        fullMatch.includes('](') &&
        fullMatch.endsWith(')')
      ) {
        const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
          const linkText = linkMatch[1];
          const url = linkMatch[2];
          renderedNode = (
            <Text key={key}>
              {linkText}
              <Text color={tuiTheme.semantic.text.link}> ({url})</Text>
            </Text>
          );
        }
      } else if (
        fullMatch.startsWith('<u>') &&
        fullMatch.endsWith('</u>') &&
        fullMatch.length > UNDERLINE_TAG_START_LENGTH + UNDERLINE_TAG_END_LENGTH - 1
      ) {
        renderedNode = (
          <Text key={key} underline>
            {fullMatch.slice(UNDERLINE_TAG_START_LENGTH, -UNDERLINE_TAG_END_LENGTH)}
          </Text>
        );
      } else if (fullMatch.match(/^https?:\/\//)) {
        renderedNode = (
          <Text key={key} color={tuiTheme.semantic.text.link}>
            {fullMatch}
          </Text>
        );
      }
    } catch {/* swallowed: unhandled error */
      renderedNode = null;
    }

    nodes.push(renderedNode ?? <Text key={key}>{fullMatch}</Text>);
    lastIndex = inlineRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(<Text key={`t-${lastIndex}`}>{text.slice(lastIndex)}</Text>);
  }

  return <>{nodes.filter((node) => node !== null)}</>;
};

export const RenderInline = React.memo(RenderInlineInternal);

/**
 * Get the plain text length of a string with markdown formatting stripped.
 * Useful for calculating column widths in tables.
 */
export const getPlainTextLength = (text: string): number => {
  const cleanText = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/<u>(.*?)<\/u>/g, '$1')
    .replace(/.*\[(.*?)\]\(.*\)/g, '$1');
  return stringWidth(cleanText);
};
