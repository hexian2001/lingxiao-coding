import type { AgentRuntimeDiagnostic } from './types.js';

export const DEFAULT_TEXT_DIAGNOSTIC_THROTTLE_MS = 250;

export function applyAgentDiagnosticUpdate(
  prev: Record<string, AgentRuntimeDiagnostic>,
  agentName: string,
  updates: Partial<AgentRuntimeDiagnostic>,
): Record<string, AgentRuntimeDiagnostic> {
  const current = prev[agentName] || ({} as AgentRuntimeDiagnostic);
  let changed = false;
  const keys = Object.keys(updates) as (keyof AgentRuntimeDiagnostic)[];
  for (const key of keys) {
    if (current[key] !== updates[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return prev;
  const nextDiagnostic: AgentRuntimeDiagnostic = { ...current, ...updates };
  return { ...prev, [agentName]: nextDiagnostic };
}

export function shouldRecordAgentTextActivity(
  throttleState: Record<string, number>,
  agentName: string,
  now: number,
  throttleMs = DEFAULT_TEXT_DIAGNOSTIC_THROTTLE_MS,
): boolean {
  const last = throttleState[agentName] || 0;
  if (now - last < throttleMs) return false;
  throttleState[agentName] = now;
  return true;
}
