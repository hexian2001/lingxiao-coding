import { useEffect } from 'react';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { routeRawBracketedPasteChunk } from '../utils.js';
import {
  isPotentialMouseWheelPrefix,
  parseMouseWheelEventPrefix,
  parseMouseClickEvent,
  type MouseClickEvent,
} from '../../ui/mouseWheel.js';
import type { KeyLike } from './useTuiKeyController.js';
import { t } from '../../i18n.js';

interface StdinLike {
  isTTY?: boolean;
  on: (event: 'data', listener: (data: Buffer) => void) => void;
  removeListener: (event: 'data', listener: (data: Buffer) => void) => void;
}

interface UseRawTerminalInputOptions {
  stdin: StdinLike | undefined;
  setRawMode: ((enabled: boolean) => void) | undefined;
  onKey: (key: KeyLike) => void;
  onPaste: (content: string) => void;
  onNonTty: () => void;
  onMouseClick?: (event: MouseClickEvent) => void;
  onMouseWheel?: (direction: 'up' | 'down') => void;
  // When false, mouse tracking escape codes are not emitted, so the host
  // terminal performs its own native text selection (drag-select, copy).
  // Defaults to true (in-TUI selection + sidebar clicks + wheel scroll).
  mouseTrackingEnabled?: boolean;
}

const MOUSE_TRACKING_ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_TRACKING_DISABLE = '\x1b[?1002l\x1b[?1000l\x1b[?1006l';

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeRawKeypress(key: unknown): KeyLike {
  const record = key !== null && typeof key === 'object'
    ? key as Record<string, unknown>
    : {};
  return {
    name: readStringField(record, 'name'),
    sequence: readStringField(record, 'sequence'),
    ctrl: readBooleanField(record, 'ctrl'),
    meta: readBooleanField(record, 'meta'),
    shift: readBooleanField(record, 'shift'),
  };
}

export function useRawTerminalInput({
  stdin,
  setRawMode,
  onKey,
  onPaste,
  onNonTty,
  onMouseClick,
  onMouseWheel,
  mouseTrackingEnabled = true,
}: UseRawTerminalInputOptions): void {
  useEffect(() => {
    if (!stdin || !setRawMode) return;
    if (!stdin.isTTY) {
      console.error(t('tui.error.not_a_tty'));
      console.error(t('tui.error.not_a_tty_hint'));
      onNonTty();
      return;
    }

    setRawMode(true);
    // Enable bracketed paste mode
    process.stdout.write('\x1b[?2004h');
    // Enable mouse button + drag tracking (sidebar clicks and message selection)
    // ?1000h = report button press + release
    // ?1002h = report drag while a button is pressed
    // ?1006h = SGR extended format for coordinates
    // When mouse tracking is OFF, the host terminal keeps its native
    // drag-to-select + copy behaviour (Ctrl+Shift+C / right-click menu).
    if (mouseTrackingEnabled) {
      process.stdout.write(MOUSE_TRACKING_ENABLE);
    } else {
      process.stdout.write(MOUSE_TRACKING_DISABLE);
    }

    let pasteState = { isPaste: false, pasteBuffer: '' };
    let mouseBuffer = '';
    const MAX_MOUSE_BUFFER = 64;
    const keypressStream = new PassThrough();
    const rl = readline.createInterface({
      input: keypressStream,
      escapeCodeTimeout: 0,
    });
    readline.emitKeypressEvents(keypressStream, rl);

    keypressStream.on('keypress', (_ch: string | undefined, key: unknown) => {
      const normalizedKey = normalizeRawKeypress(key);
      if (normalizedKey.sequence === '\x1b[I' || normalizedKey.sequence === '\x1b[O') return;
      onKey(normalizedKey);
    });

    const onData = (data: Buffer) => {
      let text = mouseBuffer + data.toString('utf8');
      mouseBuffer = '';

      // Parse and emit wheel events
      while (text.length > 0) {
        const wheel = parseMouseWheelEventPrefix(text);
        if (!wheel) break;
        if (onMouseWheel) {
          onMouseWheel(wheel.event.direction === 'up' ? 'up' : 'down');
        }
        text = text.slice(wheel.consumedLength);
      }

      // Parse and emit pointer click/drag/release events
      let skippedClick = false;
      do {
        const clickResult = parseMouseClickEvent(text);
        if (clickResult) {
          if (onMouseClick) {
            onMouseClick(clickResult.event);
          }
          text = text.slice(clickResult.consumedLength);
          skippedClick = true;
        } else {
          break;
        }
      } while (text.length > 0);

      if (skippedClick && text.length === 0) return;
      if (text.length > 0 && isPotentialMouseWheelPrefix(text)) {
        if (text.length <= MAX_MOUSE_BUFFER) {
          mouseBuffer = text;
        }
        return;
      }
      if (text.length === 0) return;

      const routed = routeRawBracketedPasteChunk(pasteState, text);
      pasteState = routed.state;
      if (routed.pasteContent !== undefined) {
        onPaste(routed.pasteContent);
      }
      if (routed.keypressText) {
        keypressStream.write(routed.keypressText);
      }
    };

    stdin.on('data', onData);

    return () => {
      stdin.removeListener('data', onData);
      keypressStream.removeAllListeners('keypress');
      rl.close();
      // Disable bracketed paste + mouse tracking on cleanup
      process.stdout.write('\x1b[?2004l\x1b[?1002l\x1b[?1000l\x1b[?1006l');
      if (pasteState.isPaste && pasteState.pasteBuffer.length > 0) {
        onPaste(pasteState.pasteBuffer);
      }
      mouseBuffer = '';
    };
  }, [stdin, setRawMode, onKey, onPaste, onNonTty, onMouseClick, onMouseWheel, mouseTrackingEnabled]);
}
