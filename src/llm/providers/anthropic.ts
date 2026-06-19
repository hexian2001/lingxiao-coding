/**
 * Anthropic provider configuration for Vercel AI SDK
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { VercelAIProviderConfig } from './index.js';

export function createAnthropicModel(config: VercelAIProviderConfig): LanguageModelV2 {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });
  return provider(config.apiModelName);
}
