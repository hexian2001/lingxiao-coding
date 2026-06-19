/**
 * extractTokenUsage — 统一从 LLM 原始 usage 对象中提取 TokenUsage。
 *
 * 历史上每个 provider 各有一份字段映射：
 *   - Anthropic: input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens
 *   - OpenAI:    prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 *   - Claude Code (CLI 流转 Anthropic schema): 同 Anthropic
 *   - Codex (Agents API): input_tokens / output_tokens / cached_input_tokens
 *
 * 4 处分别拷贝过 cache 抽取逻辑，常出现遗漏（例如 OpenAI 漏了 cache_creation）。
 * 这里收口成一个工具函数，所有 provider 走同一份字段探测。
 */

import type { TokenUsage } from './types.js';

export type UsageProvider = 'anthropic' | 'openai' | 'claude_code' | 'codex';

interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 从原始 usage 对象中提取归一化字段。
 *
 * 统一口径（关键）：promptTokens 一律为「毛输入」——包含 cache_read 与
 * cache_creation；totalTokens = promptTokens + completionTokens。这样
 * 无论哪个 provider，prompt / total 都自洽且都包含缓存，下游 /stats、
 * TUI header、CostService 拿到的都是真实消耗。
 *
 * 各 provider 的输入语义差异：
 *   - Anthropic / Claude Code：input_tokens 是「净输入」，不含 cache_read /
 *     cache_creation；真实总输入 = input_tokens + cache_read + cache_creation。
 *     旧逻辑把它当毛输入，total = net + output，缓存命中时严重少报。
 *   - OpenAI chat：prompt_tokens 已是毛输入，prompt_tokens_details.cached_tokens
 *     只是其子集。
 *   - OpenAI responses / Codex：input_tokens 已是毛输入，cached_input_tokens /
 *     input_tokens_details.cached_tokens 是其子集。
 */
function normalize(raw: Record<string, unknown>): NormalizedUsage | undefined {
  // cache_read 别名（覆盖各 provider schema）
  const promptDetails = (raw['prompt_tokens_details'] ?? raw['input_tokens_details']) as Record<string, unknown> | undefined;
  const cacheRead =
    asNumber(raw.cache_read_input_tokens) ??
    asNumber(raw['cached_input_tokens']) ??
    asNumber(promptDetails?.cached_tokens) ??
    asNumber(raw['cacheRead']) ??
    0;

  // cache_creation：目前只有 anthropic / claude code 暴露
  const cacheCreation =
    asNumber(raw.cache_creation_input_tokens) ??
    asNumber(raw['cacheCreation']) ??
    0;

  // 判定输入计数是否为「净输入」（需补回 cache 才是毛输入）。
  //   cache_read_input_tokens / cache_creation_input_tokens 是 Anthropic schema
  //   独有字段名，据此精确识别 Anthropic / Claude Code 的净输入语义。
  //   同时排除「已归一化结果再次进入」——归一化结果带 prompt_tokens（毛输入），
  //   流式 message_delta 会把上一轮 normalized usage 再喂回来，若再次叠加
  //   cache 会双计。
  const hasAnthropicCacheFields =
    'cache_read_input_tokens' in raw || 'cache_creation_input_tokens' in raw;
  const alreadyGrossPrompt = asNumber(raw.prompt_tokens) !== undefined;
  const isNetInput = hasAnthropicCacheFields && !alreadyGrossPrompt;

  const rawPrompt =
    asNumber(raw.prompt_tokens) ??
    asNumber(raw.input_tokens) ??
    asNumber(raw['inputTokens']);

  if (rawPrompt === undefined) return undefined;

  const promptTokens = isNetInput ? rawPrompt + cacheRead + cacheCreation : rawPrompt;

  const completionTokens =
    asNumber(raw.completion_tokens) ??
    asNumber(raw.output_tokens) ??
    asNumber(raw['outputTokens']) ??
    0;

  // total 一律重算为毛 prompt + completion：
  //   - Anthropic 不返回 total_tokens，旧逻辑用 net+output 漏掉全部 cache；
  //   - OpenAI 的 total_tokens == prompt_tokens + completion_tokens，与此一致。
  const totalTokens = promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
}

/**
 * 把 provider 原始 usage 抽成统一 TokenUsage。
 *
 * @param raw provider SDK 直接给出的 usage 对象（可能是流式累计值）
 * @param delta 流式 message_delta 时的增量 usage（仅 Anthropic 用，其他 provider 传 undefined）
 * @returns TokenUsage 或 undefined（raw 不可识别 / 不含 prompt 字段）
 */
export function extractTokenUsage(
  raw: unknown,
  delta?: Record<string, unknown> | undefined,
): TokenUsage | undefined {
  if ((!raw || typeof raw !== 'object') && !delta) return undefined;
  const base = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const normalized = normalize(base);
  if (!normalized) return undefined;

  // Anthropic 流式：completion 来自 message_delta.usage.output_tokens
  let completion = normalized.completionTokens;
  if (delta) {
    const deltaCompletion = asNumber(delta.output_tokens) ?? asNumber(delta.completion_tokens);
    if (deltaCompletion !== undefined) completion = deltaCompletion;
  }

  // total 统一为「毛输入 + 输出」，与 normalize 口径一致。
  // 流式 delta 仅用于刷新 completion，prompt 端不变。
  const result: TokenUsage = {
    prompt_tokens: normalized.promptTokens,
    completion_tokens: completion,
    total_tokens: normalized.promptTokens + completion,
  };
  if (normalized.cacheCreationInputTokens > 0) {
    result.cache_creation_input_tokens = normalized.cacheCreationInputTokens;
  }
  if (normalized.cacheReadInputTokens > 0) {
    result.cache_read_input_tokens = normalized.cacheReadInputTokens;
  }
  return result;
}

/**
 * Driver 使用的简化 usage 三元组（含 cache）。供 ClaudeCodeDriver / CodexDriver 用。
 */
export interface DriverUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
}

export function extractDriverUsage(raw: unknown): DriverUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const normalized = normalize(raw as Record<string, unknown>);
  if (!normalized) return undefined;
  return {
    prompt: normalized.promptTokens,
    completion: normalized.completionTokens,
    total: normalized.totalTokens,
    cacheRead: normalized.cacheReadInputTokens,
    cacheCreation: normalized.cacheCreationInputTokens,
  };
}
