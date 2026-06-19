/**
 * ToolLoopDetector — 工具调用死循环探针
 *
 * 仅在「同一个 toolName + 完全相同的 arguments」连续被调用 N 次时
 * 才报告为重复，避免误杀「同一工具但参数不同」的合法场景
 * （例如连续读多个不同文件）。
 *
 * 用法：
 *   const detector = new ToolLoopDetector({ threshold: 4 });
 *   detector.observe(toolCalls);
 *   if (detector.isLooping) emitWarning();
 *
 * 设计取舍：
 * - 指纹 = `${name}::${stableJson(args)}`，stableJson 对 object key 排序，
 *   这样 `{a:1,b:2}` 与 `{b:2,a:1}` 视为相同。
 * - 一轮里出现多个工具调用时，**只要本轮指纹集合与上一轮完全相同**才算 streak 累加；
 *   出现任何不同的指纹立即重置计数。
 * - 阈值默认 4 次（即第 5 次重复时报警），可由调用方覆盖。
 */

import type { ToolCall } from '../../llm/types.js';

export interface ToolLoopDetectorOptions {
  /** 连续相同的轮数阈值；超过此值返回 isLooping=true */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 4;

/** 把任意 JSON 值序列化为稳定字符串（递归排序对象 key） */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => JSON.stringify(k) + ':' + stableJson(obj[k]))
    .join(',');
  return '{' + body + '}';
}

/** 把 arguments 字段（可能是 string 或 object）规范化为对象 */
function normalizeArgs(raw: unknown): unknown {
  if (typeof raw === 'string') {
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw);
    } catch {
      // 解析失败时直接用原字符串当指纹的一部分
      return raw;
    }
  }
  return raw ?? {};
}

export function fingerprintToolCall(tc: ToolCall): string {
  const name = tc.function?.name ?? '<unknown>';
  const args = normalizeArgs(tc.function?.arguments);
  return `${name}::${stableJson(args)}`;
}

export class ToolLoopDetector {
  private readonly threshold: number;
  private lastSignature: string | null = null;
  private streak = 0;

  constructor(options: ToolLoopDetectorOptions = {}) {
    this.threshold = Math.max(2, options.threshold ?? DEFAULT_THRESHOLD);
  }

  /** 对单轮的工具调用集合做一次观察 */
  observe(toolCalls: ToolCall[] | null | undefined): void {
    if (!toolCalls || toolCalls.length === 0) {
      // 没有工具调用 → 不算 streak 也不重置（让纯文本轮不影响判定）
      return;
    }
    // 把同一轮的多个调用合成 multiset（排序后拼接），保证顺序无关
    const signature = toolCalls.map(fingerprintToolCall).sort().join('|');
    if (signature === this.lastSignature) {
      this.streak += 1;
    } else {
      this.lastSignature = signature;
      this.streak = 1;
    }
  }

  /** 判断当前是否已超过阈值 */
  get isLooping(): boolean {
    return this.streak >= this.threshold;
  }

  /** 返回当前累计连续次数 */
  get consecutiveCount(): number {
    return this.streak;
  }

  /** 返回当前签名（调试/日志用） */
  get currentSignature(): string | null {
    return this.lastSignature;
  }

  /** 手动重置（例如压缩重置后） */
  reset(): void {
    this.lastSignature = null;
    this.streak = 0;
  }
}
