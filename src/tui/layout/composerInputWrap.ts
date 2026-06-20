import stringWidth from 'string-width';

export interface ComposerInputLine {
  text: string;
  start: number;
  end: number;
  continuation: boolean;
  cursorOffset?: number;
}

function clampCursor(input: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return input.length;
  return Math.max(0, Math.min(input.length, Math.floor(cursor)));
}

function readCodePoint(input: string, index: number): { char: string; length: number } {
  const codePoint = input.codePointAt(index);
  if (codePoint === undefined) return { char: '', length: 0 };
  const char = String.fromCodePoint(codePoint);
  return { char, length: char.length };
}

/**
 * Split editable TUI input into hard-wrapped display lines.
 *
 * Ink's built-in wrapping can still ellipsize long unbroken runs inside flex rows.
 * We therefore wrap by CJK-aware terminal cell width before rendering, keeping the
 * cursor on the visual line where editing is happening.
 */
export function buildComposerInputLines(inputBuffer: string, inputCursor: number, maxDisplayWidth: number): ComposerInputLine[] {
  // Reserve 1 cell for the blinking cursor (▋) so it never overflows the line.
  const width = Math.max(1, Math.floor(maxDisplayWidth) - 1);
  const cursor = clampCursor(inputBuffer, inputCursor);
  const lines: ComposerInputLine[] = [];

  let i = 0;
  let lineStart = 0;
  let lineText = '';
  let lineWidth = 0;
  let continuation = false;

  const emitLine = (end: number, nextStart = end, nextContinuation = true) => {
    lines.push({ text: lineText, start: lineStart, end, continuation });
    lineText = '';
    lineWidth = 0;
    lineStart = nextStart;
    continuation = nextContinuation;
  };

  while (i < inputBuffer.length) {
    const { char, length } = readCodePoint(inputBuffer, i);
    if (length === 0) break;

    if (char === '\n' || char === '\r') {
      let newlineLength = length;
      if (char === '\r' && inputBuffer[i + length] === '\n') {
        newlineLength += 1;
      }
      emitLine(i, i + newlineLength, false);
      i += newlineLength;
      continue;
    }

    const charWidth = stringWidth(char);
    if (lineText.length > 0 && lineWidth + charWidth > width) {
      emitLine(i, i, true);
    }

    lineText += char;
    lineWidth += charWidth;
    i += length;
  }

  if (lineText.length > 0 || lines.length === 0 || /[\r\n]$/.test(inputBuffer)) {
    lines.push({ text: lineText, start: lineStart, end: inputBuffer.length, continuation });
  }

  let cursorLineIndex = lines.findIndex((line) => cursor >= line.start && cursor < line.end);
  if (cursorLineIndex < 0) {
    cursorLineIndex = lines.findIndex((line) => line.start === line.end && cursor === line.start);
  }
  if (cursorLineIndex < 0) {
    cursorLineIndex = lines.findIndex((line, index) => {
      if (cursor !== line.end) return false;
      const nextChar = inputBuffer[line.end];
      return index === lines.length - 1 || nextChar === '\n' || nextChar === '\r';
    });
  }
  if (cursorLineIndex < 0) cursorLineIndex = Math.max(0, lines.length - 1);

  return lines.map((line, index) => {
    if (index !== cursorLineIndex) return line;
    return { ...line, cursorOffset: Math.max(0, Math.min(line.text.length, cursor - line.start)) };
  });
}
