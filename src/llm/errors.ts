import { coreLogger } from '../core/Log.js';
import { errorLabel } from '../i18n.js';

export type LLMErrorKind =
  | 'connect_timeout'
  | 'request_timeout'
  | 'stream_timeout'
  | 'stream_idle_abort'
  | 'network_error'
  | 'provider_error'
  | 'rate_limited'
  | 'context_overflow'
  | 'auth_error'
  | 'quota_exhausted'
  | 'parse_error'
  | 'unknown_error';

export interface LLMErrorMetadata {
  provider?: 'openai' | 'anthropic' | string;
  model?: string;
  retryable?: boolean;
  statusCode?: number;
  errorCode?: string;
  errorType?: string;
  rawMessage?: string;
  retryAfterMs?: number;
  classifiedBy?: 'structural' | 'text-fallback' | 'none';
  classificationRuleId?: string;
}

export class LLMError extends Error {
  llmErrorKind: LLMErrorKind;
  provider?: string;
  model?: string;
  retryable: boolean;
  statusCode?: number;
  errorCode?: string;
  errorType?: string;
  rawMessage?: string;
  retryAfterMs?: number;
  classifiedBy?: 'structural' | 'text-fallback' | 'none';
  classificationRuleId?: string;

  /**
   * 流式中断（timeout / network / stream abort）时 generator 已累积的纯文本 partial。
   *
   * 由 generator 的 catch 块抢救（闭包内的 fullContent），LlmGuard 在 stream-interrupt
   * 类错误重试时把它作为 assistant prefill 注入，让模型接着续写后半截，而非从头重新生成。
   *
   * 只含 content（纯文本），不并入 thinking —— thinking-mode 协议要求 assistant 的 thinking
   * 字段完整，partial thinking 不可信、回传会触发 400。tool_call 半截也不在此（generator 的
   * fullContent 只累积 delta.content 文本，tool_call JSON 走 parser，不会污染）。
   */
  partialAssistantContent?: { content: string };

  constructor(kind: LLMErrorKind, message: string, metadata: LLMErrorMetadata = {}) {
    super(message);
    this.name = 'LLMError';
    this.llmErrorKind = kind;
    this.provider = metadata.provider;
    this.model = metadata.model;
    this.retryable = metadata.retryable ?? (kind !== 'unknown_error');
    this.statusCode = metadata.statusCode;
    this.errorCode = metadata.errorCode;
    this.errorType = metadata.errorType;
    this.rawMessage = metadata.rawMessage;
    this.retryAfterMs = metadata.retryAfterMs;
    this.classifiedBy = metadata.classifiedBy;
    this.classificationRuleId = metadata.classificationRuleId;
  }
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.status === 'number') {
    return candidate.status;
  }
  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }
  const response = candidate.response;
  if (response && typeof response === 'object') {
    const responseRecord = response as Record<string, unknown>;
    if (typeof responseRecord.status === 'number') {
      return responseRecord.status;
    }
    if (typeof responseRecord.statusCode === 'number') {
      return responseRecord.statusCode;
    }
  }
  return undefined;
}

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseJsonLike(value: unknown): unknown | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || !/^[{[]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function collectErrorObjects(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): Array<Record<string, unknown>> {
  if (value == null || depth > 6 || seen.has(value)) return [];
  seen.add(value);

  if (typeof value === 'string') {
    const parsed = parseJsonLike(value);
    return parsed === undefined ? [] : collectErrorObjects(parsed, depth + 1, seen);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectErrorObjects(item, depth + 1, seen));
  }

  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const objects: Array<Record<string, unknown>> = [record];
  for (const key of ['error', 'response', 'body', 'data', 'details', 'detail', 'cause'] as const) {
    if (record[key] != null) {
      objects.push(...collectErrorObjects(record[key], depth + 1, seen));
    }
  }
  if (Array.isArray(record.errors)) {
    for (const sub of record.errors) {
      objects.push(...collectErrorObjects(sub, depth + 1, seen));
    }
  }
  return objects;
}

/**
 * 收集错误的 cause 链 + code 字段，拼成一段可供关键词分类的文本。
 *
 * 动机（2026-05-29 修复「流式出错没真正回收旧实例」）：
 *   undici 在流式 body 中途断连时抛 `TypeError: terminated`，**真实原因**
 *   藏在 `error.cause` 里（典型 `SocketError: other side closed`，
 *   `code='UND_ERR_SOCKET'`）。只读顶层 `error.message='terminated'` 不匹配
 *   任何分支 → 落 unknown_error → retryable=false → LlmGuard 既不 recycle
 *   也不重发，旧死 socket 一直钉住。
 *
 *   因此分类前必须把 cause 链（含 AggregateError.errors[]）和各层的 `code`
 *   一起纳入判断文本。递归深度设上限防 cause 自引用死循环。
 */
function collectErrorText(error: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (error == null || depth > 6 || seen.has(error)) return '';
  seen.add(error);

  const parts: string[] = [];
  if (typeof error === 'string') {
    parts.push(error);
    const parsed = parseJsonLike(error);
    if (parsed !== undefined) {
      parts.push(collectErrorText(parsed, depth + 1, seen));
    }
  } else if (typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.message === 'string') parts.push(candidate.message);
    // undici / Node 系统错误把可判别信息放在 code（如 UND_ERR_SOCKET / ECONNRESET / EPIPE）
    if (typeof candidate.code === 'string') parts.push(candidate.code);
    if (typeof candidate.errorCode === 'string') parts.push(candidate.errorCode);
    if (typeof candidate.error_code === 'string') parts.push(candidate.error_code);
    if (typeof candidate.type === 'string') parts.push(candidate.type);
    if (typeof candidate.errorType === 'string') parts.push(candidate.errorType);
    if (typeof candidate.error_type === 'string') parts.push(candidate.error_type);
    if (typeof candidate.name === 'string') parts.push(candidate.name);
    // 递归 cause 链
    for (const key of ['cause', 'error', 'response', 'body', 'data', 'details', 'detail'] as const) {
      if (key in candidate && candidate[key] != null) {
        parts.push(collectErrorText(candidate[key], depth + 1, seen));
      }
    }
    // AggregateError：多个并发失败聚合（如 fetch 同时尝试多地址）
    if (Array.isArray(candidate.errors)) {
      for (const sub of candidate.errors) {
        parts.push(collectErrorText(sub, depth + 1, seen));
      }
    }
  } else {
    parts.push(String(error));
  }
  return parts.filter(Boolean).join(' | ');
}

function readHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  const lowerName = name.toLowerCase();
  const candidate = headers as Record<string, unknown> & { get?: (header: string) => string | null };
  if (typeof candidate.get === 'function') {
    const value = candidate.get(lowerName) || candidate.get(name);
    return typeof value === 'string' ? value : undefined;
  }

  for (const [key, value] of Object.entries(candidate)) {
    if (key.toLowerCase() === lowerName && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as Record<string, unknown>;
  const direct = readHeaderValue(candidate.headers, 'retry-after')
    || readHeaderValue(candidate.response && typeof candidate.response === 'object' ? (candidate.response as Record<string, unknown>).headers : undefined, 'retry-after');
  if (!direct) {
    return undefined;
  }

  const seconds = Number.parseFloat(direct);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const dateMs = Date.parse(direct);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

function extractStringField(error: unknown, keys: readonly string[]): string | undefined {
  const candidates = collectErrorObjects(error);
  for (const record of candidates) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

interface ExtractedErrorFields {
  rawMessage: string;
  classifyText: string;
  lowerText: string;
  statusCode?: number;
  errorCode?: string;
  errorType?: string;
  retryAfterMs?: number;
}

interface ErrorClassificationRule {
  id: string;
  statusCode?: number | readonly number[];
  errorCode?: string | readonly string[];
  errorType?: string | readonly string[];
  textPatterns?: readonly (string | RegExp)[];
  when?: (fields: ExtractedErrorFields) => boolean;
  classify: LLMErrorKind | ((fields: ExtractedErrorFields) => LLMErrorKind);
  retryable: boolean | ((fields: ExtractedErrorFields) => boolean);
  retryAfterMs?: number | ((fields: ExtractedErrorFields) => number | undefined);
}

function normalizeToken(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function matchesValue(actual: string | number | undefined, expected: string | number | readonly string[] | readonly number[] | undefined): boolean {
  if (actual === undefined || expected === undefined) return false;
  const actualValue = typeof actual === 'string' ? actual.toLowerCase() : actual;
  const candidates: readonly (string | number)[] = Array.isArray(expected) ? expected : [expected];
  return candidates.some((candidate) => {
    const normalized = typeof candidate === 'string' ? candidate.toLowerCase() : candidate;
    return normalized === actualValue;
  });
}

function matchesTextPattern(pattern: string | RegExp, fields: ExtractedErrorFields): boolean {
  return typeof pattern === 'string'
    ? fields.lowerText.includes(pattern.toLowerCase())
    : pattern.test(fields.classifyText);
}

function hasAnyText(fields: ExtractedErrorFields, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) => matchesTextPattern(pattern, fields));
}

function isConnectTimeout(fields: ExtractedErrorFields): boolean {
  return hasAnyText(fields, ['connect', 'connection', 'econnrefused', 'etimedout']);
}

function isRecoverableParseError(fields: ExtractedErrorFields): boolean {
  return hasAnyText(fields, ['unexpected end of json', 'unterminated', 'eof', 'truncated']);
}

function hasRateLimitSignal(fields: ExtractedErrorFields): boolean {
  return hasAnyText(fields, RATE_LIMIT_TEXT_PATTERNS);
}

function isContextOverflowSemantic(fields: ExtractedErrorFields): boolean {
  if (hasRateLimitSignal(fields)) return false;
  const text = fields.lowerText;
  // 排除已知的消息格式验证错误（如 Bedrock TOOL_USE_RESULT_MISMATCH）——
  // 这些错误包含 "messages" 和 "exceeds" 但与上下文大小无关，
  // 误分类为 context_overflow 会触发无意义的有损压缩，还会破坏消息序列。
  if (/tool.?(?:result|use)|mismatch/i.test(text)) return false;
  const hasRequestSizePhrase = /\b(?:payload|request(?:\s+entity)?)\s+too\s+large\b/i.test(text);
  const hasSubject = /\b(context\s+(?:window|length|limit)|max(?:imum)?\s+context|tokens?|prompt|input|messages?)\b/i.test(text) || hasRequestSizePhrase;
  const hasOverflow = hasRequestSizePhrase || /exceed(?:s|ed)?|too\s+(?:long|large|many)|over\s+(?:the\s+)?(?:limit|maximum)|above\s+(?:the\s+)?(?:limit|maximum)|reduce\s+the\s+length|adjust\s+your\s+input/i.test(text);
  return hasSubject && hasOverflow;
}

function hasStructuredCondition(rule: ErrorClassificationRule): boolean {
  return rule.statusCode !== undefined || rule.errorCode !== undefined || rule.errorType !== undefined;
}

function matchesStructured(rule: ErrorClassificationRule, fields: ExtractedErrorFields): boolean {
  if (!hasStructuredCondition(rule)) return false;
  if (rule.statusCode !== undefined && !matchesValue(fields.statusCode, rule.statusCode)) return false;
  if (rule.errorCode !== undefined && !matchesValue(fields.errorCode, rule.errorCode)) return false;
  if (rule.errorType !== undefined && !matchesValue(fields.errorType, rule.errorType)) return false;
  return rule.when ? rule.when(fields) : true;
}

function matchesText(rule: ErrorClassificationRule, fields: ExtractedErrorFields): boolean {
  if (!rule.textPatterns || !hasAnyText(fields, rule.textPatterns)) return false;
  return rule.when ? rule.when(fields) : true;
}

function applyClassificationRule(
  rule: ErrorClassificationRule,
  fields: ExtractedErrorFields,
  metadata: LLMErrorMetadata,
  classifiedBy: 'structural' | 'text-fallback',
): LLMError {
  if (classifiedBy === 'text-fallback') {
    coreLogger.debug('classified-by-text-fallback', { ruleId: rule.id, provider: metadata.provider, model: metadata.model });
  }
  const kind = typeof rule.classify === 'function' ? rule.classify(fields) : rule.classify;
  const retryable = typeof rule.retryable === 'function' ? rule.retryable(fields) : rule.retryable;
  const ruleRetryAfterMs = typeof rule.retryAfterMs === 'function' ? rule.retryAfterMs(fields) : rule.retryAfterMs;
  return createLLMError(kind, fields.rawMessage, {
    ...metadata,
    statusCode: fields.statusCode,
    errorCode: fields.errorCode,
    errorType: fields.errorType,
    rawMessage: fields.rawMessage,
    retryAfterMs: ruleRetryAfterMs ?? fields.retryAfterMs,
    retryable,
    classifiedBy,
    classificationRuleId: rule.id,
  });
}

const QUOTA_TEXT_PATTERNS = [
  'insufficient_quota',
  'insufficient quota',
  'quota_exceeded',
  'quota exceeded',
  'quota exhausted',
  'exceeded your current quota',
  'not enough credits',
  'out of credits',
] as const;

const RATE_LIMIT_TEXT_PATTERNS = [
  /\btoo many requests\b/i,
  /\brate[-_\s]?limit(?:ed|s|ing)?\b/i,
  /\bretry[-\s]?after\b/i,
  /\b(?:upstream\s+)?http\s+429\b/i,
  /\b429\b.*\b(?:too many requests|rate[-_\s]?limit|retry[-\s]?after|throttl(?:ed|ing)?)\b/i,
  /\b(?:too many requests|rate[-_\s]?limit|retry[-\s]?after|throttl(?:ed|ing)?)\b.*\b429\b/i,
  /\bthrottl(?:ed|ing)?\b/i,
] as const;

const EMPTY_CONTENT_TEXT_PATTERNS = [
  'content is empty',
  'content_empty',
  'empty content',
  'messages is empty',
  '(2013)',
] as const;

/**
 * malformed tool-call arguments 信号（流式截断 / 双层 JSON 转义毒化历史）。
 *
 * GLM 等 provider 的 `invalid function arguments json string ... (2013)` 与真正的
 * content-empty 共用数字码 2013，单凭 `(2013)` 无法区分。本组用消息文本里的
 * function-arguments 措辞精确捕获前者，并在 CLASSIFICATION_RULES 中排在
 * empty-content-text 之前——靠规则顺序消歧，避免把「工具参数非法 JSON」误判成
 * 「内容为空可重试」导致无脑重试死循环（见 LlmGuard「不改消息」约束）。
 *
 * 此类错误属客户端不可恢复：malformed arguments 已写进对话历史，重试同请求必败。
 * 正解是 provider 边界的 dropMalformedToolCallArguments 修复历史；本规则作为
 * 防御，确保漏网时快速失败而非烧光重试预算。
 */
const MALFORMED_TOOL_ARGS_TEXT_PATTERNS = [
  /invalid\s+function\s+arguments/i,
  /function\s+call\s+arguments.*(?:invalid|malformed)/i,
  /arguments.*(?:is|are)\s+(?:not\s+)?(?:valid|json)/i,
  'could not parse tool call arguments',
  'tool call arguments are not valid',
  'invalid tool call arguments',
  // GLM/MiniMax 等 provider 的工具调用响应格式校验失败：
  // 400 + "tool call result does not follow tool call (2013)"。
  // 与 content_empty 共用 2013 但语义完全不同——前者是 client 侧消息序列污染
  // （上一轮 tool_result 与本轮 tool_call id 不匹配 / role 错位），重试同上下文必死，
  // 必须 fast-fail 走 compact 路径。empty-content-text 的 `(2013)` 模糊匹配会把它
  // 误判成"内容为空可重试"导致无脑重试烧光预算。靠本规则优先匹配 + parse_error
  // (retryable=false) 阻断。
  'tool call result does not follow tool call',
  'tool_call_result',
] as const;

const INVALID_BODY_TEXT_PATTERNS = [
  'request_body_invalid',
  'improperly formed request',
  'invalid request body',
] as const;

const TIMEOUT_TEXT_PATTERNS = [
  'request timed out',
  'timed out',
  'etimedout',
  'aborterror',
  /\b(connection\s+timeout|request\s+timeout|socket\s+timeout|fetch\s+timeout|timeout\s+error|timeout\s+expired)\b/i,
] as const;

const NETWORK_TEXT_PATTERNS = [
  'fetch failed',
  'eai_again',
  'enotfound',
  'econnreset',
  'econnaborted',
  'econnrefused',
  'epipe',
  'socket hang up',
  'socket disconnected',
  'network',
  'connection error',
  'connection reset',
  'connection closed',
  'premature close',
  'terminated',
  'other side closed',
  'und_err_socket',
  'und_err_',
  'empty stream',
  'no content in stream',
  'empty response',
  'empty completion',
] as const;

const PARSE_TEXT_PATTERNS = [
  'parse',
  'invalid json',
  'unexpected end of json',
] as const;

const VALIDATION_TEXT_PATTERNS = [
  'validation',
  'schema',
  'invalid',
  'could not parse tool',
] as const;

const AUTH_TEXT_PATTERNS = [
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'unauthorized',
  'forbidden',
  'authentication',
  'permission denied',
] as const;

const CONTEXT_TEXT_PATTERNS = [
  'context_length_exceeded',
  'context length exceeded',
  'context_window_exceeded',
  'context window exceeded',
  'exceeds the context window',
  'exceeded the context window',
  'prompt is too long',
  'input is too long',
  'input exceeds',
  'your input exceeds',
  'maximum context length',
  'max context length',
  'token limit',
  'tokens exceed',
  'reduce the length',
  'adjust your input',
  'payload too large',
  'request entity too large',
  'request too large',
] as const;

const CLASSIFICATION_RULES: readonly ErrorClassificationRule[] = [
  {
    id: 'quota-structured',
    statusCode: [402],
    classify: 'quota_exhausted',
    retryable: false,
  },
  {
    id: 'quota-code',
    errorCode: ['insufficient_quota', 'quota_exceeded'],
    classify: 'quota_exhausted',
    retryable: false,
  },
  {
    id: 'quota-status-text',
    statusCode: [400, 401, 403, 429],
    when: (fields) => hasAnyText(fields, QUOTA_TEXT_PATTERNS),
    classify: 'quota_exhausted',
    retryable: false,
  },
  {
    id: 'rate-limit-structured',
    statusCode: [429],
    errorCode: ['rate_limit_error', 'rate_limit_exceeded'],
    classify: 'provider_error',
    retryable: true,
  },
  {
    id: 'rate-limit-type',
    errorType: ['rate_limit_error', 'rate_limit_exceeded'],
    classify: 'provider_error',
    retryable: true,
  },
  {
    id: 'auth-status',
    statusCode: [401, 403],
    classify: 'auth_error',
    retryable: false,
  },
  {
    id: 'context-status',
    statusCode: [413],
    classify: 'context_overflow',
    retryable: false,
  },
  {
    id: 'context-code',
    errorCode: [
      'context_overflow',
      'context_length_exceeded',
      'context_window_exceeded',
      'input_too_long',
      'prompt_too_long',
      'tokens_exceeded',
      'max_context_length_exceeded',
    ],
    classify: 'context_overflow',
    retryable: false,
  },
  {
    id: 'empty-content-code',
    errorCode: ['content_empty', 'empty_content'],
    classify: 'provider_error',
    retryable: true,
    retryAfterMs: (fields) => fields.retryAfterMs ?? 1000,
  },
  {
    id: 'invalid-body-code',
    errorCode: ['request_body_invalid'],
    classify: 'provider_error',
    retryable: false,
  },
  {
    id: 'quota-text',
    textPatterns: QUOTA_TEXT_PATTERNS,
    classify: 'quota_exhausted',
    retryable: false,
  },
  {
    id: 'rate-limit-text',
    textPatterns: RATE_LIMIT_TEXT_PATTERNS,
    classify: 'provider_error',
    retryable: true,
  },
  {
    id: 'malformed-tool-args-text',
    textPatterns: MALFORMED_TOOL_ARGS_TEXT_PATTERNS,
    classify: 'parse_error',
    retryable: false,
  },
  {
    id: 'tool-result-mismatch-text',
    textPatterns: [/tool.?(?:result|use).*mismatch/i, /toolResult.*exceeds.*toolUse/i, /TOOL_USE_RESULT_MISMATCH/],
    classify: 'parse_error',
    retryable: false,
  },
  {
    id: 'empty-content-text',
    textPatterns: EMPTY_CONTENT_TEXT_PATTERNS,
    classify: 'provider_error',
    retryable: true,
    retryAfterMs: (fields) => fields.retryAfterMs ?? 1000,
  },
  {
    id: 'invalid-body-text',
    textPatterns: INVALID_BODY_TEXT_PATTERNS,
    classify: 'provider_error',
    retryable: false,
  },
  {
    id: 'timeout-text',
    textPatterns: TIMEOUT_TEXT_PATTERNS,
    classify: (fields) => isConnectTimeout(fields) ? 'connect_timeout' : 'request_timeout',
    retryable: true,
  },
  {
    id: 'network-text',
    textPatterns: NETWORK_TEXT_PATTERNS,
    classify: 'network_error',
    retryable: true,
  },
  {
    id: 'parse-validation-text',
    textPatterns: PARSE_TEXT_PATTERNS,
    when: (fields) => fields.statusCode === 400 && hasAnyText(fields, VALIDATION_TEXT_PATTERNS),
    classify: 'provider_error',
    retryable: false,
  },
  {
    id: 'parse-text',
    textPatterns: PARSE_TEXT_PATTERNS,
    classify: 'parse_error',
    retryable: isRecoverableParseError,
  },
  {
    id: 'auth-text',
    textPatterns: AUTH_TEXT_PATTERNS,
    classify: 'auth_error',
    retryable: false,
  },
  {
    id: 'context-text',
    textPatterns: CONTEXT_TEXT_PATTERNS,
    classify: 'context_overflow',
    retryable: false,
  },
  {
    id: 'context-semantic-text',
    textPatterns: [/\b(context|tokens?|prompt|input|messages?|request)\b/i],
    when: isContextOverflowSemantic,
    classify: 'context_overflow',
    retryable: false,
  },
  {
    id: 'context-window-text',
    textPatterns: ['context window', 'max_tokens'],
    when: (fields) => hasAnyText(fields, ['exceed', 'too']),
    classify: 'context_overflow',
    retryable: false,
  },
];

export function createLLMError(
  kind: LLMErrorKind,
  message: string,
  metadata: LLMErrorMetadata = {},
): LLMError {
  return new LLMError(kind, message, metadata);
}

/**
 * Retry-After 超过此阈值时，重试循环无法在预算内 honor 服务端要求的等待：
 * backoff 会被钳到单次退避上限（默认 60s），重试立即再次触发限流、烧光重试预算。
 * 此时改为不可重试的 rate_limited 上浮，让 AutonomousFaultPolicy 把任务挂到 waiting_external，
 * cooldown 到期再由 Leader 驱动，而非 worker 空转烧 token。阈值 = 默认 maxBackoffMs。
 */
const RATE_LIMIT_SURFACE_MS = 60_000;

export function classifyLLMError(
  error: unknown,
  metadata: LLMErrorMetadata = {},
): LLMError {
  if (error instanceof LLMError) {
    return error;
  }

  const embedded = error && typeof error === 'object' ? (error as Record<string, unknown>).classified : undefined;
  if (embedded instanceof LLMError) {
    return embedded;
  }

  const rawMessage = extractRawMessage(error);
  const classifyText = collectErrorText(error) || rawMessage;
  const fields: ExtractedErrorFields = {
    rawMessage,
    classifyText,
    lowerText: classifyText.toLowerCase(),
    statusCode: metadata.statusCode ?? extractStatusCode(error),
    errorCode: normalizeToken(metadata.errorCode) ?? normalizeToken(extractStringField(error, ['code', 'errorCode', 'error_code'])),
    errorType: normalizeToken(metadata.errorType) ?? normalizeToken(extractStringField(error, ['type', 'errorType', 'error_type'])),
    retryAfterMs: metadata.retryAfterMs ?? extractRetryAfterMs(error),
  };

  let classified: LLMError | undefined;
  for (const rule of CLASSIFICATION_RULES) {
    if (matchesStructured(rule, fields)) {
      classified = applyClassificationRule(rule, fields, metadata, 'structural');
      break;
    }
  }

  if (!classified) {
    for (const rule of CLASSIFICATION_RULES) {
      if (matchesText(rule, fields)) {
        classified = applyClassificationRule(rule, fields, metadata, 'text-fallback');
        break;
      }
    }
  }

  if (!classified) {
    if ((fields.statusCode ?? 0) >= 400) {
      classified = createLLMError('provider_error', rawMessage, {
        ...metadata,
        statusCode: fields.statusCode,
        errorCode: fields.errorCode,
        errorType: fields.errorType,
        rawMessage,
        retryAfterMs: fields.retryAfterMs,
        retryable: fields.statusCode === 429 || (fields.statusCode ?? 0) >= 500,
        classifiedBy: 'structural',
        classificationRuleId: 'http-status-fallback',
      });
    } else {
      classified = createLLMError('unknown_error', rawMessage, {
        ...metadata,
        statusCode: fields.statusCode,
        errorCode: fields.errorCode,
        errorType: fields.errorType,
        rawMessage,
        retryAfterMs: fields.retryAfterMs,
        classifiedBy: 'none',
      });
    }
  }

  // 单出口 chokepoint：服务端 Retry-After 超过重试预算可 honor 的上限 → 不可重试 rate_limited。
  // 携带真实 retryAfterMs 供上层展示「N 分钟后再试」并据此调度。
  if (classified.retryable && classified.retryAfterMs && classified.retryAfterMs > RATE_LIMIT_SURFACE_MS) {
    classified = new LLMError('rate_limited', rawMessage, {
      provider: classified.provider,
      model: classified.model,
      statusCode: classified.statusCode,
      errorCode: classified.errorCode,
      errorType: classified.errorType,
      rawMessage,
      retryAfterMs: classified.retryAfterMs,
      retryable: false,
      classifiedBy: 'structural',
      classificationRuleId: 'rate-limit-cooldown',
    });
  }

  return classified;
}

export function formatLLMErrorLabel(error: LLMError): string {
  switch (error.llmErrorKind) {
    case 'connect_timeout':
      return errorLabel('error.connect_timeout');
    case 'request_timeout':
      return errorLabel('error.request_timeout');
    case 'stream_timeout':
      return errorLabel('error.stream_timeout');
    case 'stream_idle_abort':
      return errorLabel('error.stream_timeout');
    case 'network_error':
      return errorLabel('error.network_error');
    case 'provider_error':
      return errorLabel('error.provider_error');
    case 'rate_limited':
      return errorLabel('error.rate_limited');
    case 'context_overflow':
      return errorLabel('error.context_overflow');
    case 'auth_error':
      return errorLabel('error.auth_error');
    case 'quota_exhausted':
      return errorLabel('error.quota_exhausted');
    case 'parse_error':
      return errorLabel('error.parse_error');
    default:
      return errorLabel('error.unknown_error');
  }
}
