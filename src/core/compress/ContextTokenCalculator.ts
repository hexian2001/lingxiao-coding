/**
 * ContextTokenCalculator — token counting, encoder cache, and threshold logic.
 *
 * Extracted from ContextManager.ts to keep token-related concerns isolated.
 */
import { getEncoding } from 'js-tiktoken';
import { thinkingBlocksToText, type ChatMessage } from '../../llm/types.js';
import { config as runtimeConfig } from '../../config.js';
import { getEncodingForModel } from '../TiktokenCache.js';

export type TiktokenEncoder = {
  encode: (text: string) => { length: number };
};

// Global encoder cache — shared across all ContextManager instances to avoid
// re-initializing the WASM tiktoken module (which takes ~30s on first load).
const _globalEncoderCache = new Map<string, TiktokenEncoder>();

export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_THRESHOLD_RATIO = 0.8;
/** autocompact 阈值下限，防止极小窗口退化到 0。 */
const AUTOCOMPACT_MIN_THRESHOLD = 10_000;
/**
 * 触发压缩前从上下文窗口预留的预算（输出 token + system prompt + tools schema 开销）。
 * 取「窗口的 15%」与「12K 下限」的较大值，与 CheckpointBoundary.computeThresholds 的
 * RESERVED_TOKENS(13K) 预留思路对齐。此前直接 contextLimit*0.8 不预留输出，大输出模型
 * （如 64K output）会在压缩摘要本身 + 下一轮输出时溢出真实窗口而 400。
 */
const RESERVED_OUTPUT_OVERHEAD_RATIO = 0.05;
const RESERVED_OUTPUT_OVERHEAD_FLOOR = 12_000;

function defaultLeaderModel(): string {
  return runtimeConfig.llm.leader_model;
}

/**
 * Get or create a tiktoken encoder for the given model.
 */
export async function getEncoder(model: string): Promise<TiktokenEncoder> {
  if (!_globalEncoderCache.has(model)) {
    try {
      const encodingName = getEncodingForModel(model);
      const encoder = getEncoding(encodingName) as unknown as TiktokenEncoder;
      _globalEncoderCache.set(model, encoder);
    } catch (error) {
      console.warn(`[ContextTokenCalculator] 获取编码器失败：${error}，回退 cl100k_base`);
      const encoder = getEncoding('cl100k_base') as unknown as TiktokenEncoder;
      _globalEncoderCache.set(model, encoder);
    }
  }
  return _globalEncoderCache.get(model)!;
}

/**
 * Count tokens for a list of messages using tiktoken.
 */
export async function calculateTokens(
  messages: ChatMessage[],
  model: string,
): Promise<number> {
  const encoder = await getEncoder(model);
  let count = 0;

  for (const msg of messages) {
    count += 4;

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && 'type' in part) {
          const textPart = part as { type: string; text?: string };
          if (textPart.type === 'text' && textPart.text) {
            count += encoder.encode(textPart.text).length;
          } else if (textPart.type === 'image_url') {
            count += 1000;
          } else if (textPart.type === 'image_blob_ref') {
            count += 50;
          }
        } else if (typeof part === 'string') {
          count += encoder.encode(part).length;
        }
      }
    } else if (typeof content === 'string') {
      count += encoder.encode(content).length;
    } else if (content !== null && content !== undefined) {
      count += encoder.encode(JSON.stringify(content)).length;
    }

    if (msg.tool_calls?.length) {
      count += encoder.encode(JSON.stringify(msg.tool_calls)).length;
    }

    if (msg.thinking && msg.thinking.length > 0) {
      count += encoder.encode(thinkingBlocksToText(msg.thinking)).length;
    }
  }

  return count;
}

/**
 * Batch-calculate per-message token counts (single encoder pass).
 */
export async function batchCalculateTokenCounts(
  messages: ChatMessage[],
  model: string,
): Promise<number[]> {
  const encoder = await getEncoder(model);
  const counts: number[] = [];

  for (const msg of messages) {
    let count = 4; // per-message overhead
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && 'type' in part) {
          const textPart = part as { type: string; text?: string };
          if (textPart.type === 'text' && textPart.text) {
            count += encoder.encode(textPart.text).length;
          } else if (textPart.type === 'image_url') {
            count += 1000;
          } else if (textPart.type === 'image_blob_ref') {
            count += 50;
          }
        } else if (typeof part === 'string') {
          count += encoder.encode(part).length;
        }
      }
    } else if (typeof content === 'string') {
      count += encoder.encode(content).length;
    } else if (content !== null && content !== undefined) {
      count += encoder.encode(JSON.stringify(content)).length;
    }

    if (msg.tool_calls?.length) {
      count += encoder.encode(JSON.stringify(msg.tool_calls)).length;
    }

    if (msg.thinking && msg.thinking.length > 0) {
      count += encoder.encode(thinkingBlocksToText(msg.thinking)).length;
    }

    counts.push(count);
  }

  return counts;
}

// ─── 字节度量 ──────────────────────────────────────────────────────────────
//
// 动机：HTTP 413 "Payload Too Large" 是网关（nginx client_max_body_size / 云 LB）
// 对**请求 body 字节大小**的限制，与模型的 token 上下文窗口无关。一段 300K token
// 的中文/JSON/base64 内容序列化成请求 body 可能好几 MB，即使远未触及 token 阈值
// 也会被网关以 413 拒绝。因此压缩决策必须同时感知字节维度，而不能只看 token。

/** 触发字节级压缩的安全系数：实际触发阈值 = maxRequestBytes * 此系数，留余量给波动。 */
const BYTE_THRESHOLD_RATIO = 0.85;

/**
 * 计算单条消息序列化后的近似字节数（UTF-8）。
 * 覆盖 content / tool_calls / thinking，与发往 provider 的 body 内容对齐。
 */
export function calculateMessageBytes(message: ChatMessage): number {
  let bytes = 0;
  const content = message.content;
  if (typeof content === 'string') {
    bytes += Buffer.byteLength(content, 'utf8');
  } else if (content !== null && content !== undefined) {
    bytes += Buffer.byteLength(JSON.stringify(content), 'utf8');
  }
  if (message.tool_calls?.length) {
    bytes += Buffer.byteLength(JSON.stringify(message.tool_calls), 'utf8');
  }
  if (message.thinking && message.thinking.length > 0) {
    bytes += Buffer.byteLength(thinkingBlocksToText(message.thinking), 'utf8');
  }
  // 每条消息的 JSON 框架开销（role/分隔符/字段名等）近似常量。
  bytes += 32;
  return bytes;
}

/**
 * 计算整个消息列表序列化后的近似请求体字节数（UTF-8）。
 * 这是对发往 provider 的 messages 数组 body 大小的近似（不含 system/tools schema，
 * 由调用方在预算里预留余量）。
 */
export function calculateRequestBytes(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += calculateMessageBytes(msg);
  }
  return total;
}

/**
 * 由请求体字节预算推导触发压缩的字节阈值。
 * 低于预算即留出余量给 system prompt + tools schema + JSON 框架。
 */
export function calculateByteThreshold(maxRequestBytes: number): number {
  return Math.floor(maxRequestBytes * BYTE_THRESHOLD_RATIO);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function modelOverridePatternMatches(model: string, pattern: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedModel || !normalizedPattern) return false;
  if (normalizedModel === normalizedPattern) return true;
  if (normalizedPattern.indexOf('*') === -1) return false;

  const globPattern = normalizedPattern
    .split('*')
    .map(escapeRegExpLiteral)
    .join('.*');
  return new RegExp(`^${globPattern}$`).test(normalizedModel);
}

/**
 * Calculate the autocompact threshold based on the effective context limit.
 *
 * 纯函数：直接基于传入的 maxTokens（调用方已通过 resolveEffectiveContextLimit 解析为
 * effectiveContextLimit——优先级 token_limit > 模型窗口 > context_max_tokens > 200K）
 * 扣除「输出 + system + tools」预留预算后按 0.8 触发。本函数不再独立读取 config，
 * 保证「显示分母 maxTokens」与「触发阈值」同源——状态栏百分比自动诚实。
 */
export function calculateThreshold(
  maxTokens: number,
  _model: string = defaultLeaderModel(),
): number {
  const effectiveContextLimit = Math.max(1, maxTokens);
  const reserve = Math.max(
    RESERVED_OUTPUT_OVERHEAD_FLOOR,
    Math.floor(effectiveContextLimit * RESERVED_OUTPUT_OVERHEAD_RATIO),
  );
  const usable = Math.max(1, effectiveContextLimit - reserve);
  return Math.max(AUTOCOMPACT_MIN_THRESHOLD, Math.floor(usable * AUTOCOMPACT_THRESHOLD_RATIO));
}
