/**
 * historyDB.ts — 对话历史 IndexedDB 持久化
 *
 * 存储结构：
 *   DB: lingxiao-history (v1)
 *   Store: messages
 *     key: [sessionId, messageId]  (复合键)
 *     value: PersistedMessage
 *   Store: sessions
 *     key: sessionId
 *     value: PersistedSessionMeta
 *
 * 容量策略：
 *   - 每个 session 最多保留 MAX_MESSAGES_PER_SESSION 条消息
 *   - 总 session 数超过 MAX_SESSIONS 时，删除最老的 session
 */

import type { Message } from '../stores/sessionStore';

const DB_NAME = 'lingxiao-history';
const DB_VERSION = 1;
const MAX_MESSAGES_PER_SESSION = 500;
const MAX_SESSIONS = 20;

export interface PersistedSessionMeta {
  sessionId: string;
  updatedAt: number;
  messageCount: number;
}

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: ['sessionId', 'id'] });
        store.createIndex('bySession', 'sessionId', { unique: false });
        store.createIndex('bySessionTimestamp', ['sessionId', 'timestamp'], { unique: false });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db!);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
): IDBTransaction {
  return db.transaction(stores, mode);
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存一批消息（同一 session） */
export async function saveMessages(sessionId: string, messages: Message[]): Promise<void> {
  if (!messages.length) return;
  try {
    const db = await openDB();
    const t = tx(db, ['messages', 'sessions'], 'readwrite');
    const msgStore = t.objectStore('messages');
    const sessionStore = t.objectStore('sessions');

    // 只保留最新 MAX_MESSAGES_PER_SESSION 条
    const toSave = messages.slice(-MAX_MESSAGES_PER_SESSION);
    for (const msg of toSave) {
      msgStore.put({ ...msg, sessionId });
    }
    sessionStore.put({
      sessionId,
      updatedAt: Date.now(),
      messageCount: toSave.length,
    } as PersistedSessionMeta);

    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });

    // 异步清理老旧 session（不阻塞当前写入）
    evictOldSessions().catch(() => {});
  } catch (e) {
    console.warn('[historyDB] saveMessages failed:', e);
  }
}

/** 追加单条消息（增量保存） */
export async function appendMessage(sessionId: string, msg: Message): Promise<void> {
  try {
    const db = await openDB();
    const t = tx(db, ['messages', 'sessions'], 'readwrite');
    t.objectStore('messages').put({ ...msg, sessionId });
    // 更新 session meta
    const smeta = t.objectStore('sessions');
    const existing = await promisifyRequest<PersistedSessionMeta | undefined>(
      smeta.get(sessionId),
    );
    smeta.put({
      sessionId,
      updatedAt: Date.now(),
      messageCount: (existing?.messageCount ?? 0) + 1,
    } as PersistedSessionMeta);
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.warn('[historyDB] appendMessage failed:', e);
  }
}

/** 更新单条消息（用于流式追加完成后的最终状态） */
export async function updateMessage(sessionId: string, msg: Message): Promise<void> {
  try {
    const db = await openDB();
    const t = tx(db, 'messages', 'readwrite');
    t.objectStore('messages').put({ ...msg, sessionId });
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.warn('[historyDB] updateMessage failed:', e);
  }
}

/** 读取指定 session 的所有消息，按 timestamp 升序 */
export async function loadMessages(sessionId: string): Promise<Message[]> {
  try {
    const db = await openDB();
    const t = tx(db, 'messages', 'readonly');
    const index = t.objectStore('messages').index('bySessionTimestamp');
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
    const rows = await promisifyRequest<Array<Message & { sessionId: string }>>(
      index.getAll(range),
    );
    return rows.map(({ sessionId: _sid, ...msg }) => msg as Message);
  } catch (e) {
    console.warn('[historyDB] loadMessages failed:', e);
    throw new Error(`Failed to load persisted messages for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 删除指定 session 的所有消息 */
export async function clearSession(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    const t = tx(db, ['messages', 'sessions'], 'readwrite');
    const msgStore = t.objectStore('messages');
    const index = msgStore.index('bySession');
    const keys = await promisifyRequest<IDBValidKey[]>(index.getAllKeys(sessionId));
    for (const key of keys) msgStore.delete(key);
    t.objectStore('sessions').delete(sessionId);
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.warn('[historyDB] clearSession failed:', e);
  }
}

/** 删除最老的 session 直到总数不超过 MAX_SESSIONS */
async function evictOldSessions(): Promise<void> {
  try {
    const db = await openDB();
    const t = tx(db, 'sessions', 'readonly');
    const metas = await promisifyRequest<PersistedSessionMeta[]>(
      t.objectStore('sessions').getAll(),
    );
    if (metas.length <= MAX_SESSIONS) return;
    metas.sort((a, b) => a.updatedAt - b.updatedAt);
    const toDelete = metas.slice(0, metas.length - MAX_SESSIONS);
    for (const meta of toDelete) {
      await clearSession(meta.sessionId);
    }
  } catch (e) {
    console.warn('[historyDB] evictOldSessions failed:', e);
  }
}
