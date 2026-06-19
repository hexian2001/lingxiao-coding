/**
 * Google Generative AI provider configuration for Vercel AI SDK
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { VercelAIProviderConfig } from './index.js';

export function createGoogleModel(config: VercelAIProviderConfig): LanguageModelV2 {
  const provider = createGoogleGenerativeAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });
  return provider(config.apiModelName);
}
