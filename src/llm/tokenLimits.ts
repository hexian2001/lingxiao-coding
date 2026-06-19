/**
 * Token 限制常量与工具函数
 *
 * 实现 "Adaptive Output Token Escalation" 策略：
 * - 默认使用 CAPPED_DEFAULT_MAX_TOKENS (8K) 避免过度预留 GPU 资源
 * - 当输出因 max_tokens 被截断时，自动以 ESCALATED_MAX_TOKENS (64K) 重试
 *
 * 参考 qwen-code 的 adaptive-output-token-escalation 设计
 */

import { LLM } from '../config/defaults.js';
import { config as runtimeConfig, type ModelProviderConfig, type RuntimeModelSnapshot } from '../config.js';
import { getModelManager } from '../config/ModelManager.js';
import { getModelDevInfo } from './ModelsDevRegistry.js';

/** 默认 max_tokens 上限 — 99% 的响应在 5K tokens 以内，8K 提供足够余量 */
export const CAPPED_DEFAULT_MAX_TOKENS = LLM.CAPPED_MAX_TOKENS;

/** 升级后 max_tokens — 覆盖绝大多数长输出场景 */
export const ESCALATED_MAX_TOKENS = LLM.ESCALATED_MAX_TOKENS;

function configuredPositiveInteger(value: unknown, fallback: number): number {
  return positiveInteger(value) ?? fallback;
}

function cappedDefaultMaxTokens(): number {
  return configuredPositiveInteger(runtimeConfig.llm?.capped_max_tokens, LLM.CAPPED_MAX_TOKENS);
}

function escalatedMaxTokens(): number {
  return configuredPositiveInteger(runtimeConfig.llm?.escalated_max_tokens, LLM.ESCALATED_MAX_TOKENS);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function getProviderConfig(model: string): ModelProviderConfig | RuntimeModelSnapshot | undefined {
  try {
    return getModelManager().getModelById(model);
  } catch {
    return undefined;
  }
}

function getConfiguredOutputLimit(model: string): number | undefined {
  const modelConfig = getProviderConfig(model);
  return positiveInteger(modelConfig?.capabilities?.max_output_tokens);
}

function getProviderModelName(model: string): string | undefined {
  const modelConfig = getProviderConfig(model);
  if (!modelConfig) return undefined;
  const configuredModel = modelConfig.model;
  if (typeof configuredModel === 'string' && configuredModel.trim()) return configuredModel;
  if ('modelId' in modelConfig && typeof modelConfig.modelId === 'string' && modelConfig.modelId.trim()) {
    return modelConfig.modelId;
  }
  return undefined;
}

function getRegistryOutputLimit(model: string): number | undefined {
  const direct = positiveInteger(getModelDevInfo(model)?.outputLimit);
  if (direct) return direct;
  const providerModel = getProviderModelName(model);
  return providerModel ? positiveInteger(getModelDevInfo(providerModel)?.outputLimit) : undefined;
}

/**
 * 获取模型的最大输出 token 限制。
 * 优先级：
 *   1. ModelManager 用户配置 capabilities.max_output_tokens
 *   2. ModelsDevRegistry（models.dev 社区数据）
 *   3. 全局升级上限
 */
export function getModelOutputLimit(model: string): number {
  return getConfiguredOutputLimit(model)
    ?? getRegistryOutputLimit(model)
    ?? escalatedMaxTokens();
}

/**
 * 计算初始 max_tokens。
 * 取 min(模型输出上限, CAPPED_DEFAULT_MAX_TOKENS)，确保不超模型能力且节省资源。
 */
export function getInitialMaxTokens(model: string): number {
  const modelLimit = getModelOutputLimit(model);
  return Math.min(modelLimit, cappedDefaultMaxTokens());
}

/**
 * 计算升级后 max_tokens。
 * 取 min(模型输出上限, ESCALATED_MAX_TOKENS)。
 */
export function getEscalatedMaxTokens(model: string): number {
  const modelLimit = getModelOutputLimit(model);
  return Math.min(modelLimit, escalatedMaxTokens());
}
