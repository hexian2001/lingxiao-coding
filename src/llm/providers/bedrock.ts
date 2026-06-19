/**
 * Amazon Bedrock provider configuration for Vercel AI SDK
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { VercelAIProviderConfig } from './index.js';

export function createBedrockModel(config: VercelAIProviderConfig): LanguageModelV2 {
  const provider = createAmazonBedrock({
    region: config.region ?? 'us-east-1',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
  });
  return provider(config.apiModelName);
}
