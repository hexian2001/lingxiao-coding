import { create } from 'zustand';
import { apiHeaders } from '../api/headers';

export type WorktreeStatus = 'active' | 'dirty' | 'merged' | 'removed' | 'failed';

export interface WorktreeLiveStatus {
  modified: string[];
  untracked: string[];
  staged: string[];
  conflicted: string[];
  total: number;
  clean: boolean;
  currentBranch: string;
}

export interface WorktreeInfo {
  id: string;
  name: string;
  repo_root: string;
  path: string;
  branch: string;
  base_branch: string;
  session_id?: string;
  task_id?: string;
  status: WorktreeStatus;
  created_at: number;
  updated_at: number;
  last_error?: string;
  exists: boolean;
  live?: WorktreeLiveStatus;
}

interface WorktreeState {
  worktrees: WorktreeInfo[];
  isLoading: boolean;
  error: string | null;
  fetchWorktrees: (opts?: { repoRoot?: string; sessionId?: string; includeRemoved?: boolean }) => Promise<void>;
  createWorktree: (input: { repoRoot: string; name?: string; branch?: string; baseBranch?: string; sessionId?: string }) => Promise<WorktreeInfo>;
  attachSession: (id: string, sessionId: string | null) => Promise<WorktreeInfo>;
  mergeWorktree: (id: string, opts?: { ffOnly?: boolean; deleteAfterMerge?: boolean }) => Promise<void>;
  removeWorktree: (id: string, opts?: { keepBranch?: boolean }) => Promise<void>;
  pruneWorktrees: (repoRoot: string) => Promise<void>;
  fetchWorktreeDiff: (path: string) => Promise<string>;
  commitWorktree: (path: string, message: string, repoRoot?: string) => Promise<void>;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null;
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers: apiHeaders({
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json as T;
}

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  worktrees: [],
  isLoading: false,
  error: null,

  fetchWorktrees: async (opts = {}) => {
    set({ isLoading: true, error: null });
    try {
      const params = new URLSearchParams();
      if (opts.repoRoot) params.set('repoRoot', opts.repoRoot);
      if (opts.sessionId) params.set('sessionId', opts.sessionId);
      if (opts.includeRemoved) params.set('includeRemoved', 'true');
      const qs = params.toString() ? `?${params}` : '';
      const json = await apiFetch<{ data: WorktreeInfo[] }>(`/worktrees${qs}`);
      set({ worktrees: json.data || [], isLoading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false });
    }
  },

  createWorktree: async (input) => {
    const json = await apiFetch<{ data: WorktreeInfo }>('/worktrees', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    await get().fetchWorktrees({ repoRoot: input.repoRoot });
    return json.data;
  },

  attachSession: async (id, sessionId) => {
    const json = await apiFetch<{ data: WorktreeInfo }>(`/worktrees/${encodeURIComponent(id)}/attach-session`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    await get().fetchWorktrees();
    return json.data;
  },

  mergeWorktree: async (id, opts = {}) => {
    await apiFetch(`/worktrees/${encodeURIComponent(id)}/merge`, {
      method: 'POST',
      body: JSON.stringify(opts),
    });
    await get().fetchWorktrees();
  },

  removeWorktree: async (id, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.keepBranch) params.set('keepBranch', 'true');
    await apiFetch(`/worktrees/${encodeURIComponent(id)}${params.toString() ? `?${params}` : ''}`, {
      method: 'DELETE',
    });
    await get().fetchWorktrees();
  },

  pruneWorktrees: async (repoRoot) => {
    await apiFetch('/worktrees/prune', {
      method: 'POST',
      body: JSON.stringify({ repoRoot }),
    });
    await get().fetchWorktrees({ repoRoot });
  },

  fetchWorktreeDiff: async (path) => {
    const params = new URLSearchParams({ workspace: path });
    const json = await apiFetch<{ data: string }>(`/git/diff?${params}`);
    return json.data || '';
  },

  commitWorktree: async (path, message, repoRoot) => {
    const trimmed = message.trim();
    if (!trimmed) throw new Error('Commit message is required');
    await apiFetch('/git/stage', {
      method: 'POST',
      body: JSON.stringify({ workspace: path, files: [] }),
    });
    await apiFetch('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ workspace: path, message: trimmed }),
    });
    await get().fetchWorktrees(repoRoot ? { repoRoot } : undefined);
  },
}));
