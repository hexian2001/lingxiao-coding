import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { SuggestionKeyOptions } from './useSuggestionKeyHandler.js';
import { rebuildSuggestions } from './useSuggestionKeyHandler.js';
import type { KeyLike } from '../useTuiKeyController.js';

export interface InputKeyOptions {
  inputBufferRef: MutableRefObject<string>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  inputCursorRef: MutableRefObject<number>;
  setInputCursor: Dispatch<SetStateAction<number>>;
  pendingPastesMapRef: MutableRefObject<Map<string, string>>;
  setPendingPastes: Dispatch<SetStateAction<Map<string, string>>>;
  parsePlaceholder: (placeholder: string) => { charCount: number; id: number } | null;
  freePlaceholderId: (charCount: number, id: number) => void;
  breakHistoryNavigation: () => void;
  suggestionOpts: SuggestionKeyOptions;
}

/** Handle backspace key. Returns true if consumed. */
export function handleBackspaceKey(key: KeyLike, opts: InputKeyOptions): boolean {
  if (!(key.name === 'backspace' || key.sequence === '\x7f' || (key.ctrl && key.name === 'h'))) {
    return false;
  }

  const {
    inputBufferRef, setInputBuffer,
    inputCursorRef, setInputCursor,
    pendingPastesMapRef, setPendingPastes,
    parsePlaceholder, freePlaceholderId,
    breakHistoryNavigation, suggestionOpts,
  } = opts;

  breakHistoryNavigation();
  const buffer = inputBufferRef.current;
  const cursor = inputCursorRef.current;

  if (pendingPastesMapRef.current.size > 0 && buffer.length > 0 && cursor > 0) {
    for (const placeholder of pendingPastesMapRef.current.keys()) {
      const start = cursor - placeholder.length;
      if (start >= 0 && buffer.slice(start, cursor) === placeholder) {
        const nextBuffer = buffer.slice(0, start) + buffer.slice(cursor);
        inputBufferRef.current = nextBuffer;
        setInputBuffer(nextBuffer);
        setInputCursor(start);
        inputCursorRef.current = start;
        pendingPastesMapRef.current.delete(placeholder);
        setPendingPastes(prev => { const next = new Map(prev); next.delete(placeholder); return next; });
        const parsed = parsePlaceholder(placeholder);
        if (parsed) freePlaceholderId(parsed.charCount, parsed.id);
        rebuildSuggestions(nextBuffer, suggestionOpts);
        return true;
      }
    }
  }
  if (buffer.length > 0 && cursor > 0) {
    const nextBuffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
    const nextCursor = cursor - 1;
    inputBufferRef.current = nextBuffer;
    setInputBuffer(nextBuffer);
    setInputCursor(nextCursor);
    inputCursorRef.current = nextCursor;
    rebuildSuggestions(nextBuffer, suggestionOpts);
  }
  return true;
}

/** Handle delete key. Returns true if consumed. */
export function handleDeleteKey(key: KeyLike, opts: InputKeyOptions): boolean {
  if (key.name !== 'delete') return false;

  const { inputBufferRef, setInputBuffer, inputCursorRef, breakHistoryNavigation, suggestionOpts } = opts;
  breakHistoryNavigation();
  const buffer = inputBufferRef.current;
  const cursor = inputCursorRef.current;
  if (buffer.length > 0 && cursor < buffer.length) {
    const nextBuffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
    inputBufferRef.current = nextBuffer;
    setInputBuffer(nextBuffer);
    rebuildSuggestions(nextBuffer, suggestionOpts);
  }
  return true;
}

/** Handle Ctrl+U (kill line before cursor). Returns true if consumed. */
export function handleCtrlU(key: KeyLike, opts: InputKeyOptions): boolean {
  if (!(key.name === 'u' && key.ctrl)) return false;

  const { inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor, breakHistoryNavigation, suggestionOpts } = opts;
  breakHistoryNavigation();
  const cursor = inputCursorRef.current;
  const buffer = inputBufferRef.current;
  if (cursor > 0) {
    const nextBuffer = buffer.slice(cursor);
    inputBufferRef.current = nextBuffer;
    setInputBuffer(nextBuffer);
    setInputCursor(0);
    inputCursorRef.current = 0;
    rebuildSuggestions(nextBuffer, suggestionOpts);
  }
  return true;
}

/** Handle Ctrl+K (kill line after cursor). Returns true if consumed. */
export function handleCtrlK(key: KeyLike, opts: InputKeyOptions): boolean {
  if (!(key.name === 'k' && key.ctrl)) return false;

  const { inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor, breakHistoryNavigation, suggestionOpts } = opts;
  breakHistoryNavigation();
  const buffer = inputBufferRef.current;
  const cursor = inputCursorRef.current;
  if (cursor < buffer.length) {
    const nextBuffer = buffer.slice(0, cursor);
    inputBufferRef.current = nextBuffer;
    setInputBuffer(nextBuffer);
    setInputCursor(cursor);
    inputCursorRef.current = cursor;
    rebuildSuggestions(nextBuffer, suggestionOpts);
  }
  return true;
}

/** Handle Ctrl+W (delete word backward). Returns true if consumed. */
export function handleCtrlW(key: KeyLike, opts: InputKeyOptions): boolean {
  if (!(key.name === 'w' && key.ctrl)) return false;

  const { inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor, breakHistoryNavigation, suggestionOpts } = opts;
  breakHistoryNavigation();
  const buffer = inputBufferRef.current;
  const cursor = inputCursorRef.current;
  if (cursor > 0) {
    let wordStart = cursor - 1;
    while (wordStart > 0 && buffer[wordStart] === ' ') wordStart--;
    while (wordStart > 0 && buffer[wordStart - 1] !== ' ') wordStart--;
    const nextBuffer = buffer.slice(0, wordStart) + buffer.slice(cursor);
    inputBufferRef.current = nextBuffer;
    setInputBuffer(nextBuffer);
    setInputCursor(wordStart);
    inputCursorRef.current = wordStart;
    rebuildSuggestions(nextBuffer, suggestionOpts);
  }
  return true;
}

/** Handle Shift+Enter (insert newline). Returns true if consumed. */
export function handleShiftEnter(key: KeyLike, opts: InputKeyOptions): boolean {
  if (!((key.name === 'return' && (key.shift || key.ctrl)) || (key.name === 'enter' && key.shift))) {
    return false;
  }
  const { inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor, breakHistoryNavigation } = opts;
  breakHistoryNavigation();
  const buffer = inputBufferRef.current;
  const cursor = inputCursorRef.current;
  const nextBuffer = buffer.slice(0, cursor) + '\n' + buffer.slice(cursor);
  const nextCursor = cursor + 1;
  inputBufferRef.current = nextBuffer;
  setInputBuffer(nextBuffer);
  setInputCursor(nextCursor);
  inputCursorRef.current = nextCursor;
  return true;
}

/** Handle cursor movement (left/right without modals). Returns true if consumed. */
export function handleCursorMovement(key: KeyLike, opts: InputKeyOptions): boolean {
  const { inputBufferRef, inputCursorRef, setInputCursor } = opts;

  if (key.name === 'home') {
    setInputCursor(0);
    inputCursorRef.current = 0;
    return true;
  }
  if (key.name === 'end') {
    const nextCursor = inputBufferRef.current.length;
    setInputCursor(nextCursor);
    inputCursorRef.current = nextCursor;
    return true;
  }
  if (key.name === 'right' && !key.ctrl && !key.meta) {
    const cursor = inputCursorRef.current;
    const buffer = inputBufferRef.current;
    if (cursor < buffer.length) {
      const nextCursor = cursor + 1;
      setInputCursor(nextCursor);
      inputCursorRef.current = nextCursor;
    }
    return true;
  }
  if (key.name === 'left' && !key.ctrl && !key.meta) {
    const cursor = inputCursorRef.current;
    if (cursor > 0) {
      const nextCursor = cursor - 1;
      setInputCursor(nextCursor);
      inputCursorRef.current = nextCursor;
    }
    return true;
  }
  return false;
}

/** Handle character insertion. Returns true if consumed. */
export function handleCharInput(
  key: KeyLike,
  opts: InputKeyOptions,
  lastCtrlCAtRef: MutableRefObject<number>,
): boolean {
  if (key.ctrl || key.meta) return false;
  if (!(key.sequence && key.sequence.length === 1)) return false;

  const { inputBufferRef, setInputBuffer, inputCursorRef, setInputCursor, breakHistoryNavigation, suggestionOpts } = opts;
  lastCtrlCAtRef.current = 0;
  breakHistoryNavigation();
  const buffer = inputBufferRef.current;
  const cursor = inputCursorRef.current;
  const nextBuffer = buffer.slice(0, cursor) + key.sequence + buffer.slice(cursor);
  const nextCursor = cursor + key.sequence.length;
  inputBufferRef.current = nextBuffer;
  setInputBuffer(nextBuffer);
  setInputCursor(nextCursor);
  inputCursorRef.current = nextCursor;
  rebuildSuggestions(nextBuffer, suggestionOpts);
  return true;
}
