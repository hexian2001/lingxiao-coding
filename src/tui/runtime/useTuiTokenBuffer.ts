import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CommandLogMessage } from '../../commands/types.js';
import {
  calculateContextPercent,
  calculateContextRatio,
  createTokenUsageBufferState,
  flushTokenUsageDelta,
  recordTokenUsageDelta,
  resolveContextMaxTokens,
  resolveContextTokens,
} from './tokenBufferState.js';
import { t } from '../../i18n.js';
import type { TuiEventPayload } from './useTuiEventBridge.js';

interface UseTuiTokenBufferOptions {
  setTokenUsage: Dispatch<SetStateAction<{ total: number }>>;
  setAgentTokens: Dispatch<SetStateAction<Record<string, number>>>;
  agentIdMapRef: MutableRefObject<Record<string, string>>;
  setCurrentContextTokenTotal: Dispatch<SetStateAction<number | undefined>>;
  setCurrentContextLimit: Dispatch<SetStateAction<number | undefined>>;
  setCurrentContextPct: Dispatch<SetStateAction<number | undefined>>;
  appendMessage: (channel: string, message: CommandLogMessage) => void;
  contextLimit: number;
}

const TOKEN_FLUSH_INTERVAL_MS = 2000;

/**
 * Centralizes token/context accounting for the TUI:
 *   - Buffers per-agent/total token deltas and flushes them on a timer
 *     to avoid re-rendering on every `token:usage` event.
 *   - Handles `context:runtime_updated` and `context:compressed` events,
 *     keeping the header context percentage in sync.
 *   - 实时从 text_chunk / tool_call_delta 估算 output token（对齐 CodeBuddy useTokenTracking）。
 */
export function useTuiTokenBuffer({
  setTokenUsage,
  setAgentTokens,
  agentIdMapRef,
  setCurrentContextTokenTotal,
  setCurrentContextLimit,
  setCurrentContextPct,
  appendMessage,
  contextLimit,
}: UseTuiTokenBufferOptions) {
  const tokenUsageBufferRef = useRef(createTokenUsageBufferState());
  const tokenUsageFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 实时 output token 估算（从流式 chunk 字符长度推导，按 4 chars/token 估算） */
  const streamingOutputTokensRef = useRef(0);
  /** 请求开始时间戳 */
  const streamingStartedAtRef = useRef<number | undefined>(undefined);

  const flushTokenUsage = useCallback(() => {
    tokenUsageFlushTimerRef.current = null;
    const delta = flushTokenUsageDelta(tokenUsageBufferRef.current);
    if (delta.total > 0) {
      setTokenUsage(prev => ({ total: prev.total + delta.total }));
    }
    const perAgent = delta.perAgent;
    if (Object.keys(perAgent).length > 0) {
      setAgentTokens(prev => {
        const next = { ...prev };
        for (const [name, value] of Object.entries(perAgent)) {
          next[name] = (next[name] || 0) + value;
        }
        return next;
      });
    }
  }, [setTokenUsage, setAgentTokens]);

  const handleTokenUsage = useCallback((event: TuiEventPayload<'token:usage'>) => {
    recordTokenUsageDelta(tokenUsageBufferRef.current, event, agentIdMapRef.current);
    if (!tokenUsageFlushTimerRef.current) {
      tokenUsageFlushTimerRef.current = setTimeout(flushTokenUsage, TOKEN_FLUSH_INTERVAL_MS);
    }
  }, [agentIdMapRef, flushTokenUsage]);

  const handleContextRuntimeUpdated = useCallback((event: TuiEventPayload<'context:runtime_updated'>) => {
    const payload = event as { state?: { currentTokens?: number; maxTokens?: number }; tokens?: number; maxTokens?: number };
    const tokens = resolveContextTokens(payload);
    const maxTokens = resolveContextMaxTokens(payload);
    const effectiveLimit = maxTokens && maxTokens > 0 ? maxTokens : contextLimit;
    if (maxTokens && maxTokens > 0) {
      setCurrentContextLimit(maxTokens);
    }
    if (tokens != null) {
      setCurrentContextTokenTotal(tokens);
      setCurrentContextPct(calculateContextRatio(tokens, effectiveLimit));
    }
  }, [contextLimit, setCurrentContextLimit, setCurrentContextPct, setCurrentContextTokenTotal]);

  const handleContextCompressed = useCallback((event: TuiEventPayload<'context:compressed'>) => {
    setCurrentContextTokenTotal(event.newTokens);
    setCurrentContextPct(calculateContextRatio(event.newTokens, contextLimit));
    appendMessage('main', {
      type: 'system',
      content: t('tui.event.context_compressed', event.oldTokens.toLocaleString(), event.newTokens.toLocaleString()),
    });
  }, [appendMessage, contextLimit, setCurrentContextPct, setCurrentContextTokenTotal]);

  const cancelPendingFlush = useCallback(() => {
    if (tokenUsageFlushTimerRef.current) {
      clearTimeout(tokenUsageFlushTimerRef.current);
      tokenUsageFlushTimerRef.current = null;
    }
  }, []);

  /**
   * 实时估算 output token：从 leader:text_chunk 到达时累加字符数。
   * 对齐 CodeBuddy useTokenTracking（按 4 chars/token 估算，CJK 1 char/token）。
   */
  const handleStreamingChunk = useCallback((event: { chunk?: string; partialJson?: string }) => {
    const text = event.chunk || event.partialJson || '';
    if (!text) return;
    // 简单估算：ASCII 4 字符 ≈ 1 token，非 ASCII 1 字符 ≈ 1 token
    let asciiCount = 0;
    let nonAsciiCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 0x80) asciiCount++;
      else nonAsciiCount++;
    }
    const tokens = Math.ceil(asciiCount / 4) + nonAsciiCount;
    streamingOutputTokensRef.current += tokens;
    if (!streamingStartedAtRef.current) {
      streamingStartedAtRef.current = Date.now();
    }
  }, []);

  /** 重置流式 token 计数（新一轮 LLM 调用时） */
  const resetStreamingTokens = useCallback(() => {
    streamingOutputTokensRef.current = 0;
    streamingStartedAtRef.current = undefined;
  }, []);

  /** 获取当前实时 output token 数 */
  const getStreamingOutputTokens = useCallback(() => streamingOutputTokensRef.current, []);

  /** 获取请求开始时间 */
  const getStreamingStartedAt = useCallback(() => streamingStartedAtRef.current, []);

  return {
    handleTokenUsage,
    handleContextRuntimeUpdated,
    handleContextCompressed,
    cancelPendingFlush,
    handleStreamingChunk,
    resetStreamingTokens,
    getStreamingOutputTokens,
    getStreamingStartedAt,
  };
}
