import type {
  CollaborationMode,
  RouteMode,
  BlackboardMode,
} from './ModeRuntimeProjection.js';
import type { ControlMode } from '../contracts/types/Session.js';
import type { PermissionMode } from './PermissionSystem.js';
import { findModeOfTool, type ModeId } from '../contracts/modes.js';
import { recordModeGateBlock } from './ModeAudit.js';

export type ModeToolActor =
  | 'leader'
  | 'worker'
  | 'team_member'
  | 'workflow_node'
  | 'remote_worker'
  | 'external_worker';

export interface ModeToolMetadata {
  category?: string;
  visibility?: string;
  readOnly?: boolean;
  modifiesWorkspace?: boolean;
  requiresNetwork?: boolean;
  privileged?: boolean;
  dangerous?: boolean;
}

export interface ModeToolPolicyInput {
  actor: ModeToolActor;
  controlMode: ControlMode;
  routeMode: RouteMode;
  collaborationMode: CollaborationMode;
  /**
   * 会话级模式插件激活状态（bughunt/office/workflow）。
   * 用于 fail-closed：工具所属模式未启用 → 结构化 mode error。
   */
  activeModes: Record<ModeId, boolean>;
  blackboardMode: BlackboardMode;
  permissionMode: PermissionMode;
  activeTeamName?: string | null;
  callerInTeamRoster?: boolean;
  callerIsTeamLeader?: boolean;
  allowSoloEphemeralDispatch?: boolean;
  toolName: string;
  toolMetadata: ModeToolMetadata;
}

export type ModeToolDecision =
  | { visibility: 'visible'; execution: 'allowed' | 'permission_required' }
  | { visibility: 'hidden'; execution: 'forbidden'; reason: string }
  | { visibility: 'visible'; execution: 'dispatch_preferred'; reason: string };

export const TEAM_TOOL_NAMES: ReadonlySet<string> = new Set([
  'team_manage',
  'team_message',
  'team_inbox',
]);

export const TEAM_MEMBER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'team_message',
  'team_inbox',
]);

export const LEADER_META_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_task',
  'update_task',
  'delete_task',
  'define_agent_role',
  'list_available_roles',
  'dispatch_agent',
  'dispatch_batch',
  'explore',
  'send_message_to_agent',
  'update_task_status',
  'force_complete_task',
  'retry_agent_llm',
  'nudge_agent',
  'compact_agent_context',
  'pause_agent',
  'resume_agent',
  'intervene_agent',
  'terminate_agent',
  'confirm_intervention',
  'check_agent_progress',
  'ask_user',
  'submit_plan',
  'plan_create',
  'plan_update',
  'plan_checkpoint',
  'plan_finalize',
  'finish_session',
  'learn_soul',
  'request_permission_update',
  'create_download_link',
  'set_bughunt_dag',
  'upsert_bughunt_finding',
  'get_bughunt_ledger',
  'get_ready_dag_nodes',
  'verify_finding',
]);

export const BLACKBOARD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'blackboard',
]);

export function isTeamTool(toolName: string): boolean {
  return TEAM_TOOL_NAMES.has(toolName);
}

export function isLeaderMetaTool(toolName: string, metadata?: ModeToolMetadata): boolean {
  return LEADER_META_TOOL_NAMES.has(toolName) || metadata?.visibility === 'leader';
}

export function isBlackboardWriteTool(toolName: string, metadata?: ModeToolMetadata): boolean {
  return BLACKBOARD_WRITE_TOOL_NAMES.has(toolName) || metadata?.category === 'blackboard';
}

export function isHighRiskExecutionTool(_toolName: string, metadata: ModeToolMetadata): boolean {
  return Boolean(metadata.dangerous || metadata.privileged || metadata.requiresNetwork || metadata.modifiesWorkspace);
}

function forbidden(reason: string): ModeToolDecision {
  return { visibility: 'hidden', execution: 'forbidden', reason };
}

function defaultVisible(input: ModeToolPolicyInput): ModeToolDecision {
  if (isHighRiskExecutionTool(input.toolName, input.toolMetadata) && input.permissionMode !== 'yolo') {
    return { visibility: 'visible', execution: 'permission_required' };
  }
  return { visibility: 'visible', execution: 'allowed' };
}

function isWorkerActor(actor: ModeToolActor): boolean {
  return actor !== 'leader';
}

export function resolveModeToolDecision(input: ModeToolPolicyInput): ModeToolDecision {
  const toolName = input.toolName.trim();

  if (toolName === 'attempt_completion') {
    return input.actor === 'leader'
      ? forbidden('ATTEMPT_COMPLETION_WORKER_ONLY')
      : defaultVisible(input);
  }

  if (isLeaderMetaTool(toolName, input.toolMetadata) && isWorkerActor(input.actor)) {
    return forbidden('LEADER_TOOL_FORBIDDEN_FOR_WORKER');
  }

  // 会话级模式 fail-closed：工具所属模式未启用 → 结构化 mode error。
  // 对称覆盖 bughunt / office / workflow，单一事实源 src/contracts/modes.ts。
  // workflow 关闭时仍产出 WORKFLOW_MODE_REQUIRED（modes.md:390 reason 兼容）。
  // 命中时记录一次拦截计数（确定性 per-mode 可观测，供 N5 反馈点统计反复尝试）。
  const toolMode = findModeOfTool(toolName);
  if (toolMode && !input.activeModes[toolMode]) {
    const reason = `${toolMode.toUpperCase()}_MODE_REQUIRED`;
    recordModeGateBlock(toolMode, toolName, reason, input.actor);
    return forbidden(reason);
  }

  if (isBlackboardWriteTool(toolName, input.toolMetadata) && input.blackboardMode !== 'full') {
    return forbidden('BLACKBOARD_WRITE_DISABLED');
  }

  if (isTeamTool(toolName) && input.collaborationMode !== 'team') {
    return forbidden('TEAM_UNAVAILABLE_IN_SOLO');
  }

  // Blueprint 工具是 Team 模式项目管理能力：Solo 下无子系统覆盖校验机制，隐藏。
  if (toolName === 'define_project_blueprint' && input.collaborationMode === 'solo') {
    return forbidden('BLUEPRINT_UNAVAILABLE_IN_SOLO');
  }

  if (toolName === 'team_manage') {
    const leaderLike = input.actor === 'leader' || input.callerIsTeamLeader === true;
    if (!leaderLike) {
      return forbidden('TEAM_MANAGE_LEADER_ONLY');
    }
  }

  if (TEAM_MEMBER_TOOL_NAMES.has(toolName)) {
    if (input.actor === 'leader') {
      return defaultVisible(input);
    }
    if (!input.callerInTeamRoster) {
      return forbidden('TEAM_ROSTER_REQUIRED');
    }
  }

  if ((toolName === 'dispatch_agent' || toolName === 'dispatch_batch') && input.actor === 'leader' && input.collaborationMode === 'solo') {
    if (
      input.allowSoloEphemeralDispatch ||
      input.routeMode === 'hybrid' ||
      input.routeMode === 'delegate'
    ) {
      return { visibility: 'visible', execution: 'allowed' };
    }
    return forbidden('SOLO_DISPATCH_REQUIRES_ROUTE');
  }

  if (input.actor === 'leader' && input.collaborationMode === 'solo' && isHighRiskExecutionTool(toolName, input.toolMetadata)) {
    return { visibility: 'visible', execution: 'dispatch_preferred', reason: 'HIGH_RISK_DIRECT_EXECUTION' };
  }

  return defaultVisible(input);
}

export function filterToolsByModePolicy<T extends { function: { name: string } }>(
  tools: readonly T[],
  input: Omit<ModeToolPolicyInput, 'toolName' | 'toolMetadata'> & {
    getToolMetadata: (toolName: string) => ModeToolMetadata;
  },
): T[] {
  return tools.filter((tool) => {
    const decision = resolveModeToolDecision({
      ...input,
      toolName: tool.function.name,
      toolMetadata: input.getToolMetadata(tool.function.name),
    });
    return decision.visibility === 'visible';
  });
}
