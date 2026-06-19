import type { DatabaseManager } from './core/Database.js';
import { getAvailableSkillEntries as getAvailableSkillEntriesFromCatalog } from './core/SkillCatalog.js';
import { contentToPlainText } from './llm/types.js';

export interface SkillEntry {
  name: string;
  source: string;
  desc: string;
}

export interface SessionSelectionItem {
  id: string;
  status: string;
  preview: string;
  createdAt: number;
}

const SESSION_PREVIEW_MESSAGE_ROLES = new Set<string>(['user', 'assistant']);

export function getAvailableSkillEntries(baseWorkspace: string): SkillEntry[] {
  return getAvailableSkillEntriesFromCatalog(baseWorkspace);
}

export function buildSessionSelectionItems(
  db: Pick<DatabaseManager, 'listSessions' | 'getConversation'>,
  limit = 20,
): SessionSelectionItem[] {
  return db.listSessions().slice(0, limit).map((session) => {
    const conversation = db.getConversation(session.id);
    const latestDialog = [...conversation]
      .reverse()
      .find((message) => SESSION_PREVIEW_MESSAGE_ROLES.has(message.role) && contentToPlainText(message.content).trim().length > 0);
    const preview = latestDialog
      ? contentToPlainText(latestDialog.content).replace(/\s+/g, ' ').slice(0, 80)
      : contentToPlainText(session.user_request).replace(/\s+/g, ' ').slice(0, 80);

    return {
      id: session.id,
      status: session.status,
      preview: preview || '(空会话)',
      createdAt: session.created_at,
    };
  });
}
