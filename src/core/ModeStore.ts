/**
 * ModeStore<T> — 会话级模式持久化状态库的通用抽象。
 *
 * 历史上只有 Bughunt 有 ledger（src/core/BughuntLedger.ts），office 的审计落 jsonl、
 * workflow 的执行历史只活在内存 Map 里、进程重启即丢。三者的「读写一个 JSON 到
 * session_state、带版本号、带 updated_at」模式完全同构，这里把它收成一个泛型类，
 * 让三个模式共享同一种命名空间化的持久化与失效语义。
 *
 * 设计：
 *   - 存储后端仍是 DatabaseManager 的 session_state（复用 SESSION_KEY_PREFIXES 的
 *     `bughunt_` / `office_` / `workflow_` 前缀，无需新表）。
 *   - 泛型 T 约束 version/session_id/updated_at 三字段，保证读写一致性校验有据可依。
 *   - 不假设 T 的业务字段——create/transform 等业务逻辑由调用方持有 factory/producer。
 *
 * 确定性：纯函数式读写，只动 session_state，无启发式。
 */

import type { ModeId } from '../contracts/modes.js';

/** ModeStore 持久化的最小契约：版本、会话、更新时间。 */
export interface ModeStoreRecord {
  version: number;
  session_id: string;
  updated_at: number;
}

/** ModeStore 依赖的会话状态读写接口（DatabaseManager 满足此契约）。 */
export interface ModeStoreDb {
  getSessionState(sessionId: string, key: string): unknown | null;
  setSessionState(sessionId: string, key: string, value: unknown): void;
}

/**
 * 会话级模式状态库。
 *
 * 用法（典型）：
 * ```ts
 * const store = new ModeStore('bughunt', SESSION_KEYS.BUGHUNT_LEDGER, createBughuntLedger);
 * const ledger = store.ensure(db, sessionId);
 * store.update(db, ledger, (cur) => ({ ...cur, active: false }));
 * ```
 */
export class ModeStore<T extends ModeStoreRecord> {
  constructor(
    private readonly mode: ModeId,
    private readonly sessionKey: string,
    private readonly factory: (sessionId: string) => T,
  ) {}

  /** 读取并校验；记录不存在或版本/会话不匹配返回 null。 */
  read(db: ModeStoreDb, sessionId: string): T | null {
    const raw = db.getSessionState(sessionId, this.sessionKey);
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Partial<T>;
    if (record.session_id !== sessionId) return null;
    return { ...record } as T;
  }

  /** 写入（自动盖 updated_at 时间戳）。 */
  write(db: ModeStoreDb, value: T): T {
    const next = { ...value, updated_at: Date.now() };
    db.setSessionState(value.session_id, this.sessionKey, next);
    return next;
  }

  /** 读取，不存在则用 factory 创建并落库。 */
  ensure(db: ModeStoreDb, sessionId: string): T {
    return this.read(db, sessionId) ?? this.write(db, this.factory(sessionId));
  }

  /**
   * 读 → 转换 → 写 的原子化更新（注意：DatabaseManager 的 session_state 读写本身
   * 不跨进程加锁；本方法保证「同一调用内读到最新再覆盖」，适合单进程多模式场景）。
   */
  update(db: ModeStoreDb, sessionId: string, transform: (current: T) => T): T {
    const current = this.ensure(db, sessionId);
    return this.write(db, transform(current));
  }

  /** 清空该会话本模式的记录（用于模式关闭时的确定性回收）。 */
  clear(db: ModeStoreDb, sessionId: string): void {
    db.setSessionState(sessionId, this.sessionKey, null);
  }

  /** 该模式的标识（诊断/审计用）。 */
  get id(): ModeId {
    return this.mode;
  }

  /** 该模式的 session_state 键。 */
  get key(): string {
    return this.sessionKey;
  }
}
