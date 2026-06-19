import { getPromptLocale, type PromptLocale } from '../i18n/catalog.js';
import {
  getLeaderSystemPromptTemplate,
  type LeaderPromptProfile,
} from '../i18n/leader_system_prompt.js';

export { getLeaderSystemPromptTemplate };

export function getLeaderSystemPrompt(
  locale: PromptLocale = getPromptLocale(),
  profile: LeaderPromptProfile = 'solo',
): string {
  return getLeaderSystemPromptTemplate(locale, profile);
}

export const LEADER_SYSTEM_PROMPT = getLeaderSystemPromptTemplate('zh', 'solo');
