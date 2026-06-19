export type CommonModelProvider = 'anthropic' | 'moonshot' | 'deepseek' | 'openai' | 'gemini' | 'groq' | 'auto';

const COMMON_MODELS_BY_PROVIDER: Record<CommonModelProvider, string[]> = {
  anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  moonshot: ['kimi-k2.5', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  auto: ['gpt-4o', 'claude-sonnet-4-5', 'deepseek-chat', 'kimi-k2.5', 'gemini-2.0-flash'],
};

const PROVIDER_INPUT_KEYS: Record<string, CommonModelProvider> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  deepseek: 'deepseek',
  openai: 'openai',
  gemini: 'gemini',
  google: 'gemini',
  groq: 'groq',
  auto: 'auto',
};

const HOST_SUFFIXES: Array<{ suffix: string; provider: CommonModelProvider }> = [
  { suffix: 'anthropic.com', provider: 'anthropic' },
  { suffix: 'moonshot.cn', provider: 'moonshot' },
  { suffix: 'moonshot.ai', provider: 'moonshot' },
  { suffix: 'kimi.com', provider: 'moonshot' },
  { suffix: 'deepseek.com', provider: 'deepseek' },
  { suffix: 'deepseek.ai', provider: 'deepseek' },
  { suffix: 'openai.com', provider: 'openai' },
  { suffix: 'googleapis.com', provider: 'gemini' },
  { suffix: 'google.com', provider: 'gemini' },
  { suffix: 'groq.com', provider: 'groq' },
];

function normalizeProvider(provider: string): CommonModelProvider | null {
  return PROVIDER_INPUT_KEYS[provider.trim().toLowerCase()] ?? null;
}

function parseHostname(baseUrl: string): string | null {
  const raw = baseUrl.trim();
  if (!raw) return null;

  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${raw}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

function isHostOrSubdomain(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function detectCommonModelProviderFromBaseUrl(baseUrl: string): CommonModelProvider | null {
  const hostname = parseHostname(baseUrl);
  if (!hostname) return null;

  return HOST_SUFFIXES.find(({ suffix }) => isHostOrSubdomain(hostname, suffix))?.provider ?? null;
}

export function resolveCommonModelProvider(provider: string, baseUrl: string): CommonModelProvider {
  const configuredProvider = normalizeProvider(provider);
  if (configuredProvider && configuredProvider !== 'auto') return configuredProvider;
  return detectCommonModelProviderFromBaseUrl(baseUrl) ?? 'auto';
}

/**
 * 根据 provider 和 baseUrl 给首次配置流程提供常用模型列表。
 */
export function getCommonModels(provider: string, baseUrl: string): string[] {
  return COMMON_MODELS_BY_PROVIDER[resolveCommonModelProvider(provider, baseUrl)];
}
