/**
 * AgentRoleRegistry - Agent 角色注册表
 * 管理预设角色和动态定义的自定义角色
 */

import type { RoleCapabilityProfile } from './RoleCapabilityModel.js';
import type { PromptLocale } from './prompts/i18n/catalog.js';

/** 角色解析回落到的默认规范角色（无法从名字推断出任何已存在角色时使用）。 */
export const ROLE_FALLBACK_DEFAULT = 'fullstack';

/**
 * 用户/LLM 提供的角色名常常是规范名的变体或缩写：
 *   backend-agents / be-1 / FE / ux_designer_v2 / be_dev ...
 * 直接用注册表 exists() 命中不了就硬失败，体验差且打断建图。
 *
 * 本函数做**确定性**名字→已注册角色的归约，不依赖任何 confidence / 阈值 /
 * 关键词模糊打分，只做结构化字符串匹配，按下面优先级取第一个命中：
 *   1. 大小写无关精确命中
 *   2. 整体别名（手写短形映射，见 ROLE_NAME_ALIASES）
 *   3. 分词(camelCase / 下划线 / 连字符 / 斜杠 / 点)后逐 token 精确/别名命中
 *   4. 规范角色名作为子串出现——取最长命中者，避免 'review' 抢占 'frontend_reviewer'
 *   5. 都没命中 → 返回 undefined（调用方回落到 ROLE_FALLBACK_DEFAULT）
 *
 * 只会返回 availableRoleNames 里真实存在的名字，绝不凭空发明角色。
 */
const ROLE_NAME_ALIASES: Record<string, string> = {
  // 前端
  fe: 'frontend',
  front: 'frontend',
  // 后端
  be: 'backend',
  back: 'backend',
  // 全栈 / 实现
  full: 'fullstack',
  dev: 'coding',
  developer: 'coding',
  coder: 'coding',
  engineer: 'coding',
  impl: 'coding',
  implementer: 'coding',
  // 设计 / 可用性
  ui: 'ux_designer',
  ux: 'ux_designer',
  // 测试
  tester: 'qa',
  // 规划 / 架构 / 评估
  plan: 'planner',
  planning: 'planner',
  arch: 'architect',
  eval: 'evaluator',
  // 探索 / 研究 / 审查短形（多数已被精确/子串覆盖）
  researcher: 'research',
  explorer: 'explore',
  auditor: 'review',
  reviewer: 'review',
};

function tokenizeRoleName(raw: string): string[] {
  // 拆 camelCase 边界 → 小写 → 按非字母数字拆分（下划线/连字符/斜杠/点 都是分隔符）
  const lowered = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return lowered.split(/[^a-z0-9]+/).filter(Boolean);
}

export function resolveRoleFromName(
  rawName: string,
  availableRoleNames: string[],
): string | undefined {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return undefined;
  const lowerToReal = new Map<string, string>();
  for (const name of availableRoleNames) lowerToReal.set(name.toLowerCase(), name);

  // 1. 大小写无关精确命中
  if (lowerToReal.has(normalized)) return lowerToReal.get(normalized);

  // 2. 整体别名
  const wholeAlias = ROLE_NAME_ALIASES[normalized];
  if (wholeAlias && lowerToReal.has(wholeAlias)) return lowerToReal.get(wholeAlias);

  // 3. 逐 token 精确 / 别名命中
  for (const token of tokenizeRoleName(normalized)) {
    if (lowerToReal.has(token)) return lowerToReal.get(token);
    const alias = ROLE_NAME_ALIASES[token];
    if (alias && lowerToReal.has(alias)) return lowerToReal.get(alias);
  }

  // 4. 规范角色名作为子串出现，最长命中优先
  let bestReal: string | undefined;
  let bestLen = 0;
  for (const name of availableRoleNames) {
    const lower = name.toLowerCase();
    if (normalized.includes(lower) && lower.length > bestLen) {
      bestReal = name;
      bestLen = lower.length;
    }
  }
  if (bestReal) return bestReal;

  return undefined;
}

/**
 * Agent 角色定义
 */
export interface AgentRole {
  name: string;
  description: string;
  systemPrompt: string;
  /** 按 locale 的 system prompt 映射；派发时由 getPromptLocale() 选定，缺失则回落 systemPrompt */
  systemPromptByLocale?: Record<PromptLocale, string>;
  tools: string[];
  droppedTools?: string[];
  skillNames?: string[];
  capabilityProfile?: RoleCapabilityProfile;
  model?: string;
  worker_backend?: 'worker_process' | 'claude' | 'codex';
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

/**
 * Agent 角色注册表
 */
export class AgentRoleRegistry {
  protected roles: Map<string, AgentRole> = new Map();

  /**
   * 注册角色
   */
  register(role: AgentRole): AgentRole {
    if (this.roles.has(role.name)) {
      const existing = this.roles.get(role.name)!;
      // P0-1d: warn on duplicate registration to catch accidental overrides
      console.warn(
        `[RoleRegistry] Role "${role.name}" is already registered ` +
        `(createdBy=${existing.createdBy}). Overwriting with new registration ` +
        `(createdBy=${role.createdBy}).`,
      );
    }
    this.roles.set(role.name, role);
    return role;
  }

  /**
   * 检查角色是否存在
   */
  exists(name: string): boolean {
    return this.roles.has(name);
  }

  /**
   * 把一个（可能为变体/缩写的）角色名归约到注册表里真实存在的规范角色名；
   * 命中不了返回 undefined。确定性匹配，详见模块级 resolveRoleFromName。
   */
  resolveFromName(rawName: string): string | undefined {
    return resolveRoleFromName(rawName, this.listRoleNames());
  }

  /**
   * 获取角色
   */
  get(name: string): AgentRole | undefined {
    return this.roles.get(name);
  }

  /**
   * 列出所有角色名
   */
  listRoleNames(): string[] {
    return Array.from(this.roles.keys());
  }

  /**
   * 列出所有角色
   */
  listRoles(): AgentRole[] {
    return Array.from(this.roles.values());
  }

  /**
   * 生成 LLM 可读的角色上下文
   */
  toLLMContext(): string {
    const roles = Array.from(this.roles.values()).sort((a, b) => a.name.localeCompare(b.name));
    const lines: string[] = [
      '可用角色:',
      ...roles.map((role) => {
        const parts = [`- ${role.name}: ${role.description} | 工具: ${role.tools.join(', ') || '无'}`];
        if (role.droppedTools && role.droppedTools.length > 0) {
          parts.push(`  受限: ${role.droppedTools.join(', ')}`);
        }
        if (role.skillNames && role.skillNames.length > 0) {
          parts.push(`  技能: ${role.skillNames.join(', ')}`);
        }
        if (role.model) {
          parts.push(`  模型: ${role.model}`);
        }
        if (role.worker_backend && role.worker_backend !== 'worker_process') {
          parts.push(`  后端: ${role.worker_backend}${role.model ? ` · 模型: ${role.model}` : ''}`);
        }
        return parts.join('\n');
      }),
      '',
      '选角按实现单元而非任务类型——同一角色可挂多个 worker（fe-1/fe-2/be-1），由 write_scope 正交区分并行：先理解→research；通用单栈实现→coding；小到中型跨栈闭环→fullstack；API/数据库/服务端→backend；前端页面/交互/CSS→frontend；构建/回归验证→verify；测试设计/复现→qa；代码风险审查→review；验收打分→evaluator；可用性/视觉→ux_designer',
    ];
    return lines.join('\n');
  }

  /**
   * 转换为字典格式（用于持久化）
   */
  toDict(): Record<string, AgentRole> {
    const result: Record<string, AgentRole> = {};
    for (const [name, role] of this.roles) {
      result[name] = role;
    }
    return result;
  }

  /**
   * 从字典加载角色
   */
  loadFromDict(data: Record<string, AgentRole>): void {
    for (const [name, role] of Object.entries(data)) {
      this.roles.set(name, role);
    }
  }
}

export default AgentRoleRegistry;
