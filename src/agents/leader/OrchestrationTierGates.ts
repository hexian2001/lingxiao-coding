/**
 * Re-export pure + session S1/S2/S3 gates from core (single implementation).
 * LeaderTools / tests import from here; TeamManageTool imports core directly.
 */
export {
  evaluateOrchestrationTierGate,
  evaluateSessionOrchestrationTierGate,
  resolveOrchestrationTier,
  TIER_GATED_TOOL_NAMES,
  type OrchestrationTier,
  type OrchestrationTierGateInput,
  type OrchestrationTierGateResult,
  type SessionTierGateDb,
} from '../../core/OrchestrationTierGates.js';
