import { z } from 'zod';
import { zodToJsonSchema } from './SchemaUtils.js';
import type { DatabaseManager } from '../core/Database.js';
import type { EventEmitter } from '../core/EventEmitter.js';
import type { MessageBus } from '../core/MessageBus.js';
import type { ContentGenerator } from '../llm/ContentGenerator.js';
import type { BlackboardGraph } from '../core/blackboard/BlackboardGraph.js';
import type { AssumptionTracker, VerificationBatch } from '../core/AssumptionTracker.js';
import type {
  ToolContract,
  ToolContext as ContractToolContext,
  ToolResult as ContractToolResult,
  ToolScope,
} from '../contracts/types/Tool.js';
import type { ContractAllowedScope } from '../core/ContractAllowedScope.js';

export interface ToolContext extends ContractToolContext {
  workspace?: string;
  db?: DatabaseManager;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  toolCallId?: string;
  emitter?: EventEmitter;
  bus?: MessageBus;
  permissionContext?: unknown;
  llm?: ContentGenerator;
  model?: string;
  taskId?: string;
  taskWorkingDirectory?: string;
  taskWriteScope?: string[];
  /** 契约结构化允许面——写工具执行前做 intersect 硬校验(只缩不放)。undefined=无契约→维持原 scope 检查。 */
  contractAllowedScope?: ContractAllowedScope;
  abortSignal?: AbortSignal;
  blackboardGraph?: BlackboardGraph;
  assumptionTracker?: AssumptionTracker;
  assumptionFeedback?: (batch: VerificationBatch) => void | Promise<void>;
  /** Per-role git author identity. When set, GitTool commit uses this as the commit author. */
  gitIdentity?: { name: string; email: string };
  [key: string]: unknown;
}

export interface ToolErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  cause?: string;
  fix?: string;
  hints?: unknown;
  candidates?: string[];
  next_tool?: { name: string; args?: Record<string, unknown> };
  example_args?: Record<string, unknown>;
  retry_args?: Record<string, unknown>;
}

export type ToolResult = ContractToolResult;

export function createToolError(input: ToolErrorEnvelope): ToolResult {
  return {
    success: false,
    data: { llm_recovery: input },
    error: `${input.message}\n\nLLM_RECOVERY=${JSON.stringify(input)}`,
  };
}

/**
 * emitToolOutput — 工具执行期间向 agent/leader 面板流式推送真实输出 chunk。
 *
 * 通用扩展点：任何工具在 execute() 期间调用即可把逐 chunk 输出（Shell/Python 的 stdout/stderr、
 * 长任务的阶段性输出等）推到工具卡片。SseBridge 按 agentId 分流：leader → leader:tool_output
 * （主对话卡片），worker → agent:tool_output（agent 面板）。一处调用，两端受益。
 *
 * 与 agent:tool_progress 心跳（纯 "运行 Ns" 文案）互补：本函数推真实内容。瞬时工具
 * （FileRead/Glob/WebSearch 等无逐 chunk 边界）不应调用——不造假流式（见记忆 no-heuristics）。
 * payload 字段对齐 Shell.ts:246 的事实标准（事件类型 'agent:tool_output' 见 EventEmitter.ts:282）。
 */
export function emitToolOutput(
  context: ToolContext | undefined,
  tool: string,
  payload: { chunk: string; stream?: 'stdout' | 'stderr'; pid?: number },
): void {
  if (!payload.chunk || !context?.emitter) return;
  context.emitter.emit('agent:tool_output', {
    agentId: String(context.agentId || ''),
    agentName: typeof context.agentName === 'string' ? context.agentName : undefined,
    sessionId: typeof context.sessionId === 'string' ? context.sessionId : undefined,
    taskId: typeof context.taskId === 'string' ? context.taskId : undefined,
    callId: typeof context.toolCallId === 'string' ? context.toolCallId : undefined,
    tool,
    chunk: payload.chunk,
    stream: payload.stream,
    pid: payload.pid,
  });
}

export abstract class Tool implements ToolContract {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: z.ZodTypeAny;
  readonly exposedParameters?: z.ZodTypeAny;
  readonly scope: ToolScope = 'worker';

  getExecutionTimeoutMs?(_args: unknown, _context?: ToolContext): number | null | undefined;

  abstract execute(args: unknown, context?: ToolContext): Promise<ToolResult>;

  protected schemaFromParameters(parameters: z.ZodTypeAny): Record<string, unknown> {
    return normalizeJsonSchemaForOpenAI(zodToJsonSchema(parameters));
  }

  getSchema(): Record<string, unknown> {
    return this.schemaFromParameters(this.exposedParameters ?? this.parameters);
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mergeTopLevelObjectVariants(variants: unknown[]): Record<string, unknown> {
  const objectVariants = variants.filter(isJsonRecord);
  const properties: Record<string, unknown> = {};
  const requiredSets: Array<Set<string>> = [];
  let additionalPropertiesFalse = objectVariants.length > 0;

  for (const variant of objectVariants) {
    if (isJsonRecord(variant.properties)) {
      Object.assign(properties, variant.properties);
    }
    requiredSets.push(new Set(stringArray(variant.required)));
    additionalPropertiesFalse = additionalPropertiesFalse && variant.additionalProperties === false;
  }

  const required = requiredSets.length > 0 && requiredSets.every((set) => set.size > 0)
    ? Array.from(requiredSets[0]).filter((field) => requiredSets.every((set) => set.has(field)) && field in properties)
    : [];

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(additionalPropertiesFalse ? { additionalProperties: false } : {}),
  };
}

/**
 * 把 zod toJSONSchema 输出 normalize 为 OpenAI API 网关接受的形式：
 *   1. 移除 `$schema`（部分网关如 Bedrock 不识别）。
 *   2. 顶层必须是 object；顶层 oneOf/anyOf/allOf/enum/not 会被展开/移除，避免 provider 400。
 *   3. 嵌套 schema 保持尽量原样，runtime 仍用 Zod 严格校验真实参数。
 */
export function normalizeJsonSchemaForOpenAI(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  const cleaned = removeJsonSchemaDialect(schema) as Record<string, unknown>;
  const composition = Array.isArray(cleaned.oneOf)
    ? cleaned.oneOf
    : Array.isArray(cleaned.anyOf)
      ? cleaned.anyOf
      : Array.isArray(cleaned.allOf)
        ? cleaned.allOf
        : undefined;

  if (composition) {
    const merged = mergeTopLevelObjectVariants(composition.map(removeJsonSchemaDialect));
    const out: Record<string, unknown> = {
      ...cleaned,
      ...merged,
      description: cleaned.description ?? merged.description,
    };
    delete out.oneOf;
    delete out.anyOf;
    delete out.allOf;
    delete out.enum;
    delete out.not;
    return out;
  }

  delete cleaned.oneOf;
  delete cleaned.anyOf;
  delete cleaned.allOf;
  delete cleaned.enum;
  delete cleaned.not;
  if (cleaned.type !== 'object') cleaned.type = 'object';
  if (!isJsonRecord(cleaned.properties)) cleaned.properties = {};
  return cleaned;
}

export function removeJsonSchemaDialect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeJsonSchemaDialect);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$schema') continue;
    out[key] = removeJsonSchemaDialect(nested);
  }
  return out;
}
