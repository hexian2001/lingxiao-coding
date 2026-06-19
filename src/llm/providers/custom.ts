/**
 * Custom OpenAI-compatible provider configuration for Vercel AI SDK
 *
 * Supports any endpoint that implements the OpenAI chat completions API
 * (e.g., Ollama, vLLM, LiteLLM, Together AI, Fireworks, etc.)
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { VercelAIProviderConfig } from './index.js';

export function createCustomModel(config: VercelAIProviderConfig): LanguageModelV2 {
  const provider = createOpenAI({
    apiKey: config.apiKey || 'sk-no-key',
    baseURL: config.baseUrl,
    name: 'custom',
  });
  return provider(config.apiModelName);
}
