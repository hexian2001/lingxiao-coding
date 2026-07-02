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

  // Third-party "OpenAI-compatible" gateways usually implement /chat/completions
  // even when they advertise OpenAI model names such as gpt-5.5. The AI SDK's
  // default provider(model) may route gpt-5* models to the Responses API and send
  // Responses-only fields such as max_output_tokens, which many gateways reject
  // with HTTP 400. Keep custom endpoints on chat unless the model config opts in.
  return config.wireApi === 'responses'
    ? provider.responses(config.apiModelName)
    : provider.chat(config.apiModelName);
}
