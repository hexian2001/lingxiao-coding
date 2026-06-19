import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { ChatMessage, ToolCall, ToolDefinition } from '../llm/types.js';
import type { ToolRegistry } from '../tools/Registry.js';
import type { ToolResultContent } from './runtime/ToolResponseProcessor.js';
import type { AgentContextController } from './AgentContextController.js';
import type { AgentInterventionHandler } from './AgentInterventionHandler.js';

type LoggerLike = {
  debug?: (msg: string, ...args: unknown[]) => void;
};

export interface ToolCallResult {
  toolCall: ToolCall;
  result: ToolResultContent;
}

export interface RoundResult {
  messages: ChatMessage[];
  toolCalls: ToolCallResult[];
  shouldContinue: boolean;
  reason: 'tool_pending' | 'max_rounds' | 'no_tool_call' | 'interrupted' | 'overflow_recovered';
}

export interface AgentRoundExecutorDeps {
  llm: ContentGenerator;
  toolRegistry?: ToolRegistry;
  contextController?: AgentContextController;
  interventionHandler?: AgentInterventionHandler;
  logger?: LoggerLike;
  maxRounds?: number;
  model?: string;
}

export interface ExecuteRoundOptions {
  model?: string;
  tools?: ToolDefinition[];
  round?: number;
  signal?: AbortSignal;
  executeToolCall?: (toolCall: ToolCall) => Promise<ToolResultContent>;
}

export interface ExecuteRuntimeRoundOptions<T> {
  round: number;
  run: (signal: AbortSignal) => Promise<T>;
  onMaxRounds?: () => T | Promise<T>;
  onInterrupted?: () => T | Promise<T>;
}

export class AgentRoundExecutor {
  private readonly llm: ContentGenerator;
  private readonly toolRegistry?: ToolRegistry;
  private readonly contextController?: AgentContextController;
  private readonly interventionHandler?: AgentInterventionHandler;
  private readonly logger?: LoggerLike;
  private readonly maxRounds: number;
  private readonly model: string;

  constructor(deps: AgentRoundExecutorDeps) {
    this.llm = deps.llm;
    this.toolRegistry = deps.toolRegistry;
    this.contextController = deps.contextController;
    this.interventionHandler = deps.interventionHandler;
    this.logger = deps.logger;
    this.maxRounds = Math.max(1, deps.maxRounds ?? 10);
    this.model = deps.model ?? 'test-model';
  }

  async executeRuntimeRound<T>(options: ExecuteRuntimeRoundOptions<T>): Promise<T> {
    if (options.round > this.maxRounds) {
      if (options.onMaxRounds) {
        return options.onMaxRounds();
      }
      throw new Error(`AgentRoundExecutor max rounds exceeded: ${options.round}/${this.maxRounds}`);
    }

    const controller = new AbortController();
    this.interventionHandler?.attach(controller);
    try {
      return await options.run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted && options.onInterrupted) {
        this.logger?.debug?.('AgentRoundExecutor runtime round interrupted', error);
        return options.onInterrupted();
      }
      throw error;
    } finally {
      this.interventionHandler?.detach();
    }
  }

  async executeRound(
    messages: ChatMessage[],
    systemPrompt: string,
    options: ExecuteRoundOptions = {},
  ): Promise<RoundResult> {
    if ((options.round ?? 1) > this.maxRounds) {
      return { messages, toolCalls: [], shouldContinue: false, reason: 'max_rounds' };
    }

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        return { messages, toolCalls: [], shouldContinue: false, reason: 'interrupted' };
      }
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
    }
    this.interventionHandler?.attach(controller);

    try {
      const ensuredMessages = this.ensureSystemPrompt(messages, systemPrompt);
      const outboundMessages = this.contextController
        ? this.contextController.trimMessageBuffer(ensuredMessages, 1)
        : ensuredMessages;
      const definitions = options.tools ?? this.toolRegistry?.getDefinitions(undefined, { scope: 'worker' });
      const response = await this.llm.generateContent({
        messages: outboundMessages,
        model: options.model ?? this.model,
        tools: definitions,
        signal: controller.signal,
      });

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content,
        thinking: response.thinking,
        tool_calls: response.tool_calls,
        timestamp: Date.now() / 1000,
      };
      let nextMessages = this.contextController
        ? this.contextController.addMessage(assistantMessage, outboundMessages)
        : [...outboundMessages, assistantMessage];

      const toolCalls = response.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return { messages: nextMessages, toolCalls: [], shouldContinue: false, reason: 'no_tool_call' };
      }

      const results: ToolCallResult[] = [];
      if (options.executeToolCall) {
        for (const toolCall of toolCalls) {
          const result = await options.executeToolCall(toolCall);
          results.push({ toolCall, result });
          const toolMessage: ChatMessage = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
            timestamp: Date.now() / 1000,
          };
          nextMessages = this.contextController
            ? this.contextController.addMessage(toolMessage, nextMessages)
            : [...nextMessages, toolMessage];
        }
      }

      return { messages: nextMessages, toolCalls: results, shouldContinue: true, reason: 'tool_pending' };
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger?.debug?.('AgentRoundExecutor interrupted', error);
        return { messages, toolCalls: [], shouldContinue: false, reason: 'interrupted' };
      }
      throw error;
    } finally {
      this.interventionHandler?.detach();
    }
  }

  private ensureSystemPrompt(messages: ChatMessage[], systemPrompt: string): ChatMessage[] {
    if (messages[0]?.role === 'system') {
      return messages;
    }
    return [{ role: 'system', content: systemPrompt, timestamp: Date.now() / 1000 }, ...messages];
  }
}

export default AgentRoundExecutor;
