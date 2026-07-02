/**
 * OpenAI provider configuration for Vercel AI SDK
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { VercelAIProviderConfig } from './index.js';

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com' || host.endsWith('.api.openai.com');
  } catch {
    return false;
  }
}

export function createOpenAIModel(config: VercelAIProviderConfig): LanguageModelV2 {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });

  // 非官方 OpenAI-compatible endpoint 默认只能假设支持 /chat/completions。
  // AI SDK 的 provider(model) 会按 gpt-5* 等模型名自动选择 Responses API，发送
  // max_output_tokens 等新字段；第三方网关常返回 400 unsupported/input-too-large。
  // 只有显式 wireApi=responses 或官方 OpenAI baseURL 才保留自动/Responses 路径。
  if (config.wireApi === 'chat' || (config.wireApi !== 'responses' && !isOfficialOpenAIBaseUrl(config.baseUrl))) {
    return provider.chat(config.apiModelName);
  }
  if (config.wireApi === 'responses') {
    return provider.responses(config.apiModelName);
  }
  return provider(config.apiModelName);
}
