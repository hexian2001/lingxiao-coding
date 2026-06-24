import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getConfigValue, saveSettings, setConfigValue, config as runtimeConfig } from '../config.js';
import { getModelManager } from '../config/ModelManager.js';

export type LocalLlmGatewayProvider = 'openai' | 'anthropic';

export interface LocalLlmGatewayResolved {
  enabled: boolean;
  provider: LocalLlmGatewayProvider;
  modelId: string;
  apiModel: string;
  token: string;
  origin: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  injectEnv: boolean;
  overrideExistingEnv: boolean;
  traceEnabled: boolean;
}

export interface LocalLlmGatewayVirtualKey {
  id: string;
  key: string;
  label?: string;
  enabled?: boolean;
  model?: string;
  provider?: LocalLlmGatewayProvider;
  rpm?: number;
  tpm?: number;
  daily_token_budget?: number;
  expires_at?: number;
}

export interface LocalLlmGatewayAccess {
  gateway: LocalLlmGatewayResolved;
  keyId: string;
  keyLabel?: string;
  virtualKey: boolean;
  provider: LocalLlmGatewayProvider;
  modelId: string;
  apiModel: string;
  rpm: number;
  tpm: number;
  dailyTokenBudget: number;
}

export interface LocalLlmGatewayAuthError {
  statusCode: number;
  type: 'permission_error' | 'authentication_error' | 'configuration_error';
  message: string;
}

export type LocalLlmGatewayAuthResult =
  | { ok: true; access: LocalLlmGatewayAccess }
  | { ok: false; error: LocalLlmGatewayAuthError };

export interface LocalLlmGatewayQuotaReservation {
  keyId: string;
  reservedTokens: number;
}

export interface LocalLlmGatewayQuotaResult {
  allowed: boolean;
  reservation?: LocalLlmGatewayQuotaReservation;
  reason?: 'rpm_exceeded' | 'tpm_exceeded' | 'daily_budget_exceeded';
  retryAfterMs?: number;
  message?: string;
}

type GatewayQuotaBucket = {
  minuteStartedAt: number;
  minuteRequests: number;
  minuteTokens: number;
  dayKey: string;
  dailyTokens: number;
};

const quotaBuckets = new Map<string, GatewayQuotaBucket>();

// ── 运行时网关端点（进程绑定后由 startLocalLlmGatewayServer 设置）──
// 替代旧的 gateway.json 共享复用机制：每个进程自己绑定随机端口，
// 启动后把实际 host:port 写入此变量，resolveLocalLlmGateway() 优先读取。
let _runtimeGatewayEndpoint: { host: string; port: number } | null = null;

export function setRuntimeGatewayEndpoint(host: string, port: number): void {
  _runtimeGatewayEndpoint = { host: normalizeHost(host), port };
}

export function clearRuntimeGatewayEndpoint(): void {
  _runtimeGatewayEndpoint = null;
}

export function normalizeHost(host: string): string {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1';
  if (host === 'localhost') return '127.0.0.1';
  return host;
}

/** 网关根 token 前缀 —— OpenAI/Anthropic SDK 约定的 sk- 秘钥格式，lx 命名空间区分。 */
const GATEWAY_TOKEN_PREFIX = 'sk-lx-';

/**
 * 确保网关根秘钥存在并采用 sk- 格式。
 * 旧格式（lingxiao-local-…）或空 → 重新生成 sk-lx- 秘钥并落盘。
 * 网关默认关闭、仅本机 worker/客户端消费，轮换安全。
 */
function ensureGatewayToken(): string {
  const existing = String(getConfigValue('llm_gateway.api_key') || '').trim();
  if (existing && existing.startsWith(GATEWAY_TOKEN_PREFIX)) return existing;
  const token = `${GATEWAY_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  setConfigValue('llm_gateway.api_key', token);
  saveSettings(runtimeConfig);
  return token;
}

/** 导出 sk- 前缀供服务端/测试复用，保持单一事实源。 */
export function isLlmGatewaySkKey(value: string): boolean {
  return typeof value === 'string' && value.startsWith(GATEWAY_TOKEN_PREFIX);
}

export function readPositiveInt(path: string, fallback: number): number {
  const value = Number(getConfigValue(path));
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function normalizeVirtualKeyProvider(provider: unknown): LocalLlmGatewayProvider | undefined {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai') return 'openai';
  return undefined;
}

function readVirtualKeys(): LocalLlmGatewayVirtualKey[] {
  const value = getConfigValue('llm_gateway.virtual_keys');
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => raw && typeof raw === 'object' ? raw as Record<string, unknown> : null)
    .filter(Boolean)
    .map((raw): LocalLlmGatewayVirtualKey => ({
      id: String(raw!.id || '').trim(),
      key: String(raw!.key || '').trim(),
      label: typeof raw!.label === 'string' ? raw!.label : undefined,
      enabled: raw!.enabled !== false,
      model: typeof raw!.model === 'string' ? raw!.model.trim() : undefined,
      provider: normalizeVirtualKeyProvider(raw!.provider),
      rpm: Number.isFinite(Number(raw!.rpm)) && Number(raw!.rpm) > 0 ? Math.floor(Number(raw!.rpm)) : undefined,
      tpm: Number.isFinite(Number(raw!.tpm)) && Number(raw!.tpm) > 0 ? Math.floor(Number(raw!.tpm)) : undefined,
      daily_token_budget: Number.isFinite(Number(raw!.daily_token_budget)) && Number(raw!.daily_token_budget) > 0
        ? Math.floor(Number(raw!.daily_token_budget))
        : undefined,
      expires_at: Number.isFinite(Number(raw!.expires_at)) && Number(raw!.expires_at) > 0 ? Math.floor(Number(raw!.expires_at)) : undefined,
    }))
    .filter((key) => key.id && key.key);
}

function resolveAccessForModel(
  gateway: LocalLlmGatewayResolved,
  input: {
    keyId: string;
    keyLabel?: string;
    virtualKey: boolean;
    provider?: LocalLlmGatewayProvider;
    modelId?: string;
    rpm?: number;
    tpm?: number;
    dailyTokenBudget?: number;
  },
): LocalLlmGatewayAccess {
  const modelId = String(input.modelId || gateway.modelId || '').trim();
  if (!modelId) {
    throw new Error('Lingxiao local LLM gateway has no model configured');
  }
  const model = getModelManager().getModelByIdStrict(modelId);
  return {
    gateway,
    keyId: input.keyId,
    keyLabel: input.keyLabel,
    virtualKey: input.virtualKey,
    provider: input.provider || gateway.provider,
    modelId,
    apiModel: model.model || modelId,
    rpm: input.rpm || readPositiveInt('llm_gateway.default_rpm', 60),
    tpm: input.tpm || readPositiveInt('llm_gateway.default_tpm', 200_000),
    dailyTokenBudget: input.dailyTokenBudget || readPositiveInt('llm_gateway.default_daily_token_budget', 2_000_000),
  };
}

function isLocalLlmGatewayEnabled(): boolean {
  return getConfigValue('llm_gateway.enabled') === true;
}

export function resolveLocalLlmGateway(): LocalLlmGatewayResolved | null {
  if (!isLocalLlmGatewayEnabled()) return null;

  const provider = (getConfigValue('llm_gateway.provider') === 'anthropic' ? 'anthropic' : 'openai') as LocalLlmGatewayProvider;
  const modelId = String(getConfigValue('llm_gateway.model') || getConfigValue('llm.leader_model') || '').trim();
  if (!modelId) return null;

  const model = getModelManager().getModelByIdStrict(modelId);
  const apiModel = model.model || modelId;
  const token = ensureGatewayToken();
  // 网关端口：优先用运行时绑定的实际端口（随机分配），
  // 回退到配置端口（用于未启动时显示默认地址或外部直连场景）。
  const host = _runtimeGatewayEndpoint?.host || normalizeHost(String(getConfigValue('llm_gateway.host') || '127.0.0.1'));
  const port = _runtimeGatewayEndpoint?.port || readPositiveInt('llm_gateway.port', 62000);
  const origin = `http://${host}:${port}`;

  return {
    enabled: true,
    provider,
    modelId,
    apiModel,
    token,
    origin,
    openaiBaseUrl: `${origin}/llm/openai/v1`,
    anthropicBaseUrl: `${origin}/llm/anthropic`,
    injectEnv: getConfigValue('llm_gateway.inject_env') !== false,
    overrideExistingEnv: getConfigValue('llm_gateway.override_existing_env') === true,
    traceEnabled: getConfigValue('llm_gateway.trace_enabled') !== false,
  };
}

export function authorizeLocalLlmGatewayToken(token: string): LocalLlmGatewayAuthResult {
  let gateway: LocalLlmGatewayResolved | null;
  try {
    gateway = resolveLocalLlmGateway();
  } catch (err) {
    return {
      ok: false,
      error: {
        statusCode: 503,
        type: 'configuration_error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (!gateway) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        type: 'permission_error',
        message: 'Lingxiao local LLM gateway is disabled',
      },
    };
  }

  const presented = String(token || '').trim();
  if (!presented) {
    return {
      ok: false,
      error: {
        statusCode: 401,
        type: 'authentication_error',
        message: 'Missing local LLM gateway API key',
      },
    };
  }

  // Use timingSafeEqual to prevent timing side-channel attacks on token comparison.
  const expected = gateway.token;
  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expected);
  if (presentedBuf.length === expectedBuf.length && timingSafeEqual(presentedBuf, expectedBuf)) {
    try {
      return {
        ok: true,
        access: resolveAccessForModel(gateway, {
          keyId: 'root',
          keyLabel: 'Root gateway token',
          virtualKey: false,
        }),
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          statusCode: 503,
          type: 'configuration_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  const matched = readVirtualKeys().find((key) => key.key === presented);
  if (!matched) {
    return {
      ok: false,
      error: {
        statusCode: 401,
        type: 'authentication_error',
        message: 'Invalid local LLM gateway API key',
      },
    };
  }
  if (matched.enabled === false) {
    return {
      ok: false,
      error: {
        statusCode: 401,
        type: 'authentication_error',
        message: 'Local LLM gateway virtual key is disabled',
      },
    };
  }
  if (matched.expires_at && matched.expires_at <= Math.floor(Date.now() / 1000)) {
    return {
      ok: false,
      error: {
        statusCode: 401,
        type: 'authentication_error',
        message: 'Local LLM gateway virtual key has expired',
      },
    };
  }

  try {
    return {
      ok: true,
      access: resolveAccessForModel(gateway, {
        keyId: matched.id,
        keyLabel: matched.label,
        virtualKey: true,
        provider: matched.provider,
        modelId: matched.model,
        rpm: matched.rpm,
        tpm: matched.tpm,
        dailyTokenBudget: matched.daily_token_budget,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        statusCode: 503,
        type: 'configuration_error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function quotaBucket(access: LocalLlmGatewayAccess): GatewayQuotaBucket {
  const now = Date.now();
  const currentDay = dayKey(now);
  let bucket = quotaBuckets.get(access.keyId);
  if (!bucket) {
    bucket = {
      minuteStartedAt: now,
      minuteRequests: 0,
      minuteTokens: 0,
      dayKey: currentDay,
      dailyTokens: 0,
    };
    quotaBuckets.set(access.keyId, bucket);
    return bucket;
  }
  if (now - bucket.minuteStartedAt >= 60_000) {
    bucket.minuteStartedAt = now;
    bucket.minuteRequests = 0;
    bucket.minuteTokens = 0;
  }
  if (bucket.dayKey !== currentDay) {
    bucket.dayKey = currentDay;
    bucket.dailyTokens = 0;
  }
  return bucket;
}

export function reserveLocalLlmGatewayQuota(access: LocalLlmGatewayAccess, estimatedTokens: number): LocalLlmGatewayQuotaResult {
  const tokens = Math.max(0, Math.floor(Number.isFinite(estimatedTokens) ? estimatedTokens : 0));
  const bucket = quotaBucket(access);
  const retryAfterMs = Math.max(1000, 60_000 - (Date.now() - bucket.minuteStartedAt));

  if (access.rpm > 0 && bucket.minuteRequests + 1 > access.rpm) {
    return {
      allowed: false,
      reason: 'rpm_exceeded',
      retryAfterMs,
      message: `Local LLM gateway key '${access.keyId}' exceeded ${access.rpm} requests/minute`,
    };
  }
  if (access.tpm > 0 && bucket.minuteTokens + tokens > access.tpm) {
    return {
      allowed: false,
      reason: 'tpm_exceeded',
      retryAfterMs,
      message: `Local LLM gateway key '${access.keyId}' exceeded ${access.tpm} tokens/minute`,
    };
  }
  if (access.dailyTokenBudget > 0 && bucket.dailyTokens + tokens > access.dailyTokenBudget) {
    return {
      allowed: false,
      reason: 'daily_budget_exceeded',
      retryAfterMs: undefined,
      message: `Local LLM gateway key '${access.keyId}' exceeded daily token budget ${access.dailyTokenBudget}`,
    };
  }

  bucket.minuteRequests += 1;
  bucket.minuteTokens += tokens;
  bucket.dailyTokens += tokens;
  return {
    allowed: true,
    reservation: {
      keyId: access.keyId,
      reservedTokens: tokens,
    },
  };
}

export function commitLocalLlmGatewayUsage(
  access: LocalLlmGatewayAccess,
  actualTotalTokens: number,
  reservation?: LocalLlmGatewayQuotaReservation,
): void {
  const actual = Math.max(0, Math.floor(Number.isFinite(actualTotalTokens) ? actualTotalTokens : 0));
  const reserved = reservation?.keyId === access.keyId ? Math.max(0, reservation.reservedTokens) : 0;
  const delta = Math.max(0, actual - reserved);
  if (delta <= 0) return;
  const bucket = quotaBucket(access);
  bucket.minuteTokens += delta;
  bucket.dailyTokens += delta;
}

export function _resetLocalLlmGatewayQuotaForTests(): void {
  quotaBuckets.clear();
}

function setEnvIfAllowed(
  target: Record<string, string>,
  existing: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  value: string,
  override: boolean,
): void {
  if (!override && existing[key]) return;
  target[key] = value;
}

export function buildLocalLlmGatewayEnv(existingEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Record<string, string> {
  let gateway: LocalLlmGatewayResolved | null;
  try {
    gateway = resolveLocalLlmGateway();
  } catch {/* expected: data unavailable */
    return {};
  }
  if (!gateway || !gateway.injectEnv) return {};

  const env: Record<string, string> = {};
  const providerBaseUrl = gateway.provider === 'anthropic' ? gateway.anthropicBaseUrl : gateway.openaiBaseUrl;
  setEnvIfAllowed(env, existingEnv, 'LINGXIAO_LLM_GATEWAY_PROVIDER', gateway.provider, gateway.overrideExistingEnv);
  setEnvIfAllowed(env, existingEnv, 'LINGXIAO_LLM_GATEWAY_BASE_URL', providerBaseUrl, gateway.overrideExistingEnv);
  setEnvIfAllowed(env, existingEnv, 'LINGXIAO_LLM_GATEWAY_MODEL', gateway.apiModel, gateway.overrideExistingEnv);
  setEnvIfAllowed(env, existingEnv, 'LINGXIAO_LLM_GATEWAY_API_KEY', gateway.token, gateway.overrideExistingEnv);

  if (gateway.provider === 'anthropic') {
    setEnvIfAllowed(env, existingEnv, 'ANTHROPIC_BASE_URL', gateway.anthropicBaseUrl, gateway.overrideExistingEnv);
    setEnvIfAllowed(env, existingEnv, 'ANTHROPIC_API_KEY', gateway.token, gateway.overrideExistingEnv);
    setEnvIfAllowed(env, existingEnv, 'ANTHROPIC_MODEL', gateway.apiModel, gateway.overrideExistingEnv);
  } else {
    setEnvIfAllowed(env, existingEnv, 'OPENAI_BASE_URL', gateway.openaiBaseUrl, gateway.overrideExistingEnv);
    setEnvIfAllowed(env, existingEnv, 'OPENAI_API_KEY', gateway.token, gateway.overrideExistingEnv);
    setEnvIfAllowed(env, existingEnv, 'OPENAI_MODEL', gateway.apiModel, gateway.overrideExistingEnv);
  }

  return env;
}

export function buildLocalLlmGatewayPromptSection(): string {
  let gateway: LocalLlmGatewayResolved | null;
  try {
    gateway = resolveLocalLlmGateway();
  } catch {/* expected: fallback to default */
    return '';
  }
  if (!gateway || !gateway.injectEnv) return '';

  const providerVars = gateway.provider === 'anthropic'
    ? '`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`'
    : '`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`';

  const alternateEndpoint = gateway.provider === 'anthropic'
    ? `OpenAI API 端点也可用: \`${gateway.openaiBaseUrl}\``
    : `Anthropic API 端点也可用: \`${gateway.anthropicBaseUrl}\``;

  return [
    '**【本地 LLM 测试网关】**',
    `- 当前会话启用了凌霄本地 LLM Gateway；固定地址 \`${gateway.origin}\`，默认 provider: \`${gateway.provider}\`，默认模型: \`${gateway.apiModel}\`。`,
    `- OpenAI 兼容端点完整 base URL: \`${gateway.openaiBaseUrl}\` — chat completions 路径为 \`${gateway.openaiBaseUrl}/chat/completions\`，embeddings 路径为 \`${gateway.openaiBaseUrl}/embeddings\`。`,
    `- 如果正在开发/测试用户项目的 LLM 接入，且用户没有提供项目专属 LLM 配置，可使用已注入的 ${providerVars}。`,
    '- 模型名以已注入配置为准，直接使用该模型开展开发/测试。',
    `- ${alternateEndpoint}；仅当项目代码明确使用另一套 SDK/API 格式时再切换。`,
    `- 根秘钥已通过环境变量 \`${providerVars}\` 注入；请直接使用环境变量获取 token，不要在代码中硬编码。`,
    '- Gateway 地址、token 和模型配置仅作为当前会话测试环境变量使用；生产配置和部署文档引用项目自己的配置入口。',
  ].join('\n');
}
