/**
 * Server token helpers for API authentication.
 *
 * Token 优先级链（高→低）：
 * 1. URL ?token= 参数（首次启动由 CLI 拼接）
 * 2. onSend 注入的 window.__LINGXIAO_TOKEN__（服务端 HTML 注入）
 * 3. localStorage 持久化（关页面后恢复）
 *
 * 若三者皆无，尝试从 localhost-only 端点 /api/v1/auth/local-token 自动获取。
 * 这样用户关掉网页重新打开 http://localhost:PORT 也能无感恢复，不会 401。
 *
 * All API requests must include this token via:
 * - `x-lingxiao-token` header (for fetch calls)
 * - `?token=` query param (for SSE/WebSocket/<img> that cannot set headers)
 */

declare global {
  interface Window {
    __LINGXIAO_TOKEN__?: string;
  }
}

const STORAGE_KEY = 'lingxiao_server_token';

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // localStorage 不可用时静默降级
  }
}

/**
 * 初始化 token：URL ?token= > window 注入 > localStorage
 * 有值时同步写入 localStorage 持久化。
 */
(function initToken() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    // URL token 优先级最高（CLI 启动拼接的）
    window.__LINGXIAO_TOKEN__ = urlToken;
    writeStoredToken(urlToken);
  } else if (window.__LINGXIAO_TOKEN__) {
    // 服务端 onSend 注入的
    writeStoredToken(window.__LINGXIAO_TOKEN__);
  } else {
    // 关页面重新打开：从 localStorage 恢复
    const stored = readStoredToken();
    if (stored) {
      window.__LINGXIAO_TOKEN__ = stored;
    }
  }
})();

export function getServerToken(): string {
  return window.__LINGXIAO_TOKEN__ || '';
}

export function setServerToken(token: string): void {
  window.__LINGXIAO_TOKEN__ = token;
  if (token) writeStoredToken(token);
}

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'x-lingxiao-token': getServerToken(),
    ...extra,
  };
}

/**
 * 尝试从 localhost-only 端点获取 token（本地私有化场景）。
 * 成功后写入 window + localStorage，后续请求即可正常携带。
 */
export async function tryRecoverToken(): Promise<boolean> {
  if (getServerToken()) return true;

  try {
    const res = await fetch('/api/v1/auth/local-token');
    if (!res.ok) return false;
    const data = await res.json();
    if (data.token) {
      setServerToken(data.token);
      return true;
    }
  } catch {
    // 网络错误或端点不存在，静默失败
  }
  return false;
}
