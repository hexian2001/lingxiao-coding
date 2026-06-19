import type { ExecutionPhase, Interruptibility } from './ExecutionLease.js';

export interface PhasePolicyEntry {
  defaultTtlMs: number;
  interruptibility: Interruptibility;
  renewalAllowed: boolean;
}

export const PHASE_POLICIES: Record<ExecutionPhase, PhasePolicyEntry> = {
  idle:             { defaultTtlMs: Infinity, interruptibility: 'immediate',        renewalAllowed: false },
  llm_call:         { defaultTtlMs: 120_000,  interruptibility: 'not_interruptible', renewalAllowed: true },
  tool_execution:   { defaultTtlMs: 300_000,  interruptibility: 'safe_point',        renewalAllowed: true },
  tool_quiet:       { defaultTtlMs: 5_000,    interruptibility: 'immediate',         renewalAllowed: false },
  recovering:       { defaultTtlMs: 60_000,   interruptibility: 'immediate',         renewalAllowed: false },
  waiting_for_user: { defaultTtlMs: Infinity, interruptibility: 'immediate',         renewalAllowed: false },
};

export function getPhaseTtl(phase: ExecutionPhase, override?: number): number {
  return override ?? PHASE_POLICIES[phase].defaultTtlMs;
}

export function getPhaseInterruptibility(phase: ExecutionPhase): Interruptibility {
  return PHASE_POLICIES[phase].interruptibility;
}
