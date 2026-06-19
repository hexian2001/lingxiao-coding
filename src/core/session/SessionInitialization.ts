import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { DatabaseManager } from '../Database.js';
import { Workspace } from '../Workspace.js';
import {
  buildSkillDigest,
  collectAvailableSkills,
  resolveDisabledSkillNames,
} from '../SkillCatalog.js';

type LoggerLike = {
  warn?: (msg: string, ...args: unknown[]) => void;
};

export function generateUniqueSessionId(
  sessions: Map<string, unknown>,
  db: DatabaseManager,
): string {
  let sessionId: string;
  let attempts = 0;
  do {
    sessionId = randomUUID().substring(0, 16);
    attempts++;
    if (attempts > 10) {
      sessionId = randomUUID();
      break;
    }
  } while (sessions.has(sessionId) || db.getSession(sessionId) !== undefined);
  return sessionId;
}

export function ensureSessionDirectories(sessionId: string, workspace: string): void {
  const scratchpadDir = Workspace.getScratchpadDir(sessionId, workspace);
  const contextDir = Workspace.getContextDir(sessionId, workspace);
  const agentsDir = join(Workspace.getSessionArtifactPaths(sessionId, workspace).sessionDir, 'agents');
  mkdirSync(scratchpadDir, { recursive: true });
  mkdirSync(contextDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
}

export function createInitializationGate<T>(input: {
  sessionId: string;
  timeoutMs: number;
  initializingSessions: Map<string, Promise<T>>;
  logger?: LoggerLike;
}): {
  promise: Promise<T>;
  resolve: (state: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (state: T) => void;
  let reject!: (err: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (state) => { settled = true; res(state); };
    reject = (err) => { settled = true; rej(err); };
  });
  promise.catch(() => {});

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(new Error(`Session ${input.sessionId} initialization timed out after ${input.timeoutMs}ms`));
      input.initializingSessions.delete(input.sessionId);
      input.logger?.warn?.(`[SessionManager] 会话 ${input.sessionId} 初始化超时(${input.timeoutMs}ms)，已从 initializingSessions 移除`);
    }
  }, input.timeoutMs);
  if (timer.unref) timer.unref();

  return { promise, resolve, reject };
}

export function shouldAutoExtractMemory(
  autoExtractSoulOnComplete: boolean,
  memoryConfig: { enabled?: boolean; auto_memory_enabled?: boolean },
): boolean {
  return autoExtractSoulOnComplete && memoryConfig.enabled !== false && memoryConfig.auto_memory_enabled !== false;
}

export function buildLeaderSkillDigest(workspacePath: string): string {
  const disabledNames = resolveDisabledSkillNames();
  return buildSkillDigest(collectAvailableSkills(workspacePath, { disabledNames }));
}
