import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { countTokens } from '../llm/token_counter.js';
import { MemoryService } from './MemoryService.js';
import type { MemorySearchResult } from './types.js';
import { generateEmbedding } from './MemoryEmbedding.js';

export type MemoryScope = 'project' | 'user';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  description: string;
  content: string;
  scope: MemoryScope;
  fileName: string;
  filePath: string;
  createdAt?: string;
  updatedAt?: string;
  /** P2: ISO 8601 duration (e.g., 'P30D') — entry expires createdAt + ttl */
  ttl?: string;
  /** P2: ISO 8601 datetime — entry expires at this absolute time */
  expiresAt?: string;
  /** P2: If set, this entry has been superseded by the named entry */
  supersededBy?: string;
}

export interface MemorySearchOptions {
  scopes?: MemoryScope[];
  maxResults?: number;
}

export interface MemoryIndexOptions {
  tokenBudget?: number;
  maxEntriesPerScope?: number;
  includeHints?: boolean;
}

export interface MemoryManagerOptions {
  userDir?: string;
  now?: () => Date;
}

const VALID_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const INDEX_FILE_NAME = 'MEMORY.md';
const DEFAULT_INDEX_TOKEN_BUDGET = 1_200;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 12;

function cleanOneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeName(name: string): string {
  const trimmed = name.trim().replace(/\.md$/i, '').replace(/\s+/g, '-');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Invalid memory name. Do not include paths.');
  }
  if (!VALID_NAME_RE.test(trimmed)) {
    throw new Error('Invalid memory name. Use letters, numbers, dots, underscores, or hyphens; do not include paths.');
  }
  return basename(trimmed);
}

function memoryFileName(name: string): string {
  return `${sanitizeName(name)}.md`;
}

function escapeFrontmatterValue(value: string): string {
  return cleanOneLine(value).replace(/---/g, '- - -');
}

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, '').trim();
}

export class MemoryManager {
  private workspace: string;
  private projectDir: string;
  private userDir: string;
  private now: () => Date;
  private ftsServices = new Map<MemoryScope, MemoryService>();

  constructor(workspace: string = process.cwd(), options: MemoryManagerOptions = {}) {
    this.workspace = resolve(workspace);
    this.projectDir = join(this.workspace, '.lingxiao', 'memory');
    this.userDir = options.userDir ? resolve(options.userDir) : join(homedir(), '.lingxiao', 'memory');
    this.now = options.now ?? (() => new Date());
  }

  saveMemory(
    name: string,
    type: MemoryType,
    description: string,
    content: string,
    scope: MemoryScope = 'project',
    options?: { ttl?: string; expiresAt?: string },
  ): MemoryEntry {
    const fileName = memoryFileName(name);
    const dir = this.scopeDir(scope);
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, fileName);
    const existing = existsSync(filePath) ? this.readMemory(name, scope) : null;
    const now = this.now().toISOString();
    const createdAt = existing?.createdAt || now;
    const entryName = sanitizeName(name);
    const body = [
      '---',
      `name: ${escapeFrontmatterValue(entryName)}`,
      `type: ${type}`,
      `description: ${escapeFrontmatterValue(description)}`,
      `scope: ${scope}`,
      `createdAt: ${createdAt}`,
      `updatedAt: ${now}`,
      ...(options?.ttl ? [`ttl: ${options.ttl}`] : []),
      ...(options?.expiresAt ? [`expiresAt: ${options.expiresAt}`] : []),
      '---',
      '',
      content.trim(),
      '',
    ].join('\n');

    writeFileSync(filePath, body, 'utf-8');
    const saved: MemoryEntry = {
      name: entryName,
      type,
      description: cleanOneLine(description),
      content: content.trim(),
      scope,
      fileName,
      filePath,
      createdAt,
      updatedAt: now,
      ...(options?.ttl ? { ttl: options.ttl } : {}),
      ...(options?.expiresAt ? { expiresAt: options.expiresAt } : {}),
    };
    this.writeIndex(scope);
    return saved;
  }

  readMemory(name: string, scope: MemoryScope = 'project'): MemoryEntry | null {
    const fileName = memoryFileName(name);
    const filePath = join(this.scopeDir(scope), fileName);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || sanitizeName(name),
      type: this.parseType(meta.type),
      description: meta.description || '',
      content: stripFrontmatter(raw),
      scope,
      fileName,
      filePath,
      createdAt: meta.createdAt || meta.created_at,
      updatedAt: meta.updatedAt || meta.updated_at || this.fileMtime(filePath),
    };
  }

  listMemories(scope: MemoryScope = 'project'): MemoryEntry[] {
    const dir = this.scopeDir(scope);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== INDEX_FILE_NAME)
      .map((entry) => this.readMemory(entry.name.slice(0, -3), scope))
      .filter((entry): entry is MemoryEntry => !!entry)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteMemory(name: string, scope: MemoryScope = 'project'): boolean {
    const filePath = join(this.scopeDir(scope), memoryFileName(name));
    if (!existsSync(filePath)) return false;
    rmSync(filePath, { force: true });
    this.writeIndex(scope);
    return true;
  }

  readMemoryAcrossScopes(name: string): MemoryEntry | null {
    return this.readMemory(name, 'project') || this.readMemory(name, 'user');
  }

  searchAndFormat(query: string, scope: MemoryScope = 'project', maxResults = 8): string {
    return this.formatSearchResults(query, this.search(query, { scopes: [scope], maxResults }), scope);
  }

  searchAllAndFormat(query: string, options: MemorySearchOptions = {}): string {
    return this.formatSearchResults(
      query,
      this.search(query, { scopes: ['project', 'user'], ...options }),
      'all',
    );
  }

  listAllMemories(): MemoryEntry[] {
    return [
      ...this.listMemories('project'),
      ...this.listMemories('user'),
    ].sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  }

  rebuildIndex(scope: MemoryScope): void {
    mkdirSync(this.scopeDir(scope), { recursive: true });
    this.writeIndex(scope);
  }

  /**
   * FTS-backed search. Falls back to in-memory scoring if FTS is not initialized.
   */
  searchFTS(query: string, maxResults = 8): MemorySearchResult[] {
    const service = this.getOrCreateFTSService('project');
    return service.search(query, { maxResults });
  }

  /**
   * P1: Hybrid search — combine FTS/BM25 with vector cosine similarity.
   * Requires embedding support to be enabled in config.
   * Falls back to pure FTS search if embedding generation fails.
   */
  async searchHybrid(
    query: string,
    maxResults = 8,
    weights?: { fts: number; vector: number },
  ): Promise<MemorySearchResult[]> {
    const service = this.getOrCreateFTSService('project');
    try {
      const queryEmbedding = await generateEmbedding(query);
      // Access the underlying FTS instance through the service
      const fts = (service as unknown as { fts?: { hybridSearch?: (q: string, v: number[], o: unknown, w: unknown) => MemorySearchResult[] } }).fts;
      if (fts?.hybridSearch) {
        return fts.hybridSearch(query, queryEmbedding.vector, { maxResults }, weights ?? { fts: 0.7, vector: 0.3 });
      }
    } catch {
      // Fall back to pure FTS if embedding fails
    }
    return service.search(query, { maxResults });
  }

  /**
   * Get the underlying MemoryService (lazy-initialized).
   */
  getMemoryService(): MemoryService {
    return this.getOrCreateFTSService('project');
  }

  private getOrCreateFTSService(scope: MemoryScope): MemoryService {
    let service = this.ftsServices.get(scope);
    if (!service) {
      // Each scope root gets its own index. project = workspace/.lingxiao/memory,
      // user = the user dir itself (it IS the root, not a workspace).
      service = new MemoryService({ memoryRoot: this.scopeDir(scope) });
      this.ftsServices.set(scope, service);
    }
    return service;
  }

  private search(query: string, options: MemorySearchOptions = {}): MemoryEntry[] {
    const scopes: MemoryScope[] = options.scopes && options.scopes.length > 0 ? options.scopes : ['project'];
    const maxResults = options.maxResults ?? 8;
    // FTS5/BM25 over the on-disk index — no in-memory keyword heuristic.
    // Reconcile-on-search keeps the index current with the filesystem.
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const scope of scopes) {
      const service = this.getOrCreateFTSService(scope);
      let hits: MemorySearchResult[];
      try {
        hits = service.search(query, { maxResults });
      } catch {
        continue;
      }
      for (const hit of hits) {
        const name = basename(hit.path).replace(/\.md$/i, '');
        const entry = this.readMemory(name, scope);
        if (entry) scored.push({ entry, score: hit.score });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, maxResults)
      .map((item) => item.entry);
  }

  private formatSearchResults(query: string, matches: MemoryEntry[], scope: MemoryScope | 'all'): string {
    if (matches.length === 0) {
      const label = scope === 'all' ? '长期' : scope === 'user' ? '用户级' : '项目级';
      return `未找到与 "${query}" 相关的${label}记忆。`;
    }

    return matches
      .map((entry) => [
        `## ${entry.name} (${entry.scope}/${entry.type})`,
        entry.description,
        '',
        `file: ${entry.filePath}`,
        '',
        entry.content.length > 900 ? `${entry.content.slice(0, 900)}...` : entry.content,
      ].join('\n'))
      .join('\n\n---\n\n');
  }

  getAllIndexContent(options: MemoryIndexOptions = {}): string {
    const tokenBudget = options.tokenBudget ?? DEFAULT_INDEX_TOKEN_BUDGET;
    const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
    const includeHints = options.includeHints !== false;
    const scopedEntries = (['project', 'user'] as const)
      .map((scope) => ({ scope, entries: this.listMemories(scope).slice(0, maxEntriesPerScope) }));
    if (scopedEntries.every((group) => group.entries.length === 0)) return '';

    const parts: string[] = [];
    let used = 0;

    if (includeHints) {
      const hint = [
        '长期记忆只注入索引；需要正文时调用 memory(action="load")。',
        '冲突时项目级记忆优先于用户级记忆。',
      ].join(' ');
      const hintCost = countTokens(hint);
      if (hintCost <= tokenBudget) {
        parts.push(hint);
        used += hintCost;
      }
    }

    for (const { scope, entries } of scopedEntries) {
      if (entries.length === 0) continue;

      const title = scope === 'project' ? '### 项目级记忆' : '### 用户级记忆';
      const lines: string[] = [];
      for (const entry of entries) {
        const line = `- [${entry.scope}/${entry.type}] ${entry.name}: ${entry.description}`;
        const cost = countTokens(`${title}\n${line}`);
        if (used + cost > tokenBudget) break;
        lines.push(line);
        used += cost;
      }
      if (lines.length > 0) parts.push(`${title}\n${lines.join('\n')}`);
    }

    return parts.join('\n\n');
  }

  private scopeDir(scope: MemoryScope): string {
    return scope === 'user' ? this.userDir : this.projectDir;
  }

  private parseType(type: string | undefined): MemoryType {
    if (type === 'user' || type === 'feedback' || type === 'project' || type === 'reference') return type;
    return 'reference';
  }

  private fileMtime(filePath: string): string | undefined {
    try {
      return statSync(filePath).mtime.toISOString();
    } catch {/* expected: resource not available */
      return undefined;
    }
  }

  private writeIndex(scope: MemoryScope): void {
    const dir = this.scopeDir(scope);
    mkdirSync(dir, { recursive: true });
    const lines = ['# Memory Index', ''];
    for (const entry of this.listMemories(scope)) {
      lines.push(`- [${entry.name}](${entry.fileName}) - [${entry.type}] ${entry.description}`);
    }
    lines.push('');
    writeFileSync(join(dir, INDEX_FILE_NAME), lines.join('\n'), 'utf-8');
  }
}
