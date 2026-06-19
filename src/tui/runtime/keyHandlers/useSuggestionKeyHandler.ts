import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { applySuggestionToBuffer, type SuggestionItem } from '../../utils.js';

export interface SuggestionKeyOptions {
  suggestionItemsRef: MutableRefObject<SuggestionItem[]>;
  suggestionIndexRef: MutableRefObject<number>;
  setSuggestionIndex: Dispatch<SetStateAction<number>>;
  setSuggestionItems: Dispatch<SetStateAction<SuggestionItem[]>>;
  closeSuggestionsRef: MutableRefObject<() => void>;
  inputBufferRef: MutableRefObject<string>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  inputCursorRef: MutableRefObject<number>;
  setInputCursor: Dispatch<SetStateAction<number>>;
  maybeBuildSuggestions: (value: string) => { items: SuggestionItem[] };
}

/** Accept the current suggestion, applying it to the input buffer. Returns true if consumed. */
export function acceptSuggestion(opts: SuggestionKeyOptions): boolean {
  const {
    suggestionItemsRef,
    suggestionIndexRef,
    inputBufferRef,
    setInputBuffer,
    inputCursorRef,
    setInputCursor,
    closeSuggestionsRef,
  } = opts;

  if (suggestionItemsRef.current.length === 0) return false;

  const suggestion = suggestionItemsRef.current[suggestionIndexRef.current] || suggestionItemsRef.current[0];
  const name = suggestion.name;
  const nextBuffer = applySuggestionToBuffer(inputBufferRef.current, name);
  inputBufferRef.current = nextBuffer;
  setInputBuffer(nextBuffer);
  setInputCursor(nextBuffer.length);
  inputCursorRef.current = nextBuffer.length;
  closeSuggestionsRef.current();
  return true;
}

/** Navigate suggestion list up. Returns true if consumed. */
export function handleSuggestionUp(opts: SuggestionKeyOptions): boolean {
  if (opts.suggestionItemsRef.current.length === 0) return false;
  opts.setSuggestionIndex(prev => Math.max(0, prev - 1));
  return true;
}

/** Navigate suggestion list down. Returns true if consumed. */
export function handleSuggestionDown(opts: SuggestionKeyOptions): boolean {
  if (opts.suggestionItemsRef.current.length === 0) return false;
  opts.setSuggestionIndex(prev => Math.min(opts.suggestionItemsRef.current.length - 1, prev + 1));
  return true;
}

/** Dismiss suggestions on escape. Returns true if consumed. */
export function handleSuggestionEscape(opts: SuggestionKeyOptions): boolean {
  if (opts.suggestionItemsRef.current.length === 0) return false;
  opts.closeSuggestionsRef.current();
  return true;
}

/** Update suggestions after buffer changes. */
export function rebuildSuggestions(nextBuffer: string, opts: SuggestionKeyOptions): void {
  const suggestions = opts.maybeBuildSuggestions(nextBuffer);
  opts.setSuggestionItems(suggestions.items);
  opts.setSuggestionIndex(0);
}
