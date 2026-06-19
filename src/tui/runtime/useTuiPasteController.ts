import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { normalizeTerminalPasteContent } from '../utils.js';
import type { SuggestionItem } from '../utils.js';

const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const LARGE_PASTE_LINE_THRESHOLD = 10;

interface UseTuiPasteControllerOptions {
  breakHistoryNavigation: () => void;
  inputBufferRef: React.MutableRefObject<string>;
  inputCursorRef: React.MutableRefObject<number>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  setInputCursor: Dispatch<SetStateAction<number>>;
  setSuggestionItems: Dispatch<SetStateAction<SuggestionItem[]>>;
  setSuggestionIndex: Dispatch<SetStateAction<number>>;
  maybeBuildSuggestions: (value: string) => { items: SuggestionItem[] };
  pasteTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
}

export function useTuiPasteController({
  breakHistoryNavigation,
  inputBufferRef,
  inputCursorRef,
  setInputBuffer,
  setInputCursor,
  setSuggestionItems,
  setSuggestionIndex,
  maybeBuildSuggestions,
  pasteTimeoutRef,
}: UseTuiPasteControllerOptions) {
  const [pendingPastes, setPendingPastes] = useState<Map<string, string>>(new Map());
  const activePlaceholderIds = useRef<Map<number, Set<number>>>(new Map());
  const [recentPasteTime, setRecentPasteTime] = useState<number | null>(null);
  const pendingPastesMapRef = useRef<Map<string, string>>(new Map());

  const nextLargePastePlaceholder = useCallback((charCount: number): string => {
    const activeIds = activePlaceholderIds.current.get(charCount) || new Set();
    let id = 1;
    while (activeIds.has(id)) id++;
    activeIds.add(id);
    activePlaceholderIds.current.set(charCount, activeIds);
    const base = `[Pasted Content ${charCount} chars]`;
    return id === 1 ? base : `${base} #${id}`;
  }, []);

  const freePlaceholderId = useCallback((charCount: number, id: number) => {
    const activeIds = activePlaceholderIds.current.get(charCount);
    if (activeIds) {
      activeIds.delete(id);
      if (activeIds.size === 0) activePlaceholderIds.current.delete(charCount);
    }
  }, []);

  const parsePlaceholder = useCallback((placeholder: string): { charCount: number; id: number } | null => {
    const match = placeholder.match(/^\[Pasted Content (\d+) chars\](?: #(\d+))?$/);
    if (!match) return null;
    return { charCount: parseInt(match[1], 10), id: match[2] ? parseInt(match[2], 10) : 1 };
  }, []);

  const handlePasteDirect = useCallback((content: string) => {
    breakHistoryNavigation();
    const normalizedContent = normalizeTerminalPasteContent(content);
    const charCount = [...normalizedContent].length;
    const lineCount = normalizedContent.split('\n').length;
    if (charCount > LARGE_PASTE_CHAR_THRESHOLD || lineCount > LARGE_PASTE_LINE_THRESHOLD) {
      setRecentPasteTime(Date.now());
      if (pasteTimeoutRef.current) clearTimeout(pasteTimeoutRef.current);
      pasteTimeoutRef.current = setTimeout(() => { setRecentPasteTime(null); pasteTimeoutRef.current = null; }, 500);
      const placeholder = nextLargePastePlaceholder(charCount);
      pendingPastesMapRef.current.set(placeholder, normalizedContent);
      setPendingPastes(prev => { const next = new Map(prev); next.set(placeholder, normalizedContent); return next; });
      const buffer = inputBufferRef.current;
      const cursor = inputCursorRef.current;
      const nextBuffer = buffer.slice(0, cursor) + placeholder + buffer.slice(cursor);
      const nextCursor = cursor + placeholder.length;
      inputBufferRef.current = nextBuffer;
      setInputBuffer(nextBuffer);
      setInputCursor(nextCursor);
      inputCursorRef.current = nextCursor;
      const suggestions = maybeBuildSuggestions(nextBuffer);
      setSuggestionItems(suggestions.items);
      setSuggestionIndex(0);
    } else {
      const buffer = inputBufferRef.current;
      const cursor = inputCursorRef.current;
      const nextBuffer = buffer.slice(0, cursor) + normalizedContent + buffer.slice(cursor);
      const nextCursor = cursor + normalizedContent.length;
      inputBufferRef.current = nextBuffer;
      setInputBuffer(nextBuffer);
      setInputCursor(nextCursor);
      inputCursorRef.current = nextCursor;
    }
  }, [
    breakHistoryNavigation,
    inputBufferRef,
    inputCursorRef,
    maybeBuildSuggestions,
    nextLargePastePlaceholder,
    pasteTimeoutRef,
    setInputBuffer,
    setInputCursor,
    setSuggestionIndex,
    setSuggestionItems,
  ]);

  return {
    pendingPastes,
    setPendingPastes,
    recentPasteTime,
    activePlaceholderIds,
    pendingPastesMapRef,
    parsePlaceholder,
    freePlaceholderId,
    handlePasteDirect,
  };
}
