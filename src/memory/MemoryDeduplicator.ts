/**
 * MemoryDeduplicator — Post-merge algorithmic deduplication for DreamCommand.
 *
 * After the LLM merges MEMORY.md, this module performs algorithmic deduplication
 * to catch duplicates the LLM may have missed. Uses Jaccard text similarity
 * (token-level set overlap) as the primary method — no LLM calls, fully deterministic.
 *
 * Strategy:
 * 1. Split MEMORY.md into sections (by ## headers)
 * 2. For each pair of sections, compute Jaccard similarity on token sets
 * 3. If similarity exceeds threshold, merge the shorter section into the longer one
 * 4. Return deduplicated content
 */

import { coreLogger } from '../core/Log.js';

const DEFAULT_SIMILARITY_THRESHOLD = 0.65;
const DEFAULT_MIN_SECTION_LENGTH = 20;
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Tokenize text into a Set of lowercase tokens for Jaccard comparison. */
function tokenizeSet(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(TOKEN_RE), (m) => m[0].toLowerCase()));
}

/** Compute Jaccard similarity between two token sets: |A ∩ B| / |A ∪ B|. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

export interface DeduplicateOptions {
  /** Jaccard similarity threshold above which sections are considered duplicates. Default 0.65. */
  similarityThreshold?: number;
  /** Minimum section length (in characters) to be considered for dedup. */
  minSectionLength?: number;
}

export interface DeduplicateResult {
  /** Deduplicated content. */
  content: string;
  /** Number of duplicate sections removed. */
  duplicatesRemoved: number;
  /** Number of sections after dedup. */
  sectionsAfter: number;
  /** Number of sections before dedup. */
  sectionsBefore: number;
}

/** Split MEMORY.md content into sections by ## headers. */
function splitSections(content: string): string[] {
  const lines = content.split('\n');
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current.length > 0) {
        sections.push(current.join('\n'));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n'));
  }

  return sections.filter((s) => s.trim().length > 0);
}

/**
 * Deduplicate sections in MEMORY.md content using Jaccard text similarity.
 *
 * @param content The merged MEMORY.md content from DreamCommand LLM output.
 * @param options Deduplication options.
 * @returns Deduplicated content and statistics.
 */
export function deduplicateMemory(
  content: string,
  options: DeduplicateOptions = {},
): DeduplicateResult {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const minLen = options.minSectionLength ?? DEFAULT_MIN_SECTION_LENGTH;

  const sections = splitSections(content);
  const sectionsBefore = sections.length;

  if (sections.length <= 1) {
    return {
      content,
      duplicatesRemoved: 0,
      sectionsAfter: sections.length,
      sectionsBefore,
    };
  }

  // Precompute token sets for all sections
  const tokenSets = sections.map((s) => {
    if (s.length < minLen) return null;
    return tokenizeSet(s);
  });

  // Track which sections to keep (default: all)
  const keep = new Array(sections.length).fill(true);
  let duplicatesRemoved = 0;

  // Compare each pair of sections
  for (let i = 0; i < sections.length; i++) {
    if (!keep[i]) continue;
    if (tokenSets[i] === null) continue;

    for (let j = i + 1; j < sections.length; j++) {
      if (!keep[j]) continue;
      if (tokenSets[j] === null) continue;

      const similarity = jaccardSimilarity(tokenSets[i]!, tokenSets[j]!);

      if (similarity >= threshold) {
        // Keep the longer section, remove the shorter one
        if (sections[j].length <= sections[i].length) {
          keep[j] = false;
          duplicatesRemoved++;
          coreLogger.info(
            `[MemoryDeduplicator] Removed duplicate section ${j} (similarity=${similarity.toFixed(2)} with section ${i})`,
          );
        } else {
          keep[i] = false;
          duplicatesRemoved++;
          coreLogger.info(
            `[MemoryDeduplicator] Removed duplicate section ${i} (similarity=${similarity.toFixed(2)} with section ${j})`,
          );
          break; // Move to next i since we removed i
        }
      }
    }
  }

  const deduplicatedSections = sections.filter((_, idx) => keep[idx]);
  const result = deduplicatedSections.join('\n\n');

  return {
    content: result,
    duplicatesRemoved,
    sectionsAfter: deduplicatedSections.length,
    sectionsBefore,
  };
}
