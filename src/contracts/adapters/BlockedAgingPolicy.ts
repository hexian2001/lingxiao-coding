export interface BlockedAgingInput {
  blockedSinceAt?: number;
  now?: number;
  acknowledged?: boolean;
}

export type BlockedAgingSeverity = 'none' | 'reminder' | 'escalate' | 'manual_ack_required';

export interface BlockedAgingDecision {
  severity: BlockedAgingSeverity;
  blockedAgeMs: number;
  reason: string;
}

export interface BlockedAgingPolicyConfig {
  reminderAfterMs?: number;
  escalateAfterMs?: number;
  manualAckAfterMs?: number;
}

const DEFAULTS: Required<BlockedAgingPolicyConfig> = {
  reminderAfterMs: 30 * 60 * 1000,
  escalateAfterMs: 2 * 60 * 60 * 1000,
  manualAckAfterMs: 6 * 60 * 60 * 1000,
};

export class BlockedAgingPolicy {
  readonly config: Required<BlockedAgingPolicyConfig>;

  constructor(config: BlockedAgingPolicyConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  evaluate(input: BlockedAgingInput): BlockedAgingDecision {
    if (input.blockedSinceAt === undefined) {
      return { severity: 'none', blockedAgeMs: 0, reason: 'not_blocked' };
    }
    const now = input.now ?? Date.now();
    const blockedAgeMs = Math.max(0, now - input.blockedSinceAt);
    if (!input.acknowledged && blockedAgeMs >= this.config.manualAckAfterMs) {
      return { severity: 'manual_ack_required', blockedAgeMs, reason: 'blocked_requires_ack' };
    }
    if (blockedAgeMs >= this.config.escalateAfterMs) {
      return { severity: 'escalate', blockedAgeMs, reason: 'blocked_escalation_due' };
    }
    if (blockedAgeMs >= this.config.reminderAfterMs) {
      return { severity: 'reminder', blockedAgeMs, reason: 'blocked_reminder_due' };
    }
    return { severity: 'none', blockedAgeMs, reason: 'blocked_within_tolerance' };
  }
}
