import type { EventEmitter } from '../../core/EventEmitter.js';
import type { StreamCallbacks } from '../../llm/types.js';
import {
  createStreamHookBuffers,
  type StreamHookBuffers,
  wrapLlmHooksForEmitter,
} from '../runtime/LlmStreamHooks.js';

export interface LeaderStreamBufferSession {
  buffers: StreamHookBuffers;
  hooks: StreamCallbacks;
}

export interface LeaderStreamBufferOptions {
  emitter: EventEmitter;
  sessionId: string;
  flushThreshold: number;
  logToolCall?: (name: string) => void;
}

export function createLeaderStreamBufferSession(options: LeaderStreamBufferOptions): LeaderStreamBufferSession {
  const buffers = createStreamHookBuffers({
    scope: 'leader',
    emitter: options.emitter,
    sessionId: options.sessionId,
    flushThreshold: options.flushThreshold,
  });

  return {
    buffers,
    hooks: wrapLlmHooksForEmitter(
      {
        scope: 'leader',
        emitter: options.emitter,
        sessionId: options.sessionId,
        logToolCall: options.logToolCall,
      },
      buffers,
    ),
  };
}
