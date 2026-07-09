import type { AgentRole } from './RoleRegistry.js';
import type { SkillDescriptor } from '../core/SkillCatalog.js';
import { getToolCapabilityTier as getMetadataToolCapabilityTier } from '../tools/ToolMetadata.js';
import type { PromptLocale } from './prompts/i18n/catalog.js';
import {
  ROLE_SKILL_PRIORITY,
  DEFAULT_BASIC_TOOLS,
  BASIC_TOOLS_SET,
  WORKER_TOOLS,
  PRESET_ROLE_PROFILES,
  listPresetRoleProfiles,
  uniqueTools,
  type RoleCapabilityTier,
  type RoleCapabilitySource,
  type SkillPrioritySource,
  type PresetRoleName,
  type RoleCapabilityProfile,
  type PresetRoleProfile,
  type RoleToolsOverride,
  type RoleToolsOverrideMap,
} from '../contracts/constants/rolePresets.js';

/**
 * 角色/工具预设的真源已下沉到 `contracts/constants/rolePresets.ts`（最底层，仅依赖 toolNames）。
 * 本文件从那里 re-export 数据与类型，运行时（Leader 派发/能力裁剪）与前端 RolesRoutes
 * 共享同一份定义，不再出现"运行时授予的能力 ≠ 前端面板展示的能力"的双源漂移。
 *
 * 这里只保留依赖上层的东西：ToolMetadata（tier 判定）、AgentRole（RoleRegistry）、
 * SkillCatalog（技能解析）相关的函数与类型。contracts 是下层、agents 是上层，
 * 数据下沉后不会形成 contracts → agents 的反向依赖。
 */

// re-export 纯数据/类型，保持所有既有 import 路径（./RoleCapabilityModel）不变
export {
  ROLE_SKILL_PRIORITY,
  DEFAULT_BASIC_TOOLS,
  WORKER_TOOLS,
  PRESET_ROLE_PROFILES,
  listPresetRoleProfiles,
} from '../contracts/constants/rolePresets.js';
export type {
  RoleCapabilityTier,
  RoleCapabilitySource,
  SkillPrioritySource,
  PresetRoleName,
  RoleCapabilityProfile,
  PresetRoleProfile,
  RoleToolsOverride,
  RoleToolsOverrideMap,
} from '../contracts/constants/rolePresets.js';

export interface BuiltinRolePromptMap {
  research: Record<PromptLocale, string>;
  explore: Record<PromptLocale, string>;
  coding: Record<PromptLocale, string>;
  verify: Record<PromptLocale, string>;
  review: Record<PromptLocale, string>;
  frontend: Record<PromptLocale, string>;
  backend: Record<PromptLocale, string>;
  fullstack: Record<PromptLocale, string>;
  qa: Record<PromptLocale, string>;
  ux_designer: Record<PromptLocale, string>;
  planner: Record<PromptLocale, string>;
  evaluator: Record<PromptLocale, string>;
  architect: Record<PromptLocale, string>;
}

export interface ResolvedRoleCapability {
  tools: string[];
  droppedTools: string[];
  skillNames: string[];
  skillSources: Record<string, SkillPrioritySource>;
  capabilityProfile: RoleCapabilityProfile;
}

/**
 * Workflow 工具的真正常量在 `contracts/constants/leaderToolDefinitions.ts` 的 WORKFLOW_TOOL_NAMES。
 * 默认情况下不再把它们塞进任何预设角色的工具白名单——只有当 Leader/会话开启
 * "workflow 模式" 时，对应工具才在 Leader 候选清单中露出
 * （见 LeaderToolGates.filterLeaderTools / SESSION_KEYS.WORKFLOW_MODE_ACTIVE）。
 * 这避免和 Leader 自身的 create_task / dispatch_agent 编排路径形成两套
 * 并行的任务图语义混淆。
 */

// P0-1b: TOOL_TIER_MAP 已移除，tier 统一由 ToolMetadata.ts 的 TOOL_METADATA 单一事实源提供。
// getToolCapabilityTier 直接委托 getMetadataToolCapabilityTier，不再有 fallback 双源。

export function getToolCapabilityTier(toolName: string): RoleCapabilityTier | null {
  return getMetadataToolCapabilityTier(toolName) as RoleCapabilityTier | null;
}

export function isToolAllowedByCapabilityTiers(
  toolName: string,
  allowedTiers: RoleCapabilityTier[],
): boolean {
  const tier = getToolCapabilityTier(toolName);
  if (!tier) {
    return false;
  }
  return allowedTiers.includes(tier);
}

export function buildBuiltinRoles(promptMap: BuiltinRolePromptMap): AgentRole[] {
  return (Object.keys(PRESET_ROLE_PROFILES) as PresetRoleName[]).map((name) => {
    const profile = PRESET_ROLE_PROFILES[name];
    return {
      name: profile.name,
      description: profile.description,
      systemPrompt: promptMap[name].zh,
      systemPromptByLocale: promptMap[name],
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
  });
}

/**
 * 在角色 tools 上叠加用户配置。
 *
 * - basicToolsEnabled=false：从 tools 里剥离 BASIC_TOOLS（保留 profile 自带的非基础工具与 workflow / team_comm）。
 * - overrides[name].tools_added：合并补齐
 * - overrides[name].tools_removed：移除（在 add 之后再做差集，让用户能精准否决某个 add）
 *
 * 注意：返回的是新数组，不修改入参 role。
 */
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
    // 还原到 profile 中"非基础工具"集合（如 ux_designer 历史上只有 file_read/code_search）
    // 但我们已经把所有角色统一带 BASIC，这里给关闭后兜底回 read-only 视图。
    tools = tools.filter((t) => !basicSet.has(t) || t === 'file_read');
  }

  if (override?.tools_added && override.tools_added.length > 0) {
    tools.push(...override.tools_added);
  }
  if (override?.tools_removed && override.tools_removed.length > 0) {
    const removeSet = new Set(override.tools_removed);
    tools = tools.filter((t) => !removeSet.has(t));
  }

  return {
    ...role,
    tools: uniqueTools(tools),
  };
}

export function applyRoleToolsConfigMap(
  roles: AgentRole[],
  options: { basicToolsEnabled?: boolean; overrides?: RoleToolsOverrideMap },
): AgentRole[] {
  if (options.basicToolsEnabled !== false && (!options.overrides || Object.keys(options.overrides).length === 0)) {
    return roles;
  }
  return roles.map((r) => applyRoleToolsConfig(r, options));
}

export function resolveRoleSkillPriority(input: {
  userExplicitSkillNames?: string[];
  leaderExplicitSkillNames?: string[];
  roleDefaultSkillNames?: string[];
}): { skillNames: string[]; sources: Record<string, SkillPrioritySource> } {
  const ordered: Array<[SkillPrioritySource, string[] | undefined]> = [
    ['user_explicit', input.userExplicitSkillNames],
    ['leader_explicit', input.leaderExplicitSkillNames],
    ['role_default', input.roleDefaultSkillNames],
  ];

  const seen = new Set<string>();
  const skillNames: string[] = [];
  const sources: Record<string, SkillPrioritySource> = {};

  for (const [source, values] of ordered) {
    for (const name of values || []) {
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      skillNames.push(name);
      sources[name] = source;
    }
  }

  return { skillNames, sources };
}

export function resolveDynamicRoleCapability(input: {
  roleName: string;
  roleDescription: string;
  systemPrompt: string;
  requestedTools: string[];
  availableSkills: SkillDescriptor[];
  requestedSkillNames?: string[];
  userRequestedSkillNames?: string[];
  baseRoleName?: string;
}): ResolvedRoleCapability {
  // 仅在 Leader/调用方显式传 baseRoleName 时套用对应预设 profile；
  // base role 只能来自显式字段，description/systemPrompt/tools 不参与本地推断。
  const baseProfile = input.baseRoleName && input.baseRoleName in PRESET_ROLE_PROFILES
    ? PRESET_ROLE_PROFILES[input.baseRoleName as PresetRoleName]
    : undefined;

  const requestedTools = uniqueTools(input.requestedTools);
  const baselineTools = baseProfile ? uniqueTools([...baseProfile.tools]) : [];
  const mergedTools = uniqueTools([...baselineTools, ...requestedTools]);
  const allowedTiers = baseProfile?.allowedTiers || ['read', 'compute', 'execute'];
  // 受限角色（allowedTiers 不含 write 或 execute）强制按 capability tier 硬裁剪：
  // 任何来源（baseline / 增强 / settings override / role_definition 请求）塞入的写/执行
  // 工具都会被剥离到 droppedTools，保证只读角色在工具层确定性只读，不靠 prompt 自觉。
  // 全 tier 角色走原路径，零行为变化。
  const tierRestricted = !allowedTiers.includes('write') || !allowedTiers.includes('execute');
  const tools = tierRestricted
    ? mergedTools.filter((t) => isToolAllowedByCapabilityTiers(t, allowedTiers))
    : mergedTools;
  const droppedTools = tierRestricted
    ? mergedTools.filter((t) => !isToolAllowedByCapabilityTiers(t, allowedTiers))
    : [];

  const availableSkillNames = new Set(input.availableSkills.map((skill) => skill.name));
  const skillResolution = resolveRoleSkillPriority({
    userExplicitSkillNames: (input.userRequestedSkillNames || []).filter((name) => availableSkillNames.has(name)),
    leaderExplicitSkillNames: (input.requestedSkillNames || []).filter((name) => availableSkillNames.has(name)),
    roleDefaultSkillNames: (baseProfile?.defaultSkillNames || []).filter((name) => availableSkillNames.has(name)),
  });

  return {
    tools,
    droppedTools,
    skillNames: skillResolution.skillNames,
    skillSources: skillResolution.sources,
    capabilityProfile: {
      source: baseProfile ? 'preset_enhanced' : 'custom',
      baselineRole: baseProfile?.name,
      allowedTiers,
      defaultSkillNames: baseProfile?.defaultSkillNames || [],
      skillPriority: [...ROLE_SKILL_PRIORITY],
    },
  };
}
