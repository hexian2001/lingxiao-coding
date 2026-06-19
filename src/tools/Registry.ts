import { z } from 'zod';
import Ajv, { type ErrorObject } from 'ajv';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { Tool, createToolError, normalizeJsonSchemaForOpenAI, type ToolContext, type ToolResult } from './Tool.js';
import { getToolMetadata, requiresReadFirst, type ToolMetadata } from './ToolMetadata.js';
import { SESSION_KEYS } from '../core/SessionStateKeys.js';
import { auditOfficeToolExecution } from './implementations/office/OfficeAuditLog.js';
import { auditModeEvent } from '../core/ModeAudit.js';
import { isOfficeToolName } from './officeToolContract.js';
import { config as runtimeConfig } from '../config.js';
import {
  evaluateToolPermission,
  getToolPermissionContextFromToolContext,
} from '../core/PermissionSystem.js';
import { resolveModeRuntimeProjection, type ModeRuntimeProjection } from '../core/ModeRuntimeProjection.js';
import {
  resolveModeToolDecision,
  type ModeToolActor,
  type ModeToolDecision,
} from '../core/ModeToolPolicy.js';
import { getTeamMemberRegistry } from '../core/TeamMailbox.js';
import type { DatabaseManager } from '../core/Database.js';
import { normalizeToolResult, type JsonSchema, type ToolContract, type ToolScope } from '../contracts/types/Tool.js';
import { getPromptCatalog } from '../agents/prompts/i18n/catalog.js';

// ── "File must be read first" 保护 ──────────────────────────────────────────

type RegisteredTool = ToolContract;

export interface ToolInspection {
  name: string;
  description: string;
  loaded: boolean;
  deferred: boolean;
  metadata: ToolMetadata;
  schema?: JsonSchema;
  example_args?: Record<string, unknown>;
}

export interface ToolPreflightResult {
  ok: boolean;
  tool: string;
  found: boolean;
  schema?: JsonSchema;
  metadata: ToolMetadata;
  normalizedArgs?: unknown;
  repair?: {
    code: string;
    message: string;
    fix: string;
    hints?: unknown;
    candidates?: string[];
    next_tool?: { name: string; args?: Record<string, unknown> };
    example_args?: Record<string, unknown>;
    retry_args?: Record<string, unknown>;
  };
}

interface LlmRecoveryDto {
  code?: string;
  message?: string;
  fix?: string;
  hints?: unknown;
  candidates?: string[];
  next_tool?: { name: string; args?: Record<string, unknown> };
  example_args?: Record<string, unknown>;
  retry_args?: Record<string, unknown>;
}

const jsonSchemaValidator = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});

const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 60_000;

function normalizeExecutionTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : undefined;
}

function resolveToolExecutionTimeoutMs(tool: RegisteredTool, parsedArgs: unknown, context?: ToolContext): number {
  const toolSpecificTimeout = normalizeExecutionTimeoutMs(tool.getExecutionTimeoutMs?.(parsedArgs, context));
  if (toolSpecificTimeout !== undefined) {
    return toolSpecificTimeout;
  }
  const contextTimeout = typeof context?.toolExecutionTimeoutMs === 'number'
    ? context.toolExecutionTimeoutMs
    : typeof context?.executionTimeoutMs === 'number'
      ? context.executionTimeoutMs
      : undefined;
  const configured = contextTimeout ?? runtimeConfig.tools?.execution_timeout_ms ?? DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.min(600_000, Math.floor(configured))
    : DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatToolTimeoutError(name: string, timeoutMs: number): string {
  return `TOOL_TIMEOUT: 工具 "${name}" 执行 watchdog 超过 ${timeoutMs}ms，已中止本次调用。请缩小输入范围、降低并发，或为该工具设置更合适的 timeout 后重试。`;
}

function formatToolAbortedError(name: string): string {
  return `TOOL_ABORTED: 工具 "${name}" 已被中止。`;
}

async function executeToolWithTimeout(
  name: string,
  tool: RegisteredTool,
  parsedArgs: unknown,
  context: ToolContext | undefined,
): Promise<ToolResult> {
  const timeoutMs = resolveToolExecutionTimeoutMs(tool, parsedArgs, context);
  const timeoutController = new AbortController();
  const upstreamSignal = context?.abortSignal;
  const signal = upstreamSignal
    ? AbortSignal.any([upstreamSignal, timeoutController.signal])
    : timeoutController.signal;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortCleanup: (() => void) | undefined;

  const toolContext = { ...(context || {}), abortSignal: signal };
  try {
    if (signal.aborted) {
      return { success: false, data: null, error: formatToolAbortedError(name) };
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(formatToolTimeoutError(name, timeoutMs));
        reject(new Error(formatToolTimeoutError(name, timeoutMs)));
      }, timeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error(formatToolAbortedError(name)));
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', onAbort);
    });
    const result = await Promise.race([
      Promise.resolve(tool.execute(parsedArgs, toolContext)),
      timeoutPromise,
      abortPromise,
    ]);
    return normalizeToolResult(result);
  } catch (error) {
    return {
      success: false,
      data: null,
      error: timedOut
        ? formatToolTimeoutError(name, timeoutMs)
        : isAbortError(error)
          ? formatToolAbortedError(name)
          : error instanceof Error ? error.message : String(error),
    };
  } finally {
    abortCleanup?.();
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function extractLlmRecovery(data: unknown): LlmRecoveryDto | undefined {
  const recovery = isRecord(data) ? data.llm_recovery : undefined;
  if (!isRecord(recovery)) return undefined;

  const nextTool = isRecord(recovery.next_tool) && typeof recovery.next_tool.name === 'string'
    ? {
      name: recovery.next_tool.name,
      ...(isRecord(recovery.next_tool.args) ? { args: recovery.next_tool.args } : {}),
    }
    : undefined;
  const candidates = stringArray(recovery.candidates);
  const exampleArgs = recordValue(recovery.example_args);
  const retryArgs = recordValue(recovery.retry_args);

  const dto: LlmRecoveryDto = {
    ...(typeof recovery.code === 'string' ? { code: recovery.code } : {}),
    ...(typeof recovery.message === 'string' ? { message: recovery.message } : {}),
    ...(typeof recovery.fix === 'string' ? { fix: recovery.fix } : {}),
    ...('hints' in recovery ? { hints: recovery.hints } : {}),
    ...(candidates ? { candidates } : {}),
    ...(nextTool ? { next_tool: nextTool } : {}),
    ...(exampleArgs ? { example_args: exampleArgs } : {}),
    ...(retryArgs ? { retry_args: retryArgs } : {}),
  };

  return Object.keys(dto).length > 0 ? dto : undefined;
}

export type ToolDefinitionScope = ToolScope | 'all';

export interface ToolDefinitionOptions {
  scope?: ToolDefinitionScope;
  modePolicy?: ToolDefinitionModePolicyOptions;
}

export interface ToolDefinitionModePolicyOptions {
  modes: ModeRuntimeProjection;
  actor?: ModeToolActor;
  agentName?: string;
  callerInTeamRoster?: boolean;
  callerIsTeamLeader?: boolean;
  allowSoloEphemeralDispatch?: boolean;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function parseArgsText(args: unknown): { ok: true; value: unknown } | { ok: false; message: string; cause: string; rawPreview?: string } {
  if (typeof args !== 'string') return { ok: true, value: args };
  return {
    ok: false,
    message: '工具参数必须直接传结构化 JSON 值，不接受 JSON 字符串容器。',
    cause: 'top-level string tool arguments are not accepted',
    rawPreview: `${args.slice(0, 200)}${args.length > 200 ? '...' : ''}`,
  };
}

function exampleValueForSchema(schema: unknown, key?: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'value';
  const s = schema as Record<string, unknown>;
  if ('default' in s) return s.default;
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if ('const' in s) return s.const;
  const lowerKey = (key || '').toLowerCase();
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'array') return [exampleValueForSchema(s.items)];
  if (type === 'object' || Array.isArray(s.oneOf) || Array.isArray(s.anyOf) || Array.isArray(s.allOf)) {
    return exampleArgsFromSchema(s);
  }
  if (lowerKey === 'request_id' || lowerKey.endsWith('_request_id')) return '<request-id>';
  if (lowerKey === 'worker_name') return '<worker-name>';
  if (lowerKey === 'agent_name' || lowerKey.endsWith('_agent_name')) return 'Sam';
  if (lowerKey === 'task_id' || lowerKey.endsWith('_task_id')) return 'T-1';
  if (lowerKey === 'team_name') return '<team-name>';
  if (lowerKey === 'tool_name') return 'shell';
  if (lowerKey === 'reason') return '需要完成当前任务的必要操作';
  if (lowerKey === 'summary') return '已完成本轮目标';
  if (lowerKey.includes('path')) return 'src/index.ts';
  if (lowerKey.includes('url')) return 'https://example.com';
  if (lowerKey.includes('query')) return 'search terms';
  if (lowerKey.includes('command')) return 'pwd';
  if (lowerKey.includes('selector')) return 'body';
  if (lowerKey.includes('content') || lowerKey.includes('text') || lowerKey.includes('message')) return 'text';
  return 'value';
}

function schemaVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  return variants?.filter(isRecord) ?? [];
}

function selectSchemaForArgs(schema: JsonSchema | Record<string, unknown>, args?: unknown): Record<string, unknown> {
  const variants = schemaVariants(schema);
  if (variants.length === 0) return schema as Record<string, unknown>;
  const objectVariants = variants.filter((variant) => isRecord(variant.properties));
  if (objectVariants.length === 0) return schema as Record<string, unknown>;

  if (isRecord(args)) {
    for (const variant of objectVariants) {
      const properties = isRecord(variant.properties) ? variant.properties : {};
      const matches = Object.entries(properties).some(([key, prop]) =>
        isRecord(prop) &&
        'const' in prop &&
        args[key] === prop.const
      );
      if (matches) return variant;
    }
  }

  return objectVariants[0]!;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
}

function requiredKeysForSchema(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
}

function exampleArgsFromSchema(schema: JsonSchema | Record<string, unknown>, args?: unknown): Record<string, unknown> {
  const selected = selectSchemaForArgs(schema, args);
  const properties = schemaProperties(selected);
  const required = requiredKeysForSchema(selected);
  const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 3);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = exampleValueForSchema(properties[key], key);
  }
  return out;
}

function retryArgsFromSchema(schema: JsonSchema, args?: unknown): Record<string, unknown> {
  const selected = selectSchemaForArgs(schema, args);
  const properties = schemaProperties(selected);
  const out = exampleArgsFromSchema(selected, args);
  if (!isRecord(args)) return out;
  for (const key of Object.keys(properties)) {
    const value = args[key];
    const propSchema = properties[key];
    if (value !== undefined && value !== '' && valueMatchesSchema(value, propSchema)) out[key] = value;
  }
  return out;
}

function valueMatchesSchema(value: unknown, schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  try {
    const validate = jsonSchemaValidator.compile(schema);
    return validate(value) === true;
  } catch {
    return true;
  }
}

function isStringLikeSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const type = new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (type.has('string')) return true;
  if ('minLength' in schema || 'maxLength' in schema || 'pattern' in schema || 'format' in schema) return true;
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === 'string')) return true;
  return typeof schema.const === 'string';
}

/**
 * items schema 是否为 primitive（string/number/integer/boolean 或 primitive enum）。
 * 仅对 primitive-items 数组做「对象/嵌套 → 叶子拍平」，避免对 object[] 做歧义猜测。
 */
function isPrimitiveItemsSchema(items: unknown): boolean {
  if (!isRecord(items)) return false;
  const typeField = Array.isArray(items.type) ? items.type[0] : items.type;
  if (typeField === 'string' || typeField === 'number' || typeField === 'integer' || typeField === 'boolean') {
    return true;
  }
  if (Array.isArray(items.enum) && items.enum.every((v) => v === null || typeof v !== 'object')) {
    return true;
  }
  return false;
}

/**
 * 深度收集所有 primitive 叶子值（string/number/boolean），跳过对象 key 与 null。
 * 用于把模型误写成嵌套对象（如 {"item":{...,"$text":"path"}} —— XML 语义泄进 JSON）
 * 的 primitive 列表拍平回扁平数组。顺序 = 结构内文档序（深度优先）。
 */
export function collectPrimitiveLeaves(value: unknown, out: unknown[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'object') {
    const iterable = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const v of iterable) collectPrimitiveLeaves(v, out);
    return;
  }
  out.push(value);
}

/**
 * 把单个「应进入数组的元素」按 items schema 规整为元素列表。
 *
 * - primitive 叶子 → `[item]`；
 * - null/undefined → `[]`（丢弃，避免空槽）；
 * - object/嵌套 + primitive-items schema → 拍平成 primitive 叶子列表；
 * - object/嵌套 + object-items schema → `[item]`（不拍平，交回递归规整/校验）。
 *
 * 判据全部来自声明的 schema，非启发式（不靠关键词/阈值/置信度）。
 */
function coerceToArrayElement(item: unknown, itemsSchema: unknown): unknown[] {
  if (item === null || item === undefined) return [];
  if (typeof item !== 'object') return [item];
  if (!isPrimitiveItemsSchema(itemsSchema)) return [item];
  const leaves: unknown[] = [];
  collectPrimitiveLeaves(item, leaves);
  return leaves;
}

function normalizeArgsForSchema(args: unknown, schema: JsonSchema): unknown {
  const normalized = normalizeToolArgs(args);
  return normalizeValueForSchema(normalized, schema);
}

function normalizeValueForSchema(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  const selected = selectSchemaForArgs(schema, value);
  const variants = schemaVariants(selected);
  if (variants.length > 0 && selected !== schema) return normalizeValueForSchema(value, selected);
  const type = Array.isArray(selected.type) ? selected.type[0] : selected.type;

  if (type === 'array') {
    const itemsSchema = selected.items;
    // value 已是数组：逐元素规整。对 primitive-items 数组，把「对象/嵌套」元素
    // 确定性拍平为 primitive 叶子（模型常把 string[] 误写成嵌套对象，如
    // {"item":{...,"$text":"path"}} —— XML 语义泄进 JSON）。
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        for (const leaf of coerceToArrayElement(item, itemsSchema)) {
          out.push(normalizeValueForSchema(leaf, itemsSchema));
        }
      }
      return out;
    }
    // value 非数组但 schema 要数组：单 primitive 包成 [value]；对象/嵌套拍平。
    if (value !== null && value !== undefined) {
      const leaves = coerceToArrayElement(value, itemsSchema);
      if (leaves.length > 0) {
        return leaves.map((leaf) => normalizeValueForSchema(leaf, itemsSchema));
      }
    }
    return value;
  }

  if ((type === 'object' || selected.properties) && isRecord(value)) {
    const properties = schemaProperties(selected);
    const required = new Set(requiredKeysForSchema(selected));
    const out: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const propSchema = properties[key];
      if (nestedValue === '' && propSchema && isStringLikeSchema(propSchema) && !required.has(key)) {
        continue;
      }
      out[key] = propSchema ? normalizeValueForSchema(nestedValue, propSchema) : nestedValue;
    }
    return out;
  }

  return value;
}

function ajvPath(error: ErrorObject): string {
  const path = error.instancePath
    ? error.instancePath.replace(/^\//, '').replace(/\//g, '.')
    : '';
  if (error.keyword === 'required' && isRecord(error.params) && typeof error.params.missingProperty === 'string') {
    return path ? `${path}.${error.params.missingProperty}` : error.params.missingProperty;
  }
  if (error.keyword === 'additionalProperties' && isRecord(error.params) && typeof error.params.additionalProperty === 'string') {
    return path ? `${path}.${error.params.additionalProperty}` : error.params.additionalProperty;
  }
  return path || '(root)';
}

function toolCatalog() {
  return getPromptCatalog().tools;
}

function formatJsonSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  const fallback = toolCatalog().registry.schemaValidationFailed;
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => `${ajvPath(error)}: ${error.message || fallback}`)
    .join('; ');
}

function jsonSchemaHints(errors: ErrorObject[] | null | undefined): Array<{ path: string; message: string }> {
  const fallback = toolCatalog().registry.schemaValidationFailed;
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => ({ path: ajvPath(error), message: error.message || fallback }));
}

function validateJsonSchemaArgs(schema: JsonSchema, args: unknown): { ok: true; value: unknown } | { ok: false; formatted: string; hints: Array<{ path: string; message: string }> } {
  try {
    const validate = jsonSchemaValidator.compile(schema);
    if (validate(args)) return { ok: true, value: args };
    const formatted = formatJsonSchemaErrors(validate.errors);
    return {
      ok: false,
      formatted: formatted || toolCatalog().registry.schemaValidationFailed,
      hints: jsonSchemaHints(validate.errors),
    };
  } catch {
    return { ok: true, value: args };
  }
}

function validateToolProtocolArgs(toolName: string, args: unknown): { ok: true } | { ok: false; formatted: string; hints: Array<{ path: string; message: string }> } {
  if (toolName !== 'request_permission_update' || !isRecord(args) || args.source !== 'worker') {
    return { ok: true };
  }

  const missing = ['request_id', 'worker_name'].filter((key) => {
    const value = args[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    formatted: missing.map((key) => `${key}: must be a non-empty string when source is "worker"`).join('; '),
    hints: missing.map((key) => ({ path: key, message: 'must be a non-empty string when source is "worker"' })),
  };
}

export type { RegisteredTool };

export { type ToolContext, type ToolResult } from './Tool';

export function normalizeToolArgs(args: unknown): unknown {
  return args;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private deferredTools: Map<string, () => RegisteredTool> = new Map();
  private db: DatabaseManager | null = null;
  private sessionId: string | null = null;

  /** Session 级已读文件集合（绝对路径） */
  private readFiles = new Set<string>();

  /** Tool 变更监听器 — register/unregister 时回调，便于上层广播事件或失效缓存 */
  private changeListener: ((evt: { action: 'register' | 'unregister' | 'replace'; name: string }) => void) | null = null;

  /** Attach a DatabaseManager for persistence support */
  setDatabase(db: DatabaseManager, sessionId: string): void {
    this.db = db;
    this.sessionId = sessionId;
  }

  /** 注册 tool 变更监听器；同一个 listener 实例覆盖之前的 */
  setChangeListener(fn: ((evt: { action: 'register' | 'unregister' | 'replace'; name: string }) => void) | null): void {
    this.changeListener = fn;
  }

  /** 工具是否已注册（含 deferred） */
  has(name: string): boolean {
    return this.tools.has(name) || this.deferredTools.has(name);
  }

  /** 记录文件已被读取 */
  recordFileRead(filePath: string, workspace?: string): void {
    this.readFiles.add(this.resolveAbsPath(filePath, workspace));
  }

  /** 检查文件是否已被读取过 */
  hasFileBeenRead(filePath: string, workspace?: string): boolean {
    return this.readFiles.has(this.resolveAbsPath(filePath, workspace));
  }

  private resolveAbsPath(filePath: string, workspace?: string): string {
    if (isAbsolute(filePath)) return filePath;
    return resolve(workspace || process.cwd(), filePath);
  }

  register(tool: RegisteredTool): void {
    const existed = this.tools.has(tool.name) || this.deferredTools.has(tool.name);
    this.tools.set(tool.name, tool);
    this.deferredTools.delete(tool.name);
    this.saveTool(tool);
    try {
      this.changeListener?.({ action: existed ? 'replace' : 'register', name: tool.name });
    } catch {
      // listener 异常独立于注册结果
    }
  }

  /** Register a tool lazily — instantiated only on first access */
  registerDeferred(name: string, factory: () => RegisteredTool): void {
    const existed = this.tools.has(name) || this.deferredTools.has(name);
    this.deferredTools.set(name, factory);
    try {
      this.changeListener?.({ action: existed ? 'replace' : 'register', name });
    } catch {
      // ignore
    }
  }

  /** 注销工具（含 deferred）。返回是否实际移除 */
  unregister(name: string): boolean {
    const had = this.tools.delete(name);
    const hadDeferred = this.deferredTools.delete(name);
    const removed = had || hadDeferred;
    if (removed) {
      try {
        this.changeListener?.({ action: 'unregister', name });
      } catch {
        // ignore
      }
    }
    return removed;
  }

  get(name: string): RegisteredTool | undefined {
    let tool = this.tools.get(name);
    if (!tool && this.deferredTools.has(name)) {
      const factory = this.deferredTools.get(name)!;
      tool = factory();
      this.tools.set(name, tool);
      this.deferredTools.delete(name);
      this.saveTool(tool);
    }
    return tool;
  }

  getLoaded(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  getDeferredNames(): string[] {
    return Array.from(this.deferredTools.keys());
  }

  getAll(): RegisteredTool[] {
    // Materialize all deferred tools
    for (const [name, factory] of this.deferredTools) {
      if (!this.tools.has(name)) {
        const tool = factory();
        this.tools.set(name, tool);
        this.saveTool(tool);
      }
    }
    this.deferredTools.clear();
    return Array.from(this.tools.values());
  }

  /**
   * 收集用于生成 provider 定义所需的最小工具集。
   *
   * 关键：defer 真正按需加载 —— 不再无条件调用 getAll() 全量物化。
   *   - 指定 toolNames 时：只物化被显式请求的工具（按名 get，触发 lazy 实例化），
   *     其余 deferred 工具保持惰性。
   *   - 未指定 toolNames（"all" 语义）时：已加载工具全收；deferred 工具按 metadata
   *     过滤，跳过 hidden（hidden 工具永不出现在 LLM 定义里，无需物化）。其余
   *     deferred 工具因 schema 仅存在于实例上，仍需物化，但仅限非 hidden 子集。
   */
  private resolveDefinitionsSource(toolNames?: string[]): RegisteredTool[] {
    const requestedToolNames = toolNames ? new Set(toolNames) : null;

    if (requestedToolNames) {
      const resolved: RegisteredTool[] = [];
      for (const name of requestedToolNames) {
        const tool = this.get(name);
        if (tool) resolved.push(tool);
      }
      return resolved;
    }

    const collected = new Map<string, RegisteredTool>();
    for (const [name, tool] of this.tools) {
      collected.set(name, tool);
    }
    for (const name of this.deferredTools.keys()) {
      if (collected.has(name)) continue;
      // 隐藏工具永不会出现在 LLM 定义里 —— 保持 deferred，不物化。
      if (getToolMetadata(name).hidden) continue;
      const tool = this.get(name);
      if (tool) collected.set(name, tool);
    }
    return Array.from(collected.values());
  }

  getDefinitions(toolNames?: string[], options: ToolDefinitionOptions = {}): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    const requestedToolNames = toolNames ? new Set(toolNames) : null;
    const sourceTools = this.resolveDefinitionsSource(toolNames);
    const filtered = requestedToolNames
      ? sourceTools.filter(t => requestedToolNames.has(t.name))
      : sourceTools.filter(t => !getToolMetadata(t.name).hidden);

    return filtered
      .filter((tool) => this.isVisibleForDefinitionScope(tool, options.scope))
      .filter((tool) => this.isVisibleForModePolicy(tool.name, getToolMetadata(tool.name), options.modePolicy))
      .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.getSchema(tool)
      }
    }));
  }

  private isVisibleForDefinitionScope(tool: RegisteredTool, scope: ToolDefinitionScope | undefined): boolean {
    if (!scope || scope === 'all') return true;
    const toolScope = tool.scope ?? 'worker';
    if (scope === 'both') return toolScope === 'both';
    return toolScope === scope || toolScope === 'both';
  }

  private isLeaderToolContext(context?: ToolContext): boolean {
    return context?.agentId === 'leader' || context?.agentName === 'leader' || Boolean(context?.leaderToolsExecutor);
  }

  private isExecutableInContext(tool: RegisteredTool, context?: ToolContext): boolean {
    return tool.scope !== 'leader' || this.isLeaderToolContext(context);
  }

  private modeDecisionForOptions(
    name: string,
    metadata: ToolMetadata,
    options?: ToolDefinitionModePolicyOptions,
  ): ModeToolDecision | null {
    if (!options) return null;
    const modes = options.modes;
    return resolveModeToolDecision({
      actor: options.actor ?? 'worker',
      controlMode: modes.controlMode,
      routeMode: modes.route.mode,
      collaborationMode: modes.collaboration.mode,
      activeModes: modes.modePlugins,
      blackboardMode: modes.blackboard.mode,
      permissionMode: modes.permission.mode,
      activeTeamName: modes.collaboration.activeTeamName ?? null,
      callerInTeamRoster: options.callerInTeamRoster,
      callerIsTeamLeader: options.callerIsTeamLeader,
      allowSoloEphemeralDispatch: options.allowSoloEphemeralDispatch,
      toolName: name,
      toolMetadata: metadata,
    });
  }

  private isVisibleForModePolicy(
    name: string,
    metadata: ToolMetadata,
    options?: ToolDefinitionModePolicyOptions,
  ): boolean {
    const decision = this.modeDecisionForOptions(name, metadata, options);
    return !decision || decision.visibility === 'visible';
  }

  private getModeRuntimeProjectionFromContext(context?: ToolContext): ModeRuntimeProjection | null {
    const explicit = context?.modes ?? context?.modeRuntimeProjection;
    if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
      return explicit as ModeRuntimeProjection;
    }
    if (!context?.db || !context.sessionId) return null;
    try {
      return resolveModeRuntimeProjection({
        sessionId: context.sessionId,
        db: context.db,
        permissionContext: getToolPermissionContextFromToolContext(context),
        blackboardAvailable: Boolean(context.blackboardGraph),
      });
    } catch {
      return null;
    }
  }

  private modeDecisionForExecution(
    name: string,
    metadata: ToolMetadata,
    context?: ToolContext,
  ): ModeToolDecision | null {
    const modes = this.getModeRuntimeProjectionFromContext(context);
    if (!modes) return null;
    const isLeader = this.isLeaderToolContext(context);
    const agentName = typeof context?.agentName === 'string' ? context.agentName : undefined;
    let callerInTeamRoster = isLeader;
    let callerIsTeamLeader = isLeader;
    if (!isLeader && agentName && context?.sessionId && modes.collaboration.teamEnabled) {
      try {
        const member = getTeamMemberRegistry().getByName(agentName, context.sessionId);
        callerInTeamRoster = Boolean(member);
        callerIsTeamLeader = member?.role === 'leader';
      } catch {
        callerInTeamRoster = false;
        callerIsTeamLeader = false;
      }
    }

    return resolveModeToolDecision({
      actor: isLeader ? 'leader' : callerInTeamRoster ? 'team_member' : 'worker',
      controlMode: modes.controlMode,
      routeMode: modes.route.mode,
      collaborationMode: modes.collaboration.mode,
      activeModes: modes.modePlugins,
      blackboardMode: modes.blackboard.mode,
      permissionMode: modes.permission.mode,
      activeTeamName: modes.collaboration.activeTeamName ?? null,
      callerInTeamRoster,
      callerIsTeamLeader,
      toolName: name,
      toolMetadata: metadata,
    });
  }

  private getSchema(tool: RegisteredTool): JsonSchema {
    const schema = (() => {
      if (typeof tool.getSchema === 'function') {
        return tool.getSchema();
      }
      if (tool.schema) {
        return tool.schema;
      }
      if (tool.input_schema) {
        return tool.input_schema;
      }
      return { type: 'object', properties: {} };
    })();
    return normalizeJsonSchemaForOpenAI(schema as Record<string, unknown>) as JsonSchema;
  }

  getToolSchema(name: string): JsonSchema | null {
    const tool = this.get(name);
    return tool ? this.getSchema(tool) : null;
  }

  getToolInspection(name: string, options?: { includeSchema?: boolean; scope?: ToolDefinitionScope; modePolicy?: ToolDefinitionModePolicyOptions }): ToolInspection | null {
    const loadedTool = this.tools.get(name);
    const deferred = this.deferredTools.has(name);
    const tool = loadedTool ?? (options?.includeSchema || !deferred ? this.get(name) : undefined);
    if (!tool && !deferred) return null;
    if (tool && !this.isVisibleForDefinitionScope(tool, options?.scope)) return null;
    if (!this.isVisibleForModePolicy(name, getToolMetadata(name), options?.modePolicy)) return null;
    const schema = tool ? this.getSchema(tool) : undefined;
    return {
      name,
      description: tool?.description ?? toolCatalog().registry.deferredToolDescription(name),
      loaded: Boolean(loadedTool || tool),
      deferred,
      metadata: getToolMetadata(name),
      ...(options?.includeSchema && schema ? { schema, example_args: exampleArgsFromSchema(schema) } : {}),
    };
  }

  listToolInspections(options?: { includeSchema?: boolean; includeHidden?: boolean; scope?: ToolDefinitionScope; modePolicy?: ToolDefinitionModePolicyOptions }): ToolInspection[] {
    const names = Array.from(new Set([...this.tools.keys(), ...this.deferredTools.keys()])).sort((a, b) => a.localeCompare(b));
    return names
      .map((name) => this.getToolInspection(name, options))
      .filter((item): item is ToolInspection => Boolean(item))
      .filter((item) => options?.includeHidden || !item.metadata.hidden);
  }

  private validateArgs(tool: RegisteredTool, args: unknown, schema: JsonSchema): { ok: true; value: unknown } | { ok: false; result: ToolResult } {
    const normalizedArgs = normalizeArgsForSchema(args, schema);
    const registryText = toolCatalog().registry;

    if (tool instanceof Tool) {
      const parsed = tool.parameters.safeParse(normalizedArgs);
      if (!parsed.success) {
        const formatted = formatZodError(parsed.error);
        return {
          ok: false,
          result: createToolError({
            code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
            message: registryText.argumentValidationMessage(formatted),
            retryable: true,
            cause: formatted,
            fix: registryText.argumentValidationFix,
            hints: parsed.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
            example_args: exampleArgsFromSchema(schema, normalizedArgs),
            retry_args: retryArgsFromSchema(schema, normalizedArgs),
          }),
        };
      }
      const protocolValidation = validateToolProtocolArgs(tool.name, parsed.data);
      if (!protocolValidation.ok) {
        return {
          ok: false,
          result: createToolError({
            code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
            message: registryText.argumentValidationMessage(protocolValidation.formatted),
            retryable: true,
            cause: protocolValidation.formatted,
            fix: registryText.argumentValidationFix,
            hints: protocolValidation.hints,
            example_args: exampleArgsFromSchema(schema, normalizedArgs),
            retry_args: retryArgsFromSchema(schema, normalizedArgs),
          }),
        };
      }
      return { ok: true, value: parsed.data };
    }

    const jsonValidation = validateJsonSchemaArgs(schema, normalizedArgs);
    if (!jsonValidation.ok) {
      const formatted = jsonValidation.formatted;
      return {
        ok: false,
        result: createToolError({
          code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
          message: registryText.argumentValidationMessage(formatted),
          retryable: true,
          cause: formatted,
          fix: registryText.argumentValidationFix,
          hints: jsonValidation.hints,
          example_args: exampleArgsFromSchema(schema, normalizedArgs),
          retry_args: retryArgsFromSchema(schema, normalizedArgs),
        }),
      };
    }
    const protocolValidation = validateToolProtocolArgs(tool.name, jsonValidation.value);
    if (!protocolValidation.ok) {
      return {
        ok: false,
        result: createToolError({
          code: 'TOOL_ARGUMENT_VALIDATION_FAILED',
          message: registryText.argumentValidationMessage(protocolValidation.formatted),
          retryable: true,
          cause: protocolValidation.formatted,
          fix: registryText.argumentValidationFix,
          hints: protocolValidation.hints,
          example_args: exampleArgsFromSchema(schema, normalizedArgs),
          retry_args: retryArgsFromSchema(schema, normalizedArgs),
        }),
      };
    }

    return { ok: true, value: jsonValidation.value };
  }

  private suggestToolNames(name: string): string[] {
    const names = Array.from(new Set([...this.tools.keys(), ...this.deferredTools.keys()]));
    return names
      .map((candidate) => ({ candidate, score: candidate.includes(name) || name.includes(candidate) ? 0 : levenshtein(name, candidate) }))
      .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
      .slice(0, 5)
      .map((x) => x.candidate);
  }

  /**
   * Shared resolution pipeline: lookup tool, parse args, validate, check read-first.
   * Returns a discriminated union so callers can branch on the error stage.
   */
  private resolveToolAndValidateArgs(
    name: string,
    args: unknown,
    context?: ToolContext,
  ):
    | { stage: 'not_found'; candidates: string[]; metadata: ToolMetadata }
    | { stage: 'scope_forbidden'; tool: RegisteredTool; schema: JsonSchema; metadata: ToolMetadata }
    | { stage: 'mode_forbidden'; tool: RegisteredTool; schema: JsonSchema; metadata: ToolMetadata; decision: Extract<ModeToolDecision, { visibility: 'hidden' }> }
    | { stage: 'parse_failed'; tool: RegisteredTool; schema: JsonSchema; metadata: ToolMetadata; parseError: { message: string; cause: string; rawPreview?: string } }
    | { stage: 'validation_failed'; tool: RegisteredTool; schema: JsonSchema; metadata: ToolMetadata; validationResult: ToolResult }
    | { stage: 'read_first'; tool: RegisteredTool; schema: JsonSchema; metadata: ToolMetadata; parsedArgs: unknown; filePath: string }
    | { stage: 'ok'; tool: RegisteredTool; schema: JsonSchema; metadata: ToolMetadata; parsedArgs: unknown }
  {
    const tool = this.get(name);
    const metadata = getToolMetadata(name);

    if (!tool) {
      return { stage: 'not_found', candidates: this.suggestToolNames(name), metadata };
    }

    const schema = this.getSchema(tool);
    if (!this.isExecutableInContext(tool, context)) {
      return { stage: 'scope_forbidden', tool, schema, metadata };
    }

    const modeDecision = this.modeDecisionForExecution(name, metadata, context);
    if (modeDecision?.visibility === 'hidden') {
      return { stage: 'mode_forbidden', tool, schema, metadata, decision: modeDecision };
    }

    const parsed = parseArgsText(args ?? {});
    if (!parsed.ok) {
      return { stage: 'parse_failed', tool, schema, metadata, parseError: { message: parsed.message, cause: parsed.cause, rawPreview: parsed.rawPreview } };
    }

    const validation = this.validateArgs(tool, parsed.value, schema);
    if (!validation.ok) {
      return { stage: 'validation_failed', tool, schema, metadata, validationResult: validation.result };
    }

    if (requiresReadFirst(name)) {
      const filePath = (validation.value as Record<string, unknown>)?.path as string | undefined;
      if (filePath) {
        const absPath = this.resolveAbsPath(filePath, context?.workspace);
        const shouldCheck = name === 'file_create' ? existsSync(absPath) : true;
        if (shouldCheck && !this.readFiles.has(absPath)) {
          return { stage: 'read_first', tool, schema, metadata, parsedArgs: validation.value, filePath };
        }
      }
    }

    return { stage: 'ok', tool, schema, metadata, parsedArgs: validation.value };
  }

  preflight(name: string, args?: unknown, context?: ToolContext): ToolPreflightResult {
    const resolution = this.resolveToolAndValidateArgs(name, args, context);
    const registryText = toolCatalog().registry;

    switch (resolution.stage) {
      case 'not_found':
        return {
          ok: false,
          tool: name,
          found: false,
          metadata: resolution.metadata,
          repair: {
            code: 'TOOL_NOT_FOUND',
            message: registryText.toolNotFoundCause(name),
            fix: registryText.toolNotFoundFix(resolution.candidates),
            candidates: resolution.candidates,
          },
        };

      case 'parse_failed':
        return {
          ok: false,
          tool: name,
          found: true,
          schema: resolution.schema,
          metadata: resolution.metadata,
          repair: {
            code: 'TOOL_ARGUMENT_PARSE_FAILED',
            message: resolution.parseError.message,
            fix: registryText.argumentParseFix,
            hints: { raw_preview: resolution.parseError.rawPreview, cause: resolution.parseError.cause },
            example_args: exampleArgsFromSchema(resolution.schema),
          },
        };

      case 'scope_forbidden':
        return {
          ok: false,
          tool: name,
          found: true,
          schema: resolution.schema,
          metadata: resolution.metadata,
          repair: {
            code: 'TOOL_SCOPE_FORBIDDEN',
            message: registryText.scopeForbiddenCause(name),
            fix: registryText.scopeForbiddenFix,
          },
        };

      case 'mode_forbidden':
        return {
          ok: false,
          tool: name,
          found: true,
          schema: resolution.schema,
          metadata: resolution.metadata,
          repair: {
            code: resolution.decision.reason,
            message: `Tool "${name}" is hidden in the current session mode (${resolution.decision.reason}).`,
            fix: 'Use an available tool for the current mode, or explicitly switch the relevant session mode before retrying.',
          },
        };

      case 'validation_failed': {
        const recovery = extractLlmRecovery(resolution.validationResult.data);
        return {
          ok: false,
          tool: name,
          found: true,
          schema: resolution.schema,
          metadata: resolution.metadata,
          repair: {
            code: recovery?.code || 'TOOL_ARGUMENT_VALIDATION_FAILED',
            message: recovery?.message || registryText.validationFailedMessage,
            fix: recovery?.fix || registryText.validationFailedFix,
            hints: recovery?.hints,
            candidates: recovery?.candidates,
            next_tool: recovery?.next_tool,
            example_args: recovery?.example_args || exampleArgsFromSchema(resolution.schema),
            retry_args: recovery?.retry_args || retryArgsFromSchema(resolution.schema),
          },
        };
      }

      case 'read_first':
        return {
          ok: false,
          tool: name,
          found: true,
          schema: resolution.schema,
          metadata: resolution.metadata,
          normalizedArgs: resolution.parsedArgs,
          repair: {
            code: 'FILE_MUST_BE_READ_FIRST',
            message: registryText.fileMustReadFirstMessage(resolution.filePath),
            fix: registryText.fileMustReadFirstFix,
            next_tool: { name: 'file_read', args: { path: resolution.filePath } },
          },
        };

      case 'ok':
        return {
          ok: true,
          tool: name,
          found: true,
          schema: resolution.schema,
          metadata: resolution.metadata,
          normalizedArgs: resolution.parsedArgs,
        };
    }
  }

  async execute(name: string, args: unknown, context?: ToolContext): Promise<ToolResult> {
    const resolution = this.resolveToolAndValidateArgs(name, args, context);
    const registryText = toolCatalog().registry;

    if (resolution.stage === 'not_found') {
      return createToolError({
        code: 'TOOL_NOT_FOUND',
        message: registryText.toolNotFoundMessage(name),
        retryable: true,
        cause: registryText.toolNotFoundCause(name),
        fix: registryText.toolNotFoundFix(resolution.candidates),
        candidates: resolution.candidates,
      });
    }

    if (resolution.stage === 'parse_failed') {
      return createToolError({
        code: 'TOOL_ARGUMENT_PARSE_FAILED',
        message: resolution.parseError.message,
        retryable: true,
        cause: resolution.parseError.cause,
        fix: registryText.argumentParseFix,
        hints: { raw_preview: resolution.parseError.rawPreview },
      });
    }

    if (resolution.stage === 'scope_forbidden') {
      return createToolError({
        code: 'TOOL_SCOPE_FORBIDDEN',
        message: registryText.scopeForbiddenMessage(name),
        retryable: false,
        cause: registryText.scopeForbiddenCause(name),
        fix: registryText.scopeForbiddenFix,
      });
    }

    if (resolution.stage === 'mode_forbidden') {
      return createToolError({
        code: resolution.decision.reason,
        message: `MODE_TOOL_FORBIDDEN: ${resolution.decision.reason}`,
        retryable: true,
        cause: `Tool "${name}" is hidden in the current session mode.`,
        fix: 'Use an available tool for the current mode, or explicitly switch the relevant session mode before retrying.',
      });
    }

    if (resolution.stage === 'validation_failed') {
      return resolution.validationResult;
    }

    if (resolution.stage === 'read_first') {
      return createToolError({
        code: 'FILE_MUST_BE_READ_FIRST',
        message: registryText.fileMustReadFirstMessage(resolution.filePath),
        retryable: true,
        cause: registryText.fileMustReadFirstCause,
        fix: registryText.fileMustReadFirstFix,
        next_tool: { name: 'file_read', args: { path: resolution.filePath } },
      });
    }

    // stage === 'ok'
    const { tool } = resolution;
    const parsedArgs = resolution.parsedArgs;

    // Office 模式的 fail-closed 由上方 resolveToolAndValidateArgs 的 mode_forbidden
    // 统一挡（ModeToolPolicy → findModeOfTool），此处不再旁路复检。审计仍按工具归属执行。
    const isOfficeTool = isOfficeToolName(name);

    // ── Permission check ──
    const permissionDecision = evaluateToolPermission(
      name,
      parsedArgs,
      getToolPermissionContextFromToolContext(context)
    );
    if (!permissionDecision.allowed) {
      return createToolError({
        code: 'PERMISSION_REQUIRED',
        message: `PERMISSION_REQUIRED: ${permissionDecision.reason}`,
        retryable: true,
        cause: permissionDecision.reason,
        fix: registryText.permissionRequiredFix,
      });
    }

    // ── Execute tool ──
    const toolResult = await executeToolWithTimeout(name, tool, parsedArgs, context);

    if (isOfficeTool) {
      await auditOfficeToolExecution({
        tool: name,
        args: parsedArgs,
        result: toolResult,
        context: {
          ...context,
          sessionId: context?.sessionId || this.sessionId || context?.sessionId,
          db: context?.db || this.db || context?.db,
        },
      });
      // 统一 per-mode metrics 出口（jsonl 仍由上面写入，这里只补可观测计数）。
      auditModeEvent('office', {
        kind: 'office_tool_call',
        tool: name,
        success: toolResult.success,
        argsSummary: parsedArgs,
      });
    }

    // ── 记录文件内容已知的工具 ──
    if (toolResult.success && (
      name === 'file_read' ||
      name === 'file_create' ||
      name === 'structured_patch'
    )) {
      const filePath = (parsedArgs as Record<string, unknown>)?.path as string | undefined;
      if (filePath) {
        this.recordFileRead(filePath, context?.workspace);
      }
    }

    if (toolResult.success && (name === 'file_create' || name === 'structured_patch')) {
      const filePath = (parsedArgs as Record<string, unknown>)?.path as string | undefined;
      if (filePath && context?.assumptionTracker) {
        try {
          const batch = await context.assumptionTracker.onFilesChanged([filePath]);
          if (batch.falsified.length > 0) {
            await context.assumptionFeedback?.(batch);
          }
        } catch (error) {
          console.warn(`[ToolRegistry] assumption verification skipped after ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return toolResult;
  }

  // === Persistence ===

  private saveTool(tool: RegisteredTool): void {
    if (!this.db || !this.sessionId) return;
    try {
      const toolType = tool instanceof Tool ? 'class' : 'custom';
      const schema = this.getSchema(tool);
      this.db.saveToolRegistration(this.sessionId, tool.name, {
        type: toolType,
        description: tool.description,
        schema: JSON.stringify(schema),
      });
    } catch {
      // Persistence failure should not break registration
    }
  }

  /** Load tool registration metadata from DB. Returns metadata for caller to reconstruct tools. */
  loadTools(): Array<{
    tool_name: string;
    tool_type: string;
    tool_description: string;
    tool_schema: Record<string, unknown>;
  }> {
    if (!this.db || !this.sessionId) return [];
    const rows = this.db.loadToolRegistrations(this.sessionId);
    return rows.map((r: { tool_name: string; tool_type: string; tool_description: string; tool_schema: string }) => ({
      tool_name: r.tool_name,
      tool_type: r.tool_type,
      tool_description: r.tool_description,
      tool_schema: (() => {
        try { return JSON.parse(r.tool_schema); } catch { /* expected: malformed schema JSON */ return {}; }
      })(),
    }));
  }

  /** Save all currently registered tools to DB */
  persistAll(): void {
    for (const tool of this.getAll()) {
      this.saveTool(tool);
    }
  }

  /** Save already-loaded tools without instantiating deferred tools. */
  persistLoaded(): void {
    for (const tool of this.tools.values()) {
      this.saveTool(tool);
    }
  }

  /** Clear persisted tool registrations for this session */
  clearPersistedTools(): void {
    if (!this.db || !this.sessionId) return;
    try {
      this.db.clearToolRegistrations(this.sessionId);
    } catch {
      // Ignore
    }
  }
}

let defaultToolRegistry: ToolRegistry | undefined;

export function getToolRegistry(): ToolRegistry {
  defaultToolRegistry ??= new ToolRegistry();
  return defaultToolRegistry;
}
