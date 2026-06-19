export interface MessageViewportWindow<T> {
  messages: T[];
  scrollOffset: number;
  hiddenOlder: number;
  hiddenNewer: number;
}

export function clampMessageScrollOffset(offset: number, itemCount: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.min(Math.floor(offset), Math.max(0, itemCount - 1));
}

export function getMessageViewportWindow<T>(
  messages: readonly T[],
  options: {
    maxDisplay: number;
    scrollOffset: number;
  },
): MessageViewportWindow<T> {
  const maxDisplay = Math.max(0, Math.floor(options.maxDisplay));
  const scrollOffset = clampMessageScrollOffset(options.scrollOffset, messages.length);
  const endExclusive = Math.max(0, messages.length - scrollOffset);
  const startInclusive = maxDisplay > 0 ? Math.max(0, endExclusive - maxDisplay) : endExclusive;

  return {
    messages: messages.slice(startInclusive, endExclusive),
    scrollOffset,
    hiddenOlder: startInclusive,
    hiddenNewer: scrollOffset,
  };
}

export function resolveMessageLineScrollOffset(options: {
  previousOffset: number;
  previousTotalLines: number;
  totalLines: number;
  maxLines: number;
  previousTab: string;
  currentTab: string;
}): number {
  const maxOffset = Math.max(0, Math.floor(options.totalLines) - Math.max(0, Math.floor(options.maxLines)));
  if (options.previousTab !== options.currentTab) return 0;

  const previousOffset = Math.max(0, Math.floor(options.previousOffset));
  const addedLines = Math.max(0, Math.floor(options.totalLines) - Math.max(0, Math.floor(options.previousTotalLines)));
  const anchoredOffset = previousOffset > 0 ? previousOffset + addedLines : previousOffset;
  return Math.min(anchoredOffset, maxOffset);
}
