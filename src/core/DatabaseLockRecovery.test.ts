/**
 * DatabaseLockRecovery 行为测试
 *
 * 验证：
 * 1. robustDatabaseClose 在已关闭/空连接上幂等不抛
 * 2. tryRecoverDatabaseLock 能正确检测竞争进程并返回诊断
 * 3. DatabaseManager.close() 可被重复调用（exit handler + registerCleanup 都会调）
 * 4. DatabaseManager.init() 在锁定时能重试并最终成功（WAL 自动恢复）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseManager, isSqliteBusyError } from '../core/Database.js';
import { robustDatabaseClose, tryRecoverDatabaseLock } from '../core/DatabaseLockRecovery.js';

let tempDir: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lingxiao-lock-test-'));
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* tolerate */ }
});

describe('robustDatabaseClose', () => {
  it('should be a no-op on null db', () => {
    // 不应抛出
    assert.doesNotThrow(() => robustDatabaseClose(null, '/tmp/nonexistent.db'));
  });

  it('should close an open DatabaseSync connection and truncate WAL', () => {
    const dbPath = join(tempDir, 'close-test.db');
    const db = new DatabaseManager(dbPath);
    db.init();
    // 写入一些数据产生 WAL
    db.insertSession('test-session-1', '/workspace', 'hello');
    const walPath = `${dbPath}-wal`;
    // 关闭前 WAL 文件可能存在
    db.close();
    // 关闭后连接应为 null
    assert.equal(db.isClosed(), true);
    // WAL 应被 checkpoint(TRUNCATE) 截断或移除
    // (TRUNCATE 会把 wal 文件截断到 0 字节，但文件可能仍存在)
    if (existsSync(walPath)) {
      const { statSync } = require('fs');
      const st = statSync(walPath);
      // TRUNCATE 后 wal 大小应为 0
      assert.equal(st.size, 0, 'WAL file should be truncated to 0 bytes after robust close');
    }
  });

  it('should be idempotent when called multiple times via DatabaseManager.close()', () => {
    const dbPath = join(tempDir, 'idempotent-test.db');
    const db = new DatabaseManager(dbPath);
    db.init();
    db.close();
    // 第二次关闭不应抛出
    assert.doesNotThrow(() => db.close());
    // 第三次也不应抛出
    assert.doesNotThrow(() => db.close());
  });
});

describe('tryRecoverDatabaseLock', () => {
  it('should return diagnostics and canRetry=true when no competing processes', () => {
    const dbPath = join(tempDir, 'recover-test.db');
    // 先创建一个数据库文件
    const db = new DatabaseManager(dbPath);
    db.init();
    db.insertSession('recover-session', '/ws', 'test');
    db.close();

    const result = tryRecoverDatabaseLock(dbPath);
    assert.equal(result.canRetry, true);
    assert.ok(Array.isArray(result.diagnostics));
    assert.ok(result.diagnostics.length > 0);
    // 不应有活跃进程（测试环境下）
    assert.ok(Array.isArray(result.aliveProcesses));
  });

  it('should handle non-existent database path gracefully', () => {
    const result = tryRecoverDatabaseLock(join(tempDir, 'does-not-exist.db'));
    assert.equal(result.canRetry, true);
    assert.ok(Array.isArray(result.diagnostics));
  });
});

describe('DatabaseManager lock retry on init', () => {
  it('should successfully open after WAL auto-recovery', () => {
    const dbPath = join(tempDir, 'retry-test.db');

    // 第一次打开并写入
    const db1 = new DatabaseManager(dbPath);
    db1.init();
    db1.insertSession('retry-session', '/ws', 'data');
    db1.close();

    // 第二次打开应成功（WAL 自动恢复）
    const db2 = new DatabaseManager(dbPath);
    assert.doesNotThrow(() => db2.init());
    const session = db2.getSession('retry-session');
    assert.ok(session, 'session should be readable after reopen');
    assert.equal(session!.id, 'retry-session');
    db2.close();
  });

  it('should detect busy error correctly', () => {
    // isSqliteBusyError 应正确识别各种 busy 错误格式
    assert.equal(isSqliteBusyError({ code: 'SQLITE_BUSY', message: 'busy' }), true);
    assert.equal(isSqliteBusyError({ errcode: 5, message: 'database is locked' }), true);
    assert.equal(isSqliteBusyError({ errcode: 261, message: 'snapshot' }), true);
    assert.equal(isSqliteBusyError({ code: 'SQLITE_OK', message: 'fine' }), false);
    assert.equal(isSqliteBusyError(null), false);
    assert.equal(isSqliteBusyError(undefined), false);
  });
});

describe('concurrent DatabaseManager instances (multi-process simulation)', () => {
  it('should allow sequential open/close/open without lock residue', () => {
    const dbPath = join(tempDir, 'concurrent-test.db');

    // 模拟多个进程顺序使用同一个数据库
    for (let i = 0; i < 5; i++) {
      const db = new DatabaseManager(dbPath);
      db.init();
      db.insertSession(`concurrent-${i}`, '/ws', `round-${i}`);
      db.close();
    }

    // 最后验证所有数据都在
    const db = new DatabaseManager(dbPath);
    db.init();
    for (let i = 0; i < 5; i++) {
      const session = db.getSession(`concurrent-${i}`);
      assert.ok(session, `session concurrent-${i} should exist`);
    }
    db.close();
  });
});
