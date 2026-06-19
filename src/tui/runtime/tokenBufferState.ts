import type { TokenUsageView } from '../../contracts/types/TokenUsage.js';

export interface TokenUsageBufferState extends Pick<TokenUsageView, 'total'> {
  total: number;
  perAgent: Record<string, number>;
}

export function createTokenUsageBufferState(): TokenUsageBufferState {
  return { total: 0, perAgent: {} };
}

export function recordTokenUsageDelta(
  buffer: TokenUsageBufferState,
  event: { agentId?: string; usage?: { total?: number } },
  agentIdMap: Record<string, string>,
): void {
  const total = Number(event.usage?.total ?? 0);
  if (!Number.isFinite(total) || total <= 0) return;
  buffer.total += total;
  if (event.agentId) {
    const agentName = agentIdMap[event.agentId] || event.agentId;
    buffer.perAgent[agentName] = (buffer.perAgent[agentName] || 0) + total;
  }
}

export function flushTokenUsageDelta(buffer: TokenUsageBufferState): TokenUsageBufferState {
  const delta = { total: buffer.total, perAgent: { ...buffer.perAgent } };
  buffer.total = 0;
  buffer.perAgent = {};
  return delta;
}

export function resolveContextTokens(event: { state?: { currentTokens?: number }; tokens?: number }): number | undefined {
  return event.state?.currentTokens ?? event.tokens;
}

export function resolveContextMaxTokens(event: { state?: { maxTokens?: number }; maxTokens?: number }): number | undefined {
  return event.state?.maxTokens ?? event.maxTokens;
}

export function calculateContextPercent(tokens: number, contextLimit: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(contextLimit) || contextLimit <= 0) return 0;
  return Math.round((tokens / contextLimit) * 100);
}

export function calculateContextRatio(tokens: number | undefined, contextLimit: number | undefined): number | undefined {
  if (tokens === undefined || contextLimit === undefined) return undefined;
  if (!Number.isFinite(tokens) || !Number.isFinite(contextLimit) || contextLimit <= 0) return undefined;
  return Math.max(0, tokens / contextLimit);
}
