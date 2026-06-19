import type { LLMErrorKind } from '../llm/errors.js';
import type { RecoveryFaultClass } from './RecoveryRecords.js';

export type AutonomousFaultCategory =
  | 'internal_recoverable'
  | 'external_retryable'
  | 'external_blocking';

export type AutonomousRecoveryAction =
  | 'leader_takeover'
  | 'worker_restart'
  | 'worker_redispatch'
  | 'waiting_external';

export interface AutonomousFaultDecision {
  category: AutonomousFaultCategory;
  recoveryAction: AutonomousRecoveryAction;
  status: 'recovering' | 'blocked';
  reason: string;
}

export function applyRecoveryAttemptBudget(
  decision: AutonomousFaultDecision,
  attempt: number,
  maxAttempts: number,
): AutonomousFaultDecision {
  if (decision.status === 'blocked') {
    return decision;
  }

  if (attempt < maxAttempts) {
    return decision;
  }

  return {
    ...decision,
    status: 'blocked',
    recoveryAction: 'leader_takeover',
    reason: `recovery budget exhausted after ${attempt} attempts: ${decision.reason}`,
  };
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyAutonomousFault(input: {
  reason: string;
  faultClass?: RecoveryFaultClass;
  llmErrorKind?: LLMErrorKind;
}): AutonomousFaultDecision {
  const reason = String(input.reason || '').trim() || 'unknown runtime fault';
  const normalized = reason.toLowerCase();

  // rate_limited（Retry-After 超过重试预算可 honor 的上限）：不可重试，需外部冷却。
  // 挂到 waiting_external，由 Leader 在 cooldown 到期后再驱动，而非 worker 空转烧 token。
  if (input.llmErrorKind === 'rate_limited') {
    return {
      category: 'external_blocking',
      recoveryAction: 'waiting_external',
      status: 'blocked',
      reason,
    };
  }

  if (
    hasPattern(normalized, [
      /invalid api key/,
      /unauthorized/,
      /forbidden/,
      /permission/,
      /approval/,
      /ask_user/,
      /missing user input/,
      /credential/,
      /auth/,
      /not configured/,
      /missing required/,
      /requires external/,
      /model .*not found/,
      /模型 .*未找到/,
      /缺少 api key/,
      /缺少 baseurl/,
      /enoent/,
      /spawn .* enoent/,
    ]) ||
    input.faultClass === 'external_agent_auth' ||
    input.faultClass === 'external_agent_config'
  ) {
    return {
      category: 'external_blocking',
      recoveryAction: 'waiting_external',
      status: 'blocked',
      reason,
    };
  }

  if (
    input.llmErrorKind === 'connect_timeout' ||
    input.llmErrorKind === 'request_timeout' ||
    input.llmErrorKind === 'stream_timeout' ||
    input.llmErrorKind === 'network_error' ||
    (input.llmErrorKind === 'provider_error' && hasPattern(normalized, [/429/, /rate limit/, /retry after/, /temporar/, /unavailable/])) ||
    hasPattern(normalized, [
      /429/,
      /rate limit/,
      /retry after/,
      /temporar/,
      /network/,
      /timed out/,
      /socket hang up/,
      /econn/,
      /enotfound/,
      /eai_again/,
    ]) ||
    input.faultClass === 'external_agent_timeout'
  ) {
    return {
      category: 'external_retryable',
      recoveryAction: 'worker_restart',
      status: 'recovering',
      reason,
    };
  }

  const faultClass = input.faultClass;
  if (
    faultClass === 'worker_heartbeat_timeout' ||
    faultClass === 'worker_max_runtime' ||
    faultClass === 'worker_health_runaway' ||
    faultClass === 'worker_crashed' ||
    faultClass === 'worker_exit' ||
    faultClass === 'worker_stopped' ||
    faultClass === 'external_agent_crashed' ||
    faultClass === 'external_agent_protocol'
  ) {
    return {
      category: 'internal_recoverable',
      recoveryAction: 'worker_redispatch',
      status: 'recovering',
      reason,
    };
  }

  return {
    category: 'internal_recoverable',
    recoveryAction: 'leader_takeover',
    status: 'recovering',
    reason,
  };
}
