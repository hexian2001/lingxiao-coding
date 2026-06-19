/**
 * costCalculator.ts — Frontend cost calculation utility
 *
 * Lightweight version of backend CostService for real-time cost display in the UI.
 * Uses the same pricing data as the backend.
 */

import type { TokenUsageView } from '@contracts/types/TokenUsage';

export interface ModelPricing {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheReadPerMToken: number;
  cacheCreationPerMToken: number;
}

export type ModelPricingResolution = ModelPricing & {
  estimated: boolean;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude
  'claude-opus-4-5': { inputPerMToken: 15, outputPerMToken: 75, cacheReadPerMToken: 1.5, cacheCreationPerMToken: 18.75 },
  'claude-sonnet-4-5': { inputPerMToken: 3, outputPerMToken: 15, cacheReadPerMToken: 0.3, cacheCreationPerMToken: 3.75 },
  'claude-3-5-haiku-20241022': { inputPerMToken: 0.8, outputPerMToken: 4, cacheReadPerMToken: 0.08, cacheCreationPerMToken: 1 },
  'claude-3-opus-20240229': { inputPerMToken: 15, outputPerMToken: 75, cacheReadPerMToken: 1.5, cacheCreationPerMToken: 18.75 },
  'claude-3-sonnet-20240229': { inputPerMToken: 3, outputPerMToken: 15, cacheReadPerMToken: 0.3, cacheCreationPerMToken: 3.75 },
  'claude-3-haiku-20240307': { inputPerMToken: 0.25, outputPerMToken: 1.25, cacheReadPerMToken: 0.03, cacheCreationPerMToken: 0.3 },

  // OpenAI GPT
  'gpt-4o': { inputPerMToken: 2.5, outputPerMToken: 10, cacheReadPerMToken: 1.25, cacheCreationPerMToken: 2.5 },
  'gpt-4o-mini': { inputPerMToken: 0.15, outputPerMToken: 0.6, cacheReadPerMToken: 0.075, cacheCreationPerMToken: 0.15 },
  'gpt-4-turbo': { inputPerMToken: 10, outputPerMToken: 30, cacheReadPerMToken: 5, cacheCreationPerMToken: 10 },
  'gpt-4': { inputPerMToken: 30, outputPerMToken: 60, cacheReadPerMToken: 15, cacheCreationPerMToken: 30 },
  'gpt-3.5-turbo': { inputPerMToken: 0.5, outputPerMToken: 1.5, cacheReadPerMToken: 0.25, cacheCreationPerMToken: 0.5 },
  'o3-mini': { inputPerMToken: 1.1, outputPerMToken: 4.4, cacheReadPerMToken: 0.55, cacheCreationPerMToken: 1.1 },
  'o4-mini': { inputPerMToken: 1.1, outputPerMToken: 4.4, cacheReadPerMToken: 0.55, cacheCreationPerMToken: 1.1 },

  // DeepSeek
  'deepseek-chat': { inputPerMToken: 0.14, outputPerMToken: 0.28, cacheReadPerMToken: 0.014, cacheCreationPerMToken: 0.14 },
  'deepseek-reasoner': { inputPerMToken: 0.55, outputPerMToken: 2.19, cacheReadPerMToken: 0.14, cacheCreationPerMToken: 0.55 },

  // Moonshot/Kimi
  'kimi-k2.5': { inputPerMToken: 0.6, outputPerMToken: 2.4, cacheReadPerMToken: 0.15, cacheCreationPerMToken: 0.6 },
  'moonshot-v1-128k': { inputPerMToken: 0.6, outputPerMToken: 2.4, cacheReadPerMToken: 0.15, cacheCreationPerMToken: 0.6 },

  // Qwen
  'qwen-plus': { inputPerMToken: 0.8, outputPerMToken: 2, cacheReadPerMToken: 0.2, cacheCreationPerMToken: 0.8 },
  'qwen-turbo': { inputPerMToken: 0.3, outputPerMToken: 0.6, cacheReadPerMToken: 0.03, cacheCreationPerMToken: 0.3 },
  'qwen-max': { inputPerMToken: 2.4, outputPerMToken: 9.6, cacheReadPerMToken: 0.6, cacheCreationPerMToken: 2.4 },

  // Google Gemini
  'gemini-2.0-flash': { inputPerMToken: 0.1, outputPerMToken: 0.4, cacheReadPerMToken: 0.025, cacheCreationPerMToken: 0.1 },
  'gemini-1.5-pro': { inputPerMToken: 1.25, outputPerMToken: 5, cacheReadPerMToken: 0.3125, cacheCreationPerMToken: 1.25 },
};

const DEFAULT_PRICING: ModelPricing = {
  inputPerMToken: 3,
  outputPerMToken: 15,
  cacheReadPerMToken: 0.3,
  cacheCreationPerMToken: 3.75,
};

export function resolveModelPricing(modelName: string): ModelPricingResolution {
  const model = modelName.trim();
  if (!model) return { ...DEFAULT_PRICING, estimated: true };
  const exact = MODEL_PRICING[model] ?? MODEL_PRICING[model.toLowerCase()];
  return exact ? { ...exact, estimated: false } : { ...DEFAULT_PRICING, estimated: true };
}

export type TokenUsageInput = Pick<TokenUsageView, 'prompt' | 'completion' | 'cache_read' | 'cache_creation'>;

export function calculateCost(
  modelName: string,
  usage: TokenUsageInput,
  pricingOverride?: ModelPricing,
): number {
  const pricing = pricingOverride ?? resolveModelPricing(modelName);
  const cacheRead = usage.cache_read ?? 0;
  const cacheCreation = usage.cache_creation ?? 0;
  const netInput = Math.max(0, usage.prompt - cacheRead - cacheCreation);
  return (
    (netInput / 1_000_000) * pricing.inputPerMToken +
    (usage.completion / 1_000_000) * pricing.outputPerMToken +
    (cacheRead / 1_000_000) * pricing.cacheReadPerMToken +
    (cacheCreation / 1_000_000) * pricing.cacheCreationPerMToken
  );
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost > 0) return `$${cost.toFixed(4)}`;
  return '$0.00';
}
