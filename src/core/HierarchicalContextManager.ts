import { contentToPlainText, type ChatMessage } from '../llm/types.js';

export type ContextTier = 'hot' | 'warm' | 'cold';

export interface HierarchicalContextOptions {
  maxMessages?: number;
  protectedCount?: number;
  hotRetentionMessages?: number;
  warmRetentionMessages?: number;
  currentFiles?: string[];
  activeErrors?: string[];
  /** 大输出判定阈值（按字符数）。仅在未配置 largeOutputBytes 时生效。 */
  largeOutputChars?: number;
  /** 大输出判定阈值（按 UTF-8 字节）。配置后优先于 largeOutputChars 生效。
   * 用于与 maxSingleMessageBytes（字节预算）保持单位一致——此前字节值被拿来和
   * text.length（UTF-16 码元）比较，中文/emoji 下大输出漏判。 */
  largeOutputBytes?: number;
  summaryChars?: number;
  maxManifestChars?: number;
}

export interface HierarchicalContextEntry {
  id: string;
  index: number;
  tier: ContextTier;
  role: ChatMessage['role'];
  text: string;
  charCount: number;
  protected: boolean;
  reasons: string[];
}

export interface HierarchicalContextBuildResult {
  messages: ChatMessage[];
  entries: HierarchicalContextEntry[];
  hotCount: number;
  warmCount: number;
  coldCount: number;
  demotedCount: number;
  largeOutputCount: number;
  manifest?: ChatMessage;
}

export interface HierarchicalRecallResult {
  id: string;
  tier: ContextTier;
  index: number;
  role: ChatMessage['role'];
  snippet: string;
  reasons: string[];
}

const DEFAULT_HOT_RETENTION_MESSAGES = 15;
const DEFAULT_WARM_RETENTION_MESSAGES = 24;
const DEFAULT_LARGE_OUTPUT_CHARS = 12_000;
const DEFAULT_SUMMARY_CHARS = 480;
const DEFAULT_MANIFEST_CHARS = 8_000;

export class HierarchicalContextManager {
  classify(messages: ChatMessage[], options: HierarchicalContextOptions = {}): HierarchicalContextEntry[] {
    const protectedCount = Math.max(0, options.protectedCount ?? 1);
    const hotRetention = Math.max(1, options.hotRetentionMessages ?? DEFAULT_HOT_RETENTION_MESSAGES);
    const warmRetention = Math.max(0, options.warmRetentionMessages ?? DEFAULT_WARM_RETENTION_MESSAGES);
    const hotStart = Math.max(protectedCount, messages.length - hotRetention);
    const warmStart = Math.max(protectedCount, hotStart - warmRetention);
    const currentFiles = this.normalizeSignals(options.currentFiles);
    const activeErrors = this.normalizeSignals(options.activeErrors);
    const lastToolIndex = this.findLastRoleIndex(messages, 'tool');

    return messages.map((message, index) => {
      const text = contentToPlainText(message.content);
      const reasons = new Set<string>();
      let tier: ContextTier = 'cold';
      const isProtected = index < protectedCount || message.role === 'system';

      if (isProtected) {
        tier = 'hot';
        reasons.add(index < protectedCount ? 'protected_prefix' : 'protected_system');
      }

      if (index >= hotStart) {
        tier = 'hot';
        reasons.add('recent_hot_window');
      } else if (!isProtected && index >= warmStart) {
        tier = 'warm';
        reasons.add('warm_window');
      }

      if (index === lastToolIndex) {
        tier = 'hot';
        reasons.add('latest_tool_result');
      }

      if (this.containsPathToken(text, currentFiles)) {
        tier = 'hot';
        reasons.add('current_file');
      }

      if (this.includesAny(text, activeErrors)) {
        tier = 'hot';
        reasons.add('active_error');
      }

      if (this.isLargeOutput(text, options)) {
        reasons.add('large_output');
      }

      return {
        id: `m${index}`,
        index,
        tier,
        role: message.role,
        text,
        charCount: text.length,
        protected: isProtected,
        reasons: [...reasons],
      };
    });
  }

  buildContext(messages: ChatMessage[], options: HierarchicalContextOptions = {}): HierarchicalContextBuildResult {
    if (messages.length === 0) {
      return {
        messages,
        entries: [],
        hotCount: 0,
        warmCount: 0,
        coldCount: 0,
        demotedCount: 0,
        largeOutputCount: 0,
      };
    }

    const maxMessages = Math.max(0, options.maxMessages ?? 0);
    const entries = this.classify(messages, options);
    const entryByIndex = new Map(entries.map((entry) => [entry.index, entry]));
    const protectedIndexes = new Set(entries.filter((entry) => entry.protected).map((entry) => entry.index));
    const hotIndexes = new Set(entries.filter((entry) => entry.tier === 'hot').map((entry) => entry.index));
    const demotedEntries = entries.filter((entry) => entry.tier !== 'hot');
    const signalEntries = entries.filter((entry) =>
      entry.tier === 'hot' &&
      !protectedIndexes.has(entry.index) &&
      (entry.reasons.includes('current_file') || entry.reasons.includes('active_error')) &&
      !this.isInRecentWindow(entry, entries, options)
    );
    const largeEntries = entries.filter((entry) => entry.reasons.includes('large_output'));

    const manifest = this.buildManifest([...demotedEntries, ...signalEntries], largeEntries, options);
    const selected = new Set<number>([...protectedIndexes, ...hotIndexes]);
    const output: ChatMessage[] = [];
    const emitted = new Set<number>();

    for (let index = 0; index < messages.length; index += 1) {
      if (!selected.has(index)) continue;
      const entry = entryByIndex.get(index);
      if (!entry) continue;
      output.push(this.rewriteLargeMessage(messages[index], entry, options));
      emitted.add(index);
      if (index === this.findLastProtectedIndex(entries) && manifest) {
        output.push(manifest);
      }
    }

    if (manifest && output.indexOf(manifest) < 0) {
      output.unshift(manifest);
    }

    let budgeted = this.enforceMessageBudget(output, maxMessages, options.protectedCount ?? 1);
    budgeted = this.dropInvalidLeadingToolMessages(budgeted);

    return {
      messages: budgeted,
      entries,
      hotCount: entries.filter((entry) => entry.tier === 'hot').length,
      warmCount: entries.filter((entry) => entry.tier === 'warm').length,
      coldCount: entries.filter((entry) => entry.tier === 'cold').length,
      demotedCount: entries.filter((entry) => !emitted.has(entry.index)).length,
      largeOutputCount: largeEntries.length,
      manifest,
    };
  }

  recall(
    messages: ChatMessage[],
    query: string,
    options: HierarchicalContextOptions & { maxResults?: number } = {},
  ): HierarchicalRecallResult[] {
    const needle = query.trim();
    if (!needle) return [];
    const maxResults = Math.max(1, options.maxResults ?? 10);
    return this.classify(messages, options)
      .filter((entry) => entry.text.includes(needle))
      .slice(0, maxResults)
      .map((entry) => ({
        id: entry.id,
        tier: entry.tier,
        index: entry.index,
        role: entry.role,
        snippet: this.snippet(entry.text, needle, options.summaryChars ?? DEFAULT_SUMMARY_CHARS),
        reasons: [...entry.reasons],
      }));
  }

  private buildManifest(
    entries: HierarchicalContextEntry[],
    largeEntries: HierarchicalContextEntry[],
    options: HierarchicalContextOptions,
  ): ChatMessage | undefined {
    if (entries.length === 0 && largeEntries.length === 0) return undefined;
    const summaryChars = Math.max(80, options.summaryChars ?? DEFAULT_SUMMARY_CHARS);
    const maxManifestChars = Math.max(500, options.maxManifestChars ?? DEFAULT_MANIFEST_CHARS);
    const unique = new Map<string, HierarchicalContextEntry>();
    for (const entry of entries) unique.set(entry.id, entry);
    for (const entry of largeEntries) unique.set(entry.id, entry);

    const warm = [...unique.values()].filter((entry) => entry.tier === 'warm');
    const cold = [...unique.values()].filter((entry) => entry.tier === 'cold');
    const signals = [...unique.values()].filter((entry) =>
      entry.reasons.includes('current_file') || entry.reasons.includes('active_error') || entry.reasons.includes('large_output')
    );

    const lines: string[] = [
      '[Hierarchical Context]',
      `hot: original protected/current/recent messages are kept outside this manifest`,
      `warm summarized: ${warm.length}`,
      `cold summarized: ${cold.length}`,
    ];

    this.appendSummaryLines(lines, 'current evidence', signals, summaryChars);
    this.appendSummaryLines(lines, 'warm tier', warm.slice(-12), summaryChars);
    this.appendSummaryLines(lines, 'cold tier', cold.slice(-8), summaryChars);

    const content = this.truncate(lines.join('\n'), maxManifestChars);
    return {
      role: 'system',
      content,
      timestamp: Date.now() / 1000,
    };
  }

  private appendSummaryLines(
    lines: string[],
    label: string,
    entries: HierarchicalContextEntry[],
    summaryChars: number,
  ): void {
    if (entries.length === 0) return;
    lines.push(`${label}:`);
    for (const entry of entries) {
      lines.push(`- ${entry.id} ${entry.role} ${entry.tier} [${entry.reasons.join(',') || 'none'}]: ${this.truncateSingleLine(entry.text, summaryChars)}`);
    }
  }

  /**
   * 大输出判定：配置了 largeOutputBytes 时按 UTF-8 字节比较（与 maxSingleMessageBytes 单位一致），
   * 否则回退到 largeOutputChars（字符数）。统一一个判定口径，供 classify 与 rewriteLargeMessage 复用。
   */
  private isLargeOutput(text: string, options: HierarchicalContextOptions): boolean {
    if (options.largeOutputBytes && options.largeOutputBytes > 0) {
      return Buffer.byteLength(text, 'utf8') > options.largeOutputBytes;
    }
    return text.length > (options.largeOutputChars ?? DEFAULT_LARGE_OUTPUT_CHARS);
  }

  private rewriteLargeMessage(
    message: ChatMessage,
    entry: HierarchicalContextEntry,
    options: HierarchicalContextOptions,
  ): ChatMessage {
    if (!this.isLargeOutput(entry.text, options)) return message;
    const summaryChars = Math.max(80, options.summaryChars ?? DEFAULT_SUMMARY_CHARS);
    const headTailChars = Math.max(80, Math.floor(summaryChars / 2));
    const content = [
      `[large output summarized: ${entry.charCount} chars, original role=${message.role}]`,
      entry.text.slice(0, headTailChars),
      '[...middle omitted by hierarchical context budget...]',
      entry.text.slice(-headTailChars),
    ].join('\n');
    return {
      ...message,
      content,
    };
  }

  private enforceMessageBudget(messages: ChatMessage[], maxMessages: number, protectedCount: number): ChatMessage[] {
    if (!maxMessages || messages.length <= maxMessages) return messages;
    const result = [...messages];
    while (result.length > maxMessages) {
      const safeProtectedCount = Math.min(Math.max(0, protectedCount), maxMessages);
      const removableIndex = result.findIndex((message, index) => index >= safeProtectedCount && message.role !== 'system');
      if (removableIndex < 0) break;
      result.splice(removableIndex, 1);
    }
    return result.slice(-maxMessages);
  }

  private dropInvalidLeadingToolMessages(messages: ChatMessage[]): ChatMessage[] {
    let start = 0;
    while (start < messages.length && messages[start].role === 'tool') {
      start += 1;
    }
    const withoutLeadingTools = start === 0 ? [...messages] : messages.slice(start);
    let contextStart = 0;
    while (contextStart < withoutLeadingTools.length && withoutLeadingTools[contextStart].role === 'system') {
      contextStart += 1;
    }
    while (contextStart < withoutLeadingTools.length && withoutLeadingTools[contextStart].role === 'tool') {
      withoutLeadingTools.splice(contextStart, 1);
    }
    return withoutLeadingTools;
  }

  private isInRecentWindow(
    entry: HierarchicalContextEntry,
    entries: HierarchicalContextEntry[],
    options: HierarchicalContextOptions,
  ): boolean {
    const protectedCount = Math.max(0, options.protectedCount ?? 1);
    const hotRetention = Math.max(1, options.hotRetentionMessages ?? DEFAULT_HOT_RETENTION_MESSAGES);
    const hotStart = Math.max(protectedCount, entries.length - hotRetention);
    return entry.index >= hotStart;
  }

  private findLastProtectedIndex(entries: HierarchicalContextEntry[]): number {
    let index = -1;
    for (const entry of entries) {
      if (entry.protected) index = entry.index;
    }
    return index;
  }

  private findLastRoleIndex(messages: ChatMessage[], role: ChatMessage['role']): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === role) return i;
    }
    return -1;
  }

  private normalizeSignals(values: string[] | undefined): string[] {
    return (values ?? []).map((value) => value.trim()).filter(Boolean);
  }

  private includesAny(text: string, needles: string[]): boolean {
    return needles.some((needle) => text.includes(needle));
  }

  /**
   * 路径引用检测（结构化 token 边界匹配）：currentFile 必须作为完整路径 token 出现才算命中。
   * 避免裸 `text.includes('src/a.ts')` 把 `src/a.tsx`、`src/a.ts.bak`、`src/a.ts.map` 误判为同一
   * 文件——这是 token 边界的确定性匹配，非关键词模糊匹配。错误文本（activeErrors）是自由短语，
   * 仍用 {@link includesAny} 子串匹配。
   *
   * token 边界天然处理 `src/a.ts:42`（行号）：`:42` 不是路径字符，被切分成独立 token，故
   * `src/a.ts` 本身就是完整 token 命中。
   */
  private containsPathToken(text: string, paths: string[]): boolean {
    if (paths.length === 0) return false;
    const candidates = text.match(/[A-Za-z0-9_./\\-]+/g);
    if (!candidates) return false;
    const tokenSet = new Set(candidates);
    return paths.some((raw) => {
      const path = raw.trim();
      return path.length > 0 && tokenSet.has(path);
    });
  }

  private snippet(text: string, needle: string, maxChars: number): string {
    const index = text.indexOf(needle);
    if (index < 0) return this.truncateSingleLine(text, maxChars);
    const half = Math.max(20, Math.floor(maxChars / 2));
    const start = Math.max(0, index - half);
    const end = Math.min(text.length, index + needle.length + half);
    return this.truncateSingleLine(text.slice(start, end), maxChars);
  }

  private truncateSingleLine(text: string, maxChars: number): string {
    return this.truncate(text.replace(/\s+/g, ' ').trim(), maxChars);
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    if (maxChars <= 20) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 15)}...[truncated]`;
  }
}

export default HierarchicalContextManager;
