import {
  CHAR_CODE_ESC,
  CHAR_CODE_LEFT_BRACKET,
  KITTY_KEYCODE_WHEEL_DOWN,
  KITTY_KEYCODE_WHEEL_UP,
} from './platformConstants.js';

export type MouseWheelDirection = 'up' | 'down';

export interface MouseClickEvent {
  button: 0 | 1 | 2;  // 0=left, 1=middle, 2=right
  col: number;         // 1-indexed
  row: number;         // 1-indexed
  action: 'down' | 'up';
  motion?: boolean;
}

export interface MouseClickParseResult {
  event: MouseClickEvent;
  consumedLength: number;
}

export interface MouseWheelEvent {
  protocol: 'kitty' | 'sgr' | 'x10';
  direction: MouseWheelDirection;
}

export interface MouseWheelParseResult {
  event: MouseWheelEvent;
  consumedLength: number;
}

export function isPotentialMouseWheelPrefix(input: string): boolean {
  return input.startsWith('\x1b[<') || input.startsWith('\x1b[M') || input.startsWith('\x1b[57359;') || input.startsWith('\x1b[57360;');
}

/**
 * Check if input starts with a mouse click event (not wheel).
 * Mouse click events should be discarded to avoid blocking terminal input.
 */
export function isMouseClickEvent(input: string): boolean {
  // SGR format: \x1b[<button;x;yM or \x1b[<button;x;ym
  const sgrMatch = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgrMatch) {
    const button = Number.parseInt(sgrMatch[1] || '', 10);
    // Button 0-2 are left/middle/right click, 64-65 are wheel
    return button >= 0 && button <= 2;
  }

  // X10 format: 6 bytes starting with \x1b[M
  if (
    input.length >= 6 &&
    input.charCodeAt(0) === CHAR_CODE_ESC &&
    input.charCodeAt(1) === CHAR_CODE_LEFT_BRACKET &&
    input.charCodeAt(2) === 0x4d
  ) {
    const button = input.charCodeAt(3) - 32;
    return button >= 0 && button <= 2;
  }

  return false;
}

/**
 * Skip mouse click event from input buffer.
 * Returns the remaining text after consuming the click event, or null if no click found.
 */
export function skipMouseClickEvent(input: string): string | null {
  // SGR format
  const sgrMatch = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgrMatch) {
    const button = Number.parseInt(sgrMatch[1] || '', 10);
    if (button >= 0 && button <= 2) {
      return input.slice(sgrMatch[0].length);
    }
  }

  // X10 format
  if (
    input.length >= 6 &&
    input.charCodeAt(0) === CHAR_CODE_ESC &&
    input.charCodeAt(1) === CHAR_CODE_LEFT_BRACKET &&
    input.charCodeAt(2) === 0x4d
  ) {
    const button = input.charCodeAt(3) - 32;
    if (button >= 0 && button <= 2) {
      return input.slice(6);
    }
  }

  return null;
}

/**
 * Parse mouse click event and return structured data (position + button).
 * Unlike skipMouseClickEvent which discards, this extracts the click info.
 */
export function parseMouseClickEvent(input: string): MouseClickParseResult | null {
  // SGR format: \x1b[<button;col;row[Mm]
  const sgrMatch = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgrMatch) {
    const buttonCode = Number.parseInt(sgrMatch[1] || '', 10);
    const isWheel = (buttonCode & 64) === 64;
    if (!isWheel) {
      const motion = (buttonCode & 32) === 32;
      const button = buttonCode & 3;
      if (button >= 0 && button <= 2) {
        return {
          event: {
            button: button as 0 | 1 | 2,
            col: Number.parseInt(sgrMatch[2] || '', 10),
            row: Number.parseInt(sgrMatch[3] || '', 10),
            action: sgrMatch[4] === 'M' ? 'down' : 'up',
            motion,
          },
          consumedLength: sgrMatch[0].length,
        };
      }
      if (sgrMatch[4] === 'm' && button === 3) {
        return {
          event: {
            button: 0,
            col: Number.parseInt(sgrMatch[2] || '', 10),
            row: Number.parseInt(sgrMatch[3] || '', 10),
            action: 'up',
          },
          consumedLength: sgrMatch[0].length,
        };
      }
    }
  }

  // X10 format: \x1b[M + 3 bytes (button, col, row)
  if (
    input.length >= 6 &&
    input.charCodeAt(0) === CHAR_CODE_ESC &&
    input.charCodeAt(1) === CHAR_CODE_LEFT_BRACKET &&
    input.charCodeAt(2) === 0x4d
  ) {
    const button = input.charCodeAt(3) - 32;
    if (button >= 0 && button <= 2) {
      return {
        event: {
          button: button as 0 | 1 | 2,
          col: input.charCodeAt(4) - 32,
          row: input.charCodeAt(5) - 32,
          action: 'down',
        },
        consumedLength: 6,
      };
    }
  }

  return null;
}

export function parseMouseWheelEventPrefix(input: string): MouseWheelParseResult | null {
  if (!input) return null;

  const kittyMatch = input.match(/^\x1b\[(\d+)(?::[0-9:]+)?;(\d+)u/);
  if (kittyMatch) {
    const keycode = Number.parseInt(kittyMatch[1] || '', 10);
    if (keycode === KITTY_KEYCODE_WHEEL_UP) {
      return { event: { protocol: 'kitty', direction: 'up' }, consumedLength: kittyMatch[0].length };
    }
    if (keycode === KITTY_KEYCODE_WHEEL_DOWN) {
      return { event: { protocol: 'kitty', direction: 'down' }, consumedLength: kittyMatch[0].length };
    }
  }

  const sgrMatch = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (sgrMatch) {
    const button = Number.parseInt(sgrMatch[1] || '', 10);
    if (button === 64) {
      return { event: { protocol: 'sgr', direction: 'up' }, consumedLength: sgrMatch[0].length };
    }
    if (button === 65) {
      return { event: { protocol: 'sgr', direction: 'down' }, consumedLength: sgrMatch[0].length };
    }
  }

  if (
    input.length === 6 &&
    input.charCodeAt(0) === CHAR_CODE_ESC &&
    input.charCodeAt(1) === CHAR_CODE_LEFT_BRACKET &&
    input.charCodeAt(2) === 0x4d
  ) {
    const button = input.charCodeAt(3) - 32;
    if (button === 64) {
      return { event: { protocol: 'x10', direction: 'up' }, consumedLength: 6 };
    }
    if (button === 65) {
      return { event: { protocol: 'x10', direction: 'down' }, consumedLength: 6 };
    }
  }

  return null;
}

export function parseMouseWheelEvent(input: string): MouseWheelEvent | null {
  return parseMouseWheelEventPrefix(input)?.event || null;
}
