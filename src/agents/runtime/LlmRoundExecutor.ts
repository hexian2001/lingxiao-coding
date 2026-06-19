import type {
  ChatMessage,
  ChatResponse,
  LlmRoundEvent,
  StreamCallbacks,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../../llm/types.js';
import type { ContentGenerator, GenerateContentParams, StreamEvent } from '../../llm/ContentGenerator.js';
import { createLlmGuard } from '../LlmGuard.js';
import type { GatewayRequestContext } from '../../llm/ModelGateway.js';

type LlmRoundGenerateOptions = Pick<GenerateContentParams, 'maxTokens' | 'sampling'>;

export interface LlmRoundHooks<TError extends Error = Error> {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolCallDelta?: (delta: { index: number; id?: string; name?: string; partialJson: string }) => void;
  onProgress?: (progress: { elapsed: number; status: string }) => void;
  onRetry?: (attempt: number, error: TError) => void;
  onError?: (error: TError) => void;
  onUsage?: (usage: TokenUsage) => void;
  onStreamRetry?: (attempt: number, error: TError) => void;
  onFirstToken?: () => void;
}

export interface ExecuteLlmRoundOptions<TError extends Error = Error> {
  actorLabel: string;
  llm: ContentGenerator;
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  streamingEnabled: boolean;
  signal?: AbortSignal;
  classifyError?: (error: unknown) => TError;
  hooks?: LlmRoundHooks<TError>;
  gatewayContext?: GatewayRequestContext;
  generateOptions?: LlmRoundGenerateOptions;
}

export interface LlmRoundEventStream {
  events: AsyncIterable<LlmRoundEvent>;
  response: Promise<ChatResponse>;
}

function hooksFromStreamCallbacks(callbacks?: StreamCallbacks): LlmRoundHooks<Error> | undefined {
  if (!callbacks) {
    return undefined;
  }
  return {
    onText: callbacks.onText,
    onThinking: callbacks.onThinking,
    onToolCall: callbacks.onToolCall,
    onToolCallDelta: callbacks.onToolCallDelta,
    onUsage: callbacks.onUsage,
    onProgress: callbacks.onProgress,
    onRetry: callbacks.onRetry,
    onError: callbacks.onError,
    onStreamRetry: callbacks.onStreamRetry,
    onFirstToken: callbacks.onFirstToken,
  };
}

function chainHooks<TError extends Error>(
  first?: LlmRoundHooks<TError>,
  second?: LlmRoundHooks<TError>,
): LlmRoundHooks<TError> | undefined {
  if (!first && !second) {
    return undefined;
  }
  return {
    onText: (text) => {
      first?.onText?.(text);
      second?.onText?.(text);
    },
    onThinking: (thinking) => {
      first?.onThinking?.(thinking);
      second?.onThinking?.(thinking);
    },
    onToolCall: (toolCall) => {
      first?.onToolCall?.(toolCall);
      second?.onToolCall?.(toolCall);
    },
    onToolCallDelta: (delta) => {
      first?.onToolCallDelta?.(delta);
      second?.onToolCallDelta?.(delta);
    },
    onUsage: (usage) => {
      first?.onUsage?.(usage);
      second?.onUsage?.(usage);
    },
    onProgress: (progress) => {
      first?.onProgress?.(progress);
      second?.onProgress?.(progress);
    },
    onRetry: (attempt, error) => {
      first?.onRetry?.(attempt, error);
      second?.onRetry?.(attempt, error);
    },
    onError: (error) => {
      first?.onError?.(error);
      second?.onError?.(error);
    },
    onStreamRetry: (attempt, error) => {
      first?.onStreamRetry?.(attempt, error);
      second?.onStreamRetry?.(attempt, error);
    },
    onFirstToken: () => {
      first?.onFirstToken?.();
      second?.onFirstToken?.();
    },
  };
}

function normalizeError<TError extends Error>(
  error: unknown,
  classifyError?: (error: unknown) => TError,
): TError {
  if (classifyError) {
    return classifyError(error);
  }
  if (error instanceof Error) {
    return error as TError;
  }
  return new Error(String(error)) as TError;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined as unknown as T, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

export function createLlmRoundEventStream<TError extends Error = Error>(
  options: ExecuteLlmRoundOptions<TError>,
): LlmRoundEventStream {
  const queue = new AsyncEventQueue<LlmRoundEvent>();
  const baseHooks = options.hooks;

  const hooks: LlmRoundHooks<TError> = {
    onText: (text) => {
      queue.push({ type: 'text', text });
      baseHooks?.onText?.(text);
    },
    onThinking: (thinking) => {
      queue.push({ type: 'thinking', thinking });
      baseHooks?.onThinking?.(thinking);
    },
    onToolCall: (toolCall) => {
      queue.push({ type: 'tool_call', toolCall });
      baseHooks?.onToolCall?.(toolCall);
    },
    onToolCallDelta: (delta) => {
      queue.push({ type: 'tool_call_delta', delta });
      baseHooks?.onToolCallDelta?.(delta);
    },
    onUsage: (usage) => {
      queue.push({ type: 'usage', usage });
      baseHooks?.onUsage?.(usage);
    },
    onProgress: (progress) => {
      queue.push({ type: 'progress', progress });
      baseHooks?.onProgress?.(progress);
    },
    onRetry: (attempt, error) => {
      queue.push({ type: 'retry', attempt, error });
      baseHooks?.onRetry?.(attempt, error);
    },
    onError: (error) => {
      queue.push({ type: 'error', error });
      baseHooks?.onError?.(error);
    },
    onStreamRetry: (attempt, error) => {
      queue.push({ type: 'stream_retry', attempt, error });
      baseHooks?.onStreamRetry?.(attempt, error);
    },
    onFirstToken: () => {
      queue.push({ type: 'first_token' });
      baseHooks?.onFirstToken?.();
    },
  };

  const response = executeLlmRound({ ...options, hooks })
    .catch((error) => {
      const normalized = normalizeError(error, options.classifyError);
      queue.push({ type: 'error', error: normalized });
      throw error;
    })
    .finally(() => {
      queue.close();
    });

  return { events: queue, response };
}

export function createEventStreamClient<TError extends Error = Error>(options: {
  actorLabel: string;
  llm: ContentGenerator;
  classifyError?: (error: unknown) => TError;
  hooks?: LlmRoundHooks<TError>;
  gatewayContext?: GatewayRequestContext;
}): ContentGenerator {
  const createCall = (params: GenerateContentParams) => createLlmRoundEventStream({
    actorLabel: options.actorLabel,
    llm: options.llm,
    messages: params.messages,
    model: params.model,
    tools: params.tools,
    streamingEnabled: true,
    signal: params.signal,
    classifyError: options.classifyError,
    gatewayContext: options.gatewayContext,
    generateOptions: {
      maxTokens: params.maxTokens,
      sampling: params.sampling,
    },
  });

  const makeCall = async (params: GenerateContentParams, callbacks?: StreamCallbacks) => {
    const mergedHooks = chainHooks(options.hooks, hooksFromStreamCallbacks(callbacks) as LlmRoundHooks<TError>);
    const { events, response } = createCall(params);
    const consume = consumeLlmRoundEvents(events, mergedHooks, { signal: params.signal });
    const result = await response;
    await consume;
    return result;
  };

  return {
    generateContent: async (params) => {
      return makeCall(params);
    },
    generateContentStream: async function* (params, callbacks) {
      const mergedHooks = chainHooks(options.hooks, hooksFromStreamCallbacks(callbacks) as LlmRoundHooks<TError>);
      const { events, response } = createCall(params);
      try {
        for await (const event of events) {
          if (event.type === 'text') {
            mergedHooks?.onText?.(event.text);
            yield { type: 'text', text: event.text } satisfies StreamEvent;
          } else if (event.type === 'thinking') {
            mergedHooks?.onThinking?.(event.thinking);
            yield { type: 'thinking', text: event.thinking } satisfies StreamEvent;
          } else if (event.type === 'tool_call') {
            mergedHooks?.onToolCall?.(event.toolCall);
            yield { type: 'tool_call', toolCall: event.toolCall } satisfies StreamEvent;
          } else if (event.type === 'tool_call_delta') {
            mergedHooks?.onToolCallDelta?.(event.delta);
            yield { type: 'tool_call_delta', delta: event.delta } satisfies StreamEvent;
          } else if (event.type === 'usage') {
            mergedHooks?.onUsage?.(event.usage);
            yield { type: 'usage', usage: event.usage } satisfies StreamEvent;
          } else if (event.type === 'retry') {
            mergedHooks?.onRetry?.(event.attempt, event.error as TError);
          } else if (event.type === 'stream_retry') {
            mergedHooks?.onStreamRetry?.(event.attempt, event.error as TError);
          } else if (event.type === 'first_token') {
            mergedHooks?.onFirstToken?.();
          } else if (event.type === 'progress') {
            mergedHooks?.onProgress?.(event.progress);
          } else if (event.type === 'error') {
            mergedHooks?.onError?.(event.error as TError);
            yield { type: 'error', error: event.error } satisfies StreamEvent;
          }
        }
        return await response;
      } catch (error) {
        try { await response; } catch { /* preserve original stream error */ }
        throw error;
      }
    },
    generateContentWithCallbacks: async (params, callbacks) => {
      return makeCall(params, callbacks);
    },
    countTokens: (params) => options.llm.countTokens(params),
    close: () => options.llm.close(),
  } as ContentGenerator;
}

export async function consumeLlmRoundEvents<TError extends Error = Error>(
  events: AsyncIterable<LlmRoundEvent>,
  hooks?: LlmRoundHooks<TError>,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return;
  }

  const iterator = events[Symbol.asyncIterator]();
  const abortPromise = signal
    ? new Promise<IteratorResult<LlmRoundEvent>>((resolve) => {
        if (signal.aborted) {
          resolve({ value: undefined as unknown as LlmRoundEvent, done: true });
          return;
        }
        const onAbort = () => {
          resolve({ value: undefined as unknown as LlmRoundEvent, done: true });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  const nextEvent = async (): Promise<IteratorResult<LlmRoundEvent>> => {
    if (!signal) {
      return iterator.next();
    }
    if (signal.aborted) {
      return { value: undefined as unknown as LlmRoundEvent, done: true };
    }
    return abortPromise ? Promise.race([iterator.next(), abortPromise]) : iterator.next();
  };

  const closeIterator = async () => {
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Ignore iterator close failures on abort.
      }
    }
  };

  if (!hooks) {
    while (true) {
      const result = await nextEvent();
      if (result.done) {
        break;
      }
    }
    if (signal?.aborted) {
      await closeIterator();
    }
    return;
  }

  while (true) {
    const result = await nextEvent();
    if (result.done) {
      break;
    }
    const event = result.value;
    // Check abort again after receiving event (handles queued events)
    if (signal?.aborted) {
      break;
    }
    if (event.type === 'text') {
      hooks.onText?.(event.text);
    } else if (event.type === 'thinking') {
      hooks.onThinking?.(event.thinking);
    } else if (event.type === 'tool_call') {
      hooks.onToolCall?.(event.toolCall);
    } else if (event.type === 'tool_call_delta') {
      hooks.onToolCallDelta?.(event.delta);
    } else if (event.type === 'usage') {
      hooks.onUsage?.(event.usage);
    } else if (event.type === 'progress') {
      hooks.onProgress?.(event.progress);
    } else if (event.type === 'retry') {
      hooks.onRetry?.(event.attempt, event.error as TError);
    } else if (event.type === 'stream_retry') {
      hooks.onStreamRetry?.(event.attempt, event.error as TError);
    } else if (event.type === 'first_token') {
      hooks.onFirstToken?.();
    } else if (event.type === 'error') {
      hooks.onError?.(event.error as TError);
    }
  }
  if (signal?.aborted) {
    await closeIterator();
  }
}

export async function executeLlmRound<TError extends Error = Error>(
  options: ExecuteLlmRoundOptions<TError>,
): Promise<ChatResponse> {
  const {
    actorLabel,
    llm,
    messages,
    model,
    tools,
    streamingEnabled,
    signal,
    classifyError,
    hooks,
    gatewayContext,
    generateOptions,
  } = options;


  const callbacks: StreamCallbacks = {
    onText: hooks?.onText,
    onThinking: hooks?.onThinking,
    onToolCall: hooks?.onToolCall,
    onToolCallDelta: hooks?.onToolCallDelta,
    onUsage: hooks?.onUsage,
    onProgress: hooks?.onProgress,
    onRetry: hooks?.onRetry
      ? (attempt, error) => hooks.onRetry?.(attempt, normalizeError(error, classifyError))
      : undefined,
    onError: hooks?.onError
      ? (error) => hooks.onError?.(normalizeError(error, classifyError))
      : undefined,
    onStreamRetry: hooks?.onStreamRetry
      ? (attempt, error) => hooks.onStreamRetry?.(attempt, normalizeError(error, classifyError))
      : undefined,
    onFirstToken: hooks?.onFirstToken,
  };

  const guard = createLlmGuard({
    actorLabel,
  });

  return guard.call(
    llm,
    messages,
    model,
    tools,
    streamingEnabled,
    signal,
    callbacks,
    {
      actorLabel,
      requestedModel: model,
      ...gatewayContext,
    },
    generateOptions,
  );
}
