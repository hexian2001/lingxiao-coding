import { contentToPlainText, thinkingBlocksToText, type MessageContent, type ThinkingBlock, type ToolCall } from './types.js';
import { getCachedEncoder } from '../core/TiktokenCache.js';

/** once-flag: 避免 tiktoken 不可用时每次调用都打印 warn */
let _warnedTiktokenUnavailable = false;

/**
 * Token 计数器 - 完整复刻 Python 版本
 * 
 * 提供粗略和精确的 token 计数功能
 */

/**
 * 粗略估计 token 数量
 * 中文约 1.5 字符/token，英文约 4 字符/token
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  const encoder = getCachedEncoder('cl100k_base');
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch (err) {
      // tiktoken 编码失败时降级为启发式，仅首次打印 warn
      if (!_warnedTiktokenUnavailable) {
        _warnedTiktokenUnavailable = true;
        console.warn('[token_counter] tiktoken encode failed, falling back to heuristic:', err);
      }
    }
  } else {
    // encoder 未能加载（tiktoken wasm 初始化失败），仅首次打印 warn
    if (!_warnedTiktokenUnavailable) {
      _warnedTiktokenUnavailable = true;
      console.warn('[token_counter] tiktoken encoder unavailable, using heuristic estimate');
    }
  }

  // 分类统计 CJK 字符（中文、日文假名、韩文）和其他字符
  let cjkChars = 0;
  for (const c of text) {
    const code = c.codePointAt(0)!;
    // CJK 统一汉字
    if (code >= 0x4e00 && code <= 0x9fff) cjkChars++;
    // 日文平假名 + 片假名
    else if (code >= 0x3040 && code <= 0x30ff) cjkChars++;
    // 韩文音节
    else if (code >= 0xac00 && code <= 0xd7af) cjkChars++;
  }

  const otherChars = text.length - cjkChars;
  // CJK ~1.5 chars/token, 其他 ~4 chars/token
  return Math.floor(cjkChars / 1.5 + otherChars / 4);
}

/**
 * 计算消息列表的 token 数量
 */
type TokenCountableMessage = {
  role: string;
  content?: MessageContent;
  tool_calls?: ToolCall[];
  thinking?: ThinkingBlock[];
  /** 工具结果消息引用的 tool_call id，回传给 provider 时计入请求体 */
  tool_call_id?: string;
  /** 部分 provider 支持的消息 name 字段（function/tool 名等） */
  name?: string;
};

/** 每个 tool_call 的结构开销（JSON 包裹 id/type/function 字段等），约 4 token */
const TOOL_CALL_STRUCTURE_OVERHEAD = 4;

export function countMessagesTokens(messages: TokenCountableMessage[]): number {
  let total = 0;

  for (const msg of messages) {
    // 计算内容 token
    if (msg.content) {
      total += countTokens(contentToPlainText(msg.content));
    }

    // 工具调用也计入：函数名、调用 id、参数体，以及每个 tool_call 的结构开销。
    // 仅计 arguments 会系统性低估 → 压缩触发偏晚。
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name) {
          total += countTokens(tc.function.name);
        }
        if (tc.id) {
          total += countTokens(tc.id);
        }
        if (tc.function?.arguments) {
          total += countTokens(tc.function.arguments);
        }
        // 每个 tool_call 的 JSON 结构包裹开销（type/function 等字段）
        total += TOOL_CALL_STRUCTURE_OVERHEAD;
      }
    }

    // tool-result 消息的 tool_call_id（回传给 provider 时计入请求体）
    if (msg.tool_call_id) {
      total += countTokens(msg.tool_call_id);
    }

    // 消息 name 字段（function/tool 名等）
    if (msg.name) {
      total += countTokens(msg.name);
    }

    // thinking blocks 计入
    if (msg.thinking && msg.thinking.length > 0) {
      total += countTokens(thinkingBlocksToText(msg.thinking));
    }

    // 角色开销（每条消息约 4 tokens）
    total += 4;
  }

  return total;
}

/**
 * 计算消息的 token 数量（单个消息）
 */
export function countMessageTokens(message: TokenCountableMessage): number {
  return countMessagesTokens([message]);
}

/**
 * Token 计数器类 - 提供更精确的计数
 */
export class TokenCounter {
  private totalPrompt: number = 0;
  private totalCompletion: number = 0;

  /**
   * 记录 token 使用
   */
  addUsage(promptTokens: number, completionTokens: number): void {
    this.totalPrompt += promptTokens;
    this.totalCompletion += completionTokens;
  }

  /**
   * 获取总 prompt token
   */
  getTotalPrompt(): number {
    return this.totalPrompt;
  }

  /**
   * 获取总 completion token
   */
  getTotalCompletion(): number {
    return this.totalCompletion;
  }

  /**
   * 获取总 token
   */
  getTotal(): number {
    return this.totalPrompt + this.totalCompletion;
  }

  /**
   * 重置计数器
   */
  reset(): void {
    this.totalPrompt = 0;
    this.totalCompletion = 0;
  }

  /**
   * 获取统计信息
   */
  getStats(): { prompt: number; completion: number; total: number } {
    return {
      prompt: this.totalPrompt,
      completion: this.totalCompletion,
      total: this.getTotal(),
    };
  }
}

// 全局 Token 计数器实例
let globalCounter: TokenCounter | null = null;

/**
 * 获取全局 Token 计数器
 */
export function getTokenCounter(): TokenCounter {
  if (!globalCounter) {
    globalCounter = new TokenCounter();
  }
  return globalCounter;
}

/**
 * 快速估算文本 token 数
 */
export function estimateTokens(text: string | object | null | undefined): number {
  if (!text) return 0;

  if (typeof text === 'string') {
    return countTokens(text);
  }

  return countTokens(JSON.stringify(text));
}

export default {
  countTokens,
  countMessagesTokens,
  countMessageTokens,
  TokenCounter,
  getTokenCounter,
  estimateTokens,
};
