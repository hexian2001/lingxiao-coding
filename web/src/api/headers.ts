/**
 * Server token helpers for API authentication.
 *
 * The server token is injected into the frontend HTML at startup:
 * `<script>window.__LINGXIAO_TOKEN__ = "...";</script>`
 *
 * Additionally, the token can be passed via `?token=XXX` in the URL
 * (e.g. when clicking the link from TUI output). On first load, the
 * URL param takes priority over the injected token.
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

// Read token from URL query param on first load — supplement the onSend-injected token
// Do NOT remove the token from the URL — doing so with hash-router SPAs can cause
// the page to navigate and lose the token before the SPA fully initializes.
(function initTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    window.__LINGXIAO_TOKEN__ = urlToken;
  }
})();

export function getServerToken(): string {
  return window.__LINGXIAO_TOKEN__ || '';
}

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'x-lingxiao-token': getServerToken(),
    ...extra,
  };
}
