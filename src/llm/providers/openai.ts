/**
 * OpenAI provider configuration for Vercel AI SDK
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { VercelAIProviderConfig } from './index.js';

export function createOpenAIModel(config: VercelAIProviderConfig): LanguageModelV2 {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });
  return provider(config.apiModelName);
}
