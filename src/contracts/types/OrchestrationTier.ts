/**
 * Orchestration tier (S1/S2/S3) — code-enforced execution band.
 * Not prompt theatre: Leader tool path must call evaluateOrchestrationTierGate.
 */

export const ORCHESTRATION_TIERS = ['S1', 'S2', 'S3'] as const;
export type OrchestrationTier = (typeof ORCHESTRATION_TIERS)[number];

export function isOrchestrationTier(value: unknown): value is OrchestrationTier {
  return typeof value === 'string' && (ORCHESTRATION_TIERS as readonly string[]).includes(value);
}

/**
 * Resolve effective tier.
 * Explicit session value wins; else team collaboration ⇒ S3; else S2 (solo default).
 * S1 only via explicit set (never silent default).
 */
export function resolveOrchestrationTier(input: {
  explicitTier?: string | null;
  collaborationMode: 'solo' | 'team';
}): OrchestrationTier {
  if (isOrchestrationTier(input.explicitTier)) return input.explicitTier;
  if (input.collaborationMode === 'team') return 'S3';
  return 'S2';
}
