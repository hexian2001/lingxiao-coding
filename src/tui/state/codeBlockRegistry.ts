/**
 * Code Block Registry — tracks code blocks encountered during TUI rendering.
 *
 * Used for:
 * 1. Mapping visible code rows to their raw code block content
 * 2. Message selection/copy features that need code block metadata
 *
 * Registry is append-only per session; cleared on channel switch or session reset.
 * Max capacity prevents unbounded growth for very long sessions.
 */

export interface CodeBlockEntry {
  id: number;
  content: string;    // raw code text (no fence markers)
  lang: string | null;
  timestamp: number;
}

const MAX_REGISTRY_SIZE = 200;
let registry: CodeBlockEntry[] = [];
let nextId = 0;

/**
 * Register a code block during render. Returns the assigned ID.
 * Deduplicates consecutive identical blocks (re-renders of same content).
 */
export function registerCodeBlock(content: string, lang: string | null): number {
  // Deduplicate: if last entry has same content, skip
  const last = registry[registry.length - 1];
  if (last && last.content === content) {
    return last.id;
  }

  const id = nextId++;
  registry.push({ id, content, lang, timestamp: Date.now() });

  // Cap size — drop oldest
  if (registry.length > MAX_REGISTRY_SIZE) {
    registry = registry.slice(-MAX_REGISTRY_SIZE);
  }

  return id;
}

/** Get all registered code blocks (ordered oldest → newest). */
export function getCodeBlocks(): CodeBlockEntry[] {
  return registry;
}

/** Get the most recently registered code block. */
export function getLastCodeBlock(): CodeBlockEntry | undefined {
  return registry[registry.length - 1];
}

/** Get a specific code block by ID. */
export function getCodeBlockById(id: number): CodeBlockEntry | undefined {
  return registry.find(b => b.id === id);
}

/** Clear registry (on session reset or channel switch). */
export function clearCodeBlocks(): void {
  registry = [];
  nextId = 0;
}

/**
 * Parse markdown text and extract code blocks with their line positions.
 * Returns blocks with startLine/endLine (0-indexed visual line numbers).
 *
 * Used for click detection: given a visual line number, determine which
 * code block (if any) is at that position.
 */
export interface CodeBlockPosition {
  content: string;
  lang: string | null;
  /** Start line in the rendered output (0-indexed, includes fence line) */
  startLine: number;
  /** End line in the rendered output (0-indexed, includes closing fence) */
  endLine: number;
}

export function parseCodeBlockPositions(markdown: string, contentWidth: number): CodeBlockPosition[] {
  if (!markdown) return [];

  const lines = markdown.split('\n');
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *(\w*?) *$/;
  const results: CodeBlockPosition[] = [];

  let inCodeBlock = false;
  let blockStartLine = 0;
  let blockContent: string[] = [];
  let blockLang: string | null = null;
  let blockFence = '';
  let visualLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      if (
        fenceMatch &&
        fenceMatch[1]!.startsWith(blockFence[0]!) &&
        fenceMatch[1]!.length >= blockFence.length
      ) {
        // Closing fence
        results.push({
          content: blockContent.join('\n'),
          lang: blockLang,
          startLine: blockStartLine,
          endLine: visualLine,
        });
        inCodeBlock = false;
        blockContent = [];
        blockLang = null;
        blockFence = '';
      } else {
        blockContent.push(line);
      }
      visualLine++;
      continue;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    if (codeFenceMatch) {
      inCodeBlock = true;
      blockFence = codeFenceMatch[1]!;
      blockLang = codeFenceMatch[2] || null;
      blockStartLine = visualLine;
      blockContent = [];
      visualLine++;
      continue;
    }

    // Non-code lines: estimate visual lines (wrapping)
    if (contentWidth > 0 && line.length > contentWidth) {
      visualLine += Math.ceil(line.length / contentWidth);
    } else {
      visualLine++;
    }
  }

  // Unclosed code block at end (streaming)
  if (inCodeBlock && blockContent.length > 0) {
    results.push({
      content: blockContent.join('\n'),
      lang: blockLang,
      startLine: blockStartLine,
      endLine: visualLine,
    });
  }

  return results;
}
