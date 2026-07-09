/**
 * 角色/工具预设的单一事实源（lowest layer）。
 *
 * 历史上同一份 WORKER_TOOLS / PRESET_ROLE_PROFILES / DEFAULT_BASIC_TOOLS /
 * ROLE_SKILL_PRIORITY 在两处各写了一份：
 *   - `agents/RoleCapabilityModel.ts`（运行时真源，Leader 派发/能力裁剪实际使用）
 *   - `contracts/types/Agent.ts`（前端 RolesRoutes 使用）
 * 两份逐渐漂移：前端缺 explore 角色、缺 memory_read/memory_write、所有角色都被写成
 * 全 tier、且没有 contextBudget —— 导致 Web 角色面板展示的能力和运行时真正授予的能力不符。
 *
 * 本模块把这份数据下沉到 contracts/constants（最底层，仅依赖 toolNames），
 * 由上面两处统一 re-export，从根上消除双源漂移。
 *
 * 只放"纯数据 + 纯类型"。任何依赖 AgentRole / ToolMetadata / SkillCatalog 的函数
 * 仍留在各自的上层文件里（避免 contracts 反向依赖 agents/tools 造成循环）。
 */
import { OFFICE_TOOL_NAMES } from './toolNames.js';

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

/** 供上层 applyRoleToolsConfig(basicToolsEnabled=false) 复用的基础工具集 */
export const BASIC_TOOLS_SET: ReadonlyArray<string> = BASIC_TOOLS;

export const ALL_TIERS: RoleCapabilityTier[] = ['read', 'compute', 'execute', 'write'];

export function mergeTools(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().filter(Boolean)));
}

export function uniqueTools(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
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

export function listPresetRoleProfiles(): PresetRoleProfile[] {
  return (Object.keys(PRESET_ROLE_PROFILES) as PresetRoleName[]).map((name) => PRESET_ROLE_PROFILES[name]);
}
