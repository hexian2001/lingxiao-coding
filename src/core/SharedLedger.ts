/**
 * SharedLedger — 会话级共享账本
 *
 * 替代 BlackboardGraph 的轻量共享状态。核心概念：
 * - append-only 类型化条目列表
 * - 按 type + surface 索引
 * - supersedes 机制处理更新（旧条目不删，新条目标记替代）
 * - Leader 注入策略：constraint/decision 永不裁剪；finding/contract 按需查询
 *
 * 四个痛点对应：
 * 1. 跨 worker 共享：worker 启动注入相关条目 + 运行中 read_ledger 查询
 * 2. 长会话防遗忘：constraint + decision 在 compaction 时保留
 * 3. 契约对齐：type=contract 按 surface 索引，前后端 worker 看同一份
 * 4. 进度可审计：每条有 author + evidence + timestamp
 */

export type LedgerEntryType = 'decision' | 'contract' | 'finding' | 'constraint';

export interface LedgerEntry {
  /** 自增 ID: L-1, L-2, ... */
  id: string;
  /** 条目类型 */
  type: LedgerEntryType;
  /** 稳定索引键，如 "POST /api/users" 或 "tech-stack" 或 "db-schema" */
  surface: string;
  /** 写入者: "leader" | worker name */
  author: string;
  /** 正文 (markdown) */
  content: string;
  /** 证据引用: 文件路径、task_id、URL */
  evidence?: string[];
  /** 如果更新了旧条目，指向被替代的 id */
  supersedes?: string;
  /** 创建时间 */
  createdAt: number;
}

export interface LedgerQuery {
  type?: LedgerEntryType | LedgerEntryType[];
  surface?: string;
  author?: string;
  /** 只返回最新版本（supersedes 链的头部） */
  latestOnly?: boolean;
  limit?: number;
}

export interface LedgerSnapshot {
  entries: LedgerEntry[];
  version: number;
}

export class SharedLedger {
  private entries: LedgerEntry[] = [];
  private nextId = 1;
  private version = 0;

  /**
   * 追加条目。返回新条目 ID。
   */
  append(input: Omit<LedgerEntry, 'id' | 'createdAt'>): string {
    const id = `L-${this.nextId++}`;
    const entry: LedgerEntry = {
      ...input,
      id,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    this.version++;
    return id;
  }

  /**
   * 更新条目（追加新版本，标记 supersedes 旧版本）。
   */
  update(surface: string, type: LedgerEntryType, input: { author: string; content: string; evidence?: string[] }): string {
    const existing = this.getLatestBySurface(surface, type);
    const id = this.append({
      type,
      surface,
      author: input.author,
      content: input.content,
      evidence: input.evidence,
      supersedes: existing?.id,
    });
    return id;
  }

  /**
   * 查询条目
   */
  query(q: LedgerQuery = {}): LedgerEntry[] {
    let results = [...this.entries];

    if (q.type) {
      const types = Array.isArray(q.type) ? q.type : [q.type];
      results = results.filter(e => types.includes(e.type));
    }
    if (q.surface) {
      const surf = q.surface.toLowerCase();
      results = results.filter(e => e.surface.toLowerCase() === surf);
    }
    if (q.author) {
      results = results.filter(e => e.author === q.author);
    }
    if (q.latestOnly) {
      results = this.filterLatest(results);
    }
    if (q.limit && q.limit > 0) {
      results = results.slice(-q.limit);
    }
    return results;
  }

  /**
   * 获取所有 constraint + decision（用于 Leader compaction-safe slot）
   */
  getCompactionSafeEntries(): LedgerEntry[] {
    return this.filterLatest(
      this.entries.filter(e => e.type === 'constraint' || e.type === 'decision')
    );
  }

  /**
   * 获取按 surface 最新版本的 contract 条目（用于 worker 启动注入）
   */
  getActiveContracts(): LedgerEntry[] {
    return this.filterLatest(
      this.entries.filter(e => e.type === 'contract')
    );
  }

  /**
   * 获取与指定 surfaces 相关的所有最新条目（用于 worker context 注入）
   */
  getRelevantEntries(surfaces: string[]): LedgerEntry[] {
    if (surfaces.length === 0) return [];
    const normalized = new Set(surfaces.map(s => s.toLowerCase()));
    return this.filterLatest(
      this.entries.filter(e => normalized.has(e.surface.toLowerCase()))
    );
  }

  /**
   * 格式化为 markdown（注入 LLM context 用）
   */
  formatForContext(entries: LedgerEntry[]): string {
    if (entries.length === 0) return '';
    const lines: string[] = ['## Shared Ledger'];
    for (const e of entries) {
      lines.push(`### [${e.type}] ${e.surface} (${e.id}, by ${e.author})`);
      lines.push(e.content);
      if (e.evidence && e.evidence.length > 0) {
        lines.push(`_evidence: ${e.evidence.join(', ')}_`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 导出快照（用于持久化） */
  snapshot(): LedgerSnapshot {
    return { entries: [...this.entries], version: this.version };
  }

  /** 从快照恢复 */
  restore(snapshot: LedgerSnapshot): void {
    this.entries = [...snapshot.entries];
    this.version = snapshot.version;
    this.nextId = this.entries.length > 0
      ? Math.max(...this.entries.map(e => parseInt(e.id.replace('L-', ''), 10))) + 1
      : 1;
  }

  get size(): number { return this.entries.length; }
  get currentVersion(): number { return this.version; }

  /**
   * 获取某 surface + type 的最新条目
   */
  private getLatestBySurface(surface: string, type: LedgerEntryType): LedgerEntry | undefined {
    const surf = surface.toLowerCase();
    const candidates = this.entries.filter(
      e => e.type === type && e.surface.toLowerCase() === surf
    );
    return this.filterLatest(candidates)[0];
  }

  /**
   * 过滤出每个 surface+type 的最新版本（排除被 supersedes 的旧条目）
   */
  private filterLatest(entries: LedgerEntry[]): LedgerEntry[] {
    const superseded = new Set<string>();
    for (const e of entries) {
      if (e.supersedes) superseded.add(e.supersedes);
    }
    return entries.filter(e => !superseded.has(e.id));
  }
}
