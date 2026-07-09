/**
 * 角色/工具预设的真源已下沉到 `contracts/constants/rolePresets.ts`（最底层，仅依赖 toolNames）。
 * 本文件从那里 re-export，前端 RolesRoutes 与运行时 RoleCapabilityModel 共享同一份数据，
 * 不再出现"前端面板展示的角色能力 ≠ 运行时真正授予的能力"的双源漂移。
 *
 * 这里只保留 Agent 运行态特有的类型（AgentRole/AgentCapabilityProfile/AgentRoleSurfaceItem/
 * AgentHandle/RecoveredTaskInfo）以及依赖 AgentRole 的两个工厂函数。
 */
import {
  ROLE_SKILL_PRIORITY,
  DEFAULT_BASIC_TOOLS,
  BASIC_TOOLS_SET,
  WORKER_TOOLS,
  PRESET_ROLE_PROFILES,
  listPresetRoleProfiles,
  uniqueTools,
  type PresetRoleName,
  type PresetRoleProfile,
  type RoleToolsOverride,
  type RoleToolsOverrideMap,
  type RoleCapabilityTier,
  type RoleCapabilitySource,
  type SkillPrioritySource,
} from '../constants/rolePresets.js';

export {
  ROLE_SKILL_PRIORITY,
  DEFAULT_BASIC_TOOLS,
  WORKER_TOOLS,
  PRESET_ROLE_PROFILES,
  listPresetRoleProfiles,
} from '../constants/rolePresets.js';
export type {
  RoleCapabilityTier,
  RoleCapabilitySource,
  SkillPrioritySource,
  PresetRoleName,
  RoleCapabilityProfile,
  PresetRoleProfile,
  RoleToolsOverride,
  RoleToolsOverrideMap,
} from '../constants/rolePresets.js';

export type WorkerBackend = 'worker_process' | 'claude' | 'codex' | 'remote';

export interface AgentCapabilityProfile {
  source?: RoleCapabilitySource | string;
  baselineRole?: PresetRoleName | string;
  allowedTiers?: RoleCapabilityTier[] | string[];
  defaultSkillNames?: string[];
  skillPriority?: SkillPrioritySource[] | string[];
}

export interface AgentRole {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  droppedTools?: string[];
  skillNames?: string[];
  capabilityProfile?: AgentCapabilityProfile;
  model?: string;
  worker_backend?: Exclude<WorkerBackend, 'remote'>;
  worker_config?: {
    env?: Record<string, string>;
    extra_args?: string[];
    timeout_ms?: number;
    idle_timeout_ms?: number;
    wire_api?: 'chat' | 'responses';
    no_bare?: boolean;
  };
  /** Git author identity for this role's commits. When set, git commit uses
   *  `git -c user.name=... -c user.email=...` to attribute the commit.
   *  Useful for multi-agent team workflows where audit trail matters. */
  gitIdentity?: {
    name: string;
    email: string;
  };
  createdBy: 'system' | 'llm' | 'user';
}

export interface AgentRoleSurfaceItem {
  name: string;
  description: string;
  source: 'preset' | 'custom';
  baselineRole?: string;
  allowedTiers: string[];
  tools: string[];
  profileTools: string[];
  override: RoleToolsOverride;
  skillNames: string[];
  workerBackend?: Exclude<WorkerBackend, 'remote'>;
  model?: string;
  systemPrompt?: string;
  gitIdentity?: {
    name: string;
    email: string;
  };
  definition?: {
    source: 'project' | 'global' | 'runtime';
    path?: string;
    editable: boolean;
    updatedAt?: number;
    tools?: string[];
    skillNames?: string[];
  };
  runtime: boolean;
  surfaceSource: 'live' | 'static_fallback';
}

export function createPresetAgentRole(name: PresetRoleName, systemPrompt = ''): AgentRole {
  const profile = PRESET_ROLE_PROFILES[name];
  return {
    name: profile.name,
    description: profile.description,
    systemPrompt,
    tools: uniqueTools([...profile.tools]),
    skillNames: [...profile.defaultSkillNames],
    createdBy: 'system',
    capabilityProfile: {
      source: 'preset',
      baselineRole: profile.name,
      allowedTiers: [...profile.allowedTiers],
      defaultSkillNames: [...profile.defaultSkillNames],
      skillPriority: [...ROLE_SKILL_PRIORITY],
    },
  };
}

export function applyRoleToolsConfig(
  role: AgentRole,
  options: {
    basicToolsEnabled?: boolean;
    overrides?: RoleToolsOverrideMap;
  },
): AgentRole {
  const basicEnabled = options.basicToolsEnabled !== false;
  const override = options.overrides?.[role.name];
  let tools = [...role.tools];

  if (!basicEnabled) {
    const basicSet = new Set<string>(BASIC_TOOLS_SET);
    tools = tools.filter((tool) => !basicSet.has(tool) || tool === 'file_read');
  }

  if (override?.tools_added && override.tools_added.length > 0) {
    tools.push(...override.tools_added);
  }
  if (override?.tools_removed && override.tools_removed.length > 0) {
    const removeSet = new Set(override.tools_removed);
    tools = tools.filter((tool) => !removeSet.has(tool));
  }

  return {
    ...role,
    tools: uniqueTools(tools),
  };
}

export interface AgentHandle {
  agentId: string;
  /** External adapters should prefer agentId; optional id keeps inbound compatibility. */
  id?: string;
  name: string;
  roleType: string;
  displayRole?: string;
  taskId: string;
  status: 'starting' | 'running' | 'stopped' | 'completed' | 'failed' | 'interrupted' | string;
  visibility?: 'team' | 'ephemeral';
  owner?: 'leader' | 'team';
  interactive?: boolean;
  persistAcrossTurns?: boolean;
  teamMember?: string | null;
  exitReason?: 'completed' | 'failed' | 'timeout' | 'crashed' | 'terminated' | string;
  taskRunGeneration?: number;
  asyncTask?: Promise<string>;
  startTime: number;
  endTime?: number;
  error?: Error;
  sessionId?: string;
  iteration?: number;
  role?: string;
  backend?: WorkerBackend;
  workerBackend?: WorkerBackend;
  externalSessionId?: string;
  externalPid?: number;
  externalExitCode?: number | null;
  externalExitSignal?: string | null;
  externalDiagnostics?: {
    logPath?: string;
    stderrLogPath?: string;
    stderrTail?: string[];
    stdoutTail?: string[];
    lastEventAt?: number;
    recoverable?: boolean;
    recoveryAction?: string;
  };
  lastHeartbeat?: number;
  lastProgress?: number;
  lastTokenAt?: number;
  lastToolCallAt?: number;
  lastToolResultAt?: number;
  currentToolName?: string | null;
  pendingPermission?: boolean;
  toolCalls?: number;
  runtimeRole?: AgentRole;
  capabilityDetails?: {
    baselineRole?: string;
    skillNames: string[];
    droppedTools: string[];
    tools: string[];
  };
  interactiveRuntime?: unknown;
}

export interface RecoveredTaskInfo {
  id: string;
  subject: string;
  agent: string;
  agentId?: string;
  detail: string;
  role: string;
  iteration: number;
  toolCallCount?: number;
}
