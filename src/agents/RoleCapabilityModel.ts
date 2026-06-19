import type { AgentRole } from './RoleRegistry.js';
import type { SkillDescriptor } from '../core/SkillCatalog.js';
import { getToolCapabilityTier as getMetadataToolCapabilityTier } from '../tools/ToolMetadata.js';
import { OFFICE_TOOL_NAMES } from '../tools/officeToolContract.js';
import type { PromptLocale } from './prompts/i18n/catalog.js';

export type RoleCapabilityTier = 'read' | 'compute' | 'execute' | 'write';
export type RoleCapabilitySource = 'preset' | 'preset_enhanced' | 'custom';
export type SkillPrioritySource = 'user_explicit' | 'leader_explicit' | 'role_default';
export type PresetRoleName =
  | 'research'
  | 'explore'
  | 'coding'
  | 'verify'
  | 'review'
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'qa'
  | 'ux_designer'
  | 'planner'
  | 'evaluator'
  | 'architect';

export interface RoleCapabilityProfile {
  source: RoleCapabilitySource;
  baselineRole?: PresetRoleName;
  allowedTiers: RoleCapabilityTier[];
  defaultSkillNames: string[];
  skillPriority: SkillPrioritySource[];
}

export interface PresetRoleProfile {
  name: PresetRoleName;
  description: string;
  tools: string[];
  allowedTiers: RoleCapabilityTier[];
  defaultSkillNames: string[];
  /** Per-role context token budget (0 = use global default). */
  contextBudget?: number;
}

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

export const ROLE_SKILL_PRIORITY: SkillPrioritySource[] = [
  'user_explicit',
  'leader_explicit',
  'role_default',
];

const TEAM_COMM_TOOLS = ['team_message', 'team_inbox', 'team_manage'];

/**
 * 通信 / 工作笔记工具 —— 跨 Agent 协作的核心机制。
 *
 * 历史 bug：这 4 个工具在 ToolRegistry 里注册了，却没进任何角色的 tools 白名单，
 * 于是 BaseAgent.getToolDefinitions() 按 role.tools 过滤后 worker 永远看不到它们，
 * 哪怕 prompt 一直叫它调 write_work_note / send_message —— 表现为"环境未提供
 * write_work_note 工具"。统一并入 WORKER_TOOLS，从根上修掉。
 */
const COMM_TOOLS = ['send_message', 'write_work_note', 'read_work_notes', 'request_work_note'];
const MEMORY_TOOLS = ['memory', 'memory_read', 'memory_write'];

/**
 * 所有内置角色的"基础工具集"——读 / 写 / 搜索 / 结构化补丁 / python / shell。
 * 保留给 settings.json 的 basic_tools_enabled 开关与前端 RolesRoutes 使用。
 */
const BASIC_TOOLS = [
  'file_read',
  'file_create',
  'structured_patch',
  'code_search',
  'list_dir',
  'glob',
  'shell',
  'python_exec',
];

/** 暴露给配置层（settings.json）：默认基础工具集名单 */
export const DEFAULT_BASIC_TOOLS: ReadonlyArray<string> = BASIC_TOOLS;

const ALL_TIERS: RoleCapabilityTier[] = ['read', 'compute', 'execute', 'write'];

function mergeTools(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().filter(Boolean)));
}

/**
 * 统一 Worker 工具集 —— 不再按角色切割工具。
 *
 * 全系统只保留两套工具切割：Leader（元工具 + direct tools，见 contracts/constants/leaderToolDefinitions）
 * 与 Worker（这里）。所有内置/自定义 worker 角色共享同一套工具，职责差异完全靠
 * description + systemPrompt 引导，而不是用工具裁剪做硬隔离。
 *
 * 历史上按角色切工具（frontend 只有 browser、backend 只有 http_request、research
 * 没 file_create……）反复导致 Leader 派活时因"目标角色没某个工具"被迫重派/卡死，
 * 还漏掉了 send_message / write_work_note 这类必需的协作工具。
 *
 * 不包含的工具按"模式门控"动态注入，不进基础集：
 *   - bughunt scan / ledger（仅 bughunt 模式，见 LeaderToolGates）
 *   - workflow 统一入口（仅 workflow 模式）
 *   - blackboard 统一入口写入（blackboard(action="...")，仅 blackboard 模式）
 *   - office 产物工具在 Office mode 下才暴露；普通模式由 BaseAgent/ToolPruner 统一剔除
 */
export const WORKER_TOOLS: string[] = mergeTools(
  ['session_artifacts', 'find_tools', 'tool_preflight', 'parallel_read_batch', 'design_asset'],
  BASIC_TOOLS,
  ['web_fetch', 'web_search', 'http_request', 'parse_file'],
  [...OFFICE_TOOL_NAMES],
  ['screenshot', 'visual_contact_sheet', 'browser_visual_verify', 'browser_action', 'ocr', 'mcp', 'node_repl'],
  MEMORY_TOOLS,
  COMM_TOOLS,
  TEAM_COMM_TOOLS,
  // Blackboard 统一入口 — 普通模式会由 ToolPruner 剔除；黑板启用时使用单一写入入口。
  ['blackboard'],
  // 任务收尾 + 假设声明：必须对所有角色可见，否则无法产出结构化验收/早期证伪证据
  ['attempt_completion', 'declare_assumption'],
);

export const PRESET_ROLE_PROFILES: Record<PresetRoleName, PresetRoleProfile> = {
  research: {
    name: 'research',
    description: '调研分析专家，负责代码库调研和技术方案分析',
    tools: [...WORKER_TOOLS],
    allowedTiers: ['read', 'compute'],
    defaultSkillNames: [],
    contextBudget: 120_000,
  },
  explore: {
    name: 'explore',
    description:
      '只读探索 Agent：在独立上下文中对代码库/资料做广度优先搜索，只回流结论与证据（文件路径:行号），不污染主上下文。工具集经 capability tier 硬裁剪为只读（read/compute tier），无任何写入或执行代码能力。',
    tools: [...WORKER_TOOLS],
    allowedTiers: ['read', 'compute'],
    defaultSkillNames: [],
    contextBudget: 80_000,
  },
  coding: {
    name: 'coding',
    description: '代码实现专家，负责编写和修改代码。注意：HTML/PPT/Word/Excel/海报等交付物由 Leader 统一生成，agent 只产出 markdown 写到 scratchpad',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: ['explore-implement-verify'],
    contextBudget: 200_000,
  },
  verify: {
    name: 'verify',
    description: '验证测试专家，负责运行测试和验证实现',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: ['explore-implement-verify'],
    contextBudget: 150_000,
  },
  review: {
    name: 'review',
    description: '代码审查专家，负责审查代码质量和提出改进建议',
    tools: [...WORKER_TOOLS],
    allowedTiers: ['read', 'compute'],
    defaultSkillNames: [],
  },
  frontend: {
    name: 'frontend',
    description: '前端开发专家，负责 UI/UX 实现、组件开发、样式调试和前端构建',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
    contextBudget: 200_000,
  },
  backend: {
    name: 'backend',
    description: '后端开发专家，负责 API 开发、数据库设计、服务架构和性能优化',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: ['debug-frontend-backend-contract'],
  },
  fullstack: {
    name: 'fullstack',
    description: '全栈开发专家，负责前后端契约清晰的小到中型跨栈实现和端到端验证。注意：HTML/PPT/Word/Excel/海报等交付物由 Leader 统一生成，agent 只产出 markdown 写到 scratchpad',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
    contextBudget: 300_000,
  },
  qa: {
    name: 'qa',
    description: '质量保证专家，负责测试策略制定、自动化测试编写和质量门禁把控',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  ux_designer: {
    name: 'ux_designer',
    description: '用户体验设计师，负责交互设计、用户体验优化和可用性评估',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  planner: {
    name: 'planner',
    description: '规划智能体，负责将简短需求扩展为完整产品规格与编排节点',
    tools: [...WORKER_TOOLS],
    allowedTiers: ['read', 'compute'],
    defaultSkillNames: [],
  },
  evaluator: {
    name: 'evaluator',
    description: '独立评估智能体，负责基于契约和评分标准严格评判生成结果，使用浏览器工具实际测试运行中的应用',
    tools: [...WORKER_TOOLS],
    allowedTiers: ['read', 'compute', 'execute'],
    defaultSkillNames: [],
  },
  architect: {
    name: 'architect',
    description:
      '架构契约责任人。跨栈任务开工前先把前后端共享接口、数据结构、错误码和状态流写成 graph_contract（surface/title/version/content），落到黑板供 frontend/backend worker 消费。不下沉到具体代码实现，由 Leader 派发实现。',
    tools: [...WORKER_TOOLS],
    allowedTiers: ['read', 'compute', 'write'],
    defaultSkillNames: ['debug-frontend-backend-contract'],
  },
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

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
      tools: unique([...profile.tools]),
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
 * 用户角色覆盖配置（每个角色名 → 增/减工具）。
 * 与 settings.json 中 roles.overrides 字段同形。
 */
export interface RoleToolsOverride {
  tools_added?: string[];
  tools_removed?: string[];
}

export interface RoleToolsOverrideMap {
  [roleName: string]: RoleToolsOverride | undefined;
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
    const basicSet = new Set<string>(BASIC_TOOLS);
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
    tools: unique(tools),
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

  const requestedTools = unique(input.requestedTools);
  const baselineTools = baseProfile ? unique([...baseProfile.tools]) : [];
  const mergedTools = unique([...baselineTools, ...requestedTools]);
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
