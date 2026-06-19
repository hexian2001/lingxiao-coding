/**
 * Leader builtin role builder
 *
 * 抽离 registerBuiltinRoles 的装配逻辑：
 * - 11 个预置角色（research/coding/verify/...）的 prompt map
 * - 可选的 claude_coding / codex_coding 外部 Agent 角色
 *
 * LeaderAgent 只负责把最终 role 数组逐个注册到 RoleRegistry。
 */

import type { AgentRole } from '../RoleRegistry.js';
import {
  buildBuiltinRoles,
  type BuiltinRolePromptMap,
} from '../RoleCapabilityModel.js';
import type { PromptLocale } from '../prompts/i18n/catalog.js';

export interface ExternalAgentAvailabilityLite {
  claude: { installed: boolean };
  codex: { installed: boolean };
}

export interface BuiltinRoleDescriptions {
  claudeCoding: string;
  codexCoding: string;
}

export interface BuiltinRoleInput {
  prompts: BuiltinRolePromptMap;
  /** 提供给外部 Agent 角色的 systemPrompt（按 locale 映射，通常就是 CODING_SYSTEM_PROMPT_BY_LOCALE） */
  externalCodingPrompt: Record<PromptLocale, string>;
  availability: ExternalAgentAvailabilityLite;
  descriptions: BuiltinRoleDescriptions;
}

/**
 * 组装 Leader 应当注册的全部内置角色（顺序：预设 → claude_coding → codex_coding）
 */
export function collectBuiltinRoles(input: BuiltinRoleInput): AgentRole[] {
  const roles: AgentRole[] = [...buildBuiltinRoles(input.prompts)];

  if (input.availability.claude.installed) {
    roles.push({
      name: 'claude_coding',
      description: input.descriptions.claudeCoding,
      systemPrompt: input.externalCodingPrompt.zh,
      systemPromptByLocale: input.externalCodingPrompt,
      tools: [],
      createdBy: 'system',
      worker_backend: 'claude',
    });
  }

  if (input.availability.codex.installed) {
    roles.push({
      name: 'codex_coding',
      description: input.descriptions.codexCoding,
      systemPrompt: input.externalCodingPrompt.zh,
      systemPromptByLocale: input.externalCodingPrompt,
      tools: [],
      createdBy: 'system',
      worker_backend: 'codex',
      worker_config: { wire_api: 'chat' },
    });
  }

  return roles;
}
