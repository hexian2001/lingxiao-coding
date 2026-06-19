import { SESSION_KEYS } from './SessionStateKeys.js';

export interface EternalGoal {
  description: string;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface EternalGoalReader {
  getSessionState(sessionId: string, key: string): unknown | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export function normalizeEternalGoal(raw: unknown): EternalGoal | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return normalizeEternalGoal(JSON.parse(trimmed));
    } catch {/* swallowed: unhandled error */
      const now = Date.now();
      return {
        description: trimmed,
        paused: false,
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  if (!isRecord(raw)) return null;
  if (raw.deletedAt != null) return null;
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) return null;
  const updatedAt = readTimestamp(raw.updatedAt, Date.now());
  const createdAt = readTimestamp(raw.createdAt, updatedAt);
  return {
    description,
    paused: raw.paused === true,
    createdAt,
    updatedAt,
  };
}

export function readPersistedEternalGoal(
  db: EternalGoalReader,
  sessionId: string,
): EternalGoal | null {
  return normalizeEternalGoal(db.getSessionState(sessionId, SESSION_KEYS.ETERNAL_GOAL));
}

export function createEternalGoal(
  description: string,
  previous: EternalGoal | null = null,
  now = Date.now(),
): EternalGoal {
  return {
    description: description.trim(),
    paused: false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export function setEternalGoalPaused(
  goal: EternalGoal,
  paused: boolean,
  now = Date.now(),
): EternalGoal {
  return {
    ...goal,
    paused,
    updatedAt: now,
  };
}
