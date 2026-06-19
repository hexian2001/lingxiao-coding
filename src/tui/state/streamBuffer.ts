export type StreamBufferEntry = {
  currentStream?: string[];
  currentThinkingStream?: string[];
};

export type StreamBufferFlush = Record<string, StreamBufferEntry>;

type TimeoutHandle = ReturnType<typeof setTimeout> | number;

export type StreamBufferCoordinatorOptions = {
  selectDelay: (channel?: string) => number;
  onFlush: (pending: StreamBufferFlush) => void;
  onFlushChannel?: (channel: string, entry: StreamBufferEntry) => void;
  /** 单次累积最大 chunk 数，超过后立即 flush（避免 buffer 无限膨胀） */
  maxChunksPerChannel?: number;
  getNow?: () => number;
  setTimeoutFn?: (handler: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
};

export type StreamBufferCoordinator = {
  appendChunk: (channel: string, field: keyof StreamBufferEntry, chunk: string) => void;
  flush: (onlyChannel?: string) => void;
  drop: (channel: string) => void;
  dispose: () => void;
  getPendingChannels: () => string[];
  getDueAt: () => number | null;
};

export function createStreamBufferCoordinator(options: StreamBufferCoordinatorOptions): StreamBufferCoordinator {
  const buffer: StreamBufferFlush = {};
  const chunkCounts: Record<string, number> = {};
  const maxChunks = options.maxChunksPerChannel ?? 50;
  // 每个 channel 独立的定时器，避免短延迟 channel 抢占长延迟 channel
  const timers = new Map<string, { timeout: TimeoutHandle; dueAt: number }>();
  const getNow = options.getNow ?? Date.now;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const clearChannelTimer = (channel: string) => {
    const t = timers.get(channel);
    if (t) {
      clearTimeoutFn(t.timeout);
      timers.delete(channel);
    }
  };

  const clearAllTimers = () => {
    for (const [channel] of timers) {
      clearChannelTimer(channel);
    }
  };

  const flush = (onlyChannel?: string) => {
    if (onlyChannel) {
      const entry = buffer[onlyChannel];
      if (!entry) return;
      delete buffer[onlyChannel];
      delete chunkCounts[onlyChannel];
      clearChannelTimer(onlyChannel);
      if (options.onFlushChannel) {
        options.onFlushChannel(onlyChannel, entry);
      } else {
        options.onFlush({ [onlyChannel]: entry });
      }
      return;
    }
    const keys = Object.keys(buffer);
    if (keys.length === 0) return;
    const pending = { ...buffer };
    for (const key of keys) {
      delete buffer[key];
      delete chunkCounts[key];
    }
    clearAllTimers();
    options.onFlush(pending);
  };

  const schedule = (channel: string) => {
    const delay = options.selectDelay(channel);
    const now = getNow();
    const nextDueAt = now + delay;
    const existing = timers.get(channel);
    // 如果已有更早或相同的定时器，不覆盖
    if (existing && existing.dueAt <= nextDueAt) {
      return;
    }
    clearChannelTimer(channel);
    const timeout = setTimeoutFn(() => {
      timers.delete(channel);
      flush(channel);
    }, Math.max(0, nextDueAt - now));
    timers.set(channel, { timeout, dueAt: nextDueAt });
  };

  const appendChunk = (channel: string, field: keyof StreamBufferEntry, chunk: string) => {
    if (!chunk) return;
    const entry = buffer[channel] || (buffer[channel] = {});
    const existing = entry[field];
    if (existing) {
      existing.push(chunk);
    } else {
      entry[field] = [chunk];
    }
    // 累积超限时立即 flush，避免单次渲染合并过多文本导致 layout 开销过大
    const count = (chunkCounts[channel] = (chunkCounts[channel] || 0) + 1);
    if (count >= maxChunks) {
      clearChannelTimer(channel);
      flush(channel);
      return;
    }
    schedule(channel);
  };

  const drop = (channel: string) => {
    if (!buffer[channel]) return;
    delete buffer[channel];
    delete chunkCounts[channel];
    clearChannelTimer(channel);
  };

  return {
    appendChunk,
    flush,
    drop,
    dispose: clearAllTimers,
    getPendingChannels: () => Object.keys(buffer),
    getDueAt: () => {
      let earliest: number | null = null;
      for (const t of timers.values()) {
        if (earliest === null || t.dueAt < earliest) earliest = t.dueAt;
      }
      return earliest;
    },
  };
}
