/**
 * gitStore — Git 操作状态管理
 */

import { create } from 'zustand';
import i18n from '../i18n';
import { getServerToken } from '../api/headers';

export interface FileStatus {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitStatus {
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  conflicted: string[];
  isClean: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
  lastCommit?: string;
  lastCommitMsg?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface MergeRequest {
  id: number | string;
  iid?: number;
  title: string;
  description: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  platform: 'github' | 'gitlab' | 'gitea';
  draft: boolean;
  labels: string[];
  comments: number;
}

export interface CreateMRParams {
  title: string;
  description?: string;
  source_branch: string;
  target_branch: string;
  draft?: boolean;
}

export interface DetectedPlatform {
  platform: 'github' | 'gitlab' | 'gitea' | 'none';
  apiUrl: string;
  owner: string;
  repo: string;
}

interface GitState {
  workspace: string;
  status: GitStatus | null;
  branches: GitBranch[];
  log: GitCommit[];
  diff: string;
  stagedDiff: string;
  mrs: MergeRequest[];
  detectedPlatform: DetectedPlatform | null;
  isLoading: boolean;
  isMRLoading: boolean;
  error: string | null;
  mrError: string | null;
  /** 平台未配置/未授权/仓库不可见 — 后端优雅降级标志，非真实错误 */
  mrUnavailable: { reason: string; message: string } | null;
  selectedFiles: string[];
  mrStateFilter: 'open' | 'closed' | 'merged' | 'all';

  setWorkspace: (workspace: string) => void;
  fetchStatus: () => Promise<void>;
  fetchBranches: () => Promise<void>;
  fetchLog: (branch?: string) => Promise<void>;
  fetchDiff: (staged?: boolean) => Promise<void>;
  stageFiles: (files: string[]) => Promise<void>;
  unstageFiles: (files: string[]) => Promise<void>;
  commit: (message: string, amend?: boolean) => Promise<void>;
  createBranch: (name: string, from?: string) => Promise<void>;
  switchBranch: (branch: string) => Promise<void>;
  deleteBranch: (name: string, force?: boolean) => Promise<void>;
  push: (opts?: { remote?: string; branch?: string; setUpstream?: boolean }) => Promise<void>;
  pull: (remote?: string, branch?: string) => Promise<void>;
  fetch: () => Promise<void>;
  fetchMRs: (state?: 'open' | 'closed' | 'merged' | 'all') => Promise<void>;
  createMR: (params: CreateMRParams) => Promise<MergeRequest>;
  mergeMR: (id: string | number) => Promise<void>;
  closeMR: (id: string | number) => Promise<void>;
  detectPlatform: () => Promise<void>;
  stash: (message?: string) => Promise<void>;
  stashPop: () => Promise<void>;
  toggleSelectedFile: (path: string) => void;
  setSelectedFiles: (files: string[]) => void;
  setMRStateFilter: (state: 'open' | 'closed' | 'merged' | 'all') => void;
  clearError: () => void;
  initRepo: () => Promise<void>;
}

/**
 * Guard for write operations: throws a user-friendly error if workspace is empty.
 * The backend rejects write ops without an explicit workspace (returns 400).
 */
function requireWorkspace(workspace: string): string {
  if (!workspace || !workspace.trim()) {
    throw new Error(i18n.t('git.error.workspaceRequired'));
  }
  return workspace.trim();
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return fallback;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const hasBody = opts?.body != null;
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: {
      'x-lingxiao-token': getServerToken(),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errorMessageFromBody(body, `HTTP ${res.status}`));
  }
  return res.json() as T;
}

let initRepoInFlight: { workspace: string; promise: Promise<void> } | null = null;

export const useGitStore = create<GitState>((set, get) => ({
  workspace: '',
  status: null,
  branches: [],
  log: [],
  diff: '',
  stagedDiff: '',
  mrs: [],
  detectedPlatform: null,
  isLoading: false,
  isMRLoading: false,
  error: null,
  mrError: null,
  mrUnavailable: null,
  selectedFiles: [],
  mrStateFilter: 'open',

  setWorkspace: (workspace) => set((s) => {
    // Clear stale data when workspace changes to prevent showing old repo info
    if (s.workspace !== workspace) {
      return { workspace, status: null, branches: [], log: [], diff: '', stagedDiff: '', mrs: [], detectedPlatform: null, error: null, mrError: null, mrUnavailable: null, selectedFiles: [] };
    }
    return { workspace };
  }),

  fetchStatus: async () => {
    const { workspace } = get();
    set({ isLoading: true, error: null });
    try {
      const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
      const res = await apiFetch<{ data: GitStatus | null; error?: string }>(`/git/status${qs}`);
      set({ status: res.data, isLoading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), isLoading: false });
    }
  },

  fetchBranches: async () => {
    const { workspace } = get();
    try {
      const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
      const res = await apiFetch<{ data: GitBranch[] }>(`/git/branches${qs}`);
      set({ branches: res.data || [] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  fetchLog: async (branch?: string) => {
    const { workspace } = get();
    try {
      const params = new URLSearchParams();
      if (workspace) params.set('workspace', workspace);
      if (branch) params.set('branch', branch);
      const qs = params.toString() ? `?${params}` : '';
      const res = await apiFetch<{ data: GitCommit[] }>(`/git/log${qs}`);
      set({ log: res.data || [] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  fetchDiff: async (staged = false) => {
    const { workspace } = get();
    try {
      const params = new URLSearchParams();
      if (workspace) params.set('workspace', workspace);
      if (staged) params.set('staged', 'true');
      const qs = params.toString() ? `?${params}` : '';
      const res = await apiFetch<{ data: string }>(`/git/diff${qs}`);
      if (staged) {
        set({ stagedDiff: res.data || '' });
      } else {
        set({ diff: res.data || '' });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  stageFiles: async (files: string[]) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/stage', {
      method: 'POST',
      body: JSON.stringify({ workspace, files }),
    });
    await get().fetchStatus();
  },

  unstageFiles: async (files: string[]) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/unstage', {
      method: 'POST',
      body: JSON.stringify({ workspace, files }),
    });
    await get().fetchStatus();
  },

  commit: async (message: string, amend = false) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ workspace, message, amend }),
    });
    await get().fetchStatus();
    await get().fetchLog();
  },

  createBranch: async (name: string, from?: string) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/branch', {
      method: 'POST',
      body: JSON.stringify({ workspace, name, from }),
    });
    await get().fetchBranches();
    await get().fetchStatus();
  },

  switchBranch: async (branch: string) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/switch', {
      method: 'POST',
      body: JSON.stringify({ workspace, branch }),
    });
    await get().fetchStatus();
    await get().fetchBranches();
  },

  deleteBranch: async (name: string, force = false) => {
    const workspace = requireWorkspace(get().workspace);
    const qs = `?workspace=${encodeURIComponent(workspace)}&force=${force}`;
    await apiFetch(`/git/branch/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' });
    await get().fetchBranches();
  },

  push: async (opts = {}) => {
    set({ isLoading: true, error: null });
    try {
      const workspace = requireWorkspace(get().workspace);
      await apiFetch('/git/push', {
        method: 'POST',
        body: JSON.stringify({ workspace, ...opts }),
      });
      await get().fetchStatus();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ isLoading: false });
    }
  },

  pull: async (remote?: string, branch?: string) => {
    set({ isLoading: true, error: null });
    try {
      const workspace = requireWorkspace(get().workspace);
      await apiFetch('/git/pull', {
        method: 'POST',
        body: JSON.stringify({ workspace, remote, branch }),
      });
      await get().fetchStatus();
      await get().fetchLog();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ isLoading: false });
    }
  },

  fetch: async () => {
    set({ isLoading: true, error: null });
    try {
      const workspace = requireWorkspace(get().workspace);
      await apiFetch('/git/fetch', { method: 'POST', body: JSON.stringify({ workspace }) });
      await get().fetchStatus();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ isLoading: false });
    }
  },

  fetchMRs: async (state) => {
    const { workspace, mrStateFilter } = get();
    const effectiveState = state ?? mrStateFilter;
    set({ isMRLoading: true, mrError: null });
    try {
      const params = new URLSearchParams();
      if (workspace) params.set('workspace', workspace);
      params.set('state', effectiveState);
      const res = await apiFetch<{ data: MergeRequest[]; unavailable?: boolean; reason?: string; message?: string }>(`/git/platform/mrs?${params}`);
      // 后端对「平台未配置/未授权/仓库不可见」返回 200 + unavailable 标志，
      // 这是预期状态而非错误 —— 转成 mrUnavailable 供 UI 友好提示。
      if (res.unavailable) {
        set({ mrs: [], mrUnavailable: { reason: res.reason || 'unknown', message: res.message || '' }, isMRLoading: false });
      } else {
        set({ mrs: res.data || [], mrUnavailable: null, isMRLoading: false });
      }
    } catch (e) {
      set({ mrError: e instanceof Error ? e.message : String(e), isMRLoading: false });
    }
  },

  createMR: async (params: CreateMRParams) => {
    const workspace = requireWorkspace(get().workspace);
    const res = await apiFetch<{ data: MergeRequest }>('/git/platform/mrs', {
      method: 'POST',
      body: JSON.stringify({ workspace, ...params }),
    });
    await get().fetchMRs();
    return res.data;
  },

  mergeMR: async (id: string | number) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch(`/git/platform/mrs/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ workspace }),
    });
    await get().fetchMRs();
  },

  closeMR: async (id: string | number) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch(`/git/platform/mrs/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ workspace }),
    });
    await get().fetchMRs();
  },

  detectPlatform: async () => {
    const { workspace } = get();
    try {
      const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
      const res = await apiFetch<{ data: DetectedPlatform }>(`/git/detect${qs}`);
      set({ detectedPlatform: res.data });
    } catch { /* ignore */ }
  },

  stash: async (message?: string) => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/stash', {
      method: 'POST',
      body: JSON.stringify({ workspace, message }),
    });
    await get().fetchStatus();
  },

  stashPop: async () => {
    const workspace = requireWorkspace(get().workspace);
    await apiFetch('/git/stash/pop', {
      method: 'POST',
      body: JSON.stringify({ workspace }),
    });
    await get().fetchStatus();
  },

  toggleSelectedFile: (path: string) => {
    const { selectedFiles } = get();
    if (selectedFiles.includes(path)) {
      set({ selectedFiles: selectedFiles.filter(f => f !== path) });
    } else {
      set({ selectedFiles: [...selectedFiles, path] });
    }
  },

  setSelectedFiles: (files: string[]) => set({ selectedFiles: files }),

  setMRStateFilter: (state) => {
    set({ mrStateFilter: state });
    get().fetchMRs(state);
  },

  clearError: () => set({ error: null, mrError: null, mrUnavailable: null }),

  initRepo: async () => {
    let workspace: string;
    try {
      workspace = requireWorkspace(get().workspace);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (initRepoInFlight?.workspace === workspace) return initRepoInFlight.promise;

    const operation = (async () => {
      set({ isLoading: true, error: null });
      try {
        await apiFetch<{ data: { message: string; initialized: boolean; path: string } }>('/git/init', {
          method: 'POST',
          body: JSON.stringify({ workspace }),
        });
        // 重新加载状态
        const { fetchStatus, fetchBranches, fetchLog } = get();
        await fetchStatus();
        await Promise.all([fetchBranches(), fetchLog()]);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set({ isLoading: false });
      }
    })();

    initRepoInFlight = { workspace, promise: operation };
    try {
      return await operation;
    } finally {
      if (initRepoInFlight?.promise === operation) initRepoInFlight = null;
    }
  },
}));
