/**
 * Provider registry — unified factory for Vercel AI SDK language models
 *
 * Maps provider identifiers to their respective model constructors.
 * Extends ContentGeneratorConfig with additional fields needed by
 * non-OpenAI/Anthropic providers (Google, Bedrock, custom).
 */

import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { ContentGeneratorConfig } from '../ContentGenerator.js';
import { createAnthropicModel } from './anthropic.js';
import { createOpenAIModel } from './openai.js';
import { createGoogleModel } from './google.js';
import { createBedrockModel } from './bedrock.js';
import { createCustomModel } from './custom.js';

/**
 * Extended configuration for Vercel AI provider creation.
 * Superset of ContentGeneratorConfig with additional fields for
 * providers that need extra credentials (Bedrock) or settings.
 */
export interface VercelAIProviderConfig extends Omit<ContentGeneratorConfig, 'provider'> {
  /** Provider type — extended to include google, bedrock, custom */
  provider: 'openai' | 'anthropic' | 'google' | 'bedrock' | 'custom';
  /** AWS region (Bedrock) */
  region?: string;
  /** AWS access key ID (Bedrock) */
  accessKeyId?: string;
  /** AWS secret access key (Bedrock) */
  secretAccessKey?: string;
  /** AWS session token (Bedrock) */
  sessionToken?: string;
  /** Wire API hint for OpenAI-compatible providers. */
  wireApi?: 'chat' | 'responses';
}

/**
 * Create a Vercel AI SDK LanguageModel from provider configuration.
 */
export function createProviderModel(config: VercelAIProviderConfig): LanguageModelV2 {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicModel(config);
    case 'openai':
      return createOpenAIModel(config);
    case 'google':
      return createGoogleModel(config);
    case 'bedrock':
      return createBedrockModel(config);
    case 'custom':
      return createCustomModel(config);
    default: {
      // Fallback: treat unknown providers as custom OpenAI-compatible
      const exhaustive: never = config.provider;
      void exhaustive;
      return createCustomModel(config);
    }
  }
}
