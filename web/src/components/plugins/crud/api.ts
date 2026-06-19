import { getServerToken } from '../../../api/headers';

/**
 * Shared REST helper for the plugins CRUD family (skills / commands / agents).
 * Mirrors the per-file `apiFetch` that ToolsTab / SkillsTab / PluginsView each
 * duplicated — extracted here so new management tabs share one implementation.
 */
export async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'x-lingxiao-token': getServerToken(),
      ...(opts?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
  return body as T;
}
