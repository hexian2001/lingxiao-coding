import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config.js';
import { requireTokenInHeaderOnly } from '../core/HardeningPolicy.js';

const TOKEN_FILE = join(CONFIG_DIR, 'server-token');

/**
 * Server token authentication.
 *
 * Token is persisted to ~/.lingxiao/server-token and reused across restarts.
 * This allows:
 * - Daemon URL with token to work across sessions
 * - Frontend bookmark/URL sharing
 * - WebSocket/SSE connections with ?token= query param
 *
 * If the file doesn't exist, a new token is generated and saved.
 */
export class ServerAuth {
  readonly token: string;

  constructor() {
    this.token = ServerAuth.loadOrCreateToken();
  }

  private static loadOrCreateToken(): string {
    try {
      if (existsSync(TOKEN_FILE)) {
        const stored = readFileSync(TOKEN_FILE, 'utf-8').trim();
        if (stored && stored.length >= 32) return stored;
      }
    } catch (err: unknown) {
      // Token file exists but couldn't be read - log and regenerate
      console.error(`[ServerAuth] Failed to read token file ${TOKEN_FILE}:`, err instanceof Error ? err.message : err);
    }

    // Generate new token and persist
    const token = randomBytes(32).toString('hex');
    try {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(TOKEN_FILE, token, { encoding: 'utf-8', mode: 0o600 });
    } catch (err: unknown) {
      // Token generated in-memory but NOT persisted — next restart will get a different token.
      // This is a real problem: log prominently so operators can fix permissions.
      console.error(
        `[ServerAuth] WARN: token generated but failed to persist to ${TOKEN_FILE}. ` +
        `Clients using this token will lose access on daemon restart. Error:`,
        err instanceof Error ? err.message : err,
      );
    }
    return token;
  }

  /**
   * 常量时间比较 token，防时序侧信道（纯增强，无论是否加固）。
   * 长度不等直接返回 false（timingSafeEqual 要求等长 buffer）。
   */
  private tokenEquals(candidate: string): boolean {
    const a = Buffer.from(candidate, 'utf-8');
    const b = Buffer.from(this.token, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  /**
   * 读取已持久化的 server token（不生成新 token）。
   * 供 TUI 等非 server 进程使用——打开浏览器时拼接 ?token=。
   */
  static readToken(): string | undefined {
    try {
      if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf-8').trim() || undefined;
    } catch { /* file missing or unreadable */ }
    return undefined;
  }

  /**
   * Validate a request's server token.
   * Checks `x-lingxiao-token` header first, then `?token=` query param (for SSE/WebSocket/img).
   *
   * 加固模式（requireTokenInHeaderOnly）下只接受 header，拒绝 `?token=` query
   * （query token 会泄漏到日志 / 浏览器历史 / Referer）。默认关闭时保持现状（header + query 回退）。
   */
  validate(request: { headers: Record<string, string | string[] | undefined>; query?: unknown }): boolean {
    const headerToken = request.headers['x-lingxiao-token'];
    if (typeof headerToken === 'string' && this.tokenEquals(headerToken)) return true;

    // 加固模式：仅接受 header，跳过 ?token= query 回退。
    if (requireTokenInHeaderOnly()) return false;

    // Fallback for EventSource (<img>, WebSocket) that cannot set custom headers
    if (request.query && typeof request.query === 'object') {
      const query = request.query as Record<string, unknown>;
      const queryToken = query['token'];
      if (typeof queryToken === 'string' && this.tokenEquals(queryToken)) return true;
    }

    return false;
  }
}
