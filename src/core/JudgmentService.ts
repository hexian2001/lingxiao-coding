import type { ContentGenerator, GenerateContentParams } from '../llm/ContentGenerator.js';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../llm/types.js';
import type { GatewayRequestContext } from '../llm/ModelGateway.js';
import { getReasoningSampling } from '../llm/reasoningSampling.js';

export type JudgmentStatus =
  | 'ok'
  | 'unavailable'
  | 'missing_tool_call'
  | 'invalid_json'
  | 'invalid_payload'
  | 'failed';

export interface JudgmentLogger {
  warn(message: string, error?: unknown): void;
}

export interface StructuredJudgmentResult<T> {
  verdict: T | null;
  status: JudgmentStatus;
  error?: unknown;
}

export interface JudgmentLlmGuardOptions {
  actorLabel: string;
  maxRetries?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  cbScope?: string;
}

export interface JudgmentLlmGuard {
  call(
    llm: ContentGenerator,
    messages: ChatMessage[],
    model: string,
    tools?: ToolDefinition[],
    streamingEnabled?: boolean,
    signal?: AbortSignal,
    hooks?: unknown,
    gatewayContext?: GatewayRequestContext,
    generateOptions?: Pick<GenerateContentParams, 'maxTokens' | 'sampling'>,
  ): Promise<ChatResponse>;
}

export type JudgmentLlmGuardFactory = (options: JudgmentLlmGuardOptions) => JudgmentLlmGuard;

let defaultLlmGuardFactory: JudgmentLlmGuardFactory | undefined;

export function configureJudgmentLlmGuardFactory(factory: JudgmentLlmGuardFactory | undefined): void {
  defaultLlmGuardFactory = factory;
}

export interface StructuredJudgmentInput<T> {
  kind: string;
  llm?: ContentGenerator;
  model?: string;
  messages: ChatMessage[];
  tool: ToolDefinition;
  validate: (payload: unknown) => T | null;
  llmGuardFactory?: JudgmentLlmGuardFactory;
  logger?: JudgmentLogger;
  maxTokens?: number;
  sampling?: GenerateContentParams['sampling'];
  gatewayContext?: GatewayRequestContext;
}

function findToolArguments(response: ChatResponse, toolName: string): string | null {
  const toolCall = response.tool_calls?.find((call) => call.function.name === toolName);
  return toolCall?.function.arguments ?? null;
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseStructuredToolVerdict<T>(
  response: ChatResponse,
  options: {
    kind: string;
    toolName: string;
    validate: (payload: unknown) => T | null;
    logger?: JudgmentLogger;
  },
): StructuredJudgmentResult<T> {
  const rawArguments = findToolArguments(response, options.toolName);
  if (!rawArguments) {
    options.logger?.warn(`[JudgmentService:${options.kind}] missing tool call ${options.toolName}`);
    return { verdict: null, status: 'missing_tool_call' };
  }

  const parsed = parseJson(rawArguments);
  if (!parsed.ok) {
    options.logger?.warn(`[JudgmentService:${options.kind}] invalid JSON tool arguments`, parsed.error);
    return { verdict: null, status: 'invalid_json', error: parsed.error };
  }

  const verdict = options.validate(parsed.value);
  if (verdict === null) {
    options.logger?.warn(`[JudgmentService:${options.kind}] invalid structured verdict payload`);
    return { verdict: null, status: 'invalid_payload' };
  }

  return { verdict, status: 'ok' };
}

export async function runStructuredJudgment<T>(
  input: StructuredJudgmentInput<T>,
): Promise<StructuredJudgmentResult<T>> {
  if (!input.llm || !input.model) {
    return { verdict: null, status: 'unavailable' };
  }
  const guardFactory = input.llmGuardFactory ?? defaultLlmGuardFactory;
  if (!guardFactory) {
    input.logger?.warn(`[JudgmentService:${input.kind}] LLM guard factory unavailable`);
    return { verdict: null, status: 'unavailable' };
  }

  try {
    const actorLabel = input.gatewayContext?.actorLabel || `Judgment:${input.kind}`;
    const guard = guardFactory({
      actorLabel,
      maxRetries: 1,
      backoffBaseMs: 0,
      cbScope: `judgment::${input.kind}`,
    });
    const response = await guard.call(
      input.llm,
      input.messages,
      input.model,
      [input.tool],
      false,
      undefined,
      undefined,
      {
        actorType: 'system',
        purpose: 'verify',
        actorLabel,
        requestedModel: input.model,
        ...input.gatewayContext,
      },
      {
        maxTokens: input.maxTokens,
        // 防漂移：所有结构化 judgment(NextSpeaker/EternalPatrol/WorkerCompletion/TaskClassifier)
        // 决定该停还是该续、是否验收——必须确定性。caller 未显式指定时默认走 reasoning 温度。
        sampling: input.sampling ?? getReasoningSampling(),
      },
    );

    return parseStructuredToolVerdict(response, {
      kind: input.kind,
      toolName: input.tool.function.name,
      validate: input.validate,
      logger: input.logger,
    });
  } catch (error) {
    input.logger?.warn(`[JudgmentService:${input.kind}] LLM judgment request failed`, error);
    return { verdict: null, status: 'failed', error };
  }
}
