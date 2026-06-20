import { create } from 'zustand';

export interface GitActivityEvent {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  taskId?: string;
  action: 'commit' | 'push' | 'pull' | 'branch_create' | 'branch_switch' | 'merge_mr' | 'create_mr';
  success: boolean;
  timestamp: number;
  commitHash?: string;
  commitMessage?: string;
  author?: { name: string; email: string };
  branch?: string;
  gateResult?: {
    passed: boolean;
    enabled: boolean;
    diagnostics: string[];
  };
  error?: string;
}

interface GitActivityState {
  events: GitActivityEvent[];
  addEvent: (event: GitActivityEvent) => void;
  clear: () => void;
  /** Remove events older than maxAgeMs to prevent unbounded growth */
  prune: (maxAgeMs?: number) => void;
}

const MAX_EVENTS = 500;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export const useGitActivityStore = create<GitActivityState>((set) => ({
  events: [],
  addEvent: (event) =>
    set((state) => {
      // Just append; session isolation is handled by:
      // 1. connectToSession clears the store on session switch
      // 2. GitActivityView filters by current sessionId at render time
      const events = [...state.events, event];
      // Cap at MAX_EVENTS, drop oldest
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
      }
      return { events };
    }),
  clear: () => set({ events: [] }),
  prune: (maxAgeMs = DEFAULT_MAX_AGE_MS) =>
    set((state) => {
      const cutoff = Date.now() - maxAgeMs;
      return { events: state.events.filter((e) => e.timestamp >= cutoff) };
    }),
}));
