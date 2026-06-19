/**
 * StreamingToolCallParser - 流式工具调用健壮解析器
 *
 * 基于 qwen-code 的 StreamingToolCallParser 实现，解决流式工具调用中的 JSON 碎片化问题。
 *
 * 处理的问题：
 * - 工具调用以不同 chunk 形状到达（空字符串、部分 JSON、完整对象）
 * - 工具调用可能缺少 ID、name，或有不一致的 index
 * - 多个工具调用可同时处理交错 chunk
 * - index 冲突（同一 index 被不同 tool call 重用）
 * - JSON 参数跨多个 chunk 碎片化，需要重建
 *
 * 参考：/root/lingxiao/qwen-code/packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts
 */

/**
 * 完成的工具调用
 */
export interface CompletedToolCall {
  id?: string;
  name?: string;
  args: Record<string, unknown>;
  index: number;
  rawArguments?: string;
  parseError?: string;
  malformed?: boolean;
  /**
   * 当 name 存在但 arguments buffer 完全为空时为 true。
   * 可能是合法零参调用，也可能是 streaming 截断导致 args 丢失。
   * 上层应结合 tool schema 判断：若工具有 required params 则视为截断。
   */
  emptyArgs?: boolean;
}

export class StreamingToolCallParser {
  /** 每个 tool call index 的累积 JSON buffer */
  private buffers: Map<number, string> = new Map();
  /** 每个 tool call index 的 JSON 嵌套深度 */
  private depths: Map<number, number> = new Map();
  /** 每个 tool call index 是否在字符串字面量内 */
  private inStrings: Map<number, boolean> = new Map();
  /** 每个 tool call index 下一个字符是否应视为转义 */
  private escapes: Map<number, boolean> = new Map();
  /** 每个 tool call index 的元数据（id, name） */
  private toolCallMeta: Map<number, { id?: string; name?: string }> = new Map();
  /** tool call ID → 实际 index 映射（用于冲突检测） */
  private idToIndexMap: Map<string, number> = new Map();
  /** 用于生成新 index 的计数器 */
  private nextAvailableIndex: number = 0;

  /**
   * 流式期间纯拼接入口（热路径）。
   *
   * 不逐字符跑 depth/inString/escape 状态机，不尝试 JSON.parse；
   * 仅维护 ID→index 单调映射 + buffer 拼接 + 元数据。
   *
   * 这样大入参（80KB 大型工具调用等）流式期间从 O(N²) 的 JSON.parse 累积
   * 退化为 O(N) 字符串拼接；最终 parse 在 finalize() 一次性完成。
   *
   * ID 冲突策略简化：首次见到 id 分配 nextAvailableIndex；重复 id 复用映射。
   * OpenAI 流式实际不会复用 index（每个 tool_call.index 唯一），即便残留拼接，
   * finalize() 的 4 级 fallback 仍能修复。
   */
  appendChunk(
    index: number,
    chunk: string,
    id?: string,
    name?: string,
  ): { actualIndex: number } {
    let actualIndex = index;

    if (id) {
      const mapped = this.idToIndexMap.get(id);
      if (mapped !== undefined) {
        actualIndex = mapped;
      } else {
        // 新 id：若 index 已被其他完成 buffer 占用，分配新 index
        if (this.buffers.has(index)) {
          const existingMeta = this.toolCallMeta.get(index);
          if (existingMeta?.id && existingMeta.id !== id) {
            actualIndex = this.findNextAvailableIndex();
          }
        }
        this.idToIndexMap.set(id, actualIndex);
      }
    }

    if (!this.buffers.has(actualIndex)) {
      this.buffers.set(actualIndex, '');
      this.depths.set(actualIndex, 0);
      this.inStrings.set(actualIndex, false);
      this.escapes.set(actualIndex, false);
      this.toolCallMeta.set(actualIndex, {});
    }

    const meta = this.toolCallMeta.get(actualIndex)!;
    if (id) meta.id = id;
    if (name) meta.name = name;

    if (chunk) {
      this.buffers.set(actualIndex, this.buffers.get(actualIndex)! + chunk);
    }

    return { actualIndex };
  }

  /**
   * 流末扫描：把 appendChunk 拼好的 buffer 一次性跑状态机，重算 depth/inString/escape。
   *
   * 状态机可交换性：对完整字符串扫描 = 对若干分片连续扫描，结果等价。
   * 这一步是 finalize() / hasIncompleteAfterFinalize() 的前置。
   */
  private finalizeStates(): void {
    for (const [index, buffer] of this.buffers.entries()) {
      let depth = 0;
      let inString = false;
      let escape = false;

      for (const char of buffer) {
        if (!inString) {
          if (char === '{' || char === '[') depth++;
          else if (char === '}' || char === ']') depth--;
        }
        if (char === '"' && !escape) {
          inString = !inString;
        }
        escape = char === '\\' && !escape;
      }

      this.depths.set(index, depth);
      this.inStrings.set(index, inString);
      this.escapes.set(index, escape);
    }
  }

  /**
   * 流末一次性产出所有完成的工具调用。
   *
   * 行为：先把所有 buffer 跑完状态机 → 再走 getCompletedToolCalls 的 4 级 fallback。
   */
  finalize(): CompletedToolCall[] {
    this.finalizeStates();
    return this.getCompletedToolCalls();
  }

  /**
   * 流末截断检测。
   *
   * 与 hasIncompleteToolCalls 等价，区别仅在前置一次 finalizeStates 把状态扫到位。
   */
  hasIncompleteAfterFinalize(): boolean {
    this.finalizeStates();
    return this.hasIncompleteToolCalls();
  }

  /**
   * 获取指定 index 的工具调用元数据
   */
  getToolCallMeta(index: number): { id?: string; name?: string } {
    return this.toolCallMeta.get(index) || {};
  }

  /**
   * 获取所有已完成的工具调用
   *
   * 在流式结束时调用，尝试解析累积的 buffer。
   */
  getCompletedToolCalls(): CompletedToolCall[] {
    const completed: CompletedToolCall[] = [];

    for (const [index, buffer] of this.buffers.entries()) {
      const meta = this.toolCallMeta.get(index);
      if (!meta?.name) continue;

      // 零参函数：name 存在但 buffer 为空 → 可能是合法无参调用（如 get_current_time()），
      // 也可能是 arguments streaming chunks 丢失/截断导致 buffer 为空。
      // 标记 emptyArgs=true 让上层决策：若 tool schema 有 required params 应视为截断。
      if (!buffer.trim()) {
        completed.push({
          id: meta.id,
          name: meta.name,
          args: {},
          index,
          emptyArgs: true,
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      let parseError: string | undefined;
      let malformed = false;

      try {
        args = JSON.parse(buffer);
      } catch (error) { /* expected: incomplete JSON from streaming — apply repair strategy */
        parseError = error instanceof Error ? error.message : String(error);
        // 多级修复策略
        const inString = this.inStrings.get(index) || false;
        const depth = this.depths.get(index) || 0;

        if (inString) {
          // 截断在字符串值内部：逐级尝试闭合
          // 1. 闭合字符串
          try { args = JSON.parse(buffer + '"'); } catch { /* expected: need deeper closure */
            // 2. 闭合字符串 + 补齐所有未闭合括号
            let suffix = '"';
            for (let i = 0; i < depth; i++) suffix += '}';
            try { args = JSON.parse(buffer + suffix); } catch { /* expected: use safeJsonParse fallback */
              // 3. 最终 fallback
              const repaired = this.safeJsonParse(buffer, index, undefined);
              if (repaired == null) malformed = true;
              else args = repaired;
            }
          }
        } else {
          const repaired = this.safeJsonParse(buffer, index, undefined);
          if (repaired == null) malformed = true;
          else args = repaired;
        }
      }

      completed.push({
        id: meta.id,
        name: meta.name,
        args,
        index,
        rawArguments: buffer,
        parseError,
        malformed,
      });
    }

    return completed;
  }

  /**
   * 检查是否有任何未完成的工具调用
   *
   * 用于检测流式截断：如果流式结束时仍有未完成的 tool call，
   * 说明输出被截断，应触发重试。
   */
  hasIncompleteToolCalls(): boolean {
    for (const [index] of this.buffers.entries()) {
      const meta = this.toolCallMeta.get(index);
      if (!meta?.name) continue;

      const depth = this.depths.get(index) || 0;
      const inString = this.inStrings.get(index) || false;
      if (depth > 0 || inString) {
        return true;
      }
    }
    return false;
  }

  /**
   * 查找下一个可用的 index
   */
  private findNextAvailableIndex(): number {
    while (this.buffers.has(this.nextAvailableIndex)) {
      const buffer = this.buffers.get(this.nextAvailableIndex)!;
      const depth = this.depths.get(this.nextAvailableIndex)!;
      const meta = this.toolCallMeta.get(this.nextAvailableIndex);

      if (!buffer.trim() || depth > 0 || !meta?.id) {
        return this.nextAvailableIndex;
      }

      try {
        JSON.parse(buffer);
        if (depth === 0) {
          this.nextAvailableIndex++;
          continue;
        }
      } catch { /* expected: buffer is still incomplete */
        return this.nextAvailableIndex;
      }

      this.nextAvailableIndex++;
    }
    return this.nextAvailableIndex++;
  }

  /**
   * 安全的 JSON 解析（降级策略）
   * 使用 finalizeStates() 已跟踪的精确 depth 而非 regex counting（regex 会误匹配字符串字面量内的括号）
   */
  private safeJsonParse<T>(text: string, index: number, fallback: T): T {
    try {
      const trimmed = text.trim();
      if (!trimmed) return fallback;

      const depth = this.depths.get(index) || 0;
      const inString = this.inStrings.get(index) || false;

      let fixed = trimmed;

      // 如果截断在字符串值内部，先闭合字符串
      if (inString) {
        fixed += '"';
      }

      // depth > 0 意味着有未闭合的 { 或 [，逐层补齐
      for (let i = 0; i < depth; i++) fixed += '}';

      try {
        return JSON.parse(fixed) as T;
      } catch { /* expected: closing braces insufficient — try brackets */
        // 如果补 } 失败，尝试补 ]（可能是数组未闭合）
        if (depth > 0) {
          let altFixed = inString ? trimmed + '"' : trimmed;
          for (let i = 0; i < depth; i++) altFixed += ']';
          try {
            return JSON.parse(altFixed) as T;
          } catch { /* fall through */ }
        }
        return fallback;
      }
    } catch { /* expected: buffer completely unparseable */
      return fallback;
    }
  }
}
