import { OFFICE_TOOL_NAMES } from '../constants/toolNames.js';

export type WorkerBackend = 'worker_process' | 'claude' | 'codex' | 'remote';

export type RoleCapabilityTier = 'read' | 'compute' | 'execute' | 'write';
export type RoleCapabilitySource = 'preset' | 'preset_enhanced' | 'custom';
export type SkillPrioritySource = 'user_explicit' | 'leader_explicit' | 'role_default';
export type PresetRoleName =
  | 'research'
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
  createdBy: 'system' | 'llm' | 'user';
}

export interface PresetRoleProfile {
  name: PresetRoleName;
  description: string;
  tools: string[];
  allowedTiers: RoleCapabilityTier[];
  defaultSkillNames: string[];
}

export interface RoleToolsOverride {
  tools_added?: string[];
  tools_removed?: string[];
}

export interface RoleToolsOverrideMap {
  [roleName: string]: RoleToolsOverride | undefined;
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

export const ROLE_SKILL_PRIORITY: SkillPrioritySource[] = [
  'user_explicit',
  'leader_explicit',
  'role_default',
];

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

export const DEFAULT_BASIC_TOOLS: ReadonlyArray<string> = BASIC_TOOLS;

const TEAM_COMM_TOOLS = ['team_message', 'team_inbox', 'team_manage'];
const COMM_TOOLS = ['send_message', 'write_work_note', 'read_work_notes', 'request_work_note'];
const MEMORY_TOOLS = ['memory'];

function mergeTools(...groups: string[][]): string[] {
  return Array.from(new Set(groups.flat().filter(Boolean)));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export const WORKER_TOOLS: string[] = mergeTools(
  ['session_artifacts', 'find_tools', 'tool_preflight', 'parallel_read_batch', 'design_asset'],
  BASIC_TOOLS,
  ['web_fetch', 'web_search', 'http_request', 'parse_file'],
  [...OFFICE_TOOL_NAMES],
  ['screenshot', 'visual_contact_sheet', 'browser_visual_verify', 'browser_action', 'ocr', 'mcp', 'node_repl'],
  MEMORY_TOOLS,
  COMM_TOOLS,
  TEAM_COMM_TOOLS,
  ['blackboard'],
  ['attempt_completion', 'declare_assumption'],
);

const ALL_TIERS: RoleCapabilityTier[] = ['read', 'compute', 'execute', 'write'];

export const PRESET_ROLE_PROFILES: Record<PresetRoleName, PresetRoleProfile> = {
  research: {
    name: 'research',
    description: '调研分析专家，负责代码库调研和技术方案分析',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  coding: {
    name: 'coding',
    description: '代码实现专家，负责编写和修改代码。注意：HTML/PPT/Word/Excel/海报等交付物由 Leader 统一生成，agent 只产出 markdown 写到 scratchpad',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  verify: {
    name: 'verify',
    description: '验证测试专家，负责运行测试和验证实现',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  review: {
    name: 'review',
    description: '代码审查专家，负责审查代码质量和提出改进建议',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  frontend: {
    name: 'frontend',
    description: '前端开发专家，负责 UI/UX 实现、组件开发、样式调试和前端构建',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  backend: {
    name: 'backend',
    description: '后端开发专家，负责 API 开发、数据库设计、服务架构和性能优化',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  fullstack: {
    name: 'fullstack',
    description: '全栈开发专家，负责前后端契约清晰的小到中型跨栈实现和端到端验证。注意：HTML/PPT/Word/Excel/海报等交付物由 Leader 统一生成，agent 只产出 markdown 写到 scratchpad',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
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
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  evaluator: {
    name: 'evaluator',
    description: '独立评估智能体，负责基于契约和评分标准严格评判生成结果，使用浏览器工具实际测试运行中的应用',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
  architect: {
    name: 'architect',
    description:
      '架构契约责任人。跨栈任务开工前先把前后端共享接口、数据结构、错误码和状态流写成 graph_contract（surface/title/version/content），落到黑板供 frontend/backend worker 消费。不下沉到具体代码实现，由 Leader 派发实现。',
    tools: [...WORKER_TOOLS],
    allowedTiers: [...ALL_TIERS],
    defaultSkillNames: [],
  },
};

export function listPresetRoleProfiles(): PresetRoleProfile[] {
  return (Object.keys(PRESET_ROLE_PROFILES) as PresetRoleName[]).map((name) => PRESET_ROLE_PROFILES[name]);
}

export function createPresetAgentRole(name: PresetRoleName, systemPrompt = ''): AgentRole {
  const profile = PRESET_ROLE_PROFILES[name];
  return {
    name: profile.name,
    description: profile.description,
    systemPrompt,
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
    const basicSet = new Set<string>(BASIC_TOOLS);
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
    tools: unique(tools),
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
