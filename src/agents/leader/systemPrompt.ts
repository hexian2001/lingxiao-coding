/**
 * Leader system prompt builder
 *
 * 把 Leader 的系统 prompt 装配过程抽出为纯函数。
 * 接受外部 prompt 模板与运行参数，输出最终注入到 LLM 的 system 文本。
 */

import { getPromptCatalog, getPromptLanguageDirective, type PromptLocale } from '../prompts/i18n/catalog.js';

export interface SystemPromptInput {
  /** 原始 system prompt 模板（包含 {available_roles}/<session_id>/<workspace>/<session_scope_section> 占位符） */
  template: string;
  /** 角色目录（roleRegistry.toLLMContext() 输出） */
  availableRoles: string;
  /** 会话 ID */
  sessionId: string;
  /** 工作区目录 */
  workspace: string;
  /** Session scope 段（buildSessionScopeSection 输出） */
  sessionScopeSection: string;
  /** 已渲染的可用 skills 列表（Markdown 项目列表） */
  skillsContent?: string;
  /** Prompt 文案语言；不传时读取 sessionLanguage，其次 currentLanguage */
  locale?: PromptLocale;
  /** 运行时 i18n 语言指令（每轮动态拼接，让用户切换语言后下一轮立即生效） */
  languageDirective?: string;
}

/**
 * 装配 Leader 的 system prompt：
 * 1. 替换 4 个占位符
 * 2. 当存在 skills 时追加可用 Skills 段
 */
export function buildLeaderSystemPrompt(input: SystemPromptInput): string {
  const { template, availableRoles, sessionId, workspace, sessionScopeSection } = input;
  let prompt = template;
  prompt = prompt.replace('{available_roles}', availableRoles);
  prompt = prompt.replace('<session_id>', sessionId);
  prompt = prompt.replace('<workspace>', workspace);
  prompt = prompt.replace('<session_scope_section>', sessionScopeSection);
  const catalog = getPromptCatalog(input.locale);
  const skillsContent = (input.skillsContent || '').trim();
  if (skillsContent) {
    prompt +=
      `\n\n## ${catalog.leader.availableSkillsHeading}\n\n${catalog.leader.availableSkillsIntro}\n\n${skillsContent}`;
  }
  const languageDirective = (input.languageDirective ?? getPromptLanguageDirective(catalog.locale)).trim();
  if (languageDirective) {
    prompt += languageDirective.startsWith('\n') ? languageDirective : `\n\n${languageDirective}`;
  }
  return prompt;
}
