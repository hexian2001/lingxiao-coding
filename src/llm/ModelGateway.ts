import { config as runtimeConfig, type Config, type ModelProviderConfig, type RuntimeModelSnapshot } from '../config.js';
import { getModelManager, type ModelManager } from '../config/ModelManager.js';
import { resolvePricing } from './CostService.js';
import { getModelDevInfo } from './ModelsDevRegistry.js';
import type { InputModalities } from './types.js';

export type GatewayPurpose =
  | 'leader'
  | 'agent'
  | 'research'
  | 'coding'
  | 'verify'
  | 'review'
  | 'summary'
  | 'vision'
  | 'local_gateway'
  | 'settings_test'
  | 'wiki'
  | 'generic';

export type GatewayLatencyClass = 'interactive' | 'batch' | 'background';
export type GatewayDataPolicy = 'standard' | 'local_only' | 'zdr_required' | 'redact_sensitive';

export interface GatewayRequiredCapabilities {
  thinking?: boolean;
  vision?: boolean;
  longContextTokens?: number;
}

export interface GatewayRequestContext {
  actorLabel?: string;
  actorType?: 'leader' | 'agent' | 'external' | 'local_gateway' | 'system';
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  role?: string;
  purpose?: GatewayPurpose;
  required?: GatewayRequiredCapabilities;
  latencyClass?: GatewayLatencyClass;
  dataPolicy?: GatewayDataPolicy;
  maxInputTokens?: number;
  requestedModel?: string;
}

export interface GatewayRouteConfig {
  primary?: string;
  fallbacks?: string[];
  require?: GatewayRequiredCapabilities;
  max_cost_per_mtoken?: number;
  data_policy?: GatewayDataPolicy;
}

export interface GatewayDecision {
  profile: string;
  requestedModel: string;
  selectedModel: string;
  candidates: string[];
  fallbackModels: string[];
  rejected: Array<{ model: string; reason: string }>;
  reason: string;
}

export interface GatewayTrace {
  traceId: string;
  request: GatewayRequestContext;
  decision: GatewayDecision;
  attempts: Array<{
    model: string;
    status: 'started' | 'success' | 'failed' | 'skipped';
    errorKind?: string;
    errorMessage?: string;
    retryable?: boolean;
    elapsedMs?: number;
    startedAt: number;
    finishedAt?: number;
  }>;
  startedAt: number;
  finishedAt?: number;
  finalModel?: string;
  finalStatus?: 'success' | 'failed';
}

const ROLE_PROFILES = new Set<Extract<GatewayPurpose, 'research' | 'verify' | 'review' | 'coding'>>([
  'research',
  'verify',
  'review',
  'coding',
]);

export interface GatewayAttemptHandle {
  trace: GatewayTrace;
  attemptIndex: number;
  model: string;
}

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function profileFromPurpose(input?: GatewayRequestContext): string {
  const purpose = input?.purpose;
  const actorType = input?.actorType;
  const role = (input?.role || '').toLowerCase();
  if (purpose === 'local_gateway') return 'local_gateway';
  if (purpose === 'settings_test') return 'settings_test';
  if (purpose === 'wiki') return 'wiki';
  if (purpose === 'summary') return 'summary';
  if (purpose === 'vision' || input?.required?.vision) return 'vision';
  if (actorType === 'leader' || purpose === 'leader') return 'leader';
  if (purpose === 'research') return 'research';
  if (purpose === 'verify') return 'verify';
  if (purpose === 'review') return 'review';
  if (purpose === 'coding') return 'coding';
  if (ROLE_PROFILES.has(role as Extract<GatewayPurpose, 'research' | 'verify' | 'review' | 'coding'>)) {
    return role as Extract<GatewayPurpose, 'research' | 'verify' | 'review' | 'coding'>;
  }
  if (actorType === 'agent' || purpose === 'agent') return 'agent';
  return 'generic';
}

function configuredRoute(config: Config, profile: string): GatewayRouteConfig | undefined {
  const routes = config.llm.gateway_routes as Record<string, GatewayRouteConfig> | undefined;
  return routes?.[profile] || routes?.generic;
}

function defaultPrimary(config: Config, profile: string): string {
  if (profile === 'agent' || profile === 'coding' || profile === 'verify' || profile === 'review' || profile === 'research') {
    return config.llm.agent_model || config.llm.leader_model || '';
  }
  if (profile === 'wiki') {
    return config.llm.wiki_model || config.llm.leader_model || config.llm.agent_model || '';
  }
  return config.llm.leader_model || config.llm.agent_model || '';
}

function hasThinking(model: ModelProviderConfig | RuntimeModelSnapshot): boolean {
  const caps = model.capabilities as Record<string, unknown> | undefined;
  if (typeof caps?.thinking_mode === 'string' && caps.thinking_mode) return true;
  return getModelDevInfo(getProviderModelName(model))?.reasoning === true;
}

function getModelId(model: ModelProviderConfig | RuntimeModelSnapshot): string {
  return 'snapshotId' in model ? model.snapshotId : model.id;
}

function getProviderModelName(model: ModelProviderConfig | RuntimeModelSnapshot): string {
  return model.model || ('modelId' in model ? model.modelId : model.id);
}

function getModelModalities(model: ModelProviderConfig | RuntimeModelSnapshot): InputModalities | undefined {
  const configured = model.capabilities?.modalities;
  if (configured) return configured;
  const devInfo = getModelDevInfo(getProviderModelName(model));
  if (!devInfo) return undefined;
  return {
    image: devInfo.vision,
    pdf: devInfo.pdf || undefined,
    audio: devInfo.audio || undefined,
    video: devInfo.video || undefined,
  };
}

function getContextWindowSize(model: ModelProviderConfig | RuntimeModelSnapshot): number | undefined {
  if ('contextWindowSize' in model && typeof model.contextWindowSize === 'number' && model.contextWindowSize > 0) {
    return model.contextWindowSize;
  }
  const fromCaps = model.capabilities?.contextWindowSize;
  if (fromCaps && fromCaps > 0) return fromCaps;
  return getModelDevInfo(getProviderModelName(model))?.contextLimit;
}

function modelSupports(modelId: string, required: GatewayRequiredCapabilities | undefined, modelManager: ModelManager): { ok: boolean; reason?: string } {
  const model = modelManager.getModelById(modelId);
  if (!model) {
    if (!required?.thinking && !required?.vision && !required?.longContextTokens) {
      return { ok: true };
    }
    return { ok: false, reason: 'not_configured' };
  }
  if (required?.thinking && !hasThinking(model)) return { ok: false, reason: 'missing_thinking' };
  if (required?.vision) {
    const modalities = getModelModalities(model);
    if (!modalities?.image) return { ok: false, reason: 'missing_vision' };
  }
  if (required?.longContextTokens) {
    const contextWindow = getContextWindowSize(model);
    if (contextWindow && contextWindow < required.longContextTokens) return { ok: false, reason: 'context_too_small' };
  }
  return { ok: true };
}

function costAllowed(modelId: string, maxCostPerMToken: number | undefined): { ok: boolean; reason?: string } {
  if (!maxCostPerMToken || maxCostPerMToken <= 0) return { ok: true };
  const pricing = resolvePricing(modelId);
  if (!pricing) return { ok: false, reason: 'pricing_missing' };
  return Math.max(pricing.inputPerMToken, pricing.outputPerMToken) <= maxCostPerMToken
    ? { ok: true }
    : { ok: false, reason: 'cost_ceiling' };
}

export class ModelGateway {
  constructor(
    private readonly config: Config = runtimeConfig,
    private readonly modelManager: ModelManager = getModelManager(),
  ) {}

  decide(input: GatewayRequestContext = {}): GatewayDecision {
    const profile = profileFromPurpose(input);
    const route = configuredRoute(this.config, profile);
    const requestedModel = input.requestedModel || defaultPrimary(this.config, profile);
    const primary = route?.primary || requestedModel || defaultPrimary(this.config, profile);
    const required = {
      ...(route?.require || {}),
      ...(input.required || {}),
    };
    const candidates = uniqueNonEmpty([primary]);

    const rejected: GatewayDecision['rejected'] = [];
    let selectedModel = '';
    for (const candidate of candidates) {
      const supported = modelSupports(candidate, required, this.modelManager);
      if (!supported.ok) {
        rejected.push({ model: candidate, reason: supported.reason || 'unsupported' });
        continue;
      }
      const cost = costAllowed(candidate, route?.max_cost_per_mtoken);
      if (!cost.ok) {
        rejected.push({ model: candidate, reason: cost.reason || 'cost_ceiling' });
        continue;
      }
      selectedModel = candidate;
      break;
    }

    if (!selectedModel) {
      selectedModel = primary || requestedModel;
    }

    // 显式 fallback 候选：route.fallbacks 优先，其后接全局 gateway_fallback_models。
    // 与 primary 同样跑能力/成本过滤，剔除 selectedModel 与重复项，保持确定性顺序。
    const globalFallbacks = (this.config.llm.gateway_fallback_models as string[] | undefined) || [];
    const fallbackCandidates = uniqueNonEmpty([...(route?.fallbacks || []), ...globalFallbacks])
      .filter((candidate) => candidate !== selectedModel);
    const fallbackModels: string[] = [];
    for (const candidate of fallbackCandidates) {
      const supported = modelSupports(candidate, required, this.modelManager);
      if (!supported.ok) {
        rejected.push({ model: candidate, reason: supported.reason || 'unsupported' });
        continue;
      }
      const cost = costAllowed(candidate, route?.max_cost_per_mtoken);
      if (!cost.ok) {
        rejected.push({ model: candidate, reason: cost.reason || 'cost_ceiling' });
        continue;
      }
      fallbackModels.push(candidate);
    }

    return {
      profile,
      requestedModel: requestedModel || selectedModel,
      selectedModel,
      candidates,
      fallbackModels,
      rejected,
      reason: route ? `profile:${profile}` : `default:${profile}`,
    };
  }

  createTrace(request: GatewayRequestContext = {}, decision = this.decide(request)): GatewayTrace {
    return {
      traceId: `gw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      request,
      decision,
      attempts: [],
      startedAt: Date.now(),
    };
  }

  startAttempt(trace: GatewayTrace, model: string): GatewayAttemptHandle {
    const attemptIndex = trace.attempts.length;
    trace.attempts.push({
      model,
      status: 'started',
      startedAt: Date.now(),
    });
    return { trace, attemptIndex, model };
  }

  finishAttempt(handle: GatewayAttemptHandle, input: {
    status: 'success' | 'failed' | 'skipped';
    errorKind?: string;
    errorMessage?: string;
    retryable?: boolean;
  }): void {
    const attempt = handle.trace.attempts[handle.attemptIndex];
    if (!attempt) return;
    const finishedAt = Date.now();
    attempt.status = input.status;
    attempt.errorKind = input.errorKind;
    attempt.errorMessage = input.errorMessage;
    attempt.retryable = input.retryable;
    attempt.finishedAt = finishedAt;
    attempt.elapsedMs = finishedAt - attempt.startedAt;
    if (input.status === 'success') {
      handle.trace.finalStatus = 'success';
      handle.trace.finalModel = handle.model;
      handle.trace.finishedAt = finishedAt;
    }
  }

  failTrace(trace: GatewayTrace): void {
    trace.finalStatus = 'failed';
    trace.finishedAt = Date.now();
  }

  pickFallback(trace: GatewayTrace, failedModels: Set<string>): string | null {
    for (const candidate of trace.decision.fallbackModels) {
      if (!failedModels.has(candidate)) return candidate;
    }
    return null;
  }
}

let globalGateway: ModelGateway | null = null;

export function getModelGateway(): ModelGateway {
  if (!globalGateway) globalGateway = new ModelGateway();
  return globalGateway;
}

export function _resetModelGatewayForTests(): void {
  globalGateway = null;
}

export function modelIdsFromProviders(config: Config = runtimeConfig): string[] {
  return Object.values(config.llm.model_providers || {})
    .flat()
    .map((model) => getModelId(model as ModelProviderConfig))
    .filter(Boolean);
}
