import type { ContentGenerator } from '../../llm/ContentGenerator.js';
import { classifyLLMError } from '../../llm/errors.js';
import { createEventStreamClient, type LlmRoundHooks } from '../runtime/LlmRoundExecutor.js';

export type LeaderLlmRoundHooks = LlmRoundHooks;

export interface LeaderLlmSessionClientOptions {
  actorLabel: string;
  sessionId: string;
  llm: ContentGenerator;
  hooks?: LlmRoundHooks;
}

export function createLeaderLlmSessionClient(options: LeaderLlmSessionClientOptions): ContentGenerator {
  return createEventStreamClient({
    actorLabel: options.actorLabel,
    llm: options.llm,
    classifyError: classifyLLMError,
    hooks: options.hooks,
    gatewayContext: {
      actorType: 'leader',
      actorLabel: options.actorLabel,
      purpose: 'leader',
      sessionId: options.sessionId,
    },
  });
}
