export interface OoxmlTextReplaceResult {
  xml: string;
  count: number;
}

interface TextNodeSpan {
  index: number;
  open: string;
  text: string;
  start: number;
  end: number;
}

interface MatchSpan {
  start: number;
  end: number;
}

export function replaceTextAcrossOoxmlTextNodes(options: {
  xml: string;
  tagName: 'w:t' | 'a:t';
  find: string;
  replace: string;
  matchCase?: boolean;
}): OoxmlTextReplaceResult {
  const nodes = collectTextNodes(options.xml, options.tagName);
  if (nodes.length === 0) return { xml: options.xml, count: 0 };

  const fullText = nodes.map((node) => node.text).join('');
  const matches = findTextMatches(fullText, options.find, options.matchCase === true);
  if (matches.length === 0) return { xml: options.xml, count: 0 };

  const nextTexts = applyMatchesToNodeTexts(nodes, matches, options.replace);
  let index = 0;
  const tagPattern = tagRegex(options.tagName);
  const xml = options.xml.replace(tagPattern, (full, open: string, _inner: string, close: string) => {
    const text = nextTexts[index] ?? '';
    const nextOpen = preserveSpaceIfNeeded(open, text);
    index += 1;
    return `${nextOpen}${xmlEscape(text)}${close}`;
  });
  return { xml, count: matches.length };
}

function collectTextNodes(xml: string, tagName: 'w:t' | 'a:t'): TextNodeSpan[] {
  const nodes: TextNodeSpan[] = [];
  const re = tagRegex(tagName);
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const text = decodeXmlText(match[2] ?? '');
    const start = cursor;
    const end = start + text.length;
    nodes.push({ index: nodes.length, open: match[1], text, start, end });
    cursor = end;
  }
  return nodes;
}

function tagRegex(tagName: 'w:t' | 'a:t'): RegExp {
  const escaped = tagName.replace(':', '\\:');
  return new RegExp(`(<${escaped}\\b[^>]*>)([\\s\\S]*?)(<\\/${escaped}>)`, 'gi');
}

function findTextMatches(text: string, find: string, matchCase: boolean): MatchSpan[] {
  const haystack = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  const matches: MatchSpan[] = [];
  if (!needle) return matches;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    matches.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return matches;
}

function applyMatchesToNodeTexts(nodes: TextNodeSpan[], matches: MatchSpan[], replacement: string): string[] {
  const out = nodes.map(() => '');
  const cursor = nodes.map(() => 0);

  for (const match of matches) {
    const startNode = nodeIndexAt(nodes, match.start);
    const endNode = nodeIndexAt(nodes, match.end - 1);
    if (startNode < 0 || endNode < 0) continue;

    const startOffset = match.start - nodes[startNode].start;
    const endOffset = match.end - nodes[endNode].start;

    if (cursor[startNode] <= startOffset) {
      out[startNode] += nodes[startNode].text.slice(cursor[startNode], startOffset);
      out[startNode] += replacement;
    }

    if (startNode === endNode) {
      cursor[startNode] = Math.max(cursor[startNode], endOffset);
      continue;
    }

    cursor[startNode] = nodes[startNode].text.length;
    for (let index = startNode + 1; index < endNode; index++) {
      cursor[index] = nodes[index].text.length;
    }
    cursor[endNode] = Math.max(cursor[endNode], endOffset);
  }

  for (const node of nodes) {
    out[node.index] += node.text.slice(cursor[node.index]);
  }
  return out;
}

function nodeIndexAt(nodes: TextNodeSpan[], position: number): number {
  return nodes.findIndex((node) => position >= node.start && position < node.end);
}

function preserveSpaceIfNeeded(openTag: string, text: string): string {
  if (!/^\s|\s$/.test(text) || /\sxml:space=/i.test(openTag)) return openTag;
  return openTag.replace(/>$/, ' xml:space="preserve">');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
