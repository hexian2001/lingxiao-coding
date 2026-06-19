import { config as globalConfig, getConfigValue } from '../../config.js';
import { getModelManager } from '../../config/ModelManager.js';
import { t } from '../../i18n.js';
import type { AgentRole } from '../RoleRegistry.js';
import type { ExternalBackend, ExternalModelConfig } from './types.js';
import type { WorkerTaskPayload } from '../../core/WorkerProcessRunner.js';

const ANTHROPIC_PROVIDER_KEYS = new Set(['anthropic', 'claude']);
const OPENAI_COMPATIBLE_PROVIDER_KEYS = new Set(['openai', 'openai-compatible', 'azure-openai']);
const ANTHROPIC_HOST_PATTERN = /(^|\.)anthropic\.com$/i;
const OPENAI_HOST_PATTERN = /(^|\.)openai\.com$|(^|\.)openai\.azure\.com$/i;
const ANTHROPIC_PATH_SEGMENTS = new Set(['messages']);
const OPENAI_COMPATIBLE_PATH_SEGMENTS = new Set(['v1', 'responses']);

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function parseBaseUrl(baseUrl: string): URL | undefined {
  try {
    return new URL(baseUrl);
  } catch {
    return undefined;
  }
}

function hasKnownPathSegment(url: URL, segments: ReadonlySet<string>): boolean {
  for (const segment of url.pathname.split('/')) {
    const normalized = segment.trim().toLowerCase();
    if (normalized && segments.has(normalized)) {
      return true;
    }
  }
  return false;
}

function providerLooksAnthropic(baseUrl: string, provider: string): boolean {
  const normalizedProvider = normalizeProvider(provider);
  if (ANTHROPIC_PROVIDER_KEYS.has(normalizedProvider)) return true;

  const url = parseBaseUrl(baseUrl);
  if (!url) return false;
  return ANTHROPIC_HOST_PATTERN.test(url.hostname) || hasKnownPathSegment(url, ANTHROPIC_PATH_SEGMENTS);
}

function providerLooksOpenAI(baseUrl: string, provider: string): boolean {
  const normalizedProvider = normalizeProvider(provider);
  if (OPENAI_COMPATIBLE_PROVIDER_KEYS.has(normalizedProvider)) return true;

  const url = parseBaseUrl(baseUrl);
  if (!url) return false;
  return OPENAI_HOST_PATTERN.test(url.hostname) || hasKnownPathSegment(url, OPENAI_COMPATIBLE_PATH_SEGMENTS);
}

export function resolveExternalModel(
  backend: ExternalBackend,
  role: AgentRole,
  payload: WorkerTaskPayload,
): ExternalModelConfig {
  const modelId = role.model || payload.model || globalConfig.llm.agent_model || globalConfig.llm.leader_model;
  if (!modelId) {
    throw new Error(t('external_agent.model_missing', backend));
  }

  const rawModel = getModelManager().getModelByIdStrict(modelId) as unknown as Record<string, unknown>;
  const rawProvider = typeof rawModel.provider === 'string' ? rawModel.provider : undefined;
  const provider = normalizeProvider(rawProvider || (backend === 'claude' ? 'anthropic' : 'openai'));
  const apiKey = rawModel.apiKey as string | undefined;
  const baseUrl = rawModel.baseUrl as string | undefined;
  const apiModel = (rawModel.model || rawModel.id || modelId) as string;
  const envKey = (rawModel.envKey as string) || (backend === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');

  if (!apiKey) {
    throw new Error(t('external_agent.api_key_missing', backend, modelId, envKey));
  }
  if (!baseUrl) {
    throw new Error(t('external_agent.base_url_missing', backend, modelId));
  }

  if (backend === 'claude' && provider !== 'anthropic' && !providerLooksAnthropic(baseUrl, provider)) {
    throw new Error(t('external_agent.claude_incompatible', modelId, provider, baseUrl));
  }

  if (backend === 'codex' && provider !== 'openai' && !providerLooksOpenAI(baseUrl, provider)) {
    throw new Error(t('external_agent.codex_incompatible', modelId, provider, baseUrl));
  }

  return {
    id: String(rawModel.id || modelId),
    apiModel: String(apiModel),
    provider: backend === 'claude' ? 'anthropic' : 'openai',
    baseUrl: String(baseUrl),
    envKey: String(envKey),
    apiKey: String(apiKey),
    wireApi: role.worker_config?.wire_api || rawModel.wireApi as 'chat' | 'responses' | undefined || 'chat',
    reasoningEffort: String(getConfigValue('llm.reasoning_effort') || 'high'),
    disableResponseStorage: typeof rawModel.disableResponseStorage === 'boolean' ? rawModel.disableResponseStorage : undefined,
    networkAccess: rawModel.networkAccess === 'enabled' || rawModel.networkAccess === 'disabled' || rawModel.networkAccess === 'restricted'
      ? rawModel.networkAccess
      : undefined,
  };
}
