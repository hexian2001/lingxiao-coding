import fetchWithAgent from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';
import { config } from '../config.js';

export type ProxyScope = 'llm' | 'tools';

export interface RuntimeProxyConfig {
  protocol?: 'http' | 'socks5';
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  no_proxy?: string;
  url?: string;
  llm_enabled?: boolean;
  tools_enabled?: boolean;
}

type AgentCacheEntry = {
  proxyUrl: string;
  fetch: typeof fetch;
  agent: ProxyAgent;
};

const scopedFetchCache: Partial<Record<ProxyScope, AgentCacheEntry>> = {};

function getRuntimeProxyConfig(): RuntimeProxyConfig {
  return ((config as unknown as { network?: { proxy?: RuntimeProxyConfig } }).network?.proxy || {}) as RuntimeProxyConfig;
}

function isScopeEnabled(cfg: RuntimeProxyConfig, scope: ProxyScope): boolean {
  return scope === 'llm' ? cfg.llm_enabled === true : cfg.tools_enabled === true;
}

function buildUrlFromParts(cfg: RuntimeProxyConfig): string | null {
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port || 0);
  if (!host || !Number.isFinite(port) || port <= 0) return null;

  const protocol = cfg.protocol === 'socks5' ? 'socks5' : 'http';
  const url = new URL(`${protocol}://${host}:${port}`);
  const username = String(cfg.username || '').trim();
  const password = String(cfg.password || '');
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
}

export function getConfiguredProxyUrl(scope: ProxyScope): string | null {
  const cfg = getRuntimeProxyConfig();
  if (!isScopeEnabled(cfg, scope)) return null;

  const explicitUrl = String(cfg.url || '').trim();
  const rawUrl = explicitUrl || buildUrlFromParts(cfg);
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    if (!['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

export function isConfiguredProxyEnabled(scope: ProxyScope): boolean {
  return getConfiguredProxyUrl(scope) !== null;
}

export function getConfiguredNoProxy(): string {
  return String(getRuntimeProxyConfig().no_proxy || '').trim();
}

export function buildToolProxyEnv(): NodeJS.ProcessEnv {
  const proxyUrl = getConfiguredProxyUrl('tools');
  if (!proxyUrl) return {};

  const noProxy = getConfiguredNoProxy();
  const env: NodeJS.ProcessEnv = {
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
  };
  if (noProxy) {
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

export function withToolProxyEnv<T extends NodeJS.ProcessEnv | Record<string, string | undefined>>(env: T): T {
  const proxyEnv = buildToolProxyEnv();
  if (Object.keys(proxyEnv).length === 0) return env;
  return { ...env, ...proxyEnv } as T;
}

export function getScopedProxyFetch(scope: ProxyScope): typeof fetch | undefined {
  const proxyUrl = getConfiguredProxyUrl(scope);
  if (!proxyUrl) return undefined;

  const cached = scopedFetchCache[scope];
  if (cached?.proxyUrl === proxyUrl) return cached.fetch;

  const agent = new ProxyAgent({
    getProxyForUrl: () => proxyUrl,
  });
  const scopedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return fetchWithAgent(input as Parameters<typeof fetchWithAgent>[0], {
      ...(init as Parameters<typeof fetchWithAgent>[1]),
      agent,
    });
  }) as unknown as typeof fetch;

  scopedFetchCache[scope] = { proxyUrl, fetch: scopedFetch, agent };
  return scopedFetch;
}

export function resolveToolBrowserProxy(): { server: string; username?: string; password?: string; bypass?: string } | undefined {
  const proxyUrl = getConfiguredProxyUrl('tools');
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    const proxy = {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      bypass: getConfiguredNoProxy() || undefined,
    };
    return proxy;
  } catch {/* expected: resource not available */
    return undefined;
  }
}

export function __resetProxyFetchCacheForTest(): void {
  for (const entry of Object.values(scopedFetchCache)) {
    entry?.agent.destroy();
  }
  delete scopedFetchCache.llm;
  delete scopedFetchCache.tools;
}
