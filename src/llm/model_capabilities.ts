/**
 * 模型能力管理器 - 完整复刻 Python 版本
 * 
 * 通过配置文件定义不同模型的能力，避免硬编码逻辑
 * 支持动态匹配模型、配置参数、响应字段映射
 */

import { getConfigValue, isLlmConfigUserSet } from '../config.js';
import {
  type ModelCapabilityConfig,
  type ModelCapabilitiesMap,
} from './model_capability_config.js';
import { getModelDevInfo } from './ModelsDevRegistry.js';

/**
 * 思考内容字段名列表（按优先级尝试，class 内私有用）
 */
const REASONING_FIELDS = ['reasoning_content', 'thinking', 'reasoning'];

// ==================== ModelProvider 能力查询接口 ====================

import { getModelManager } from '../config/ModelManager.js';
import type { ModelGenerationConfig, ModelProviderConfig, RuntimeModelSnapshot } from '../config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasoningPartToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    for (const field of REASONING_FIELDS) {
      const nested = value[field];
      if (typeof nested === 'string') return nested;
    }
    const text = value.text;
    if (typeof text === 'string') return text;
  }
  return String(value);
}

function getProviderModelName(modelId: string): string | undefined {
  try {
    const modelConfig = getModelManager().getModelById(modelId);
    if (!modelConfig) return undefined;
    const configuredModel = (modelConfig as ModelProviderConfig | RuntimeModelSnapshot).model;
    if (typeof configuredModel === 'string' && configuredModel.trim()) return configuredModel;
    if ('modelId' in modelConfig && typeof modelConfig.modelId === 'string' && modelConfig.modelId.trim()) {
      return modelConfig.modelId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getRegistryModelInfo(modelId: string) {
  const direct = getModelDevInfo(modelId);
  if (direct) return direct;
  const providerModel = getProviderModelName(modelId);
  return providerModel ? getModelDevInfo(providerModel) : undefined;
}

/**
 * effort 档位通用序（低 → 高）。用于把用户配置的 effort 档位映射到模型在 models.dev
 * 中实际支持的 values（不同模型档位集合不同，如 glm-5.2 仅 [high, max]）。
 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * effort 档位 → 默认 thinking budget（token 数）。仅用于 anthropic wire 的 budget 估算，
 * 最终会被 models.dev reasoning_options 的 budget_tokens.min/max 夹到模型真实区间。
 */
const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 2_048,
  low: 8_000,
  medium: 16_000,
  high: 32_000,
  xhigh: 48_000,
  max: 64_000,
};

/**
 * 把用户配置的 effort 档位映射到模型实际支持的档位值（来自 models.dev
 * reasoning_options.values）。确定性规则：命中即用；否则按通用序向上取最近的可用档
 * （优先更高强度），再向下，最后兜底取最高可用档。
 */
export function pickEffortValue(effort: string, available: string[]): string {
  const clean = available.filter((v): v is string => typeof v === 'string' && v.length > 0);
  // 空集：用户配了什么就发什么，不再硬降级为 'high'。
  // API 不认会返回 400，用户自行修正——比静默降级更透明。
  if (clean.length === 0) return effort;
  if (clean.includes(effort)) return effort;
  const idx = EFFORT_ORDER.indexOf(effort);
  if (idx >= 0) {
    for (let i = idx; i < EFFORT_ORDER.length; i++) {
      if (clean.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
    }
    for (let i = idx; i >= 0; i--) {
      if (clean.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
    }
  }
  return clean[clean.length - 1];
}

/**
 * 从 ModelManager 读取用户为该模型选定的 provider wire 格式（openai / anthropic）。
 * 模型未注册时返回 undefined（此时无法确定 wire 格式，调用方应放弃传思考参数）。
 */
function getProviderKindOfModel(modelId: string): 'openai' | 'anthropic' | undefined {
  try {
    const cfg = getModelManager().getModelById(modelId);
    const provider = (cfg as { provider?: unknown } | undefined)?.provider;
    return provider === 'anthropic' ? 'anthropic' : provider === 'openai' ? 'openai' : undefined;
  } catch {/* expected: model may be unregistered */}
  return undefined;
}

function modalitiesFromRegistry(modelId: string): import('./types.js').InputModalities | undefined {
  const devInfo = getRegistryModelInfo(modelId);
  if (!devInfo) return undefined;
  return {
    image: devInfo.vision,
    pdf: devInfo.pdf || undefined,
    audio: devInfo.audio || undefined,
    video: devInfo.video || undefined,
  };
}

/**
 * 从 ModelManager 查询模型是否支持 vision
 */
export function supportsVisionFromProvider(modelId: string): boolean {
  const modalities = getInputModalitiesFromProvider(modelId);
  if (modalities !== undefined) {
    return modalities.image ?? false;
  }
  return supportsVision(modelId);
}

/**
 * 从 ModelManager 查询模型的 InputModalities
 */
export function getInputModalitiesFromProvider(modelId: string): import('./types.js').InputModalities | undefined {
  const modelConfig = getModelManager().getModelById(modelId);
  if (!modelConfig) {
    return undefined;
  }

  const capabilities = (modelConfig as ModelProviderConfig | RuntimeModelSnapshot).capabilities;
  if (capabilities?.modalities) {
    return capabilities.modalities;
  }
  return modalitiesFromRegistry(modelId);
}

/**
 * 从 ModelManager 查询模型的 contextWindowSize
 * 优先级：配置直设 contextWindowSize > capabilities.contextWindowSize
 */
export function getContextWindowSizeFromProvider(modelId: string): number | undefined {
  const modelConfig = getModelManager().getModelById(modelId);
  if (!modelConfig) {
    return undefined;
  }

  const cfg = modelConfig as ModelProviderConfig | RuntimeModelSnapshot;
  // 优先从模型配置直设的 contextWindowSize 读
  if ('contextWindowSize' in cfg && typeof cfg.contextWindowSize === 'number' && cfg.contextWindowSize > 0) {
    return cfg.contextWindowSize;
  }
  // 其次从 capabilities 读
  const fromCaps = cfg.capabilities?.contextWindowSize;
  if (fromCaps && fromCaps > 0) return fromCaps;
  const devInfo = getRegistryModelInfo(modelId);
  return devInfo?.contextLimit;
}

/**
 * 从 ModelManager 查询模型的 generationConfig
 */
export function getGenerationConfigFromProvider(modelId: string): ModelGenerationConfig | undefined {
  const modelConfig = getModelManager().getModelById(modelId);
  if (!modelConfig) {
    return undefined;
  }

  return (modelConfig as ModelProviderConfig | RuntimeModelSnapshot).generationConfig;
}

/**
 * 模型能力管理器
 */
export class ModelCapabilities {
  private capabilities: ModelCapabilitiesMap;

  constructor(capabilities?: ModelCapabilitiesMap) {
    this.capabilities = capabilities || {};
  }

  /**
   * 精确匹配模型类型。
   */
  private matchModel(model: string): string | null {
    const modelLower = model.trim().toLowerCase();
    if (modelLower in this.capabilities) {
      return modelLower;
    }
    return null;
  }

  private getProviderCapability(model: string): ModelCapabilityConfig | null {
    try {
      const modelConfig = getModelManager().getModelById(model);
      const capabilities = (modelConfig as ModelProviderConfig | RuntimeModelSnapshot | undefined)?.capabilities as (Partial<ModelCapabilityConfig> & { modalities?: unknown }) | undefined;
      if (capabilities?.thinking_mode || capabilities?.param_name) {
        return capabilities as ModelCapabilityConfig;
      }
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
    return null;
  }

  private getExactCapability(model: string): ModelCapabilityConfig | null {
    const providerCapability = this.getProviderCapability(model);
    if (providerCapability) return providerCapability;

    const matched = this.matchModel(model);
    if (matched) return this.capabilities[matched];

    return null;
  }

  /**
   * 获取模型的思考模式参数（JSON 驱动 + provider 参数名）。
   *
   * 单一事实源（2026-06 重构，删除按名字猜的家族表）：
   *   1. 用户显式配置 capabilities.thinking_mode → 完全相信用户，按其 mode 传参。
   *   2. 否则 JSON 驱动：models.dev reasoning=true 才发；控制机制由
   *      reasoning_options.type 决定（effort→档位 / budget_tokens→预算 / toggle→开关），
   *      合法档位值 / 预算区间来自 JSON；参数名由用户选的 provider wire 决定
   *      （openai→reasoning_effort·extra_body / anthropic→thinking）。
   *   3. reasoning=true 但无 reasoning_options → 模型恒开推理（gpt-5.x/deepseek-r1），无需传参。
   */
  getThinkingParams(model: string): Record<string, unknown> | null {
    if (!getConfigValue('llm.enable_extended_thinking')) {
      return null;
    }

    const effort = String(getConfigValue('llm.reasoning_effort') || 'high');

    // 1) 用户显式配置（最高优先级，完全相信用户）。
    const explicit = this.getExactCapability(model);
    if (explicit?.thinking_mode && explicit.param_name) {
      return this.buildExplicitThinkingParams(explicit, effort);
    }

    // 2) JSON 驱动：models.dev reasoning=true 才发思考参数。
    const info = getRegistryModelInfo(model);
    if (!info?.reasoning) {
      // JSON 证明不支持推理（或模型未知）→ 不发，避免给非推理模型发参触发 400。
      return null;
    }
    const provider = getProviderKindOfModel(model);

    if (provider === 'anthropic') {
      // anthropic wire：thinking 块。预算取 effort→budget 映射，并被 JSON budget_tokens
      // 的 min/max 夹到模型真实区间。effort=adaptive 透传（新 Claude 自适应思考）。
      if (effort === 'adaptive') {
        return { thinking: { type: 'adaptive' } };
      }
      const budgetOpt = info.reasoningOptions?.find((o) => o.type === 'budget_tokens');
      const explicitBudget = getConfigValue('llm.thinking_budget_tokens');
      let budget = typeof explicitBudget === 'number' ? explicitBudget : (EFFORT_TO_BUDGET[effort] ?? 32_000);
      if (typeof budgetOpt?.min === 'number') budget = Math.max(budget, budgetOpt.min);
      if (typeof budgetOpt?.max === 'number' && budgetOpt.max > 0) budget = Math.min(budget, budgetOpt.max);
      if (budget <= 0) {
        return { thinking: { type: 'disabled' } };
      }
      return { thinking: { type: 'enabled', budget_tokens: budget } };
    }

    if (provider === 'openai') {
      // openai wire：按 models.dev 控制机制分支。
      const effortOpt = info.reasoningOptions?.find((o) => o.type === 'effort');
      if (effortOpt?.values && effortOpt.values.length > 0) {
        // 档位控制：值从模型 JSON 实际 values 取（不再硬编码 OpenAI 合法值）。
        return { reasoning_effort: pickEffortValue(effort, effortOpt.values) };
      }
      if (info.reasoningOptions?.some((o) => o.type === 'toggle')) {
        // 开关控制（Kimi/Qwen/旧 GLM）：extra_body.enable_thinking。
        return { extra_body: { enable_thinking: true } };
      }
      // reasoning=true 但无控制选项（gpt-5.x / deepseek-r1 / glm-5.2）。
      // 旧逻辑：认为「恒开推理无需传参」→ return null。
      // 新逻辑：用户显式配置了 reasoning_effort（非 none），说明用户想控制强度。
      // 即使 registry 没有控制选项，也发 reasoning_effort，让 API 决定是否接受。
      // API 不认会返回 400，用户自行修正——比静默丢弃更透明。
      if (effort !== 'none') {
        return { reasoning_effort: pickEffortValue(effort, []) };
      }
      return null;
    }

    // 未知 provider（模型未注册）→ 无法确定 wire 格式，不发。
    return null;
  }

  /**
   * 用户显式 capabilities 配置路径：按其声明的 thinking_mode 传参。
   * 仅当用户在模型配置里显式写了 thinking_mode/param_name 时走这里（完全相信用户）。
   */
  private buildExplicitThinkingParams(
    spec: ModelCapabilityConfig,
    effort: string,
  ): Record<string, unknown> | null {
    const mode = spec.thinking_mode;
    const paramName = spec.param_name;
    if (!mode || !paramName) return null;

    if (mode === 'reasoning_effort') {
      const legal = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
      return { [paramName]: legal.has(effort) ? effort : 'high' };
    }
    if (mode === 'thinking_block') {
      if (effort === 'adaptive') {
        return { [paramName]: { type: 'adaptive' } };
      }
      // 2026-06-23 修复「强度未传递」：anthropic thinking 的预算必须由 effort 驱动，
      // 否则用户配置的 reasoning_effort（如 xhigh/max/medium）对 Anthropic 完全失效——
      // 旧实现只要 llm.thinking_budget_tokens（schema 默认 32000）存在就直接采用，
      // 把 effort 旁路掉，导致强度档位被静默丢弃，且与 JSON 驱动路径行为不一致。
      // 现在与 JSON 驱动路径（见上文 getThinkingParams anthropic 分支）对齐：
      //   base = EFFORT_TO_BUDGET[effort]
      //   仅当用户在 settings.json/env 显式设定了 thinking_budget_tokens 时，
      //   才用该精确预算覆盖 effort 估算（提供「我要精确控制预算」的逃生口）。
      const effortBudget = EFFORT_TO_BUDGET[effort] ?? 32_000;
      const explicitBudget = isLlmConfigUserSet('llm.thinking_budget_tokens')
        ? getConfigValue('llm.thinking_budget_tokens')
        : undefined;
      const budget = typeof explicitBudget === 'number' && explicitBudget >= 0
        ? explicitBudget
        : effortBudget;
      if (budget <= 0) {
        return { [paramName]: { type: 'disabled' } };
      }
      return { [paramName]: { type: 'enabled', budget_tokens: budget } };
    }
    if (mode === 'extra_body') {
      return { extra_body: { [paramName]: spec.param_value } };
    }
    return null;
  }

  /**
   * 从消息中提取思考内容
   * 
   * 尝试多个可能的字段名，按优先级顺序
   */
  extractReasoningContent(message: unknown): string | null {
    if (!isRecord(message)) {
      return null;
    }

    for (const field of REASONING_FIELDS) {
      const value = message[field];
      if (value) {
        // 处理可能的列表格式（Anthropic）
        if (Array.isArray(value)) {
          return value.map(reasoningPartToText).join('');
        }
        return String(value);
      }
    }

    return null;
  }

  /**
   * 将思考模式参数应用到请求参数中
   */
  applyThinkingParams(model: string, kwargs: Record<string, unknown>): Record<string, unknown> {
    const params = this.getThinkingParams(model);
    if (!params) {
      return kwargs;
    }

    // 处理 extra_body 合并
    if ('extra_body' in params) {
      const currentExtraBody =
        typeof kwargs.extra_body === 'object' && kwargs.extra_body !== null
          ? kwargs.extra_body as Record<string, unknown>
          : {};
      const nextExtraBody =
        typeof params.extra_body === 'object' && params.extra_body !== null
          ? params.extra_body as Record<string, unknown>
          : {};
      kwargs.extra_body = { ...currentExtraBody, ...nextExtraBody };
    } else {
      Object.assign(kwargs, params);
    }

    return kwargs;
  }

  /**
   * 检查模型是否支持思考模式
   * 优先级：
   *   1. ModelManager 用户配置（thinking_mode 字段）
   *   2. ModelsDevRegistry reasoning 字段
   */
  supportsThinking(model: string): boolean {
    const config = this.getExactCapability(model);
    if (Boolean(config?.thinking_mode)) {
      return true;
    }
    const devInfo = getRegistryModelInfo(model);
    if (devInfo?.reasoning) return true;
    return false;
  }

  supportsVision(model: string): boolean {
    const modalities = this.getInputModalities(model);
    return modalities.image ?? false;
  }

  /**
   * 获取模型支持的输入模态
   * 优先级：
   *   1. ModelManager 用户配置 modalities
   *   2. ModelsDevRegistry（models.dev 社区数据）
   */
  getInputModalities(model: string): import('./types.js').InputModalities {
    const config = this.getExactCapability(model);

    // 1. 用户手动配置（最高优先级）
    const configWithModalities = config as (ModelCapabilityConfig & { modalities?: import('./types.js').InputModalities }) | null;
    if (configWithModalities?.modalities) {
      return configWithModalities.modalities;
    }

    return modalitiesFromRegistry(model) ?? {};
  }

  /**
   * 获取模型的能力配置
   */
  getCapability(model: string): ModelCapabilityConfig | null {
    return this.getExactCapability(model);
  }
}

// 全局实例
let globalCapabilities: ModelCapabilities | null = null;

/**
 * 获取模型能力管理器实例
 */
export function getModelCapabilities(): ModelCapabilities {
  if (!globalCapabilities) {
    globalCapabilities = new ModelCapabilities();
  }
  return globalCapabilities;
}

/**
 * 快捷方法：获取思考参数
 */
export function getThinkingParams(model: string): Record<string, unknown> | null {
  return getModelCapabilities().getThinkingParams(model);
}

export function supportsVision(model: string): boolean {
  return getModelCapabilities().supportsVision(model);
}

/**
 * 快捷方法：判断模型是否支持思考模式（thinking）
 * 用于 provider 请求组装和网关能力筛选；请求总超时统一由 runtimeConfig.llm.request_timeout_s 控制。
 */
export function supportsThinking(model: string): boolean {
  return getModelCapabilities().supportsThinking(model);
}

/**
 * 提取思考内容（外部以 extractCapabilityReasoningContent 别名引用，需保留）
 */
export function extractReasoningContent(message: unknown): string | null {
  return getModelCapabilities().extractReasoningContent(message);
}

/**
 * 快捷方法：应用思考参数
 */
export function applyThinkingParams(model: string, kwargs: Record<string, unknown>): Record<string, unknown> {
  return getModelCapabilities().applyThinkingParams(model, kwargs);
}
