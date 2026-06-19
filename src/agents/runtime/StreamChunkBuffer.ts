/**
 * StreamChunkBuffer
 *
 * 把 LLM 流式 chunk 聚合成更大的片段再 emit，避免每个 token 触发一次事件。
 *
 * 设计目标：Leader 与 Worker(BaseAgent)、文本与 thinking 共用一份缓冲实现，
 * 修复历史上 thinking 缓冲忘记定时 flush / finally flush 导致短链思考被吞的 bug。
 *
 * 触发 flush 的三种路径：
 *  - 阈值触发：累积长度 >= flushThreshold 立即 flush
 *  - 换行触发：chunk 内含 \n 立即 flush（保留行边界，便于 UI 分行渲染）
 *  - 定时触发：append 后启动定时器，达到 idleFlushMs 自动 flush（保证小片段也能露出）
 *  - 显式 flush：调用方在 finally 中 flush()，保证最后一段不丢
 *
 * 与 src/tui/state/streamBuffer.ts 的区别：
 *  - 这里聚合的是「单条流」，append → onFlush(text) 同步交付
 *  - TUI streamBuffer 是「多 channel × 多 field」的 React 渲染节流，关注的是 setState 频率
 *  两边问题域不同，不能合并。
 */
export interface StreamChunkBufferOptions {
  /** 累积长度达到此阈值立即 flush */
  flushThreshold: number;
  /** append 后多少毫秒未再追加则 flush（默认 10ms） */
  idleFlushMs?: number;
  /** flush 时同步交付聚合后的字符串，空字符串不会调用 */
  onFlush: (text: string) => void;
}

export interface StreamChunkBuffer {
  /** 追加一段 chunk，按规则触发 flush */
  append(chunk: string): void;
  /** 强制 flush 当前缓冲（无论长度），并清掉定时器 */
  flush(): void;
  /**
   * 丢弃当前缓冲，不交付任何残留。
   *
   * 用于 LlmGuard 外层重试场景：上一次 attempt 已经流出去的部分要被前端 discard，
   * 残留在 buffer 里的更不能再 flush 出去和下一次 attempt 的内容拼接。
   * 不同于 dispose（终结使用），reset 后 buffer 仍可继续 append。
   */
  reset(): void;
  /** 释放资源（清定时器，丢弃缓冲，不交付） */
  dispose(): void;
}

export function createStreamChunkBuffer(options: StreamChunkBufferOptions): StreamChunkBuffer {
  const idleFlushMs = options.idleFlushMs ?? 10;
  const parts: string[] = [];
  let len = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const deliver = () => {
    if (len === 0 || disposed) return;
    const text = parts.join('');
    parts.length = 0;
    len = 0;
    options.onFlush(text);
  };

  const flush = () => {
    if (disposed) return;
    clearTimer();
    deliver();
  };

  const append = (chunk: string) => {
    if (!chunk || disposed) return;
    parts.push(chunk);
    len += chunk.length;
    clearTimer();
    if (len >= options.flushThreshold || chunk.includes('\n')) {
      deliver();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      deliver();
    }, idleFlushMs);
  };

  const dispose = () => {
    disposed = true;
    clearTimer();
    parts.length = 0;
    len = 0;
  };

  const reset = () => {
    if (disposed) return;
    clearTimer();
    parts.length = 0;
    len = 0;
  };

  return { append, flush, reset, dispose };
}
