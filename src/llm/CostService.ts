/**
 * CostService — 模型定价与费用计算
 *
 * 基于 token usage 计算费用，支持 cache-aware 计价：
 * - cache_read 通常比普通 input 便宜 90%（Anthropic）或免费（OpenAI）
 * - cache_creation 通常比普通 input 贵 25%（Anthropic）
 * - 净输入 = input - cache_read - cache_creation（避免重复计费）
 *
 * 价格来源（按优先级）：
 *   1. runtimeConfig.llm.model_providers / ModelManager 精确配置
 *   2. ModelsDevRegistry 精确模型数据
 *   3. 未命中时明确标记 pricingMissing，不再套用估算默认价
 */

import { coreLogger } from '../core/Log.js';
import { config as runtimeConfig } from '../config.js';
import { getModelManager } from '../config/ModelManager.js';
import { getModelDevInfoExact } from './ModelsDevRegistry.js';

export interface ModelPricing {
  /** 每百万 input token 价格（美元） */
  inputPerMToken: number;
  /** 每百万 output token 价格（美元） */
  outputPerMToken: number;
  /** 每百万 cache read token 价格（美元） */
  cacheReadPerMToken: number;
  /** 每百万 cache creation token 价格（美元） */
  cacheCreationPerMToken: number;
}

export type ModelPricingResolution = ModelPricing & {
  estimated: false;
};

export interface CostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 净输入（扣除 cache 部分） */
  netInputTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheCreationCost: number;
  totalCost: number;
  pricingMissing?: boolean;
}

export interface SessionCostSummary {
  models: CostBreakdown[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCost: number;
  cacheHitRate: number;
  cacheSavings: number;
}

const warnedPricingMisses = new Set<string>();

function coerceModelPricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Record<keyof ModelPricing, unknown>>;
  const input = raw.inputPerMToken;
  const output = raw.outputPerMToken;
  if (typeof input !== 'number' || input <= 0 || typeof output !== 'number' || output <= 0) {
    return null;
  }
  return {
    inputPerMToken: input,
    outputPerMToken: output,
    cacheReadPerMToken: typeof raw.cacheReadPerMToken === 'number' ? raw.cacheReadPerMToken : input,
    cacheCreationPerMToken: typeof raw.cacheCreationPerMToken === 'number' ? raw.cacheCreationPerMToken : input,
  };
}

function warnPricingMiss(modelId: string): void {
  if (!modelId || warnedPricingMisses.has(modelId)) return;
  warnedPricingMisses.add(modelId);
  coreLogger.warn('no-pricing-for-model', { modelId });
}

function getPricingFromRuntimeConfig(modelId: string): ModelPricing | null {
  for (const models of Object.values(runtimeConfig.llm.model_providers || {})) {
    for (const model of models) {
      if (model.id !== modelId) continue;
      const configuredPricing = coerceModelPricing(model.pricing);
      if (configuredPricing) return configuredPricing;

      const providerModelId = model.model;
      if (providerModelId && providerModelId !== modelId) {
        const providerPricing = coerceModelPricing(getModelDevInfoExact(providerModelId)?.pricing);
        if (providerPricing) return providerPricing;
      }
      return null;
    }
  }
  return null;
}

/**
 * 从结构化注册表精确查找模型定价。
 */
export function getPricingFromRegistry(modelId: string): ModelPricing | null {
  const id = modelId.trim();
  if (!id) return null;

  const runtimeConfigured = getPricingFromRuntimeConfig(id);
  if (runtimeConfigured) return runtimeConfigured;

  try {
    const configured = getModelManager().getModelById(id) as { pricing?: unknown; model?: string } | undefined;
    const configuredPricing = coerceModelPricing(configured?.pricing);
    if (configuredPricing) return configuredPricing;

    const providerModelId = configured?.model;
    if (providerModelId && providerModelId !== id) {
      const providerPricing = coerceModelPricing(getModelDevInfoExact(providerModelId)?.pricing);
      if (providerPricing) return providerPricing;
    }
  } catch {
    // ModelManager can throw while resolving incomplete local credentials; pricing lookup must stay non-fatal.
  }

  return coerceModelPricing(getModelDevInfoExact(id)?.pricing);
}

/**
 * 获取模型定价解析结果。
 *
 * 解析顺序：
 *   1. runtimeConfig.llm.model_providers / ModelManager / ModelsDevRegistry 精确查找
 *   2. 未命中返回 null
 */
export function resolvePricing(modelName: string): ModelPricingResolution | null {
  const modelId = modelName.trim();
  if (!modelId) {
    return null;
  }

  const registry = getPricingFromRegistry(modelId);
  if (registry) return { ...registry, estimated: false };

  warnPricingMiss(modelId);
  return null;
}

/**
 * 计算单个模型的费用明细
 */
export function calculateModelCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): CostBreakdown {
  const pricing = resolvePricing(modelName);

  // 净输入 = 总输入 - cache_read - cache_creation（避免重复计费）。
  // usageExtractor 已统一把所有 provider 的 input 归一为「毛输入」（含 cache
  // 两部分），因此这里对全 provider 都成立，不再有 Anthropic 双扣减问题。
  const netInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);

  if (!pricing) {
    return {
      model: modelName,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      netInputTokens,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheCreationCost: 0,
      totalCost: 0,
      pricingMissing: true,
    };
  }

  const inputCost = (netInputTokens / 1_000_000) * pricing.inputPerMToken;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMToken;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMToken;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * pricing.cacheCreationPerMToken;
  const totalCost = inputCost + outputCost + cacheReadCost + cacheCreationCost;

  return {
    model: modelName,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    netInputTokens,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    totalCost,
  };
}

/**
 * 计算会话总费用
 */
export function calculateSessionCost(
  modelStats: Array<{
    name: string;
    totalPrompt: number;
    totalCompletion: number;
    cacheRead?: number;
    cacheCreation?: number;
  }>,
): SessionCostSummary {
  const models: CostBreakdown[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCost = 0;

  for (const stat of modelStats) {
    const breakdown = calculateModelCost(
      stat.name,
      stat.totalPrompt,
      stat.totalCompletion,
      stat.cacheRead ?? 0,
      stat.cacheCreation ?? 0,
    );
    models.push(breakdown);
    totalInput += stat.totalPrompt;
    totalOutput += stat.totalCompletion;
    totalCacheRead += stat.cacheRead ?? 0;
    totalCacheCreation += stat.cacheCreation ?? 0;
    totalCost += breakdown.totalCost;
  }

  const cacheHitRate = totalInput > 0 ? (totalCacheRead / totalInput) * 100 : 0;

  // 节省金额 = 无缓存时的输入侧费用 − 有缓存时的实际输入侧费用。
  //   inputTokens 已是毛输入（含 cache_read + cache_creation），无缓存时全部
  //   按 inputPerMToken 计价；实际费用 = 净输入 + 缓存读 + 缓存写三段单价之和。
  //   两边都只算输入侧（output 费用一致，不参与节省比较）。
  const cacheSavings = models.reduce((sum, m) => {
    const pricing = resolvePricing(m.model);
    if (!pricing) return sum;
    const costWithoutCache = (m.inputTokens / 1_000_000) * pricing.inputPerMToken;
    const actualInputCost = m.inputCost + m.cacheReadCost + m.cacheCreationCost;
    return sum + (costWithoutCache - actualInputCost);
  }, 0);

  return {
    models,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreationTokens: totalCacheCreation,
    totalCost,
    cacheHitRate,
    cacheSavings,
  };
}

/**
 * 格式化 token 数量（自动选择 K/M 单位）
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * 格式化费用（美元）
 */
export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost > 0) return `$${cost.toFixed(4)}`;
  return '$0.00';
}

/**
 * 格式化 /cost 命令输出
 */
export function formatCostReport(summary: SessionCostSummary): string {
  const lines: string[] = [];

  for (const m of summary.models) {
    lines.push(`${m.model}:`);
    lines.push(`  ${formatTokens(m.inputTokens)} input, ${formatTokens(m.outputTokens)} output, ${formatTokens(m.cacheReadTokens)} cache read, ${formatTokens(m.cacheCreationTokens)} cache write`);
    lines.push(`  ${formatCost(m.inputCost)} + ${formatCost(m.outputCost)} + ${formatCost(m.cacheReadCost)} + ${formatCost(m.cacheCreationCost)} = ${formatCost(m.totalCost)}`);
    if (m.pricingMissing) {
      lines.push('  pricing unavailable');
    }
  }

  if (summary.models.length > 1) {
    lines.push('');
    lines.push('Total:');
    lines.push(`  ${formatTokens(summary.totalInputTokens)} input, ${formatTokens(summary.totalOutputTokens)} output, ${formatTokens(summary.totalCacheReadTokens)} cache read, ${formatTokens(summary.totalCacheCreationTokens)} cache write`);
  }

  lines.push('');
  lines.push(`Total cost: ${formatCost(summary.totalCost)}`);

  if (summary.totalCacheReadTokens > 0) {
    lines.push(`Cache hit rate: ${summary.cacheHitRate.toFixed(1)}%`);
    lines.push(`Cache savings: ${formatCost(summary.cacheSavings)}`);
  }

  return lines.join('\n');
}
