import { config as runtimeConfig } from '../config.js';
import {
  DEFAULT_LINGXIAO_USER_AGENT,
  isLingxiaoDefaultUserAgent,
  isValidUserAgent,
} from '../version.js';

export {
  DEFAULT_LINGXIAO_USER_AGENT,
  isValidUserAgent,
} from '../version.js';

const USER_AGENT_HEADER = 'User-Agent';

export function normalizeUserAgent(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || isLingxiaoDefaultUserAgent(raw) || !isValidUserAgent(raw)) return DEFAULT_LINGXIAO_USER_AGENT;
  return raw;
}

export function getEffectiveUserAgent(): string {
  const configured = (runtimeConfig as unknown as { network?: { user_agent?: unknown } }).network?.user_agent;
  return normalizeUserAgent(configured);
}

function mergeHeaders(input: RequestInfo | URL, headers?: HeadersInit): Headers {
  const next = new Headers();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    for (const [key, value] of input.headers.entries()) next.set(key, value);
  }
  if (headers) {
    for (const [key, value] of new Headers(headers).entries()) next.set(key, value);
  }
  next.set(USER_AGENT_HEADER, getEffectiveUserAgent());
  return next;
}

export function withUserAgentHeader(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  return {
    ...(init || {}),
    headers: mergeHeaders(input, init?.headers),
  };
}
