/**
 * Pure S1/S2/S3 tool gates for Leader meta/dispatch surfaces.
 * Production LeaderTools.execute MUST call evaluateOrchestrationTierGate with the same inputs.
 */

import {
  type OrchestrationTier,
  resolveOrchestrationTier,
} from '../../contracts/types/OrchestrationTier.js';

export { resolveOrchestrationTier, type OrchestrationTier };

export interface OrchestrationTierGateInput {
  tier: OrchestrationTier;
  toolName: string;
  args?: Record<string, unknown>;
  collaborationMode: 'solo' | 'team';
  /** null when solo; boolean when team */
  teamReady: boolean | null;
  runningAgentCount: number;
}

export type OrchestrationTierGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

function teamManageAction(args: Record<string, unknown> | undefined): string {
  const a = args?.action;
  return typeof a === 'string' ? a.trim().toLowerCase() : '';
}

function dispatchBatchSize(args: Record<string, unknown> | undefined): number {
  const items = args?.items ?? args?.dispatches ?? args?.agents;
  if (Array.isArray(items)) return items.length;
  if (typeof args?.count === 'number' && Number.isFinite(args.count)) return Math.max(0, Math.floor(args.count));
  return 0;
}

/**
 * Fail-closed tier rules (AC4):
 * - S1: block team creation / multi-agent batch dispatch / role factory multi surfaces
 * - S2: at most one concurrent ephemeral dispatch unit (batch size ≤ 1; block if already running)
 * - S3: team-mode dispatch requires teamReady
 */
export function evaluateOrchestrationTierGate(
  input: OrchestrationTierGateInput,
): OrchestrationTierGateResult {
  const name = input.toolName;
  const args = input.args ?? {};
  const action = teamManageAction(args);

  if (input.tier === 'S1') {
    if (name === 'team_manage' && (action === 'create' || action === 'edit')) {
      return {
        ok: false,
        code: 'TIER_S1_TEAM_FORBIDDEN',
        message: 'S1 禁止建团/改 roster（team_manage create/edit）。请保持 Leader 直办，或 set_orchestration_tier(S2|S3)。',
      };
    }
    if (name === 'dispatch_batch') {
      return {
        ok: false,
        code: 'TIER_S1_BATCH_FORBIDDEN',
        message: 'S1 禁止 dispatch_batch。单任务请用 dispatch_agent，或提升到 S2/S3。',
      };
    }
    if (name === 'dispatch_agent' && input.runningAgentCount >= 1) {
      return {
        ok: false,
        code: 'TIER_S1_CONCURRENT_FORBIDDEN',
        message: 'S1 禁止并发多 Agent：已有 running worker。等其结束后再派，或提升到 S2/S3。',
      };
    }
    if (name === 'spawn_worker' && input.runningAgentCount >= 1) {
      return {
        ok: false,
        code: 'TIER_S1_CONCURRENT_FORBIDDEN',
        message: 'S1 禁止并发 spawn_worker：已有 running worker。',
      };
    }
  }

  if (input.tier === 'S2') {
    if (name === 'team_manage' && action === 'create') {
      return {
        ok: false,
        code: 'TIER_S2_TEAM_CREATE_FORBIDDEN',
        message: 'S2 禁止建团（team_manage create）。S2 仅允许最多一个 ephemeral worker；多角色协作请 set_orchestration_tier(S3) 并建团。',
      };
    }
    if (name === 'dispatch_batch') {
      const size = dispatchBatchSize(args);
      if (size > 1) {
        return {
          ok: false,
          code: 'TIER_S2_BATCH_CAP',
          message: `S2 限制 dispatch_batch 最多 1 项（收到 ${size}）。拆成单次 dispatch_agent 或提升到 S3。`,
        };
      }
      if (input.runningAgentCount >= 1) {
        return {
          ok: false,
          code: 'TIER_S2_CONCURRENT_CAP',
          message: 'S2 限制同时最多 1 个 running worker；请等待当前 worker 结束。',
        };
      }
    }
    if ((name === 'dispatch_agent' || name === 'spawn_worker') && input.runningAgentCount >= 1) {
      return {
        ok: false,
        code: 'TIER_S2_CONCURRENT_CAP',
        message: 'S2 限制同时最多 1 个 running worker；请等待当前 worker 结束或提升到 S3。',
      };
    }
  }

  if (input.tier === 'S3' || input.collaborationMode === 'team') {
    const isDispatch = name === 'dispatch_agent' || name === 'dispatch_batch';
    if (isDispatch && input.collaborationMode === 'team' && input.teamReady === false) {
      return {
        ok: false,
        code: 'TIER_S3_TEAM_NOT_READY',
        message: 'S3/Team 模式派发前 team roster 未就绪（definition 与 registry 未对齐）。请 team_manage(create/edit) 后重试。',
      };
    }
  }

  return { ok: true };
}

/** Tools that tier gates care about (for definition filtering optional use). */
export const TIER_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'team_manage',
  'dispatch_agent',
  'dispatch_batch',
  'spawn_worker',
  'set_orchestration_tier',
]);
