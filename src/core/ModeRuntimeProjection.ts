import type { ControlMode, LeaderExecutionMode } from '../contracts/types/Session.js';
import {
  getDefaultToolPermissionContext,
  normalizeToolPermissionContext,
  summarizePermissionContextForDisplay,
  type PermissionMode,
  type ToolPermissionContext,
} from './PermissionSystem.js';
import { SESSION_KEYS } from './SessionStateKeys.js';
import { parseBlueprint, type ProjectBlueprint } from './ProjectBlueprint.js';
import { getTeamMailbox, getTeamMemberRegistry } from './TeamMailbox.js';
import { MODE_REGISTRY, ALL_MODE_IDS, type ModeId } from '../contracts/modes.js';

export type CollaborationMode = 'solo' | 'team';
export type ExecutionRoutePreference = 'auto' | 'direct' | 'hybrid' | 'delegate';
export type BlackboardMode = 'off' | 'summary' | 'full';
export type RouteMode = LeaderExecutionMode | 'unknown';
export type CollaborationModeSource = 'explicit' | 'legacy' | 'default';
export type RouteModeSource = 'leader' | 'session' | 'default';
export type BlackboardModeSource = 'default' | 'explicit' | 'team' | 'workflow' | 'contract_bound';

export interface ModeRuntimeProjection {
  controlMode: ControlMode;
  route: {
    mode: RouteMode;
    preference: ExecutionRoutePreference;
    reason?: string;
    source: RouteModeSource;
  };
  collaboration: {
    mode: CollaborationMode;
    source: CollaborationModeSource;
    activeTeamName?: string | null;
    teamEnabled: boolean;
  };
  workflow: {
    enabled: boolean;
    activeExecutionCount: number;
  };
  /**
   * 会话级模式插件激活状态（bughunt/office/workflow）。
   * 由 MODE_REGISTRY 单一事实源派生，供 ModeToolPolicy 做 fail-closed 判定，
   * 并对齐 modes.md「Backend projection canonical」供 Web/TUI 投影展示。
   */
  modePlugins: Record<ModeId, boolean>;
  blackboard: {
    mode: BlackboardMode;
    source: BlackboardModeSource;
  };
  permission: {
    mode: PermissionMode;
    summary?: string;
  };
  /** 项目蓝图(复杂项目结构化状态);无蓝图时为 null。投影到 runtime snapshot 供前端展示与覆盖判定。 */
  blueprint?: ProjectBlueprint | null;
}

export interface ModeRuntimeStateReader {
  getSessionState(sessionId: string, key: string): unknown | null;
}

export interface ActiveTeamValidationResult {
  valid: boolean;
  activeTeamName: string | null;
  rosterCount: number;
}

export interface ResolveModeRuntimeProjectionInput {
  sessionId: string;
  db: ModeRuntimeStateReader;
  permissionContext?: ToolPermissionContext | null;
  permissionSummary?: string;
  blackboardAvailable?: boolean;
  blackboardModeOverride?: unknown;
  activeWorkflowExecutionCount?: number;
  validateActiveTeam?: (teamName: string, sessionId: string) => ActiveTeamValidationResult;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readControlMode(value: unknown): ControlMode {
  return value === 'eternal' ? 'eternal' : 'manual';
}

function readRouteMode(value: unknown): { mode: RouteMode; source: RouteModeSource } {
  if (value === 'direct' || value === 'hybrid' || value === 'delegate') {
    return { mode: value, source: 'leader' };
  }
  return { mode: 'direct', source: 'default' };
}

function readRoutePreference(value: unknown): ExecutionRoutePreference {
  if (value === 'direct' || value === 'hybrid' || value === 'delegate') return value;
  return 'auto';
}

/**
 * 归一化后的执行路由偏好三态。'hybrid' 是历史遗留值（UI 已收敛为 自动/自己执行/委派助手
 * 三选项），语义等同 'auto'（算法自主决定），归一化掉。chooseExecutionRoute 决策与 route
 * hint 注入共用此单一事实源，避免两处各写归一化逻辑而漂移。
 */
export type EffectiveRoutePreference = 'auto' | 'direct' | 'delegate';

/** 将任意 EXECUTION_ROUTE_OVERRIDE 值归一化为 auto/direct/delegate 三态。 */
export function resolveEffectiveRoutePreference(value: unknown): EffectiveRoutePreference {
  const pref = readRoutePreference(value);
  return pref === 'hybrid' ? 'auto' : pref;
}

function readCollaborationMode(value: unknown): CollaborationMode | null {
  return value === 'solo' || value === 'team' ? value : null;
}

function readBlackboardMode(value: unknown): BlackboardMode | null {
  return value === 'off' || value === 'summary' || value === 'full' ? value : null;
}

export function defaultActiveTeamValidator(teamName: string, sessionId: string): ActiveTeamValidationResult {
  const activeTeamName = teamName.trim();
  if (!activeTeamName) {
    return { valid: false, activeTeamName: null, rosterCount: 0 };
  }

  try {
    const team = getTeamMailbox().getTeam(activeTeamName, sessionId);
    const roster = getTeamMemberRegistry().getByTeam(activeTeamName, sessionId);
    const rosterNames = new Set(roster.map((member) => member.name));
    const expectedNames = new Set<string>();
    if (team?.leader) expectedNames.add(team.leader);
    for (const memberName of team?.members || []) expectedNames.add(memberName);
    const expectedRosterPresent = expectedNames.size === 0
      ? roster.length > 0
      : Array.from(expectedNames).every((name) => rosterNames.has(name));
    const valid = Boolean(team?.active !== false && roster.length > 0 && expectedRosterPresent);
    return {
      valid,
      activeTeamName: valid ? activeTeamName : null,
      rosterCount: roster.length,
    };
  } catch {
    return { valid: false, activeTeamName: null, rosterCount: 0 };
  }
}

function resolvePermissionProjection(input: ResolveModeRuntimeProjectionInput): ModeRuntimeProjection['permission'] {
  const raw = input.permissionContext ?? input.db.getSessionState(input.sessionId, SESSION_KEYS.TOOL_PERMISSION_CONTEXT);
  const context = raw
    ? normalizeToolPermissionContext(raw)
    : getDefaultToolPermissionContext();
  return {
    mode: context.mode,
    summary: input.permissionSummary || summarizePermissionContextForDisplay(context),
  };
}

function resolveCollaborationProjection(
  input: ResolveModeRuntimeProjectionInput,
): ModeRuntimeProjection['collaboration'] {
  const explicitMode = readCollaborationMode(input.db.getSessionState(input.sessionId, SESSION_KEYS.COLLABORATION_MODE));
  const activeTeamState = asTrimmedString(input.db.getSessionState(input.sessionId, SESSION_KEYS.LEADER_ACTIVE_TEAM));
  const validate = input.validateActiveTeam ?? defaultActiveTeamValidator;
  const activeTeam = activeTeamState ? validate(activeTeamState, input.sessionId) : { valid: false, activeTeamName: null, rosterCount: 0 };

  if (explicitMode) {
    const teamEnabled = explicitMode === 'team' && activeTeam.valid;
    return {
      mode: explicitMode,
      source: 'explicit',
      activeTeamName: teamEnabled ? activeTeam.activeTeamName : null,
      teamEnabled,
    };
  }

  if (activeTeam.valid) {
    return {
      mode: 'team',
      source: 'legacy',
      activeTeamName: activeTeam.activeTeamName,
      teamEnabled: true,
    };
  }

  return {
    mode: 'solo',
    source: 'default',
    activeTeamName: null,
    teamEnabled: false,
  };
}

function resolveBlackboardProjection(input: {
  workflowEnabled: boolean;
  collaboration: ModeRuntimeProjection['collaboration'];
  blackboardAvailable?: boolean;
  blackboardModeOverride?: unknown;
}): ModeRuntimeProjection['blackboard'] {
  const explicit = readBlackboardMode(input.blackboardModeOverride);
  if (explicit) {
    return { mode: explicit, source: 'explicit' };
  }
  if (input.collaboration.teamEnabled) {
    return { mode: 'full', source: 'team' };
  }
  if (input.workflowEnabled && input.blackboardAvailable) {
    return { mode: 'full', source: 'workflow' };
  }
  if (input.blackboardAvailable) {
    return { mode: 'summary', source: 'default' };
  }
  return { mode: 'off', source: 'default' };
}

export function resolveModeRuntimeProjection(input: ResolveModeRuntimeProjectionInput): ModeRuntimeProjection {
  const controlMode = readControlMode(input.db.getSessionState(input.sessionId, SESSION_KEYS.CONTROL_MODE));
  const route = readRouteMode(input.db.getSessionState(input.sessionId, SESSION_KEYS.LEADER_EXECUTION_MODE));
  const routePreference = readRoutePreference(input.db.getSessionState(input.sessionId, SESSION_KEYS.EXECUTION_ROUTE_OVERRIDE));
  const routeReason = asTrimmedString(input.db.getSessionState(input.sessionId, SESSION_KEYS.LEADER_EXECUTION_REASON));
  const modePlugins = Object.fromEntries(
    ALL_MODE_IDS.map((id) => [id, input.db.getSessionState(input.sessionId, MODE_REGISTRY[id].sessionKey) === 'true']),
  ) as Record<ModeId, boolean>;
  const workflowEnabled = modePlugins.workflow;
  const collaboration = resolveCollaborationProjection(input);
  const blackboard = resolveBlackboardProjection({
    workflowEnabled,
    collaboration,
    blackboardAvailable: input.blackboardAvailable,
    blackboardModeOverride: input.blackboardModeOverride,
  });
  const blueprint = parseBlueprint(input.db.getSessionState(input.sessionId, SESSION_KEYS.PROJECT_BLUEPRINT));

  return {
    controlMode,
    route: {
      mode: route.mode,
      preference: routePreference,
      ...(routeReason ? { reason: routeReason } : {}),
      source: route.source,
    },
    collaboration,
    workflow: {
      enabled: workflowEnabled,
      activeExecutionCount: Math.max(0, Math.trunc(input.activeWorkflowExecutionCount ?? 0)),
    },
    modePlugins,
    blackboard,
    permission: resolvePermissionProjection(input),
    blueprint,
  };
}
