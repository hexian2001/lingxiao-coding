export interface ThinkStreamingSplit {
  text: string;
  thinking: string;
  segments: Array<{ type: 'text' | 'thinking'; text: string }>;
  inThinking: boolean;
  pendingTag: string;
  sawThinkTag: boolean;
}

export interface ThinkContentSplit {
  cleaned: string;
  reasoning?: string;
  sawThinkTag: boolean;
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

function findTagIndex(value: string, tag: string): number {
  return value.toLowerCase().indexOf(tag);
}

function longestTagPrefixAtSuffix(value: string, tag: string): number {
  const lower = value.toLowerCase();
  for (let length = Math.min(tag.length - 1, lower.length); length > 0; length--) {
    if (lower.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

function appendSegment(segments: ThinkStreamingSplit['segments'], type: 'text' | 'thinking', text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.type === type) {
    last.text += text;
  } else {
    segments.push({ type, text });
  }
}

export function splitThinkStreamingChunk(
  chunk: string,
  startsInThinking = false,
  pendingTag = '',
): ThinkStreamingSplit {
  let rest = `${pendingTag || ''}${String(chunk || '')}`;
  let inThinking = startsInThinking;
  let sawThinkTag = false;
  let text = '';
  let thinking = '';
  const segments: ThinkStreamingSplit['segments'] = [];
  let nextPendingTag = '';

  while (rest) {
    const targetTag = inThinking ? CLOSE_TAG : OPEN_TAG;
    if (inThinking) {
      const closeIndex = findTagIndex(rest, CLOSE_TAG);
      if (closeIndex < 0) {
        const pendingLength = longestTagPrefixAtSuffix(rest, CLOSE_TAG);
        if (pendingLength > 0) {
          const value = rest.slice(0, -pendingLength);
          thinking += value;
          appendSegment(segments, 'thinking', value);
          nextPendingTag = rest.slice(-pendingLength);
        } else {
          thinking += rest;
          appendSegment(segments, 'thinking', rest);
        }
        rest = '';
        break;
      }
      sawThinkTag = true;
      const value = rest.slice(0, closeIndex);
      thinking += value;
      appendSegment(segments, 'thinking', value);
      rest = rest.slice(closeIndex + CLOSE_TAG.length);
      inThinking = false;
      continue;
    }

    const openIndex = findTagIndex(rest, OPEN_TAG);
    if (openIndex < 0) {
      const pendingLength = longestTagPrefixAtSuffix(rest, targetTag);
      if (pendingLength > 0) {
        const value = rest.slice(0, -pendingLength);
        text += value;
        appendSegment(segments, 'text', value);
        nextPendingTag = rest.slice(-pendingLength);
      } else {
        text += rest;
        appendSegment(segments, 'text', rest);
      }
      rest = '';
      break;
    }
    sawThinkTag = true;
    const value = rest.slice(0, openIndex);
    text += value;
    appendSegment(segments, 'text', value);
    rest = rest.slice(openIndex + OPEN_TAG.length);
    inThinking = true;
  }

  return { text, thinking, segments, inThinking, pendingTag: nextPendingTag, sawThinkTag };
}

export function splitThinkContent(content: string): ThinkContentSplit {
  const raw = String(content || '');
  const split = splitThinkStreamingChunk(raw, false);
  if (!split.sawThinkTag && !split.inThinking && !split.thinking) {
    return { cleaned: raw, sawThinkTag: false };
  }
  const cleaned = split.text.trim();
  const reasoning = split.thinking.trim();
  return {
    cleaned,
    reasoning: reasoning || undefined,
    sawThinkTag: split.sawThinkTag,
  };
}
